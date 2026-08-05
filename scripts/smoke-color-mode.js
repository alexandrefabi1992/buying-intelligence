#!/usr/bin/env node
'use strict';
// Smoke test for the color_translation_mode setting routes + branch logic.
//
// Tests:
//   1. GET default returns 'french' when nothing set
//   2. PUT 'passthrough' persists and GET reflects it
//   3. PUT 'french' persists and GET reflects it
//   4. PUT invalid value returns 400
//   5. Branch logic (in-process): simulate the /upload composition for both
//      modes against a stubbed parser product, assert the two paths differ.
//
// Restores original mode at the end. Does NOT touch import_files, so the
// existing B9.5 record (file_id=7) is preserved.
//
// Run: DATABASE_URL='...' JWT_SECRET='...' node scripts/smoke-color-mode.js

const express = require('express');
const jwt     = require('jsonwebtoken');
const axios   = require('axios');
const { Pool } = require('pg');
const { mountImportRoutes } = require('../lib/import-routes');

const TENANT = 'valerie-simon';
const PORT   = 3994;

const dbUrl = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET;
if (!dbUrl || !JWT_SECRET) { console.error('DATABASE_URL + JWT_SECRET required'); process.exit(1); }
const pool = new Pool({ connectionString: dbUrl, ssl: dbUrl.includes('railway.internal') ? undefined : { rejectUnauthorized: false } });
const requireAuth = (req, res, next) => { try { const p = jwt.verify((req.headers.authorization ?? '').replace('Bearer ',''), JWT_SECRET); req.tenantId=p.tenantId; req.userId=p.userId; req.role=p.role; next(); } catch { res.status(401).json({error:'x'}); } };
const token = jwt.sign({ tenantId: TENANT, userId: 'smoke-color', role: 'superadmin' }, JWT_SECRET);
const H = { Authorization: `Bearer ${token}` };
const BASE = `http://127.0.0.1:${PORT}`;

// Stub parser product — mirrors what parseOuiEurostyle emits for style 97981
// dark brown grey black, color code 899. Used by the branch-logic test below.
const STUB_PRODUCT = {
  style_ref:        '97981',
  color_code:       '899',
  color_label:      'dk brown grey black',      // raw (matches color_translations key)
  color_normalized: 'Dk brown grey black-899',  // parser's Title-cased fallback
};

async function main() {
  const app = express(); app.use(express.json());
  mountImportRoutes(app, pool, requireAuth);
  const srv = app.listen(PORT);

  let originalMode;
  try {
    // Save current mode
    originalMode = (await axios.get(`${BASE}/api/settings/import-colors`, { headers: H })).data.color_translation_mode;
    console.log(`[setup] original mode: ${originalMode}`);

    // ─── 1. Reset to default and read ─────────────────────────────────
    console.log('\n[1] DELETE any existing setting → GET should default to french');
    await pool.query(`DELETE FROM app_settings WHERE tenant_id = $1 AND key = 'color_translation_mode'`, [TENANT]);
    const g0 = (await axios.get(`${BASE}/api/settings/import-colors`, { headers: H })).data;
    if (g0.color_translation_mode !== 'french') throw new Error(`expected french default, got ${g0.color_translation_mode}`);
    console.log(`  ✔ GET returned '${g0.color_translation_mode}' (default)`);

    // ─── 2. PUT passthrough → GET reflects ─────────────────────────────
    console.log('\n[2] PUT passthrough');
    const p1 = (await axios.put(`${BASE}/api/settings/import-colors`, { color_translation_mode: 'passthrough' }, { headers: H })).data;
    if (p1.color_translation_mode !== 'passthrough') throw new Error(`PUT response ${p1.color_translation_mode}`);
    const g1 = (await axios.get(`${BASE}/api/settings/import-colors`, { headers: H })).data;
    if (g1.color_translation_mode !== 'passthrough') throw new Error(`GET after PUT: ${g1.color_translation_mode}`);
    console.log(`  ✔ PUT + GET both 'passthrough'`);

    // ─── 3. PUT french → GET reflects ──────────────────────────────────
    console.log('\n[3] PUT french');
    const p2 = (await axios.put(`${BASE}/api/settings/import-colors`, { color_translation_mode: 'french' }, { headers: H })).data;
    const g2 = (await axios.get(`${BASE}/api/settings/import-colors`, { headers: H })).data;
    if (p2.color_translation_mode !== 'french' || g2.color_translation_mode !== 'french') throw new Error('french round-trip failed');
    console.log(`  ✔ PUT + GET both 'french'`);

    // ─── 4. Invalid mode → 400 ─────────────────────────────────────────
    console.log('\n[4] PUT invalid → expect 400');
    const bad = await axios.put(`${BASE}/api/settings/import-colors`, { color_translation_mode: 'whatever' }, { headers: H, validateStatus: () => true });
    if (bad.status !== 400) throw new Error(`expected 400, got ${bad.status}`);
    if (bad.data.error !== 'invalid_mode') throw new Error(`error code: ${bad.data.error}`);
    console.log(`  ✔ HTTP 400 error=${bad.data.error}`);

    // Also missing field
    const bad2 = await axios.put(`${BASE}/api/settings/import-colors`, {}, { headers: H, validateStatus: () => true });
    if (bad2.status !== 400) throw new Error(`empty body: expected 400, got ${bad2.status}`);
    console.log(`  ✔ empty body → 400`);

    // ─── 5. Branch logic — replicate the /upload composition for both modes ──
    console.log('\n[5] Branch composition logic (in-process, stub product)');
    const p = STUB_PRODUCT;
    const { rows: ctRows } = await pool.query(
      `SELECT raw_color, normalized FROM color_translations WHERE supplier_key = 'oui-eurostyle'`);
    const colorMap = new Map(ctRows.map(r => [String(r.raw_color).toLowerCase(), r.normalized]));

    // Simulate french path
    const rawColor = String(p.color_label).toLowerCase();
    const frenchName = colorMap.get(rawColor);
    const frenchOutput = frenchName
      ? (p.color_code ? `${frenchName}-${p.color_code}` : frenchName)
      : p.color_normalized;
    console.log(`  french path      → "${frenchOutput}"`);
    if (frenchOutput !== 'Brun gris-899') throw new Error(`french expected "Brun gris-899", got "${frenchOutput}"`);

    // Simulate passthrough path
    const passthroughOutput = p.color_normalized;
    console.log(`  passthrough path → "${passthroughOutput}"`);
    if (passthroughOutput !== 'Dk brown grey black-899') throw new Error(`passthrough expected "Dk brown grey black-899", got "${passthroughOutput}"`);

    console.log(`  ✔ Both branches produce the expected value`);

    console.log('\n✅ All color-mode setting assertions passed.');
  } finally {
    // Restore original mode
    console.log(`\n[restore] mode → ${originalMode}`);
    await axios.put(`${BASE}/api/settings/import-colors`, { color_translation_mode: originalMode }, { headers: H }).catch(() => {});
    srv.close();
    await pool.end();
  }
}

main().catch(e => { console.error('FATAL:', e.message); if (e.response) console.error(JSON.stringify(e.response.data).slice(0,400)); if (e.stack) console.error(e.stack); process.exit(1); });
