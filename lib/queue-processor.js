'use strict';
// Import push queue processor for the Oui/Eurostyle module.
//
// SINGLE-THREADED, SEQUENTIAL. One line at a time, in insertion order
// (batch_id, line_id). This is a per-file operation; multiple files should
// not push concurrently against the same tenant (higher-level guard).
//
// RESUME SEMANTICS (non-negotiable):
//   Every state transition (matrix_id set, item_id set, status change) is
//   COMMITTED before the next operation starts. If the process dies at any
//   point, restart re-loads all lines and skips the ones already at status
//   'ordered'. In-progress lines resume from the exact step their fields
//   indicate — never re-running a step that already succeeded.
//
// STRICT ORDER PER STYLE (non-negotiable):
//   For each line, operations execute in this order:
//     1. Matrix   — POST /ItemMatrix (or reuse preferred_matrix_id from resolver)
//     2. Variant  — POST /Item under the matrix (or reuse existing size/color)
//     3. Tag      — PUT /Item Tags (idempotent via lightspeed-client.tagItem)
//     4. PO       — POST /Order for the batch (once per batch)
//     5. OrderLine — POST /OrderLine (one per line, quantity = ordered qty)
//   A variant cannot be ordered before it exists — enforced by requiring
//   item_id to be non-null before step 5, and matrix_id before step 2.
//
// CROSS-LINE COORDINATION:
//   Multiple lines can reference the same (style_ref, color_normalized).
//   Before POSTing a new matrix or variant, we check the DB for peer lines
//   in the same file that already have matrix_id / item_id set — if so,
//   reuse those IDs instead of creating duplicates. This preserves the
//   dedup guarantee from B6 through the queue.
//
// LIVE CHECK BEFORE POST /Item:
//   Even after peer-line lookup, there's a residual risk on retry: a
//   previous run may have POSTed a variant and crashed before committing
//   the item_id. To detect that, we fetch listVariantsForMatrix() right
//   before posting a new variant and match on (attribute1=size,
//   attribute2=color_normalized). If found, adopt that itemID.
//   Not applied to matrices (much lower risk — creation is much rarer)
//   nor to OrderLines (Lightspeed rejects duplicates on same PO+item).

const { upsertCreatedProduct } = require('./local-upsert');

// ─────────────────────────────────────────────────────────────────────────
// Payload builders — extracted for testability & override.
// ─────────────────────────────────────────────────────────────────────────
function buildMatrixPayload({ description, manufacturerID, defaultVendorID, defaultCost, retailPrice, attributeSetID, categoryID }) {
  const payload = {
    description:        String(description),
    itemAttributeSetID: String(attributeSetID),
    manufacturerID:     String(manufacturerID),
  };
  if (defaultVendorID != null) payload.defaultVendorID = String(defaultVendorID);
  if (defaultCost != null)     payload.defaultCost     = String(defaultCost);
  if (categoryID != null && categoryID !== '') payload.categoryID = String(categoryID);
  // Prices block — WITHOUT it, Default/MSRP/Online all default to 0 and the
  // matrix's "Valeurs par défaut" show margin=-100% (confirmed 2026-08 during
  // B8.5). Same amount for all three useTypes = supplier retail price.
  if (retailPrice != null) {
    const p = String(retailPrice);
    payload.Prices = {
      ItemPrice: [
        { amount: p, useType: 'Default' },
        { amount: p, useType: 'MSRP' },
        { amount: p, useType: 'Online' },
      ],
    };
  }
  return payload;
}

function buildItemPayload({ matrixID, size, colorNormalized, description, manufacturerID, defaultVendorID, defaultCost, retailPrice, attributeSetID, vendorNum }) {
  // Lightspeed rejects itemAttributeSetID at the top level for Item POSTs
  // ("Item not created. You can not set ItemAttributes without specifying
  //  a itemAttributeSetID" — confirmed 2026-08 during B8.5 live test).
  // It must live INSIDE the ItemAttributes object.
  const payload = {
    description:    String(description),
    itemMatrixID:   String(matrixID),
    manufacturerID: String(manufacturerID),
    ItemAttributes: {
      itemAttributeSetID: String(attributeSetID),
      attribute1:         String(size),
      attribute2:         String(colorNormalized),
    },
  };
  if (defaultVendorID != null) payload.defaultVendorID = String(defaultVendorID);
  if (defaultCost != null)     payload.defaultCost     = String(defaultCost);
  // Prices block — same rationale as buildMatrixPayload: WITHOUT it, all
  // three prices default to 0 → -100% margin. The variant's prices are the
  // ones actually shown in POS/Online, so this is REQUIRED, not optional.
  if (retailPrice != null) {
    const p = String(retailPrice);
    payload.Prices = {
      ItemPrice: [
        { amount: p, useType: 'Default' },
        { amount: p, useType: 'MSRP' },
        { amount: p, useType: 'Online' },
      ],
    };
  }
  if (vendorNum) {
    // Field is `value`, not `vendorNum` (Lightspeed error message quirk —
    // confirmed 2026-08 during B8.5 live test).
    payload.ItemVendorNums = {
      ItemVendorNum: {
        vendorID: String(defaultVendorID),
        value:    String(vendorNum),
        cost:     defaultCost != null ? String(defaultCost) : undefined,
      },
    };
  }
  return payload;
}

function buildOrderPayload({ batch, vendorID, shopID, employeeID, customOrderName }) {
  // Operator-provided custom name takes precedence when set at upload time.
  // Otherwise fall back to "po_number + customer_reference" as before.
  const refNum = customOrderName && String(customOrderName).trim()
    ? String(customOrderName).trim()
    : [batch.po_number, batch.customer_reference].filter(Boolean).join(' ');
  const payload = {
    orderDate:    batch.order_date    ?? undefined,
    deliveryDate: batch.delivery_date ?? undefined,
    cancelDate:   batch.cancel_date   ?? undefined,
    vendorID:     String(vendorID),
    shopID:       String(shopID),
    refNum,
  };
  if (employeeID != null) payload.employeeID = String(employeeID);
  return payload;
}

function buildOrderLinePayload({ orderID, itemID, quantity, unitCost }) {
  return {
    orderID:   String(orderID),
    itemID:    String(itemID),
    quantity:  Number(quantity),
    cost:      unitCost != null ? String(unitCost) : undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// DB helpers — all use parameterised queries with (tenant_id) scope.
// ─────────────────────────────────────────────────────────────────────────
async function loadLinesForFile(pool, tenantId, fileId) {
  // MUST filter b.selected = true — otherwise a partial push (some POs
  // deselected by the operator) would still process every line and create
  // POs the user explicitly opted out of. Also skip abandoned batches.
  const { rows } = await pool.query(
    `SELECT ol.line_id, ol.batch_id, ol.tenant_id,
            ol.supplier_style_ref, ol.supplier_color_ref, ol.color_normalized, ol.size_label,
            ol.qty, ol.unit_cost, ol.unit_price_retail,
            ol.matrix_id, ol.item_id, ol.lightspeed_order_line_id,
            ol.status, ol.error_message
     FROM   import_order_lines ol
     JOIN   import_batches      b ON b.batch_id = ol.batch_id
     WHERE  b.file_id = $1 AND b.tenant_id = $2
       AND  b.selected = true
       AND  b.status <> 'abandoned'
     ORDER  BY ol.batch_id, ol.line_id`,
    [fileId, tenantId],
  );
  return rows;
}

async function findSharedMatrixId(pool, tenantId, fileId, styleRef, colorNormalized) {
  const { rows } = await pool.query(
    `SELECT ol.matrix_id
     FROM   import_order_lines ol
     JOIN   import_batches      b ON b.batch_id = ol.batch_id
     WHERE  b.file_id = $1 AND b.tenant_id = $2
       AND  ol.supplier_style_ref = $3 AND ol.color_normalized = $4
       AND  ol.matrix_id IS NOT NULL
     LIMIT  1`,
    [fileId, tenantId, styleRef, colorNormalized],
  );
  return rows[0]?.matrix_id ?? null;
}

async function findSharedItemId(pool, tenantId, fileId, styleRef, colorNormalized, sizeLabel) {
  const { rows } = await pool.query(
    `SELECT ol.item_id
     FROM   import_order_lines ol
     JOIN   import_batches      b ON b.batch_id = ol.batch_id
     WHERE  b.file_id = $1 AND b.tenant_id = $2
       AND  ol.supplier_style_ref = $3 AND ol.color_normalized = $4 AND ol.size_label = $5
       AND  ol.item_id IS NOT NULL
     LIMIT  1`,
    [fileId, tenantId, styleRef, colorNormalized, sizeLabel],
  );
  return rows[0]?.item_id ?? null;
}

async function loadBatch(pool, tenantId, batchId) {
  const { rows } = await pool.query(
    `SELECT batch_id, po_number, customer_reference, order_date, delivery_date, cancel_date,
            is_consignment, lightspeed_order_id, status
     FROM   import_batches
     WHERE  batch_id = $1 AND tenant_id = $2`,
    [batchId, tenantId],
  );
  return rows[0] ?? null;
}

// Small helpers so status transitions and error recording share one query pattern.
async function setLine(pool, tenantId, lineId, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(', ');
  await pool.query(
    `UPDATE import_order_lines SET ${sets}, last_attempted_at = now()
     WHERE line_id = $1 AND tenant_id = $2`,
    [lineId, tenantId, ...keys.map(k => fields[k])],
  );
}

async function setBatch(pool, tenantId, batchId, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(', ');
  await pool.query(
    `UPDATE import_batches SET ${sets} WHERE batch_id = $1 AND tenant_id = $2`,
    [batchId, tenantId, ...keys.map(k => fields[k])],
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Per-step orchestration.
// ─────────────────────────────────────────────────────────────────────────

async function ensureMatrix(deps, opts, line) {
  const { pool, client } = deps;
  // 1. Peer-line lookup
  const shared = await findSharedMatrixId(pool, opts.tenantId, opts.fileId, line.supplier_style_ref, line.color_normalized);
  if (shared) {
    await setLine(pool, opts.tenantId, line.line_id, { matrix_id: shared, status: 'matrix_ensured' });
    line.matrix_id = shared;
    line.status = 'matrix_ensured';
    return;
  }
  // 2. Resolver directive
  const res = opts.resolutions.get(line.supplier_style_ref);
  if (res?.status === 'exists_current_season' && res.preferred_matrix_id) {
    const matrixId = String(res.preferred_matrix_id);
    await setLine(pool, opts.tenantId, line.line_id, { matrix_id: matrixId, status: 'matrix_ensured' });
    line.matrix_id = matrixId;
    line.status = 'matrix_ensured';
    return;
  }
  // 3. POST /ItemMatrix — then tag it immediately (tags don't propagate,
  //    matrix and variants must both carry the season tag).
  const plannedDesc = (res?.status === 'exists_other_season')
    ? `${line.supplier_style_ref} ${opts.seasonTag}`
    : line.supplier_style_ref;
  // Look up per-matrix operator override (set via PATCH /matrices/:key/override).
  // matrix_key = "style_ref|color_normalized", same rule as preview-generator.
  const matrixKey       = `${line.supplier_style_ref}|${line.color_normalized}`;
  const overrideCategoryID = opts.matrixOverrides?.[matrixKey]?.category_id ?? null;
  // Apply negotiated margin override (from brand_payment_terms.margin_override_pct).
  // effective_cost = retail_price × (1 - margin/100) — overrides PO cost when the
  // real retailer margin exceeds what the supplier printed on the PO.
  let effectiveCost = line.unit_cost;
  if (opts.brandMarginPct != null && Number(line.unit_price_retail) > 0) {
    effectiveCost = Number((Number(line.unit_price_retail) * (1 - opts.brandMarginPct / 100)).toFixed(2));
  }
  const payload = buildMatrixPayload({
    description:      plannedDesc,
    manufacturerID:   opts.manufacturerID,
    defaultVendorID:  opts.defaultVendorID,
    defaultCost:      effectiveCost,
    retailPrice:      line.unit_price_retail,
    attributeSetID:   opts.attributeSetID,
    categoryID:       overrideCategoryID,
  });
  const created = await client.createMatrix(payload);
  const matrixId = String(created.itemMatrixID);
  await setLine(pool, opts.tenantId, line.line_id, { matrix_id: matrixId, status: 'matrix_ensured' });
  line.matrix_id = matrixId;
  line.status = 'matrix_ensured';
  // Pre-populate the attr-set cache so we don't re-fetch this brand-new matrix
  // just to learn what we already set. Recipes always create Taille/Couleur
  // (setId 5 in Oui's case), which is a two-attribute set.
  (opts._attrSetCache ??= new Map()).set(matrixId, {
    setId:        String(opts.attributeSetID),
    attr1Name:    'Taille',
    attr2Name:    'Couleur',
    isSingleAttr: false,
  });
  // Tag matrix with season. Idempotent — will merge with any pre-existing tags.
  await client.tagMatrix(matrixId, [opts.seasonTag]);
}

// Fetches the itemAttributeSetID of an ItemMatrix + the SHAPE of that set
// (single-attribute Couleur vs. two-attribute Taille/Couleur). Cached per-run.
// Different matrices can use different sets. When we ADD a variant to an
// EXISTING matrix, we MUST match its set — not the recipe's default.
// Confirmed 2026-08 during B9.5:
//   - Mismatched setID: 400 "Item.ItemAttributes.itemAttributesSetID and
//     the itemAttributesSetID in corresponding matrix object do not match."
//   - Setting attribute2 on a Couleur-only set: 400 "Cannot set attribute2 on
//     an Item with ItemAttributeSet type Couleur. Valid fields are attribute1"
async function resolveMatrixAttrSet(deps, opts, matrixId) {
  if (!opts._attrSetCache) opts._attrSetCache = new Map();
  const cached = opts._attrSetCache.get(String(matrixId));
  if (cached) return cached;
  const data = await deps.client._request('GET', `/ItemMatrix/${matrixId}.json`, {});
  const setId = String(data.ItemMatrix?.itemAttributeSetID ?? opts.attributeSetID);
  const setInfo = await deps.client._request('GET', `/ItemAttributeSet/${setId}.json`, {});
  const s = setInfo.ItemAttributeSet ?? {};
  const info = {
    setId,
    attr1Name: s.attributeName1 || '',
    attr2Name: s.attributeName2 || '',
    isSingleAttr: !s.attributeName2,   // true for 'Couleur' or 'Taille' only
  };
  opts._attrSetCache.set(String(matrixId), info);
  return info;
}

async function ensureVariant(deps, opts, line) {
  const { pool, client } = deps;

  // 1. Peer-line lookup (same file, same style/color/size, item_id already set)
  const shared = await findSharedItemId(pool, opts.tenantId, opts.fileId, line.supplier_style_ref, line.color_normalized, line.size_label);
  if (shared) {
    await setLine(pool, opts.tenantId, line.line_id, { item_id: shared, status: 'variant_ensured' });
    line.item_id = shared;
    line.status = 'variant_ensured';
    return;
  }

  // 2. If resolver already found this exact variant in an existing matrix, adopt it.
  const res = opts.resolutions.get(line.supplier_style_ref);
  if (res?.status === 'exists_current_season') {
    const target = res.matching_matrices.find(m => String(m.matrix_id) === String(line.matrix_id));
    const existing = target?.variants?.find(v =>
      String(v.attribute1 ?? '') === String(line.size_label) &&
      String(v.attribute2 ?? '') === String(line.color_normalized),
    );
    if (existing) {
      const itemId = String(existing.itemID);
      await setLine(pool, opts.tenantId, line.line_id, { item_id: itemId, status: 'variant_ensured' });
      line.item_id = itemId;
      line.status = 'variant_ensured';
      return;
    }
  }

  // 3. Get the matrix's actual attribute-set shape. Two possibilities:
  //    (a) two-attribute Taille/Couleur (the normal case for apparel) →
  //        variant identity = (attribute1=size, attribute2=color)
  //    (b) single-attribute Couleur/Taille (e.g. matrices for scarves,
  //        one-size items) → variant identity = attribute1 alone.
  //    In case (b), the incoming line's size_label (typically "OS") is
  //    semantic only; the actual dimension stored on the variant is the color.
  const attrSet = await resolveMatrixAttrSet(deps, opts, line.matrix_id);

  // 4. Defensive live check — matched to the matrix's actual schema.
  const liveVariants = await client.listVariantsForMatrix(line.matrix_id);
  const liveExisting = liveVariants.find(v => {
    const a1 = String(v.ItemAttributes?.attribute1 ?? '');
    const a2 = String(v.ItemAttributes?.attribute2 ?? '');
    if (attrSet.isSingleAttr) {
      // Match by color. Accept exact color_normalized OR any variant whose
      // attribute1 contains the supplier color code (handles pre-existing
      // "-897" style values from earlier CSV imports).
      const wantFull = String(line.color_normalized);
      const wantCode = String(line.supplier_color_ref ?? '');
      return a1 === wantFull || (wantCode && a1.includes(wantCode));
    }
    return a1 === String(line.size_label) && a2 === String(line.color_normalized);
  });
  if (liveExisting) {
    const itemId = String(liveExisting.itemID);
    await setLine(pool, opts.tenantId, line.line_id, { item_id: itemId, status: 'variant_ensured' });
    line.item_id = itemId;
    line.status = 'variant_ensured';
    return;
  }

  // 5. Create. Payload shape follows the matrix's schema.
  const vendorNum = [line.supplier_style_ref, line.size_label, line.supplier_color_ref].filter(Boolean).join('-');
  const attrs = attrSet.isSingleAttr
    ? { itemAttributeSetID: attrSet.setId, attribute1: String(line.color_normalized) }
    : { itemAttributeSetID: attrSet.setId, attribute1: String(line.size_label), attribute2: String(line.color_normalized) };
  // Same margin override as ensureMatrix — the variant carries its own cost.
  let effectiveVariantCost = line.unit_cost;
  if (opts.brandMarginPct != null && Number(line.unit_price_retail) > 0) {
    effectiveVariantCost = Number((Number(line.unit_price_retail) * (1 - opts.brandMarginPct / 100)).toFixed(2));
  }
  const payload = buildItemPayload({
    matrixID:         line.matrix_id,
    size:             line.size_label,           // ignored downstream if isSingleAttr
    colorNormalized:  line.color_normalized,
    description:      `${line.supplier_style_ref} ${line.color_normalized}${attrSet.isSingleAttr ? '' : ' ' + line.size_label}`,
    manufacturerID:   opts.manufacturerID,
    defaultVendorID:  opts.defaultVendorID,
    defaultCost:      effectiveVariantCost,
    retailPrice:      line.unit_price_retail,
    attributeSetID:   attrSet.setId,
    vendorNum,
  });
  // Override the ItemAttributes with the schema-correct shape (buildItemPayload
  // always emits two-attribute; we replace when the matrix wants one).
  payload.ItemAttributes = attrs;
  const created = await client.createItemVariant(payload);
  const itemId = String(created.itemID);
  await setLine(pool, opts.tenantId, line.line_id, { item_id: itemId, status: 'variant_ensured' });
  line.item_id = itemId;
  line.status = 'variant_ensured';

  // 5. Local upsert into `products` — beats the sync freshness gate.
  await upsertCreatedProduct(pool, {
    tenantId:         opts.tenantId,
    item:             created,
    manufacturerName: opts.targetManufacturer,
    // No tag yet — that happens in the next step. On next sync, tags get merged.
  });
}

async function tagVariant(deps, opts, line) {
  const { pool, client } = deps;
  await client.tagItem(line.item_id, [opts.seasonTag]);
  await setLine(pool, opts.tenantId, line.line_id, { status: 'variant_tagged' });
  line.status = 'variant_tagged';
}

async function ensureOrder(deps, opts, batch) {
  const { pool, client } = deps;
  const payload = buildOrderPayload({
    batch,
    vendorID:        opts.defaultVendorID,
    shopID:          opts.destinationShopID,
    employeeID:      opts.employeeID,
    customOrderName: opts.customOrderName,
  });
  const created = await client.createOrder(payload);
  const orderId = String(created.orderID);
  await setBatch(pool, opts.tenantId, batch.batch_id, {
    lightspeed_order_id: orderId,
    status:              'pushing',
  });
  batch.lightspeed_order_id = orderId;
  return orderId;
}

async function createOrderLine(deps, opts, line, batch) {
  const { pool, client } = deps;
  // Same margin override — OrderLine's unitCost is what shows up in the PO
  // dollar total in Lightspeed, so it must match the matrix defaultCost.
  let effectiveOLCost = line.unit_cost;
  if (opts.brandMarginPct != null && Number(line.unit_price_retail) > 0) {
    effectiveOLCost = Number((Number(line.unit_price_retail) * (1 - opts.brandMarginPct / 100)).toFixed(2));
  }
  const payload = buildOrderLinePayload({
    orderID:  batch.lightspeed_order_id,
    itemID:   line.item_id,
    quantity: line.qty,
    unitCost: effectiveOLCost,
  });
  const created = await client.createOrderLine(batch.lightspeed_order_id, payload);
  const orderLineId = String(created.orderLineID ?? created.itemOrderLineID ?? created.id);
  await setLine(pool, opts.tenantId, line.line_id, {
    lightspeed_order_line_id: orderLineId,
    status:                    'ordered',
  });
  line.lightspeed_order_line_id = orderLineId;
  line.status = 'ordered';
}

// ─────────────────────────────────────────────────────────────────────────
// Main entry.
// deps: { pool, client }
// opts: { tenantId, fileId, seasonTag, targetManufacturer, manufacturerID,
//         defaultVendorID, destinationShopID, attributeSetID, resolutions,
//         employeeID (optional),
//         onLineDone (optional callback (line, summary)),
//         stopOnError (optional bool, default false) }
// ─────────────────────────────────────────────────────────────────────────
async function runImportPush(deps, opts) {
  if (!deps?.pool || !deps?.client) throw new Error('runImportPush: deps.pool and deps.client required');
  for (const k of ['tenantId', 'fileId', 'seasonTag', 'targetManufacturer', 'manufacturerID', 'defaultVendorID', 'destinationShopID', 'attributeSetID', 'resolutions']) {
    if (opts[k] == null) throw new Error(`runImportPush: opts.${k} required`);
  }
  const stopOnError = opts.stopOnError ?? false;
  const lines = await loadLinesForFile(deps.pool, opts.tenantId, opts.fileId);
  const batchCache = new Map(); // batch_id → batch obj (in-memory during this run)
  const summary = { total: lines.length, ordered: 0, error: 0, skipped: 0 };

  for (const line of lines) {
    if (line.status === 'ordered') { summary.skipped++; continue; }
    if (line.status === 'error')   { summary.skipped++; continue; }
    try {
      if (!line.matrix_id)                await ensureMatrix(deps, opts, line);
      if (!line.item_id)                  await ensureVariant(deps, opts, line);
      if (line.status !== 'variant_tagged' && line.status !== 'ordered') {
        await tagVariant(deps, opts, line);
      }
      // Ensure PO once per batch
      let batch = batchCache.get(line.batch_id);
      if (!batch) {
        batch = await loadBatch(deps.pool, opts.tenantId, line.batch_id);
        batchCache.set(line.batch_id, batch);
      }
      if (!batch.lightspeed_order_id) await ensureOrder(deps, opts, batch);
      if (!line.lightspeed_order_line_id) await createOrderLine(deps, opts, line, batch);
      summary.ordered++;
    } catch (e) {
      // Preserve the Lightspeed body when available — the naked message
      // ("POST /Item.json → HTTP 400") is not enough to debug from the DB.
      const bodyStr = e?.body ? ` ${JSON.stringify(e.body)}` : '';
      const msg = `${e?.message ?? 'unknown error'}${bodyStr}`.slice(0, 2000);
      await setLine(deps.pool, opts.tenantId, line.line_id, { status: 'error', error_message: msg });
      summary.error++;
      if (opts.onLineDone) opts.onLineDone(line, summary, e);
      if (stopOnError) throw e;
      continue;
    }
    if (opts.onLineDone) opts.onLineDone(line, summary, null);
  }

  return summary;
}

module.exports = {
  runImportPush,
  // Exported for tests & unit reuse:
  buildMatrixPayload,
  buildItemPayload,
  buildOrderPayload,
  buildOrderLinePayload,
};
