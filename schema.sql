-- Buying Intelligence — PostgreSQL Schema
-- Run once: psql $DATABASE_URL -f schema.sql

CREATE TABLE IF NOT EXISTS shops (
  shop_id        TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  time_zone      TEXT,
  raw            JSONB,
  synced_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
  item_id        TEXT PRIMARY KEY,
  matrix_id      TEXT,
  description    TEXT,
  ean            TEXT,
  upc            TEXT,
  manufacturer   TEXT,
  brand          TEXT,
  category       TEXT,
  department     TEXT,
  tags           TEXT,
  image_url      TEXT,
  default_cost   NUMERIC(12,4),
  default_price  NUMERIC(12,4),
  archived       BOOLEAN DEFAULT false,
  raw            JSONB,
  synced_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_products_matrix ON products(matrix_id);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);

CREATE TABLE IF NOT EXISTS inventory (
  id             BIGSERIAL PRIMARY KEY,
  item_id        TEXT NOT NULL REFERENCES products(item_id) ON DELETE CASCADE,
  shop_id        TEXT NOT NULL REFERENCES shops(shop_id) ON DELETE CASCADE,
  qty_on_hand    NUMERIC(12,4) DEFAULT 0,
  qty_on_order   NUMERIC(12,4) DEFAULT 0,
  reorder_point  NUMERIC(12,4),
  reorder_level  NUMERIC(12,4),
  raw            JSONB,
  synced_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE (item_id, shop_id)
);

CREATE INDEX IF NOT EXISTS idx_inventory_shop ON inventory(shop_id);

CREATE TABLE IF NOT EXISTS sales (
  sale_id        TEXT PRIMARY KEY,
  shop_id        TEXT REFERENCES shops(shop_id),
  register_id    TEXT,
  customer_id    TEXT,
  completed_time TIMESTAMPTZ,
  total          NUMERIC(12,4),
  discount       NUMERIC(12,4),
  tax            NUMERIC(12,4),
  raw            JSONB,
  synced_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sales_shop        ON sales(shop_id);
CREATE INDEX IF NOT EXISTS idx_sales_completed   ON sales(completed_time);

CREATE TABLE IF NOT EXISTS sale_lines (
  sale_line_id   TEXT PRIMARY KEY,
  sale_id        TEXT NOT NULL REFERENCES sales(sale_id) ON DELETE CASCADE,
  item_id        TEXT REFERENCES products(item_id),
  shop_id        TEXT REFERENCES shops(shop_id),
  unit_price     NUMERIC(12,4),
  unit_cost      NUMERIC(12,4),
  qty            NUMERIC(12,4),
  discount       NUMERIC(12,4),
  tax            NUMERIC(12,4),
  completed_time TIMESTAMPTZ,
  raw            JSONB,
  synced_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sale_lines_sale   ON sale_lines(sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_lines_item   ON sale_lines(item_id);
CREATE INDEX IF NOT EXISTS idx_sale_lines_shop   ON sale_lines(shop_id);
CREATE INDEX IF NOT EXISTS idx_sale_lines_date   ON sale_lines(completed_time);

CREATE TABLE IF NOT EXISTS orders (
  order_id       TEXT PRIMARY KEY,
  shop_id        TEXT REFERENCES shops(shop_id),
  vendor_id      TEXT,
  status         TEXT,
  order_date     TIMESTAMPTZ,
  eta            TIMESTAMPTZ,
  total          NUMERIC(12,4),
  raw            JSONB,
  synced_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_shop   ON orders(shop_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

-- Materialized view: weekly sales velocity per item per shop (refreshed after each sync)
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_sales_velocity AS
SELECT
  sl.item_id,
  sl.shop_id,
  date_trunc('week', sl.completed_time) AS week,
  SUM(sl.qty)                           AS units_sold,
  SUM(sl.qty * sl.unit_price - COALESCE((sl.raw->>'calcLineDiscount')::numeric, 0)) AS revenue
FROM sale_lines sl
WHERE sl.completed_time IS NOT NULL
GROUP BY sl.item_id, sl.shop_id, date_trunc('week', sl.completed_time);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_velocity      ON mv_sales_velocity(item_id, shop_id, week);
-- Dedicated week index so "WHERE week >= now()-12weeks" uses a range scan (week is 3rd col above)
CREATE INDEX        IF NOT EXISTS idx_mv_velocity_week  ON mv_sales_velocity(week);

-- Pre-aggregated inventory stock per item across all shops.
-- Eliminates the 412ms Seq Scan + HashAggregate on 662k inventory rows in /api/budget/saisonnier.
-- Refreshed CONCURRENTLY after each sync alongside mv_sales_velocity.
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_inventory_stock AS
SELECT
  item_id,
  SUM(COALESCE(qty_on_hand, 0) + COALESCE(qty_on_order, 0)) AS current_stock_all
FROM inventory
GROUP BY item_id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_inventory_stock ON mv_inventory_stock(item_id);

-- Trigram extension for ILIKE '%…%' acceleration on tags
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_products_tags_gin     ON products USING gin(tags        gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_products_desc_gin     ON products USING gin(description gin_trgm_ops);

-- Manufacturer index for GROUP BY sort
CREATE INDEX IF NOT EXISTS idx_products_manufacturer ON products(manufacturer);

-- Partial index: most queries filter archived = false; skip archived rows entirely
CREATE INDEX IF NOT EXISTS idx_products_active       ON products(item_id) WHERE archived = false;

-- Inter-shop stock transfers (one row per transfer × item)
-- sent/received booleans on the header; qty_received = units actually moved
CREATE TABLE IF NOT EXISTS transfers (
  transfer_item_id  TEXT PRIMARY KEY,                              -- TransferItem.transferItemID
  transfer_id       TEXT NOT NULL,                                 -- Transfer.transferID
  from_shop_id      TEXT REFERENCES shops(shop_id) ON DELETE SET NULL,
  to_shop_id        TEXT REFERENCES shops(shop_id) ON DELETE SET NULL,
  item_id           TEXT REFERENCES products(item_id) ON DELETE SET NULL,
  qty_sent          NUMERIC(12,4) DEFAULT 0,
  qty_received      NUMERIC(12,4) DEFAULT 0,
  transfer_sent     BOOLEAN DEFAULT false,                         -- header: was it sent?
  transfer_received BOOLEAN DEFAULT false,                         -- header: was it received?
  transfer_date     TIMESTAMPTZ,                                   -- sentOn or timeStamp
  note              TEXT,
  raw               JSONB,
  synced_at         TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transfers_transfer ON transfers(transfer_id);
CREATE INDEX IF NOT EXISTS idx_transfers_item     ON transfers(item_id);
CREATE INDEX IF NOT EXISTS idx_transfers_from     ON transfers(from_shop_id);
CREATE INDEX IF NOT EXISTS idx_transfers_to       ON transfers(to_shop_id);
CREATE INDEX IF NOT EXISTS idx_transfers_date     ON transfers(transfer_date);

-- Sync checkpoint — persists cursor position across restarts
CREATE TABLE IF NOT EXISTS sync_state (
  step            VARCHAR(50) PRIMARY KEY,
  next_url        TEXT,
  processed_count INTEGER DEFAULT 0,
  started_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- App settings — key/value store for editable config (multiplier tiers, etc.)
-- Multiplier tiers key: 'multiplier_tiers'
-- Value format: [{ "st_min": 0.80, "multiplier": 1.25, "label": "Augmenter" }, …]
-- st_min is a decimal fraction (0–1). Tiers checked highest-to-lowest; first match wins.
-- Edit via PUT /api/settings/multipliers or directly in DB:
--   UPDATE app_settings SET value = '[...]'::jsonb WHERE key = 'multiplier_tiers';
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Budget plans — planned purchase amounts per season/brand/shop
-- shop_id = '__all__' for global (all shops combined)
CREATE TABLE IF NOT EXISTS budget_plans (
  season_code      TEXT    NOT NULL,
  manufacturer     TEXT    NOT NULL,
  shop_id          TEXT    NOT NULL DEFAULT '__all__',
  planned_amount   NUMERIC NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (season_code, manufacturer, shop_id)
);
