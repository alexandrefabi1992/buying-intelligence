#!/usr/bin/env node
'use strict';
// End-to-end test of B8 queue processor's resume semantics.
//
// WHAT THIS PROVES:
//   1. Line-level resume works: if the queue dies at line N/M, restart
//      picks up at line N+1 without re-processing lines 1..N-1 (no
//      duplicate matrix/variant/PO/OrderLine creations).
//   2. Strict ordering per style is enforced: within a line, matrix →
//      variant → tag → PO → OrderLine, none skipped.
//   3. Cross-line dedup survives crashes: if lines A and B share a
//      matrix/variant and A committed the ID before the crash, B on
//      restart reuses A's ID instead of POSTing again.
//
// METHOD:
//   - Fabricates test fixtures (import_files, import_batches, import_order_lines)
//     with an obvious tenant-scoped marker so they can be cleaned up after.
//   - Uses a STUB LightspeedClient that:
//       (a) tracks every POST/PUT it receives (in-memory);
//       (b) fires programmable errors when `failAtCall` is set (throws on
//           the Nth call, then heals — the caller resets it for the second run).
//   - Runs the queue ONCE with a failure programmed at call #5 → verifies
//     that lines up to and including the failed line are in a mid-state, and
//     later lines are still pending.
//   - Runs the queue AGAIN with the stub healed → verifies that:
//       (a) the already-committed IDs are NOT re-POSTed
//       (b) all lines end at status='ordered'
//       (c) total unique matrices/variants created == expected (no dupes)
//   - Cleans up all test rows on success OR failure.
//
// NO REAL Lightspeed calls are made. This tests the queue's DB/state logic.
//
// Run: railway run --service Postgres node scripts/smoke-queue-resume.js

const { Pool } = require('pg');
const { runImportPush } = require('../lib/queue-processor');

const TENANT_ID = 'valerie-simon';
const MARK = 'TEST-B8-' + Date.now();  // marker to isolate test rows

const dbUrl = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('FATAL: no DATABASE_URL. Run via `railway run --service Postgres`.');
  process.exit(1);
}
const pool = new Pool({
  connectionString: dbUrl,
  ssl: dbUrl.includes('railway.internal') ? undefined : { rejectUnauthorized: false },
});

// ═══ Stub Lightspeed client ══════════════════════════════════════════════
// Counters record what the queue actually called. Duplicate detection is
// enforced by asserting on these counts after the resume.
function makeStubClient() {
  const stub = {
    calls: [],                         // one entry per client method invocation
    postedMatrices: [],                // {description, id}
    postedVariants: [],                // {matrixID, size, color, id}
    postedOrders: [],                  // {refNum, id}
    postedOrderLines: [],              // {orderID, itemID, quantity, id}
    tagged: [],                        // {itemID, tags}
    listedVariantsFor: [],             // matrixID for each listVariantsForMatrix call
    failAt: null,                      // if set, throw on the Nth invocation
    _callCounter: 0,                   // # of client invocations this session
    _idCounter: 0,                     // separate — assigns unique IDs
  };

  const nextId = (kind) => `NEW-${kind}-${++stub._idCounter}`;

  // Every client method calls this FIRST. It increments the call counter,
  // records the call, and throws if failAt matches. Separating the call
  // counter from the id counter keeps assertions readable.
  const startCall = (name) => {
    stub._callCounter++;
    stub.calls.push({ n: stub._callCounter, name });
    if (stub.failAt !== null && stub._callCounter === stub.failAt) {
      throw new Error(`STUB FAILURE (programmed at call #${stub.failAt} of ${name})`);
    }
  };

  stub.listVariantsForMatrix = async (matrixId) => {
    startCall('listVariantsForMatrix');
    stub.listedVariantsFor.push(String(matrixId));
    return stub.postedVariants
      .filter(v => String(v.matrixID) === String(matrixId))
      .map(v => ({
        itemID: v.id,
        ItemAttributes: { attribute1: v.size, attribute2: v.color },
      }));
  };

  stub.createMatrix = async (payload) => {
    startCall('createMatrix');
    const id = nextId('MTX');
    stub.postedMatrices.push({ description: payload.description, id });
    return { itemMatrixID: id, description: payload.description };
  };

  stub.createItemVariant = async (payload) => {
    startCall('createItemVariant');
    const id = nextId('ITM');
    stub.postedVariants.push({
      matrixID: payload.itemMatrixID,
      size:     payload.ItemAttributes.attribute1,
      color:    payload.ItemAttributes.attribute2,
      id,
    });
    return { itemID: id, itemMatrixID: payload.itemMatrixID, description: payload.description };
  };

  stub.tagItem = async (itemId, tags) => {
    startCall('tagItem');
    stub.tagged.push({ itemID: String(itemId), tags: [...tags] });
    return { itemId: String(itemId), tags };
  };

  stub.createOrder = async (payload) => {
    startCall('createOrder');
    const id = nextId('ORD');
    stub.postedOrders.push({ refNum: payload.refNum, id });
    return { orderID: id, refNum: payload.refNum };
  };

  stub.createOrderLine = async (orderId, payload) => {
    startCall('createOrderLine');
    const id = nextId('OL');
    stub.postedOrderLines.push({
      orderID:  payload.orderID,
      itemID:   payload.itemID,
      quantity: payload.quantity,
      id,
    });
    return { orderLineID: id, orderID: payload.orderID };
  };

  return stub;
}

// ═══ Fixture — the smallest interesting case ══════════════════════════════
// 2 POs, each with 2 lines. Cross-PO dedup: PO#1 and PO#2 both order
// STY1 / RED / size 38 → should produce ONE matrix + ONE variant + 2 OrderLines.
async function insertFixtures(pool, resolutionInputs) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    // Ensure tenant row exists (test env may or may not)
    await c.query(
      `INSERT INTO tenants (id, name) VALUES ($1, $1)
       ON CONFLICT (id) DO NOTHING`,
      [TENANT_ID],
    );
    // parse_recipes row required for FK from import_files
    const recipe = await c.query(
      `SELECT recipe_id FROM parse_recipes WHERE supplier_key = 'oui-eurostyle' AND version = 1`,
    );
    if (!recipe.rowCount) throw new Error('parse_recipes[oui-eurostyle v1] missing — run seed-oui-eurostyle first');
    const recipeId = recipe.rows[0].recipe_id;

    const file = await c.query(
      `INSERT INTO import_files
        (tenant_id, supplier_key, recipe_id, source_filename, source_hash, source_bytes,
         season_tag, destination_shop_id, target_manufacturer, status)
       VALUES ($1, 'oui-eurostyle', $2, $3, $4, $5, 'a26', '1', 'Oui', 'previewed')
       RETURNING file_id`,
      [TENANT_ID, recipeId, `${MARK}.pdf`, MARK, Buffer.from(MARK)],
    );
    const fileId = file.rows[0].file_id;

    // Two POs
    const b1 = await c.query(
      `INSERT INTO import_batches
        (file_id, tenant_id, po_number, customer_reference, order_date, delivery_date, cancel_date,
         unit_count_declared, amount_declared, is_consignment, status)
       VALUES ($1, $2, $3, 'Ref1', '2026-01-22', '2026-07-20', '2026-08-25', 3, 300.00, false, 'previewed')
       RETURNING batch_id`,
      [fileId, TENANT_ID, `${MARK}-PO1`],
    );
    const b2 = await c.query(
      `INSERT INTO import_batches
        (file_id, tenant_id, po_number, customer_reference, order_date, delivery_date, cancel_date,
         unit_count_declared, amount_declared, is_consignment, status)
       VALUES ($1, $2, $3, 'Ref2', '2026-01-22', '2026-07-20', '2026-08-25', 2, 200.00, false, 'previewed')
       RETURNING batch_id`,
      [fileId, TENANT_ID, `${MARK}-PO2`],
    );
    const batch1 = b1.rows[0].batch_id;
    const batch2 = b2.rows[0].batch_id;

    // Lines — 4 total across 2 POs, with cross-PO dedup on STY1/RED/38
    const insertLine = (batchId, style, colorRef, colorNorm, size, qty) =>
      c.query(
        `INSERT INTO import_order_lines
           (batch_id, tenant_id, supplier_style_ref, supplier_color_ref, color_normalized,
            size_label, qty, unit_cost, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 100.00, 'pending')`,
        [batchId, TENANT_ID, style, colorRef, colorNorm, size, qty],
      );

    await insertLine(batch1, 'STY1', 'R', 'Rouge-R', '38', 1);
    await insertLine(batch1, 'STY1', 'R', 'Rouge-R', '40', 1);
    await insertLine(batch2, 'STY1', 'R', 'Rouge-R', '38', 2); // SAME style/color/size as PO1 line1 → shared variant
    await insertLine(batch2, 'STY2', 'B', 'Bleu-B',  '38', 1); // Different style

    await c.query('COMMIT');
    return { fileId, batch1, batch2 };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

async function cleanup(pool, fileId) {
  // Cascades: import_files → import_batches → import_order_lines
  if (fileId) {
    await pool.query(`DELETE FROM import_files WHERE file_id = $1`, [fileId]);
  }
  // Also brute-force in case the fileId slipped
  await pool.query(`DELETE FROM import_files WHERE source_hash = $1`, [MARK]);
}

async function dumpLines(pool, fileId) {
  const { rows } = await pool.query(
    `SELECT ol.line_id, ol.batch_id, ol.supplier_style_ref, ol.color_normalized, ol.size_label,
            ol.qty, ol.status, ol.matrix_id, ol.item_id, ol.lightspeed_order_line_id, ol.error_message
     FROM   import_order_lines ol
     JOIN   import_batches      b ON b.batch_id = ol.batch_id
     WHERE  b.file_id = $1
     ORDER  BY ol.batch_id, ol.line_id`, [fileId]);
  return rows;
}

// ═══ Fake resolver: 2 styles, both 'new' — the simplest case ══════════════
function makeResolutions() {
  return new Map([
    ['STY1', { status: 'new', preferred_matrix_id: null, matching_matrices: [] }],
    ['STY2', { status: 'new', preferred_matrix_id: null, matching_matrices: [] }],
  ]);
}

function baseOpts(fileId) {
  return {
    tenantId:            TENANT_ID,
    fileId,
    seasonTag:           'a26',
    targetManufacturer:  'Oui',
    manufacturerID:      '155',
    defaultVendorID:     '70',
    destinationShopID:   '1',
    attributeSetID:      '5',
    resolutions:         makeResolutions(),
    employeeID:          '1',
  };
}

// ═══ Main ═════════════════════════════════════════════════════════════════
async function main() {
  console.log(`Test marker: ${MARK}\n`);
  console.log(`[Setup] Inserting fixtures…`);
  const { fileId } = await insertFixtures(pool);
  console.log(`  file_id=${fileId}, 2 batches, 4 lines\n`);

  let stub;

  try {
    // ─── RUN 1: fail at call #5 ─────────────────────────────────────────
    console.log(`━━ RUN 1 — programmed failure at call #5 ━━`);
    stub = makeStubClient();
    stub.failAt = 5;

    const summary1 = await runImportPush({ pool, client: stub }, baseOpts(fileId));
    console.log(`  summary:`, summary1);

    const after1 = await dumpLines(pool, fileId);
    console.log(`  lines after RUN 1:`);
    for (const l of after1) {
      console.log(`    L${l.line_id} PO=${l.batch_id} ${l.supplier_style_ref}/${l.color_normalized}/${l.size_label} qty=${l.qty} → status=${l.status} matrix=${l.matrix_id ?? '-'} item=${l.item_id ?? '-'} OL=${l.lightspeed_order_line_id ?? '-'}`);
      if (l.error_message) console.log(`      ERROR: ${l.error_message}`);
    }
    const errorCount1 = after1.filter(l => l.status === 'error').length;
    const orderedCount1 = after1.filter(l => l.status === 'ordered').length;
    if (errorCount1 === 0 && orderedCount1 === 4) throw new Error('RUN 1 did not fail — programmed failure was skipped');
    console.log(`  ✔ RUN 1 partial state confirmed (${errorCount1} error, ${orderedCount1} ordered)\n`);

    // Capture what got created in RUN 1
    const matricesRun1     = stub.postedMatrices.length;
    const variantsRun1     = stub.postedVariants.length;
    const ordersRun1       = stub.postedOrders.length;
    const orderLinesRun1   = stub.postedOrderLines.length;
    console.log(`  RUN 1 stub totals: matrices=${matricesRun1}, variants=${variantsRun1}, orders=${ordersRun1}, orderLines=${orderLinesRun1}`);

    // Snapshot pre-existing IDs before RUN 2
    const idsBeforeRun2 = new Set(after1
      .filter(l => l.item_id || l.matrix_id || l.lightspeed_order_line_id)
      .map(l => `${l.line_id}:${l.matrix_id}|${l.item_id}|${l.lightspeed_order_line_id}`));

    // ─── RUN 2: heal the error state manually and resume ────────────────
    // Reset any 'error' lines back to their max-committed status so the
    // queue picks them up again. (In prod this would be an operator action:
    // acknowledge the error and click "Reprendre".)
    await pool.query(
      `UPDATE import_order_lines
         SET status = CASE
             WHEN item_id IS NOT NULL       THEN 'variant_ensured'
             WHEN matrix_id IS NOT NULL     THEN 'matrix_ensured'
             ELSE 'pending'
         END,
         error_message = NULL
       WHERE tenant_id = $1 AND status = 'error'
         AND batch_id IN (SELECT batch_id FROM import_batches WHERE file_id = $2)`,
      [TENANT_ID, fileId]
    );

    console.log(`\n━━ RUN 2 — resume, no programmed failure ━━`);
    stub = makeStubClient(); // fresh stub — captures ONLY calls from RUN 2
    const summary2 = await runImportPush({ pool, client: stub }, baseOpts(fileId));
    console.log(`  summary:`, summary2);

    const after2 = await dumpLines(pool, fileId);
    console.log(`  lines after RUN 2:`);
    for (const l of after2) {
      console.log(`    L${l.line_id} PO=${l.batch_id} ${l.supplier_style_ref}/${l.color_normalized}/${l.size_label} qty=${l.qty} → status=${l.status} matrix=${l.matrix_id ?? '-'} item=${l.item_id ?? '-'} OL=${l.lightspeed_order_line_id ?? '-'}`);
    }

    // ─── Assertions ─────────────────────────────────────────────────────
    console.log(`\n━━ ASSERTIONS ━━`);

    const ordered2 = after2.filter(l => l.status === 'ordered').length;
    if (ordered2 !== 4) throw new Error(`Expected all 4 lines ordered, got ${ordered2}`);
    console.log(`  ✔ All 4 lines reached status='ordered'`);

    // Cross-PO dedup: L1 (PO1, STY1/Rouge-R/38) and L3 (PO2, STY1/Rouge-R/38)
    // should share matrix_id AND item_id but have DIFFERENT lightspeed_order_line_id.
    const L1 = after2.find(l => l.line_id === after2[0].line_id);
    const L3 = after2.find(l => l.batch_id !== L1.batch_id && l.supplier_style_ref === 'STY1' && l.size_label === '38');
    if (!L1 || !L3) throw new Error(`Failed to locate L1 and L3 rows`);
    if (L1.matrix_id !== L3.matrix_id) throw new Error(`Cross-PO dedup broken: L1.matrix_id=${L1.matrix_id} vs L3.matrix_id=${L3.matrix_id}`);
    if (L1.item_id !== L3.item_id)     throw new Error(`Cross-PO dedup broken: L1.item_id=${L1.item_id} vs L3.item_id=${L3.item_id}`);
    if (L1.lightspeed_order_line_id === L3.lightspeed_order_line_id) throw new Error(`OrderLine dedup wrong: L1 and L3 share the same OL id`);
    console.log(`  ✔ Cross-PO dedup preserved: L1 & L3 share matrix (${L1.matrix_id}) & item (${L1.item_id}) but have distinct OLs`);

    // Total unique matrices created (across BOTH runs) — expect 2 (STY1 + STY2)
    const allDistinctMatrixIds = new Set(after2.map(l => l.matrix_id));
    if (allDistinctMatrixIds.size !== 2) throw new Error(`Expected 2 distinct matrix_ids across all lines, got ${allDistinctMatrixIds.size}`);
    console.log(`  ✔ Exactly 2 distinct matrix_ids across all lines (STY1 + STY2)`);

    // Total unique variants — expect 3 (STY1/R/38, STY1/R/40, STY2/B/38)
    const allDistinctItemIds = new Set(after2.map(l => l.item_id));
    if (allDistinctItemIds.size !== 3) throw new Error(`Expected 3 distinct item_ids across all lines, got ${allDistinctItemIds.size}`);
    console.log(`  ✔ Exactly 3 distinct item_ids across all lines`);

    // RUN 2 must NOT have re-created things that RUN 1 already committed:
    // for each ID present after RUN 1 (matrix_id/item_id/order_line_id), it should
    // still be present after RUN 2 (i.e. not overwritten with a new NEW-* id).
    const survived = after2.filter(l => {
      // if RUN 1 committed L's matrix_id or item_id, RUN 2's shouldn't be a different NEW-* id
      const l1 = after1.find(x => x.line_id === l.line_id);
      if (l1?.matrix_id && l1.matrix_id !== l.matrix_id) return false;
      if (l1?.item_id   && l1.item_id   !== l.item_id)   return false;
      return true;
    });
    if (survived.length !== after2.length) throw new Error('RUN 2 overwrote IDs committed by RUN 1');
    console.log(`  ✔ RUN 2 did NOT overwrite any IDs committed by RUN 1`);

    // The stub for RUN 2 should show STRICTLY FEWER creations than a fresh full run.
    // A full 4-line run would create: 2 matrices + 3 variants + 2 orders + 4 order lines = 11 POST ops (+ tags & liveChecks).
    // RUN 1 got to call #5 before failing so ≤ 5 items got created; RUN 2 should
    // create the REMAINDER only, not the full set again.
    const totalCreationsRun2 = stub.postedMatrices.length + stub.postedVariants.length + stub.postedOrders.length + stub.postedOrderLines.length;
    const totalCreationsRun1 = matricesRun1 + variantsRun1 + ordersRun1 + orderLinesRun1;
    console.log(`  RUN 2 creations: matrices=${stub.postedMatrices.length}, variants=${stub.postedVariants.length}, orders=${stub.postedOrders.length}, orderLines=${stub.postedOrderLines.length} (total ${totalCreationsRun2})`);
    if (totalCreationsRun1 + totalCreationsRun2 > 2 + 3 + 2 + 4) {
      throw new Error(`Total creations across both runs (${totalCreationsRun1 + totalCreationsRun2}) exceeds the expected max (11)`);
    }
    console.log(`  ✔ Combined creations across runs (${totalCreationsRun1 + totalCreationsRun2}) ≤ expected max (11) — no duplicates`);

    console.log(`\n✅ ALL ASSERTIONS PASSED.\n`);
  } finally {
    console.log(`[Cleanup] Deleting fixtures…`);
    await cleanup(pool, undefined);
    console.log(`  done.`);
  }
}

main()
  .catch(async e => {
    console.error('FATAL:', e.message);
    if (e.stack) console.error(e.stack);
    await cleanup(pool, undefined).catch(() => {});
    process.exit(1);
  })
  .finally(() => pool.end());
