// ---------------------------------------------------------------------------
// Per-user permissions — tab access + shop scoping.
//
// Stored in users.permissions (JSONB):
//   { "tabs": ["budget", "nos"], "shops": ["1", "6"] }
//
// Conventions:
//  - A missing key, a non-array value, or an EMPTY array all mean "no
//    restriction". This keeps every pre-existing user (permissions = '{}')
//    working unchanged, and makes an accidental `[]` from a buggy client a
//    no-op rather than a lockout. A user who should see nothing is deleted
//    or has their tenant deactivated — not given an empty tab list.
//  - Shop ids are compared as trimmed strings (shops.shop_id is TEXT).
//  - superadmin bypasses everything; requireAuth sets both lists to null.
// ---------------------------------------------------------------------------

// Canonical tab keys — must match the data-tab attributes in public/index.html.
const TABS = [
  'budget', 'nos', 'sizes', 'transfers', 'plan',
  'inv-history', 'accounting', 'velocity', 'params',
];

// Tabs that are inherently cross-shop: granting them grants visibility on
// every shop of the tenant, regardless of the user's shop restriction.
// Transfers rows are (dormant shop → active shop) pairs; scoping them to a
// single shop would hide the other half of every recommendation.
const SHOP_EXEMPT_TABS = ['transfers'];

class ForbiddenError extends Error {
  constructor(message) {
    super(message);
    this.name   = 'ForbiddenError';
    this.status = 403;
  }
}

// Normalize a raw JSONB list into a deduped string array, or null when the
// value carries no restriction (absent / not an array / empty).
function normalizeList(value) {
  if (!Array.isArray(value)) return null;
  const out = [...new Set(value.map(v => String(v).trim()).filter(Boolean))];
  return out.length ? out : null;
}

function normalizePermissions(raw) {
  const p = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    tabs:  normalizeList(p.tabs),
    shops: normalizeList(p.shops),
  };
}

// Parse a requested shop selection from a query param ("1,6"), an array, or a
// single id. Returns null when nothing was requested.
function parseShopRequest(value) {
  if (value == null || value === '') return null;
  const arr = Array.isArray(value) ? value : String(value).split(',');
  const out = [...new Set(arr.map(v => String(v).trim()).filter(Boolean))];
  return out.length ? out : null;
}

// ---------------------------------------------------------------------------
// createPermissionLoader(pool) → async load(userId) → { tabs, shops }
//
// Permissions live in the DB rather than the JWT so that revoking access takes
// effect within the cache TTL instead of at the user's next login (tokens last
// 7 days). The lookup is a primary-key hit, cached in-process.
// ---------------------------------------------------------------------------
function createPermissionLoader(pool, { ttlMs = 30_000, maxEntries = 5000 } = {}) {
  const cache = new Map(); // String(userId) → { perms, exp }

  async function load(userId) {
    const key = String(userId);
    const hit = cache.get(key);
    if (hit && hit.exp > Date.now()) return hit.perms;

    const { rows } = await pool.query('SELECT permissions FROM users WHERE id = $1', [userId]);
    // Token references a user that no longer exists — deny rather than
    // falling through with an unrestricted (undefined) permission set.
    if (!rows.length) throw new ForbiddenError('Utilisateur introuvable');

    const perms = normalizePermissions(rows[0].permissions);
    if (cache.size >= maxEntries) cache.clear();
    cache.set(key, { perms, exp: Date.now() + ttlMs });
    return perms;
  }

  // Call after any write to users.permissions so the change is immediate.
  load.invalidate = (userId) => {
    if (userId == null) cache.clear();
    else cache.delete(String(userId));
  };

  return load;
}

// ---------------------------------------------------------------------------
// scopeShops(req, requested) → string[] | null
//
// The core of shop restriction. Every shop-aware endpoint treats a missing
// shop param as "all shops", so clamping an absent param to the allowed list
// is what actually enforces the restriction — hiding the shop in the UI does
// not. Returns null only for unrestricted users, meaning "no shop filter",
// which preserves the current behaviour byte for byte.
// ---------------------------------------------------------------------------
function scopeShops(req, requested) {
  const allowed = req?.allowedShops ?? null;
  const asked   = parseShopRequest(requested);
  if (!allowed) return asked;
  if (!asked)   return [...allowed];
  const inter = asked.filter(s => allowed.includes(s));
  if (!inter.length) throw new ForbiddenError('Accès refusé à cette boutique');
  return inter;
}

// Write paths that carry a single concrete shop_id in the body. Sentinels
// (null, '', '__all__') are left to the caller — they mean "not a specific
// shop" and are handled per-endpoint.
function assertShopAllowed(req, shopId) {
  const allowed = req?.allowedShops ?? null;
  if (!allowed) return;
  if (shopId == null || shopId === '' || shopId === '__all__') return;
  if (!allowed.includes(String(shopId).trim())) {
    throw new ForbiddenError('Accès refusé à cette boutique');
  }
}

function canAccessTab(req, tab) {
  const allowed = req?.allowedTabs ?? null;
  if (!allowed) return true;
  return allowed.includes(tab);
}

// True when the user's shop restriction should be ignored for this tab.
function isShopExemptTab(tab) {
  return SHOP_EXEMPT_TABS.includes(tab);
}

module.exports = {
  TABS,
  SHOP_EXEMPT_TABS,
  ForbiddenError,
  normalizePermissions,
  parseShopRequest,
  createPermissionLoader,
  scopeShops,
  assertShopAllowed,
  canAccessTab,
  isShopExemptTab,
};
