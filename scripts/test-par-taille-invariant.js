'use strict';
// Non-regression test: validates invariants on the real tool functions in ai-agent.js.
//
// Calls production code directly so any regression in the SQL or aggregation
// logic is caught — reimplementing the queries here would miss those bugs.
//
// Run: DATABASE_URL=... node scripts/test-par-taille-invariant.js
//      OR: railway run npm test

const { Pool } = require('pg');
const {
  toolGetSellthroughBySize,
  toolGetStockByVariant,
  toolGetSalesByVariant,
  toolGetSalesByCategory,
  toolGetSalesAnalysis,
} = require('../ai-agent');

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required.');
  console.error('Run: railway run npm test   OR   DATABASE_URL=... npm test');
  process.exit(1);
}

const pool = new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });

const TENANT = 'valerie-simon';

async function buildCtx() {
  const getSeasonsConfig = async () => {
    const { rows } = await pool.query(
      "SELECT value FROM app_settings WHERE key = 'seasons_config' AND tenant_id = $1",
      [TENANT]
    );
    return rows.length && Array.isArray(rows[0].value) ? rows[0].value : [];
  };
  return { pool, getSeasonsConfig };
}

const sumField = (arr, field) => arr.reduce((s, x) => s + Number(x[field] ?? 0), 0);

// ---------------------------------------------------------------------------
// toolGetSellthroughBySize
// Invariants: sum(par_taille[*].recu_fournisseur) == total_recu_fournisseur
//             sum(par_taille[*].stock_actuel) == total_stock_actuel_en_boutique
// par_taille is built from ALL SQL rows; totals are window functions — both
// bypass the display LIMIT. If someone reintroduces LIMIT before the JS
// aggregation, one side stays correct and the other shrinks → mismatch.
// ---------------------------------------------------------------------------
async function testSellthroughBySize(label, args, ctx, { minVariants = 1 } = {}) {
  const result = await toolGetSellthroughBySize(args, ctx);

  if (!result.par_taille) throw new Error(`${label} — no par_taille in result`);
  if (result.nb_variantes_total < minVariants) {
    throw new Error(`${label} — only ${result.nb_variantes_total} variants, need ≥${minVariants}`);
  }

  const sumRecu  = sumField(result.par_taille, 'recu_fournisseur');
  const sumStock = sumField(result.par_taille, 'stock_actuel');
  let failed = false;

  if (sumRecu !== result.total_recu_fournisseur) {
    console.error(`FAIL ${label} — recu: sum(par_taille)=${sumRecu} ≠ total=${result.total_recu_fournisseur}`);
    failed = true;
  }
  if (sumStock !== result.total_stock_actuel_en_boutique) {
    console.error(`FAIL ${label} — stock: sum(par_taille)=${sumStock} ≠ total=${result.total_stock_actuel_en_boutique}`);
    failed = true;
  }
  if (!failed) {
    const truncNote = result.nb_variantes_total > result.nb_variantes_affiches
      ? ` (affiches=${result.nb_variantes_affiches}/${result.nb_variantes_total} — LIMIT ne touche pas par_taille ✓)`
      : '';
    console.log(`PASS ${label} — ${result.nb_variantes_total} variantes, recu=${result.total_recu_fournisseur} ✅ stock=${result.total_stock_actuel_en_boutique} ✅${truncNote}`);
  }
  return !failed;
}

// ---------------------------------------------------------------------------
// toolGetStockByVariant
// Invariant: when nb_lignes_total > nb_lignes_affichees (LIMIT 100),
//            sum(articles[*].stock) < total_unites (window function).
// If LIMIT were applied before the window, the window total would be wrong
// and the two sums would match — that's the regression signal.
// ---------------------------------------------------------------------------
async function testStockByVariant(label, args, ctx) {
  const result = await toolGetStockByVariant(args, ctx);

  if (!result.articles) throw new Error(`${label} — no articles in result`);

  const displayedSum = sumField(result.articles, 'stock');
  const windowTotal  = result.total_unites;
  const truncated    = result.nb_lignes_total > result.nb_lignes_affichees;
  let failed = false;

  if (truncated && displayedSum >= windowTotal) {
    console.error(
      `FAIL ${label} — truncated (${result.nb_lignes_affichees}/${result.nb_lignes_total}) ` +
      `but sum(displayed)=${displayedSum} >= window=${windowTotal} — window function missing?`
    );
    failed = true;
  }
  if (!failed) {
    const note = truncated
      ? `  (affiches=${result.nb_lignes_affichees}/${result.nb_lignes_total} — sum(displayed)=${displayedSum} < window=${windowTotal} ✓)`
      : `  (${result.nb_lignes_total} lignes ≤ LIMIT, pas de troncation)`;
    console.log(`PASS ${label}${note} ✅`);
  }
  return !failed;
}

// ---------------------------------------------------------------------------
// toolGetSalesByVariant
// Invariant: when nb_articles_total > nb_articles_affiches (LIMIT 100),
//            sum(articles[*].qty_vendue) < total_unites_vendues.
// Baseline: Brax — ~1261 descriptions, without fix reduce(100) ≈ 86% wrong.
// ---------------------------------------------------------------------------
async function testSalesByVariant(label, args, ctx, { minDescriptions = 1 } = {}) {
  const result = await toolGetSalesByVariant(args, ctx);

  if (!result.articles) throw new Error(`${label} — no articles in result`);
  if (result.nb_articles_total < minDescriptions) {
    throw new Error(`${label} — only ${result.nb_articles_total} descriptions, need ≥${minDescriptions}`);
  }

  const displayedSum = sumField(result.articles, 'qty_vendue');
  const windowTotal  = result.total_unites_vendues;
  const truncated    = result.nb_articles_total > result.nb_articles_affiches;
  let failed = false;

  if (truncated && displayedSum >= windowTotal) {
    console.error(
      `FAIL ${label} — truncated (${result.nb_articles_affiches}/${result.nb_articles_total}) ` +
      `but sum(displayed)=${displayedSum} >= window=${windowTotal} — window function missing?`
    );
    failed = true;
  }
  if (!failed) {
    const pct = truncated ? Math.round((windowTotal - displayedSum) / windowTotal * 100) : 0;
    const note = truncated
      ? `  (reduce=${displayedSum} vs window=${windowTotal}, ${pct}% wrong without fix)`
      : `  (${result.nb_articles_total} descriptions ≤ LIMIT, pas de troncation)`;
    console.log(`PASS ${label} — ${result.nb_articles_total} descriptions, window=${windowTotal} ✅${note}`);
  }
  return !failed;
}

// ---------------------------------------------------------------------------
// toolGetSalesByCategory
// Invariant: when nb_categories_total > nb_categories_affiches (LIMIT 60),
//            sum(categories[*].unites) < total.unites.
// Baseline: 150 categories, without fix reduce(60) ≈ 6% wrong.
// ---------------------------------------------------------------------------
async function testSalesByCategory(label, args, ctx, { minCategories = 1 } = {}) {
  const result = await toolGetSalesByCategory(args, ctx);

  if (result.erreur) throw new Error(`${label} — tool returned error: ${result.erreur}`);
  if (!result.categories) throw new Error(`${label} — no categories in result`);
  if (result.nb_categories_total < minCategories) {
    throw new Error(`${label} — only ${result.nb_categories_total} categories, need ≥${minCategories}`);
  }

  const displayedSum = sumField(result.categories, 'unites');
  const windowTotal  = result.total.unites;
  const truncated    = result.nb_categories_total > result.nb_categories_affiches;
  let failed = false;

  if (truncated && displayedSum >= windowTotal) {
    console.error(
      `FAIL ${label} — truncated (${result.nb_categories_affiches}/${result.nb_categories_total}) ` +
      `but sum(displayed)=${displayedSum} >= window=${windowTotal} — window function missing?`
    );
    failed = true;
  }
  if (!failed) {
    const pct = truncated ? Math.round((windowTotal - displayedSum) / windowTotal * 100) : 0;
    const note = truncated
      ? `  (reduce=${displayedSum} vs window=${windowTotal}, ${pct}% wrong without fix)`
      : `  (${result.nb_categories_total} catégories ≤ LIMIT, pas de troncation)`;
    console.log(`PASS ${label} — ${result.nb_categories_total} catégories, window=${windowTotal} ✅${note}`);
  }
  return !failed;
}

// ---------------------------------------------------------------------------
// toolGetSalesAnalysis — category branch
// Invariant: when nb_marques_total > nb_marques_affiches (LIMIT 20),
//            sum(marques[*].unites) < total.unites.
// Baseline: Femme/Hauts/Chandail — 46 brands, without fix reduce(20) ≈ 10% wrong.
// ---------------------------------------------------------------------------
async function testSalesAnalysisCategory(label, args, ctx, { minBrands = 1 } = {}) {
  const result = await toolGetSalesAnalysis(args, ctx);

  if (result.erreur) throw new Error(`${label} — tool returned error: ${result.erreur}`);
  if (!result.marques) {
    throw new Error(
      `${label} — no marques in result (wrong branch?), keys: ${JSON.stringify(Object.keys(result))}`
    );
  }
  if (result.nb_marques_total < minBrands) {
    throw new Error(`${label} — only ${result.nb_marques_total} brands, need ≥${minBrands}`);
  }

  const displayedSum = sumField(result.marques, 'unites');
  const windowTotal  = result.total.unites;
  const truncated    = result.nb_marques_total > result.nb_marques_affiches;
  let failed = false;

  if (truncated && displayedSum >= windowTotal) {
    console.error(
      `FAIL ${label} — truncated (${result.nb_marques_affiches}/${result.nb_marques_total}) ` +
      `but sum(displayed)=${displayedSum} >= window=${windowTotal} — window function missing?`
    );
    failed = true;
  }
  if (!failed) {
    const pct = truncated ? Math.round((windowTotal - displayedSum) / windowTotal * 100) : 0;
    const note = truncated
      ? `  (reduce=${displayedSum} vs window=${windowTotal}, ${pct}% wrong without fix)`
      : `  (${result.nb_marques_total} marques ≤ LIMIT, pas de troncation)`;
    console.log(`PASS ${label} — ${result.nb_marques_total} marques, window=${windowTotal} ✅${note}`);
  }
  return !failed;
}

// ---------------------------------------------------------------------------

async function main() {
  const ctx = await buildCtx();
  let anyFailed = false;

  // --- toolGetSellthroughBySize ---
  // Scoped: exact original bug context — Patrick Assaraf p26 @ boutique 1
  // (62 variants, old LIMIT 50 gave stock=27 instead of 34)
  const r1 = await testSellthroughBySize(
    '[SellthroughBySize] Patrick Assaraf p26 @ boutique 1',
    { manufacturer: 'Patrick Assaraf', season: 'p26', shop_id: '1' },
    ctx, { minVariants: 30 }
  );
  if (!r1) anyFailed = true;

  // Broad: all boutiques, no season filter
  const r2 = await testSellthroughBySize(
    '[SellthroughBySize] Patrick Assaraf (toutes boutiques)',
    { manufacturer: 'Patrick Assaraf' },
    ctx, { minVariants: 50 }
  );
  if (!r2) anyFailed = true;

  const r3 = await testSellthroughBySize(
    '[SellthroughBySize] Eton (toutes boutiques)',
    { manufacturer: 'Eton' },
    ctx, { minVariants: 100 }
  );
  if (!r3) anyFailed = true;

  const r4 = await testSellthroughBySize(
    '[SellthroughBySize] Brax (toutes boutiques)',
    { manufacturer: 'Brax' },
    ctx, { minVariants: 100 }
  );
  if (!r4) anyFailed = true;

  // --- toolGetStockByVariant ---
  // Brax: many stock lines across shops, LIMIT 100
  console.log('');
  const r5 = await testStockByVariant(
    '[StockByVariant] Brax (toutes boutiques)',
    { manufacturer: 'Brax' },
    ctx
  );
  if (!r5) anyFailed = true;

  // --- toolGetSalesByVariant ---
  // Brax: ~1261 descriptions, LIMIT 100 — without fix, reduce gives ~86% wrong
  const r6 = await testSalesByVariant(
    '[SalesByVariant] Brax (toutes boutiques)',
    { manufacturer: 'Brax' },
    ctx, { minDescriptions: 200 }
  );
  if (!r6) anyFailed = true;

  // --- toolGetSalesByCategory ---
  // All categories over 1 year, LIMIT 60 — without fix, reduce gives ~6% wrong
  const r7 = await testSalesByCategory(
    '[SalesByCategory] 1 an (toutes boutiques)',
    { period: '1y' },
    ctx, { minCategories: 100 }
  );
  if (!r7) anyFailed = true;

  // --- toolGetSalesAnalysis — category branch ---
  // Femme/Hauts/Chandail over 1 year, LIMIT 20 — without fix, reduce gives ~10% wrong
  const r8 = await testSalesAnalysisCategory(
    '[SalesAnalysis] Femme/Hauts/Chandail (toutes boutiques, 1 an)',
    { category: 'Femme/Hauts/Chandail', period: '1y' },
    ctx, { minBrands: 30 }
  );
  if (!r8) anyFailed = true;

  await pool.end();

  if (anyFailed) {
    console.error('\n❌  INVARIANT VIOLATED — totaux incorrects.');
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
