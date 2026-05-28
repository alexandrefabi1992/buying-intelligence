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

app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

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
    const conditions = ['p.matrix_id IS NOT NULL', 'p.archived = false'];
    const params     = [];

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
