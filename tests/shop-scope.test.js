'use strict';
// Coverage test for per-user shop scoping.
//
// Static analysis, not a runtime test: it walks every API route in server.js
// and lib/import-routes.js and fails when a route that touches shop data has
// no shop guard. The point is that a route added later cannot silently escape
// the permission layer — the gap shows up here instead of in production.
//
// A route is considered covered when it either:
//   - calls one of the permission helpers, or
//   - carries a "shop-scope: exempt" comment stating why it must not scope, or
//   - is listed in NOT_APPLICABLE below, or
//   - takes :file_id / :batch_id, which the app.param gates in import-routes
//     cover centrally.
//
// Run: node tests/shop-scope.test.js   OR   npm run test:shop-scope

const fs   = require('fs');
const path = require('path');

const ROOT  = path.join(__dirname, '..');
const FILES = ['server.js', 'lib/import-routes.js'];

// Routes that touch the word "shop" but carry no per-shop data to restrict.
const NOT_APPLICABLE = new Set([
  'GET /api/shops',                     // itself filtered, by req.allowedShops
  'PUT /api/settings/budget-params',    // tenant-wide settings; gated by the 'params' tab
  'DELETE /api/conversations/:id',      // chat history, keyed by tenant
  'DELETE /api/budget-plan/document/:id',
  'POST /api/ai/chat',                  // chatbot tools scope themselves (ai-agent.js)
]);

const GUARD    = /PERMS\.|scopeShops|assertShopAllowed|allowedShops|velocityShopCond/;
const EXEMPT   = /shop-scope:\s*exempt/;
const ADMIN    = /^\/api\/(admin|superadmin|sync|logs|test|token)/;
const PARAMGATE = /:file_id|:batch_id/;

const gaps = [];
let checked = 0;

for (const file of FILES) {
  const lines  = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
  const starts = [];
  lines.forEach((l, i) => {
    const m = l.match(/^\s*app\.(get|post|put|delete|patch)\('(\/api\/[^']*)'/);
    if (m) starts.push({ i, key: `${m[1].toUpperCase()} ${m[2]}`, route: m[2] });
  });

  starts.forEach((s, k) => {
    if (ADMIN.test(s.route)) return;
    const end = k + 1 < starts.length ? starts[k + 1].i : lines.length;
    const slice = lines.slice(s.i, end);
    // Cut at the route's own closing "});" — anything after it belongs to the
    // next route's header (or, for the last route, to the rest of the file),
    // and would otherwise leak that code's vocabulary into this body.
    let last = slice.length - 1;
    while (last > 0 && !/^\s{0,2}\}\);\s*$/.test(slice[last])) last--;
    const body = slice.slice(0, (last || slice.length - 1) + 1).join('\n');
    // Preceding comment block, where an exemption is declared.
    let first = s.i - 1;
    while (first >= 0 && /^\s*\/\//.test(lines[first])) first--;
    const header = lines.slice(first + 1, s.i).join('\n');

    checked++;
    if (!/shop/i.test(body)) return;
    if (GUARD.test(body) || EXEMPT.test(body) || EXEMPT.test(header)) return;
    if (PARAMGATE.test(s.route)) return;
    if (NOT_APPLICABLE.has(s.key)) return;
    gaps.push(`${s.key}  (${file}:${s.i + 1})`);
  });
}

// --- chatbot tools -----------------------------------------------------------
// The AI agent reaches the same data through 26 tools. A tool that accepts a
// shop_id but never resolves it through resolveShopIds would read across every
// shop, bypassing the whole HTTP layer above.
{
  const src   = fs.readFileSync(path.join(ROOT, 'ai-agent.js'), 'utf8');
  const lines = src.split('\n');
  const starts = [];
  lines.forEach((l, i) => {
    const m = l.match(/^async function (tool\w+)/);
    if (m) starts.push({ i, name: m[1] });
  });
  starts.forEach((t, k) => {
    const end  = k + 1 < starts.length ? starts[k + 1].i : lines.length;
    const body = lines.slice(t.i, end).join('\n');
    // Declared exemption lives in the comment block above the function.
    let first = t.i - 1;
    while (first >= 0 && /^\s*\/\//.test(lines[first])) first--;
    const header = lines.slice(first + 1, t.i).join('\n');
    // Signature may span several lines; it ends at the line closing with `) {`.
    let sigEnd = t.i;
    while (sigEnd < end && !/\)\s*\{\s*$/.test(lines[sigEnd])) sigEnd++;
    const sig = lines.slice(t.i, sigEnd + 1).join(' ');

    checked++;
    if (/shop-scope:\s*exempt/.test(header)) return;
    // A tool that accepts a shop from the model must resolve it — that call is
    // what clamps an absent or foreign shop to the caller's own shops.
    if (/\b(shop_id|shops|receiving_shop_id)\b/.test(sig)) {
      if (!/resolveShopIds/.test(body)) gaps.push(`${t.name} — accepte shop_id sans resolveShopIds  (ai-agent.js:${t.i + 1})`);
      return;
    }
    // Otherwise: any tool reading shop columns must at least consult the scope.
    if (!/shop_id|\bshops\b/.test(body)) return;
    if (!/allowedShops/.test(body)) gaps.push(`${t.name} — lit des données boutique sans allowedShops  (ai-agent.js:${t.i + 1})`);
  });
  console.log(`Checked ${starts.length} chatbot tools in ai-agent.js.`);
}

console.log(`Checked ${checked} API routes and tools in total.`);
if (gaps.length) {
  console.error('\n❌  Routes touching shop data with no shop guard:\n');
  gaps.forEach(g => console.error('   ' + g));
  console.error('\nFix by calling PERMS.scopeShops / assertShopAllowed, or document');
  console.error('the exemption with a "shop-scope: exempt" comment and say why.');
  process.exit(1);
}
console.log('✅  Every shop-touching route is scoped, exempted, or gated.');
