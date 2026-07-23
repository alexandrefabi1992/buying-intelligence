#!/usr/bin/env node
/**
 * scripts/refetch-null-tags.js
 *
 * Re-fetches from Lightspeed API all products that have tags=null
 * (non-stubs, with sales in the last 2 years) to pick up their real tags.
 *
 * This fixes items like the 4 Brax "766508 MARY" variants that got tags=null
 * because the Lightspeed API returned Manufacturer=null on the bulk sync.
 *
 * DRY_RUN=1 (default) — reports affected items, no writes
 * DRY_RUN=0           — re-fetches and upserts each item
 *
 * Optional: MANUFACTURER=brax — restrict to one manufacturer
 *
 * Usage:
 *   node scripts/refetch-null-tags.js              # dry run, all manufacturers
 *   MANUFACTURER=brax node scripts/refetch-null-tags.js    # dry run, Brax only
 *   DRY_RUN=0 node scripts/refetch-null-tags.js    # write, all manufacturers
 */

require('dotenv').config({ path: '.env.local' });
const { Pool } = require('pg');
const axios = require('axios');

const DRY_RUN      = process.env.DRY_RUN !== '0';
const TENANT       = process.env.SYNC_TENANT_ID || 'valerie-simon';
const MFG_FILTER   = process.env.MANUFACTURER ?? null;
const BASE_URL     = `https://api.lightspeedapp.com/API/V3/Account/${process.env.LIGHTSPEED_ACCOUNT_ID}`;
const TOKEN_URL    = 'https://cloud.lightspeedapp.com/oauth/access_token.php';
const API_TIMEOUT  = 30_000;
const BATCH_DELAY  = 150; // ms between API calls to stay under rate limit

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway.internal')
    ? false
    : { rejectUnauthorized: false },
});

// ── Token ──────────────────────────────────────────────────────────────────
let _token = null;
let _tokenExp = 0;

async function getToken() {
  if (_token && Date.now() < _tokenExp - 30_000) return _token;
  const { data } = await axios.post(TOKEN_URL, new URLSearchParams({
    client_id:     process.env.LIGHTSPEED_CLIENT_ID,
    client_secret: process.env.LIGHTSPEED_CLIENT_SECRET,
    refresh_token: process.env.LIGHTSPEED_REFRESH_TOKEN,
    grant_type:    'refresh_token',
  }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  _token    = data.access_token;
  _tokenExp = Date.now() + data.expires_in * 1_000;
  return _token;
}

async function apiGet(path, params = {}) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const token = await getToken();
      const res = await axios.get(`${BASE_URL}/${path}.json?${new URLSearchParams(params)}`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: API_TIMEOUT,
      });
      return res.data;
    } catch (err) {
      const status = err.response?.status ?? 0;
      if (status === 429 || err.code === 'ECONNABORTED' || status >= 500) {
        const wait = status === 429
          ? Math.max(parseInt(err.response?.headers?.['retry-after'] ?? '5', 10) * 1000, 5000)
          : Math.min(2000 * 2 ** (attempt - 1), 60_000);
        await new Promise(r => setTimeout(r, wait));
      } else {
        throw err;
      }
    }
  }
  throw new Error(`API failed after 6 attempts: ${path}`);
}

// ── Upsert ─────────────────────────────────────────────────────────────────
async function upsertProduct(item, mfgMap) {
  const manufacturer = item.Manufacturer?.name ?? mfgMap.get(String(item.manufacturerID ?? '')) ?? null;
  const tagsRaw = item.Tags?.tag;
  const tags    = (tagsRaw && tagsRaw !== 'false') ? String(tagsRaw).trim() : null;
  const category = item.Category?.fullPathName ?? item.Category?.name ?? item.categoryID ?? null;
  const defaultPrice = item.Prices?.ItemPrice?.[0]?.amount ?? item.defaultPrice ?? null;

  await pool.query(
    `INSERT INTO products(item_id, matrix_id, description, manufacturer, tags,
        category, default_cost, default_price, archived, raw, tenant_id, stub_inferred_fields)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL)
     ON CONFLICT(tenant_id, item_id) DO UPDATE
       SET description=$3, manufacturer=$4, tags=$5, category=$6,
           default_cost=$7, default_price=$8, archived=$9, raw=$10,
           stub_inferred_fields=NULL, synced_at=now()`,
    [
      item.itemID, item.itemMatrixID ?? null,
      item.description, manufacturer, tags, category,
      item.defaultCost ?? null, defaultPrice,
      item.archived === 'true', item, TENANT,
    ],
  );
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  REFETCH NULL TAGS — ${DRY_RUN ? 'DRY RUN' : '⚠️  ÉCRITURE RÉELLE'}`);
  if (MFG_FILTER) console.log(`  Filtre manufacturier : ${MFG_FILTER}`);
  console.log(`  Démarrage : ${new Date().toISOString()}`);
  console.log(`${'═'.repeat(60)}\n`);

  // Load manufacturer map for fallback resolution (table may not exist if sync hasn't run yet)
  let mfgMap = new Map();
  try {
    const { rows: mfgRows } = await pool.query(
      `SELECT manufacturer_id, name FROM manufacturers WHERE tenant_id = $1`, [TENANT],
    );
    mfgMap = new Map(mfgRows.map(r => [r.manufacturer_id, r.name]));
    console.log(`Manufacturers dans la table locale : ${mfgMap.size}`);
  } catch {
    console.log('Table manufacturers absente — résolution par relation API uniquement.');
  }

  // Find all non-stub products with tags=null and sales in the last 2 years
  const mfgCondition = MFG_FILTER
    ? `AND p.manufacturer ILIKE $2`
    : '';
  const params = MFG_FILTER ? [TENANT, `%${MFG_FILTER}%`] : [TENANT];

  const { rows: candidates } = await pool.query(
    `SELECT DISTINCT p.item_id, p.manufacturer, p.description
     FROM products p
     JOIN sale_lines sl ON sl.item_id = p.item_id AND sl.tenant_id = p.tenant_id
     WHERE p.tenant_id = $1
       AND p.tags IS NULL
       AND p.stub_inferred_fields IS NULL
       ${mfgCondition}
       AND sl.completed_time > now() - interval '2 years'
     ORDER BY p.manufacturer, p.item_id`,
    params,
  );

  console.log(`Items à re-fetcher : ${candidates.length}`);
  if (candidates.length === 0) {
    console.log('Aucun item à corriger.');
    await pool.end();
    return;
  }

  // Show breakdown by manufacturer
  const byMfg = {};
  for (const r of candidates) {
    const mfg = r.manufacturer ?? '(null)';
    byMfg[mfg] = (byMfg[mfg] ?? 0) + 1;
  }
  const sorted = Object.entries(byMfg).sort((a, b) => b[1] - a[1]).slice(0, 20);
  console.log('\nTop manufacturiers affectés :');
  for (const [mfg, n] of sorted) {
    console.log(`  ${String(n).padStart(5)}  ${mfg}`);
  }

  if (DRY_RUN) {
    console.log('\nDRY RUN — aucune donnée modifiée.');
    console.log('Pour lancer le re-fetch réel : DRY_RUN=0 node scripts/refetch-null-tags.js');
    await pool.end();
    return;
  }

  // Re-fetch each item from Lightspeed API
  let updated = 0, tagsFound = 0, still404 = 0, errors = 0;
  const RELS = JSON.stringify(['Tags', 'Category', 'Manufacturer']);

  for (let i = 0; i < candidates.length; i++) {
    const { item_id, manufacturer, description } = candidates[i];
    try {
      const data = await apiGet(`Item/${item_id}`, { load_relations: RELS });
      const item = data?.Item;
      if (!item) {
        still404++;
        console.log(`  [404] item_id=${item_id} (${manufacturer} — ${description?.slice(0, 40)})`);
        continue;
      }
      const tagsRaw = item.Tags?.tag;
      const tags = (tagsRaw && tagsRaw !== 'false') ? String(tagsRaw).trim() : null;
      await upsertProduct(item, mfgMap);
      updated++;
      if (tags) {
        tagsFound++;
        if (i < 20 || tags) {
          console.log(`  [OK]  item_id=${item_id} tags="${tags}" (${item.Manufacturer?.name ?? manufacturer})`);
        }
      } else {
        console.log(`  [OK]  item_id=${item_id} tags=null (toujours absent de Lightspeed)`);
      }
    } catch (err) {
      errors++;
      console.error(`  [ERR] item_id=${item_id}: ${err.response?.status ?? err.message}`);
    }
    if (BATCH_DELAY > 0) await new Promise(r => setTimeout(r, BATCH_DELAY));
    if ((i + 1) % 50 === 0) {
      console.log(`  ... ${i + 1}/${candidates.length} traités (${tagsFound} tags trouvés)`);
    }
  }

  console.log('\n══ RÉSUMÉ ══════════════════════════════════════════════════════');
  console.log(`  Items re-fetchés           : ${updated}`);
  console.log(`  Tags récupérés             : ${tagsFound}`);
  console.log(`  Tags toujours null         : ${updated - tagsFound}`);
  console.log(`  404 (vraiment supprimés)   : ${still404}`);
  console.log(`  Erreurs                    : ${errors}`);
  console.log(`  Terminé : ${new Date().toISOString()}`);

  await pool.end();
}

main().catch(err => {
  console.error('\n[ERREUR]', err.message);
  pool.end();
  process.exit(1);
});
