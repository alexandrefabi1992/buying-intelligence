#!/usr/bin/env node
'use strict';
// B9.5 — LIVE push of ONE real PO through the full REST stack.
//
// Two modes:
//   plan                → upload, preview, deselect 5 other batches, print plan, exit
//   push <file_id>      → POST /push, poll /progress, verify Lightspeed state, list IDs
//
// The plan mode leaves the file row in the DB so `push` can find it by ID.
// If a prior "test-b95" file exists, it is deleted first (idempotent replay).

const express = require('express');
const jwt     = require('jsonwebtoken');
const fs      = require('fs');
const axios   = require('axios');
const FormData = require('form-data');
const { Pool } = require('pg');

const { mountImportRoutes } = require('../lib/import-routes');
const { fromEnv }           = require('../lib/lightspeed-client');

const TENANT     = 'valerie-simon';
const USER_ID    = 'b95-test';
const PDF_PATH   = '/Users/alexandrefabi/Downloads/OrderConfirmationSteilmann_V2.pdf';
const PORT       = 3998;
const TARGET_PO  = '0361110';

const MODE = process.argv[2] || 'plan';
const FILE_ID_ARG = process.argv[3] ? Number(process.argv[3]) : null;

const dbUrl = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET;
if (!dbUrl || !JWT_SECRET) { console.error('DATABASE_URL and JWT_SECRET required'); process.exit(1); }
const pool = new Pool({ connectionString: dbUrl, ssl: dbUrl.includes('railway.internal') ? undefined : { rejectUnauthorized: false } });

function requireAuth(req, res, next) {
  const t = (req.headers.authorization ?? '').replace('Bearer ', '');
  try {
    const p = jwt.verify(t, JWT_SECRET);
    req.tenantId = p.tenantId; req.userId = p.userId; req.role = p.role;
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}
const token = jwt.sign({ tenantId: TENANT, userId: USER_ID, role: 'superadmin' }, JWT_SECRET, { expiresIn: '2h' });
const H = { Authorization: `Bearer ${token}` };
const BASE = `http://127.0.0.1:${PORT}`;

async function bootServer() {
  const app = express();
  app.use(express.json());
  mountImportRoutes(app, pool, requireAuth);
  return app.listen(PORT);
}

// ─── Plan mode ────────────────────────────────────────────────────────────
async function plan() {
  const server = await bootServer();
  try {
    console.log('═══ PLAN MODE ═══\n');

    // Idempotency: delete any prior test-b95 file (matches by original filename)
    const prior = await pool.query(
      `SELECT file_id FROM import_files WHERE tenant_id = $1 AND source_filename = 'test-b95.pdf'`,
      [TENANT]);
    for (const r of prior.rows) {
      await pool.query(`DELETE FROM import_files WHERE file_id = $1`, [r.file_id]);
      console.log(`  Deleted prior test file #${r.file_id}`);
    }

    // 1. Upload
    console.log('[1] Upload PDF…');
    const fd = new FormData();
    fd.append('file', fs.createReadStream(PDF_PATH), { filename: 'test-b95.pdf', contentType: 'application/pdf' });
    fd.append('season_tag', 'a26');
    fd.append('destination_shop_id', '1');
    fd.append('target_manufacturer', 'Oui');
    const up = await axios.post(`${BASE}/api/import/upload`, fd, {
      headers: { ...fd.getHeaders(), ...H }, maxBodyLength: 30*1024*1024,
    });
    const fileId = up.data.file_id;
    console.log(`    file_id=${fileId}, ${up.data.batches.length} batches`);

    // 2. Preview
    console.log('[2] Fetch preview (cold — will hit Lightspeed)…');
    const t0 = Date.now();
    const pv = await axios.get(`${BASE}/api/import/files/${fileId}/preview`, { headers: H, timeout: 120000 });
    console.log(`    ${((Date.now()-t0)/1000).toFixed(1)}s, ${pv.data.summary.matrix_count} matrices resolved`);

    // 3. Deselect all except target PO
    console.log(`[3] Deselect all batches except PO ${TARGET_PO}…`);
    for (const b of up.data.batches) {
      const keep = b.po_number === TARGET_PO;
      if (!keep) {
        await axios.patch(`${BASE}/api/import/batches/${b.batch_id}`, { selected: false }, { headers: H });
        console.log(`    ✗ deselected batch ${b.batch_id} (PO ${b.po_number})`);
      } else {
        console.log(`    ✓ kept       batch ${b.batch_id} (PO ${b.po_number})`);
      }
    }

    // 4. Build plan from preview data filtered to target PO's matrices
    const targetOrder = pv.data.orders.find(o => o.po_number === TARGET_PO);
    if (!targetOrder) throw new Error(`PO ${TARGET_PO} not found in preview`);
    const targetLineKeys = new Set(targetOrder.lines.map(l => `${l.style_ref}|${l.color_normalized}`));
    const targetMatrices = pv.data.matrices.filter(m => {
      // A matrix is "in this PO" if any of its po_quantities includes TARGET_PO
      return Object.keys(m.po_quantities).includes(TARGET_PO);
    });

    // For each target matrix, compute per-PO lines (only TARGET_PO)
    console.log(`\n═══ PLAN FOR PO ${TARGET_PO} "${targetOrder.customer_reference}" ═══`);
    console.log(`  PO meta: order=${targetOrder.order_date} deliv=${targetOrder.delivery_date} canc=${targetOrder.cancel_date}  ${targetOrder.is_consignment ? '[consignation]' : ''}`);
    console.log(`  Declared: ${targetOrder.unit_count_declared} unités / ${(targetOrder.amount_declared).toFixed(2)} $`);
    console.log(`  refNum planifié: "${TARGET_PO} ${targetOrder.customer_reference}"`);

    const actionCounts = { create_new: 0, create_with_suffix: 0, complete_existing: 0 };
    console.log(`\n  MATRICES (${targetMatrices.length}) :`);
    let variantsToCreate = 0;
    let variantsExisting = 0;
    for (const m of targetMatrices) {
      actionCounts[m.action] = (actionCounts[m.action] || 0) + 1;
      const poQ = m.po_quantities[TARGET_PO] || {};
      const sizesInThisPO = Object.entries(poQ).map(([s, q]) => `${s}×${q}`).join(' ');
      const actionLabel = ({
        create_new:         'CRÉER NEW',
        create_with_suffix: `CRÉER "${m.matrix_description_planned}"`,
        complete_existing:  `COMPLÉTER #${m.reused_matrix_id}`,
      })[m.action] || m.action;
      const willCreateVariants = m.variants_to_create.filter(v => sizesInThisPO.includes(v.size));
      const willReuseVariants  = m.variants_already_present.filter(v => sizesInThisPO.includes(v.size));
      variantsToCreate += willCreateVariants.length;
      variantsExisting += willReuseVariants.length;
      console.log(`    ▸ ${m.style_ref.padEnd(8)} ${m.color_normalized.padEnd(24)} ${(m.description||'').padEnd(12)}`);
      console.log(`      action: ${actionLabel}  desc="${m.matrix_description_planned}"`);
      console.log(`      lignes PO ${TARGET_PO}: [${sizesInThisPO}]  cost=${m.unit_cost}  retail=${m.retail_price}`);
      if (willCreateVariants.length) console.log(`      variantes À CRÉER: ${willCreateVariants.map(v => v.size).join(', ')}`);
      if (willReuseVariants.length)  console.log(`      variantes DÉJÀ LÀ: ${willReuseVariants.map(v => v.size).join(', ')}`);
    }

    // Count order lines
    const nLines = targetOrder.lines.length;

    // Estimate API calls
    const nMatricesNew = actionCounts.create_new + actionCounts.create_with_suffix;
    const apiCalls = {
      // resolveStyles: 1 prefix + up to 2 variant fetches per style (already cached in preview)
      resolveOnPush:    targetMatrices.length * 2, // rough: 1 prefix + 1 variants each
      matrixPOST:       nMatricesNew,
      matrixTagPUT:     nMatricesNew,           // GET+PUT (2 calls) per matrix, but tagMatrix = 1 or 2
      variantLiveCheck: variantsToCreate,       // listVariantsForMatrix before each POST /Item
      variantPOST:      variantsToCreate,
      variantTagPUT:    variantsToCreate + variantsExisting, // idempotent tagItem for every line
      orderPOST:        1,
      orderLinePOST:    nLines,
    };
    const totalApiCalls = Object.values(apiCalls).reduce((s, n) => s + n, 0);

    console.log(`\n  RÉCAP:`);
    console.log(`    ${actionCounts.create_new} matrice(s) CRÉER (bare)`);
    console.log(`    ${actionCounts.create_with_suffix} matrice(s) CRÉER avec suffixe a26`);
    console.log(`    ${actionCounts.complete_existing} matrice(s) COMPLÉTER existante`);
    console.log(`    ${variantsToCreate} variante(s) neuve(s), ${variantsExisting} déjà présente(s)`);
    console.log(`    ${nLines} OrderLine à créer`);
    console.log(`\n  APPELS API ESTIMÉS (worst case):`);
    for (const [k, n] of Object.entries(apiCalls)) console.log(`    ${k.padEnd(20)} : ${n}`);
    console.log(`    ${'TOTAL'.padEnd(20)} : ${totalApiCalls}  (~${Math.ceil(totalApiCalls/3)}s @ 3 req/s)`);

    console.log(`\n═══════════════════════════════════════════════════════════════════════`);
    console.log(`  ENDS HERE. Pour pousser:  node scripts/b95-live.js push ${fileId}`);
    console.log(`═══════════════════════════════════════════════════════════════════════`);
  } finally {
    server.close();
    await pool.end();
  }
}

// ─── Push mode ────────────────────────────────────────────────────────────
async function push() {
  if (!FILE_ID_ARG) throw new Error('push mode requires file_id: node b95-live.js push <file_id>');
  const server = await bootServer();
  try {
    console.log(`═══ PUSH MODE — file_id ${FILE_ID_ARG} ═══\n`);

    // 1. POST /push
    console.log('[1] POST /push…');
    const push = await axios.post(`${BASE}/api/import/files/${FILE_ID_ARG}/push`, {}, { headers: H });
    console.log(`    HTTP 202 job_id=${push.data.queue_job_id} batches_included=${push.data.batches_included} lines_to_process=${push.data.lines_to_process}`);

    // 2. Poll /progress
    console.log('[2] Polling /progress every 3s…');
    let doneStatus;
    while (true) {
      await new Promise(r => setTimeout(r, 3000));
      const p = await axios.get(`${BASE}/api/import/files/${FILE_ID_ARG}/progress`, { headers: H });
      const q = p.data;
      const counts = q.counts || {};
      console.log(`    status=${q.status.padEnd(8)}  ${q.current}/${q.total}  ordered=${counts.ordered||0} error=${counts.error||0}`);
      if (['done', 'failed'].includes(q.status)) { doneStatus = q; break; }
    }

    if (doneStatus.status === 'failed' && (doneStatus.counts?.error || 0) > 0) {
      console.log(`\n  ✗ Push encountered errors:`);
      for (const e of doneStatus.recent_errors) console.log(`    L${e.line_id} ${e.style} ${e.color} ${e.size}: ${e.error_message}`);
      throw new Error('Push failed with errors — see above');
    }

    // 3. Verify against Lightspeed
    console.log('\n[3] VERIFICATION — reading back from Lightspeed…');
    const client = fromEnv();
    const { rows: batchRows } = await pool.query(
      `SELECT batch_id, po_number, customer_reference, lightspeed_order_id
       FROM   import_batches WHERE file_id = $1 AND selected = true AND lightspeed_order_id IS NOT NULL`,
      [FILE_ID_ARG]);
    if (!batchRows.length) throw new Error('No lightspeed_order_id found — push may not have completed');

    const createdIds = { matrices: new Set(), items: new Set(), orders: new Set(), orderLines: [] };

    for (const b of batchRows) {
      console.log(`\n  ▸ Order ${b.lightspeed_order_id}  refNum expected="${b.po_number} ${b.customer_reference}"`);
      createdIds.orders.add(b.lightspeed_order_id);
      const oCap = await client._request('GET', `/Order/${b.lightspeed_order_id}.json`, { params: { load_relations: '["OrderLines"]' } });
      const ord = oCap.Order || {};
      console.log(`      refNum lu     = "${ord.refNum}"`);
      console.log(`      vendorID=${ord.vendorID}  shopID=${ord.shopID}  complete=${ord.complete}`);
      let ols = ord.OrderLines?.OrderLine || []; if (!Array.isArray(ols)) ols = [ols];
      for (const ol of ols) {
        console.log(`        OL ${ol.orderLineID}: item=${ol.itemID}  qty=${ol.quantity}  numReceived=${ol.numReceived}  price=${ol.price}  vendorCost=${ol.vendorCost}`);
        createdIds.orderLines.push({ id: ol.orderLineID, itemId: ol.itemID, qty: ol.quantity });
      }
    }

    // Get all matrix_ids and item_ids that were used in this push
    const { rows: lineRows } = await pool.query(
      `SELECT DISTINCT ol.matrix_id, ol.item_id, ol.supplier_style_ref, ol.color_normalized, ol.size_label
       FROM   import_order_lines ol
       JOIN   import_batches      b ON b.batch_id = ol.batch_id
       WHERE  b.file_id = $1 AND b.selected = true AND ol.status = 'ordered'`,
      [FILE_ID_ARG]);
    const matrixIds = [...new Set(lineRows.map(r => r.matrix_id))];
    const itemIds   = [...new Set(lineRows.map(r => r.item_id))];

    console.log(`\n  ▸ Matrices touchées (${matrixIds.length}):`);
    const tagList = f => { if (!f) return []; const r = f.tag ?? f.Tag ?? f; const a = Array.isArray(r) ? r : [r]; return a.map(t => typeof t === 'string' ? t : (t.name ?? t.Name)).filter(Boolean); };
    const priceList = f => { if (!f) return []; const a = Array.isArray(f.ItemPrice) ? f.ItemPrice : (f.ItemPrice ? [f.ItemPrice] : []); return a; };

    for (const mid of matrixIds) {
      createdIds.matrices.add(mid);
      const m = (await client._request('GET', `/ItemMatrix/${mid}.json`, { params: { load_relations: '["Tags"]' } })).ItemMatrix;
      const tags = tagList(m.Tags);
      const prices = priceList(m.Prices);
      console.log(`      #${mid}  "${m.description}"  cost=${m.defaultCost}  vendor=${m.defaultVendorID}`);
      console.log(`        tags: ${tags.join(', ') || '(none)'}${tags.includes('a26') ? '  ✅' : '  ⚠ missing a26!'}`);
      console.log(`        prices: ${prices.map(p => `${p.useType}=${p.amount}`).join(', ') || '(none)'}`);
    }

    console.log(`\n  ▸ Variantes ordonnées (${itemIds.length}):`);
    for (const iid of itemIds) {
      createdIds.items.add(iid);
      const it = (await client._request('GET', `/Item/${iid}.json`, { params: { load_relations: '["Tags","ItemAttributes","ItemVendorNums","ItemShops"]' } })).Item;
      const tags = tagList(it.Tags);
      const prices = priceList(it.Prices);
      const attr = it.ItemAttributes || {};
      let shops = it.ItemShops?.ItemShop || []; if (!Array.isArray(shops)) shops = [shops];
      const stockNonZero = shops.filter(s => Number(s.qoh) !== 0);
      console.log(`      #${iid}  attr1=${attr.attribute1}  attr2=${attr.attribute2}  cost=${it.defaultCost}`);
      console.log(`        tags: ${tags.join(', ') || '(none)'}${tags.includes('a26') ? '  ✅' : '  ⚠ missing a26!'}`);
      console.log(`        prices: ${prices.map(p => `${p.useType}=${p.amount}`).join(', ') || '(none)'}`);
      console.log(`        stock:  ${stockNonZero.length === 0 ? 'zero across all shops ✅' : '⚠ NON-ZERO: ' + stockNonZero.map(s => `shop${s.shopID}=${s.qoh}`).join(', ')}`);
    }

    // ─── FINAL SUMMARY ─────────────────────────────────────────────────
    console.log(`\n═══════════════════════════════════════════════════════════════════════`);
    console.log(`  IDS CRÉÉS DANS LIGHTSPEED  (à conserver si tout est OK)`);
    console.log(`═══════════════════════════════════════════════════════════════════════`);
    console.log(`  Order(s):     ${[...createdIds.orders].join(', ')}`);
    console.log(`  Matrix(es):   ${[...createdIds.matrices].join(', ')}`);
    console.log(`  Item(s):      ${[...createdIds.items].join(', ')}`);
    console.log(`  OrderLine(s): ${createdIds.orderLines.map(o => `#${o.id}(item=${o.itemId} qty=${o.qty})`).join(', ')}`);
  } finally {
    server.close();
    await pool.end();
  }
}

// ─── Dispatch ─────────────────────────────────────────────────────────────
if (MODE === 'plan') plan().catch(e => { console.error('FATAL:', e.message); if (e.response) console.error(JSON.stringify(e.response.data).slice(0,400)); process.exit(1); });
else if (MODE === 'push') push().catch(e => { console.error('FATAL:', e.message); if (e.response) console.error(JSON.stringify(e.response.data).slice(0,400)); process.exit(1); });
else { console.error(`unknown mode: ${MODE}. Use: plan | push <file_id>`); process.exit(1); }
