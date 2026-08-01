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
  toolGetBrandRanking,
  toolGetPricingAnalysis,
} = require('../ai-agent');

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required.');
  console.error('Run: railway run npm test   OR   DATABASE_URL=... npm test');
  process.exit(1);
}

// Default to 'valerie-simon' — the only tenant in this deployment.
// Override with TENANT_ID for multi-tenant testing.
const TENANT = process.env.TENANT_ID || 'valerie-simon';

const pool = new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });

async function buildCtx() {
  const getSeasonsConfig = async () => {
    const { rows } = await pool.query(
      "SELECT value FROM app_settings WHERE key = 'seasons_config' AND tenant_id = $1",
      [TENANT]
    );
    return rows.length && Array.isArray(rows[0].value) ? rows[0].value : [];
  };
  return { pool, getSeasonsConfig, tenantId: TENANT };
}

const sumField = (arr, field) => arr.reduce((s, x) => s + Number(x[field] ?? 0), 0);

// Run an independent SELECT SUM(...) and assert it equals `expected`.
// This verifies the window function total is actually correct, not just that
// it's bigger than the truncated displayed rows.
async function assertIndependentSum(expected, sql, params, label) {
  const { rows } = await pool.query(sql, params);
  const independent = Number(rows[0]?.total ?? 0);
  if (independent !== expected) {
    console.error(
      `FAIL ${label} — window_total=${expected} ≠ independent_SUM=${independent}` +
      ` — window function may compute wrong total`
    );
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// toolGetSellthroughBySize
// Invariants (equality, not inequality — par_taille is built from ALL SQL rows):
//   sum(par_taille[*].recu_fournisseur) == total_recu_fournisseur
//   sum(par_taille[*].stock_actuel)     == total_stock_actuel_en_boutique
//
// The SQL has no LIMIT, so both sides of the check are derived from the same
// full result set. A LIMIT reintroduced on the SQL would cause the window
// totals to remain correct (window functions apply before LIMIT in SQL) while
// par_taille shrinks → equality breaks → FAIL.
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
// Two-part invariant:
//   1. When truncated: sum(articles[*].stock) < total_unites
//      (detects missing window function — without it total equals sum of LIMIT rows)
//   2. total_unites == independent SELECT SUM(qty_on_hand) with same filters
//      (detects a window function that computes the wrong total)
// Options:
//   independentSQL  — SQL with a `total` alias, no LIMIT
//   independentParams — params array (or function taking result → array)
// ---------------------------------------------------------------------------
async function testStockByVariant(label, args, ctx, { independentSQL, independentParams } = {}) {
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

  if (independentSQL) {
    const params = typeof independentParams === 'function' ? independentParams(result) : independentParams;
    const ok = await assertIndependentSum(windowTotal, independentSQL, params, label);
    if (!ok) failed = true;
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
// Two-part invariant:
//   1. When truncated: sum(articles[*].qty_vendue) < total_unites_vendues
//   2. total_unites_vendues == independent SELECT SUM(qty) with same filters
// Baseline: Brax all-time — 5463 descriptions, reduce(100)=420 vs window=7797
// (old 1-year window baseline: 1261 descriptions, reduce(100)=222 vs window=1548)
// ---------------------------------------------------------------------------
async function testSalesByVariant(label, args, ctx, { minDescriptions = 1, independentSQL, independentParams } = {}) {
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

  if (independentSQL) {
    const params = typeof independentParams === 'function' ? independentParams(result) : independentParams;
    const ok = await assertIndependentSum(windowTotal, independentSQL, params, label);
    if (!ok) failed = true;
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
// Two-part invariant:
//   1. When truncated: sum(categories[*].unites) < total.unites
//   2. total.unites == independent SELECT SUM(qty) with same filters
// Baseline: 150 categories, reduce(60)=28370 vs window=31490 (10% wrong)
// ---------------------------------------------------------------------------
async function testSalesByCategory(label, args, ctx, { minCategories = 1, independentSQL, independentParams } = {}) {
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

  if (independentSQL) {
    const params = typeof independentParams === 'function' ? independentParams(result) : independentParams;
    const ok = await assertIndependentSum(windowTotal, independentSQL, params, label);
    if (!ok) failed = true;
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
// Two-part invariant:
//   1. When truncated: sum(marques[*].unites) < total.unites
//   2. total.unites == independent SELECT SUM(qty) with same filters
// Baseline: Femme/Hauts/Chandail — 46 brands, reduce(20)=2880 vs window=3196 (10% wrong)
// ---------------------------------------------------------------------------
async function testSalesAnalysisCategory(label, args, ctx, { minBrands = 1, independentSQL, independentParams } = {}) {
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

  if (independentSQL) {
    const params = typeof independentParams === 'function' ? independentParams(result) : independentParams;
    const ok = await assertIndependentSum(windowTotal, independentSQL, params, label);
    if (!ok) failed = true;
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
// Chatbot behavioral test — calls the production API and asserts conversational behavior.
// Skipped (SKIP, not FAIL) if JWT_SECRET is not set in the environment.
// ---------------------------------------------------------------------------
async function testChatbotClarification(label, question) {
  if (!process.env.JWT_SECRET) {
    console.log(`SKIP ${label} — JWT_SECRET not set`);
    return true;
  }

  const jwt = require('jsonwebtoken');
  const https = require('https');
  const PROD_URL = process.env.PROD_URL || 'https://buying-intelligence-production.up.railway.app';
  const token = jwt.sign(
    { userId: '1', tenantId: TENANT, role: 'superadmin' },
    process.env.JWT_SECRET,
    { expiresIn: '5m' }
  );

  const body = JSON.stringify({ messages: [{ role: 'user', content: question }] });
  const url  = new URL('/api/ai/chat', PROD_URL);

  const responseText = await new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: url.hostname, path: url.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'Content-Length': Buffer.byteLength(body) } },
      res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve(data));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  let parsed;
  try { parsed = JSON.parse(responseText); } catch (e) {
    console.error(`FAIL ${label} — réponse non-JSON: ${responseText.slice(0, 200)}`);
    return false;
  }

  if (parsed.error) {
    console.error(`FAIL ${label} — API error: ${parsed.error}`);
    return false;
  }

  // Extract the assistant text from the last message
  const messages = parsed.messages ?? [];
  const assistantMsg = [...messages].reverse().find(m => m.role === 'assistant');
  const assistantText = typeof assistantMsg?.content === 'string'
    ? assistantMsg.content
    : JSON.stringify(assistantMsg?.content ?? '');

  let failed = false;

  // Must not contain numbers (unit counts or dollar amounts)
  if (/\d+\s*unités?/i.test(assistantText)) {
    console.error(`FAIL ${label} — assertion "\d+ unités" failed — réponse contient des chiffres: "${assistantText.slice(0, 200)}"`);
    failed = true;
  }
  if (/\$\s*[\d\s,.]+/.test(assistantText)) {
    console.error(`FAIL ${label} — assertion "\$\\d+" failed — réponse contient des montants: "${assistantText.slice(0, 200)}"`);
    failed = true;
  }

  // Must contain clarification options (A) and (B)
  if (!assistantText.includes('(A)') || !assistantText.includes('(B)')) {
    console.error(`FAIL ${label} — assertion "(A)/(B)" failed — pas de question de clarification: "${assistantText.slice(0, 300)}"`);
    failed = true;
  }

  // Must not have triggered a tool call (clarification should come before any tool use)
  const hasToolCall = messages.some(m => Array.isArray(m.content) && m.content.some(c => c.type === 'tool_use'));
  if (hasToolCall) {
    console.error(`FAIL ${label} — assertion "pas d'appel outil" failed — le chatbot a appelé un outil avant de clarifier`);
    failed = true;
  }

  if (!failed) {
    console.log(`PASS ${label} ✅`);
  }
  return !failed;
}

// ---------------------------------------------------------------------------

async function main() {
  const ctx = await buildCtx();
  let anyFailed = false;

  // --- toolGetSellthroughBySize ---
  // Invariant: equality (sum par_taille == window totals).
  // No independent SQL needed — par_taille is JS-aggregated from ALL SQL rows
  // (no LIMIT in the query), so the equality already catches any truncation bug.

  const r1 = await testSellthroughBySize(
    '[SellthroughBySize] Patrick Assaraf p26 @ boutique 1',
    { manufacturer: 'Patrick Assaraf', season: 'p26', shop_id: '1' },
    ctx, { minVariants: 30 }
  );
  if (!r1) anyFailed = true;

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
  // Brax: many stock lines across shops, LIMIT 100.
  // Independent SQL mirrors the tool's exact WHERE (archived=false, manufacturer, shops join).
  console.log('');
  const r5 = await testStockByVariant(
    '[StockByVariant] Brax (toutes boutiques)',
    { manufacturer: 'Brax' },
    ctx, {
      independentSQL: `
        SELECT SUM(i.qty_on_hand) AS total
        FROM products p
        JOIN inventory i  ON i.item_id  = p.item_id
        JOIN shops    sh  ON sh.shop_id = i.shop_id
        WHERE p.archived = false
          AND p.manufacturer ILIKE $1
      `,
      independentParams: ['%Brax%'],
    }
  );
  if (!r5) anyFailed = true;

  // --- toolGetSalesByVariant ---
  // Brax, all-time (no date filter) → 5463 descriptions, LIMIT 100.
  // reduce(100) gives 420 vs correct 7797 (95% wrong without window fix).
  // Note: 1-year window baseline at fix time was 222 vs 1548 (86% wrong) —
  // different because all-time has far more variant×date combinations.
  const r6 = await testSalesByVariant(
    '[SalesByVariant] Brax (toutes boutiques, all-time)',
    { manufacturer: 'Brax' },
    ctx, {
      minDescriptions: 200,
      independentSQL: `
        SELECT SUM(sl.qty) AS total
        FROM sale_lines sl
        JOIN products p ON p.item_id = sl.item_id
        WHERE sl.qty != 0
          AND p.manufacturer ILIKE $1
      `,
      independentParams: ['%Brax%'],
    }
  );
  if (!r6) anyFailed = true;

  // --- toolGetSalesByCategory ---
  // All categories over 1 year, LIMIT 60.
  // reduce(60) gives ~28370 vs correct ~31490 (10% wrong without window fix).
  // Independent SQL uses the period dates from result.periode.
  const r7 = await testSalesByCategory(
    '[SalesByCategory] 1 an (toutes boutiques)',
    { period: '1y' },
    ctx, {
      minCategories: 100,
      independentSQL: `
        SELECT SUM(sl.qty) AS total
        FROM sale_lines sl
        JOIN products p ON p.item_id = sl.item_id
        WHERE (sl.completed_time AT TIME ZONE 'America/Toronto')::date >= $1::date
          AND (sl.completed_time AT TIME ZONE 'America/Toronto')::date <= $2::date
          AND p.category IS NOT NULL
          AND p.category != ''
      `,
      independentParams: (result) => [result.periode.de, result.periode.a],
    }
  );
  if (!r7) anyFailed = true;

  // --- toolGetSalesAnalysis — category branch ---
  // Femme/Hauts/Chandail, 1 year, LIMIT 20.
  // reduce(20) gives ~2880 vs correct ~3196 (10% wrong without window fix).
  // Independent SQL mirrors the tool's JOIN shops (INNER) + manufacturer IS NOT NULL.
  const r8 = await testSalesAnalysisCategory(
    '[SalesAnalysis] Femme/Hauts/Chandail (toutes boutiques, 1 an)',
    { category: 'Femme/Hauts/Chandail', period: '1y' },
    ctx, {
      minBrands: 30,
      independentSQL: `
        SELECT SUM(sl.qty) AS total
        FROM sale_lines sl
        JOIN products p  ON p.item_id  = sl.item_id
        JOIN shops    sh ON sh.shop_id = sl.shop_id
        WHERE (sl.completed_time AT TIME ZONE 'America/Toronto')::date >= $1::date
          AND (sl.completed_time AT TIME ZONE 'America/Toronto')::date <= $2::date
          AND p.category ILIKE $3
          AND p.manufacturer IS NOT NULL
      `,
      independentParams: (result) => [result.periode.de, result.periode.a, '%Femme/Hauts/Chandail%'],
    }
  );
  if (!r8) anyFailed = true;

  // --- chatbot conversational behavior ---
  console.log('');
  const r10 = await testChatbotClarification(
    '[Chatbot] "ventes de Marc Cain ce printemps" → clarification, pas de chiffres',
    'ventes de Marc Cain ce printemps'
  );
  if (!r10) anyFailed = true;

  // --- marque_introuvable (typo detection, 2026-07-27) ---
  // "Patrick Assarag" (faute de frappe) doit déclencher marque_introuvable: true
  // avec "Patrick Assaraf" dans les suggestions (pg_trgm similarity > 0.15).
  // Testé sur toolGetSalesByVariant — la logique buildBrandNotFoundResult est
  // partagée par les 4 tools, donc un seul cas suffit.
  console.log('');
  const r9 = await (async () => {
    const label = '[BrandNotFound] "Patrick Assarag" (faute de frappe)';
    const result = await toolGetSalesByVariant({ manufacturer: 'Patrick Assarag' }, ctx);
    let failed = false;

    if (!result.marque_introuvable) {
      console.error(`FAIL ${label} — marque_introuvable devrait être true, got: ${JSON.stringify(result)}`);
      failed = true;
    }
    if (!result.suggestions?.some(s => s.toLowerCase().includes('assaraf'))) {
      console.error(`FAIL ${label} — suggestions devrait inclure "Patrick Assaraf", got: ${JSON.stringify(result.suggestions)}`);
      failed = true;
    }
    if (!failed) {
      console.log(`PASS ${label} — marque_introuvable=true ✅, suggestions=${JSON.stringify(result.suggestions)} ✅`);
    }
    return !failed;
  })();
  if (!r9) anyFailed = true;

  // --- Cross-tool revenue check ---
  // toolGetSalesByVariant.total_ventes_net must match an independent NET revenue SQL
  // for the same brand and period. Catches BRUT vs NET formula divergence (was +13.7%).
  console.log('');
  const rCrossRevenue = await (async () => {
    const label = '[Cross-Revenue] SalesByVariant.total_ventes_net == independent NET SQL — Brax 1y';
    const svResult = await toolGetSalesByVariant({ manufacturer: 'Brax', period: '1y' }, ctx);
    if (svResult.erreur) { console.error(`FAIL ${label} — tool error: ${svResult.erreur}`); return false; }

    const parseM = s => parseFloat(String(s).replace('$', '').replace(/\s/g, '').replace(',', '.'));
    const svRevenue = parseM(svResult.total_ventes_net ?? 0);

    const { rows } = await pool.query(`
      SELECT ROUND(SUM(COALESCE((sl.raw->>'calcSubtotal')::numeric, sl.qty * sl.unit_price)
               - COALESCE(sl.discount, 0)), 2) AS total
      FROM sale_lines sl
      JOIN products p ON p.item_id = sl.item_id
      WHERE p.manufacturer ILIKE $1
        AND sl.qty != 0
        AND (sl.completed_time AT TIME ZONE 'America/Toronto')::date >= $2::date
        AND (sl.completed_time AT TIME ZONE 'America/Toronto')::date <= $3::date
    `, ['%Brax%', svResult.periode.de, svResult.periode.a]);
    const indRevenue = parseFloat(rows[0]?.total ?? 0);

    const delta = Math.abs(svRevenue - indRevenue);
    if (delta > 1) {
      console.error(`FAIL ${label} — SalesByVariant=${svRevenue} ≠ independent=${indRevenue} (Δ=${delta.toFixed(2)})`);
      return false;
    }
    console.log(`PASS ${label} — ${svRevenue.toFixed(2)} ✅`);
    return true;
  })();
  if (!rCrossRevenue) anyFailed = true;

  // --- Cross-tool stock check ---
  // toolGetSellthroughBySize.total_stock_actuel_en_boutique must equal
  // toolGetStockByVariant.total_unites for the same brand.
  // Both exclude shop_id='0' — divergence exposes a phantom-stock regression.
  const rCrossStock = await (async () => {
    const label = '[Cross-Stock] SellthroughBySize.total_stock == StockByVariant.total_unites — Brax';
    const [stResult, svResult] = await Promise.all([
      toolGetSellthroughBySize({ manufacturer: 'Brax' }, ctx),
      toolGetStockByVariant({ manufacturer: 'Brax' }, ctx),
    ]);

    const stStock = stResult.total_stock_actuel_en_boutique;
    const svStock = svResult.total_unites;

    if (stStock !== svStock) {
      console.error(`FAIL ${label} — SellthroughBySize=${stStock} ≠ StockByVariant=${svStock} (phantom regression?)`);
      return false;
    }
    console.log(`PASS ${label} — both=${stStock} ✅`);
    return true;
  })();
  if (!rCrossStock) anyFailed = true;

  // --- PricingAnalysis: Brax 12 months brut/net/revenu_perdu match live SQL baseline ---
  // Baseline queried fresh each run — no hardcoded refs (the 1y rolling window drifts hourly).
  const rPricingBrax = await (async () => {
    const label = '[PricingAnalysis] Brax 1y — brut/net/revenu_perdu match live SQL';
    const result = await toolGetPricingAnalysis({ manufacturer: 'Brax', period: '1y' }, ctx);
    if (result.erreur) { console.error(`FAIL ${label} — tool error: ${result.erreur}`); return false; }
    const brax = result.marques[0];
    if (!brax) { console.error(`FAIL ${label} — Brax not in results`); return false; }
    const from = result.periode.de, to = result.periode.a;
    const { rows: base } = await pool.query(`
      SELECT
        ROUND(SUM(sl.qty * sl.unit_price)::numeric, 2)                             AS brut,
        ROUND(SUM(sl.qty * sl.unit_price - COALESCE(sl.discount, 0))::numeric, 2)  AS net,
        ROUND(SUM(COALESCE(sl.discount, 0))::numeric, 2)                           AS rev_perdu
      FROM sale_lines sl
      JOIN products p ON p.item_id = sl.item_id
      WHERE p.manufacturer ILIKE '%Brax%'
        AND sl.qty != 0
        AND COALESCE((sl.raw->>'discountPercent')::numeric, 0) < 1
        AND (sl.completed_time AT TIME ZONE 'America/Toronto')::date >= $1::date
        AND (sl.completed_time AT TIME ZONE 'America/Toronto')::date <= $2::date
    `, [from, to]);
    const ok = Math.abs(brax.brut - parseFloat(base[0].brut)) < 5 &&
               Math.abs(brax.net  - parseFloat(base[0].net))  < 5 &&
               Math.abs(brax.revenu_perdu - parseFloat(base[0].rev_perdu)) < 5;
    if (!ok) {
      console.error(`FAIL ${label} — tool: brut=${brax.brut} net=${brax.net} rev_perdu=${brax.revenu_perdu}`);
      console.error(`  live SQL: brut=${base[0].brut} net=${base[0].net} rev_perdu=${base[0].rev_perdu}`);
      return false;
    }
    console.log(`PASS ${label} — brut=${brax.brut} net=${brax.net} rev_perdu=${brax.revenu_perdu} ✅`);
    return true;
  })();
  if (!rPricingBrax) anyFailed = true;

  // --- PricingAnalysis: BYLYSE palier 50%+ must be the dominant bracket (spec: 55.3% avg discount) ---
  const rPricingBylyse = await (async () => {
    const label = '[PricingAnalysis] BYLYSE — palier 50%+ dominant (liquidation profile)';
    const result = await toolGetPricingAnalysis({ manufacturer: 'BYLYSE', period: '1y', min_lignes: 1 }, ctx);
    if (result.erreur) { console.error(`FAIL ${label} — tool error: ${result.erreur}`); return false; }
    const bylyse = result.marques[0];
    if (!bylyse) { console.error(`FAIL ${label} — BYLYSE not in results`); return false; }
    const p50 = bylyse.paliers.find(p => p.palier === '50%+');
    const pct50 = p50 ? p50.pct_unites : 0;
    // BYLYSE is in liquidation: ≥ 70% of units should be in 50%+ bracket (known: ~81%)
    if (pct50 < 70) {
      console.error(`FAIL ${label} — palier 50%+ only ${pct50}% of units, expected ≥ 70%`);
      return false;
    }
    // taux_remise_sur_remises should be around 55.3% (±2 points for data drift)
    const taux = bylyse.taux_remise_sur_remises;
    if (Math.abs(taux - 55.3) > 5) {
      console.error(`FAIL ${label} — taux_remise_sur_remises=${taux}%, expected ~55.3%`);
      return false;
    }
    console.log(`PASS ${label} — palier50+=${pct50}%, taux_sur_remises=${taux}% ✅`);
    return true;
  })();
  if (!rPricingBylyse) anyFailed = true;

  // --- PricingAnalysis: min_lignes exclusion (Orientique has 19 lines, must be excluded at default 20) ---
  const rPricingExclusion = await (async () => {
    const label = '[PricingAnalysis] min_lignes exclusion — Orientique (19 lines) excluded at min_lignes=20';
    const result = await toolGetPricingAnalysis({ manufacturer: 'Orientique', min_lignes: 20 }, ctx);
    if (result.erreur) { console.error(`FAIL ${label} — tool error: ${result.erreur}`); return false; }
    const found   = result.marques.some(m => /orientique/i.test(m.manufacturer));
    const counted = result.nb_marques_exclues >= 1;
    if (found) { console.error(`FAIL ${label} — Orientique appeared in results despite < 20 lines`); return false; }
    if (!counted) { console.error(`FAIL ${label} — nb_marques_exclues=${result.nb_marques_exclues}, expected ≥ 1`); return false; }
    console.log(`PASS ${label} — excluded correctly, nb_marques_exclues=${result.nb_marques_exclues} ✅`);
    return true;
  })();
  if (!rPricingExclusion) anyFailed = true;

  // --- DateBoundary: single-day query must include the full day, not just midnight ---
  // Regression for the BETWEEN/<=date truncation bug: before fix, date_to='2026-07-31'
  // was evaluated as '2026-07-31 00:00:00Z', returning 0 rows for any same-day range.
  const rDateBoundary = await (async () => {
    const label = '[DateBoundary] date_to boundary includes full last day (not just midnight)';
    const { rows: direct } = await pool.query(`
      SELECT SUM(sl.qty)::int AS unites
      FROM sale_lines sl
      WHERE sl.shop_id = '8'
        AND (sl.completed_time AT TIME ZONE 'America/Toronto')::date = '2026-07-31'
    `);
    const expected = direct[0].unites ?? 0;
    if (expected === 0) {
      console.log(`SKIP ${label} — no sale_lines on 2026-07-31 for shop 8`);
      return true;
    }
    const result = await toolGetSalesAnalysis({
      date_from: '2026-07-31',
      date_to:   '2026-07-31',
      shop_id:   '8',
      total_only: true,
    }, ctx);
    if (result.erreur) { console.error(`FAIL ${label} — tool error: ${result.erreur}`); return false; }
    const got = result.total?.unites ?? 0;
    if (got !== expected) {
      console.error(`FAIL ${label} — tool=${got} units, direct DB=${expected}`);
      console.error(`  If tool=0 and direct>0: date boundary is still truncating the last day.`);
      return false;
    }
    console.log(`PASS ${label} — 2026-07-31 shop 8: tool=${got} === direct=${expected} ✅`);
    return true;
  })();
  if (!rDateBoundary) anyFailed = true;

  // --- TimezoneBoundary: evening sale (20h-minuit local) on last day must be included ---
  // Regression for AT TIME ZONE fix: a sale at 21h local = UTC 01h next-day was excluded
  // when queries used raw UTC comparisons. Now using AT TIME ZONE 'America/Toronto'.
  const rTzBoundary = await (async () => {
    const label = '[TimezoneBoundary] evening sale (20h-minuit local) included in its local date';
    // Find any sale in UTC 00:00-03:59 (= 20h-23:59 America/Toronto) in the last 12 months
    const { rows: sample } = await pool.query(`
      SELECT
        sl.shop_id,
        (sl.completed_time AT TIME ZONE 'America/Toronto')::date AS local_date,
        SUM(sl.qty)::int AS unites
      FROM sale_lines sl
      WHERE EXTRACT(HOUR FROM sl.completed_time) < 4
        AND sl.completed_time > now() - interval '12 months'
        AND sl.qty > 0
      GROUP BY sl.shop_id, (sl.completed_time AT TIME ZONE 'America/Toronto')::date
      ORDER BY local_date DESC
      LIMIT 1
    `);
    if (!sample.length) {
      console.log(`SKIP ${label} — no evening sales in last 12 months`);
      return true;
    }
    const { shop_id, local_date, unites: expected } = sample[0];
    const dateStr = local_date instanceof Date
      ? local_date.toISOString().slice(0, 10)
      : String(local_date).slice(0, 10);

    // Direct check: AT TIME ZONE query (what our queries now do)
    const { rows: direct } = await pool.query(`
      SELECT SUM(sl.qty)::int AS unites
      FROM sale_lines sl
      WHERE (sl.completed_time AT TIME ZONE 'America/Toronto')::date = $1::date
        AND sl.shop_id = $2
        AND EXTRACT(HOUR FROM sl.completed_time) < 4
        AND sl.qty > 0
    `, [dateStr, shop_id]);
    const directUnits = direct[0].unites ?? 0;

    const result = await toolGetSalesAnalysis({
      date_from:  dateStr,
      date_to:    dateStr,
      shop_id,
      total_only: true,
    }, ctx);
    if (result.erreur) { console.error(`FAIL ${label} — tool error: ${result.erreur}`); return false; }
    const toolUnits = result.total?.unites ?? 0;

    // Tool must return >= directUnits (evening sales included in the day's total)
    if (toolUnits < directUnits) {
      console.error(`FAIL ${label} — tool=${toolUnits} < evening_units=${directUnits} for ${dateStr} shop ${shop_id}`);
      console.error(`  Evening sales (UTC hour<4) are not being counted in their local date.`);
      return false;
    }
    console.log(`PASS ${label} — ${dateStr} shop ${shop_id}: evening_units=${directUnits} included in tool total=${toolUnits} ✅`);
    return true;
  })();
  if (!rTzBoundary) anyFailed = true;

  // --- PeriodConflict: explicit date_from/date_to must win over conflicting period ---
  // Regression 2026-08-01: AI passed period='this_month' + date_from='2026-07-01' + date_to='2026-07-31'.
  // Old code silently used period (today only, 3 units). Now explicit dates win + warning.
  const rPeriodConflict = await (async () => {
    const label = '[PeriodConflict] explicit date_from/date_to override conflicting period';
    // Baseline: what the explicit dates SHOULD return for shop 8 July 2026
    const { rows: expected } = await pool.query(`
      SELECT SUM(sl.qty)::int AS unites
      FROM sale_lines sl
      WHERE (sl.completed_time AT TIME ZONE 'America/Toronto')::date >= '2026-07-01'::date
        AND (sl.completed_time AT TIME ZONE 'America/Toronto')::date <= '2026-07-31'::date
        AND sl.shop_id = '8'
    `);
    const expectedUnits = expected[0].unites ?? 0;
    if (expectedUnits < 100) {
      console.log(`SKIP ${label} — only ${expectedUnits} units for shop 8 July 2026 (test needs a bigger month)`);
      return true;
    }
    // Call tool with BOTH period=this_month AND July dates — same as chatbot bug
    const result = await toolGetSalesAnalysis({
      shop_id: '8',
      period: 'this_month',
      date_from: '2026-07-01',
      date_to:   '2026-07-31',
      total_only: true,
    }, ctx);
    if (result.erreur) { console.error(`FAIL ${label} — tool error: ${result.erreur}`); return false; }
    const gotUnits = result.total?.unites ?? 0;
    if (gotUnits !== expectedUnits) {
      console.error(`FAIL ${label} — tool=${gotUnits} units, expected=${expectedUnits} (period should have been overridden by explicit dates)`);
      return false;
    }
    if (!result.avertissement_periode) {
      console.error(`FAIL ${label} — no avertissement_periode returned despite period/date conflict`);
      return false;
    }
    console.log(`PASS ${label} — dates won (${gotUnits} units), avertissement present ✅`);
    return true;
  })();
  if (!rPeriodConflict) anyFailed = true;

  // --- PeriodLastMonth: period='last_month' must resolve to previous calendar month ---
  // Regression 2026-08-01: AI calculated dates itself (juin instead of juillet).
  // resolvePeriod('last_month') on today's date should give the previous calendar month.
  const rLastMonth = await (async () => {
    const label = '[PeriodLastMonth] period="last_month" resolves to previous calendar month';
    const now = new Date();
    const expectedFrom = `${now.getFullYear()}-${String(now.getMonth() || 12).padStart(2, '0')}-01`;
    const lastDayPrev = new Date(now.getFullYear(), now.getMonth(), 0);
    const expectedTo = `${lastDayPrev.getFullYear()}-${String(lastDayPrev.getMonth() + 1).padStart(2, '0')}-${String(lastDayPrev.getDate()).padStart(2, '0')}`;

    const result = await toolGetSalesAnalysis({ period: 'last_month', total_only: true }, ctx);
    if (result.erreur) { console.error(`FAIL ${label} — tool error: ${result.erreur}`); return false; }
    const got = result.periode;
    if (got.de !== expectedFrom || got.a !== expectedTo) {
      console.error(`FAIL ${label} — got ${got.de} → ${got.a}, expected ${expectedFrom} → ${expectedTo}`);
      return false;
    }
    console.log(`PASS ${label} — ${got.de} → ${got.a} ✅`);
    return true;
  })();
  if (!rLastMonth) anyFailed = true;

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
