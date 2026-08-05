#!/usr/bin/env node
'use strict';
// Regression test for B9.5 bug (2026-08):
// runImportPush()'s loadLinesForFile() used to ignore the batch.selected
// flag and would silently push deselected/abandoned batches. This test
// asserts three properties that MUST hold going forward:
//
//   1. selected=false batches → their lines stay 'pending' and the stub
//      client receives NO calls related to them.
//   2. status='abandoned' batches → same behavior.
//   3. selected=true + status<>'abandoned' → normal processing.
//
// Uses a stub Lightspeed client (no live writes). Fixtures are inserted
// with a timestamped marker and cleaned up on exit.
//
// Run: railway run --service Postgres node scripts/smoke-queue-selection.js

const { Pool } = require('pg');
const { runImportPush } = require('../lib/queue-processor');

const TENANT_ID = 'valerie-simon';
const MARK = 'TEST-B95-SEL-' + Date.now();

const dbUrl = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!dbUrl) { console.error('DATABASE_URL required. Run via `railway run --service Postgres`.'); process.exit(1); }
const pool = new Pool({
  connectionString: dbUrl,
  ssl: dbUrl.includes('railway.internal') ? undefined : { rejectUnauthorized: false },
});

// ─── Stub client that tracks every call and never throws ──────────────────
function makeStubClient() {
  const stub = {
    createMatrix_calls:      [],   // {description}
    createItemVariant_calls: [],   // {matrixID, size, color}
    tagMatrix_calls:         [],
    tagItem_calls:           [],
    createOrder_calls:       [],   // {refNum}
    createOrderLine_calls:   [],   // {orderID, itemID, quantity}
    _mid: 0, _iid: 0, _oid: 0, _olid: 0,
  };
  stub.listVariantsForMatrix = async () => [];
  stub.createMatrix = async (p) => {
    stub.createMatrix_calls.push({ description: p.description });
    return { itemMatrixID: `M${++stub._mid}`, description: p.description };
  };
  stub.tagMatrix = async (mid, tags) => { stub.tagMatrix_calls.push({ mid, tags }); return { skipped: 'already_present' }; };
  stub.createItemVariant = async (p) => {
    stub.createItemVariant_calls.push({ matrixID: p.itemMatrixID, size: p.ItemAttributes.attribute1, color: p.ItemAttributes.attribute2 });
    return { itemID: `I${++stub._iid}`, itemMatrixID: p.itemMatrixID, description: p.description };
  };
  stub.tagItem = async (iid, tags) => { stub.tagItem_calls.push({ iid, tags }); return { tags }; };
  stub.createOrder = async (p) => {
    stub.createOrder_calls.push({ refNum: p.refNum });
    return { orderID: `O${++stub._oid}`, refNum: p.refNum };
  };
  stub.createOrderLine = async (oid, p) => {
    stub.createOrderLine_calls.push({ orderID: p.orderID, itemID: p.itemID, quantity: p.quantity });
    return { orderLineID: `OL${++stub._olid}`, orderID: p.orderID };
  };
  return stub;
}

// ─── Insert fixture ───────────────────────────────────────────────────────
// One file with THREE batches:
//   A (selected=false)             → 2 lines, MUST NOT be processed
//   B (selected=true, abandoned)   → 2 lines, MUST NOT be processed
//   C (selected=true, ok)          → 2 lines, MUST be processed
async function insertFixture() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`INSERT INTO tenants (id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING`, [TENANT_ID]);
    const { rows: [rec] } = await c.query(`SELECT recipe_id FROM parse_recipes WHERE supplier_key = 'oui-eurostyle' AND version = 1`);
    if (!rec) throw new Error('parse_recipes[oui-eurostyle v1] missing');

    const { rows: [f] } = await c.query(
      `INSERT INTO import_files (tenant_id, supplier_key, recipe_id, source_filename, source_hash, source_bytes,
                                  season_tag, destination_shop_id, target_manufacturer, status)
       VALUES ($1, 'oui-eurostyle', $2, $3, $4, $5, 'a26', '1', 'Oui', 'previewed')
       RETURNING file_id`,
      [TENANT_ID, rec.recipe_id, `${MARK}.pdf`, MARK, Buffer.from(MARK)]);
    const fileId = f.file_id;

    const insBatch = (poNum, selected, status) => c.query(
      `INSERT INTO import_batches
         (file_id, tenant_id, po_number, customer_reference, order_date, delivery_date, cancel_date,
          unit_count_declared, amount_declared, is_consignment, selected, status)
       VALUES ($1, $2, $3, 'Ref', '2026-01-01', '2026-07-01', '2026-08-01', 2, 200, false, $4, $5)
       RETURNING batch_id`,
      [fileId, TENANT_ID, `${MARK}-${poNum}`, selected, status]);

    const { rows: [A] } = await insBatch('A', false, 'previewed');    // deselected
    const { rows: [B] } = await insBatch('B', true,  'abandoned');    // abandoned
    const { rows: [C] } = await insBatch('C', true,  'previewed');    // OK

    const insLine = (batchId, style, size, qty) => c.query(
      `INSERT INTO import_order_lines (batch_id, tenant_id, supplier_style_ref, supplier_color_ref, color_normalized,
                                        size_label, qty, unit_cost, unit_price_retail, status)
       VALUES ($1, $2, $3, 'X', $4, $5, $6, 100, 250, 'pending')`,
      [batchId, TENANT_ID, style, `${style}-color`, size, qty]);

    await insLine(A.batch_id, 'STY_A', '38', 1);
    await insLine(A.batch_id, 'STY_A', '40', 1);
    await insLine(B.batch_id, 'STY_B', '38', 1);
    await insLine(B.batch_id, 'STY_B', '40', 1);
    await insLine(C.batch_id, 'STY_C', '38', 1);
    await insLine(C.batch_id, 'STY_C', '40', 1);

    await c.query('COMMIT');
    return { fileId, batchA: A.batch_id, batchB: B.batch_id, batchC: C.batch_id };
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

async function cleanup() {
  await pool.query(`DELETE FROM import_files WHERE source_hash = $1`, [MARK]);
}

async function main() {
  console.log(`Marker: ${MARK}\n`);
  let fileId;
  try {
    console.log('[Setup] Inserting fixture (3 batches: deselected / abandoned / ok)…');
    const ids = await insertFixture();
    fileId = ids.fileId;
    console.log(`  file_id=${fileId}, batches A=${ids.batchA} B=${ids.batchB} C=${ids.batchC}\n`);

    console.log('[Run] runImportPush with stub client…');
    const stub = makeStubClient();
    const summary = await runImportPush({ pool, client: stub }, {
      tenantId:            TENANT_ID,
      fileId,
      seasonTag:           'a26',
      targetManufacturer:  'Oui',
      manufacturerID:      '155',
      defaultVendorID:     '70',
      destinationShopID:   '1',
      attributeSetID:      '5',
      resolutions:         new Map([
        ['STY_A', { status: 'new', preferred_matrix_id: null, matching_matrices: [] }],
        ['STY_B', { status: 'new', preferred_matrix_id: null, matching_matrices: [] }],
        ['STY_C', { status: 'new', preferred_matrix_id: null, matching_matrices: [] }],
      ]),
    });
    console.log(`  queue summary: ${JSON.stringify(summary)}\n`);

    // ─── ASSERTIONS ──────────────────────────────────────────────────────
    console.log('[Assert]');

    // 1. Only batch C's 2 lines should have been considered
    if (summary.total !== 2) throw new Error(`Expected summary.total=2, got ${summary.total} — deselected/abandoned lines leaked into the queue`);
    console.log(`  ✔ summary.total = 2 (only batch C's lines loaded)`);

    // 2. Both C lines should be 'ordered'
    if (summary.ordered !== 2) throw new Error(`Expected 2 ordered, got ${summary.ordered}`);
    console.log(`  ✔ summary.ordered = 2`);

    // 3. In DB: A & B lines still 'pending', C lines 'ordered'
    const { rows: statusRows } = await pool.query(
      `SELECT b.batch_id, ol.status, COUNT(*)::int AS n
       FROM   import_order_lines ol JOIN import_batches b ON b.batch_id = ol.batch_id
       WHERE  b.file_id = $1 GROUP BY b.batch_id, ol.status ORDER BY b.batch_id, ol.status`, [fileId]);
    const bucket = {};
    for (const r of statusRows) (bucket[r.batch_id] ??= {})[r.status] = r.n;
    if (bucket[ids.batchA]?.pending !== 2) throw new Error(`batch A should have 2 pending, got ${JSON.stringify(bucket[ids.batchA])}`);
    if (bucket[ids.batchB]?.pending !== 2) throw new Error(`batch B should have 2 pending (abandoned batch), got ${JSON.stringify(bucket[ids.batchB])}`);
    if (bucket[ids.batchC]?.ordered !== 2) throw new Error(`batch C should have 2 ordered, got ${JSON.stringify(bucket[ids.batchC])}`);
    console.log(`  ✔ DB state: A={pending:2} B={pending:2} C={ordered:2}`);

    // 4. Stub should have received EXACTLY 1 createOrder (only C's PO)
    if (stub.createOrder_calls.length !== 1) throw new Error(`Expected 1 createOrder call, got ${stub.createOrder_calls.length}: ${JSON.stringify(stub.createOrder_calls)}`);
    if (!stub.createOrder_calls[0].refNum.includes(`${MARK}-C`)) throw new Error(`createOrder called for wrong PO: ${stub.createOrder_calls[0].refNum}`);
    console.log(`  ✔ Exactly 1 createOrder call, for batch C's PO ("${stub.createOrder_calls[0].refNum}")`);

    // 5. No matrices should have been POSTed for STY_A or STY_B
    for (const badStyle of ['STY_A', 'STY_B']) {
      const leaked = stub.createMatrix_calls.filter(c => c.description === badStyle);
      if (leaked.length) throw new Error(`Matrix POSTed for deselected/abandoned style ${badStyle}: ${JSON.stringify(leaked)}`);
      const leakedItems = stub.createItemVariant_calls.filter(c => c.color.startsWith(`${badStyle}-color`));
      if (leakedItems.length) throw new Error(`Item POSTed for deselected/abandoned style ${badStyle}: ${JSON.stringify(leakedItems)}`);
    }
    console.log(`  ✔ Zero POSTs for STY_A (deselected) or STY_B (abandoned)`);

    // 6. Exactly 1 matrix + 2 variants + 2 orderLines for STY_C
    if (stub.createMatrix_calls.length !== 1) throw new Error(`Expected 1 matrix POST, got ${stub.createMatrix_calls.length}`);
    if (stub.createItemVariant_calls.length !== 2) throw new Error(`Expected 2 variant POSTs, got ${stub.createItemVariant_calls.length}`);
    if (stub.createOrderLine_calls.length !== 2) throw new Error(`Expected 2 orderLine POSTs, got ${stub.createOrderLine_calls.length}`);
    console.log(`  ✔ For batch C: 1 matrix + 2 variants + 2 orderLines POSTed`);

    console.log(`\n✅ ALL ASSERTIONS PASSED — deselected + abandoned batches are respected.`);
  } finally {
    console.log(`\n[Cleanup] Deleting fixture…`);
    await cleanup();
    console.log('  done.');
  }
}

main()
  .catch(async e => {
    console.error('FATAL:', e.message);
    if (e.stack) console.error(e.stack);
    await cleanup().catch(() => {});
    process.exit(1);
  })
  .finally(() => pool.end());
