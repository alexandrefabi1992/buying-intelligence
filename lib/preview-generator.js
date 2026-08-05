'use strict';
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

  const summary = {
    order_count:            parsed.orders.length,
    matrix_count:           matrices.length,
    variants_to_create:     matrices.reduce((s, m) => s + m.variants_to_create.length, 0),
    variants_already:       matrices.reduce((s, m) => s + m.variants_already_present.length, 0),
    counters,
    declared_units_total,
    declared_amount_total,
    summed_units_total,
    units_match:            summed_units_total === declared_units_total,
  };
  if (!summary.units_match) {
    pushWarn(
      'units_mismatch_parser_vs_declared',
      `parser summed ${summed_units_total} units but PDF declares ${declared_units_total}`,
      { summed: summed_units_total, declared: declared_units_total },
    );
  }

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

module.exports = { buildPreview };
