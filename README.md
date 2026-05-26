# Buying Intelligence

Purchase recommendation system connected to Lightspeed R-Series (OAuth2).

## Architecture

```
sync.js ──► Lightspeed API ──► PostgreSQL ──► server.js ──► REST API
 (cron)       (OAuth2)                         (Express)
```

## Setup

### 1. Dependencies

```bash
npm install
```

### 2. Environment

```bash
cp .env.example .env
# Fill in all values
```

| Variable | Description |
|---|---|
| `LIGHTSPEED_ACCOUNT_ID` | Your Lightspeed account ID |
| `LIGHTSPEED_CLIENT_ID` | OAuth2 client ID from Lightspeed developer portal |
| `LIGHTSPEED_CLIENT_SECRET` | OAuth2 client secret |
| `LIGHTSPEED_REFRESH_TOKEN` | Long-lived refresh token (obtained during OAuth2 flow) |
| `DATABASE_URL` | PostgreSQL connection string |
| `PORT` | Express port (default 3000) |
| `SYNC_DAYS_BACK` | How many days of sales to pull per sync (default 90) |

> **Getting a refresh token:** Complete the OAuth2 authorization code flow once in your browser, capture the `refresh_token` from the callback, and store it in `.env`. The sync worker refreshes the access token automatically on every run.

### 3. Database

```bash
psql $DATABASE_URL -f schema.sql
```

### 4. First sync (one-shot)

```bash
node sync.js --once
```

### 5. Start API server

```bash
npm start
```

### 6. Start sync scheduler (every Monday 07:00)

Run `sync.js` as a long-lived process (e.g. via PM2):

```bash
pm2 start sync.js --name buying-sync
```

---

## API Reference

All endpoints return JSON.

### `GET /api/nos`

**Never-Out-of-Stock** — items that will stock out within N weeks based on 12-week velocity.

| Query param | Default | Description |
|---|---|---|
| `weeks` | `4` | Weeks of cover threshold |

```json
{
  "weeks_threshold": 4,
  "count": 12,
  "items": [
    {
      "item_id": "123",
      "description": "Blue Jacket M",
      "shop_name": "Downtown",
      "qty_on_hand": 2,
      "avg_weekly_units": 1.5,
      "weeks_of_cover": 1.3,
      "suggested_order_qty": 4
    }
  ]
}
```

---

### `GET /api/transfers`

**Inter-shop transfer recommendations** — overstocked locations that can replenish understocked ones.

| Query param | Default | Description |
|---|---|---|
| `min_cover` | `8` | Weeks cover to be considered overstocked |
| `max_cover` | `2` | Weeks cover to be considered understocked |

---

### `GET /api/seasonal`

**Seasonal buying forecast** — demand forecast for the next N weeks based on same-period prior years.

| Query param | Default | Description |
|---|---|---|
| `weeks_ahead` | `8` | Forward planning window |

---

### `GET /api/sizes`

**Size curve analysis** — % of matrix sales by size, per shop.

| Query param | Default | Description |
|---|---|---|
| `matrix_id` | — | Filter to a specific matrix |
| `shop_id` | — | Filter to a specific shop |

---

### `GET /api/budget`

**Buying budget summary** — estimated replenishment cost by shop.

| Query param | Default | Description |
|---|---|---|
| `weeks` | `4` | Planning horizon (same as `/api/nos`) |

```json
{
  "weeks_threshold": 4,
  "total_recommended_budget": 14250.00,
  "by_shop": [
    { "shop_name": "Downtown", "nos_replenishment_cost": 8000, "recommended_budget": 9200 }
  ]
}
```

---

## Sync worker endpoints

The worker pulls these Lightspeed endpoints in order:

1. `Shop` — store locations
2. `Item` (with Category, Department, Manufacturer, Prices)
3. `ItemMatrix` — size/colour variant groups
4. `ItemShop` — per-location inventory quantities
5. `Sale` (with embedded `SaleLines`) — filtered to `SYNC_DAYS_BACK`
6. `Order` — purchase orders

Pagination uses `limit=200` with offset scrolling. All data is upserted (conflict on primary key).

After each sync the `mv_sales_velocity` materialized view is refreshed concurrently so the API reflects the latest data with no downtime.
