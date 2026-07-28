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

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required.');
  console.error('Run: railway run npm test   OR   DATABASE_URL=... npm test');
  process.exit(1);
}

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
// shop_id and tag_pattern are optional to scope the query.
async function runQuery(manufacturer, simulatedLimit = null, { shopId = null, tagPattern = null, from = null, to = null } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  if (!from) {
    const d = new Date(); d.setFullYear(d.getFullYear() - 1);
    from = d.toISOString().slice(0, 10);
  }
  if (!to) to = today;

  const limitClause = simulatedLimit ? `LIMIT ${simulatedLimit}` : '';
  const shopSaleCond   = shopId ? `AND sl2.shop_id = '${shopId}'` : '';
  const shopStockWhere = shopId ? `WHERE inv.shop_id = '${shopId}'` : '';
  const tagCond        = tagPattern ? `AND p.tags ILIKE '%${tagPattern}%'` : '';

  const { rows } = await pool.query(`
    WITH sales_by_item AS (
      SELECT sl2.item_id, SUM(sl2.qty) AS sold
      FROM sale_lines sl2
      WHERE sl2.completed_time BETWEEN $1 AND $2
        ${shopSaleCond}
      GROUP BY sl2.item_id
    ),
    stock_by_item AS (
      SELECT inv.item_id, SUM(inv.qty_on_hand) AS stock
      FROM inventory inv
      JOIN products px ON px.item_id = inv.item_id AND px.archived = false
      ${shopStockWhere}
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
        ${tagCond}
        AND (COALESCE(s.sold, 0) + COALESCE(st.stock, 0)) > 0
    )
    SELECT *,
      SUM(received_supplier) OVER () AS total_recu_all,
      SUM(stock)             OVER () AS total_stock_all,
      COUNT(*)               OVER () AS nb_variantes_total
    FROM base
    ORDER BY received_supplier DESC
    ${limitClause}
  `, [from, to, `%${manufacturer}%`]);

  return rows;
}

// Test a scoped query (specific boutique + season tag) — reproduces the exact original bug context.
async function testBrandScoped(manufacturer, { shopId, shopName, tagPattern, from, to, badLimit }) {
  const rows = await runQuery(manufacturer, null, { shopId, tagPattern, from, to });
  if (rows.length === 0) {
    throw new Error(`[${manufacturer} ${tagPattern} ${shopName}] No rows — check brand/tag/shop.`);
  }

  const nb_total    = Number(rows[0].nb_variantes_total);
  const total_recu  = Number(rows[0].total_recu_all);
  const total_stock = Number(rows[0].total_stock_all);

  const sizeAgg = {};
  for (const r of rows) {
    const t = extractSize(r.description);
    if (!sizeAgg[t]) sizeAgg[t] = { recu: 0, stock: 0 };
    sizeAgg[t].recu  += Number(r.received_supplier);
    sizeAgg[t].stock += Number(r.stock);
  }
  const sumRecu  = Object.values(sizeAgg).reduce((s, v) => s + v.recu,  0);
  const sumStock = Object.values(sizeAgg).reduce((s, v) => s + v.stock, 0);

  // Also simulate the old bug with the given limit
  const buggedRows = await runQuery(manufacturer, badLimit, { shopId, tagPattern, from, to });
  const bugAgg = {};
  for (const r of buggedRows) {
    const t = extractSize(r.description);
    if (!bugAgg[t]) bugAgg[t] = { recu: 0, stock: 0 };
    bugAgg[t].recu  += Number(r.received_supplier);
    bugAgg[t].stock += Number(r.stock);
  }
  const bugStock = Object.values(bugAgg).reduce((s, v) => s + v.stock, 0);

  const label = `[${manufacturer} ${tagPattern} @ ${shopName}]`;
  let failed = false;

  if (sumRecu !== total_recu || sumStock !== total_stock) {
    console.error(`FAIL ${label} par_taille mismatch: recu=${sumRecu}≠${total_recu} stock=${sumStock}≠${total_stock}`);
    failed = true;
  } else {
    console.log(`PASS ${label} ${nb_total} variantes — recu=${total_recu} ✅  stock=${total_stock} ✅`);
    if (bugStock !== total_stock) {
      console.log(`  → LIMIT ${badLimit} aurait produit stock=${bugStock} au lieu de ${total_stock} (bug original reproduit ✓)`);
    }
  }

  return !failed;
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

// ---------------------------------------------------------------------------
// Tests for toolGetSalesByVariant (LIMIT 100 + reduce bug, fixed 2026-07-27)
// Invariant: window total_qty_all == true sum of ALL descriptions (not just top 100)
// Baseline: Brax — 1261 descriptions, reduce(100 rows)=222 vs correct=1548 (86% wrong)
// ---------------------------------------------------------------------------
async function testSalesByVariant(manufacturer, displayLimit, minDescriptions) {
  const today = new Date().toISOString().slice(0, 10);
  const oneYearAgo = new Date(); oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  const from = oneYearAgo.toISOString().slice(0, 10);

  const { rows } = await pool.query(`
    SELECT SUM(sl.qty) AS qty_vendue,
      SUM(SUM(sl.qty)) OVER () AS total_qty_all,
      COUNT(*)         OVER () AS nb_articles_total
    FROM sale_lines sl
    JOIN products p ON p.item_id = sl.item_id
    WHERE p.manufacturer ILIKE $1
      AND sl.completed_time BETWEEN $2 AND $3
    GROUP BY p.description, p.manufacturer
    ORDER BY qty_vendue DESC
    LIMIT ${displayLimit}
  `, [`%${manufacturer}%`, from, today]);

  if (!rows.length) throw new Error(`[SalesByVariant ${manufacturer}] No rows`);

  const nb_total     = Number(rows[0].nb_articles_total);
  const window_total = Number(rows[0].total_qty_all);
  const reduce_total = rows.reduce((s, r) => s + Number(r.qty_vendue), 0);

  if (nb_total < minDescriptions) {
    throw new Error(`[SalesByVariant ${manufacturer}] Only ${nb_total} descriptions — need ≥${minDescriptions}`);
  }

  const label = `[SalesByVariant ${manufacturer} LIMIT ${displayLimit}]`;
  if (reduce_total === window_total) {
    // Both match → either all rows fit within LIMIT, or there's a regression
    if (nb_total <= displayLimit) {
      console.log(`PASS ${label} ${nb_total} descriptions ≤ LIMIT — window=${window_total} ✅`);
    } else {
      console.error(`FAIL ${label} reduce=${reduce_total} == window=${window_total} but nb_total=${nb_total} > LIMIT`
        + ` — window function may not be applied.`);
      return false;
    }
  } else {
    // reduce undercount confirms the bug would exist without the window fix
    console.log(`PASS ${label} ${nb_total} descriptions — window=${window_total} ✅`
      + `  (reduce on ${displayLimit} rows would give ${reduce_total}, ${Math.round((window_total-reduce_total)/window_total*100)}% wrong)`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Tests for toolGetSalesByCategory (LIMIT 60 + reduce bug, fixed 2026-07-27)
// Invariant: window total_unites_all == true sum across ALL categories (not just top 60)
// Baseline: 150 categories, reduce(60 rows)=29444 vs correct=31490 (6% wrong)
// ---------------------------------------------------------------------------
async function testSalesByCategory(displayLimit, minCategories) {
  const today = new Date().toISOString().slice(0, 10);
  const oneYearAgo = new Date(); oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  const from = oneYearAgo.toISOString().slice(0, 10);

  const { rows } = await pool.query(`
    SELECT SUM(sl.qty)::int AS unites,
      SUM(SUM(sl.qty)) OVER () AS total_unites_all,
      COUNT(*)         OVER () AS nb_categories_total
    FROM sale_lines sl
    JOIN products p ON p.item_id = sl.item_id
    WHERE sl.completed_time BETWEEN $1 AND $2
      AND p.category IS NOT NULL AND p.category != ''
    GROUP BY p.category
    ORDER BY unites DESC
    LIMIT ${displayLimit}
  `, [from, today]);

  if (!rows.length) throw new Error(`[SalesByCategory] No rows`);

  const nb_total     = Number(rows[0].nb_categories_total);
  const window_total = Number(rows[0].total_unites_all);
  const reduce_total = rows.reduce((s, r) => s + Number(r.unites), 0);

  if (nb_total < minCategories) {
    throw new Error(`[SalesByCategory] Only ${nb_total} categories — need ≥${minCategories}`);
  }

  const label = `[SalesByCategory LIMIT ${displayLimit}]`;
  if (reduce_total === window_total && nb_total > displayLimit) {
    console.error(`FAIL ${label} reduce=${reduce_total} == window=${window_total} but ${nb_total} categories > LIMIT`);
    return false;
  }
  console.log(`PASS ${label} ${nb_total} catégories — window=${window_total} ✅`
    + (nb_total > displayLimit ? `  (reduce on ${displayLimit} rows would give ${reduce_total}, ${Math.round((window_total-reduce_total)/window_total*100)}% wrong)` : ''));
  return true;
}

// ---------------------------------------------------------------------------
// Tests for toolGetSalesAnalysis category branch (LIMIT 20 + reduce, fixed 2026-07-27)
// Invariant: window total_unites_all == true sum across ALL brands in the category
// Baseline: Femme/Hauts/Chandail — 46 brands, reduce(20)=2888 vs correct=3196 (10% wrong)
// ---------------------------------------------------------------------------
async function testSalesAnalysisByCategory(category, displayLimit, minBrands) {
  const today = new Date().toISOString().slice(0, 10);
  const oneYearAgo = new Date(); oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  const from = oneYearAgo.toISOString().slice(0, 10);

  const { rows } = await pool.query(`
    SELECT SUM(sl.qty) AS unites,
      SUM(SUM(sl.qty)) OVER () AS total_unites_all,
      COUNT(*)         OVER () AS nb_marques_total
    FROM sale_lines sl
    JOIN products p ON p.item_id = sl.item_id
    JOIN shops sh ON sh.shop_id = sl.shop_id
    WHERE sl.completed_time BETWEEN $1 AND $2
      AND p.category ILIKE $3
      AND p.manufacturer IS NOT NULL
    GROUP BY p.manufacturer
    ORDER BY unites DESC
    LIMIT ${displayLimit}
  `, [from, today, `%${category}%`]);

  if (!rows.length) throw new Error(`[SalesAnalysis cat "${category}"] No rows`);

  const nb_total     = Number(rows[0].nb_marques_total);
  const window_total = Number(rows[0].total_unites_all);
  const reduce_total = rows.reduce((s, r) => s + Number(r.unites), 0);

  if (nb_total < minBrands) {
    throw new Error(`[SalesAnalysis cat "${category}"] Only ${nb_total} brands — need ≥${minBrands}`);
  }

  const label = `[SalesAnalysis cat "${category}" LIMIT ${displayLimit}]`;
  if (reduce_total === window_total && nb_total > displayLimit) {
    console.error(`FAIL ${label} reduce=${reduce_total} == window=${window_total} but ${nb_total} brands > LIMIT`);
    return false;
  }
  console.log(`PASS ${label} ${nb_total} marques — window=${window_total} ✅`
    + (nb_total > displayLimit ? `  (reduce on ${displayLimit} rows would give ${reduce_total}, ${Math.round((window_total-reduce_total)/window_total*100)}% wrong)` : ''));
  return true;
}

async function main() {
  let anyFailed = false;

  // --- Scoped test: exact original bug context (conv 168-169, 2026-07-27) ---
  // Patrick Assaraf p26 @ Valérie Simon — 62 variants, old LIMIT 50 gave stock=27 instead of 34.
  const paScoped = await testBrandScoped('Patrick Assaraf', {
    shopId: '1', shopName: 'Valérie Simon',
    tagPattern: 'p26',
    from: '2025-10-01', to: '2026-07-27',
    badLimit: 50,
  });
  if (!paScoped) anyFailed = true;

  // --- Broad tests: no shop/season filter, verifies invariant at scale ---

  // Patrick Assaraf: alpha sizes (XS–XXL). Original bug brand, all boutiques, 1 year.
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

  // --- toolGetSalesByVariant (LIMIT 100 bug, fixed 2026-07-27) ---
  // Brax: 1261 descriptions, reduce(100)=222 vs window=1548 (86% wrong without fix)
  console.log('');
  const sbv = await testSalesByVariant('Brax', 100, 200);
  if (!sbv) anyFailed = true;

  // --- toolGetSalesByCategory (LIMIT 60 bug, fixed 2026-07-27) ---
  // 150 categories, reduce(60)=29444 vs window=31490 (6% wrong without fix)
  const sbc = await testSalesByCategory(60, 100);
  if (!sbc) anyFailed = true;

  // --- toolGetSalesAnalysis category branch (LIMIT 20 bug, fixed 2026-07-27) ---
  // Femme/Hauts/Chandail: 46 brands, reduce(20)=2888 vs window=3196 (10% wrong without fix)
  const sac = await testSalesAnalysisByCategory('Femme/Hauts/Chandail', 20, 30);
  if (!sac) anyFailed = true;

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
