#!/usr/bin/env node
/**
 * reconcile-lightspeed.js
 *
 * Compare un export CSV Lightspeed "Ventes par Marque" (détail des lignes)
 * avec nos sale_lines en DB pour identifier la règle exacte d'écart.
 *
 * Usage:
 *   node scripts/reconcile-lightspeed.js <SAISON> <fichier.csv> [--manufacturer=<marque>]
 *
 *   Exemples:
 *     node scripts/reconcile-lightspeed.js p25 lightspeed-p25.csv
 *     node scripts/reconcile-lightspeed.js p25 lightspeed-p25.csv --manufacturer=Oui
 *
 * L'export CSV Lightspeed doit idéalement contenir ces colonnes
 * (adapter COLUMN_MAP ci-dessous si les noms diffèrent) :
 *   - Numéro de vente / Sale ID / Ticket Number  → identifiant de la transaction
 *   - SKU / Code article / Item ID               → identifiant produit
 *   - Quantité / Qty                             → unités vendues
 *   - Prix unitaire / Unit Price                 → prix de vente
 *   - Sous-total / Subtotal                      → montant ligne
 *   - Date / Completed Date                      → date de la vente
 *   - Boutique / Shop / Location                 → point de vente
 *   - Marque / Manufacturer / Brand              → fabricant (optionnel si déjà filtré)
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

// ── Colonnes à adapter selon le format réel du CSV Lightspeed ──────────────
// Clé = nom de colonne utilisé en interne, valeur = variantes possibles dans le CSV
// (insensible à la casse, correspondance partielle si le header contient la valeur)
const COLUMN_MAP = {
  sale_id:    ['numéro de vente', 'sale id', 'ticket', 'vente', 'ticket number', 'sale number'],
  item_id:    ['item id', 'article id', 'sku', 'code article', 'identifiant article'],
  qty:        ['quantité', 'qty', 'quantity', 'qté'],
  unit_price: ['prix unitaire', 'unit price', 'prix'],
  subtotal:   ['sous-total', 'subtotal', 'montant', 'total ligne'],
  date:       ['date', 'completed', 'date de vente', 'completed date'],
  shop:       ['boutique', 'shop', 'location', 'magasin', 'point de vente'],
  manufacturer: ['marque', 'manufacturer', 'brand', 'fabricant'],
};

// ── Config DB ───────────────────────────────────────────────────────────────
const DB_URL    = process.env.DATABASE_URL
  || 'postgresql://postgres:EBWQzqWDOMnqFvLbKUrzlKXWUgyXIQQp@zephyr.proxy.rlwy.net:38019/railway';
const TENANT_ID = process.env.TENANT_ID || 'valerie-simon';

// ── Saisons (identiques à server.js) ───────────────────────────────────────
const SEASONS = [
  { code:'p23', reception_from:'2022-10-01', sell_from:'2023-02-01', sell_to:'2023-09-30', tag_pattern:'p23' },
  { code:'a23', reception_from:'2023-05-01', sell_from:'2023-09-01', sell_to:'2024-02-28', tag_pattern:'a23' },
  { code:'p24', reception_from:'2023-10-01', sell_from:'2024-02-01', sell_to:'2024-09-30', tag_pattern:'p24' },
  { code:'a24', reception_from:'2024-05-01', sell_from:'2024-09-01', sell_to:'2025-02-28', tag_pattern:'a24' },
  { code:'p25', reception_from:'2024-10-01', sell_from:'2025-02-01', sell_to:'2025-09-30', tag_pattern:'p25' },
  { code:'a25', reception_from:'2025-05-01', sell_from:'2025-09-01', sell_to:'2026-02-28', tag_pattern:'a25' },
  { code:'p26', reception_from:'2025-10-01', sell_from:'2026-02-01', sell_to:'2026-09-30', tag_pattern:'p26' },
];

// ── Helpers ─────────────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: node scripts/reconcile-lightspeed.js <SAISON> <fichier.csv> [--manufacturer=<marque>]');
    process.exit(1);
  }
  const seasonCode   = args[0].toLowerCase();
  const csvPath      = args[1];
  const mfgArg       = args.find(a => a.startsWith('--manufacturer='));
  const manufacturer = mfgArg ? mfgArg.split('=')[1] : null;
  return { seasonCode, csvPath, manufacturer };
}

function findHeader(headers, variants) {
  const lc = headers.map(h => h.toLowerCase().trim());
  for (const v of variants) {
    const idx = lc.findIndex(h => h.includes(v.toLowerCase()));
    if (idx !== -1) return idx;
  }
  return -1;
}

function parseCSV(filePath) {
  const raw  = fs.readFileSync(filePath, 'utf8');
  // Support \r\n and \r
  const lines = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const nonEmpty = lines.filter(l => l.trim());
  if (nonEmpty.length < 2) throw new Error('CSV vide ou sans données.');

  // Detect delimiter (comma or semicolon)
  const firstLine = nonEmpty[0];
  const delimiter = (firstLine.split(';').length > firstLine.split(',').length) ? ';' : ',';

  const splitLine = line => {
    const cells = [];
    let cur = '', inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === delimiter && !inQ) { cells.push(cur.trim()); cur = ''; }
      else { cur += ch; }
    }
    cells.push(cur.trim());
    return cells;
  };

  const headers = splitLine(nonEmpty[0]);
  const colIdx  = {};
  for (const [key, variants] of Object.entries(COLUMN_MAP)) {
    colIdx[key] = findHeader(headers, variants);
  }

  // Report column mapping
  console.log('\n── Mapping des colonnes CSV ──────────────────────────────────');
  for (const [key, idx] of Object.entries(colIdx)) {
    const found = idx !== -1 ? `"${headers[idx]}" (col ${idx + 1})` : '⚠️  NON TROUVÉE';
    console.log(`  ${key.padEnd(14)} → ${found}`);
  }
  if (colIdx.sale_id === -1) throw new Error('Colonne sale_id introuvable — ajuster COLUMN_MAP.');
  if (colIdx.qty     === -1) throw new Error('Colonne qty introuvable — ajuster COLUMN_MAP.');

  const rows = [];
  for (let i = 1; i < nonEmpty.length; i++) {
    const cells = splitLine(nonEmpty[i]);
    if (cells.length < 2) continue;
    const get = key => colIdx[key] !== -1 ? (cells[colIdx[key]] ?? '').replace(/"/g, '').trim() : '';
    rows.push({
      sale_id:      get('sale_id'),
      item_id:      get('item_id'),
      qty:          parseFloat(get('qty').replace(',', '.')) || 0,
      unit_price:   parseFloat(get('unit_price').replace(',', '.').replace(/[^0-9.\-]/g, '')) || 0,
      subtotal:     parseFloat(get('subtotal').replace(',', '.').replace(/[^0-9.\-]/g, '')) || 0,
      date:         get('date'),
      shop:         get('shop'),
      manufacturer: get('manufacturer'),
    });
  }
  return rows;
}

async function loadDBLines(pool, season, manufacturer) {
  const tag  = season.tag_pattern;
  const from = season.reception_from ?? season.sell_from;
  const to   = season.sell_to;

  const params = [TENANT_ID, from, to, `%${tag}%`];
  let mfgClause = '';
  if (manufacturer) {
    params.push(`%${manufacturer}%`);
    mfgClause = `AND p.manufacturer ILIKE $${params.length}`;
  }

  const sql = `
    SELECT
      sl.sale_line_id,
      sl.sale_id,
      sl.item_id,
      sl.qty,
      sl.unit_price,
      sl.discount  AS calc_line_discount,
      sl.completed_time,
      sl.shop_id,
      sh.name      AS shop_name,
      p.manufacturer,
      p.description,
      p.tags,
      sl.raw,
      s.raw        AS sale_raw
    FROM sale_lines sl
    JOIN products p  ON p.item_id  = sl.item_id  AND p.tenant_id = sl.tenant_id
    LEFT JOIN shops sh ON sh.shop_id = sl.shop_id AND sh.tenant_id = sl.tenant_id
    LEFT JOIN sales s  ON s.sale_id  = sl.sale_id AND s.tenant_id  = sl.tenant_id
    WHERE sl.tenant_id      = $1
      AND sl.completed_time BETWEEN $2 AND $3
      AND p.tags ILIKE $4
      ${mfgClause}
    ORDER BY sl.completed_time
  `;

  const { rows } = await pool.query(sql, params);
  return rows;
}

function buildKey(saleId, itemId) {
  return `${String(saleId).trim()}__${String(itemId).trim()}`;
}

function fmt(n) { return (n ?? 0).toLocaleString('fr-CA', { minimumFractionDigits: 2 }); }

function printRow(label, row, dbRow) {
  console.log(`\n  ${label}`);
  if (row) {
    console.log(`    CSV  → sale_id=${row.sale_id}  item_id=${row.item_id}  qty=${row.qty}  prix=${row.unit_price}  date=${row.date}  boutique=${row.shop}`);
  }
  if (dbRow) {
    const r      = dbRow.raw   ?? {};
    const sr     = dbRow.sale_raw ?? {};
    const subtot = parseFloat(r.calcSubtotal ?? 0);
    const disc   = parseFloat(r.calcLineDiscount ?? dbRow.calc_line_discount ?? 0);
    console.log(`    DB   → sale_id=${dbRow.sale_id}  item_id=${dbRow.item_id}  qty=${dbRow.qty}  prix=${dbRow.unit_price}  date=${dbRow.completed_time?.toISOString().slice(0,10)}  boutique=${dbRow.shop_name ?? dbRow.shop_id}`);
    console.log(`    DB meta → isLayaway=${r.isLayaway}  saleType=${sr.saleType ?? 'null'}  completed=${sr.completed}  voided=${sr.voided}  balance=${sr.balance}  sale_total=${sr.total}`);
    console.log(`    DB raw line → calcSubtotal=${subtot}  calcLineDiscount=${disc}  net=${subtot - disc}  parentSaleLineID=${r.parentSaleLineID}  lineType=${JSON.stringify(r.lineType)}`);
    console.log(`    tags: ${dbRow.tags}`);
    if (process.env.SHOW_RAW) {
      console.log(`    RAW LINE: ${JSON.stringify(r, null, 2)}`);
    }
  }
}

async function main() {
  const { seasonCode, csvPath, manufacturer } = parseArgs();

  const season = SEASONS.find(s => s.code === seasonCode);
  if (!season) {
    console.error(`Saison inconnue: ${seasonCode}. Valeurs possibles: ${SEASONS.map(s => s.code).join(', ')}`);
    process.exit(1);
  }

  if (!fs.existsSync(csvPath)) {
    console.error(`Fichier introuvable: ${csvPath}`);
    process.exit(1);
  }

  console.log(`\n═══════════════════════════════════════════════════════════════`);
  console.log(` Réconciliation ${seasonCode.toUpperCase()} — ${season.reception_from ?? season.sell_from} → ${season.sell_to}`);
  if (manufacturer) console.log(` Filtre marque: ${manufacturer}`);
  console.log(`═══════════════════════════════════════════════════════════════`);

  // 1. Parse CSV
  console.log(`\n[1/3] Chargement CSV: ${path.basename(csvPath)}`);
  const csvRows = parseCSV(csvPath);
  console.log(`  → ${csvRows.length} lignes CSV chargées`);

  // Filter CSV by manufacturer if requested
  const csvFiltered = manufacturer
    ? csvRows.filter(r => !r.manufacturer || r.manufacturer.toLowerCase().includes(manufacturer.toLowerCase()))
    : csvRows;
  if (manufacturer) console.log(`  → ${csvFiltered.length} lignes après filtre marque`);

  // Build CSV map: key → row (keep first occurrence; track all for multi-line)
  const csvMap = new Map();
  for (const row of csvFiltered) {
    if (!row.sale_id) continue;
    const key = buildKey(row.sale_id, row.item_id);
    if (!csvMap.has(key)) csvMap.set(key, []);
    csvMap.get(key).push(row);
  }

  // 2. Load DB lines
  console.log(`\n[2/3] Chargement DB (tenant=${TENANT_ID})…`);
  const pool   = new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  const dbRows = await loadDBLines(pool, season, manufacturer);
  await pool.end();
  console.log(`  → ${dbRows.length} lignes DB chargées`);

  const dbMap = new Map();
  for (const row of dbRows) {
    const key = buildKey(row.sale_id, row.item_id);
    if (!dbMap.has(key)) dbMap.set(key, []);
    dbMap.get(key).push(row);
  }

  // 3. Reconcile
  const onlyInLS   = [];  // in CSV not in DB
  const onlyInDB   = [];  // in DB not in CSV
  const qtyMismatch = []; // both sides, qty differs

  // (a) in Lightspeed but not in our DB
  for (const [key, lsRows] of csvMap) {
    if (!dbMap.has(key)) {
      onlyInLS.push({ key, lsRows, dbRows: null });
    } else {
      const lsQty = lsRows.reduce((s, r) => s + r.qty, 0);
      const dbQty = dbMap.get(key).reduce((s, r) => s + parseFloat(r.qty), 0);
      if (Math.abs(lsQty - dbQty) > 0.001) {
        qtyMismatch.push({ key, lsRows, dbRows: dbMap.get(key), lsQty, dbQty });
      }
    }
  }

  // (b) in our DB but not in Lightspeed
  for (const [key, rows] of dbMap) {
    if (!csvMap.has(key)) {
      onlyInDB.push({ key, dbRows: rows, lsRows: null });
    }
  }

  // ── Résumé unités ──────────────────────────────────────────────────────
  const lsTotalUnits = csvFiltered.reduce((s, r) => s + r.qty, 0);
  const dbTotalUnits = dbRows.reduce((s, r) => s + parseFloat(r.qty), 0);
  const dbGrossUnits = dbRows.reduce((s, r) => s + (parseFloat(r.qty) > 0 ? parseFloat(r.qty) : 0), 0);

  console.log(`\n[3/3] Résultats de réconciliation`);
  console.log(`\n  Totaux:`);
  console.log(`    Lightspeed CSV  : ${lsTotalUnits} unités (${csvMap.size} sale×item combos)`);
  console.log(`    Notre DB (net)  : ${dbTotalUnits} unités (${dbMap.size} sale×item combos)`);
  console.log(`    Notre DB (gross): ${dbGrossUnits} unités`);
  console.log(`    Écart net       : ${lsTotalUnits - dbTotalUnits > 0 ? '+' : ''}${(lsTotalUnits - dbTotalUnits).toFixed(0)} unités vs Lightspeed`);

  console.log(`\n  Divergences:`);
  console.log(`    (a) Dans Lightspeed MAIS PAS dans notre DB : ${onlyInLS.length} combos`);
  console.log(`    (b) Dans notre DB MAIS PAS dans Lightspeed  : ${onlyInDB.length} combos`);
  console.log(`    (c) Dans les deux mais qty différente        : ${qtyMismatch.length} combos`);

  // ── Détail (a) ─────────────────────────────────────────────────────────
  if (onlyInLS.length > 0) {
    console.log(`\n\n════ (a) DANS LIGHTSPEED — ABSENTS DE NOTRE DB (${onlyInLS.length}) ════`);
    let totalUnits = 0;
    for (const { key, lsRows } of onlyInLS) {
      totalUnits += lsRows.reduce((s, r) => s + r.qty, 0);
      for (const row of lsRows) {
        printRow(`sale_id=${row.sale_id}  item_id=${row.item_id}`, row, null);
      }
    }
    console.log(`\n  Sous-total (a): ${totalUnits} unités manquantes dans notre DB`);
  }

  // ── Détail (b) ─────────────────────────────────────────────────────────
  if (onlyInDB.length > 0) {
    console.log(`\n\n════ (b) DANS NOTRE DB — ABSENTS DE LIGHTSPEED (${onlyInDB.length}) ════`);
    let totalUnits = 0;
    for (const { key, dbRows: rows } of onlyInDB) {
      for (const dbRow of rows) {
        const qty = parseFloat(dbRow.qty);
        totalUnits += qty;
        printRow(`sale_id=${dbRow.sale_id}  item_id=${dbRow.item_id}  qty=${qty}`, null, dbRow);
      }
    }
    console.log(`\n  Sous-total (b): ${totalUnits} unités en surplus dans notre DB`);
  }

  // ── Détail (c) ─────────────────────────────────────────────────────────
  if (qtyMismatch.length > 0) {
    console.log(`\n\n════ (c) QTY DIFFÉRENTE (${qtyMismatch.length}) ════`);
    for (const { lsRows, dbRows: rows, lsQty, dbQty } of qtyMismatch) {
      const row = lsRows[0];
      console.log(`\n  sale_id=${row.sale_id}  item_id=${row.item_id}  LS=${lsQty}  DB=${dbQty}  écart=${dbQty - lsQty > 0 ? '+' : ''}${(dbQty - lsQty).toFixed(0)}`);
      for (const dbRow of rows) printRow('  DB line', lsRows[0], dbRow);
    }
  }

  // ── Analyse des champs discriminants pour liste (b) ───────────────────
  if (onlyInDB.length > 0) {
    console.log(`\n\n════ ANALYSE CHAMPS DISCRIMINANTS — liste (b) ════`);
    const counts = {
      isLayaway_true: 0, isLayaway_false: 0,
      saleType_null: 0, saleType_other: {},
      voided_true: 0, voided_false: 0,
      completed_true: 0, completed_false: 0,
      balance_nonzero: 0, balance_zero: 0,
      sale_total_zero: 0, sale_total_nonzero: 0,
      parentSaleLineID_nonzero: 0, parentSaleLineID_zero: 0,
      lineType_empty: 0, lineType_other: {},
    };
    let totalSurplusUnits = 0;

    for (const { dbRows: rows } of onlyInDB) {
      for (const dbRow of rows) {
        const r  = dbRow.raw ?? {};
        const sr = dbRow.sale_raw ?? {};
        const qty = parseFloat(dbRow.qty);
        totalSurplusUnits += qty;

        if (r.isLayaway === 'true')  counts.isLayaway_true++;
        else                         counts.isLayaway_false++;

        const sType = sr.saleType ?? 'null';
        if (sType === 'null') counts.saleType_null++;
        else counts.saleType_other[sType] = (counts.saleType_other[sType] ?? 0) + 1;

        if (sr.voided === 'true')    counts.voided_true++; else counts.voided_false++;
        if (sr.completed === 'true') counts.completed_true++; else counts.completed_false++;

        const bal = parseFloat(sr.balance ?? 0);
        if (bal !== 0) counts.balance_nonzero++; else counts.balance_zero++;

        const tot = parseFloat(sr.total ?? 0);
        if (tot === 0) counts.sale_total_zero++; else counts.sale_total_nonzero++;

        const parentId = parseInt(r.parentSaleLineID ?? 0);
        if (parentId !== 0) counts.parentSaleLineID_nonzero++; else counts.parentSaleLineID_zero++;

        const lt = r.lineType ?? '';
        if (lt === '') counts.lineType_empty++;
        else counts.lineType_other[lt] = (counts.lineType_other[lt] ?? 0) + 1;
      }
    }

    console.log(`  Lignes en surplus (b): ${onlyInDB.length} combos, ${totalSurplusUnits} unités totales`);
    console.log(`  isLayaway      : true=${counts.isLayaway_true}  false=${counts.isLayaway_false}`);
    console.log(`  saleType       : null=${counts.saleType_null}  autres=${JSON.stringify(counts.saleType_other)}`);
    console.log(`  voided         : true=${counts.voided_true}  false=${counts.voided_false}`);
    console.log(`  completed      : true=${counts.completed_true}  false=${counts.completed_false}`);
    console.log(`  balance        : zéro=${counts.balance_zero}  non-zéro=${counts.balance_nonzero}`);
    console.log(`  sale total     : zéro=${counts.sale_total_zero}  non-zéro=${counts.sale_total_nonzero}`);
    console.log(`  parentSaleLineID: zéro=${counts.parentSaleLineID_zero}  non-zéro=${counts.parentSaleLineID_nonzero}`);
    console.log(`  lineType       : vide=${counts.lineType_empty}  autres=${JSON.stringify(counts.lineType_other)}`);
  }

  console.log(`\n═══════════════════════════════════════════════════════════════`);
  console.log(` Fin de la réconciliation`);
  console.log(` Astuce: relancer avec SHOW_RAW=1 pour voir le JSON complet des lignes divergentes`);
  console.log(`═══════════════════════════════════════════════════════════════\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
