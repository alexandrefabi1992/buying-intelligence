#!/usr/bin/env node
'use strict';
// Smoke test for lib/local-upsert.js.
// Fabricates a Lightspeed-shaped Item response, upserts it into the local
// `products` table, verifies the row is present with the right columns,
// then cleans up.
//
// Run: railway run --service Postgres node scripts/smoke-local-upsert.js
// (--service Postgres exposes DATABASE_PUBLIC_URL, which works from a dev
//  machine outside Railway's private network.)

const { Pool } = require('pg');
const { upsertCreatedProduct } = require('../lib/local-upsert');

const TENANT_ID = 'valerie-simon';
// Use a synthetic itemID that will not collide with anything real. Prefixed
// so grep can locate leftover rows if the cleanup step ever fails.
const FAKE_ITEM_ID = 'test-upsert-' + Date.now();

const dbUrl = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('FATAL: no DATABASE_URL (or DATABASE_PUBLIC_URL). Run via `railway run --service Postgres`.');
  process.exit(1);
}
const pool = new Pool({
  connectionString: dbUrl,
  ssl: dbUrl.includes('railway.internal') ? undefined : { rejectUnauthorized: false },
});

async function cleanup() {
  await pool.query(`DELETE FROM products WHERE tenant_id = $1 AND item_id = $2`, [TENANT_ID, FAKE_ITEM_ID]);
}

async function main() {
  const fakeItem = {
    itemID:         FAKE_ITEM_ID,
    itemMatrixID:   '99999999',   // also fake
    description:    'Test upsert item — safe to delete',
    ean:            null,
    upc:            null,
    manufacturerID: '155',        // Oui in prod
    categoryID:     null,
    departmentID:   null,
    defaultCost:    '99.99',
    archived:       'false',
    // No Prices, no Manufacturer, no Category — mirror what POST /Item returns
  };

  console.log(`[1] Insert (item_id=${FAKE_ITEM_ID})…`);
  const r1 = await upsertCreatedProduct(pool, {
    tenantId:          TENANT_ID,
    item:              fakeItem,
    manufacturerName:  'Oui',
    tags:              ['a26'],
    categoryName:      'Test / Category',
  });
  if (!r1.inserted) throw new Error('Expected inserted=true on first upsert');
  console.log(`    ✔ inserted=${r1.inserted}`);

  const { rows } = await pool.query(
    `SELECT item_id, matrix_id, description, manufacturer, tags, default_cost, archived, tenant_id
     FROM products WHERE tenant_id = $1 AND item_id = $2`,
    [TENANT_ID, FAKE_ITEM_ID]
  );
  if (!rows.length) throw new Error('Row not found after insert');
  const row = rows[0];
  const checks = {
    item_id:       row.item_id === FAKE_ITEM_ID,
    matrix_id:     row.matrix_id === '99999999',
    manufacturer:  row.manufacturer === 'Oui',
    tags:          row.tags === 'a26',
    default_cost:  Number(row.default_cost) === 99.99,
    archived:      row.archived === false,
    tenant_id:     row.tenant_id === TENANT_ID,
  };
  console.log(`    row: ${JSON.stringify(row)}`);
  for (const [k, ok] of Object.entries(checks)) {
    if (!ok) throw new Error(`Field check FAILED: ${k}`);
  }
  console.log(`    ✔ all fields match expected`);

  console.log(`\n[2] Re-upsert same item (should UPDATE, not insert)…`);
  const r2 = await upsertCreatedProduct(pool, {
    tenantId: TENANT_ID,
    item: { ...fakeItem, description: 'Updated description' },
    manufacturerName: 'Oui',
    tags: ['a26', 'p27'],
  });
  if (r2.inserted) throw new Error('Expected inserted=false on second upsert');
  console.log(`    ✔ inserted=${r2.inserted} (update path)`);

  const { rows: rows2 } = await pool.query(
    `SELECT description, tags FROM products WHERE tenant_id = $1 AND item_id = $2`,
    [TENANT_ID, FAKE_ITEM_ID]
  );
  if (rows2[0].description !== 'Updated description') throw new Error('description not updated');
  if (rows2[0].tags !== 'a26,p27') throw new Error(`tags not updated (got "${rows2[0].tags}")`);
  console.log(`    ✔ description and tags updated correctly`);

  console.log(`\n[3] Cleanup — delete test row…`);
  await cleanup();
  const { rowCount } = await pool.query(
    `SELECT 1 FROM products WHERE tenant_id = $1 AND item_id = $2`,
    [TENANT_ID, FAKE_ITEM_ID]
  );
  if (rowCount) throw new Error('Cleanup failed — row still present');
  console.log(`    ✔ deleted`);

  console.log(`\n✅ All smoke tests passed.`);
}

main()
  .catch(async e => {
    console.error('FATAL:', e.message);
    if (e.stack) console.error(e.stack);
    await cleanup().catch(() => {});
    process.exit(1);
  })
  .finally(() => pool.end());
