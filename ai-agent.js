'use strict';
// ---------------------------------------------------------------------------
// AI Agent — tool executor + agentic loop
//
// Tools make direct SQL queries so they work regardless of cache state.
// The agentic loop is provider-agnostic: it calls createProvider().complete()
// and handles tool_calls until the model returns a final text response.
// ---------------------------------------------------------------------------

const { createProvider, SYSTEM_PROMPT } = require('./ai-provider');

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
// Tool implementations
// ---------------------------------------------------------------------------

async function toolGetBudgetRecommendations({ season, shops, limit = 20 }, { pool, budgetCache, getSeasonsConfig }) {
  season = (season ?? 'p26').toLowerCase();
  const shopIds = shops ? shops.split(',').map(s => s.trim()).filter(Boolean) : null;
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
    ? [target.sale_from, target.sale_to, shopIds]
    : [target.sale_from, target.sale_to];

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
    from = s.sale_from;
    to   = s.sale_to;
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

async function toolGetStockByVariant({ manufacturer, size, category, genre, description_search, shop_id }, { pool }) {
  const conditions = ['p.archived = false'];
  const params     = [];

  if (manufacturer) { conditions.push(`p.manufacturer ILIKE $${params.length + 1}`); params.push(`%${manufacturer}%`); }
  if (category)     { conditions.push(`p.category ILIKE $${params.length + 1}`);      params.push(`%${category}%`); }
  if (genre)        {
    conditions.push(`(p.category ILIKE $${params.length + 1} OR p.tags ILIKE $${params.length + 2} OR p.description ILIKE $${params.length + 3})`);
    params.push(`%${genre}%`, `%${genre}%`, `%${genre}%`);
  }
  if (description_search) { conditions.push(`p.description ILIKE $${params.length + 1}`); params.push(`%${description_search}%`); }
  if (size) {
    const fraction = decimalToFraction(size.trim());
    if (fraction) {
      conditions.push(`(p.description ILIKE $${params.length + 1} OR p.description ILIKE $${params.length + 2})`);
      params.push(`% ${size.trim()}%`, `% ${fraction}%`);
    } else {
      conditions.push(`p.description ILIKE $${params.length + 1}`);
      params.push(`% ${size.trim()}%`);
    }
  }
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

async function toolGetSalesByVariant({ manufacturer, size, category, genre, description_search, shop_id, period, season }, { pool, getSeasonsConfig }) {
  let from, to;
  if (period) {
    const resolved = resolvePeriod(period);
    if (resolved) [from, to] = resolved;
  }
  if (season && !from) {
    const seasons = await getSeasonsConfig();
    const s = seasons.find(x => x.code === season.toLowerCase());
    if (s) { from = s.sale_from; to = s.sale_to; }
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
  if (description_search) { conditions.push(`p.description ILIKE $${params.length + 1}`); params.push(`%${description_search}%`); }
  if (size) {
    const fraction = decimalToFraction(size.trim());
    if (fraction) {
      conditions.push(`(p.description ILIKE $${params.length + 1} OR p.description ILIKE $${params.length + 2})`);
      params.push(`% ${size.trim()}%`, `% ${fraction}%`);
    } else {
      conditions.push(`p.description ILIKE $${params.length + 1}`);
      params.push(`% ${size.trim()}%`);
    }
  }
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
  const shopIds = shops ? shops.split(',').map(s => s.trim()).filter(Boolean) : null;
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
  const params = shopIds?.length ? [s.sale_from, s.sale_to, shopIds] : [s.sale_from, s.sale_to];

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

async function toolGetSeasonsList(_, { getSeasonsConfig }) {
  const seasons = await getSeasonsConfig();
  return {
    saisons: seasons.map(s => ({
      code:          s.code,
      reception_de:  s.reception_from,
      reception_a:   s.reception_to,
      ventes_de:     s.sale_from,
      ventes_a:      s.sale_to,
    })),
  };
}

// ---------------------------------------------------------------------------
// Tool dispatcher
// ---------------------------------------------------------------------------
async function executeTool(name, args, ctx) {
  try {
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
      default:                           return { erreur: `Outil inconnu: ${name}` };
    }
  } catch (err) {
    console.error(`[ai-agent] Tool "${name}" error:`, err.message);
    return { erreur: `Erreur lors de l'exécution de l'outil "${name}": ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Agentic loop
// messages = OpenAI-format array (history from client, without system prompt)
// ctx = { pool, budgetCache, getSeasonsConfig }
// ---------------------------------------------------------------------------
async function runAgentLoop(messages, ctx) {
  const provider = createProvider();

  const now   = new Date();
  const today = now.toISOString().slice(0, 10);
  const d = (yearsBack = 0, monthsBack = 0) => {
    const dt = new Date(now);
    dt.setFullYear(dt.getFullYear() - yearsBack);
    dt.setMonth(dt.getMonth() - monthsBack);
    return dt.toISOString().slice(0, 10);
  };

  const dateContext = `\n\nDATE ACTUELLE: ${today}
RÈGLE ABSOLUE SUR LES DATES: utilise TOUJOURS le paramètre "period" pour les périodes relatives — jamais date_from/date_to calculées de ta tête.
Correspondances period: "4y"=4 ans, "3y"=3 ans, "2y"=2 ans, "1y"=1 an, "6m"=6 mois, "3m"=3 mois, "10w"=10 semaines, "ytd"=cette année, "last_year"=l'an dernier.`;

  const systemContent = SYSTEM_PROMPT + dateContext;

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

module.exports = { runAgentLoop };
