#!/usr/bin/env node
'use strict';
// End-to-end smoke test for the B9 REST routes.
// Boots an in-process Express app with the routes mounted, then exercises
// each endpoint via supertest-style raw HTTP calls (using axios).
// No live Lightspeed writes — preview is fetched but push is NOT run here.
//
// Run: DATABASE_URL='postgresql://…zephyr…' node scripts/smoke-import-routes.js

const express = require('express');
const jwt     = require('jsonwebtoken');
const fs      = require('fs');
const path    = require('path');
const axios   = require('axios');
const FormData = require('form-data');
const { Pool } = require('pg');

const { mountImportRoutes } = require('../lib/import-routes');

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) { console.error('DATABASE_URL required'); process.exit(1); }

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const TENANT     = 'valerie-simon';
const USER_ID    = 'smoke-test-user';
const PDF_PATH   = '/Users/alexandrefabi/Downloads/OrderConfirmationSteilmann_V2.pdf';
const PORT       = 3999;

const pool = new Pool({
  connectionString: dbUrl,
  ssl: dbUrl.includes('railway.internal') ? undefined : { rejectUnauthorized: false },
});

function requireAuth(req, res, next) {
  const t = (req.headers.authorization ?? '').replace('Bearer ', '');
  if (!t) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const p = jwt.verify(t, JWT_SECRET);
    req.tenantId = p.tenantId; req.userId = p.userId; req.role = p.role;
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

const token = jwt.sign({ tenantId: TENANT, userId: USER_ID, role: 'superadmin' }, JWT_SECRET, { expiresIn: '1h' });
const H = { Authorization: `Bearer ${token}` };
const BASE = `http://127.0.0.1:${PORT}`;

async function cleanup(fileId) {
  if (fileId) {
    // Test-created rows use tenant valerie-simon — but only smoke-owned files (from this user_id).
    // Force-delete by file_id.
    await pool.query(`DELETE FROM import_files WHERE file_id = $1 AND tenant_id = $2`, [fileId, TENANT]);
  }
}

async function main() {
  const app = express();
  app.use(express.json());
  mountImportRoutes(app, pool, requireAuth);
  const server = app.listen(PORT);
  console.log(`Server listening on ${PORT}`);

  let fileId = null;
  try {
    // ─── 1. Upload PDF ─────────────────────────────────────────────────
    console.log('\n[1] POST /api/import/upload');
    const fd = new FormData();
    fd.append('file', fs.createReadStream(PDF_PATH), { filename: 'test-steilmann.pdf', contentType: 'application/pdf' });
    fd.append('season_tag', 'a26');
    fd.append('destination_shop_id', '1');
    fd.append('target_manufacturer', 'Oui');
    const up = await axios.post(`${BASE}/api/import/upload`, fd, {
      headers: { ...fd.getHeaders(), ...H },
      maxBodyLength: 30 * 1024 * 1024,
      validateStatus: () => true,
    });
    console.log(`   HTTP ${up.status}`);
    if (up.status !== 200) {
      // Might be duplicate — clean up and retry
      if (up.data?.error === 'duplicate_file') {
        console.log(`   duplicate detected (existing file_id=${up.data.existing_file_id}), deleting and retrying…`);
        await cleanup(up.data.existing_file_id);
        const up2 = await axios.post(`${BASE}/api/import/upload`, fd, {
          headers: { ...fd.getHeaders(), ...H },
          maxBodyLength: 30 * 1024 * 1024, validateStatus: () => true,
        });
        if (up2.status !== 200) throw new Error(`Upload retry failed: ${up2.status} ${JSON.stringify(up2.data)}`);
        Object.assign(up, up2);
      } else {
        throw new Error(`Upload failed: ${up.status} ${JSON.stringify(up.data)}`);
      }
    }
    fileId = up.data.file_id;
    console.log(`   file_id=${fileId}, batches=${up.data.batches.length}, warnings=${up.data.warnings.length}`);
    console.log(`   batches:`);
    for (const b of up.data.batches) console.log(`     PO ${b.po_number} "${b.customer_reference}" ${b.unit_count_declared}u/${b.amount_declared}$ consign=${b.is_consignment}`);

    // ─── 2. Brand mismatch → 400 ───────────────────────────────────────
    console.log(`\n[2] POST /api/import/upload with WRONG brand → expect 400 brand_mismatch`);
    const fdBad = new FormData();
    fdBad.append('file', fs.createReadStream(PDF_PATH), { filename: 'test-brand.pdf' });
    fdBad.append('season_tag', 'a26');
    fdBad.append('destination_shop_id', '1');
    fdBad.append('target_manufacturer', 'Brax');
    const bad = await axios.post(`${BASE}/api/import/upload`, fdBad, {
      headers: { ...fdBad.getHeaders(), ...H }, maxBodyLength: 30*1024*1024, validateStatus: () => true,
    });
    console.log(`   HTTP ${bad.status} error=${bad.data?.error}`);
    if (bad.status !== 400 || bad.data?.error !== 'brand_mismatch') throw new Error(`Expected 400 brand_mismatch, got ${bad.status} ${JSON.stringify(bad.data)}`);

    // ─── 3. Duplicate → 409 ────────────────────────────────────────────
    console.log(`\n[3] POST /api/import/upload again → expect 409 duplicate_file`);
    const fdDup = new FormData();
    fdDup.append('file', fs.createReadStream(PDF_PATH), { filename: 'dup.pdf' });
    fdDup.append('season_tag', 'a26');
    fdDup.append('destination_shop_id', '1');
    fdDup.append('target_manufacturer', 'Oui');
    const dup = await axios.post(`${BASE}/api/import/upload`, fdDup, {
      headers: { ...fdDup.getHeaders(), ...H }, maxBodyLength: 30*1024*1024, validateStatus: () => true,
    });
    console.log(`   HTTP ${dup.status} error=${dup.data?.error} existing_file_id=${dup.data?.existing_file_id}`);
    if (dup.status !== 409 || dup.data?.error !== 'duplicate_file') throw new Error(`Expected 409 duplicate, got ${dup.status}`);

    // ─── 4. GET files list ─────────────────────────────────────────────
    console.log(`\n[4] GET /api/import/files`);
    const list = await axios.get(`${BASE}/api/import/files`, { headers: H });
    console.log(`   HTTP ${list.status}, files=${list.data.files.length}`);
    const mine = list.data.files.find(f => f.file_id === fileId);
    console.log(`   my file: ${mine.source_filename} status=${mine.status} batches=${mine.batches_count} lines=${mine.lines_count}`);

    // ─── 5. GET file metadata ──────────────────────────────────────────
    console.log(`\n[5] GET /api/import/files/${fileId}`);
    const meta = await axios.get(`${BASE}/api/import/files/${fileId}`, { headers: H });
    console.log(`   HTTP ${meta.status} status=${meta.data.file.status} batches=${meta.data.batches.length} line_counts=${JSON.stringify(meta.data.line_counts_by_status)}`);

    // ─── 6. GET preview (cold, ~30s) ───────────────────────────────────
    console.log(`\n[6] GET /api/import/files/${fileId}/preview (COLD — resolves against Lightspeed)`);
    const t6 = Date.now();
    const pv1 = await axios.get(`${BASE}/api/import/files/${fileId}/preview`, { headers: H, timeout: 120000 });
    console.log(`   HTTP ${pv1.status} in ${((Date.now()-t6)/1000).toFixed(1)}s`);
    if (pv1.status !== 200) throw new Error(`Preview failed: ${pv1.status} ${JSON.stringify(pv1.data)}`);
    const s = pv1.data.summary;
    console.log(`   cached=${pv1.data.cached}, matrices=${s.matrix_count}, orders=${s.order_count}`);
    console.log(`   actions: create_new=${s.counters.create_new} with_suffix=${s.counters.create_with_suffix} complete=${s.counters.complete_existing} error=${s.counters.error||0}`);
    console.log(`   units: parser=${s.summed_units_total} vs declared=${s.declared_units_total} ${s.units_match ? '✅' : '⚠'}`);

    // ─── 7. GET preview (cache hit, fast) ──────────────────────────────
    console.log(`\n[7] GET /api/import/files/${fileId}/preview (WARM — from cache)`);
    const t7 = Date.now();
    const pv2 = await axios.get(`${BASE}/api/import/files/${fileId}/preview`, { headers: H });
    console.log(`   HTTP ${pv2.status} in ${((Date.now()-t7)/1000).toFixed(2)}s cached=${pv2.data.cached}`);
    if (!pv2.data.cached) throw new Error(`Expected cached=true on second call`);
    if (Date.now() - t7 > 2000) throw new Error(`Cache hit should be < 2s`);

    // ─── 8. Deselect a batch ───────────────────────────────────────────
    console.log(`\n[8] PATCH /api/import/batches/${up.data.batches[0].batch_id} → selected=false`);
    const patch = await axios.patch(`${BASE}/api/import/batches/${up.data.batches[0].batch_id}`,
      { selected: false }, { headers: H });
    console.log(`   HTTP ${patch.status} → ${JSON.stringify(patch.data)}`);

    // ─── 9. Abandon (should succeed since not pushed) ──────────────────
    console.log(`\n[9] POST /api/import/files/${fileId}/abandon`);
    const ab = await axios.post(`${BASE}/api/import/files/${fileId}/abandon`, {}, { headers: H });
    console.log(`   HTTP ${ab.status} abandoned=${ab.data.abandoned}`);
    console.log(`   cleanup_needed: matrices=${ab.data.cleanup_needed.matrices.length}, items=${ab.data.cleanup_needed.items.length}, orders=${ab.data.cleanup_needed.orders.length}`);

    // ─── 10. Verify abandoned status ───────────────────────────────────
    console.log(`\n[10] GET /api/import/files/${fileId} (verify status=abandoned)`);
    const meta2 = await axios.get(`${BASE}/api/import/files/${fileId}`, { headers: H });
    console.log(`   file status=${meta2.data.file.status}`);
    if (meta2.data.file.status !== 'abandoned') throw new Error(`Expected status=abandoned`);

    // ─── 11. DELETE denied (status not parsed/previewed) ───────────────
    console.log(`\n[11] DELETE /api/import/files/${fileId} → expect 409 (status is abandoned, not parsed/previewed)`);
    const del = await axios.delete(`${BASE}/api/import/files/${fileId}`, { headers: H, validateStatus: () => true });
    console.log(`   HTTP ${del.status} error=${del.data?.error}`);
    if (del.status !== 409) throw new Error(`Expected 409 for delete after abandon`);

    console.log(`\n✅ All route smoke tests passed.`);
  } finally {
    console.log(`\n[Cleanup] Removing test file_id=${fileId}`);
    await cleanup(fileId);
    server.close();
    await pool.end();
  }
}

main().catch(async (e) => {
  console.error('FATAL:', e.message);
  if (e.response) console.error('  response:', e.response.status, JSON.stringify(e.response.data).slice(0, 300));
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
