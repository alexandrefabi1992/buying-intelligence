'use strict';
// Unit tests for lib/permissions.js — the per-user tab/shop access layer.
//
// No database required: the loader is exercised against a stub pool so the
// caching and fail-closed behaviour can be asserted deterministically.
//
// Run: node tests/permissions.test.js   OR   npm run test:permissions

const P = require('../lib/permissions');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (err) { failed++; console.error('  FAIL ' + name + ' — ' + err.message); }
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label ?? ''} expected ${e}, got ${a}`);
}
function throws(fn, label) {
  try { fn(); } catch { return; }
  throw new Error((label ?? '') + ' expected a throw, got none');
}

// --- normalizePermissions ---------------------------------------------------
console.log('normalizePermissions');
check('empty object → unrestricted', () =>
  eq(P.normalizePermissions({}), { tabs: null, shops: null }));
check('null / garbage → unrestricted', () => {
  eq(P.normalizePermissions(null), { tabs: null, shops: null });
  eq(P.normalizePermissions('nope'), { tabs: null, shops: null });
  eq(P.normalizePermissions([1, 2]), { tabs: null, shops: null });
});
check('empty arrays → unrestricted (never a lockout)', () =>
  eq(P.normalizePermissions({ tabs: [], shops: [] }), { tabs: null, shops: null }));
check('values coerced to trimmed strings and deduped', () =>
  eq(P.normalizePermissions({ shops: [1, ' 1 ', 6] }).shops, ['1', '6']));

// --- scopeShops -------------------------------------------------------------
console.log('scopeShops');
const free = { allowedShops: null };
const ltd  = { allowedShops: ['1', '6'] };

check('unrestricted + no request → null (no filter, unchanged behaviour)', () =>
  eq(P.scopeShops(free, undefined), null));
check('unrestricted + request → request honoured verbatim', () =>
  eq(P.scopeShops(free, '2,9'), ['2', '9']));
check('restricted + NO request → clamped to allowed (the whole point)', () =>
  eq(P.scopeShops(ltd, undefined), ['1', '6']));
check('restricted + empty string → clamped to allowed', () =>
  eq(P.scopeShops(ltd, ''), ['1', '6']));
check('restricted + partial overlap → intersection only', () =>
  eq(P.scopeShops(ltd, '1,2,9'), ['1']));
check('restricted + array input → intersection only', () =>
  eq(P.scopeShops(ltd, ['6', '8']), ['6']));
check('restricted + no overlap → 403', () =>
  throws(() => P.scopeShops(ltd, '2,9')));
check('403 carries status 403', () => {
  try { P.scopeShops(ltd, '9'); } catch (e) { eq(e.status, 403); return; }
  throw new Error('no throw');
});
check('missing req fields behave as unrestricted (admin-secret routes)', () =>
  eq(P.scopeShops({}, '2'), ['2']));

// --- assertShopAllowed ------------------------------------------------------
console.log('assertShopAllowed');
check('unrestricted passes anything', () => P.assertShopAllowed(free, '9'));
check('restricted passes an allowed id', () => P.assertShopAllowed(ltd, '6'));
check('restricted rejects a foreign id', () =>
  throws(() => P.assertShopAllowed(ltd, '9')));
check('sentinels are left to the caller', () => {
  P.assertShopAllowed(ltd, null);
  P.assertShopAllowed(ltd, '');
  P.assertShopAllowed(ltd, '__all__');
});

// --- canAccessTab -----------------------------------------------------------
console.log('canAccessTab');
check('unrestricted sees every tab', () =>
  eq(P.TABS.every(t => P.canAccessTab({ allowedTabs: null }, t)), true));
check('restricted sees only granted tabs', () => {
  const req = { allowedTabs: ['budget', 'nos'] };
  eq(P.canAccessTab(req, 'budget'), true);
  eq(P.canAccessTab(req, 'accounting'), false);
});
check('transfers is shop-exempt', () => {
  eq(P.isShopExemptTab('transfers'), true);
  eq(P.isShopExemptTab('budget'), false);
});

// --- createPermissionLoader -------------------------------------------------
console.log('createPermissionLoader');
(async () => {
  let calls = 0, stored = { shops: ['1'] }, present = true;
  const pool = { query: async () => { calls++; return { rows: present ? [{ permissions: stored }] : [] }; } };
  const load = P.createPermissionLoader(pool, { ttlMs: 10_000 });

  const a = await load(7);
  const b = await load(7);
  check('normalizes the stored row', () => eq(a, { tabs: null, shops: ['1'] }));
  check('second call served from cache', () => eq(calls, 1));
  check('cache returns the same value', () => eq(b, a));

  stored = { shops: ['1', '6'] };
  load.invalidate(7);
  const c = await load(7);
  check('invalidate forces a refetch', () => { eq(calls, 2); eq(c.shops, ['1', '6']); });

  present = false;
  load.invalidate();
  let denied = false;
  try { await load(7); } catch (e) { denied = e instanceof P.ForbiddenError; }
  check('deleted user → ForbiddenError, never unrestricted', () => eq(denied, true));

  const boom = P.createPermissionLoader({ query: async () => { throw new Error('db down'); } });
  let propagated = false;
  try { await boom(1); } catch (e) { propagated = !(e instanceof P.ForbiddenError); }
  check('DB errors propagate (requireAuth turns them into 503)', () => eq(propagated, true));

  console.log(failed ? `\n❌  ${failed} test(s) failed.` : '\n✅  All permission tests pass.');
  process.exit(failed ? 1 : 0);
})();
