#!/usr/bin/env node
// Smoke test for lib/lightspeed-client.js.
// Exercises: token refresh, rate limiter (10 seq calls), search, variants,
// tags fetch, and the FORBIDDEN_TAGS guard (no actual PUT is made).
//
// READS ONLY. No matrix/variant/order is created.
//
// Run: railway run node scripts/smoke-lightspeed-client.js

'use strict';

const { fromEnv, LightspeedError } = require('../lib/lightspeed-client');

async function main() {
  const cli = fromEnv();
  console.log('✔ Client instantiated. Base URL:', cli.baseURL);

  // 1. Token refresh
  console.log('\n[1] Refresh OAuth token…');
  const t0 = Date.now();
  await cli._getAccessToken();
  console.log(`    got token in ${Date.now() - t0}ms`);

  // 2. Rate-limiter check: fire 6 sequential /Shop calls, expect ~5×(1000/3) = ~1660ms floor
  console.log('\n[2] Rate-limit sanity — 6 sequential /Shop.json calls…');
  const rateStart = Date.now();
  for (let i = 0; i < 6; i++) {
    const data = await cli._request('GET', '/Shop.json', { params: { limit: 1 } });
    process.stdout.write(`    call ${i + 1}: ok (bucket ${cli.lastBucketLevel || '?'})\n`);
  }
  const rateElapsed = Date.now() - rateStart;
  console.log(`    total elapsed: ${rateElapsed}ms (floor for 6 @ 3/s ≈ 1666ms)`);

  // 3. Search by prefix — use a style known to exist from the preview data
  const testStyle = '99103';
  console.log(`\n[3] searchMatrixByPrefix('${testStyle}')…`);
  const matrices = await cli.searchMatrixByPrefix(testStyle);
  console.log(`    → ${matrices.length} matrix(es):`);
  for (const m of matrices) console.log(`      #${m.itemMatrixID} "${m.description}"`);

  // 4. Load variants of the first match (if any)
  if (matrices.length) {
    const first = matrices[0];
    console.log(`\n[4] getMatrixWithVariants(${first.itemMatrixID})…`);
    const { matrix, items } = await cli.getMatrixWithVariants(first.itemMatrixID);
    console.log(`    matrix "${matrix.description}" → ${items.length} variants`);

    // 5. Load tags for the first variant
    if (items.length) {
      const v0 = items[0];
      console.log(`\n[5] getItemWithTags(${v0.itemID})…`);
      const item = await cli.getItemWithTags(v0.itemID);
      const tagField = item?.Tags;
      console.log(`    variant "${item?.description}" — Tags shape: ${JSON.stringify(tagField)?.slice(0, 200) || 'null'}`);
    }
  }

  // 6. FORBIDDEN_TAGS guard — must throw before any HTTP call
  console.log(`\n[6] tagItem() with forbidden tag 'add' — must throw:`);
  try {
    await cli.tagItem(999999999, ['a26', 'add']);
    console.error('    ✗ FAIL: tagItem did NOT throw');
    process.exit(1);
  } catch (e) {
    if (e instanceof LightspeedError && /forbidden/i.test(e.message)) {
      console.log(`    ✔ threw as expected: ${e.message}`);
    } else {
      console.error(`    ✗ FAIL: wrong error type/message: ${e.message}`);
      process.exit(1);
    }
  }

  console.log('\n✅ All smoke tests passed.');
}

main().catch(e => {
  console.error('FATAL:', e.message);
  if (e.body) console.error('  body:', JSON.stringify(e.body).slice(0, 500));
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
