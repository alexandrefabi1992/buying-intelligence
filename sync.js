require('dotenv').config();
const axios = require('axios');
const { Pool } = require('pg');
const cron = require('node-cron');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const BASE_URL = `https://api.lightspeedapp.com/API/V3/Account/${process.env.LIGHTSPEED_ACCOUNT_ID}`;
const TOKEN_URL = 'https://cloud.lightspeedapp.com/oauth/access_token.php';
const LIMIT = 200;

// ---------------------------------------------------------------------------
// OAuth2 — exchange refresh token for a short-lived access token
// ---------------------------------------------------------------------------
let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 30_000) return cachedToken;

  const { data } = await axios.post(TOKEN_URL, new URLSearchParams({
    client_id:     process.env.LIGHTSPEED_CLIENT_ID,
    client_secret: process.env.LIGHTSPEED_CLIENT_SECRET,
    refresh_token: process.env.LIGHTSPEED_REFRESH_TOKEN,
    grant_type:    'refresh_token',
  }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

  cachedToken     = data.access_token;
  tokenExpiresAt  = Date.now() + data.expires_in * 1000;
  return cachedToken;
}

async function apiClient() {
  const token = await getAccessToken();
  return axios.create({
    baseURL: BASE_URL,
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ---------------------------------------------------------------------------
// Paginated fetch — yields each page's item array
// ---------------------------------------------------------------------------
async function* paginate(client, resource, params = {}) {
  let offset = 0;
  while (true) {
    const { data } = await client.get(`/${resource}.json`, {
      params: { ...params, limit: LIMIT, offset },
    });

    const wrapper = data[resource] ?? data[Object.keys(data).find(k => k !== '@attributes')];
    const items   = Array.isArray(wrapper) ? wrapper : wrapper ? [wrapper] : [];
    const count   = Number(data['@attributes']?.count ?? items.length);

    if (items.length === 0) break;
    yield items;

    offset += LIMIT;
    if (offset >= count) break;
  }
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
    await pool.query(
      `INSERT INTO products(item_id, matrix_id, description, ean, upc, manufacturer, brand,
         category, department, default_cost, default_price, archived, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT(item_id) DO UPDATE
         SET matrix_id=$2, description=$3, ean=$4, upc=$5, manufacturer=$6, brand=$7,
             category=$8, department=$9, default_cost=$10, default_price=$11,
             archived=$12, raw=$13, synced_at=now()`,
      [
        item.itemID, item.itemMatrixID ?? null,
        item.description, item.ean ?? null, item.upc ?? null,
        item.manufacturerID ?? null, item.Manufacturer?.name ?? null,
        item.Category?.name ?? null, item.Department?.name ?? null,
        item.defaultCost ?? null, item.Prices?.ItemPrice?.[0]?.amount ?? null,
        item.archived === 'true', item,
      ],
    );
  }
}

async function upsertInventory(client, rows) {
  for (const is of rows) {
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
  }
}

async function upsertSales(client, rows) {
  for (const s of rows) {
    await pool.query(
      `INSERT INTO sales(sale_id, shop_id, register_id, customer_id, completed_time, total, discount, tax, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT(sale_id) DO UPDATE
         SET shop_id=$2, completed_time=$5, total=$6, discount=$7, tax=$8, raw=$9, synced_at=now()`,
      [
        s.saleID, s.shopID ?? null, s.registerID ?? null, s.customerID ?? null,
        s.completedTime ?? null,
        s.calcTotal ?? null, s.calcDiscount ?? null, s.calcTax ?? null,
        s,
      ],
    );
  }
}

async function upsertSaleLines(client, rows, completedTime) {
  for (const sl of rows) {
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
        sl.unitPrice ?? null, sl.unitCost ?? null,
        sl.unitQuantity ?? null, sl.discountAmount ?? null, sl.tax ?? null,
        completedTime ?? null,
        sl,
      ],
    );
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
        o.total ?? null, o,
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Main sync
// ---------------------------------------------------------------------------
async function runSync() {
  console.log(`[sync] Starting — ${new Date().toISOString()}`);
  const client = await apiClient();

  const daysBack   = parseInt(process.env.SYNC_DAYS_BACK ?? '90', 10);
  const since      = new Date(Date.now() - daysBack * 86_400_000).toISOString();

  // 1. Shops
  console.log('[sync] Fetching shops…');
  for await (const page of paginate(client, 'Shop')) {
    await upsertShops(client, page);
  }

  // 2. Items (products)
  console.log('[sync] Fetching items…');
  for await (const page of paginate(client, 'Item', {
    load_relations: JSON.stringify(['Category', 'Department', 'Manufacturer', 'Prices']),
  })) {
    await upsertProducts(client, page);
  }

  // 3. ItemMatrix (update matrix_id mapping via products already inserted)
  console.log('[sync] Fetching item matrices…');
  for await (const page of paginate(client, 'ItemMatrix')) {
    // ItemMatrix itself is metadata; product rows already carry matrixID from Item
    // Store raw for reference
    for (const m of page) {
      await pool.query(
        `UPDATE products SET raw = raw || $2::jsonb WHERE matrix_id = $1`,
        [m.itemMatrixID, JSON.stringify({ matrix: m })],
      );
    }
  }

  // 4. ItemShop (inventory)
  console.log('[sync] Fetching inventory (ItemShop)…');
  for await (const page of paginate(client, 'ItemShop')) {
    await upsertInventory(client, page);
  }

  // 5. Sales (with embedded SaleLines)
  console.log(`[sync] Fetching sales since ${since}…`);
  for await (const page of paginate(client, 'Sale', {
    load_relations: JSON.stringify(['SaleLines']),
    completed_time: `>,${since}`,
    sort:           'completedTime',
  })) {
    await upsertSales(client, page);
    for (const sale of page) {
      const lines = sale.SaleLines?.SaleLine;
      if (!lines) continue;
      const lineArr = Array.isArray(lines) ? lines : [lines];
      await upsertSaleLines(client, lineArr, sale.completedTime);
    }
  }

  // 6. Orders
  console.log('[sync] Fetching orders…');
  for await (const page of paginate(client, 'Order')) {
    await upsertOrders(client, page);
  }

  // Refresh materialized view
  console.log('[sync] Refreshing sales velocity view…');
  await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_sales_velocity');

  console.log(`[sync] Done — ${new Date().toISOString()}`);
}

// ---------------------------------------------------------------------------
// Entrypoint: cron (every Monday at 07:00) or one-shot via --once flag
// ---------------------------------------------------------------------------
if (process.argv.includes('--once')) {
  runSync().catch(err => { console.error(err); process.exit(1); });
} else {
  console.log('[sync] Scheduler started — runs every Monday at 07:00');
  // Cron expression: minute=0 hour=7 dayOfWeek=1 (Monday)
  cron.schedule('0 7 * * 1', () => {
    runSync().catch(err => console.error('[sync] Error:', err));
  });
}
