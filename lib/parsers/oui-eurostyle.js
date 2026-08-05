'use strict';
// Parser for the Oui/Eurostyle PDF format (also filed under "Steilmann" historically).
//
// Layout: horizontal size grid. Each product occupies 2 vertical rows:
//   row A  — Style/collection/color-code+label + Description + Unit price + Total Qty + Total price
//   row B  — Quantities aligned under size-header positions from the header row above
//
// Size header row appears once per page section, e.g. "CA 34 36 38 40 42 44 46" or "CA OS".
// Quantities align within 0.5 pt of their header — we accept up to 8 pt as safety margin.
//
// Exports: parseOuiEurostyle(pdfBuffer) →
//   { file: {supplier_name,customer_name,...},
//     orders: [{po_number,customer_reference,order_date,delivery_date,cancel_date,first_page,last_page,is_consignment,unit_count_declared,amount_declared}],
//     products: [{po_number,page,style_ref,...,variants:[…]}],
//     warnings, declared_totals }

const path = require('path');
const { getDocument } = require('pdfjs-dist/legacy/build/pdf.mjs');

// Regex for product line: "99103 / 2026K / 5400 blue"
const PRODUCT_RE = /^(\d{4,6})\s*\/\s*(\S+)\s*\/\s*(\d+)\s+(.+?)$/;
// Alignment tolerance between qty x-center and size header x-center
const X_TOLERANCE = 8;

// Extract all words with (x,y,w) coordinates per page.
async function extractWords(pdfBuffer) {
  const loadingTask = getDocument({ data: new Uint8Array(pdfBuffer), disableWorker: true });
  const doc = await loadingTask.promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const words = content.items.map(it => {
      // pdfjs gives transform [a,b,c,d,e,f] — x=e, y=viewport.height-f (flip)
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

// Cluster words into lines (rows) by y-coordinate (3pt tolerance).
// IMPORTANT: sort each line's words by x0 before joining, so text order = visual order.
function wordsToLines(words) {
  const sorted = [...words].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const lines = [];
  for (const w of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(w.y0 - last.y0) < 3) {
      last.words.push(w);
    } else {
      lines.push({ y0: w.y0, words: [w] });
    }
  }
  // Finalize each line: sort words by x, then compose text
  for (const line of lines) {
    line.words.sort((a, b) => a.x0 - b.x0);
    line.text = line.words.map(w => w.text).join(' ');
  }
  return lines;
}

// Detect a size header line: "CA 34 36 38 ..." or "CA OS"
function parseSizeHeader(line) {
  const trimmed = line.text.trim();
  if (!/^CA\s+/.test(trimmed)) return null;
  const tokens = line.words.filter(w => /^(?:\d{2}|OS)$/.test(w.text));
  if (tokens.length === 0) return null;
  return {
    sizes: tokens.map(t => ({ label: t.text, xc: t.xc, xheader_word: t })),
    lineY: line.y0,
  };
}

// Find the applicable size header for a product row (the most recent CA-header above it).
function findApplicableHeader(headers, productY) {
  const candidates = headers.filter(h => h.lineY < productY);
  return candidates.length ? candidates[candidates.length - 1] : null;
}

// Match quantities on the row BELOW the product line to size header columns.
function matchQtysToSizes(header, qtyRow) {
  const results = [];
  const qtyTokens = qtyRow.words.filter(w => /^\d+$/.test(w.text) && parseInt(w.text) < 200);
  for (const q of qtyTokens) {
    const size = header.sizes.find(s => Math.abs(q.xc - s.xc) < X_TOLERANCE);
    if (size) results.push({ size: size.label, qty: parseInt(q.text) });
  }
  return results;
}

// Extract a product's metadata from a matched product line + accompanying tokens.
// The product line starts with "<style> / <collection> / <color_code> <color_label>"
// The description ("Jacket", "Pullover") appears between the color info and the price.
// Unit price + Total qty + Total price are on the far right of the same row.
function extractProductMeta(line, allWordsSameY) {
  const productMatch = line.text.match(PRODUCT_RE);
  if (!productMatch) return null;
  const [, style, collection, colorCode, rest] = productMatch;

  // Extract price + qty + total from the row.
  // Format: "$565.00 2 248.60 497.20"  (retail, totalQty, unitCost, lineTotal)
  // Not anchored at end because the description ("Jacket") sits after in the merged line.
  const priceRe = /\$([\d,]+\.\d{2})\s+(\d+)\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})/;
  const priceMatch = line.text.match(priceRe);
  let retailPrice = null, totalQty = null, unitCost = null, lineTotal = null;
  if (priceMatch) {
    retailPrice = parseFloat(priceMatch[1].replace(/,/g, ''));
    totalQty    = parseInt(priceMatch[2]);
    unitCost    = parseFloat(priceMatch[3].replace(/,/g, ''));
    lineTotal   = parseFloat(priceMatch[4].replace(/,/g, ''));
  }

  // Description = text between "colorLabel" and the price block, on this same y-line
  // We split rest by whitespace: first token(s) = color label, then description
  // But color label can be multi-word ("Blanc cassé"). Best approach:
  // description is what's between the color and the "$" price. Use price index in rest.
  // Split color label vs description using case:
  //   colors are lowercase ("blue", "ultra violett", "dk blue camel")
  //   descriptions are Capitalized ("Jacket", "T Shirt", "Turtleneck Shirt")
  // Everything from the first Capitalized word to end (before price) = description.
  // Everything before = color label.
  // Also, the priceMatch appears somewhere in rest — the description can be AFTER the price
  // block (pdfjs sometimes appends the description after the price on the same visual row).
  let colorLabel = '';
  let description = '';
  if (priceMatch) {
    // Strip the price block AND anything before it from rest, and anything after up to next price.
    const priceLiteral = priceMatch[0];
    const beforePrice = rest.slice(0, rest.indexOf(priceLiteral)).trim();
    const afterPrice  = rest.slice(rest.indexOf(priceLiteral) + priceLiteral.length).trim();
    // Split beforePrice: color words (lowercase) then Capitalized description words
    const bpParts = beforePrice.split(/\s+/).filter(Boolean);
    const firstCap = bpParts.findIndex(w => /^[A-Z]/.test(w));
    if (firstCap === -1) {
      // No capitalized word in beforePrice — all lowercase = color only
      colorLabel  = beforePrice;
      description = afterPrice; // description might be after the price
    } else if (firstCap === 0) {
      // beforePrice starts with a capital → probably no color label separator
      colorLabel  = '';
      description = beforePrice;
    } else {
      colorLabel  = bpParts.slice(0, firstCap).join(' ');
      description = bpParts.slice(firstCap).join(' ');
    }
    // If nothing before the price contained a capital, description might live after
    if (!description && afterPrice) description = afterPrice;
  } else {
    colorLabel = rest.trim();
  }

  return {
    style_ref:    style,
    collection:   collection,
    color_code:   colorCode,
    color_label:  colorLabel,
    color_normalized: normalizeColor(colorLabel, colorCode),
    description,
    unit_cost:    unitCost,
    retail_price: retailPrice,
    total_qty_declared: totalQty,
    line_total_declared: lineTotal,
    _lineY: line.y0,
  };
}

// "blue" + "5400" → "Bleu-5400" (best-effort; final translation via color_translations DB later)
// For MVP: capitalize first letter, hyphen + code. No FR translation yet.
function normalizeColor(label, code) {
  if (!label) return code ? code : '';
  const cap = label.charAt(0).toUpperCase() + label.slice(1).toLowerCase();
  return code ? `${cap}-${code}` : cap;
}

// File-level metadata (only fields common to the whole file: supplier, buyer contact).
function extractFileMeta(pages) {
  const p1Text = pages[0].words.map(w => w.text).join(' ');
  const custMatch = p1Text.match(/Facturer\s+A[^\d]*([A-Z][A-Z\s\-]+)/);
  return {
    supplier_key:             'oui-eurostyle',
    customer_name:            custMatch?.[1]?.trim() ?? null,
    target_manufacturer:      'Oui',
    default_vendor_id:        '70',
    default_attribute_set_id: '5',
  };
}

// Parse "MM/DD/YYYY" → "YYYY-MM-DD" (ISO). Returns null on failure.
function parseDate(mmddyyyy) {
  if (!mmddyyyy) return null;
  const m = mmddyyyy.replace(/\s/g, '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

// Per-page: extract PO number + customer reference + dates from the metadata band.
// A new PO always starts with a page whose "No. Commande: XXXX" differs from the
// previous page. Customer reference sits on the "LYS1R" client line as free text
// between the "%" markup and the two dates.
function extractPageMeta(page) {
  const lines = wordsToLines(page.words);
  let po_number = null, customer_reference = null, order_date = null, delivery_date = null, cancel_date = null;
  for (const line of lines) {
    const m = line.text.match(/No\.?\s*Commande\s*:?\s*(\d+)/i);
    if (m) po_number = m[1];
    const d = line.text.match(/Date\s*de\s*Commande\s*:?\s*(\d{2}\s*\/\s*\d{2}\/\s*\d{4})/i);
    if (d) order_date = parseDate(d[1]);
    // Client info row: "LYS1R 56.00 % Urban Romance 07/20/2026 08/25/2026 JB A26 4% ..."
    // Cust.PO can be multi-word ("Urban Romance", "Heritage Reset") until first date.
    const c = line.text.match(/^LYS1R\s+\S+\s+%?\s*(.+?)\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})\b/);
    if (c) {
      customer_reference = c[1].trim();
      delivery_date      = parseDate(c[2]);
      cancel_date        = parseDate(c[3]);
    }
  }
  return { po_number, customer_reference, order_date, delivery_date, cancel_date };
}

// Group pages by PO number. Each group covers a contiguous page range with the same
// No. Commande. Returns Map<po_number, { first_page, last_page, meta, page_nums }>
function groupPagesByPO(pages) {
  const groups = new Map();
  let currentPO = null;
  for (const page of pages) {
    const meta = extractPageMeta(page);
    if (meta.po_number && meta.po_number !== currentPO) currentPO = meta.po_number;
    if (!currentPO) continue;
    if (!groups.has(currentPO)) {
      groups.set(currentPO, {
        po_number:          currentPO,
        first_page:         page.pageNum,
        last_page:          page.pageNum,
        page_nums:          [page.pageNum],
        customer_reference: meta.customer_reference,
        order_date:         meta.order_date,
        delivery_date:      meta.delivery_date,
        cancel_date:        meta.cancel_date,
      });
    } else {
      const g = groups.get(currentPO);
      g.last_page = page.pageNum;
      g.page_nums.push(page.pageNum);
      // Fill in missing meta from later pages
      g.customer_reference = g.customer_reference ?? meta.customer_reference;
      g.order_date         = g.order_date         ?? meta.order_date;
      g.delivery_date      = g.delivery_date      ?? meta.delivery_date;
      g.cancel_date        = g.cancel_date        ?? meta.cancel_date;
    }
  }
  return groups;
}

// Extract "Total Commande" markers per page. pdfjs-dist reads text out of spatial
// order — so we cluster words back into lines by y-coordinate first, then look
// for a line containing "Total" + "Commande" + a number + a decimal amount.
function extractDeclaredTotals(pages) {
  const orders = [];
  let totalUnits = 0;
  let totalAmount = 0;
  for (const page of pages) {
    const lines = wordsToLines(page.words);
    for (const line of lines) {
      // Find any line where "Total" and "Commande" appear + a plausible number pair
      const text = line.text;
      if (!/Total\s+Commande/i.test(text)) continue;
      // Look for "N X.XX" or "N X,XXX.XX" following the label
      const m = text.match(/Total\s+Commande\D*(\d{1,4})\s+([\d,]+\.\d{2})/i);
      if (!m) continue;
      const units  = parseInt(m[1]);
      const amount = parseFloat(m[2].replace(/,/g, ''));
      orders.push({ page: page.pageNum, units, amount });
      totalUnits  += units;
      totalAmount += amount;
    }
  }
  return { orders, totalUnits, totalAmount };
}

// Extract distinct order numbers appearing in the document (No. Commande: XXXXX)
function extractOrderNumbers(pages) {
  const seen = new Set();
  for (const page of pages) {
    const text = page.words.map(w => w.text).join(' ');
    const m = text.match(/No\.?\s*Commande\s*:?\s*(\d+)/i);
    if (m) seen.add(m[1]);
  }
  return [...seen];
}

// Main entry point
async function parseOuiEurostyle(pdfBuffer) {
  const pages = await extractWords(pdfBuffer);
  const file  = extractFileMeta(pages);
  const declaredTotals = extractDeclaredTotals(pages);
  const orderNumbers   = extractOrderNumbers(pages);

  // Split pages into POs and gather per-PO metadata
  const poGroups   = groupPagesByPO(pages);
  const pageToPO   = new Map();
  for (const g of poGroups.values()) for (const pn of g.page_nums) pageToPO.set(pn, g.po_number);

  // Attach declared totals to each PO (each "Total Commande" line appears on the last page of its PO)
  for (const t of declaredTotals.orders) {
    const po = pageToPO.get(t.page);
    if (po && poGroups.has(po)) {
      poGroups.get(po).unit_count_declared = t.units;
      poGroups.get(po).amount_declared     = t.amount;
    }
  }
  const orders = [...poGroups.values()].map(g => ({
    po_number:           g.po_number,
    customer_reference:  g.customer_reference,
    order_date:          g.order_date,
    delivery_date:       g.delivery_date,
    cancel_date:         g.cancel_date,
    first_page:          g.first_page,
    last_page:           g.last_page,
    unit_count_declared: g.unit_count_declared ?? null,
    amount_declared:     g.amount_declared ?? null,
    is_consignment:      /consigne|consignment/i.test(g.customer_reference ?? ''),
  }));

  const products = [];
  const warnings = [];

  for (const page of pages) {
    const lines = wordsToLines(page.words);
    // Collect size headers on this page
    const headers = [];
    for (const line of lines) {
      const h = parseSizeHeader(line);
      if (h) headers.push(h);
    }
    // Find product lines and match with header + qty row
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const meta = extractProductMeta(line);
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
      // qty row = the row directly below the product line
      const qtyRow = lines[i + 1];
      if (!qtyRow) continue;
      // Only accept as qty row if it's within reasonable distance
      if (qtyRow.y0 - line.y0 > 25 || qtyRow.y0 - line.y0 < 3) continue;
      const qtys = matchQtysToSizes(header, qtyRow);
      const total = qtys.reduce((s, q) => s + q.qty, 0);
      if (meta.total_qty_declared != null && total !== meta.total_qty_declared) {
        warnings.push({
          type: 'qty_mismatch',
          page: page.pageNum,
          style: meta.style_ref,
          declared: meta.total_qty_declared,
          summed: total,
          qtys,
        });
      }
      products.push({
        ...meta,
        variants: qtys,
        total_qty_summed: total,
        page: page.pageNum,
        po_number: pageToPO.get(page.pageNum) ?? null,
      });
    }
  }

  // Sanity check: every product should be linked to a PO
  const orphans = products.filter(p => !p.po_number);
  if (orphans.length) warnings.push({ type: 'orphan_products', count: orphans.length });

  return { file, orders, products, warnings, declared_totals: declaredTotals };
}

module.exports = { parseOuiEurostyle };

// CLI test mode
if (require.main === module) {
  const fs = require('fs');
  const file = process.argv[2] || '/Users/alexandrefabi/Downloads/OrderConfirmationSteilmann_V2.pdf';
  (async () => {
    const buf = fs.readFileSync(file);
    const result = await parseOuiEurostyle(buf);
    console.log('=== FILE META ===');
    console.log(JSON.stringify(result.file, null, 2));

    console.log(`\n=== ORDERS DETECTED: ${result.orders.length} ===`);
    for (const o of result.orders) {
      const cons = o.is_consignment ? '  (consignation)' : '';
      console.log(`  PO ${o.po_number}  "${o.customer_reference ?? '?'}"  order=${o.order_date}  deliv=${o.delivery_date}  canc=${o.cancel_date}  pages ${o.first_page}-${o.last_page}${cons}`);
      console.log(`     declared: ${o.unit_count_declared ?? '?'} u / ${(o.amount_declared ?? 0).toFixed(2)} $`);
    }

    console.log(`\n=== PRODUCTS: ${result.products.length} ===`);
    let sumUnits = 0;
    for (const p of result.products) {
      const variantStr = p.variants.map(v => `${v.size}×${v.qty}`).join(' ');
      console.log(`  PO${p.po_number ?? '???'} p${p.page} ${p.style_ref} / ${p.collection} / ${p.color_code} ${p.color_label} — ${p.description} — cost=${p.unit_cost} retail=${p.retail_price} — declared=${p.total_qty_declared} summed=${p.total_qty_summed} [${variantStr}]`);
      sumUnits += p.total_qty_summed;
    }

    console.log(`\n=== PER-PO BREAKDOWN ===`);
    const byPO = new Map();
    for (const p of result.products) {
      if (!byPO.has(p.po_number)) byPO.set(p.po_number, { lines: 0, units: 0 });
      const s = byPO.get(p.po_number);
      s.lines++;
      s.units += p.total_qty_summed;
    }
    for (const [po, s] of byPO) console.log(`  PO ${po}: ${s.lines} product lines, ${s.units} units`);

    console.log(`\n=== TOTALS ===`);
    console.log(`  Products (product lines)  : ${result.products.length}`);
    console.log(`  Units summed (parser)     : ${sumUnits}`);
    console.log(`  Units declared (PDF sum)  : ${result.declared_totals.totalUnits} across ${result.declared_totals.orders.length} "Total Commande" markers`);
    console.log(`  Amount declared (PDF sum) : ${result.declared_totals.totalAmount.toFixed(2)}`);
    console.log(`  Per-order breakdown       : ${result.declared_totals.orders.map(o => `p${o.page}: ${o.units} u/${o.amount.toFixed(2)}$`).join(' | ')}`);
    console.log(`  ${sumUnits === result.declared_totals.totalUnits ? '✅ MATCH' : '⚠ MISMATCH'} parser=${sumUnits} vs declared=${result.declared_totals.totalUnits}`);
    console.log(`  Warnings                  : ${result.warnings.length}`);
    if (result.warnings.length) {
      console.log('\n=== WARNINGS (first 10) ===');
      for (const w of result.warnings.slice(0, 10)) console.log(' ', JSON.stringify(w));
    }
  })().catch(e => { console.error('FATAL:', e); process.exit(1); });
}
