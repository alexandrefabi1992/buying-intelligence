#!/usr/bin/env node
'use strict';
// One-off catalogue audit — finds all ItemMatrix rows with zero variants.
//
// Strategy: single paginated sweep of /ItemMatrix.json with
// load_relations=["Items","Manufacturer"] — variant count comes inline, no
// extra round-trip per matrix. Cursor pagination (`after`) since Lightspeed
// dropped offset.
//
// READS ONLY. Nothing is written or archived. Output is a report:
//   - total empty matrices
//   - breakdown by manufacturer (and by season-suffixed vs bare)
//   - full list for Oui
//
// Run: railway run node scripts/audit-empty-matrices.js

const { fromEnv } = require('../lib/lightspeed-client');

// Detect "styleRef <season>" where season looks like p26/a26/p27/etc.
const SEASON_SUFFIX_RE = /\s(p\d{2}|a\d{2}|h\d{2}|e\d{2})$/i;

async function main() {
  const cli = fromEnv();
  console.log(`Sweeping /ItemMatrix.json with Items+Manufacturer loaded…\n`);

  const baseParams = { load_relations: '["Items","Manufacturer"]', limit: 100 };
  let after = null;
  let pageNum = 0;
  const all = [];
  const t0 = Date.now();

  for (;;) {
    const params = after ? { ...baseParams, after } : baseParams;
    const r = await cli._request('GET', '/ItemMatrix.json', { params });
    let list = r.ItemMatrix ?? [];
    if (!Array.isArray(list)) list = [list];
    all.push(...list);
    pageNum++;
    process.stdout.write(`  page ${pageNum}: +${list.length} matrices (total ${all.length})\r`);

    const nextUrl = r['@attributes']?.next;
    if (!nextUrl) break;
    const parsed = new URL(nextUrl);
    after = parsed.searchParams.get('after');
    if (!after) break;
  }
  const totalDur = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n  → done in ${totalDur}s — ${all.length} matrices scanned across ${pageNum} pages.\n`);

  // Compute variant count and classify each empty matrix
  const empties = [];
  for (const m of all) {
    let items = m.Items?.Item ?? [];
    if (!Array.isArray(items)) items = items ? [items] : [];
    if (items.length === 0) {
      const desc = String(m.description ?? '').trim();
      const manuName = m.Manufacturer?.name ?? '(no manufacturer)';
      const isArchived = m.archived === 'true' || m.archived === true;
      const seasonMatch = desc.match(SEASON_SUFFIX_RE);
      empties.push({
        matrix_id:      m.itemMatrixID,
        description:    desc,
        manufacturer:   manuName,
        manufacturerID: m.manufacturerID,
        archived:       isArchived,
        season_suffix:  seasonMatch ? seasonMatch[1].toLowerCase() : null,
      });
    }
  }

  // ═══ Breakdown ══════════════════════════════════════════════════════════
  const byBrand = new Map();
  let seasonSuffixed = 0;
  let bare = 0;
  let archived = 0;
  for (const e of empties) {
    if (!byBrand.has(e.manufacturer)) {
      byBrand.set(e.manufacturer, { total: 0, season_suffixed: 0, bare: 0, archived: 0 });
    }
    const b = byBrand.get(e.manufacturer);
    b.total++;
    if (e.archived) { b.archived++; archived++; }
    if (e.season_suffix) { b.season_suffixed++; seasonSuffixed++; }
    else                 { b.bare++;             bare++; }
  }

  console.log('═'.repeat(90));
  console.log(`  AUDIT: matrices vides dans le catalogue`);
  console.log('═'.repeat(90));
  console.log(`  Matrices totales scannées   : ${all.length}`);
  console.log(`  Matrices VIDES              : ${empties.length}`);
  console.log(`    dont season-suffixées     : ${seasonSuffixed}  (récupérables auto par le module)`);
  console.log(`    dont bare (sans suffixe)  : ${bare}            (à archiver manuellement)`);
  console.log(`    dont déjà archivées       : ${archived}`);

  console.log(`\n─ Répartition par marque (triée par total desc) ─`);
  const brands = [...byBrand.entries()].sort((a, b) => b[1].total - a[1].total);
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`  ${pad('Marque', 32)} ${pad('total', 7)} ${pad('season', 8)} ${pad('bare', 6)} ${pad('archived', 10)}`);
  console.log(`  ${'-'.repeat(32)} ${'-'.repeat(7)} ${'-'.repeat(8)} ${'-'.repeat(6)} ${'-'.repeat(10)}`);
  for (const [name, s] of brands) {
    console.log(`  ${pad(name, 32)} ${String(s.total).padStart(5)}   ${String(s.season_suffixed).padStart(6)}   ${String(s.bare).padStart(4)}   ${String(s.archived).padStart(8)}`);
  }

  // ═══ Full Oui list ═════════════════════════════════════════════════════
  console.log(`\n─ Liste complète — marque Oui ─`);
  const ouiEmpties = empties.filter(e => e.manufacturer === 'Oui').sort((a, b) => {
    // group season-suffixed first, then bare
    if (!!a.season_suffix !== !!b.season_suffix) return a.season_suffix ? -1 : 1;
    return a.description.localeCompare(b.description);
  });
  if (!ouiEmpties.length) {
    console.log(`  Aucune matrice vide sous la marque Oui.`);
  } else {
    console.log(`  ${ouiEmpties.length} matrices vides sous Oui :\n`);
    for (const e of ouiEmpties) {
      const flag = e.archived ? ' [archivée]' : '';
      const kind = e.season_suffix ? `[${e.season_suffix}]` : '[bare] ';
      console.log(`   ${kind} #${String(e.matrix_id).padEnd(6)}  "${e.description}"${flag}`);
    }
    const ouiSeason = ouiEmpties.filter(e => e.season_suffix).length;
    const ouiBare   = ouiEmpties.filter(e => !e.season_suffix).length;
    console.log(`\n  → Oui: ${ouiSeason} season-suffixée(s) (récup auto) + ${ouiBare} bare (à archiver).`);
  }

  console.log('\n' + '═'.repeat(90));
}

main().catch(e => {
  console.error('FATAL:', e.message);
  if (e.body) console.error('  body:', JSON.stringify(e.body).slice(0, 500));
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
