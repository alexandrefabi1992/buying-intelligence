console.log("STARTING");

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT',  () => process.exit(0));

console.log('[startup] Node process started, pid=%d', process.pid);

try {

require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const multer  = require('multer');
const { Pool } = require('pg');
const fs      = require('fs');
const path    = require('path');
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');
const { runAgentLoop, runAgentLoopStream } = require('./ai-agent');
const HELP             = require('./help-content');

// Multer for chat attachments (images + PDFs, 10MB limit, in-memory)
const chatUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^(image\/(png|jpe?g|webp|gif)|application\/pdf)$/i.test(file.mimetype);
    if (!ok) return cb(new Error('Format non supporté: ' + file.mimetype + ' (images ou PDF uniquement)'));
    cb(null, true);
  },
});

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
// Auth middleware
// ---------------------------------------------------------------------------
function requireAuth(req, res, next) {
  const token = (req.headers.authorization ?? '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET ?? 'dev-secret');
    req.tenantId = payload.tenantId;
    req.userId   = payload.userId;
    req.role     = payload.role;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function requireAdmin(req, res, next) {
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Admin secret required' });
  }
  next();
}

function requireSuperAdmin(req, res, next) {
  if (req.role !== 'superadmin') return res.status(403).json({ error: 'Superadmin required' });
  next();
}

// ---------------------------------------------------------------------------
// Multiplier tiers — default values; overridden by app_settings DB table.
// Each tier: { st_min: 0–1, multiplier: number, label: string }
// Tiers are checked highest-to-lowest; first match wins.
// ---------------------------------------------------------------------------
const DEFAULT_MULTIPLIER_TIERS = [
  { st_min: 0.80, multiplier: 1.15, label: 'Augmenter'     },
  { st_min: 0.65, multiplier: 1.08, label: 'Légère hausse' },
  { st_min: 0.50, multiplier: 1.00, label: 'Reconduire'    },
  { st_min: 0.40, multiplier: 0.90, label: 'Léger recul'   },
  { st_min: 0.30, multiplier: 0.75, label: 'Réduire'       },
  { st_min: 0.00, multiplier: 0.50, label: 'Couper'        },
];

async function getMultiplierTiers(tenantId) {
  try {
    const { rows } = await pool.query(
      "SELECT value FROM app_settings WHERE key = 'multiplier_tiers' AND tenant_id = $1",
      [tenantId]
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

// Projection ST — how we forecast the sell-through of an in-progress reference season.
// See doc block above /api/budget/marque handler for the full algorithm.
const DEFAULT_BUDGET_PROJECTION_CONFIG = {
  seuil_bascule:    0.05,  // rhythm gap that triggers velocity-adjusted projection
  poids_recent:     0.60,  // weight of recent velocity in the blended forecast
  fenetre_velocite: 8,     // weeks used to compute recent velocity
  borne_plancher:   0.50,  // lower bound on projected ST, as a fraction of brand's historical ST
  borne_plafond:    1.50,  // upper bound (also capped at 100% absolute)
};

async function getTenantConfig(tenantId) {
  try {
    const { rows } = await pool.query("SELECT value FROM app_settings WHERE key = 'tenant_config' AND tenant_id = $1", [tenantId]);
    if (rows.length && rows[0].value) return rows[0].value;
  } catch {}
  return {};
}

async function getSeasonsConfig(tenantId) {
  try {
    const { rows } = await pool.query("SELECT value FROM app_settings WHERE key = 'seasons_config' AND tenant_id = $1", [tenantId]);
    if (rows.length && Array.isArray(rows[0].value) && rows[0].value.length > 0) return rows[0].value;
  } catch {}
  return DEFAULT_SEASONS_CONFIG;
}

async function getBudgetParams(tenantId) {
  try {
    const { rows } = await pool.query("SELECT value FROM app_settings WHERE key = 'budget_params' AND tenant_id = $1", [tenantId]);
    if (rows.length && rows[0].value && typeof rows[0].value === 'object') {
      return { ...DEFAULT_BUDGET_PARAMS, ...rows[0].value };
    }
  } catch {}
  return { ...DEFAULT_BUDGET_PARAMS };
}

async function getBudgetProjectionConfig(tenantId) {
  try {
    const { rows } = await pool.query("SELECT value FROM app_settings WHERE key = 'budget_projection_config' AND tenant_id = $1", [tenantId]);
    if (rows.length && rows[0].value && typeof rows[0].value === 'object') {
      return { ...DEFAULT_BUDGET_PROJECTION_CONFIG, ...rows[0].value };
    }
  } catch {}
  return { ...DEFAULT_BUDGET_PROJECTION_CONFIG };
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
// Route-level auth — global middleware for /api/* routes
// - JWT required for all client routes
// - X-Admin-Secret required for system/admin routes
// ---------------------------------------------------------------------------
app.use('/api', (req, res, next) => {
  const p = req.path;
  // Public: auth login
  if (p === '/auth/login') return next();
  // Admin-only system routes (protected by X-Admin-Secret, not JWT)
  if (p.startsWith('/admin') ||
      p === '/sync/run' || p === '/sync/reset' || p === '/sync/full-history' ||
      p === '/logs' || p.startsWith('/test') || p.startsWith('/token')) return next();
  // All other /api/* routes (including /sync/checkpoints) require JWT
  requireAuth(req, res, next);
});
// Admin secret for system routes
app.use('/api/admin',       requireAdmin);
app.use('/api/sync/run',    requireAdmin);
app.use('/api/sync/reset',  requireAdmin);
app.use('/api/logs',        requireAdmin);
app.use('/api/test',        requireAdmin);
app.use('/api/token',       requireAdmin);

// Supplier order ingestion module (B9) — /api/import/* routes.
// Global JWT middleware above already runs requireAuth for /api/*; the
// mounted routes call requireAuth again defensively (idempotent).
const { mountImportRoutes } = require('./lib/import-routes');
const importHelpers = mountImportRoutes(app, pool, requireAuth, requireAdmin);

// ---------------------------------------------------------------------------
// POST /api/auth/login — email + password → JWT (no auth required)
// ---------------------------------------------------------------------------
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const { rows } = await pool.query(
      'SELECT id, tenant_id, role, password_hash FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });

    const { rows: tenantRows } = await pool.query(
      user.role === 'superadmin'
        ? 'SELECT id, name FROM tenants WHERE id = $1'
        : 'SELECT id, name FROM tenants WHERE id = $1 AND active = true',
      [user.tenant_id]
    );
    if (!tenantRows.length) return res.status(403).json({ error: 'Tenant inactive' });

    const token = jwt.sign(
      { userId: user.id, tenantId: user.tenant_id, role: user.role },
      process.env.JWT_SECRET ?? 'dev-secret',
      { expiresIn: '7d' }
    );
    res.json({ token, tenant: tenantRows[0], role: user.role });
  } catch (err) {
    console.error('[auth/login]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Admin API — tenant + user management (protected by X-Admin-Secret header)
// ---------------------------------------------------------------------------
app.get('/api/admin/tenants', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, ls_account_id, active, created_at FROM tenants ORDER BY created_at'
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/tenants', requireAdmin, async (req, res) => {
  const { id, name } = req.body ?? {};
  if (!id || !name) return res.status(400).json({ error: 'id and name required' });
  try {
    await pool.query(
      'INSERT INTO tenants (id, name) VALUES ($1, $2)',
      [id.toLowerCase().trim(), name.trim()]
    );
    res.json({ ok: true, id });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Tenant already exists' });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/users', requireAdmin, async (req, res) => {
  const { tenant_id, email, password, role = 'user' } = req.body ?? {};
  if (!tenant_id || !email || !password) return res.status(400).json({ error: 'tenant_id, email and password required' });
  try {
    const password_hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      'INSERT INTO users (tenant_id, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id',
      [tenant_id, email.toLowerCase().trim(), password_hash, role]
    );
    res.json({ ok: true, userId: rows[0].id });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already exists' });
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/users/:id/password', requireAdmin, async (req, res) => {
  const { password } = req.body ?? {};
  if (!password) return res.status(400).json({ error: 'password required' });
  try {
    const password_hash = await bcrypt.hash(password, 12);
    const { rowCount } = await pool.query(
      'UPDATE users SET password_hash = $1 WHERE id = $2',
      [password_hash, req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'User not found' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------------------
// Admin — attribute sets (size_axis / color_axis configuration)
// Both routes inherit requireAdmin from app.use('/api/admin', requireAdmin) above.
// ---------------------------------------------------------------------------

// GET /api/admin/attribute-sets?tenant_id=X — list all sets with labels and configured axes
app.get('/api/admin/attribute-sets', async (req, res) => {
  const tenantId = req.query.tenant_id;
  if (!tenantId) return res.status(400).json({ error: 'tenant_id query param required' });
  try {
    const { rows } = await pool.query(`
      SELECT attribute_set_id, name,
             attribute1_label, attribute2_label, attribute3_label,
             size_axis, color_axis, synced_at
      FROM   item_attribute_sets
      WHERE  tenant_id = $1
      ORDER  BY attribute_set_id::int
    `, [tenantId]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/admin/attribute-sets/:setId?tenant_id=X — manually override size_axis / color_axis
app.patch('/api/admin/attribute-sets/:setId', async (req, res) => {
  const tenantId = req.query.tenant_id;
  if (!tenantId) return res.status(400).json({ error: 'tenant_id query param required' });

  const { size_axis, color_axis } = req.body ?? {};
  const { setId } = req.params;

  // Allow explicit null to clear a previously set axis.
  const hasSize  = 'size_axis'  in (req.body ?? {});
  const hasColor = 'color_axis' in (req.body ?? {});
  if (!hasSize && !hasColor) return res.status(400).json({ error: 'Provide size_axis and/or color_axis' });

  const validAxis = v => v === null || v === undefined || [1, 2, 3].includes(Number(v));
  if (hasSize  && !validAxis(size_axis))  return res.status(400).json({ error: 'size_axis must be 1, 2, 3, or null' });
  if (hasColor && !validAxis(color_axis)) return res.status(400).json({ error: 'color_axis must be 1, 2, 3, or null' });

  try {
    const setClauses = [];
    const params     = [tenantId, setId];
    if (hasSize)  { setClauses.push(`size_axis  = $${params.length + 1}`);  params.push(size_axis  ?? null); }
    if (hasColor) { setClauses.push(`color_axis = $${params.length + 1}`); params.push(color_axis ?? null); }

    const { rowCount } = await pool.query(
      `UPDATE item_attribute_sets SET ${setClauses.join(', ')} WHERE tenant_id = $1 AND attribute_set_id = $2`,
      params
    );
    if (!rowCount) return res.status(404).json({ error: `attribute-set ${setId} not found` });
    res.json({ ok: true, attribute_set_id: setId, size_axis: hasSize ? (size_axis ?? null) : undefined, color_axis: hasColor ? (color_axis ?? null) : undefined });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------------------
// Superadmin API — JWT-protected, role=superadmin required
// ---------------------------------------------------------------------------

// GET /api/superadmin/dashboard — all tenants with stats
app.get('/api/superadmin/dashboard', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const { rows: tenants } = await pool.query(
      `SELECT t.id, t.name, t.active, t.created_at,
        (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id) AS user_count,
        (SELECT COUNT(*) FROM products p WHERE p.tenant_id = t.id) AS product_count,
        (SELECT COUNT(*) FROM sale_lines sl WHERE sl.tenant_id = t.id) AS sale_line_count,
        (SELECT MAX(sc.updated_at) FROM sync_checkpoints sc WHERE sc.tenant_id = t.id) AS last_sync_at
       FROM tenants t
       ORDER BY t.created_at`
    );
    res.json(tenants);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/superadmin/tenants/:id/users
app.get('/api/superadmin/tenants/:id/users', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, email, role, created_at FROM users WHERE tenant_id = $1 ORDER BY created_at`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/superadmin/tenants/:id/users — create user
app.post('/api/superadmin/tenants/:id/users', requireAuth, requireSuperAdmin, async (req, res) => {
  const { email, password, role = 'user' } = req.body ?? {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  try {
    const password_hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      `INSERT INTO users (tenant_id, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id`,
      [req.params.id, email.toLowerCase().trim(), password_hash, role]
    );
    res.json({ ok: true, userId: rows[0].id });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already exists' });
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/superadmin/users/:id/password — reset password
app.put('/api/superadmin/users/:id/password', requireAuth, requireSuperAdmin, async (req, res) => {
  const { password } = req.body ?? {};
  if (!password) return res.status(400).json({ error: 'password required' });
  try {
    const password_hash = await bcrypt.hash(password, 12);
    const { rowCount } = await pool.query(
      `UPDATE users SET password_hash = $1 WHERE id = $2`,
      [password_hash, req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'User not found' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/superadmin/tenants/:id — toggle active or rename
app.put('/api/superadmin/tenants/:id', requireAuth, requireSuperAdmin, async (req, res) => {
  const { active, name } = req.body ?? {};
  try {
    const sets = [];
    const vals = [];
    if (active !== undefined) { sets.push(`active = $${sets.length + 1}`); vals.push(active); }
    if (name   !== undefined) { sets.push(`name   = $${sets.length + 1}`); vals.push(name); }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(req.params.id);
    await pool.query(`UPDATE tenants SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/superadmin/tenants — create new tenant + first user
app.post('/api/superadmin/tenants', requireAuth, requireSuperAdmin, async (req, res) => {
  const { id, name, email, password } = req.body ?? {};
  if (!id || !name || !email || !password) return res.status(400).json({ error: 'id, name, email, password required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO tenants (id, name) VALUES ($1, $2)`, [id.toLowerCase().trim(), name.trim()]);
    const password_hash = await bcrypt.hash(password, 12);
    await client.query(
      `INSERT INTO users (tenant_id, email, password_hash, role) VALUES ($1, $2, $3, 'user')`,
      [id.toLowerCase().trim(), email.toLowerCase().trim(), password_hash]
    );
    await client.query('COMMIT');
    res.json({ ok: true, id: id.toLowerCase().trim() });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Tenant or email already exists' });
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

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

  // One-time migration: recreate mv_inventory_stock with JOIN shops to exclude phantom shop_id='0'
  const { rows: mvInvVer } = await pool.query(
    "SELECT 1 FROM sync_state WHERE step = 'mv_inventory_v2'"
  );
  if (!mvInvVer.length) {
    console.log('[migration] Recreating mv_inventory_stock with JOIN shops to exclude phantom locations…');
    await pool.query('DROP MATERIALIZED VIEW IF EXISTS mv_inventory_stock CASCADE');
    await pool.query(`
      CREATE MATERIALIZED VIEW mv_inventory_stock AS
      SELECT
        i.item_id,
        SUM(COALESCE(i.qty_on_hand, 0) + COALESCE(i.qty_on_order, 0)) AS current_stock_all
      FROM inventory i
      JOIN shops sh ON sh.shop_id = i.shop_id
      GROUP BY i.item_id
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_inventory_stock ON mv_inventory_stock(item_id)`);
    await pool.query(
      "INSERT INTO sync_state(step, next_url) VALUES ('mv_inventory_v2', 'COMPLETED') ON CONFLICT(step) DO NOTHING"
    );
    console.log('[migration] mv_inventory_stock recreated.');
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
  // Seed drop metadata for any existing plan rows that don't have a drop entry yet.
  // Branch on whether tenant_id column already exists (added by Phase 1 on existing DBs).
  {
    const { rows: bpdTid } = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'budget_plan_drops' AND column_name = 'tenant_id'`
    );
    if (bpdTid.length) {
      await pool.query(`
        INSERT INTO budget_plan_drops (tenant_id, season_code, manufacturer, drop_id, drop_name, drop_order)
        SELECT DISTINCT bp.tenant_id, bp.season_code, bp.manufacturer, bp.drop_id,
          'Drop ' || split_part(bp.drop_id, '_', 2),
          COALESCE(NULLIF(split_part(bp.drop_id, '_', 2), '')::int, 1)
        FROM budget_plans bp
        ON CONFLICT DO NOTHING
      `);
    } else {
      await pool.query(`
        INSERT INTO budget_plan_drops (season_code, manufacturer, drop_id, drop_name, drop_order)
        SELECT DISTINCT season_code, manufacturer, drop_id,
          'Drop ' || split_part(drop_id, '_', 2),
          COALESCE(NULLIF(split_part(drop_id, '_', 2), '')::int, 1)
        FROM budget_plans
        ON CONFLICT DO NOTHING
      `);
    }
  }
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

  // ---------------------------------------------------------------------------
  // Multi-tenant migration (Phase 1)
  // ---------------------------------------------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tenants (
      id               TEXT PRIMARY KEY,
      name             TEXT NOT NULL,
      ls_account_id    TEXT,
      ls_refresh_token TEXT,
      active           BOOLEAN DEFAULT true,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            BIGSERIAL PRIMARY KEY,
      tenant_id     TEXT NOT NULL REFERENCES tenants(id),
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'user',
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Seed first tenant (existing Valérie Simon data)
  await pool.query(
    `INSERT INTO tenants (id, name) VALUES ('valerie-simon', 'Valérie Simon') ON CONFLICT DO NOTHING`
  );

  // Add tenant_id to all data tables (nullable, idempotent)
  const TENANT_TABLES = [
    'products','sales','sale_lines','inventory','shops','orders','transfers',
    'app_settings','budget_plans','budget_plan_drops','budget_documents','conversations',
  ];
  for (const t of TENANT_TABLES) {
    await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS tenant_id TEXT REFERENCES tenants(id)`);
  }
  // sync_state: no FK (has global migration marker rows)
  await pool.query(`ALTER TABLE sync_state ADD COLUMN IF NOT EXISTS tenant_id TEXT`);

  // Backfill existing rows with the first tenant
  for (const t of TENANT_TABLES) {
    await pool.query(`UPDATE ${t} SET tenant_id = 'valerie-simon' WHERE tenant_id IS NULL`);
  }
  await pool.query(`UPDATE sync_state SET tenant_id = 'valerie-simon' WHERE tenant_id IS NULL`);

  // Promote columns to NOT NULL (idempotent — checks nullability first)
  for (const t of TENANT_TABLES) {
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name='tenant_id' AND is_nullable='YES'`,
      [t]
    );
    if (rows.length) await pool.query(`ALTER TABLE ${t} ALTER COLUMN tenant_id SET NOT NULL`);
  }

  // ---------------------------------------------------------------------------
  // Multi-tenant Phase 4 — composite PKs + sync_checkpoints table
  // ---------------------------------------------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sync_checkpoints (
      tenant_id       TEXT NOT NULL REFERENCES tenants(id),
      step            TEXT NOT NULL,
      next_url        TEXT,
      processed_count INTEGER DEFAULT 0,
      updated_at      TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (tenant_id, step)
    )
  `);

  // Change single-column PKs to composite (tenant_id, original_id).
  // Idempotent: only runs if products PK does not yet include tenant_id.
  {
    const { rows: pkCols } = await pool.query(`
      SELECT a.attname FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = 'products'::regclass AND i.indisprimary
    `);
    const alreadyComposite = pkCols.some(r => r.attname === 'tenant_id');
    if (!alreadyComposite) {
      console.log('[migration] Upgrading to composite PKs for multi-tenant…');
      // Drop old PKs with CASCADE — auto-removes any FK constraints referencing them
      for (const [tbl, conName] of [
        ['products',   'products_pkey'],
        ['shops',      'shops_pkey'],
        ['sales',      'sales_pkey'],
        ['sale_lines', 'sale_lines_pkey'],
        ['orders',     'orders_pkey'],
        ['transfers',  'transfers_pkey'],
      ]) {
        await pool.query(`ALTER TABLE ${tbl} DROP CONSTRAINT IF EXISTS "${conName}" CASCADE`);
      }
      // Drop inventory unique constraint (name may vary — query for it)
      const { rows: invUq } = await pool.query(`
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'inventory'::regclass AND contype = 'u'
      `);
      for (const r of invUq) {
        await pool.query(`ALTER TABLE inventory DROP CONSTRAINT "${r.conname}"`);
      }
      // Add composite PKs
      await pool.query(`ALTER TABLE products   ADD PRIMARY KEY (tenant_id, item_id)`);
      await pool.query(`ALTER TABLE shops       ADD PRIMARY KEY (tenant_id, shop_id)`);
      await pool.query(`ALTER TABLE sales       ADD PRIMARY KEY (tenant_id, sale_id)`);
      await pool.query(`ALTER TABLE sale_lines  ADD PRIMARY KEY (tenant_id, sale_line_id)`);
      await pool.query(`ALTER TABLE orders      ADD PRIMARY KEY (tenant_id, order_id)`);
      await pool.query(`ALTER TABLE transfers   ADD PRIMARY KEY (tenant_id, transfer_item_id)`);
      await pool.query(`ALTER TABLE inventory   ADD UNIQUE (tenant_id, item_id, shop_id)`);
      console.log('[migration] Composite PKs applied');
    }
  }

  // ---------------------------------------------------------------------------
  // Multi-tenant Phase 5 — composite PKs for settings + budget tables
  // ---------------------------------------------------------------------------
  {
    const { rows: pkCols } = await pool.query(`
      SELECT a.attname FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = 'app_settings'::regclass AND i.indisprimary
    `);
    if (!pkCols.some(r => r.attname === 'tenant_id')) {
      await pool.query(`ALTER TABLE app_settings DROP CONSTRAINT IF EXISTS app_settings_pkey CASCADE`);
      await pool.query(`ALTER TABLE app_settings ADD PRIMARY KEY (tenant_id, key)`);
      console.log('[migration] app_settings composite PK applied');
    }
  }
  {
    // Guard on budget_plan_drops (budget_plans may already be composite from a partial run)
    const { rows: dpCols } = await pool.query(`
      SELECT a.attname FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = 'budget_plan_drops'::regclass AND i.indisprimary
    `);
    if (!dpCols.some(r => r.attname === 'tenant_id')) {
      // Backfill NULL tenant_ids to first tenant before adding NOT NULL PK
      const { rows: ft } = await pool.query(`SELECT id FROM tenants ORDER BY created_at LIMIT 1`);
      if (ft.length) {
        await pool.query(`UPDATE budget_plans      SET tenant_id = $1 WHERE tenant_id IS NULL OR tenant_id = ''`, [ft[0].id]);
        await pool.query(`UPDATE budget_plan_drops SET tenant_id = $1 WHERE tenant_id IS NULL OR tenant_id = ''`, [ft[0].id]);
      }
      // budget_plans PK — only drop/re-add if not already composite
      const { rows: bpCols } = await pool.query(`
        SELECT a.attname FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = 'budget_plans'::regclass AND i.indisprimary
      `);
      if (!bpCols.some(r => r.attname === 'tenant_id')) {
        const { rows: c1 } = await pool.query(`SELECT conname FROM pg_constraint WHERE conrelid = 'budget_plans'::regclass AND contype = 'p'`);
        if (c1.length) await pool.query(`ALTER TABLE budget_plans DROP CONSTRAINT "${c1[0].conname}" CASCADE`);
        await pool.query(`ALTER TABLE budget_plans ADD PRIMARY KEY (tenant_id, season_code, manufacturer, drop_id, shop_id)`);
      }
      // budget_plan_drops PK
      const { rows: c2 } = await pool.query(`SELECT conname FROM pg_constraint WHERE conrelid = 'budget_plan_drops'::regclass AND contype = 'p'`);
      if (c2.length) await pool.query(`ALTER TABLE budget_plan_drops DROP CONSTRAINT "${c2[0].conname}" CASCADE`);
      await pool.query(`ALTER TABLE budget_plan_drops ADD PRIMARY KEY (tenant_id, season_code, manufacturer, drop_id)`);
      console.log('[migration] budget_plans/drops composite PKs applied');
    }
  }
  // conversations tenant_id column
  {
    const { rows: cols } = await pool.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'conversations' AND column_name = 'tenant_id'
    `);
    if (!cols.length) {
      await pool.query(`ALTER TABLE conversations ADD COLUMN tenant_id TEXT NOT NULL DEFAULT ''`);
      console.log('[migration] conversations.tenant_id column added');
    }
  }

  // Superadmin role — ensure 'superadmin' is an accepted role value
  {
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role_check') THEN
          ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
          ALTER TABLE users ADD CONSTRAINT users_role_check
            CHECK (role IN ('user','admin','superadmin'));
        END IF;
      EXCEPTION WHEN others THEN NULL;
      END $$
    `);
    // Add constraint idempotently
    const { rows: cc } = await pool.query(`
      SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check'
    `);
    if (!cc.length) {
      await pool.query(`ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('user','admin','superadmin'))`);
    }
  }

  // brand_payment_terms — supplier discount / net terms per brand
  await pool.query(`
    CREATE TABLE IF NOT EXISTS brand_payment_terms (
      tenant_id           TEXT NOT NULL REFERENCES tenants(id),
      manufacturer        TEXT NOT NULL,
      discount_pct        NUMERIC,
      discount_days       INT,
      net_days            INT,
      margin_override_pct NUMERIC,
      notes               TEXT,
      updated_at          TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (tenant_id, manufacturer)
    )
  `);

  // transfer_recommendations_dismissed — dismissal per (tenant, item, from_shop, to_shop)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transfer_recommendations_dismissed (
      tenant_id    TEXT NOT NULL,
      item_id      TEXT NOT NULL,
      from_shop_id TEXT NOT NULL,
      to_shop_id   TEXT NOT NULL,
      dismissed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      dismissed_until DATE,
      PRIMARY KEY (tenant_id, item_id, from_shop_id, to_shop_id)
    )
  `);

  // item_matrices — Lightspeed matrix descriptions (clean model names without size/color suffixes).
  // Synced by sync.js with checkpoint+delta; read-only here.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS item_matrices (
      tenant_id        TEXT NOT NULL,
      matrix_id        TEXT NOT NULL,
      description      TEXT,
      manufacturer_id  TEXT,
      category_id      TEXT,
      attribute_set_id TEXT,
      synced_at        TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (tenant_id, matrix_id)
    )
  `);

  // ─── Supplier order ingestion module ─────────────────────────────────
  //
  // Two GLOBAL tables (shared across tenants — describe file structure only,
  // never commercial data). A new tenant automatically benefits from recipes
  // configured for another. Every row here MUST be free of prices, quantities,
  // customer names, order numbers.
  //
  //   - parse_recipes: how to read a supplier file (regex, coordinates, headers)
  //   - color_translations: raw supplier color → normalized "Nom-Code"
  //
  // Five PER-TENANT tables (all commercial content lives here):
  //   - brand_vendor_map: default Lightspeed vendor per brand for this tenant
  //   - import_files: parent for one uploaded PDF/XLSX (holds bytes)
  //   - import_batches: one row per PO detected in the file
  //   - import_order_lines: one row per size-quantity within a PO (created/skipped/failed status per line).
  //     Named import_order_lines (not order_lines) to avoid collision with a hypothetical
  //     future sync.js mirror of Lightspeed's OrderLine entity.
  //   - import_queue: single-threaded job queue for API pushes

  await pool.query(`
    CREATE TABLE IF NOT EXISTS parse_recipes (
      recipe_id                 SERIAL PRIMARY KEY,
      supplier_key              TEXT   NOT NULL,     -- 'oui-eurostyle', 'bugatchi', ...
      version                   INT    NOT NULL,
      file_kind                 TEXT   NOT NULL,     -- 'pdf' | 'xlsx'
      detection                 JSONB  NOT NULL,     -- rules to auto-identify this template
      layout                    JSONB  NOT NULL,     -- structural extraction rules (no values)
      target_manufacturer       TEXT,                -- brand this recipe produces (e.g. 'Oui')
      default_attribute_set_id  TEXT DEFAULT '5',
      notes                     TEXT,
      active                    BOOLEAN NOT NULL DEFAULT true,
      created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (supplier_key, version)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_parse_recipes_active ON parse_recipes(active, supplier_key)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS color_translations (
      supplier_key   TEXT NOT NULL,
      raw_color      TEXT NOT NULL,      -- 'blue', 'ultra violett' — as extracted
      normalized     TEXT NOT NULL,      -- 'Bleu', 'Ultra Violett' — capitalized
      PRIMARY KEY (supplier_key, raw_color)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS brand_vendor_map (
      tenant_id      TEXT NOT NULL REFERENCES tenants(id),
      manufacturer   TEXT NOT NULL,       -- 'Oui', 'Bugatchi'
      vendor_id      TEXT NOT NULL,       -- Lightspeed defaultVendorID, e.g. '70'
      vendor_name    TEXT,                -- 'EUROSTYLE' — display only
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, manufacturer)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS import_files (
      file_id           SERIAL PRIMARY KEY,
      tenant_id         TEXT NOT NULL REFERENCES tenants(id),
      supplier_key      TEXT NOT NULL,
      recipe_id         INT  NOT NULL REFERENCES parse_recipes(recipe_id),
      source_filename   TEXT NOT NULL,
      source_hash       TEXT NOT NULL,           -- SHA256, anti-double-import
      source_bytes      BYTEA NOT NULL,          -- original file kept indefinitely
      uploaded_by       TEXT,
      uploaded_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      season_tag        TEXT NOT NULL,           -- 'p27', 'a26' — from active budget at upload time
      destination_shop_id TEXT NOT NULL,         -- shop selected in the budget UI at upload time
      target_manufacturer TEXT NOT NULL,         -- brand row the user clicked from (validated)
      status            TEXT NOT NULL DEFAULT 'parsed',  -- parsed | previewed | pushing | pushed | partial | failed
      UNIQUE (tenant_id, source_hash)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_import_files_tenant_uploaded ON import_files(tenant_id, uploaded_at DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS import_batches (
      batch_id            SERIAL PRIMARY KEY,
      file_id             INT  NOT NULL REFERENCES import_files(file_id) ON DELETE CASCADE,
      tenant_id           TEXT NOT NULL REFERENCES tenants(id),
      po_number           TEXT NOT NULL,          -- '0361041' — from PDF
      customer_reference  TEXT,                   -- 'Urban Romance' — from PDF
      order_date          DATE,                   -- Date de Commande from PDF
      delivery_date       DATE,                   -- Date Exp. from PDF
      cancel_date         DATE,                   -- Date de Canc from PDF
      unit_count_declared INT,                    -- from 'Total Commande' in PDF
      amount_declared     NUMERIC(10,2),
      is_consignment      BOOLEAN NOT NULL DEFAULT false,
      selected            BOOLEAN NOT NULL DEFAULT true,   -- unchecked = user opted out
      status              TEXT NOT NULL DEFAULT 'pending', -- pending | pushing | pushed | partial | failed | skipped
      -- Ordering side (Lightspeed):
      lightspeed_order_id TEXT,                   -- returned by POST /Order
      -- Audit
      approved_by         TEXT,
      approved_at         TIMESTAMPTZ,
      pushed_at           TIMESTAMPTZ,
      errors              JSONB,
      UNIQUE (tenant_id, file_id, po_number)      -- one PO per import file (same PO OK across different files, e.g. multi-shop)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_import_batches_file ON import_batches(file_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_import_batches_tenant_status ON import_batches(tenant_id, status)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS import_order_lines (
      line_id             SERIAL PRIMARY KEY,
      batch_id            INT  NOT NULL REFERENCES import_batches(batch_id) ON DELETE CASCADE,
      tenant_id           TEXT NOT NULL REFERENCES tenants(id),
      -- Extracted from file:
      supplier_style_ref  TEXT NOT NULL,          -- '99103'
      supplier_color_ref  TEXT,                   -- '5400'
      color_normalized    TEXT,                   -- 'Bleu-5400'
      size_label          TEXT NOT NULL,          -- '38' or 'OS'
      qty                 INT  NOT NULL,          -- ordered quantity (becomes OrderLine.quantity)
      unit_cost           NUMERIC(10,2),
      unit_price_retail   NUMERIC(10,2),
      -- Resolved to Lightspeed:
      matrix_id           TEXT,                   -- filled after matrix ensured (POST or reuse)
      item_id             TEXT,                   -- filled after variant ensured
      lightspeed_order_line_id TEXT,              -- filled after POST /OrderLine
      -- Per-line status for granular resume ('Reprendre' at line 181 of 265):
      status              TEXT NOT NULL DEFAULT 'pending',
      -- pending | matrix_ensured | variant_ensured | variant_tagged | ordered | skipped_duplicate | error
      error_message       TEXT,
      last_attempted_at   TIMESTAMPTZ
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_import_order_lines_batch  ON import_order_lines(batch_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_import_order_lines_status ON import_order_lines(tenant_id, status) WHERE status NOT IN ('ordered','skipped_duplicate')`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS import_queue (
      job_id           SERIAL PRIMARY KEY,
      tenant_id        TEXT NOT NULL REFERENCES tenants(id),
      file_id          INT  NOT NULL REFERENCES import_files(file_id) ON DELETE CASCADE,
      owner            TEXT,                       -- user email that queued the job
      status           TEXT NOT NULL DEFAULT 'queued',  -- queued | running | done | failed
      queued_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_at       TIMESTAMPTZ,
      finished_at      TIMESTAMPTZ,
      progress_current INT DEFAULT 0,              -- for UI progress bar
      progress_total   INT DEFAULT 0,
      error_message    TEXT
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_import_queue_pending ON import_queue(status, queued_at) WHERE status IN ('queued','running')`);

  // Preview cache — populated on first /preview call, reused on subsequent
  // calls unless ?refresh=true. Column added after the fact to keep the
  // initial schema minimal; safe on live DBs (IF NOT EXISTS).
  await pool.query(`ALTER TABLE import_files ADD COLUMN IF NOT EXISTS preview_json JSONB`);
  await pool.query(`ALTER TABLE import_files ADD COLUMN IF NOT EXISTS preview_computed_at TIMESTAMPTZ`);
  // Extraction source — 'recipe' (default, uses parse_recipes) or 'llm'
  // (operator-triggered fallback when no recipe matches). Distinct paths;
  // recipe extractions are UNCHANGED — the default is set to 'recipe' so
  // every existing row is treated as recipe-extracted with no behaviour shift.
  await pool.query(`ALTER TABLE import_files ADD COLUMN IF NOT EXISTS extraction_source TEXT NOT NULL DEFAULT 'recipe'`);
  // Raw text extracted from the PDF — persisted only for LLM-extracted files
  // so the size-mismatch validator can re-run at any time (including on push,
  // after edits, when re-computing the cached preview). NULL for recipe files.
  await pool.query(`ALTER TABLE import_files ADD COLUMN IF NOT EXISTS raw_text TEXT`);
  // Async LLM extraction — 'extracting' status is set while the background
  // job runs, and last_extraction_error persists the failure message across
  // page reloads so the operator can see what went wrong without re-running.
  await pool.query(`ALTER TABLE import_files ADD COLUMN IF NOT EXISTS last_extraction_error TEXT`);
  // Optional operator-provided PO name — overrides the default refNum
  // ("po_number + customer_reference") when set at upload time.
  await pool.query(`ALTER TABLE import_files ADD COLUMN IF NOT EXISTS custom_order_name TEXT`);
  // drop_id links an import file to a specific Drop (livraison) in the
  // Plan tab. When present, the Plan UI shows a 'Voir importation' button
  // beside that drop instead of 'Importer'. Nullable — legacy files and
  // imports triggered from the top-level 'Importer' button leave it null.
  await pool.query(`ALTER TABLE import_files ADD COLUMN IF NOT EXISTS drop_id TEXT`);
  // confirmed_at: null while a file is only in pre-analysis mode (attached
  // to a drop but the operator hasn't clicked Importer yet). Set to now()
  // the first time the operator confirms the import via the modal. Drives
  // the per-drop button label — 'Importer' when null, 'Voir importation'
  // once confirmed.
  await pool.query(`ALTER TABLE import_files ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ`);
  // Relax the UNIQUE (tenant_id, source_hash) constraint that blocked
  // the legitimate case of the same PDF being re-attached under a
  // different season / drop (operator realizes the wrong season was
  // selected, deletes + re-attaches). Dedup is now done in application
  // logic scoped by (tenant, source_hash, season, drop, manufacturer).
  await pool.query(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'import_files_tenant_id_source_hash_key') THEN
        ALTER TABLE import_files DROP CONSTRAINT import_files_tenant_id_source_hash_key;
      END IF;
    END $$;
  `);
  // Non-unique index on source_hash for the dedup lookup performance
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_import_files_tenant_hash
                    ON import_files(tenant_id, source_hash)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_import_files_manufacturer_drop
                    ON import_files(tenant_id, target_manufacturer, season_tag, drop_id)
                    WHERE drop_id IS NOT NULL`);
  // Relax the (tenant_id, po_number) constraint on import_batches — it
  // blocked the legit case of the same supplier PO being imported for two
  // different shops (each shop → its own Lightspeed Order). Dedup at file
  // level is already enforced by import_files.source_hash + upload dup check.
  // Replace with the softer (tenant_id, file_id, po_number) so we still
  // reject duplicates WITHIN one file. Idempotent: DROP IF EXISTS + ADD IF
  // NOT EXISTS.
  await pool.query(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'import_batches_tenant_id_po_number_key') THEN
        ALTER TABLE import_batches DROP CONSTRAINT import_batches_tenant_id_po_number_key;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'import_batches_tenant_file_po_key') THEN
        ALTER TABLE import_batches ADD CONSTRAINT import_batches_tenant_file_po_key UNIQUE (tenant_id, file_id, po_number);
      END IF;
    END $$;
  `);
  // Per-matrix overrides — operator-editable fields (category first; more to
  // come). Keyed by (tenant, file, matrix_key) where matrix_key is
  // "style_ref|color_normalized" (same key preview-generator uses to dedupe).
  // Overrides are loaded at preview render + push time, so a value set once
  // sticks through re-extractions and push retries.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS import_matrix_overrides (
      tenant_id      TEXT NOT NULL REFERENCES tenants(id),
      file_id        INT  NOT NULL REFERENCES import_files(file_id) ON DELETE CASCADE,
      matrix_key     TEXT NOT NULL,
      category_id    TEXT,
      category_path  TEXT,
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, file_id, matrix_key)
    )
  `);
  // Add retail_price override (operator-set price, overrides the PDF's price).
  await pool.query(`ALTER TABLE import_matrix_overrides ADD COLUMN IF NOT EXISTS retail_price_override NUMERIC(10,2)`);
  // recipe_id is NULLable — LLM-extracted files and files awaiting extraction
  // legitimately have no matching parse_recipes row, and were previously
  // attached to an arbitrary recipe just to satisfy the NOT NULL constraint
  // (misleading — a Marc Cain file appeared linked to Oui or Bugatchi).
  // The FK to parse_recipes(recipe_id) is preserved and accepts NULL by
  // default (no MATCH FULL clause).
  await pool.query(`ALTER TABLE import_files ALTER COLUMN recipe_id DROP NOT NULL`);
  // parse_recipes ownership: nullable tenant_id.
  //   tenant_id = null  → GLOBAL recipe (visible to every tenant)
  //   tenant_id = 'X'   → PRIVATE to tenant X, invisible to others
  // New user-created recipes are private by default; promotion to global
  // is a deliberate admin action via POST /api/import/recipes/:id/promote.
  await pool.query(`ALTER TABLE parse_recipes ADD COLUMN IF NOT EXISTS tenant_id TEXT REFERENCES tenants(id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_parse_recipes_tenant ON parse_recipes(tenant_id, active)`);
  // Uniqueness must scope on tenant now — two tenants may each have their
  // private 'oui-eurostyle' v1 alongside a global one. Drop the old
  // (supplier_key, version) unique constraint if present and replace with a
  // tenant-aware one. Uses NULLS NOT DISTINCT so global (tenant_id IS NULL)
  // is unique across supplier_key/version.
  const { rows: uniqRows } = await pool.query(`
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'parse_recipes'::regclass AND contype = 'u'
      AND pg_get_constraintdef(oid) = 'UNIQUE (supplier_key, version)'
  `);
  for (const r of uniqRows) {
    await pool.query(`ALTER TABLE parse_recipes DROP CONSTRAINT "${r.conname}"`);
    console.log(`[migration] Dropped parse_recipes.${r.conname} (superseded by tenant-scoped unique)`);
  }
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_parse_recipes_tenant_supplier_version
    ON parse_recipes (COALESCE(tenant_id, ''), supplier_key, version)
  `);
  // 'abandoned' is a valid status on both import_files and import_batches:
  // set by POST /files/:file_id/abandon when the user gives up on a
  // partially-pushed file. No CHECK constraint on status, so no ALTER needed.

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

// POST /api/sync/full-history — re-sync all sale_lines from the past 10 years.
// Use to fix gaps in historical data (missing sale_lines for past seasons).
// Safe: upsertSaleLines uses ON CONFLICT UPDATE — no duplicates.
app.use('/api/sync/full-history', requireAdmin);
app.post('/api/sync/full-history', async (req, res) => {
  if (!process.env.LIGHTSPEED_REFRESH_TOKEN) {
    return res.status(400).json({ error: 'LIGHTSPEED_REFRESH_TOKEN is not set.' });
  }
  if (syncRunning) {
    return res.status(409).json({ status: 'sync already running' });
  }
  syncRunning = true;
  res.json({ status: 'full-history sync started — pulling 10 years of sale_lines', note: 'This may take 10-30 minutes. Check logs for progress.' });
  const { spawn } = require('child_process');
  const child = spawn('node', ['sync.js', '--once', '--full-history'], { cwd: __dirname });
  const capture = chunk => {
    const text = chunk.toString();
    process.stdout.write(text);
    text.split('\n').filter(Boolean).forEach(appendLog);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.on('close', code => {
    syncRunning = false;
    const msg = `[sync/full-history] exited with code ${code}`;
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

  // Encode tenant_id in state (signed JWT) so /oauth/callback knows which tenant
  const tenantId = req.query.tenant_id ?? null;
  const state    = tenantId
    ? jwt.sign({ tenantId }, process.env.JWT_SECRET ?? 'dev-secret', { expiresIn: '1h' })
    : null;

  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     process.env.LIGHTSPEED_CLIENT_ID,
    redirect_uri:  redirectUri,
    scope:         'employee:all',
    ...(state ? { state } : {}),
  });

  res.redirect(`${AUTHORIZE_URL}?${params}`);
});

app.get('/oauth/callback', async (req, res, next) => {
  try {
    const { code, error, state } = req.query;

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

    // Auto-discover account_id from Lightspeed API
    let accountId = null;
    try {
      const acctRes = await axios.get('https://api.lightspeedapp.com/API/V3/Account.json', {
        headers: { Authorization: `Bearer ${access_token}` },
        timeout: 10000,
      });
      accountId = acctRes.data?.Account?.accountID ?? null;
    } catch (e) {
      console.warn('[oauth] Could not auto-discover account ID:', e.message);
    }

    // If state encodes a tenant_id, store tokens directly in the tenants table
    let tenantName = null;
    if (state) {
      try {
        const payload = jwt.verify(state, process.env.JWT_SECRET ?? 'dev-secret');
        const tenantId = payload.tenantId;
        await pool.query(
          `UPDATE tenants SET ls_refresh_token = $1, ls_account_id = COALESCE($2, ls_account_id) WHERE id = $3`,
          [refresh_token, accountId, tenantId]
        );
        const { rows } = await pool.query('SELECT name FROM tenants WHERE id = $1', [tenantId]);
        tenantName = rows[0]?.name ?? tenantId;
        console.log(`[oauth] Tokens stored for tenant: ${tenantId} (account ${accountId})`);
      } catch (e) {
        console.warn('[oauth] Invalid state JWT:', e.message);
      }
    }

    // NEVER log refresh_token or access_token in plaintext (would persist in
    // Railway logs, accessible to anyone with log access even after the token
    // is rotated). Log only non-sensitive metadata.
    console.log('\n========== LIGHTSPEED TOKENS ==========');
    if (tenantName) console.log('tenant     :', tenantName);
    if (accountId)  console.log('account_id :', accountId);
    console.log('expires_in :', expires_in, 'seconds');
    console.log('token stored: refresh_token=***REDACTED*** (length=' + (refresh_token?.length ?? 0) + ')');
    console.log('=======================================\n');

    // If the OAuth callback was invoked without state (no tenant JWT), we used
    // to display the token in an HTML <code> block so the developer could copy
    // it. This was safe when the app was single-tenant and only devs saw this
    // page — but now it's a leak vector. Instead, tell them to check server
    // logs (or preferably use the state-encoded flow which stores automatically).
    const successMsg = tenantName
      ? `<h1 style="color:#2d7d46">✓ Lightspeed connecté — ${tenantName}</h1><p>Le compte Lightspeed (ID ${accountId ?? '?'}) a été lié automatiquement. Le prochain sync importera les données.</p><p><a href="/">← Retour à l'application</a></p>`
      : `<h1>Authorization successful</h1><p>Le token a été reçu mais aucun tenant n'était encodé dans le paramètre <code>state</code>. Pour le lier à un tenant, relance le flow OAuth depuis l'interface de connexion Lightspeed du tenant concerné. Ne PAS partager cette URL.</p>`;

    res.send(`<!doctype html><html><head><meta charset="utf-8"><title>OAuth2</title>
<style>body{font-family:sans-serif;max-width:600px;margin:60px auto;padding:0 20px}</style>
</head><body>${successMsg}</body></html>`);
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
       WHERE manufacturer IS NOT NULL AND manufacturer != '' AND tenant_id = $1
       ORDER BY manufacturer`,
      [req.tenantId]
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
    // Tenant isolation: mv_sales_velocity is a global materialized view
    // (no tenant_id column yet — TODO: add in Sprint B). Isolation is
    // enforced via the downstream JOINs on products/inventory/shops which
    // ALL filter by tenant_id. An item_id that doesn't belong to the
    // caller's tenant simply gets dropped by the INNER JOIN.
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
      JOIN inventory  i ON i.item_id = v.item_id AND i.shop_id = v.shop_id AND i.tenant_id = $2
      JOIN products   p ON p.item_id = v.item_id AND p.tenant_id = $2
      JOIN shops      s ON s.shop_id = i.shop_id AND s.tenant_id = $2
      WHERE v.avg_weekly_units > 0
        AND (i.qty_on_hand + i.qty_on_order) / v.avg_weekly_units < $1
        AND p.archived = false
        AND p.category    NOT ILIKE 'Alt%ration%'
        AND p.description NOT ILIKE '%shopify%'
        AND NOT (p.default_cost = 0 AND p.default_price = 0)
      ORDER BY weeks_of_cover ASC NULLS LAST, suggested_order_qty DESC
    `, [weeks, req.tenantId]);
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
    const daysDormant   = parseInt(req.query.days_dormant ?? '14', 10);
    const minStock      = parseInt(req.query.min_stock    ?? '1',  10);
    const showDismissed = req.query.show_dismissed === '1';
    const params        = [daysDormant, minStock];

    const nosFilter = req.query.exclude_nos === '1'
      ? "AND (p.tags IS NULL OR p.tags NOT ILIKE '%nos%')" : '';
    let catFilter = '';
    if (req.query.category) { params.push(req.query.category); catFilter = `AND p.category = $${params.length}`; }
    params.push(req.tenantId);
    const tidN = params.length;

    const dismissedFilter = showDismissed ? '' :
      `AND (trd.dismissed_at IS NULL OR (trd.dismissed_until IS NOT NULL AND trd.dismissed_until < CURRENT_DATE))`;

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
          AND p.tenant_id = $${tidN}
        GROUP BY p.matrix_id, sl.shop_id
      ),
      -- Shops that have EVER sold this matrix (last 3 years) — filters out shops that never carried it
      matrix_ever_sold AS (
        SELECT DISTINCT p.matrix_id, sl.shop_id
        FROM sale_lines sl
        JOIN products p ON p.item_id = sl.item_id
        WHERE sl.completed_time >= now() - interval '3 years'
          AND p.matrix_id IS NOT NULL AND p.archived = false
          AND p.tenant_id = $${tidN}
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
        WHERE i.qty_on_hand > 0 AND i.shop_id != '0'
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
      ),
      -- 90-day sales per item per shop (for velocity comparison)
      sales_90d AS (
        SELECT item_id, shop_id, SUM(qty)::int AS units_90d
        FROM sale_lines
        WHERE completed_time >= now() - interval '90 days' AND completed_time IS NOT NULL
        GROUP BY item_id, shop_id
      ),
      -- Recent completed transfers in last 30 days (recently-transferred badge)
      recent_transfers AS (
        SELECT item_id::text, from_shop_id::text, to_shop_id::text,
               MAX(transfer_date)::date AS last_tx_date
        FROM transfers
        WHERE transfer_received = true AND transfer_date >= now() - interval '30 days'
          AND tenant_id = $${tidN}
        GROUP BY item_id, from_shop_id, to_shop_id
      )
      SELECT
        p.item_id, p.description, p.manufacturer, p.category,
        p.matrix_id, p.default_price,
        im.description                            AS matrix_description,
        COALESCE(
          CASE WHEN p.raw->'ItemAttributes'->>'attribute1' ~ '^[0-9]' OR p.raw->'ItemAttributes'->>'attribute1' ~* '^(XXS|XS|S|M|L|XL|XXL|XXXL|2XL|3XL)$' THEN p.raw->'ItemAttributes'->>'attribute1' END,
          CASE WHEN p.raw->'ItemAttributes'->>'attribute2' ~ '^[0-9]' OR p.raw->'ItemAttributes'->>'attribute2' ~* '^(XXS|XS|S|M|L|XL|XXL|XXXL|2XL|3XL)$' THEN p.raw->'ItemAttributes'->>'attribute2' END,
          CASE WHEN p.raw->'ItemAttributes'->>'attribute3' ~ '^[0-9]' OR p.raw->'ItemAttributes'->>'attribute3' ~* '^(XXS|XS|S|M|L|XL|XXL|XXXL|2XL|3XL)$' THEN p.raw->'ItemAttributes'->>'attribute3' END
        ) AS size,
        sh_d.name  AS dormant_shop,  ba.dormant_shop_id,
        ba.dormant_last_sale,        ba.days_dormant,
        i.qty_on_hand::int                       AS qty,
        sh_a.name  AS active_shop,   ba.active_shop_id,
        ba.active_last_sale,         ba.units_sold_30d AS active_sold_30d,
        COALESCE(i_dest.qty_on_hand, 0)::int     AS stock_destination,
        COALESCE(s_dest.units_90d, 0)::int       AS sold_90d_destination,
        COALESCE(s_src.units_90d,  0)::int       AS sold_90d_source,
        rt.last_tx_date                           AS recently_transferred_date,
        trd.dismissed_until, trd.dismissed_at
      FROM best_active ba
      JOIN products p  ON p.matrix_id = ba.matrix_id AND p.archived = false AND p.tenant_id = $${tidN}
      JOIN item_ever_sold ies ON ies.item_id = p.item_id AND ies.shop_id = ba.active_shop_id
      JOIN inventory i ON i.item_id = p.item_id AND i.shop_id = ba.dormant_shop_id
        AND i.qty_on_hand >= $2
      JOIN shops sh_d ON sh_d.shop_id = ba.dormant_shop_id
      JOIN shops sh_a ON sh_a.shop_id = ba.active_shop_id
      LEFT JOIN item_matrices im ON im.tenant_id = $${tidN} AND im.matrix_id = p.matrix_id
      LEFT JOIN inventory i_dest ON i_dest.item_id = p.item_id AND i_dest.shop_id = ba.active_shop_id
      LEFT JOIN sales_90d s_dest ON s_dest.item_id = p.item_id AND s_dest.shop_id = ba.active_shop_id
      LEFT JOIN sales_90d s_src  ON s_src.item_id  = p.item_id AND s_src.shop_id  = ba.dormant_shop_id
      LEFT JOIN recent_transfers rt ON rt.item_id = p.item_id::text
           AND rt.from_shop_id = ba.dormant_shop_id::text AND rt.to_shop_id = ba.active_shop_id::text
      LEFT JOIN transfer_recommendations_dismissed trd
        ON trd.tenant_id = $${tidN} AND trd.item_id = p.item_id::text
        AND trd.from_shop_id = ba.dormant_shop_id::text AND trd.to_shop_id = ba.active_shop_id::text
      WHERE NOT (p.default_cost = 0 AND p.default_price = 0)
        AND p.description NOT ILIKE '%shopify%'
        ${nosFilter} ${catFilter}
        ${dismissedFilter}
      ORDER BY (i.qty_on_hand * p.default_price) DESC NULLS LAST, p.manufacturer, p.matrix_id, p.description
    `, params);

    res.json({ days_dormant: daysDormant, min_stock: minStock, count: rows.length, transfers: rows });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/transfers/dismiss — dismiss a transfer recommendation
// Body: { item_id, from_shop_id, to_shop_id, duration } ('30d'|'90d'|'permanent')
// ---------------------------------------------------------------------------
app.post('/api/transfers/dismiss', async (req, res, next) => {
  try {
    const { item_id, from_shop_id, to_shop_id, duration } = req.body ?? {};
    if (!item_id || !from_shop_id || !to_shop_id || !duration)
      return res.status(400).json({ error: 'Missing required fields' });

    let dismissed_until = null;
    if (duration === '30d')           dismissed_until = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
    else if (duration === '90d')      dismissed_until = new Date(Date.now() + 90 * 86400000).toISOString().split('T')[0];
    else if (duration !== 'permanent') return res.status(400).json({ error: 'Invalid duration' });

    await pool.query(`
      INSERT INTO transfer_recommendations_dismissed
        (tenant_id, item_id, from_shop_id, to_shop_id, dismissed_at, dismissed_until)
      VALUES ($1, $2, $3, $4, now(), $5)
      ON CONFLICT (tenant_id, item_id, from_shop_id, to_shop_id)
      DO UPDATE SET dismissed_at = now(), dismissed_until = EXCLUDED.dismissed_until
    `, [req.tenantId, String(item_id), String(from_shop_id), String(to_shop_id), dismissed_until]);

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// DELETE /api/transfers/dismiss — restore a dismissed transfer recommendation
// Query: ?item_id=&from_shop_id=&to_shop_id=
// ---------------------------------------------------------------------------
app.delete('/api/transfers/dismiss', async (req, res, next) => {
  try {
    const { item_id, from_shop_id, to_shop_id } = req.query;
    if (!item_id || !from_shop_id || !to_shop_id)
      return res.status(400).json({ error: 'Missing required fields' });

    await pool.query(`
      DELETE FROM transfer_recommendations_dismissed
      WHERE tenant_id = $1 AND item_id = $2 AND from_shop_id = $3 AND to_shop_id = $4
    `, [req.tenantId, String(item_id), String(from_shop_id), String(to_shop_id)]);

    res.json({ ok: true });
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
    params.push(req.tenantId); conditions.push(`p.tenant_id = $${params.length}`);

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
      seasonFilter = `AND (sl.completed_time AT TIME ZONE 'America/Toronto')::date >= $${params.length - 1}::date AND (sl.completed_time AT TIME ZONE 'America/Toronto')::date <= $${params.length}::date`;
    } else if (season === 'p') {
      seasonFilter = `AND EXTRACT(MONTH FROM sl.completed_time AT TIME ZONE 'America/Toronto') BETWEEN 2 AND 8`;
    } else if (season === 'a') {
      seasonFilter = `AND (EXTRACT(MONTH FROM sl.completed_time AT TIME ZONE 'America/Toronto') >= 9 OR EXTRACT(MONTH FROM sl.completed_time AT TIME ZONE 'America/Toronto') = 1)`;
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
    params.push(req.tenantId);
    const tidN = params.length;
    const baseWhere = `p.matrix_id IS NOT NULL AND p.archived = false
      AND p.category NOT ILIKE 'Alt%ration%' AND p.description NOT ILIKE '%shopify%'
      AND NOT (p.default_cost = 0 AND p.default_price = 0) AND p.tenant_id = $${tidN} ${nosFilter}`;

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
          AND tenant_id = $1
        ORDER BY category
      `, [req.tenantId]),
    ]);

    res.json({ count: rows.length, sizes: rows, categories: catRows.map(r => r.category) });
  } catch (err) { next(err); }
});


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

    // Tenant isolation: cache key MUST include tenantId, otherwise the first
    // tenant's response poisons the cache for all others during TTL.
    const cacheKey = JSON.stringify({ r: 'nos', tid: req.tenantId, weeks, shops, colls, sizes });
    const hit = cacheGet(cacheKey);
    if (hit) return res.json({ ...hit, cached: true });

    const params = [weeks]; // $1
    let shopCond = '', collCond = '', sizeCond = '';
    if (shops?.length) { params.push(shops);                                          shopCond = `AND i.shop_id = ANY($${params.length})`; }
    if (colls?.length) { params.push(colls);                                          collCond = `AND string_to_array(lower(coalesce(p.tags,'')), ',') && $${params.length}::text[]`; }
    if (sizes?.length) { params.push('\\y(' + sizes.join('|') + ')\\y');             sizeCond = `AND p.description ~* $${params.length}`; }
    params.push(req.tenantId);
    const tidN = params.length;

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
          AND p.tenant_id = $${tidN}
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
    // Tenant isolation: sync_state rows have tenant_id (nullable for legacy
    // global markers). Only return rows for the caller's tenant PLUS any
    // truly global markers (tenant_id IS NULL). Sync metadata should never
    // leak cross-tenant since it exposes cursor positions and cadence.
    const { rows } = await pool.query(
      `SELECT step, next_url, processed_count, started_at, updated_at
       FROM sync_state
       WHERE step != 'refresh_token'
         AND (tenant_id = $1 OR tenant_id IS NULL)
       ORDER BY updated_at DESC NULLS LAST`,
      [req.tenantId]
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
          AND (sl.completed_time AT TIME ZONE 'America/Toronto')::date >= $2::date
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
        AND (sl.completed_time AT TIME ZONE 'America/Toronto')::date >= $3::date
        AND (sl.completed_time AT TIME ZONE 'America/Toronto')::date <= ${toParam}::date
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
      WHERE (sl.completed_time AT TIME ZONE 'America/Toronto')::date >= $1::date AND (sl.completed_time AT TIME ZONE 'America/Toronto')::date <= $2::date
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
          CASE WHEN (sl.completed_time AT TIME ZONE 'America/Toronto')::date >= ${ shopId ? '$4' : '$3' }::date
                AND (sl.completed_time AT TIME ZONE 'America/Toronto')::date <= ${ shopId ? '$5' : '$4' }::date
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
        WHERE (sl.completed_time AT TIME ZONE 'America/Toronto')::date >= '2025-02-01'
          AND (sl.completed_time AT TIME ZONE 'America/Toronto')::date <= '2025-09-30'
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
    const { rows } = await pool.query('SELECT shop_id, name FROM shops WHERE tenant_id = $1 ORDER BY name', [req.tenantId]);
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
    const tiers = await getMultiplierTiers(req.tenantId);
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
      `INSERT INTO app_settings(tenant_id, key, value, updated_at)
       VALUES ($1, 'multiplier_tiers', $2::jsonb, now())
       ON CONFLICT(tenant_id, key) DO UPDATE SET value = $2::jsonb, updated_at = now()`,
      [req.tenantId, JSON.stringify(tiers)]
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
    const seasons = await getSeasonsConfig(req.tenantId);
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
      `INSERT INTO app_settings(tenant_id, key, value, updated_at)
       VALUES ($1, 'seasons_config', $2::jsonb, now())
       ON CONFLICT(tenant_id, key) DO UPDATE SET value = $2::jsonb, updated_at = now()`,
      [req.tenantId, JSON.stringify(seasons)]
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
    const params = await getBudgetParams(req.tenantId);
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
      `INSERT INTO app_settings(tenant_id, key, value, updated_at)
       VALUES ($1, 'budget_params', $2::jsonb, now())
       ON CONFLICT(tenant_id, key) DO UPDATE SET value = $2::jsonb, updated_at = now()`,
      [req.tenantId, JSON.stringify(params)]
    );
    budgetCache.clear();
    res.json({ ok: true, ...params });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/settings/budget-projection — read projection config (rhythm / velocity blending)
// PUT /api/settings/budget-projection — update projection config
// ---------------------------------------------------------------------------
app.get('/api/settings/budget-projection', async (req, res, next) => {
  try {
    const cfg = await getBudgetProjectionConfig(req.tenantId);
    res.json(cfg);
  } catch (err) { next(err); }
});

app.put('/api/settings/budget-projection', async (req, res, next) => {
  try {
    const cfg = {
      seuil_bascule:    Math.max(0, Math.min(1,  parseFloat(req.body.seuil_bascule    ?? DEFAULT_BUDGET_PROJECTION_CONFIG.seuil_bascule))),
      poids_recent:     Math.max(0, Math.min(1,  parseFloat(req.body.poids_recent     ?? DEFAULT_BUDGET_PROJECTION_CONFIG.poids_recent))),
      fenetre_velocite: Math.max(1, Math.min(52, parseInt(req.body.fenetre_velocite   ?? DEFAULT_BUDGET_PROJECTION_CONFIG.fenetre_velocite, 10))),
      borne_plancher:   Math.max(0, Math.min(2,  parseFloat(req.body.borne_plancher   ?? DEFAULT_BUDGET_PROJECTION_CONFIG.borne_plancher))),
      borne_plafond:    Math.max(1, Math.min(5,  parseFloat(req.body.borne_plafond    ?? DEFAULT_BUDGET_PROJECTION_CONFIG.borne_plafond))),
    };
    if (cfg.borne_plancher >= cfg.borne_plafond) {
      return res.status(400).json({ error: 'borne_plancher must be < borne_plafond' });
    }
    await pool.query(
      `INSERT INTO app_settings(tenant_id, key, value, updated_at)
       VALUES ($1, 'budget_projection_config', $2::jsonb, now())
       ON CONFLICT(tenant_id, key) DO UPDATE SET value = $2::jsonb, updated_at = now()`,
      [req.tenantId, JSON.stringify(cfg)]
    );
    budgetCache.clear();
    res.json({ ok: true, ...cfg });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/settings/nos-lead-times  — délais fournisseur par marque (en semaines)
// PUT /api/settings/nos-lead-times  — sauvegarder
// ---------------------------------------------------------------------------
app.get('/api/settings/nos-lead-times', async (req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT value FROM app_settings WHERE key = 'nos_lead_times' AND tenant_id = $1", [req.tenantId]);
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
      `INSERT INTO app_settings(tenant_id, key, value, updated_at)
       VALUES ($1, 'nos_lead_times', $2::jsonb, now())
       ON CONFLICT(tenant_id, key) DO UPDATE SET value = $2::jsonb, updated_at = now()`,
      [req.tenantId, JSON.stringify(clean)]
    );
    res.json({ ok: true, lead_times: clean });
  } catch (err) { next(err); }
});

// GET /api/settings/nos-excluded  — articles exclus du rapport NOS (array of item_id strings)
// PUT /api/settings/nos-excluded
// ---------------------------------------------------------------------------
app.get('/api/settings/nos-excluded', async (req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT value FROM app_settings WHERE key = 'nos_excluded' AND tenant_id = $1", [req.tenantId]);
    res.json(rows.length ? rows[0].value : []);
  } catch (err) { next(err); }
});

app.put('/api/settings/nos-excluded', async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body) ? req.body.map(String) : [];
    await pool.query(
      `INSERT INTO app_settings(tenant_id, key, value, updated_at)
       VALUES ($1, 'nos_excluded', $2::jsonb, now())
       ON CONFLICT(tenant_id, key) DO UPDATE SET value = $2::jsonb, updated_at = now()`,
      [req.tenantId, JSON.stringify(ids)]
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
    const params = req.query.shop_id ? [req.query.shop_id] : [];
    const shopFilter = req.query.shop_id ? `AND i.shop_id = $1` : '';
    params.push(req.tenantId);
    const tidN = params.length;

    // Load lead times from settings
    const { rows: ltRows } = await pool.query("SELECT value FROM app_settings WHERE key = 'nos_lead_times' AND tenant_id = $1", [req.tenantId]);
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
        AND p.tenant_id = $${tidN}
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
    const { rows } = await pool.query("SELECT value FROM app_settings WHERE key = 'tenant_config' AND tenant_id = $1", [req.tenantId]);
    res.json(rows.length ? rows[0].value : {});
  } catch (err) { next(err); }
});

app.put('/api/settings/tenant', async (req, res, next) => {
  try {
    const config = req.body;
    await pool.query(
      `INSERT INTO app_settings(tenant_id, key, value, updated_at)
       VALUES ($1, 'tenant_config', $2::jsonb, now())
       ON CONFLICT(tenant_id, key) DO UPDATE SET value = $2::jsonb, updated_at = now()`,
      [req.tenantId, JSON.stringify(config)]
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

    const cacheKey = JSON.stringify({ r: 'marque2', season: targetSeasonCode, shops, tid: req.tenantId });
    const hit = cacheGet(cacheKey);
    if (hit) return res.json({ ...hit, cached: true });

    const [tiers, seasonsConfig, budgetParams, projCfg] = await Promise.all([
      getMultiplierTiers(req.tenantId),
      getSeasonsConfig(req.tenantId),
      getBudgetParams(req.tenantId),
      getBudgetProjectionConfig(req.tenantId),
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

    // baseParams layout: [shops?, tenantId]
    // tenantIdx is always the last element of baseParams (position 1 or 2)
    const baseParams     = shops?.length ? [shops, req.tenantId] : [req.tenantId];
    const tenantIdx      = baseParams.length; // $1 or $2
    const tenantCond     = `AND p.tenant_id = $${tenantIdx}`;
    const shopCondSL     = shops?.length ? `AND sl.shop_id = ANY($1)` : '';
    const shopCondInv    = shops?.length ? `AND i.shop_id = ANY($1)` : '';

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
      JOIN inventory i  ON i.item_id  = p.item_id
      JOIN shops     sh ON sh.shop_id = i.shop_id AND sh.tenant_id = p.tenant_id
      WHERE p.tags ILIKE $${coInvTagIdx}
        AND p.tags NOT ILIKE '%nos%'
        AND p.default_cost > 0
        ${tenantCond}
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
      WHERE (sl.completed_time AT TIME ZONE 'America/Toronto')::date >= $${coSalesFromIdx}::date
        AND (sl.completed_time AT TIME ZONE 'America/Toronto')::date <= $${coSalesToIdx}::date
        AND sl.completed_time IS NOT NULL
        AND p.tags ILIKE $${coSalesTagIdx}
        AND p.tags NOT ILIKE '%nos%'
        AND p.default_cost > 0
        ${tenantCond}
        AND p.category    NOT ILIKE 'Alt%ration%'
        AND p.description NOT ILIKE '%shopify%'
        ${shopCondSL}
      GROUP BY p.manufacturer
    `, coSalesParams);
    const ytdSalesMap = {};
    for (const r of coSalesRows) ytdSalesMap[r.manufacturer] = parseFloat(r.sales_cost_ytd ?? 0);

    // Three-pass season processing:
    //   Pass 1 — SQL data collection (all reference seasons)
    //   Pass 2 — compute ST for COMPLETED seasons (simple, no projection)
    //   Pass 3 — compute ST for IN-PROGRESS seasons with rhythm-adjusted projection
    // Pass 2 must run before Pass 3 because the projection bounds use the
    // brand's historical ST (average across completed reference seasons).
    const seasonResults = {};
    const rawBySeason   = {}; // { code: { irSlMap, irInvMap, soldMap, soldCostMap, isRefInProgress, refSellStart, refSellEnd, allMfrsRef } }

    // ─── PASS 1: SQL data collection ────────────────────────────────────────
    for (const refSeason of refSeasons) {
      const refSellStart = new Date(refSeason.sell_from);
      const refSellEnd   = new Date(refSeason.sell_to);
      if (todayDate < refSellStart) continue; // future reference — no data yet

      const isRefInProgress = todayDate >= refSellStart && todayDate <= refSellEnd;
      const refTag          = `%${refSeason.tag_pattern}%`;

      const irSlParams  = [...baseParams, refSeason.reception_from, refTag];
      const irSlFromIdx = irSlParams.length - 1;
      const irSlTagIdx  = irSlParams.length;
      const { rows: irSlRows } = await pool.query(`
        SELECT COALESCE(p.manufacturer, 'Sans marque') AS manufacturer,
               SUM(sl.qty)::float8 AS qty_sold_all,
               SUM(sl.qty * COALESCE(p.default_cost, 0))::float8 AS sold_cost
        FROM sale_lines sl JOIN products p ON p.item_id = sl.item_id
        WHERE (sl.completed_time AT TIME ZONE 'America/Toronto')::date >= $${irSlFromIdx}::date
          AND sl.completed_time IS NOT NULL
          AND p.tags ILIKE $${irSlTagIdx} AND p.tags NOT ILIKE '%nos%'
          ${tenantCond}
          AND p.category NOT ILIKE 'Alt%ration%' AND p.description NOT ILIKE '%shopify%'
          ${shopCondSL}
        GROUP BY p.manufacturer
      `, irSlParams);

      const irInvParams  = [...baseParams, refTag];
      const irInvTagIdx  = irInvParams.length;
      const { rows: irInvRows } = await pool.query(`
        SELECT COALESCE(p.manufacturer, 'Sans marque') AS manufacturer,
               SUM(COALESCE(i.qty_on_hand, 0))::float8 AS qty_on_hand,
               SUM(COALESCE(i.qty_on_hand, 0) * COALESCE(p.default_cost, 0))::float8 AS stock_cost
        FROM products p
        JOIN inventory i  ON i.item_id  = p.item_id
        JOIN shops     sh ON sh.shop_id = i.shop_id AND sh.tenant_id = p.tenant_id
        WHERE p.tags ILIKE $${irInvTagIdx} AND p.tags NOT ILIKE '%nos%'
          ${tenantCond}
          AND p.category NOT ILIKE 'Alt%ration%' AND p.description NOT ILIKE '%shopify%'
          AND i.qty_on_hand > 0
          ${shopCondInv}
        GROUP BY p.manufacturer
      `, irInvParams);

      const slParams  = [...baseParams, refSeason.sell_from, refSeason.sell_to, refTag];
      const slFromIdx = slParams.length - 2;
      const slToIdx   = slParams.length - 1;
      const slTagIdx  = slParams.length;
      const { rows: slRows } = await pool.query(`
        SELECT COALESCE(p.manufacturer, 'Sans marque') AS manufacturer,
               SUM(sl.qty)::float8 AS units_sold,
               SUM(sl.qty * COALESCE(p.default_cost, 0))::float8 AS sold_cost
        FROM sale_lines sl JOIN products p ON p.item_id = sl.item_id
        WHERE (sl.completed_time AT TIME ZONE 'America/Toronto')::date >= $${slFromIdx}::date
          AND (sl.completed_time AT TIME ZONE 'America/Toronto')::date <= $${slToIdx}::date
          AND sl.completed_time IS NOT NULL
          AND p.tags ILIKE $${slTagIdx} AND p.tags NOT ILIKE '%nos%'
          ${tenantCond}
          AND p.category NOT ILIKE 'Alt%ration%' AND p.description NOT ILIKE '%shopify%'
          ${shopCondSL}
        GROUP BY p.manufacturer
      `, slParams);

      const irSlMap   = {};
      for (const r of irSlRows)  irSlMap[r.manufacturer]  = { qty: parseFloat(r.qty_sold_all ?? 0), cost: parseFloat(r.sold_cost ?? 0) };
      const irInvMap  = {};
      for (const r of irInvRows) irInvMap[r.manufacturer] = { qty: parseFloat(r.qty_on_hand ?? 0),  cost: parseFloat(r.stock_cost ?? 0) };
      const soldMap     = {};
      const soldCostMap = {};
      for (const r of slRows) {
        soldMap[r.manufacturer]     = parseFloat(r.units_sold ?? 0);
        soldCostMap[r.manufacturer] = parseFloat(r.sold_cost  ?? 0);
      }

      rawBySeason[refSeason.code] = {
        irSlMap, irInvMap, soldMap, soldCostMap,
        isRefInProgress, refSellStart, refSellEnd,
        allMfrsRef: new Set([...Object.keys(irSlMap), ...Object.keys(irInvMap)]),
      };
    }

    // ─── PASS 2: compute ST for COMPLETED seasons ───────────────────────────
    for (const refSeason of refSeasons) {
      const raw = rawBySeason[refSeason.code];
      if (!raw || raw.isRefInProgress) continue;
      seasonResults[refSeason.code] = {};
      for (const mfr of raw.allMfrsRef) {
        const sl  = raw.irSlMap[mfr]  ?? { qty: 0, cost: 0 };
        const inv = raw.irInvMap[mfr] ?? { qty: 0, cost: 0 };
        const impliedUnits = sl.qty + inv.qty;
        const impliedCost  = sl.cost + inv.cost;
        if (impliedCost <= 0) continue;
        const soldRaw     = raw.soldMap[mfr]     ?? 0;
        const soldCostRaw = raw.soldCostMap[mfr] ?? 0;
        const st          = impliedUnits >= 5 ? soldRaw / impliedUnits : null;
        const blendedCost = (impliedCost + soldCostRaw) / 2;
        seasonResults[refSeason.code][mfr] = {
          units_received:    Math.round(impliedUnits),
          units_sold:        Math.round(soldRaw),
          units_sold_ytd:    Math.round(soldRaw),
          received_cost:     Math.round(blendedCost * 100) / 100,
          received_cost_raw: Math.round(impliedCost * 100) / 100,
          sold_cost:         Math.round(soldCostRaw * 100) / 100,
          st_rate:           st !== null ? Math.round(st * 1000) / 1000 : null,
          st_rate_ytd:       st !== null ? Math.round(st * 1000) / 1000 : null,
          st_insufficient:   impliedUnits < 5,
          partial:           false,
        };
      }
    }

    // Compute st_historique_marque per brand (avg of completed reference seasons' ST) —
    // used as anchor for the projection bounds in Pass 3.
    const stHistoriqueMarque = {};
    {
      const allMfrsCompleted = new Set();
      for (const code of Object.keys(seasonResults)) {
        Object.keys(seasonResults[code] ?? {}).forEach(m => allMfrsCompleted.add(m));
      }
      for (const mfr of allMfrsCompleted) {
        const sts = refSeasons
          .filter(s => rawBySeason[s.code] && !rawBySeason[s.code].isRefInProgress)
          .map(s => seasonResults[s.code]?.[mfr]?.st_rate)
          .filter(x => x != null);
        if (sts.length) stHistoriqueMarque[mfr] = sts.reduce((a, b) => a + b, 0) / sts.length;
      }
    }

    // ─── PASS 3: compute ST for IN-PROGRESS seasons with rhythm-adjusted projection ─
    for (const refSeason of refSeasons) {
      const raw = rawBySeason[refSeason.code];
      if (!raw || !raw.isRefInProgress) continue;

      const refSellStart = raw.refSellStart;
      const refSellEnd   = raw.refSellEnd;
      const refTotalDays = (refSellEnd - refSellStart) / 86400000;
      const refElapsedDays = Math.max(1, (todayDate - refSellStart) / 86400000);
      const refCompletion  = Math.min(1, refElapsedDays / refTotalDays);
      const weeksRemaining = Math.max(0, (refSellEnd - todayDate) / (7 * 86400000));
      seasonResults[refSeason.code] = {};

      // Fetch histRemaining, histElapsed (from most recent completed prev season), and recentVelocity
      let histRemaining      = null;
      let histElapsed        = null;
      let comparableSeasonCode = null;
      let recentVelocity     = null;

      if (refCompletion > 0.05) {
        const prevSeasonsForRef    = getReferenceSeasonsFromConfig(refSeason.code, seasonsConfig, nbRef);
        const completedPrevSeasons = prevSeasonsForRef.filter(s => todayDate > new Date(s.sell_to));

        // histRemaining — avg sales in equivalent remaining window across all completed prev seasons
        if (completedPrevSeasons.length > 0) {
          histRemaining = {};
          for (const prevSeas of completedPrevSeasons) {
            const prevSellStart  = new Date(prevSeas.sell_from);
            const prevSellEnd    = new Date(prevSeas.sell_to);
            const prevWindowFrom = new Date(prevSellStart.getTime() + refElapsedDays * 86400000);
            if (prevWindowFrom >= prevSellEnd) continue;

            const prevTag   = `%${prevSeas.tag_pattern}%`;
            const rwParams  = [...baseParams, prevWindowFrom.toISOString().slice(0, 10), prevSeas.sell_to, prevTag];
            const rwFromIdx = rwParams.length - 2;
            const rwToIdx   = rwParams.length - 1;
            const rwTagIdx  = rwParams.length;

            const { rows: rwRows } = await pool.query(`
              SELECT COALESCE(p.manufacturer, 'Sans marque') AS manufacturer,
                     SUM(sl.qty * COALESCE(p.default_cost, 0))::float8 AS remaining_cost,
                     SUM(sl.qty)::float8 AS remaining_units
              FROM sale_lines sl JOIN products p ON p.item_id = sl.item_id
              WHERE (sl.completed_time AT TIME ZONE 'America/Toronto')::date >= $${rwFromIdx}::date
                AND (sl.completed_time AT TIME ZONE 'America/Toronto')::date <= $${rwToIdx}::date
                AND sl.completed_time IS NOT NULL
                AND p.tags ILIKE $${rwTagIdx} AND p.tags NOT ILIKE '%nos%'
                ${tenantCond}
                AND p.category NOT ILIKE 'Alt%ration%' AND p.description NOT ILIKE '%shopify%'
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

        // histElapsed — from the most recent completed prev season, at the equivalent elapsed date.
        // Used to compute st_ytd_comparable for the ratio_rythme step.
        if (completedPrevSeasons.length > 0) {
          const cmp = completedPrevSeasons[0];
          comparableSeasonCode = cmp.code;
          const prevSellStart = new Date(cmp.sell_from);
          const prevCutoffDt  = new Date(prevSellStart.getTime() + refElapsedDays * 86400000);
          const prevSellEndDt = new Date(cmp.sell_to);
          const prevCutoffStr = (prevCutoffDt <= prevSellEndDt ? prevCutoffDt : prevSellEndDt).toISOString().slice(0, 10);
          const prevTag       = `%${cmp.tag_pattern}%`;

          // Sold during [sell_from, cutoff]
          const heSoldParams = [...baseParams, cmp.sell_from, prevCutoffStr, prevTag];
          const heSoldFromIdx = heSoldParams.length - 2;
          const heSoldToIdx   = heSoldParams.length - 1;
          const heSoldTagIdx  = heSoldParams.length;
          const { rows: heSoldRows } = await pool.query(`
            SELECT COALESCE(p.manufacturer, 'Sans marque') AS manufacturer,
                   SUM(sl.qty)::float8 AS sold_elapsed
            FROM sale_lines sl JOIN products p ON p.item_id = sl.item_id
            WHERE (sl.completed_time AT TIME ZONE 'America/Toronto')::date >= $${heSoldFromIdx}::date
              AND (sl.completed_time AT TIME ZONE 'America/Toronto')::date <= $${heSoldToIdx}::date
              AND sl.completed_time IS NOT NULL
              AND p.tags ILIKE $${heSoldTagIdx} AND p.tags NOT ILIKE '%nos%'
              ${tenantCond}
              AND p.category NOT ILIKE 'Alt%ration%' AND p.description NOT ILIKE '%shopify%'
              ${shopCondSL}
            GROUP BY p.manufacturer
          `, heSoldParams);

          // Received-since-reception up to cutoff (for denominator of st_ytd_comparable)
          const heRecvParams = [...baseParams, cmp.reception_from, prevCutoffStr, prevTag];
          const heRecvFromIdx = heRecvParams.length - 2;
          const heRecvToIdx   = heRecvParams.length - 1;
          const heRecvTagIdx  = heRecvParams.length;
          const { rows: heRecvRows } = await pool.query(`
            SELECT COALESCE(p.manufacturer, 'Sans marque') AS manufacturer,
                   SUM(sl.qty)::float8 AS recv_elapsed
            FROM sale_lines sl JOIN products p ON p.item_id = sl.item_id
            WHERE (sl.completed_time AT TIME ZONE 'America/Toronto')::date >= $${heRecvFromIdx}::date
              AND (sl.completed_time AT TIME ZONE 'America/Toronto')::date <= $${heRecvToIdx}::date
              AND sl.completed_time IS NOT NULL
              AND p.tags ILIKE $${heRecvTagIdx} AND p.tags NOT ILIKE '%nos%'
              ${tenantCond}
              AND p.category NOT ILIKE 'Alt%ration%' AND p.description NOT ILIKE '%shopify%'
              ${shopCondSL}
            GROUP BY p.manufacturer
          `, heRecvParams);

          histElapsed = {};
          for (const r of heSoldRows) {
            const m = r.manufacturer;
            histElapsed[m] = histElapsed[m] ?? { sold: 0, recvElapsed: 0 };
            histElapsed[m].sold = parseFloat(r.sold_elapsed);
          }
          for (const r of heRecvRows) {
            const m = r.manufacturer;
            histElapsed[m] = histElapsed[m] ?? { sold: 0, recvElapsed: 0 };
            histElapsed[m].recvElapsed = parseFloat(r.recv_elapsed);
          }
        }

        // recentVelocity — units sold in the last fenetre_velocite weeks of the CURRENT season
        const velFromDt  = new Date(todayDate.getTime() - projCfg.fenetre_velocite * 7 * 86400000);
        const velFromStr = velFromDt.toISOString().slice(0, 10);
        const velToStr   = todayDate.toISOString().slice(0, 10);
        const refTag     = `%${refSeason.tag_pattern}%`;
        const rvParams   = [...baseParams, velFromStr, velToStr, refTag];
        const rvFromIdx  = rvParams.length - 2;
        const rvToIdx    = rvParams.length - 1;
        const rvTagIdx   = rvParams.length;
        const { rows: rvRows } = await pool.query(`
          SELECT COALESCE(p.manufacturer, 'Sans marque') AS manufacturer,
                 SUM(sl.qty)::float8 AS units
          FROM sale_lines sl JOIN products p ON p.item_id = sl.item_id
          WHERE (sl.completed_time AT TIME ZONE 'America/Toronto')::date >= $${rvFromIdx}::date
            AND (sl.completed_time AT TIME ZONE 'America/Toronto')::date <= $${rvToIdx}::date
            AND sl.completed_time IS NOT NULL
            AND p.tags ILIKE $${rvTagIdx} AND p.tags NOT ILIKE '%nos%'
            ${tenantCond}
            AND p.category NOT ILIKE 'Alt%ration%' AND p.description NOT ILIKE '%shopify%'
            ${shopCondSL}
          GROUP BY p.manufacturer
        `, rvParams);
        recentVelocity = {};
        for (const r of rvRows) recentVelocity[r.manufacturer] = parseFloat(r.units);
      }

      // Now per-brand projection
      for (const mfr of raw.allMfrsRef) {
        const sl  = raw.irSlMap[mfr]  ?? { qty: 0, cost: 0 };
        const inv = raw.irInvMap[mfr] ?? { qty: 0, cost: 0 };
        const impliedUnitsYtd = sl.qty + inv.qty;
        const impliedCostYtd  = sl.cost + inv.cost;
        if (impliedCostYtd <= 0) continue;

        const soldRaw     = raw.soldMap[mfr]     ?? 0;
        const soldCostRaw = raw.soldCostMap[mfr] ?? 0;
        const stYtd       = impliedUnitsYtd >= 5 ? soldRaw / impliedUnitsYtd : null;

        // Step 1: compute ratio_rythme against the most recent completed prev season at equivalent point
        let ratioRythme = null, stYtdComparable = null;
        if (histElapsed?.[mfr] && stYtd != null && comparableSeasonCode) {
          const he = histElapsed[mfr];
          // Denominator proxy: sold-since-reception up to cutoff + current stock of prev season
          // (prev-season stock at cutoff isn't retrievable — using current stock is the best available proxy)
          const prevInv = rawBySeason[comparableSeasonCode]?.irInvMap?.[mfr]?.qty ?? 0;
          const impliedRecvComparable = he.recvElapsed + prevInv;
          if (impliedRecvComparable >= 5) {
            stYtdComparable = he.sold / impliedRecvComparable;
            if (stYtdComparable > 0) ratioRythme = stYtd / stYtdComparable;
          }
        }

        // Step 2: choose projection method
        const rem = histRemaining?.[mfr];
        const hasHistRem  = rem && rem.count > 0;
        const avgRemUnits = hasHistRem ? rem.totalUnits / rem.count : 0;
        const avgRemCost  = hasHistRem ? rem.totalCost  / rem.count : 0;

        let methode = 'historique';
        let velRecent = null, velHist = null;
        let remainingUnits = 0, remainingCost = 0;

        if (ratioRythme != null && Math.abs(ratioRythme - 1) > projCfg.seuil_bascule) {
          methode = 'velocite_ajustee';
          const rvUnits = recentVelocity?.[mfr] ?? 0;
          velRecent = rvUnits / projCfg.fenetre_velocite;
          velHist   = (hasHistRem && weeksRemaining > 0) ? (avgRemUnits / weeksRemaining) : 0;
          const velProj = velRecent * projCfg.poids_recent + velHist * (1 - projCfg.poids_recent);
          remainingUnits = velProj * weeksRemaining;
          // Cost side: prorate remaining cost by remaining units × historical cost-per-unit
          const histCostPerUnit = (avgRemUnits > 0) ? (avgRemCost / avgRemUnits) : 0;
          remainingCost  = remainingUnits * histCostPerUnit;
        } else if (hasHistRem) {
          methode = 'historique';
          remainingUnits = avgRemUnits;
          remainingCost  = avgRemCost;
        } else {
          // Fallback: linear extrapolation when no historical remaining data exists.
          // Scales BOTH sold and received by 1/completion so the projected ST = stYtd
          // (the "no information" default that keeps ST identical to the OLD behavior).
          methode = 'lineaire';
        }

        // Step 3: compute projected sold / received / ST
        let soldProj, receivedProj, impliedCostProj, soldCostProj;
        if (methode === 'lineaire') {
          soldProj        = soldRaw          / refCompletion;
          receivedProj    = impliedUnitsYtd  / refCompletion;
          impliedCostProj = impliedCostYtd   / refCompletion;
          soldCostProj    = soldCostRaw      / refCompletion;
          remainingUnits  = soldProj - soldRaw;                 // for the response payload only
          remainingCost   = soldCostProj - soldCostRaw;
        } else {
          soldProj        = soldRaw         + remainingUnits;
          receivedProj    = impliedUnitsYtd + remainingUnits;
          impliedCostProj = impliedCostYtd  + remainingCost;
          soldCostProj    = soldCostRaw     + remainingCost;
        }
        const stProjeteBrut = receivedProj >= 5 ? soldProj / receivedProj : null;

        // Step 4: apply bounds using stHistoriqueMarque[mfr].
        // Guard: if historical ST is very low (< 10%), the anchor isn't meaningful
        // (e.g., a brand that historically didn't sell) — skip bounds, cap only at 100%.
        let stProjeteFinal = stProjeteBrut;
        let borneAppliquee = null;
        const stHist = stHistoriqueMarque[mfr];
        const stHistUsable = stHist != null && stHist >= 0.10;
        if (stProjeteBrut != null && stHistUsable) {
          const plancher = stHist * projCfg.borne_plancher;
          const plafond  = Math.min(1.0, stHist * projCfg.borne_plafond);
          if (stProjeteBrut < plancher) { stProjeteFinal = plancher; borneAppliquee = 'plancher'; }
          else if (stProjeteBrut > plafond) { stProjeteFinal = plafond; borneAppliquee = 'plafond'; }
        } else if (stProjeteBrut != null && stProjeteBrut > 1.0) {
          stProjeteFinal = 1.0;
          borneAppliquee = 'plafond';
        }

        const impliedUnitsProj = receivedProj;
        const blendedCostProj  = (impliedCostProj + soldCostProj) / 2;

        seasonResults[refSeason.code][mfr] = {
          units_received:    Math.round(impliedUnitsProj),
          units_sold:        Math.round(soldProj),
          units_sold_ytd:    Math.round(soldRaw),
          received_cost:     Math.round(blendedCostProj * 100) / 100,
          received_cost_raw: Math.round(impliedCostProj * 100) / 100,
          sold_cost:         Math.round(soldCostProj * 100) / 100,
          st_rate:           stProjeteFinal != null ? Math.round(stProjeteFinal * 1000) / 1000 : null,
          st_rate_ytd:       stYtd != null ? Math.round(stYtd * 1000) / 1000 : null,
          st_insufficient:   impliedUnitsProj < 5,
          partial:           true,
          projection_detail: {
            methode,
            ratio_rythme:               ratioRythme != null ? Math.round(ratioRythme * 100) / 100 : null,
            st_ytd_actuel:              stYtd != null ? Math.round(stYtd * 1000) / 10 : null,
            st_ytd_comparable:          stYtdComparable != null ? Math.round(stYtdComparable * 1000) / 10 : null,
            comparable_season:          comparableSeasonCode,
            velocite_recente:           velRecent != null ? Math.round(velRecent * 100) / 100 : null,
            velocite_historique:        velHist   != null ? Math.round(velHist   * 100) / 100 : null,
            semaines_restantes:         Math.round(weeksRemaining * 10) / 10,
            ventes_restantes_projetees: Math.round(remainingUnits),
            st_projete_brut:            stProjeteBrut  != null ? Math.round(stProjeteBrut  * 1000) / 10 : null,
            st_projete_final:           stProjeteFinal != null ? Math.round(stProjeteFinal * 1000) / 10 : null,
            borne_appliquee:            borneAppliquee,
            st_historique_marque:       stHist != null ? Math.round(stHist * 1000) / 10 : null,
          },
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

      // costEntries: seasons where blendedCost > 0. stEntries: seasons where recv >= 5
      // (significance threshold for ST — see st_rate computation above).
      // Both pools use the same recencyFactor weights but filter independently, so their
      // effective weight distributions may diverge when a season has cost data but
      // fewer than 5 units received (st_rate = null). This is intentional: unreliable
      // ST data must not distort the multiplier tier selection.
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
        projection_detail:     mostRecentData?.projection_detail ?? null,
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
         FROM budget_plans WHERE season_code = $1 AND tenant_id = $2`,
        [season, req.tenantId]
      ),
      pool.query(
        `SELECT manufacturer, drop_id, drop_name, drop_order
         FROM budget_plan_drops WHERE season_code = $1 AND tenant_id = $2
         ORDER BY manufacturer, drop_order`,
        [season, req.tenantId]
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
      `INSERT INTO budget_plans(tenant_id, season_code, manufacturer, drop_id, shop_id, planned_amount, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT(tenant_id, season_code, manufacturer, drop_id, shop_id)
       DO UPDATE SET planned_amount = $6, updated_at = now()`,
      [req.tenantId, sc, manufacturer, drop_id, shop_id, amount]
    );
    // Ensure drop metadata exists
    await pool.query(
      `INSERT INTO budget_plan_drops(tenant_id, season_code, manufacturer, drop_id, drop_name, drop_order)
       VALUES ($1, $2, $3, $4, 'Drop 1', 1)
       ON CONFLICT DO NOTHING`,
      [req.tenantId, sc, manufacturer, drop_id]
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
      `SELECT drop_id, drop_order FROM budget_plan_drops WHERE season_code = $1 AND manufacturer = $2 AND tenant_id = $3 ORDER BY drop_order`,
      [sc, manufacturer, req.tenantId]
    );
    const nextOrder  = (existing[existing.length - 1]?.drop_order ?? 0) + 1;
    const newDropId  = `drop_${nextOrder}`;
    const name       = drop_name?.trim() || `Drop ${nextOrder}`;
    await pool.query(
      `INSERT INTO budget_plan_drops(tenant_id, season_code, manufacturer, drop_id, drop_name, drop_order)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING`,
      [req.tenantId, sc, manufacturer, newDropId, name, nextOrder]
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
       WHERE season_code = $1 AND manufacturer = $2 AND drop_id = $3 AND tenant_id = $5`,
      [season_code.toLowerCase(), manufacturer, drop_id, name, req.tenantId]
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
    await pool.query(`DELETE FROM budget_plans        WHERE season_code = $1 AND manufacturer = $2 AND drop_id = $3 AND tenant_id = $4`, [sc, manufacturer, drop_id, req.tenantId]);
    await pool.query(`DELETE FROM budget_plan_drops   WHERE season_code = $1 AND manufacturer = $2 AND drop_id = $3 AND tenant_id = $4`, [sc, manufacturer, drop_id, req.tenantId]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.delete('/api/budget-plan/brand', async (req, res, next) => {
  try {
    const { season_code, manufacturer } = req.query;
    if (!season_code || !manufacturer) return res.status(400).json({ error: 'season_code and manufacturer required' });
    const sc = season_code.toLowerCase();
    await pool.query(`DELETE FROM budget_plans      WHERE season_code = $1 AND manufacturer = $2 AND tenant_id = $3`, [sc, manufacturer, req.tenantId]);
    await pool.query(`DELETE FROM budget_plan_drops WHERE season_code = $1 AND manufacturer = $2 AND tenant_id = $3`, [sc, manufacturer, req.tenantId]);
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
    const conditions = ['season_code = $1', 'manufacturer = $2', 'tenant_id = $3'];
    const params     = [season.toLowerCase(), manufacturer, req.tenantId];
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
    const { season_code, manufacturer, drop_id = 'drop_1', filename, content_type, data_base64,
            destination_shop_id } = req.body;
    if (!season_code || !manufacturer || !filename || !data_base64)
      return res.status(400).json({ error: 'season_code, manufacturer, filename, data_base64 are required' });
    const buf = Buffer.from(data_base64, 'base64');
    const { rows } = await pool.query(
      `INSERT INTO budget_documents(tenant_id, season_code, manufacturer, drop_id, filename, content_type, file_size, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [req.tenantId, season_code.toLowerCase(), manufacturer, drop_id, filename,
       content_type || 'application/octet-stream', buf.length, buf]
    );

    // ═══════════════════════════════════════════════════════════════════
    // Pre-analysis kick-off — if the attached doc is a PDF and we have
    // enough context (mfr + season + drop_id + shop), immediately start
    // an LLM extraction in the background. When the operator later
    // clicks the drop's Importer button, the extraction is often
    // already complete → preview appears instantly instead of a 30-90s
    // wait. Uses source_hash to skip re-extraction of already-imported
    // PDFs (deduplication).
    // ═══════════════════════════════════════════════════════════════════
    let preAnalysisFileId = null;
    const isPdf = (content_type || '').toLowerCase().includes('pdf')
                || filename.toLowerCase().endsWith('.pdf');
    if (isPdf && destination_shop_id) {
      try {
        const crypto = require('crypto');
        const source_hash = crypto.createHash('sha256').update(buf).digest('hex');
        // Pre-analysis dedup: skip if a file with the SAME source_hash
        // already exists for this (mfr, drop, season) — regardless of
        // shop. Pre-analysis is a background convenience; we don't want
        // to auto-spawn N extractions for N shops of the same drop just
        // because the operator switched views. The shop-specific import
        // is created explicitly when the operator clicks Importer per
        // shop (which goes through /api/import/upload with the intended
        // shop and sets confirmed_at). This is stricter than the
        // per-shop dedup on /upload — intentional, to prevent orphan
        // pre-analyses from cluttering other shops' Plan tabs.
        const { rows: dup } = await pool.query(
          `SELECT file_id, destination_shop_id FROM import_files
           WHERE tenant_id = $1
             AND source_hash = $2
             AND season_tag = $3
             AND lower(target_manufacturer) = lower($4)
             AND COALESCE(drop_id, '') = COALESCE($5, '')
           ORDER BY confirmed_at DESC NULLS LAST, uploaded_at DESC
           LIMIT 1`,
          [req.tenantId, source_hash, season_code.toLowerCase(), manufacturer,
           String(drop_id || '')],
        );
        if (dup.length) {
          preAnalysisFileId = dup[0].file_id;
        } else {
          const insRes = await pool.query(
            `INSERT INTO import_files
               (tenant_id, supplier_key, recipe_id, source_filename, source_hash, source_bytes,
                uploaded_by, season_tag, destination_shop_id, target_manufacturer, status,
                extraction_source, drop_id, preview_computed_at)
             VALUES ($1, 'unknown', NULL, $2, $3, $4, $5, $6, $7, $8, 'extracting', 'recipe', $9, now())
             RETURNING file_id`,
            [req.tenantId, filename, source_hash, buf, req.userId ?? null,
             season_code.toLowerCase(), String(destination_shop_id),
             manufacturer, String(drop_id)],
          );
          preAnalysisFileId = insRes.rows[0].file_id;
          if (importHelpers?.spawnLlmExtractionBackground) {
            importHelpers.spawnLlmExtractionBackground(req.tenantId, preAnalysisFileId);
            console.log(`[pre-analysis] file=${preAnalysisFileId} mfr=${manufacturer} drop=${drop_id} tenant=${req.tenantId} spawned`);
          }
        }
      } catch (e) {
        // Non-fatal — the doc attachment succeeded, only the pre-analysis failed
        console.error('[pre-analysis] failed:', e.message);
      }
    }
    res.json({ ok: true, id: rows[0].id, filename,
      pre_analysis_file_id: preAnalysisFileId });
  } catch (err) { next(err); }
});

// Download a document by id
app.get('/api/budget-plan/document/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT filename, content_type, data FROM budget_documents WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, req.tenantId]
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
    await pool.query(`DELETE FROM budget_documents WHERE id = $1 AND tenant_id = $2`, [req.params.id, req.tenantId]);
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
    const configPromise = Promise.all([getSeasonsConfig(req.tenantId), getMultiplierTiers(req.tenantId)]);
    // p layout: [mfr, shopId?, tenantId]
    const p      = hasShop ? [mfr, shopId, req.tenantId] : [mfr, req.tenantId];
    const tIdx   = p.length; // $3 or $2
    const tenantCondP = `AND p.tenant_id = $${tIdx}`;
    const slS    = hasShop ? 'AND sl.shop_id = $2'     : '';
    const invJ   = hasShop ? 'AND i.shop_id  = $2'     : "AND i.shop_id != '0'";
    const stCTE  = `
      st AS (
        SELECT i.item_id,
               SUM(COALESCE(i.qty_on_hand,0) + COALESCE(i.qty_on_order,0)) AS stock
        FROM   inventory i
        JOIN   shops sh ON sh.shop_id = i.shop_id AND sh.tenant_id = $${tIdx}
        WHERE  1=1 ${hasShop ? 'AND i.shop_id = $2' : ''}
        GROUP  BY i.item_id
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

    const seasonTag = allTime ? null : `%${seasonCode}%`;

    // Q6 — Transfers balance for this shop (only meaningful when shop filter active)
    // When a season is selected, filter transfers to season-tagged items only so that
    // stockTagRecon = stockTag + sentOut - receivedIn stays in the same tag universe.
    // Without this filter, untagged transfers can push stockTagRecon below zero,
    // causing "ST avant transferts" to clamp at 100 % even when tagged stock remains.
    const q6TagCond = (!allTime && seasonTag) ? `AND p.tags ILIKE $${p.length + 1}` : '';
    const q6Params  = (!allTime && seasonTag) ? [...p, seasonTag] : p;
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
            ${q6TagCond}
            ${tenantCondP}
        `, q6Params)
      : Promise.resolve({ rows: [{ received_in: 0, sent_out: 0 }] });

    // Q1 — sell-through (season date range) + revenue_12w (last 12w + season tag)
    // Param layout:
    //   allTime + no shop : $1=mfr
    //   allTime + shop    : $1=mfr  $2=shopId
    //   season + no shop  : $1=mfr  $2=stFrom  $3=stTo  $4='%tag%'
    //   season + shop     : $1=mfr  $2=shopId  $3=stFrom $4=stTo  $5='%tag%'
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
          ${tenantCondP}
          ${slS}
      `, p);
    } else if (hasShop) {
      // $1=mfr $2=shopId $3=stFrom $4=stTo $5='%tag%' $6=tenantId
      // No date filter in WHERE — CASEs handle mode 1 (tag) and mode 2 (tag+period)
      q1Promise = pool.query(`
        SELECT
          COUNT(DISTINCT CASE WHEN p.tags ILIKE $5
                              AND (sl.completed_time AT TIME ZONE 'America/Toronto')::date >= $3::date AND (sl.completed_time AT TIME ZONE 'America/Toronto')::date <= $4::date
                             THEN sl.item_id END)::int AS active_items,
          ROUND(SUM(CASE WHEN sl.completed_time >= now() - INTERVAL '12 weeks'
                         THEN sl.qty ELSE 0 END) / 12.0, 1)::float8   AS weekly_velocity,
          ROUND(SUM(CASE WHEN p.tags ILIKE $5
                         THEN sl.qty ELSE 0 END), 0)::float8           AS units_sold_tag,
          ROUND(SUM(CASE WHEN p.tags ILIKE $5
                         THEN sl.qty * sl.unit_price - COALESCE((sl.raw->>'calcLineDiscount')::numeric, 0) ELSE 0 END), 2)::float8 AS revenue_tag,
          ROUND(SUM(CASE WHEN p.tags ILIKE $5
                          AND (sl.completed_time AT TIME ZONE 'America/Toronto')::date >= $3::date AND (sl.completed_time AT TIME ZONE 'America/Toronto')::date <= $4::date
                         THEN sl.qty ELSE 0 END), 0)::float8           AS units_sold_tag_period,
          ROUND(SUM(CASE WHEN p.tags ILIKE $5
                          AND (sl.completed_time AT TIME ZONE 'America/Toronto')::date >= $3::date AND (sl.completed_time AT TIME ZONE 'America/Toronto')::date <= $4::date
                         THEN sl.qty * sl.unit_price - COALESCE((sl.raw->>'calcLineDiscount')::numeric, 0) ELSE 0 END), 2)::float8 AS revenue_tag_period,
          ROUND(SUM(CASE WHEN sl.completed_time >= now() - INTERVAL '12 weeks' AND p.tags ILIKE $5
                         THEN sl.qty * sl.unit_price - COALESCE((sl.raw->>'calcLineDiscount')::numeric, 0) ELSE 0 END), 2)::float8 AS revenue_12w
        FROM sale_lines sl
        JOIN products p ON p.item_id = sl.item_id
        WHERE p.manufacturer ILIKE $1
          AND sl.shop_id = $2
          AND sl.completed_time IS NOT NULL
          AND p.tenant_id = $6
      `, [mfr, shopId, stFrom, stTo, seasonTag, req.tenantId]);
    } else {
      // $1=mfr $2=stFrom $3=stTo $4='%tag%' $5=tenantId
      // No date filter in WHERE — CASEs handle mode 1 (tag) and mode 2 (tag+period)
      q1Promise = pool.query(`
        SELECT
          COUNT(DISTINCT CASE WHEN p.tags ILIKE $4
                              AND (sl.completed_time AT TIME ZONE 'America/Toronto')::date >= $2::date AND (sl.completed_time AT TIME ZONE 'America/Toronto')::date <= $3::date
                             THEN sl.item_id END)::int AS active_items,
          ROUND(SUM(CASE WHEN sl.completed_time >= now() - INTERVAL '12 weeks'
                         THEN sl.qty ELSE 0 END) / 12.0, 1)::float8   AS weekly_velocity,
          ROUND(SUM(CASE WHEN p.tags ILIKE $4
                         THEN sl.qty ELSE 0 END), 0)::float8           AS units_sold_tag,
          ROUND(SUM(CASE WHEN p.tags ILIKE $4
                         THEN sl.qty * sl.unit_price - COALESCE((sl.raw->>'calcLineDiscount')::numeric, 0) ELSE 0 END), 2)::float8 AS revenue_tag,
          ROUND(SUM(CASE WHEN p.tags ILIKE $4
                          AND (sl.completed_time AT TIME ZONE 'America/Toronto')::date >= $2::date AND (sl.completed_time AT TIME ZONE 'America/Toronto')::date <= $3::date
                         THEN sl.qty ELSE 0 END), 0)::float8           AS units_sold_tag_period,
          ROUND(SUM(CASE WHEN p.tags ILIKE $4
                          AND (sl.completed_time AT TIME ZONE 'America/Toronto')::date >= $2::date AND (sl.completed_time AT TIME ZONE 'America/Toronto')::date <= $3::date
                         THEN sl.qty * sl.unit_price - COALESCE((sl.raw->>'calcLineDiscount')::numeric, 0) ELSE 0 END), 2)::float8 AS revenue_tag_period,
          ROUND(SUM(CASE WHEN sl.completed_time >= now() - INTERVAL '12 weeks' AND p.tags ILIKE $4
                         THEN sl.qty * sl.unit_price - COALESCE((sl.raw->>'calcLineDiscount')::numeric, 0) ELSE 0 END), 2)::float8 AS revenue_12w
        FROM sale_lines sl
        JOIN products p ON p.item_id = sl.item_id
        WHERE p.manufacturer ILIKE $1
          AND sl.completed_time IS NOT NULL
          AND p.tenant_id = $5
      `, [mfr, stFrom, stTo, seasonTag, req.tenantId]);
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
        WHERE p.manufacturer ILIKE $1 AND p.archived = false ${tenantCondP}
      `, p);
    } else if (hasShop) {
      // $1=mfr $2=shopId $3='%tag%' $4=tenantId
      q2Promise = pool.query(`
        SELECT
          COUNT(DISTINCT p.item_id)::int AS total_items,
          ROUND(SUM(COALESCE(i.qty_on_hand,0) + COALESCE(i.qty_on_order,0)), 0)::float8 AS current_stock,
          ROUND(SUM(CASE WHEN p.tags ILIKE $3
                         THEN COALESCE(i.qty_on_hand,0) + COALESCE(i.qty_on_order,0) ELSE 0 END), 0)::float8 AS current_stock_tag,
          ROUND(AVG(CASE WHEN p.default_price > 0 AND p.tags ILIKE $3
                         THEN (p.default_price - p.default_cost) / p.default_price * 100
                         ELSE NULL END), 1)::float8 AS avg_margin_pct
        FROM products p
        LEFT JOIN inventory i ON i.item_id = p.item_id AND i.shop_id = $2
        WHERE p.manufacturer ILIKE $1 AND p.archived = false AND p.tenant_id = $4
      `, [mfr, shopId, seasonTag, req.tenantId]);
    } else {
      // $1=mfr $2='%tag%' $3=tenantId
      q2Promise = pool.query(`
        SELECT
          COUNT(DISTINCT p.item_id)::int AS total_items,
          ROUND(SUM(COALESCE(i.qty_on_hand,0) + COALESCE(i.qty_on_order,0)), 0)::float8 AS current_stock,
          ROUND(SUM(CASE WHEN p.tags ILIKE $2
                         THEN COALESCE(i.qty_on_hand,0) + COALESCE(i.qty_on_order,0) ELSE 0 END), 0)::float8 AS current_stock_tag,
          ROUND(AVG(CASE WHEN p.default_price > 0 AND p.tags ILIKE $2
                         THEN (p.default_price - p.default_cost) / p.default_price * 100
                         ELSE NULL END), 1)::float8 AS avg_margin_pct
        FROM products p
        LEFT JOIN inventory i ON i.item_id = p.item_id AND i.shop_id != '0'
        WHERE p.manufacturer ILIKE $1 AND p.archived = false AND p.tenant_id = $3
      `, [mfr, seasonTag, req.tenantId]);
    }

    const [q1, q2, q3a, q3b, q4, q5, q6, [seasonsConfig, tiers]] = await Promise.all([
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
          ${tenantCondP}
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
          ${tenantCondP}
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
            ${tenantCondP}
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
        JOIN products par ON par.item_id = s.matrix_item_id AND par.archived = false AND par.tenant_id = $${tIdx}
        LEFT JOIN st_matrix sm ON sm.matrix_item_id = s.matrix_item_id
        ORDER BY s.units DESC
        LIMIT 10
      `, p),

      // Q5 — Sales + stock by category.
      // Date scope: last 12 weeks when no season selected; all-time when season active
      // (matches units_sold_tag in Q1 so the totals align).
      // Archived filter: kept only for items_count + stock, not for sales
      // (archived items were still sold — same convention as Q1).
      (() => {
        const p5        = allTime ? p : [...p, seasonTag];
        const tagCondP5 = allTime ? '' : `AND p.tags ILIKE $${p5.length}`;
        const sDateCond = allTime
          ? "sl.completed_time >= now() - INTERVAL '12 weeks' AND sl.completed_time IS NOT NULL"
          : 'sl.completed_time IS NOT NULL';
        return pool.query(`
          WITH s AS (
            SELECT sl.item_id,
                   SUM(sl.qty)                 AS units,
                   SUM(sl.qty * sl.unit_price - COALESCE((sl.raw->>'calcLineDiscount')::numeric, 0)) AS rev
            FROM sale_lines sl
            WHERE ${sDateCond}
              ${slS}
            GROUP BY sl.item_id
          ),
          ${stCTE}
          SELECT
            COALESCE(p.category, 'Sans catégorie')       AS category,
            COUNT(DISTINCT p.item_id) FILTER (WHERE p.archived = false AND (COALESCE(s.units,0) > 0 OR COALESCE(st.stock,0) > 0))::int AS items_count,
            ROUND(SUM(COALESCE(s.units, 0)), 0)::float8  AS units_sold_12w,
            ROUND(SUM(COALESCE(s.rev,   0)), 2)::float8  AS revenue_12w,
            ROUND(SUM(CASE WHEN p.archived = false THEN COALESCE(st.stock,0) ELSE 0 END), 0)::float8 AS stock_units
          FROM products p
          LEFT JOIN s  ON s.item_id  = p.item_id
          LEFT JOIN st ON st.item_id = p.item_id
          WHERE p.manufacturer ILIKE $1
            ${tenantCondP}
            ${tagCondP5}
          GROUP BY p.category
          ORDER BY units_sold_12w DESC NULLS LAST
        `, p5);
      })(),

      q6Promise,
      configPromise,
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

    // ── Second batch: season-specific features ──────────────────────────────
    const todayStr        = today.toISOString().slice(0, 10);
    const receivedSupplier = !allTime ? Math.max(0, soldTag + stockTag + sentOut - receivedIn) : null;
    const seasonConf      = !allTime ? seasonsConfig.find(s => s.code === seasonCode) : null;
    const isActive        = !allTime && !!seasonConf && todayStr <= (seasonConf.sell_to ?? '');

    const prevSeasonConf = !allTime ? (() => {
      const t = seasonCode[0], y = parseInt(seasonCode.slice(1), 10);
      return seasonsConfig.find(s => s.code === `${t}${y - 1}`) ?? null;
    })() : null;

    const histSeasons = !allTime
      ? (() => {
          const t = seasonCode[0], y = parseInt(seasonCode.slice(1), 10);
          return [y - 2, y - 1, y]
            .map(yr => seasonsConfig.find(s => s.code === `${t}${yr}`))
            .filter(Boolean);
        })()
      : [...seasonsConfig].sort((a, b) => b.sell_from.localeCompare(a.sell_from)).slice(0, 3).reverse();

    // Build param objects for season-scoped brand queries.
    // Returns params array + index map + shop conditions.
    const mkSP = (from, to, tag) => {
      if (hasShop) {
        return { params: [mfr, shopId, from, to, tag, req.tenantId],
                 i: { mfr: 1, shop: 2, from: 3, to: 4, tag: 5, tid: 6 },
                 shopSale: 'AND sl.shop_id = $2', shopInv: 'AND inv2.shop_id = $2' };
      }
      return { params: [mfr, from, to, tag, req.tenantId],
               i: { mfr: 1, from: 2, to: 3, tag: 4, tid: 5 },
               shopSale: '', shopInv: '' };
    };

    // Factory: one season's sold + stock + transfers metrics.
    // sold_cte has NO date bounds (mirrors main Q1: all tagged sales ever) so that
    // received_supplier and ST% are identical to the main KPI for the current season.
    // Params: hasShop=[mfr,shopId,tag,tid]  no-shop=[mfr,tag,tid]
    const histQ = (conf) => {
      const hTag = `%${conf.tag_pattern}%`;
      const params    = hasShop ? [mfr, shopId, hTag, req.tenantId] : [mfr, hTag, req.tenantId];
      const [mi, si, ti, di] = hasShop ? [1, 2, 3, 4] : [1, null, 2, 3];
      const shopSale  = hasShop ? `AND sl.shop_id = $${si}` : '';
      const shopInv2  = hasShop ? `AND inv2.shop_id = $${si}` : "AND inv2.shop_id != '0'";

      const transfersCte = hasShop ? `
        transfers_cte AS (
          SELECT
            COALESCE(SUM(CASE WHEN t.to_shop_id   = $${si} THEN t.qty_received ELSE 0 END), 0)::float8 AS received_in,
            COALESCE(SUM(CASE WHEN t.from_shop_id = $${si} THEN t.qty_received ELSE 0 END), 0)::float8 AS sent_out
          FROM transfers t
          JOIN products p ON p.item_id = t.item_id
          WHERE p.manufacturer ILIKE $${mi}
            AND t.transfer_received = true
            AND t.item_id IS NOT NULL
            AND (t.from_shop_id = $${si} OR t.to_shop_id = $${si})
            AND p.tags ILIKE $${ti}
            AND p.tenant_id = $${di}
        )` : `
        transfers_cte AS (SELECT 0::float8 AS received_in, 0::float8 AS sent_out)`;

      return pool.query(`
        WITH
        sold_cte AS (
          SELECT
            COALESCE(SUM(sl.qty), 0)::float8 AS units_sold,
            COALESCE(SUM(sl.qty * sl.unit_price - COALESCE((sl.raw->>'calcLineDiscount')::numeric, 0)), 0)::float8 AS revenue
          FROM sale_lines sl
          JOIN products p ON p.item_id = sl.item_id
          WHERE p.manufacturer ILIKE $${mi}
            AND p.tags ILIKE $${ti}
            AND sl.completed_time IS NOT NULL
            AND p.tenant_id = $${di}
            ${shopSale}
        ),
        stock_cte AS (
          SELECT COALESCE(SUM(COALESCE(inv2.qty_on_hand,0) + COALESCE(inv2.qty_on_order,0)), 0)::float8 AS stock_tag
          FROM products p
          LEFT JOIN inventory inv2 ON inv2.item_id = p.item_id ${shopInv2}
          WHERE p.manufacturer ILIKE $${mi}
            AND p.tags ILIKE $${ti}
            AND p.archived = false
            AND p.tenant_id = $${di}
        ),
        ${transfersCte}
        SELECT s.units_sold, s.revenue, st2.stock_tag, tc.received_in, tc.sent_out
        FROM sold_cte s, stock_cte st2, transfers_cte tc
      `, params);
    };

    // Factory: cumulative weekly sold (for ST chart)
    const wklyQ = (from, to, tag) => {
      const { params, i, shopSale } = mkSP(from, to, tag);
      return pool.query(`
        WITH ws AS (
          SELECT date_trunc('week', sl.completed_time) AS wk,
                 SUM(sl.qty) AS q
          FROM sale_lines sl
          JOIN products p ON p.item_id = sl.item_id
          WHERE p.manufacturer ILIKE $${i.mfr}
            AND p.tags ILIKE $${i.tag}
            AND (sl.completed_time AT TIME ZONE 'America/Toronto')::date >= $${i.from}::date
            AND (sl.completed_time AT TIME ZONE 'America/Toronto')::date <= $${i.to}::date
            AND p.tenant_id = $${i.tid}
            ${shopSale}
          GROUP BY 1
        )
        SELECT wk AS week_start, SUM(q) OVER (ORDER BY wk)::float8 AS cum_sold
        FROM ws ORDER BY wk
      `, params);
    };

    // Assemble second batch
    const batch2 = [];
    const bk     = []; // keys parallel to batch2

    if (!allTime) {
      // NOS breakdown
      const xn = mkSP(stFrom, stTo, seasonTag);
      batch2.push(pool.query(`
        SELECT
          ROUND(SUM(CASE WHEN p.tags ILIKE $${xn.i.tag} THEN sl.qty ELSE 0 END), 0)::int AS collection,
          ROUND(SUM(sl.qty), 0)::int AS total
        FROM sale_lines sl
        JOIN products p ON p.item_id = sl.item_id
        WHERE p.manufacturer ILIKE $${xn.i.mfr}
          AND (sl.completed_time AT TIME ZONE 'America/Toronto')::date >= $${xn.i.from}::date
          AND (sl.completed_time AT TIME ZONE 'America/Toronto')::date <= $${xn.i.to}::date
          AND p.tenant_id = $${xn.i.tid}
          ${xn.shopSale}
      `, xn.params));
      bk.push('nos');

      // Weekly cumulative ST — current season
      batch2.push(wklyQ(stFrom, stTo, seasonTag));
      bk.push('wk_curr');

      // Weekly cumulative ST — previous season
      batch2.push(prevSeasonConf
        ? wklyQ(prevSeasonConf.sell_from, prevSeasonConf.sell_to, `%${prevSeasonConf.tag_pattern}%`)
        : Promise.resolve({ rows: [] }));
      bk.push('wk_prev');

      // Velocity 4 weeks (for projection)
      const veloParams = hasShop ? [mfr, shopId, seasonTag, req.tenantId] : [mfr, seasonTag, req.tenantId];
      const [veloTagIdx, veloTidIdx] = hasShop ? [3, 4] : [2, 3];
      const veloShop = hasShop ? 'AND sl.shop_id = $2' : '';
      batch2.push(isActive ? pool.query(`
        SELECT ROUND(SUM(sl.qty) / 4.0, 1)::float8 AS velo
        FROM sale_lines sl
        JOIN products p ON p.item_id = sl.item_id
        WHERE p.manufacturer ILIKE $1
          AND p.tags ILIKE $${veloTagIdx}
          AND sl.completed_time >= now() - INTERVAL '4 weeks'
          AND sl.completed_time IS NOT NULL
          AND p.tenant_id = $${veloTidIdx}
          ${veloShop}
      `, veloParams) : Promise.resolve({ rows: [{ velo: 0 }] }));
      bk.push('velo4');
    }

    const histStartIdx = batch2.length;
    for (const conf of histSeasons) { batch2.push(histQ(conf)); bk.push(`h_${conf.code}`); }

    const b2 = await Promise.all(batch2);
    const gr  = (key) => b2[bk.indexOf(key)];

    // Compute ventes_nos
    let ventes_nos = null;
    if (!allTime) {
      const rn = gr('nos')?.rows[0];
      const col = parseInt(rn?.collection) || 0;
      const tot = parseInt(rn?.total)      || 0;
      ventes_nos = { collection: col, nos_autres: tot - col, total: tot };
    }

    // Compute weekly_st_cumulative
    let weekly_st_cumulative = null;
    if (!allTime && receivedSupplier > 0) {
      const currRows = gr('wk_curr')?.rows ?? [];
      const prevRows = gr('wk_prev')?.rows ?? [];

      // Received_supplier for prev season (sold_prev + stock_prev)
      let prevReceived = 0;
      if (prevSeasonConf) {
        const phi = histSeasons.findIndex(s => s.code === prevSeasonConf.code);
        if (phi >= 0) {
          const ph = b2[histStartIdx + phi]?.rows[0];
          prevReceived = Math.max(0, (parseFloat(ph?.units_sold) || 0) + (parseFloat(ph?.stock_tag) || 0));
        }
      }

      weekly_st_cumulative = currRows.map((row, idx) => {
        const cumSold = parseFloat(row.cum_sold) || 0;
        const stPct   = Math.round(cumSold / receivedSupplier * 1000) / 10;
        const prow    = prevRows[idx];
        const prevCum = prow ? (parseFloat(prow.cum_sold) || 0) : null;
        const prevPct = (prevCum !== null && prevReceived > 0)
          ? Math.round(prevCum / prevReceived * 1000) / 10 : null;
        return { week_start: row.week_start, st_pct_cumulative: stPct, st_pct_cumulative_prev_season: prevPct };
      });
    }

    // Compute projection
    let projection = null;
    if (!allTime && isActive && seasonConf) {
      const sellToDate    = new Date(seasonConf.sell_to + 'T12:00:00Z');
      const semRestantes  = Math.max(0, (sellToDate - today) / (7 * 24 * 3600 * 1000));
      const velo4         = parseFloat(gr('velo4')?.rows[0]?.velo) || 0;
      const ventesProj    = Math.round(velo4 * semRestantes);
      const stProjeteFrac = receivedSupplier > 0 ? Math.min(1, (soldTag + ventesProj) / receivedSupplier) : null;
      const stProjete     = stProjeteFrac !== null ? Math.round(stProjeteFrac * 1000) / 10 : null;

      const rupture = (velo4 > 0 && stockTag > 0) ? (() => {
        const sem = stockTag / velo4;
        const d   = new Date(today.getTime() + sem * 7 * 24 * 3600 * 1000);
        return { date: d.toISOString().slice(0, 10), semaines: Math.round(sem * 10) / 10 };
      })() : null;

      const tiersResult = stProjeteFrac !== null ? applyMultiplierTiers(stProjeteFrac, tiers) : null;
      const signalMap   = { 'Augmenter': 'augmenter', 'Légère hausse': 'legere_hausse',
                             'Reconduire': 'reconduire', 'Réduire': 'reduire', 'Couper': 'couper' };
      projection = {
        semaines_restantes:    Math.round(semRestantes * 10) / 10,
        velocite_4sem:         Math.round(velo4 * 10) / 10,
        ventes_projetees:      ventesProj,
        st_projete_pct:        stProjete,
        date_rupture_stock:    rupture?.date ?? null,
        semaines_avant_rupture: rupture?.semaines ?? null,
        signal:                tiersResult ? (signalMap[tiersResult.label] ?? 'reconduire') : 'reconduire',
      };
    }

    // Compute historique_saisons — immutable received_supplier formula
    const historique_saisons = histSeasons.map((conf, idx) => {
      const r    = b2[histStartIdx + idx]?.rows[0];
      const sold = parseFloat(r?.units_sold)   || 0;
      const stk  = parseFloat(r?.stock_tag)    || 0;
      const rev  = parseFloat(r?.revenue)      || 0;
      const tin  = parseFloat(r?.received_in)  || 0;
      const tout = parseFloat(r?.sent_out)     || 0;
      const received = Math.max(0, sold + stk + tout - tin);
      return {
        code:           conf.code.toUpperCase(),
        periode:        { de: conf.sell_from, a: conf.sell_to },
        st_pct:         received > 0 ? Math.round(sold / received * 1000) / 10 : null,
        units_received: Math.round(received),
        units_sold:     Math.round(sold),
        revenue:        Math.round(rev),
        en_cours:       conf.sell_to >= todayStr,
      };
    });

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
      weekly_current:       q3a.rows,
      weekly_ly:            q3b.rows,
      top_items:            q4.rows,
      by_category:          q5.rows,
      weekly_st_cumulative,
      projection,
      historique_saisons,
      ventes_nos,
      reconduire_threshold_pct: (() => {
        const t2 = [...tiers].sort((a, b) => b.st_min - a.st_min);
        const reconduire = t2.find(tier => tier.label === 'Reconduire');
        return reconduire ? Math.round(reconduire.st_min * 100) : 50;
      })(),
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/brand/:manufacturer/top-attributes — top sizes & colors (12 weeks)
// ---------------------------------------------------------------------------
// Module-level: warn once per unknown set_id per server lifetime, not once per request.
const _warnedTopAttrSets = new Set();

app.get('/api/brand/:manufacturer/top-attributes', async (req, res, next) => {
  try {
    const mfr      = decodeURIComponent(req.params.manufacturer);
    const shopId   = req.query.shop_id ?? null;
    const tenantId = req.tenantId;

    const params   = [tenantId, mfr];
    let   shopCond = '';
    if (shopId) { params.push(shopId); shopCond = `AND sl.shop_id = $${params.length}`; }

    const { rows } = await pool.query(`
      SELECT
        p.description,
        p.raw->'ItemAttributes'->>'attribute1'         AS attr1,
        p.raw->'ItemAttributes'->>'attribute2'         AS attr2,
        p.raw->'ItemAttributes'->>'attribute3'         AS attr3,
        p.raw->'ItemAttributes'->>'itemAttributeSetID' AS set_id,
        ias.size_axis,
        ias.color_axis,
        SUM(sl.qty)::int AS units
      FROM   sale_lines sl
      JOIN   products   p   ON p.item_id = sl.item_id AND p.tenant_id = sl.tenant_id
      LEFT JOIN item_attribute_sets ias
        ON  ias.attribute_set_id = (p.raw->'ItemAttributes'->>'itemAttributeSetID')
        AND ias.tenant_id = p.tenant_id
      WHERE  sl.tenant_id = $1
        AND  p.manufacturer ILIKE $2
        AND  sl.completed_time > now() - interval '12 weeks'
        AND  p.matrix_id IS NOT NULL
        ${shopCond}
      GROUP  BY
        p.description,
        p.raw->'ItemAttributes'->>'attribute1',
        p.raw->'ItemAttributes'->>'attribute2',
        p.raw->'ItemAttributes'->>'attribute3',
        p.raw->'ItemAttributes'->>'itemAttributeSetID',
        ias.size_axis,
        ias.color_axis
      HAVING SUM(sl.qty) > 0
    `, params);

    function extractSizeColor(desc) {
      if (!desc) return { size: null, color: null };

      // Alpha sizes (longest alternatives first to avoid XL matching L)
      const alphaRe = /(?:^| )(XXXL|XXL|XL|XS|L|M|S)(?= |$)/i;
      // Numeric sizes: standalone 2-digit number 26-69 not surrounded by digits/dash/slash
      const numRe   = /(?:^| )([2-6][0-9])(?= |$)/;

      let size = null, sizePos = -1, sizeLen = 0;

      const aM = desc.match(alphaRe);
      const nM = desc.match(numRe);
      if (aM) {
        size    = aM[1].toUpperCase();
        sizePos = aM.index + (aM[0][0] === ' ' ? 1 : 0);
        sizeLen = aM[1].length;
      } else if (nM) {
        size    = nM[1];
        sizePos = nM.index + (nM[0][0] === ' ' ? 1 : 0);
        sizeLen = 2;
      }

      let color = null;
      if (size !== null) {
        const after = desc.slice(sizePos + sizeLen).trim();
        if (after && /[A-Za-zÀ-ÿ]/.test(after)) {
          color = after.toUpperCase();
        } else {
          // Look before the size: take last pure-alpha word (not a number code)
          const before = desc.slice(0, sizePos).trim().split(/\s+/);
          for (let i = before.length - 1; i >= 0; i--) {
            const w = before[i];
            if (/^[A-Za-zÀ-ÿé][A-Za-zÀ-ÿé\-']*$/.test(w) && w.length > 1) {
              color = w.toUpperCase(); break;
            }
          }
        }
      }
      return { size, color };
    }

    // Map extracted color strings to canonical color families.
    // Split on spaces/dashes first so "BLEU-26" → words ["BLEU","26"].
    // Priority order matters: MARINE checked before BLEU.
    function normalizeColor(color) {
      if (!color) return null;
      const words = color.toUpperCase().split(/[\s\-_,/]+/).filter(Boolean);
      const has  = (...kws) => kws.some(k => words.includes(k));
      const hasP = (...kws) => kws.some(k => words.some(w => w.startsWith(k)));
      if (hasP('MARINE', 'NAVY'))                                                              return 'Marine';
      if (hasP('BLEU', 'BLUE', 'COBALT', 'INDIGO', 'DENIM', 'AZUR', 'TURQUOISE', 'CYAN'))    return 'Bleu';
      if (hasP('NOIR', 'BLACK', 'EBENE', 'EBÈNE', 'ANTHRACIT', 'CARBONE'))                    return 'Noir';
      if (hasP('GRIS', 'GREY', 'GRAY', 'PERLE', 'ARGENT', 'PLATINE'))                         return 'Gris';
      if (hasP('BLANC', 'WHITE', 'CREME', 'CRÈME', 'ECRU', 'ÉCRU', 'IVOIRE', 'NATUREL'))      return 'Blanc/Crème';
      if (hasP('ROUGE', 'RED', 'BORDEAUX', 'BOURGOGNE', 'FRAMBOISE', 'GRENAT', 'CERISE', 'CARMIN', 'CRAMOISI')) return 'Rouge';
      if (hasP('VERT', 'GREEN', 'KAKI', 'OLIVE', 'SAUGE', 'MENTHE', 'MILITAIRE', 'EMERAUDE', 'ÉMERAUDE', 'BOUTEILLE')) return 'Vert';
      if (hasP('BRUN', 'MARRON', 'BROWN', 'CAMEL', 'CARAMEL', 'NOISETTE', 'CHOCOLAT', 'COGNAC', 'TABAC', 'FAUVE', 'CANNELLE')) return 'Brun/Camel';
      if (hasP('BEIGE', 'SABLE', 'TAUPE', 'NUDE', 'MASTIC', 'PIERRE') || has('LIN'))          return 'Beige';
      if (hasP('CORAIL', 'ORANGE', 'ROUILLE', 'BRIQUE', 'TERRA', 'SAUMON', 'PECHE', 'PÊCHE', 'ABRICOT', 'MANDARINE')) return 'Orange/Corail';
      if (hasP('ROSE', 'PINK', 'FUSCHIA', 'FUCHSIA', 'FRAISE'))                               return 'Rose';
      if (hasP('VIOLET', 'MAUVE', 'PRUNE', 'AUBERGINE', 'LAVANDE', 'LILAS', 'PARME'))         return 'Violet';
      if (hasP('JAUNE', 'YELLOW', 'CURRY', 'MOUTARDE', 'CITRON', 'DORE', 'DORÉ', 'SAFRAN', 'OCRE') || has('OR')) return 'Jaune';
      // Unknown: normalize capitalization
      return color.charAt(0).toUpperCase() + color.slice(1).toLowerCase();
    }

    // size_axis/color_axis = source of truth (1/2/3 = which attribute holds size/color).
    // Set at sync time via auto-detection; overrideable via PATCH /api/admin/attribute-sets/:id.
    // Falls back to regex only when no axis is configured for this set.
    function pickSizeColor(row) {
      const { size_axis, color_axis, attr1, attr2, attr3, set_id } = row;
      const byAxis = [null, attr1, attr2, attr3]; // 1-indexed

      if (size_axis || color_axis) {
        let size  = size_axis  ? (byAxis[size_axis]  ?? null) : null;
        let color = color_axis ? (byAxis[color_axis] ?? null) : null;
        if (size  === '') size  = null;
        if (color === '') color = null;
        if (size  && /taille\s+unique|one\s+size/i.test(size))  size  = 'Unique';
        if (color && /taille\s+unique|one\s+size/i.test(color)) color = 'Unique';
        return { size, color };
      }
      if (set_id && !_warnedTopAttrSets.has(set_id)) {
        _warnedTopAttrSets.add(set_id);
        console.warn(`[top-attributes] WARNING: attribute-set ${set_id} has no size_axis — regex fallback. Use PATCH /api/admin/attribute-sets/${set_id} to configure.`);
      }
      return extractSizeColor(row.description);
    }

    const sizeTotals  = {};
    const colorTotals = {};
    for (const r of rows) {
      const { size, color } = pickSizeColor(r);
      const normColor = normalizeColor(color);
      if (size)      sizeTotals[size]      = (sizeTotals[size]      || 0) + r.units;
      if (normColor) colorTotals[normColor] = (colorTotals[normColor] || 0) + r.units;
    }

    const rank = obj => Object.entries(obj)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([value, units]) => ({ value, units }));

    res.json({ top_sizes: rank(sizeTotals), top_colors: rank(colorTotals) });
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
    const p        = hasShop ? [matrixId, shopId, req.tenantId] : [matrixId, req.tenantId];
    const tIdx     = p.length;

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
        SELECT i.item_id, SUM(COALESCE(i.qty_on_hand,0) + COALESCE(i.qty_on_order,0)) AS stock
        FROM inventory i
        JOIN shops sh ON sh.shop_id = i.shop_id AND sh.tenant_id = $${tIdx}
        WHERE 1=1 ${hasShop ? 'AND i.shop_id = $2' : ''}
        GROUP BY i.item_id
      ),
      mname AS (
        SELECT NULLIF(regexp_replace(
          MIN(CASE WHEN matrix_id IS NOT NULL AND matrix_id != item_id
                   THEN description END),
          '\\s+(\\d{2,3}|XXS|XS|XL|XXL|XXXL|S|M|L|TU|OS|UNI)(\\s.*)?$',
          '', 'i'), '') AS name
        FROM products
        WHERE (item_id = $1 OR matrix_id = $1) AND archived = false AND tenant_id = $${tIdx}
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
        AND v.tenant_id = $${tIdx}
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
function velocityCTEs(seasonFrom, seasonTo, shopCondSL, shopCondInv, tagParam, tenantCond = '', shopJoin = '') {
  return `
    season_items AS (
      SELECT item_id, manufacturer, category, default_price, default_cost,
             COALESCE(matrix_id, item_id) AS matrix_key
      FROM products
      WHERE tags ILIKE ${tagParam}
        AND archived = false
        AND default_cost > 0
        ${tenantCond}
        AND category NOT ILIKE 'Alt%ration%'
        AND description NOT ILIKE '%shopify%'
    ),
    season_lines AS (
      SELECT
        sl.item_id,
        sl.completed_time,
        GREATEST(1, CEIL(((sl.completed_time AT TIME ZONE 'America/Toronto')::date - '${seasonFrom}'::date + 1) / 7.0))::int AS wk,
        sl.qty,
        CASE WHEN sl.qty > 0
              AND si.default_price > 0
              AND (sl.unit_price * sl.qty - COALESCE((sl.raw->>'calcLineDiscount')::numeric, 0))
                  >= si.default_price * sl.qty * 0.90
             THEN sl.qty ELSE 0 END AS qty_fp,
        CASE WHEN sl.qty > 0 THEN sl.qty ELSE 0 END AS qty_gross
      FROM sale_lines sl
      JOIN season_items si ON si.item_id = sl.item_id
      WHERE (sl.completed_time AT TIME ZONE 'America/Toronto')::date >= '${seasonFrom}'::date
        AND (sl.completed_time AT TIME ZONE 'America/Toronto')::date <= LEAST('${seasonTo}'::date, CURRENT_DATE)
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
      SELECT i.item_id,
             SUM(COALESCE(i.qty_on_hand, 0) + COALESCE(i.qty_on_order, 0)) AS stock
      FROM inventory i
      ${shopJoin}
      WHERE 1=1 ${shopCondInv.replace('AND shop_id', 'AND i.shop_id')}
      GROUP BY i.item_id
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

    const safeTenantId = (req.tenantId ?? '').replace(/[^a-zA-Z0-9_-]/g, '');
    const tenantCond = safeTenantId ? `AND tenant_id = '${safeTenantId}'` : '';
    const shopJoin   = hasShop ? '' : (safeTenantId ? `JOIN shops sh ON sh.shop_id = i.shop_id AND sh.tenant_id = '${safeTenantId}'` : `JOIN shops sh ON sh.shop_id = i.shop_id`);

    const { rows } = await pool.query(`
      WITH ${velocityCTEs(season.from, season.to, shopCondSL, shopCondInv, "'%" + seasonCode + "%'", tenantCond, shopJoin)}
      SELECT
        manufacturer,
        COUNT(DISTINCT item_id)::int                                            AS items_count,
        ROUND(SUM(initial_stock)::numeric, 0)::float8                          AS initial_stock,
        ROUND(SUM(u_total)::numeric, 0)::float8                               AS units_sold,
        ROUND(SUM(current_stock)::numeric, 0)::float8                         AS current_stock,
        ROUND((SUM(u_s4)   / NULLIF(SUM(initial_stock), 0))::numeric, 3)::float8 AS st_s4,
        ROUND((SUM(u_s7)   / NULLIF(SUM(initial_stock), 0))::numeric, 3)::float8 AS st_s7,
        ROUND((SUM(u_s10)  / NULLIF(SUM(initial_stock), 0))::numeric, 3)::float8 AS st_s10,
        ROUND((SUM(u_s14)  / NULLIF(SUM(initial_stock), 0))::numeric, 3)::float8 AS st_s14,
        ROUND((SUM(u_total)/ NULLIF(SUM(initial_stock), 0))::numeric, 3)::float8 AS st_final,
        ROUND((SUM(u_fp)   / NULLIF(SUM(u_gross), 0))::numeric, 3)::float8   AS fp_pct
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

    const safeTenantId = (req.tenantId ?? '').replace(/[^a-zA-Z0-9_-]/g, '');
    const tenantCond = safeTenantId ? `AND tenant_id = '${safeTenantId}'` : '';
    const shopJoin   = hasShop ? '' : (safeTenantId ? `JOIN shops sh ON sh.shop_id = i.shop_id AND sh.tenant_id = '${safeTenantId}'` : `JOIN shops sh ON sh.shop_id = i.shop_id`);

    const { rows } = await pool.query(`
      WITH ${velocityCTEs(season.from, season.to, shopCondSL, shopCondInv, "'%" + seasonCode + "%'", tenantCond, shopJoin)}
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
        ROUND(SUM(f.initial_stock)::numeric, 0)::float8                         AS initial_stock,
        ROUND(SUM(f.u_total)::numeric, 0)::float8                              AS units_sold,
        ROUND(SUM(f.current_stock)::numeric, 0)::float8                        AS current_stock,
        ROUND((SUM(f.u_s4)   / NULLIF(SUM(f.initial_stock), 0))::numeric, 3)::float8 AS st_s4,
        ROUND((SUM(f.u_s7)   / NULLIF(SUM(f.initial_stock), 0))::numeric, 3)::float8 AS st_s7,
        ROUND((SUM(f.u_s10)  / NULLIF(SUM(f.initial_stock), 0))::numeric, 3)::float8 AS st_s10,
        ROUND((SUM(f.u_s14)  / NULLIF(SUM(f.initial_stock), 0))::numeric, 3)::float8 AS st_s14,
        ROUND((SUM(f.u_total)/ NULLIF(SUM(f.initial_stock), 0))::numeric, 3)::float8 AS st_final,
        ROUND((SUM(f.u_fp)   / NULLIF(SUM(f.u_gross), 0))::numeric, 3)::float8 AS fp_pct,
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
      `SELECT item_id FROM products WHERE (item_id = $1 OR matrix_id = $1) AND archived = false AND tenant_id = $2`,
      [matrixId, req.tenantId]
    );
    const itemIds = matrixItems.map(r => r.item_id);
    if (!itemIds.length) return res.json({ articles: [], season_code: seasonCode, weeks_elapsed: weeksElapsed });

    // Build IN list safely using ANY
    const { rows } = await pool.query(`
      WITH season_lines AS (
        SELECT
          sl.item_id,
          sl.completed_time,
          GREATEST(1, CEIL(((sl.completed_time AT TIME ZONE 'America/Toronto')::date - '${season.from}'::date + 1) / 7.0))::int AS wk,
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
          AND (sl.completed_time AT TIME ZONE 'America/Toronto')::date >= '${season.from}'::date
          AND (sl.completed_time AT TIME ZONE 'America/Toronto')::date <= LEAST('${season.to}'::date, CURRENT_DATE)
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
        SELECT i.item_id, SUM(COALESCE(i.qty_on_hand, 0) + COALESCE(i.qty_on_order, 0)) AS stock
        FROM inventory i
        JOIN shops sh ON sh.shop_id = i.shop_id AND sh.tenant_id = $2
        WHERE i.item_id = ANY($1) ${shopCondInv.replace('AND shop_id', 'AND i.shop_id')}
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
        ROUND((COALESCE(ia.u_total,0) / NULLIF(COALESCE(ia.u_total,0)+COALESCE(cs.stock,0),0))::numeric,3)::float8 AS st_final,
        ROUND((COALESCE(ia.u_fp,0) / NULLIF(COALESCE(ia.u_gross,0),0))::numeric,3)::float8 AS fp_pct,
        CASE WHEN COALESCE(cs.stock,0) = 0 THEN ia.last_sale_dt END           AS sellout_date,
        CASE WHEN COALESCE(cs.stock,0) = 0 AND ia.last_sale_dt IS NOT NULL
             THEN GREATEST(1, CEIL((ia.last_sale_dt::date - '${season.from}'::date + 1) / 7.0))::int
        END                                                                     AS sellout_week
      FROM products p
      LEFT JOIN item_agg ia    ON ia.item_id = p.item_id
      LEFT JOIN current_stk cs ON cs.item_id = p.item_id
      WHERE p.item_id = ANY($1)
        AND p.tenant_id = $2
      ORDER BY COALESCE(ia.u_total,0) DESC NULLS LAST, p.description
    `, [itemIds, req.tenantId]);

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
// GET /api/help — app section guide (used by UI + AI)
app.get('/api/help', requireAuth, (req, res) => {
  const lang = (req.query.lang === 'en') ? 'en' : 'fr';
  res.json(HELP[lang] ?? HELP.fr);
});

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
// Strips base64 image/document data from message content arrays before saving
// to the conversations table (a 5MB PDF encoded is ~7MB JSON — would bloat DB).
// Replaces attachments with a small text marker so the conversation history
// still reads meaningfully. Preserves everything else.
function sanitizeMessagesForDb(messages) {
  return messages.map(m => {
    if (!Array.isArray(m.content)) return m;
    const parts = [];
    let attachmentNote = '';
    for (const block of m.content) {
      if (block?.type === 'text') parts.push(block.text || '');
      else if (block?.type === 'image')    attachmentNote = ' [Image jointe]';
      else if (block?.type === 'document') attachmentNote = ' [Document PDF joint]';
      // tool_result / tool_use blocks stay as-is if array is other kind — skip in this path
    }
    const textJoined = parts.join(' ').trim();
    const content_preview = (textJoined + attachmentNote).slice(0, 200);
    return { ...m, content: textJoined + attachmentNote, content_preview };
  });
}

// Middleware that accepts EITHER multipart/form-data (with attachment) OR JSON body.
// Multer's .single() is a no-op when Content-Type is application/json.
app.post('/api/ai/chat', chatUpload.single('attachment'), async (req, res, next) => {
  try {
    if (!process.env.MISTRAL_API_KEY && !process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({
        error: 'Agent IA non configuré. Ajouter MISTRAL_API_KEY (ou OPENAI_API_KEY / ANTHROPIC_API_KEY) dans les variables d\'environnement.',
      });
    }
    // In multipart mode, messages + pageContext arrive as JSON strings in req.body
    let { messages, pageContext } = req.body;
    if (typeof messages === 'string')     { try { messages = JSON.parse(messages); } catch { messages = null; } }
    if (typeof pageContext === 'string')  { try { pageContext = JSON.parse(pageContext); } catch { pageContext = null; } }
    if (!Array.isArray(messages) || !messages.length) {
      return res.status(400).json({ error: 'messages array required' });
    }

    // If a file is attached, inject it as a content block on the last user message.
    // Anthropic multi-part format: content = [ { type: 'text', text }, { type: 'image'|'document', source: {...} } ].
    if (req.file) {
      if (process.env.AI_PROVIDER !== 'anthropic') {
        return res.status(400).json({
          error: 'attachments_require_anthropic',
          message: 'Les pièces jointes ne sont supportées que par Claude (AI_PROVIDER=anthropic).',
        });
      }
      const isPdf = req.file.mimetype === 'application/pdf';
      const base64 = req.file.buffer.toString('base64');
      const block = {
        type: isPdf ? 'document' : 'image',
        source: { type: 'base64', media_type: req.file.mimetype, data: base64 },
      };
      // Locate the last user message and convert its content to a multi-part array
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
          const text = typeof messages[i].content === 'string' ? messages[i].content : '';
          messages[i] = {
            role: 'user',
            content: [ { type: 'text', text: text || 'Analyse ce document.' }, block ],
            _attachment_meta: { filename: req.file.originalname, size: req.file.size, mimetype: req.file.mimetype },
          };
          break;
        }
      }
    }
    const [tenantConfig, seasons, shopsResult] = await Promise.all([
      getTenantConfig(req.tenantId),
      getSeasonsConfig(req.tenantId),
      pool.query('SELECT shop_id, name FROM shops WHERE tenant_id = $1 ORDER BY name', [req.tenantId]),
    ]);
    const ctx = {
      pool,
      budgetCache,
      getSeasonsConfig: () => Promise.resolve(seasons),
      tenantConfig,
      tenantId: req.tenantId,
      shops: shopsResult.rows,
      seasons,
      pageContext: pageContext && typeof pageContext === 'object' ? pageContext : null,
    };
    const wantsStream = (req.headers.accept ?? '').includes('text/event-stream');

    if (wantsStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

      try {
        await runAgentLoopStream(messages, ctx, (event) => {
          send(event);
          if (event.type === 'done') {
            const sanitized = sanitizeMessagesForDb(event.messages ?? []);
            const userMsgs = sanitized.filter(m => m.role === 'user');
            if (userMsgs.length) {
              const lastUser = userMsgs[userMsgs.length - 1];
              const previewText = typeof lastUser.content === 'string' ? lastUser.content : (lastUser.content_preview || '');
              const preview = String(previewText).slice(0, 120);
              pool.query(
                `INSERT INTO conversations(tenant_id, preview, messages) VALUES($1, $2, $3::jsonb)`,
                [req.tenantId, preview, JSON.stringify(sanitized)]
              ).catch(() => {});
            }
          }
        });
      } catch (err) {
        console.error('[SSE error]', err);
        send({ type: 'error', message: err.message || 'Erreur interne du serveur.' });
        send({ type: 'done', messages });
      }

      res.end();
    } else {
      const result = await runAgentLoop(messages, ctx);
      const sanitized = sanitizeMessagesForDb(result.messages ?? []);
      const userMsgs = sanitized.filter(m => m.role === 'user');
      if (userMsgs.length) {
        const lastUser = userMsgs[userMsgs.length - 1];
        const previewText = typeof lastUser.content === 'string' ? lastUser.content : (lastUser.content_preview || '');
        const preview = String(previewText).slice(0, 120);
        pool.query(
          `INSERT INTO conversations(tenant_id, preview, messages) VALUES($1, $2, $3::jsonb)`,
          [req.tenantId, preview, JSON.stringify(sanitized)]
        ).catch(() => {});
      }

      res.json(result);
    }
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
      `SELECT id, created_at, preview FROM conversations WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [req.tenantId, limit]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

app.get('/api/conversations/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, created_at, preview, messages FROM conversations WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, req.tenantId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Conversation introuvable' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

app.delete('/api/conversations/:id', async (req, res, next) => {
  try {
    await pool.query(`DELETE FROM conversations WHERE id = $1 AND tenant_id = $2`, [req.params.id, req.tenantId]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/inventory-history — snapshot agrégé à une date donnée
// Without shop_id: breakdown par boutique
// With shop_id only: breakdown par marque dans cette boutique
// With both: totaux seulement
// ---------------------------------------------------------------------------
app.get('/api/inventory-history', async (req, res, next) => {
  try {
    const { date, shop_id, manufacturer } = req.query;
    if (!date) return res.status(400).json({ error: 'Paramètre date requis (YYYY-MM-DD)' });

    const { rows: meta } = await pool.query(
      `SELECT MIN(snapshot_date)::text AS first_date, MAX(snapshot_date)::text AS last_date
       FROM inventory_snapshots WHERE tenant_id = $1`,
      [req.tenantId],
    );
    const firstDate = meta[0]?.first_date ?? null;
    if (!firstDate) {
      return res.status(404).json({ error: 'Aucun snapshot disponible. Le premier snapshot sera capturé lors du prochain sync.' });
    }
    if (date < firstDate) {
      return res.status(404).json({ error: `Aucun snapshot avant le ${firstDate}.`, first_date: firstDate });
    }

    const { rows: dateCheck } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM inventory_snapshots WHERE tenant_id = $1 AND snapshot_date = $2`,
      [req.tenantId, date],
    );
    if (!dateCheck[0].n) {
      return res.status(404).json({ error: `Aucun snapshot pour le ${date}.`, first_date: firstDate, last_date: meta[0].last_date });
    }

    const params = [req.tenantId, date];
    const shopCond = shop_id ? `AND s.shop_id = $${params.push(shop_id)}` : '';
    const mfrCond  = manufacturer ? `AND p.manufacturer ILIKE $${params.push('%' + manufacturer + '%')}` : '';

    // Aggregation dimension: by boutique (no shop), by marque (shop given), or totals only (both given)
    let selectDim, groupDim;
    if (!shop_id) {
      selectDim = `COALESCE(sh.name, s.shop_id::text) AS dimension, s.shop_id::text AS dim_id`;
      groupDim  = `COALESCE(sh.name, s.shop_id::text), s.shop_id`;
    } else if (!manufacturer) {
      selectDim = `COALESCE(p.manufacturer, 'Sans marque') AS dimension, NULL::text AS dim_id`;
      groupDim  = `COALESCE(p.manufacturer, 'Sans marque')`;
    } else {
      selectDim = `'total' AS dimension, NULL::text AS dim_id`;
      groupDim  = null; // single aggregate row — no GROUP BY needed
    }

    const { rows: breakdown } = await pool.query(`
      SELECT
        ${selectDim},
        SUM(s.qty)::int                                         AS units,
        ROUND(SUM(s.qty * COALESCE(s.unit_cost,0))::numeric,2) AS cost_value,
        ROUND(SUM(s.qty * COALESCE(s.unit_price,0))::numeric,2) AS retail_value
      FROM inventory_snapshots s
      JOIN products p ON p.item_id = s.item_id AND p.tenant_id = s.tenant_id
      LEFT JOIN shops sh ON sh.shop_id = s.shop_id AND sh.tenant_id = s.tenant_id
      WHERE s.tenant_id = $1 AND s.snapshot_date = $2
        ${shopCond} ${mfrCond}
      ${groupDim ? `GROUP BY ${groupDim}` : ''}
      ORDER BY units DESC
    `, params);

    const totals = breakdown.reduce((acc, r) => ({
      units:        (acc.units        ?? 0) + r.units,
      cost_value:   (acc.cost_value   ?? 0) + parseFloat(r.cost_value),
      retail_value: (acc.retail_value ?? 0) + parseFloat(r.retail_value),
    }), {});

    res.json({
      date,
      first_date:   firstDate,
      last_date:    meta[0].last_date,
      filter:       { shop_id: shop_id ?? null, manufacturer: manufacturer ?? null },
      totals:       { units: totals.units ?? 0, cost_value: Math.round((totals.cost_value ?? 0) * 100) / 100, retail_value: Math.round((totals.retail_value ?? 0) * 100) / 100 },
      breakdown,
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/inventory-history/timeline — série temporelle pour graphique
// granularity: day (défaut) | month
// ---------------------------------------------------------------------------
app.get('/api/inventory-history/timeline', async (req, res, next) => {
  try {
    const { from, to, shop_id, manufacturer, granularity = 'day' } = req.query;

    const { rows: meta } = await pool.query(
      `SELECT MIN(snapshot_date)::text AS first_date, MAX(snapshot_date)::text AS last_date
       FROM inventory_snapshots WHERE tenant_id = $1`,
      [req.tenantId],
    );
    const firstDate = meta[0]?.first_date ?? null;
    if (!firstDate) {
      return res.status(404).json({ error: 'Aucun snapshot disponible.', first_date: null });
    }

    const rangeFrom = from && from >= firstDate ? from : firstDate;
    const rangeTo   = to ?? meta[0].last_date;

    if (rangeFrom < firstDate) {
      return res.status(404).json({ error: `Aucun snapshot avant le ${firstDate}.`, first_date: firstDate });
    }

    const params = [req.tenantId, rangeFrom, rangeTo];
    const shopCond = shop_id      ? `AND s.shop_id = $${params.push(shop_id)}` : '';
    const mfrCond  = manufacturer ? `AND p.manufacturer ILIKE $${params.push('%' + manufacturer + '%')}` : '';

    // For monthly granularity: first sum per day, then average across days in the month.
    // Direct AVG(qty) across rows would yield avg units-per-reference (~1.1), not total stock.
    const { rows: series } = await pool.query(granularity === 'month' ? `
      SELECT
        date_trunc('month', day_date)::date                       AS date,
        ROUND(AVG(day_units))::int                                AS units,
        ROUND(AVG(day_cost)::numeric, 2)                          AS cost_value,
        ROUND(AVG(day_retail)::numeric, 2)                        AS retail_value
      FROM (
        SELECT
          s.snapshot_date                                         AS day_date,
          SUM(s.qty)::float8                                      AS day_units,
          SUM(s.qty * COALESCE(s.unit_cost,0))::float8            AS day_cost,
          SUM(s.qty * COALESCE(s.unit_price,0))::float8           AS day_retail
        FROM inventory_snapshots s
        JOIN products p ON p.item_id = s.item_id AND p.tenant_id = s.tenant_id
        WHERE s.tenant_id = $1
          AND s.snapshot_date BETWEEN $2::date AND $3::date
          ${shopCond} ${mfrCond}
        GROUP BY s.snapshot_date
      ) daily
      GROUP BY date_trunc('month', day_date)::date
      ORDER BY 1
    ` : `
      SELECT
        s.snapshot_date                                            AS date,
        SUM(s.qty)::int                                           AS units,
        ROUND(SUM(s.qty * COALESCE(s.unit_cost,0))::numeric,2)   AS cost_value,
        ROUND(SUM(s.qty * COALESCE(s.unit_price,0))::numeric,2)  AS retail_value
      FROM inventory_snapshots s
      JOIN products p ON p.item_id = s.item_id AND p.tenant_id = s.tenant_id
      WHERE s.tenant_id = $1
        AND s.snapshot_date BETWEEN $2::date AND $3::date
        ${shopCond} ${mfrCond}
      GROUP BY s.snapshot_date
      ORDER BY 1
    `, params);

    res.json({ first_date: firstDate, last_date: meta[0].last_date, from: rangeFrom, to: rangeTo, granularity, series });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET  /api/accounting/brands          — payment terms analysis per brand
// PUT  /api/accounting/brands/:mfr     — save terms for a brand
// GET  /api/settings/cost-of-capital   — global cost of capital %
// PUT  /api/settings/cost-of-capital   — save cost of capital
// ---------------------------------------------------------------------------
app.get('/api/accounting/brands', requireAuth, async (req, res, next) => {
  try {
    const tid = req.tenantId;

    const { rows: capRow } = await pool.query(
      `SELECT value FROM app_settings WHERE tenant_id = $1 AND key = 'cost_of_capital'`,
      [tid],
    );
    const costOfCapital = capRow[0] ? Number(capRow[0].value) : 8.0;

    const { rows } = await pool.query(`
      WITH
      brand_sales AS (
        SELECT
          p.manufacturer,
          SUM(sl.qty)                                        AS units_365,
          SUM(sl.qty * COALESCE(p.default_cost,  0))        AS cost_365,
          SUM(sl.qty * COALESCE(p.default_price, 0))        AS retail_365
        FROM sale_lines sl
        JOIN products p ON p.item_id = sl.item_id AND p.tenant_id = sl.tenant_id
        WHERE sl.tenant_id = $1
          AND sl.completed_time > now() - interval '365 days'
          AND p.manufacturer IS NOT NULL AND p.manufacturer != ''
          AND p.stub_inferred_fields IS NULL
        GROUP BY p.manufacturer
      ),
      brand_velocity AS (
        SELECT
          p.manufacturer,
          SUM(sl.qty)::float / 90 AS daily_units
        FROM sale_lines sl
        JOIN products p ON p.item_id = sl.item_id AND p.tenant_id = sl.tenant_id
        WHERE sl.tenant_id = $1
          AND sl.completed_time > now() - interval '90 days'
          AND p.manufacturer IS NOT NULL AND p.manufacturer != ''
          AND p.stub_inferred_fields IS NULL
        GROUP BY p.manufacturer
      ),
      brand_stock AS (
        SELECT
          p.manufacturer,
          SUM(i.qty_on_hand) AS stock_units
        FROM inventory i
        JOIN shops sh ON sh.shop_id = i.shop_id AND sh.tenant_id = i.tenant_id
        JOIN products p ON p.item_id = i.item_id AND p.tenant_id = i.tenant_id
        WHERE i.tenant_id = $1
          AND i.qty_on_hand > 0
          AND p.manufacturer IS NOT NULL AND p.manufacturer != ''
          AND p.archived = false
        GROUP BY p.manufacturer
      ),
      brand_terms AS (
        SELECT manufacturer, discount_pct, discount_days, net_days, margin_override_pct, notes
        FROM brand_payment_terms WHERE tenant_id = $1
      )
      SELECT
        bs.manufacturer,
        bs.units_365,
        ROUND(bs.cost_365::numeric,   2)  AS cost_365,
        ROUND(bs.retail_365::numeric, 2)  AS retail_365,
        CASE WHEN bs.retail_365 > 0
          THEN ROUND(((bs.retail_365 - bs.cost_365) / bs.retail_365 * 100)::numeric, 1)
          ELSE NULL END                   AS margin_pct,
        bv.daily_units,
        COALESCE(bst.stock_units, 0)      AS stock_units,
        CASE WHEN bv.daily_units > 0 AND bst.stock_units > 0
          THEN ROUND(bst.stock_units / bv.daily_units)
          ELSE NULL END                   AS velocity_days,
        bt.discount_pct,
        bt.discount_days,
        bt.net_days,
        bt.margin_override_pct,
        bt.notes
      FROM brand_sales bs
      LEFT JOIN brand_velocity bv  ON bv.manufacturer  = bs.manufacturer
      LEFT JOIN brand_stock    bst ON bst.manufacturer = bs.manufacturer
      LEFT JOIN brand_terms    bt  ON bt.manufacturer  = bs.manufacturer
      ORDER BY bs.cost_365 DESC
    `, [tid]);

    const brands = rows.map(r => {
      const disc    = r.discount_pct   != null ? Number(r.discount_pct)   : null;
      const ddays   = r.discount_days  != null ? Number(r.discount_days)  : null;
      const ndays   = r.net_days       != null ? Number(r.net_days)       : null;
      const margin  = r.margin_override_pct != null
        ? Number(r.margin_override_pct)
        : (r.margin_pct != null ? Number(r.margin_pct) : null);
      const vel     = r.velocity_days != null ? Number(r.velocity_days) : null;
      const cost365 = Number(r.cost_365);

      let annualizedYield = null;
      if (disc != null && ddays != null && ndays != null && ndays > ddays) {
        annualizedYield = Math.round(
          (disc / (1 - disc / 100)) * (365 / (ndays - ddays)) * 10
        ) / 10;
      }

      let recommendation, flag = null;
      if (ndays == null) {
        recommendation = 'terms_missing';
      } else if (disc == null) {
        recommendation = 'full_term';  // terms known but no discount offered
      } else if (annualizedYield > costOfCapital) {
        recommendation = 'take_discount';
        if (vel != null && ndays != null && vel > ndays) {
          flag = `⚠ stock lent (${vel}j) — l'escompte sort le cash ${vel - ndays}j avant la vente`;
        }
      } else {
        recommendation = 'full_term';
      }

      const annualSavings = (disc != null && cost365 > 0)
        ? Math.round(cost365 * disc / 100)
        : 0;

      return {
        manufacturer:        r.manufacturer,
        units_365:           Number(r.units_365),
        cost_365:            cost365,
        retail_365:          Number(r.retail_365),
        margin_pct:          r.margin_pct != null ? Number(r.margin_pct) : null,
        margin_override_pct: r.margin_override_pct != null ? Number(r.margin_override_pct) : null,
        effective_margin:    margin,
        stock_units:         Number(r.stock_units),
        velocity_days:       vel,
        discount_pct:        disc,
        discount_days:       ddays,
        net_days:            ndays,
        notes:               r.notes ?? null,
        annualized_yield:    annualizedYield,
        financing_delay:     (ndays != null && vel != null) ? ndays - vel : null,
        recommendation,
        flag,
        annual_savings:      annualSavings,
      };
    });

    res.json({ cost_of_capital: costOfCapital, brands });
  } catch (err) { next(err); }
});

app.put('/api/accounting/brands/:manufacturer', requireAuth, async (req, res, next) => {
  try {
    const mfr = decodeURIComponent(req.params.manufacturer);
    const { discount_pct, discount_days, net_days, margin_override_pct, notes } = req.body;
    await pool.query(`
      INSERT INTO brand_payment_terms
        (tenant_id, manufacturer, discount_pct, discount_days, net_days, margin_override_pct, notes, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,now())
      ON CONFLICT (tenant_id, manufacturer) DO UPDATE SET
        discount_pct        = EXCLUDED.discount_pct,
        discount_days       = EXCLUDED.discount_days,
        net_days            = EXCLUDED.net_days,
        margin_override_pct = EXCLUDED.margin_override_pct,
        notes               = EXCLUDED.notes,
        updated_at          = now()
    `, [req.tenantId, mfr, discount_pct ?? null, discount_days ?? null, net_days ?? null,
        margin_override_pct ?? null, notes ?? null]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.get('/api/settings/cost-of-capital', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT value FROM app_settings WHERE tenant_id = $1 AND key = 'cost_of_capital'`,
      [req.tenantId],
    );
    res.json({ cost_of_capital: rows[0] ? Number(rows[0].value) : 8.0 });
  } catch (err) { next(err); }
});

app.put('/api/settings/cost-of-capital', requireAuth, async (req, res, next) => {
  try {
    const pct = Number(req.body.cost_of_capital);
    if (isNaN(pct) || pct < 0 || pct > 100) return res.status(400).json({ error: 'Valeur invalide (0–100)' });
    await pool.query(`
      INSERT INTO app_settings(tenant_id, key, value, updated_at)
      VALUES ($1,'cost_of_capital',$2::jsonb,now())
      ON CONFLICT(tenant_id, key) DO UPDATE SET value=$2::jsonb, updated_at=now()
    `, [req.tenantId, String(pct)]);
    res.json({ ok: true, cost_of_capital: pct });
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

  // Orphan-recovery for import jobs (pushes + LLM extractions).
  // Any process running these tasks was killed when this container restarted.
  // Mark them as failed/awaiting so the operator can retry from the UI.
  try {
    const { rows: stalePush } = await pool.query(
      `UPDATE import_queue SET status = 'failed', finished_at = now(),
                                error_message = 'Container restarted mid-push (orphan recovery on boot)'
       WHERE status IN ('queued','running')
       RETURNING job_id, tenant_id, file_id`,
    );
    if (stalePush.length) {
      console.warn(`[startup] Marked ${stalePush.length} orphan push job(s) as failed:`,
        stalePush.map(r => `job=${r.job_id} file=${r.file_id}`).join(', '));
      // Companion: bring their import_files back to 'previewed' so the operator
      // can click Push again. The queue processor is idempotent (skips lines
      // that already have lightspeed_order_line_id), so retries resume where
      // the previous run left off — no double-inserts in Lightspeed.
      const fileIds = stalePush.map(r => r.file_id);
      await pool.query(
        `UPDATE import_files SET status = 'previewed'
         WHERE file_id = ANY($1::int[]) AND status = 'pushing'`,
        [fileIds],
      );
    }
    const { rows: staleExtract } = await pool.query(
      `UPDATE import_files SET status = 'awaiting_extraction',
                                last_extraction_error = 'Container restarted mid-extraction (orphan recovery on boot)'
       WHERE status = 'extracting'
       RETURNING file_id, tenant_id`,
    );
    if (staleExtract.length) {
      console.warn(`[startup] Marked ${staleExtract.length} orphan LLM extraction(s) as awaiting:`,
        staleExtract.map(r => `file=${r.file_id}`).join(', '));
    }
  } catch (err) {
    console.error('[startup] Orphan-job recovery failed:', err.message);
  }

  // Hourly sync — spawns sync.js --once every hour if no sync is already running.
  // SYNC_DAYS_BACK controls the sales/transfers window (keep it small, e.g. 7,
  // since full historical data is already in the DB from the initial sync).
  // STATIC_SYNC_DAYS controls how often inventory/items/shops re-sync (default 1 = daily).
  const nodeCron = require('node-cron');
  nodeCron.schedule('0 * * * *', () => {
    if (syncRunning || !process.env.LIGHTSPEED_REFRESH_TOKEN) return;
    console.log('[sync/cron] Starting hourly sync…');
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
      console.log(`[sync/cron] exited with code ${code}`);
    });
  });
  console.log('[sync/cron] Hourly sync scheduled (runs at :00 every hour)');
});

} catch (err) {
  console.error('Fatal error during startup:', err);
  process.exit(1);
}
