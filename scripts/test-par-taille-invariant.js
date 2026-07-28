'use strict';
// Non-regression test: par_taille sums must equal window-function totals.
//
// This test fails loudly if someone reintroduces a SQL LIMIT on
// toolGetSellthroughBySize before the JS aggregation step — the bug that
// caused wrong "total reçu" numbers in the chatbot (Patrick Assaraf, VS).
//
// Run: DATABASE_URL=... node scripts/test-par-taille-invariant.js
//      OR: railway run node scripts/test-par-taille-invariant.js

const { Pool } = require('pg');

const DB_URL = process.env.DATABASE_URL
  || 'postgresql://postgres:REDACTED_CREDENTIAL@zephyr.proxy.rlwy.net:38019/railway';

const pool = new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });

// Mirrors extractSize() in ai-agent.js exactly — update both if regex changes.
function extractSize(desc) {
  if (!desc) return 'N/A';
  let m;
  m = /\b(3XL|XXL|2XL|XL|XS|2X|3X)\b/i.exec(desc); if (m) return m[1].toUpperCase();
  m = /\b([SML])\b/.exec(desc);                       if (m) return m[1].toUpperCase();
  m = /\b(\d{2,3}(?:[.,]\d+)?)\b/.exec(desc);         if (m) return m[1].replace(',', '.');
  return 'N/A';
}

// Run the same core query as toolGetSellthroughBySize — NO LIMIT.
// Optionally cap with simulatedLimit to reproduce the old bug.
async function runQuery(manufacturer, simulatedLimit = null) {
  const today = new Date().toISOString().slice(0, 10);
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  const from = oneYearAgo.toISOString().slice(0, 10);

  const limitClause = simulatedLimit ? `LIMIT ${simulatedLimit}` : '';

  const { rows } = await pool.query(`
    WITH sales_by_item AS (
      SELECT sl2.item_id, SUM(sl2.qty) AS sold
      FROM sale_lines sl2
      WHERE sl2.completed_time BETWEEN $1 AND $2
      GROUP BY sl2.item_id
    ),
    stock_by_item AS (
      SELECT inv.item_id, SUM(inv.qty_on_hand) AS stock
      FROM inventory inv
      JOIN products px ON px.item_id = inv.item_id AND px.archived = false
      GROUP BY inv.item_id
    ),
    base AS (
      SELECT
        p.description,
        COALESCE(s.sold,   0)::int AS sold,
        COALESCE(st.stock, 0)::int AS stock,
        GREATEST(0, COALESCE(s.sold, 0) + COALESCE(st.stock, 0))::int AS received_supplier
      FROM products p
      LEFT JOIN sales_by_item s  ON s.item_id  = p.item_id
      LEFT JOIN stock_by_item st ON st.item_id = p.item_id
      WHERE p.manufacturer ILIKE $3
        AND (COALESCE(s.sold, 0) + COALESCE(st.stock, 0)) > 0
    )
    SELECT *,
      SUM(received_supplier) OVER () AS total_recu_all,
      SUM(stock)             OVER () AS total_stock_all,
      COUNT(*)               OVER () AS nb_variantes_total
    FROM base
    ORDER BY received_supplier DESC
    ${limitClause}
  `, [from, today, `%${manufacturer}%`]);

  return rows;
}

async function testBrand(manufacturer, minVariants) {
  const rows = await runQuery(manufacturer);

  if (rows.length === 0) {
    throw new Error(`[${manufacturer}] No rows returned — brand not found or no activity.`);
  }

  const nb_total      = Number(rows[0].nb_variantes_total);
  const total_recu    = Number(rows[0].total_recu_all);
  const total_stock   = Number(rows[0].total_stock_all);

  if (nb_total < minVariants) {
    throw new Error(
      `[${manufacturer}] Only ${nb_total} variants found — need ≥${minVariants} to be a meaningful regression test.`
    );
  }

  // Compute par_taille from ALL rows (same as toolGetSellthroughBySize)
  const sizeAgg = {};
  for (const r of rows) {
    const t = extractSize(r.description);
    if (!sizeAgg[t]) sizeAgg[t] = { recu: 0, stock: 0 };
    sizeAgg[t].recu  += Number(r.received_supplier);
    sizeAgg[t].stock += Number(r.stock);
  }

  const sumRecu  = Object.values(sizeAgg).reduce((s, v) => s + v.recu,  0);
  const sumStock = Object.values(sizeAgg).reduce((s, v) => s + v.stock, 0);

  let failed = false;

  if (sumRecu !== total_recu) {
    console.error(
      `FAIL [${manufacturer}] recu: sum(par_taille)=${sumRecu} ≠ window total=${total_recu}` +
      ` — a SQL LIMIT before JS aggregation would cause this.`
    );
    failed = true;
  }

  if (sumStock !== total_stock) {
    console.error(
      `FAIL [${manufacturer}] stock: sum(par_taille)=${sumStock} ≠ window total=${total_stock}` +
      ` — a SQL LIMIT before JS aggregation would cause this.`
    );
    failed = true;
  }

  if (!failed) {
    console.log(
      `PASS [${manufacturer}] ${nb_total} variantes — recu=${total_recu} ✅  stock=${total_stock} ✅`
    );
  }

  return !failed;
}

// Verify that introducing a LIMIT would actually break the invariant (sanity check on the test itself).
async function verifyLimitBreaksInvariant(manufacturer, badLimit) {
  const rowsFull    = await runQuery(manufacturer);
  const rowsLimited = await runQuery(manufacturer, badLimit);

  if (rowsFull.length === 0) return; // already caught above

  const totalRecu = Number(rowsFull[0].total_recu_all);

  const sizeAgg = {};
  for (const r of rowsLimited) {
    const t = extractSize(r.description);
    if (!sizeAgg[t]) sizeAgg[t] = { recu: 0 };
    sizeAgg[t].recu += Number(r.received_supplier);
  }
  const sumLimited = Object.values(sizeAgg).reduce((s, v) => s + v.recu, 0);

  if (sumLimited === totalRecu) {
    console.warn(
      `WARN [${manufacturer}] LIMIT ${badLimit} did NOT change the sum (${sumLimited}==${totalRecu}).` +
      ` This brand may have ≤${badLimit} active variants — pick a brand with more variants.`
    );
  } else {
    console.log(
      `INFO [${manufacturer}] Confirmed: LIMIT ${badLimit} produces sum=${sumLimited} vs correct=${totalRecu}` +
      ` — old bug reproduced as expected.`
    );
  }
}

async function main() {
  let anyFailed = false;

  // Patrick Assaraf: 77 variants, alpha sizes (XS–XXL). The original bug brand.
  const pa = await testBrand('Patrick Assaraf', 50);
  if (!pa) anyFailed = true;

  // Eton: 3000+ variants, decimal collar sizes (14.5, 15, 15.5…). Tests numeric regex.
  const eton = await testBrand('Eton', 100);
  if (!eton) anyFailed = true;

  // Brax: 3000+ variants, waist/length sizes. Tests multi-part numeric descriptions.
  const brax = await testBrand('Brax', 100);
  if (!brax) anyFailed = true;

  // Confirm the old bug (LIMIT 50) would break the invariant for Patrick Assaraf
  console.log('');
  await verifyLimitBreaksInvariant('Patrick Assaraf', 50);

  await pool.end();

  if (anyFailed) {
    console.error('\n❌  INVARIANT VIOLATED — par_taille totals do not match window function totals.');
    process.exit(1);
  } else {
    console.log('\n✅  All invariants pass.');
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  pool.end();
  process.exit(1);
});
