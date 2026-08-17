'use strict';
// ---------------------------------------------------------------------------
// lib/sync-tenant.js — per-tenant sync worker (commit B.1 extraction of sync.js)
//
// Extracted mechanically from sync.js. The old sync.js remains unchanged and
// continues to run in production against the primary tenant; this module is
// invoked by the future multi-tenant producer/worker with an explicit
// tenantId + pool.
//
// Design:
//   - All state (per-run counters, token cache, manufacturer map) lives on a
//     `ctx` object created fresh in each syncTenant() call.
//   - `ctx` is threaded through every helper — no module-level mutable state.
//   - pool arrives as a parameter (no module-level Pool).
//   - BASE_URL is built per-call from tenants.ls_account_id (with env fallback).
//   - Refresh-token rotation writes back to tenants.ls_refresh_token
//     (encrypted via lib/token-crypto), NOT to sync_state.refresh_token.
//   - Checkpoint reads/writes go to sync_checkpoints (PK is (tenant_id, step)).
//   - No ensureSchema() call — server.js boot handles migrations.
//   - No REFRESH MATERIALIZED VIEW — producer will orchestrate that.
//   - No keepalive setInterval — getAccessToken() self-refreshes on demand.
//   - No cron scheduling — the worker handles scheduling.
// ---------------------------------------------------------------------------

const axios = require('axios');
const { encrypt, decrypt } = require('./token-crypto');

const TOKEN_URL   = 'https://cloud.lightspeedapp.com/oauth/access_token.php';
const LIMIT       = 200;
const API_TIMEOUT = 60_000;

// Steps whose data doesn't change daily — only re-sync if stale (> STATIC_SYNC_DAYS old).
// Time-filtered steps (sales, orders, transfers) always re-run to pick up the daily delta.
const STATIC_STEPS     = new Set(['shops', 'items', 'item_matrices', 'inventory']);
const STATIC_SYNC_DAYS = parseInt(process.env.STATIC_SYNC_DAYS ?? '1', 10);
const SYNC_STEPS       = ['shops', 'items', 'item_matrices', 'inventory', 'sales', 'orders', 'transfers'];

// ---------------------------------------------------------------------------
// Context factory — one per syncTenant() invocation. Holds pool, tenant scope,
// Lightspeed base URL, OAuth cache, and per-run counters.
// ---------------------------------------------------------------------------
function makeCtx(pool, tenantId, tenantRow) {
  const accountId = tenantRow.ls_account_id ?? process.env.LIGHTSPEED_ACCOUNT_ID;
  if (!accountId) {
    throw new Error(`syncTenant(${tenantId}): no ls_account_id in tenants row and no LIGHTSPEED_ACCOUNT_ID env var`);
  }
  return {
    pool,
    tenantId,
    baseUrl: `https://api.lightspeedapp.com/API/V3/Account/${accountId}`,
    // OAuth2 access-token cache + current refresh token (decrypted).
    // The refresh token here is the plaintext; when Lightspeed rotates it,
    // we re-encrypt via token-crypto before writing back to tenants row.
    auth: {
      cachedToken:    null,
      tokenExpiresAt: 0,
      refreshToken:   tenantRow.ls_refresh_token ? decrypt(tenantRow.ls_refresh_token) : null,
    },
    // Orphan rescue counters — reset per run.
    state: {
      orphanRescuedCount: 0, // item fetched from Lightspeed API and inserted into products
      orphanStubCount:    0, // item not found in API — minimal stub created
      orphanSkippedCount: 0, // rescue failed (shouldn't happen) — line still lost
      rescuedItemIds:     new Set(), // dedup: avoid re-fetching same item_id in one run
      // Manufacturer resolution — populated by syncManufacturers() at start of runSync.
      mfgMap:             new Map(), // manufacturerID (string) → name
      unresolvedMfgCount: 0,         // items upserted this run whose manufacturer couldn't be resolved
    },
  };
}

// ---------------------------------------------------------------------------
// OAuth2 — access token cache + rotation-safe refresh token persistence.
// Lightspeed rotates the refresh_token on every exchange; we persist the
// latest one to tenants.ls_refresh_token (encrypted). If Lightspeed rejects
// the current token, we fall back to the env var as a last resort.
// ---------------------------------------------------------------------------
async function fetchToken(refreshToken) {
  const { data } = await axios.post(TOKEN_URL, new URLSearchParams({
    client_id:     process.env.LIGHTSPEED_CLIENT_ID,
    client_secret: process.env.LIGHTSPEED_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type:    'refresh_token',
  }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  return data;
}

async function saveRefreshToken(ctx, token) {
  const encrypted = encrypt(token);
  await ctx.pool.query(
    `UPDATE tenants SET ls_refresh_token = $1 WHERE id = $2`,
    [encrypted, ctx.tenantId],
  );
  ctx.auth.refreshToken = token;
  console.log(`[sync:${ctx.tenantId}] Token refreshed and persisted (encrypted) to tenants row`);
}

async function getAccessToken(ctx) {
  if (ctx.auth.cachedToken && Date.now() < ctx.auth.tokenExpiresAt - 30_000) {
    return ctx.auth.cachedToken;
  }

  const dbToken  = ctx.auth.refreshToken;
  const envToken = process.env.LIGHTSPEED_REFRESH_TOKEN;

  let data;
  try {
    if (!dbToken) throw new Error('no refresh token in tenants row');
    data = await fetchToken(dbToken);
  } catch (firstErr) {
    // DB token may have been consumed or absent — fall back to env var as last resort
    if (envToken && dbToken !== envToken) {
      console.log(`[sync:${ctx.tenantId}] DB refresh token rejected, falling back to env var…`);
      data = await fetchToken(envToken);
    } else {
      throw firstErr;
    }
  }

  ctx.auth.cachedToken    = data.access_token;
  ctx.auth.tokenExpiresAt = Date.now() + data.expires_in * 1000;
  if (data.refresh_token) await saveRefreshToken(ctx, data.refresh_token);

  return ctx.auth.cachedToken;
}

async function apiClient(ctx) {
  const token = await getAccessToken(ctx);
  return axios.create({
    baseURL: ctx.baseUrl,
    timeout: API_TIMEOUT,
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function fetchWithRetry(url, headers, retries = 6) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await axios.get(url, { headers, timeout: API_TIMEOUT });
      return res;
    } catch (err) {
      const status = err.response?.status ?? 0;
      const isRateLimit = status === 429;
      const isRetriable = isRateLimit || err.code === 'ECONNABORTED' || status >= 500;
      if (isRetriable && attempt < retries) {
        // Honour Retry-After header if present, else exponential backoff (max 60s)
        const retryAfter = parseInt(err.response?.headers?.['retry-after'] ?? '0', 10);
        const delay = isRateLimit
          ? Math.max(retryAfter * 1000, 5000)
          : Math.min(2000 * Math.pow(2, attempt - 1), 60000);
        console.log(`[sync] ${isRateLimit ? 'Rate limited' : 'Error'} — waiting ${delay / 1000}s before retry ${attempt}/${retries - 1}`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Checkpoint helpers — all scoped by tenant_id via the sync_checkpoints table
// (PK is (tenant_id, step), so concurrent tenants never race on the same key).
//
// Historical note: an earlier sync.js used the sync_state table which had a
// single-column PK on step, meaning two tenants writing the same step name
// would clobber each other. B.3 migrated this module to sync_checkpoints;
// the sync_state table is preserved for a transition window and dropped
// in commit B.5.
// ---------------------------------------------------------------------------
async function getCheckpoint(ctx, step) {
  const { rows } = await ctx.pool.query(
    'SELECT next_url, processed_count, updated_at FROM sync_checkpoints WHERE tenant_id = $1 AND step = $2',
    [ctx.tenantId, step],
  );
  return rows[0] ?? null;
}

async function saveCheckpoint(ctx, step, nextUrl, processedCount) {
  await ctx.pool.query(
    `INSERT INTO sync_checkpoints(tenant_id, step, next_url, processed_count, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT(tenant_id, step) DO UPDATE
       SET next_url = $3, processed_count = $4, updated_at = now()`,
    [ctx.tenantId, step, nextUrl, processedCount],
  );
}

// Mark a step as fully completed — skipped on resume
async function markStepCompleted(ctx, step, processedCount = 0) {
  await ctx.pool.query(
    `INSERT INTO sync_checkpoints(tenant_id, step, next_url, processed_count, updated_at)
     VALUES ($1, $2, 'COMPLETED', $3, now())
     ON CONFLICT(tenant_id, step) DO UPDATE
       SET next_url = 'COMPLETED', processed_count = $3, updated_at = now()`,
    [ctx.tenantId, step, processedCount],
  );
}

async function clearCheckpoint(ctx, step) {
  await ctx.pool.query('DELETE FROM sync_checkpoints WHERE tenant_id = $1 AND step = $2', [ctx.tenantId, step]);
}

function cpLabel(cp) {
  if (!cp) return 'pending';
  if (cp.next_url === 'COMPLETED') return `completed (${cp.processed_count})`;
  return `resuming at offset ${cp.processed_count}`;
}

// ---------------------------------------------------------------------------
// Paginated fetch — cursor-based. Yields { items, nextUrl } per page.
// Always calls getAccessToken() for every request so token refreshes are
// picked up mid-sync. The axios `client` arg is kept for signature
// compatibility but NOT used for HTTP calls — the client instance has the
// initial token baked in and would be stale after a long prior step.
// ---------------------------------------------------------------------------
// Rebuild a Lightspeed next-page URL so our original params (e.g. load_relations)
// are always present. Lightspeed's @attributes.next only carries cursor params
// (sort, after, limit) — it never echoes back load_relations or filter params.
function rebuildUrl(ctx, resource, params, lightspeedNextUrl) {
  const parsed    = new URL(lightspeedNextUrl);
  const after     = parsed.searchParams.get('after');
  const sortParam = parsed.searchParams.get('sort');
  const rebuilt   = { ...params, limit: String(LIMIT) };
  if (sortParam) rebuilt.sort  = sortParam;
  if (after)     rebuilt.after = after;
  return `${ctx.baseUrl}/${resource}.json?${new URLSearchParams(rebuilt)}`;
}

async function* paginate(ctx, _client, resource, params = {}, resumeUrl = null) {
  // First URL: if resuming use checkpoint cursor but re-inject original params;
  // otherwise build fresh from ctx.baseUrl.
  let url;
  if (resumeUrl) {
    try {
      url = rebuildUrl(ctx, resource, params, resumeUrl);
    } catch {
      url = resumeUrl; // fallback for malformed URLs
    }
  } else {
    url = `${ctx.baseUrl}/${resource}.json?${new URLSearchParams({ ...params, limit: String(LIMIT) })}`;
  }

  while (true) {
    const token    = await getAccessToken(ctx);
    const response = await fetchWithRetry(url, { Authorization: `Bearer ${token}` });

    const { data } = response;
    const key     = Object.keys(data).find(k => k !== '@attributes');
    const wrapper = key ? data[key] : null;
    const items   = Array.isArray(wrapper) ? wrapper : wrapper ? [wrapper] : [];

    if (items.length === 0) break;

    const lsNextUrl = data['@attributes']?.next ?? null;
    // Always save the raw LS next URL as checkpoint (contains the cursor);
    // but rebuild it with our params before fetching.
    yield { items, nextUrl: lsNextUrl };

    if (!lsNextUrl) break;
    try {
      url = rebuildUrl(ctx, resource, params, lsNextUrl);
    } catch {
      url = lsNextUrl; // fallback: use raw URL if rebuild fails
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function numOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

// ---------------------------------------------------------------------------
// ensureSchema() intentionally removed — server.js runs all DDL migrations
// at boot time. Keeping this comment as a marker.
// TODO cleanup B.5 — delete this comment once server.js boot ordering is
// proven to always run migrations before any syncTenant() invocation.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ItemAttributeSet sync — fetches set definitions (attribute axis labels) from Lightspeed.
// Each set has a name and attribute1/2/3 labels (e.g. "Taille Col", "Coupe").
// Products reference a set via raw->'ItemAttributes'->>'itemAttributeSetID'.
// Tiny dataset (~10-100 rows), always full sync, no checkpoint needed.
// ---------------------------------------------------------------------------
async function syncItemAttributeSets(ctx) {
  const tenantId = ctx.tenantId;
  let count = 0;
  for await (const { items } of paginate(ctx, null, 'ItemAttributeSet', {})) {
    for (const s of items) {
      const setId = String(s.itemAttributeSetID ?? '');
      if (!setId || setId === '0') continue;
      const l1 = s.attributeName1 ?? null;
      const l2 = s.attributeName2 ?? null;
      const l3 = s.attributeName3 ?? null;

      // Upsert labels — never touch size_axis/color_axis here (protected from manual override).
      await ctx.pool.query(`
        INSERT INTO item_attribute_sets
          (tenant_id, attribute_set_id, name, attribute1_label, attribute2_label, attribute3_label, synced_at)
        VALUES ($1,$2,$3,$4,$5,$6,now())
        ON CONFLICT(tenant_id, attribute_set_id) DO UPDATE
          SET name=$3, attribute1_label=$4, attribute2_label=$5, attribute3_label=$6, synced_at=now()
      `, [tenantId, setId, s.name ?? null, l1, l2, l3]);

      // Auto-detect size_axis/color_axis from labels — COALESCE keeps any existing manual value.
      const labels = [l1, l2, l3];
      const detectedSize  = labels.findIndex(l => l && (/taille/i.test(l) || /size/i.test(l)));
      const detectedColor = labels.findIndex(l => l && (/couleur/i.test(l) || /color/i.test(l)));
      const sizeAxis  = detectedSize  >= 0 ? detectedSize  + 1 : null; // 1-indexed
      const colorAxis = detectedColor >= 0 ? detectedColor + 1 : null;

      // COALESCE(size_axis, $3) — keeps existing manual value if set, writes detected value if NULL.
      await ctx.pool.query(`
        UPDATE item_attribute_sets
        SET size_axis  = COALESCE(size_axis,  $3),
            color_axis = COALESCE(color_axis, $4)
        WHERE tenant_id = $1 AND attribute_set_id = $2
      `, [tenantId, setId, sizeAxis, colorAxis]);

      count++;
    }
  }

  // Warn for any set that still has no size_axis after auto-detection — needs manual PATCH.
  const { rows: undetected } = await ctx.pool.query(`
    SELECT attribute_set_id, name, attribute1_label, attribute2_label, attribute3_label
    FROM   item_attribute_sets
    WHERE  tenant_id = $1 AND size_axis IS NULL
  `, [tenantId]);
  for (const r of undetected) {
    console.warn(
      `[WARNING] attribute-set ${r.attribute_set_id} "${r.name}" — size_axis not auto-detected. ` +
      `Labels: attr1="${r.attribute1_label}" attr2="${r.attribute2_label}" attr3="${r.attribute3_label}". ` +
      `Use PATCH /api/admin/attribute-sets/${r.attribute_set_id} to configure manually.`
    );
  }

  console.log(`[sync] ItemAttributeSets synced: ${count}`);
  return count;
}

// ---------------------------------------------------------------------------
// Manufacturer sync — fetches all Lightspeed manufacturers into a local table
// so upsertProducts can resolve numeric IDs even when Manufacturer relation is null.
// Always runs in full (tiny dataset, no checkpoint needed).
// ---------------------------------------------------------------------------
async function syncManufacturers(ctx) {
  const tenantId = ctx.tenantId;
  const map = new Map();
  let count = 0;
  for await (const { items } of paginate(ctx, null, 'Manufacturer', {})) {
    for (const m of items) {
      const id   = String(m.manufacturerID ?? '');
      const name = m.name ?? null;
      if (!id || !name) continue;
      map.set(id, name);
      await ctx.pool.query(
        `INSERT INTO manufacturers(tenant_id, manufacturer_id, name)
         VALUES ($1, $2, $3)
         ON CONFLICT(tenant_id, manufacturer_id) DO UPDATE SET name = $3`,
        [tenantId, id, name],
      );
      count++;
    }
  }
  ctx.state.mfgMap = map;
  console.log(`[sync] Manufacturers synced: ${count} (map size: ${map.size})`);
}

// ---------------------------------------------------------------------------
// Backfill — resolves existing products that still have a numeric manufacturer_id
// stored as text (artifact of the old fallback before manufacturers table existed).
// Idempotent: only touches rows where manufacturer ~ '^[0-9]+$'.
// ---------------------------------------------------------------------------
async function backfillNumericManufacturers(ctx) {
  const tenantId = ctx.tenantId;
  // Replace stored numeric IDs with real names from the manufacturers table.
  const { rowCount: resolved } = await ctx.pool.query(
    `UPDATE products p
     SET manufacturer = m.name, synced_at = now()
     FROM manufacturers m
     WHERE p.tenant_id = $1
       AND m.tenant_id = $1
       AND m.manufacturer_id = p.manufacturer
       AND p.manufacturer ~ '^[0-9]+$'`,
    [tenantId],
  );
  // manufacturerID=0 is Lightspeed's "no manufacturer" sentinel — set to NULL.
  const { rowCount: zeroed } = await ctx.pool.query(
    `UPDATE products SET manufacturer = NULL, synced_at = now()
     WHERE tenant_id = $1 AND manufacturer = '0'`,
    [tenantId],
  );
  if (resolved > 0 || zeroed > 0) {
    console.log(`[sync] Backfill manufacturers: ${resolved} IDs → name, ${zeroed} ID=0 → NULL`);
  }
}

// ---------------------------------------------------------------------------
// ItemMatrix upsert — one row per matrix, description is the clean model name.
// ---------------------------------------------------------------------------
async function upsertItemMatrices(ctx, matrices) {
  const tenantId = ctx.tenantId;
  for (const mx of matrices) {
    const matrixId = String(mx.itemMatrixID ?? '');
    if (!matrixId || matrixId === '0') continue;
    await ctx.pool.query(`
      INSERT INTO item_matrices (tenant_id, matrix_id, description, manufacturer_id, category_id, attribute_set_id, synced_at)
      VALUES ($1, $2, $3, $4, $5, $6, now())
      ON CONFLICT (tenant_id, matrix_id) DO UPDATE
        SET description = $3, manufacturer_id = $4, category_id = $5, attribute_set_id = $6, synced_at = now()
    `, [
      tenantId,
      matrixId,
      mx.description ?? null,
      mx.manufacturerID ? String(mx.manufacturerID) : null,
      mx.categoryID     ? String(mx.categoryID)     : null,
      mx.itemAttributeSetID ? String(mx.itemAttributeSetID) : null,
    ]);
  }
}

// ---------------------------------------------------------------------------
// Upsert helpers
// ---------------------------------------------------------------------------
async function upsertShops(ctx, rows) {
  const tenantId = ctx.tenantId;
  for (const s of rows) {
    await ctx.pool.query(
      `INSERT INTO shops(shop_id, name, time_zone, raw, tenant_id)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT(tenant_id, shop_id) DO UPDATE
         SET name=$2, time_zone=$3, raw=$4, synced_at=now()`,
      [s.shopID, s.name, s.timeZone ?? null, s, tenantId],
    );
  }
}

async function upsertProducts(ctx, rows) {
  const tenantId = ctx.tenantId;
  for (const item of rows) {
    // Category: prefer fullPathName from loaded relation, fall back to raw ID
    const category = item.Category?.fullPathName ?? item.Category?.name ?? item.categoryID ?? null;

    // Manufacturer: prefer relation name, then local table lookup, then null.
    // Never fall back to the raw numeric ID — store null and count as unresolved instead.
    const manufacturer = item.Manufacturer?.name
      ?? ctx.state.mfgMap.get(String(item.manufacturerID ?? ''))
      ?? null;
    if (manufacturer === null && item.manufacturerID && String(item.manufacturerID) !== '0') {
      ctx.state.unresolvedMfgCount++;
    }

    // Tags: Tags.tag is a CSV string ("NOS,A26") or false/absent when none
    const tagsRaw = item.Tags?.tag;
    const tags = (tagsRaw && tagsRaw !== 'false') ? String(tagsRaw).trim() : null;

    // Image: pick the Image with ordering=0 (or first in array), build Cloudinary URL
    let imageUrl = null;
    const imgRelation = item.Images;
    if (imgRelation && imgRelation !== false && imgRelation !== 'false') {
      const imgList = imgRelation.Image;
      const imgs = Array.isArray(imgList) ? imgList : imgList ? [imgList] : [];
      const primary = imgs.sort((a, b) => Number(a.ordering) - Number(b.ordering))[0];
      if (primary?.baseImageURL && primary?.publicID) {
        imageUrl = primary.baseImageURL + primary.publicID;
      }
    }

    const defaultPrice = item.Prices?.ItemPrice?.[0]?.amount ?? item.defaultPrice ?? null;

    await ctx.pool.query(
      `INSERT INTO products(item_id, matrix_id, description, ean, upc, manufacturer, brand,
         category, department, tags, image_url, default_cost, default_price, archived, raw, tenant_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT(tenant_id, item_id) DO UPDATE
         SET matrix_id=$2, description=$3, ean=$4, upc=$5, manufacturer=$6, brand=$7,
             category=$8, department=$9, tags=$10, image_url=$11,
             default_cost=$12, default_price=$13, archived=$14, raw=$15,
             stub_inferred_fields=NULL, synced_at=now()`,
      [
        item.itemID, item.itemMatrixID ?? null,
        item.description, item.ean ?? null, item.upc ?? null,
        manufacturer, null,
        category, item.departmentID ?? null,
        tags, imageUrl,
        item.defaultCost ?? null, defaultPrice,
        item.archived === 'true', item, tenantId,
      ],
    );
  }
}

async function upsertInventory(ctx, rows) {
  const tenantId = ctx.tenantId;
  for (const is of rows) {
    try {
      await ctx.pool.query(
        `INSERT INTO inventory(item_id, shop_id, qty_on_hand, qty_on_order, reorder_point, reorder_level, raw, tenant_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT(tenant_id, item_id, shop_id) DO UPDATE
           SET qty_on_hand=$3, qty_on_order=$4, reorder_point=$5, reorder_level=$6,
               raw=$7, synced_at=now()`,
        [
          is.itemID, is.shopID,
          is.qoh ?? 0, is.qoo ?? 0,
          is.reorderPoint ?? null, is.reorderLevel ?? null,
          is, tenantId,
        ],
      );
    } catch (err) {
      if (err.code === '23503') continue; // orphaned ItemShop — silently skip
      throw err;
    }
  }
}

async function upsertSales(ctx, rows) {
  const tenantId = ctx.tenantId;
  for (const s of rows) {
    try {
      await ctx.pool.query(
        `INSERT INTO sales(sale_id, shop_id, register_id, customer_id, completed_time, total, discount, tax, raw, tenant_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT(tenant_id, sale_id) DO UPDATE
           SET shop_id=$2, completed_time=$5, total=$6, discount=$7, tax=$8, raw=$9, synced_at=now()`,
        [
          s.saleID, s.shopID ?? null, s.registerID ?? null, s.customerID ?? null,
          s.completeTime ?? s.completedTime ?? null,
          numOrNull(s.calcTotal), numOrNull(s.calcDiscount), numOrNull(s.calcTax),
          s, tenantId,
        ],
      );
    } catch (err) {
      if (err.code === '23503') continue;
      throw err;
    }
  }
}

async function upsertSaleLines(ctx, rows, completedTime) {
  const tenantId = ctx.tenantId;
  const sql = `INSERT INTO sale_lines(sale_line_id, sale_id, item_id, shop_id,
      unit_price, unit_cost, qty, discount, tax, completed_time, raw, tenant_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT(tenant_id, sale_line_id) DO UPDATE
      SET item_id=$3, shop_id=$4, unit_price=$5, unit_cost=$6, qty=$7,
          discount=$8, tax=$9, completed_time=$10, raw=$11, synced_at=now()`;

  for (const sl of rows) {
    const params = [
      sl.saleLineID, sl.saleID ?? null,
      sl.itemID ?? null, sl.shopID ?? null,
      numOrNull(sl.unitPrice), numOrNull(sl.unitCost),
      numOrNull(sl.unitQuantity), numOrNull(sl.calcLineDiscount), numOrNull(sl.tax),
      completedTime ?? null,
      sl, tenantId,
    ];

    try {
      await ctx.pool.query(sql, params);
    } catch (err) {
      if (err.code !== '23503') throw err;

      // FK violation: determine if it's the products constraint specifically.
      // PostgreSQL detail says: Key (tenant_id, item_id)=(...) is not present in table "products".
      const isProductFK = err.detail?.includes('"products"');

      if (isProductFK && sl.itemID && sl.itemID !== '0') {
        // item_id=0 = generic/manual line with no real product — skip silently.
        // All other orphan item_ids: rescue (fetch from API or create stub), then retry.
        await rescueOrphanProduct(ctx, sl.itemID, sl);
        try {
          await ctx.pool.query(sql, params);
        } catch (retryErr) {
          // Should not happen — rescue always creates at least a stub.
          ctx.state.orphanSkippedCount++;
          console.error(`[sync] [ORPHAN] ❌ retry échoué sale_line_id=${sl.saleLineID} item_id=${sl.itemID}: ${retryErr.message}`);
        }
      } else {
        // Other FK (shop_id, sale_id) or item_id=0 — keep existing silent-skip behavior.
        continue;
      }
    }
  }
}

async function upsertTransfers(ctx, transfers) {
  const tenantId = ctx.tenantId;
  for (const t of transfers) {
    const fromShopId = t.TransferFrom?.shopID  ?? null;
    const toShopId   = t.TransferTo?.shopID    ?? null;
    // Prefer the actual sent timestamp; fall back to record creation time
    const transferDate = t.TransferFrom?.sentOn ?? t.timeStamp ?? null;
    const note         = t.note || null;
    const tSent        = t.sent     === 'true';
    const tReceived    = t.received === 'true';

    // TransferItems is "" (empty string) when the transfer has no line items
    const itemsWrapper = t.TransferItems;
    if (!itemsWrapper || itemsWrapper === '' || itemsWrapper === false) continue;

    const rawItems = itemsWrapper.TransferItem;
    const items    = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];

    for (const ti of items) {
      try {
        await ctx.pool.query(
          `INSERT INTO transfers(
             transfer_item_id, transfer_id, from_shop_id, to_shop_id,
             item_id, qty_sent, qty_received,
             transfer_sent, transfer_received, transfer_date, note, raw, tenant_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT(tenant_id, transfer_item_id) DO UPDATE
             SET transfer_id=$2, from_shop_id=$3, to_shop_id=$4,
                 item_id=$5, qty_sent=$6, qty_received=$7,
                 transfer_sent=$8, transfer_received=$9,
                 transfer_date=$10, note=$11, raw=$12, synced_at=now()`,
          [
            ti.transferItemID, t.transferID,
            fromShopId, toShopId,
            ti.itemID ?? null,
            numOrNull(ti.sent)     ?? 0,
            numOrNull(ti.received) ?? 0,
            tSent, tReceived,
            transferDate, note,
            { header: t, item: ti }, tenantId,
          ],
        );
      } catch (err) {
        if (err.code === '23503') continue; // orphaned FK (item or shop not yet synced)
        throw err;
      }
    }
  }
}

async function upsertOrders(ctx, rows) {
  const tenantId = ctx.tenantId;
  for (const o of rows) {
    await ctx.pool.query(
      `INSERT INTO orders(order_id, shop_id, vendor_id, status, order_date, eta, total, raw, tenant_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT(tenant_id, order_id) DO UPDATE
         SET shop_id=$2, vendor_id=$3, status=$4, order_date=$5, eta=$6,
             total=$7, raw=$8, synced_at=now()`,
      [
        o.orderID, o.shopID ?? null, o.vendorID ?? null,
        o.orderStatus ?? null,
        o.orderDate ?? null, o.eta ?? null,
        numOrNull(o.total), o, tenantId,
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Orphan rescue — called when upsertSaleLines gets a FK violation on products
// ---------------------------------------------------------------------------
async function rescueOrphanProduct(ctx, itemId, slContext) {
  const tenantId = ctx.tenantId;
  const cacheKey = `${tenantId}:${itemId}`;
  if (ctx.state.rescuedItemIds.has(cacheKey)) return; // already handled this run — retry will work
  ctx.state.rescuedItemIds.add(cacheKey);

  // 1. Try Lightspeed API (handles archived items; may also work for recently deleted)
  try {
    const token = await getAccessToken(ctx);
    const rels  = encodeURIComponent(JSON.stringify(['Tags', 'Category', 'Manufacturer']));
    const res   = await fetchWithRetry(
      `${ctx.baseUrl}/Item/${itemId}.json?load_relations=${rels}`,
      { Authorization: `Bearer ${token}` },
      3,
    );
    const item = res.data?.Item;
    if (item) {
      await upsertProducts(ctx, [item]);
      ctx.state.orphanRescuedCount++;
      console.log(`[sync] [ORPHAN] ✓ item_id=${itemId} récupéré via API Lightspeed`);
      return;
    }
  } catch (apiErr) {
    const status = apiErr.response?.status;
    if (status !== 404) {
      // Unexpected error — log but fall through to stub
      console.warn(`[sync] [ORPHAN] ⚠ item_id=${itemId}: erreur API ${status ?? apiErr.message}`);
    }
    // 404 = genuinely deleted — fall through to stub
  }

  // 2. Fallback: minimal stub so the sale_line FK passes.
  //    avgCost from the SaleLine raw is used as default_cost (best we have without the Item record).
  //    Tags = '__stub__' only — no inferred season here. User will tag manually via audit query.
  //    stub_inferred_fields = 'all' marks everything as unknown.
  const avgCost = slContext?.avgCost ? numOrNull(slContext.avgCost) : null;
  await ctx.pool.query(
    `INSERT INTO products(item_id, description, manufacturer, tags, archived, default_cost, tenant_id, stub_inferred_fields)
     VALUES ($1, $2, NULL, '__stub__', true, $3, $4, 'all')
     ON CONFLICT(tenant_id, item_id) DO NOTHING`,
    [itemId, `[supprimé-${itemId}]`, avgCost, tenantId],
  );
  ctx.state.orphanStubCount++;
  console.log(`[sync] [ORPHAN] ⚠ item_id=${itemId}: introuvable en API — stub créé (default_cost=${avgCost ?? 'N/A'})`);
}

// ---------------------------------------------------------------------------
// Quality audit — run after each sync to surface data health issues.
// Results stored in sync_checkpoints so they're visible in monitoring/dashboard.
// Window: items sold in the last 365 days (rolling, non-stubs only).
// ---------------------------------------------------------------------------
async function computeAndSaveQualityCounters(ctx) {
  const tenantId = ctx.tenantId;
  const [r1, r2, r3, r4] = await Promise.all([
    // Detect items where a numeric manufacturer_id was stored as the name.
    // Uses a JOIN on manufacturers so legitimate numeric brand names (e.g. "0909")
    // are excluded — they exist as a name in the table, not as a manufacturer_id.
    ctx.pool.query(
      `SELECT COUNT(DISTINCT p.item_id) AS n
       FROM products p
       JOIN sale_lines sl ON sl.item_id = p.item_id AND sl.tenant_id = p.tenant_id
       JOIN manufacturers m ON m.tenant_id = p.tenant_id AND m.manufacturer_id = p.manufacturer
       WHERE p.tenant_id = $1
         AND p.stub_inferred_fields IS NULL
         AND sl.completed_time > now() - interval '365 days'`,
      [tenantId],
    ),
    ctx.pool.query(
      `SELECT COUNT(DISTINCT sl.item_id) AS n
       FROM sale_lines sl
       JOIN products p ON p.item_id = sl.item_id AND p.tenant_id = sl.tenant_id
       WHERE sl.tenant_id = $1
         AND p.tags IS NULL
         AND p.stub_inferred_fields IS NULL
         AND sl.completed_time > now() - interval '365 days'`,
      [tenantId],
    ),
    ctx.pool.query(
      `SELECT COUNT(DISTINCT sl.item_id) AS n
       FROM sale_lines sl
       JOIN products p ON p.item_id = sl.item_id AND p.tenant_id = sl.tenant_id
       WHERE sl.tenant_id = $1
         AND (p.default_cost IS NULL OR p.default_cost = 0)
         AND p.stub_inferred_fields IS NULL
         AND sl.completed_time > now() - interval '365 days'`,
      [tenantId],
    ),
    // Count units sitting in shop_ids not present in the shops table ("phantom shops").
    // In Lightspeed R-Series, shop_id=0 is a virtual location (HQ / items in transit /
    // unallocated). Lightspeed's own "Inventory Assets by Location" report excludes it.
    // This counter tracks how much value is invisible to our snapshot and to Lightspeed.
    ctx.pool.query(
      `SELECT COALESCE(SUM(i.qty_on_hand), 0)::int AS n
       FROM inventory i
       WHERE i.tenant_id = $1
         AND i.qty_on_hand > 0
         AND NOT EXISTS (
           SELECT 1 FROM shops sh
           WHERE sh.shop_id = i.shop_id AND sh.tenant_id = i.tenant_id
         )`,
      [tenantId],
    ),
  ]);

  const unresolvedMfg  = Number(r1.rows[0].n);
  const noTags         = Number(r2.rows[0].n);
  const noCost         = Number(r3.rows[0].n);
  const phantomUnits   = Number(r4.rows[0].n);

  console.log('[sync] ── Qualité données ─────────────────────────────────');
  console.log(`[sync]   Manufacturier non résolu (vendus 365j) : ${unresolvedMfg} items`);
  console.log(`[sync]   Vendus sans tags (365j)                : ${noTags} items`);
  console.log(`[sync]   Vendus sans coût (365j)                : ${noCost} items`);
  console.log(`[sync]   Unités boutique fantôme (shop non mappé): ${phantomUnits} u`);
  if (ctx.state.unresolvedMfgCount > 0) {
    console.log(`[sync]   Non résolus ce run                     : ${ctx.state.unresolvedMfgCount} items`);
  }
  console.log('[sync] ─────────────────────────────────────────────────────');

  for (const [step, value] of [
    ['quality_unresolved_mfg',      unresolvedMfg],
    ['quality_no_tags',             noTags],
    ['quality_no_cost',             noCost],
    ['quality_phantom_shop_units',  phantomUnits],
    ['quality_unresolved_mfg_run',  ctx.state.unresolvedMfgCount],
  ]) {
    await ctx.pool.query(
      `INSERT INTO sync_checkpoints(tenant_id, step, next_url, processed_count, updated_at)
       VALUES ($1, $2, 'COMPLETED', $3, now())
       ON CONFLICT(tenant_id, step) DO UPDATE SET processed_count = $3, updated_at = now()`,
      [tenantId, step, value],
    );
  }
}

// ---------------------------------------------------------------------------
// Inventory snapshot — daily EOD capture of stock state.
// Called once per sync run, after MV refresh. ON CONFLICT DO NOTHING ensures
// that if the sync runs twice on the same day, the first snapshot is kept.
//
// Retention: detail rows live 400 days (year-over-year comparisons).
// Before purging, complete months older than 400 days are aggregated into
// inventory_snapshots_monthly (average daily qty/value per shop×manufacturer).
// ---------------------------------------------------------------------------
async function snapshotInventory(ctx) {
  const tenantId = ctx.tenantId;
  const today = new Date().toISOString().slice(0, 10);

  // ── 1. Aggregate complete months about to be purged ──────────────────────
  // A "complete month" is one where every day is older than 400 days, i.e.
  // the month ended before (today − 400 days). We aggregate before purging.
  const cutoffMonth = new Date();
  cutoffMonth.setDate(cutoffMonth.getDate() - 400);
  const cutoffMonthStr = cutoffMonth.toISOString().slice(0, 7) + '-01';

  await ctx.pool.query(`
    INSERT INTO inventory_snapshots_monthly
      (tenant_id, month, shop_id, manufacturer, total_qty, total_cost_value, total_retail_value)
    SELECT
      s.tenant_id,
      date_trunc('month', s.snapshot_date)::date                               AS month,
      s.shop_id,
      COALESCE(p.manufacturer, '')                                              AS manufacturer,
      ROUND(AVG(s.qty))::int                                                    AS total_qty,
      ROUND(AVG(s.qty * COALESCE(s.unit_cost, 0))::numeric, 2)                 AS total_cost_value,
      ROUND(AVG(s.qty * COALESCE(s.unit_price, 0))::numeric, 2)                AS total_retail_value
    FROM inventory_snapshots s
    JOIN products p ON p.item_id = s.item_id AND p.tenant_id = s.tenant_id
    WHERE s.tenant_id = $1
      AND s.snapshot_date < $2::date
    GROUP BY s.tenant_id, date_trunc('month', s.snapshot_date)::date, s.shop_id, COALESCE(p.manufacturer, '')
    ON CONFLICT (tenant_id, month, shop_id, manufacturer) DO NOTHING
  `, [tenantId, cutoffMonthStr]);

  // ── 2. Purge detail rows older than 400 days ─────────────────────────────
  const { rowCount: purged } = await ctx.pool.query(`
    DELETE FROM inventory_snapshots
    WHERE tenant_id = $1 AND snapshot_date < current_date - interval '400 days'
  `, [tenantId]);
  if (purged > 0) console.log(`[sync] Snapshot inventaire : ${purged} lignes purgées (>400j)`);

  // ── 3. Capture today's snapshot ──────────────────────────────────────────
  const { rowCount } = await ctx.pool.query(`
    INSERT INTO inventory_snapshots (tenant_id, snapshot_date, item_id, shop_id, qty, unit_cost, unit_price)
    SELECT
      i.tenant_id,
      $1::date,
      i.item_id,
      i.shop_id,
      i.qty_on_hand::int,
      p.default_cost,
      p.default_price
    FROM inventory i
    JOIN products p  ON p.item_id  = i.item_id  AND p.tenant_id = i.tenant_id
    JOIN shops    sh ON sh.shop_id = i.shop_id   AND sh.tenant_id = i.tenant_id
    WHERE i.tenant_id = $2
      AND i.qty_on_hand != 0
      AND p.archived = false
    ON CONFLICT DO NOTHING
  `, [today, tenantId]);

  console.log(`[sync] Snapshot inventaire : ${rowCount} lignes pour ${today}`);

  for (const [step, val] of [
    ['snapshot_last_date', today],
    ['snapshot_rows',      String(rowCount)],
  ]) {
    await ctx.pool.query(`
      INSERT INTO sync_checkpoints(tenant_id, step, next_url, processed_count, updated_at)
      VALUES ($1, $2, $3, $4, now())
      ON CONFLICT(tenant_id, step) DO UPDATE SET next_url = $3, processed_count = $4, updated_at = now()
    `, [tenantId, step, val, rowCount]);
  }
}

// ---------------------------------------------------------------------------
// refreshMaterializedView — kept exported for the future producer/worker.
// Intentionally NOT called from syncTenant() (per B.1 audit point G).
// The producer will orchestrate MV refresh once, after all per-tenant syncs
// complete, to avoid duplicate work in multi-tenant deployments.
// ---------------------------------------------------------------------------
async function refreshMaterializedView(pool, viewName) {
  try {
    await pool.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${viewName}`);
  } catch (err) {
    const msg = String(err.message || err);
    if (msg.includes('does not have a unique index') || msg.includes('cannot refresh materialized view concurrently') || msg.includes('CONCURRENTLY')) {
      console.warn(`[sync] Concurrent refresh failed for ${viewName}; falling back to non-concurrent refresh. Reason: ${msg}`);
      await pool.query(`REFRESH MATERIALIZED VIEW ${viewName}`);
      return;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Main entry point — one full sync for a single tenant.
//
// syncTenant(pool, tenantId, { forceDaysBack? })
//   - pool: pg.Pool instance (shared with server.js)
//   - tenantId: string, must exist in tenants table
//   - opts.forceDaysBack: optional override for sales lookback window
// Returns { steps, orphanRescued, orphanStubs, orphanSkipped, unresolvedMfg, durationMs }
// ---------------------------------------------------------------------------
async function syncTenant(pool, tenantId, opts = {}) {
  const { forceDaysBack = null } = opts;
  const startTime = Date.now();

  console.log(`[sync:${tenantId}] Starting — ${new Date().toISOString()}`);

  // Load tenant row (needed for accountId + refresh token).
  const { rows: tenantRows } = await pool.query(
    `SELECT id, ls_account_id, ls_refresh_token FROM tenants WHERE id = $1`,
    [tenantId],
  );
  if (!tenantRows[0]) throw new Error(`syncTenant: tenant '${tenantId}' not found`);

  const ctx = makeCtx(pool, tenantId, tenantRows[0]);

  // NOTE: ensureSchema() was called here in the legacy sync.js; removed per
  // audit point D — server.js boot handles all migrations. See comment above.

  // Force immediate token refresh + persist any rotated refresh_token before any work
  ctx.auth.tokenExpiresAt = 0;
  await getAccessToken(ctx);

  const client = await apiClient(ctx);

  // Auto-detect initial sync (per-tenant): if this tenant's sale_lines is empty,
  // pull full history regardless of SYNC_DAYS_BACK. Ensures a fresh onboarding
  // always fetches complete history without operator intervention.
  const { rows: countRows } = await pool.query(
    'SELECT COUNT(*) AS n FROM sale_lines WHERE tenant_id = $1',
    [tenantId],
  );
  const isFirstSync = Number(countRows[0].n) === 0;
  const daysBack = forceDaysBack
    ?? (isFirstSync ? 3650 : parseInt(process.env.SYNC_DAYS_BACK ?? '7', 10));
  if (isFirstSync)    console.log(`[sync:${tenantId}] First sync detected (sale_lines empty) — pulling full 10-year history`);
  if (forceDaysBack)  console.log(`[sync:${tenantId}] Force full sync: pulling ${forceDaysBack} days of history`);
  const since = new Date(Date.now() - daysBack * 86_400_000).toISOString();

  // Step counters for the return summary
  const steps = { shops: 0, items: 0, item_matrices: 0, inventory: 0, sales: 0, orders: 0, transfers: 0 };

  // NOTE: keepalive setInterval intentionally removed per audit point F.
  // getAccessToken() self-refreshes when cachedToken is within 30s of expiry;
  // a single ~500ms refresh mid-sync is acceptable.

  // Load all checkpoints upfront (all tenant-scoped)
  const cps = {};
  for (const step of SYNC_STEPS) cps[step] = await getCheckpoint(ctx, step);

  // If the last step completed in the previous run, start a fresh run.
  // Static steps (shops, items, inventory) are only cleared if stale (> STATIC_SYNC_DAYS).
  // Time-filtered steps (sales, orders, transfers) are always cleared so they re-fetch the delta.
  const lastStep = SYNC_STEPS[SYNC_STEPS.length - 1];
  if (cps[lastStep]?.next_url === 'COMPLETED') {
    console.log(`[sync:${tenantId}] Previous run fully completed. Resetting steps selectively.`);
    for (const step of SYNC_STEPS) {
      if (STATIC_STEPS.has(step)) {
        const updatedAt = cps[step]?.updated_at ? new Date(cps[step].updated_at) : null;
        const ageDays   = updatedAt ? (Date.now() - updatedAt.getTime()) / 86_400_000 : Infinity;
        if (ageDays > STATIC_SYNC_DAYS) {
          console.log(`[sync:${tenantId}] ${step}: stale (${Math.round(ageDays)}d old) — will re-sync`);
          await clearCheckpoint(ctx, step);
          cps[step] = null;
        } else {
          console.log(`[sync:${tenantId}] ${step}: fresh (${Math.round(ageDays)}d old) — skipping`);
        }
      } else {
        await clearCheckpoint(ctx, step);
        cps[step] = null;
      }
    }
  }

  // Print checkpoint status summary
  const statusLine = SYNC_STEPS.map(s => `${s}=${cpLabel(cps[s])}`).join(', ');
  console.log(`[sync:${tenantId}] Checkpoint status: ${statusLine}`);

  // Sync manufacturer lookup table and backfill existing numeric IDs — always runs,
  // outside SYNC_STEPS because it's small and requires no checkpointing.
  await syncManufacturers(ctx);
  await backfillNumericManufacturers(ctx);

  // Sync attribute set labels (tiny, no checkpoint) — needed for deterministic
  // size/color identification in top-attributes endpoint.
  await syncItemAttributeSets(ctx);

  // ── 1. Shops ──────────────────────────────────────────────────────────
  if (cps.shops?.next_url === 'COMPLETED') {
    console.log(`[sync:${tenantId}] shops: skipping (already completed)`);
    steps.shops = cps.shops.processed_count ?? 0;
  } else {
    if (cps.shops) console.log(`[sync:${tenantId}] Resuming shops from checkpoint…`);
    else           console.log(`[sync:${tenantId}] Fetching shops…`);
    let shopCount = 0;
    for await (const { items, nextUrl } of paginate(ctx, client, 'Shop', {}, cps.shops?.next_url)) {
      await upsertShops(ctx, items);
      shopCount += items.length;
      if (nextUrl) await saveCheckpoint(ctx, 'shops', nextUrl, shopCount);
    }
    await markStepCompleted(ctx, 'shops', shopCount);
    steps.shops = shopCount;
  }

  // ── 2. Items (products) ───────────────────────────────────────────────
  // Delta sync: only fetch items modified since last completed items sync.
  // First sync (isFirstSync) always pulls everything.
  if (cps.items?.next_url === 'COMPLETED') {
    console.log(`[sync:${tenantId}] items: skipping (already completed)`);
    steps.items = cps.items.processed_count ?? 0;
  } else {
    const itemsDeltaRow = await getCheckpoint(ctx, 'items_delta_since');
    const itemsDelta    = !isFirstSync && itemsDeltaRow?.next_url && itemsDeltaRow.next_url !== 'COMPLETED'
      ? itemsDeltaRow.next_url
      : null;
    const itemsParams = {
      load_relations: JSON.stringify(['Tags', 'Category', 'Manufacturer', 'Images', 'ItemAttributes']),
      ...(itemsDelta ? { timeStamp: `>,${itemsDelta}` } : {}),
    };
    const itemsSyncStarted = new Date().toISOString();

    let itemCount = cps.items?.processed_count ?? 0;
    if (cps.items)    console.log(`[sync:${tenantId}] Resuming items from checkpoint at ${itemCount}…`);
    else if (itemsDelta) console.log(`[sync:${tenantId}] Items delta sync since ${itemsDelta}…`);
    else              console.log(`[sync:${tenantId}] Items full sync…`);

    for await (const { items, nextUrl } of paginate(ctx, client, 'Item', itemsParams, cps.items?.next_url)) {
      await upsertProducts(ctx, items);
      itemCount += items.length;
      console.log(`[sync:${tenantId}] Items upserted: ${itemCount}`);
      if (nextUrl) await saveCheckpoint(ctx, 'items', nextUrl, itemCount);
    }
    await markStepCompleted(ctx, 'items', itemCount);
    await saveCheckpoint(ctx, 'items_delta_since', itemsSyncStarted, itemCount);
    steps.items = itemCount;
  }

  // ── 3. ItemMatrix (matrix descriptions) ──────────────────────────────
  // Delta sync: only fetch matrices modified since last completed sync.
  // Checkpoint cursor in 'item_matrices'; delta boundary in 'item_matrices_delta_since'.
  if (cps.item_matrices?.next_url === 'COMPLETED') {
    console.log(`[sync:${tenantId}] item_matrices: skipping (already completed)`);
    steps.item_matrices = cps.item_matrices.processed_count ?? 0;
  } else {
    const mxDeltaRow = await getCheckpoint(ctx, 'item_matrices_delta_since');
    const mxDelta    = !isFirstSync && mxDeltaRow?.next_url && mxDeltaRow.next_url !== 'COMPLETED'
      ? mxDeltaRow.next_url
      : null;
    const mxParams       = mxDelta ? { timeStamp: `>,${mxDelta}` } : {};
    const mxSyncStarted  = new Date().toISOString();

    let mxCount = cps.item_matrices?.processed_count ?? 0;
    if (cps.item_matrices) console.log(`[sync:${tenantId}] Resuming item_matrices from checkpoint at ${mxCount}…`);
    else if (mxDelta)       console.log(`[sync:${tenantId}] ItemMatrix delta sync since ${mxDelta}…`);
    else                    console.log(`[sync:${tenantId}] ItemMatrix full sync…`);

    let mxPages = 0;
    for await (const { items, nextUrl } of paginate(ctx, client, 'ItemMatrix', mxParams, cps.item_matrices?.next_url)) {
      await upsertItemMatrices(ctx, items);
      mxCount += items.length;
      mxPages++;
      if (mxCount % 1000 === 0) console.log(`[sync:${tenantId}] ItemMatrix upserted: ${mxCount}`);
      if (nextUrl) await saveCheckpoint(ctx, 'item_matrices', nextUrl, mxCount);
    }
    console.log(`[sync:${tenantId}] ItemMatrix done: ${mxCount} records (${mxPages} pages)`);
    await markStepCompleted(ctx, 'item_matrices', mxCount);
    await saveCheckpoint(ctx, 'item_matrices_delta_since', mxSyncStarted, mxCount);
    steps.item_matrices = mxCount;

    // Warn for product matrix_ids with no item_matrices entry after full sync.
    if (!mxDelta) {
      const { rows: orphans } = await pool.query(`
        SELECT COUNT(DISTINCT p.matrix_id) AS n
        FROM   products p
        LEFT JOIN item_matrices im ON im.tenant_id = $1 AND im.matrix_id = p.matrix_id
        WHERE  p.tenant_id = $1 AND p.matrix_id IS NOT NULL AND p.matrix_id != ''
          AND  im.matrix_id IS NULL
      `, [tenantId]);
      const orphanCount = Number(orphans[0]?.n ?? 0);
      if (orphanCount > 0) console.warn(`[sync:${tenantId}] WARNING: ${orphanCount} product matrix_ids have no item_matrices entry`);
    }
  }

  // ── 4. Inventory (ItemShop) ───────────────────────────────────────────
  // Delta sync: on subsequent runs, only fetch records modified since the last
  // completed inventory sync (stored as 'inventory_delta_since' in sync_checkpoints).
  // First sync (isFirstSync) always pulls everything — no timeStamp filter.
  if (cps.inventory?.next_url === 'COMPLETED') {
    console.log(`[sync:${tenantId}] inventory: skipping (already completed)`);
    steps.inventory = cps.inventory.processed_count ?? 0;
  } else {
    const deltaSinceRow = await getCheckpoint(ctx, 'inventory_delta_since');
    const deltaSince    = !isFirstSync && deltaSinceRow?.next_url && deltaSinceRow.next_url !== 'COMPLETED'
      ? deltaSinceRow.next_url   // stored as ISO timestamp string in next_url field
      : null;
    const invParams = deltaSince ? { timeStamp: `>,${deltaSince}` } : {};

    let invCount = cps.inventory?.processed_count ?? 0;
    if (cps.inventory)  console.log(`[sync:${tenantId}] Resuming inventory from checkpoint at ${invCount}…`);
    else if (deltaSince) console.log(`[sync:${tenantId}] Inventory delta sync since ${deltaSince}…`);
    else                 console.log(`[sync:${tenantId}] Inventory full sync (ItemShop)…`);

    // Record the start time before fetching — use this as the next delta boundary.
    const invSyncStarted = new Date().toISOString();

    for await (const { items, nextUrl } of paginate(ctx, client, 'ItemShop', invParams, cps.inventory?.next_url)) {
      await upsertInventory(ctx, items);
      invCount += items.length;
      if (invCount % 1000 === 0)  console.log(`[sync:${tenantId}] Inventory upserted: ${invCount}`);
      if (nextUrl && invCount % 10_000 === 0) await saveCheckpoint(ctx, 'inventory', nextUrl, invCount);
    }
    console.log(`[sync:${tenantId}] Inventory done: ${invCount} records`);
    await markStepCompleted(ctx, 'inventory', invCount);
    // Save the start time of this run as the next delta boundary.
    // Using start (not end) ensures no records are missed if Lightspeed updates
    // an ItemShop while we're mid-sync.
    await saveCheckpoint(ctx, 'inventory_delta_since', invSyncStarted, invCount);
    steps.inventory = invCount;
  }

  // ── 5. Sales (with embedded SaleLines) ───────────────────────────────
  if (cps.sales?.next_url === 'COMPLETED') {
    console.log(`[sync:${tenantId}] sales: skipping (already completed)`);
    steps.sales = cps.sales.processed_count ?? 0;
  } else {
    let salesCount = cps.sales?.processed_count ?? 0;
    if (cps.sales) console.log(`[sync:${tenantId}] Resuming sales from checkpoint at ${salesCount}…`);
    else           console.log(`[sync:${tenantId}] Fetching sales since ${since}…`);
    for await (const { items, nextUrl } of paginate(ctx, client, 'Sale', {
      load_relations: JSON.stringify(['SaleLines']),
      completeTime: `>,${since}`,
    }, cps.sales?.next_url)) {
      await upsertSales(ctx, items);
      for (const sale of items) {
        const lines = sale.SaleLines?.SaleLine;
        if (!lines) continue;
        const lineArr = Array.isArray(lines) ? lines : [lines];
        // Lightspeed uses completeTime (no 'd') in the response object
        const ct = sale.completeTime ?? sale.completedTime ?? null;
        await upsertSaleLines(ctx, lineArr, ct);
      }
      salesCount += items.length;
      // Checkpoint every 10,000 records
      if (nextUrl && salesCount % 10_000 === 0) await saveCheckpoint(ctx, 'sales', nextUrl, salesCount);
    }
    await markStepCompleted(ctx, 'sales', salesCount);
    steps.sales = salesCount;

    // Orphan rescue summary — persisted in sync_checkpoints so it's visible after each run.
    const totalOrphans = ctx.state.orphanRescuedCount + ctx.state.orphanStubCount + ctx.state.orphanSkippedCount;
    if (totalOrphans > 0) {
      console.log(`[sync:${tenantId}] [ORPHAN] Résumé: ${ctx.state.orphanRescuedCount} récupérés via API, ${ctx.state.orphanStubCount} stubs créés, ${ctx.state.orphanSkippedCount} perdus`);
      if (ctx.state.orphanSkippedCount > 0) {
        console.error(`[sync:${tenantId}] [ORPHAN] ❌ ATTENTION: ${ctx.state.orphanSkippedCount} lignes de vente irrécupérables — vérifier les logs ci-dessus`);
      }
    } else {
      console.log(`[sync:${tenantId}] [ORPHAN] Aucun orphelin détecté dans ce batch`);
    }
    // Persist counts to sync_checkpoints for monitoring
    await pool.query(
      `INSERT INTO sync_checkpoints(tenant_id, step, next_url, processed_count, updated_at)
       VALUES ($1, 'orphan_rescued', 'COMPLETED', $2, now())
       ON CONFLICT(tenant_id, step) DO UPDATE SET processed_count=$2, updated_at=now()`,
      [tenantId, ctx.state.orphanRescuedCount],
    );
    await pool.query(
      `INSERT INTO sync_checkpoints(tenant_id, step, next_url, processed_count, updated_at)
       VALUES ($1, 'orphan_stubs', 'COMPLETED', $2, now())
       ON CONFLICT(tenant_id, step) DO UPDATE SET processed_count=$2, updated_at=now()`,
      [tenantId, ctx.state.orphanStubCount],
    );
    await pool.query(
      `INSERT INTO sync_checkpoints(tenant_id, step, next_url, processed_count, updated_at)
       VALUES ($1, 'orphan_skipped', 'COMPLETED', $2, now())
       ON CONFLICT(tenant_id, step) DO UPDATE SET processed_count=$2, updated_at=now()`,
      [tenantId, ctx.state.orphanSkippedCount],
    );
  }

  // ── 6. Orders ─────────────────────────────────────────────────────────
  if (cps.orders?.next_url === 'COMPLETED') {
    console.log(`[sync:${tenantId}] orders: skipping (already completed)`);
    steps.orders = cps.orders.processed_count ?? 0;
  } else {
    let ordersCount = cps.orders?.processed_count ?? 0;
    if (cps.orders) console.log(`[sync:${tenantId}] Resuming orders from checkpoint at ${ordersCount}…`);
    else            console.log(`[sync:${tenantId}] Fetching orders…`);
    for await (const { items, nextUrl } of paginate(ctx, client, 'Order', {}, cps.orders?.next_url)) {
      await upsertOrders(ctx, items);
      ordersCount += items.length;
      if (nextUrl) await saveCheckpoint(ctx, 'orders', nextUrl, ordersCount);
    }
    await markStepCompleted(ctx, 'orders', ordersCount);
    steps.orders = ordersCount;
  }

  // ── 7. Transfers (inter-shop stock movements) ─────────────────────────
  if (cps.transfers?.next_url === 'COMPLETED') {
    console.log(`[sync:${tenantId}] transfers: skipping (already completed)`);
    steps.transfers = cps.transfers.processed_count ?? 0;
  } else {
    let txCount = cps.transfers?.processed_count ?? 0;
    if (cps.transfers) console.log(`[sync:${tenantId}] Resuming transfers from checkpoint at ${txCount}…`);
    else               console.log(`[sync:${tenantId}] Fetching transfers…`);
    for await (const { items, nextUrl } of paginate(ctx, client, 'Transfer', {
      load_relations: 'all',
    }, cps.transfers?.next_url)) {
      await upsertTransfers(ctx, items);
      txCount += items.length;
      if (txCount % 500 === 0) console.log(`[sync:${tenantId}] Transfers processed: ${txCount}`);
      if (nextUrl && txCount % 2_000 === 0) await saveCheckpoint(ctx, 'transfers', nextUrl, txCount);
    }
    await markStepCompleted(ctx, 'transfers', txCount);
    console.log(`[sync:${tenantId}] Transfers done: ${txCount} records`);
    steps.transfers = txCount;
  }

  // ── Materialized-view refresh intentionally skipped per audit point G.
  // The producer will refresh mv_sales_velocity / mv_inventory_stock once
  // after all tenants complete, using the exported refreshMaterializedView.

  // ── Quality audit ─────────────────────────────────────────────────────
  await computeAndSaveQualityCounters(ctx);

  // ── Inventory snapshot ────────────────────────────────────────────────
  await snapshotInventory(ctx);

  const durationMs = Date.now() - startTime;
  console.log(`[sync:${tenantId}] Done — ${new Date().toISOString()} (${durationMs}ms)`);

  return {
    steps,
    orphanRescued:  ctx.state.orphanRescuedCount,
    orphanStubs:    ctx.state.orphanStubCount,
    orphanSkipped:  ctx.state.orphanSkippedCount,
    unresolvedMfg:  ctx.state.unresolvedMfgCount,
    durationMs,
  };
}

module.exports = { syncTenant, refreshMaterializedView };
