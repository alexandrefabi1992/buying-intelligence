'use strict';
// Generic recipe-driven PDF parser (Week 1 of Option 2).
//
// One engine, many suppliers. A recipe is a JSONB object stored in
// parse_recipes.layout. Its structure — validated at execution time —
// tells the engine WHERE to find fields, HOW to split into orders,
// and WHAT layout to use for products (size_grid, flat_table, …).
//
// ═══ RECIPE FORMAT REFERENCE ═══════════════════════════════════════════
//
// {
//   version: 1,
//   meta: {
//     supplier_key:             'oui-eurostyle',
//     target_manufacturer:      'Oui',
//     default_vendor_id:        '70',
//     default_attribute_set_id: '5'
//   },
//   detection: {
//     match_all: ['LYS1R', 'No\\.?\\s*Commande'],  // ALL regexes must appear in the file text
//     match_any: ['EUROSTYLE', 'Steilmann']         // AT LEAST ONE must appear
//   },
//   extraction: {
//     engine:      'coordinate',
//     tolerances:  { y_pt: 3, x_pt: 8 },
//     parser:      null,        // ⚠ ESCAPE HATCH — see below
//     file_fields: { … },       // fields extracted from the whole file (once)
//     orders:      { … },       // how to detect orders + their fields
//     products:    { … }        // how to find product rows + variants
//   }
// }
//
// ═══ ESCAPE HATCH — `extraction.parser` ═══════════════════════════════
//
// If a supplier's format truly cannot be expressed declaratively, set
// `extraction.parser` to the name of a JS function registered via
// `registerCustomParser(name, fn)`. The engine delegates to that function
// instead of running the declarative pipeline.
//
// This is an ADMISSION OF FAILURE, not a normal solution. Every use is:
//   - loudly console.warn'd with a "⚠ ESCAPE HATCH" prefix
//   - counted globally per-process (getEscapeHatchStats())
//   - a signal that the declarative format must be extended
//
// If a recipe permanently depends on the escape hatch, the layout is
// missing an expressiveness feature — fix the engine, not the recipe.
//
// ═══ FAIL LOUDLY ═══════════════════════════════════════════════════════
//
// The engine refuses to return partial results. It throws
// `RecipeExecutionError` with a clear code when:
//   - detection rules don't match the file             (detection_mismatch)
//   - the recipe is malformed                          (invalid_recipe)
//   - no orders are detected                           (zero_orders)
//   - no products are extracted                        (zero_products)
//   - a required field cannot be resolved              (missing_required_field)
//   - the size-grid header cannot be found for a page
//     containing product rows                          (missing_size_header)
//   - the recipe uses an unsupported feature           (unsupported_*)

const { getDocument } = require('pdfjs-dist/legacy/build/pdf.mjs');

// ─────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────
class RecipeExecutionError extends Error {
  constructor(message, { code, context } = {}) {
    super(message);
    this.name = 'RecipeExecutionError';
    this.code = code || 'unknown';
    this.context = context || null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Custom parser registry (escape hatch)
// ─────────────────────────────────────────────────────────────────────────
const _customParsers = new Map();
const _escapeHatchStats = { total_uses: 0, per_recipe: {} };

function registerCustomParser(name, fn) {
  if (typeof name !== 'string' || !name) throw new Error('registerCustomParser: name required');
  if (typeof fn !== 'function')          throw new Error('registerCustomParser: fn must be a function');
  _customParsers.set(name, fn);
}
function getEscapeHatchStats() {
  return { total_uses: _escapeHatchStats.total_uses, per_recipe: { ..._escapeHatchStats.per_recipe } };
}
function _reportEscapeHatch(recipe) {
  const supplier = recipe?.meta?.supplier_key ?? '(unknown)';
  const name = recipe?.extraction?.parser ?? '(no name)';
  _escapeHatchStats.total_uses++;
  _escapeHatchStats.per_recipe[supplier] = (_escapeHatchStats.per_recipe[supplier] || 0) + 1;
  console.warn(
    `[generic-recipe] ⚠ ESCAPE HATCH: recipe "${supplier}" uses custom parser "${name}". ` +
    `Total uses this process: ${_escapeHatchStats.total_uses}. ` +
    `If this recipe permanently needs a custom parser, extend the declarative format ` +
    `so future recipes don't need one.`
  );
}

// ─────────────────────────────────────────────────────────────────────────
// PDF extraction — copied from oui-eurostyle.js so the two parsers are
// fully independent during the transition. Will be shared once the old
// parser is retired.
// ─────────────────────────────────────────────────────────────────────────
async function extractWords(pdfBuffer) {
  const loadingTask = getDocument({ data: new Uint8Array(pdfBuffer), disableWorker: true });
  const doc = await loadingTask.promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const words = content.items.map(it => {
      const tx = it.transform;
      const x  = tx[4];
      const yTop = viewport.height - tx[5] - it.height;
      return {
        text:   it.str,
        x0:     x,
        y0:     yTop,
        width:  it.width,
        height: it.height,
        x1:     x + it.width,
        yc:     yTop + it.height / 2,
        xc:     x + it.width / 2,
      };
    }).filter(w => w.text.trim() !== '');
    pages.push({ pageNum: p, width: viewport.width, height: viewport.height, words });
  }
  return pages;
}

function wordsToLines(words, yTolerance = 3) {
  const sorted = [...words].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const lines = [];
  for (const w of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(w.y0 - last.y0) < yTolerance) {
      last.words.push(w);
    } else {
      lines.push({ y0: w.y0, words: [w] });
    }
  }
  for (const line of lines) {
    line.words.sort((a, b) => a.x0 - b.x0);
    line.text = line.words.map(w => w.text).join(' ');
  }
  return lines;
}

// ─────────────────────────────────────────────────────────────────────────
// Transforms library — named string transformations referenceable from
// a recipe via `"transform": "name"`. Adding a new transform here makes
// it available to every recipe.
// ─────────────────────────────────────────────────────────────────────────
const TRANSFORMS = {
  // "01/22/2026" → "2026-01-22"
  date_mdy_to_iso(v) {
    if (v == null) return null;
    const m = String(v).replace(/\s/g, '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
  },
  // "42" → 42 (integer)
  int(v) {
    if (v == null || v === '') return null;
    const n = parseInt(String(v).replace(/[^\d\-]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  },
  // "16,273.40" → 16273.40 (comma stripped as thousand separator)
  decimal(v) {
    if (v == null || v === '') return null;
    const n = parseFloat(String(v).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  },
  // Trim + collapse whitespace
  trim(v) {
    return v == null ? null : String(v).trim().replace(/\s+/g, ' ');
  },
  // Identity
  none(v) { return v; },
};

function applyTransform(value, transformName) {
  if (!transformName || transformName === 'none') return value;
  const fn = TRANSFORMS[transformName];
  if (!fn) throw new RecipeExecutionError(
    `Unknown transform "${transformName}" — allowed: ${Object.keys(TRANSFORMS).join(', ')}`,
    { code: 'unsupported_transform' }
  );
  return fn(value);
}

// ─────────────────────────────────────────────────────────────────────────
// Field matching primitives — one function per `source` type.
// ─────────────────────────────────────────────────────────────────────────

// Match a field definition against a set of lines (one order's pages worth).
// Returns the extracted value, or null if not found.
function matchFieldOnLines(lines, fieldDef) {
  if (!fieldDef?.regex) throw new RecipeExecutionError(
    `Field definition missing regex: ${JSON.stringify(fieldDef)}`,
    { code: 'invalid_recipe' }
  );
  const re = new RegExp(fieldDef.regex, fieldDef.flags || '');
  const group = fieldDef.group ?? 0;
  for (const line of lines) {
    const m = line.text.match(re);
    if (m) return applyTransform(m[group], fieldDef.transform);
  }
  return null;
}

// Match against full-text (all words on all pages joined) — for detection.
// Defensive: accepts both new format (array of strings) and legacy format
// (array of {regex, where} objects) so pre-S1 DB rows don't silently match
// EVERY document via the /[object Object]/i character-class quirk.
function _asRegexStr(x) {
  if (x == null) return null;
  if (typeof x === 'string') return x;
  if (typeof x === 'object' && typeof x.regex === 'string') return x.regex;
  throw new RecipeExecutionError(
    `Detection pattern must be a string or {regex} object, got ${JSON.stringify(x)}`,
    { code: 'invalid_recipe' }
  );
}
function textMatchesAll(fullText, regexes) {
  return regexes.every(r => new RegExp(_asRegexStr(r), 'i').test(fullText));
}
function textMatchesAny(fullText, regexes) {
  return regexes.some(r => new RegExp(_asRegexStr(r), 'i').test(fullText));
}

// ─────────────────────────────────────────────────────────────────────────
// Detection
// ─────────────────────────────────────────────────────────────────────────
function checkDetection(pages, detection) {
  if (!detection) return true; // no detection rules → always match
  const fullText = pages.map(p => p.words.map(w => w.text).join(' ')).join('\n');
  const okAll = !detection.match_all || textMatchesAll(fullText, detection.match_all);
  const okAny = !detection.match_any || textMatchesAny(fullText, detection.match_any);
  return okAll && okAny;
}

// ─────────────────────────────────────────────────────────────────────────
// Order splitting
//
// If `orders.order_split` is ABSENT → the whole file is a single order.
// Mono-order is the default because it's the most common case.
//
// If `orders.order_split` is PRESENT, it declares HOW a file with multiple
// orders is split:
//
//   {
//     "marker":             "No\\.?\\s*Commande",   // informative regex — what to look for
//                                                    // (may be used by the mapping UI to
//                                                    //  highlight boundaries). The engine
//                                                    //  actually uses `split_field`.
//     "split_field":        "po_number",             // field name (must exist in orders.fields)
//                                                    // whose extracted VALUE changing marks a
//                                                    //  new order.
//     "boundary_strategy":  "page_break_on_change"   // how the boundary works.
//                                                    // Currently supported:
//                                                    //   page_break_on_change — a page whose
//                                                    //   split_field differs from the running
//                                                    //   value starts a new order group.
//   }
// ─────────────────────────────────────────────────────────────────────────
function splitPagesIntoOrders(pages, ordersConfig, tolerances) {
  const os = ordersConfig?.order_split;

  // ─── MONO-order path (default when order_split is absent) ─────────────
  if (!os) {
    const allLines = [];
    for (const page of pages) {
      allLines.push(...wordsToLines(page.words, tolerances.y_pt));
    }
    return [{
      first_page: pages[0]?.pageNum ?? 1,
      last_page:  pages[pages.length - 1]?.pageNum ?? 1,
      page_nums:  pages.map(p => p.pageNum),
      _pages:     pages,
      _lines:     allLines,
    }];
  }

  // ─── MULTI-order path ─────────────────────────────────────────────────
  const boundaryStrategy = os.boundary_strategy;
  if (boundaryStrategy !== 'page_break_on_change') {
    throw new RecipeExecutionError(
      `Unsupported order_split.boundary_strategy "${boundaryStrategy}" — supported: page_break_on_change`,
      { code: 'unsupported_boundary_strategy' }
    );
  }
  const splitFieldName = os.split_field;
  const splitFieldDef  = ordersConfig.fields?.[splitFieldName];
  if (!splitFieldDef) throw new RecipeExecutionError(
    `order_split.split_field "${splitFieldName}" is not defined in orders.fields`,
    { code: 'invalid_recipe' }
  );

  const groups = new Map();
  let currentValue = null;
  for (const page of pages) {
    const lines = wordsToLines(page.words, tolerances.y_pt);
    const pageValue = matchFieldOnLines(lines, splitFieldDef);
    if (pageValue && pageValue !== currentValue) currentValue = pageValue;
    if (!currentValue) continue; // page has no value and no prior — skip until we find one
    if (!groups.has(currentValue)) {
      groups.set(currentValue, {
        [splitFieldName]: currentValue,
        first_page: page.pageNum,
        last_page:  page.pageNum,
        page_nums:  [page.pageNum],
        _pages:     [page],
        _lines:     [...lines],
      });
    } else {
      const g = groups.get(currentValue);
      g.last_page = page.pageNum;
      g.page_nums.push(page.pageNum);
      g._pages.push(page);
      g._lines.push(...lines);
    }
  }
  return [...groups.values()];
}

// ─────────────────────────────────────────────────────────────────────────
// Order metadata extraction
//
// For each order group, iterate its lines and try to match each field.
// First match wins per field. Also computes is_consignment if configured.
// ─────────────────────────────────────────────────────────────────────────
function extractOrderMeta(orderGroup, ordersConfig) {
  const meta = {};
  for (const [name, fieldDef] of Object.entries(ordersConfig.fields)) {
    meta[name] = matchFieldOnLines(orderGroup._lines, fieldDef);
  }
  if (ordersConfig.is_consignment_from) {
    const { field, regex, flags } = ordersConfig.is_consignment_from;
    const src = meta[field] ?? '';
    meta.is_consignment = new RegExp(regex, flags || '').test(src);
  } else {
    meta.is_consignment = false;
  }
  return meta;
}

// ─────────────────────────────────────────────────────────────────────────
// Product extraction — size_grid dispatcher
//
// For each page:
//   1. Find size-header lines matching the header_prefix (e.g. "CA")
//      and extract the size tokens with their x-centers.
//   2. Find product-header lines matching row_header.regex.
//   3. For each product header, locate the size header applicable to it
//      (most recent header ABOVE the product line).
//   4. Find the qty row (position: next_line_below within y-gap bounds).
//   5. Match each qty token to a size by x-center alignment (x_pt tolerance).
//   6. Emit the product with variants.
// ─────────────────────────────────────────────────────────────────────────
function parseSizeHeader(line, sizeGridConfig) {
  const prefix = sizeGridConfig.header_prefix;
  const trimmed = line.text.trim();
  if (prefix && !new RegExp(`^${prefix}\\s+`).test(trimmed)) return null;
  const tokenRe = new RegExp(`^(?:${sizeGridConfig.header_token_pattern})$`);
  const tokens = line.words.filter(w => tokenRe.test(w.text));
  if (tokens.length === 0) return null;
  return {
    sizes: tokens.map(t => ({ label: t.text, xc: t.xc })),
    lineY: line.y0,
  };
}

function findApplicableHeader(headers, productY) {
  const candidates = headers.filter(h => h.lineY < productY);
  return candidates.length ? candidates[candidates.length - 1] : null;
}

function matchQtysToSizes(header, qtyRow, sizeGridConfig, xTolerance) {
  const pattern = sizeGridConfig.qty_token_pattern || '\\d+';
  const maxVal = sizeGridConfig.qty_max_value ?? Infinity;
  const re = new RegExp(`^${pattern}$`);
  const qtyTokens = qtyRow.words.filter(w => re.test(w.text) && parseInt(w.text, 10) < maxVal);
  const out = [];
  for (const q of qtyTokens) {
    const size = header.sizes.find(s => Math.abs(q.xc - s.xc) < xTolerance);
    if (size) out.push({ size: size.label, qty: parseInt(q.text, 10) });
  }
  return out;
}

// Apply the row_header regex and trailing_metrics regex to a line,
// return a product meta object with declared cost/qty/retail.
function extractProductRowMeta(line, productsConfig) {
  const rh = productsConfig.row_header;
  const rhRe = new RegExp(rh.regex, rh.flags || '');
  const m = line.text.match(rhRe);
  if (!m) return null;

  const meta = {};
  // Base fields from row_header
  for (const [name, def] of Object.entries(rh.fields || {})) {
    meta[name] = m[def.group ?? 0];
  }

  // Trailing metrics (cost, total qty, retail, line total)
  if (rh.trailing_metrics) {
    const tm = rh.trailing_metrics;
    const tmRe = new RegExp(tm.regex, tm.flags || '');
    const tmMatch = line.text.match(tmRe);
    if (tmMatch) {
      for (const [name, def] of Object.entries(tm.fields || {})) {
        meta[name] = applyTransform(tmMatch[def.group ?? 0], def.transform);
      }
    }
    // Preserve raw match for downstream color/description splitting
    meta._trailing_match = tmMatch;
  }

  meta._line = line;
  return meta;
}

// Color / description splitter — currently the only implementation is
// oui-eurostyle's "case_heuristic_with_price_split" which is Oui-specific.
// If added transforms are needed for other suppliers, register them here.
function splitColorAndDescription(meta, productsConfig) {
  const splitConfig = productsConfig.row_header?.fields?.color_and_description?.split;
  if (!splitConfig) {
    // No split configured — nothing to do; caller keeps whatever fields exist.
    return {};
  }
  const raw = meta.color_and_description ?? '';
  const trailingMatch = meta._trailing_match;

  if (splitConfig === 'case_heuristic_with_price_split') {
    // Oui-specific: description may live before OR after the price block.
    // Colors are lowercase words, description starts at first Capitalized.
    if (!trailingMatch) {
      // No price block — assume the whole thing is color
      return { color_label: String(raw).trim(), description: '' };
    }
    const priceLiteral = trailingMatch[0];
    const beforePrice = raw.slice(0, raw.indexOf(priceLiteral)).trim();
    const afterPrice  = raw.slice(raw.indexOf(priceLiteral) + priceLiteral.length).trim();
    const bpParts = beforePrice.split(/\s+/).filter(Boolean);
    const firstCap = bpParts.findIndex(w => /^[A-Z]/.test(w));
    let colorLabel = '', description = '';
    if (firstCap === -1) {
      colorLabel = beforePrice;
      description = afterPrice;
    } else if (firstCap === 0) {
      colorLabel = '';
      description = beforePrice;
    } else {
      colorLabel = bpParts.slice(0, firstCap).join(' ');
      description = bpParts.slice(firstCap).join(' ');
    }
    if (!description && afterPrice) description = afterPrice;
    return { color_label: colorLabel, description };
  }

  throw new RecipeExecutionError(
    `Unknown color_and_description split mode "${splitConfig}"`,
    { code: 'unsupported_split_transform' }
  );
}

function normalizeColor(label, code) {
  if (!label) return code ? code : '';
  const cap = label.charAt(0).toUpperCase() + label.slice(1).toLowerCase();
  return code ? `${cap}-${code}` : cap;
}

function extractProductsFromPage(page, productsConfig, tolerances, warnings) {
  if (productsConfig.layout_type === 'flat_table') {
    return extractFlatTableProducts(page, productsConfig, tolerances, warnings);
  }
  if (productsConfig.layout_type !== 'size_grid') {
    throw new RecipeExecutionError(
      `Unsupported layout_type "${productsConfig.layout_type}" — supported: size_grid, flat_table`,
      { code: 'unsupported_layout_type' }
    );
  }

  const sg = productsConfig.size_grid;
  if (!sg) throw new RecipeExecutionError(
    `layout_type=size_grid requires products.size_grid config`,
    { code: 'invalid_recipe' }
  );

  const lines = wordsToLines(page.words, tolerances.y_pt);
  const headers = [];
  for (const line of lines) {
    const h = parseSizeHeader(line, sg);
    if (h) headers.push(h);
  }

  const products = [];
  const minGap = sg.qty_row?.min_y_gap_pt ?? 3;
  const maxGap = sg.qty_row?.max_y_gap_pt ?? 25;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const meta = extractProductRowMeta(line, productsConfig);
    if (!meta) continue;

    const header = findApplicableHeader(headers, line.y0);
    if (!header) {
      warnings.push({
        type: 'no_size_header',
        page: page.pageNum,
        style: meta.style_ref,
        detail: `No size header found above product line at y=${line.y0}`,
      });
      continue;
    }
    const qtyRow = lines[i + 1];
    if (!qtyRow) continue;
    const gap = qtyRow.y0 - line.y0;
    if (gap < minGap || gap > maxGap) continue;

    const variants = matchQtysToSizes(header, qtyRow, sg, tolerances.x_pt);
    const total = variants.reduce((s, v) => s + v.qty, 0);
    if (meta.total_qty_declared != null && total !== meta.total_qty_declared) {
      warnings.push({
        type: 'qty_mismatch',
        page: page.pageNum,
        style: meta.style_ref,
        declared: meta.total_qty_declared,
        summed: total,
        variants,
      });
    }

    // Split color / description (Oui-specific transform for now)
    const cd = splitColorAndDescription(meta, productsConfig);

    // Assemble the final product shape (matching parseOuiEurostyle output)
    const product = {
      style_ref:        meta.style_ref ?? null,
      collection:       meta.collection ?? null,
      color_code:       meta.color_code ?? null,
      color_label:      cd.color_label ?? '',
      color_normalized: normalizeColor(cd.color_label ?? '', meta.color_code),
      description:      cd.description ?? '',
      unit_cost:        meta.unit_cost ?? null,
      retail_price:     meta.retail_price ?? null,
      total_qty_declared:  meta.total_qty_declared ?? null,
      line_total_declared: meta.line_total_declared ?? null,
      _lineY:           line.y0,
      variants,
      total_qty_summed: total,
      page:             page.pageNum,
      po_number:        null, // filled by caller
    };
    products.push(product);
  }

  return products;
}

// ─────────────────────────────────────────────────────────────────────────
// flat_table extractor — one product = one TRIGGER line + optional
// subsequent lines at fixed offsets. Variants come from a REPEATED regex
// applied to a specified line (or a captured substring of it).
//
// Recipe shape:
//   products: {
//     layout_type: 'flat_table',
//     row_header: {
//       regex:            "trigger regex",   // matched against every line
//       fields:           { ... },            // captures from trigger line
//       trailing_metrics: { regex, fields }   // OPTIONAL — same-line metrics
//     },
//     subsequent_lines: [                    // OPTIONAL — capture more attrs
//       { offset: 1, regex: "...", fields: { name: {group, transform} } },
//       ...
//     ],
//     variants: {
//       line_offset:              0,          // 0 = trigger line itself
//       extract_from_line_regex:  "regex",    // OPTIONAL — capture a substring
//       extract_from_line_group:  1,
//       pattern:                  "size:qty pattern applied with /g",
//       size_group:               1,
//       qty_group:                2,
//       min_qty:                  1,
//       max_qty:                  9999
//     }
//   }
function extractFlatTableProducts(page, productsConfig, tolerances, warnings) {
  const lines = wordsToLines(page.words, tolerances.y_pt);
  const products = [];

  const variantCfg = productsConfig.variants;
  if (!variantCfg?.pattern) throw new RecipeExecutionError(
    `layout_type=flat_table requires products.variants.pattern`,
    { code: 'invalid_recipe' }
  );

  for (let i = 0; i < lines.length; i++) {
    const triggerLine = lines[i];
    const meta = extractProductRowMeta(triggerLine, productsConfig);
    if (!meta) continue;

    // Apply subsequent_lines captures at fixed offsets below the trigger
    for (const sub of productsConfig.subsequent_lines || []) {
      const targetLine = lines[i + (sub.offset ?? 1)];
      if (!targetLine) continue;
      const re = new RegExp(sub.regex, sub.flags || '');
      const m = targetLine.text.match(re);
      if (!m) continue;
      for (const [name, def] of Object.entries(sub.fields || {})) {
        meta[name] = applyTransform(m[def.group ?? 0], def.transform);
      }
    }

    // Locate the variants line (offset can be 0 for same-line variants)
    const varLine = lines[i + (variantCfg.line_offset ?? 0)];
    if (!varLine) continue;

    // Optionally extract a substring from that line first
    let source = varLine.text;
    if (variantCfg.extract_from_line_regex) {
      const re = new RegExp(variantCfg.extract_from_line_regex, variantCfg.extract_from_line_flags || '');
      const m = source.match(re);
      if (!m) {
        warnings.push({
          type: 'no_variants_source',
          page: page.pageNum,
          style: meta.style_ref,
          detail: `extract_from_line_regex "${variantCfg.extract_from_line_regex}" did not match line ${i + (variantCfg.line_offset ?? 0)}`,
        });
        continue;
      }
      source = m[variantCfg.extract_from_line_group ?? 1];
    }

    // Extract all size:qty pairs from the source string
    const variantRe = new RegExp(variantCfg.pattern, 'g' + (variantCfg.flags || ''));
    const variants = [];
    for (const m of source.matchAll(variantRe)) {
      const size = String(m[variantCfg.size_group ?? 1] ?? '').trim();
      const qty  = parseInt(String(m[variantCfg.qty_group ?? 2] ?? ''), 10);
      if (!size || !Number.isFinite(qty)) continue;
      if (variantCfg.min_qty != null && qty < variantCfg.min_qty) continue;
      if (variantCfg.max_qty != null && qty > variantCfg.max_qty) continue;
      variants.push({ size, qty });
    }

    if (!variants.length) {
      warnings.push({
        type: 'no_variants_matched',
        page: page.pageNum,
        style: meta.style_ref,
        detail: `variants.pattern matched zero size:qty pairs in "${source.slice(0, 80)}"`,
      });
      continue;
    }

    const total = variants.reduce((s, v) => s + v.qty, 0);
    if (meta.total_qty_declared != null && total !== meta.total_qty_declared) {
      warnings.push({
        type: 'qty_mismatch',
        page: page.pageNum,
        style: meta.style_ref,
        declared: meta.total_qty_declared,
        summed: total,
        variants,
      });
    }

    const cd = splitColorAndDescription(meta, productsConfig);
    const colorLabel = cd.color_label ?? meta.color_label ?? '';
    const description = cd.description ?? meta.description ?? '';

    products.push({
      style_ref:            meta.style_ref ?? null,
      collection:           meta.collection ?? null,
      color_code:           meta.color_code ?? null,
      color_label:          colorLabel,
      color_normalized:     normalizeColor(colorLabel, meta.color_code),
      description,
      unit_cost:            meta.unit_cost ?? null,
      retail_price:         meta.retail_price ?? null,
      total_qty_declared:   meta.total_qty_declared ?? null,
      line_total_declared:  meta.line_total_declared ?? null,
      _lineY:               triggerLine.y0,
      variants,
      total_qty_summed:     total,
      page:                 page.pageNum,
      po_number:            null,
    });
  }

  return products;
}

// ─────────────────────────────────────────────────────────────────────────
// Declared totals — "Total Commande N X,XXX.XX" markers per page
// ─────────────────────────────────────────────────────────────────────────
function extractDeclaredTotals(pages, ordersConfig, tolerances) {
  const dtConfig = ordersConfig.declared_totals_extraction;
  if (!dtConfig) return { orders: [], totalUnits: 0, totalAmount: 0 };
  const re = new RegExp(dtConfig.regex, dtConfig.flags || 'i');
  const uGroup = dtConfig.units_group ?? 1;
  const aGroup = dtConfig.amount_group ?? 2;
  const orders = [];
  let totalUnits = 0, totalAmount = 0;
  for (const page of pages) {
    const lines = wordsToLines(page.words, tolerances.y_pt);
    for (const line of lines) {
      const m = line.text.match(re);
      if (!m) continue;
      const units = parseInt(m[uGroup], 10);
      const amount = parseFloat(String(m[aGroup]).replace(/,/g, ''));
      if (!Number.isFinite(units) || !Number.isFinite(amount)) continue;
      orders.push({ page: page.pageNum, units, amount });
      totalUnits  += units;
      totalAmount += amount;
    }
  }
  return { orders, totalUnits, totalAmount };
}

// ─────────────────────────────────────────────────────────────────────────
// File-level metadata (extracted once from the whole document)
// ─────────────────────────────────────────────────────────────────────────
function extractFileMeta(pages, extractionConfig) {
  const base = {
    supplier_key:             null,      // caller fills from recipe.meta
    customer_name:            null,
    target_manufacturer:      null,
    default_vendor_id:        null,
    default_attribute_set_id: null,
  };
  const ff = extractionConfig?.file_fields;
  if (!ff) return base;

  const p1Text = pages[0].words.map(w => w.text).join(' ');
  for (const [name, def] of Object.entries(ff)) {
    if (def.source !== 'first_page_text' && def.source !== undefined) {
      throw new RecipeExecutionError(
        `Unsupported file_field source "${def.source}" — supported: first_page_text`,
        { code: 'unsupported_source' }
      );
    }
    const re = new RegExp(def.regex, def.flags || '');
    const m = p1Text.match(re);
    base[name] = m ? applyTransform(m[def.group ?? 0], def.transform)?.trim() ?? null : null;
  }
  return base;
}

// ─────────────────────────────────────────────────────────────────────────
// Recipe shape validation — throws with a clear error for anything missing.
// ─────────────────────────────────────────────────────────────────────────
function validateRecipeShape(recipe) {
  const errs = [];
  if (!recipe || typeof recipe !== 'object') errs.push('recipe must be an object');
  if (recipe.version !== 1) errs.push(`recipe.version must be 1 (got ${recipe.version})`);
  if (!recipe.meta?.supplier_key)         errs.push('recipe.meta.supplier_key required');
  if (!recipe.meta?.target_manufacturer)  errs.push('recipe.meta.target_manufacturer required');
  if (!recipe.extraction)                 errs.push('recipe.extraction required');

  if (recipe.extraction && !recipe.extraction.parser) {
    // Declarative path — validate the standard sections
    const e = recipe.extraction;
    if (e.engine !== 'coordinate')        errs.push('recipe.extraction.engine must be "coordinate"');
    if (!e.tolerances?.y_pt)              errs.push('recipe.extraction.tolerances.y_pt required');
    if (!e.tolerances?.x_pt)              errs.push('recipe.extraction.tolerances.x_pt required');
    if (!e.orders?.fields)                errs.push('recipe.extraction.orders.fields required');
    if (!e.products?.layout_type)         errs.push('recipe.extraction.products.layout_type required');
    if (!e.products?.row_header?.regex)   errs.push('recipe.extraction.products.row_header.regex required');
    if (e.products?.layout_type === 'size_grid' && !e.products?.size_grid) {
      errs.push('products.layout_type=size_grid requires products.size_grid config');
    }
    if (e.products?.layout_type === 'flat_table' && !e.products?.variants?.pattern) {
      errs.push('products.layout_type=flat_table requires products.variants.pattern');
    }
    // order_split is OPTIONAL — but if present, must have the 3 required sub-fields
    if (e.orders?.order_split) {
      const os = e.orders.order_split;
      if (!os.split_field)      errs.push('orders.order_split.split_field required');
      if (!os.boundary_strategy) errs.push('orders.order_split.boundary_strategy required');
      if (os.split_field && !e.orders.fields[os.split_field]) {
        errs.push(`orders.order_split.split_field "${os.split_field}" not in orders.fields`);
      }
    }
  }
  if (errs.length) throw new RecipeExecutionError(
    `Invalid recipe: ${errs.join('; ')}`,
    { code: 'invalid_recipe', context: errs },
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Main entry — runRecipe(pdfBuffer, recipe) → same output shape as
// parseOuiEurostyle() for the Oui recipe (asserted by equivalence test).
// ─────────────────────────────────────────────────────────────────────────
async function runRecipe(pdfBuffer, recipe) {
  validateRecipeShape(recipe);

  // Escape hatch — delegate to a registered custom parser
  if (recipe.extraction.parser) {
    _reportEscapeHatch(recipe);
    const fn = _customParsers.get(recipe.extraction.parser);
    if (!fn) throw new RecipeExecutionError(
      `Recipe "${recipe.meta.supplier_key}" references custom parser "${recipe.extraction.parser}" ` +
      `but it is not registered. Call registerCustomParser("${recipe.extraction.parser}", fn) first.`,
      { code: 'custom_parser_not_registered' },
    );
    return await fn(pdfBuffer, recipe);
  }

  // Declarative path
  const pages = await extractWords(pdfBuffer);
  if (!pages.length) throw new RecipeExecutionError(
    `PDF has zero pages`,
    { code: 'empty_pdf' },
  );

  // Detection — refuse if file doesn't match
  if (!checkDetection(pages, recipe.detection)) {
    throw new RecipeExecutionError(
      `Recipe "${recipe.meta.supplier_key}" detection rules do not match this file`,
      { code: 'detection_mismatch' },
    );
  }

  const tolerances = recipe.extraction.tolerances;

  // File-level metadata
  const fileFieldsBase = extractFileMeta(pages, recipe.extraction);
  const file = {
    ...fileFieldsBase,
    supplier_key:             recipe.meta.supplier_key,
    target_manufacturer:      recipe.meta.target_manufacturer,
    default_vendor_id:        recipe.meta.default_vendor_id ?? null,
    default_attribute_set_id: recipe.meta.default_attribute_set_id ?? null,
  };

  // Order groups + per-order metadata
  // - Mono-order: single group covering all pages (no order_split configured)
  // - Multi-order: one group per distinct split_field value
  const orderGroups = splitPagesIntoOrders(pages, recipe.extraction.orders, tolerances);
  if (!orderGroups.length) throw new RecipeExecutionError(
    `Recipe applied but zero orders detected (order_split configured but no discriminator value found on any page)`,
    { code: 'zero_orders' },
  );

  const isMultiOrder = !!recipe.extraction.orders.order_split;
  const splitFieldName = isMultiOrder ? recipe.extraction.orders.order_split.split_field : null;

  // Compute a map page → group index (for product attribution + totals matching)
  const pageToGroupIdx = new Map();
  orderGroups.forEach((g, idx) => {
    for (const pn of g.page_nums) pageToGroupIdx.set(pn, idx);
  });

  // Declared totals per page (Total Commande markers), attribute to groups
  const declaredTotals = extractDeclaredTotals(pages, recipe.extraction.orders, tolerances);
  const orderExtras = orderGroups.map(() => ({}));  // one entry per group by idx
  for (const t of declaredTotals.orders) {
    const gi = pageToGroupIdx.get(t.page);
    if (gi != null) {
      // If multiple "Total Commande" markers land in the same group (rare),
      // sum them — this preserves mono-order behaviour where a file might
      // have a single trailing total, but a multi-order file has one per order.
      orderExtras[gi].unit_count_declared = (orderExtras[gi].unit_count_declared ?? 0) + t.units;
      orderExtras[gi].amount_declared     = (orderExtras[gi].amount_declared ?? 0) + t.amount;
    }
  }

  // Build the orders array (matching parseOuiEurostyle output shape)
  const orders = orderGroups.map((g, idx) => {
    const meta = extractOrderMeta(g, recipe.extraction.orders);
    const extra = orderExtras[idx];
    return {
      po_number:           meta.po_number ?? (splitFieldName ? g[splitFieldName] : null),
      customer_reference:  meta.customer_reference ?? null,
      order_date:          meta.order_date ?? null,
      delivery_date:       meta.delivery_date ?? null,
      cancel_date:         meta.cancel_date ?? null,
      first_page:          g.first_page,
      last_page:           g.last_page,
      unit_count_declared: extra.unit_count_declared ?? null,
      amount_declared:     extra.amount_declared ?? null,
      is_consignment:      meta.is_consignment,
    };
  });

  // Products — one page at a time; attribute each to its order via group idx
  const warnings = [];
  const products = [];
  for (const page of pages) {
    const pageProducts = extractProductsFromPage(page, recipe.extraction.products, tolerances, warnings);
    for (const p of pageProducts) {
      const gi = pageToGroupIdx.get(page.pageNum);
      p.po_number = gi != null ? orders[gi].po_number : null;
      delete p._lineY;
      products.push(p);
    }
  }
  if (!products.length) throw new RecipeExecutionError(
    `Recipe applied but zero products extracted from ${pages.length} page(s). ` +
    `Check size-grid header prefix and row_header regex — file may not match the recipe.`,
    { code: 'zero_products', context: { pages: pages.length, orders: orders.length } },
  );

  // Sanity check on orphan products
  const orphans = products.filter(p => !p.po_number);
  if (orphans.length) warnings.push({ type: 'orphan_products', count: orphans.length });

  return { file, orders, products, warnings, declared_totals: declaredTotals };
}

module.exports = {
  runRecipe,
  registerCustomParser,
  getEscapeHatchStats,
  RecipeExecutionError,
  TRANSFORMS,
  // Exported for tests / advanced callers:
  extractWords,
  wordsToLines,
  validateRecipeShape,
  checkDetection,
};
