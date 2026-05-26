require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');

const app  = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

app.use(express.json());

// ---------------------------------------------------------------------------
// /api/nos — Never-Out-of-Stock candidates
// Items whose average weekly velocity exceeds their current stock cover.
// Returns items at risk of stockout within `weeks` weeks (default 4).
// ---------------------------------------------------------------------------
app.get('/api/nos', async (req, res, next) => {
  try {
    const weeks = parseInt(req.query.weeks ?? '4', 10);
    const { rows } = await pool.query(`
      WITH velocity AS (
        SELECT
          v.item_id,
          v.shop_id,
          AVG(v.units_sold) AS avg_weekly_units
        FROM mv_sales_velocity v
        WHERE v.week >= date_trunc('week', now()) - interval '12 weeks'
        GROUP BY v.item_id, v.shop_id
      )
      SELECT
        p.item_id,
        p.description,
        p.brand,
        p.category,
        i.shop_id,
        s.name                           AS shop_name,
        i.qty_on_hand,
        i.qty_on_order,
        ROUND(v.avg_weekly_units, 2)     AS avg_weekly_units,
        ROUND(
          CASE WHEN v.avg_weekly_units > 0
               THEN (i.qty_on_hand + i.qty_on_order) / v.avg_weekly_units
               ELSE NULL END, 1
        )                                AS weeks_of_cover,
        GREATEST(0, ROUND(
          v.avg_weekly_units * $1 - (i.qty_on_hand + i.qty_on_order), 0
        ))                               AS suggested_order_qty
      FROM velocity v
      JOIN inventory  i ON i.item_id = v.item_id AND i.shop_id = v.shop_id
      JOIN products   p ON p.item_id = v.item_id
      JOIN shops      s ON s.shop_id = i.shop_id
      WHERE v.avg_weekly_units > 0
        AND (i.qty_on_hand + i.qty_on_order) / v.avg_weekly_units < $1
        AND p.archived = false
      ORDER BY weeks_of_cover ASC NULLS LAST, suggested_order_qty DESC
    `, [weeks]);
    res.json({ weeks_threshold: weeks, count: rows.length, items: rows });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// /api/transfers — Inter-shop transfer recommendations
// Identifies items overstocked at one shop and understocked at another.
// ---------------------------------------------------------------------------
app.get('/api/transfers', async (req, res, next) => {
  try {
    const minCover    = parseFloat(req.query.min_cover    ?? '8');   // weeks
    const maxCover    = parseFloat(req.query.max_cover    ?? '2');
    const { rows } = await pool.query(`
      WITH velocity AS (
        SELECT item_id, shop_id, AVG(units_sold) AS avg_weekly_units
        FROM mv_sales_velocity
        WHERE week >= date_trunc('week', now()) - interval '12 weeks'
        GROUP BY item_id, shop_id
      ),
      cover AS (
        SELECT
          i.item_id, i.shop_id,
          i.qty_on_hand,
          v.avg_weekly_units,
          CASE WHEN v.avg_weekly_units > 0
               THEN i.qty_on_hand / v.avg_weekly_units
               ELSE NULL END AS weeks_of_cover
        FROM inventory i
        JOIN velocity v USING (item_id, shop_id)
      )
      SELECT
        p.item_id,
        p.description,
        p.brand,
        p.category,
        over_stocked.shop_id             AS from_shop_id,
        sf.name                          AS from_shop,
        under_stocked.shop_id            AS to_shop_id,
        st.name                          AS to_shop,
        ROUND(over_stocked.qty_on_hand, 0)  AS from_qty_on_hand,
        ROUND(under_stocked.qty_on_hand, 0) AS to_qty_on_hand,
        ROUND(over_stocked.weeks_of_cover, 1)   AS from_weeks_cover,
        ROUND(under_stocked.weeks_of_cover, 1)  AS to_weeks_cover,
        ROUND(
          (over_stocked.weeks_of_cover - $1) / 2
          * over_stocked.avg_weekly_units, 0
        ) AS suggested_transfer_qty
      FROM cover over_stocked
      JOIN cover under_stocked USING (item_id)
      JOIN products p ON p.item_id = over_stocked.item_id
      JOIN shops sf   ON sf.shop_id = over_stocked.shop_id
      JOIN shops st   ON st.shop_id = under_stocked.shop_id
      WHERE over_stocked.weeks_of_cover  > $1
        AND under_stocked.weeks_of_cover < $2
        AND over_stocked.shop_id        <> under_stocked.shop_id
        AND p.archived = false
      ORDER BY suggested_transfer_qty DESC
    `, [minCover, maxCover]);
    res.json({ min_cover: minCover, max_cover: maxCover, count: rows.length, transfers: rows });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// /api/seasonal — Seasonal buying recommendations
// Compares same-period sales from prior years to forecast demand.
// ---------------------------------------------------------------------------
app.get('/api/seasonal', async (req, res, next) => {
  try {
    const weeksAhead = parseInt(req.query.weeks_ahead ?? '8', 10);
    const { rows } = await pool.query(`
      WITH target_window AS (
        SELECT
          date_trunc('week', now())                      AS start_week,
          date_trunc('week', now()) + ($1 * interval '1 week') AS end_week
      ),
      historical AS (
        SELECT
          v.item_id,
          v.shop_id,
          EXTRACT(week FROM v.week)  AS iso_week,
          AVG(v.units_sold)          AS avg_units
        FROM mv_sales_velocity v, target_window tw
        WHERE v.week >= now() - interval '2 years'
          AND EXTRACT(week FROM v.week) BETWEEN
              EXTRACT(week FROM tw.start_week) AND
              EXTRACT(week FROM tw.end_week)
        GROUP BY v.item_id, v.shop_id, EXTRACT(week FROM v.week)
      ),
      forecast AS (
        SELECT
          item_id, shop_id,
          ROUND(SUM(avg_units), 0) AS forecasted_units
        FROM historical
        GROUP BY item_id, shop_id
      )
      SELECT
        p.item_id,
        p.description,
        p.brand,
        p.category,
        f.shop_id,
        s.name              AS shop_name,
        f.forecasted_units,
        i.qty_on_hand,
        i.qty_on_order,
        GREATEST(0, f.forecasted_units - i.qty_on_hand - i.qty_on_order)
                            AS suggested_order_qty,
        ROUND(p.default_cost *
          GREATEST(0, f.forecasted_units - i.qty_on_hand - i.qty_on_order), 2
        )                   AS estimated_cost
      FROM forecast f
      JOIN inventory  i ON i.item_id = f.item_id AND i.shop_id = f.shop_id
      JOIN products   p ON p.item_id = f.item_id
      JOIN shops      s ON s.shop_id = f.shop_id
      WHERE f.forecasted_units > 0
        AND GREATEST(0, f.forecasted_units - i.qty_on_hand - i.qty_on_order) > 0
        AND p.archived = false
      ORDER BY suggested_order_qty DESC
    `, [weeksAhead]);
    res.json({ weeks_ahead: weeksAhead, count: rows.length, recommendations: rows });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// /api/sizes — Size curve analysis per product matrix and shop
// Shows which sizes sell best as a % of total matrix sales.
// ---------------------------------------------------------------------------
app.get('/api/sizes', async (req, res, next) => {
  try {
    const { matrix_id, shop_id } = req.query;
    const conditions = ['p.matrix_id IS NOT NULL', 'p.archived = false'];
    const params     = [];

    if (matrix_id) { params.push(matrix_id); conditions.push(`p.matrix_id = $${params.length}`); }
    if (shop_id)   { params.push(shop_id);   conditions.push(`sl.shop_id = $${params.length}`); }

    const { rows } = await pool.query(`
      WITH matrix_sales AS (
        SELECT
          p.matrix_id,
          p.item_id,
          p.description,
          sl.shop_id,
          SUM(sl.qty) AS units_sold
        FROM sale_lines sl
        JOIN products p ON p.item_id = sl.item_id
        WHERE ${conditions.join(' AND ')}
          AND sl.completed_time >= now() - interval '52 weeks'
        GROUP BY p.matrix_id, p.item_id, p.description, sl.shop_id
      ),
      matrix_totals AS (
        SELECT matrix_id, shop_id, SUM(units_sold) AS total_units
        FROM matrix_sales GROUP BY matrix_id, shop_id
      )
      SELECT
        ms.matrix_id,
        ms.item_id,
        ms.description,
        ms.shop_id,
        s.name            AS shop_name,
        ms.units_sold,
        mt.total_units,
        ROUND(ms.units_sold * 100.0 / NULLIF(mt.total_units, 0), 1) AS pct_of_matrix,
        i.qty_on_hand
      FROM matrix_sales ms
      JOIN matrix_totals mt USING (matrix_id, shop_id)
      JOIN shops         s  ON s.shop_id = ms.shop_id
      LEFT JOIN inventory i ON i.item_id = ms.item_id AND i.shop_id = ms.shop_id
      ORDER BY ms.matrix_id, ms.shop_id, pct_of_matrix DESC
    `, params);
    res.json({ count: rows.length, size_curves: rows });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// /api/budget — Buying budget summary
// Total estimated cost of all open recommendations (NOS + seasonal).
// ---------------------------------------------------------------------------
app.get('/api/budget', async (req, res, next) => {
  try {
    const weeks = parseInt(req.query.weeks ?? '4', 10);

    const { rows } = await pool.query(`
      WITH velocity AS (
        SELECT item_id, shop_id, AVG(units_sold) AS avg_weekly_units
        FROM mv_sales_velocity
        WHERE week >= date_trunc('week', now()) - interval '12 weeks'
        GROUP BY item_id, shop_id
      ),
      nos AS (
        SELECT
          i.shop_id,
          SUM(
            GREATEST(0, v.avg_weekly_units * $1 - (i.qty_on_hand + i.qty_on_order))
            * COALESCE(p.default_cost, 0)
          ) AS nos_cost
        FROM velocity v
        JOIN inventory i ON i.item_id = v.item_id AND i.shop_id = v.shop_id
        JOIN products  p ON p.item_id = v.item_id
        WHERE v.avg_weekly_units > 0
          AND (i.qty_on_hand + i.qty_on_order) / v.avg_weekly_units < $1
          AND p.archived = false
        GROUP BY i.shop_id
      )
      SELECT
        s.shop_id,
        s.name                     AS shop_name,
        ROUND(n.nos_cost, 2)       AS nos_replenishment_cost,
        ROUND(n.nos_cost * 1.15, 2) AS recommended_budget
      FROM nos n
      JOIN shops s USING (shop_id)
      ORDER BY recommended_budget DESC
    `, [weeks]);

    const total = rows.reduce((sum, r) => sum + parseFloat(r.recommended_budget ?? 0), 0);
    res.json({
      weeks_threshold: weeks,
      total_recommended_budget: Math.round(total * 100) / 100,
      by_shop: rows,
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => console.log(`Buying Intelligence API listening on port ${PORT}`));
