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
  SUM(sl.qty * sl.unit_price)           AS revenue
FROM sale_lines sl
WHERE sl.completed_time IS NOT NULL
GROUP BY sl.item_id, sl.shop_id, date_trunc('week', sl.completed_time);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_velocity ON mv_sales_velocity(item_id, shop_id, week);

-- Sync checkpoint — persists cursor position across restarts
CREATE TABLE IF NOT EXISTS sync_state (
  step            VARCHAR(50) PRIMARY KEY,
  next_url        TEXT,
  processed_count INTEGER DEFAULT 0,
  started_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);
