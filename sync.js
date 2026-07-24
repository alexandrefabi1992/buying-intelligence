require('dotenv').config();
const axios = require('axios');
const { Pool } = require('pg');
const cron = require('node-cron');

const poolConfig = { connectionString: process.env.DATABASE_URL };
if (process.env.DATABASE_URL) poolConfig.ssl = { rejectUnauthorized: false };
const pool = new Pool(poolConfig);

// Tenant ID for this sync process. Set SYNC_TENANT_ID env var, or the first tenant in DB is used.
let _syncTenantId = process.env.SYNC_TENANT_ID ?? null;
async function getSyncTenantId() {
  if (_syncTenantId) return _syncTenantId;
  const { rows } = await pool.query(`SELECT id FROM tenants ORDER BY created_at LIMIT 1`);
  _syncTenantId = rows[0]?.id ?? null;
  return _syncTenantId;
}

const BASE_URL = `https://api.lightspeedapp.com/API/V3/Account/${process.env.LIGHTSPEED_ACCOUNT_ID}`;
const TOKEN_URL = 'https://cloud.lightspeedapp.com/oauth/access_token.php';
const LIMIT = 200;

// Orphan rescue counters — reset at start of each runSync().
// Tracked per-run so the numbers in sync_state always reflect the latest run.
let _orphanRescuedCount = 0; // item fetched from Lightspeed API and inserted into products
let _orphanStubCount    = 0; // item not found in API — minimal stub created
let _orphanSkippedCount = 0; // rescue failed (shouldn't happen) — line still lost
const _rescuedItemIds   = new Set(); // dedup: avoid re-fetching same item_id in one run

// Manufacturer resolution — populated by syncManufacturers() at start of each runSync().
let _mfgMap = new Map(); // manufacturerID (string) → name
let _unresolvedMfgCount = 0; // items upserted this run whose manufacturer couldn't be resolved

// Steps whose data doesn't change daily — only re-sync if stale (> STATIC_SYNC_DAYS old).
// Time-filtered steps (sales, orders, transfers) always re-run to pick up the daily delta.
const STATIC_STEPS    = new Set(['shops', 'items', 'inventory']);
const STATIC_SYNC_DAYS = parseInt(process.env.STATIC_SYNC_DAYS ?? '1', 10);

// ---------------------------------------------------------------------------
// OAuth2 — access token cache + rotation-safe refresh token persistence.
// Lightspeed rotates the refresh_token on every exchange; we persist the
// latest one in sync_state(step='refresh_token'). If the DB token is stale
// (already consumed by another process), we fall back to the env var.
// ---------------------------------------------------------------------------
let cachedToken    = null;
let tokenExpiresAt = 0;

async function getCurrentRefreshToken() {
  try {
    const { rows } = await pool.query(
      "SELECT next_url FROM sync_state WHERE step = 'refresh_token'",
    );
    return rows[0]?.next_url ?? process.env.LIGHTSPEED_REFRESH_TOKEN;
  } catch {
    return process.env.LIGHTSPEED_REFRESH_TOKEN;
  }
}

async function saveRefreshToken(token) {
  await pool.query(
    `INSERT INTO sync_state(step, next_url, updated_at)
     VALUES ('refresh_token', $1, now())
     ON CONFLICT(step) DO UPDATE SET next_url = $1, updated_at = now()`,
    [token],
  );
  console.log('[sync] Token refreshed and persisted to DB');
}

async function fetchToken(refreshToken) {
  const { data } = await axios.post(TOKEN_URL, new URLSearchParams({
    client_id:     process.env.LIGHTSPEED_CLIENT_ID,
    client_secret: process.env.LIGHTSPEED_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type:    'refresh_token',
  }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  return data;
}

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 30_000) return cachedToken;

  const dbToken  = await getCurrentRefreshToken();
  const envToken = process.env.LIGHTSPEED_REFRESH_TOKEN;

  let data;
  try {
    data = await fetchToken(dbToken);
  } catch (firstErr) {
    // DB token may have been consumed — fall back to env var as last resort
    if (dbToken !== envToken) {
      console.log('[sync] DB refresh token rejected, falling back to env var…');
      data = await fetchToken(envToken);
    } else {
      throw firstErr;
    }
  }

  cachedToken    = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;
  if (data.refresh_token) await saveRefreshToken(data.refresh_token);

  return cachedToken;
}

const API_TIMEOUT = 60_000;

async function apiClient() {
  const token = await getAccessToken();
  return axios.create({
    baseURL: BASE_URL,
    timeout: API_TIMEOUT,
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function fetchWithRetry(url, headers, retries = 6) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await axios.get(url, { headers, timeout: API_TIMEOUT });
      return res;
    } catch (err) {
      const status = err.response?.status ?? 0;
      const isRateLimit = status === 429;
      const isRetriable = isRateLimit || err.code === 'ECONNABORTED' || status >= 500;
      if (isRetriable && attempt < retries) {
        // Honour Retry-After header if present, else exponential backoff (max 60s)
        const retryAfter = parseInt(err.response?.headers?.['retry-after'] ?? '0', 10);
        const delay = isRateLimit
          ? Math.max(retryAfter * 1000, 5000)
          : Math.min(2000 * Math.pow(2, attempt - 1), 60000);
        console.log(`[sync] ${isRateLimit ? 'Rate limited' : 'Error'} — waiting ${delay / 1000}s before retry ${attempt}/${retries - 1}`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Checkpoint helpers
// ---------------------------------------------------------------------------
async function getCheckpoint(step) {
  const { rows } = await pool.query(
    'SELECT next_url, processed_count, updated_at FROM sync_state WHERE step = $1',
    [step],
  );
  return rows[0] ?? null;
}

async function saveCheckpoint(step, nextUrl, processedCount) {
  await pool.query(
    `INSERT INTO sync_state(step, next_url, processed_count, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT(step) DO UPDATE
       SET next_url = $2, processed_count = $3, updated_at = now()`,
    [step, nextUrl, processedCount],
  );
}

// Mark a step as fully completed — skipped on resume
async function markStepCompleted(step, processedCount = 0) {
  await pool.query(
    `INSERT INTO sync_state(step, next_url, processed_count, updated_at)
     VALUES ($1, 'COMPLETED', $2, now())
     ON CONFLICT(step) DO UPDATE
       SET next_url = 'COMPLETED', processed_count = $2, updated_at = now()`,
    [step, processedCount],
  );
}

async function clearCheckpoint(step) {
  await pool.query('DELETE FROM sync_state WHERE step = $1', [step]);
}

function cpLabel(cp) {
  if (!cp) return 'pending';
  if (cp.next_url === 'COMPLETED') return `completed (${cp.processed_count})`;
  return `resuming at offset ${cp.processed_count}`;
}

// ---------------------------------------------------------------------------
// Paginated fetch — cursor-based. Yields { items, nextUrl } per page.
// Always calls getAccessToken() for every request (including the first) so
// the keepalive-rotated token is used. The axios `client` arg is kept for
// signature compatibility but NOT used for HTTP calls — the client instance
// has the initial token baked in and would be stale after a long prior step.
// ---------------------------------------------------------------------------
// Rebuild a Lightspeed next-page URL so our original params (e.g. load_relations)
// are always present. Lightspeed's @attributes.next only carries cursor params
// (sort, after, limit) — it never echoes back load_relations or filter params.
function rebuildUrl(resource, params, lightspeedNextUrl) {
  const parsed    = new URL(lightspeedNextUrl);
  const after     = parsed.searchParams.get('after');
  const sortParam = parsed.searchParams.get('sort');
  const rebuilt   = { ...params, limit: String(LIMIT) };
  if (sortParam) rebuilt.sort  = sortParam;
  if (after)     rebuilt.after = after;
  return `${BASE_URL}/${resource}.json?${new URLSearchParams(rebuilt)}`;
}

async function* paginate(client, resource, params = {}, resumeUrl = null) {
  // First URL: if resuming use checkpoint cursor but re-inject original params;
  // otherwise build fresh from BASE_URL.
  let url;
  if (resumeUrl) {
    try {
      url = rebuildUrl(resource, params, resumeUrl);
    } catch {
      url = resumeUrl; // fallback for malformed URLs
    }
  } else {
    url = `${BASE_URL}/${resource}.json?${new URLSearchParams({ ...params, limit: String(LIMIT) })}`;
  }

  while (true) {
    const token    = await getAccessToken();
    const response = await fetchWithRetry(url, { Authorization: `Bearer ${token}` });

    const { data } = response;
    const key     = Object.keys(data).find(k => k !== '@attributes');
    const wrapper = key ? data[key] : null;
    const items   = Array.isArray(wrapper) ? wrapper : wrapper ? [wrapper] : [];

    if (items.length === 0) break;

    const lsNextUrl = data['@attributes']?.next ?? null;
    // Always save the raw LS next URL as checkpoint (contains the cursor);
    // but rebuild it with our params before fetching.
    yield { items, nextUrl: lsNextUrl };

    if (!lsNextUrl) break;
    try {
      url = rebuildUrl(resource, params, lsNextUrl);
    } catch {
      url = lsNextUrl; // fallback: use raw URL if rebuild fails
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function numOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

// ---------------------------------------------------------------------------
// Schema migrations — idempotent, run once at startup
// ---------------------------------------------------------------------------
async function ensureSchema() {
  // stub_inferred_fields: lists which fields were guessed (not from Lightspeed API).
  // NULL = real product. 'all' = full stub (item was deleted). 'tags,manufacturer' = partial.
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS stub_inferred_fields TEXT`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS manufacturers (
      tenant_id       TEXT NOT NULL,
      manufacturer_id TEXT NOT NULL,
      name            TEXT NOT NULL,
      PRIMARY KEY (tenant_id, manufacturer_id)
    )
  `);

  // Inventory snapshots — daily EOD stock per item×shop.
  // unit_cost/unit_price are frozen at snapshot time (not recalculated from current products).
  // Rows with qty=0 are not stored (absence of row implies zero stock).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inventory_snapshots (
      tenant_id     TEXT    NOT NULL,
      snapshot_date DATE    NOT NULL,
      item_id       TEXT    NOT NULL,
      shop_id       TEXT    NOT NULL,
      qty           INT     NOT NULL,
      unit_cost     NUMERIC,
      unit_price    NUMERIC,
      PRIMARY KEY (tenant_id, snapshot_date, item_id, shop_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_inv_snap_date ON inventory_snapshots (tenant_id, snapshot_date)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_inv_snap_item ON inventory_snapshots (tenant_id, item_id)`);

  // Monthly aggregate — long-term retention after 400-day detail window expires.
  // manufacturer='' represents items with no manufacturer (avoids NULL in PK).
  // total_qty = average daily qty over the month; cost/retail = average daily value.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inventory_snapshots_monthly (
      tenant_id          TEXT    NOT NULL,
      month              DATE    NOT NULL,
      shop_id            TEXT    NOT NULL,
      manufacturer       TEXT    NOT NULL DEFAULT '',
      total_qty          INT     NOT NULL,
      total_cost_value   NUMERIC NOT NULL,
      total_retail_value NUMERIC NOT NULL,
      PRIMARY KEY (tenant_id, month, shop_id, manufacturer)
    )
  `);
}

// ---------------------------------------------------------------------------
// Manufacturer sync — fetches all Lightspeed manufacturers into a local table
// so upsertProducts can resolve numeric IDs even when Manufacturer relation is null.
// Always runs in full (tiny dataset, no checkpoint needed).
// ---------------------------------------------------------------------------
async function syncManufacturers(tenantId) {
  const map = new Map();
  let count = 0;
  for await (const { items } of paginate(null, 'Manufacturer', {})) {
    for (const m of items) {
      const id   = String(m.manufacturerID ?? '');
      const name = m.name ?? null;
      if (!id || !name) continue;
      map.set(id, name);
      await pool.query(
        `INSERT INTO manufacturers(tenant_id, manufacturer_id, name)
         VALUES ($1, $2, $3)
         ON CONFLICT(tenant_id, manufacturer_id) DO UPDATE SET name = $3`,
        [tenantId, id, name],
      );
      count++;
    }
  }
  _mfgMap = map;
  console.log(`[sync] Manufacturers synced: ${count} (map size: ${map.size})`);
}

// ---------------------------------------------------------------------------
// Backfill — resolves existing products that still have a numeric manufacturer_id
// stored as text (artifact of the old fallback before manufacturers table existed).
// Idempotent: only touches rows where manufacturer ~ '^[0-9]+$'.
// ---------------------------------------------------------------------------
async function backfillNumericManufacturers(tenantId) {
  // Replace stored numeric IDs with real names from the manufacturers table.
  const { rowCount: resolved } = await pool.query(
    `UPDATE products p
     SET manufacturer = m.name, synced_at = now()
     FROM manufacturers m
     WHERE p.tenant_id = $1
       AND m.tenant_id = $1
       AND m.manufacturer_id = p.manufacturer
       AND p.manufacturer ~ '^[0-9]+$'`,
    [tenantId],
  );
  // manufacturerID=0 is Lightspeed's "no manufacturer" sentinel — set to NULL.
  const { rowCount: zeroed } = await pool.query(
    `UPDATE products SET manufacturer = NULL, synced_at = now()
     WHERE tenant_id = $1 AND manufacturer = '0'`,
    [tenantId],
  );
  if (resolved > 0 || zeroed > 0) {
    console.log(`[sync] Backfill manufacturers: ${resolved} IDs → name, ${zeroed} ID=0 → NULL`);
  }
}

// ---------------------------------------------------------------------------
// Upsert helpers
// ---------------------------------------------------------------------------
async function upsertShops(tenantId, rows) {
  for (const s of rows) {
    await pool.query(
      `INSERT INTO shops(shop_id, name, time_zone, raw, tenant_id)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT(tenant_id, shop_id) DO UPDATE
         SET name=$2, time_zone=$3, raw=$4, synced_at=now()`,
      [s.shopID, s.name, s.timeZone ?? null, s, tenantId],
    );
  }
}

async function upsertProducts(tenantId, rows) {
  for (const item of rows) {
    // Category: prefer fullPathName from loaded relation, fall back to raw ID
    const category = item.Category?.fullPathName ?? item.Category?.name ?? item.categoryID ?? null;

    // Manufacturer: prefer relation name, then local table lookup, then null.
    // Never fall back to the raw numeric ID — store null and count as unresolved instead.
    const manufacturer = item.Manufacturer?.name
      ?? _mfgMap.get(String(item.manufacturerID ?? ''))
      ?? null;
    if (manufacturer === null && item.manufacturerID && String(item.manufacturerID) !== '0') {
      _unresolvedMfgCount++;
    }

    // Tags: Tags.tag is a CSV string ("NOS,A26") or false/absent when none
    const tagsRaw = item.Tags?.tag;
    const tags = (tagsRaw && tagsRaw !== 'false') ? String(tagsRaw).trim() : null;

    // Image: pick the Image with ordering=0 (or first in array), build Cloudinary URL
    let imageUrl = null;
    const imgRelation = item.Images;
    if (imgRelation && imgRelation !== false && imgRelation !== 'false') {
      const imgList = imgRelation.Image;
      const imgs = Array.isArray(imgList) ? imgList : imgList ? [imgList] : [];
      const primary = imgs.sort((a, b) => Number(a.ordering) - Number(b.ordering))[0];
      if (primary?.baseImageURL && primary?.publicID) {
        imageUrl = primary.baseImageURL + primary.publicID;
      }
    }

    const defaultPrice = item.Prices?.ItemPrice?.[0]?.amount ?? item.defaultPrice ?? null;

    await pool.query(
      `INSERT INTO products(item_id, matrix_id, description, ean, upc, manufacturer, brand,
         category, department, tags, image_url, default_cost, default_price, archived, raw, tenant_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT(tenant_id, item_id) DO UPDATE
         SET matrix_id=$2, description=$3, ean=$4, upc=$5, manufacturer=$6, brand=$7,
             category=$8, department=$9, tags=$10, image_url=$11,
             default_cost=$12, default_price=$13, archived=$14, raw=$15,
             stub_inferred_fields=NULL, synced_at=now()`,
      [
        item.itemID, item.itemMatrixID ?? null,
        item.description, item.ean ?? null, item.upc ?? null,
        manufacturer, null,
        category, item.departmentID ?? null,
        tags, imageUrl,
        item.defaultCost ?? null, defaultPrice,
        item.archived === 'true', item, tenantId,
      ],
    );
  }
}

async function upsertInventory(tenantId, rows) {
  for (const is of rows) {
    try {
      await pool.query(
        `INSERT INTO inventory(item_id, shop_id, qty_on_hand, qty_on_order, reorder_point, reorder_level, raw, tenant_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT(tenant_id, item_id, shop_id) DO UPDATE
           SET qty_on_hand=$3, qty_on_order=$4, reorder_point=$5, reorder_level=$6,
               raw=$7, synced_at=now()`,
        [
          is.itemID, is.shopID,
          is.qoh ?? 0, is.qoo ?? 0,
          is.reorderPoint ?? null, is.reorderLevel ?? null,
          is, tenantId,
        ],
      );
    } catch (err) {
      if (err.code === '23503') continue; // orphaned ItemShop — silently skip
      throw err;
    }
  }
}

async function upsertSales(tenantId, rows) {
  for (const s of rows) {
    try {
      await pool.query(
        `INSERT INTO sales(sale_id, shop_id, register_id, customer_id, completed_time, total, discount, tax, raw, tenant_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT(tenant_id, sale_id) DO UPDATE
           SET shop_id=$2, completed_time=$5, total=$6, discount=$7, tax=$8, raw=$9, synced_at=now()`,
        [
          s.saleID, s.shopID ?? null, s.registerID ?? null, s.customerID ?? null,
          s.completeTime ?? s.completedTime ?? null,
          numOrNull(s.calcTotal), numOrNull(s.calcDiscount), numOrNull(s.calcTax),
          s, tenantId,
        ],
      );
    } catch (err) {
      if (err.code === '23503') continue;
      throw err;
    }
  }
}

async function upsertSaleLines(tenantId, rows, completedTime) {
  const sql = `INSERT INTO sale_lines(sale_line_id, sale_id, item_id, shop_id,
      unit_price, unit_cost, qty, discount, tax, completed_time, raw, tenant_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT(tenant_id, sale_line_id) DO UPDATE
      SET item_id=$3, shop_id=$4, unit_price=$5, unit_cost=$6, qty=$7,
          discount=$8, tax=$9, completed_time=$10, raw=$11, synced_at=now()`;

  for (const sl of rows) {
    const params = [
      sl.saleLineID, sl.saleID ?? null,
      sl.itemID ?? null, sl.shopID ?? null,
      numOrNull(sl.unitPrice), numOrNull(sl.unitCost),
      numOrNull(sl.unitQuantity), numOrNull(sl.calcLineDiscount), numOrNull(sl.tax),
      completedTime ?? null,
      sl, tenantId,
    ];

    try {
      await pool.query(sql, params);
    } catch (err) {
      if (err.code !== '23503') throw err;

      // FK violation: determine if it's the products constraint specifically.
      // PostgreSQL detail says: Key (tenant_id, item_id)=(...) is not present in table "products".
      const isProductFK = err.detail?.includes('"products"');

      if (isProductFK && sl.itemID && sl.itemID !== '0') {
        // item_id=0 = generic/manual line with no real product — skip silently.
        // All other orphan item_ids: rescue (fetch from API or create stub), then retry.
        await rescueOrphanProduct(tenantId, sl.itemID, sl);
        try {
          await pool.query(sql, params);
        } catch (retryErr) {
          // Should not happen — rescue always creates at least a stub.
          _orphanSkippedCount++;
          console.error(`[sync] [ORPHAN] ❌ retry échoué sale_line_id=${sl.saleLineID} item_id=${sl.itemID}: ${retryErr.message}`);
        }
      } else {
        // Other FK (shop_id, sale_id) or item_id=0 — keep existing silent-skip behavior.
        continue;
      }
    }
  }
}

async function upsertTransfers(tenantId, transfers) {
  for (const t of transfers) {
    const fromShopId = t.TransferFrom?.shopID  ?? null;
    const toShopId   = t.TransferTo?.shopID    ?? null;
    // Prefer the actual sent timestamp; fall back to record creation time
    const transferDate = t.TransferFrom?.sentOn ?? t.timeStamp ?? null;
    const note         = t.note || null;
    const tSent        = t.sent     === 'true';
    const tReceived    = t.received === 'true';

    // TransferItems is "" (empty string) when the transfer has no line items
    const itemsWrapper = t.TransferItems;
    if (!itemsWrapper || itemsWrapper === '' || itemsWrapper === false) continue;

    const rawItems = itemsWrapper.TransferItem;
    const items    = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];

    for (const ti of items) {
      try {
        await pool.query(
          `INSERT INTO transfers(
             transfer_item_id, transfer_id, from_shop_id, to_shop_id,
             item_id, qty_sent, qty_received,
             transfer_sent, transfer_received, transfer_date, note, raw, tenant_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT(tenant_id, transfer_item_id) DO UPDATE
             SET transfer_id=$2, from_shop_id=$3, to_shop_id=$4,
                 item_id=$5, qty_sent=$6, qty_received=$7,
                 transfer_sent=$8, transfer_received=$9,
                 transfer_date=$10, note=$11, raw=$12, synced_at=now()`,
          [
            ti.transferItemID, t.transferID,
            fromShopId, toShopId,
            ti.itemID ?? null,
            numOrNull(ti.sent)     ?? 0,
            numOrNull(ti.received) ?? 0,
            tSent, tReceived,
            transferDate, note,
            { header: t, item: ti }, tenantId,
          ],
        );
      } catch (err) {
        if (err.code === '23503') continue; // orphaned FK (item or shop not yet synced)
        throw err;
      }
    }
  }
}

async function upsertOrders(tenantId, rows) {
  for (const o of rows) {
    await pool.query(
      `INSERT INTO orders(order_id, shop_id, vendor_id, status, order_date, eta, total, raw, tenant_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT(tenant_id, order_id) DO UPDATE
         SET shop_id=$2, vendor_id=$3, status=$4, order_date=$5, eta=$6,
             total=$7, raw=$8, synced_at=now()`,
      [
        o.orderID, o.shopID ?? null, o.vendorID ?? null,
        o.orderStatus ?? null,
        o.orderDate ?? null, o.eta ?? null,
        numOrNull(o.total), o, tenantId,
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Orphan rescue — called when upsertSaleLines gets a FK violation on products
// ---------------------------------------------------------------------------
async function rescueOrphanProduct(tenantId, itemId, slContext) {
  const cacheKey = `${tenantId}:${itemId}`;
  if (_rescuedItemIds.has(cacheKey)) return; // already handled this run — retry will work
  _rescuedItemIds.add(cacheKey);

  // 1. Try Lightspeed API (handles archived items; may also work for recently deleted)
  try {
    const token = await getAccessToken();
    const rels  = encodeURIComponent(JSON.stringify(['Tags', 'Category', 'Manufacturer']));
    const res   = await fetchWithRetry(
      `${BASE_URL}/Item/${itemId}.json?load_relations=${rels}`,
      { Authorization: `Bearer ${token}` },
      3,
    );
    const item = res.data?.Item;
    if (item) {
      await upsertProducts(tenantId, [item]);
      _orphanRescuedCount++;
      console.log(`[sync] [ORPHAN] ✓ item_id=${itemId} récupéré via API Lightspeed`);
      return;
    }
  } catch (apiErr) {
    const status = apiErr.response?.status;
    if (status !== 404) {
      // Unexpected error — log but fall through to stub
      console.warn(`[sync] [ORPHAN] ⚠ item_id=${itemId}: erreur API ${status ?? apiErr.message}`);
    }
    // 404 = genuinely deleted — fall through to stub
  }

  // 2. Fallback: minimal stub so the sale_line FK passes.
  //    avgCost from the SaleLine raw is used as default_cost (best we have without the Item record).
  //    Tags = '__stub__' only — no inferred season here. User will tag manually via audit query.
  //    stub_inferred_fields = 'all' marks everything as unknown.
  const avgCost = slContext?.avgCost ? numOrNull(slContext.avgCost) : null;
  await pool.query(
    `INSERT INTO products(item_id, description, manufacturer, tags, archived, default_cost, tenant_id, stub_inferred_fields)
     VALUES ($1, $2, NULL, '__stub__', true, $3, $4, 'all')
     ON CONFLICT(tenant_id, item_id) DO NOTHING`,
    [itemId, `[supprimé-${itemId}]`, avgCost, tenantId],
  );
  _orphanStubCount++;
  console.log(`[sync] [ORPHAN] ⚠ item_id=${itemId}: introuvable en API — stub créé (default_cost=${avgCost ?? 'N/A'})`);
}

// ---------------------------------------------------------------------------
// Quality audit — run after each sync to surface data health issues.
// Results stored in sync_state so they're visible in monitoring/dashboard.
// Window: items sold in the last 365 days (rolling, non-stubs only).
// ---------------------------------------------------------------------------
async function computeAndSaveQualityCounters(tenantId) {
  const [r1, r2, r3] = await Promise.all([
    // Detect items where a numeric manufacturer_id was stored as the name.
    // Uses a JOIN on manufacturers so legitimate numeric brand names (e.g. "0909")
    // are excluded — they exist as a name in the table, not as a manufacturer_id.
    pool.query(
      `SELECT COUNT(DISTINCT p.item_id) AS n
       FROM products p
       JOIN sale_lines sl ON sl.item_id = p.item_id AND sl.tenant_id = p.tenant_id
       JOIN manufacturers m ON m.tenant_id = p.tenant_id AND m.manufacturer_id = p.manufacturer
       WHERE p.tenant_id = $1
         AND p.stub_inferred_fields IS NULL
         AND sl.completed_time > now() - interval '365 days'`,
      [tenantId],
    ),
    pool.query(
      `SELECT COUNT(DISTINCT sl.item_id) AS n
       FROM sale_lines sl
       JOIN products p ON p.item_id = sl.item_id AND p.tenant_id = sl.tenant_id
       WHERE sl.tenant_id = $1
         AND p.tags IS NULL
         AND p.stub_inferred_fields IS NULL
         AND sl.completed_time > now() - interval '365 days'`,
      [tenantId],
    ),
    pool.query(
      `SELECT COUNT(DISTINCT sl.item_id) AS n
       FROM sale_lines sl
       JOIN products p ON p.item_id = sl.item_id AND p.tenant_id = sl.tenant_id
       WHERE sl.tenant_id = $1
         AND (p.default_cost IS NULL OR p.default_cost = 0)
         AND p.stub_inferred_fields IS NULL
         AND sl.completed_time > now() - interval '365 days'`,
      [tenantId],
    ),
  ]);

  const unresolvedMfg = Number(r1.rows[0].n);
  const noTags        = Number(r2.rows[0].n);
  const noCost        = Number(r3.rows[0].n);

  console.log('[sync] ── Qualité données ─────────────────────────────────');
  console.log(`[sync]   Manufacturier non résolu (vendus 365j) : ${unresolvedMfg} items`);
  console.log(`[sync]   Vendus sans tags (365j)                : ${noTags} items`);
  console.log(`[sync]   Vendus sans coût (365j)                : ${noCost} items`);
  if (_unresolvedMfgCount > 0) {
    console.log(`[sync]   Non résolus ce run                     : ${_unresolvedMfgCount} items`);
  }
  console.log('[sync] ─────────────────────────────────────────────────────');

  for (const [step, value] of [
    ['quality_unresolved_mfg',     unresolvedMfg],
    ['quality_no_tags',            noTags],
    ['quality_no_cost',            noCost],
    ['quality_unresolved_mfg_run', _unresolvedMfgCount],
  ]) {
    await pool.query(
      `INSERT INTO sync_state(step, next_url, processed_count, updated_at)
       VALUES ($1, 'COMPLETED', $2, now())
       ON CONFLICT(step) DO UPDATE SET processed_count = $2, updated_at = now()`,
      [step, value],
    );
  }
}

// ---------------------------------------------------------------------------
// Inventory snapshot — daily EOD capture of stock state.
// Called once per sync run, after MV refresh. ON CONFLICT DO NOTHING ensures
// that if the sync runs twice on the same day, the first snapshot is kept.
//
// Retention: detail rows live 400 days (year-over-year comparisons).
// Before purging, complete months older than 400 days are aggregated into
// inventory_snapshots_monthly (average daily qty/value per shop×manufacturer).
// ---------------------------------------------------------------------------
async function snapshotInventory(tenantId) {
  const today = new Date().toISOString().slice(0, 10);

  // ── 1. Aggregate complete months about to be purged ──────────────────────
  // A "complete month" is one where every day is older than 400 days, i.e.
  // the month ended before (today − 400 days). We aggregate before purging.
  const cutoffMonth = new Date();
  cutoffMonth.setDate(cutoffMonth.getDate() - 400);
  const cutoffMonthStr = cutoffMonth.toISOString().slice(0, 7) + '-01';

  await pool.query(`
    INSERT INTO inventory_snapshots_monthly
      (tenant_id, month, shop_id, manufacturer, total_qty, total_cost_value, total_retail_value)
    SELECT
      s.tenant_id,
      date_trunc('month', s.snapshot_date)::date                               AS month,
      s.shop_id,
      COALESCE(p.manufacturer, '')                                              AS manufacturer,
      ROUND(AVG(s.qty))::int                                                    AS total_qty,
      ROUND(AVG(s.qty * COALESCE(s.unit_cost, 0))::numeric, 2)                 AS total_cost_value,
      ROUND(AVG(s.qty * COALESCE(s.unit_price, 0))::numeric, 2)                AS total_retail_value
    FROM inventory_snapshots s
    JOIN products p ON p.item_id = s.item_id AND p.tenant_id = s.tenant_id
    WHERE s.tenant_id = $1
      AND s.snapshot_date < $2::date
    GROUP BY s.tenant_id, date_trunc('month', s.snapshot_date)::date, s.shop_id, COALESCE(p.manufacturer, '')
    ON CONFLICT (tenant_id, month, shop_id, manufacturer) DO NOTHING
  `, [tenantId, cutoffMonthStr]);

  // ── 2. Purge detail rows older than 400 days ─────────────────────────────
  const { rowCount: purged } = await pool.query(`
    DELETE FROM inventory_snapshots
    WHERE tenant_id = $1 AND snapshot_date < current_date - interval '400 days'
  `, [tenantId]);
  if (purged > 0) console.log(`[sync] Snapshot inventaire : ${purged} lignes purgées (>400j)`);

  // ── 3. Capture today's snapshot ──────────────────────────────────────────
  const { rowCount } = await pool.query(`
    INSERT INTO inventory_snapshots (tenant_id, snapshot_date, item_id, shop_id, qty, unit_cost, unit_price)
    SELECT
      i.tenant_id,
      $1::date,
      i.item_id,
      i.shop_id,
      i.qty_on_hand::int,
      p.default_cost,
      p.default_price
    FROM inventory i
    JOIN products p  ON p.item_id  = i.item_id  AND p.tenant_id = i.tenant_id
    JOIN shops    sh ON sh.shop_id = i.shop_id   AND sh.tenant_id = i.tenant_id
    WHERE i.tenant_id = $2
      AND i.qty_on_hand != 0
      AND p.archived = false
    ON CONFLICT DO NOTHING
  `, [today, tenantId]);

  console.log(`[sync] Snapshot inventaire : ${rowCount} lignes pour ${today}`);

  for (const [step, val] of [
    ['snapshot_last_date', today],
    ['snapshot_rows',      String(rowCount)],
  ]) {
    await pool.query(`
      INSERT INTO sync_state(step, next_url, processed_count, updated_at)
      VALUES ($1, $2, $3, now())
      ON CONFLICT(step) DO UPDATE SET next_url = $2, processed_count = $3, updated_at = now()
    `, [step, val, rowCount]);
  }
}

async function refreshMaterializedView(viewName) {
  try {
    await pool.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${viewName}`);
  } catch (err) {
    const msg = String(err.message || err);
    if (msg.includes('does not have a unique index') || msg.includes('cannot refresh materialized view concurrently') || msg.includes('CONCURRENTLY')) {
      console.warn(`[sync] Concurrent refresh failed for ${viewName}; falling back to non-concurrent refresh. Reason: ${msg}`);
      await pool.query(`REFRESH MATERIALIZED VIEW ${viewName}`);
      return;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Main sync
// ---------------------------------------------------------------------------
const SYNC_STEPS = ['shops', 'items', 'inventory', 'sales', 'orders', 'transfers'];

async function runSync({ forceDaysBack = null } = {}) {
  console.log(`[sync] Starting — ${new Date().toISOString()}`);

  // Schema migration (idempotent)
  await ensureSchema();

  // Reset per-run counters
  _orphanRescuedCount  = 0;
  _orphanStubCount     = 0;
  _orphanSkippedCount  = 0;
  _rescuedItemIds.clear();
  _unresolvedMfgCount  = 0;

  const tenantId = await getSyncTenantId();
  if (!tenantId) throw new Error('No tenant found — set SYNC_TENANT_ID env var or run onboarding first');
  console.log(`[sync] Tenant: ${tenantId}`);

  // Force immediate token refresh + persist new refresh_token before any work
  tokenExpiresAt = 0;
  await getAccessToken();

  const client = await apiClient();

  // Auto-detect initial sync: if sale_lines is empty, pull full history regardless of SYNC_DAYS_BACK.
  // This ensures new client onboarding always gets complete historical data without manual config.
  const { rows: countRows } = await pool.query('SELECT COUNT(*) AS n FROM sale_lines');
  const isFirstSync = Number(countRows[0].n) === 0;
  const daysBack = forceDaysBack
    ?? (isFirstSync ? 3650 : parseInt(process.env.SYNC_DAYS_BACK ?? '7', 10));
  if (isFirstSync)    console.log('[sync] First sync detected (sale_lines empty) — pulling full 10-year history');
  if (forceDaysBack)  console.log(`[sync] Force full sync: pulling ${forceDaysBack} days of history`);
  const since = new Date(Date.now() - daysBack * 86_400_000).toISOString();

  // Keepalive: force token refresh every 5 min to survive long inventory phases
  const keepalive = setInterval(async () => {
    try {
      tokenExpiresAt = 0;
      await getAccessToken();
      console.log('[sync] Token keepalive: refreshed');
    } catch (err) {
      console.error('[sync] Token keepalive failed:', err.message);
    }
  }, 5 * 60 * 1000);

  try {
    // Load all checkpoints upfront
    const cps = {};
    for (const step of SYNC_STEPS) cps[step] = await getCheckpoint(step);

    // If the last step completed in the previous run, start a fresh run.
    // Static steps (shops, items, inventory) are only cleared if stale (> STATIC_SYNC_DAYS).
    // Time-filtered steps (sales, orders, transfers) are always cleared so they re-fetch the delta.
    const lastStep = SYNC_STEPS[SYNC_STEPS.length - 1];
    if (cps[lastStep]?.next_url === 'COMPLETED') {
      console.log('[sync] Previous run fully completed. Resetting steps selectively.');
      for (const step of SYNC_STEPS) {
        if (STATIC_STEPS.has(step)) {
          const updatedAt = cps[step]?.updated_at ? new Date(cps[step].updated_at) : null;
          const ageDays   = updatedAt ? (Date.now() - updatedAt.getTime()) / 86_400_000 : Infinity;
          if (ageDays > STATIC_SYNC_DAYS) {
            console.log(`[sync] ${step}: stale (${Math.round(ageDays)}d old) — will re-sync`);
            await clearCheckpoint(step);
            cps[step] = null;
          } else {
            console.log(`[sync] ${step}: fresh (${Math.round(ageDays)}d old) — skipping`);
          }
        } else {
          await clearCheckpoint(step);
          cps[step] = null;
        }
      }
    }

    // Print checkpoint status summary
    const statusLine = SYNC_STEPS.map(s => `${s}=${cpLabel(cps[s])}`).join(', ');
    console.log(`[sync] Checkpoint status: ${statusLine}`);

    // Sync manufacturer lookup table and backfill existing numeric IDs — always runs,
    // outside SYNC_STEPS because it's small and requires no checkpointing.
    await syncManufacturers(tenantId);
    await backfillNumericManufacturers(tenantId);

    // ── 1. Shops ──────────────────────────────────────────────────────────
    if (cps.shops?.next_url === 'COMPLETED') {
      console.log('[sync] shops: skipping (already completed)');
    } else {
      if (cps.shops) console.log('[sync] Resuming shops from checkpoint…');
      else           console.log('[sync] Fetching shops…');
      let shopCount = 0;
      for await (const { items, nextUrl } of paginate(client, 'Shop', {}, cps.shops?.next_url)) {
        await upsertShops(tenantId, items);
        shopCount += items.length;
        if (nextUrl) await saveCheckpoint('shops', nextUrl, shopCount);
      }
      await markStepCompleted('shops', shopCount);
    }

    // ── 2. Items (products) ───────────────────────────────────────────────
    // Delta sync: only fetch items modified since last completed items sync.
    // First sync (isFirstSync) always pulls everything.
    if (cps.items?.next_url === 'COMPLETED') {
      console.log('[sync] items: skipping (already completed)');
    } else {
      const itemsDeltaRow = await getCheckpoint('items_delta_since');
      const itemsDelta    = !isFirstSync && itemsDeltaRow?.next_url && itemsDeltaRow.next_url !== 'COMPLETED'
        ? itemsDeltaRow.next_url
        : null;
      const itemsParams = {
        load_relations: JSON.stringify(['Tags', 'Category', 'Manufacturer', 'Images', 'ItemAttributes']),
        ...(itemsDelta ? { timeStamp: `>,${itemsDelta}` } : {}),
      };
      const itemsSyncStarted = new Date().toISOString();

      let itemCount = cps.items?.processed_count ?? 0;
      if (cps.items)    console.log(`[sync] Resuming items from checkpoint at ${itemCount}…`);
      else if (itemsDelta) console.log(`[sync] Items delta sync since ${itemsDelta}…`);
      else              console.log('[sync] Items full sync…');

      for await (const { items, nextUrl } of paginate(client, 'Item', itemsParams, cps.items?.next_url)) {
        await upsertProducts(tenantId, items);
        itemCount += items.length;
        console.log(`[sync] Items upserted: ${itemCount}`);
        if (nextUrl) await saveCheckpoint('items', nextUrl, itemCount);
      }
      await markStepCompleted('items', itemCount);
      await saveCheckpoint('items_delta_since', itemsSyncStarted, itemCount);
    }

    // ── 3. ItemMatrix — skipped; matrix_id stored on each product row ─────

    // ── 4. Inventory (ItemShop) ───────────────────────────────────────────
    // Delta sync: on subsequent runs, only fetch records modified since the last
    // completed inventory sync (stored as 'inventory_delta_since' in sync_state).
    // First sync (isFirstSync) always pulls everything — no timeStamp filter.
    if (cps.inventory?.next_url === 'COMPLETED') {
      console.log('[sync] inventory: skipping (already completed)');
    } else {
      const deltaSinceRow = await getCheckpoint('inventory_delta_since');
      const deltaSince    = !isFirstSync && deltaSinceRow?.next_url && deltaSinceRow.next_url !== 'COMPLETED'
        ? deltaSinceRow.next_url   // stored as ISO timestamp string in next_url field
        : null;
      const invParams = deltaSince ? { timeStamp: `>,${deltaSince}` } : {};

      let invCount = cps.inventory?.processed_count ?? 0;
      if (cps.inventory)  console.log(`[sync] Resuming inventory from checkpoint at ${invCount}…`);
      else if (deltaSince) console.log(`[sync] Inventory delta sync since ${deltaSince}…`);
      else                 console.log('[sync] Inventory full sync (ItemShop)…');

      // Record the start time before fetching — use this as the next delta boundary.
      const invSyncStarted = new Date().toISOString();

      for await (const { items, nextUrl } of paginate(client, 'ItemShop', invParams, cps.inventory?.next_url)) {
        await upsertInventory(tenantId, items);
        invCount += items.length;
        if (invCount % 1000 === 0)  console.log(`[sync] Inventory upserted: ${invCount}`);
        if (nextUrl && invCount % 10_000 === 0) await saveCheckpoint('inventory', nextUrl, invCount);
      }
      console.log(`[sync] Inventory done: ${invCount} records`);
      await markStepCompleted('inventory', invCount);
      // Save the start time of this run as the next delta boundary.
      // Using start (not end) ensures no records are missed if Lightspeed updates
      // an ItemShop while we're mid-sync.
      await saveCheckpoint('inventory_delta_since', invSyncStarted, invCount);
    }

    // ── 5. Sales (with embedded SaleLines) ───────────────────────────────
    if (cps.sales?.next_url === 'COMPLETED') {
      console.log('[sync] sales: skipping (already completed)');
    } else {
      let salesCount = cps.sales?.processed_count ?? 0;
      if (cps.sales) console.log(`[sync] Resuming sales from checkpoint at ${salesCount}…`);
      else           console.log(`[sync] Fetching sales since ${since}…`);
      for await (const { items, nextUrl } of paginate(client, 'Sale', {
        load_relations: JSON.stringify(['SaleLines']),
        completeTime: `>,${since}`,
      }, cps.sales?.next_url)) {
        await upsertSales(tenantId, items);
        for (const sale of items) {
          const lines = sale.SaleLines?.SaleLine;
          if (!lines) continue;
          const lineArr = Array.isArray(lines) ? lines : [lines];
          // Lightspeed uses completeTime (no 'd') in the response object
          const ct = sale.completeTime ?? sale.completedTime ?? null;
          await upsertSaleLines(tenantId, lineArr, ct);
        }
        salesCount += items.length;
        // Checkpoint every 10,000 records
        if (nextUrl && salesCount % 10_000 === 0) await saveCheckpoint('sales', nextUrl, salesCount);
      }
      await markStepCompleted('sales', salesCount);

      // Orphan rescue summary — persisted in sync_state so it's visible after each run.
      const totalOrphans = _orphanRescuedCount + _orphanStubCount + _orphanSkippedCount;
      if (totalOrphans > 0) {
        console.log(`[sync] [ORPHAN] Résumé: ${_orphanRescuedCount} récupérés via API, ${_orphanStubCount} stubs créés, ${_orphanSkippedCount} perdus`);
        if (_orphanSkippedCount > 0) {
          console.error(`[sync] [ORPHAN] ❌ ATTENTION: ${_orphanSkippedCount} lignes de vente irrécupérables — vérifier les logs ci-dessus`);
        }
      } else {
        console.log('[sync] [ORPHAN] Aucun orphelin détecté dans ce batch');
      }
      // Persist counts to sync_state for monitoring
      await pool.query(
        `INSERT INTO sync_state(step, next_url, processed_count, updated_at)
         VALUES ('orphan_rescued', 'COMPLETED', $1, now())
         ON CONFLICT(step) DO UPDATE SET processed_count=$1, updated_at=now()`,
        [_orphanRescuedCount],
      );
      await pool.query(
        `INSERT INTO sync_state(step, next_url, processed_count, updated_at)
         VALUES ('orphan_stubs', 'COMPLETED', $1, now())
         ON CONFLICT(step) DO UPDATE SET processed_count=$1, updated_at=now()`,
        [_orphanStubCount],
      );
      await pool.query(
        `INSERT INTO sync_state(step, next_url, processed_count, updated_at)
         VALUES ('orphan_skipped', 'COMPLETED', $1, now())
         ON CONFLICT(step) DO UPDATE SET processed_count=$1, updated_at=now()`,
        [_orphanSkippedCount],
      );
    }

    // ── 6. Orders ─────────────────────────────────────────────────────────
    if (cps.orders?.next_url === 'COMPLETED') {
      console.log('[sync] orders: skipping (already completed)');
    } else {
      let ordersCount = cps.orders?.processed_count ?? 0;
      if (cps.orders) console.log(`[sync] Resuming orders from checkpoint at ${ordersCount}…`);
      else            console.log('[sync] Fetching orders…');
      for await (const { items, nextUrl } of paginate(client, 'Order', {}, cps.orders?.next_url)) {
        await upsertOrders(tenantId, items);
        ordersCount += items.length;
        if (nextUrl) await saveCheckpoint('orders', nextUrl, ordersCount);
      }
      await markStepCompleted('orders', ordersCount);
    }

    // ── 7. Transfers (inter-shop stock movements) ─────────────────────────
    if (cps.transfers?.next_url === 'COMPLETED') {
      console.log('[sync] transfers: skipping (already completed)');
    } else {
      let txCount = cps.transfers?.processed_count ?? 0;
      if (cps.transfers) console.log(`[sync] Resuming transfers from checkpoint at ${txCount}…`);
      else               console.log('[sync] Fetching transfers…');
      for await (const { items, nextUrl } of paginate(client, 'Transfer', {
        load_relations: 'all',
      }, cps.transfers?.next_url)) {
        await upsertTransfers(tenantId, items);
        txCount += items.length;
        if (txCount % 500 === 0) console.log(`[sync] Transfers processed: ${txCount}`);
        if (nextUrl && txCount % 2_000 === 0) await saveCheckpoint('transfers', nextUrl, txCount);
      }
      await markStepCompleted('transfers', txCount);
      console.log(`[sync] Transfers done: ${txCount} records`);
    }

    // ── Refresh materialized views ────────────────────────────────────────
    console.log('[sync] Refreshing materialized views…');
    await refreshMaterializedView('mv_sales_velocity');
    await refreshMaterializedView('mv_inventory_stock');

    // ── Quality audit ─────────────────────────────────────────────────────
    await computeAndSaveQualityCounters(tenantId);

    // ── Inventory snapshot ────────────────────────────────────────────────
    await snapshotInventory(tenantId);

    console.log(`[sync] Done — ${new Date().toISOString()}`);

  } finally {
    clearInterval(keepalive);
  }
}

// ---------------------------------------------------------------------------
// Entrypoint: cron (every Monday at 07:00) or one-shot via --once flag
// ---------------------------------------------------------------------------
if (process.argv.includes('--once')) {
  const fullHistory = process.argv.includes('--full-history');
  runSync(fullHistory ? { forceDaysBack: 3650 } : {}).catch(err => {
    if (err.response?.data?.message) {
      console.error('[sync] API error:', err.response.data.message);
    } else {
      console.error('[sync] Error:', err.message);
    }
    process.exit(1);
  });
} else {
  console.log('[sync] Scheduler started — runs daily at 05:00 UTC (midnight EST / 1am EDT)');
  cron.schedule('0 5 * * *', () => {
    runSync().catch(err => console.error('[sync] Error:', err));
  });
}
