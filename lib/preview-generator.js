'use strict';

// ═══════════════════════════════════════════════════════════════════════
// VALIDATION THRESHOLDS — post-extraction "completeness" gate.
//
// If any of these thresholds is breached, the preview is marked
// `summary.incomplete = true` with a list of `incomplete_reasons`. The
// backend push endpoint refuses to run unless the client explicitly
// includes `force_incomplete: true` (which is logged for traceability).
//
// Adjust here to tighten/loosen the safety net globally — do NOT hardcode
// these values inside the extraction logic below.
// ═══════════════════════════════════════════════════════════════════════
const VALIDATION_THRESHOLDS = {
  // Fraction of declared units that MUST be extracted.
  // 0.95 means we accept up to 5% missing. If the PDF says "Total: 265u"
  // and we extracted 220u, ratio = 0.83 → incomplete.
  // Skipped entirely when the recipe doesn't extract declared totals
  // (declared_units_total === 0 → no denominator to compare against).
  min_units_ratio: 0.95,

  // Max fraction of SUCCESSFULLY EXTRACTED products that may have their
  // per-line qty summed differ from the per-line declared total (a strong
  // signal that some size cells were missed). 0.10 = up to 10% mismatch OK.
  max_qty_mismatch_ratio: 0.10,

  // Max fraction of ATTEMPTED products that may be skipped entirely
  // (no size header found, no variants matched, etc.). 0.10 = up to 10% skip OK.
  //
  // Applied when a declared units total IS available in the PDF — we already
  // have the units_ratio check as a first line of defense, so this ratio can
  // be a little looser.
  max_skipped_ratio: 0.10,

  // STRICTER variant: applied when declared_units_total === 0 (recipe has no
  // "Total Commande" extraction, or the PDF doesn't include one — Bugatchi is
  // the reference case). In that scenario the units_ratio check is skipped
  // entirely, so skipped_ratio becomes the SOLE completeness signal we have.
  // We tighten it to 0.05 so a marginal drop still trips the flag, since we
  // can't cross-check against a document total. If the target recipe suffers
  // from a real skip pattern, the operator sees it sooner.
  max_skipped_ratio_no_declared: 0.05,

  // LLM-ONLY guard against column-shift errors (Marc Cain reference case).
  // The recipe path anchors quantities to size headers by x-coordinate and
  // is immune. LLMs read text sequentially and can attribute qtys to the
  // wrong size when the source has "-" placeholders for empty size columns.
  // Even a single suspected product is a hard signal that the extraction is
  // misaligned column-wise, so we set an aggressive 2% threshold: 1 bad
  // product out of 50 is already enough to trip the flag and force the
  // operator to review before push.
  max_size_mismatch_ratio: 0.02,

  // Max fraction the summed extracted cost may deviate from the declared
  // amount total (from the PDF's summary/header). 0.02 = 2%. Skipped when
  // no declared amount total is available. Independent from units check —
  // it can catch cost/qty misalignment where units match but $ don't
  // (e.g., a product with wrong unit_cost extracted).
  max_cost_ratio_deviation: 0.02,
};

// Preview generator for the import module.
//
// Consumes parser output (from lib/parsers/*.js) + a resolution Map (from
// lib/style-resolver.js) and produces the structured preview JSON that the
// frontend renders and the push queue eventually replays.
//
// Two grouping levels — this is the crux of the module:
//   1. MATRIX-level dedup CROSS-PO.
//      A style×color pair appearing in 3 different POs must produce ONE
//      Lightspeed matrix + N variants (not 3 × the same matrix). Sizes are
//      unioned so the matrix has every size ordered in any PO.
//   2. ORDER_LINE-level per-PO preservation.
//      Each PO gets its own OrderLine rows with its OWN quantities. Style
//      99103/blue/38 with qty=1 in PO A and qty=2 in PO B produces two
//      OrderLine rows (one per PO), pointing at the SAME item_id.
//
// Output shape:
//   {
//     file:            { …meta from parser (supplier, target manufacturer, …) },
//     season_tag:      'a26',
//     target_manufacturer: 'Oui',
//     orders:          [ { po_number, customer_reference, dates, is_consignment, unit_count_declared, amount_declared, lines: [{ style_ref, color, size, qty, unit_cost }] } ],
//     matrices:        [ { key, style_ref, color_normalized, color_code, description, unit_cost, retail_price,
//                          action: 'create_new' | 'create_with_suffix' | 'complete_existing',
//                          reused_matrix_id: <id|null>,
//                          matrix_description_planned: '99103' | '99103 a26',
//                          existing_variants: [ {size, itemID} ],   // present when complete_existing
//                          variants_to_create: [ {size, qty_across_pos} ],
//                          variants_already_present: [ {size} ],
//                          po_quantities: { <po_number>: { <size>: qty } }
//                        } ],
//     summary:         { totals per action, declared units/amount, warnings }
//     warnings:        [ { code, message, context } ]
//   }
//
// The frontend uses `matrices` for display and `orders` for the "which POs
// will be created" section. The push queue uses:
//   - matrices[*] to know what to POST /ItemMatrix + POST /Item
//   - orders[*].lines cross-referenced with matrices[*].po_quantities to
//     know what OrderLine rows to create under each POST /Order

// Build the preview.
//   parsed:      output of parseOuiEurostyle() (or any parser producing the
//                { file, orders, products } shape).
//   resolutions: Map<style_ref, { status, preferred_matrix_id, matching_matrices }>
//                (from lib/style-resolver.js).
//   opts:
//     season_tag:           string, e.g. 'a26'   — REQUIRED
//     target_manufacturer:  string, e.g. 'Oui'   — for brand-mismatch guard elsewhere
//     color_translations:   optional Map<raw_color, normalized> for override
//                            (parser already emits a normalized string; this
//                             lets the caller override with DB translations).
function buildPreview(parsed, resolutions, opts = {}) {
  if (!parsed?.products) throw new Error('buildPreview: parsed.products required');
  if (!parsed?.orders)   throw new Error('buildPreview: parsed.orders required');
  if (!resolutions)      throw new Error('buildPreview: resolutions Map required');
  if (!opts.season_tag)  throw new Error('buildPreview: opts.season_tag required');

  const seasonTag         = String(opts.season_tag).toLowerCase();
  const targetManufacturer = opts.target_manufacturer || parsed.file?.target_manufacturer || null;
  const colorMap          = opts.color_translations instanceof Map ? opts.color_translations : null;

  const warnings = [];
  const pushWarn = (code, message, context) => warnings.push({ code, message, context });

  // ═══ 1. Build per-PO orders view ══════════════════════════════════════
  // orders[po_number] = { …meta, lines: [ {style_ref, color_normalized, color_code, size, qty, unit_cost} ] }
  // batch_id + selected + batch_status + lightspeed_order_id come through only
  // when the parsed input was rebuilt from DB (rebuildParsedFromDB in the
  // route handler); otherwise these are undefined (parser-only call path).
  const ordersByPO = new Map();
  for (const o of parsed.orders) {
    ordersByPO.set(o.po_number, {
      batch_id:            o.batch_id ?? null,
      po_number:           o.po_number,
      customer_reference:  o.customer_reference,
      order_date:          o.order_date,
      delivery_date:       o.delivery_date,
      cancel_date:         o.cancel_date,
      is_consignment:      !!o.is_consignment,
      unit_count_declared: o.unit_count_declared ?? null,
      amount_declared:     o.amount_declared ?? null,
      selected:            o.selected == null ? true : !!o.selected,
      batch_status:        o.batch_status ?? null,
      lightspeed_order_id: o.lightspeed_order_id ?? null,
      first_page:          o.first_page,
      last_page:           o.last_page,
      lines:               [],
    });
  }

  // ═══ 2. Group products by matrix (style_ref × color_normalized) ═══════
  // matrices[key] = { …meta, po_quantities: { po → { size → qty } } }
  const matrixByKey = new Map();
  const keyFor = (styleRef, colorNormalized) => `${styleRef}|${colorNormalized}`;

  for (const p of parsed.products) {
    const rawColor  = p.color_label;
    // Prefer DB translation if provided; fall back to parser's normalized field.
    const normalizedColor =
      (colorMap && colorMap.get(String(rawColor).toLowerCase()))
      || p.color_normalized
      || rawColor;

    const key = keyFor(p.style_ref, normalizedColor);
    if (!matrixByKey.has(key)) {
      matrixByKey.set(key, {
        key,
        style_ref:        p.style_ref,
        color_code:       p.color_code,
        color_label_raw:  p.color_label,
        color_normalized: normalizedColor,
        description:      p.description,
        unit_cost:        p.unit_cost,
        retail_price:     p.retail_price,
        po_quantities:    {}, // { po_number: { size: qty } }
        sizes_ordered:    new Set(),
      });
    }
    const m = matrixByKey.get(key);

    // Sanity: same key across multiple POs might have different unit_cost.
    // Business rule: shouldn't happen (same style/color = same cost). Warn if it does.
    if (Number(m.unit_cost) !== Number(p.unit_cost)) {
      pushWarn(
        'cost_mismatch_cross_po',
        `${p.style_ref} / ${normalizedColor} has conflicting unit costs: ${m.unit_cost} vs ${p.unit_cost}`,
        { style_ref: p.style_ref, color: normalizedColor, po_number: p.po_number },
      );
    }

    // Feed both the matrix's cross-PO accumulator AND the PO's order-lines list.
    const poBucket = m.po_quantities[p.po_number] ??= {};
    const orderView = ordersByPO.get(p.po_number);
    for (const v of p.variants) {
      poBucket[v.size] = (poBucket[v.size] || 0) + v.qty;
      m.sizes_ordered.add(v.size);
      if (orderView) {
        orderView.lines.push({
          style_ref:        p.style_ref,
          color_normalized: normalizedColor,
          color_code:       p.color_code,
          size:             v.size,
          qty:              v.qty,
          unit_cost:        p.unit_cost,
        });
      } else {
        pushWarn('orphan_product_po', `product references unknown PO ${p.po_number}`, { style_ref: p.style_ref });
      }
    }
  }

  // ═══ 3. Classify each matrix using resolution + planned name/variants ══
  const matrices = [];
  for (const m of matrixByKey.values()) {
    const res = resolutions.get(m.style_ref);
    let action, reused_matrix_id = null, matrix_description_planned = null, existing_variants = [];

    if (!res || res.status === 'error') {
      action = 'error';
      pushWarn('style_resolution_error', `could not resolve style ${m.style_ref}: ${res?.error ?? 'unknown'}`, { style_ref: m.style_ref });
    } else if (res.status === 'new') {
      action = 'create_new';
      matrix_description_planned = m.style_ref;
    } else if (res.status === 'exists_current_season') {
      action = 'complete_existing';
      reused_matrix_id = res.preferred_matrix_id;
      const target = res.matching_matrices.find(mm => mm.matrix_id === reused_matrix_id);
      matrix_description_planned = target?.matrix_description ?? m.style_ref;
      existing_variants = (target?.variants ?? []).map(v => ({
        size:       v.attribute1,
        color_attr: v.attribute2,
        itemID:     v.itemID,
        tags:       v.tags,
      }));
    } else if (res.status === 'exists_other_season') {
      action = 'create_with_suffix';
      matrix_description_planned = `${m.style_ref} ${seasonTag}`;
    }

    // Cross-PO totals per size (dedup at variant level)
    const total_qty_by_size = {};
    for (const [, sizeMap] of Object.entries(m.po_quantities)) {
      for (const [size, qty] of Object.entries(sizeMap)) {
        total_qty_by_size[size] = (total_qty_by_size[size] || 0) + qty;
      }
    }

    // Split into "already there" vs "to create" for complete_existing
    let variants_to_create = [];
    let variants_already_present = [];
    if (action === 'complete_existing') {
      // Match on attribute1 (size). Color is same by construction (same matrix
      // key = same color_normalized, and reused matrix belongs to this style).
      const existingSizes = new Set(existing_variants.map(v => String(v.size)));
      for (const [size, qty_across_pos] of Object.entries(total_qty_by_size)) {
        if (existingSizes.has(String(size))) {
          variants_already_present.push({ size, qty_across_pos });
        } else {
          variants_to_create.push({ size, qty_across_pos });
        }
      }
    } else if (action === 'create_new' || action === 'create_with_suffix') {
      for (const [size, qty_across_pos] of Object.entries(total_qty_by_size)) {
        variants_to_create.push({ size, qty_across_pos });
      }
    }

    matrices.push({
      key:                        m.key,
      style_ref:                  m.style_ref,
      color_normalized:           m.color_normalized,
      color_label_raw:            m.color_label_raw,
      color_code:                 m.color_code,
      description:                m.description,
      unit_cost:                  m.unit_cost,
      retail_price:               m.retail_price,
      action,                     // create_new | create_with_suffix | complete_existing | error
      reused_matrix_id,
      matrix_description_planned,
      existing_variants,
      variants_to_create,
      variants_already_present,
      po_quantities:              m.po_quantities, // { po_number: { size: qty } }
      total_qty:                  Object.values(total_qty_by_size).reduce((s, q) => s + q, 0),
      pos_referenced:             Object.keys(m.po_quantities),
    });
  }

  // ═══ 4. Summary counters ══════════════════════════════════════════════
  const counters = { create_new: 0, create_with_suffix: 0, complete_existing: 0, error: 0 };
  for (const m of matrices) counters[m.action] = (counters[m.action] || 0) + 1;

  const declared_units_total  = parsed.orders.reduce((s, o) => s + (o.unit_count_declared || 0), 0);
  const declared_amount_total = parsed.orders.reduce((s, o) => s + Number(o.amount_declared || 0), 0);
  const summed_units_total    = matrices.reduce((s, m) => s + m.total_qty, 0);
  // We compute BOTH summed totals because different suppliers show different
  // totals on their POs — some show the wholesale cost total, others show
  // the retail total. The LLM extracts whichever is prominent as
  // amount_declared, so we can't assume which one to compare against.
  const summed_cost_total   = matrices.reduce((s, m) => s + (Number(m.unit_cost)    || 0) * m.total_qty, 0);
  const summed_retail_total = matrices.reduce((s, m) => s + (Number(m.retail_price) || 0) * m.total_qty, 0);
  // Keep the legacy name as an alias for backward-compat with any UI code
  // that reads summary.summed_amount_total.
  const summed_amount_total = summed_cost_total;

  const summary = {
    order_count:            parsed.orders.length,
    matrix_count:           matrices.length,
    variants_to_create:     matrices.reduce((s, m) => s + m.variants_to_create.length, 0),
    variants_already:       matrices.reduce((s, m) => s + m.variants_already_present.length, 0),
    counters,
    declared_units_total,
    declared_amount_total,
    summed_units_total,
    summed_amount_total: Number(summed_amount_total.toFixed(2)),
    summed_cost_total:   Number(summed_cost_total.toFixed(2)),
    summed_retail_total: Number(summed_retail_total.toFixed(2)),
    units_match:            summed_units_total === declared_units_total,
  };
  if (!summary.units_match) {
    pushWarn(
      'units_mismatch_parser_vs_declared',
      `parser summed ${summed_units_total} units but PDF declares ${declared_units_total}`,
      { summed: summed_units_total, declared: declared_units_total },
    );
  }

  // ═══ Merge parser warnings into the output warnings so the UI can render
  //    them (they were previously discarded). Prefix `code` with 'parser_'
  //    to keep them distinguishable from preview-generator's own warnings.
  const parserWarnings = parsed.warnings || [];
  for (const pw of parserWarnings) {
    warnings.push({
      code:    'parser_' + (pw.type || 'unknown'),
      message: pw.detail || pw.msg || JSON.stringify(pw),
      context: pw,
    });
  }

  // ═══ Completeness assessment — blocking flag ═══════════════════════════
  const completeness = assessCompleteness({
    products:              parsed.products,
    parserWarnings,
    declared_units_total,
    summed_units_total,
    declared_amount_total,
    summed_cost_total,
    summed_retail_total,
    thresholds:            opts.validation_thresholds || VALIDATION_THRESHOLDS,
    // LLM-only inputs: caller must pass extraction_source='llm' + rawText
    // to enable per-size validation. Recipe path leaves them undefined and
    // the new check is skipped entirely — zero impact on Oui/Bugatchi.
    extraction_source:     opts.extraction_source || parsed.extraction_source || 'recipe',
    rawText:               opts.rawText,
  });
  summary.incomplete             = completeness.incomplete;
  summary.incomplete_reasons     = completeness.reasons;
  summary.validation_thresholds  = completeness.thresholds;
  summary.extraction_stats       = completeness.stats;

  return {
    file:                parsed.file || {},
    season_tag:          seasonTag,
    target_manufacturer: targetManufacturer,
    orders:              [...ordersByPO.values()],
    matrices,
    summary,
    warnings,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// assessCompleteness — the gating function. Returns:
//   {
//     incomplete: boolean,                  // true if ANY threshold breached
//     reasons:    [{code, actual, threshold, description}],
//     stats:      { attempted, successful, skipped, qty_mismatched,
//                   units_ratio, qty_mismatch_ratio, skipped_ratio }
//   }
//
// A "skipped" product is one the parser attempted but dropped without
// emitting to products[] — these show up as warnings with types
// no_size_header | no_variants_source | no_variants_matched.
//
// A "qty_mismatch" product IS emitted (in products[]) but its variant sum
// differs from the row-level declared qty — a strong signal that some
// size cells were missed on that line.
// ─────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────
// SIZE-MISMATCH DETECTION (LLM-only defence)
//
// Recipe extractions anchor qtys to size headers by x-coordinate — they
// literally cannot get columns mixed up. LLM extractions read text
// sequentially; when a header is "1 2 3 4 5 6 7" and the qty row is
// "- 1 1 1 1 - -", an LLM may correctly count 4 units total but assign
// them to sizes {1,2,3,4} instead of the correct {2,3,4,5}. This
// silent shift is invisible to units_ratio checks.
//
// The two helpers below reconstruct the size-header ↔ qty-position mapping
// from RAW TEXT (which the LLM caller must pass) and cross-check the LLM's
// variant sizes against that ground truth. Used only when
// extraction_source === 'llm'.
// ─────────────────────────────────────────────────────────────────────────

// Detect any line in the raw text that contains a contiguous run of size
// tokens. A "run" is ≥3 consecutive tokens matching the size pattern.
// This catches headers embedded in wider column-title lines like Marc Cain's
// `article description col SL 1 2 3 4 5 6 7 qua. pp RRP price` — the run
// `1 2 3 4 5 6 7` is what matters, not the ratio of size tokens over the
// full line.
// Returns [{ lineIdx, sizes, runStart, runEnd, allTokens }].
function extractExpectedSizes(rawText) {
  if (!rawText) return [];
  const sizeTokenRe = /^(?:\d{1,3}|XXS|XS|S|M|L|XL|XXL|XXXL|OS|ONE|U|TU|UNI)$/i;
  const lines = rawText.split('\n');
  const headers = [];
  for (let i = 0; i < lines.length; i++) {
    const tokens = lines[i].trim().split(/\s+/).filter(Boolean);
    if (tokens.length < 3) continue;
    // Find the longest contiguous run of size-like tokens
    let bestStart = -1, bestLen = 0, curStart = -1, curLen = 0;
    for (let j = 0; j < tokens.length; j++) {
      if (sizeTokenRe.test(tokens[j])) {
        if (curStart === -1) curStart = j;
        curLen++;
        if (curLen > bestLen) { bestStart = curStart; bestLen = curLen; }
      } else {
        curStart = -1;
        curLen = 0;
      }
    }
    if (bestLen >= 3) {
      const run = tokens.slice(bestStart, bestStart + bestLen);
      // Reject monotonous runs (e.g. a qty row "1 1 1 1" looking like a header).
      // A real size header has ≥3 DISTINCT values.
      const uniqueVals = new Set(run.map(s => String(s).toLowerCase()));
      if (uniqueVals.size < 3) continue;
      headers.push({
        lineIdx:   i,
        sizes:     run,
        runStart:  bestStart,
        runEnd:    bestStart + bestLen,
        allTokens: tokens,
      });
    }
  }
  return headers;
}

// For each LLM-emitted product, try to locate its raw text row (by style_ref
// substring), find the closest size header ABOVE it, and cross-check that
// LLM variant sizes correspond to the NON-NULL POSITIONS in the raw qty
// tokens.
//
// The check catches the Marc Cain-style "off by N" column shift: 4 non-null
// positions at raw indices [1,2,3,4] correspond to header sizes [2,3,4,5],
// but an LLM that just counts non-nulls left-to-right will emit [1,2,3,4].
//
// Products whose raw row cannot be located are skipped from the check (not
// counted in the ratio). The check is heuristic and conservative — false
// positives are acceptable (they just force operator review) but a false
// negative would hide the exact bug we're trying to catch.
function validateLlmSizes(products, rawText) {
  const headers = extractExpectedSizes(rawText);
  if (!products?.length || !headers.length) return { suspected: [], considered: 0, headers_found: headers.length };

  const lines = rawText.split('\n');
  const qtyTokenRe = /^(?:-|\d{1,2})$/;
  const suspected = [];
  let considered = 0;

  for (const product of products) {
    const styleRef = product?.style_ref;
    if (!styleRef) continue;

    // Find the product's raw row (first line containing the exact style_ref)
    const productLineIdx = lines.findIndex(l => l.includes(styleRef));
    if (productLineIdx === -1) continue;

    // Find the closest header ABOVE this product row
    const applicableHeader = [...headers].reverse().find(h => h.lineIdx < productLineIdx);
    if (!applicableHeader) continue;

    considered++;
    const productLine = lines[productLineIdx].trim();
    const productTokens = productLine.split(/\s+/);

    // Search a contiguous run of qty tokens (either digits ≤2 or "-")
    // whose length equals the header's size count. That run should be the
    // qty section aligned with the header positions.
    const headerLen = applicableHeader.sizes.length;
    let qtyRunStart = -1, qtyRunLen = 0;
    for (let j = 0; j < productTokens.length; j++) {
      if (qtyTokenRe.test(productTokens[j])) {
        if (qtyRunStart === -1) qtyRunStart = j;
        qtyRunLen++;
        if (qtyRunLen === headerLen) break;
      } else if (qtyRunStart !== -1) {
        // Broken run — reset
        qtyRunStart = -1;
        qtyRunLen = 0;
      }
    }

    if (qtyRunStart === -1 || qtyRunLen < headerLen) {
      // Row doesn't fit the expected qty pattern — skip (don't flag, don't count)
      considered--;
      continue;
    }

    const qtySlice = productTokens.slice(qtyRunStart, qtyRunStart + headerLen);
    const expectedSizes = [];
    for (let j = 0; j < qtySlice.length; j++) {
      const v = qtySlice[j];
      if (v !== '-' && v !== '' && parseInt(v, 10) > 0) {
        expectedSizes.push(String(applicableHeader.sizes[j]));
      }
    }

    const llmSizes = (product.variants || []).map(v => String(v.size));
    const llmSorted = [...llmSizes].sort();
    const expSorted = [...expectedSizes].sort();

    const mismatch = llmSorted.length !== expSorted.length
                  || llmSorted.some((s, i) => s !== expSorted[i]);

    if (mismatch) {
      suspected.push({
        style_ref:      styleRef,
        llm_sizes:      llmSizes,
        expected_sizes: expectedSizes,
        header:         applicableHeader.sizes,
        raw_row:        productLine.slice(0, 180),
      });
    }
  }

  return { suspected, considered, headers_found: headers.length };
}

function assessCompleteness({ products, parserWarnings, declared_units_total, summed_units_total, declared_amount_total, summed_cost_total, summed_retail_total, thresholds, extraction_source, rawText }) {
  const successful    = products.length;
  const skipTypes     = new Set(['no_size_header', 'no_variants_source', 'no_variants_matched']);
  const skippedList   = parserWarnings.filter(w => skipTypes.has(w.type));
  const skipped       = skippedList.length;
  const attempted     = successful + skipped;
  const qtyMismatched = parserWarnings.filter(w => w.type === 'qty_mismatch').length;

  const units_ratio        = declared_units_total > 0 ? summed_units_total / declared_units_total : null;
  const qty_mismatch_ratio = successful > 0            ? qtyMismatched      / successful           : 0;
  const skipped_ratio      = attempted > 0             ? skipped            / attempted            : 0;

  const reasons = [];

  // 1. Units ratio — only checked when we HAVE a declared total to compare with
  if (units_ratio !== null && units_ratio < thresholds.min_units_ratio) {
    reasons.push({
      code:        'units_below_threshold',
      actual:      Number(units_ratio.toFixed(4)),
      threshold:   thresholds.min_units_ratio,
      extracted:   summed_units_total,
      declared:    declared_units_total,
      missing:     declared_units_total - summed_units_total,
      description: `Seulement ${summed_units_total}/${declared_units_total} unités extraites (${Math.round(units_ratio * 100)}%). Il en manque ${declared_units_total - summed_units_total}.`,
    });
  }

  // 2. Qty mismatch ratio
  if (qty_mismatch_ratio > thresholds.max_qty_mismatch_ratio) {
    reasons.push({
      code:        'too_many_qty_mismatch',
      actual:      Number(qty_mismatch_ratio.toFixed(4)),
      threshold:   thresholds.max_qty_mismatch_ratio,
      count:       qtyMismatched,
      of:          successful,
      description: `${qtyMismatched}/${successful} produits ont une quantité extraite qui ne correspond pas au total déclaré de leur ligne (${Math.round(qty_mismatch_ratio * 100)}%).`,
    });
  }

  // 3. Skipped ratio (products dropped entirely).
  //    When declared_units_total === 0 the units_ratio check above is
  //    skipped, so skipped_ratio is our ONLY signal of completeness — we
  //    tighten the bound to catch marginal drops. The chosen threshold is
  //    reported back in the reason so the operator knows which was applied.
  const hasDeclared = declared_units_total > 0;
  const skippedThreshold = hasDeclared
    ? thresholds.max_skipped_ratio
    : thresholds.max_skipped_ratio_no_declared;
  if (skipped_ratio > skippedThreshold) {
    const breakdown = {};
    for (const w of skippedList) {
      breakdown[w.type] = (breakdown[w.type] || 0) + 1;
    }
    const breakdownStr = Object.entries(breakdown)
      .map(([k, n]) => `${k}=${n}`).join(', ');
    reasons.push({
      code:                       'too_many_skipped',
      actual:                     Number(skipped_ratio.toFixed(4)),
      threshold:                  skippedThreshold,
      stricter_no_declared_total: !hasDeclared,
      base_threshold:             thresholds.max_skipped_ratio,
      count:                      skipped,
      of:                         attempted,
      breakdown,
      description: `${skipped}/${attempted} produits ignorés par le parseur (${Math.round(skipped_ratio * 100)}%, seuil ${Math.round(skippedThreshold * 100)}%${hasDeclared ? '' : ' — plus strict car aucun total déclaré à croiser'}). Causes: ${breakdownStr}.`,
    });
  }

  // 4. Cost/amount deviation — the declared_amount_total from the PDF may be
  //    either the WHOLESALE COST total OR the RETAIL total depending on the
  //    supplier's format (Oui/Bugatchi print cost; Numph/Fradi print retail).
  //    We don't force the LLM to guess which — we accept whichever total the
  //    PDF happened to show and check if it matches EITHER our summed cost OR
  //    our summed retail within the threshold. Only trigger when it matches
  //    neither (real signal that unit_cost or retail_price was misread).
  let cost_deviation = null;
  if (declared_amount_total > 0) {
    const cost_deviation_vs_cost   = summed_cost_total   > 0 ? Math.abs(summed_cost_total   - declared_amount_total) / declared_amount_total : Infinity;
    const cost_deviation_vs_retail = summed_retail_total > 0 ? Math.abs(summed_retail_total - declared_amount_total) / declared_amount_total : Infinity;
    cost_deviation = Math.min(cost_deviation_vs_cost, cost_deviation_vs_retail);
    if (cost_deviation > thresholds.max_cost_ratio_deviation) {
      // Report both comparisons in the reason so the operator sees why.
      const bestMatchLabel = cost_deviation_vs_cost < cost_deviation_vs_retail
        ? `coût (${summed_cost_total.toFixed(2)}$)`
        : `retail (${summed_retail_total.toFixed(2)}$)`;
      reasons.push({
        code:        'cost_deviation_over_threshold',
        actual:      Number(cost_deviation.toFixed(4)),
        threshold:   thresholds.max_cost_ratio_deviation,
        declared:    Number(declared_amount_total.toFixed(2)),
        summed_cost:   Number(summed_cost_total.toFixed(2)),
        summed_retail: Number(summed_retail_total.toFixed(2)),
        best_match:  bestMatchLabel,
        description: `Total déclaré ${declared_amount_total.toFixed(2)}$ ne matche ni le total coût (${summed_cost_total.toFixed(2)}$) ni le total retail (${summed_retail_total.toFixed(2)}$). Meilleur match : ${bestMatchLabel} à ${Math.round(cost_deviation * 100)}% d'écart (seuil ${Math.round(thresholds.max_cost_ratio_deviation * 100)}%). Un ou plusieurs unit_cost ou retail_price sont probablement erronés.`,
      });
    }
  }

  // 5. Size-mismatch — LLM extractions ONLY. Recipe path anchors qtys to
  //    headers by coordinate, so this check is skipped there entirely.
  let size_validation = null;
  if (extraction_source === 'llm' && rawText) {
    size_validation = validateLlmSizes(products, rawText);
    const size_mismatch_ratio = size_validation.considered > 0
      ? size_validation.suspected.length / size_validation.considered
      : 0;
    if (size_mismatch_ratio > thresholds.max_size_mismatch_ratio) {
      reasons.push({
        code:        'size_mismatch_suspected',
        actual:      Number(size_mismatch_ratio.toFixed(4)),
        threshold:   thresholds.max_size_mismatch_ratio,
        suspected:   size_validation.suspected.length,
        considered:  size_validation.considered,
        headers_found: size_validation.headers_found,
        samples:     size_validation.suspected.slice(0, 5),
        description: `${size_validation.suspected.length}/${size_validation.considered} produits présentent une attribution de tailles suspecte (${Math.round(size_mismatch_ratio * 100)}%, seuil ${Math.round(thresholds.max_size_mismatch_ratio * 100)}%). Cause probable : décalage de colonne dans la lecture LLM du tableau tailles.`,
      });
    }
  }

  return {
    incomplete: reasons.length > 0,
    reasons,
    thresholds,
    stats: {
      attempted, successful, skipped, qty_mismatched: qtyMismatched,
      units_ratio, qty_mismatch_ratio, skipped_ratio,
      size_validation,
    },
  };
}

module.exports = { buildPreview, assessCompleteness, VALIDATION_THRESHOLDS, extractExpectedSizes, validateLlmSizes };
