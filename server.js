console.log("STARTING");

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT',  () => process.exit(0));

console.log('[startup] Node process started, pid=%d', process.pid);

try {

require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const { Pool } = require('pg');
const fs      = require('fs');
const path    = require('path');

const app  = express();

// Railway PostgreSQL requires SSL; skip cert verification for self-signed certs
const poolConfig = { connectionString: process.env.DATABASE_URL };
if (process.env.DATABASE_URL) {
  poolConfig.ssl = { rejectUnauthorized: false };
}
const pool = new Pool(poolConfig);

// Prevent idle client errors from crashing the process.
// pg emits 'error' on the pool when a background client disconnects
// unexpectedly (e.g. Railway terminates idle SSL connections). Without
// a listener, Node.js treats this as an unhandled 'error' event and exits.
pool.on('error', (err) => {
  console.error('[pool] Unexpected idle client error:', err.message);
});

// Log unhandled promise rejections instead of crashing
process.on('unhandledRejection', (reason) => {
  console.error('[process] Unhandled rejection:', reason?.message ?? reason);
});

// ---------------------------------------------------------------------------
// In-memory TTL cache — 5-minute TTL for slow budget queries
// Key: JSON string of route + params. Auto-expires on get.
// ---------------------------------------------------------------------------
const budgetCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

function cacheGet(key) {
  const entry = budgetCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) { budgetCache.delete(key); return null; }
  return entry.data;
}

function cacheSet(key, data) {
  budgetCache.set(key, { data, expires: Date.now() + CACHE_TTL_MS });
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ---------------------------------------------------------------------------
// GET /api/test/token-rotation — verify refresh token rotation persists to DB
// Forces two consecutive token refreshes and shows before/after DB state.
// Safe to call even while a sync is running (sync has its own cached token).
// ---------------------------------------------------------------------------
app.get('/api/test/token-rotation', async (req, res, next) => {
  const TOKEN_URL = 'https://cloud.lightspeedapp.com/oauth/access_token.php';
  const results   = [];

  async function dbRefreshToken() {
    const { rows } = await pool.query(
      "SELECT next_url, updated_at FROM sync_state WHERE step = 'refresh_token'",
    );
    return rows[0] ? { token: mask(rows[0].next_url), updated_at: rows[0].updated_at } : null;
  }

  function mask(t) {
    return t ? `${t.slice(0, 6)}…${t.slice(-6)}` : null;
  }

  async function forceRefresh(label, refreshToken) {
    const { data } = await axios.post(TOKEN_URL, new URLSearchParams({
      client_id:     process.env.LIGHTSPEED_CLIENT_ID,
      client_secret: process.env.LIGHTSPEED_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    const newRefresh = data.refresh_token;
    if (newRefresh) {
      await pool.query(
        `INSERT INTO sync_state(step, next_url, updated_at)
         VALUES ('refresh_token', $1, now())
         ON CONFLICT(step) DO UPDATE SET next_url = $1, updated_at = now()`,
        [newRefresh],
      );
    }
    return { label, access_token: mask(data.access_token), new_refresh_token: mask(newRefresh), rotated: !!newRefresh };
  }

  try {
    const before = await dbRefreshToken();
    const startToken = before?.token
      ? (await pool.query("SELECT next_url FROM sync_state WHERE step='refresh_token'")).rows[0].next_url
      : process.env.LIGHTSPEED_REFRESH_TOKEN;

    results.push({ step: 'before', db: before });

    const r1 = await forceRefresh('refresh_1', startToken);
    results.push(r1);
    results.push({ step: 'after_refresh_1', db: await dbRefreshToken() });

    const r1Token = (await pool.query("SELECT next_url FROM sync_state WHERE step='refresh_token'")).rows[0]?.next_url;
    const r2 = await forceRefresh('refresh_2', r1Token);
    results.push(r2);
    results.push({ step: 'after_refresh_2', db: await dbRefreshToken() });

    res.json({ ok: true, rotation_persisted: r1.rotated && r2.rotated, steps: results });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// In-memory log ring buffer — last 500 lines from sync processes
// ---------------------------------------------------------------------------
const LOG_BUFFER_SIZE = 2000;
const logBuffer = [];
function appendLog(line) {
  logBuffer.push({ ts: new Date().toISOString(), line: line.trimEnd() });
  if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
}

app.get('/api/logs', (_req, res) => {
  res.json({ count: logBuffer.length, logs: logBuffer });
});

// ---------------------------------------------------------------------------
// Auto-migration — apply schema.sql on every startup (all statements use
// IF NOT EXISTS / ON CONFLICT so it is safe to run repeatedly)
// ---------------------------------------------------------------------------
async function runMigrations() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  // Split on statement-ending semicolons, skip empty chunks
  const statements = sql.split(/;\s*\n/).map(s => s.trim()).filter(Boolean);
  for (const stmt of statements) {
    try {
      await pool.query(stmt);
    } catch (err) {
      // CONCURRENTLY index creation fails inside a transaction; skip safely
      if (!err.message.includes('already exists')) {
        console.error('[migration] Error on statement:', err.message);
      }
    }
  }
  // Additive migration: sync_state table for checkpoint resumption
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sync_state (
      step            VARCHAR(50) PRIMARY KEY,
      next_url        TEXT,
      processed_count INTEGER DEFAULT 0,
      started_at      TIMESTAMPTZ DEFAULT now(),
      updated_at      TIMESTAMPTZ DEFAULT now()
    )
  `);
  // Additive migration: tags and image_url columns on products
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS tags      TEXT`);
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url TEXT`);
  console.log('[migration] Schema up to date');
}

// ---------------------------------------------------------------------------
// POST /api/sync/run — trigger a full Lightspeed sync on demand
// ---------------------------------------------------------------------------
let syncRunning = false;

app.post('/api/sync/run', async (req, res) => {
  if (!process.env.LIGHTSPEED_REFRESH_TOKEN) {
    return res.status(400).json({ error: 'LIGHTSPEED_REFRESH_TOKEN is not set. Complete the OAuth2 flow at /oauth/start first.' });
  }
  if (syncRunning) {
    return res.status(409).json({ status: 'sync already running' });
  }
  syncRunning = true;
  res.json({ status: 'sync started' });
  const { spawn } = require('child_process');
  const child = spawn('node', ['sync.js', '--once'], { cwd: __dirname });
  const capture = chunk => {
    const text = chunk.toString();
    process.stdout.write(text);
    text.split('\n').filter(Boolean).forEach(appendLog);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.on('close', code => {
    syncRunning = false;
    const msg = `[sync/run] exited with code ${code}`;
    console.log(msg);
    appendLog(msg);
  });
});

// ---------------------------------------------------------------------------
// OAuth2 flow — one-time setup to obtain a refresh_token
//
// 1. Open http://localhost:{PORT}/oauth/start in your browser
// 2. Authorise the app on the Lightspeed consent screen
// 3. Lightspeed redirects to /oauth/callback — your refresh_token is shown
// 4. Copy it into .env as LIGHTSPEED_REFRESH_TOKEN
//
// Requires in .env: LIGHTSPEED_CLIENT_ID, LIGHTSPEED_CLIENT_SECRET
// LIGHTSPEED_REDIRECT_URI must match what is registered in the Lightspeed
// developer portal (default: http://localhost:{PORT}/oauth/callback).
// ---------------------------------------------------------------------------
const AUTHORIZE_URL = 'https://cloud.lightspeedapp.com/oauth/authorize.php';
const TOKEN_URL     = 'https://cloud.lightspeedapp.com/oauth/access_token.php';

app.get('/oauth/start', (req, res) => {
  const redirectUri = process.env.LIGHTSPEED_REDIRECT_URI
    ?? `http://localhost:${process.env.PORT ?? 3000}/oauth/callback`;

  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     process.env.LIGHTSPEED_CLIENT_ID,
    redirect_uri:  redirectUri,
    scope:         'employee:all',
  });

  res.redirect(`${AUTHORIZE_URL}?${params}`);
});

app.get('/oauth/callback', async (req, res, next) => {
  try {
    const { code, error } = req.query;

    if (error) {
      return res.status(400).send(`<pre>Lightspeed returned an error:\n${error}</pre>`);
    }
    if (!code) {
      return res.status(400).send('<pre>Missing authorization code.</pre>');
    }

    const redirectUri = process.env.LIGHTSPEED_REDIRECT_URI
      ?? `http://localhost:${process.env.PORT ?? 3000}/oauth/callback`;

    const { data } = await axios.post(TOKEN_URL, new URLSearchParams({
      client_id:     process.env.LIGHTSPEED_CLIENT_ID,
      client_secret: process.env.LIGHTSPEED_CLIENT_SECRET,
      code,
      grant_type:    'authorization_code',
      redirect_uri:  redirectUri,
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    const { access_token, refresh_token, expires_in } = data;

    console.log('\n========== LIGHTSPEED TOKENS ==========');
    console.log('refresh_token :', refresh_token);
    console.log('access_token  :', access_token);
    console.log('expires_in    :', expires_in, 'seconds');
    console.log('=======================================\n');

    res.send(`
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>OAuth2 Success</title>
<style>
  body { font-family: monospace; max-width: 700px; margin: 60px auto; padding: 0 20px; }
  h1   { color: #2d7d46; }
  .token-box { background: #f4f4f4; border: 1px solid #ccc; padding: 16px;
               border-radius: 6px; word-break: break-all; }
  label { font-weight: bold; display: block; margin-top: 16px; }
  .note { color: #555; margin-top: 24px; font-size: 0.9em; }
</style>
</head>
<body>
  <h1>Authorization successful</h1>
  <p>Copy the <strong>refresh_token</strong> into your <code>.env</code> file
     as <code>LIGHTSPEED_REFRESH_TOKEN</code>.</p>

  <label>refresh_token</label>
  <div class="token-box">${refresh_token}</div>

  <label>access_token (short-lived, ${expires_in}s)</label>
  <div class="token-box">${access_token}</div>

  <p class="note">Both tokens have also been printed to the server console.</p>
</body>
</html>`);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// /api/nos — Never-Out-of-Stock candidates
// Items whose average weekly velocity exceeds their current stock cover.
// Returns items at risk of stockout within `weeks` weeks (default 4).
// ---------------------------------------------------------------------------
app.get('/api/nos', async (req, res, next) => {
  try {
    const weeks = parseInt(req.query.weeks ?? '4', 10);
    const { rows } = await pool.query(`
      WITH velocity AS (
        SELECT
          v.item_id,
          v.shop_id,
          AVG(v.units_sold) AS avg_weekly_units
        FROM mv_sales_velocity v
        WHERE v.week >= date_trunc('week', now()) - interval '12 weeks'
        GROUP BY v.item_id, v.shop_id
      )
      SELECT
        p.item_id,
        p.description,
        p.brand,
        p.category,
        i.shop_id,
        s.name                           AS shop_name,
        i.qty_on_hand,
        i.qty_on_order,
        ROUND(v.avg_weekly_units, 2)     AS avg_weekly_units,
        ROUND(
          CASE WHEN v.avg_weekly_units > 0
               THEN (i.qty_on_hand + i.qty_on_order) / v.avg_weekly_units
               ELSE NULL END, 1
        )                                AS weeks_of_cover,
        GREATEST(0, ROUND(
          v.avg_weekly_units * $1 - (i.qty_on_hand + i.qty_on_order), 0
        ))                               AS suggested_order_qty
      FROM velocity v
      JOIN inventory  i ON i.item_id = v.item_id AND i.shop_id = v.shop_id
      JOIN products   p ON p.item_id = v.item_id
      JOIN shops      s ON s.shop_id = i.shop_id
      WHERE v.avg_weekly_units > 0
        AND (i.qty_on_hand + i.qty_on_order) / v.avg_weekly_units < $1
        AND p.archived = false
        AND p.category    NOT ILIKE 'Alt%ration%'
        AND p.description NOT ILIKE '%shopify%'
        AND NOT (p.default_cost = 0 AND p.default_price = 0)
      ORDER BY weeks_of_cover ASC NULLS LAST, suggested_order_qty DESC
    `, [weeks]);
    res.json({ weeks_threshold: weeks, count: rows.length, items: rows });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// /api/transfers — Inter-shop transfer recommendations
// Identifies items overstocked at one shop and understocked at another.
// ---------------------------------------------------------------------------
app.get('/api/transfers', async (req, res, next) => {
  try {
    const minCover    = parseFloat(req.query.min_cover    ?? '8');   // weeks
    const maxCover    = parseFloat(req.query.max_cover    ?? '2');
    const { rows } = await pool.query(`
      WITH velocity AS (
        SELECT item_id, shop_id, AVG(units_sold) AS avg_weekly_units
        FROM mv_sales_velocity
        WHERE week >= date_trunc('week', now()) - interval '12 weeks'
        GROUP BY item_id, shop_id
      ),
      cover AS (
        SELECT
          i.item_id, i.shop_id,
          i.qty_on_hand,
          v.avg_weekly_units,
          CASE WHEN v.avg_weekly_units > 0
               THEN i.qty_on_hand / v.avg_weekly_units
               ELSE NULL END AS weeks_of_cover
        FROM inventory i
        JOIN velocity v USING (item_id, shop_id)
      )
      SELECT
        p.item_id,
        p.description,
        p.brand,
        p.category,
        over_stocked.shop_id             AS from_shop_id,
        sf.name                          AS from_shop,
        under_stocked.shop_id            AS to_shop_id,
        st.name                          AS to_shop,
        ROUND(over_stocked.qty_on_hand, 0)  AS from_qty_on_hand,
        ROUND(under_stocked.qty_on_hand, 0) AS to_qty_on_hand,
        ROUND(over_stocked.weeks_of_cover, 1)   AS from_weeks_cover,
        ROUND(under_stocked.weeks_of_cover, 1)  AS to_weeks_cover,
        ROUND(
          (over_stocked.weeks_of_cover - $1) / 2
          * over_stocked.avg_weekly_units, 0
        ) AS suggested_transfer_qty
      FROM cover over_stocked
      JOIN cover under_stocked USING (item_id)
      JOIN products p ON p.item_id = over_stocked.item_id
      JOIN shops sf   ON sf.shop_id = over_stocked.shop_id
      JOIN shops st   ON st.shop_id = under_stocked.shop_id
      WHERE over_stocked.weeks_of_cover  > $1
        AND under_stocked.weeks_of_cover < $2
        AND over_stocked.shop_id        <> under_stocked.shop_id
        AND p.archived = false
      ORDER BY suggested_transfer_qty DESC
    `, [minCover, maxCover]);
    res.json({ min_cover: minCover, max_cover: maxCover, count: rows.length, transfers: rows });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// /api/seasonal — Seasonal buying recommendations
// Compares same-period sales from prior years to forecast demand.
// ---------------------------------------------------------------------------
app.get('/api/seasonal', async (req, res, next) => {
  try {
    const weeksAhead = parseInt(req.query.weeks_ahead ?? '8', 10);
    const { rows } = await pool.query(`
      WITH target_window AS (
        SELECT
          date_trunc('week', now())                      AS start_week,
          date_trunc('week', now()) + ($1 * interval '1 week') AS end_week
      ),
      historical AS (
        SELECT
          v.item_id,
          v.shop_id,
          EXTRACT(week FROM v.week)  AS iso_week,
          AVG(v.units_sold)          AS avg_units
        FROM mv_sales_velocity v, target_window tw
        WHERE v.week >= now() - interval '2 years'
          AND EXTRACT(week FROM v.week) BETWEEN
              EXTRACT(week FROM tw.start_week) AND
              EXTRACT(week FROM tw.end_week)
        GROUP BY v.item_id, v.shop_id, EXTRACT(week FROM v.week)
      ),
      forecast AS (
        SELECT
          item_id, shop_id,
          ROUND(SUM(avg_units), 0) AS forecasted_units
        FROM historical
        GROUP BY item_id, shop_id
      )
      SELECT
        p.item_id,
        p.description,
        p.brand,
        p.category,
        f.shop_id,
        s.name              AS shop_name,
        f.forecasted_units,
        i.qty_on_hand,
        i.qty_on_order,
        GREATEST(0, f.forecasted_units - i.qty_on_hand - i.qty_on_order)
                            AS suggested_order_qty,
        ROUND(p.default_cost *
          GREATEST(0, f.forecasted_units - i.qty_on_hand - i.qty_on_order), 2
        )                   AS estimated_cost
      FROM forecast f
      JOIN inventory  i ON i.item_id = f.item_id AND i.shop_id = f.shop_id
      JOIN products   p ON p.item_id = f.item_id
      JOIN shops      s ON s.shop_id = f.shop_id
      WHERE f.forecasted_units > 0
        AND GREATEST(0, f.forecasted_units - i.qty_on_hand - i.qty_on_order) > 0
        AND p.archived = false
      ORDER BY suggested_order_qty DESC
    `, [weeksAhead]);
    res.json({ weeks_ahead: weeksAhead, count: rows.length, recommendations: rows });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// /api/sizes — Size curve analysis per product matrix and shop
// Shows which sizes sell best as a % of total matrix sales.
// ---------------------------------------------------------------------------
app.get('/api/sizes', async (req, res, next) => {
  try {
    const { matrix_id, shop_id } = req.query;
    const conditions = [
      'p.matrix_id IS NOT NULL',
      'p.archived = false',
      "p.category    NOT ILIKE 'Alt%ration%'",
      "p.description NOT ILIKE '%shopify%'",
      'NOT (p.default_cost = 0 AND p.default_price = 0)',
    ];
    const params = [];

    if (matrix_id) { params.push(matrix_id); conditions.push(`p.matrix_id = $${params.length}`); }
    if (shop_id)   { params.push(shop_id);   conditions.push(`sl.shop_id = $${params.length}`); }

    const { rows } = await pool.query(`
      WITH matrix_sales AS (
        SELECT
          p.matrix_id,
          p.item_id,
          p.description,
          sl.shop_id,
          SUM(sl.qty) AS units_sold
        FROM sale_lines sl
        JOIN products p ON p.item_id = sl.item_id
        WHERE ${conditions.join(' AND ')}
          AND sl.completed_time >= now() - interval '52 weeks'
        GROUP BY p.matrix_id, p.item_id, p.description, sl.shop_id
      ),
      matrix_totals AS (
        SELECT matrix_id, shop_id, SUM(units_sold) AS total_units
        FROM matrix_sales GROUP BY matrix_id, shop_id
      )
      SELECT
        ms.matrix_id,
        ms.item_id,
        ms.description,
        ms.shop_id,
        s.name            AS shop_name,
        ms.units_sold,
        mt.total_units,
        ROUND(ms.units_sold * 100.0 / NULLIF(mt.total_units, 0), 1) AS pct_of_matrix,
        i.qty_on_hand
      FROM matrix_sales ms
      JOIN matrix_totals mt USING (matrix_id, shop_id)
      JOIN shops         s  ON s.shop_id = ms.shop_id
      LEFT JOIN inventory i ON i.item_id = ms.item_id AND i.shop_id = ms.shop_id
      ORDER BY ms.matrix_id, ms.shop_id, pct_of_matrix DESC
    `, params);
    res.json({ count: rows.length, size_curves: rows });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// /api/budget — Buying budget summary
// Total estimated cost of all open recommendations (NOS + seasonal).
// ---------------------------------------------------------------------------
app.get('/api/budget', async (req, res, next) => {
  try {
    const weeks = parseInt(req.query.weeks ?? '4', 10);

    const { rows } = await pool.query(`
      WITH velocity AS (
        SELECT item_id, shop_id, AVG(units_sold) AS avg_weekly_units
        FROM mv_sales_velocity
        WHERE week >= date_trunc('week', now()) - interval '12 weeks'
        GROUP BY item_id, shop_id
      ),
      nos AS (
        SELECT
          i.shop_id,
          SUM(
            GREATEST(0, v.avg_weekly_units * $1 - (i.qty_on_hand + i.qty_on_order))
            * COALESCE(p.default_cost, 0)
          ) AS nos_cost
        FROM velocity v
        JOIN inventory i ON i.item_id = v.item_id AND i.shop_id = v.shop_id
        JOIN products  p ON p.item_id = v.item_id
        WHERE v.avg_weekly_units > 0
          AND (i.qty_on_hand + i.qty_on_order) / v.avg_weekly_units < $1
          AND p.archived = false
        GROUP BY i.shop_id
      )
      SELECT
        s.shop_id,
        s.name                     AS shop_name,
        ROUND(n.nos_cost, 2)       AS nos_replenishment_cost,
        ROUND(n.nos_cost * 1.15, 2) AS recommended_budget
      FROM nos n
      JOIN shops s USING (shop_id)
      ORDER BY recommended_budget DESC
    `, [weeks]);

    const total = rows.reduce((sum, r) => sum + parseFloat(r.recommended_budget ?? 0), 0);
    res.json({
      weeks_threshold: weeks,
      total_recommended_budget: Math.round(total * 100) / 100,
      by_shop: rows,
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Shared helper: aggregate manufacturer×category rows into a nested tree.
// Each manufacturer entry gets a `hypothesis` scaffold for future multipliers.
// refField is the column name carrying the reference-demand figure
// (differs between NOS and seasonal).
// ---------------------------------------------------------------------------
function buildManufacturerTree(rows, refField) {
  const map = new Map();
  for (const row of rows) {
    const budget = parseFloat(row.proposed_budget ?? 0);
    if (budget <= 0) continue;
    if (!map.has(row.manufacturer)) {
      map.set(row.manufacturer, {
        manufacturer:          row.manufacturer,
        items_count:           0,
        remaining_stock_units: 0,
        [refField]:            0,
        proposed_budget:       0,
        hypothesis:            { multiplier: 1.0, adjusted_budget: 0 },
        by_category:           [],
      });
    }
    const m = map.get(row.manufacturer);
    m.items_count           += parseInt(row.items_count ?? 0);
    m.remaining_stock_units += parseFloat(row.remaining_stock_units ?? 0);
    m[refField]             += parseFloat(row[refField] ?? 0);
    m.proposed_budget       += budget;
    m.by_category.push({
      category:              row.category,
      items_count:           parseInt(row.items_count ?? 0),
      remaining_stock_units: parseFloat(row.remaining_stock_units ?? 0),
      [refField]:            parseFloat(row[refField] ?? 0),
      proposed_budget:       budget,
    });
  }
  return Array.from(map.values())
    .map(m => {
      m.proposed_budget        = Math.round(m.proposed_budget * 100) / 100;
      m.remaining_stock_units  = Math.round(m.remaining_stock_units);
      m[refField]              = Math.round(m[refField]);
      m.hypothesis.adjusted_budget = Math.round(m.proposed_budget * m.hypothesis.multiplier * 100) / 100;
      return m;
    })
    .sort((a, b) => b.proposed_budget - a.proposed_budget);
}

// ---------------------------------------------------------------------------
// GET /api/budget/nos — NOS buying budget by manufacturer + category drill-down
// Filter: products where tags ILIKE '%nos%'
// Reference demand: 12-week average weekly velocity
// Shortage: MAX(0, avg_weekly × weeks_target − current_stock) × default_cost
// ?weeks=4 → coverage target in weeks (default 4)
// ---------------------------------------------------------------------------
app.get('/api/budget/nos', async (req, res, next) => {
  try {
    const weeks  = parseInt(req.query.weeks ?? '4', 10);

    const shops = req.query.shops       ? req.query.shops.split(',').filter(Boolean)                                  : null;
    const colls = req.query.collections ? req.query.collections.split(',').map(s => s.toLowerCase().trim()).filter(Boolean) : null;
    const sizes = req.query.sizes       ? req.query.sizes.split(',').filter(Boolean)                                  : null;

    const cacheKey = JSON.stringify({ r: 'nos', weeks, shops, colls, sizes });
    const hit = cacheGet(cacheKey);
    if (hit) return res.json({ ...hit, cached: true });

    const params = [weeks]; // $1
    let shopCond = '', collCond = '', sizeCond = '';
    if (shops?.length) { params.push(shops);                                          shopCond = `AND i.shop_id = ANY($${params.length})`; }
    if (colls?.length) { params.push(colls);                                          collCond = `AND string_to_array(lower(coalesce(p.tags,'')), ',') && $${params.length}::text[]`; }
    if (sizes?.length) { params.push('\\y(' + sizes.join('|') + ')\\y');             sizeCond = `AND p.description ~* $${params.length}`; }

    const { rows } = await pool.query(`
      WITH velocity AS (
        SELECT item_id, shop_id, AVG(units_sold) AS avg_weekly_units
        FROM mv_sales_velocity
        WHERE week >= date_trunc('week', now()) - INTERVAL '12 weeks'
        GROUP BY item_id, shop_id
      ),
      shortage AS (
        SELECT
          COALESCE(p.manufacturer, 'Sans marque')                           AS manufacturer,
          COALESCE(p.category,     'Sans catégorie')                        AS category,
          p.item_id,
          COALESCE(i.qty_on_hand, 0) + COALESCE(i.qty_on_order, 0)        AS current_stock,
          v.avg_weekly_units * 12                                            AS ref_units_12w,
          GREATEST(0,
            v.avg_weekly_units * $1
            - (COALESCE(i.qty_on_hand, 0) + COALESCE(i.qty_on_order, 0))
          )                                                                  AS shortage_units,
          COALESCE(p.default_cost, 0)                                       AS unit_cost
        FROM products p
        JOIN velocity  v ON v.item_id = p.item_id
        JOIN inventory i ON i.item_id = p.item_id AND i.shop_id = v.shop_id
        WHERE p.tags ILIKE '%nos%'
          AND p.archived = false
          AND v.avg_weekly_units > 0
          AND p.category    NOT ILIKE 'Alt%ration%'
          AND p.description NOT ILIKE '%shopify%'
          AND NOT (p.default_cost = 0 AND p.default_price = 0)
          ${shopCond}
          ${collCond}
          ${sizeCond}
      )
      SELECT
        manufacturer,
        category,
        COUNT(DISTINCT item_id)::int                       AS items_count,
        ROUND(SUM(current_stock),              0)::float8  AS remaining_stock_units,
        ROUND(SUM(ref_units_12w),              0)::float8  AS reference_units_12w,
        ROUND(SUM(shortage_units * unit_cost), 2)::float8  AS proposed_budget
      FROM shortage
      GROUP BY manufacturer, category
      ORDER BY manufacturer, proposed_budget DESC
    `, params);

    const byManufacturer = buildManufacturerTree(rows, 'reference_units_12w');
    const total = byManufacturer.reduce((s, m) => s + m.proposed_budget, 0);

    const result = {
      weeks_target:          weeks,
      generated_at:          new Date().toISOString(),
      total_proposed_budget: Math.round(total * 100) / 100,
      manufacturer_count:    byManufacturer.length,
      by_manufacturer:       byManufacturer,
    };
    cacheSet(cacheKey, result);
    res.json(result);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/budget/saisonnier — Seasonal buying budget by manufacturer + category
// Filter: products where tags IS NULL OR tags NOT ILIKE '%nos%'
// Reference demand: units sold in the same N-week window 52 weeks ago
// Shortage: MAX(0, units_last_year − current_stock_all_shops) × default_cost
// ?weeks=8 → season horizon in weeks (default 8)
// ---------------------------------------------------------------------------
app.get('/api/budget/saisonnier', async (req, res, next) => {
  try {
    const weeks  = parseInt(req.query.weeks ?? '8', 10);

    const shops = req.query.shops       ? req.query.shops.split(',').filter(Boolean)                                  : null;
    const colls = req.query.collections ? req.query.collections.split(',').map(s => s.toLowerCase().trim()).filter(Boolean) : null;
    const sizes = req.query.sizes       ? req.query.sizes.split(',').filter(Boolean)                                  : null;

    const cacheKey = JSON.stringify({ r: 'saisonnier', weeks, shops, colls, sizes });
    const hit = cacheGet(cacheKey);
    if (hit) return res.json({ ...hit, cached: true });

    const params = [weeks]; // $1
    let shopCondSL = '', shopCondInv = '', collCond = '', sizeCond = '';
    if (shops?.length) {
      params.push(shops);
      const n = params.length;
      shopCondSL  = `AND sl.shop_id = ANY($${n})`;
      shopCondInv = `AND shop_id    = ANY($${n})`;
    }
    if (colls?.length) { params.push(colls);                                          collCond = `AND string_to_array(lower(coalesce(p.tags,'')), ',') && $${params.length}::text[]`; }
    if (sizes?.length) { params.push('\\y(' + sizes.join('|') + ')\\y');             sizeCond = `AND p.description ~* $${params.length}`; }

    // Without shop filter: use pre-aggregated MV (eliminates 412ms inventory HashAggregate).
    // With shop filter: aggregate only the requested shops inline.
    const stockCTE = shops?.length
      ? `stock AS (
           SELECT item_id,
                  SUM(COALESCE(qty_on_hand, 0) + COALESCE(qty_on_order, 0)) AS current_stock
           FROM inventory
           WHERE 1=1 ${shopCondInv}
           GROUP BY item_id
         )`
      : `stock AS (SELECT item_id, current_stock_all AS current_stock FROM mv_inventory_stock)`;

    const [rangeResult, budgetResult] = await Promise.all([
      pool.query(`
        SELECT
          MIN(completed_time)::date AS min_date,
          MAX(completed_time)::date AS max_date,
          COUNT(*)::int             AS total_lines
        FROM sale_lines
        WHERE completed_time IS NOT NULL
      `),
      pool.query(`
        WITH last_year AS (
          SELECT
            sl.item_id,
            SUM(sl.qty) AS units_sold_ly
          FROM sale_lines sl
          WHERE sl.completed_time >= now() - INTERVAL '52 weeks'
            AND sl.completed_time <  now() - INTERVAL '52 weeks'
                                     + ($1 || ' weeks')::interval
            AND sl.qty > 0
            AND sl.completed_time IS NOT NULL
            ${shopCondSL}
          GROUP BY sl.item_id
        ),
        ${stockCTE}
        SELECT
          COALESCE(p.manufacturer, 'Sans marque')    AS manufacturer,
          COALESCE(p.category,     'Sans catégorie') AS category,
          COUNT(DISTINCT p.item_id)::int             AS items_count,
          ROUND(SUM(COALESCE(st.current_stock, 0)), 0)::float8   AS remaining_stock_units,
          ROUND(SUM(ly.units_sold_ly), 0)::float8                AS reference_units_sold,
          ROUND(SUM(
            GREATEST(0, ly.units_sold_ly - COALESCE(st.current_stock, 0))
            * COALESCE(p.default_cost, 0)
          ), 2)::float8                              AS proposed_budget
        FROM products p
        JOIN last_year ly ON ly.item_id = p.item_id
        LEFT JOIN stock st ON st.item_id = p.item_id
        WHERE (p.tags IS NULL OR p.tags NOT ILIKE '%nos%')
          AND p.archived = false
          AND p.default_cost > 0
          AND p.category    NOT ILIKE 'Alt%ration%'
          AND p.description NOT ILIKE '%shopify%'
          AND NOT (p.default_cost = 0 AND p.default_price = 0)
          ${collCond}
          ${sizeCond}
        GROUP BY p.manufacturer, p.category
        ORDER BY p.manufacturer, proposed_budget DESC
      `, params),
    ]);

    const range    = rangeResult.rows[0];
    const refStart = new Date(Date.now() - 52 * 7 * 24 * 60 * 60 * 1000);
    const refEnd   = new Date(refStart.getTime() + weeks * 7 * 24 * 60 * 60 * 1000);

    const byManufacturer = buildManufacturerTree(budgetResult.rows, 'reference_units_sold');
    const total = byManufacturer.reduce((s, m) => s + m.proposed_budget, 0);

    const result = {
      weeks_horizon:         weeks,
      reference_period:      {
        from: refStart.toISOString().slice(0, 10),
        to:   refEnd.toISOString().slice(0, 10),
      },
      sales_data_range:      {
        min_date:    range.min_date,
        max_date:    range.max_date,
        total_lines: range.total_lines,
      },
      generated_at:          new Date().toISOString(),
      total_proposed_budget: Math.round(total * 100) / 100,
      manufacturer_count:    byManufacturer.length,
      by_manufacturer:       byManufacturer,
    };
    cacheSet(cacheKey, result);
    res.json(result);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/admin/checkpoint — manually upsert a sync_state row
// Body: { step, status: "completed"|"pending", processed_count? }
// ---------------------------------------------------------------------------
app.post('/api/admin/checkpoint', async (req, res, next) => {
  try {
    const { step, status, processed_count = 0 } = req.body;
    if (!step) return res.status(400).json({ error: 'step is required' });

    if (status === 'pending') {
      await pool.query('DELETE FROM sync_state WHERE step = $1', [step]);
      return res.json({ ok: true, step, action: 'deleted' });
    }

    const nextUrl = status === 'completed' ? 'COMPLETED' : null;
    await pool.query(
      `INSERT INTO sync_state(step, next_url, processed_count, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT(step) DO UPDATE
         SET next_url = $2, processed_count = $3, updated_at = now()`,
      [step, nextUrl, processed_count],
    );
    const { rows } = await pool.query(
      'SELECT * FROM sync_state WHERE step = $1', [step],
    );
    res.json({ ok: true, row: rows[0] });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/token/status — show current refresh token state in DB vs env var
// ---------------------------------------------------------------------------
app.get('/api/token/status', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT next_url, updated_at FROM sync_state WHERE step = 'refresh_token'",
    );
    const dbRow    = rows[0] ?? null;
    const dbToken  = dbRow?.next_url ?? null;
    const envToken = process.env.LIGHTSPEED_REFRESH_TOKEN ?? null;
    const mask     = t => t ? `${t.slice(0, 6)}…${t.slice(-6)}` : null;
    res.json({
      db_token:        mask(dbToken),
      db_updated_at:   dbRow?.updated_at ?? null,
      env_token:       mask(envToken),
      tokens_match:    dbToken === envToken,
      db_is_primary:   !!dbToken,
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/sync/checkpoints — full sync_state table (excluding token row)
// ---------------------------------------------------------------------------
app.get('/api/sync/checkpoints', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT step, next_url, processed_count, started_at, updated_at
       FROM sync_state
       WHERE step != 'refresh_token'
       ORDER BY updated_at DESC NULLS LAST`,
    );
    const formatted = rows.map(r => ({
      step:            r.step,
      status:          r.next_url === 'COMPLETED' ? 'completed' : r.next_url ? 'in_progress' : 'pending',
      next_url:        r.next_url === 'COMPLETED' ? null : r.next_url,
      processed_count: r.processed_count,
      updated_at:      r.updated_at,
    }));
    res.json({ count: formatted.length, checkpoints: formatted });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/admin/query — run a whitelisted COUNT query (debug only)
// ---------------------------------------------------------------------------
app.get('/api/admin/query', async (req, res, next) => {
  try {
    const ALLOWED = [
      'SELECT COUNT(*) FROM sale_lines',
      'SELECT COUNT(*) FROM mv_sales_velocity',
      'SELECT COUNT(*) FROM sales',
      'SELECT COUNT(*) FROM products',
      'SELECT COUNT(*) FROM inventory',
      'SELECT COUNT(*) FROM shops',
      'SELECT COUNT(*) FROM sale_lines WHERE completed_time IS NOT NULL',
      'SELECT COUNT(*) FROM sales WHERE completed_time IS NOT NULL',
      "SELECT jsonb_object_keys(raw) AS key FROM products LIMIT 1",
      "SELECT jsonb_object_keys(raw) AS key FROM products GROUP BY key ORDER BY key",
    ];
    const q = (req.query.q ?? '').trim();
    if (!ALLOWED.includes(q)) return res.status(400).json({ error: 'query not whitelisted', allowed: ALLOWED });
    const { rows } = await pool.query(q);
    res.json({ query: q, count: rows[0].count });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/admin/ls-inspect — fetch first page of a Lightspeed reference endpoint
// Usage: /api/admin/ls-inspect?resource=Category|Department|Manufacturer|ItemTag
// ---------------------------------------------------------------------------
app.get('/api/admin/ls-inspect', async (req, res, next) => {
  try {
    const resource = req.query.resource;
    const ALLOWED_RESOURCES = ['Category', 'Department', 'Manufacturer', 'ItemTag', 'Images'];
    if (!ALLOWED_RESOURCES.includes(resource)) {
      return res.status(400).json({ error: 'resource must be one of: ' + ALLOWED_RESOURCES.join(', ') });
    }

    const BASE_URL = `https://api.lightspeedapp.com/API/V3/Account/${process.env.LIGHTSPEED_ACCOUNT_ID}`;
    const TOKEN_URL = 'https://cloud.lightspeedapp.com/oauth/access_token.php';

    // Get current refresh token from DB
    const { rows } = await pool.query("SELECT next_url FROM sync_state WHERE step = 'refresh_token'");
    const refreshToken = rows[0]?.next_url ?? process.env.LIGHTSPEED_REFRESH_TOKEN;

    // Exchange for access token
    const tokenResp = await axios.post(TOKEN_URL, new URLSearchParams({
      client_id:     process.env.LIGHTSPEED_CLIENT_ID,
      client_secret: process.env.LIGHTSPEED_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    const accessToken = tokenResp.data.access_token;
    // Persist rotated refresh token
    if (tokenResp.data.refresh_token) {
      await pool.query(
        `INSERT INTO sync_state(step, next_url, updated_at) VALUES ('refresh_token', $1, now())
         ON CONFLICT(step) DO UPDATE SET next_url=$1, updated_at=now()`,
        [tokenResp.data.refresh_token],
      );
    }

    // ItemTag is a relation on Item, not a standalone endpoint
    let url, resp;
    if (resource === 'Images') {
      const params = new URLSearchParams({ limit: '5', load_relations: '["Images"]' });
      url = `${BASE_URL}/Item.json?${params}`;
      resp = await axios.get(url, { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 30000 });
      const items = resp.data.Item ?? [];
      const sample = items.map(i => ({
        itemID:      i.itemID,
        description: i.description,
        Images:      i.Images,
      }));
      return res.json({ resource, url, sample });
    } else if (resource === 'ItemTag') {
      // Try multiple load_relations formats to find what Lightspeed accepts
      // load_relations=all to discover all available relations and tag fields
      url = `${BASE_URL}/Item.json?limit=5&load_relations=all`;
      resp = await axios.get(url, { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 30000 });
      const items = resp.data.Item ?? [];
      // Show full keys available on each item (to find tag-related fields)
      const keySummary = items.length > 0 ? Object.keys(items[0]).sort() : [];
      // Show items where any key looks tag-related
      const tagKeys = keySummary.filter(k => /tag|Tag|label|Label/i.test(k));
      const sample = items.slice(0, 3).map(i => {
        const obj = { itemID: i.itemID, description: i.description };
        tagKeys.forEach(k => { obj[k] = i[k]; });
        // Also show non-false relation values
        for (const k of Object.keys(i)) {
          if (i[k] && typeof i[k] === 'object' && !Array.isArray(i[k])) obj['_rel_' + k] = i[k];
        }
        return obj;
      });
      return res.json({ resource, url, all_keys: keySummary, tag_related_keys: tagKeys, sample });
    } else {
      url = `${BASE_URL}/${resource}.json?limit=5`;
      resp = await axios.get(url, { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 30000 });
      res.json({ resource, url, data: resp.data });
    }
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/admin/products-audit — show products table structure + null stats + sample
// ---------------------------------------------------------------------------
app.get('/api/admin/products-audit', async (req, res, next) => {
  try {
    // Column-level NULL audit
    const { rows: nulls } = await pool.query(`
      SELECT
        COUNT(*)                                          AS total,
        COUNT(description)                                AS has_description,
        COUNT(brand)                                      AS has_brand,
        COUNT(category)                                   AS has_category,
        COUNT(department)                                 AS has_department,
        COUNT(manufacturer)                               AS has_manufacturer,
        COUNT(tags)                                       AS has_tags,
        COUNT(image_url)                                  AS has_image_url,
        COUNT(matrix_id) FILTER (WHERE matrix_id != '0') AS has_matrix_id,
        COUNT(default_cost)                               AS has_default_cost,
        COUNT(default_price)                              AS has_default_price,
        COUNT(ean)                                        AS has_ean,
        COUNT(upc)                                        AS has_upc
      FROM products
    `);

    // Sample row — pick one with most fields filled
    const { rows: samples } = await pool.query(`
      SELECT item_id, matrix_id, description, brand, category, department,
             manufacturer, default_cost, default_price, ean, upc, archived,
             jsonb_object_keys(raw) AS raw_key
      FROM products
      LIMIT 1
    `);

    // Full sample row with raw keys list
    const { rows: fullSample } = await pool.query(`
      SELECT item_id, matrix_id, description, brand, category, department,
             manufacturer, tags, image_url,
             default_cost, default_price, ean, upc, archived,
             array(SELECT jsonb_object_keys(raw) ORDER BY 1) AS raw_keys,
             raw->>'categoryID'   AS category_id,
             raw->>'departmentID' AS department_id
      FROM products
      ORDER BY item_id
      LIMIT 3
    `);

    // Check what category/brand/manufacturer look like in raw (are they objects?)
    const { rows: catSample } = await pool.query(`
      SELECT item_id, category, raw->'Category' AS raw_cat, raw->>'categoryID' AS cat_id
      FROM products
      WHERE category IS NOT NULL
      LIMIT 3
    `);

    res.json({
      schema_columns: ['item_id','matrix_id','description','brand','category','department',
                        'manufacturer','default_cost','default_price','ean','upc','archived','raw','synced_at'],
      null_audit: nulls[0],
      sample_rows: fullSample,
      category_sample: catSample,
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/admin/validate — post-sync data validation
// ---------------------------------------------------------------------------
app.get('/api/admin/validate', async (req, res, next) => {
  try {
    const [nosCount, imageCount, topManufacturers, categories, sampleFull] = await Promise.all([
      // 1. Articles avec tag NOS
      pool.query(`
        SELECT COUNT(*) AS nos_items,
               COUNT(DISTINCT manufacturer) AS nos_manufacturers
        FROM products
        WHERE tags ILIKE '%NOS%'
          AND archived = false
      `),
      // 2. Articles avec image_url
      pool.query(`
        SELECT COUNT(image_url)                           AS with_image,
               COUNT(*) FILTER (WHERE image_url IS NULL) AS without_image,
               ROUND(COUNT(image_url) * 100.0 / NULLIF(COUNT(*), 0), 1) AS pct_with_image
        FROM products WHERE archived = false
      `),
      // 3. Top 20 manufacturers par nb d'articles vendus (via sale_lines)
      pool.query(`
        SELECT p.manufacturer,
               COUNT(DISTINCT p.item_id)  AS nb_articles,
               ROUND(SUM(sl.qty)::numeric, 0) AS units_sold
        FROM products p
        JOIN sale_lines sl ON sl.item_id = p.item_id
        WHERE p.manufacturer IS NOT NULL
          AND sl.completed_time >= now() - interval '52 weeks'
        GROUP BY p.manufacturer
        ORDER BY units_sold DESC
        LIMIT 20
      `),
      // 4. Catégories distinctes (niveau feuille du fullPath)
      pool.query(`
        SELECT category,
               COUNT(DISTINCT item_id) AS nb_articles
        FROM products
        WHERE category IS NOT NULL
          AND archived = false
        GROUP BY category
        ORDER BY nb_articles DESC
        LIMIT 50
      `),
      // 5. 3 exemples complets
      pool.query(`
        SELECT p.item_id, p.description, p.manufacturer, p.category,
               p.tags, p.image_url, p.default_cost, p.default_price, p.archived
        FROM products p
        WHERE p.tags IS NOT NULL
          AND p.image_url IS NOT NULL
          AND p.manufacturer IS NOT NULL
          AND p.category IS NOT NULL
          AND p.archived = false
        ORDER BY p.item_id
        LIMIT 3
      `),
    ]);

    res.json({
      nos:          { ...nosCount.rows[0] },
      images:       { ...imageCount.rows[0] },
      top_manufacturers: topManufacturers.rows,
      categories:   categories.rows,
      sample_full:  sampleFull.rows,
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/admin/raw-sample — inspect JSONB keys and tag structure in products
// ---------------------------------------------------------------------------
app.get('/api/admin/raw-sample', async (req, res, next) => {
  try {
    // Top-level keys present in products.raw
    const { rows: keys } = await pool.query(`
      SELECT jsonb_object_keys(raw) AS key, COUNT(*) AS cnt
      FROM products
      GROUP BY key ORDER BY cnt DESC
    `);

    // Sample of the raw field to see tag structure
    const { rows: samples } = await pool.query(`
      SELECT item_id, description, raw
      FROM products
      WHERE raw IS NOT NULL
      ORDER BY item_id
      LIMIT 2
    `);

    // Try common tag paths
    const tagPaths = [
      { path: "raw->'Tags'",       label: "raw->Tags" },
      { path: "raw->'tag'",        label: "raw->tag" },
      { path: "raw->'ItemTag'",    label: "raw->ItemTag" },
      { path: "raw->'itemTags'",   label: "raw->itemTags" },
      { path: "raw->'Tags'->'tag'", label: "raw->Tags->tag" },
    ];
    const tagCounts = {};
    for (const { path, label } of tagPaths) {
      const { rows } = await pool.query(
        `SELECT COUNT(*) FROM products WHERE ${path} IS NOT NULL AND ${path}::text != 'false' AND ${path}::text != 'null'`
      );
      tagCounts[label] = rows[0].count;
    }

    res.json({
      top_level_keys: keys,
      tag_path_counts: tagCounts,
      sample_raw: samples.map(s => ({ item_id: s.item_id, description: s.description, raw: s.raw })),
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/admin/inspect-filters — audit tag tokens, size patterns, parasites
app.get('/api/admin/inspect-filters', async (req, res, next) => {
  try {
    const [tagTokens, descSizes, parasites, shops] = await Promise.all([
      // Distinct tag tokens and their frequency
      pool.query(`
        SELECT tag, COUNT(*) AS cnt
        FROM (
          SELECT trim(t) AS tag
          FROM products, unnest(string_to_array(tags, ',')) AS t
          WHERE tags IS NOT NULL
        ) sub
        WHERE tag != ''
        GROUP BY tag
        ORDER BY cnt DESC
        LIMIT 80
      `),
      // Descriptions containing size-like tokens (letters+digits or common sizes)
      pool.query(`
        SELECT description, category, manufacturer, tags
        FROM products
        WHERE (
          description ~* '\\y(XS|S|M|L|XL|XXL|XXXL)\\y'
          OR description ~* '\\y(3[0-9]|4[0-9]|5[0-9])\\y'
          OR description ~ '[0-9]{2}$'
        )
        AND archived = false
        LIMIT 40
      `),
      // Parasite candidates
      pool.query(`
        SELECT item_id, description, category, default_cost, default_price, tags
        FROM products
        WHERE (
          category ILIKE '%alt%ration%'
          OR description ILIKE '%shopify%'
          OR (default_cost = 0 AND default_price = 0)
        )
        AND archived = false
        LIMIT 30
      `),
      // Shops list
      pool.query(`SELECT shop_id, name FROM shops ORDER BY name`),
    ]);

    res.json({
      tag_tokens:      tagTokens.rows,
      desc_size_sample: descSizes.rows,
      parasite_sample:  parasites.rows,
      shops:            shops.rows,
    });
  } catch (err) { next(err); }
});

// GET /api/admin/explain — EXPLAIN ANALYZE on the two slow budget queries
// ---------------------------------------------------------------------------
app.get('/api/admin/explain', async (req, res, next) => {
  try {
    const nosQuery = `
      WITH velocity AS (
        SELECT item_id, shop_id, AVG(units_sold) AS avg_weekly_units
        FROM mv_sales_velocity
        WHERE week >= date_trunc('week', now()) - INTERVAL '12 weeks'
        GROUP BY item_id, shop_id
      ),
      shortage AS (
        SELECT
          COALESCE(p.manufacturer, 'Sans marque') AS manufacturer,
          COALESCE(p.category, 'Sans catégorie')  AS category,
          p.item_id,
          COALESCE(i.qty_on_hand, 0) + COALESCE(i.qty_on_order, 0)      AS current_stock,
          v.avg_weekly_units * 12                                          AS ref_units_12w,
          GREATEST(0,
            v.avg_weekly_units * 4
            - (COALESCE(i.qty_on_hand, 0) + COALESCE(i.qty_on_order, 0))
          )                                                                AS shortage_units,
          COALESCE(p.default_cost, 0)                                      AS unit_cost
        FROM products p
        JOIN velocity  v ON v.item_id = p.item_id
        JOIN inventory i ON i.item_id = p.item_id AND i.shop_id = v.shop_id
        WHERE p.tags ILIKE '%nos%'
          AND p.archived = false
          AND v.avg_weekly_units > 0
          AND p.category    NOT ILIKE 'Alt%ration%'
          AND p.description NOT ILIKE '%shopify%'
          AND NOT (p.default_cost = 0 AND p.default_price = 0)
      )
      SELECT manufacturer, category,
             COUNT(DISTINCT item_id)::int            AS items_count,
             ROUND(SUM(current_stock), 0)::float8    AS remaining_stock_units,
             ROUND(SUM(ref_units_12w), 0)::float8    AS reference_units_12w,
             ROUND(SUM(shortage_units * unit_cost), 2)::float8 AS proposed_budget
      FROM shortage
      GROUP BY manufacturer, category
      ORDER BY manufacturer, proposed_budget DESC
    `;

    const saisQuery = `
      WITH last_year AS (
        SELECT sl.item_id, SUM(sl.qty) AS units_sold_ly
        FROM sale_lines sl
        WHERE sl.completed_time >= now() - INTERVAL '52 weeks'
          AND sl.completed_time <  now() - INTERVAL '52 weeks' + ('8 weeks')::interval
          AND sl.qty > 0
          AND sl.completed_time IS NOT NULL
        GROUP BY sl.item_id
      ),
      stock AS (SELECT item_id, current_stock_all AS current_stock FROM mv_inventory_stock)
      SELECT
        COALESCE(p.manufacturer, 'Sans marque') AS manufacturer,
        COALESCE(p.category, 'Sans catégorie')  AS category,
        COUNT(DISTINCT p.item_id)::int           AS items_count,
        ROUND(SUM(COALESCE(st.current_stock, 0)), 0)::float8 AS remaining_stock_units,
        ROUND(SUM(ly.units_sold_ly), 0)::float8              AS reference_units_sold,
        ROUND(SUM(
          GREATEST(0, ly.units_sold_ly - COALESCE(st.current_stock, 0))
          * COALESCE(p.default_cost, 0)
        ), 2)::float8 AS proposed_budget
      FROM products p
      JOIN last_year ly ON ly.item_id = p.item_id
      LEFT JOIN stock st ON st.item_id = p.item_id
      WHERE (p.tags IS NULL OR p.tags NOT ILIKE '%nos%')
        AND p.archived = false
        AND p.default_cost > 0
        AND p.category    NOT ILIKE 'Alt%ration%'
        AND p.description NOT ILIKE '%shopify%'
        AND NOT (p.default_cost = 0 AND p.default_price = 0)
      GROUP BY p.manufacturer, p.category
      ORDER BY p.manufacturer, proposed_budget DESC
    `;

    const [nosExpl, saisExpl] = await Promise.all([
      pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${nosQuery}`),
      pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${saisQuery}`),
    ]);

    res.json({
      nos:       nosExpl.rows[0]['QUERY PLAN'],
      saisonnier: saisExpl.rows[0]['QUERY PLAN'],
    });
  } catch (err) { next(err); }
});

// POST /api/admin/refresh-view — force refresh mv_sales_velocity
// ---------------------------------------------------------------------------
app.post('/api/admin/refresh-view', async (req, res, next) => {
  try {
    await pool.query('REFRESH MATERIALIZED VIEW mv_sales_velocity');
    const { rows } = await pool.query('SELECT COUNT(*) FROM mv_sales_velocity');
    res.json({ ok: true, mv_sales_velocity_count: rows[0].count });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

const PORT = parseInt(process.env.PORT ?? '3000', 10);
console.log('[startup] PORT=%d DATABASE_URL=%s', PORT, process.env.DATABASE_URL ? 'set' : 'NOT SET');
app.listen(PORT, '0.0.0.0', () => {
  console.log('[startup] Listening on 0.0.0.0:%d', PORT);
  runMigrations().catch(err => console.error('[migration] Fatal:', err.message));
});

} catch (err) {
  console.error('Fatal error during startup:', err);
  process.exit(1);
}
