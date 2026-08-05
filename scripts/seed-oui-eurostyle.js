#!/usr/bin/env node
// Seeds three tables for the Oui/Eurostyle import module:
//   1. parse_recipes[oui-eurostyle v1]  (GLOBAL, no tenant)
//   2. color_translations               (GLOBAL, no tenant) — 28 colors observed in sample PDF
//   3. brand_vendor_map[<tenant>: Oui → 70 EUROSTYLE]  (per tenant)
//
// Idempotent: safe to re-run. Uses ON CONFLICT to update existing rows.
//
// Run: railway run node scripts/seed-oui-eurostyle.js
// Env: TENANT_ID (default 'valerie-simon'), DATABASE_URL (from Railway)

'use strict';

const { Pool } = require('pg');

const TENANT_ID = process.env.TENANT_ID || 'valerie-simon';

const dbUrl = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('FATAL: no DATABASE_URL / DATABASE_PUBLIC_URL. Run via `railway run --service Postgres node scripts/seed-oui-eurostyle.js`.');
  process.exit(1);
}
const pool = new Pool({
  connectionString: dbUrl,
  ssl: dbUrl.includes('railway.internal') ? undefined : { rejectUnauthorized: false },
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. parse_recipes — GLOBAL. Describes WHERE to find fields, never the values.
// ─────────────────────────────────────────────────────────────────────────────
const RECIPE = {
  supplier_key: 'oui-eurostyle',
  version: 1,
  file_kind: 'pdf',
  target_manufacturer: 'Oui',
  default_attribute_set_id: '5', // Taille/Couleur
  detection: {
    // Auto-identify this template from the first 2 pages of any uploaded PDF.
    // ALL patterns must match (AND). Patterns are anchored as substrings.
    match_all: [
      { where: 'text_any_page', regex: 'LYS1R' },
      { where: 'text_any_page', regex: 'No\\.?\\s*Commande' },
      { where: 'text_any_page', regex: 'Total\\s*Commande' },
    ],
    match_any: [
      { where: 'text_any_page', regex: 'EUROSTYLE' },
      { where: 'text_any_page', regex: 'Steilmann' },
      { where: 'text_any_page', regex: 'Oui\\b' },
    ],
  },
  layout: {
    // Coordinate-based extraction. All tunables the parser uses.
    x_tolerance_pt: 8,
    y_tolerance_pt: 3,
    product_row_regex: '^(\\d{4,6})\\s*/\\s*(\\S+)\\s*/\\s*(\\d+)\\s+(.+?)$',
    size_headers_prefix: 'CA', // 'CA 34 36 38 40 42 44 46' or 'CA OS'
    two_row_product: true,     // meta row A + quantities row B
    // Field locators — text regexes anchored on line contents (not coordinates)
    fields: {
      po_number:          { regex: 'No\\.?\\s*Commande\\s*:?\\s*(\\d+)', group: 1 },
      order_date:         { regex: 'Date\\s*de\\s*Commande\\s*:?\\s*(\\d{2}\\s*/\\s*\\d{2}/\\s*\\d{4})', group: 1, transform: 'mmddyyyy_to_iso' },
      customer_reference: { regex: '^LYS1R\\s+\\S+\\s+%?\\s*(.+?)\\s+\\d{2}/\\d{2}/\\d{4}\\s+\\d{2}/\\d{2}/\\d{4}\\b', group: 1 },
      delivery_date:      { regex: '^LYS1R\\s+\\S+\\s+%?\\s*.+?\\s+(\\d{2}/\\d{2}/\\d{4})\\s+\\d{2}/\\d{2}/\\d{4}\\b', group: 1, transform: 'mmddyyyy_to_iso' },
      cancel_date:        { regex: '^LYS1R\\s+\\S+\\s+%?\\s*.+?\\s+\\d{2}/\\d{2}/\\d{4}\\s+(\\d{2}/\\d{2}/\\d{4})\\b', group: 1, transform: 'mmddyyyy_to_iso' },
      total_commande:     { regex: 'Total\\s*Commande\\s*(\\d+)\\s*([\\d,\\.]+)', groups: { units: 1, amount: 2 } },
    },
    consignment_detection: {
      // customer_reference containing "consigne" or "consignment" (case-insensitive) flags is_consignment=true
      regex: 'consign',
      flags: 'i',
    },
  },
  notes: 'Format 6-PO/file confirmed. Sizes on horizontal grid, 2-row product blocks. See lib/parsers/oui-eurostyle.js.',
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. color_translations — GLOBAL. Raw supplier text → French color name
//    (WITHOUT the supplier code — code is appended per product at intake).
//
//    Rules (validated with Mortar 2026-08):
//    - Composed colors keep BOTH translated words (dk/lt prefixes dropped,
//      tertiary words like "black" in "dk brown grey black" dropped).
//    - Uncertain / brand-specific names stay in English (Mysterioso,
//      Cloud dancer, Gardenia, Mulch, River stone, Bright blue denim,
//      Whitecap).
//    Order matters: "brown blue" → "Brun bleu" (brown primary, blue modifier),
//    following the source order.
// ─────────────────────────────────────────────────────────────────────────────
const COLOR_MAP = {
  'black':               'Noir',
  'blue':                'Bleu',
  'blue blue':           'Bleu',                    // supplier artefact, code disambiguates from 5400
  'bright blue denim':   'Bright blue denim',       // EN — uncertain
  'brown':               'Brun',
  'camel violet':        'Chameau violet',
  'cloud dancer':        'Cloud dancer',            // EN — uncertain
  'dk blue camel':       'Bleu chameau',
  'dk blue grey':        'Bleu gris',
  'dk brown camel':      'Brun chameau',
  'dk brown grey black': 'Brun gris',               // tertiary "black" dropped
  'dk violet blue':      'Violet bleu',
  'dk violett orange':   'Violet orange',
  'gardenia':            'Gardenia',                // EN — uncertain
  'lilac yellow':        'Lilas jaune',
  'lt brown blue':       'Brun bleu',
  'lt stone':            'Pierre',
  'lt stone taupe':      'Pierre taupe',
  'mulch':               'Mulch',                   // EN — uncertain
  'mysterioso':          'Mysterioso',              // EN — uncertain
  'offwhite':            'Blanc cassé',
  'river stone':         'River stone',             // EN — uncertain
  'steel grey':          'Gris acier',
  'ultra violett':       'Ultra violet',
  'washedout black':     'Noir délavé',
  'white blue':          'Blanc bleu',
  'white violet':        'Blanc violet',
  'whitecap grey':       'Whitecap gris',           // "whitecap" kept EN (uncertain)
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. brand_vendor_map — per-tenant.
// ─────────────────────────────────────────────────────────────────────────────
const VENDOR_MAP = {
  manufacturer: 'Oui',
  vendor_id:    '70',
  vendor_name:  'EUROSTYLE',
};

// ═════════════════════════════════════════════════════════════════════════════
async function seedRecipe(client) {
  const res = await client.query(
    `INSERT INTO parse_recipes
       (supplier_key, version, file_kind, detection, layout, target_manufacturer, default_attribute_set_id, notes)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8)
     ON CONFLICT (supplier_key, version) DO UPDATE
       SET file_kind                = EXCLUDED.file_kind,
           detection                = EXCLUDED.detection,
           layout                   = EXCLUDED.layout,
           target_manufacturer      = EXCLUDED.target_manufacturer,
           default_attribute_set_id = EXCLUDED.default_attribute_set_id,
           notes                    = EXCLUDED.notes,
           active                   = true
     RETURNING recipe_id, (xmax = 0) AS inserted`,
    [
      RECIPE.supplier_key,
      RECIPE.version,
      RECIPE.file_kind,
      JSON.stringify(RECIPE.detection),
      JSON.stringify(RECIPE.layout),
      RECIPE.target_manufacturer,
      RECIPE.default_attribute_set_id,
      RECIPE.notes,
    ]
  );
  const { recipe_id, inserted } = res.rows[0];
  console.log(`  parse_recipes[${RECIPE.supplier_key} v${RECIPE.version}] → recipe_id=${recipe_id} (${inserted ? 'inserted' : 'updated'})`);
  return recipe_id;
}

async function seedColors(client) {
  const entries = Object.entries(COLOR_MAP);
  let inserted = 0, updated = 0;
  for (const [raw, normalized] of entries) {
    const r = await client.query(
      `INSERT INTO color_translations (supplier_key, raw_color, normalized)
       VALUES ($1, $2, $3)
       ON CONFLICT (supplier_key, raw_color) DO UPDATE
         SET normalized = EXCLUDED.normalized
       RETURNING (xmax = 0) AS inserted`,
      [RECIPE.supplier_key, raw, normalized]
    );
    if (r.rows[0].inserted) inserted++; else updated++;
  }
  console.log(`  color_translations[${RECIPE.supplier_key}] → ${entries.length} rows (${inserted} inserted, ${updated} updated)`);
}

async function seedVendorMap(client) {
  const check = await client.query(`SELECT 1 FROM tenants WHERE id = $1`, [TENANT_ID]);
  if (!check.rowCount) {
    console.error(`FATAL: tenant '${TENANT_ID}' not in tenants table — cannot seed brand_vendor_map.`);
    process.exit(1);
  }
  const r = await client.query(
    `INSERT INTO brand_vendor_map (tenant_id, manufacturer, vendor_id, vendor_name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, manufacturer) DO UPDATE
       SET vendor_id   = EXCLUDED.vendor_id,
           vendor_name = EXCLUDED.vendor_name,
           updated_at  = now()
     RETURNING (xmax = 0) AS inserted`,
    [TENANT_ID, VENDOR_MAP.manufacturer, VENDOR_MAP.vendor_id, VENDOR_MAP.vendor_name]
  );
  const inserted = r.rows[0].inserted;
  console.log(`  brand_vendor_map[${TENANT_ID}: ${VENDOR_MAP.manufacturer} → ${VENDOR_MAP.vendor_id} ${VENDOR_MAP.vendor_name}] (${inserted ? 'inserted' : 'updated'})`);
}

async function main() {
  console.log(`Seeding Oui/Eurostyle recipe + colors + vendor map`);
  console.log(`  tenant_id = ${TENANT_ID}`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await seedRecipe(client);
    await seedColors(client);
    await seedVendorMap(client);
    await client.query('COMMIT');
    console.log(`\nDone. All three seeds committed.`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(`FATAL: rolled back. ${e.message}`);
    console.error(e.stack);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
