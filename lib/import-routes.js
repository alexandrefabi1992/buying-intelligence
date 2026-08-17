'use strict';
// Express routes for the supplier order ingestion module.
// All routes prefixed with /api/import, JWT-scoped by tenantId.
//
// Mounted from server.js via mountImportRoutes(app, pool, requireAuth).
// The queue processor and Lightspeed client are lazy-imported inside the
// route handlers so server.js keeps startup snappy.

const crypto = require('crypto');
const multer = require('multer');

const { fromEnv, fromTenant } = require('./lightspeed-client');
const { resolveStyles }     = require('./style-resolver');
const { buildPreview, normalizeSizeToken } = require('./preview-generator');
const { runImportPush }     = require('./queue-processor');
const {
  runRecipe, RecipeExecutionError,
  extractWords, wordsToLines, checkDetection,
} = require('./parsers/generic-recipe');
const { extractPdfWithLlm, LlmExtractionError } = require('./llm-extractor');

// In-memory registry of running push jobs. One active job per tenant.
// Key = tenantId, value = { file_id, job_id, promise, startedAt }
const activeJobs = new Map();

// ─────────────────────────────────────────────────────────────────────────
// PROBE STORE — in-memory holder for PDFs uploaded by the recipe-builder
// wizard. A probe holds the parsed word/line structure so the wizard can:
//   1. Display extracted lines to the user (mapping UI)
//   2. Test a candidate recipe against it (POST /recipes/test) without
//      re-parsing the PDF at every keystroke.
// TTL: 30 min. Not persisted — a Node restart drops every probe (accepted
// tradeoff; a probe is typically consumed within minutes of upload).
// ─────────────────────────────────────────────────────────────────────────
const _probes = new Map();  // probe_id → { tenantId, filename, pdfBuffer, pages, complexity, createdAt }
const PROBE_TTL_MS = 30 * 60 * 1000;

function _newProbeId() {
  return 'probe-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
}
function _sweepProbes() {
  const cutoff = Date.now() - PROBE_TTL_MS;
  for (const [id, p] of _probes) if (p.createdAt < cutoff) _probes.delete(id);
}
setInterval(_sweepProbes, 5 * 60 * 1000).unref?.();  // sweep every 5 min

// Complexity assessor — refuses obviously-untraitable files up front rather
// than letting the wizard produce a recipe that will fail at real use.
// Signals for "too_complex" (blocking):
//   - PDF returned zero pages (empty/corrupt)
//   - Zero extractable words across every page (image-based / scanned PDF)
//   - Fewer than 20 extractable words total (text encoding is broken)
//   - No page has more than 3 lines (unusual — no repeatable structure)
// Signals for "warn" (non-blocking, note in UI):
//   - Some pages have zero words (mixed image/text — some pages will be lost)
//   - Very few pages (<2) — mono-order likely, no repetition to learn from
function assessProbeComplexity(pages) {
  const warnings = [];
  const blockers = [];
  if (!pages || !pages.length) blockers.push({ code: 'empty_pdf', msg: 'PDF has zero pages.' });

  const totalWords = pages.reduce((s, p) => s + p.words.length, 0);
  const emptyPages = pages.filter(p => p.words.length === 0).length;

  if (totalWords === 0)  blockers.push({
    code: 'no_extractable_text',
    msg: 'Aucun texte extractible. Ce PDF est probablement une image scannée. La reconnaissance par OCR n\'est pas prise en charge actuellement.',
  });
  else if (totalWords < 20) blockers.push({
    code: 'sparse_text',
    msg: `Seulement ${totalWords} mots extraits. Le texte du PDF est peut-être une image ou utilise un encodage non standard.`,
  });

  // Lines per page — need SOME structure
  let maxLines = 0;
  for (const p of pages) {
    const lines = wordsToLines(p.words);
    if (lines.length > maxLines) maxLines = lines.length;
  }
  if (blockers.length === 0 && maxLines < 3) blockers.push({
    code: 'no_line_structure',
    msg: `Aucune page ne contient plus de ${maxLines} lignes distinctes. Le PDF n\'a pas la structure tabulaire attendue.`,
  });

  if (emptyPages > 0 && !blockers.length) warnings.push({
    code: 'mixed_pages',
    msg: `${emptyPages} page(s) sur ${pages.length} sans texte extractible — elles seront ignorées.`,
  });
  if (pages.length === 1) warnings.push({
    code: 'single_page',
    msg: 'Un seul page dans l\'échantillon — impossible d\'inférer les motifs récurrents multi-pages.',
  });

  const level = blockers.length ? 'too_complex' : (warnings.length ? 'warn' : 'ok');
  return { level, warnings, blockers, stats: { pages: pages.length, totalWords, emptyPages, maxLines } };
}

// Multer: keep files in memory (max 20 MB — one supplier PDF is typically 100–500 KB).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

// ─── Small helpers ───────────────────────────────────────────────────────
function normStr(s) { return String(s ?? '').trim().toLowerCase(); }
function badRequest(res, code, message, extra = {}) {
  return res.status(400).json({ error: code, message, ...extra });
}
function conflict(res, code, message, extra = {}) {
  return res.status(409).json({ error: code, message, ...extra });
}
function notFound(res, code, message) {
  return res.status(404).json({ error: code, message });
}

// Loads the negotiated margin override for a brand (from
// brand_payment_terms.margin_override_pct). This is the retailer's REAL
// margin — often higher than what the supplier's PO shows because of
// season-specific deals. When set, the effective unit cost is computed
// as retail_price × (1 - margin/100), overriding the cost printed on the PDF.
// Returns a number in [0, 100] or null if no override.
async function loadBrandMargin(pool, tenantId, manufacturer) {
  if (!manufacturer) return null;
  const { rows } = await pool.query(
    `SELECT margin_override_pct
     FROM   brand_payment_terms
     WHERE  tenant_id = $1 AND manufacturer = $2`,
    [tenantId, manufacturer],
  );
  const v = rows[0]?.margin_override_pct;
  return v == null ? null : Number(v);
}

// Applies a margin override to all matrices in a preview. Adds
// effective_unit_cost + margin_override_pct_applied. When no override,
// effective_unit_cost = unit_cost (unchanged). Also recomputes
// summary.summed_amount_total using the effective cost.
function attachMarginOverride(preview, marginPct) {
  if (!preview?.matrices) return preview;
  preview.margin_override_pct = marginPct;
  let effectiveSum = 0;
  for (const m of preview.matrices) {
    const originalCost = Number(m.unit_cost) || 0;
    let effectiveCost = originalCost;
    if (marginPct != null && Number(m.retail_price) > 0) {
      effectiveCost = Number((m.retail_price * (1 - marginPct / 100)).toFixed(2));
    }
    m.effective_unit_cost         = effectiveCost;
    m.margin_override_pct_applied = marginPct;
    effectiveSum += effectiveCost * (m.total_qty || 0);
  }
  if (preview.summary) {
    preview.summary.summed_amount_total_effective = Number(effectiveSum.toFixed(2));
  }
  return preview;
}

// Loads per-matrix overrides for a file into a Map keyed by matrix_key.
async function loadMatrixOverrides(pool, tenantId, fileId) {
  const { rows } = await pool.query(
    `SELECT matrix_key, category_id, category_path, retail_price_override
     FROM   import_matrix_overrides
     WHERE  tenant_id = $1 AND file_id = $2`,
    [tenantId, fileId],
  );
  const map = new Map();
  for (const r of rows) {
    map.set(r.matrix_key, {
      category_id:           r.category_id,
      category_path:         r.category_path,
      retail_price_override: r.retail_price_override == null ? null : Number(r.retail_price_override),
    });
  }
  return map;
}

// Attaches override fields to each matrix in a preview response. Matrix key
// is "style_ref|color_normalized" (same rule preview-generator uses).
// Also computes effective_retail_price = override OR original PDF value.
function attachOverrides(preview, overrides) {
  if (!preview?.matrices) return preview;
  for (const m of preview.matrices) {
    const key = `${m.style_ref}|${m.color_normalized}`;
    const ov  = overrides?.get(key);
    if (ov) {
      m.override_category_id   = ov.category_id;
      m.override_category_path = ov.category_path;
      if (ov.retail_price_override != null) m.override_retail_price = ov.retail_price_override;
    }
    // Always compute effective_retail_price so the frontend has a single
    // field to read (override if set, else the original PDF value, else null).
    m.effective_retail_price = m.override_retail_price != null
      ? m.override_retail_price
      : (m.retail_price != null ? Number(m.retail_price) : null);
  }
  return preview;
}

async function loadFile(pool, tenantId, fileId) {
  const { rows } = await pool.query(
    `SELECT file_id, tenant_id, supplier_key, recipe_id, source_filename, source_hash,
            uploaded_by, uploaded_at, season_tag, destination_shop_id, target_manufacturer,
            status, preview_json, preview_computed_at, extraction_source, raw_text,
            last_extraction_error, custom_order_name, drop_id, confirmed_at
     FROM   import_files WHERE file_id = $1 AND tenant_id = $2`,
    [fileId, tenantId],
  );
  return rows[0] ?? null;
}

// Per-tenant setting: how to translate raw supplier colors when inserting
// order lines. Stored in app_settings (key='color_translation_mode') as
// { mode: 'french' | 'passthrough' }. Default = 'french' (backward compat
// with the 2026-08 Mortar-validated convention).
async function getColorTranslationMode(pool, tenantId) {
  const { rows } = await pool.query(
    `SELECT value FROM app_settings WHERE tenant_id = $1 AND key = 'color_translation_mode'`,
    [tenantId],
  );
  const raw = rows[0]?.value?.mode;
  return raw === 'passthrough' ? 'passthrough' : 'french';
}

async function loadBatchesForFile(pool, tenantId, fileId) {
  const { rows } = await pool.query(
    `SELECT batch_id, file_id, po_number, customer_reference, order_date, delivery_date, cancel_date,
            unit_count_declared, amount_declared, is_consignment, selected, status, lightspeed_order_id
     FROM   import_batches WHERE file_id = $1 AND tenant_id = $2
     ORDER  BY batch_id`,
    [fileId, tenantId],
  );
  return rows;
}

// Rebuild the parsed structure the preview generator needs, from DB rows.
// (Avoids re-parsing the PDF for every preview request.)
async function rebuildParsedFromDB(pool, tenantId, file, batches) {
  const { rows: lines } = await pool.query(
    `SELECT ol.line_id, ol.batch_id, ol.supplier_style_ref, ol.supplier_color_ref, ol.color_normalized,
            ol.size_label, ol.qty, ol.unit_cost, ol.unit_price_retail,
            b.po_number
     FROM   import_order_lines ol
     JOIN   import_batches      b ON b.batch_id = ol.batch_id
     WHERE  b.file_id = $1 AND b.tenant_id = $2
     ORDER  BY b.batch_id, ol.line_id`,
    [file.file_id, tenantId],
  );

  // Group lines into products by (batch, style, color) preserving each PO's own set
  const productMap = new Map(); // key -> product
  for (const l of lines) {
    const key = `${l.po_number}|${l.supplier_style_ref}|${l.color_normalized}|${l.size_label}`;
    // For products we group by (po, style, color), then push variants (size, qty)
    const pKey = `${l.po_number}|${l.supplier_style_ref}|${l.color_normalized}`;
    if (!productMap.has(pKey)) {
      productMap.set(pKey, {
        po_number:        l.po_number,
        style_ref:        l.supplier_style_ref,
        color_code:       l.supplier_color_ref,
        color_label:      l.color_normalized,
        color_normalized: l.color_normalized,
        description:      '',
        unit_cost:        Number(l.unit_cost),
        retail_price:     l.unit_price_retail == null ? null : Number(l.unit_price_retail),
        variants:         [],
        total_qty_summed: 0,
        page:             null,
      });
    }
    const p = productMap.get(pKey);
    p.variants.push({ size: l.size_label, qty: l.qty });
    p.total_qty_summed += l.qty;
  }

  return {
    file: {
      supplier_key:        file.supplier_key,
      target_manufacturer: file.target_manufacturer,
    },
    orders: batches.map(b => ({
      batch_id:            b.batch_id,
      po_number:           b.po_number,
      customer_reference:  b.customer_reference,
      order_date:          b.order_date,
      delivery_date:       b.delivery_date,
      cancel_date:         b.cancel_date,
      is_consignment:      b.is_consignment,
      unit_count_declared: b.unit_count_declared,
      amount_declared:     b.amount_declared == null ? null : Number(b.amount_declared),
      selected:            b.selected,
      batch_status:        b.status,
      lightspeed_order_id: b.lightspeed_order_id,
      first_page:          null,
      last_page:           null,
    })),
    products: [...productMap.values()],
    warnings: [],
    declared_totals: {
      totalUnits:  batches.reduce((s, b) => s + (b.unit_count_declared || 0), 0),
      totalAmount: batches.reduce((s, b) => s + Number(b.amount_declared || 0), 0),
      orders:      [],
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════
// Route mount
// ═════════════════════════════════════════════════════════════════════════
function mountImportRoutes(app, pool, requireAuth, requireAdmin) {
  if (!app || !pool || !requireAuth) throw new Error('mountImportRoutes: app, pool, requireAuth required');
  if (!requireAdmin) requireAdmin = (_req, _res, next) => next();  // dev fallback if not provided

  // ─── POST /upload ─────────────────────────────────────────────────────
  // Multipart form: file (PDF) + season_tag + destination_shop_id + target_manufacturer
  // Parses, validates brand, inserts file/batches/order_lines, returns file_id.
  app.post('/api/import/upload', requireAuth, upload.single('file'), async (req, res, next) => {
    try {
      if (!req.file) return badRequest(res, 'no_file', 'No file uploaded (form field "file")');
      const { season_tag, destination_shop_id, target_manufacturer, custom_order_name, drop_id } = req.body || {};
      if (!season_tag)          return badRequest(res, 'missing_field', 'season_tag required');
      if (!destination_shop_id) return badRequest(res, 'missing_field', 'destination_shop_id required');
      if (!target_manufacturer) return badRequest(res, 'missing_field', 'target_manufacturer required');
      const customOrderName = custom_order_name && String(custom_order_name).trim()
        ? String(custom_order_name).trim().slice(0, 200) : null;
      const dropId = drop_id && String(drop_id).trim() ? String(drop_id).trim().slice(0, 100) : null;

      // 1. Extract PDF once, then try every active recipe visible to this
      //    tenant (private + global). First recipe whose detection matches
      //    wins. This is what makes new-supplier onboarding work: any recipe
      //    seeded (Oui, Bugatchi, or one built via the wizard) can dispatch.
      let pages;
      try {
        pages = await extractWords(req.file.buffer);
      } catch (e) {
        return badRequest(res, 'parse_failed', `PDF extraction failed: ${e.message}`);
      }

      const { rows: candidateRecipes } = await pool.query(
        `SELECT recipe_id, tenant_id, supplier_key, version, target_manufacturer,
                detection, layout, default_attribute_set_id, notes
         FROM   parse_recipes
         WHERE  active = true AND (tenant_id IS NULL OR tenant_id = $1)
         ORDER  BY tenant_id NULLS LAST, version DESC`,
        [req.tenantId],
      );
      if (!candidateRecipes.length) return badRequest(res, 'no_active_recipe',
        'Aucune recette active. Configure au moins une recette dans Paramètres → Recettes d\'import.');

      let recipe = null;   // DB row
      let recipeObj = null; // { meta, detection, extraction } for runRecipe
      const detectionAttempts = [];
      for (const r of candidateRecipes) {
        const obj = {
          version: 1,
          meta: {
            supplier_key: r.supplier_key,
            target_manufacturer: r.target_manufacturer,
            default_attribute_set_id: r.default_attribute_set_id,
          },
          detection: r.detection,
          extraction: r.layout,
        };
        if (checkDetection(pages, r.detection)) {
          recipe = r;
          recipeObj = obj;
          break;
        }
        detectionAttempts.push(r.supplier_key);
      }

      // No recipe matched — persist the file with recipe_id = NULL so the
      // operator can trigger POST /extract-llm. Recipe path (below) stays
      // untouched: files that matched a recipe continue through unchanged.
      if (!recipe) {
        const source_hash_nomatch = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
        // Context-aware dedup: same PDF for the same (season, drop, mfr)
        // is a duplicate. Different context (e.g. re-attach in a26 after
        // realizing the original attach was p26) is a legitimate new intent.
        const { rows: dupRows } = await pool.query(
          `SELECT file_id FROM import_files
           WHERE tenant_id = $1
             AND source_hash = $2
             AND season_tag = $3
             AND lower(target_manufacturer) = lower($4)
             AND COALESCE(drop_id, '') = COALESCE($5, '')
             AND COALESCE(destination_shop_id, '') = COALESCE($6, '')
           LIMIT 1`,
          [req.tenantId, source_hash_nomatch, season_tag, target_manufacturer,
           dropId || '', String(destination_shop_id || '')],
        );
        if (dupRows.length) return conflict(res, 'duplicate_file',
          `This file has already been uploaded for this drop/season (file_id=${dupRows[0].file_id})`,
          { existing_file_id: dupRows[0].file_id });

        // Insert directly in status='extracting' — extraction starts
        // right away, no operator click needed. preview_computed_at stamped
        // so the stale-detection has a start time (matches /extract-llm).
        const insRes = await pool.query(
          `INSERT INTO import_files
             (tenant_id, supplier_key, recipe_id, source_filename, source_hash, source_bytes,
              uploaded_by, season_tag, destination_shop_id, target_manufacturer, status,
              extraction_source, custom_order_name, drop_id, preview_computed_at, confirmed_at)
           VALUES ($1, 'unknown', NULL, $2, $3, $4, $5, $6, $7, $8, 'extracting', 'recipe', $9, $10, now(), now())
           RETURNING file_id`,
          [req.tenantId, req.file.originalname,
           source_hash_nomatch, req.file.buffer, req.userId ?? null,
           season_tag, destination_shop_id, target_manufacturer, customOrderName, dropId],
        );
        const newFileId = insRes.rows[0].file_id;
        // Fire the LLM extraction in the background — client polls /preview
        spawnLlmExtractionBackground(req.tenantId, newFileId);
        return res.json({
          file_id:              newFileId,
          batches:              [],
          warnings:             [],
          needs_llm_extraction: true,
          extraction_started:   true,
          attempted_recipes:    detectionAttempts,
          message: `Aucune recette existante ne reconnaît ce PDF — extraction IA démarrée automatiquement (${detectionAttempts.length} recette${detectionAttempts.length > 1 ? 's' : ''} testée${detectionAttempts.length > 1 ? 's' : ''}).`,
        });
      }

      // 2. Brand validation BEFORE parse — clicking Bugatchi with an Oui-detected PDF must refuse
      const parsedBrand = normStr(recipe.target_manufacturer);
      const clickedBrand = normStr(target_manufacturer);
      if (parsedBrand !== clickedBrand) {
        return badRequest(res, 'brand_mismatch',
          `Ce PDF est détecté comme "${recipe.target_manufacturer}", mais tu as cliqué "${target_manufacturer}".`,
          { pdf_brand: recipe.target_manufacturer, clicked_brand: target_manufacturer, matched_recipe: recipe.supplier_key });
      }

      // 3. Parse via the generic engine using the matched recipe
      let parsed;
      try {
        parsed = await runRecipe(req.file.buffer, recipeObj);
      } catch (e) {
        const code = e instanceof RecipeExecutionError ? e.code : 'parse_failed';
        return badRequest(res, code, `Recette "${recipe.supplier_key}" a échoué : ${e.message}`);
      }
      if (!parsed?.products?.length) {
        return badRequest(res, 'parse_failed', `Recette "${recipe.supplier_key}" a extrait 0 produit.`);
      }

      // 4. Compute source_hash for context-aware dedup (same PDF for
      //    same season+drop+mfr = duplicate; different context = new intent)
      const source_hash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
      const { rows: dupRows } = await pool.query(
        `SELECT file_id FROM import_files
         WHERE tenant_id = $1
           AND source_hash = $2
           AND season_tag = $3
           AND lower(target_manufacturer) = lower($4)
           AND COALESCE(drop_id, '') = COALESCE($5, '')
           AND COALESCE(destination_shop_id, '') = COALESCE($6, '')
         LIMIT 1`,
        [req.tenantId, source_hash, season_tag, target_manufacturer,
         dropId || '', String(destination_shop_id || '')],
      );
      if (dupRows.length) {
        return conflict(res, 'duplicate_file',
          `This file has already been uploaded (file_id=${dupRows[0].file_id})`,
          { existing_file_id: dupRows[0].file_id });
      }

      // 5. Insert file + batches + order lines in one transaction
      const client = await pool.connect();
      let fileId;
      try {
        await client.query('BEGIN');
        const insFile = await client.query(
          `INSERT INTO import_files
             (tenant_id, supplier_key, recipe_id, source_filename, source_hash, source_bytes,
              uploaded_by, season_tag, destination_shop_id, target_manufacturer, status, custom_order_name, drop_id, confirmed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'parsed', $11, $12, now())
           RETURNING file_id`,
          [req.tenantId, recipe.supplier_key, recipe.recipe_id,
           req.file.originalname, source_hash, req.file.buffer,
           req.userId ?? null, season_tag, destination_shop_id, target_manufacturer, customOrderName, dropId],
        );
        fileId = insFile.rows[0].file_id;

        // Load color translations + the per-tenant translation mode.
        //   french     → lookup color_translations, compose <french>-<code>
        //   passthrough → keep the parser's capitalized English (e.g. "Blue-5400")
        // Default mode = french. Users toggle via PUT /api/settings/import-colors.
        const { rows: ctRows } = await client.query(
          `SELECT raw_color, normalized FROM color_translations WHERE supplier_key = $1`,
          [recipe.supplier_key],
        );
        const colorMap = new Map(ctRows.map(r => [String(r.raw_color).toLowerCase(), r.normalized]));
        const colorMode = await getColorTranslationMode(pool, req.tenantId);

        // Map po_number -> batch_id for line inserts
        const batchIdByPO = new Map();
        for (const o of parsed.orders) {
          const isConsign = /consign/i.test(o.customer_reference || '');
          const insB = await client.query(
            `INSERT INTO import_batches
               (file_id, tenant_id, po_number, customer_reference, order_date, delivery_date, cancel_date,
                unit_count_declared, amount_declared, is_consignment, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'parsed')
             RETURNING batch_id`,
            [fileId, req.tenantId, o.po_number, o.customer_reference,
             o.order_date, o.delivery_date, o.cancel_date,
             o.unit_count_declared, o.amount_declared, isConsign],
          );
          batchIdByPO.set(o.po_number, insB.rows[0].batch_id);
        }

        for (const p of parsed.products) {
          const batchId = batchIdByPO.get(p.po_number);
          if (!batchId) continue; // orphan (already warned by parser)
          // Compose color_normalized per the tenant's chosen mode.
          let colorNormalized;
          if (colorMode === 'passthrough') {
            // As-is from the parser (English capitalized, e.g. "Blue-5400")
            colorNormalized = p.color_normalized;
          } else {
            // French mode: lookup + <french>-<code>. Fallback to parser value
            // when no translation registered (safer than silently truncating).
            const rawColor = String(p.color_label ?? '').toLowerCase();
            const frenchName = colorMap.get(rawColor);
            colorNormalized = frenchName
              ? (p.color_code ? `${frenchName}-${p.color_code}` : frenchName)
              : p.color_normalized;
          }
          // Mutate so buildPreview keys matrices on the SAME color_normalized
          // we write to import_order_lines — critical for matrix override
          // lookup (category / retail_price) at push time.
          p.color_normalized = colorNormalized;
          for (const v of p.variants) {
            await client.query(
              `INSERT INTO import_order_lines
                 (batch_id, tenant_id, supplier_style_ref, supplier_color_ref, color_normalized,
                  size_label, qty, unit_cost, unit_price_retail, status)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')`,
              [batchId, req.tenantId,
               p.style_ref, p.color_code, colorNormalized,
               normalizeSizeToken(v.size), v.qty, p.unit_cost, p.retail_price],
            );
          }
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }

      const batches = await loadBatchesForFile(pool, req.tenantId, fileId);
      res.json({
        file_id: fileId,
        batches: batches.map(b => ({
          batch_id:            b.batch_id,
          po_number:           b.po_number,
          customer_reference:  b.customer_reference,
          unit_count_declared: b.unit_count_declared,
          amount_declared:     b.amount_declared == null ? null : Number(b.amount_declared),
          is_consignment:      b.is_consignment,
          selected:            b.selected,
        })),
        warnings: parsed.warnings || [],
      });
    } catch (e) {
      // Friendlier error for the (tenant_id, file_id, po_number) unique
      // constraint. Post-migration this should almost never fire — only if
      // the same file legitimately contains two batches with the same
      // po_number (parser bug, corrupt PDF, etc.).
      if (e && e.code === '23505' && String(e.constraint || '').includes('po')) {
        return badRequest(res, 'duplicate_po_in_file',
          `Ce PDF contient deux commandes avec le même numéro de PO — chaque PO ne peut apparaître qu'une fois par fichier. Détail : ${e.detail || e.message}`);
      }
      next(e);
    }
  });

  // ─── GET /files/:file_id/preview ──────────────────────────────────────
  // Cached in import_files.preview_json. ?refresh=true bypasses cache.
  app.get('/api/import/files/:file_id/preview', requireAuth, async (req, res, next) => {
    try {
      const file = await loadFile(pool, req.tenantId, req.params.file_id);
      if (!file) return notFound(res, 'file_not_found', `file_id ${req.params.file_id} not in this tenant`);

      const refresh = req.query.refresh === 'true' || req.query.refresh === '1';

      // If an LLM re-extraction is in progress, block the cached preview.
      // Returning the old preview lets the operator click "Pousser" and
      // hit a 400 (status must be one of previewed/partial/failed — current:
      // extracting). Instead surface the same 202 as a fresh extraction so
      // the UI shows the polling card until the new extraction lands.
      if (file.status === 'extracting') {
        return res.status(202).json({
          error:   'extracting',
          status:  'extracting',
          file_id: file.file_id,
          message: 'Extraction still running.',
        });
      }

      if (!refresh && file.preview_json) {
        const overrides = await loadMatrixOverrides(pool, req.tenantId, file.file_id);
        const margin    = await loadBrandMargin(pool, req.tenantId, file.target_manufacturer);
        const preview   = attachMarginOverride(
          attachOverrides({ ...file.preview_json }, overrides),
          margin,
        );
        return res.json({
          ...preview,
          cached: true,
          extraction_source: file.extraction_source || 'recipe',
          preview_computed_at: file.preview_computed_at,
        });
      }

      // LLM-extracted files must be re-extracted via POST /extract-llm to
      // refresh — we never re-run recipes on LLM output (recipes wouldn't match)
      // and re-running the LLM call is expensive + non-idempotent. Force the
      // operator through the explicit re-extract endpoint.
      if (refresh && file.extraction_source === 'llm') {
        if (!file.preview_json) return badRequest(res, 'no_llm_preview',
          `File is LLM-flagged but has no cached preview. Trigger POST /files/${file.file_id}/extract-llm.`);
        const overrides = await loadMatrixOverrides(pool, req.tenantId, file.file_id);
        const margin    = await loadBrandMargin(pool, req.tenantId, file.target_manufacturer);
        const preview   = attachMarginOverride(
          attachOverrides({ ...file.preview_json }, overrides),
          margin,
        );
        return res.json({
          ...preview,
          cached: true,
          extraction_source: 'llm',
          preview_computed_at: file.preview_computed_at,
          refresh_note: 'LLM extractions cannot be refreshed via /preview — call POST /extract-llm to re-run.',
        });
      }

      // File uploaded but no recipe matched yet — cannot compute preview
      if (file.status === 'awaiting_extraction') {
        return badRequest(res, 'awaiting_extraction',
          `File is awaiting extraction. Trigger POST /files/${file.file_id}/extract-llm.`,
          file.last_extraction_error ? { last_extraction_error: file.last_extraction_error } : {});
      }

      // (status === 'extracting' handled at the top of this route)

      // Compute fresh (recipe path)
      const batches = await loadBatchesForFile(pool, req.tenantId, file.file_id);
      const parsed  = await rebuildParsedFromDB(pool, req.tenantId, file, batches);
      const styleSet = new Set(parsed.products.map(p => p.style_ref));

      // Optional per-tenant color_translations from DB (override parser's normalized)
      const { rows: ctRows } = await pool.query(
        `SELECT raw_color, normalized FROM color_translations WHERE supplier_key = $1`,
        [file.supplier_key],
      );
      const colorMap = new Map(ctRows.map(r => [String(r.raw_color).toLowerCase(), r.normalized]));

      const client = fromEnv();
      const resolutions = await resolveStyles(client, [...styleSet], file.season_tag);

      const preview = buildPreview(parsed, resolutions, {
        season_tag:          file.season_tag,
        target_manufacturer: file.target_manufacturer,
        color_translations:  colorMap,
        // extraction_source defaults to 'recipe' — no LLM validation runs
      });

      // Cache + advance status to 'previewed'
      await pool.query(
        `UPDATE import_files SET preview_json = $1::jsonb, preview_computed_at = now(),
                                 status = CASE WHEN status = 'parsed' THEN 'previewed' ELSE status END
         WHERE file_id = $2 AND tenant_id = $3`,
        [JSON.stringify(preview), file.file_id, req.tenantId],
      );

      const overrides = await loadMatrixOverrides(pool, req.tenantId, file.file_id);
      const margin    = await loadBrandMargin(pool, req.tenantId, file.target_manufacturer);
      attachOverrides(preview, overrides);
      attachMarginOverride(preview, margin);
      res.json({ ...preview, cached: false, extraction_source: 'recipe', preview_computed_at: new Date().toISOString() });
    } catch (e) { next(e); }
  });

  // ─── GET /files ──────────────────────────────────────────────────────
  app.get('/api/import/files', requireAuth, async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT f.file_id, f.source_filename, f.uploaded_at, f.uploaded_by,
                f.season_tag, f.target_manufacturer, f.destination_shop_id, f.status,
                f.drop_id, f.confirmed_at,
                (SELECT COUNT(*) FROM import_batches      WHERE file_id = f.file_id) AS batches_count,
                (SELECT COUNT(*) FROM import_order_lines ol
                   JOIN import_batches b ON b.batch_id = ol.batch_id
                   WHERE b.file_id = f.file_id) AS lines_count,
                (SELECT COUNT(*) FROM import_order_lines ol
                   JOIN import_batches b ON b.batch_id = ol.batch_id
                   WHERE b.file_id = f.file_id AND ol.status = 'ordered') AS lines_ordered,
                (SELECT COUNT(*) FROM import_order_lines ol
                   JOIN import_batches b ON b.batch_id = ol.batch_id
                   WHERE b.file_id = f.file_id AND ol.status = 'error') AS lines_error
         FROM   import_files f
         WHERE  f.tenant_id = $1
         ORDER  BY f.uploaded_at DESC
         LIMIT  200`,
        [req.tenantId],
      );
      res.json({ files: rows });
    } catch (e) { next(e); }
  });

  // ─── GET /files/:file_id (metadata) ──────────────────────────────────
  app.get('/api/import/files/:file_id', requireAuth, async (req, res, next) => {
    try {
      const file = await loadFile(pool, req.tenantId, req.params.file_id);
      if (!file) return notFound(res, 'file_not_found', `file_id ${req.params.file_id}`);
      const batches = await loadBatchesForFile(pool, req.tenantId, file.file_id);
      const { rows: countsRows } = await pool.query(
        `SELECT ol.status, COUNT(*) AS n
         FROM   import_order_lines ol
         JOIN   import_batches      b ON b.batch_id = ol.batch_id AND b.tenant_id = ol.tenant_id
         WHERE  b.file_id = $1
           AND  b.tenant_id = $2
         GROUP  BY ol.status`,
        [file.file_id, req.tenantId],
      );
      const counts = Object.fromEntries(countsRows.map(r => [r.status, Number(r.n)]));
      res.json({
        file: {
          file_id: file.file_id, source_filename: file.source_filename, source_hash: file.source_hash,
          uploaded_by: file.uploaded_by, uploaded_at: file.uploaded_at,
          season_tag: file.season_tag, destination_shop_id: file.destination_shop_id,
          target_manufacturer: file.target_manufacturer, status: file.status,
          preview_computed_at: file.preview_computed_at,
        },
        batches,
        line_counts_by_status: counts,
      });
    } catch (e) { next(e); }
  });

  // ─── PATCH /batches/:batch_id (select/deselect) ──────────────────────
  app.patch('/api/import/batches/:batch_id', requireAuth, async (req, res, next) => {
    try {
      const { selected } = req.body || {};
      if (typeof selected !== 'boolean') return badRequest(res, 'invalid_body', 'selected: boolean required');
      const { rows } = await pool.query(
        `SELECT status FROM import_batches WHERE batch_id = $1 AND tenant_id = $2`,
        [req.params.batch_id, req.tenantId],
      );
      if (!rows.length) return notFound(res, 'batch_not_found', `batch_id ${req.params.batch_id}`);
      if (['pushing', 'pushed', 'partial', 'abandoned'].includes(rows[0].status)) {
        return conflict(res, 'batch_frozen', `batch status is '${rows[0].status}' — too late to change selection`);
      }
      await pool.query(
        `UPDATE import_batches SET selected = $1 WHERE batch_id = $2 AND tenant_id = $3`,
        [selected, req.params.batch_id, req.tenantId],
      );
      res.json({ batch_id: Number(req.params.batch_id), selected });
    } catch (e) { next(e); }
  });

  // Shared kickoff logic — used by both /push and /resume. Returns the
  // 202 response body on success; throws { httpStatus, code, message, extra }
  // shape on failure so the caller can translate to res.status().json().
  async function launchPushJob(tenantId, userId, file) {
    if (activeJobs.has(tenantId)) {
      const j = activeJobs.get(tenantId);
      throw { httpStatus: 409, code: 'push_in_progress',
        message: `A push is already running for this tenant (file_id ${j.file_id}, job_id ${j.job_id})`,
        extra: { active_file_id: j.file_id, active_job_id: j.job_id } };
    }
    const batches = await loadBatchesForFile(pool, tenantId, file.file_id);
    const selected = batches.filter(b => b.selected && b.status !== 'abandoned');
    if (!selected.length) throw { httpStatus: 400, code: 'no_selected_batches', message: 'No batches selected for push' };

    const { rows: [{ count: linesTotal }] } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM import_order_lines ol
       JOIN   import_batches      b ON b.batch_id = ol.batch_id
       WHERE  b.file_id = $1 AND b.tenant_id = $2 AND b.selected = true
         AND  ol.status NOT IN ('ordered')`,
      [file.file_id, tenantId],
    );

    const { rows: mfgRows } = await pool.query(
      `SELECT DISTINCT raw->>'manufacturerID' AS mid FROM products
       WHERE  tenant_id = $1 AND manufacturer = $2 AND raw->>'manufacturerID' IS NOT NULL LIMIT 1`,
      [tenantId, file.target_manufacturer],
    );
    const manufacturerID = mfgRows[0]?.mid;
    if (!manufacturerID) throw { httpStatus: 400, code: 'no_manufacturer_id',
      message: `Could not resolve manufacturerID for brand "${file.target_manufacturer}"` };

    const { rows: bvmRows } = await pool.query(
      `SELECT vendor_id FROM brand_vendor_map WHERE tenant_id = $1 AND manufacturer = $2`,
      [tenantId, file.target_manufacturer],
    );
    const defaultVendorID = bvmRows[0]?.vendor_id;
    if (!defaultVendorID) throw { httpStatus: 400, code: 'no_vendor_map',
      message: `brand_vendor_map missing entry for tenant "${tenantId}" + manufacturer "${file.target_manufacturer}"` };

    const { rows: rpRows } = await pool.query(
      `SELECT default_attribute_set_id FROM parse_recipes
       WHERE recipe_id = $1 AND (tenant_id IS NULL OR tenant_id = $2)`,
      [file.recipe_id, tenantId],
    );
    const attributeSetID = rpRows[0]?.default_attribute_set_id || '5';

    const { rows: qRows } = await pool.query(
      `INSERT INTO import_queue (tenant_id, file_id, owner, status, progress_total, started_at)
       VALUES ($1, $2, $3, 'running', $4, now()) RETURNING job_id`,
      [tenantId, file.file_id, userId ?? null, linesTotal],
    );
    const jobId = qRows[0].job_id;

    await pool.query(
      `UPDATE import_files SET status = 'pushing' WHERE file_id = $1 AND tenant_id = $2`,
      [file.file_id, tenantId],
    );

    const client = fromEnv();
    const { rows: styleRows } = await pool.query(
      `SELECT DISTINCT supplier_style_ref FROM import_order_lines ol
       JOIN   import_batches      b ON b.batch_id = ol.batch_id AND b.tenant_id = ol.tenant_id
       WHERE  b.file_id = $1 AND b.selected = true
         AND  b.tenant_id = $2`,
      [file.file_id, tenantId],
    );
    const resolutions = await resolveStyles(client, styleRows.map(r => r.supplier_style_ref), file.season_tag);

    // Load per-matrix operator overrides (category + future fields) so the
    // queue processor can inject them into the Lightspeed matrix payload.
    const overridesMap = await loadMatrixOverrides(pool, tenantId, file.file_id);
    // Convert to a plain object keyed by matrix_key for the queue processor.
    const matrixOverrides = {};
    for (const [k, v] of overridesMap.entries()) matrixOverrides[k] = v;

    // Load negotiated margin override — replaces the PO's stated cost with
    // retail_price * (1 - margin/100) when set. Applied per line in queue.
    const brandMarginPct = await loadBrandMargin(pool, tenantId, file.target_manufacturer);

    // Detect OS-only matrices — those where every variant has size='OS' or
    // size is null/empty (accessories, prepacks, one-size items). Route them
    // to a single-attribute (color-only) attribute set so we don't create
    // a phantom Taille='OS' dimension in Lightspeed.
    const { rows: osRows } = await pool.query(
      `SELECT  ol.supplier_style_ref,
               ol.color_normalized,
               BOOL_AND(ol.size_label IS NULL OR ol.size_label = '' OR UPPER(ol.size_label) = 'OS') AS all_os
       FROM    import_order_lines ol
       JOIN    import_batches b ON b.batch_id = ol.batch_id AND b.tenant_id = ol.tenant_id
       WHERE   b.file_id = $1 AND b.selected = true
         AND   b.tenant_id = $2
       GROUP BY ol.supplier_style_ref, ol.color_normalized`,
      [file.file_id, tenantId],
    );
    const osOnlyMatrixKeys = new Set(
      osRows.filter(r => r.all_os).map(r => `${r.supplier_style_ref}|${r.color_normalized}`),
    );
    const singleAttrSetID = process.env.LS_SINGLE_ATTR_SET_ID || null;

    const opts = {
      tenantId, fileId: file.file_id, seasonTag: file.season_tag,
      targetManufacturer: file.target_manufacturer, manufacturerID, defaultVendorID,
      destinationShopID: file.destination_shop_id, attributeSetID, resolutions,
      matrixOverrides,
      brandMarginPct,
      customOrderName: file.custom_order_name,
      osOnlyMatrixKeys,
      singleAttrSetID,
      onLineDone: async (line, summary) => {
        try {
          await pool.query(
            `UPDATE import_queue SET progress_current = $1 WHERE job_id = $2 AND tenant_id = $3`,
            [summary.ordered + summary.error + summary.skipped, jobId, tenantId]);
        } catch { /* non-blocking */ }
      },
    };

    const promise = runImportPush({ pool, client }, opts).then(async (summary) => {
      const anyError = summary.error > 0;
      await pool.query(
        `UPDATE import_queue SET status = $1, finished_at = now() WHERE job_id = $2 AND tenant_id = $3`,
        [anyError ? 'failed' : 'done', jobId, tenantId],
      );
      await pool.query(
        `UPDATE import_files SET status = $1 WHERE file_id = $2 AND tenant_id = $3`,
        [anyError ? 'partial' : 'pushed', file.file_id, tenantId],
      );
    }).catch(async (e) => {
      console.error(`[import-push] job ${jobId} threw:`, e.message);
      await pool.query(
        `UPDATE import_queue SET status = 'failed', finished_at = now(), error_message = $1 WHERE job_id = $2 AND tenant_id = $3`,
        [String(e.message).slice(0, 1000), jobId, tenantId],
      );
      await pool.query(
        `UPDATE import_files SET status = 'failed' WHERE file_id = $1 AND tenant_id = $2`,
        [file.file_id, tenantId],
      );
    }).finally(() => { activeJobs.delete(tenantId); });

    activeJobs.set(tenantId, { file_id: file.file_id, job_id: jobId, promise, startedAt: Date.now() });

    return {
      queue_job_id:     jobId,
      status:           'queued',
      batches_included: selected.length,
      lines_to_process: linesTotal,
    };
  }

  // ─── POST /files/:file_id/push ───────────────────────────────────────
  // Refuses to run when the cached preview is flagged `summary.incomplete`
  // unless the request body includes `force_incomplete: true` — a
  // deliberate override for cases where the operator knows the extraction
  // is partial (e.g. a supplier PO that is genuinely small). Every force
  // is logged to server console with tenant/user/file/reasons.
  app.post('/api/import/files/:file_id/push', requireAuth, async (req, res, next) => {
    try {
      const file = await loadFile(pool, req.tenantId, req.params.file_id);
      if (!file) return notFound(res, 'file_not_found', `file_id ${req.params.file_id}`);
      if (!['previewed', 'partial', 'failed'].includes(file.status)) {
        return badRequest(res, 'file_not_previewed', `status must be one of previewed/partial/failed (current: ${file.status})`);
      }

      // Completeness gate — reads cached preview_json (if any) and refuses
      // to launch when incomplete without an explicit force flag.
      const forceIncomplete = req.body?.force_incomplete === true;
      const preview = file.preview_json;
      if (preview?.summary?.incomplete === true && !forceIncomplete) {
        return res.status(400).json({
          error: 'extraction_incomplete',
          message: 'Extraction incomplète — la recette n\'a pas capturé assez du fichier. Vérifie la recette ou pousse quand même explicitement.',
          incomplete_reasons: preview.summary.incomplete_reasons,
          extraction_stats:   preview.summary.extraction_stats,
        });
      }
      if (forceIncomplete && preview?.summary?.incomplete === true) {
        // Structured log for traceability. If a proper audit table is added
        // later, this line is the seed for that migration.
        console.warn('[import] FORCE_INCOMPLETE_PUSH tenant=%s user=%s file=%s reasons=%j stats=%j',
          req.tenantId, req.userId ?? '(unknown)', file.file_id,
          preview.summary.incomplete_reasons, preview.summary.extraction_stats);
      }

      try {
        const body = await launchPushJob(req.tenantId, req.userId, file);
        // Echo back the force flag in the response so the client knows the
        // override took effect.
        res.status(202).json({ ...body, forced_incomplete: forceIncomplete && preview?.summary?.incomplete === true });
      } catch (kickErr) {
        if (kickErr?.httpStatus) return res.status(kickErr.httpStatus).json({
          error: kickErr.code, message: kickErr.message, ...(kickErr.extra || {}),
        });
        throw kickErr;
      }
    } catch (e) { next(e); }
  });

  // ─── GET /files/:file_id/progress ────────────────────────────────────
  app.get('/api/import/files/:file_id/progress', requireAuth, async (req, res, next) => {
    try {
      const { rows: qRows } = await pool.query(
        `SELECT job_id, status, queued_at, started_at, finished_at, progress_current, progress_total, error_message
         FROM   import_queue WHERE file_id = $1 AND tenant_id = $2
         ORDER  BY queued_at DESC LIMIT 1`,
        [req.params.file_id, req.tenantId],
      );
      if (!qRows.length) return notFound(res, 'no_job', 'No push job for this file');
      const job = qRows[0];

      const { rows: countRows } = await pool.query(
        `SELECT ol.status, COUNT(*)::int AS n FROM import_order_lines ol
         JOIN   import_batches      b ON b.batch_id = ol.batch_id AND b.tenant_id = ol.tenant_id
         WHERE  b.file_id = $1 AND b.tenant_id = $2 GROUP BY ol.status`,
        [req.params.file_id, req.tenantId],
      );
      const counts = Object.fromEntries(countRows.map(r => [r.status, r.n]));

      const { rows: errorRows } = await pool.query(
        `SELECT ol.line_id, ol.supplier_style_ref, ol.color_normalized, ol.size_label, ol.error_message
         FROM   import_order_lines ol
         JOIN   import_batches      b ON b.batch_id = ol.batch_id AND b.tenant_id = ol.tenant_id
         WHERE  b.file_id = $1 AND b.tenant_id = $2 AND ol.status = 'error'
         ORDER  BY ol.last_attempted_at DESC LIMIT 10`,
        [req.params.file_id, req.tenantId],
      );

      const batches = await loadBatchesForFile(pool, req.tenantId, req.params.file_id);
      res.json({
        queue_job_id: job.job_id,
        status:       job.status,
        started_at:   job.started_at,
        finished_at:  job.finished_at,
        current:      job.progress_current,
        total:        job.progress_total,
        counts,
        recent_errors: errorRows.map(r => ({
          line_id: r.line_id, style: r.supplier_style_ref, color: r.color_normalized, size: r.size_label,
          error_message: r.error_message,
        })),
        batches: batches.map(b => ({
          batch_id: b.batch_id, po_number: b.po_number,
          lightspeed_order_id: b.lightspeed_order_id, status: b.status,
        })),
      });
    } catch (e) { next(e); }
  });

  // ─── POST /files/:file_id/resume ─────────────────────────────────────
  app.post('/api/import/files/:file_id/resume', requireAuth, async (req, res, next) => {
    try {
      if (activeJobs.has(req.tenantId)) {
        const j = activeJobs.get(req.tenantId);
        return conflict(res, 'push_in_progress', `Push already running (job_id ${j.job_id})`);
      }
      const { line_ids } = req.body || {};

      // Backtrack error lines to the highest step their fields indicate.
      // If line_ids not provided, resume ALL errored lines for this file.
      const params = [req.tenantId, req.params.file_id];
      let scope = `ol.status = 'error'`;
      if (Array.isArray(line_ids) && line_ids.length) {
        params.push(line_ids);
        scope = `ol.line_id = ANY($3::int[])`;
      }
      const { rowCount: linesReset } = await pool.query(
        `UPDATE import_order_lines ol
         SET    status = CASE
                  WHEN ol.item_id   IS NOT NULL THEN 'variant_ensured'
                  WHEN ol.matrix_id IS NOT NULL THEN 'matrix_ensured'
                  ELSE 'pending'
                END,
                error_message = NULL
         WHERE  ol.tenant_id = $1
           AND  ol.batch_id IN (SELECT batch_id FROM import_batches WHERE file_id = $2 AND tenant_id = $1)
           AND  ${scope}`,
        params,
      );

      // Kick the queue in the same request (shared launchPushJob helper —
      // /resume = reset error lines + relaunch). File status returns to
      // 'pushing' automatically inside launchPushJob.
      const file = await loadFile(pool, req.tenantId, req.params.file_id);
      if (!file) return notFound(res, 'file_not_found', `file_id ${req.params.file_id}`);
      try {
        const body = await launchPushJob(req.tenantId, req.userId, file);
        res.status(202).json({ ...body, lines_reset: linesReset });
      } catch (kickErr) {
        if (kickErr?.httpStatus) return res.status(kickErr.httpStatus).json({
          error: kickErr.code, message: kickErr.message, lines_reset: linesReset, ...(kickErr.extra || {}),
        });
        throw kickErr;
      }
    } catch (e) { next(e); }
  });

  // ─── GET/PUT /api/settings/import-colors ─────────────────────────────
  // Per-tenant switch between:
  //   french      → translate raw supplier colors via color_translations
  //                 (default; requires the color_translations seed).
  //   passthrough → keep the parser's Title-cased English value as-is.
  //                 Useful when the color_translations table is not seeded
  //                 for a supplier, or when the retailer prefers vendor
  //                 nomenclature.
  // Setting takes effect on the NEXT /upload. Already-inserted lines are
  // NOT retroactively re-translated.
  app.get('/api/settings/import-colors', requireAuth, async (req, res, next) => {
    try {
      const mode = await getColorTranslationMode(pool, req.tenantId);
      res.json({ color_translation_mode: mode });
    } catch (e) { next(e); }
  });

  app.put('/api/settings/import-colors', requireAuth, async (req, res, next) => {
    try {
      const { color_translation_mode } = req.body || {};
      if (!['french', 'passthrough'].includes(color_translation_mode)) {
        return badRequest(res, 'invalid_mode',
          'color_translation_mode must be "french" or "passthrough"');
      }
      await pool.query(
        `INSERT INTO app_settings (tenant_id, key, value, updated_at)
         VALUES ($1, 'color_translation_mode', $2::jsonb, now())
         ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [req.tenantId, JSON.stringify({ mode: color_translation_mode })],
      );
      res.json({ color_translation_mode });
    } catch (e) { next(e); }
  });

  // ─── POST /files/:file_id/abandon ────────────────────────────────────
  // Marks the file + its batches as abandoned in the DB. Does NOT touch
  // anything already created in Lightspeed. Returns a summary of created
  // artifacts so the user knows exactly what to clean up manually.
  app.post('/api/import/files/:file_id/abandon', requireAuth, async (req, res, next) => {
    try {
      if (activeJobs.has(req.tenantId) && activeJobs.get(req.tenantId).file_id === Number(req.params.file_id)) {
        return conflict(res, 'push_in_progress',
          'Cannot abandon while a push is running for this file — wait for it to finish or fail first');
      }
      const file = await loadFile(pool, req.tenantId, req.params.file_id);
      if (!file) return notFound(res, 'file_not_found', `file_id ${req.params.file_id}`);
      if (file.status === 'abandoned') {
        return conflict(res, 'already_abandoned', 'This file is already marked abandoned');
      }

      // Build the cleanup summary BEFORE flipping status
      const { rows: createdMatrices } = await pool.query(
        `SELECT DISTINCT ol.matrix_id, ol.supplier_style_ref
         FROM   import_order_lines ol
         JOIN   import_batches      b ON b.batch_id = ol.batch_id AND b.tenant_id = ol.tenant_id
         WHERE  b.file_id = $1 AND b.tenant_id = $2 AND ol.matrix_id IS NOT NULL`,
        [file.file_id, req.tenantId],
      );
      const { rows: createdItems } = await pool.query(
        `SELECT ol.item_id, ol.supplier_style_ref, ol.color_normalized, ol.size_label
         FROM   import_order_lines ol
         JOIN   import_batches      b ON b.batch_id = ol.batch_id AND b.tenant_id = ol.tenant_id
         WHERE  b.file_id = $1 AND b.tenant_id = $2 AND ol.item_id IS NOT NULL`,
        [file.file_id, req.tenantId],
      );
      const { rows: createdOrders } = await pool.query(
        `SELECT b.batch_id, b.po_number, b.customer_reference, b.lightspeed_order_id
         FROM   import_batches b
         WHERE  b.file_id = $1 AND b.tenant_id = $2 AND b.lightspeed_order_id IS NOT NULL`,
        [file.file_id, req.tenantId],
      );

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `UPDATE import_files SET status = 'abandoned' WHERE file_id = $1 AND tenant_id = $2`,
          [file.file_id, req.tenantId],
        );
        await client.query(
          `UPDATE import_batches SET status = 'abandoned' WHERE file_id = $1 AND tenant_id = $2
             AND status NOT IN ('pushed', 'partial')`,
          [file.file_id, req.tenantId],
        );
        // Any 'pending' lines under selected batches get flagged too, so they
        // don't accidentally get picked up by a future /resume.
        await client.query(
          `UPDATE import_order_lines SET status = 'skipped_duplicate', error_message = 'file abandoned'
           WHERE  tenant_id = $1 AND status = 'pending'
             AND  batch_id IN (SELECT batch_id FROM import_batches WHERE file_id = $2)`,
          [req.tenantId, file.file_id],
        );
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }

      res.json({
        abandoned: true,
        cleanup_needed: {
          matrices:   createdMatrices.map(r => ({ matrix_id: r.matrix_id, style_ref: r.supplier_style_ref })),
          items:      createdItems.map(r => ({ item_id: r.item_id, style_ref: r.supplier_style_ref, color: r.color_normalized, size: r.size_label })),
          orders:     createdOrders.map(r => ({ order_id: r.lightspeed_order_id, po_number: r.po_number, customer_reference: r.customer_reference })),
        },
        message: 'File marked abandoned. Nothing was deleted from Lightspeed. ' +
                 'Use the Lightspeed UI (Retail → Inventory / Ordering) to clean up the listed artifacts.',
      });
    } catch (e) { next(e); }
  });

  // ═════════════════════════════════════════════════════════════════════
  // RECIPE BUILDER (S2 wizard)
  // ═════════════════════════════════════════════════════════════════════

  // POST /recipes/probe — multipart upload, extracts words+lines, returns
  //   { probe_id, complexity: {level, warnings, blockers, stats}, pages: [...] }
  // The probe is kept in memory for 30 min. The wizard uses probe_id when
  // subsequently calling /recipes/test to avoid re-uploading the file.
  app.post('/api/import/recipes/probe', requireAuth, upload.single('file'), async (req, res, next) => {
    try {
      if (!req.file) return badRequest(res, 'no_file', 'No file uploaded (form field "file")');
      let pages;
      try {
        pages = await extractWords(req.file.buffer);
      } catch (e) {
        return badRequest(res, 'pdf_parse_failed', `PDF extraction failed: ${e.message}`);
      }
      const complexity = assessProbeComplexity(pages);

      // Reshape pages for wire format (drop word-level x1/yc/width/height for size)
      const wirePages = pages.map(p => ({
        pageNum: p.pageNum,
        width:   p.width,
        height:  p.height,
        lines:   wordsToLines(p.words).map(l => ({
          y0: Math.round(l.y0 * 100) / 100,
          text: l.text,
          words: l.words.map(w => ({
            text: w.text,
            x0: Math.round(w.x0 * 100) / 100,
            x1: Math.round(w.x1 * 100) / 100,
            xc: Math.round(w.xc * 100) / 100,
          })),
        })),
      }));

      // Only store the probe (buffer + full pages structure) if the file is
      // salvageable. Blocked files are reported but not held.
      let probe_id = null;
      if (complexity.level !== 'too_complex') {
        probe_id = _newProbeId();
        _probes.set(probe_id, {
          tenantId:  req.tenantId,
          filename:  req.file.originalname,
          pdfBuffer: req.file.buffer,
          pages,
          complexity,
          createdAt: Date.now(),
        });
      }

      res.json({
        probe_id,
        filename:   req.file.originalname,
        complexity,
        pages:      wirePages,
      });
    } catch (e) { next(e); }
  });

  // POST /recipes/test — apply a candidate recipe to a previously probed PDF
  //   Body: { probe_id, recipe: {...} }
  //   Returns the full runRecipe output on success, or { error: {code, message} }
  //   on failure. The wizard uses this to validate the recipe before saving.
  app.post('/api/import/recipes/test', requireAuth, async (req, res, next) => {
    try {
      const { probe_id, recipe } = req.body || {};
      if (!probe_id) return badRequest(res, 'no_probe_id', 'probe_id required');
      if (!recipe)   return badRequest(res, 'no_recipe',   'recipe required');
      const probe = _probes.get(probe_id);
      if (!probe) return notFound(res, 'probe_expired',
        'Ce probe n\'existe plus ou a expiré (TTL 30 min). Recharge le PDF.');
      if (probe.tenantId !== req.tenantId) return res.status(403).json({
        error: 'probe_forbidden', message: 'This probe belongs to another tenant.',
      });
      try {
        const result = await runRecipe(probe.pdfBuffer, recipe);
        // Trim products/orders to first 20 for response size
        res.json({
          ok: true,
          summary: {
            orders_count:   result.orders.length,
            products_count: result.products.length,
            declared_units: result.declared_totals.totalUnits,
            declared_amount: result.declared_totals.totalAmount,
            warnings_count: result.warnings.length,
          },
          orders:   result.orders.slice(0, 20),
          products: result.products.slice(0, 20),
          warnings: result.warnings.slice(0, 20),
          file:     result.file,
        });
      } catch (e) {
        const code = e instanceof RecipeExecutionError ? e.code : 'unknown';
        res.json({
          ok:      false,
          error:   { code, message: e.message, context: e.context ?? null },
        });
      }
    } catch (e) { next(e); }
  });

  // POST /recipes — persist a new recipe, tenant-scoped by default
  //   Body: { recipe: {meta, detection, extraction, notes?} }
  app.post('/api/import/recipes', requireAuth, async (req, res, next) => {
    try {
      const { recipe } = req.body || {};
      if (!recipe?.meta?.supplier_key) {
        return badRequest(res, 'missing_supplier_key', 'recipe.meta.supplier_key required');
      }
      if (!recipe?.meta?.target_manufacturer) {
        return badRequest(res, 'missing_target_manufacturer', 'recipe.meta.target_manufacturer required');
      }
      // Compute next version for this (tenant, supplier_key)
      const { rows: [{ max: currentMax }] } = await pool.query(
        `SELECT COALESCE(MAX(version), 0) AS max FROM parse_recipes
         WHERE supplier_key = $1 AND COALESCE(tenant_id, '') = COALESCE($2, '')`,
        [recipe.meta.supplier_key, req.tenantId],
      );
      const version = Number(currentMax) + 1;
      const insertRes = await pool.query(
        `INSERT INTO parse_recipes
           (tenant_id, supplier_key, version, file_kind, detection, layout,
            target_manufacturer, default_attribute_set_id, notes, active)
         VALUES ($1, $2, $3, 'pdf', $4::jsonb, $5::jsonb, $6, $7, $8, true)
         RETURNING recipe_id, supplier_key, version, tenant_id`,
        [
          req.tenantId,                // NEW recipes are private
          recipe.meta.supplier_key,
          version,
          JSON.stringify(recipe.detection || {}),
          JSON.stringify(recipe.extraction || {}),
          recipe.meta.target_manufacturer,
          recipe.meta.default_attribute_set_id || '5',
          recipe.meta.notes || recipe.notes || null,
        ],
      );
      res.json({ recipe: insertRes.rows[0] });
    } catch (e) { next(e); }
  });

  // GET /recipes — list recipes visible to this tenant (tenant-scoped + global)
  app.get('/api/import/recipes', requireAuth, async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT recipe_id, supplier_key, version, file_kind, target_manufacturer,
                default_attribute_set_id, notes, active, created_at, tenant_id,
                (tenant_id IS NULL) AS is_global
         FROM   parse_recipes
         WHERE  active = true AND (tenant_id IS NULL OR tenant_id = $1)
         ORDER  BY tenant_id NULLS LAST, supplier_key, version DESC`,
        [req.tenantId],
      );
      res.json({ recipes: rows });
    } catch (e) { next(e); }
  });

  // GET /recipes/:id — full recipe body (detection + layout)
  app.get('/api/import/recipes/:id', requireAuth, async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT recipe_id, supplier_key, version, file_kind, detection, layout,
                target_manufacturer, default_attribute_set_id, notes, active,
                tenant_id, (tenant_id IS NULL) AS is_global, created_at
         FROM   parse_recipes
         WHERE  recipe_id = $1 AND (tenant_id IS NULL OR tenant_id = $2)`,
        [req.params.id, req.tenantId],
      );
      if (!rows.length) return notFound(res, 'recipe_not_found', `recipe_id ${req.params.id}`);
      res.json({ recipe: rows[0] });
    } catch (e) { next(e); }
  });

  // POST /admin/recipes/:id/promote — admin only. Sets tenant_id=NULL so the
  // recipe becomes visible to every tenant. Deliberate promotion; the
  // corresponding revert (demote) exists as an inverse.
  // Auth: X-Admin-Secret (bypasses JWT to be usable via curl/CLI).
  app.post('/api/admin/import/recipes/:id/promote', requireAdmin, async (req, res, next) => {
    try {
      const { rowCount, rows } = await pool.query(
        `UPDATE parse_recipes SET tenant_id = NULL WHERE recipe_id = $1
         RETURNING recipe_id, supplier_key, version, tenant_id`,
        [req.params.id],
      );
      if (!rowCount) return notFound(res, 'recipe_not_found', `recipe_id ${req.params.id}`);
      res.json({ promoted: true, recipe: rows[0] });
    } catch (e) { next(e); }
  });

  // ─── POST /files/:file_id/extract-llm ────────────────────────────────
  // Operator-triggered LLM extraction for a file that was uploaded but no
  // recipe matched (status='awaiting_extraction') OR to REPLACE a prior
  // extraction (any status where re-extract makes sense: awaiting_extraction,
  // parsed, previewed, failed, abandoned — but NOT pushed/pushing).
  //
  // Provides Mistral with a strict schema + detected size headers as a hard
  // constraint (see lib/llm-extractor.js). Persists batches/lines exactly
  // like the recipe path, so /preview and /push don't need to know the
  // extraction source — they just consume import_batches + import_order_lines.
  //
  // The persisted preview_json has extraction_source='llm', which activates
  // the size-mismatch validator inside assessCompleteness. If the LLM's size
  // attribution is off by even one column, summary.incomplete is true and
  // the push endpoint refuses (unless force_incomplete=true).
  // Runs the actual LLM extraction end-to-end. Called both from POST
  // /extract-llm (as a background task via setImmediate — request returns
  // 202 immediately so Railway's HTTP proxy doesn't kill the connection
  // during the 30-90s LLM call) and directly from tests.
  async function runLlmExtractionForFile(tenantId, fileId) {
    const file = await loadFile(pool, tenantId, fileId);
    if (!file) throw new Error(`file_not_found: ${fileId}`);

    const { rows: srcRows } = await pool.query(
      `SELECT source_bytes FROM import_files WHERE file_id = $1 AND tenant_id = $2`,
      [fileId, tenantId],
    );
    if (!srcRows.length || !srcRows[0].source_bytes) {
      throw Object.assign(new Error('File has no stored source bytes'), { code: 'no_source_bytes' });
    }

    const extraction = await extractPdfWithLlm(srcRows[0].source_bytes, {
      supplier_key:        file.supplier_key,
      target_manufacturer: file.target_manufacturer,
    });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM import_batches WHERE file_id = $1 AND tenant_id = $2`, [fileId, tenantId]);

      const { rows: ctRows } = await client.query(
        `SELECT raw_color, normalized FROM color_translations WHERE supplier_key = $1`,
        [file.supplier_key || 'unknown'],
      );
      const colorMap = new Map(ctRows.map(r => [String(r.raw_color).toLowerCase(), r.normalized]));

      const batchIdByPO = new Map();
      for (const o of extraction.orders) {
        const isConsign = /consign/i.test(o.customer_reference || '') || !!o.is_consignment;
        const insB = await client.query(
          `INSERT INTO import_batches
             (file_id, tenant_id, po_number, customer_reference, order_date, delivery_date, cancel_date,
              unit_count_declared, amount_declared, is_consignment, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'parsed')
           RETURNING batch_id`,
          [fileId, tenantId, o.po_number, o.customer_reference,
           o.order_date, o.delivery_date, o.cancel_date,
           o.unit_count_declared, o.amount_declared, isConsign],
        );
        batchIdByPO.set(o.po_number, insB.rows[0].batch_id);
      }

      for (const p of extraction.products) {
        const batchId = batchIdByPO.get(p.po_number);
        if (!batchId) continue;
        // Fallback: if color_label is empty but color_code exists (Meyer
        // pattern — numeric-only color codes with no textual name),
        // promote color_code to color_label so different color variants
        // of the same style don't collapse into a single product with
        // color=null in the matrix grouping.
        if (!p.color_label && p.color_code) p.color_label = String(p.color_code);
        const rawColor = String(p.color_label ?? '').toLowerCase();
        const frenchName = colorMap.get(rawColor);
        const colorNormalized = frenchName
          ? (p.color_code ? `${frenchName}-${p.color_code}` : frenchName)
          : (p.color_label ? `${p.color_label}${p.color_code && p.color_code !== p.color_label ? '-' + p.color_code : ''}` : null);
        // Mutate the LLM product so buildPreview keys its matrix on the SAME
        // color_normalized we're about to write to import_order_lines. Without
        // this, preview groups by `LAVENDER` while the push looks up
        // `LAVENDER-054` and silently drops all matrix overrides
        // (category, retail_price) set via the picker.
        p.color_normalized = colorNormalized;
        for (const v of (p.variants || [])) {
          await client.query(
            `INSERT INTO import_order_lines
               (batch_id, tenant_id, supplier_style_ref, supplier_color_ref, color_normalized,
                size_label, qty, unit_cost, unit_price_retail, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')`,
            [batchId, tenantId,
             p.style_ref, p.color_code, colorNormalized,
             normalizeSizeToken(v.size), v.qty, p.unit_cost, p.retail_price],
          );
        }
      }

      const styleSet    = new Set(extraction.products.map(p => p.style_ref));
      const client_ls   = fromEnv();
      const resolutions = await resolveStyles(client_ls, [...styleSet], file.season_tag);
      const preview     = buildPreview(extraction, resolutions, {
        season_tag:          file.season_tag,
        target_manufacturer: file.target_manufacturer,
        color_translations:  colorMap,
        extraction_source:   'llm',
        rawText:             extraction._rawText,
      });

      await client.query(
        `UPDATE import_files
           SET preview_json          = $1::jsonb,
               preview_computed_at   = now(),
               extraction_source     = 'llm',
               raw_text              = $2,
               status                = 'previewed',
               last_extraction_error = NULL
         WHERE file_id = $3 AND tenant_id = $4`,
        [JSON.stringify(preview), extraction._rawText, fileId, tenantId],
      );

      await client.query('COMMIT');
      return { preview, extraction };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  // POST /extract-llm — kicks off extraction in the background and returns
  // 202 immediately. Frontend polls /preview to detect completion.
  // Reason: LLM calls take 30-90s which exceeds Railway's HTTP proxy
  // idle-response tolerance ("Application failed to respond").
  app.post('/api/import/files/:file_id/extract-llm', requireAuth, async (req, res, next) => {
    try {
      const file = await loadFile(pool, req.tenantId, req.params.file_id);
      if (!file) return notFound(res, 'file_not_found', `file_id ${req.params.file_id}`);
      if (['pushing', 'pushed', 'partial'].includes(file.status)) {
        return conflict(res, 'file_locked',
          `Cannot re-extract file in status '${file.status}' — it has already been pushed to Lightspeed.`);
      }
      // Stale extraction detection: an extraction that has been running for
      // more than 3 minutes without updating the DB is almost certainly
      // orphaned (Railway restarted the container, Mistral hung, or the
      // background task crashed before its catch could persist an error).
      // In that case we allow a fresh extraction to take over — otherwise
      // the file would stay stuck in 'extracting' forever.
      if (file.status === 'extracting') {
        const startedAt = file.preview_computed_at
          ? new Date(file.preview_computed_at).getTime()
          : 0;
        // Fallback: use uploaded_at if preview_computed_at is null (fresh file)
        const started = startedAt || (file.uploaded_at ? new Date(file.uploaded_at).getTime() : 0);
        const ageMs = Date.now() - started;
        const STALE_THRESHOLD_MS = 3 * 60 * 1000;
        if (ageMs < STALE_THRESHOLD_MS) {
          return res.status(202).json({ status: 'extracting', file_id: file.file_id,
            message: `Extraction already running for this file (started ${Math.round(ageMs/1000)}s ago).` });
        }
        console.warn(`[llm-extract] file=${file.file_id} stale extraction detected (${Math.round(ageMs/1000)}s old) — allowing restart`);
      }

      // Mark as extracting, clear any previous error, stamp preview_computed_at
      // so stale-extraction detection has a reliable start time.
      await pool.query(
        `UPDATE import_files SET status = 'extracting',
                                 last_extraction_error = NULL,
                                 preview_computed_at   = now()
         WHERE file_id = $1 AND tenant_id = $2`,
        [file.file_id, req.tenantId],
      );

      // Reply immediately — extraction runs in the background
      res.status(202).json({ status: 'extracting', file_id: file.file_id,
        message: 'Extraction started. Poll /preview to detect completion.' });

      // Fire the extraction (fire-and-forget, errors persisted to DB)
      spawnLlmExtractionBackground(req.tenantId, file.file_id);
    } catch (e) { next(e); }
  });

  // Shared background-runner for LLM extraction. Called from /extract-llm
  // (operator-triggered) and from /upload (auto-triggered on no-recipe-match).
  // Fire-and-forget: errors are persisted to import_files.last_extraction_error
  // and the file falls back to status='awaiting_extraction' so the operator
  // can retry via the UI.
  function spawnLlmExtractionBackground(tenantId, fileId) {
    setImmediate(async () => {
      try {
        await runLlmExtractionForFile(tenantId, fileId);
        console.log(`[llm-extract] file=${fileId} tenant=${tenantId} completed`);
      } catch (e) {
        const errMsg = e instanceof LlmExtractionError
          ? `[${e.code}] ${e.message}`
          : (e.code ? `[${e.code}] ${e.message}` : e.message);
        console.error(`[llm-extract] file=${fileId} tenant=${tenantId} FAILED: ${errMsg}`);
        try {
          await pool.query(
            `UPDATE import_files
               SET status = 'awaiting_extraction', last_extraction_error = $1
             WHERE file_id = $2 AND tenant_id = $3`,
            [errMsg.slice(0, 2000), fileId, tenantId],
          );
        } catch (dbErr) {
          console.error(`[llm-extract] file=${fileId} failed to persist error:`, dbErr);
        }
      }
    });
  }

  // ─── DELETE /files/:file_id ──────────────────────────────────────────
  // Allowed for any status that has NOT reached Lightspeed
  // (parsed, previewed, awaiting_extraction, failed). Refused for
  // pushing/pushed/partial — those need /abandon so the operator sees
  // the cleanup list.
  app.delete('/api/import/files/:file_id', requireAuth, async (req, res, next) => {
    try {
      const file = await loadFile(pool, req.tenantId, req.params.file_id);
      if (!file) return notFound(res, 'file_not_found', `file_id ${req.params.file_id}`);
      if (['pushing', 'pushed', 'partial'].includes(file.status)) {
        return conflict(res, 'cannot_delete_pushed',
          `Status is '${file.status}' — POs may already exist in Lightspeed. Use POST /abandon instead.`);
      }
      await pool.query(`DELETE FROM import_files WHERE file_id = $1 AND tenant_id = $2`, [file.file_id, req.tenantId]);
      res.json({ deleted: true, file_id: file.file_id });
    } catch (e) { next(e); }
  });

  // ─── POST /admin/backfill-matrix-overrides ───────────────────────────
  // One-shot repair for the matrix_key mismatch bug (fixed in commit
  // 5ee9dbc). Walks every pushed file with matrix overrides, matches each
  // override to its actual Lightspeed matrix_id via
  // (style_ref, color_normalized_stripped_of_code), then PUTs the missing
  // category / Prices. Idempotent — GETs first, skips no-ops.
  //
  //   POST /api/admin/backfill-matrix-overrides           # dry run
  //   POST /api/admin/backfill-matrix-overrides?apply=1   # actually PUT
  app.post('/api/import/backfill-matrix-overrides', requireAuth, async (req, res, next) => {
    try {
      const dry = req.query.apply !== '1';
      const client = fromEnv();
      const log = [];
      const l = (s) => { log.push(s); console.log(`[backfill] ${s}`); };
      l(`Mode: ${dry ? 'DRY-RUN' : 'APPLY'}`);

      const stripCodeSuffix = (colorNormalized, colorCode) => {
        if (!colorNormalized) return null;
        if (colorCode && colorNormalized.endsWith('-' + colorCode)) {
          return colorNormalized.slice(0, -1 - String(colorCode).length);
        }
        return colorNormalized;
      };

      const { rows: files } = await pool.query(`
        SELECT f.file_id, f.tenant_id, f.source_filename, f.target_manufacturer
        FROM   import_files f
        WHERE  f.tenant_id = $1
          AND  f.status IN ('pushed', 'partial')
          AND  EXISTS (SELECT 1 FROM import_matrix_overrides o WHERE o.file_id = f.file_id)
        ORDER  BY f.file_id
      `, [req.tenantId]);
      l(`${files.length} pushed file(s) with overrides`);

      let applied = 0, skipped = 0, notFound = 0, failed = 0;
      const details = [];

      for (const f of files) {
        const { rows: ovRows } = await pool.query(
          `SELECT matrix_key, category_id, category_path, retail_price_override
           FROM import_matrix_overrides WHERE tenant_id = $1 AND file_id = $2`,
          [f.tenant_id, f.file_id],
        );
        const { rows: lineRows } = await pool.query(
          `SELECT DISTINCT ol.supplier_style_ref, ol.supplier_color_ref, ol.color_normalized, ol.matrix_id
           FROM import_order_lines ol
           JOIN import_batches b ON b.batch_id = ol.batch_id
           WHERE b.file_id = $1 AND b.tenant_id = $2 AND ol.matrix_id IS NOT NULL`,
          [f.file_id, f.tenant_id],
        );
        // Build lookup index: fullKeys always win; strippedKey is only a
        // fuzzy fallback for legacy overrides written pre-5ee9dbc (key
        // without color_code suffix).
        // Also track collisions on strippedKey — a real risk if a
        // supplier ever ships two color codes with the same name
        // (LAVENDER-054 + LAVENDER-058, both strip to LAVENDER). In that
        // case we REFUSE to apply and surface the override for operator
        // review — silently guessing the wrong matrix would be worse.
        const idx           = new Map();  // exact "style|color-code" only
        const strippedIdx   = new Map();  // "style|color" (stripped) → first matrix_id
        const fullKeys      = new Set();  // exact full keys seen
        const collisions    = new Map();  // strippedKey → Set<matrix_id>
        for (const ln of lineRows) {
          const fullKey     = `${ln.supplier_style_ref}|${ln.color_normalized}`;
          const strippedKey = `${ln.supplier_style_ref}|${stripCodeSuffix(ln.color_normalized, ln.supplier_color_ref)}`;
          fullKeys.add(fullKey);
          idx.set(fullKey, ln.matrix_id);
          const prev = strippedIdx.get(strippedKey);
          if (prev == null) {
            strippedIdx.set(strippedKey, ln.matrix_id);
          } else if (prev !== ln.matrix_id) {
            const set = collisions.get(strippedKey) || new Set([prev]);
            set.add(ln.matrix_id);
            collisions.set(strippedKey, set);
          }
        }

        for (const ov of ovRows) {
          if (ov.category_id == null && ov.retail_price_override == null) { skipped++; continue; }
          // Two-step resolution: exact full-key first, then stripped-key
          // fallback, but ONLY if that stripped key has no collision.
          let matrixId = idx.get(ov.matrix_key);
          let resolvedVia = 'full';
          if (!matrixId) {
            if (collisions.has(ov.matrix_key)) {
              const colliders = [...collisions.get(ov.matrix_key)].join(',');
              l(`  ⚠ collision file=${f.file_id} matrix_key="${ov.matrix_key}" → matrices [${colliders}] all strip to this key. REFUSING to guess. Set the override manually in Lightspeed if needed.`);
              details.push({ file: f.file_id, matrix_key: ov.matrix_key,
                status: 'collision_refused', collidingMatrixIds: [...collisions.get(ov.matrix_key)] });
              notFound++;
              continue;
            }
            matrixId = strippedIdx.get(ov.matrix_key);
            resolvedVia = 'stripped';
          }
          if (!matrixId) {
            notFound++;
            details.push({ file: f.file_id, matrix_key: ov.matrix_key, status: 'not_found' });
            continue;
          }
          let curCat, curRetail;
          try {
            const { matrix } = await client.getMatrixWithVariants(matrixId);
            curCat    = String(matrix.categoryID ?? '0');
            curRetail = matrix.Prices?.ItemPrice?.[0]?.amount != null ? Number(matrix.Prices.ItemPrice[0].amount) : null;
          } catch (e) {
            failed++; details.push({ file: f.file_id, matrix_key: ov.matrix_key, status: 'get_failed', error: e.message });
            continue;
          }
          const wantCat    = ov.category_id != null ? String(ov.category_id) : null;
          const wantRetail = ov.retail_price_override != null ? Number(ov.retail_price_override) : null;
          const needMatrixCat    = wantCat != null && wantCat !== curCat;
          const needMatrixRetail = wantRetail != null && (curRetail == null || Math.abs(curRetail - wantRetail) > 0.01);

          const matrixPutBody = {};
          if (needMatrixCat)    matrixPutBody.categoryID = wantCat;
          if (needMatrixRetail) matrixPutBody.Prices = {
            ItemPrice: [
              { amount: String(wantRetail), useType: 'Default' },
              { amount: String(wantRetail), useType: 'MSRP' },
              { amount: String(wantRetail), useType: 'Online' },
            ],
          };
          const matrixChanges = [
            needMatrixCat    ? `cat ${curCat}->${wantCat}` : null,
            needMatrixRetail ? `retail ${curRetail ?? 'null'}->${wantRetail}` : null,
          ].filter(Boolean).join(', ') || 'up-to-date';

          // Always fetch + evaluate variants — the matrix can be correct
          // while its Items still hold stale $0/cat=0. Report per-variant.
          let variants = [];
          let variantsPatched = 0, variantsFailed = 0, variantsSkipped = 0;
          try {
            variants = await client.listVariantsForMatrix(matrixId);
          } catch (e) {
            l(`    ! list variants for matrix ${matrixId} failed: ${e.message}`);
          }
          const variantPlans = [];
          for (const v of variants) {
            const vBody = {};
            const vCurCat    = String(v.categoryID ?? '0');
            const vCurRetail = v.Prices?.ItemPrice?.[0]?.amount != null ? Number(v.Prices.ItemPrice[0].amount) : null;
            const vNeedCat    = wantCat    != null && vCurCat    !== wantCat;
            const vNeedRetail = wantRetail != null && (vCurRetail == null || Math.abs(vCurRetail - wantRetail) > 0.01);
            if (!vNeedCat && !vNeedRetail) { variantsSkipped++; continue; }
            if (vNeedCat)    vBody.categoryID = wantCat;
            if (vNeedRetail) vBody.Prices = {
              ItemPrice: [
                { amount: String(wantRetail), useType: 'Default' },
                { amount: String(wantRetail), useType: 'MSRP' },
                { amount: String(wantRetail), useType: 'Online' },
              ],
            };
            variantPlans.push({ itemID: v.itemID, body: vBody });
          }
          const needMatrix   = needMatrixCat || needMatrixRetail;
          const nothingToDo  = !needMatrix && variantPlans.length === 0;
          if (nothingToDo) {
            skipped++;
            l(`  = file=${f.file_id} matrix_key="${ov.matrix_key}" matrix=#${matrixId} — matrix + ${variantsSkipped} variants already up-to-date`);
            continue;
          }
          l(`  ${dry ? '~' : '->'} file=${f.file_id} matrix_key="${ov.matrix_key}" matrix=#${matrixId} — matrix ${matrixChanges}, ${variantPlans.length} variants to patch`);

          if (!dry) {
            let matrixOK = true;
            if (needMatrix) {
              try {
                await client._request('PUT', `/ItemMatrix/${matrixId}.json`, { body: matrixPutBody });
              } catch (e) {
                matrixOK = false;
                l(`    ! matrix PUT failed: ${e.message}`);
              }
            }
            for (const vp of variantPlans) {
              try {
                await client._request('PUT', `/Item/${vp.itemID}.json`, { body: vp.body });
                variantsPatched++;
              } catch (ve) {
                variantsFailed++;
                l(`    ! variant #${vp.itemID} PUT failed: ${ve.message}`);
              }
            }
            if (matrixOK && variantsFailed === 0) applied++;
            else if (variantsFailed > 0 && variantsPatched > 0) applied++; // partial ok
            else failed++;
            l(`    matrix ${matrixOK ? 'ok' : 'FAIL'}, variants ${variantsPatched}/${variantPlans.length} patched, ${variantsFailed} failed`);
            details.push({ file: f.file_id, matrix_key: ov.matrix_key, matrixId, status: 'applied',
              matrixChanges, variantsPatched, variantsFailed });
          } else {
            applied++;
            details.push({ file: f.file_id, matrix_key: ov.matrix_key, matrixId, status: 'would_apply',
              matrixChanges, variantsPlanned: variantPlans.length });
          }
        }
      }

      const summary = { mode: dry ? 'dry-run' : 'apply', applied, skipped, notFound, failed };
      l(`SUMMARY: ${JSON.stringify(summary)}`);
      res.json({ ok: true, summary, log, details });
    } catch (e) { next(e); }
  });

  // ─── POST /files/:file_id/confirm ────────────────────────────────────
  // Marks a pre-analyzed file as 'confirmed by operator'. Called by the
  // ImportModal when the operator ticks the checkbox and clicks Analyser.
  // The per-drop button then flips from "Importer" (pre-analysis only) to
  // "Voir importation" (operator has explicitly imported).
  app.post('/api/import/files/:file_id/confirm', requireAuth, async (req, res, next) => {
    try {
      const file = await loadFile(pool, req.tenantId, req.params.file_id);
      if (!file) return notFound(res, 'file_not_found', `file_id ${req.params.file_id}`);
      // Idempotent — don't overwrite an existing confirmation time
      if (file.confirmed_at) return res.json({ ok: true, confirmed_at: file.confirmed_at, already: true });
      await pool.query(
        `UPDATE import_files SET confirmed_at = now()
         WHERE file_id = $1 AND tenant_id = $2`,
        [file.file_id, req.tenantId],
      );
      const { rows } = await pool.query(
        `SELECT confirmed_at FROM import_files WHERE file_id = $1 AND tenant_id = $2`,
        [file.file_id, req.tenantId],
      );
      res.json({ ok: true, confirmed_at: rows[0]?.confirmed_at, already: false });
    } catch (e) { next(e); }
  });

  // ─── GET /files/:file_id/raw-text (diagnostic) ───────────────────────
  // Returns the padded raw text stored during LLM extraction. Used by
  // operator/dev diagnostics to inspect what the LLM was fed.
  app.get('/api/import/files/:file_id/raw-text', requireAuth, async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT raw_text FROM import_files WHERE file_id = $1 AND tenant_id = $2`,
        [req.params.file_id, req.tenantId],
      );
      if (!rows.length) return notFound(res, 'file_not_found', `file_id ${req.params.file_id}`);
      res.type('text/plain').send(rows[0].raw_text || '(no raw_text — this file was not LLM-extracted)');
    } catch (e) { next(e); }
  });

  // ─── POST /files/:file_id/reset-push ─────────────────────────────────
  // Force-resets a stuck push: file status='pushing' + queue status='running'
  // with no active worker (container restart mid-push, hung API call, etc.).
  // Marks the file back to 'previewed' + queue to 'failed' so the operator
  // can click Push again. Push is idempotent — lines already inserted in
  // Lightspeed have lightspeed_order_line_id set and are skipped on retry.
  app.post('/api/import/files/:file_id/reset-push', requireAuth, async (req, res, next) => {
    try {
      const file = await loadFile(pool, req.tenantId, req.params.file_id);
      if (!file) return notFound(res, 'file_not_found', `file_id ${req.params.file_id}`);
      if (!['pushing', 'partial', 'failed'].includes(file.status)) {
        return badRequest(res, 'not_resettable',
          `File status is '${file.status}' — reset only makes sense from pushing/partial/failed.`);
      }
      // Mark any lingering job as failed so a new push can start
      await pool.query(
        `UPDATE import_queue SET status = 'failed', finished_at = now(),
                                 error_message = 'Reset manually by operator'
         WHERE file_id = $1 AND tenant_id = $2 AND status IN ('queued','running')`,
        [file.file_id, req.tenantId],
      );
      await pool.query(
        `UPDATE import_files SET status = 'previewed'
         WHERE file_id = $1 AND tenant_id = $2`,
        [file.file_id, req.tenantId],
      );
      activeJobs.delete(req.tenantId);
      console.warn(`[import-push] file=${file.file_id} tenant=${req.tenantId} manually reset from '${file.status}'`);
      res.json({ ok: true, file_id: file.file_id, previous_status: file.status });
    } catch (e) { next(e); }
  });

  // ─── POST /files/:file_id/reset-extraction ───────────────────────────
  // Forces status='awaiting_extraction' + records the manual reset in
  // last_extraction_error. Used when an extraction is stuck ('extracting'
  // for too long — orphan job after container restart, hung Mistral call,
  // etc.). The background task (if still running) will eventually try to
  // update the DB and lose against a fresh extraction — accepted trade-off.
  app.post('/api/import/files/:file_id/reset-extraction', requireAuth, async (req, res, next) => {
    try {
      const file = await loadFile(pool, req.tenantId, req.params.file_id);
      if (!file) return notFound(res, 'file_not_found', `file_id ${req.params.file_id}`);
      if (['pushing', 'pushed', 'partial'].includes(file.status)) {
        return conflict(res, 'file_locked',
          `Cannot reset file in status '${file.status}' — already pushed to Lightspeed.`);
      }
      await pool.query(
        `UPDATE import_files
           SET status = 'awaiting_extraction',
               last_extraction_error = 'Extraction annulée manuellement.'
         WHERE file_id = $1 AND tenant_id = $2`,
        [file.file_id, req.tenantId],
      );
      console.warn(`[llm-extract] file=${file.file_id} tenant=${req.tenantId} manually reset from '${file.status}'`);
      res.json({ ok: true, file_id: file.file_id, previous_status: file.status });
    } catch (e) { next(e); }
  });

  // ─── GET /lightspeed/vendors ─────────────────────────────────────────
  // Proxies the Lightspeed vendor list so the operator can pick from an
  // actual dropdown when mapping a brand → vendor. Cached per-tenant for
  // 5 minutes. Scoped by tenantId so a future multi-account setup won't
  // leak vendors from tenant A into tenant B's dropdown.
  const vendorsCache = new Map(); // tenantId → { at, list }
  app.get('/api/import/lightspeed/vendors', requireAuth, async (req, res, next) => {
    try {
      const now = Date.now();
      const cached = vendorsCache.get(req.tenantId);
      if (!cached || (now - cached.at) > 5 * 60 * 1000) {
        let client;
        try { client = await fromTenant(pool, req.tenantId); }
        catch (e) {
          if (e.code === 'lightspeed_not_connected') return res.status(403).json({ error: e.code, message: e.message });
          throw e;
        }
        const vendors = await client.listVendors();
        vendorsCache.set(req.tenantId, {
          at:   now,
          list: vendors.map(v => ({
            vendor_id:   String(v.vendorID),
            name:        v.name,
            code:        v.code || null,
            contact:     v.contact || null,
          })),
        });
      }
      const fresh = vendorsCache.get(req.tenantId);
      res.json({ vendors: fresh.list, cached_at: fresh.at });
    } catch (e) { next(e); }
  });

  // ─── GET /lightspeed/categories ──────────────────────────────────────
  // Returns the category tree from Lightspeed as { nodes, roots }.
  //   nodes: { [category_id]: { id, name, parent_id, full_path, children: [id, ...] } }
  //   roots: [category_id, ...]  — top-level nodes
  // Cached per-tenant for 5 min. Categories rarely change. Scoped by
  // tenantId so a future multi-account setup can't serve tenant A's tree
  // to tenant B.
  const categoriesCache = new Map(); // tenantId → { at, nodes, roots }
  app.get('/api/import/lightspeed/categories', requireAuth, async (req, res, next) => {
    try {
      const now = Date.now();
      const cached = categoriesCache.get(req.tenantId);
      if (!cached || (now - cached.at) > 5 * 60 * 1000) {
        let client;
        try { client = await fromTenant(pool, req.tenantId); }
        catch (e) {
          if (e.code === 'lightspeed_not_connected') return res.status(403).json({ error: e.code, message: e.message });
          throw e;
        }
        const cats   = await client.listCategories();
        const nodes  = {};
        for (const c of cats) {
          const id = String(c.categoryID);
          nodes[id] = {
            id,
            name:      c.name,
            parent_id: c.parentID && c.parentID !== '0' ? String(c.parentID) : null,
            full_path: c.fullPathName || c.name,
            children:  [],
          };
        }
        const roots = [];
        for (const id in nodes) {
          const parentId = nodes[id].parent_id;
          if (parentId && nodes[parentId]) nodes[parentId].children.push(id);
          else roots.push(id);
        }
        // Sort children alphabetically at each level for stable UI
        for (const id in nodes) {
          nodes[id].children.sort((a, b) => nodes[a].name.localeCompare(nodes[b].name, 'fr'));
        }
        roots.sort((a, b) => nodes[a].name.localeCompare(nodes[b].name, 'fr'));
        categoriesCache.set(req.tenantId, { at: now, nodes, roots });
      }
      const fresh = categoriesCache.get(req.tenantId);
      res.json({ nodes: fresh.nodes, roots: fresh.roots, cached_at: fresh.at });
    } catch (e) { next(e); }
  });

  // ─── PATCH /files/:file_id/matrices/:matrix_key/override ─────────────
  // Persists an operator override on one matrix (currently: category).
  // matrix_key is URL-encoded "style_ref|color_normalized". Merged into
  // the preview response and used by push to set the matrix categoryID.
  app.patch('/api/import/files/:file_id/matrices/:matrix_key/override', requireAuth, async (req, res, next) => {
    try {
      const file = await loadFile(pool, req.tenantId, req.params.file_id);
      if (!file) return notFound(res, 'file_not_found', `file_id ${req.params.file_id}`);
      if (['pushed', 'partial'].includes(file.status)) {
        return conflict(res, 'file_locked',
          `File status is '${file.status}' — matrices already exist in Lightspeed.`);
      }
      const matrixKey = req.params.matrix_key;
      const body      = req.body || {};
      const hasCategory      = 'category_id'          in body;
      const hasRetail        = 'retail_price_override' in body;
      if (!hasCategory && !hasRetail) {
        return badRequest(res, 'missing_field', 'category_id or retail_price_override required');
      }
      // Read current row so PATCH only overwrites the fields present in body.
      const { rows: existing } = await pool.query(
        `SELECT category_id, category_path, retail_price_override
         FROM   import_matrix_overrides
         WHERE  tenant_id = $1 AND file_id = $2 AND matrix_key = $3`,
        [req.tenantId, file.file_id, matrixKey],
      );
      const cur = existing[0] || { category_id: null, category_path: null, retail_price_override: null };
      const nextCategoryId   = hasCategory ? (body.category_id == null ? null : String(body.category_id)) : cur.category_id;
      const nextCategoryPath = hasCategory ? (body.category_path || null) : cur.category_path;
      const nextRetail       = hasRetail
        ? (body.retail_price_override == null || body.retail_price_override === '' ? null : Number(body.retail_price_override))
        : cur.retail_price_override;
      await pool.query(
        `INSERT INTO import_matrix_overrides
           (tenant_id, file_id, matrix_key, category_id, category_path, retail_price_override, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (tenant_id, file_id, matrix_key)
         DO UPDATE SET category_id           = EXCLUDED.category_id,
                       category_path         = EXCLUDED.category_path,
                       retail_price_override = EXCLUDED.retail_price_override,
                       updated_at            = now()`,
        [req.tenantId, file.file_id, matrixKey, nextCategoryId, nextCategoryPath, nextRetail],
      );
      res.json({ ok: true, matrix_key: matrixKey,
        category_id: nextCategoryId, category_path: nextCategoryPath,
        retail_price_override: nextRetail });
    } catch (e) { next(e); }
  });

  // ─── POST /files/:id/matrices/apply-multiplier ───────────────────────
  // Bulk sets retail_price_override = cost × multiplier across matrices.
  // scope='missing' (default) touches only matrices with no PDF retail_price
  // and no existing override. scope='all' overwrites every matrix.
  app.post('/api/import/files/:file_id/matrices/apply-multiplier', requireAuth, async (req, res, next) => {
    try {
      const file = await loadFile(pool, req.tenantId, req.params.file_id);
      if (!file) return notFound(res, 'file_not_found', `file_id ${req.params.file_id}`);
      if (['pushed', 'partial'].includes(file.status)) {
        return conflict(res, 'file_locked',
          `File status is '${file.status}' — matrices already exist in Lightspeed.`);
      }
      const { multiplier, scope } = req.body || {};
      const mult = Number(multiplier);
      if (!Number.isFinite(mult) || mult <= 0) {
        return badRequest(res, 'invalid_multiplier', 'multiplier must be a positive number');
      }
      const scopeAll = scope === 'all';
      if (!file.preview_json?.matrices) {
        return badRequest(res, 'no_preview', 'File has no cached preview yet');
      }
      // Load existing overrides so scope='missing' can skip matrices that
      // already have an override.
      const currentOverrides = await loadMatrixOverrides(pool, req.tenantId, file.file_id);
      let applied = 0;
      for (const m of file.preview_json.matrices) {
        const cost = Number(m.unit_cost) || 0;
        if (cost <= 0) continue;
        const key       = `${m.style_ref}|${m.color_normalized}`;
        const currentOv = currentOverrides.get(key);
        const pdfRetail = m.retail_price != null ? Number(m.retail_price) : null;
        if (!scopeAll) {
          // Only fill truly-missing retails (no PDF value AND no existing override)
          if (pdfRetail != null || currentOv?.retail_price_override != null) continue;
        }
        const newRetail = Number((cost * mult).toFixed(2));
        await pool.query(
          `INSERT INTO import_matrix_overrides
             (tenant_id, file_id, matrix_key, category_id, category_path, retail_price_override, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, now())
           ON CONFLICT (tenant_id, file_id, matrix_key)
           DO UPDATE SET retail_price_override = EXCLUDED.retail_price_override, updated_at = now()`,
          [req.tenantId, file.file_id, key,
           currentOv?.category_id || null, currentOv?.category_path || null, newRetail],
        );
        applied++;
      }
      res.json({ ok: true, applied, multiplier: mult, scope: scopeAll ? 'all' : 'missing' });
    } catch (e) { next(e); }
  });

  // ─── POST /files/:id/matrices/apply-category ─────────────────────────
  // Bulk sets category_id + category_path on matrices for a file.
  // scope='all' (default) overwrites every matrix's category.
  // scope='missing' only fills matrices that don't have any category yet.
  app.post('/api/import/files/:file_id/matrices/apply-category', requireAuth, async (req, res, next) => {
    try {
      const file = await loadFile(pool, req.tenantId, req.params.file_id);
      if (!file) return notFound(res, 'file_not_found', `file_id ${req.params.file_id}`);
      if (['pushed', 'partial'].includes(file.status)) {
        return conflict(res, 'file_locked',
          `File status is '${file.status}' — matrices already exist in Lightspeed.`);
      }
      const { category_id, category_path, scope } = req.body || {};
      if (!category_id) {
        return badRequest(res, 'missing_field', 'category_id required');
      }
      if (!file.preview_json?.matrices) {
        return badRequest(res, 'no_preview', 'File has no cached preview yet');
      }
      const scopeAll = scope === 'all';
      const currentOverrides = await loadMatrixOverrides(pool, req.tenantId, file.file_id);
      let applied = 0;
      for (const m of file.preview_json.matrices) {
        const key       = `${m.style_ref}|${m.color_normalized}`;
        const currentOv = currentOverrides.get(key);
        if (!scopeAll && currentOv?.category_id) continue; // skip already-categorized
        await pool.query(
          `INSERT INTO import_matrix_overrides
             (tenant_id, file_id, matrix_key, category_id, category_path, retail_price_override, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, now())
           ON CONFLICT (tenant_id, file_id, matrix_key)
           DO UPDATE SET category_id   = EXCLUDED.category_id,
                         category_path = EXCLUDED.category_path,
                         updated_at    = now()`,
          [req.tenantId, file.file_id, key,
           String(category_id), category_path || null,
           currentOv?.retail_price_override ?? null],
        );
        applied++;
      }
      res.json({ ok: true, applied, category_id, category_path, scope: scopeAll ? 'all' : 'missing' });
    } catch (e) { next(e); }
  });

  // ─── PUT /settings/brand-vendor-map ──────────────────────────────────
  // Upsert one mapping (manufacturer → vendor_id) for the current tenant.
  // Body: { manufacturer: 'liujo', vendor_id: '72', vendor_name: 'LIU JO INC' }
  app.put('/api/settings/brand-vendor-map', requireAuth, async (req, res, next) => {
    try {
      const { manufacturer, vendor_id, vendor_name } = req.body || {};
      if (!manufacturer || !vendor_id) {
        return badRequest(res, 'missing_field', 'manufacturer and vendor_id are required');
      }
      await pool.query(
        `INSERT INTO brand_vendor_map (tenant_id, manufacturer, vendor_id, vendor_name, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (tenant_id, manufacturer)
         DO UPDATE SET vendor_id = EXCLUDED.vendor_id, vendor_name = EXCLUDED.vendor_name, updated_at = now()`,
        [req.tenantId, manufacturer, String(vendor_id), vendor_name || null],
      );
      res.json({ ok: true, manufacturer, vendor_id, vendor_name: vendor_name || null });
    } catch (e) { next(e); }
  });

  // Expose helpers so other modules (e.g. the budget-plan doc upload
  // endpoint in server.js) can trigger a pre-analysis when a PDF is
  // attached to a drop.
  return { spawnLlmExtractionBackground };
}

module.exports = { mountImportRoutes };
