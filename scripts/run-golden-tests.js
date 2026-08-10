#!/usr/bin/env node
'use strict';

/*
 * run-golden-tests.js
 * --------------------
 * Regression harness for the PO ingestion pipeline. Compares every golden
 * under tests/golden/<supplier>/ against either:
 *
 *   • the current cached preview (default, mode="diff") — fast, no LLM cost.
 *     Detects drift caused by preview-generator, style-resolver, buildPreview
 *     or any post-extraction post-processing change.
 *
 *   • a freshly re-extracted LLM output (--live) — actually re-invokes
 *     Mistral against the original PDF and re-runs buildPreview locally.
 *     Detects drift caused by the LLM prompt itself.
 *
 * Live mode requires the original PDFs on disk. Point at their directory via
 *   --pdf-dir=/path/to/pdfs
 * and each golden's meta.json.source_filename must exist inside that dir.
 * Without --pdf-dir, live mode falls back to $GOLDEN_PDF_DIR, then skips any
 * supplier whose PDF cannot be located (with a clear warning).
 *
 * Usage:
 *   node scripts/run-golden-tests.js
 *   node scripts/run-golden-tests.js --live [--pdf-dir=/path]
 *   node scripts/run-golden-tests.js --only=meyer,brax-pl
 */

const fs   = require('fs');
const path = require('path');

const BASE       = process.env.GOLDEN_API_BASE
  || 'https://buying-intelligence-production.up.railway.app';
const TOKEN_PATH = '/tmp/diag-token.txt';
const ROOT       = path.resolve(__dirname, '..');
const GOLDEN_DIR = path.join(ROOT, 'tests', 'golden');

const ARGS = process.argv.slice(2);
const LIVE = ARGS.includes('--live');
const ONLY = (ARGS.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const PDF_DIR = (ARGS.find((a) => a.startsWith('--pdf-dir=')) || '').slice(10)
  || process.env.GOLDEN_PDF_DIR
  || null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadToken() {
  try {
    const t = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
    if (t) return t;
  } catch (_) {}
  const jwt = require(path.join(ROOT, 'node_modules', 'jsonwebtoken'));
  const secret = process.env.JWT_SECRET
    || '9607dd7cac5d2f4f6ace760668ee90d853ff3b4bac5c26cc4ad1a3e722eaa0aa';
  const fresh = jwt.sign(
    { tenantId: 'valerie-simon', userId: 'diag', role: 'superadmin' },
    secret,
  );
  try { fs.writeFileSync(TOKEN_PATH, fresh); } catch (_) {}
  return fresh;
}

async function apiGet(pathname, { asText = false, retries = 3 } = {}) {
  const token = loadToken();
  const url   = `${BASE}${pathname}`;
  let last;
  for (let i = 1; i <= retries; i++) {
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 502) { last = new Error('HTTP 502'); await sleep(2000); continue; }
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`GET ${pathname} → HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      return asText ? await res.text() : await res.json();
    } catch (e) {
      last = e;
      if (i < retries) await sleep(2000);
    }
  }
  throw last;
}

// ═══ Summary comparison ═══════════════════════════════════════════════════

const SUMMARY_KEYS = [
  'matrix_count',
  'summed_units_total',
  'summed_cost_total',
  'declared_units_total',
  'incomplete',
];

function extractSummaryFields(preview) {
  const s = preview.summary || preview.preview_json?.summary || {};
  const out = {};
  for (const k of SUMMARY_KEYS) out[k] = s[k];
  out.incomplete_reason_codes = new Set(
    (s.incomplete_reasons || []).map((r) => r.code).sort(),
  );
  out.matrices_len  = (preview.matrices || preview.preview_json?.matrices || []).length;
  out.products_len  = (preview.products || preview.preview_json?.products || []).length;
  return out;
}

function diffSummary(expected, actual) {
  const diffs = [];
  for (const k of SUMMARY_KEYS) {
    if (JSON.stringify(expected[k]) !== JSON.stringify(actual[k])) {
      diffs.push(`  ${k}: expected=${JSON.stringify(expected[k])} actual=${JSON.stringify(actual[k])}`);
    }
  }
  const expCodes = [...expected.incomplete_reason_codes].join(',');
  const actCodes = [...actual.incomplete_reason_codes].join(',');
  if (expCodes !== actCodes) {
    diffs.push(`  incomplete_reason_codes: expected={${expCodes}} actual={${actCodes}}`);
  }
  if (expected.matrices_len !== actual.matrices_len) {
    diffs.push(`  matrices.length: expected=${expected.matrices_len} actual=${actual.matrices_len}`);
  }
  if (expected.products_len !== actual.products_len) {
    diffs.push(`  products.length: expected=${expected.products_len} actual=${actual.products_len}`);
  }
  return diffs;
}

// ═══ Supplier-specific assertions ═════════════════════════════════════════
// Return { ok: boolean, msg: string } — msg is the FAIL reason (or PASS
// note) shown in the report. Assertions receive the LIVE actual preview,
// not the golden — they enforce invariants that must hold across the
// current pipeline (they'd catch a regression that the summary diff missed).

const ASSERTIONS = {
  meyer: (preview) => {
    const mats = preview.matrices || [];
    const withSlash = mats.filter((m) => m.style_ref && m.style_ref.includes('/'));
    if (withSlash.length) {
      return { ok: false, msg: `${withSlash.length} matrix(es) with '/' in style_ref: ${
        withSlash.slice(0, 3).map((m) => m.style_ref).join(', ')}` };
    }
    const nullCol = mats.filter((m) => !m.color_normalized);
    if (nullCol.length) {
      return { ok: false, msg: `${nullCol.length} matrix(es) with null color_normalized` };
    }
    return { ok: true, msg: `${mats.length} matrices, no '/' in style_ref, all color_normalized set` };
  },

  fradi: (preview) => {
    const mats = preview.matrices || [];
    const empty = mats.filter((m) => {
      const created  = (m.variants_to_create      || []).length;
      const existing = (m.existing_variants       || []).length;
      const already  = (m.variants_already_present|| []).length;
      return created + existing + already === 0;
    });
    if (empty.length) {
      return { ok: false, msg: `${empty.length} matrix(es) with zero variants: ${
        empty.slice(0, 3).map((m) => m.style_ref).join(', ')}` };
    }
    return { ok: true, msg: `${mats.length} matrices, all have ≥1 variant` };
  },

  numph: (preview) => {
    // Golden captured PRE-fix (commit 40eb0bd). Cannot verify prepack fix
    // rétroactivement — the recipe/prompt now sums prepacks differently
    // and pushed files are immutable. This assertion only checks the
    // summary matches the golden count (already covered by diff mode) —
    // treat as informational.
    const mats = preview.matrices || [];
    return { ok: true, msg: `${mats.length} matrices (prepack assertion skipped — golden is PRE-fix commit 40eb0bd)` };
  },

  'brax-pl': (preview) => {
    const inc = preview.summary?.incomplete;
    if (inc) {
      const codes = (preview.summary?.incomplete_reasons || []).map((r) => r.code).join(', ');
      return { ok: false, msg: `summary.incomplete=true (codes: ${codes}) — should be false post fixes 5287525+b25965e+7b17ef8` };
    }
    return { ok: true, msg: 'summary.incomplete=false' };
  },

  'brax-vs': (preview) => {
    const mats  = preview.matrices || [];
    const bozen = mats.find((m) => (m.style_ref || '').includes('73214 BOZEN'));
    if (!bozen) {
      return { ok: false, msg: 'no matrix with style_ref containing "73214 BOZEN"' };
    }
    if (bozen.action !== 'complete_existing') {
      return { ok: false, msg: `73214 BOZEN: action=${bozen.action} (expected complete_existing)` };
    }
    if (!bozen.reused_matrix_id) {
      return { ok: false, msg: '73214 BOZEN: reused_matrix_id is null (expected cross-PO reuse)' };
    }
    return { ok: true, msg: `73214 BOZEN reuses matrix ${bozen.reused_matrix_id} (cross-PO style-resolver OK)` };
  },

  oui: (preview) => {
    const s = preview.summary || {};
    if (Number(s.summed_cost_total) !== Number(s.declared_amount_total)) {
      return { ok: false, msg: `summed_cost_total=${s.summed_cost_total} !== declared_amount_total=${s.declared_amount_total}` };
    }
    return { ok: true, msg: `recipe path: summed_cost = declared_amount = ${s.summed_cost_total}` };
  },

  'liu-jo': (preview) => {
    // Golden captured PRE-fix (commits 5287525, b25965e, 7b17ef8). Numeric
    // sizes '1'/'2' cannot be verified against this snapshot. Only assert
    // that the overall structure is intact (units_match=true, no errors).
    const s = preview.summary || {};
    if (!s.units_match) {
      return { ok: false, msg: 'units_match=false — structural regression on Liu Jo golden' };
    }
    return { ok: true, msg: `structure intact (${s.matrix_count} matrices, units_match=true — numeric-size fix not testable here)` };
  },

  marcoliani: (preview) => {
    const s = preview.summary || {};
    if (!s.units_match) {
      return { ok: false, msg: 'units_match=false' };
    }
    return { ok: true, msg: `${s.matrix_count} matrices, units_match=true (retail_price=null tolerated)` };
  },

  'marc-cain': (preview) => {
    const mats = preview.matrices || [];
    // 1) No column-shift leak into style_ref (would look like a leading 'N ' or a '/N' fragment).
    const badRef = mats.filter((m) => {
      const s = m.style_ref || '';
      return s.startsWith('N ') || s.includes('/N');
    });
    if (badRef.length) {
      return { ok: false, msg: `${badRef.length} matrix(es) with 'N ' prefix or '/N' fragment in style_ref: ${
        badRef.slice(0, 3).map((m) => m.style_ref).join(', ')}` };
    }
    // 2) No variant.size should start with 'N' (would indicate the 'N' preflix column shifted into the size cells).
    const badSize = [];
    for (const m of mats) {
      const variants = (m.variants_to_create || [])
        .concat(m.existing_variants || [])
        .concat(m.variants_already_present || []);
      for (const v of variants) {
        if ((v.size || '').startsWith('N')) badSize.push(`${m.style_ref}:${v.size}`);
      }
    }
    if (badSize.length) {
      return { ok: false, msg: `${badSize.length} variant(s) with size starting with 'N' (column-shift leak): ${
        badSize.slice(0, 3).join(', ')}` };
    }
    return { ok: true, msg: `${mats.length} matrices, no 'N' prefix leak in style_ref or variant sizes` };
  },

  'patrick-assaraf': (preview) => {
    const mats = preview.matrices || [];
    if (mats.length < 1) {
      return { ok: false, msg: `matrix_count=${mats.length} (expected ≥1)` };
    }
    // Composite style_ref (base + modifier) must be cleanly concatenated:
    // no consecutive spaces, no '--', no leading/trailing '-'.
    const bad = mats.filter((m) => {
      const s = m.style_ref || '';
      return /\s{2,}/.test(s) || s.includes('--') || s.startsWith('-') || s.endsWith('-');
    });
    if (bad.length) {
      return { ok: false, msg: `${bad.length} matrix(es) with malformed style_ref (spaces/dashes): ${
        bad.slice(0, 3).map((m) => `'${m.style_ref}'`).join(', ')}` };
    }
    return { ok: true, msg: `${mats.length} matrices, all style_refs cleanly composed` };
  },

  bugatchi: (preview) => {
    const mats = preview.matrices || [];
    // 1) Every matrix (accessory) must have unit_cost > 0.
    const noCost = mats.filter((m) => !(Number(m.unit_cost) > 0));
    if (noCost.length) {
      return { ok: false, msg: `${noCost.length} matrix(es) with unit_cost <= 0: ${
        noCost.slice(0, 3).map((m) => m.style_ref).join(', ')}` };
    }
    // 2) Every variant.size must have been normalized ONE → OS.
    const oneSizes = [];
    for (const m of mats) {
      const variants = (m.variants_to_create || [])
        .concat(m.existing_variants || [])
        .concat(m.variants_already_present || []);
      for (const v of variants) {
        if (v.size === 'ONE') oneSizes.push(m.style_ref);
      }
    }
    if (oneSizes.length) {
      return { ok: false, msg: `${oneSizes.length} variant(s) with size='ONE' (must be normalized to 'OS'): ${
        [...new Set(oneSizes)].slice(0, 3).join(', ')}` };
    }
    return { ok: true, msg: `${mats.length} matrices, all cost>0, no 'ONE' sizes (all normalized to 'OS')` };
  },

  dph: (preview) => {
    const mats = preview.matrices || [];
    // 1) Every matrix must have color_normalized non-null and non-empty.
    const nullCol = mats.filter((m) => !m.color_normalized || String(m.color_normalized).trim() === '');
    if (nullCol.length) {
      return { ok: false, msg: `${nullCol.length} matrix(es) with null/empty color_normalized: ${
        nullCol.slice(0, 3).map((m) => m.style_ref).join(', ')}` };
    }
    // 2) If a PAULA matrix exists (case-insensitive on style_ref/description),
    //    it must have at least one variant with size='OS' and none with size='T0'.
    //    If no PAULA row, log a note but do NOT fail — PAULA can be absent from a given PO.
    const paulaMat = mats.find((m) => {
      const s = ((m.style_ref || '') + ' ' + (m.description || '')).toUpperCase();
      return s.includes('PAULA');
    });
    if (paulaMat) {
      const variants = (paulaMat.variants_to_create || [])
        .concat(paulaMat.existing_variants || [])
        .concat(paulaMat.variants_already_present || []);
      const hasOS = variants.some((v) => v.size === 'OS');
      const hasT0 = variants.some((v) => v.size === 'T0');
      if (!hasOS || hasT0) {
        return { ok: false, msg: `PAULA matrix has wrong sizes (expected OS present, T0 absent): sizes=${
          JSON.stringify(variants.map((v) => v.size))}` };
      }
      return { ok: true, msg: `${mats.length} matrices, all color_normalized set; PAULA=OS (no T0)` };
    }
    return { ok: true, msg: `${mats.length} matrices, all color_normalized set (no PAULA matrix on this PO)` };
  },
};

// ═══ Live-mode extraction helper ══════════════════════════════════════════
// Requires the original PDF on disk. Uses lib/llm-extractor.extractPdfWithLlm
// verbatim (so any prompt change is caught) and then re-invokes
// preview-generator.buildPreview locally to produce a comparable preview.

async function runLive(meta, rawGolden) {
  if (!PDF_DIR) {
    return { skipped: true, reason: 'no --pdf-dir supplied (and $GOLDEN_PDF_DIR unset)' };
  }
  const pdfPath = path.join(PDF_DIR, meta.source_filename);
  if (!fs.existsSync(pdfPath)) {
    return { skipped: true, reason: `PDF not found at ${pdfPath}` };
  }
  const { extractPdfWithLlm } = require(path.join(ROOT, 'lib', 'llm-extractor'));
  const { buildPreview }      = require(path.join(ROOT, 'lib', 'preview-generator'));

  const pdfBuf = fs.readFileSync(pdfPath);
  const parsed = await extractPdfWithLlm(pdfBuf, {
    target_manufacturer: meta.manufacturer,
  });

  // Empty resolutions map → all matrices route via style-resolver as
  // "create_new" (we can't run the cross-PO resolver without DB access).
  // buildPreview still yields the summary + assertion-relevant fields;
  // any cross-PO-reuse assertion (brax-vs) will need to run in diff mode.
  const preview = buildPreview(parsed, new Map(), {
    season_tag:          meta.season_tag,
    target_manufacturer: meta.manufacturer,
  });
  return { skipped: false, preview, rawText: parsed._rawText || rawGolden };
}

// ═══ Runner ═══════════════════════════════════════════════════════════════

async function loadGolden(supplier) {
  const dir = path.join(GOLDEN_DIR, supplier);
  return {
    supplier,
    meta:    JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')),
    preview: JSON.parse(fs.readFileSync(path.join(dir, 'expected_preview.json'), 'utf8')),
    rawText: fs.readFileSync(path.join(dir, 'raw_text.txt'), 'utf8'),
  };
}

function listSuppliers() {
  return fs.readdirSync(GOLDEN_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((s) => !ONLY.length || ONLY.includes(s))
    .sort();
}

function fmtStatus(pass) { return pass ? 'PASS' : 'FAIL'; }

async function main() {
  const suppliers = listSuppliers();
  const mode      = LIVE ? 'live (re-extract LLM)' : 'diff (compare cached preview)';
  console.log(`Running ${suppliers.length} golden(s) — mode: ${mode}`);
  console.log('');

  let pass = 0, fail = 0, skipped = 0;
  const failures = [];

  for (const supplier of suppliers) {
    const golden   = await loadGolden(supplier);
    const expected = extractSummaryFields(golden.preview);
    let   actualPreview;

    try {
      if (LIVE) {
        const r = await runLive(golden.meta, golden.rawText);
        if (r.skipped) {
          console.log(`SKIP  ${supplier.padEnd(11)} — ${r.reason}`);
          skipped++;
          continue;
        }
        actualPreview = r.preview;
      } else {
        actualPreview = await apiGet(`/api/import/files/${golden.meta.file_id}/preview`);
      }
    } catch (e) {
      console.log(`ERROR ${supplier.padEnd(11)} — ${e.message}`);
      fail++;
      failures.push(`${supplier}: fetch error — ${e.message}`);
      continue;
    }

    const actual = extractSummaryFields(actualPreview);
    const diffs  = diffSummary(expected, actual);
    const assert = ASSERTIONS[supplier]
      ? ASSERTIONS[supplier](actualPreview)
      : { ok: true, msg: 'no supplier-specific assertion registered' };

    const ok = diffs.length === 0 && assert.ok;
    if (ok) pass++; else fail++;

    console.log(`${fmtStatus(ok)}  ${supplier.padEnd(11)} — ${assert.msg}`);
    if (diffs.length) {
      console.log('  summary diff:');
      for (const d of diffs) console.log(d);
      failures.push(`${supplier}: summary drift`);
    }
    if (!assert.ok) failures.push(`${supplier}: ${assert.msg}`);
  }

  console.log('');
  console.log(`Result: ${pass} pass / ${fail} fail / ${skipped} skipped (of ${suppliers.length})`);
  if (failures.length) {
    console.log('');
    console.log('Failures:');
    for (const f of failures) console.log(`  • ${f}`);
  }
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(`[run-golden-tests] fatal: ${e.stack || e.message}`);
  process.exit(1);
});
