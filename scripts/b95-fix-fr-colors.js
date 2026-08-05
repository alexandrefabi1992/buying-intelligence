#!/usr/bin/env node
'use strict';
// Fix for B9.5 English-named variants — archive the 2 that don't match the
// new French convention (Dk brown grey black-899 → Brun gris-899), then
// re-run the queue on file_id=7 to recreate them with French attribute2.
//
// The 3 "River stone-9373" variants (139117-139119) are already conformant
// per the new rules (river stone kept EN) — no action on them.
//
// PO #16 was already archived (via test DELETE /Order). New push will
// create a fresh PO "0361110 Consignment OTG" with 6 OrderLines pointing to
// the correct variants (2 new French + 3 river stone reused + 1 scarf reused).
//
// Run: DATABASE_URL='...' JWT_SECRET='...' LIGHTSPEED_* env node scripts/b95-fix-fr-colors.js

const { Pool } = require('pg');
const express = require('express');
const jwt     = require('jsonwebtoken');
const axios   = require('axios');
const { fromEnv } = require('../lib/lightspeed-client');
const { mountImportRoutes } = require('../lib/import-routes');

const TENANT     = 'valerie-simon';
const FILE_ID    = 7;
const BATCH_ID   = 31;                                  // PO 0361110 selected batch
const OLD_ENGLISH = ['139115', '139116'];               // Dk brown grey black-899
const KEEP_AS_IS  = ['139117', '139118', '139119'];     // River stone-9373 (correct per new rules)
const REUSED_SCARF = '135675';                          // Pre-existing scarf variant

const PORT = 3995;
const dbUrl = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET;
if (!dbUrl || !JWT_SECRET) { console.error('DATABASE_URL and JWT_SECRET required'); process.exit(1); }
const pool = new Pool({ connectionString: dbUrl, ssl: dbUrl.includes('railway.internal') ? undefined : { rejectUnauthorized: false } });

const requireAuth = (req, res, next) => {
  try { const p = jwt.verify((req.headers.authorization ?? '').replace('Bearer ',''), JWT_SECRET); req.tenantId=p.tenantId; req.userId=p.userId; req.role=p.role; next(); }
  catch { res.status(401).json({ error: 'x' }); }
};
const token = jwt.sign({ tenantId: TENANT, userId: 'fix', role: 'superadmin' }, JWT_SECRET);
const H = { Authorization: `Bearer ${token}` };
const BASE = `http://127.0.0.1:${PORT}`;

async function main() {
  const cli = fromEnv();
  console.log('═══ B9.5 FR-color fix ═══\n');

  // ─── 1. Archive the 2 English-named variants ──────────────────────────
  console.log('[1] Archive 139115 & 139116 (Dk brown grey black-899)…');
  for (const iid of OLD_ENGLISH) {
    try {
      await cli._request('DELETE', `/Item/${iid}.json`, {});
      console.log(`    ✔ #${iid} archived`);
    } catch (e) {
      console.log(`    ✗ #${iid} DELETE failed: ${e.status} ${e.body?.message ?? e.message}`);
    }
  }

  // ─── 2. Reset DB state ────────────────────────────────────────────────
  console.log('\n[2] Reset DB state for re-push…');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    // batch: clear PO id (PO #16 was archived — we'll create a new one)
    await c.query(`UPDATE import_batches SET lightspeed_order_id = NULL, status = 'previewed'
                   WHERE batch_id = $1 AND tenant_id = $2`, [BATCH_ID, TENANT]);

    // Lines with archived item_id: clear item_id + status back to matrix_ensured
    // (matrix is fine, matrix tag is fine — just need new variant)
    await c.query(
      `UPDATE import_order_lines
       SET    item_id = NULL,
              lightspeed_order_line_id = NULL,
              status = 'matrix_ensured',
              error_message = NULL
       WHERE  batch_id = $1 AND tenant_id = $2 AND item_id = ANY($3::text[])`,
      [BATCH_ID, TENANT, OLD_ENGLISH],
    );

    // Lines with kept item_ids (river stone + scarf): keep item_id, but clear
    // lightspeed_order_line_id and drop status to variant_tagged so /push will
    // skip variant creation + tag but re-create OrderLine under the new PO.
    await c.query(
      `UPDATE import_order_lines
       SET    lightspeed_order_line_id = NULL,
              status = 'variant_tagged',
              error_message = NULL
       WHERE  batch_id = $1 AND tenant_id = $2 AND item_id = ANY($3::text[])`,
      [BATCH_ID, TENANT, [...KEEP_AS_IS, REUSED_SCARF]],
    );

    // File status: /push requires previewed | partial | failed. Was 'pushed'.
    await c.query(`UPDATE import_files SET status = 'partial'
                   WHERE file_id = $1 AND tenant_id = $2`, [FILE_ID, TENANT]);

    await c.query('COMMIT');
    console.log('    ✔ DB state reset');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }

  // Show snapshot
  const { rows } = await pool.query(
    `SELECT line_id, supplier_style_ref, color_normalized, size_label, status, item_id
     FROM   import_order_lines WHERE batch_id = $1 ORDER BY line_id`, [BATCH_ID]);
  console.log('\n    DB snapshot:');
  for (const r of rows) console.log(`      L${r.line_id} ${r.supplier_style_ref}/${r.color_normalized}/${r.size_label} status=${r.status} item=${r.item_id ?? '-'}`);

  // ─── 3. Also update the 2 lines' color_normalized to the French value ─
  // (they were stored as "Dk brown grey black-899" — need "Brun gris-899"
  // so the queue POSTs the correct attribute2)
  console.log('\n[3] Update color_normalized on the 2 English-named lines to French…');
  const u = await pool.query(
    `UPDATE import_order_lines
     SET    color_normalized = 'Brun gris-899'
     WHERE  batch_id = $1 AND tenant_id = $2 AND color_normalized = 'Dk brown grey black-899'`,
    [BATCH_ID, TENANT],
  );
  console.log(`    ✔ ${u.rowCount} rows updated`);

  // ─── 4. Boot server, POST /push, poll ─────────────────────────────────
  console.log('\n[4] Kick /push and poll progress…');
  const app = express(); app.use(express.json());
  mountImportRoutes(app, pool, requireAuth);
  const srv = app.listen(PORT);
  try {
    const r = await axios.post(`${BASE}/api/import/files/${FILE_ID}/push`, {}, { headers: H });
    console.log(`    HTTP 202 job=${r.data.queue_job_id} lines_to_process=${r.data.lines_to_process}`);

    while (true) {
      await new Promise(x => setTimeout(x, 3000));
      const p = (await axios.get(`${BASE}/api/import/files/${FILE_ID}/progress`, { headers: H })).data;
      console.log(`    status=${p.status} ${p.current}/${p.total} counts=${JSON.stringify(p.counts)}`);
      if (['done','failed'].includes(p.status)) {
        if (p.recent_errors?.length) for (const e of p.recent_errors) console.log(`      ERR L${e.line_id}: ${e.error_message}`);
        break;
      }
    }
  } finally { srv.close(); }

  // ─── 5. Verify — read new PO + new variants ───────────────────────────
  console.log('\n[5] Verify new state in Lightspeed…');
  const { rows: [b] } = await pool.query(
    `SELECT lightspeed_order_id FROM import_batches WHERE batch_id = $1`, [BATCH_ID]);
  const newOID = b.lightspeed_order_id;
  console.log(`    New PO ID: ${newOID}`);

  const o = (await cli._request('GET', `/Order/${newOID}.json`, { params: { load_relations: '["OrderLines"]' } })).Order;
  console.log(`    refNum="${o.refNum}" archived=${o.archived}`);
  let ols = o.OrderLines?.OrderLine ?? []; if (!Array.isArray(ols)) ols = [ols];
  for (const ol of ols) console.log(`      OL${ol.orderLineID}: item=${ol.itemID}  qty=${ol.quantity}  price=${ol.price}  numReceived=${ol.numReceived}`);

  // Fetch the newly-created "Brun gris-899" variants
  const { rows: newVars } = await pool.query(
    `SELECT item_id, size_label FROM import_order_lines
     WHERE batch_id = $1 AND color_normalized = 'Brun gris-899' ORDER BY size_label`,
    [BATCH_ID]);
  console.log(`\n    New Brun gris-899 variants:`);
  for (const v of newVars) {
    const it = (await cli._request('GET', `/Item/${v.item_id}.json`, { params: { load_relations: '["Tags","ItemAttributes"]' } })).Item;
    const a = it.ItemAttributes || {};
    const tags = (() => { const t = it.Tags?.tag ?? it.Tags?.Tag; const arr = Array.isArray(t) ? t : (t ? [t] : []); return arr.map(x => typeof x === 'string' ? x : (x.name ?? x.Name)).filter(Boolean); })();
    console.log(`      #${v.item_id} attr1="${a.attribute1}" attr2="${a.attribute2}" tags=${JSON.stringify(tags)}`);
  }

  await pool.end();
  console.log('\n✅ Fix complete.');
}

main().catch(e => { console.error('FATAL:', e.message); if (e.body) console.error(JSON.stringify(e.body)); if (e.stack) console.error(e.stack); process.exit(1); });
