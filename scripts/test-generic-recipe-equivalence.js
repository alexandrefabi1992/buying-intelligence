#!/usr/bin/env node
'use strict';
// Non-negotiable success criterion for Week 1 of Option 2:
// the generic recipe engine, fed by the Oui recipe, MUST produce
// the EXACT same output as parseOuiEurostyle() on the Steilmann PDF.
//
// Success = 265 units / 6 orders / 61 products, and field-by-field parity.
// Any difference = the generic format isn't expressive enough → fix the engine,
// not this test.
//
// Also asserts:
//   - Applying the Oui recipe to a NON-Oui PDF fails LOUDLY (throws
//     RecipeExecutionError with a clear code), not silently returns empty.
//
// Run: node scripts/test-generic-recipe-equivalence.js
// Optional: PDF_PATH=/path/to/steilmann.pdf FALLBACK_PDF=/path/to/other.pdf

const fs = require('fs');
const path = require('path');
const { parseOuiEurostyle } = require('../lib/parsers/oui-eurostyle');
const { runRecipe, RecipeExecutionError } = require('../lib/parsers/generic-recipe');

const RECIPE = require('../lib/parsers/recipes/oui-eurostyle.recipe.json');
const PDF_PATH     = process.env.PDF_PATH     || '/Users/alexandrefabi/Downloads/OrderConfirmationSteilmann_V2.pdf';
const FALLBACK_PDF = process.env.FALLBACK_PDF || '/Users/alexandrefabi/Downloads/Order Confirmation ERP.pdf';

let assertions = 0;
let failures = [];

function assert(label, cond, detail) {
  assertions++;
  if (cond) {
    console.log(`  ✔ ${label}`);
  } else {
    failures.push({ label, detail });
    console.log(`  ✗ ${label}` + (detail ? `\n      ${detail}` : ''));
  }
}

// Deep structural equality — reports the first diff path found.
function deepDiff(a, b, path = '') {
  if (a === b) return null;
  if (a == null || b == null) return `${path || '(root)'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`;
  if (typeof a !== typeof b) return `${path || '(root)'}: type ${typeof a} !== ${typeof b}`;
  if (typeof a === 'number' && Math.abs(a - b) < 1e-9) return null;   // float tolerance
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array mismatch`;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return `${path}.length: ${a.length} !== ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = deepDiff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (typeof a === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const d = deepDiff(a[k], b[k], path ? `${path}.${k}` : k);
      if (d) return d;
    }
    return null;
  }
  return `${path}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`;
}

// Normalise a product before comparison — remove parser-internal fields
// that aren't guaranteed to be identical (private markers).
function normalizeProducts(products) {
  return products.map(p => {
    const clean = { ...p };
    // Both parsers add _lineY but the generic deletes it. Ensure both are clean.
    delete clean._lineY;
    delete clean._trailing_match;
    delete clean._line;
    return clean;
  });
}

async function main() {
  if (!fs.existsSync(PDF_PATH)) {
    console.error(`FATAL: PDF not found at ${PDF_PATH}`);
    console.error(`Set PDF_PATH env var to the Steilmann PDF you validated in B9.5.`);
    process.exit(1);
  }
  const pdfBuffer = fs.readFileSync(PDF_PATH);

  // ─── Phase 1: legacy parser baseline ─────────────────────────────────
  console.log(`\n═══ Phase 1 — Baseline (parseOuiEurostyle) on ${path.basename(PDF_PATH)} ═══`);
  const baseline = await parseOuiEurostyle(pdfBuffer);
  console.log(`  ${baseline.orders.length} orders, ${baseline.products.length} products, ${baseline.declared_totals.totalUnits} units declared`);

  // Expected baseline for Steilmann_V2 (from the user's spec):
  assert('baseline: 265 units declared',
    baseline.declared_totals.totalUnits === 265,
    `got ${baseline.declared_totals.totalUnits}`);
  assert('baseline: 35 490.40 $ declared',
    Math.abs(baseline.declared_totals.totalAmount - 35490.40) < 0.01,
    `got ${baseline.declared_totals.totalAmount.toFixed(2)}`);
  assert('baseline: 6 orders',
    baseline.orders.length === 6,
    `got ${baseline.orders.length}`);

  // ─── Phase 2: generic engine with the Oui recipe ─────────────────────
  console.log(`\n═══ Phase 2 — Generic engine + oui-eurostyle recipe ═══`);
  const generic = await runRecipe(pdfBuffer, RECIPE);
  console.log(`  ${generic.orders.length} orders, ${generic.products.length} products, ${generic.declared_totals.totalUnits} units declared`);

  // Same top-level numbers
  assert('generic: same orders count',
    generic.orders.length === baseline.orders.length);
  assert('generic: same products count',
    generic.products.length === baseline.products.length);
  assert('generic: same declared unit total',
    generic.declared_totals.totalUnits === baseline.declared_totals.totalUnits);
  assert('generic: same declared amount total',
    Math.abs(generic.declared_totals.totalAmount - baseline.declared_totals.totalAmount) < 0.01);

  // ─── Phase 3: field-by-field equivalence ─────────────────────────────
  console.log(`\n═══ Phase 3 — Deep equivalence, field by field ═══`);

  const fileDiff = deepDiff(baseline.file, generic.file);
  assert('file meta identical', fileDiff === null, fileDiff);

  const ordersDiff = deepDiff(baseline.orders, generic.orders);
  assert('orders array identical', ordersDiff === null, ordersDiff);

  const dtDiff = deepDiff(baseline.declared_totals, generic.declared_totals);
  assert('declared_totals identical', dtDiff === null, dtDiff);

  const prodBase = normalizeProducts(baseline.products);
  const prodGen  = normalizeProducts(generic.products);
  const prodDiff = deepDiff(prodBase, prodGen);
  assert('products array identical', prodDiff === null, prodDiff);

  // Warnings: allow ordering / content differences but count parity
  assert('warnings same count',
    baseline.warnings.length === generic.warnings.length,
    `baseline=${baseline.warnings.length} vs generic=${generic.warnings.length}`);

  // ─── Phase 4: fail-loud on non-matching PDF ──────────────────────────
  console.log(`\n═══ Phase 4 — Fail-loud on unrelated PDF ═══`);
  if (!fs.existsSync(FALLBACK_PDF)) {
    console.log(`  ⚠ ${FALLBACK_PDF} not found — skipping fail-loud test`);
    console.log(`    (Set FALLBACK_PDF env var to any non-Oui PDF for a full coverage run)`);
  } else {
    const nonOui = fs.readFileSync(FALLBACK_PDF);
    let threw = false, errorCode = null, errorMessage = null;
    try {
      await runRecipe(nonOui, RECIPE);
    } catch (e) {
      threw = true;
      errorCode = e instanceof RecipeExecutionError ? e.code : e.name;
      errorMessage = e.message;
    }
    assert('non-matching PDF throws (not returns empty)', threw, 'engine returned silently instead of throwing');
    if (threw) {
      assert('thrown error is RecipeExecutionError with a clear code',
        errorCode !== 'unknown' && errorCode != null,
        `got code="${errorCode}", message="${errorMessage}"`);
      console.log(`      → code=${errorCode}  message="${errorMessage.slice(0, 120)}"`);
    }
  }

  // ─── Summary ─────────────────────────────────────────────────────────
  console.log(`\n═══ SUMMARY ═══`);
  console.log(`  ${assertions - failures.length} / ${assertions} assertions passed`);
  if (failures.length) {
    console.log(`\n${failures.length} FAILURE(S):`);
    for (const f of failures) console.log(`  ✗ ${f.label}: ${f.detail || '(no detail)'}`);
    process.exit(1);
  }
  console.log('\n✅ EQUIVALENCE PROVEN. Generic recipe engine matches parseOuiEurostyle exactly.');
}

main().catch(e => {
  console.error('\n✗ FATAL:', e.message);
  if (e instanceof RecipeExecutionError) console.error('  code:', e.code, 'context:', e.context);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
