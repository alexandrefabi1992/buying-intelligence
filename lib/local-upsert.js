'use strict';
// Local Postgres upsert of items we just created in Lightspeed.
//
// WHY THIS EXISTS
//   sync.js has a checkpoint-level freshness gate (sync.js:1008):
//     "[sync] items: fresh (Nd old) — skipping"
//   If the `items` checkpoint is younger than STATIC_SYNC_DAYS, the next
//   sync run skips fetching items entirely. Without this upsert, a variant
//   we just POSTed to Lightspeed stays invisible to the local `products`
//   table (and therefore to budget calculations) for up to STATIC_SYNC_DAYS
//   after creation — the sync just doesn't know it exists yet.
//
// SHAPE COMPATIBILITY WITH sync.js
//   This module writes to the SAME columns with the SAME conflict-resolution
//   key (tenant_id, item_id) that sync.js uses in upsertProducts()
//   (sync.js:530). Fields sync.js resolves from loaded relations
//   (Manufacturer.name, Category.fullPathName) must be provided explicitly
//   here because the POST /Item response doesn't include loaded relations —
//   only the raw IDs. The caller (queue processor) knows the manufacturer
//   name from brand_vendor_map and provides it.
//
//   On the NEXT sync, if it re-fetches this item, its own INSERT ... ON
//   CONFLICT DO UPDATE will overwrite whatever we wrote — including refined
//   category, tags with images loaded, etc. That's expected and correct.

// Upsert one item into the local `products` table.
//
// Required args:
//   pool                — a `pg` Pool
//   tenantId            — string, e.g. 'valerie-simon'
//   item                — the object returned by POST /Item (or PUT /Item after tag);
//                          must at minimum contain itemID, itemMatrixID, description,
//                          defaultCost, manufacturerID, categoryID, archived
//   manufacturerName    — resolved brand name (e.g. 'Oui') — POST response has only
//                          manufacturerID, not the loaded Manufacturer relation
//
// Optional args:
//   tags                — string[] applied via tagItem() (e.g. ['a26']).
//                          Stored as CSV to match sync.js convention.
//                          null/empty → tags column stays NULL.
//   categoryName        — full path or leaf name if known; else null.
//
// Returns { inserted: boolean, item_id }.
async function upsertCreatedProduct(pool, { tenantId, item, manufacturerName, tags = null, categoryName = null }) {
  if (!pool)              throw new Error('upsertCreatedProduct: pool required');
  if (!tenantId)          throw new Error('upsertCreatedProduct: tenantId required');
  if (!item?.itemID)      throw new Error('upsertCreatedProduct: item.itemID required');
  if (!manufacturerName)  throw new Error('upsertCreatedProduct: manufacturerName required');

  const tagsCsv = Array.isArray(tags) && tags.length
    ? tags.map(t => String(t).trim()).filter(Boolean).join(',')
    : null;

  // Match sync.js's Prices path if present in the response, else null
  const defaultPrice = item.Prices?.ItemPrice?.[0]?.amount ?? item.defaultPrice ?? null;
  const archived = item.archived === 'true' || item.archived === true;

  const res = await pool.query(
    `INSERT INTO products
       (item_id, matrix_id, description, ean, upc, manufacturer, brand,
        category, department, tags, image_url, default_cost, default_price,
        archived, raw, tenant_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (tenant_id, item_id) DO UPDATE
       SET matrix_id     = EXCLUDED.matrix_id,
           description   = EXCLUDED.description,
           ean           = EXCLUDED.ean,
           upc           = EXCLUDED.upc,
           manufacturer  = EXCLUDED.manufacturer,
           brand         = EXCLUDED.brand,
           category      = EXCLUDED.category,
           department    = EXCLUDED.department,
           tags          = EXCLUDED.tags,
           image_url     = EXCLUDED.image_url,
           default_cost  = EXCLUDED.default_cost,
           default_price = EXCLUDED.default_price,
           archived      = EXCLUDED.archived,
           raw           = EXCLUDED.raw,
           stub_inferred_fields = NULL,
           synced_at     = now()
     RETURNING (xmax = 0) AS inserted`,
    [
      String(item.itemID),
      item.itemMatrixID ? String(item.itemMatrixID) : null,
      item.description ?? null,
      item.ean ?? null,
      item.upc ?? null,
      manufacturerName,
      null,                                    // brand — sync.js also stores null
      categoryName,
      item.departmentID ? String(item.departmentID) : null,
      tagsCsv,
      null,                                    // image_url — no images at creation
      item.defaultCost ?? null,
      defaultPrice,
      archived,
      item,                                    // raw JSONB
      tenantId,
    ],
  );
  return { inserted: !!res.rows[0]?.inserted, item_id: String(item.itemID) };
}

// Batch helper — upserts many items in a single transaction. All-or-nothing:
// if any single row fails, the whole batch is rolled back so we don't leave
// partial state behind.
async function upsertCreatedProducts(pool, { tenantId, items, manufacturerName, tags = null, categoryName = null }) {
  if (!items?.length) return { inserted: 0, updated: 0 };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let inserted = 0, updated = 0;
    for (const item of items) {
      const r = await upsertCreatedProduct(client, {
        tenantId, item, manufacturerName, tags, categoryName,
      });
      if (r.inserted) inserted++; else updated++;
    }
    await client.query('COMMIT');
    return { inserted, updated };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { upsertCreatedProduct, upsertCreatedProducts };
