#!/usr/bin/env node
'use strict';
// B8.5 (v2 = "B85B") — LIVE API TEST with corrected builders.
//
// Fixes vs. the initial B85:
//   1. Prices block (Default/MSRP/Online at supplier retail) — WITHOUT it,
//      matrix and variants show 0.00 prices and -100% margin.
//   2. Matrix tagging — tags do NOT propagate, so matrix and variants must
//      both be tagged. Uses new client.tagMatrix() method.
//
// Usage:
//   railway run node scripts/live-test-b85.js          # dry-run: prints payloads
//   railway run node scripts/live-test-b85.js --go     # actually POST + verify + capture
//
// After --go the script fetches the created matrix, variants and PO with
// Prices+Tags loaded and prints them — that's the "capture" for validation.

const { fromEnv, LightspeedError } = require('../lib/lightspeed-client');
const {
  buildMatrixPayload,
  buildItemPayload,
  buildOrderPayload,
  buildOrderLinePayload,
} = require('../lib/queue-processor');

const GO = process.argv.includes('--go');

// ─── Fixed test config ────────────────────────────────────────────────────
const MATRIX_DESC       = 'TEST API B85B';
const COLOR_NORMALIZED  = 'Test-B85B';
const SIZES             = ['38', '40'];
const UNIT_COST         = '99.99';
const RETAIL_PRICE      = '299.00';                    // > cost so margin isn't -100%
const MANUFACTURER_ID   = '155';                       // Oui
const VENDOR_ID         = '70';                        // EUROSTYLE
const ATTRIBUTE_SET_ID  = '5';                         // Taille/Couleur
const SHOP_ID           = '1';                         // Boutique Valérie Simon
const SEASON_TAG        = 'a26';
const REFNUM            = `${MATRIX_DESC} ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
const LINE_QTYS         = { '38': 1, '40': 2 };

const FAKE_BATCH = {
  po_number:          'B85B',
  customer_reference: 'Test',
  order_date:         null,
  delivery_date:      null,
  cancel_date:        null,
};

function buildAllPayloads() {
  const matrix = buildMatrixPayload({
    description:      MATRIX_DESC,
    manufacturerID:   MANUFACTURER_ID,
    defaultVendorID:  VENDOR_ID,
    defaultCost:      UNIT_COST,
    retailPrice:      RETAIL_PRICE,
    attributeSetID:   ATTRIBUTE_SET_ID,
  });

  const variants = SIZES.map(size => buildItemPayload({
    matrixID:         '<pending>',
    size,
    colorNormalized:  COLOR_NORMALIZED,
    description:      `${MATRIX_DESC} ${COLOR_NORMALIZED} ${size}`,
    manufacturerID:   MANUFACTURER_ID,
    defaultVendorID:  VENDOR_ID,
    defaultCost:      UNIT_COST,
    retailPrice:      RETAIL_PRICE,
    attributeSetID:   ATTRIBUTE_SET_ID,
    vendorNum:        `B85B-${size}-TEST`,
  }));

  const order = {
    ...buildOrderPayload({
      batch:      { ...FAKE_BATCH, po_number: 'B85B', customer_reference: null },
      vendorID:   VENDOR_ID,
      shopID:     SHOP_ID,
    }),
    refNum: REFNUM,
  };

  const orderLines = SIZES.map(size => buildOrderLinePayload({
    orderID:   '<pending>',
    itemID:    `<pending — variant[${size}]>`,
    quantity:  LINE_QTYS[size],
    unitCost:  UNIT_COST,
  }));

  return { matrix, variants, order, orderLines };
}

function dumpPayloads() {
  const p = buildAllPayloads();
  console.log('══════════════════════════════════════════════════════════════════');
  console.log(`   PLANNED PAYLOADS — B85B (dry-run)`);
  console.log(`   description : "${MATRIX_DESC}"      cost: ${UNIT_COST}      retail: ${RETAIL_PRICE}`);
  console.log(`   refNum      : "${REFNUM}"           season: ${SEASON_TAG}`);
  console.log('══════════════════════════════════════════════════════════════════');

  console.log('\n[1] POST /ItemMatrix (with Prices block)');
  console.log(JSON.stringify(p.matrix, null, 2));
  console.log('\n[2] PUT /ItemMatrix/{id} — tag matrix with "' + SEASON_TAG + '" (via tagMatrix — GET-merge-PUT)');

  p.variants.forEach((v, i) => {
    console.log(`\n[3.${i + 1}] POST /Item — size ${SIZES[i]} (with Prices block)`);
    console.log(JSON.stringify(v, null, 2));
  });

  p.variants.forEach((_, i) => {
    console.log(`\n[4.${i + 1}] PUT /Item/{id} — tag variant ${SIZES[i]} with "${SEASON_TAG}"`);
  });

  console.log('\n[5] POST /Order');
  console.log(JSON.stringify(p.order, null, 2));

  p.orderLines.forEach((ol, i) => {
    console.log(`\n[6.${i + 1}] POST /OrderLine — size ${SIZES[i]} qty ${LINE_QTYS[SIZES[i]]}`);
    console.log(JSON.stringify(ol, null, 2));
  });

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('Writes: 1 matrix + 1 tagMatrix + 2 items + 2 tagItems + 1 order + 2 orderLines = 9 writes');
  console.log('To execute:  railway run node scripts/live-test-b85.js --go');
  console.log('══════════════════════════════════════════════════════════════════');
}

// ─── Live run ─────────────────────────────────────────────────────────────
async function live() {
  const cli = fromEnv();
  const created = { matrix_id: null, item_ids: {}, order_id: null, order_line_ids: {} };
  const step = (n, msg) => console.log(`\n[${n}] ${msg}`);

  try {
    // 1. POST /ItemMatrix
    step('1', `POST /ItemMatrix "${MATRIX_DESC}"…`);
    const p1 = buildMatrixPayload({
      description: MATRIX_DESC, manufacturerID: MANUFACTURER_ID,
      defaultVendorID: VENDOR_ID, defaultCost: UNIT_COST, retailPrice: RETAIL_PRICE,
      attributeSetID: ATTRIBUTE_SET_ID,
    });
    const m = await cli.createMatrix(p1);
    created.matrix_id = String(m.itemMatrixID);
    console.log(`   ✔ itemMatrixID = ${created.matrix_id}`);

    // 2. Tag matrix
    step('2', `tagMatrix(${created.matrix_id}, ['${SEASON_TAG}'])…`);
    const tm = await cli.tagMatrix(created.matrix_id, [SEASON_TAG]);
    console.log(`   ✔ matrix tags now = ${JSON.stringify(tm.tags)}${tm.skipped ? ' (' + tm.skipped + ')' : ''}`);

    // 3. POST /Item × 2
    for (const size of SIZES) {
      step(`3.${size}`, `POST /Item size ${size}…`);
      const p3 = buildItemPayload({
        matrixID: created.matrix_id, size, colorNormalized: COLOR_NORMALIZED,
        description: `${MATRIX_DESC} ${COLOR_NORMALIZED} ${size}`,
        manufacturerID: MANUFACTURER_ID, defaultVendorID: VENDOR_ID,
        defaultCost: UNIT_COST, retailPrice: RETAIL_PRICE,
        attributeSetID: ATTRIBUTE_SET_ID, vendorNum: `B85B-${size}-TEST`,
      });
      const item = await cli.createItemVariant(p3);
      created.item_ids[size] = String(item.itemID);
      console.log(`   ✔ itemID(size ${size}) = ${created.item_ids[size]}`);
    }

    // 4. Tag variants
    for (const size of SIZES) {
      step(`4.${size}`, `tagItem(${created.item_ids[size]}, ['${SEASON_TAG}'])…`);
      const t = await cli.tagItem(created.item_ids[size], [SEASON_TAG]);
      console.log(`   ✔ tags = ${JSON.stringify(t.tags)}${t.skipped ? ' (' + t.skipped + ')' : ''}`);
    }

    // 5. POST /Order
    step('5', `POST /Order refNum="${REFNUM}"…`);
    const p5 = { ...buildOrderPayload({
      batch: { ...FAKE_BATCH }, vendorID: VENDOR_ID, shopID: SHOP_ID,
    }), refNum: REFNUM };
    const order = await cli.createOrder(p5);
    created.order_id = String(order.orderID);
    console.log(`   ✔ orderID = ${created.order_id}`);

    // 6. POST /OrderLine × 2
    for (const size of SIZES) {
      step(`6.${size}`, `POST /OrderLine size ${size} qty ${LINE_QTYS[size]}…`);
      const p6 = buildOrderLinePayload({
        orderID: created.order_id, itemID: created.item_ids[size],
        quantity: LINE_QTYS[size], unitCost: UNIT_COST,
      });
      const ol = await cli.createOrderLine(created.order_id, p6);
      created.order_line_ids[size] = String(ol.orderLineID ?? ol.itemOrderLineID ?? ol.id);
      console.log(`   ✔ orderLineID(size ${size}) = ${created.order_line_ids[size]}`);
    }

    // ═══ CAPTURE — read back matrix, variants, PO with Prices + Tags ═══
    console.log('\n══════════════════════════════════════════════════════════════════');
    console.log('   CAPTURE — état lu depuis Lightspeed après création');
    console.log('══════════════════════════════════════════════════════════════════');

    console.log(`\n▸ ItemMatrix #${created.matrix_id} (Prices in body + Tags relation)`);
    // Prices is NOT a valid load_relation on ItemMatrix (Lightspeed 400s).
    // The Prices field is returned inline in the matrix body by default.
    const mCap = await cli._request('GET', `/ItemMatrix/${created.matrix_id}.json`, {
      params: { load_relations: '["Tags"]' },
    });
    const mObj = mCap.ItemMatrix ?? {};
    const mPrices = mObj.Prices?.ItemPrice;
    const mPriceArr = Array.isArray(mPrices) ? mPrices : (mPrices ? [mPrices] : []);
    console.log(`   description : "${mObj.description}"`);
    console.log(`   defaultCost : ${mObj.defaultCost}    manufacturerID: ${mObj.manufacturerID}    vendorID: ${mObj.defaultVendorID}`);
    console.log(`   PRICES (${mPriceArr.length}) :`);
    for (const pr of mPriceArr) console.log(`     ${pr.useType.padEnd(10)} → ${pr.amount}`);
    const mTagsList = _extractTagList(mObj.Tags);
    console.log(`   TAGS  : ${mTagsList.length ? mTagsList.join(', ') : '(none)'}`);

    for (const size of SIZES) {
      const iid = created.item_ids[size];
      console.log(`\n▸ Item #${iid} — size ${size} (Prices + Tags + ItemAttributes)`);
      const iCap = await cli._request('GET', `/Item/${iid}.json`, {
        params: { load_relations: '["Prices","Tags","ItemAttributes","ItemVendorNums"]' },
      });
      const it = iCap.Item ?? {};
      const iPrices = it.Prices?.ItemPrice;
      const iPriceArr = Array.isArray(iPrices) ? iPrices : (iPrices ? [iPrices] : []);
      console.log(`   description : "${it.description}"`);
      console.log(`   defaultCost : ${it.defaultCost}    matrix: ${it.itemMatrixID}`);
      console.log(`   attributes  : attr1=${it.ItemAttributes?.attribute1}  attr2=${it.ItemAttributes?.attribute2}`);
      const vn = it.ItemVendorNums?.ItemVendorNum;
      const vnObj = Array.isArray(vn) ? vn[0] : vn;
      console.log(`   vendorNum   : ${vnObj?.value ?? '-'} (vendor ${vnObj?.vendorID ?? '-'}, cost ${vnObj?.cost ?? '-'})`);
      console.log(`   PRICES (${iPriceArr.length}) :`);
      for (const pr of iPriceArr) console.log(`     ${pr.useType.padEnd(10)} → ${pr.amount}`);
      const iTagsList = _extractTagList(it.Tags);
      console.log(`   TAGS  : ${iTagsList.length ? iTagsList.join(', ') : '(none)'}`);
    }

    console.log(`\n▸ Order #${created.order_id} (OrderLines with prices)`);
    const oCap = await cli._request('GET', `/Order/${created.order_id}.json`, {
      params: { load_relations: '["OrderLines"]' },
    });
    const ord = oCap.Order ?? {};
    let ols = ord.OrderLines?.OrderLine ?? [];
    if (!Array.isArray(ols)) ols = ols ? [ols] : [];
    console.log(`   PO ${ord.orderID}  refNum "${ord.refNum}"  vendorID ${ord.vendorID}  shopID ${ord.shopID}`);
    for (const ol of ols) {
      console.log(`     OL ${ol.orderLineID}: itemID=${ol.itemID}  qty=${ol.quantity}  numReceived=${ol.numReceived}  price=${ol.price}  vendorCost=${ol.vendorCost}  total=${ol.total}`);
    }

    // ═══ CLEANUP IDs ═══════════════════════════════════════════════════════
    console.log('\n══════════════════════════════════════════════════════════════════');
    console.log('   IDs pour nettoyage');
    console.log('══════════════════════════════════════════════════════════════════');
    console.log(`   ItemMatrix    #${created.matrix_id}    "${MATRIX_DESC}"`);
    for (const size of SIZES) console.log(`   Item          #${created.item_ids[size]}     size ${size}`);
    console.log(`   Order         #${created.order_id}     "${REFNUM}"`);
    for (const size of SIZES) console.log(`   OrderLine     #${created.order_line_ids[size]}     size ${size} qty ${LINE_QTYS[size]}`);
    console.log(`\nCleanup manuel dans Lightspeed UI :`);
    console.log(`  - Retail → Inventory → Matrices → "${MATRIX_DESC}" → Delete`);
    console.log(`  - Retail → Ordering → Purchase Orders → "${REFNUM}" → Delete/Cancel`);
  } catch (e) {
    console.error(`\n✗ FAILED at step above.`);
    if (e instanceof LightspeedError) {
      console.error(`  HTTP ${e.status} on ${e.method} ${e.path}`);
      console.error(`  body: ${JSON.stringify(e.body)?.slice(0, 800)}`);
    } else {
      console.error(`  ${e.message}`);
      if (e.stack) console.error(e.stack);
    }
    console.log('\nPartial state (may need cleanup):');
    console.log(JSON.stringify(created, null, 2));
    process.exit(1);
  }
}

function _extractTagList(tagsField) {
  if (!tagsField) return [];
  const raw = tagsField.tag ?? tagsField.Tag ?? tagsField;
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map(t => (typeof t === 'string' ? t : (t.name ?? t.Name))).filter(Boolean);
}

if (GO) live();
else    dumpPayloads();
