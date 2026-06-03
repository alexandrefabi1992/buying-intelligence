require('dotenv').config();
const axios = require('axios');
const { Pool } = require('pg');
const cron = require('node-cron');

const poolConfig = { connectionString: process.env.DATABASE_URL };
if (process.env.DATABASE_URL) poolConfig.ssl = { rejectUnauthorized: false };
const pool = new Pool(poolConfig);

const BASE_URL = `https://api.lightspeedapp.com/API/V3/Account/${process.env.LIGHTSPEED_ACCOUNT_ID}`;
const TOKEN_URL = 'https://cloud.lightspeedapp.com/oauth/access_token.php';
const LIMIT = 200;

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

async function fetchWithRetry(url, headers, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await axios.get(url, { headers, timeout: API_TIMEOUT });
    } catch (err) {
      const retriable = err.code === 'ECONNABORTED' || (err.response?.status ?? 0) >= 500;
      if (retriable && attempt < retries) {
        console.log(`[sync] Retry ${attempt}/${retries - 1} for ${url}`);
        await new Promise(r => setTimeout(r, 2000 * attempt));
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
    'SELECT next_url, processed_count FROM sync_state WHERE step = $1',
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
// Upsert helpers
// ---------------------------------------------------------------------------
async function upsertShops(client, rows) {
  for (const s of rows) {
    await pool.query(
      `INSERT INTO shops(shop_id, name, time_zone, raw)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT(shop_id) DO UPDATE
         SET name=$2, time_zone=$3, raw=$4, synced_at=now()`,
      [s.shopID, s.name, s.timeZone ?? null, s],
    );
  }
}

async function upsertProducts(client, rows) {
  for (const item of rows) {
    // Category: prefer fullPathName from loaded relation, fall back to raw ID
    const category = item.Category?.fullPathName ?? item.Category?.name ?? item.categoryID ?? null;

    // Manufacturer = brand in clothing context
    const manufacturer = item.Manufacturer?.name ?? item.manufacturerID ?? null;

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
         category, department, tags, image_url, default_cost, default_price, archived, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT(item_id) DO UPDATE
         SET matrix_id=$2, description=$3, ean=$4, upc=$5, manufacturer=$6, brand=$7,
             category=$8, department=$9, tags=$10, image_url=$11,
             default_cost=$12, default_price=$13, archived=$14, raw=$15, synced_at=now()`,
      [
        item.itemID, item.itemMatrixID ?? null,
        item.description, item.ean ?? null, item.upc ?? null,
        manufacturer, null,
        category, item.departmentID ?? null,
        tags, imageUrl,
        item.defaultCost ?? null, defaultPrice,
        item.archived === 'true', item,
      ],
    );
  }
}

async function upsertInventory(client, rows) {
  for (const is of rows) {
    try {
      await pool.query(
        `INSERT INTO inventory(item_id, shop_id, qty_on_hand, qty_on_order, reorder_point, reorder_level, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT(item_id, shop_id) DO UPDATE
           SET qty_on_hand=$3, qty_on_order=$4, reorder_point=$5, reorder_level=$6,
               raw=$7, synced_at=now()`,
        [
          is.itemID, is.shopID,
          is.qoh ?? 0, is.qoo ?? 0,
          is.reorderPoint ?? null, is.reorderLevel ?? null,
          is,
        ],
      );
    } catch (err) {
      if (err.code === '23503') continue; // orphaned ItemShop — silently skip
      throw err;
    }
  }
}

async function upsertSales(client, rows) {
  for (const s of rows) {
    try {
      await pool.query(
        `INSERT INTO sales(sale_id, shop_id, register_id, customer_id, completed_time, total, discount, tax, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT(sale_id) DO UPDATE
           SET shop_id=$2, completed_time=$5, total=$6, discount=$7, tax=$8, raw=$9, synced_at=now()`,
        [
          s.saleID, s.shopID ?? null, s.registerID ?? null, s.customerID ?? null,
          s.completeTime ?? s.completedTime ?? null,
          numOrNull(s.calcTotal), numOrNull(s.calcDiscount), numOrNull(s.calcTax),
          s,
        ],
      );
    } catch (err) {
      if (err.code === '23503') continue;
      throw err;
    }
  }
}

async function upsertSaleLines(client, rows, completedTime) {
  for (const sl of rows) {
    try {
      await pool.query(
        `INSERT INTO sale_lines(sale_line_id, sale_id, item_id, shop_id,
           unit_price, unit_cost, qty, discount, tax, completed_time, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT(sale_line_id) DO UPDATE
           SET item_id=$3, shop_id=$4, unit_price=$5, unit_cost=$6, qty=$7,
               discount=$8, tax=$9, completed_time=$10, raw=$11, synced_at=now()`,
        [
          sl.saleLineID, sl.saleID ?? null,
          sl.itemID ?? null, sl.shopID ?? null,
          numOrNull(sl.unitPrice), numOrNull(sl.unitCost),
          numOrNull(sl.unitQuantity), numOrNull(sl.calcLineDiscount), numOrNull(sl.tax),
          completedTime ?? null,
          sl,
        ],
      );
    } catch (err) {
      if (err.code === '23503') continue;
      throw err;
    }
  }
}

async function upsertTransfers(client, transfers) {
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
             transfer_sent, transfer_received, transfer_date, note, raw)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT(transfer_item_id) DO UPDATE
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
            { header: t, item: ti },
          ],
        );
      } catch (err) {
        if (err.code === '23503') continue; // orphaned FK (item or shop not yet synced)
        throw err;
      }
    }
  }
}

async function upsertOrders(client, rows) {
  for (const o of rows) {
    await pool.query(
      `INSERT INTO orders(order_id, shop_id, vendor_id, status, order_date, eta, total, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT(order_id) DO UPDATE
         SET shop_id=$2, vendor_id=$3, status=$4, order_date=$5, eta=$6,
             total=$7, raw=$8, synced_at=now()`,
      [
        o.orderID, o.shopID ?? null, o.vendorID ?? null,
        o.orderStatus ?? null,
        o.orderDate ?? null, o.eta ?? null,
        numOrNull(o.total), o,
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Main sync
// ---------------------------------------------------------------------------
const SYNC_STEPS = ['shops', 'items', 'inventory', 'sales', 'orders', 'transfers'];

async function runSync() {
  console.log(`[sync] Starting — ${new Date().toISOString()}`);

  // Force immediate token refresh + persist new refresh_token before any work
  tokenExpiresAt = 0;
  await getAccessToken();

  const client = await apiClient();
  const daysBack = parseInt(process.env.SYNC_DAYS_BACK ?? '90', 10);
  const since    = new Date(Date.now() - daysBack * 86_400_000).toISOString();

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

    // If the last step completed in the previous run, this is a fresh run — clear all
    const lastStep = SYNC_STEPS[SYNC_STEPS.length - 1];
    if (cps[lastStep]?.next_url === 'COMPLETED') {
      console.log('[sync] Previous run fully completed. Clearing checkpoints for fresh run.');
      for (const step of SYNC_STEPS) {
        await clearCheckpoint(step);
        cps[step] = null;
      }
    }

    // Print checkpoint status summary
    const statusLine = SYNC_STEPS.map(s => `${s}=${cpLabel(cps[s])}`).join(', ');
    console.log(`[sync] Checkpoint status: ${statusLine}`);

    // ── 1. Shops ──────────────────────────────────────────────────────────
    if (cps.shops?.next_url === 'COMPLETED') {
      console.log('[sync] shops: skipping (already completed)');
    } else {
      if (cps.shops) console.log('[sync] Resuming shops from checkpoint…');
      else           console.log('[sync] Fetching shops…');
      let shopCount = 0;
      for await (const { items, nextUrl } of paginate(client, 'Shop', {}, cps.shops?.next_url)) {
        await upsertShops(client, items);
        shopCount += items.length;
        if (nextUrl) await saveCheckpoint('shops', nextUrl, shopCount);
      }
      await markStepCompleted('shops', shopCount);
    }

    // ── 2. Items (products) ───────────────────────────────────────────────
    if (cps.items?.next_url === 'COMPLETED') {
      console.log('[sync] items: skipping (already completed)');
    } else {
      let itemCount = cps.items?.processed_count ?? 0;
      if (cps.items) console.log(`[sync] Resuming items from checkpoint at ${itemCount}…`);
      else           console.log('[sync] Fetching items…');
      for await (const { items, nextUrl } of paginate(client, 'Item', {
        load_relations: JSON.stringify(['Tags', 'Category', 'Manufacturer', 'Images']),
      }, cps.items?.next_url)) {
        await upsertProducts(client, items);
        itemCount += items.length;
        console.log(`[sync] Items upserted: ${itemCount}`);
        if (nextUrl) await saveCheckpoint('items', nextUrl, itemCount);
      }
      await markStepCompleted('items', itemCount);
    }

    // ── 3. ItemMatrix — skipped; matrix_id stored on each product row ─────

    // ── 4. Inventory (ItemShop) ───────────────────────────────────────────
    if (cps.inventory?.next_url === 'COMPLETED') {
      console.log('[sync] inventory: skipping (already completed)');
    } else {
      let invCount = cps.inventory?.processed_count ?? 0;
      if (cps.inventory) console.log(`[sync] Resuming inventory from checkpoint at ${invCount}…`);
      else               console.log('[sync] Fetching inventory (ItemShop)…');
      for await (const { items, nextUrl } of paginate(client, 'ItemShop', {}, cps.inventory?.next_url)) {
        await upsertInventory(client, items);
        invCount += items.length;
        if (invCount % 1000 === 0)  console.log(`[sync] Inventory upserted: ${invCount}`);
        // Checkpoint every 10,000 records to limit DB writes on high-volume step
        if (nextUrl && invCount % 10_000 === 0) await saveCheckpoint('inventory', nextUrl, invCount);
      }
      console.log(`[sync] Inventory done: ${invCount} records`);
      await markStepCompleted('inventory', invCount);
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
        await upsertSales(client, items);
        for (const sale of items) {
          const lines = sale.SaleLines?.SaleLine;
          if (!lines) continue;
          const lineArr = Array.isArray(lines) ? lines : [lines];
          // Lightspeed uses completeTime (no 'd') in the response object
          const ct = sale.completeTime ?? sale.completedTime ?? null;
          await upsertSaleLines(client, lineArr, ct);
        }
        salesCount += items.length;
        // Checkpoint every 10,000 records
        if (nextUrl && salesCount % 10_000 === 0) await saveCheckpoint('sales', nextUrl, salesCount);
      }
      await markStepCompleted('sales', salesCount);
    }

    // ── 6. Orders ─────────────────────────────────────────────────────────
    if (cps.orders?.next_url === 'COMPLETED') {
      console.log('[sync] orders: skipping (already completed)');
    } else {
      let ordersCount = cps.orders?.processed_count ?? 0;
      if (cps.orders) console.log(`[sync] Resuming orders from checkpoint at ${ordersCount}…`);
      else            console.log('[sync] Fetching orders…');
      for await (const { items, nextUrl } of paginate(client, 'Order', {}, cps.orders?.next_url)) {
        await upsertOrders(client, items);
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
        await upsertTransfers(client, items);
        txCount += items.length;
        if (txCount % 500 === 0) console.log(`[sync] Transfers processed: ${txCount}`);
        if (nextUrl && txCount % 2_000 === 0) await saveCheckpoint('transfers', nextUrl, txCount);
      }
      await markStepCompleted('transfers', txCount);
      console.log(`[sync] Transfers done: ${txCount} records`);
    }

    // ── Refresh materialized views ────────────────────────────────────────
    console.log('[sync] Refreshing materialized views…');
    await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_sales_velocity');
    await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_inventory_stock');

    console.log(`[sync] Done — ${new Date().toISOString()}`);

  } finally {
    clearInterval(keepalive);
  }
}

// ---------------------------------------------------------------------------
// Entrypoint: cron (every Monday at 07:00) or one-shot via --once flag
// ---------------------------------------------------------------------------
if (process.argv.includes('--once')) {
  runSync().catch(err => {
    if (err.response?.data?.message) {
      console.error('[sync] API error:', err.response.data.message);
    } else {
      console.error('[sync] Error:', err.message);
    }
    process.exit(1);
  });
} else {
  console.log('[sync] Scheduler started — runs every hour at :00');
  cron.schedule('0 * * * *', () => {
    runSync().catch(err => console.error('[sync] Error:', err));
  });
}
