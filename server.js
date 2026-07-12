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
const { runAgentLoop } = require('./ai-agent');

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
// Multiplier tiers — default values; overridden by app_settings DB table.
// Each tier: { st_min: 0–1, multiplier: number, label: string }
// Tiers are checked highest-to-lowest; first match wins.
// ---------------------------------------------------------------------------
const DEFAULT_MULTIPLIER_TIERS = [
  { st_min: 0.80, multiplier: 1.25, label: 'Augmenter'     },
  { st_min: 0.65, multiplier: 1.10, label: 'Légère hausse' },
  { st_min: 0.50, multiplier: 1.00, label: 'Reconduire'    },
  { st_min: 0.35, multiplier: 0.80, label: 'Réduire'       },
  { st_min: 0.00, multiplier: 0.50, label: 'Couper'        },
];

async function getMultiplierTiers() {
  try {
    const { rows } = await pool.query(
      "SELECT value FROM app_settings WHERE key = 'multiplier_tiers'"
    );
    if (rows.length && Array.isArray(rows[0].value)) return rows[0].value;
  } catch {}
  return DEFAULT_MULTIPLIER_TIERS;
}

function applyMultiplierTiers(st, tiers) {
  if (st === null || st === undefined || isNaN(st)) {
    return { multiplier: 1.00, label: 'Reconduire', tier_threshold: null };
  }
  const sorted = [...tiers].sort((a, b) => b.st_min - a.st_min);
  for (const tier of sorted) {
    if (st >= tier.st_min) {
      const threshold = tier.st_min > 0
        ? `ST ≥ ${Math.round(tier.st_min * 100)}%`
        : `ST < ${Math.round((sorted[sorted.length - 2]?.st_min ?? 0.35) * 100)}%`;
      return { multiplier: tier.multiplier, label: tier.label, tier_threshold: threshold };
    }
  }
  const last = sorted[sorted.length - 1];
  return { multiplier: last.multiplier, label: last.label, tier_threshold: 'repli' };
}

// ---------------------------------------------------------------------------
// Seasons config and budget params — defaults; overridden by app_settings DB table.
// Each season: { code, label, reception_from, reception_to, sell_from, sell_to, tag_pattern }
// ---------------------------------------------------------------------------
const DEFAULT_SEASONS_CONFIG = [
  { code:'p23', label:'P23 — Printemps 2023', reception_from:'2022-10-01', reception_to:'2023-09-30', sell_from:'2023-02-01', sell_to:'2023-09-30', tag_pattern:'p23' },
  { code:'a23', label:'A23 — Automne 2023',   reception_from:'2023-05-01', reception_to:'2024-02-28', sell_from:'2023-09-01', sell_to:'2024-02-28', tag_pattern:'a23' },
  { code:'p24', label:'P24 — Printemps 2024', reception_from:'2023-10-01', reception_to:'2024-09-30', sell_from:'2024-02-01', sell_to:'2024-09-30', tag_pattern:'p24' },
  { code:'a24', label:'A24 — Automne 2024',   reception_from:'2024-05-01', reception_to:'2025-02-28', sell_from:'2024-09-01', sell_to:'2025-02-28', tag_pattern:'a24' },
  { code:'p25', label:'P25 — Printemps 2025', reception_from:'2024-10-01', reception_to:'2025-09-30', sell_from:'2025-02-01', sell_to:'2025-09-30', tag_pattern:'p25' },
  { code:'a25', label:'A25 — Automne 2025',   reception_from:'2025-05-01', reception_to:'2026-02-28', sell_from:'2025-09-01', sell_to:'2026-02-28', tag_pattern:'a25' },
  { code:'p26', label:'P26 — Printemps 2026', reception_from:'2025-10-01', reception_to:'2026-09-30', sell_from:'2026-02-01', sell_to:'2026-09-30', tag_pattern:'p26' },
  { code:'a26', label:'A26 — Automne 2026',   reception_from:'2026-05-01', reception_to:'2027-02-28', sell_from:'2026-09-01', sell_to:'2027-02-28', tag_pattern:'a26' },
  { code:'p27', label:'P27 — Printemps 2027', reception_from:'2026-10-01', reception_to:'2027-09-30', sell_from:'2027-02-01', sell_to:'2027-09-30', tag_pattern:'p27' },
  { code:'a27', label:'A27 — Automne 2027',   reception_from:'2027-05-01', reception_to:'2028-02-28', sell_from:'2027-09-01', sell_to:'2028-02-28', tag_pattern:'a27' },
];

const DEFAULT_BUDGET_PARAMS = {
  nb_saisons_reference:       3,
  carryover_deduction_rate:   0.50,
  use_global_carryover_rate:  true,
  carryover_rates_by_shop:    {},
  recency_factor:             2.0,
  absent_brand_mode:          'show', // 'show' = afficher avec badge | 'hide' = masquer
};

async function getTenantConfig() {
  try {
    const { rows } = await pool.query("SELECT value FROM app_settings WHERE key = 'tenant_config'");
    if (rows.length && rows[0].value) return rows[0].value;
  } catch {}
  return {};
}

async function getSeasonsConfig() {
  try {
    const { rows } = await pool.query("SELECT value FROM app_settings WHERE key = 'seasons_config'");
    if (rows.length && Array.isArray(rows[0].value) && rows[0].value.length > 0) return rows[0].value;
  } catch {}
  return DEFAULT_SEASONS_CONFIG;
}

async function getBudgetParams() {
  try {
    const { rows } = await pool.query("SELECT value FROM app_settings WHERE key = 'budget_params'");
    if (rows.length && rows[0].value && typeof rows[0].value === 'object') {
      return { ...DEFAULT_BUDGET_PARAMS, ...rows[0].value };
    }
  } catch {}
  return { ...DEFAULT_BUDGET_PARAMS };
}

function getReferenceSeasonsFromConfig(targetCode, config, n) {
  const type = targetCode[0];
  const year = parseInt(targetCode.slice(1), 10);
  const result = [];
  for (let y = year - 1; y >= year - 10 && result.length < n; y--) {
    const s = config.find(c => c.code === `${type}${y}`);
    if (s) result.push(s);
  }
  return result;
}

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

app.use(express.json({ limit: '25mb' }));
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

  // app_settings: key/value store for editable config (multiplier tiers, etc.)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key        TEXT PRIMARY KEY,
      value      JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now()
    )
  `);
  // Conversation history table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id          SERIAL PRIMARY KEY,
      created_at  TIMESTAMPTZ DEFAULT now(),
      preview     TEXT,
      messages    JSONB NOT NULL
    )
  `);

  const { rows: tiersRow } = await pool.query(
    "SELECT 1 FROM app_settings WHERE key = 'multiplier_tiers'"
  );
  if (!tiersRow.length) {
    await pool.query(
      "INSERT INTO app_settings(key, value) VALUES ('multiplier_tiers', $1::jsonb)",
      [JSON.stringify(DEFAULT_MULTIPLIER_TIERS)]
    );
    console.log('[migration] Default multiplier tiers seeded into app_settings');
  }

  // One-time migration: recreate mv_sales_velocity with HT after-discount revenue formula
  const { rows: mvVer } = await pool.query(
    "SELECT 1 FROM sync_state WHERE step = 'mv_velocity_v2'"
  );
  if (!mvVer.length) {
    console.log('[migration] Recreating mv_sales_velocity with correct revenue formula…');
    await pool.query('DROP MATERIALIZED VIEW IF EXISTS mv_sales_velocity CASCADE');
    await pool.query(`
      CREATE MATERIALIZED VIEW mv_sales_velocity AS
      SELECT
        sl.item_id,
        sl.shop_id,
        date_trunc('week', sl.completed_time) AS week,
        SUM(sl.qty)                           AS units_sold,
        SUM(sl.qty * sl.unit_price - COALESCE((sl.raw->>'calcLineDiscount')::numeric, 0)) AS revenue
      FROM sale_lines sl
      WHERE sl.completed_time IS NOT NULL
      GROUP BY sl.item_id, sl.shop_id, date_trunc('week', sl.completed_time)
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_velocity ON mv_sales_velocity(item_id, shop_id, week)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_mv_velocity_week ON mv_sales_velocity(week)`);
    await pool.query(
      "INSERT INTO sync_state(step, next_url) VALUES ('mv_velocity_v2', 'COMPLETED') ON CONFLICT(step) DO NOTHING"
    );
    console.log('[migration] mv_sales_velocity recreated.');
  } else {
    // Ensure mv_velocity_v2 is always marked COMPLETED (not stuck in in_progress)
    await pool.query(
      "UPDATE sync_state SET next_url = 'COMPLETED' WHERE step = 'mv_velocity_v2' AND next_url != 'COMPLETED'"
    );
  }

  // Migration: add drop_id to budget_plans + budget_plan_drops table
  // Each step is idempotent — checks actual DB state, never deletes rows.
  await pool.query(`ALTER TABLE budget_plans ADD COLUMN IF NOT EXISTS drop_id TEXT NOT NULL DEFAULT 'drop_1'`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS budget_plan_drops (
      season_code  TEXT    NOT NULL,
      manufacturer TEXT    NOT NULL,
      drop_id      TEXT    NOT NULL,
      drop_name    TEXT    NOT NULL DEFAULT 'Drop 1',
      drop_order   INTEGER NOT NULL DEFAULT 1,
      updated_at   TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (season_code, manufacturer, drop_id)
    )
  `);
  // Check whether the primary key on budget_plans already includes drop_id
  {
    const { rows: pkCols } = await pool.query(`
      SELECT a.attname
      FROM   pg_index     i
      JOIN   pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE  i.indrelid = 'budget_plans'::regclass AND i.indisprimary
    `);
    const pkHasDropId = pkCols.some(r => r.attname === 'drop_id');
    if (!pkHasDropId) {
      // Drop whatever the current PK is named (PostgreSQL auto-names it tablename_pkey)
      const { rows: conRows } = await pool.query(`
        SELECT conname FROM pg_constraint
        WHERE  conrelid = 'budget_plans'::regclass AND contype = 'p'
      `);
      if (conRows.length) {
        await pool.query(`ALTER TABLE budget_plans DROP CONSTRAINT ${conRows[0].conname}`);
      }
      await pool.query(`ALTER TABLE budget_plans ADD PRIMARY KEY (season_code, manufacturer, drop_id, shop_id)`);
      console.log('[migration] budget_plans PK updated to include drop_id');
    }
  }
  // Seed drop metadata for any existing plan rows that don't have a drop entry yet
  await pool.query(`
    INSERT INTO budget_plan_drops (season_code, manufacturer, drop_id, drop_name, drop_order)
    SELECT DISTINCT season_code, manufacturer, drop_id,
      'Drop ' || split_part(drop_id, '_', 2),
      COALESCE(NULLIF(split_part(drop_id, '_', 2), '')::int, 1)
    FROM budget_plans
    ON CONFLICT DO NOTHING
  `);
  await pool.query(
    "INSERT INTO sync_state(step, next_url) VALUES ('budget_plans_drops_v1', 'COMPLETED') ON CONFLICT(step) DO NOTHING"
  );

  // Budget documents — binary file storage per (season, manufacturer, drop)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS budget_documents (
      id           BIGSERIAL PRIMARY KEY,
      season_code  TEXT        NOT NULL,
      manufacturer TEXT        NOT NULL,
      drop_id      TEXT        NOT NULL DEFAULT 'drop_1',
      filename     TEXT        NOT NULL,
      content_type TEXT        NOT NULL DEFAULT 'application/octet-stream',
      file_size    INTEGER     NOT NULL DEFAULT 0,
      data         BYTEA       NOT NULL,
      uploaded_at  TIMESTAMPTZ DEFAULT now()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_budget_docs_lookup
    ON budget_documents(season_code, manufacturer, drop_id)`);

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

app.post('/api/sync/reset', (req, res) => {
  syncRunning = false;
  res.json({ ok: true, message: 'syncRunning flag reset' });
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
// ---------------------------------------------------------------------------
// GET /api/manufacturers — all distinct manufacturers in the products table
// ---------------------------------------------------------------------------
app.get('/api/manufacturers', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT manufacturer FROM products
       WHERE manufacturer IS NOT NULL AND manufacturer != ''
       ORDER BY manufacturer`
    );
    res.json(rows.map(r => r.manufacturer));
  } catch (err) { next(err); }
});

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
// /api/transfers — Sleeping stock transfer recommendations
// Only shops that have EVER sold this matrix are considered dormant candidates
// active_sold_30d >= 1 required to avoid false positives from returns
// ---------------------------------------------------------------------------
app.get('/api/transfers', async (req, res, next) => {
  try {
    const daysDormant = parseInt(req.query.days_dormant ?? '14', 10);
    const minStock    = parseInt(req.query.min_stock    ?? '1',  10);
    const params      = [daysDormant, minStock];

    const nosFilter = req.query.exclude_nos === '1'
      ? "AND (p.tags IS NULL OR p.tags NOT ILIKE '%nos%')" : '';
    let catFilter = '';
    if (req.query.category) { params.push(req.query.category); catFilter = `AND p.category = $${params.length}`; }

    const { rows } = await pool.query(`
      WITH
      -- Matrix-level sales: last 90d window for dormant/active detection
      matrix_last_sale AS (
        SELECT p.matrix_id, sl.shop_id,
          MAX(sl.completed_time)                                              AS last_sale_date,
          SUM(CASE WHEN sl.completed_time >= now() - interval '30 days'
                   THEN sl.qty ELSE 0 END)::int                              AS units_sold_30d
        FROM sale_lines sl
        JOIN products p ON p.item_id = sl.item_id
        WHERE sl.completed_time >= now() - interval '90 days'
          AND sl.completed_time IS NOT NULL
          AND p.matrix_id IS NOT NULL AND p.archived = false
        GROUP BY p.matrix_id, sl.shop_id
      ),
      -- Shops that have EVER sold this matrix (last 3 years) — filters out shops that never carried it
      matrix_ever_sold AS (
        SELECT DISTINCT p.matrix_id, sl.shop_id
        FROM sale_lines sl
        JOIN products p ON p.item_id = sl.item_id
        WHERE sl.completed_time >= now() - interval '3 years'
          AND p.matrix_id IS NOT NULL AND p.archived = false
      ),
      -- Dormant: has stock + no sale in X days + shop has EVER sold this matrix
      dormant_matrix AS (
        SELECT DISTINCT p.matrix_id, i.shop_id,
          mls.last_sale_date,
          CASE WHEN mls.last_sale_date IS NULL THEN NULL
               ELSE EXTRACT(DAY FROM now() - mls.last_sale_date)::int END   AS days_dormant
        FROM inventory i
        JOIN products p ON p.item_id = i.item_id
          AND p.matrix_id IS NOT NULL AND p.archived = false
        JOIN matrix_ever_sold mes ON mes.matrix_id = p.matrix_id AND mes.shop_id = i.shop_id
        LEFT JOIN matrix_last_sale mls ON mls.matrix_id = p.matrix_id AND mls.shop_id = i.shop_id
        WHERE i.qty_on_hand > 0
          AND (mls.last_sale_date IS NULL OR mls.last_sale_date < now() - (interval '1 day' * $1))
        GROUP BY p.matrix_id, i.shop_id, mls.last_sale_date
      ),
      -- Active: sold in last 30 days (fixed window, independent of dormant threshold)
      active_matrix AS (
        SELECT matrix_id, shop_id, last_sale_date, units_sold_30d
        FROM matrix_last_sale
        WHERE last_sale_date >= now() - interval '30 days'
          AND units_sold_30d >= 1
      ),
      -- Specific items (exact size+color) ever sold at each shop (last 3 years)
      item_ever_sold AS (
        SELECT DISTINCT item_id, shop_id
        FROM sale_lines
        WHERE completed_time >= now() - interval '3 years'
      ),
      -- Best active shop per (matrix, dormant_shop): most recently sold
      best_active AS (
        SELECT DISTINCT ON (dm.matrix_id, dm.shop_id)
          dm.matrix_id,
          dm.shop_id        AS dormant_shop_id,
          dm.last_sale_date AS dormant_last_sale,
          dm.days_dormant,
          am.shop_id        AS active_shop_id,
          am.last_sale_date AS active_last_sale,
          am.units_sold_30d
        FROM dormant_matrix dm
        JOIN active_matrix am ON am.matrix_id = dm.matrix_id AND am.shop_id != dm.shop_id
        ORDER BY dm.matrix_id, dm.shop_id, am.last_sale_date DESC
      )
      SELECT
        p.item_id, p.description, p.manufacturer, p.category,
        p.matrix_id,
        COALESCE(
          CASE WHEN p.raw->'ItemAttributes'->>'attribute1' ~ '^[0-9]' OR p.raw->'ItemAttributes'->>'attribute1' ~* '^(XXS|XS|S|M|L|XL|XXL|XXXL|2XL|3XL)$' THEN p.raw->'ItemAttributes'->>'attribute1' END,
          CASE WHEN p.raw->'ItemAttributes'->>'attribute2' ~ '^[0-9]' OR p.raw->'ItemAttributes'->>'attribute2' ~* '^(XXS|XS|S|M|L|XL|XXL|XXXL|2XL|3XL)$' THEN p.raw->'ItemAttributes'->>'attribute2' END,
          CASE WHEN p.raw->'ItemAttributes'->>'attribute3' ~ '^[0-9]' OR p.raw->'ItemAttributes'->>'attribute3' ~* '^(XXS|XS|S|M|L|XL|XXL|XXXL|2XL|3XL)$' THEN p.raw->'ItemAttributes'->>'attribute3' END
        ) AS size,
        sh_d.name  AS dormant_shop,  ba.dormant_shop_id,
        ba.dormant_last_sale,        ba.days_dormant,
        i.qty_on_hand::int           AS qty,
        sh_a.name  AS active_shop,   ba.active_shop_id,
        ba.active_last_sale,         ba.units_sold_30d AS active_sold_30d
      FROM best_active ba
      JOIN products p  ON p.matrix_id = ba.matrix_id AND p.archived = false
      JOIN item_ever_sold ies ON ies.item_id = p.item_id AND ies.shop_id = ba.active_shop_id
      JOIN inventory i ON i.item_id = p.item_id AND i.shop_id = ba.dormant_shop_id
        AND i.qty_on_hand >= $2
      JOIN shops sh_d ON sh_d.shop_id = ba.dormant_shop_id
      JOIN shops sh_a ON sh_a.shop_id = ba.active_shop_id
      WHERE NOT (p.default_cost = 0 AND p.default_price = 0)
        AND p.description NOT ILIKE '%shopify%'
        ${nosFilter} ${catFilter}
      ORDER BY ba.days_dormant ASC NULLS LAST, p.manufacturer, p.matrix_id, p.description
    `, params);

    res.json({ days_dormant: daysDormant, min_stock: minStock, count: rows.length, transfers: rows });
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
// GET /api/sizes/brands — Size curve analysis aggregated by brand + category
// Extracts size from description via regex, computes ST% and stock alignment.
// ?season=p|a|''  ?category=X  ?shop_id=Y
// ---------------------------------------------------------------------------
app.get('/api/sizes/brands', async (req, res, next) => {
  try {
    const { season, category, shop_id, date_from, date_to, exclude_nos, stock_tag } = req.query;
    const params = [];

    // Priority: ItemAttributes (exact values from Lightspeed matrix) → description parsing (fallback)
    // ItemAttributes populated after sync with load_relations=['ItemAttributes']
    const sizeAttrExpr = (n) => `p.raw->'ItemAttributes'->>'attribute${n}'`;
    const isSizeAttr = (expr) => `(
      ${expr} ~* '^\\s*(XXS|XS|S|M|L|XL|XXL|XXXL|2XL|3XL)\\s*$'
      OR ${expr} ~ '^[0-9]'
    )`;
    // Normalize fraction notation to decimal: "15 1/2"→"15.5", "15 3/4"→"15.75", "15 1/4"→"15.25"
    const normAttr = (expr) => `
      CASE
        WHEN ${expr} ~ '^[0-9]+ 1/4$' THEN regexp_replace(${expr}, ' 1/4$', '.25')
        WHEN ${expr} ~ '^[0-9]+ 1/2$' THEN regexp_replace(${expr}, ' 1/2$', '.5')
        WHEN ${expr} ~ '^[0-9]+ 3/4$' THEN regexp_replace(${expr}, ' 3/4$', '.75')
        WHEN ${expr} ~ '^[0-9]+,[0-9]' THEN regexp_replace(${expr}, ',', '.')
        ELSE ${expr}
      END`;
    const sizeCase = `
      COALESCE(
        CASE WHEN ${isSizeAttr(sizeAttrExpr(1))} THEN ${normAttr(sizeAttrExpr(1))} END,
        CASE WHEN ${isSizeAttr(sizeAttrExpr(2))} THEN ${normAttr(sizeAttrExpr(2))} END,
        CASE WHEN ${isSizeAttr(sizeAttrExpr(3))} THEN ${normAttr(sizeAttrExpr(3))} END,
        CASE
          WHEN p.description ~* '\\m(XXXL|3XL)\\M' THEN 'XXXL'
          WHEN p.description ~* '\\m(XXL|2XL)\\M'  THEN 'XXL'
          WHEN p.description ~* '\\mXL\\M'           THEN 'XL'
          WHEN p.description ~* '\\mL\\M'            THEN 'L'
          WHEN p.description ~* '\\mM\\M'            THEN 'M'
          WHEN p.description ~* '\\mXS\\M'           THEN 'XS'
          WHEN p.description ~* '\\mS\\M'            THEN 'S'
          WHEN p.description ~  '(?<![0-9])[0-9]{1,2},(25|5|50|75)(?![0-9])'
            THEN regexp_replace((regexp_match(p.description, '(?<![0-9])([0-9]{1,2},(25|5|50|75))(?![0-9])'))[1], ',', '.')
          WHEN p.description ~  '(?<![0-9])[0-9]{1,2}\\.(25|5|50|75)(?![0-9])'
            THEN (regexp_match(p.description, '(?<![0-9])([0-9]{1,2}\\.(25|5|50|75))(?![0-9])'))[1]
          WHEN p.description ~  '(?<![0-9])[0-9]{2}/[0-9]{2,3}(?![0-9])'
            THEN (regexp_match(p.description, '(?<![0-9])([0-9]{2}/[0-9]{2,3})(?![0-9])'))[1]
          WHEN p.description ~  '(?<![0-9A-Za-z\\-\\.])[1-9][0-9]?(?![0-9A-Za-z\\.])'
            THEN (regexp_match(p.description, '(?<![0-9A-Za-z\\-\\.])([1-9][0-9]?)(?![0-9A-Za-z\\.])'))[1]
          ELSE NULL
        END
      )`;

    let seasonFilter = '';
    if (date_from && date_to) {
      params.push(date_from, date_to);
      seasonFilter = `AND sl.completed_time >= $${params.length - 1} AND sl.completed_time < $${params.length}::date + INTERVAL '1 day'`;
    } else if (season === 'p') {
      seasonFilter = `AND EXTRACT(MONTH FROM sl.completed_time) BETWEEN 2 AND 8`;
    } else if (season === 'a') {
      seasonFilter = `AND (EXTRACT(MONTH FROM sl.completed_time) >= 9 OR EXTRACT(MONTH FROM sl.completed_time) = 1)`;
    }

    let catFilter = '';
    if (category) { params.push(category); catFilter = `AND p.category = $${params.length}`; }

    let shopFilterSL = '', shopFilterInv = '';
    if (shop_id) {
      params.push(shop_id);
      shopFilterSL  = `AND sl.shop_id = $${params.length}`;
      shopFilterInv = `AND i.shop_id  = $${params.length}`;
    }

    const nosFilter = exclude_nos === '1' ? `AND (p.tags IS NULL OR p.tags NOT ILIKE '%nos%')` : '';
    const baseWhere = `p.matrix_id IS NOT NULL AND p.archived = false
      AND p.category NOT ILIKE 'Alt%ration%' AND p.description NOT ILIKE '%shopify%'
      AND NOT (p.default_cost = 0 AND p.default_price = 0) ${nosFilter}`;

    let stockTagFilter = '';
    if (stock_tag) {
      params.push(stock_tag);
      stockTagFilter = `AND p.tags ILIKE $${params.length}`;
    }

    const [{ rows }, { rows: catRows }] = await Promise.all([
      pool.query(`
        WITH size_sales AS (
          SELECT
            COALESCE(p.manufacturer, 'Sans marque') AS manufacturer,
            COALESCE(p.category, 'Sans catégorie')  AS category,
            ${sizeCase} AS size_label,
            SUM(GREATEST(sl.qty, 0)) AS units_sold
          FROM products p
          JOIN sale_lines sl ON sl.item_id = p.item_id
            AND sl.completed_time >= now() - INTERVAL '2 years'
            AND sl.completed_time IS NOT NULL
            ${seasonFilter} ${shopFilterSL}
          WHERE ${baseWhere} ${catFilter}
          GROUP BY p.manufacturer, p.category, size_label
          HAVING SUM(GREATEST(sl.qty, 0)) > 0
        ),
        size_stock AS (
          SELECT
            COALESCE(p.manufacturer, 'Sans marque') AS manufacturer,
            COALESCE(p.category, 'Sans catégorie')  AS category,
            ${sizeCase} AS size_label,
            SUM(COALESCE(i.qty_on_hand, 0)) AS qty_on_hand
          FROM products p
          JOIN inventory i ON i.item_id = p.item_id ${shopFilterInv}
          WHERE ${baseWhere} ${catFilter} ${stockTagFilter}
          GROUP BY p.manufacturer, p.category, size_label
        )
        SELECT
          manufacturer, category, size_label,
          COALESCE(ss.units_sold, 0)::float8   AS units_sold,
          COALESCE(sk.qty_on_hand, 0)::float8  AS qty_on_hand
        FROM size_sales ss
        FULL OUTER JOIN size_stock sk USING (manufacturer, category, size_label)
        WHERE size_label IS NOT NULL
          AND (COALESCE(ss.units_sold, 0) > 0 OR COALESCE(sk.qty_on_hand, 0) > 0)
        ORDER BY manufacturer, category, COALESCE(ss.units_sold, 0) DESC
      `, params),
      pool.query(`
        SELECT DISTINCT COALESCE(category, 'Sans catégorie') AS category
        FROM products
        WHERE matrix_id IS NOT NULL AND archived = false
          AND category NOT ILIKE 'Alt%ration%' AND description NOT ILIKE '%shopify%'
        ORDER BY category
      `),
    ]);

    res.json({ count: rows.length, sizes: rows, categories: catRows.map(r => r.category) });
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
        SELECT item_id, shop_id, SUM(units_sold) / 12.0 AS avg_weekly_units
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
// Multiplier table: sell-through + full-price rate → buying budget adjustment
// Both conditions must be met for a tier; falls to the next if either fails.
// ---------------------------------------------------------------------------
function computeMultiplier(st, fp) {
  if (st === null || st === undefined || fp === null || fp === undefined || isNaN(st) || isNaN(fp)) {
    return { multiplier: 1.00, label: 'Reconduire' };
  }
  if (st >= 0.80 && fp >= 0.70) return { multiplier: 1.25, label: 'Augmenter'     };
  if (st >= 0.65 && fp >= 0.50) return { multiplier: 1.10, label: 'Légère hausse' };
  if (st >= 0.50 && fp >= 0.40) return { multiplier: 1.00, label: 'Reconduire'    };
  if (st >= 0.35 && fp >= 0.30) return { multiplier: 0.80, label: 'Réduire'       };
  return                               { multiplier: 0.50, label: 'Couper'         };
}

// ---------------------------------------------------------------------------
// Shared helper: aggregate manufacturer×category rows into a nested tree.
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
        fp_units_sold:         0,
        gross_units_sold:      0,
        hypothesis:            { multiplier: 1.0, label: 'Reconduire', adjusted_budget: 0 },
        by_category:           [],
      });
    }
    const m = map.get(row.manufacturer);
    m.items_count           += parseInt(row.items_count ?? 0);
    m.remaining_stock_units += parseFloat(row.remaining_stock_units ?? 0);
    m[refField]             += parseFloat(row[refField] ?? 0);
    m.proposed_budget       += budget;
    m.fp_units_sold         += parseFloat(row.fp_units_sold    ?? 0);
    m.gross_units_sold      += parseFloat(row.gross_units_sold ?? 0);
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
        SELECT item_id, shop_id, SUM(units_sold) / 12.0 AS avg_weekly_units
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
// Reference demand: units sold during the selected reference season
// Shortage: MAX(0, season_units − current_stock) × default_cost
// ?season=p26 → season code (default p26); options: p26,a26,p25,a25,p24,a24,p23,a23
// Reference demand comes from the equivalent seasons of the N previous years,
// prorated by current vs historical item count (handles portfolio size changes).
// ---------------------------------------------------------------------------
const SEASON_RANGES = {
  // recv_from = 4 months before season start, to catch pre-season deliveries
  p23: { from: '2023-02-01', to: '2023-09-30', recv_from: '2022-10-01', label: 'P23 — Printemps 2023' },
  a23: { from: '2023-09-01', to: '2024-02-28', recv_from: '2023-05-01', label: 'A23 — Automne 2023'   },
  p24: { from: '2024-02-01', to: '2024-09-30', recv_from: '2023-10-01', label: 'P24 — Printemps 2024' },
  a24: { from: '2024-09-01', to: '2025-02-28', recv_from: '2024-05-01', label: 'A24 — Automne 2024'   },
  p25: { from: '2025-02-01', to: '2025-09-30', recv_from: '2024-10-01', label: 'P25 — Printemps 2025' },
  a25: { from: '2025-09-01', to: '2026-02-28', recv_from: '2025-05-01', label: 'A25 — Automne 2025'   },
  p26: { from: '2026-02-01', to: '2026-09-30', recv_from: '2025-10-01', label: 'P26 — Printemps 2026' },
  a26: { from: '2026-09-01', to: '2027-02-28', recv_from: '2026-05-01', label: 'A26 — Automne 2026'   },
  p27: { from: '2027-02-01', to: '2027-09-30', recv_from: '2026-10-01', label: 'P27 — Printemps 2027' },
  a27: { from: '2027-09-01', to: '2028-02-28', recv_from: '2027-05-01', label: 'A27 — Automne 2027'   },
};

// Returns the up-to-3 previous equivalent seasons for a given code.
// e.g. p26 → ['p25', 'p24', 'p23']
function getPreviousSeasons(code) {
  const type = code[0];
  const year = parseInt(code.slice(1), 10);
  return [year - 1, year - 2, year - 3]
    .map(y => `${type}${y}`)
    .filter(c => SEASON_RANGES[c]);
}

app.get('/api/budget/saisonnier', async (req, res, next) => {
  try {
    const seasonCode     = (req.query.season ?? 'p26').toLowerCase();
    const season         = SEASON_RANGES[seasonCode] ?? SEASON_RANGES.p26;
    const refSeasonCodes = getPreviousSeasons(seasonCode); // e.g. ['p25','p24','p23']

    const shops = req.query.shops       ? req.query.shops.split(',').filter(Boolean)                                       : null;
    const colls = req.query.collections ? req.query.collections.split(',').map(s => s.toLowerCase().trim()).filter(Boolean) : null;
    const sizes = req.query.sizes       ? req.query.sizes.split(',').filter(Boolean)                                       : null;

    const cacheKey = JSON.stringify({ r: 'saisonnier2', season: seasonCode, shops, colls, sizes });
    const hit = cacheGet(cacheKey);
    if (hit) return res.json({ ...hit, cached: true });

    // $1 = target season tag (portfolio to buy for)
    const params = [`%${seasonCode}%`];
    let shopCondSL = '', shopCondInv = '', collCond = '', sizeCond = '';
    if (shops?.length) {
      params.push(shops);
      const n = params.length;
      shopCondSL  = `AND sl.shop_id = ANY($${n})`;
      shopCondInv = `AND shop_id    = ANY($${n})`;
    }
    if (colls?.length) { params.push(colls); collCond = `AND string_to_array(lower(coalesce(p.tags,'')), ',') && $${params.length}::text[]`; }
    if (sizes?.length) { params.push('\\y(' + sizes.join('|') + ')\\y'); sizeCond = `AND p.description ~* $${params.length}`; }

    const stockCTE = shops?.length
      ? `stock AS (
           SELECT item_id,
                  SUM(COALESCE(qty_on_hand, 0) + COALESCE(qty_on_order, 0)) AS current_stock
           FROM inventory
           WHERE 1=1 ${shopCondInv}
           GROUP BY item_id
         )`
      : `stock AS (SELECT item_id, current_stock_all AS current_stock FROM mv_inventory_stock)`;

    // One CTE per reference season — LEFT JOIN ensures items with no sales are still counted
    // (items_count = full portfolio size, not just items that sold)
    const refCTEParts    = [];
    const refSelectParts = [];
    for (const refCode of refSeasonCodes) {
      const refSeason = SEASON_RANGES[refCode];
      params.push(refSeason.from, refSeason.to, `%${refCode}%`);
      const fromP = params.length - 2;
      const toP   = params.length - 1;
      const tagP  = params.length;

      refCTEParts.push(`
        ref_${refCode} AS (
          SELECT
            COALESCE(p.manufacturer, 'Sans marque') AS manufacturer,
            COALESCE(p.category,     'Sans catégorie') AS category,
            COUNT(DISTINCT p.item_id)::float8 AS items_count,
            COALESCE(SUM(sl.qty), 0)::float8 AS net_units,
            COALESCE(SUM(CASE WHEN sl.qty > 0 THEN sl.qty ELSE 0 END), 0)::float8 AS gross_units,
            COALESCE(SUM(CASE WHEN sl.qty > 0
                              AND p.default_price > 0
                              AND (sl.unit_price * sl.qty - COALESCE((sl.raw->>'calcLineDiscount')::numeric, 0))
                                  >= p.default_price * sl.qty * 0.90
                         THEN sl.qty ELSE 0 END), 0)::float8 AS fp_units
          FROM products p
          LEFT JOIN sale_lines sl
            ON  sl.item_id = p.item_id
            AND sl.completed_time >= $${fromP}::date
            AND sl.completed_time <= $${toP}::date
            AND sl.completed_time IS NOT NULL
            ${shopCondSL}
          WHERE p.tags ILIKE $${tagP}
            AND p.tags NOT ILIKE '%nos%'
            AND p.archived = false
            AND p.default_cost > 0
            AND p.category    NOT ILIKE 'Alt%ration%'
            AND p.description NOT ILIKE '%shopify%'
            AND NOT (p.default_cost = 0 AND p.default_price = 0)
          GROUP BY p.manufacturer, p.category
        )`);

      refSelectParts.push(`
        SELECT manufacturer, category,
          GREATEST(0, net_units   / NULLIF(items_count, 0)) AS net_per_item,
          GREATEST(0, gross_units / NULLIF(items_count, 0)) AS gross_per_item,
          GREATEST(0, fp_units    / NULLIF(items_count, 0)) AS fp_per_item
        FROM ref_${refCode}`);
    }

    // Average the per-item rates across available reference seasons
    const combinedRefCTE = refSelectParts.length > 0
      ? `combined_ref AS (
          SELECT manufacturer, category,
            AVG(net_per_item)   AS avg_net_per_item,
            AVG(gross_per_item) AS avg_gross_per_item,
            AVG(fp_per_item)    AS avg_fp_per_item
          FROM (
            ${refSelectParts.join('\n            UNION ALL\n')}
          ) all_refs
          GROUP BY manufacturer, category
        )`
      : `combined_ref AS (SELECT NULL::text AS manufacturer, NULL::text AS category,
            0::float8 AS avg_net_per_item, 0::float8 AS avg_gross_per_item, 0::float8 AS avg_fp_per_item WHERE false)`;

    const allCTEs = [stockCTE, ...refCTEParts, combinedRefCTE].join(',\n');

    const { rows } = await pool.query(`
      WITH ${allCTEs},
      current_season AS (
        SELECT
          COALESCE(p.manufacturer, 'Sans marque') AS manufacturer,
          COALESCE(p.category,     'Sans catégorie') AS category,
          COUNT(DISTINCT p.item_id)::int AS items_count,
          ROUND(SUM(COALESCE(st.current_stock, 0))::numeric, 0)::float8 AS current_stock,
          SUM(COALESCE(p.default_cost, 0)) / NULLIF(COUNT(DISTINCT p.item_id), 0) AS avg_unit_cost
        FROM products p
        LEFT JOIN stock st ON st.item_id = p.item_id
        WHERE p.tags ILIKE $1
          AND p.tags NOT ILIKE '%nos%'
          AND p.archived = false
          AND p.default_cost > 0
          AND p.category    NOT ILIKE 'Alt%ration%'
          AND p.description NOT ILIKE '%shopify%'
          AND NOT (p.default_cost = 0 AND p.default_price = 0)
          ${collCond}
          ${sizeCond}
        GROUP BY p.manufacturer, p.category
      )
      SELECT
        cs.manufacturer,
        cs.category,
        cs.items_count,
        cs.current_stock                                                                                      AS remaining_stock_units,
        ROUND(GREATEST(0, COALESCE(cr.avg_net_per_item   * cs.items_count, 0))::numeric)::float8             AS reference_units_sold,
        ROUND(GREATEST(0, COALESCE(cr.avg_fp_per_item    * cs.items_count, 0))::numeric)::float8             AS fp_units_sold,
        ROUND(GREATEST(0, COALESCE(cr.avg_gross_per_item * cs.items_count, 0))::numeric)::float8             AS gross_units_sold,
        ROUND(GREATEST(0,
          COALESCE(cr.avg_net_per_item * cs.items_count, 0) - cs.current_stock
        )::numeric * COALESCE(cs.avg_unit_cost, 0), 2)::float8                                               AS proposed_budget
      FROM current_season cs
      LEFT JOIN combined_ref cr ON cr.manufacturer = cs.manufacturer AND cr.category = cs.category
      ORDER BY cs.manufacturer, proposed_budget DESC
    `, params);

    const byManufacturer = buildManufacturerTree(rows, 'reference_units_sold').map(m => {
      const ref   = m.reference_units_sold;
      const stock = m.remaining_stock_units;
      const st    = (ref + stock) > 0 ? ref / (ref + stock) : null;
      const fp    = m.gross_units_sold > 0 ? m.fp_units_sold / m.gross_units_sold : null;
      const hyp   = computeMultiplier(st, fp);
      m.st_rate   = st !== null ? Math.round(st * 1000) / 1000 : null;
      m.fp_rate   = fp !== null ? Math.round(fp * 1000) / 1000 : null;
      m.hypothesis = { ...hyp, adjusted_budget: Math.round(m.proposed_budget * hyp.multiplier * 100) / 100 };
      return m;
    });
    const total = byManufacturer.reduce((s, m) => s + m.proposed_budget, 0);

    const result = {
      season_code:             seasonCode,
      season_label:            season.label,
      reference_seasons:       refSeasonCodes,
      reference_seasons_label: refSeasonCodes.map(c => c.toUpperCase()).join(', '),
      generated_at:            new Date().toISOString(),
      total_proposed_budget:   Math.round(total * 100) / 100,
      manufacturer_count:      byManufacturer.length,
      by_manufacturer:         byManufacturer,
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
// GET /api/admin/receiving-sources — audit all ways stock enters the system
// Shows orders table, transfers with null from_shop_id (vendor receivings),
// and transfers between shops, to understand what data is available
// ---------------------------------------------------------------------------
app.get('/api/admin/receiving-sources', async (req, res, next) => {
  try {
    const [ordersStats, transferTypes, ordersDetail] = await Promise.all([
      pool.query(`
        SELECT COUNT(*)::int AS total_orders,
               MIN(raw->>'orderedDate') AS earliest,
               MAX(raw->>'orderedDate') AS latest
        FROM orders
      `),
      pool.query(`
        SELECT
          CASE WHEN from_shop_id IS NULL THEN 'vendor_receiving' ELSE 'shop_to_shop' END AS type,
          COUNT(*)::int AS rows,
          COUNT(CASE WHEN transfer_received = true AND qty_received > 0 THEN 1 END)::int AS usable,
          MIN(transfer_date) AS earliest,
          MAX(transfer_date) AS latest
        FROM transfers
        GROUP BY 1
      `),
      pool.query(`
        SELECT order_id,
               raw->>'orderedDate'   AS ordered_date,
               raw->>'receivedDate'  AS received_date,
               raw->>'totalQuantity' AS total_qty,
               raw->>'totalCost'     AS total_cost,
               raw->>'orderStatus'   AS order_status,
               raw->>'vendorID'      AS vendor_id
        FROM orders
        ORDER BY (raw->>'orderedDate') DESC NULLS LAST
      `),
    ]);

    res.json({
      orders:         ordersStats.rows[0],
      transfer_types: transferTypes.rows,
      orders_detail:  ordersDetail.rows,
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/admin/inventory-by-mfr?manufacturer=Corneliani — current stock for a brand
// Also derives "implied received" = qty_on_hand + qty_sold since a given date
// ---------------------------------------------------------------------------
app.get('/api/admin/inventory-by-mfr', async (req, res, next) => {
  try {
    const mfr   = req.query.manufacturer || 'Corneliani';
    const since = req.query.since        || '2025-10-01'; // P26 recv window start

    const [invRows, salesRows] = await Promise.all([
      pool.query(`
        SELECT p.item_id, p.description, p.tags, p.default_cost, p.archived,
               SUM(COALESCE(i.qty_on_hand, 0))   AS qty_on_hand,
               SUM(COALESCE(i.qty_on_order, 0))  AS qty_on_order
        FROM products p
        LEFT JOIN inventory i ON i.item_id = p.item_id
        WHERE p.manufacturer ILIKE $1
          AND p.archived = false
        GROUP BY p.item_id, p.description, p.tags, p.default_cost, p.archived
        ORDER BY p.description
      `, [`%${mfr}%`]),
      pool.query(`
        SELECT p.item_id, SUM(sl.qty) AS units_sold
        FROM sale_lines sl
        JOIN products p ON p.item_id = sl.item_id
        WHERE p.manufacturer ILIKE $1
          AND sl.completed_time >= $2::date
          AND sl.qty > 0
        GROUP BY p.item_id
      `, [`%${mfr}%`, since]),
    ]);

    const salesMap = {};
    for (const r of salesRows.rows) salesMap[r.item_id] = parseFloat(r.units_sold ?? 0);

    const items = invRows.rows.map(r => {
      const sold    = salesMap[r.item_id] ?? 0;
      const onHand  = parseFloat(r.qty_on_hand ?? 0);
      const onOrder = parseFloat(r.qty_on_order ?? 0);
      return {
        item_id:         r.item_id,
        description:     r.description,
        tags:            r.tags,
        default_cost:    parseFloat(r.default_cost ?? 0),
        qty_on_hand:     onHand,
        qty_on_order:    onOrder,
        units_sold_since: sold,
        implied_received: onHand + sold,
        implied_cost:     (onHand + sold) * parseFloat(r.default_cost ?? 0),
      };
    });

    const totals = items.reduce((acc, r) => ({
      qty_on_hand:      acc.qty_on_hand      + r.qty_on_hand,
      qty_on_order:     acc.qty_on_order     + r.qty_on_order,
      units_sold_since: acc.units_sold_since + r.units_sold_since,
      implied_received: acc.implied_received + r.implied_received,
      implied_cost:     acc.implied_cost     + r.implied_cost,
    }), { qty_on_hand: 0, qty_on_order: 0, units_sold_since: 0, implied_received: 0, implied_cost: 0 });

    res.json({ manufacturer: mfr, since, totals, items });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/admin/transfers-by-mfr?manufacturer=Corneliani — all transfers for a brand
// Shows transfer_date distribution, useful to debug why a brand is undercounted
// ---------------------------------------------------------------------------
app.get('/api/admin/transfers-by-mfr', async (req, res, next) => {
  try {
    const mfr = req.query.manufacturer || 'Corneliani';
    const { rows } = await pool.query(`
      SELECT
        t.transfer_item_id,
        t.transfer_id,
        t.from_shop_id,
        t.to_shop_id,
        t.transfer_date,
        t.qty_received,
        t.qty_sent,
        t.transfer_received,
        t.transfer_sent,
        p.item_id,
        p.description,
        p.default_cost,
        p.tags,
        t.qty_received * COALESCE(p.default_cost, 0) AS line_cost
      FROM transfers t
      JOIN products p ON p.item_id = t.item_id
      WHERE p.manufacturer ILIKE $1
      ORDER BY t.transfer_date DESC
    `, [`%${mfr}%`]);

    const byYear = {};
    for (const r of rows) {
      const y = r.transfer_date ? new Date(r.transfer_date).getFullYear() : 'null';
      if (!byYear[y]) byYear[y] = { rows: 0, units: 0, cost: 0 };
      byYear[y].rows++;
      byYear[y].units += parseFloat(r.qty_received ?? 0);
      byYear[y].cost  += parseFloat(r.line_cost ?? 0);
    }

    res.json({ manufacturer: mfr, total_rows: rows.length, by_year: byYear, rows });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/admin/tag-diag?manufacturer=Brax&tag=p26 — tag filter diagnostics
// ---------------------------------------------------------------------------
app.get('/api/admin/tag-diag', async (req, res, next) => {
  try {
    const mfr = req.query.manufacturer || 'Brax';
    const tag = req.query.tag          || 'p26';
    const tagPattern = `%${tag}%`;

    const [q1, q2, q3, q4, q5] = await Promise.all([
      // 1. Raw totals (user's requested query)
      pool.query(`
        SELECT COUNT(*)::int           AS row_count,
               COUNT(DISTINCT sl.sale_line_id)::int AS distinct_sale_lines,
               ROUND(SUM(sl.qty),0)::float8         AS total_qty,
               ROUND(SUM(sl.qty * sl.unit_price - COALESCE((sl.raw->>'calcLineDiscount')::numeric, 0)),2)::float8 AS total_revenue
        FROM sale_lines sl
        JOIN products p ON p.item_id = sl.item_id
        WHERE p.manufacturer ILIKE $1
          AND p.tags ILIKE $2
          AND sl.qty > 0
      `, [mfr, tagPattern]),

      // 2. Same but only articles that have EXACTLY the tag (no partial matches)
      pool.query(`
        SELECT COUNT(DISTINCT p.item_id)::int AS products_matching_tag,
               array_agg(DISTINCT p.tags ORDER BY p.tags) AS sample_tags
        FROM products p
        WHERE p.manufacturer ILIKE $1
          AND p.tags ILIKE $2
        LIMIT 1
      `, [mfr, tagPattern]),

      // 3. Breakdown by tag value — shows if '%p26%' catches unexpected tags
      pool.query(`
        SELECT p.tags,
               COUNT(DISTINCT p.item_id)::int AS items,
               ROUND(SUM(sl.qty),0)::float8   AS qty_sold
        FROM sale_lines sl
        JOIN products p ON p.item_id = sl.item_id
        WHERE p.manufacturer ILIKE $1
          AND p.tags ILIKE $2
          AND sl.qty > 0
        GROUP BY p.tags
        ORDER BY qty_sold DESC
        LIMIT 20
      `, [mfr, tagPattern]),

      // 4. Check if sale_line_id is duplicated (JOIN producing extra rows?)
      pool.query(`
        SELECT COUNT(*)::int AS total_rows,
               COUNT(DISTINCT sl.sale_line_id)::int AS distinct_ids,
               COUNT(*) - COUNT(DISTINCT sl.sale_line_id) AS duplicates
        FROM sale_lines sl
        JOIN products p ON p.item_id = sl.item_id
        WHERE p.manufacturer ILIKE $1
          AND p.tags ILIKE $2
          AND sl.qty > 0
      `, [mfr, tagPattern]),

      // 5. Totals per year — shows if all-time vs season-period explains the gap
      pool.query(`
        SELECT date_trunc('year', sl.completed_time)::date AS year,
               ROUND(SUM(sl.qty),0)::float8                AS qty_sold,
               ROUND(SUM(sl.qty * sl.unit_price - COALESCE((sl.raw->>'calcLineDiscount')::numeric, 0)),2)::float8 AS revenue
        FROM sale_lines sl
        JOIN products p ON p.item_id = sl.item_id
        WHERE p.manufacturer ILIKE $1
          AND p.tags ILIKE $2
          AND sl.qty > 0
          AND sl.completed_time IS NOT NULL
        GROUP BY 1 ORDER BY 1 DESC
      `, [mfr, tagPattern]),
    ]);

    res.json({
      params: { manufacturer: mfr, tag, tagPattern },
      raw_totals:       q1.rows[0],
      duplicate_check:  q4.rows[0],
      products_count:   q2.rows[0],
      by_tag_value:     q3.rows,
      by_year:          q5.rows,
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/admin/revenue-diag?manufacturer=Brax&tag=p26&shop_id=5
// Compare all raw Lightspeed price fields to find the correct pre-tax,
// after-discount revenue formula for a Tag+Période window.
// ---------------------------------------------------------------------------
app.get('/api/admin/revenue-diag', async (req, res, next) => {
  try {
    const mfr    = req.query.manufacturer || 'Brax';
    const tag    = req.query.tag          || 'p26';
    const shopId = req.query.shop_id      || null;
    const tagPat = `%${tag}%`;

    const season = SEASON_RANGES[tag.toLowerCase()];
    if (!season) return res.status(400).json({ error: `Tag "${tag}" not a known season code` });

    const seasonFrom = season.from;
    const seasonTo   = new Date().toISOString().slice(0,10) < season.to
      ? new Date().toISOString().slice(0,10) : season.to;

    const shopCond = shopId ? 'AND sl.shop_id = $4' : '';
    const params   = shopId
      ? [mfr, tagPat, seasonFrom, shopId, seasonTo]
      : [mfr, tagPat, seasonFrom, seasonTo];
    const toParam  = shopId ? '$5' : '$4';

    const { rows } = await pool.query(`
      SELECT
        COUNT(*)::int                                                          AS sale_lines,
        ROUND(SUM(sl.qty), 0)::float8                                         AS units,

        -- What we were storing before
        ROUND(SUM(sl.qty * sl.unit_price), 2)::float8                         AS sum_qty_x_unit_price,

        -- Raw LS fields from JSON
        ROUND(SUM((sl.raw->>'calcSubtotal')::numeric),       2)::float8       AS sum_calc_subtotal,
        ROUND(SUM((sl.raw->>'calcLineDiscount')::numeric),   2)::float8       AS sum_calc_line_discount,
        ROUND(SUM((sl.raw->>'calcTotal')::numeric),          2)::float8       AS sum_calc_total,
        ROUND(SUM((sl.raw->>'calcTax1')::numeric),           2)::float8       AS sum_calc_tax1,
        ROUND(SUM((sl.raw->>'calcTax2')::numeric),           2)::float8       AS sum_calc_tax2,

        -- Derived: calcTotal minus taxes (pre-tax, after-discount)
        ROUND(SUM(
          COALESCE((sl.raw->>'calcTotal')::numeric, 0)
          - COALESCE((sl.raw->>'calcTax1')::numeric, 0)
          - COALESCE((sl.raw->>'calcTax2')::numeric, 0)
        ), 2)::float8                                                          AS calc_total_pretax,

        -- How many rows have calcTotal present in raw
        COUNT(*) FILTER (WHERE sl.raw->>'calcTotal' IS NOT NULL)::int         AS rows_with_calc_total,
        COUNT(*) FILTER (WHERE sl.raw->>'calcLineDiscount' IS NOT NULL)::int  AS rows_with_discount_field
      FROM sale_lines sl
      JOIN products p ON p.item_id = sl.item_id
      WHERE p.manufacturer ILIKE $1
        AND p.tags ILIKE $2
        AND sl.completed_time >= $3::date
        AND sl.completed_time <= ${toParam}::date
        AND sl.qty > 0
        AND sl.completed_time IS NOT NULL
        ${shopCond}
    `, params);

    res.json({ params: { manufacturer: mfr, tag, shop_id: shopId, season_from: seasonFrom, season_to: seasonTo }, ...rows[0] });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/admin/revenue-check?date_from=2023-01-01&date_to=2026-06-19
// Diagnose revenue formula coverage for a date range (no season filter)
// ---------------------------------------------------------------------------
app.get('/api/admin/revenue-check', async (req, res, next) => {
  try {
    const from = req.query.date_from || '2023-01-01';
    const to   = req.query.date_to   || new Date().toISOString().slice(0,10);
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)::int                                                                        AS total_lines,
        COUNT(*) FILTER (WHERE sl.qty > 0)::int                                             AS lignes_ventes,
        COUNT(*) FILTER (WHERE sl.qty < 0)::int                                             AS lignes_retours,
        COUNT(*) FILTER (WHERE sl.raw->>'calcSubtotal' IS NULL)::int                        AS lignes_sans_calcsubtotal,
        COUNT(*) FILTER (WHERE sl.raw->>'calcSubtotal' IS NOT NULL)::int                    AS lignes_avec_calcsubtotal,
        ROUND(SUM(COALESCE((sl.raw->>'calcSubtotal')::numeric, sl.qty * sl.unit_price)),2)::float8  AS subtotal_all,
        ROUND(SUM(COALESCE((sl.raw->>'calcSubtotal')::numeric, sl.qty * sl.unit_price)) FILTER (WHERE sl.qty > 0),2)::float8 AS subtotal_ventes_only,
        ROUND(SUM(COALESCE((sl.raw->>'calcSubtotal')::numeric, sl.qty * sl.unit_price)) FILTER (WHERE sl.qty < 0),2)::float8 AS subtotal_retours_only,
        ROUND(SUM(sl.qty * sl.unit_price),2)::float8                                        AS sum_unit_price,
        ROUND(SUM(COALESCE((sl.raw->>'calcLineDiscount')::numeric,0)),2)::float8            AS sum_discounts,
        ROUND(SUM((sl.raw->>'calcTotal')::numeric - COALESCE((sl.raw->>'calcTax1')::numeric,0) - COALESCE((sl.raw->>'calcTax2')::numeric,0)),2)::float8 AS calctotal_pretax
      FROM sale_lines sl
      WHERE sl.completed_time BETWEEN $1 AND $2
        AND sl.qty IS NOT NULL
    `, [from, to]);
    res.json({ periode: { from, to }, ...rows[0] });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/admin/season-gap-diag
// GET /api/admin/product-descriptions?manufacturer=Eton&limit=50
// Show raw product descriptions to inspect size/variant format in DB
// ---------------------------------------------------------------------------
app.get('/api/admin/product-descriptions', async (req, res, next) => {
  try {
    const mfr   = req.query.manufacturer || 'Eton';
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const { rows } = await pool.query(
      `SELECT p.description, p.manufacturer, p.item_id, p.category,
              COALESCE(SUM(i.qty_on_hand), 0) AS total_stock
       FROM products p
       LEFT JOIN inventory i ON i.item_id = p.item_id
       WHERE p.manufacturer ILIKE $1 AND p.archived = false
       GROUP BY p.description, p.manufacturer, p.item_id, p.category
       ORDER BY p.description
       LIMIT $2`,
      [`%${mfr}%`, limit]
    );
    res.json({ manufacturer: mfr, count: rows.length, products: rows });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Diagnose the gap between Tag mode and Tag+Période mode for a given
// manufacturer / tag / shop.
// Example: /api/admin/season-gap-diag?manufacturer=Brax&tag=p26&shop_id=5
//
// Returns:
//  - summary: units inside season window vs outside
//  - outside_by_month: monthly breakdown of the "extra" units (before season start)
//  - outside_items: which articles are involved and when they sold
//  - tag_freshness: last sync date for those products (detects stale tags)
// ---------------------------------------------------------------------------
app.get('/api/admin/season-gap-diag', async (req, res, next) => {
  try {
    const mfr     = req.query.manufacturer || 'Brax';
    const tag     = req.query.tag          || 'p26';
    const shopId  = req.query.shop_id      || null;
    const tagPat  = `%${tag}%`;

    const season  = SEASON_RANGES[tag.toLowerCase()];
    if (!season) {
      return res.status(400).json({ error: `Tag "${tag}" n'est pas un code de saison connu.` });
    }
    const seasonFrom = season.from;
    const seasonTo   = new Date().toISOString().slice(0, 10) < season.to
      ? new Date().toISOString().slice(0, 10) : season.to;

    const shopCond = shopId ? `AND sl.shop_id = $3` : '';
    const params   = shopId ? [mfr, tagPat, shopId] : [mfr, tagPat];

    const [q1, q2, q3, q4] = await Promise.all([

      // 1. Summary: inside vs outside season window
      pool.query(`
        SELECT
          CASE WHEN sl.completed_time >= ${ shopId ? '$4' : '$3' }::date
                AND sl.completed_time <= ${ shopId ? '$5' : '$4' }::date
               THEN 'pendant_saison'
               ELSE 'hors_saison'
          END                                        AS period,
          COUNT(*)::int                              AS sale_lines,
          ROUND(SUM(sl.qty), 0)::float8              AS units,
          ROUND(SUM(sl.qty * sl.unit_price - COALESCE((sl.raw->>'calcLineDiscount')::numeric, 0)), 2)::float8 AS revenue,
          MIN(sl.completed_time)::date               AS earliest,
          MAX(sl.completed_time)::date               AS latest
        FROM sale_lines sl
        JOIN products p ON p.item_id = sl.item_id
        WHERE p.manufacturer ILIKE $1
          AND p.tags ILIKE $2
          AND sl.qty > 0
          AND sl.completed_time IS NOT NULL
          ${shopCond}
        GROUP BY 1
        ORDER BY 1
      `, [...params, seasonFrom, seasonTo]),

      // 2. Monthly breakdown of sales OUTSIDE the season window
      pool.query(`
        SELECT
          date_trunc('month', sl.completed_time)::date AS month,
          ROUND(SUM(sl.qty), 0)::float8                AS units,
          ROUND(SUM(sl.qty * sl.unit_price - COALESCE((sl.raw->>'calcLineDiscount')::numeric, 0)), 2)::float8 AS revenue,
          COUNT(DISTINCT sl.item_id)::int              AS distinct_items
        FROM sale_lines sl
        JOIN products p ON p.item_id = sl.item_id
        WHERE p.manufacturer ILIKE $1
          AND p.tags ILIKE $2
          AND sl.qty > 0
          AND sl.completed_time IS NOT NULL
          AND (sl.completed_time < ${ shopId ? '$4' : '$3' }::date
               OR sl.completed_time > ${ shopId ? '$5' : '$4' }::date)
          ${shopCond}
        GROUP BY 1
        ORDER BY 1 DESC
      `, [...params, seasonFrom, seasonTo]),

      // 3. Item-level detail for sales OUTSIDE season window
      pool.query(`
        SELECT
          p.item_id,
          p.description,
          p.tags,
          MIN(sl.completed_time)::date              AS first_sale,
          MAX(sl.completed_time)::date              AS last_sale,
          ROUND(SUM(sl.qty), 0)::float8             AS units_outside,
          ROUND(SUM(sl.qty * sl.unit_price - COALESCE((sl.raw->>'calcLineDiscount')::numeric, 0)), 2)::float8 AS revenue_outside
        FROM sale_lines sl
        JOIN products p ON p.item_id = sl.item_id
        WHERE p.manufacturer ILIKE $1
          AND p.tags ILIKE $2
          AND sl.qty > 0
          AND sl.completed_time IS NOT NULL
          AND (sl.completed_time < ${ shopId ? '$4' : '$3' }::date
               OR sl.completed_time > ${ shopId ? '$5' : '$4' }::date)
          ${shopCond}
        GROUP BY p.item_id, p.description, p.tags
        ORDER BY units_outside DESC
        LIMIT 50
      `, [...params, seasonFrom, seasonTo]),

      // 4. Tag freshness — last synced_at for products with this tag
      //    If synced_at is old, the tag might be stale (removed in LS but still in our DB)
      pool.query(`
        SELECT
          MIN(p.synced_at)::date AS oldest_sync,
          MAX(p.synced_at)::date AS newest_sync,
          COUNT(*)::int          AS product_count,
          COUNT(*) FILTER (WHERE p.synced_at < now() - INTERVAL '30 days')::int AS synced_over_30d_ago
        FROM products p
        WHERE p.manufacturer ILIKE $1
          AND p.tags ILIKE $2
      `, [mfr, tagPat]),

    ]);

    res.json({
      params:       { manufacturer: mfr, tag, shop_id: shopId, season_from: seasonFrom, season_to: seasonTo },
      summary:      q1.rows,
      outside_by_month: q2.rows,
      outside_items:    q3.rows,
      tag_freshness:    q4.rows[0],
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/admin/ls-inspect — fetch first page of a Lightspeed reference endpoint
// Usage: /api/admin/ls-inspect?resource=Category|Department|Manufacturer|ItemTag
// ---------------------------------------------------------------------------
app.get('/api/admin/ls-inspect', async (req, res, next) => {
  try {
    const resource = req.query.resource;
    const ALLOWED_RESOURCES = ['Category', 'Department', 'Manufacturer', 'ItemTag', 'Images', 'Transfer'];
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
    } else if (resource === 'Transfer') {
      url = `${BASE_URL}/Transfer.json?limit=3&load_relations=all`;
      resp = await axios.get(url, { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 30000 });
      res.json({ resource, url, data: resp.data });
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
// GET /api/admin/stock-audit?manufacturer=Brax&shop_id=1
// Diagnose stock discrepancy between Lightspeed and our DB
// ---------------------------------------------------------------------------
app.get('/api/admin/stock-audit', async (req, res, next) => {
  try {
    const mfr    = req.query.manufacturer || 'Brax';
    const shopId = req.query.shop_id      || '1';

    const [totals, syncInfo, positiveStock, samples, mvStock] = await Promise.all([
      // 1. Total stock for this manufacturer at this shop
      pool.query(`
        SELECT
          COUNT(*)                                          AS total_items,
          SUM(i.qty_on_hand)                               AS total_qty_on_hand,
          SUM(i.qty_on_order)                              AS total_qty_on_order,
          SUM(COALESCE(i.qty_on_hand,0) + COALESCE(i.qty_on_order,0)) AS total_stock
        FROM inventory i
        JOIN products p ON p.item_id = i.item_id
        WHERE p.manufacturer ILIKE $1
          AND i.shop_id = $2
          AND p.archived = false
      `, [mfr, shopId]),

      // 2. Last sync date for inventory rows of this manufacturer
      pool.query(`
        SELECT
          MAX(i.synced_at)  AS last_synced_at,
          MIN(i.synced_at)  AS oldest_synced_at,
          COUNT(*)          AS rows_synced
        FROM inventory i
        JOIN products p ON p.item_id = i.item_id
        WHERE p.manufacturer ILIKE $1
          AND i.shop_id = $2
      `, [mfr, shopId]),

      // 3. Count items with qty_on_hand > 0
      pool.query(`
        SELECT COUNT(*) AS items_with_stock
        FROM inventory i
        JOIN products p ON p.item_id = i.item_id
        WHERE p.manufacturer ILIKE $1
          AND i.shop_id = $2
          AND i.qty_on_hand > 0
          AND p.archived = false
      `, [mfr, shopId]),

      // 4. Sample of 10 items with their stock
      pool.query(`
        SELECT
          p.item_id,
          p.description,
          p.category,
          i.qty_on_hand,
          i.qty_on_order,
          i.reorder_point,
          i.synced_at
        FROM inventory i
        JOIN products p ON p.item_id = i.item_id
        WHERE p.manufacturer ILIKE $1
          AND i.shop_id = $2
          AND p.archived = false
        ORDER BY i.qty_on_hand DESC NULLS LAST
        LIMIT 10
      `, [mfr, shopId]),

      // 5. Cross-check: what mv_inventory_stock shows (all shops, no shop filter)
      pool.query(`
        SELECT
          SUM(mv.current_stock_all) AS mv_total_stock_all_shops,
          COUNT(*)                  AS mv_items
        FROM mv_inventory_stock mv
        JOIN products p ON p.item_id = mv.item_id
        WHERE p.manufacturer ILIKE $1
          AND p.archived = false
      `, [mfr]),
    ]);

    res.json({
      manufacturer: mfr,
      shop_id:      shopId,
      totals:       totals.rows[0],
      sync_info:    syncInfo.rows[0],
      positive_stock: positiveStock.rows[0],
      top_10_by_stock: samples.rows,
      mv_inventory_stock_all_shops: mvStock.rows[0],
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
// GET /api/admin/raw-attr?manufacturer=Eton&category=... — inspect raw attribute keys for a brand
app.get('/api/admin/raw-attr', async (req, res, next) => {
  try {
    const mfr = req.query.manufacturer || 'Eton';
    const cat = req.query.category || null;
    const params = [mfr];
    const catFilter = cat ? `AND category ILIKE $${params.push('%' + cat + '%') && params.length}` : '';
    const { rows: keyRows } = await pool.query(`
      SELECT jsonb_object_keys(raw) AS raw_key FROM products
      WHERE manufacturer = $1 ${catFilter} AND matrix_id IS NOT NULL AND archived = false
      LIMIT 300
    `, params);
    const keys = [...new Set(keyRows.map(r => r.raw_key))].sort();

    const { rows: samples } = await pool.query(`
      SELECT item_id, description, category
      FROM products
      WHERE manufacturer = $1 ${catFilter} AND matrix_id IS NOT NULL AND archived = false
      ORDER BY item_id LIMIT 30
    `, params);
    res.json({ raw_keys: keys, descriptions: samples.map(r => ({ id: r.item_id, cat: r.category, desc: r.description })) });
  } catch (err) { next(err); }
});

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
        SELECT item_id, shop_id, SUM(units_sold) / 12.0 AS avg_weekly_units
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

    // explain uses p25 as representative season for query plan analysis
    const saisQuery = `
      WITH season_sales AS (
        SELECT sl.item_id, SUM(sl.qty) AS units_sold_season
        FROM sale_lines sl
        WHERE sl.completed_time >= '2025-02-01'::date
          AND sl.completed_time <= '2025-09-30'::date
          AND sl.qty > 0
          AND sl.completed_time IS NOT NULL
        GROUP BY sl.item_id
      ),
      stock AS (SELECT item_id, current_stock_all AS current_stock FROM mv_inventory_stock)
      SELECT
        COALESCE(p.manufacturer, 'Sans marque') AS manufacturer,
        COALESCE(p.category, 'Sans catégorie')  AS category,
        COUNT(DISTINCT p.item_id)::int           AS items_count,
        ROUND(SUM(COALESCE(st.current_stock, 0)), 0)::float8             AS remaining_stock_units,
        ROUND(SUM(COALESCE(ss.units_sold_season, 0)), 0)::float8         AS reference_units_sold,
        ROUND(SUM(
          GREATEST(0, COALESCE(ss.units_sold_season, 0) - COALESCE(st.current_stock, 0))
          * COALESCE(p.default_cost, 0)
        ), 2)::float8 AS proposed_budget
      FROM products p
      LEFT JOIN season_sales ss ON ss.item_id = p.item_id
      LEFT JOIN stock        st ON st.item_id = p.item_id
      WHERE p.tags ILIKE '%p25%'
        AND p.tags NOT ILIKE '%nos%'
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

// ---------------------------------------------------------------------------
// GET /api/shops — shop list for dropdowns
// ---------------------------------------------------------------------------
app.get('/api/shops', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT shop_id, name FROM shops ORDER BY name');
    res.json(rows);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/admin/transfers-diag — diagnose transfer/receiving data in DB
// Checks: total rows, received rows, rows with season tags, sample
// ---------------------------------------------------------------------------
app.get('/api/admin/transfers-diag', async (req, res, next) => {
  try {
    const [totals, byFlag, bySeason, sample, topMfr] = await Promise.all([

      // 1. Overall counts
      pool.query(`
        SELECT
          COUNT(*)::int                                                  AS total_rows,
          COUNT(*) FILTER (WHERE transfer_received = true)::int         AS received_true,
          COUNT(*) FILTER (WHERE transfer_received = false)::int        AS received_false,
          COUNT(*) FILTER (WHERE qty_received > 0)::int                 AS qty_received_gt0,
          COUNT(*) FILTER (WHERE transfer_received = true AND qty_received > 0)::int AS usable,
          MIN(transfer_date)::date                                       AS earliest,
          MAX(transfer_date)::date                                       AS latest
        FROM transfers
      `),

      // 2. Rows joined to products with a season tag
      pool.query(`
        SELECT
          COUNT(*)::int                                                  AS rows_with_product,
          COUNT(*) FILTER (WHERE p.tags IS NOT NULL)::int                AS rows_with_tags,
          COUNT(*) FILTER (WHERE p.tags ~* 'p2[0-9]|a2[0-9]')::int      AS rows_with_season_tag,
          COUNT(*) FILTER (WHERE t.transfer_received = true
                             AND t.qty_received > 0
                             AND p.tags ~* 'p2[0-9]|a2[0-9]')::int     AS usable_with_season
        FROM transfers t
        JOIN products p ON p.item_id = t.item_id
      `),

      // 3. Received cost per season tag
      pool.query(`
        SELECT
          regexp_matches(lower(p.tags), '(p2[0-9]|a2[0-9])', 'g') AS season,
          COUNT(DISTINCT t.transfer_item_id)::int                   AS transfer_rows,
          COUNT(DISTINCT p.manufacturer)::int                       AS manufacturers,
          ROUND(SUM(t.qty_received))::int                           AS units_received,
          ROUND(SUM(t.qty_received * COALESCE(p.default_cost,0)),0)::float8 AS received_cost
        FROM transfers t
        JOIN products p ON p.item_id = t.item_id
        WHERE t.transfer_received = true
          AND t.qty_received > 0
          AND p.tags IS NOT NULL
          AND p.default_cost > 0
        GROUP BY regexp_matches(lower(p.tags), '(p2[0-9]|a2[0-9])', 'g')
        ORDER BY season
      `),

      // 4. Sample of 5 usable rows
      pool.query(`
        SELECT
          t.transfer_item_id,
          t.transfer_date::date,
          t.qty_received,
          p.manufacturer,
          p.tags,
          p.default_cost,
          ROUND(t.qty_received * COALESCE(p.default_cost,0), 2) AS line_cost
        FROM transfers t
        JOIN products p ON p.item_id = t.item_id
        WHERE t.transfer_received = true
          AND t.qty_received > 0
          AND p.tags ~* 'p2[0-9]|a2[0-9]'
          AND p.default_cost > 0
        ORDER BY t.transfer_date DESC NULLS LAST
        LIMIT 5
      `),

      // 5. Top 10 manufacturers by received cost (all seasons)
      pool.query(`
        SELECT
          COALESCE(p.manufacturer, 'Sans marque')                   AS manufacturer,
          ROUND(SUM(t.qty_received))::int                           AS units_received,
          ROUND(SUM(t.qty_received * COALESCE(p.default_cost,0)),0)::float8 AS received_cost
        FROM transfers t
        JOIN products p ON p.item_id = t.item_id
        WHERE t.transfer_received = true
          AND t.qty_received > 0
          AND p.tags ~* 'p2[0-9]|a2[0-9]'
          AND p.default_cost > 0
        GROUP BY p.manufacturer
        ORDER BY received_cost DESC
        LIMIT 10
      `),
    ]);

    res.json({
      totals:           totals.rows[0],
      product_join:     byFlag.rows[0],
      by_season:        bySeason.rows.map(r => ({ season: r.season?.[0], ...r, season: undefined })),
      sample_rows:      sample.rows,
      top_manufacturers: topMfr.rows,
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/settings/multipliers — read multiplier tier config
// PUT /api/settings/multipliers — update multiplier tier config
// Tiers format: [{ st_min: 0.80, multiplier: 1.25, label: 'Augmenter' }, …]
// st_min is a decimal fraction (0–1), not a percentage.
// ---------------------------------------------------------------------------
app.get('/api/settings/multipliers', async (req, res, next) => {
  try {
    const tiers = await getMultiplierTiers();
    res.json({ tiers });
  } catch (err) { next(err); }
});

app.put('/api/settings/multipliers', async (req, res, next) => {
  // NOTE: only updates app_settings — budget_plans (saved plan data) is never touched
  try {
    const { tiers } = req.body;
    if (!Array.isArray(tiers) || tiers.length === 0) {
      return res.status(400).json({ error: 'tiers must be a non-empty array' });
    }
    await pool.query(
      `INSERT INTO app_settings(key, value, updated_at)
       VALUES ('multiplier_tiers', $1::jsonb, now())
       ON CONFLICT(key) DO UPDATE SET value = $1::jsonb, updated_at = now()`,
      [JSON.stringify(tiers)]
    );
    budgetCache.clear();
    res.json({ ok: true, tiers });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/settings/seasons — read season config
// PUT /api/settings/seasons — update season config
// ---------------------------------------------------------------------------
app.get('/api/settings/seasons', async (req, res, next) => {
  try {
    const seasons = await getSeasonsConfig();
    res.json({ seasons });
  } catch (err) { next(err); }
});

app.put('/api/settings/seasons', async (req, res, next) => {
  try {
    const { seasons } = req.body;
    if (!Array.isArray(seasons) || seasons.length === 0) {
      return res.status(400).json({ error: 'seasons must be a non-empty array' });
    }
    await pool.query(
      `INSERT INTO app_settings(key, value, updated_at)
       VALUES ('seasons_config', $1::jsonb, now())
       ON CONFLICT(key) DO UPDATE SET value = $1::jsonb, updated_at = now()`,
      [JSON.stringify(seasons)]
    );
    budgetCache.clear();
    res.json({ ok: true, seasons });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/settings/budget-params — read budget params (nb_saisons_reference, carryover_deduction_rate)
// PUT /api/settings/budget-params — update budget params
// ---------------------------------------------------------------------------
app.get('/api/settings/budget-params', async (req, res, next) => {
  try {
    const params = await getBudgetParams();
    res.json(params);
  } catch (err) { next(err); }
});

app.put('/api/settings/budget-params', async (req, res, next) => {
  try {
    const ratesByShop = {};
    if (req.body.carryover_rates_by_shop && typeof req.body.carryover_rates_by_shop === 'object') {
      for (const [shopId, rate] of Object.entries(req.body.carryover_rates_by_shop)) {
        const r = parseFloat(rate);
        if (!isNaN(r)) ratesByShop[shopId] = Math.max(0, Math.min(1, r));
      }
    }
    const absentMode = ['show', 'hide'].includes(req.body.absent_brand_mode) ? req.body.absent_brand_mode : 'show';
    const params = {
      nb_saisons_reference:      Math.max(1, Math.min(10, parseInt(req.body.nb_saisons_reference ?? 3, 10))),
      carryover_deduction_rate:  Math.max(0, Math.min(1, parseFloat(req.body.carryover_deduction_rate ?? 0.5))),
      use_global_carryover_rate: req.body.use_global_carryover_rate !== false,
      carryover_rates_by_shop:   ratesByShop,
      recency_factor:            Math.max(1, Math.min(10, parseFloat(req.body.recency_factor ?? 2.0))),
      absent_brand_mode:         absentMode,
    };
    await pool.query(
      `INSERT INTO app_settings(key, value, updated_at)
       VALUES ('budget_params', $1::jsonb, now())
       ON CONFLICT(key) DO UPDATE SET value = $1::jsonb, updated_at = now()`,
      [JSON.stringify(params)]
    );
    budgetCache.clear();
    res.json({ ok: true, ...params });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/settings/nos-lead-times  — délais fournisseur par marque (en semaines)
// PUT /api/settings/nos-lead-times  — sauvegarder
// ---------------------------------------------------------------------------
app.get('/api/settings/nos-lead-times', async (req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT value FROM app_settings WHERE key = 'nos_lead_times'");
    res.json(rows.length ? rows[0].value : {});
  } catch (err) { next(err); }
});

app.put('/api/settings/nos-lead-times', async (req, res, next) => {
  try {
    const raw = req.body;
    const clean = {};
    for (const [brand, weeks] of Object.entries(raw)) {
      const w = parseInt(weeks, 10);
      if (brand && !isNaN(w) && w > 0) clean[brand] = w;
    }
    await pool.query(
      `INSERT INTO app_settings(key, value, updated_at)
       VALUES ('nos_lead_times', $1::jsonb, now())
       ON CONFLICT(key) DO UPDATE SET value = $1::jsonb, updated_at = now()`,
      [JSON.stringify(clean)]
    );
    res.json({ ok: true, lead_times: clean });
  } catch (err) { next(err); }
});

// GET /api/settings/nos-excluded  — articles exclus du rapport NOS (array of item_id strings)
// PUT /api/settings/nos-excluded
// ---------------------------------------------------------------------------
app.get('/api/settings/nos-excluded', async (req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT value FROM app_settings WHERE key = 'nos_excluded'");
    res.json(rows.length ? rows[0].value : []);
  } catch (err) { next(err); }
});

app.put('/api/settings/nos-excluded', async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body) ? req.body.map(String) : [];
    await pool.query(
      `INSERT INTO app_settings(key, value, updated_at)
       VALUES ('nos_excluded', $1::jsonb, now())
       ON CONFLICT(key) DO UPDATE SET value = $1::jsonb, updated_at = now()`,
      [JSON.stringify(ids)]
    );
    res.json({ ok: true, excluded: ids });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/nos/urgent — articles NOS à commander maintenant
// Un article est urgent si sa couverture actuelle < délai fournisseur de sa marque
// Tri par urgence décroissante (plus le déficit est grand, plus c'est critique)
// ---------------------------------------------------------------------------
app.get('/api/nos/urgent', async (req, res, next) => {
  try {
    const shopFilter = req.query.shop_id ? `AND i.shop_id = $1` : '';
    const params     = req.query.shop_id ? [req.query.shop_id] : [];

    // Load lead times from settings
    const { rows: ltRows } = await pool.query("SELECT value FROM app_settings WHERE key = 'nos_lead_times'");
    const leadTimes = ltRows.length ? ltRows[0].value : {};
    const defaultLeadTime = 8; // semaines par défaut si non configuré

    const { rows } = await pool.query(`
      WITH velocity AS (
        SELECT
          item_id,
          shop_id,
          SUM(units_sold) / 12.0 AS avg_12w,
          SUM(CASE WHEN week >= date_trunc('week', now()) - INTERVAL '4 weeks' THEN units_sold ELSE 0 END) / 4.0 AS avg_4w,
          GREATEST(
            SUM(units_sold) / 12.0,
            SUM(CASE WHEN week >= date_trunc('week', now()) - INTERVAL '4 weeks' THEN units_sold ELSE 0 END) / 4.0
          ) AS avg_weekly_units
        FROM mv_sales_velocity
        WHERE week >= date_trunc('week', now()) - INTERVAL '12 weeks'
        GROUP BY item_id, shop_id
      )
      SELECT
        p.item_id,
        p.description,
        COALESCE(p.manufacturer, 'Sans marque') AS manufacturer,
        COALESCE(p.category, 'Sans catégorie')  AS category,
        s.name                                   AS shop_name,
        i.shop_id,
        COALESCE(i.qty_on_hand, 0)               AS qty_on_hand,
        COALESCE(i.qty_on_order, 0)              AS qty_on_order,
        COALESCE(i.qty_on_hand,0) + COALESCE(i.qty_on_order,0) AS total_stock,
        ROUND(v.avg_weekly_units, 2)             AS avg_weekly_units,
        ROUND(
          CASE WHEN v.avg_weekly_units > 0
            THEN (COALESCE(i.qty_on_hand,0) + COALESCE(i.qty_on_order,0)) / v.avg_weekly_units
            ELSE NULL END, 1
        )                                        AS weeks_of_cover,
        COALESCE(p.default_cost, 0)              AS unit_cost
      FROM velocity v
      JOIN inventory i ON i.item_id = v.item_id AND i.shop_id = v.shop_id
      JOIN products  p ON p.item_id = v.item_id
      JOIN shops     s ON s.shop_id = i.shop_id
      WHERE p.tags ILIKE '%nos%'
        AND p.archived = false
        AND v.avg_weekly_units > 0
        AND p.category    NOT ILIKE 'Alt%ration%'
        AND p.description NOT ILIKE '%shopify%'
        AND NOT (p.default_cost = 0 AND p.default_price = 0)
        ${shopFilter}
      ORDER BY weeks_of_cover ASC NULLS LAST
    `, params);

    // Enrich with lead time and urgency level
    const items = rows.map(r => {
      const lead = leadTimes[r.manufacturer] ?? defaultLeadTime;
      const cover = r.weeks_of_cover !== null ? Number(r.weeks_of_cover) : null;
      const deficit = cover !== null ? lead - cover : null;
      const suggestedQty = Math.max(0, Math.round(Number(r.avg_weekly_units) * lead - Number(r.total_stock)));

      let urgency;
      if (cover === null || cover <= 0)        urgency = 'critique';
      else if (cover < lead * 0.5)             urgency = 'urgent';
      else if (cover < lead)                   urgency = 'attention';
      else                                     return null; // pas urgent

      return {
        item_id:        r.item_id,
        description:    r.description,
        manufacturer:   r.manufacturer,
        category:       r.category,
        shop_name:      r.shop_name,
        shop_id:        r.shop_id,
        qty_on_hand:    Number(r.qty_on_hand),
        qty_on_order:   Number(r.qty_on_order),
        avg_weekly:     Number(r.avg_weekly_units),
        avg_12w:        Math.round(Number(r.avg_12w) * 100) / 100,
        avg_4w:         Math.round(Number(r.avg_4w) * 100) / 100,
        recent_boost:   Number(r.avg_4w) > Number(r.avg_12w),
        weeks_of_cover: cover,
        lead_time_weeks: lead,
        deficit_weeks:  deficit !== null ? Math.round(deficit * 10) / 10 : null,
        suggested_qty:  suggestedQty,
        unit_cost:      Number(r.unit_cost),
        urgency,
      };
    }).filter(Boolean);

    // Sort: critique first, then urgent, then attention; within each by deficit desc
    const order = { critique: 0, urgent: 1, attention: 2 };
    items.sort((a, b) => order[a.urgency] - order[b.urgency] || (b.deficit_weeks ?? 0) - (a.deficit_weeks ?? 0));

    const totalCost = items.reduce((s, i) => s + i.suggested_qty * i.unit_cost, 0);

    res.json({
      generated_at:     new Date().toISOString(),
      default_lead_time: defaultLeadTime,
      lead_times:       leadTimes,
      count:            items.length,
      total_cost:       Math.round(totalCost * 100) / 100,
      items,
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/settings/tenant  — read tenant onboarding config
// PUT /api/settings/tenant  — save tenant onboarding config
// GET /api/admin/discover   — auto-discover DB structure for onboarding wizard
// ---------------------------------------------------------------------------
app.get('/api/settings/tenant', async (req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT value FROM app_settings WHERE key = 'tenant_config'");
    res.json(rows.length ? rows[0].value : {});
  } catch (err) { next(err); }
});

app.put('/api/settings/tenant', async (req, res, next) => {
  try {
    const config = req.body;
    await pool.query(
      `INSERT INTO app_settings(key, value, updated_at)
       VALUES ('tenant_config', $1::jsonb, now())
       ON CONFLICT(key) DO UPDATE SET value = $1::jsonb, updated_at = now()`,
      [JSON.stringify(config)]
    );
    res.json({ ok: true, config });
  } catch (err) { next(err); }
});

app.get('/api/admin/discover', async (req, res, next) => {
  try {
    const [cats, tags, descSamples] = await Promise.all([
      pool.query(`SELECT DISTINCT category, COUNT(*) as cnt FROM products WHERE category IS NOT NULL AND category != '' AND archived = false GROUP BY category ORDER BY cnt DESC LIMIT 30`),
      pool.query(`SELECT DISTINCT UNNEST(string_to_array(tags, ',')) AS tag, COUNT(*) as cnt FROM products WHERE tags IS NOT NULL AND tags != '' AND archived = false GROUP BY tag ORDER BY cnt DESC LIMIT 50`),
      pool.query(`SELECT description FROM products WHERE archived = false AND description IS NOT NULL ORDER BY RANDOM() LIMIT 5`),
    ]);
    res.json({
      categories:          cats.rows.map(r => ({ name: r.category, count: Number(r.cnt) })),
      tags:                tags.rows.map(r => ({ tag: r.tag.trim(), count: Number(r.cnt) })),
      description_samples: descSamples.rows.map(r => r.description),
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/budget/marque — Pre-season buying budget per brand (config-driven)
//
// Config loaded from app_settings: seasons_config, budget_params, multiplier_tiers.
// Data source: implied received = tagged items sold since reception_from + tagged inventory today.
//
// 7-step formula per brand:
//   1. implied_received = sold_since_recv_from + on_hand  (for each reference season)
//   2. ST = units_sold_during_season / implied_received_units
//   3. multiplier = from tiers based on avg_st
//   4. budget_ajuste = avg_hist × multiplier
//   5. carryover = MAX(0, stock_at_cost − ytd_sales × (remaining / elapsed))
//   6. budget_ajuste − (carryover × carryover_deduction_rate)
//   7. net_budget = MAX(0, step_6)
// ---------------------------------------------------------------------------
app.get('/api/budget/marque', async (req, res, next) => {
  try {
    const targetSeasonCode = (req.query.season ?? 'p26').toLowerCase();
    const shops = req.query.shops ? req.query.shops.split(',').filter(Boolean) : null;

    const cacheKey = JSON.stringify({ r: 'marque2', season: targetSeasonCode, shops });
    const hit = cacheGet(cacheKey);
    if (hit) return res.json({ ...hit, cached: true });

    const [tiers, seasonsConfig, budgetParams] = await Promise.all([
      getMultiplierTiers(),
      getSeasonsConfig(),
      getBudgetParams(),
    ]);
    const { nb_saisons_reference: nbRef, carryover_deduction_rate: globalCoRate,
            use_global_carryover_rate: useGlobal, carryover_rates_by_shop: ratesByShop,
            recency_factor: recencyFactor, absent_brand_mode: absentBrandMode = 'show' } = budgetParams;
    const coRate = (!useGlobal && shops?.length === 1 && ratesByShop?.[shops[0]] != null)
      ? ratesByShop[shops[0]]
      : globalCoRate;

    const targetSeason = seasonsConfig.find(s => s.code === targetSeasonCode);
    if (!targetSeason) return res.status(404).json({ error: `Season ${targetSeasonCode} not found in config` });

    const refSeasons = getReferenceSeasonsFromConfig(targetSeasonCode, seasonsConfig, nbRef);
    if (!refSeasons.length) return res.status(400).json({ error: `No reference seasons found for ${targetSeasonCode}` });

    const baseParams  = shops?.length ? [shops] : [];
    const shopCondSL  = shops?.length ? `AND sl.shop_id = ANY($1)` : '';
    const shopCondInv = shops?.length ? `AND i.shop_id = ANY($1)` : '';

    // Date math for target season
    const todayDate       = new Date(); todayDate.setHours(0,0,0,0);
    const todayStr        = todayDate.toISOString().split('T')[0];
    const targetSellStart = new Date(targetSeason.sell_from);
    const targetSellEnd   = new Date(targetSeason.sell_to);
    const isFutureSeason  = todayDate < targetSellStart;
    const isCurrentSeason = todayDate >= targetSellStart && todayDate <= targetSellEnd;

    // Carryover season = most-recent reference (for future buying) or target (for current/past)
    const carryoverSeason = isFutureSeason ? refSeasons[0] : targetSeason;
    const coSellStart     = new Date(carryoverSeason.sell_from);
    const coSellEnd       = new Date(carryoverSeason.sell_to);
    const coTotalDays     = (coSellEnd - coSellStart) / 86400000;
    const coElapsed       = Math.max(1, Math.min(coTotalDays, (todayDate - coSellStart) / 86400000));
    const coRemaining     = Math.max(0, (coSellEnd - todayDate) / 86400000);

    // Current stock tagged with carryover season
    const coTag       = `%${carryoverSeason.tag_pattern}%`;
    const coInvParams = [...baseParams, coTag];
    const coInvTagIdx = coInvParams.length;
    const { rows: coInvRows } = await pool.query(`
      SELECT
        COALESCE(p.manufacturer, 'Sans marque')                                  AS manufacturer,
        SUM(COALESCE(i.qty_on_hand, 0) * COALESCE(p.default_cost, 0))::float8   AS stock_at_cost
      FROM products p
      JOIN inventory i ON i.item_id = p.item_id
      WHERE p.tags ILIKE $${coInvTagIdx}
        AND p.tags NOT ILIKE '%nos%'
        AND p.default_cost > 0
        AND p.category    NOT ILIKE 'Alt%ration%'
        AND p.description NOT ILIKE '%shopify%'
        AND i.qty_on_hand > 0
        ${shopCondInv}
      GROUP BY p.manufacturer
    `, coInvParams);
    const stockMap = {};
    for (const r of coInvRows) stockMap[r.manufacturer] = parseFloat(r.stock_at_cost ?? 0);

    // YTD sales tagged with carryover season (from sell_from to today)
    const coSalesParams  = [...baseParams, carryoverSeason.sell_from, todayStr, coTag];
    const coSalesFromIdx = coSalesParams.length - 2;
    const coSalesToIdx   = coSalesParams.length - 1;
    const coSalesTagIdx  = coSalesParams.length;
    const { rows: coSalesRows } = await pool.query(`
      SELECT
        COALESCE(p.manufacturer, 'Sans marque')                               AS manufacturer,
        SUM(sl.qty * COALESCE(p.default_cost, 0))::float8                     AS sales_cost_ytd
      FROM sale_lines sl
      JOIN products p ON p.item_id = sl.item_id
      WHERE sl.completed_time >= $${coSalesFromIdx}::date
        AND sl.completed_time <= $${coSalesToIdx}::date
        AND sl.completed_time IS NOT NULL
        AND sl.qty > 0
        AND p.tags ILIKE $${coSalesTagIdx}
        AND p.tags NOT ILIKE '%nos%'
        AND p.default_cost > 0
        AND p.category    NOT ILIKE 'Alt%ration%'
        AND p.description NOT ILIKE '%shopify%'
        ${shopCondSL}
      GROUP BY p.manufacturer
    `, coSalesParams);
    const ytdSalesMap = {};
    for (const r of coSalesRows) ytdSalesMap[r.manufacturer] = parseFloat(r.sales_cost_ytd ?? 0);

    // For each reference season: compute implied received + units sold
    const seasonResults = {};
    for (const refSeason of refSeasons) {
      const refSellStart = new Date(refSeason.sell_from);
      const refSellEnd   = new Date(refSeason.sell_to);
      if (todayDate < refSellStart) continue; // future reference — no data yet

      const isRefInProgress = todayDate >= refSellStart && todayDate <= refSellEnd;
      const refTag          = `%${refSeason.tag_pattern}%`;

      // Implied received: tagged items sold since reception_from + tagged items in inventory today
      const irSlParams  = [...baseParams, refSeason.reception_from, refTag];
      const irSlFromIdx = irSlParams.length - 1;
      const irSlTagIdx  = irSlParams.length;
      const { rows: irSlRows } = await pool.query(`
        SELECT
          COALESCE(p.manufacturer, 'Sans marque')                               AS manufacturer,
          SUM(sl.qty)::float8                                                    AS qty_sold_all,
          SUM(sl.qty * COALESCE(p.default_cost, 0))::float8                     AS sold_cost
        FROM sale_lines sl
        JOIN products p ON p.item_id = sl.item_id
        WHERE sl.completed_time >= $${irSlFromIdx}::date
          AND sl.completed_time IS NOT NULL
          AND sl.qty > 0
          AND p.tags ILIKE $${irSlTagIdx}
          AND p.tags NOT ILIKE '%nos%'
          AND p.category    NOT ILIKE 'Alt%ration%'
          AND p.description NOT ILIKE '%shopify%'
          ${shopCondSL}
        GROUP BY p.manufacturer
      `, irSlParams);

      const irInvParams  = [...baseParams, refTag];
      const irInvTagIdx  = irInvParams.length;
      const { rows: irInvRows } = await pool.query(`
        SELECT
          COALESCE(p.manufacturer, 'Sans marque')                                  AS manufacturer,
          SUM(COALESCE(i.qty_on_hand, 0))::float8                                   AS qty_on_hand,
          SUM(COALESCE(i.qty_on_hand, 0) * COALESCE(p.default_cost, 0))::float8    AS stock_cost
        FROM products p
        JOIN inventory i ON i.item_id = p.item_id
        WHERE p.tags ILIKE $${irInvTagIdx}
          AND p.tags NOT ILIKE '%nos%'
          AND p.category    NOT ILIKE 'Alt%ration%'
          AND p.description NOT ILIKE '%shopify%'
          AND i.qty_on_hand > 0
          ${shopCondInv}
        GROUP BY p.manufacturer
      `, irInvParams);

      // Units sold DURING season (ST numerator)
      const slParams  = [...baseParams, refSeason.sell_from, refSeason.sell_to, refTag];
      const slFromIdx = slParams.length - 2;
      const slToIdx   = slParams.length - 1;
      const slTagIdx  = slParams.length;
      const { rows: slRows } = await pool.query(`
        SELECT
          COALESCE(p.manufacturer, 'Sans marque')                AS manufacturer,
          SUM(sl.qty)::float8                                     AS units_sold,
          SUM(sl.qty * COALESCE(p.default_cost, 0))::float8      AS sold_cost
        FROM sale_lines sl
        JOIN products p ON p.item_id = sl.item_id
        WHERE sl.completed_time >= $${slFromIdx}::date
          AND sl.completed_time <= $${slToIdx}::date
          AND sl.completed_time IS NOT NULL
          AND sl.qty > 0
          AND p.tags ILIKE $${slTagIdx}
          AND p.tags NOT ILIKE '%nos%'
          AND p.category    NOT ILIKE 'Alt%ration%'
          AND p.description NOT ILIKE '%shopify%'
          ${shopCondSL}
        GROUP BY p.manufacturer
      `, slParams);

      const irSlMap    = {};
      for (const r of irSlRows)  irSlMap[r.manufacturer]  = { qty: parseFloat(r.qty_sold_all ?? 0), cost: parseFloat(r.sold_cost ?? 0) };
      const irInvMap   = {};
      for (const r of irInvRows) irInvMap[r.manufacturer] = { qty: parseFloat(r.qty_on_hand ?? 0),  cost: parseFloat(r.stock_cost ?? 0) };
      const soldMap      = {};
      const soldCostMap  = {};
      for (const r of slRows) {
        soldMap[r.manufacturer]     = parseFloat(r.units_sold ?? 0);
        soldCostMap[r.manufacturer] = parseFloat(r.sold_cost  ?? 0);
      }

      const allMfrsRef = new Set([...Object.keys(irSlMap), ...Object.keys(irInvMap)]);
      seasonResults[refSeason.code] = {};

      // For in-progress reference seasons: estimate remaining using historical window avg.
      // projected = YTD actuals + avg(sales during equivalent remaining window in past N seasons).
      // Brands with no past-season history in that window fall back to linear (÷ completion).
      let histRemaining  = null;
      let refElapsedDays = 0;
      let refCompletion  = 1;
      if (isRefInProgress) {
        const refTotalDays   = (refSellEnd - refSellStart) / 86400000;
        refElapsedDays = Math.max(1, (todayDate - refSellStart) / 86400000);
        refCompletion  = Math.min(1, refElapsedDays / refTotalDays);

        if (refCompletion > 0.05) {
          const prevSeasonsForRef    = getReferenceSeasonsFromConfig(refSeason.code, seasonsConfig, nbRef);
          const completedPrevSeasons = prevSeasonsForRef.filter(s => todayDate > new Date(s.sell_to));

          if (completedPrevSeasons.length > 0) {
            histRemaining = {};
            for (const prevSeas of completedPrevSeasons) {
              const prevSellStart  = new Date(prevSeas.sell_from);
              const prevSellEnd    = new Date(prevSeas.sell_to);
              // Map today's position in refSeason to the equivalent date in prevSeas
              const prevWindowFrom = new Date(prevSellStart.getTime() + refElapsedDays * 86400000);
              if (prevWindowFrom >= prevSellEnd) continue;

              const prevTag   = `%${prevSeas.tag_pattern}%`;
              const rwParams  = [...baseParams, prevWindowFrom.toISOString().slice(0, 10), prevSeas.sell_to, prevTag];
              const rwFromIdx = rwParams.length - 2;
              const rwToIdx   = rwParams.length - 1;
              const rwTagIdx  = rwParams.length;

              const { rows: rwRows } = await pool.query(`
                SELECT
                  COALESCE(p.manufacturer, 'Sans marque')                AS manufacturer,
                  SUM(sl.qty * COALESCE(p.default_cost, 0))::float8      AS remaining_cost,
                  SUM(sl.qty)::float8                                     AS remaining_units
                FROM sale_lines sl
                JOIN products p ON p.item_id = sl.item_id
                WHERE sl.completed_time >= $${rwFromIdx}::date
                  AND sl.completed_time <= $${rwToIdx}::date
                  AND sl.completed_time IS NOT NULL
                  AND sl.qty > 0
                  AND p.tags ILIKE $${rwTagIdx}
                  AND p.tags NOT ILIKE '%nos%'
                  AND p.category    NOT ILIKE 'Alt%ration%'
                  AND p.description NOT ILIKE '%shopify%'
                  ${shopCondSL}
                GROUP BY p.manufacturer
              `, rwParams);

              for (const r of rwRows) {
                const m = r.manufacturer;
                if (!histRemaining[m]) histRemaining[m] = { totalCost: 0, totalUnits: 0, count: 0 };
                histRemaining[m].totalCost  += parseFloat(r.remaining_cost  ?? 0);
                histRemaining[m].totalUnits += parseFloat(r.remaining_units ?? 0);
                histRemaining[m].count++;
              }
            }
          }
        }
      }

      for (const mfr of allMfrsRef) {
        const sl  = irSlMap[mfr]  ?? { qty: 0, cost: 0 };
        const inv = irInvMap[mfr] ?? { qty: 0, cost: 0 };
        let impliedUnits = sl.qty + inv.qty;
        let impliedCost  = sl.cost + inv.cost;
        if (impliedCost <= 0) continue;

        // Capture YTD values before projection
        const impliedUnitsYtd = impliedUnits;
        const soldRaw         = soldMap[mfr]     ?? 0;
        const soldCostRaw     = soldCostMap[mfr] ?? 0;
        const stYtd           = impliedUnitsYtd >= 5 ? soldRaw / impliedUnitsYtd : null;

        let soldForSt    = soldRaw;
        let soldCostProj = soldCostRaw;
        if (isRefInProgress && refCompletion > 0.05) {
          const rem = histRemaining?.[mfr];
          if (rem && rem.count > 0) {
            // Average only over seasons that actually had sales for this brand in remaining window
            const avgRemCost  = rem.totalCost  / rem.count;
            const avgRemUnits = rem.totalUnits / rem.count;
            impliedCost   += avgRemCost;
            impliedUnits  += avgRemUnits;
            soldForSt     += avgRemUnits;
            soldCostProj  += avgRemCost;
          } else {
            // No past history for this brand in remaining window → linear fallback
            impliedCost   = impliedCost  / refCompletion;
            impliedUnits  = impliedUnits / refCompletion;
            soldForSt     = soldRaw      / refCompletion;
            soldCostProj  = soldCostRaw  / refCompletion;
          }
        }

        // Budget base = avg(received cost, sold cost) — anchors buying to actual demand.
        // When ST=100%: same as received. When ST drops: budget naturally dampened.
        const blendedCost = (impliedCost + soldCostProj) / 2;

        const recv = impliedUnits;
        const st   = recv >= 5 ? soldForSt / recv : null;

        seasonResults[refSeason.code][mfr] = {
          units_received:    Math.round(recv),
          units_sold:        Math.round(soldForSt),
          units_sold_ytd:    Math.round(soldRaw),
          received_cost:     Math.round(blendedCost * 100) / 100,
          received_cost_raw: Math.round(impliedCost * 100) / 100,
          sold_cost:         Math.round(soldCostProj * 100) / 100,
          st_rate:           st !== null ? Math.round(st * 1000) / 1000 : null,
          st_rate_ytd:       stYtd !== null ? Math.round(stYtd * 1000) / 1000 : null,
          st_insufficient:   recv < 5,
          partial:           isRefInProgress,
        };
      }
    }

    // Aggregate per brand
    const allMfr = new Set();
    for (const code of Object.keys(seasonResults)) {
      Object.keys(seasonResults[code] ?? {}).forEach(m => allMfr.add(m));
    }

    const byManufacturer = [];
    for (const mfr of allMfr) {
      const seasons      = {};
      const weightedData = []; // { cost, st, weight } — index 0 = most recent

      for (let i = 0; i < refSeasons.length; i++) {
        const refSeason = refSeasons[i];
        const d = seasonResults[refSeason.code]?.[mfr];
        if (d) {
          seasons[refSeason.code] = d;
          // Most recent (i=0) gets highest weight: recencyFactor^(N-1), oldest gets 1
          const weight = Math.pow(recencyFactor, refSeasons.length - 1 - i);
          weightedData.push({
            cost:   d.received_cost > 0 ? d.received_cost : null,
            st:     d.st_rate,
            weight,
            code:   refSeason.code,
          });
        }
      }

      const costEntries = weightedData.filter(x => x.cost !== null);
      if (!costEntries.length) continue;

      const totalCostWeight = costEntries.reduce((s, x) => s + x.weight, 0);
      const avgHist = costEntries.reduce((s, x) => s + x.cost * x.weight, 0) / totalCostWeight;
      const minHist = Math.min(...costEntries.map(x => x.cost));
      const maxHist = Math.max(...costEntries.map(x => x.cost));

      const stEntries  = weightedData.filter(x => x.st !== null);
      const totalStWeight = stEntries.reduce((s, x) => s + x.weight, 0);
      const avgSt = stEntries.length
        ? stEntries.reduce((s, x) => s + x.st * x.weight, 0) / totalStWeight
        : null;

      // YTD + projected ST for the most recent in-progress reference season
      const mostRecentData      = seasonResults[refSeasons[0]?.code]?.[mfr];
      const recentStYtd         = mostRecentData?.partial ? mostRecentData.st_rate_ytd         : null;
      const recentStProjected   = mostRecentData?.partial ? mostRecentData.st_rate              : null;
      const recentSeasonCode    = mostRecentData?.partial ? refSeasons[0]?.code                 : null;

      // Trend: ST direction from oldest to most-recent reference season with data
      // +10 pts → hausse, -10 pts → baisse (absolute percentage points, not relative)
      let trend = 'stable';
      const codesWithSt = refSeasons.map(s => s.code).filter(c => seasonResults[c]?.[mfr]?.st_rate != null);
      if (codesWithSt.length >= 2) {
        const latestSt = seasonResults[codesWithSt[0]][mfr].st_rate;
        const oldestSt = seasonResults[codesWithSt[codesWithSt.length - 1]][mfr].st_rate;
        if (latestSt > oldestSt + 0.10)      trend = 'hausse';
        else if (latestSt < oldestSt - 0.10) trend = 'baisse';
      }

      // Low ST alert: ST < 40% for two most recent consecutive seasons
      const recentSts = refSeasons
        .slice(0, 2)
        .map(s => seasonResults[s.code]?.[mfr]?.st_rate ?? null);
      const lowStAlert = recentSts.length === 2
        && recentSts[0] !== null && recentSts[1] !== null
        && recentSts[0] < 0.40 && recentSts[1] < 0.40;

      const hyp            = applyMultiplierTiers(avgSt, tiers);
      const avgHistRounded = Math.round(avgHist * 100) / 100;
      const adjustedBudget = Math.round(avgHistRounded * hyp.multiplier * 100) / 100;

      // Step 5: carryover = MAX(0, stock − ytd_sales × (remaining / elapsed))
      const stockCost = stockMap[mfr]    ?? 0;
      const ytdSales  = ytdSalesMap[mfr] ?? 0;
      let carryover   = 0;
      let budgetMode  = 'historical';

      if (coElapsed > 1) {
        const projectedRemaining = ytdSales > 0
          ? ytdSales * (coRemaining / coElapsed)
          : 0;
        carryover  = Math.max(0, Math.round((stockCost - projectedRemaining) * 100) / 100);
        budgetMode = isFutureSeason ? 'future' : (isCurrentSeason ? 'current' : 'historical');
      } else if (stockCost > 0) {
        carryover  = Math.round(stockCost * 100) / 100;
        budgetMode = isFutureSeason ? 'future' : 'historical';
      }

      // Steps 6–7
      const carryoverDeduction = Math.round(carryover * coRate * 100) / 100;
      const netBudget          = Math.max(0, Math.round((adjustedBudget - carryoverDeduction) * 100) / 100);

      // Flag brands absent from the most recent reference season
      const mostRecentRef = refSeasons[0];
      const absentRecent  = !seasonResults[mostRecentRef?.code]?.[mfr];

      byManufacturer.push({
        manufacturer:          mfr,
        seasons_count:         costEntries.length,
        seasons,
        absent_recent_season:  absentRecent,
        most_recent_ref:       mostRecentRef?.code ?? null,
        avg_hist:              avgHistRounded,
        avg_received_cost:     avgHistRounded,
        min_received_cost:     Math.round(minHist * 100) / 100,
        max_received_cost:     Math.round(maxHist * 100) / 100,
        avg_st:                avgSt !== null ? Math.round(avgSt * 1000) / 1000 : null,
        recent_st_ytd:         recentStYtd       !== null ? Math.round(recentStYtd * 1000)       / 1000 : null,
        recent_st_projected:   recentStProjected !== null ? Math.round(recentStProjected * 1000) / 1000 : null,
        recent_season_code:    recentSeasonCode,
        recent_received_cost:  seasons[refSeasons[0]?.code]?.received_cost_raw ?? null,
        trend,
        low_st_alert:          lowStAlert,
        multiplier:            hyp.multiplier,
        multiplier_label:      hyp.label,
        tier_threshold:        hyp.tier_threshold,
        adjusted_budget:       adjustedBudget,
        stock_at_cost:         Math.round(stockCost * 100) / 100,
        ytd_sales:             Math.round(ytdSales * 100) / 100,
        carryover:             carryover,
        carryover_deduction:   carryoverDeduction,
        net_budget:            netBudget,
        budget_mode:           budgetMode,
        elapsed_days:          Math.round(coElapsed),
        remaining_days:        Math.round(coRemaining),
        carryover_season:      carryoverSeason.code,
      });
    }

    // Filter absent brands if mode is 'hide', and redistribute their budget proportionally
    const filteredManufacturers = absentBrandMode === 'hide'
      ? byManufacturer.filter(m => !m.absent_recent_season)
      : byManufacturer;

    if (absentBrandMode === 'hide' && filteredManufacturers.length > 0) {
      const hiddenTotal   = byManufacturer
        .filter(m => m.absent_recent_season)
        .reduce((s, m) => s + m.net_budget, 0);

      if (hiddenTotal > 0) {
        const visibleTotal = filteredManufacturers.reduce((s, m) => s + m.net_budget, 0);
        filteredManufacturers.forEach(m => {
          const share = visibleTotal > 0
            ? m.net_budget / visibleTotal
            : 1 / filteredManufacturers.length;
          const redistribution = Math.round(hiddenTotal * share * 100) / 100;
          m.redistributed_amount = redistribution;
          m.net_budget           = Math.round((m.net_budget + redistribution) * 100) / 100;
        });
      }
    }

    filteredManufacturers.sort((a, b) => b.net_budget - a.net_budget);

    const totalHist     = filteredManufacturers.reduce((s, m) => s + m.avg_hist, 0);
    const totalAdj      = filteredManufacturers.reduce((s, m) => s + m.adjusted_budget, 0);
    const totalCarryDed = filteredManufacturers.reduce((s, m) => s + m.carryover_deduction, 0);
    const totalNet      = filteredManufacturers.reduce((s, m) => s + m.net_budget, 0);

    const result = {
      target_season:            targetSeasonCode,
      target_season_label:      targetSeason.label,
      is_future_season:         isFutureSeason,
      reference_seasons:        refSeasons.map(s => s.code),
      reference_seasons_label:  refSeasons.map(s => s.code.toUpperCase()).join(', '),
      nb_saisons_reference:     nbRef,
      carryover_deduction_rate: coRate,
      absent_brand_mode:        absentBrandMode,
      generated_at:             new Date().toISOString(),
      elapsed_days:             Math.round(coElapsed),
      remaining_days:           Math.round(coRemaining),
      carryover_season:         carryoverSeason.code,
      totals: {
        hist:               Math.round(totalHist * 100) / 100,
        adjusted:           Math.round(totalAdj * 100) / 100,
        carryover_deducted: Math.round(totalCarryDed * 100) / 100,
        net:                Math.round(totalNet * 100) / 100,
        brands_count:       filteredManufacturers.length,
        brands_hidden:      byManufacturer.length - filteredManufacturers.length,
      },
      total_proposed_budget:  Math.round(totalHist * 100) / 100,
      total_adjusted_budget:  Math.round(totalAdj * 100) / 100,
      total_net_budget:       Math.round(totalNet * 100) / 100,
      manufacturer_count:     filteredManufacturers.length,
      by_manufacturer:        filteredManufacturers,
    };

    cacheSet(cacheKey, result);
    res.json(result);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Budget plan routes — per (season, manufacturer, drop, shop)
// ---------------------------------------------------------------------------
app.get('/api/budget-plan', async (req, res, next) => {
  try {
    const season = (req.query.season ?? 'p26').toLowerCase();
    const [planRows, dropRows] = await Promise.all([
      pool.query(
        `SELECT manufacturer, drop_id, shop_id, planned_amount::float8 AS planned_amount
         FROM budget_plans WHERE season_code = $1`,
        [season]
      ),
      pool.query(
        `SELECT manufacturer, drop_id, drop_name, drop_order
         FROM budget_plan_drops WHERE season_code = $1
         ORDER BY manufacturer, drop_order`,
        [season]
      ),
    ]);

    // Shape: { [mfr]: { [drop_id]: { [shop_id]: amount } } }
    const byMfr = {};
    for (const r of planRows.rows) {
      if (!byMfr[r.manufacturer]) byMfr[r.manufacturer] = {};
      if (!byMfr[r.manufacturer][r.drop_id]) byMfr[r.manufacturer][r.drop_id] = {};
      byMfr[r.manufacturer][r.drop_id][r.shop_id] = parseFloat(r.planned_amount ?? 0);
    }

    // Shape: { [mfr]: [{ drop_id, drop_name, drop_order }] }
    const drops = {};
    for (const r of dropRows.rows) {
      if (!drops[r.manufacturer]) drops[r.manufacturer] = [];
      drops[r.manufacturer].push({ drop_id: r.drop_id, drop_name: r.drop_name, drop_order: r.drop_order });
    }

    res.json({ season_code: season, by_manufacturer: byMfr, drops });
  } catch (err) { next(err); }
});

// Upsert one amount entry
app.put('/api/budget-plan', async (req, res, next) => {
  try {
    const { season_code, manufacturer, drop_id = 'drop_1', shop_id = '__all__', planned_amount } = req.body;
    if (!season_code || !manufacturer) return res.status(400).json({ error: 'season_code and manufacturer are required' });
    const amount = Math.max(0, parseFloat(planned_amount ?? 0));
    const sc = season_code.toLowerCase();
    await pool.query(
      `INSERT INTO budget_plans(season_code, manufacturer, drop_id, shop_id, planned_amount, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT(season_code, manufacturer, drop_id, shop_id)
       DO UPDATE SET planned_amount = $5, updated_at = now()`,
      [sc, manufacturer, drop_id, shop_id, amount]
    );
    // Ensure drop metadata exists
    await pool.query(
      `INSERT INTO budget_plan_drops(season_code, manufacturer, drop_id, drop_name, drop_order)
       VALUES ($1, $2, $3, 'Drop 1', 1)
       ON CONFLICT DO NOTHING`,
      [sc, manufacturer, drop_id]
    );
    res.json({ ok: true, season_code: sc, manufacturer, drop_id, shop_id, planned_amount: amount });
  } catch (err) { next(err); }
});

// Create a new drop for a brand
app.post('/api/budget-plan/drop', async (req, res, next) => {
  try {
    const { season_code, manufacturer, drop_name } = req.body;
    if (!season_code || !manufacturer) return res.status(400).json({ error: 'season_code and manufacturer are required' });
    const sc = season_code.toLowerCase();
    const { rows: existing } = await pool.query(
      `SELECT drop_id, drop_order FROM budget_plan_drops WHERE season_code = $1 AND manufacturer = $2 ORDER BY drop_order`,
      [sc, manufacturer]
    );
    const nextOrder  = (existing[existing.length - 1]?.drop_order ?? 0) + 1;
    const newDropId  = `drop_${nextOrder}`;
    const name       = drop_name?.trim() || `Drop ${nextOrder}`;
    await pool.query(
      `INSERT INTO budget_plan_drops(season_code, manufacturer, drop_id, drop_name, drop_order)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [sc, manufacturer, newDropId, name, nextOrder]
    );
    res.json({ ok: true, drop_id: newDropId, drop_name: name, drop_order: nextOrder });
  } catch (err) { next(err); }
});

// Rename a drop
app.put('/api/budget-plan/drop', async (req, res, next) => {
  try {
    const { season_code, manufacturer, drop_id, drop_name } = req.body;
    if (!season_code || !manufacturer || !drop_id) return res.status(400).json({ error: 'season_code, manufacturer and drop_id are required' });
    const name = drop_name?.trim() || drop_id;
    await pool.query(
      `UPDATE budget_plan_drops SET drop_name = $4, updated_at = now()
       WHERE season_code = $1 AND manufacturer = $2 AND drop_id = $3`,
      [season_code.toLowerCase(), manufacturer, drop_id, name]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Delete a drop and all its amounts
app.delete('/api/budget-plan/drop', async (req, res, next) => {
  try {
    const { season_code, manufacturer, drop_id } = req.body;
    if (!season_code || !manufacturer || !drop_id) return res.status(400).json({ error: 'season_code, manufacturer and drop_id are required' });
    if (drop_id === 'drop_1') return res.status(400).json({ error: 'Cannot delete the primary drop' });
    const sc = season_code.toLowerCase();
    await pool.query(`DELETE FROM budget_plans        WHERE season_code = $1 AND manufacturer = $2 AND drop_id = $3`, [sc, manufacturer, drop_id]);
    await pool.query(`DELETE FROM budget_plan_drops   WHERE season_code = $1 AND manufacturer = $2 AND drop_id = $3`, [sc, manufacturer, drop_id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Budget document routes — binary file storage per (season, manufacturer, drop)
// ---------------------------------------------------------------------------

// List documents (no file data)
app.get('/api/budget-plan/documents', async (req, res, next) => {
  try {
    const { season, manufacturer, drop_id } = req.query;
    if (!season || !manufacturer) return res.status(400).json({ error: 'season and manufacturer are required' });
    const conditions = ['season_code = $1', 'manufacturer = $2'];
    const params     = [season.toLowerCase(), manufacturer];
    if (drop_id) { conditions.push(`drop_id = $${params.length + 1}`); params.push(drop_id); }
    const { rows } = await pool.query(
      `SELECT id, drop_id, filename, content_type, file_size, uploaded_at
       FROM budget_documents WHERE ${conditions.join(' AND ')} ORDER BY uploaded_at`,
      params
    );
    res.json({ docs: rows });
  } catch (err) { next(err); }
});

// Upload a document (base64 JSON body)
app.post('/api/budget-plan/document', async (req, res, next) => {
  try {
    const { season_code, manufacturer, drop_id = 'drop_1', filename, content_type, data_base64 } = req.body;
    if (!season_code || !manufacturer || !filename || !data_base64)
      return res.status(400).json({ error: 'season_code, manufacturer, filename, data_base64 are required' });
    const buf = Buffer.from(data_base64, 'base64');
    const { rows } = await pool.query(
      `INSERT INTO budget_documents(season_code, manufacturer, drop_id, filename, content_type, file_size, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [season_code.toLowerCase(), manufacturer, drop_id, filename,
       content_type || 'application/octet-stream', buf.length, buf]
    );
    res.json({ ok: true, id: rows[0].id, filename });
  } catch (err) { next(err); }
});

// Download a document by id
app.get('/api/budget-plan/document/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT filename, content_type, data FROM budget_documents WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const { filename, content_type, data } = rows[0];
    res.setHeader('Content-Type', content_type);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.send(data);
  } catch (err) { next(err); }
});

// Delete a document
app.delete('/api/budget-plan/document/:id', async (req, res, next) => {
  try {
    await pool.query(`DELETE FROM budget_documents WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/brand/:manufacturer — brand detail page data
// ?shop_id= optional shop filter (applies to sales + stock)
// ---------------------------------------------------------------------------
app.get('/api/brand/:manufacturer', async (req, res, next) => {
  try {
    const mfr    = decodeURIComponent(req.params.manufacturer);
    const shopId = req.query.shop_id || null;
    const hasShop = !!shopId;
    const p      = hasShop ? [mfr, shopId] : [mfr];
    const slS    = hasShop ? 'AND sl.shop_id = $2'     : '';
    const invJ   = hasShop ? 'AND i.shop_id  = $2'     : '';
    const stCTE  = `
      st AS (
        SELECT item_id,
               SUM(COALESCE(qty_on_hand,0) + COALESCE(qty_on_order,0)) AS stock
        FROM   inventory
        WHERE  1=1 ${hasShop ? 'AND shop_id = $2' : ''}
        GROUP  BY item_id
      )`;

    // Resolve season for sell-through
    const today = new Date();
    const requestedCode = (req.query.season ?? '').toLowerCase();
    const allTime = !requestedCode; // empty → no date filter, full history
    let seasonCode, season, stFrom, stTo;
    if (!allTime) {
      seasonCode = SEASON_RANGES[requestedCode]
        ? requestedCode
        : Object.entries(SEASON_RANGES).find(([, r]) =>
            new Date(r.from) <= today && today <= new Date(r.to)
          )?.[0] ?? 'p26';
      season = SEASON_RANGES[seasonCode];
      stFrom = season.from;
      stTo   = today.toISOString().slice(0, 10) < season.to ? today.toISOString().slice(0, 10) : season.to;
    }

    // Q6 — Transfers balance for this shop (only meaningful when shop filter active)
    const q6Promise = hasShop
      ? pool.query(`
          SELECT
            COALESCE(SUM(CASE WHEN t.to_shop_id   = $2 THEN t.qty_received ELSE 0 END), 0)::float8 AS received_in,
            COALESCE(SUM(CASE WHEN t.from_shop_id = $2 THEN t.qty_received ELSE 0 END), 0)::float8 AS sent_out
          FROM transfers t
          JOIN products p ON p.item_id = t.item_id
          WHERE p.manufacturer ILIKE $1
            AND t.transfer_received = true
            AND t.item_id IS NOT NULL
            AND (t.from_shop_id = $2 OR t.to_shop_id = $2)
        `, p)
      : Promise.resolve({ rows: [{ received_in: 0, sent_out: 0 }] });

    // Q1 — sell-through (season date range) + revenue_12w (last 12w + season tag)
    // Param layout:
    //   allTime + no shop : $1=mfr
    //   allTime + shop    : $1=mfr  $2=shopId
    //   season + no shop  : $1=mfr  $2=stFrom  $3=stTo  $4='%tag%'
    //   season + shop     : $1=mfr  $2=shopId  $3=stFrom $4=stTo  $5='%tag%'
    const seasonTag = allTime ? null : `%${seasonCode}%`;
    let q1Promise;
    if (allTime) {
      q1Promise = pool.query(`
        SELECT
          COUNT(DISTINCT sl.item_id)::int               AS active_items,
          ROUND(SUM(sl.qty), 0)::float8                 AS units_sold_season,
          ROUND(SUM(sl.qty * sl.unit_price - COALESCE((sl.raw->>'calcLineDiscount')::numeric, 0)), 2)::float8 AS revenue_season,
          ROUND(SUM(sl.qty) / GREATEST(1, EXTRACT(EPOCH FROM (now()-MIN(sl.completed_time)))/604800.0), 1)::float8
                                                        AS weekly_velocity,
          ROUND(SUM(CASE WHEN sl.completed_time >= now() - INTERVAL '12 weeks'
                         THEN sl.qty * sl.unit_price - COALESCE((sl.raw->>'calcLineDiscount')::numeric, 0) ELSE 0 END), 2)::float8
                                                        AS revenue_12w
        FROM sale_lines sl
        JOIN products p ON p.item_id = sl.item_id
        WHERE p.manufacturer ILIKE $1
          AND sl.completed_time IS NOT NULL
          ${slS}
      `, p);
    } else if (hasShop) {
      // $1=mfr $2=shopId $3=stFrom $4=stTo $5='%tag%'
      // No date filter in WHERE — CASEs handle mode 1 (tag) and mode 2 (tag+period)
      q1Promise = pool.query(`
        SELECT
          COUNT(DISTINCT CASE WHEN p.tags ILIKE $5 THEN sl.item_id END)::int AS active_items,
          ROUND(SUM(CASE WHEN sl.completed_time >= now() - INTERVAL '12 weeks'
                         THEN sl.qty ELSE 0 END) / 12.0, 1)::float8   AS weekly_velocity,
          ROUND(SUM(CASE WHEN p.tags ILIKE $5
                         THEN sl.qty ELSE 0 END), 0)::float8           AS units_sold_tag,
          ROUND(SUM(CASE WHEN p.tags ILIKE $5
                         THEN sl.qty * sl.unit_price - COALESCE((sl.raw->>'calcLineDiscount')::numeric, 0) ELSE 0 END), 2)::float8 AS revenue_tag,
          ROUND(SUM(CASE WHEN p.tags ILIKE $5
                          AND sl.completed_time >= $3::date AND sl.completed_time <= $4::date
                         THEN sl.qty ELSE 0 END), 0)::float8           AS units_sold_tag_period,
          ROUND(SUM(CASE WHEN p.tags ILIKE $5
                          AND sl.completed_time >= $3::date AND sl.completed_time <= $4::date
                         THEN sl.qty * sl.unit_price - COALESCE((sl.raw->>'calcLineDiscount')::numeric, 0) ELSE 0 END), 2)::float8 AS revenue_tag_period,
          ROUND(SUM(CASE WHEN sl.completed_time >= now() - INTERVAL '12 weeks' AND p.tags ILIKE $5
                         THEN sl.qty * sl.unit_price - COALESCE((sl.raw->>'calcLineDiscount')::numeric, 0) ELSE 0 END), 2)::float8 AS revenue_12w
        FROM sale_lines sl
        JOIN products p ON p.item_id = sl.item_id
        WHERE p.manufacturer ILIKE $1
          AND sl.shop_id = $2
          AND sl.completed_time IS NOT NULL
      `, [mfr, shopId, stFrom, stTo, seasonTag]);
    } else {
      // $1=mfr $2=stFrom $3=stTo $4='%tag%'
      // No date filter in WHERE — CASEs handle mode 1 (tag) and mode 2 (tag+period)
      q1Promise = pool.query(`
        SELECT
          COUNT(DISTINCT CASE WHEN p.tags ILIKE $4 THEN sl.item_id END)::int AS active_items,
          ROUND(SUM(CASE WHEN sl.completed_time >= now() - INTERVAL '12 weeks'
                         THEN sl.qty ELSE 0 END) / 12.0, 1)::float8   AS weekly_velocity,
          ROUND(SUM(CASE WHEN p.tags ILIKE $4
                         THEN sl.qty ELSE 0 END), 0)::float8           AS units_sold_tag,
          ROUND(SUM(CASE WHEN p.tags ILIKE $4
                         THEN sl.qty * sl.unit_price - COALESCE((sl.raw->>'calcLineDiscount')::numeric, 0) ELSE 0 END), 2)::float8 AS revenue_tag,
          ROUND(SUM(CASE WHEN p.tags ILIKE $4
                          AND sl.completed_time >= $2::date AND sl.completed_time <= $3::date
                         THEN sl.qty ELSE 0 END), 0)::float8           AS units_sold_tag_period,
          ROUND(SUM(CASE WHEN p.tags ILIKE $4
                          AND sl.completed_time >= $2::date AND sl.completed_time <= $3::date
                         THEN sl.qty * sl.unit_price - COALESCE((sl.raw->>'calcLineDiscount')::numeric, 0) ELSE 0 END), 2)::float8 AS revenue_tag_period,
          ROUND(SUM(CASE WHEN sl.completed_time >= now() - INTERVAL '12 weeks' AND p.tags ILIKE $4
                         THEN sl.qty * sl.unit_price - COALESCE((sl.raw->>'calcLineDiscount')::numeric, 0) ELSE 0 END), 2)::float8 AS revenue_12w
        FROM sale_lines sl
        JOIN products p ON p.item_id = sl.item_id
        WHERE p.manufacturer ILIKE $1
          AND sl.completed_time IS NOT NULL
      `, [mfr, stFrom, stTo, seasonTag]);
    }

    // Q2 — Stock + margin; current_stock_tag = tag-filtered stock for sell-through denominator
    // allTime: no tag filter → current_stock_tag = current_stock
    // !allTime: CASE on p.tags ILIKE seasonTag
    let q2Promise;
    if (allTime) {
      q2Promise = pool.query(`
        SELECT
          COUNT(DISTINCT p.item_id)::int AS total_items,
          ROUND(SUM(COALESCE(i.qty_on_hand,0) + COALESCE(i.qty_on_order,0)), 0)::float8 AS current_stock,
          ROUND(SUM(COALESCE(i.qty_on_hand,0) + COALESCE(i.qty_on_order,0)), 0)::float8 AS current_stock_tag,
          ROUND(AVG(CASE WHEN p.default_price > 0
                         THEN (p.default_price - p.default_cost) / p.default_price * 100
                         ELSE NULL END), 1)::float8 AS avg_margin_pct
        FROM products p
        LEFT JOIN inventory i ON i.item_id = p.item_id ${invJ}
        WHERE p.manufacturer ILIKE $1 AND p.archived = false
      `, p);
    } else if (hasShop) {
      // $1=mfr $2=shopId $3='%tag%'
      q2Promise = pool.query(`
        SELECT
          COUNT(DISTINCT p.item_id)::int AS total_items,
          ROUND(SUM(COALESCE(i.qty_on_hand,0) + COALESCE(i.qty_on_order,0)), 0)::float8 AS current_stock,
          ROUND(SUM(CASE WHEN p.tags ILIKE $3
                         THEN COALESCE(i.qty_on_hand,0) + COALESCE(i.qty_on_order,0) ELSE 0 END), 0)::float8 AS current_stock_tag,
          ROUND(AVG(CASE WHEN p.default_price > 0
                         THEN (p.default_price - p.default_cost) / p.default_price * 100
                         ELSE NULL END), 1)::float8 AS avg_margin_pct
        FROM products p
        LEFT JOIN inventory i ON i.item_id = p.item_id AND i.shop_id = $2
        WHERE p.manufacturer ILIKE $1 AND p.archived = false
      `, [mfr, shopId, seasonTag]);
    } else {
      // $1=mfr $2='%tag%'
      q2Promise = pool.query(`
        SELECT
          COUNT(DISTINCT p.item_id)::int AS total_items,
          ROUND(SUM(COALESCE(i.qty_on_hand,0) + COALESCE(i.qty_on_order,0)), 0)::float8 AS current_stock,
          ROUND(SUM(CASE WHEN p.tags ILIKE $2
                         THEN COALESCE(i.qty_on_hand,0) + COALESCE(i.qty_on_order,0) ELSE 0 END), 0)::float8 AS current_stock_tag,
          ROUND(AVG(CASE WHEN p.default_price > 0
                         THEN (p.default_price - p.default_cost) / p.default_price * 100
                         ELSE NULL END), 1)::float8 AS avg_margin_pct
        FROM products p
        LEFT JOIN inventory i ON i.item_id = p.item_id
        WHERE p.manufacturer ILIKE $1 AND p.archived = false
      `, [mfr, seasonTag]);
    }

    const [q1, q2, q3a, q3b, q4, q5, q6] = await Promise.all([
      q1Promise,
      q2Promise,

      // Q3a — Weekly sales: current 12 weeks
      pool.query(`
        SELECT
          date_trunc('week', sl.completed_time)          AS week,
          ROUND(SUM(sl.qty), 0)::float8                  AS units,
          ROUND(SUM(sl.qty * sl.unit_price - COALESCE((sl.raw->>'calcLineDiscount')::numeric, 0)), 2)::float8  AS revenue
        FROM sale_lines sl
        JOIN products p ON p.item_id = sl.item_id
        WHERE p.manufacturer ILIKE $1
          AND sl.completed_time >= now() - INTERVAL '12 weeks'
          AND sl.completed_time IS NOT NULL
          ${slS}
        GROUP BY 1 ORDER BY 1
      `, p),

      // Q3b — Weekly sales: same 12 weeks last year (shifted +364 days to align on chart)
      pool.query(`
        SELECT
          (date_trunc('week', sl.completed_time) + INTERVAL '364 days') AS week,
          ROUND(SUM(sl.qty), 0)::float8                                  AS units_ly
        FROM sale_lines sl
        JOIN products p ON p.item_id = sl.item_id
        WHERE p.manufacturer ILIKE $1
          AND sl.completed_time >= now() - INTERVAL '64 weeks'
          AND sl.completed_time <  now() - INTERVAL '52 weeks'
          AND sl.completed_time IS NOT NULL
          ${slS}
        GROUP BY date_trunc('week', sl.completed_time)
        ORDER BY 1
      `, p),

      // Q4 — Top 10 matrices by units sold (12 weeks), variants consolidated under parent
      // matrix_name: strip trailing size/colour suffix from a non-self-referencing variant's
      // description ("940008 VICKI 34 Blanc-99" → "940008 VICKI").  Falls back to par.description
      // for standalone items (matrix_id IS NULL).
      pool.query(`
        WITH s AS (
          SELECT
            COALESCE(p.matrix_id, p.item_id)                                                  AS matrix_item_id,
            MIN(CASE WHEN p.matrix_id IS NOT NULL AND p.matrix_id != p.item_id
                     THEN p.description END)                                                   AS variant_desc,
            SUM(sl.qty)                                                                        AS units,
            SUM(sl.qty * sl.unit_price - COALESCE((sl.raw->>'calcLineDiscount')::numeric, 0)) AS rev
          FROM sale_lines sl
          JOIN products p ON p.item_id = sl.item_id
          WHERE sl.completed_time >= now() - INTERVAL '12 weeks'
            AND sl.completed_time IS NOT NULL
            AND p.manufacturer ILIKE $1
            AND p.archived = false
            ${slS}
          GROUP BY COALESCE(p.matrix_id, p.item_id)
        ),
        ${stCTE},
        st_matrix AS (
          SELECT
            COALESCE(p2.matrix_id, p2.item_id) AS matrix_item_id,
            SUM(st.stock)                       AS stock
          FROM st
          JOIN products p2 ON p2.item_id = st.item_id
          GROUP BY COALESCE(p2.matrix_id, p2.item_id)
        )
        SELECT
          par.item_id,
          COALESCE(
            NULLIF(regexp_replace(
              s.variant_desc,
              '\\s+(\\d{2,3}|XXS|XS|XL|XXL|XXXL|S|M|L|TU|OS|UNI)(\\s.*)?$',
              '', 'i'), ''),
            par.description
          )                             AS description,
          par.category,
          par.image_url,
          par.default_cost,
          par.default_price,
          ROUND(s.units, 0)::float8     AS units_sold_12w,
          ROUND(s.rev, 2)::float8       AS revenue_12w,
          COALESCE(sm.stock, 0)::float8 AS current_stock
        FROM s
        JOIN products par ON par.item_id = s.matrix_item_id AND par.archived = false
        LEFT JOIN st_matrix sm ON sm.matrix_item_id = s.matrix_item_id
        ORDER BY s.units DESC
        LIMIT 10
      `, p),

      // Q5 — Sales + stock by category
      pool.query(`
        WITH s AS (
          SELECT sl.item_id,
                 SUM(sl.qty)                 AS units,
                 SUM(sl.qty * sl.unit_price - COALESCE((sl.raw->>'calcLineDiscount')::numeric, 0)) AS rev
          FROM sale_lines sl
          WHERE sl.completed_time >= now() - INTERVAL '12 weeks'
            AND sl.completed_time IS NOT NULL
            ${slS}
          GROUP BY sl.item_id
        ),
        ${stCTE}
        SELECT
          COALESCE(p.category, 'Sans catégorie')       AS category,
          COUNT(DISTINCT p.item_id)::int               AS items_count,
          ROUND(SUM(COALESCE(s.units, 0)), 0)::float8  AS units_sold_12w,
          ROUND(SUM(COALESCE(s.rev,   0)), 2)::float8  AS revenue_12w,
          ROUND(SUM(COALESCE(st.stock,0)), 0)::float8  AS stock_units
        FROM products p
        LEFT JOIN s  ON s.item_id  = p.item_id
        LEFT JOIN st ON st.item_id = p.item_id
        WHERE p.manufacturer ILIKE $1
          AND p.archived = false
        GROUP BY p.category
        ORDER BY units_sold_12w DESC NULLS LAST
      `, p),

      q6Promise,
    ]);

    // Sold units per mode
    const soldTag    = allTime
      ? parseFloat(q1.rows[0]?.units_sold_season) || 0
      : parseFloat(q1.rows[0]?.units_sold_tag)    || 0;
    const soldPeriod = allTime
      ? soldTag
      : parseFloat(q1.rows[0]?.units_sold_tag_period) || 0;

    // Stock: current_stock for display; current_stock_tag for sell-through denominator
    const stock      = parseFloat(q2.rows[0]?.current_stock)     || 0;
    const stockTag   = parseFloat(q2.rows[0]?.current_stock_tag) || 0;

    const receivedIn = parseFloat(q6.rows[0]?.received_in) || 0;
    const sentOut    = parseFloat(q6.rows[0]?.sent_out)    || 0;

    // Reconstituted stock uses tag-filtered stock as base
    const stockRecon    = Math.max(0, stock    + sentOut - receivedIn);
    const stockTagRecon = Math.max(0, stockTag + sentOut - receivedIn);

    // Sell-through: denominator = tag-filtered stock
    const st            = soldTag    + stockTag      > 0 ? soldTag    / (soldTag    + stockTag)      : 0;
    const stRecon       = soldTag    + stockTagRecon > 0 ? soldTag    / (soldTag    + stockTagRecon) : 0;
    const stPeriod      = soldPeriod + stockTag      > 0 ? soldPeriod / (soldPeriod + stockTag)      : 0;
    const stPeriodRecon = soldPeriod + stockTagRecon > 0 ? soldPeriod / (soldPeriod + stockTagRecon) : 0;

    // Recommendation based on mode 1 (tag)
    const recommendation =
      st >= 0.70 ? 'ACHETER+' :
      st >= 0.40 ? 'MAINTENIR' :
      st >= 0.20 ? 'RÉDUIRE'  : 'ARRÊTER';

    res.json({
      manufacturer:  mfr,
      shop_id:       shopId,
      season_code:   allTime ? null : seasonCode,
      season_label:  allTime ? 'Toutes les saisons' : season.label,
      season_from:   allTime ? null : stFrom,
      season_to:     allTime ? null : stTo,
      performance: {
        ...q1.rows[0],
        ...q2.rows[0],
        sell_through_pct:            Math.round(st           * 1000) / 10,
        sell_through_recon_pct:      Math.round(stRecon      * 1000) / 10,
        sell_through_period_pct:     Math.round(stPeriod     * 1000) / 10,
        sell_through_period_recon_pct: Math.round(stPeriodRecon * 1000) / 10,
        stock_reconstituted:         Math.round(stockTagRecon),
        current_stock_tag:           Math.round(stockTag),
        transfers_received_in:       Math.round(receivedIn),
        transfers_sent_out:          Math.round(sentOut),
        recommendation,
      },
      weekly_current: q3a.rows,
      weekly_ly:      q3b.rows,
      top_items:      q4.rows,
      by_category:    q5.rows,
    });
  } catch (err) { next(err); }
});

// Serve brand.html for /brand/:manufacturer (express.static won't match this path)
app.get('/brand/:manufacturer', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'brand.html'));
});

// ---------------------------------------------------------------------------
// GET /api/matrix/:matrixId — variant breakdown for a matrix product (12 weeks)
// ---------------------------------------------------------------------------
app.get('/api/matrix/:matrixId', async (req, res, next) => {
  try {
    const matrixId = req.params.matrixId;
    const shopId   = req.query.shop_id || null;
    const hasShop  = !!shopId;
    const shopSl   = hasShop ? 'AND sl.shop_id = $2' : '';
    const shopInv  = hasShop ? 'AND shop_id = $2'    : '';
    const p        = hasShop ? [matrixId, shopId] : [matrixId];

    const { rows } = await pool.query(`
      WITH sales AS (
        SELECT
          sl.item_id,
          SUM(sl.qty)                                                                        AS units,
          SUM(sl.qty * sl.unit_price - COALESCE((sl.raw->>'calcLineDiscount')::numeric, 0)) AS rev
        FROM sale_lines sl
        WHERE sl.completed_time >= now() - INTERVAL '12 weeks'
          AND sl.completed_time IS NOT NULL
          ${shopSl}
        GROUP BY sl.item_id
      ),
      inv AS (
        SELECT item_id, SUM(COALESCE(qty_on_hand,0) + COALESCE(qty_on_order,0)) AS stock
        FROM inventory
        WHERE 1=1 ${shopInv}
        GROUP BY item_id
      ),
      mname AS (
        SELECT NULLIF(regexp_replace(
          MIN(CASE WHEN matrix_id IS NOT NULL AND matrix_id != item_id
                   THEN description END),
          '\\s+(\\d{2,3}|XXS|XS|XL|XXL|XXXL|S|M|L|TU|OS|UNI)(\\s.*)?$',
          '', 'i'), '') AS name
        FROM products
        WHERE (item_id = $1 OR matrix_id = $1) AND archived = false
      )
      SELECT
        v.item_id,
        v.description,
        v.default_cost,
        v.default_price,
        v.image_url,
        ROUND(COALESCE(s.units, 0), 0)::float8  AS units_sold_12w,
        ROUND(COALESCE(s.rev,   0), 2)::float8  AS revenue_12w,
        COALESCE(inv.stock, 0)::float8           AS current_stock,
        (v.item_id = $1)                         AS is_parent,
        (SELECT name FROM mname)                 AS matrix_name
      FROM products v
      LEFT JOIN sales s   ON s.item_id   = v.item_id
      LEFT JOIN inv       ON inv.item_id = v.item_id
      WHERE (v.item_id = $1 OR v.matrix_id = $1)
        AND v.archived = false
      ORDER BY COALESCE(s.units, 0) DESC NULLS LAST, v.description
    `, p);

    const parent   = rows.find(r => r.is_parent) || null;
    const variants = rows.filter(r => !r.is_parent);
    const matrixName = rows[0]?.matrix_name || parent?.description || matrixId;

    res.json({ matrix_id: matrixId, matrix_name: matrixName, parent, variants });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /matrix/:matrixId — serve matrix detail page
// ---------------------------------------------------------------------------
app.get('/matrix/:matrixId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'matrix.html'));
});

// ---------------------------------------------------------------------------
// VELOCITY ANALYSIS — sell-through phases, full-price %, rating, actions
// ---------------------------------------------------------------------------

function velocityRating(st, fp) {
  if (st === null) return null;
  if (st >= 0.80 && fp >= 0.70) return { cote: '⭐⭐⭐', label: 'Winner',        color: '#16a34a' };
  if (st >= 0.60 && fp >= 0.50) return { cote: '⭐⭐',  label: 'Solide',        color: '#2563eb' };
  if (st >= 0.40 && fp >= 0.35) return { cote: '⭐',   label: 'Acceptable',    color: '#ca8a04' };
  if (st >= 0.25)                return { cote: '⚠️',  label: 'Problématique', color: '#ea580c' };
  return                                { cote: '🚫',  label: 'Abandon',       color: '#dc2626' };
}

function velocityAction(weeksElapsed, st_s4, st_s7, st_s10, residual_pct, seasonActive) {
  if (!seasonActive) return null;
  if (weeksElapsed >= 14 && residual_pct > 0.25) return { action: 'Liquidation ou retour fournisseur', severity: 'critical' };
  if (weeksElapsed >= 10 && st_s10 !== null && st_s10 < 0.50) return { action: 'Entrée en solde anticipée', severity: 'high' };
  if (weeksElapsed >= 7  && st_s7  !== null && st_s7  < 0.30) return { action: 'Promotion ciblée', severity: 'medium' };
  if (weeksElapsed >= 4  && st_s4  !== null && st_s4  < 0.15) return { action: 'Transfert inter-portes immédiat', severity: 'high' };
  return null;
}

// Shared CTE builder — items tagged with season + their sales within the window
function velocityCTEs(seasonFrom, seasonTo, shopCondSL, shopCondInv, tagParam) {
  return `
    season_items AS (
      SELECT item_id, manufacturer, category, default_price, default_cost,
             COALESCE(matrix_id, item_id) AS matrix_key
      FROM products
      WHERE tags ILIKE ${tagParam}
        AND archived = false
        AND default_cost > 0
        AND category NOT ILIKE 'Alt%ration%'
        AND description NOT ILIKE '%shopify%'
    ),
    season_lines AS (
      SELECT
        sl.item_id,
        sl.completed_time,
        GREATEST(1, CEIL((sl.completed_time::date - '${seasonFrom}'::date + 1) / 7.0))::int AS wk,
        sl.qty,
        CASE WHEN sl.qty > 0
              AND si.default_price > 0
              AND (sl.unit_price * sl.qty - COALESCE((sl.raw->>'calcLineDiscount')::numeric, 0))
                  >= si.default_price * sl.qty * 0.90
             THEN sl.qty ELSE 0 END AS qty_fp,
        CASE WHEN sl.qty > 0 THEN sl.qty ELSE 0 END AS qty_gross
      FROM sale_lines sl
      JOIN season_items si ON si.item_id = sl.item_id
      WHERE sl.completed_time >= '${seasonFrom}'::date
        AND sl.completed_time <= LEAST('${seasonTo}'::date, CURRENT_DATE)
        AND sl.completed_time IS NOT NULL
        ${shopCondSL}
    ),
    item_agg AS (
      SELECT
        item_id,
        SUM(CASE WHEN wk <= 4  THEN qty ELSE 0 END)::float8 AS u_s4,
        SUM(CASE WHEN wk <= 7  THEN qty ELSE 0 END)::float8 AS u_s7,
        SUM(CASE WHEN wk <= 10 THEN qty ELSE 0 END)::float8 AS u_s10,
        SUM(CASE WHEN wk <= 14 THEN qty ELSE 0 END)::float8 AS u_s14,
        SUM(qty)::float8                                     AS u_total,
        SUM(qty_fp)::float8                                  AS u_fp,
        SUM(qty_gross)::float8                               AS u_gross,
        MAX(CASE WHEN qty > 0 THEN completed_time END)       AS last_sale_dt
      FROM season_lines
      GROUP BY item_id
    ),
    current_stk AS (
      SELECT item_id,
             SUM(COALESCE(qty_on_hand, 0) + COALESCE(qty_on_order, 0)) AS stock
      FROM inventory
      WHERE 1=1 ${shopCondInv}
      GROUP BY item_id
    ),
    item_full AS (
      SELECT
        si.manufacturer, si.category, si.matrix_key, si.item_id,
        si.default_price, si.default_cost,
        COALESCE(ia.u_s4,   0) AS u_s4,
        COALESCE(ia.u_s7,   0) AS u_s7,
        COALESCE(ia.u_s10,  0) AS u_s10,
        COALESCE(ia.u_s14,  0) AS u_s14,
        COALESCE(ia.u_total,0) AS u_total,
        COALESCE(ia.u_fp,   0) AS u_fp,
        COALESCE(ia.u_gross,0) AS u_gross,
        COALESCE(cs.stock,  0) AS current_stock,
        COALESCE(ia.u_total,0) + COALESCE(cs.stock, 0) AS initial_stock,
        ia.last_sale_dt
      FROM season_items si
      LEFT JOIN item_agg ia    ON ia.item_id = si.item_id
      LEFT JOIN current_stk cs ON cs.item_id = si.item_id
    )`;
}

function enrichVelocityRow(row, weeksElapsed, seasonActive) {
  const toFloat = r => (r !== null && r !== undefined) ? parseFloat(r) : null;
  const stF   = toFloat(row.st_final);
  const stS4  = toFloat(row.st_s4);
  const stS7  = toFloat(row.st_s7);
  const stS10 = toFloat(row.st_s10);
  const fpPct = toFloat(row.fp_pct);
  const init  = parseFloat(row.initial_stock) || 0;
  const cur   = parseFloat(row.current_stock) || 0;
  const residual = init > 0 ? cur / init : 0;
  return {
    ...row,
    rating: velocityRating(stF, fpPct),
    action: velocityAction(weeksElapsed, stS4, stS7, stS10, residual, seasonActive),
  };
}

// GET /api/velocity/brands
app.get('/api/velocity/brands', async (req, res, next) => {
  try {
    const seasonCode = (req.query.season ?? 'p25').toLowerCase();
    const season     = SEASON_RANGES[seasonCode] ?? SEASON_RANGES.p25;
    const shopId     = /^\d+$/.test(req.query.shop_id ?? '') ? req.query.shop_id : null;
    const hasShop    = !!shopId;
    const shopCondSL  = hasShop ? `AND sl.shop_id = '${shopId}'` : '';
    const shopCondInv = hasShop ? `AND shop_id = '${shopId}'`    : '';

    const today       = new Date();
    const seasonFrom  = new Date(season.from);
    const seasonTo    = new Date(season.to);
    const seasonActive = today >= seasonFrom && today <= seasonTo;
    const weeksElapsed = today < seasonFrom ? 0
      : Math.floor((Math.min(today, seasonTo) - seasonFrom) / (7 * 86400000)) + 1;

    const { rows } = await pool.query(`
      WITH ${velocityCTEs(season.from, season.to, shopCondSL, shopCondInv, "'%" + seasonCode + "%'")}
      SELECT
        manufacturer,
        COUNT(DISTINCT item_id)::int                                            AS items_count,
        ROUND(SUM(initial_stock), 0)::float8                                   AS initial_stock,
        ROUND(SUM(u_total), 0)::float8                                         AS units_sold,
        ROUND(SUM(current_stock), 0)::float8                                   AS current_stock,
        ROUND(SUM(u_s4)   / NULLIF(SUM(initial_stock), 0), 3)::float8         AS st_s4,
        ROUND(SUM(u_s7)   / NULLIF(SUM(initial_stock), 0), 3)::float8         AS st_s7,
        ROUND(SUM(u_s10)  / NULLIF(SUM(initial_stock), 0), 3)::float8         AS st_s10,
        ROUND(SUM(u_s14)  / NULLIF(SUM(initial_stock), 0), 3)::float8         AS st_s14,
        ROUND(SUM(u_total)/ NULLIF(SUM(initial_stock), 0), 3)::float8         AS st_final,
        ROUND(SUM(u_fp)   / NULLIF(SUM(u_gross), 0), 3)::float8               AS fp_pct
      FROM item_full
      WHERE initial_stock > 0
      GROUP BY manufacturer
      ORDER BY manufacturer
    `);

    res.json({
      season_code: seasonCode, season_label: season.label,
      weeks_elapsed: weeksElapsed, season_active: seasonActive,
      brands: rows.map(r => enrichVelocityRow(r, weeksElapsed, seasonActive)),
    });
  } catch (err) { next(err); }
});

// GET /api/velocity/matrices
app.get('/api/velocity/matrices', async (req, res, next) => {
  try {
    const seasonCode   = (req.query.season ?? 'p25').toLowerCase();
    const season       = SEASON_RANGES[seasonCode] ?? SEASON_RANGES.p25;
    const manufacturer = req.query.manufacturer || '';
    const shopId       = /^\d+$/.test(req.query.shop_id ?? '') ? req.query.shop_id : null;
    const hasShop      = !!shopId;
    const shopCondSL   = hasShop ? `AND sl.shop_id = '${shopId}'` : '';
    const shopCondInv  = hasShop ? `AND shop_id = '${shopId}'`    : '';

    const today        = new Date();
    const seasonFrom   = new Date(season.from);
    const seasonTo     = new Date(season.to);
    const seasonActive = today >= seasonFrom && today <= seasonTo;
    const weeksElapsed = today < seasonFrom ? 0
      : Math.floor((Math.min(today, seasonTo) - seasonFrom) / (7 * 86400000)) + 1;

    const { rows } = await pool.query(`
      WITH ${velocityCTEs(season.from, season.to, shopCondSL, shopCondInv, "'%" + seasonCode + "%'")}
      SELECT
        matrix_key,
        -- Matrix name: strip size/colour from a non-self-referencing variant
        COALESCE(
          NULLIF(regexp_replace(
            MIN(CASE WHEN p2.matrix_id IS NOT NULL AND p2.matrix_id != p2.item_id
                     THEN p2.description END),
            '\\s+(\\d{2,3}|XXS|XS|XL|XXL|XXXL|S|M|L|TU|OS|UNI)(\\s.*)?$', '', 'i'), ''),
          MIN(p2.description)
        )                                                                        AS matrix_name,
        MAX(p2.image_url)                                                        AS image_url,
        COUNT(DISTINCT f.item_id)::int                                           AS items_count,
        ROUND(SUM(f.initial_stock), 0)::float8                                  AS initial_stock,
        ROUND(SUM(f.u_total), 0)::float8                                        AS units_sold,
        ROUND(SUM(f.current_stock), 0)::float8                                  AS current_stock,
        ROUND(SUM(f.u_s4)   / NULLIF(SUM(f.initial_stock), 0), 3)::float8      AS st_s4,
        ROUND(SUM(f.u_s7)   / NULLIF(SUM(f.initial_stock), 0), 3)::float8      AS st_s7,
        ROUND(SUM(f.u_s10)  / NULLIF(SUM(f.initial_stock), 0), 3)::float8      AS st_s10,
        ROUND(SUM(f.u_s14)  / NULLIF(SUM(f.initial_stock), 0), 3)::float8      AS st_s14,
        ROUND(SUM(f.u_total)/ NULLIF(SUM(f.initial_stock), 0), 3)::float8      AS st_final,
        ROUND(SUM(f.u_fp)   / NULLIF(SUM(f.u_gross), 0), 3)::float8            AS fp_pct,
        -- Sell-out date: last positive sale if all stock is gone
        CASE WHEN SUM(f.current_stock) = 0 THEN MAX(f.last_sale_dt) END        AS sellout_date,
        CASE WHEN SUM(f.current_stock) = 0 AND MAX(f.last_sale_dt) IS NOT NULL
             THEN GREATEST(1, CEIL((MAX(f.last_sale_dt)::date - '${season.from}'::date + 1) / 7.0))::int
        END                                                                     AS sellout_week
      FROM item_full f
      JOIN products p2 ON p2.item_id = f.item_id
      WHERE f.manufacturer ILIKE $1
        AND f.initial_stock > 0
      GROUP BY f.matrix_key
      ORDER BY SUM(f.u_total) DESC NULLS LAST
    `, [manufacturer]);

    res.json({
      season_code: seasonCode, season_label: season.label, manufacturer,
      weeks_elapsed: weeksElapsed, season_active: seasonActive,
      matrices: rows.map(r => enrichVelocityRow(r, weeksElapsed, seasonActive)),
    });
  } catch (err) { next(err); }
});

// GET /api/velocity/articles
app.get('/api/velocity/articles', async (req, res, next) => {
  try {
    const seasonCode = (req.query.season ?? 'p25').toLowerCase();
    const season     = SEASON_RANGES[seasonCode] ?? SEASON_RANGES.p25;
    const matrixId   = req.query.matrix_id || '';
    const shopId     = /^\d+$/.test(req.query.shop_id ?? '') ? req.query.shop_id : null;
    const hasShop    = !!shopId;
    const shopCondSL  = hasShop ? `AND sl.shop_id = '${shopId}'` : '';
    const shopCondInv = hasShop ? `AND shop_id = '${shopId}'`    : '';

    const today        = new Date();
    const seasonFrom   = new Date(season.from);
    const seasonTo     = new Date(season.to);
    const seasonActive = today >= seasonFrom && today <= seasonTo;
    const weeksElapsed = today < seasonFrom ? 0
      : Math.floor((Math.min(today, seasonTo) - seasonFrom) / (7 * 86400000)) + 1;

    // Get all item_ids belonging to this matrix
    const { rows: matrixItems } = await pool.query(
      `SELECT item_id FROM products WHERE (item_id = $1 OR matrix_id = $1) AND archived = false`,
      [matrixId]
    );
    const itemIds = matrixItems.map(r => r.item_id);
    if (!itemIds.length) return res.json({ articles: [], season_code: seasonCode, weeks_elapsed: weeksElapsed });

    // Build IN list safely using ANY
    const { rows } = await pool.query(`
      WITH season_lines AS (
        SELECT
          sl.item_id,
          sl.completed_time,
          GREATEST(1, CEIL((sl.completed_time::date - '${season.from}'::date + 1) / 7.0))::int AS wk,
          sl.qty,
          CASE WHEN sl.qty > 0
                AND p.default_price > 0
                AND (sl.unit_price * sl.qty - COALESCE((sl.raw->>'calcLineDiscount')::numeric, 0))
                    >= p.default_price * sl.qty * 0.90
               THEN sl.qty ELSE 0 END AS qty_fp,
          CASE WHEN sl.qty > 0 THEN sl.qty ELSE 0 END AS qty_gross
        FROM sale_lines sl
        JOIN products p ON p.item_id = sl.item_id
        WHERE sl.item_id = ANY($1)
          AND sl.completed_time >= '${season.from}'::date
          AND sl.completed_time <= LEAST('${season.to}'::date, CURRENT_DATE)
          AND sl.completed_time IS NOT NULL
          ${shopCondSL}
      ),
      item_agg AS (
        SELECT
          item_id,
          SUM(CASE WHEN wk <= 4  THEN qty ELSE 0 END)::float8  AS u_s4,
          SUM(CASE WHEN wk <= 7  THEN qty ELSE 0 END)::float8  AS u_s7,
          SUM(CASE WHEN wk <= 10 THEN qty ELSE 0 END)::float8  AS u_s10,
          SUM(CASE WHEN wk <= 14 THEN qty ELSE 0 END)::float8  AS u_s14,
          SUM(qty)::float8                                      AS u_total,
          SUM(qty_fp)::float8                                   AS u_fp,
          SUM(qty_gross)::float8                                AS u_gross,
          MAX(CASE WHEN qty > 0 THEN completed_time END)        AS last_sale_dt
        FROM season_lines
        GROUP BY item_id
      ),
      current_stk AS (
        SELECT item_id, SUM(COALESCE(qty_on_hand, 0) + COALESCE(qty_on_order, 0)) AS stock
        FROM inventory
        WHERE item_id = ANY($1) ${shopCondInv}
        GROUP BY item_id
      )
      SELECT
        p.item_id, p.description,
        COALESCE(ia.u_s4,   0)::float8                                         AS u_s4,
        COALESCE(ia.u_s7,   0)::float8                                         AS u_s7,
        COALESCE(ia.u_s10,  0)::float8                                         AS u_s10,
        COALESCE(ia.u_s14,  0)::float8                                         AS u_s14,
        COALESCE(ia.u_total,0)::float8                                         AS units_sold,
        COALESCE(ia.u_fp,  0)::float8                                          AS u_fp,
        COALESCE(ia.u_gross,0)::float8                                         AS u_gross,
        COALESCE(cs.stock, 0)::float8                                          AS current_stock,
        (COALESCE(ia.u_total,0) + COALESCE(cs.stock,0))::float8               AS initial_stock,
        ROUND(COALESCE(ia.u_total,0) / NULLIF(COALESCE(ia.u_total,0)+COALESCE(cs.stock,0),0),3)::float8 AS st_final,
        ROUND(COALESCE(ia.u_fp,0) / NULLIF(COALESCE(ia.u_gross,0),0),3)::float8 AS fp_pct,
        CASE WHEN COALESCE(cs.stock,0) = 0 THEN ia.last_sale_dt END           AS sellout_date,
        CASE WHEN COALESCE(cs.stock,0) = 0 AND ia.last_sale_dt IS NOT NULL
             THEN GREATEST(1, CEIL((ia.last_sale_dt::date - '${season.from}'::date + 1) / 7.0))::int
        END                                                                     AS sellout_week
      FROM products p
      LEFT JOIN item_agg ia    ON ia.item_id = p.item_id
      LEFT JOIN current_stk cs ON cs.item_id = p.item_id
      WHERE p.item_id = ANY($1)
      ORDER BY COALESCE(ia.u_total,0) DESC NULLS LAST, p.description
    `, [itemIds]);

    const articles = rows.map(r => {
      const init = parseFloat(r.initial_stock) || 0;
      const sold = parseFloat(r.units_sold) || 0;
      const st   = init > 0 ? sold / init : null;
      const fp   = (r.fp_pct !== null && r.fp_pct !== undefined) ? parseFloat(r.fp_pct) : null;
      return {
        ...r,
        st_s4:  init > 0 ? parseFloat(r.u_s4)  / init : null,
        st_s7:  init > 0 ? parseFloat(r.u_s7)  / init : null,
        st_s10: init > 0 ? parseFloat(r.u_s10) / init : null,
        st_s14: init > 0 ? parseFloat(r.u_s14) / init : null,
        st_final: st,
        fp_pct: fp,
        rating: velocityRating(st, fp),
        action: velocityAction(
          weeksElapsed,
          init > 0 ? parseFloat(r.u_s4) / init : null,
          init > 0 ? parseFloat(r.u_s7) / init : null,
          init > 0 ? parseFloat(r.u_s10) / init : null,
          init > 0 ? parseFloat(r.current_stock) / init : 0,
          seasonActive
        ),
      };
    });

    res.json({ season_code: seasonCode, season_label: season.label, matrix_id: matrixId, weeks_elapsed: weeksElapsed, season_active: seasonActive, articles });
  } catch (err) { next(err); }
});

// GET /velocity — serve velocity analysis page
app.get('/velocity', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'velocity.html'));
});

// ---------------------------------------------------------------------------
// POST /api/admin/refresh-view — force refresh mv_sales_velocity
// ---------------------------------------------------------------------------
app.post('/api/admin/refresh-view', async (req, res, next) => {
  try {
    try {
      await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_sales_velocity');
    } catch (err) {
      const msg = String(err.message || err);
      if (msg.includes('does not have a unique index') || msg.includes('cannot refresh materialized view concurrently') || msg.includes('CONCURRENTLY')) {
        console.warn('[admin] Concurrent refresh failed; falling back to non-concurrent refresh. Reason:', msg);
        await pool.query('REFRESH MATERIALIZED VIEW mv_sales_velocity');
      } else {
        throw err;
      }
    }

    const { rows } = await pool.query('SELECT COUNT(*) FROM mv_sales_velocity');
    res.json({ ok: true, mv_sales_velocity_count: rows[0].count });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/ai/chat — AI agent endpoint
// Body: { messages: [...] }   (OpenAI-format conversation history)
// Returns: { content, messages }
//
// Provider is configured via env vars — see ai-provider.js header for details:
//   AI_PROVIDER=mistral   MISTRAL_API_KEY=...   AI_MODEL=mistral-small-latest
//   AI_PROVIDER=openai    OPENAI_API_KEY=...    AI_MODEL=gpt-4o-mini
//   AI_PROVIDER=anthropic ANTHROPIC_API_KEY=... AI_MODEL=claude-haiku-4-5-20251001
//   (self-hosted) MISTRAL_BASE_URL=http://your-server:8000/v1
// ---------------------------------------------------------------------------
app.post('/api/ai/chat', async (req, res, next) => {
  try {
    if (!process.env.MISTRAL_API_KEY && !process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({
        error: 'Agent IA non configuré. Ajouter MISTRAL_API_KEY (ou OPENAI_API_KEY / ANTHROPIC_API_KEY) dans les variables d\'environnement.',
      });
    }
    const { messages } = req.body;
    if (!Array.isArray(messages) || !messages.length) {
      return res.status(400).json({ error: 'messages array required' });
    }
    const tenantConfig = await getTenantConfig();
    const ctx = { pool, budgetCache, getSeasonsConfig, tenantConfig };
    const result = await runAgentLoop(messages, ctx);

    // Save conversation asynchronously (don't block response)
    const userMsgs = (result.messages ?? []).filter(m => m.role === 'user');
    if (userMsgs.length) {
      const preview = userMsgs[userMsgs.length - 1].content?.slice(0, 120) ?? '';
      pool.query(
        `INSERT INTO conversations(preview, messages) VALUES($1, $2::jsonb)`,
        [preview, JSON.stringify(result.messages ?? [])]
      ).catch(() => {});
    }

    res.json(result);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/conversations        — list recent conversations
// GET /api/conversations/:id    — get full conversation
// DELETE /api/conversations/:id — delete a conversation
// ---------------------------------------------------------------------------
app.get('/api/conversations', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit ?? 50), 200);
    const { rows } = await pool.query(
      `SELECT id, created_at, preview FROM conversations ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

app.get('/api/conversations/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, created_at, preview, messages FROM conversations WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Conversation introuvable' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

app.delete('/api/conversations/:id', async (req, res, next) => {
  try {
    await pool.query(`DELETE FROM conversations WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------
app.use((err, req, res, _next) => {
  console.error(err);
  const message = err.message || err.code || String(err) || 'Erreur interne inconnue';
  const detail  = {
    error:   message,
    type:    err.constructor?.name ?? 'Error',
    code:    err.code  ?? undefined,
    route:   req.method + ' ' + req.path,
  };
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
    detail.hint = 'Impossible de joindre la base de données — vérifier DATABASE_URL';
  }
  res.status(500).json(detail);
});

const PORT = parseInt(process.env.PORT ?? '3000', 10);
console.log('[startup] PORT=%d DATABASE_URL=%s', PORT, process.env.DATABASE_URL ? 'set' : 'NOT SET');
app.listen(PORT, '0.0.0.0', async () => {
  console.log('[startup] Listening on 0.0.0.0:%d', PORT);
  await runMigrations().catch(err => console.error('[migration] Fatal:', err.message));

  // Auto-resume a sync that was killed mid-way (e.g. by a redeploy)
  try {
    const { rows } = await pool.query(
      `SELECT step FROM sync_state WHERE next_url != 'COMPLETED' LIMIT 1`
    );
    if (rows.length > 0 && !syncRunning && process.env.LIGHTSPEED_REFRESH_TOKEN) {
      console.log('[startup] In-progress sync detected — auto-resuming…');
      syncRunning = true;
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
        appendLog(`[sync/run] exited with code ${code}`);
      });
    }
  } catch (err) {
    console.error('[startup] Auto-resume check failed:', err.message);
  }
});

} catch (err) {
  console.error('Fatal error during startup:', err);
  process.exit(1);
}
