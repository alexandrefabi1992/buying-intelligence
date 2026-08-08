'use strict';
// Backfill script for the matrix_key mismatch bug (fix in commit 5ee9dbc).
//
// Before that fix, matrix overrides set via the UI (category, retail_price)
// used the key "style_ref|color_label" (e.g. MAR4909T|LAVENDER) while the
// push code looked them up as "style_ref|color_normalized" (e.g.
// MAR4909T|LAVENDER-054). Lookups silently missed → overrides never
// applied to Lightspeed matrices.
//
// This script walks every pushed file, finds import_matrix_overrides
// whose matrix_key doesn't directly appear in import_order_lines, tries
// to fuzzy-match to the actual line via prefix-of-color_normalized, and
// PUTs the missing category / Prices to the Lightspeed matrix.
//
// USAGE:
//   railway run node scripts/backfill-matrix-overrides.js           # dry run
//   railway run node scripts/backfill-matrix-overrides.js --apply   # actually PUT
//
// Idempotent: rerunning after --apply is a no-op (already-applied values
// are detected via GET-before-PUT and skipped).

const { Pool } = require('pg');
const { fromEnv } = require('../lib/lightspeed-client');

const DRY = !process.argv.includes('--apply');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway.internal') ? undefined : { rejectUnauthorized: false },
});

function stripCodeSuffix(colorNormalized, colorCode) {
  if (!colorNormalized) return null;
  if (colorCode && colorNormalized.endsWith('-' + colorCode)) {
    return colorNormalized.slice(0, -1 - String(colorCode).length);
  }
  return colorNormalized;
}

async function fetchOverridesForFile(pool, tenantId, fileId) {
  const { rows } = await pool.query(
    `SELECT matrix_key, category_id, category_path, retail_price_override
     FROM   import_matrix_overrides
     WHERE  tenant_id = $1 AND file_id = $2`,
    [tenantId, fileId],
  );
  return rows;
}

async function fetchLinesForFile(pool, tenantId, fileId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ol.supplier_style_ref, ol.supplier_color_ref,
            ol.color_normalized, ol.matrix_id
     FROM   import_order_lines ol
     JOIN   import_batches      b ON b.batch_id = ol.batch_id
     WHERE  b.file_id = $1 AND b.tenant_id = $2 AND ol.matrix_id IS NOT NULL`,
    [fileId, tenantId],
  );
  return rows;
}

// Build a lookup: for each unique (style_ref, color_normalized_stripped) → matrix_id
// Also indexes by the full color_normalized (in case old override was written
// with the full key post-fix).
function buildMatrixKeyIndex(lines) {
  const idx = new Map();
  for (const l of lines) {
    const fullKey    = `${l.supplier_style_ref}|${l.color_normalized}`;
    const strippedKey = `${l.supplier_style_ref}|${stripCodeSuffix(l.color_normalized, l.supplier_color_ref)}`;
    idx.set(fullKey, l.matrix_id);
    if (!idx.has(strippedKey)) idx.set(strippedKey, l.matrix_id);
  }
  return idx;
}

async function main() {
  const client = fromEnv();
  console.log(`Mode: ${DRY ? 'DRY-RUN (no changes)' : 'APPLY (will PUT to Lightspeed)'}`);
  console.log('');

  // Find all pushed / partial files that have overrides
  const { rows: files } = await pool.query(`
    SELECT f.file_id, f.tenant_id, f.source_filename, f.status, f.target_manufacturer
    FROM   import_files f
    WHERE  f.status IN ('pushed', 'partial')
      AND  EXISTS (SELECT 1 FROM import_matrix_overrides o WHERE o.file_id = f.file_id)
    ORDER  BY f.file_id
  `);
  console.log(`${files.length} pushed file(s) have matrix overrides — scanning each.`);

  let totalApplied = 0, totalSkipped = 0, totalNotFound = 0, totalFailed = 0;

  for (const f of files) {
    console.log(`\n── file_id=${f.file_id} "${f.source_filename}" (${f.target_manufacturer}) ──`);
    const overrides = await fetchOverridesForFile(pool, f.tenant_id, f.file_id);
    const lines     = await fetchLinesForFile(pool, f.tenant_id, f.file_id);
    const idx       = buildMatrixKeyIndex(lines);

    for (const ov of overrides) {
      const hasCategory = ov.category_id != null;
      const hasRetail   = ov.retail_price_override != null;
      if (!hasCategory && !hasRetail) { totalSkipped++; continue; }

      const matrixId = idx.get(ov.matrix_key);
      if (!matrixId) {
        console.log(`  ✗ matrix_key="${ov.matrix_key}" — no matching pushed matrix found`);
        totalNotFound++;
        continue;
      }

      // Fetch current Lightspeed state to decide what actually needs PUTting
      let currentCategory = null, currentPricesAmount = null;
      try {
        const { matrix } = await client.getMatrixWithVariants(matrixId);
        currentCategory      = String(matrix.categoryID ?? '0');
        const firstPrice      = matrix.Prices?.ItemPrice?.[0]?.amount;
        currentPricesAmount   = firstPrice != null ? Number(firstPrice) : null;
      } catch (e) {
        console.log(`  ✗ matrix_key="${ov.matrix_key}" matrix=#${matrixId} — GET failed: ${e.message}`);
        totalFailed++;
        continue;
      }

      const wantCategory = hasCategory ? String(ov.category_id) : null;
      const wantRetail   = hasRetail   ? Number(ov.retail_price_override) : null;

      const needCat    = hasCategory && wantCategory !== currentCategory;
      const needRetail = hasRetail && (currentPricesAmount == null || Math.abs(currentPricesAmount - wantRetail) > 0.01);

      if (!needCat && !needRetail) {
        console.log(`  = matrix_key="${ov.matrix_key}" matrix=#${matrixId} — already up-to-date`);
        totalSkipped++;
        continue;
      }

      const putBody = {};
      if (needCat)    putBody.categoryID = wantCategory;
      if (needRetail) putBody.Prices = {
        ItemPrice: [
          { amount: String(wantRetail), useType: 'Default' },
          { amount: String(wantRetail), useType: 'MSRP' },
          { amount: String(wantRetail), useType: 'Online' },
        ],
      };

      const changes = [
        needCat    ? `category ${currentCategory}→${wantCategory}` : null,
        needRetail ? `retail   ${currentPricesAmount ?? 'null'}→${wantRetail}` : null,
      ].filter(Boolean).join(', ');
      console.log(`  ${DRY ? '~' : '→'} matrix_key="${ov.matrix_key}" matrix=#${matrixId} ${DRY ? '(would apply)' : '(applying)'} ${changes}`);

      if (!DRY) {
        try {
          await client._request('PUT', `/ItemMatrix/${matrixId}.json`, { body: putBody });
          totalApplied++;
        } catch (e) {
          console.log(`    ✗ PUT failed: ${e.message}`);
          totalFailed++;
        }
      } else {
        totalApplied++; // count as would-apply
      }
    }
  }

  console.log('');
  console.log('═══ SUMMARY ═══');
  console.log(`  ${DRY ? 'Would apply' : 'Applied'}: ${totalApplied}`);
  console.log(`  Skipped (no-op or empty override): ${totalSkipped}`);
  console.log(`  Not found (matrix_key has no matching line): ${totalNotFound}`);
  console.log(`  Failed: ${totalFailed}`);
  if (DRY) console.log('\n  Re-run with --apply to actually PUT to Lightspeed.');

  await pool.end();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
