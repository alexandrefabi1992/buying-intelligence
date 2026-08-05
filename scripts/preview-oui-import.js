'use strict';
// CLI wrapper around lib/preview-generator.js.
// Reads a PDF, resolves styles against Lightspeed, and renders the preview.
// WRITES NOTHING. This is the same code path an Express route will use.

const fs = require('fs');
const { parseOuiEurostyle } = require('../lib/parsers/oui-eurostyle');
const { fromEnv }           = require('../lib/lightspeed-client');
const { resolveStyles }     = require('../lib/style-resolver');
const { buildPreview }      = require('../lib/preview-generator');

async function main() {
  const pdfPath   = process.argv[2] || '/Users/alexandrefabi/Downloads/OrderConfirmationSteilmann_V2.pdf';
  const seasonTag = process.argv[3] || 'a26';
  console.log(`Season tag: ${seasonTag}\nParsing ${pdfPath}...\n`);

  const parsed = await parseOuiEurostyle(fs.readFileSync(pdfPath));
  const styleSet = new Set(parsed.products.map(p => p.style_ref));
  console.log(`Unique styles: ${styleSet.size} across ${parsed.products.length} product lines`);

  console.log(`\nResolving ${styleSet.size} styles…`);
  const client = fromEnv();
  const startedAt = Date.now();
  const resolutions = await resolveStyles(client, [...styleSet], seasonTag, {
    onProgress: (done, total) => {
      if (done % 10 === 0 || done === total) console.log(`  ${done}/${total} resolved…`);
    },
  });
  console.log(`  → done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

  const preview = buildPreview(parsed, resolutions, {
    season_tag:          seasonTag,
    target_manufacturer: 'Oui',
  });

  // ═══════════════════ RENDER ═════════════════════════════════════════════
  const H = s => '\n' + '═'.repeat(100) + '\n' + s + '\n' + '═'.repeat(100);
  console.log(H('                    PRÉVISUALISATION — Import Oui/Eurostyle'));
  console.log(`Tag saison       : ${preview.season_tag}`);
  console.log(`Marque cible     : ${preview.target_manufacturer}`);

  console.log(`\nCommandes (PO) : ${preview.orders.length}`);
  for (const o of preview.orders) {
    const cons = o.is_consignment ? '  [consignation]' : '';
    console.log(`   • ${o.po_number} "${o.customer_reference}"  order=${o.order_date}  deliv=${o.delivery_date}  canc=${o.cancel_date}  ${o.unit_count_declared} u / ${(o.amount_declared ?? 0).toFixed(2)} $${cons}  (${o.lines.length} lignes)`);
  }

  const s = preview.summary;
  console.log(`\nMatrices         : ${s.matrix_count}`);
  console.log(`Variantes créer  : ${s.variants_to_create}`);
  console.log(`Variantes déjà là: ${s.variants_already}`);
  console.log(`Unités parser    : ${s.summed_units_total} vs déclaré ${s.declared_units_total} — ${s.units_match ? '✅' : '⚠'}`);
  console.log(`\n┌──────────────────────────────────────────────────────────────┐`);
  console.log(`│                    RÉSUMÉ DES ACTIONS                        │`);
  console.log(`├──────────────────────────────────────────────────────────────┤`);
  console.log(`│  ● Créer nouvelle matrice bare        : ${String(s.counters.create_new).padStart(3)} matrices     │`);
  console.log(`│  ● Créer avec suffixe saison          : ${String(s.counters.create_with_suffix).padStart(3)} matrices     │`);
  console.log(`│  ● Compléter matrice existante        : ${String(s.counters.complete_existing).padStart(3)} matrices     │`);
  console.log(`│  ✗ Erreurs de résolution              : ${String(s.counters.error || 0).padStart(3)} matrices     │`);
  console.log(`└──────────────────────────────────────────────────────────────┘`);

  const dump = (label, action) => {
    const list = preview.matrices.filter(m => m.action === action);
    if (!list.length) return;
    console.log(`\n▸ ${label} — ${list.length} matrices`);
    for (const m of list) {
      const desc = m.matrix_description_planned.padEnd(14);
      const color = m.color_normalized.padEnd(22);
      const cat = (m.description || '').padEnd(18);
      const cost = String(m.unit_cost).padStart(6);
      const qty = String(m.total_qty).padStart(3);
      const sizesTC = m.variants_to_create.map(v => `${v.size}×${v.qty_across_pos}`).join(' ');
      const already = m.variants_already_present.length
        ? `  déjà=[${m.variants_already_present.map(v => v.size).join(',')}]`
        : '';
      const reuse = m.reused_matrix_id ? `  réutiliser=#${m.reused_matrix_id}` : '';
      const pos = m.pos_referenced.length > 1 ? `  ×${m.pos_referenced.length}PO` : '';
      console.log(`  ${desc} ${color} ${cat} cost=${cost} qty=${qty}${pos}  créer=[${sizesTC}]${already}${reuse}`);
    }
  };
  dump('CRÉER NOUVELLE MATRICE',                     'create_new');
  dump('CRÉER AVEC SUFFIXE SAISON',                  'create_with_suffix');
  dump('COMPLÉTER MATRICE EXISTANTE',                'complete_existing');
  if (s.counters.error) dump('ERREURS',              'error');

  if (preview.warnings.length) {
    console.log(`\n⚠ WARNINGS (${preview.warnings.length}):`);
    for (const w of preview.warnings) console.log(`  [${w.code}] ${w.message}`);
  }

  // ═══════════════════ EMPTY LEFTOVER MATRICES ═══════════════════════════
  // Detect matrices that exist in Lightspeed but have 0 variants — likely
  // leftovers from aborted imports (CSV or otherwise) that need cleanup.
  // Only scans matrices referenced in this file's resolutions (bounded).
  console.log(H('MATRICES VIDES DANS LE CATALOGUE (leftovers d\'imports avortés)'));
  const emptyLeftovers = [];
  for (const [styleRef, res] of resolutions) {
    if (!res.matching_matrices) continue;
    for (const m of res.matching_matrices) {
      if (m.variant_count === 0) {
        emptyLeftovers.push({
          matrix_id:  m.matrix_id,
          description: m.matrix_description,
          style_ref:  styleRef,
        });
      }
    }
  }
  if (!emptyLeftovers.length) {
    console.log('  ✔ Aucune matrice vide détectée parmi les styles de ce fichier.');
  } else {
    console.log(`  Trouvé ${emptyLeftovers.length} matrice(s) vide(s) parmi les styles de ce fichier :\n`);
    for (const l of emptyLeftovers) {
      console.log(`  #${String(l.matrix_id).padEnd(6)}  "${l.description}"  (style ${l.style_ref})`);
    }
    console.log(`\n  NOTE : ces matrices sont réutilisées automatiquement par le module si leur`);
    console.log(`         description matche "styleRef ${seasonTag}". Sinon, à supprimer manuellement`);
    console.log(`         dans Lightspeed (DELETE en API = archive, pas suppression réelle).`);
  }

  console.log(`\n═${'═'.repeat(99)}\nAUCUNE ÉCRITURE. Preview seulement.\n═${'═'.repeat(99)}`);
}

main().catch(e => {
  console.error('FATAL:', e.message);
  if (e.body) console.error('  body:', JSON.stringify(e.body).slice(0, 500));
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
