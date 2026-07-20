'use strict';
// ---------------------------------------------------------------------------
// AI Agent — tool executor + agentic loop
//
// Tools make direct SQL queries so they work regardless of cache state.
// The agentic loop is provider-agnostic: it calls createProvider().complete()
// and handles tool_calls until the model returns a final text response.
// ---------------------------------------------------------------------------

const { createProvider, SYSTEM_PROMPT, buildSystemPrompt } = require('./ai-provider');

const MAX_TOOL_ROUNDS = 6; // safety limit against infinite loops

// ---------------------------------------------------------------------------
// Helper: format currency for AI responses
// ---------------------------------------------------------------------------
function fmtMoney(v) {
  if (v == null) return 'N/A';
  return '$' + Number(v).toLocaleString('fr-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtPct(v) {
  if (v == null) return 'N/A';
  return (Number(v) * 100).toFixed(1) + '%';
}

// ---------------------------------------------------------------------------
// Helper: resolve shop name → numeric shop_id.
// Accepts a numeric ID (returned as-is) or a partial name (ILIKE lookup).
// ---------------------------------------------------------------------------
async function resolveShopId(shop_id, pool) {
  if (!shop_id) return null;
  if (/^\d+$/.test(String(shop_id))) {
    // Verify the numeric ID actually exists
    const { rows } = await pool.query("SELECT shop_id FROM shops WHERE shop_id = $1", [shop_id]);
    if (rows.length) return shop_id;
    return null;
  }
  const { rows } = await pool.query(
    "SELECT shop_id FROM shops WHERE name ILIKE $1 LIMIT 1",
    [`%${shop_id}%`]
  );
  return rows[0]?.shop_id ?? null;
}

// ---------------------------------------------------------------------------
// Helper: build AND conditions for tag inclusion + exclusion arrays.
// Normalizes string → [string] so the model can pass either form.
// ---------------------------------------------------------------------------
function normalizeTags(v) {
  if (!v) return [];
  return (Array.isArray(v) ? v : [v]).filter(Boolean).slice(0, 10);
}
function buildTagConditions(tags, excludeTags, params) {
  const conds = [];
  for (const t of normalizeTags(tags)) {
    conds.push(`p.tags ILIKE $${params.length + 1}`);
    params.push(`%${t}%`);
  }
  for (const t of normalizeTags(excludeTags)) {
    conds.push(`(p.tags NOT ILIKE $${params.length + 1} OR p.tags IS NULL)`);
    params.push(`%${t}%`);
  }
  return conds;
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function toolGetBudgetRecommendations({ season, shops, limit = 20 }, { pool, budgetCache, getSeasonsConfig }) {
  season = (season ?? 'p26').toLowerCase();
  const rawShops = shops ? shops.split(',').map(s => s.trim()).filter(Boolean) : null;
  const shopIds  = rawShops ? (await Promise.all(rawShops.map(s => resolveShopId(s, pool)))).filter(Boolean) : null;
  const cacheKey = `marque:${season}:${shopIds?.join(',') ?? 'all'}`;

  // Try the in-memory cache first (already computed, fast)
  const cached = budgetCache?.get(cacheKey);
  if (cached && Date.now() < cached.expires) {
    const brands = (cached.data.by_manufacturer ?? []).slice(0, limit).map(m => ({
      marque:            m.manufacturer,
      budget_net:        fmtMoney(m.net_budget),
      sell_through_moyen: fmtPct(m.avg_st),
      tendance:          m.trend ?? 'stable',
      multiplicateur:    m.multiplier ?? 1,
    }));
    return { saison: season, source: 'cache', marques: brands };
  }

  // Fallback: simplified query — last 2 seasons of sold cost as proxy
  const seasons = await getSeasonsConfig();
  const target  = seasons.find(s => s.code === season);
  if (!target) return { erreur: `Saison "${season}" non trouvée dans la configuration.` };

  const shopFilter = shopIds?.length ? 'AND sl.shop_id = ANY($3)' : '';
  const params = shopIds?.length
    ? [target.sell_from, target.sell_to, shopIds]
    : [target.sell_from, target.sell_to];

  const { rows } = await pool.query(`
    SELECT
      p.manufacturer                    AS marque,
      SUM(sl.qty)                        AS unites_vendues,
      SUM(sl.qty * p.default_cost)::numeric(12,2) AS cout_ventes,
      COUNT(DISTINCT p.item_id)          AS references_distinctes
    FROM sale_lines sl
    JOIN products p ON p.item_id = sl.item_id
    WHERE sl.completed_time BETWEEN $1 AND $2
      AND p.manufacturer IS NOT NULL AND p.manufacturer != ''
      ${shopFilter}
    GROUP BY p.manufacturer
    ORDER BY cout_ventes DESC NULLS LAST
    LIMIT ${ shopIds?.length ? '$4' : '$3' }
  `, [...params, limit]);

  return {
    saison: season,
    source: 'données brutes (budget complet disponible dans l\'onglet Budget)',
    note:   'Ventes pendant la fenêtre de vente de la saison — pas le budget calculé complet',
    marques: rows.map(r => ({
      marque:                r.marque,
      cout_ventes:           fmtMoney(r.cout_ventes),
      unites_vendues:        r.unites_vendues,
      references_distinctes: r.references_distinctes,
    })),
  };
}

function resolvePeriod(period) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const p = (period ?? '').toLowerCase().trim();
  const yMatch = p.match(/^(\d+)\s*y(?:ear)?s?$/);
  const mMatch = p.match(/^(\d+)\s*m(?:onth)?s?$/);
  const wMatch = p.match(/^(\d+)\s*w(?:eek)?s?$/);
  const dMatch = p.match(/^(\d+)\s*d(?:ay)?s?$/);
  if (yMatch) { const d = new Date(now); d.setFullYear(d.getFullYear() - +yMatch[1]); return [d.toISOString().slice(0,10), today]; }
  if (mMatch) { const d = new Date(now); d.setMonth(d.getMonth() - +mMatch[1]);       return [d.toISOString().slice(0,10), today]; }
  if (wMatch) { const d = new Date(now); d.setDate(d.getDate() - +wMatch[1] * 7);     return [d.toISOString().slice(0,10), today]; }
  if (dMatch) { const d = new Date(now); d.setDate(d.getDate() - +dMatch[1]);          return [d.toISOString().slice(0,10), today]; }
  if (p === 'ytd')       return [`${now.getFullYear()}-01-01`, today];
  if (p === 'last_year') return [`${now.getFullYear()-1}-01-01`, `${now.getFullYear()-1}-12-31`];
  return null;
}

async function toolGetSalesAnalysis({ season, manufacturer, shop_id, date_from, date_to, period, total_only = false }, { pool, getSeasonsConfig }) {
  shop_id = await resolveShopId(shop_id, pool);
  let from = date_from, to = date_to;

  // period shorthand takes priority over raw dates
  if (period) {
    const resolved = resolvePeriod(period);
    if (resolved) [from, to] = resolved;
  }

  if (season && !from) {
    const seasons = await getSeasonsConfig();
    const s = seasons.find(x => x.code === season.toLowerCase());
    if (!s) return { erreur: `Saison "${season}" non trouvée.` };
    from = s.sell_from;
    to   = s.sell_to;
  }
  if (!from) return { erreur: 'Fournir "period" (ex: "4y", "10w", "6m", "ytd") ou "season" ou "date_from".' };

  const conditions = ['sl.completed_time BETWEEN $1 AND $2'];
  const params     = [from, to ?? new Date().toISOString()];

  if (manufacturer) { conditions.push(`p.manufacturer ILIKE $${params.length + 1}`); params.push(`%${manufacturer}%`); }
  if (shop_id)      { conditions.push(`sl.shop_id = $${params.length + 1}`);          params.push(shop_id); }

  // total_only = true → grand total par boutique, LEFT JOIN pour capturer 100% des ventes
  // (INNER JOIN exclurait les articles supprimés/non-synced → sous-comptage)
  if (total_only || (!manufacturer && !shop_id)) {
    const { rows } = await pool.query(`
      SELECT
        sh.name                              AS boutique,
        SUM(sl.qty)                          AS unites,
        ROUND(SUM(COALESCE((sl.raw->>'calcSubtotal')::numeric, sl.qty * sl.unit_price)), 2)::numeric(14,2) AS ventes_brutes,
        ROUND(SUM(sl.qty * COALESCE(p.default_cost, 0)), 2)::numeric(14,2) AS cout_ventes
      FROM sale_lines sl
      LEFT JOIN products p ON p.item_id  = sl.item_id
      JOIN shops    sh ON sh.shop_id = sl.shop_id
      WHERE ${conditions.join(' AND ')}
      GROUP BY sh.name
      ORDER BY ventes_brutes DESC NULLS LAST
    `, params);

    const totVentes = rows.reduce((s, r) => s + parseFloat(r.ventes_brutes ?? 0), 0);
    const totCout   = rows.reduce((s, r) => s + parseFloat(r.cout_ventes   ?? 0), 0);
    const totUnites = rows.reduce((s, r) => s + parseInt(r.unites          ?? 0), 0);

    return {
      periode:  { de: from, a: to },
      par_boutique: rows.map(r => ({
        boutique:      r.boutique,
        unites:        Number(r.unites),
        ventes_brutes: fmtMoney(r.ventes_brutes),
        cout_ventes:   fmtMoney(r.cout_ventes),
      })),
      total: {
        unites:        totUnites,
        ventes_brutes: fmtMoney(totVentes),
        cout_ventes:   fmtMoney(totCout),
      },
    };
  }

  const { rows } = await pool.query(`
    SELECT
      p.manufacturer,
      sh.name                              AS boutique,
      SUM(sl.qty)                          AS unites,
      ROUND(SUM(COALESCE((sl.raw->>'calcSubtotal')::numeric, sl.qty * sl.unit_price)), 2)::numeric(12,2) AS ventes_brutes,
      ROUND(SUM(sl.qty * COALESCE(p.default_cost, 0)), 2)::numeric(12,2) AS cout_ventes
    FROM sale_lines sl
    JOIN products p  ON p.item_id  = sl.item_id
    JOIN shops    sh ON sh.shop_id = sl.shop_id
    WHERE ${conditions.join(' AND ')}
    GROUP BY p.manufacturer, sh.name
    ORDER BY ventes_brutes DESC NULLS LAST
    LIMIT 50
  `, params);

  const totVentes = rows.reduce((s, r) => s + parseFloat(r.ventes_brutes ?? 0), 0);
  const totCout   = rows.reduce((s, r) => s + parseFloat(r.cout_ventes   ?? 0), 0);
  const totUnites = rows.reduce((s, r) => s + parseInt(r.unites          ?? 0), 0);

  return {
    periode: { de: from, a: to },
    resultats: rows.map(r => ({
      marque:        r.manufacturer,
      boutique:      r.boutique,
      unites:        Number(r.unites),
      ventes_brutes: fmtMoney(r.ventes_brutes),
      cout_ventes:   fmtMoney(r.cout_ventes),
    })),
    total: {
      unites:        totUnites,
      ventes_brutes: fmtMoney(totVentes),
      cout_ventes:   fmtMoney(totCout),
    },
  };
}

async function toolGetStockByVariant({ manufacturer, size, category, genre, tags, exclude_tags, description_search, shop_id }, { pool }) {
  shop_id = await resolveShopId(shop_id, pool);
  const conditions = ['p.archived = false'];
  const params     = [];

  if (manufacturer) { conditions.push(`p.manufacturer ILIKE $${params.length + 1}`); params.push(`%${manufacturer}%`); }
  if (category)     { conditions.push(`p.category ILIKE $${params.length + 1}`);      params.push(`%${category}%`); }
  if (genre)        {
    conditions.push(`(p.category ILIKE $${params.length + 1} OR p.tags ILIKE $${params.length + 2} OR p.description ILIKE $${params.length + 3})`);
    params.push(`%${genre}%`, `%${genre}%`, `%${genre}%`);
  }
  conditions.push(...buildTagConditions(tags, exclude_tags, params));
  if (description_search && !category) { conditions.push(`p.description ILIKE $${params.length + 1}`); params.push(`%${description_search}%`); }
  if (size)    { conditions.push(buildSizeCondition(size, params)); }
  if (shop_id) { conditions.push(`i.shop_id = $${params.length + 1}`); params.push(shop_id); }

  const { rows } = await pool.query(`
    SELECT
      p.description,
      p.manufacturer,
      sh.name            AS boutique,
      i.qty_on_hand      AS stock,
      p.default_cost     AS cout_unitaire
    FROM products p
    JOIN inventory i ON i.item_id = p.item_id
    JOIN shops    sh ON sh.shop_id = i.shop_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY p.description, sh.name
    LIMIT 100
  `, params);

  const total = rows.reduce((s, r) => s + Number(r.stock), 0);
  return {
    filtre: { marque: manufacturer, taille: size, recherche: description_search },
    total_unites: total,
    articles: rows.map(r => ({
      description: r.description,
      boutique:    r.boutique,
      stock:       Number(r.stock),
    })),
  };
}

// Convert decimal collar size to fraction string used by some products, e.g. 15.5 → "15 1/2"
function decimalToFraction(sizeStr) {
  const fractions = { '.25': '1/4', '.5': '1/2', '.75': '3/4' };
  const m = sizeStr.match(/^(\d+)(\.(?:25|5|75))$/);
  if (!m) return null;
  return `${m[1]} ${fractions[m[2]]}`;
}

// Build a size condition that avoids false positives.
// Letter sizes (S, M, L, XL, XXL…) require a word boundary after the size
// to avoid matching MARINE, MAUVE, LILAS, SLIM, etc.
// Numeric sizes also check the fraction equivalent (15.5 ↔ 15 1/2).
function buildSizeCondition(size, params) {
  const s = size.trim();
  if (/^(XS|S|M|L|XL|XXL|XXXL)$/i.test(s)) {
    const i1 = params.length + 1, i2 = params.length + 2;
    params.push(`% ${s} %`, `% ${s}`);
    return `(p.description ILIKE $${i1} OR p.description ILIKE $${i2})`;
  }
  const fraction = decimalToFraction(s);
  if (fraction) {
    const i1 = params.length + 1, i2 = params.length + 2;
    params.push(`% ${s}%`, `% ${fraction}%`);
    return `(p.description ILIKE $${i1} OR p.description ILIKE $${i2})`;
  }
  const i = params.length + 1;
  params.push(`% ${s}%`);
  return `p.description ILIKE $${i}`;
}

async function toolGetSalesByVariant({ manufacturer, size, category, genre, tags, exclude_tags, description_search, shop_id, period, season }, { pool, getSeasonsConfig }) {
  shop_id = await resolveShopId(shop_id, pool);
  let from, to;
  if (period) {
    const resolved = resolvePeriod(period);
    if (resolved) [from, to] = resolved;
  }
  if (season && !from) {
    const seasons = await getSeasonsConfig();
    const s = seasons.find(x => x.code === season.toLowerCase());
    if (s) { from = s.sell_from; to = s.sell_to; }
  }

  const conditions = ['sl.qty > 0'];
  const params     = [];

  if (from) { conditions.push(`sl.completed_time >= $${params.length + 1}`); params.push(from); }
  if (to)   { conditions.push(`sl.completed_time <= $${params.length + 1}`); params.push(to); }
  if (manufacturer) { conditions.push(`p.manufacturer ILIKE $${params.length + 1}`); params.push(`%${manufacturer}%`); }
  if (category)     { conditions.push(`p.category ILIKE $${params.length + 1}`);      params.push(`%${category}%`); }
  if (genre)        {
    conditions.push(`(p.category ILIKE $${params.length + 1} OR p.tags ILIKE $${params.length + 2} OR p.description ILIKE $${params.length + 3})`);
    params.push(`%${genre}%`, `%${genre}%`, `%${genre}%`);
  }
  conditions.push(...buildTagConditions(tags, exclude_tags, params));
  // Ignore description_search if category is already set — model tends to duplicate the type word
  if (description_search && !category) { conditions.push(`p.description ILIKE $${params.length + 1}`); params.push(`%${description_search}%`); }
  if (size)    { conditions.push(buildSizeCondition(size, params)); }
  if (shop_id) { conditions.push(`sl.shop_id = $${params.length + 1}`); params.push(shop_id); }

  const { rows } = await pool.query(`
    SELECT
      p.description,
      p.manufacturer,
      SUM(sl.qty)                          AS qty_vendue,
      ROUND(SUM(COALESCE((sl.raw->>'calcSubtotal')::numeric, sl.qty * sl.unit_price)), 2) AS ventes_brutes,
      ROUND(SUM(sl.qty * COALESCE(p.default_cost, 0)), 2) AS cout_ventes
    FROM sale_lines sl
    JOIN products p ON p.item_id = sl.item_id
    WHERE ${conditions.join(' AND ')}
    GROUP BY p.description, p.manufacturer
    ORDER BY qty_vendue DESC
    LIMIT 100
  `, params);

  const total_qty    = rows.reduce((s, r) => s + Number(r.qty_vendue),    0);
  const total_ventes = rows.reduce((s, r) => s + parseFloat(r.ventes_brutes ?? 0), 0);

  return {
    filtre: { marque: manufacturer, taille: size, recherche: description_search, de: from, a: to },
    total_unites_vendues:  total_qty,
    total_ventes_brutes:   fmtMoney(total_ventes),
    articles: rows.map(r => ({
      description:   r.description,
      qty_vendue:    Number(r.qty_vendue),
      ventes_brutes: fmtMoney(r.ventes_brutes),
    })),
  };
}

async function toolGetStockLevels({ manufacturer, shop_id, low_stock_only = false }, { pool }) {
  shop_id = await resolveShopId(shop_id, pool);
  const conditions = ['p.archived = false', 'i.qty_on_hand > 0'];
  const params     = [];

  if (manufacturer) { conditions.push(`p.manufacturer ILIKE $${params.length + 1}`); params.push(`%${manufacturer}%`); }
  if (shop_id)      { conditions.push(`i.shop_id = $${params.length + 1}`);           params.push(shop_id); }
  if (low_stock_only) conditions.push('i.qty_on_hand <= 2');

  const { rows } = await pool.query(`
    SELECT
      p.manufacturer,
      sh.name                        AS boutique,
      SUM(i.qty_on_hand)             AS stock_total,
      COUNT(DISTINCT p.item_id)      AS references,
      SUM(i.qty_on_hand * p.default_cost)::numeric(12,2) AS valeur_stock
    FROM inventory i
    JOIN products p  ON p.item_id  = i.item_id
    JOIN shops    sh ON sh.shop_id = i.shop_id
    WHERE ${conditions.join(' AND ')}
    GROUP BY p.manufacturer, sh.name
    ORDER BY valeur_stock DESC NULLS LAST
    LIMIT 60
  `, params);

  return {
    filtre: { marque: manufacturer ?? 'toutes', boutique: shop_id ?? 'toutes', bas_stock: low_stock_only },
    stock: rows.map(r => ({
      marque:       r.manufacturer,
      boutique:     r.boutique,
      unites:       Number(r.stock_total),
      references:   Number(r.references),
      valeur_stock: fmtMoney(r.valeur_stock),
    })),
  };
}

async function toolGetPlanVsRecommended({ season }, { pool, budgetCache }) {
  season = (season ?? 'p26').toLowerCase();

  // Get planned amounts
  const { rows: planRows } = await pool.query(`
    SELECT manufacturer, SUM(planned_amount)::float8 AS total_planifie
    FROM budget_plans WHERE season_code = $1
    GROUP BY manufacturer
  `, [season]);

  const planned = {};
  for (const r of planRows) planned[r.manufacturer] = parseFloat(r.total_planifie ?? 0);

  // Get recommended from cache
  const cacheKey = `marque:${season}:all`;
  const cached   = budgetCache?.get(cacheKey);
  const recommended = {};
  if (cached && Date.now() < cached.expires) {
    for (const m of cached.data.by_manufacturer ?? []) {
      recommended[m.manufacturer] = m.net_budget ?? 0;
    }
  }

  const allBrands = new Set([...Object.keys(planned), ...Object.keys(recommended)]);
  const comparison = [...allBrands].map(mfr => {
    const rec  = recommended[mfr] ?? null;
    const plan = planned[mfr]     ?? 0;
    const diff = rec != null ? plan - rec : null;
    return {
      marque:      mfr,
      recommande:  rec  != null ? fmtMoney(rec)  : '(non calculé — ouvrir onglet Budget)',
      planifie:    plan > 0     ? fmtMoney(plan)  : '—',
      ecart:       diff != null ? fmtMoney(diff)  : '—',
      statut:      diff == null ? 'inconnu' : diff > 0 ? 'au-dessus' : diff < 0 ? 'en-dessous' : 'exact',
    };
  }).sort((a, b) => {
    const da = planned[a.marque] ?? 0, db = planned[b.marque] ?? 0;
    return db - da;
  });

  return { saison: season, comparaison: comparison };
}

async function toolGetTopPerformers({ season, metric, order = 'desc', limit = 10, shops }, { pool, budgetCache, getSeasonsConfig }) {
  season = (season ?? 'p26').toLowerCase();
  const rawShops = shops ? shops.split(',').map(s => s.trim()).filter(Boolean) : null;
  const shopIds  = rawShops ? (await Promise.all(rawShops.map(s => resolveShopId(s, pool)))).filter(Boolean) : null;
  const cacheKey = `marque:${season}:${shopIds?.join(',') ?? 'all'}`;
  const cached = budgetCache?.get(cacheKey);

  if (cached && Date.now() < cached.expires) {
    let list = [...(cached.data.by_manufacturer ?? [])];
    if      (metric === 'sell_through') list.sort((a, b) => (a.avg_st ?? 0) - (b.avg_st ?? 0));
    else if (metric === 'net_budget')   list.sort((a, b) => (a.net_budget ?? 0) - (b.net_budget ?? 0));
    else if (metric === 'sold_cost')    list.sort((a, b) => (a.sold_cost ?? 0) - (b.sold_cost ?? 0));
    if (order === 'desc') list.reverse();
    return {
      saison: season,
      critere: metric,
      ordre: order === 'desc' ? 'décroissant (meilleures en tête)' : 'croissant (pires en tête)',
      classement: list.slice(0, limit).map((m, i) => ({
        rang:              i + 1,
        marque:            m.manufacturer,
        sell_through:      fmtPct(m.avg_st),
        budget_net:        fmtMoney(m.net_budget),
        tendance:          m.trend ?? 'stable',
      })),
    };
  }

  // Fallback: sort by sold_cost from DB
  const seasons = await getSeasonsConfig();
  const s = seasons.find(x => x.code === season);
  if (!s) return { erreur: `Saison "${season}" non trouvée.` };
  const shopFilter = shopIds?.length ? 'AND sl.shop_id = ANY($3)' : '';
  const params = shopIds?.length ? [s.sell_from, s.sell_to, shopIds] : [s.sell_from, s.sell_to];

  const dir = order === 'asc' ? 'ASC' : 'DESC';
  const { rows } = await pool.query(`
    SELECT
      p.manufacturer,
      SUM(sl.qty * p.default_cost)::numeric(12,2) AS cout_ventes
    FROM sale_lines sl
    JOIN products p ON p.item_id = sl.item_id
    WHERE sl.completed_time BETWEEN $1 AND $2
      AND p.manufacturer IS NOT NULL ${shopFilter}
    GROUP BY p.manufacturer
    ORDER BY cout_ventes ${dir} NULLS LAST
    LIMIT ${shopIds?.length ? '$4' : '$3'}
  `, [...params, limit]);

  return {
    saison: season,
    critere: 'cout_ventes (budget complet disponible dans onglet Budget)',
    classement: rows.map((r, i) => ({ rang: i + 1, marque: r.manufacturer, cout_ventes: fmtMoney(r.cout_ventes) })),
  };
}

async function toolGetShopsList(_, { pool }) {
  const { rows } = await pool.query('SELECT shop_id, name FROM shops ORDER BY name');
  return { boutiques: rows.map(r => ({ id: r.shop_id, nom: r.name })) };
}

async function toolSearchBrands({ query }, { pool }) {
  const { rows } = await pool.query(`
    SELECT DISTINCT manufacturer, COUNT(DISTINCT item_id) AS nb_articles
    FROM products
    WHERE manufacturer ILIKE $1 AND manufacturer IS NOT NULL
    GROUP BY manufacturer
    ORDER BY manufacturer
    LIMIT 20
  `, [`%${query}%`]);
  return { resultats: rows.map(r => ({ marque: r.manufacturer, nb_articles: Number(r.nb_articles) })) };
}

async function toolGetSellthroughBySize({ manufacturer, size, category, genre, tags, exclude_tags, season, shop_id, sort = 'st_desc', limit = 50 }, { pool, getSeasonsConfig }) {
  shop_id = await resolveShopId(shop_id, pool);
  const today = new Date().toISOString().slice(0, 10);
  let from, to;

  // Resolve date range: prefer reception_from (= start of season life) over sell_from.
  // Also inject the season tag so only items tagged for this season are included —
  // matching Lightspeed's "Stocks reçus" filter which uses the season tag, not just dates.
  if (season) {
    const seasons = await getSeasonsConfig();
    const s = seasons.find(x => x.code === season.toLowerCase());
    if (s) {
      from = s.reception_from ?? s.sell_from;
      to   = s.sell_to < today ? s.sell_to : today;
      // Auto-inject season tag unless caller already provided a tag override
      const pattern = s.tag_pattern ?? s.code;
      const existingTags = normalizeTags(tags);
      if (!existingTags.some(t => t.toLowerCase() === pattern.toLowerCase())) {
        tags = [...existingTags, pattern];
      }
    }
  }
  // If tags contain a season-like code (e.g. "p26"), auto-resolve its reception_from
  if (!from && tags?.length) {
    const seasons = await getSeasonsConfig();
    for (const t of normalizeTags(tags)) {
      const s = seasons.find(x => x.tag_pattern === t || x.code === t);
      if (s) { from = s.reception_from ?? s.sell_from; to = today; break; }
    }
  }
  if (!from) {
    const d = new Date(); d.setFullYear(d.getFullYear() - 1);
    from = d.toISOString().slice(0, 10); to = today;
  }

  // No archived filter on products — archived items were still received and sold.
  // Convention: archived = false only for inventory queries, not sales.
  const prodWhere = [];
  const params    = [from, to]; // $1, $2

  if (manufacturer) { prodWhere.push(`p.manufacturer ILIKE $${params.length + 1}`); params.push(`%${manufacturer}%`); }
  if (category)     { prodWhere.push(`p.category ILIKE $${params.length + 1}`);      params.push(`%${category}%`); }
  if (genre)        {
    prodWhere.push(`(p.category ILIKE $${params.length + 1} OR p.tags ILIKE $${params.length + 2} OR p.description ILIKE $${params.length + 3})`);
    params.push(`%${genre}%`, `%${genre}%`, `%${genre}%`);
  }
  prodWhere.push(...buildTagConditions(tags, exclude_tags, params));
  if (size) { prodWhere.push(buildSizeCondition(size, params)); }

  const shopIdx        = shop_id ? params.length + 1 : null;
  if (shop_id) params.push(shop_id);
  const shopSaleCond   = shopIdx ? `AND sl2.shop_id = $${shopIdx}` : '';
  const shopStockWhere = shopIdx ? `WHERE inv.shop_id = $${shopIdx}` : '';

  const limitIdx = params.length + 1;
  params.push(Math.min(limit, 100));

  const orderBy = sort === 'st_asc'    ? 'st_pct ASC  NULLS LAST, sold DESC'
               : sort === 'sold_desc' ? 'sold DESC, st_pct DESC'
               : /* st_desc default */ 'st_pct DESC NULLS LAST, sold DESC';

  // Transfer CTEs reuse the same shopIdx parameter.
  // When shopIdx is null, to_shop_id = NULL is always false → CTEs return 0 rows
  // → no adjustment, which is correct (transfers cancel out at company level).
  const transferInCond  = shopIdx ? `t.to_shop_id   = $${shopIdx} AND t.transfer_received = true` : 'false';
  const transferOutCond = shopIdx ? `t.from_shop_id = $${shopIdx} AND t.transfer_sent     = true` : 'false';

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
    transfers_in AS (
      SELECT t.item_id, SUM(t.qty_received) AS qty_in
      FROM transfers t
      WHERE ${transferInCond}
        AND t.transfer_date BETWEEN $1 AND $2
      GROUP BY t.item_id
    ),
    transfers_out AS (
      -- Completed transfers: qty_sent is cleared to 0 once received, use qty_received.
      -- Pending transfers (in transit): qty_received = 0, use qty_sent.
      SELECT t.item_id,
        SUM(CASE WHEN t.transfer_received THEN t.qty_received ELSE t.qty_sent END) AS qty_out
      FROM transfers t
      WHERE ${transferOutCond}
        AND t.transfer_date BETWEEN $1 AND $2
      GROUP BY t.item_id
    ),
    base AS (
      SELECT
        p.description,
        p.manufacturer,
        p.category,
        COALESCE(s.sold,    0)::int  AS sold,
        COALESCE(st.stock,  0)::int  AS stock,
        COALESCE(ti.qty_in, 0)::int  AS transferred_in,
        COALESCE(to2.qty_out, 0)::int AS transferred_out,
        -- True supplier received = sold + stock + out - in (transfers cancel)
        GREATEST(0,
          COALESCE(s.sold, 0) + COALESCE(st.stock, 0)
          + COALESCE(to2.qty_out, 0) - COALESCE(ti.qty_in, 0)
        )::int AS received_supplier,
        CASE WHEN GREATEST(0,
          COALESCE(s.sold, 0) + COALESCE(st.stock, 0)
          + COALESCE(to2.qty_out, 0) - COALESCE(ti.qty_in, 0)) > 0
          THEN ROUND(GREATEST(0, COALESCE(s.sold, 0))::numeric / GREATEST(1,
            COALESCE(s.sold, 0) + COALESCE(st.stock, 0)
            + COALESCE(to2.qty_out, 0) - COALESCE(ti.qty_in, 0)) * 100, 1)
          ELSE 0 END AS st_pct
      FROM products p
      LEFT JOIN sales_by_item  s    ON s.item_id    = p.item_id
      LEFT JOIN stock_by_item  st   ON st.item_id   = p.item_id
      LEFT JOIN transfers_in   ti   ON ti.item_id   = p.item_id
      LEFT JOIN transfers_out  to2  ON to2.item_id  = p.item_id
      WHERE ${prodWhere.length ? prodWhere.join(' AND ') + ' AND' : ''}
        -- Include any item with sales, stock, OR transfer activity.
        -- Items transferred out with 0 sales and 0 stock still have real supplier received.
        (GREATEST(0, COALESCE(s.sold, 0)) + COALESCE(st.stock, 0) + COALESCE(ti.qty_in, 0) + COALESCE(to2.qty_out, 0)) > 0
    )
    SELECT *,
      SUM(received_supplier) OVER () AS total_recu_all,
      SUM(sold)              OVER () AS total_sold_all,
      SUM(stock)             OVER () AS total_stock_all,
      SUM(transferred_in)    OVER () AS total_in_all,
      SUM(transferred_out)   OVER () AS total_out_all,
      COUNT(*)               OVER () AS nb_variantes_total
    FROM base
    ORDER BY ${orderBy}
    LIMIT $${limitIdx}
  `, params);

  // Totals from window functions — correct even when LIMIT truncates the rows
  const total_recu  = rows[0] ? Number(rows[0].total_recu_all)  : 0;
  const total_sold  = rows[0] ? Number(rows[0].total_sold_all)  : 0;
  const total_stock = rows[0] ? Number(rows[0].total_stock_all) : 0;
  const total_in    = rows[0] ? Number(rows[0].total_in_all)    : 0;
  const total_out   = rows[0] ? Number(rows[0].total_out_all)   : 0;
  const total_st    = total_recu > 0 ? Math.round(total_sold / total_recu * 1000) / 10 : 0;
  const nb_total    = rows[0] ? Number(rows[0].nb_variantes_total) : 0;

  return {
    periode:              { de: from, a: to },
    filtre:               { marque: manufacturer, categorie: category, genre, tags, exclude_tags, taille: size, saison: season },
    tri:                  sort,
    formule_calcul:       'recu_fournisseur = vendu + stock_actuel + transferts_sortants - transferts_entrants. IMPORTANT: stock_actuel est EXCLUSIF des transferts_sortants (ces unités ont déjà quitté la boutique et sont déduites de linventaire). Ne jamais dire que le stock "inclut" les transferts sortants.',
    total_recu_fournisseur: total_recu,
    total_vendu:          total_sold,
    total_stock_actuel_en_boutique: total_stock,
    total_transferts_entrants_depuis_autres_boutiques: total_in,
    total_transferts_sortants_vers_autres_boutiques:   total_out,
    st_global:            `${total_st}%`,
    nb_variantes_total:   nb_total,
    nb_variantes_affiches: rows.length,
    variantes:            rows.map(r => ({
      description:         r.description,
      recu_fournisseur:    Number(r.received_supplier),
      vendu:               Number(r.sold),
      stock_actuel:        Number(r.stock),
      transferts_entrants: Number(r.transferred_in),
      transferts_sortants: Number(r.transferred_out),
      st_pct:              `${Number(r.st_pct)}%`,
    })),
  };
}

async function toolGetCategories({ manufacturer }, { pool }) {
  const conditions = ['p.category IS NOT NULL', "p.category != ''", 'p.archived = false'];
  const params     = [];

  if (manufacturer) {
    conditions.push(`p.manufacturer ILIKE $${params.length + 1}`);
    params.push(`%${manufacturer}%`);
  }

  const { rows } = await pool.query(`
    SELECT
      p.category,
      COUNT(DISTINCT p.item_id)   AS nb_produits,
      COUNT(DISTINCT p.manufacturer) AS nb_marques
    FROM products p
    WHERE ${conditions.join(' AND ')}
    GROUP BY p.category
    ORDER BY nb_produits DESC
    LIMIT 100
  `, params);

  // Build a tree summary: top-level segments and their children
  const tree = {};
  for (const r of rows) {
    const parts = r.category.split('/');
    const top   = parts[0];
    if (!tree[top]) tree[top] = [];
    tree[top].push({ categorie: r.category, nb_produits: Number(r.nb_produits) });
  }

  return {
    filtre_marque: manufacturer ?? 'toutes',
    nb_categories: rows.length,
    categories: rows.map(r => ({
      categorie:   r.category,
      nb_produits: Number(r.nb_produits),
      nb_marques:  Number(r.nb_marques),
    })),
    arbre: tree,
  };
}

async function toolGetTransferRecommendations({ days_dormant = 14, min_stock = 1, receiving_shop_id, category, exclude_nos = false }, { pool }) {
  const params = [days_dormant, min_stock];
  const nosFilter = exclude_nos ? "AND (p.tags IS NULL OR p.tags NOT ILIKE '%nos%')" : '';
  let catFilter = '';
  if (category) { params.push(`%${category}%`); catFilter = `AND p.category ILIKE $${params.length}`; }

  const { rows } = await pool.query(`
    WITH
    matrix_last_sale AS (
      SELECT p.matrix_id, sl.shop_id,
        MAX(sl.completed_time) AS last_sale_date,
        SUM(CASE WHEN sl.completed_time >= now() - interval '30 days' THEN sl.qty ELSE 0 END)::int AS units_sold_30d
      FROM sale_lines sl
      JOIN products p ON p.item_id = sl.item_id
      WHERE sl.completed_time >= now() - interval '90 days'
        AND sl.completed_time IS NOT NULL
        AND p.matrix_id IS NOT NULL AND p.archived = false
      GROUP BY p.matrix_id, sl.shop_id
    ),
    matrix_ever_sold AS (
      SELECT DISTINCT p.matrix_id, sl.shop_id
      FROM sale_lines sl JOIN products p ON p.item_id = sl.item_id
      WHERE sl.completed_time >= now() - interval '3 years'
        AND p.matrix_id IS NOT NULL AND p.archived = false
    ),
    item_ever_sold AS (
      SELECT DISTINCT item_id, shop_id FROM sale_lines
      WHERE completed_time >= now() - interval '3 years'
    ),
    dormant_matrix AS (
      SELECT DISTINCT p.matrix_id, i.shop_id,
        CASE WHEN mls.last_sale_date IS NULL THEN NULL
             ELSE EXTRACT(DAY FROM now() - mls.last_sale_date)::int END AS days_dormant
      FROM inventory i
      JOIN products p ON p.item_id = i.item_id AND p.matrix_id IS NOT NULL AND p.archived = false
      JOIN matrix_ever_sold mes ON mes.matrix_id = p.matrix_id AND mes.shop_id = i.shop_id
      LEFT JOIN matrix_last_sale mls ON mls.matrix_id = p.matrix_id AND mls.shop_id = i.shop_id
      WHERE i.qty_on_hand > 0
        AND (mls.last_sale_date IS NULL OR mls.last_sale_date < now() - (interval '1 day' * $1))
      GROUP BY p.matrix_id, i.shop_id, mls.last_sale_date
    ),
    active_matrix AS (
      SELECT matrix_id, shop_id, last_sale_date, units_sold_30d
      FROM matrix_last_sale
      WHERE last_sale_date >= now() - interval '30 days' AND units_sold_30d >= 1
    ),
    best_active AS (
      SELECT DISTINCT ON (dm.matrix_id, dm.shop_id)
        dm.matrix_id, dm.shop_id AS dormant_shop_id, dm.days_dormant,
        am.shop_id AS active_shop_id, am.units_sold_30d
      FROM dormant_matrix dm
      JOIN active_matrix am ON am.matrix_id = dm.matrix_id AND am.shop_id != dm.shop_id
      ORDER BY dm.matrix_id, dm.shop_id, am.last_sale_date DESC
    )
    SELECT
      p.manufacturer,
      p.matrix_id,
      MIN(p.description) AS model_name,
      sh_d.name AS boutique_dormante,
      sh_a.name AS boutique_active,
      ba.days_dormant,
      ba.units_sold_30d AS vendu_30j,
      SUM(i.qty_on_hand)::int AS stock_total,
      COUNT(DISTINCT p.item_id)::int AS nb_tailles,
      string_agg(DISTINCT COALESCE(
        CASE WHEN p.raw->'ItemAttributes'->>'attribute1' ~ '^[0-9]' OR p.raw->'ItemAttributes'->>'attribute1' ~* '^(XXS|XS|S|M|L|XL|XXL|XXXL|2XL|3XL)$' THEN p.raw->'ItemAttributes'->>'attribute1' END,
        CASE WHEN p.raw->'ItemAttributes'->>'attribute2' ~ '^[0-9]' OR p.raw->'ItemAttributes'->>'attribute2' ~* '^(XXS|XS|S|M|L|XL|XXL|XXXL|2XL|3XL)$' THEN p.raw->'ItemAttributes'->>'attribute2' END
      ), ', ' ORDER BY COALESCE(
        CASE WHEN p.raw->'ItemAttributes'->>'attribute1' ~ '^[0-9]' OR p.raw->'ItemAttributes'->>'attribute1' ~* '^(XXS|XS|S|M|L|XL|XXL|XXXL|2XL|3XL)$' THEN p.raw->'ItemAttributes'->>'attribute1' END,
        CASE WHEN p.raw->'ItemAttributes'->>'attribute2' ~ '^[0-9]' OR p.raw->'ItemAttributes'->>'attribute2' ~* '^(XXS|XS|S|M|L|XL|XXL|XXXL|2XL|3XL)$' THEN p.raw->'ItemAttributes'->>'attribute2' END
      )) AS tailles
    FROM best_active ba
    JOIN products p ON p.matrix_id = ba.matrix_id AND p.archived = false
    JOIN item_ever_sold ies ON ies.item_id = p.item_id AND ies.shop_id = ba.active_shop_id
    JOIN inventory i ON i.item_id = p.item_id AND i.shop_id = ba.dormant_shop_id AND i.qty_on_hand >= $2
    JOIN shops sh_d ON sh_d.shop_id = ba.dormant_shop_id
    JOIN shops sh_a ON sh_a.shop_id = ba.active_shop_id
    WHERE NOT (p.default_cost = 0 AND p.default_price = 0)
      AND p.description NOT ILIKE '%shopify%'
      ${nosFilter} ${catFilter}
    GROUP BY p.manufacturer, p.matrix_id, sh_d.name, sh_a.name, ba.days_dormant, ba.units_sold_30d
    ORDER BY ba.days_dormant ASC NULLS LAST, p.manufacturer
    LIMIT 50
  `, params);

  const filtered = receiving_shop_id
    ? rows.filter(r => r.boutique_active.toLowerCase().includes(receiving_shop_id.toLowerCase()))
    : rows;

  return {
    parametres: { jours_inactif: days_dormant, stock_min: min_stock },
    nb_modeles: filtered.length,
    recommandations: filtered.map(r => ({
      marque:           r.manufacturer,
      modele:           r.model_name,
      tailles:          r.tailles ?? '—',
      nb_tailles:       Number(r.nb_tailles),
      stock_total:      Number(r.stock_total),
      boutique_dormante: r.boutique_dormante,
      jours_inactif:    r.days_dormant ?? 'Jamais vendu',
      boutique_active:  r.boutique_active,
      vendu_30j:        Number(r.vendu_30j),
    })),
  };
}

async function toolGetMatrixInfo({ manufacturer, description_search, category, shop_id }, { pool }) {
  shop_id = await resolveShopId(shop_id, pool);
  const conditions = ['p.archived = false', 'p.matrix_id IS NOT NULL'];
  const params = [];
  if (manufacturer)      { conditions.push(`p.manufacturer ILIKE $${params.length+1}`); params.push(`%${manufacturer}%`); }
  if (description_search){ conditions.push(`p.description  ILIKE $${params.length+1}`); params.push(`%${description_search}%`); }
  if (category)          { conditions.push(`p.category     ILIKE $${params.length+1}`); params.push(`%${category}%`); }

  const shopJoin  = shop_id ? `JOIN inventory i ON i.item_id = p.item_id AND i.shop_id = $${params.length+1}` : 'LEFT JOIN inventory i ON i.item_id = p.item_id';
  if (shop_id) params.push(shop_id);

  const { rows } = await pool.query(`
    SELECT
      p.matrix_id,
      p.manufacturer,
      MIN(p.description) AS exemple_description,
      COUNT(DISTINCT p.item_id)::int AS nb_variantes,
      COALESCE(SUM(i.qty_on_hand), 0)::int AS stock_total,
      string_agg(DISTINCT COALESCE(
        CASE WHEN p.raw->'ItemAttributes'->>'attribute1' ~ '^[0-9]' OR p.raw->'ItemAttributes'->>'attribute1' ~* '^(XXS|XS|S|M|L|XL|XXL|XXXL|2XL|3XL)$' THEN p.raw->'ItemAttributes'->>'attribute1' END,
        CASE WHEN p.raw->'ItemAttributes'->>'attribute2' ~ '^[0-9]' OR p.raw->'ItemAttributes'->>'attribute2' ~* '^(XXS|XS|S|M|L|XL|XXL|XXXL|2XL|3XL)$' THEN p.raw->'ItemAttributes'->>'attribute2' END,
        CASE WHEN p.raw->'ItemAttributes'->>'attribute3' ~ '^[0-9]' OR p.raw->'ItemAttributes'->>'attribute3' ~* '^(XXS|XS|S|M|L|XL|XXL|XXXL|2XL|3XL)$' THEN p.raw->'ItemAttributes'->>'attribute3' END
      ), ', ') AS tailles_disponibles,
      (SELECT SUM(sl2.qty) FROM sale_lines sl2
       JOIN products p2 ON p2.item_id = sl2.item_id
       WHERE p2.matrix_id = p.matrix_id
         AND sl2.completed_time >= now() - interval '365 days')::int AS ventes_12m
    FROM products p
    ${shopJoin}
    WHERE ${conditions.join(' AND ')}
    GROUP BY p.matrix_id, p.manufacturer
    ORDER BY stock_total DESC NULLS LAST
    LIMIT 30
  `, params);

  return {
    nb_matrices: rows.length,
    matrices: rows.map(r => ({
      matrix_id:      r.matrix_id,
      marque:         r.manufacturer,
      modele:         r.exemple_description,
      nb_variantes:   r.nb_variantes,
      tailles:        r.tailles_disponibles ?? '—',
      stock_total:    r.stock_total,
      ventes_12m:     r.ventes_12m ?? 0,
    })),
  };
}

async function toolGetSeasonsList(_, { getSeasonsConfig }) {
  const seasons = await getSeasonsConfig();
  return {
    saisons: seasons.map(s => ({
      code:          s.code,
      reception_de:  s.reception_from,
      reception_a:   s.reception_to,
      ventes_de:     s.sell_from,
      ventes_a:      s.sell_to,
    })),
  };
}

// ---------------------------------------------------------------------------
// Tool dispatcher
// ---------------------------------------------------------------------------
async function dispatchTool(name, args, ctx) {
  switch (name) {
    case 'get_budget_recommendations': return await toolGetBudgetRecommendations(args, ctx);
    case 'get_sales_analysis':         return await toolGetSalesAnalysis(args, ctx);
    case 'get_stock_levels':           return await toolGetStockLevels(args, ctx);
    case 'get_stock_by_variant':       return await toolGetStockByVariant(args, ctx);
    case 'get_sales_by_variant':       return await toolGetSalesByVariant(args, ctx);
    case 'get_plan_vs_recommended':    return await toolGetPlanVsRecommended(args, ctx);
    case 'get_top_performers':         return await toolGetTopPerformers(args, ctx);
    case 'get_shops_list':             return await toolGetShopsList(args, ctx);
    case 'search_brands':              return await toolSearchBrands(args, ctx);
    case 'get_seasons_list':           return await toolGetSeasonsList(args, ctx);
    case 'get_categories':             return await toolGetCategories(args, ctx);
    case 'get_sellthrough_by_size':         return await toolGetSellthroughBySize(args, ctx);
    case 'get_transfer_recommendations':    return await toolGetTransferRecommendations(args, ctx);
    case 'get_matrix_info':                 return await toolGetMatrixInfo(args, ctx);
    default:                                return { erreur: `Outil inconnu: ${name}` };
  }
}

// Returns true when a tool result has no useful data (0 items, 0 sales, empty arrays)
function isEmptyResult(name, result) {
  if (result.erreur) return false; // errors are not "empty" — don't retry
  if (name === 'get_sellthrough_by_size') return !result.variantes?.length;
  if (name === 'get_sales_by_variant')    return !result.lignes?.length && (result.total_qty ?? 0) === 0;
  if (name === 'get_stock_by_variant')    return !result.articles?.length;
  return false;
}

// Relax args one step: remove the most restrictive filter to broaden the search
function relaxArgs(name, args) {
  const r = { ...args };
  // Priority order: size > tag > category > description_search > genre
  if (name === 'get_sellthrough_by_size' || name === 'get_sales_by_variant' || name === 'get_stock_by_variant') {
    if (r.size)               { delete r.size;               return { relaxed: r, dropped: 'size' }; }
    if (r.tag)                { delete r.tag;                return { relaxed: r, dropped: 'tag' }; }
    if (r.description_search) { delete r.description_search; return { relaxed: r, dropped: 'description_search' }; }
    if (r.category)           { delete r.category;           return { relaxed: r, dropped: 'category' }; }
  }
  return null;
}

async function executeTool(name, args, ctx) {
  try {
    const result = await dispatchTool(name, args, ctx);

    // Auto-retry with relaxed filters if result is empty
    if (isEmptyResult(name, result)) {
      const relaxation = relaxArgs(name, args);
      if (relaxation) {
        console.log(`[ai-agent] Empty result for "${name}", retrying without "${relaxation.dropped}"`);
        const retried = await dispatchTool(name, relaxation.relaxed, ctx);
        if (!isEmptyResult(name, retried)) {
          retried._retry_note = `Filtre "${relaxation.dropped}" retiré automatiquement — aucun résultat avec le filtre original.`;
          return retried;
        }
      }
    }

    return result;
  } catch (err) {
    console.error(`[ai-agent] Tool "${name}" error:`, err.message);
    return { erreur: `Erreur lors de l'exécution de l'outil "${name}": ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Agentic loop
// messages = OpenAI-format array (history from client, without system prompt)
// ctx = { pool, budgetCache, getSeasonsConfig, tenantConfig, tenantId, shops, seasons }
// ---------------------------------------------------------------------------
async function runAgentLoop(messages, ctx) {
  const provider = createProvider();

  const now   = new Date();
  const today = now.toISOString().slice(0, 10);

  // Build live context — generic, works for any tenant
  const seasons    = ctx.seasons ?? await ctx.getSeasonsConfig();
  const shops      = ctx.shops   ?? [];
  const shopNames  = shops.map(s => s.name).join(', ') || '(aucune boutique configurée)';

  // Active season = sell period contains today
  const activeSeason = seasons.find(s => today >= s.sell_from && today <= s.sell_to);
  // Season in preparation = reception started but sell not yet started
  const prepSeason   = seasons.find(s => today >= s.reception_from && today < s.sell_from);
  // Next budget season = first season whose reception hasn't started yet
  const nextSeason   = seasons.find(s => today < s.reception_from);

  const seasonLines = [
    activeSeason
      ? `- Saison en cours (ventes actives) : ${activeSeason.code.toUpperCase()} — ${activeSeason.label}`
      : '- Aucune saison en cours',
    prepSeason
      ? `- Saison en préparation (commandes en cours) : ${prepSeason.code.toUpperCase()} — ${prepSeason.label}`
      : '',
    nextSeason
      ? `- Prochaine saison (pas encore commencée) : ${nextSeason.code.toUpperCase()} — ${nextSeason.label}`
      : '',
  ].filter(Boolean).join('\n');

  const liveContext = `

DATE ACTUELLE : ${today}
RÈGLE ABSOLUE SUR LES DATES : utilise TOUJOURS le paramètre "period" pour les périodes relatives — jamais date_from/date_to calculées de ta tête.
Correspondances period : "4y"=4 ans, "3y"=3 ans, "2y"=2 ans, "1y"=1 an, "6m"=6 mois, "3m"=3 mois, "10w"=10 semaines, "ytd"=cette année, "last_year"=l'an dernier.

BOUTIQUES DISPONIBLES : ${shopNames}
Quand l'utilisateur mentionne une boutique (même en abrégé), utilise le nom exact ci-dessus dans shop_id.
"toutes les boutiques" ou "toutes" → ne pas filtrer par boutique (omettre shop_id).

SAISONS :
${seasonLines}
Toutes les saisons configurées : ${seasons.map(s => s.code).join(', ')}
Résolution du langage naturel :
- "cette saison" / "la saison en cours" → ${activeSeason?.code ?? 'demander précision'}
- "la saison en préparation" / "la prochaine commande" → ${prepSeason?.code ?? nextSeason?.code ?? 'demander précision'}
- "l'an dernier" / "last year" → utiliser period="last_year"
- "les X dernières saisons" → lister les X codes précédant la saison en cours du même type (P ou A)`;

  const basePrompt    = ctx.tenantConfig ? buildSystemPrompt(ctx.tenantConfig) : SYSTEM_PROMPT;
  const systemContent = basePrompt + liveContext;

  const fullMessages = [
    { role: 'system', content: systemContent },
    ...messages,
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await provider.complete(fullMessages);
    fullMessages.push(response.message);

    if (!response.tool_calls?.length) {
      // Final text response — return content and updated history (without system prompt)
      return {
        content:  response.content,
        messages: fullMessages.slice(1), // strip system prompt from history
      };
    }

    // Execute all tool calls in parallel
    const results = await Promise.all(
      response.tool_calls.map(async tc => {
        const args   = JSON.parse(tc.function.arguments ?? '{}');
        const result = await executeTool(tc.function.name, args, ctx);
        return {
          role:         'tool',
          tool_call_id: tc.id,
          name:         tc.function.name,
          content:      JSON.stringify(result),
        };
      })
    );

    fullMessages.push(...results);
  }

  return {
    content:  "Désolé, j'ai atteint la limite de traitement pour cette requête. Veuillez reformuler votre question.",
    messages: fullMessages.slice(1),
  };
}

// ---------------------------------------------------------------------------
// Tool name → human-readable label for streaming status messages
// ---------------------------------------------------------------------------
const TOOL_LABELS = {
  get_budget_recommendations:   'Calcul des budgets recommandés',
  get_sales_analysis:           'Analyse des ventes',
  get_stock_levels:             'Consultation du stock',
  get_plan_vs_recommended:      'Comparaison plan vs recommandé',
  get_top_performers:           'Classement des marques',
  get_sellthrough_by_size:      'Analyse des tailles',
  get_transfer_recommendations: 'Recommandations de transferts',
  get_matrix_info:              'Info produit / matrice',
  get_categories:               'Récupération des catégories',
};

// ---------------------------------------------------------------------------
// runAgentLoopStream — same logic as runAgentLoop but emits SSE events:
//   onEvent({ type: 'tool_call', label })  — before each tool round
//   onEvent({ type: 'token',     text  })  — each streamed token
//   onEvent({ type: 'done',      messages, content }) — when complete
// ---------------------------------------------------------------------------
async function runAgentLoopStream(messages, ctx, onEvent) {
  const provider = createProvider();

  const now   = new Date();
  const today = now.toISOString().slice(0, 10);

  const seasons    = ctx.seasons ?? await ctx.getSeasonsConfig();
  const shops      = ctx.shops   ?? [];
  const shopNames  = shops.map(s => s.name).join(', ') || '(aucune boutique configurée)';

  const activeSeason = seasons.find(s => today >= s.sell_from && today <= s.sell_to);
  const prepSeason   = seasons.find(s => today >= s.reception_from && today < s.sell_from);
  const nextSeason   = seasons.find(s => today < s.reception_from);

  const seasonLines = [
    activeSeason ? `- Saison en cours : ${activeSeason.code.toUpperCase()} — ${activeSeason.label}` : '- Aucune saison en cours',
    prepSeason   ? `- Saison en préparation : ${prepSeason.code.toUpperCase()} — ${prepSeason.label}` : '',
    nextSeason   ? `- Prochaine saison : ${nextSeason.code.toUpperCase()} — ${nextSeason.label}` : '',
  ].filter(Boolean).join('\n');

  const liveContext = `

DATE ACTUELLE : ${today}
RÈGLE ABSOLUE SUR LES DATES : utilise TOUJOURS le paramètre "period" pour les périodes relatives.
Correspondances : "4y"=4 ans, "3y"=3 ans, "2y"=2 ans, "1y"=1 an, "6m"=6 mois, "3m"=3 mois, "10w"=10 semaines, "ytd"=cette année, "last_year"=l'an dernier.

BOUTIQUES DISPONIBLES : ${shopNames}
Quand l'utilisateur mentionne une boutique (même en abrégé), utilise le nom exact ci-dessus dans shop_id.
"toutes les boutiques" ou "toutes" → ne pas filtrer par boutique (omettre shop_id).

SAISONS :
${seasonLines}
Toutes les saisons configurées : ${seasons.map(s => s.code).join(', ')}
Résolution du langage naturel :
- "cette saison" / "la saison en cours" → ${activeSeason?.code ?? 'demander précision'}
- "la saison en préparation" / "la prochaine commande" → ${prepSeason?.code ?? nextSeason?.code ?? 'demander précision'}
- "l'an dernier" / "last year" → utiliser period="last_year"`;

  const basePrompt    = ctx.tenantConfig ? buildSystemPrompt(ctx.tenantConfig) : SYSTEM_PROMPT;
  const systemContent = basePrompt + liveContext;

  const fullMessages = [{ role: 'system', content: systemContent }, ...messages];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    // Check if this is the final round (no tool calls expected) — use streaming
    // We always try non-streaming first to detect tool calls; only stream the final answer
    const response = await provider.complete(fullMessages);
    fullMessages.push(response.message);

    if (!response.tool_calls?.length) {
      // Final response — re-issue as streaming call for token-by-token output.
      // noTools=true prevents Mistral from switching to a tool call mid-stream.
      fullMessages.pop();
      let content = '';
      const streamResult = await provider.stream(fullMessages, text => {
        content += text;
        onEvent({ type: 'token', text });
      }, { noTools: true });
      // Fallback: if stream returned no text but tool calls, treat as text anyway
      if (!content && streamResult.tool_calls?.length) {
        const fallback = "Je n'ai pas pu générer une réponse textuelle. Reformulez votre question.";
        onEvent({ type: 'token', text: fallback });
        content = fallback;
      }
      fullMessages.push({ role: 'assistant', content: content || '', tool_calls: undefined });
      onEvent({ type: 'done', content, messages: fullMessages.slice(1) });
      return;
    }

    // Tool call round — emit status label for each unique tool being called
    const uniqueTools = [...new Set(response.tool_calls.map(tc => tc.function.name))];
    const label = uniqueTools.map(n => TOOL_LABELS[n] ?? n).join(' + ');
    onEvent({ type: 'tool_call', label });

    const results = await Promise.all(
      response.tool_calls.map(async tc => {
        const args   = JSON.parse(tc.function.arguments ?? '{}');
        const result = await executeTool(tc.function.name, args, ctx);
        return { role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: JSON.stringify(result) };
      })
    );
    fullMessages.push(...results);
  }

  onEvent({ type: 'done', content: "Désolé, j'ai atteint la limite de traitement. Veuillez reformuler.", messages: fullMessages.slice(1) });
}

module.exports = { runAgentLoop, runAgentLoopStream };
