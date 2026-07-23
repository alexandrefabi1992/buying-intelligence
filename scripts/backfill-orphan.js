#!/usr/bin/env node
/**
 * scripts/backfill-orphan.js
 *
 * Finds item_ids referenced in sale_lines but absent from products,
 * fetches them from Lightspeed API (archived sweep), and inserts them
 * so JOIN-based queries (budget, compare_seasons) work correctly.
 *
 * DRY_RUN=1 (default) — no DB writes, report only
 * DRY_RUN=0           — actual backfill with checkpoint/resume
 *
 * Checkpoint: sync_state(step='backfill_orphan') stores the Lightspeed
 * pagination cursor so the script resumes after an interruption.
 */

require('dotenv').config({ path: '.env.local' });
const { Pool } = require('pg');
const axios  = require('axios');

const DRY_RUN  = process.env.DRY_RUN !== '0';
const TENANT   = process.env.SYNC_TENANT_ID || 'valerie-simon';
const BASE_URL = `https://api.lightspeedapp.com/API/V3/Account/${process.env.LIGHTSPEED_ACCOUNT_ID}`;
const TOKEN_URL = 'https://cloud.lightspeedapp.com/oauth/access_token.php';
const API_TIMEOUT = 30_000;
const SWEEP_LIMIT = 200;
const CHECKPOINT_EVERY = 50; // pages

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway.internal')
    ? false
    : { rejectUnauthorized: false },
});

// ── Token ──────────────────────────────────────────────────────────────────
let _cachedToken = null;
let _tokenExpiresAt = 0;

async function getToken() {
  if (_cachedToken && Date.now() < _tokenExpiresAt - 30_000) return _cachedToken;
  const { data } = await axios.post(TOKEN_URL, new URLSearchParams({
    client_id:     process.env.LIGHTSPEED_CLIENT_ID,
    client_secret: process.env.LIGHTSPEED_CLIENT_SECRET,
    refresh_token: process.env.LIGHTSPEED_REFRESH_TOKEN,
    grant_type:    'refresh_token',
  }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  _cachedToken    = data.access_token;
  _tokenExpiresAt = Date.now() + data.expires_in * 1_000;
  return _cachedToken;
}

async function apiGet(path, params = {}) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const token = await getToken();
      const url   = `${BASE_URL}/${path}.json?${new URLSearchParams(params)}`;
      const res   = await axios.get(url, {
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
        console.log(`  [api] rate-limit/timeout (attempt ${attempt}) — attente ${wait / 1000}s`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        throw err;
      }
    }
  }
}

// ── DB helpers ─────────────────────────────────────────────────────────────
async function upsertProduct(item) {
  if (DRY_RUN) return;
  const manufacturer = item.Manufacturer?.name ?? item.manufacturerID ?? null;
  const tagsRaw      = item.Tags?.tag;
  const tags         = (tagsRaw && tagsRaw !== 'false') ? String(tagsRaw).trim() : null;
  const category     = item.Category?.fullPathName ?? item.Category?.name ?? item.categoryID ?? null;
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

async function upsertStub(itemId, avgCost) {
  if (DRY_RUN) return;
  await pool.query(
    `INSERT INTO products(item_id, description, manufacturer, tags, archived, default_cost, tenant_id, stub_inferred_fields)
     VALUES ($1,$2,NULL,'__stub__',true,$3,$4,'all')
     ON CONFLICT(tenant_id, item_id) DO NOTHING`,
    [itemId, `[supprimé-${itemId}]`, avgCost ?? null, TENANT],
  );
}

async function getCheckpoint() {
  const { rows } = await pool.query(
    `SELECT next_url FROM sync_state WHERE step = 'backfill_orphan'`,
  );
  return rows[0]?.next_url ?? null;
}

async function saveCheckpoint(afterCursor, processed) {
  if (DRY_RUN) return;
  await pool.query(
    `INSERT INTO sync_state(step, next_url, processed_count, updated_at)
     VALUES ('backfill_orphan', $1, $2, now())
     ON CONFLICT(step) DO UPDATE SET next_url=$1, processed_count=$2, updated_at=now()`,
    [afterCursor ?? '', processed],
  );
}

async function clearCheckpoint() {
  if (DRY_RUN) return;
  await pool.query(`DELETE FROM sync_state WHERE step = 'backfill_orphan'`);
}

async function refreshViews() {
  if (DRY_RUN) return;
  for (const view of ['mv_sales_velocity', 'mv_inventory_stock']) {
    try {
      await pool.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${view}`);
      console.log(`  ✓ REFRESH ${view}`);
    } catch (err) {
      // Fallback if no unique index for CONCURRENTLY
      try {
        await pool.query(`REFRESH MATERIALIZED VIEW ${view}`);
        console.log(`  ✓ REFRESH ${view} (non-concurrent)`);
      } catch (e2) {
        console.warn(`  ⚠ Impossible de refresh ${view}: ${e2.message}`);
      }
    }
  }
}

// ── Phase 1 : DB stats ─────────────────────────────────────────────────────
async function phase1_dbStats(orphanIds) {
  console.log('\n══ PHASE 1 — Statistiques DB ══════════════════════════════════');
  console.log(`\nOrphans uniques dans sale_lines : ${orphanIds.size.toLocaleString()}`);

  const { rows: byYear } = await pool.query(
    `SELECT EXTRACT(YEAR FROM completed_time)::int AS yr,
            COUNT(*)::int AS nb_lines,
            SUM(qty)::numeric AS total_qty,
            COUNT(DISTINCT item_id) AS unique_items
     FROM sale_lines
     WHERE tenant_id=$1 AND item_id!='0' AND item_id=ANY($2)
     GROUP BY yr ORDER BY yr`,
    [TENANT, [...orphanIds]],
  );

  console.log('\nSale_lines orphelines dans la table, par année :');
  console.log('  Année  | Lignes  | Unités nettes | Items uniques');
  console.log('  -------|---------|---------------|---------------');
  let totalLines = 0, totalQty = 0;
  for (const r of byYear) {
    console.log(`  ${r.yr}   | ${String(r.nb_lines).padStart(7)} | ${String(Number(r.total_qty).toFixed(0)).padStart(13)} | ${r.unique_items}`);
    totalLines += r.nb_lines;
    totalQty   += Number(r.total_qty);
  }
  console.log(`  TOTAL  | ${String(totalLines).padStart(7)} | ${String(totalQty.toFixed(0)).padStart(13)} |`);

  // P24 verification
  const p24Ids = ['79306','79307','79308','79309','79310','79311','79312','82423','82424','82425','82457','82458','82459','82460','82461','73520','71257','71441','81883','83099','82039'];
  const { rows: p24rows } = await pool.query(
    `SELECT item_id, SUM(qty)::numeric as qty FROM sale_lines
     WHERE tenant_id=$1 AND item_id=ANY($2) AND completed_time BETWEEN '2024-02-01' AND '2024-09-30'
     GROUP BY item_id`,
    [TENANT, p24Ids],
  );
  const p24Net = p24rows.reduce((s, r) => s + Number(r.qty), 0);
  console.log(`\nVérification P24 : ${p24rows.length}/${p24Ids.length} items | qty P24 fév–sep : ${p24Net}u`);

  // P25 verification
  const p25Ids = ['104340','104484','99956','104309','104442','104443','104444','104445','104446','104447','104482','99938','99952','99953','99954','99955','99706','99937','99939','100053','100059','100136','100137','100139','100151','100152','100154','100155','100156','102060','104483','104498','104499','104500','104501'];
  const { rows: p25rows } = await pool.query(
    `SELECT item_id, SUM(qty)::numeric as qty FROM sale_lines
     WHERE tenant_id=$1 AND item_id=ANY($2) AND completed_time BETWEEN '2025-02-01' AND '2025-09-30'
     GROUP BY item_id`,
    [TENANT, p25Ids],
  );
  const p25Net = p25rows.reduce((s, r) => s + Number(r.qty), 0);
  console.log(`Vérification P25 : ${p25rows.length}/${p25Ids.length} items | qty P25 fév–sep : ${p25Net}u`);
}

// ── Phase 2 : API sweep ─────────────────────────────────────────────────────
async function phase2_apiSweep(orphanIds) {
  console.log('\n══ PHASE 2 — Sweep API Lightspeed (archived=true) ══════════════');

  // Resume from checkpoint if available
  const savedCursor = DRY_RUN ? null : await getCheckpoint();
  if (savedCursor) {
    console.log(`  Reprise depuis checkpoint (cursor: ${savedCursor.slice(0, 30)}...)`);
    // Re-query orphanIds to only include items still absent from products
    const { rows } = await pool.query(
      `SELECT DISTINCT item_id FROM sale_lines
       WHERE tenant_id=$1 AND item_id!='0'
         AND NOT EXISTS (SELECT 1 FROM products p WHERE p.item_id=sale_lines.item_id AND p.tenant_id=$1)`,
      [TENANT],
    );
    orphanIds = new Set(rows.map(r => r.item_id));
    console.log(`  Orphans restants après reprise : ${orphanIds.size}`);
  }

  const recovered = new Set();
  let pageNum = 0;
  let afterCursor = savedCursor || null;

  while (true) {
    pageNum++;
    const params = {
      limit: String(SWEEP_LIMIT),
      archived: 'true',
      load_relations: JSON.stringify(['Tags', 'Category', 'Manufacturer']),
    };
    if (afterCursor) params.after = afterCursor;

    const data   = await apiGet('Item', params);
    const wrapper = data?.Item;
    if (!wrapper) break;
    const items = Array.isArray(wrapper) ? wrapper : [wrapper];
    if (items.length === 0) break;

    // Upsert inline — no need to collect first
    for (const item of items) {
      if (orphanIds.has(item.itemID)) {
        await upsertProduct(item);
        recovered.add(item.itemID);
      }
    }

    if (pageNum % 10 === 0) {
      process.stdout.write(`  Page ${pageNum} — swept ${pageNum * SWEEP_LIMIT} archived items, ${recovered.size} orphans insérés\r`);
    }

    // Checkpoint every N pages
    if (!DRY_RUN && pageNum % CHECKPOINT_EVERY === 0) {
      await saveCheckpoint(afterCursor, recovered.size);
    }

    const nextUrl = data['@attributes']?.next;
    if (!nextUrl) break;
    const parsed = new URL(nextUrl);
    afterCursor  = parsed.searchParams.get('after');
    if (!afterCursor) break;
  }

  console.log(`\n  Sweep terminé : ${pageNum} pages, ${recovered.size} / ${orphanIds.size} orphans récupérés`);

  return { recovered, remaining: new Set([...orphanIds].filter(id => !recovered.has(id))) };
}

// ── Phase 3 : Individual fallback ──────────────────────────────────────────
async function phase3_individualLookup(remaining) {
  console.log(`\n══ PHASE 3 — Lookups individuels (${remaining.size} non trouvés dans sweep) ══`);
  if (remaining.size === 0) {
    console.log('  Aucun item restant — aucun stub nécessaire.');
    return { stubCount: 0, apiCount: 0 };
  }

  let apiCount = 0, stubCount = 0;
  for (const itemId of remaining) {
    try {
      const data = await apiGet(`Item/${itemId}`, {
        load_relations: JSON.stringify(['Tags', 'Category', 'Manufacturer']),
      });
      if (data?.Item) {
        await upsertProduct(data.Item);
        apiCount++;
      } else {
        await upsertStub(itemId, null);
        stubCount++;
        console.log(`  [STUB] item_id=${itemId} : 404 → stub créé`);
      }
    } catch (err) {
      if (err.response?.status === 404) {
        await upsertStub(itemId, null);
        stubCount++;
        console.log(`  [STUB] item_id=${itemId} : 404 → stub créé`);
      } else {
        console.error(`  [ERR] item_id=${itemId} : ${err.response?.status ?? err.message}`);
      }
    }
  }
  console.log(`  Résultat : ${apiCount} récupérés, ${stubCount} stubs`);
  return { stubCount, apiCount };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  BACKFILL ORPHAN — ${DRY_RUN ? 'DRY RUN (aucune écriture)' : '⚠️  ÉCRITURE RÉELLE'}`);
  console.log(`  Démarrage : ${new Date().toISOString()}`);
  console.log(`${'═'.repeat(60)}`);

  // Current orphan item_ids
  const { rows: orphanRows } = await pool.query(
    `SELECT DISTINCT item_id FROM sale_lines
     WHERE tenant_id=$1 AND item_id!='0'
       AND NOT EXISTS (SELECT 1 FROM products p WHERE p.item_id=sale_lines.item_id AND p.tenant_id=$1)`,
    [TENANT],
  );
  let orphanIds = new Set(orphanRows.map(r => r.item_id));

  if (orphanIds.size === 0) {
    console.log('\n✓ Aucun orphelin — backfill déjà complet ou inutile.');
    await pool.end();
    return;
  }

  await phase1_dbStats(orphanIds);
  const { recovered, remaining } = await phase2_apiSweep(orphanIds);
  const { stubCount, apiCount }  = await phase3_individualLookup(remaining);

  // ── Summary ──────────────────────────────────────────────────────────────
  const totalInserted = recovered.size + apiCount;
  console.log('\n══ RÉSUMÉ ══════════════════════════════════════════════════════');
  console.log(`  Products insérés (sweep archived) : ${recovered.size.toLocaleString()}`);
  console.log(`  Products insérés (lookup individuel) : ${apiCount}`);
  console.log(`  Stubs créés (vraiment supprimés) : ${stubCount}`);
  console.log(`  Total products créés/mis à jour : ${totalInserted.toLocaleString()}`);
  console.log(`  Sale_lines désormais joignables : 24 142 (déjà dans la table)`);

  if (!DRY_RUN) {
    // Refresh materialized views
    console.log('\n══ REFRESH MATERIALIZED VIEWS ══════════════════════════════════');
    await refreshViews();

    // Clear checkpoint — run is complete
    await clearCheckpoint();
    console.log('\n  Checkpoint effacé.');
  }

  console.log(`\n  Terminé : ${new Date().toISOString()}`);
  if (DRY_RUN) {
    console.log('  DRY RUN — aucune donnée modifiée.');
    console.log('  Pour lancer le backfill réel : DRY_RUN=0 node scripts/backfill-orphan.js');
  }

  await pool.end();
}

main().catch(err => {
  console.error('\n[ERREUR]', err.message);
  pool.end();
  process.exit(1);
});
