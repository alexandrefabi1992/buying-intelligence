'use strict';
// Express routes for the supplier order ingestion module.
// All routes prefixed with /api/import, JWT-scoped by tenantId.
//
// Mounted from server.js via mountImportRoutes(app, pool, requireAuth).
// The queue processor and Lightspeed client are lazy-imported inside the
// route handlers so server.js keeps startup snappy.

const crypto = require('crypto');
const multer = require('multer');

const { parseOuiEurostyle } = require('./parsers/oui-eurostyle');
const { fromEnv }           = require('./lightspeed-client');
const { resolveStyles }     = require('./style-resolver');
const { buildPreview }      = require('./preview-generator');
const { runImportPush }     = require('./queue-processor');

// In-memory registry of running push jobs. One active job per tenant.
// Key = tenantId, value = { file_id, job_id, promise, startedAt }
const activeJobs = new Map();

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

async function loadFile(pool, tenantId, fileId) {
  const { rows } = await pool.query(
    `SELECT file_id, tenant_id, supplier_key, recipe_id, source_filename, source_hash,
            uploaded_by, uploaded_at, season_tag, destination_shop_id, target_manufacturer,
            status, preview_json, preview_computed_at
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
function mountImportRoutes(app, pool, requireAuth) {
  if (!app || !pool || !requireAuth) throw new Error('mountImportRoutes: app, pool, requireAuth required');

  // ─── POST /upload ─────────────────────────────────────────────────────
  // Multipart form: file (PDF) + season_tag + destination_shop_id + target_manufacturer
  // Parses, validates brand, inserts file/batches/order_lines, returns file_id.
  app.post('/api/import/upload', requireAuth, upload.single('file'), async (req, res, next) => {
    try {
      if (!req.file) return badRequest(res, 'no_file', 'No file uploaded (form field "file")');
      const { season_tag, destination_shop_id, target_manufacturer } = req.body || {};
      if (!season_tag)          return badRequest(res, 'missing_field', 'season_tag required');
      if (!destination_shop_id) return badRequest(res, 'missing_field', 'destination_shop_id required');
      if (!target_manufacturer) return badRequest(res, 'missing_field', 'target_manufacturer required');

      // 1. Detect recipe. For MVP, single supplier (oui-eurostyle). Later:
      //    iterate parse_recipes and pick first matching detection rules.
      const { rows: recipeRows } = await pool.query(
        `SELECT recipe_id, supplier_key, target_manufacturer
         FROM   parse_recipes WHERE active = true AND supplier_key = 'oui-eurostyle'
         ORDER  BY version DESC LIMIT 1`,
      );
      if (!recipeRows.length) return badRequest(res, 'no_active_recipe', 'No active parse_recipe available');
      const recipe = recipeRows[0];

      // 2. Parse
      let parsed;
      try {
        parsed = await parseOuiEurostyle(req.file.buffer);
      } catch (e) {
        return badRequest(res, 'parse_failed', `Parser threw: ${e.message}`);
      }
      if (!parsed?.products?.length) {
        return badRequest(res, 'parse_failed', 'Parser returned no products — check PDF format');
      }

      // 3. Brand validation — case-insensitive equality
      const parsedBrand = normStr(parsed.file?.target_manufacturer || recipe.target_manufacturer);
      const clickedBrand = normStr(target_manufacturer);
      if (parsedBrand !== clickedBrand) {
        return badRequest(res, 'brand_mismatch',
          `PDF is for "${parsed.file?.target_manufacturer || recipe.target_manufacturer}" but you clicked "${target_manufacturer}"`,
          { pdf_brand: parsed.file?.target_manufacturer, clicked_brand: target_manufacturer });
      }

      // 4. Compute source_hash for dedup
      const source_hash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
      const { rows: dupRows } = await pool.query(
        `SELECT file_id FROM import_files WHERE tenant_id = $1 AND source_hash = $2`,
        [req.tenantId, source_hash],
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
              uploaded_by, season_tag, destination_shop_id, target_manufacturer, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'parsed')
           RETURNING file_id`,
          [req.tenantId, recipe.supplier_key, recipe.recipe_id,
           req.file.originalname, source_hash, req.file.buffer,
           req.userId ?? null, season_tag, destination_shop_id, target_manufacturer],
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
          for (const v of p.variants) {
            await client.query(
              `INSERT INTO import_order_lines
                 (batch_id, tenant_id, supplier_style_ref, supplier_color_ref, color_normalized,
                  size_label, qty, unit_cost, unit_price_retail, status)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')`,
              [batchId, req.tenantId,
               p.style_ref, p.color_code, colorNormalized,
               v.size, v.qty, p.unit_cost, p.retail_price],
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
    } catch (e) { next(e); }
  });

  // ─── GET /files/:file_id/preview ──────────────────────────────────────
  // Cached in import_files.preview_json. ?refresh=true bypasses cache.
  app.get('/api/import/files/:file_id/preview', requireAuth, async (req, res, next) => {
    try {
      const file = await loadFile(pool, req.tenantId, req.params.file_id);
      if (!file) return notFound(res, 'file_not_found', `file_id ${req.params.file_id} not in this tenant`);

      const refresh = req.query.refresh === 'true' || req.query.refresh === '1';
      if (!refresh && file.preview_json) {
        return res.json({
          ...file.preview_json,
          cached: true,
          preview_computed_at: file.preview_computed_at,
        });
      }

      // Compute fresh
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
      });

      // Cache + advance status to 'previewed'
      await pool.query(
        `UPDATE import_files SET preview_json = $1::jsonb, preview_computed_at = now(),
                                 status = CASE WHEN status = 'parsed' THEN 'previewed' ELSE status END
         WHERE file_id = $2 AND tenant_id = $3`,
        [JSON.stringify(preview), file.file_id, req.tenantId],
      );

      res.json({ ...preview, cached: false, preview_computed_at: new Date().toISOString() });
    } catch (e) { next(e); }
  });

  // ─── GET /files ──────────────────────────────────────────────────────
  app.get('/api/import/files', requireAuth, async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT f.file_id, f.source_filename, f.uploaded_at, f.uploaded_by,
                f.season_tag, f.target_manufacturer, f.destination_shop_id, f.status,
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
         JOIN   import_batches      b ON b.batch_id = ol.batch_id
         WHERE  b.file_id = $1
         GROUP  BY ol.status`,
        [file.file_id],
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
      `SELECT default_attribute_set_id FROM parse_recipes WHERE recipe_id = $1`,
      [file.recipe_id],
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
       JOIN   import_batches      b ON b.batch_id = ol.batch_id
       WHERE  b.file_id = $1 AND b.selected = true`,
      [file.file_id],
    );
    const resolutions = await resolveStyles(client, styleRows.map(r => r.supplier_style_ref), file.season_tag);

    const opts = {
      tenantId, fileId: file.file_id, seasonTag: file.season_tag,
      targetManufacturer: file.target_manufacturer, manufacturerID, defaultVendorID,
      destinationShopID: file.destination_shop_id, attributeSetID, resolutions,
      onLineDone: async (line, summary) => {
        try {
          await pool.query(`UPDATE import_queue SET progress_current = $1 WHERE job_id = $2`,
            [summary.ordered + summary.error + summary.skipped, jobId]);
        } catch { /* non-blocking */ }
      },
    };

    const promise = runImportPush({ pool, client }, opts).then(async (summary) => {
      const anyError = summary.error > 0;
      await pool.query(
        `UPDATE import_queue SET status = $1, finished_at = now() WHERE job_id = $2`,
        [anyError ? 'failed' : 'done', jobId],
      );
      await pool.query(
        `UPDATE import_files SET status = $1 WHERE file_id = $2 AND tenant_id = $3`,
        [anyError ? 'partial' : 'pushed', file.file_id, tenantId],
      );
    }).catch(async (e) => {
      console.error(`[import-push] job ${jobId} threw:`, e.message);
      await pool.query(
        `UPDATE import_queue SET status = 'failed', finished_at = now(), error_message = $1 WHERE job_id = $2`,
        [String(e.message).slice(0, 1000), jobId],
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
  app.post('/api/import/files/:file_id/push', requireAuth, async (req, res, next) => {
    try {
      const file = await loadFile(pool, req.tenantId, req.params.file_id);
      if (!file) return notFound(res, 'file_not_found', `file_id ${req.params.file_id}`);
      if (!['previewed', 'partial', 'failed'].includes(file.status)) {
        return badRequest(res, 'file_not_previewed', `status must be one of previewed/partial/failed (current: ${file.status})`);
      }
      try {
        const body = await launchPushJob(req.tenantId, req.userId, file);
        res.status(202).json(body);
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
         JOIN   import_batches      b ON b.batch_id = ol.batch_id
         WHERE  b.file_id = $1 GROUP BY ol.status`,
        [req.params.file_id],
      );
      const counts = Object.fromEntries(countRows.map(r => [r.status, r.n]));

      const { rows: errorRows } = await pool.query(
        `SELECT ol.line_id, ol.supplier_style_ref, ol.color_normalized, ol.size_label, ol.error_message
         FROM   import_order_lines ol
         JOIN   import_batches      b ON b.batch_id = ol.batch_id
         WHERE  b.file_id = $1 AND ol.status = 'error'
         ORDER  BY ol.last_attempted_at DESC LIMIT 10`,
        [req.params.file_id],
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
         JOIN   import_batches      b ON b.batch_id = ol.batch_id
         WHERE  b.file_id = $1 AND ol.matrix_id IS NOT NULL`,
        [file.file_id],
      );
      const { rows: createdItems } = await pool.query(
        `SELECT ol.item_id, ol.supplier_style_ref, ol.color_normalized, ol.size_label
         FROM   import_order_lines ol
         JOIN   import_batches      b ON b.batch_id = ol.batch_id
         WHERE  b.file_id = $1 AND ol.item_id IS NOT NULL`,
        [file.file_id],
      );
      const { rows: createdOrders } = await pool.query(
        `SELECT b.batch_id, b.po_number, b.customer_reference, b.lightspeed_order_id
         FROM   import_batches b
         WHERE  b.file_id = $1 AND b.lightspeed_order_id IS NOT NULL`,
        [file.file_id],
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

  // ─── DELETE /files/:file_id ──────────────────────────────────────────
  // Only allowed BEFORE push starts (status in parsed | previewed).
  app.delete('/api/import/files/:file_id', requireAuth, async (req, res, next) => {
    try {
      const file = await loadFile(pool, req.tenantId, req.params.file_id);
      if (!file) return notFound(res, 'file_not_found', `file_id ${req.params.file_id}`);
      if (!['parsed', 'previewed'].includes(file.status)) {
        return conflict(res, 'cannot_delete_pushed',
          `Status is '${file.status}' — POs may already exist in Lightspeed. Use POST /abandon instead.`);
      }
      await pool.query(`DELETE FROM import_files WHERE file_id = $1 AND tenant_id = $2`, [file.file_id, req.tenantId]);
      res.json({ deleted: true, file_id: file.file_id });
    } catch (e) { next(e); }
  });
}

module.exports = { mountImportRoutes };
