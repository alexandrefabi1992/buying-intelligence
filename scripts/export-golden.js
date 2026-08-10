#!/usr/bin/env node
'use strict';

/*
 * export-golden.js
 * ----------------
 * Usage: node scripts/export-golden.js <supplier-key> <file_id>
 *
 * Fetches the cached preview_json + raw_text of an already-uploaded PO
 * from the production API and freezes them under tests/golden/<supplier>/.
 *
 * The generated triplet (raw_text.txt, expected_preview.json, meta.json) is
 * the canonical "golden" that run-golden-tests.js compares against. Re-run
 * this script whenever a golden needs to be refreshed after an intentional
 * prompt/pipeline change.
 *
 * Auth: reads /tmp/diag-token.txt, or regenerates a superadmin JWT using
 * JWT_SECRET (env or the historical dev fallback). Prints the 3 written
 * paths on stdout.
 */

const fs   = require('fs');
const path = require('path');

const BASE  = process.env.GOLDEN_API_BASE
  || 'https://buying-intelligence-production.up.railway.app';
const TOKEN_PATH = '/tmp/diag-token.txt';
const ROOT       = path.resolve(__dirname, '..');
const GOLDEN_DIR = path.join(ROOT, 'tests', 'golden');

// Supplier keys → notes to embed in meta.json. Unknown keys get a TODO note
// so the operator remembers to fill it in before committing.
const SUPPLIER_NOTES = {
  'oui':        'Recette déterministe, gold historique — extractor path=\'recipe\'',
  'fradi':      'Accessoires (chapeaux, écharpes) doivent avoir variante OS avec qty=total_qty du \'Cmdé\', vérifié post-fix',
  'liu-jo':     'Fix taille numérique (commits 5287525, b25965e, 7b17ef8) appliqué au prompt post-hoc — ce golden reflète le preview_json cached AVANT ces fixes. Non re-testé rétroactivement car file en status=\'pushed\' immuable. Une future re-extraction pourrait différer et c\'est ATTENDU. Fix taille numérique appliqué post-hoc, non re-testé rétroactivement.',
  'numph':      'Prepacks (Nuluca Socks Prepack 6 Multi) — fix appliqué au prompt post-extraction (commit 40eb0bd). Ce golden reflète l\'état PRE-fix (units summed=194 alors que declared=189, différence de 5 dûe aux prepacks mal comptés).',
  'marcoliani': 'PDF sans retail_price — comptable via multiplicateur retail. Accessoires (chaussettes) devraient router à attribute_set 7 (single-attr couleur) au push.',
  'brax-pl':    'PDF Brax avec size header inline (même ligne que style_ref) — nécessite fix validator 5287525. LLM extrait fidèlement le compound style_ref \'76724 CHUCK 34\' (inseam inclus, voulu — distingue SKUs Brax).',
  'brax-vs':    'Doit réutiliser les matrices 73214 BOZEN et 803650CHUCK 34 déjà créées par le push de Brax PL — action=\'complete_existing\' avec reused_matrix_id sur ces 2 rows.',
  'meyer':      'Re-extrait avec les fixes format Meyer (commits e49fdbc + 50f785b) : style_ref épuré (2-3615, pas 2-3615/19), color_label = color_code (fallback numérique), description = \'BONN\'/\'ROMA\'/\'DUBLIN\' extrait du nom modèle.',
  'marc-cain':       'Format Marc Cain avec colonne `N` (préfixe article) — vérifier qu\'aucune variant.size ne commence par \'N\', et que style_ref est bien épuré. Note : PAULA (size=OS) est dans ce PDF Marc Cain, pas DPH.',
  'patrick-assaraf': 'Style ref composé (base + modifier) — vérifier que les composants sont bien concaténés sans séparateur parasite. Sur ce PO, tous les style_ref sont des codes atomiques (CM000012U, GA000192U…). Deux matrices sortent avec description=null — pas bloquant.',
  'bugatchi':        'Bugatchi chaussettes OS — les tailles \'ONE\' doivent être normalisées en \'OS\' au push. Uniquement des accessoires (chaussettes) → routing vers attribute_set 7 attendu au push. BUG CONNU : ce PO passe par la recette bugatchi-socks (pas le LLM), et la recette ne normalise PAS ONE→OS (seule la règle du prompt LLM le fait). L\'assertion échoue expressément pour signaler qu\'une normalisation post-recipe est manquante côté pipeline.',
  'dph':             'Extrait AVEC les fixes DPH commit 7bbe198 (header T0/T1/T2/T3 ABOVE row prioritaire). Sur ce PO les tailles sortent normalisées en N1..N6 (convention DPH). Aucune matrice PAULA sur ce PO (PAULA est en fait chez Marc Cain). L\'assertion PAULA est skip-si-absent : elle vérifie uniquement color_normalized non-null par matrice.',
};

function loadToken() {
  try {
    const t = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
    if (t) return t;
  } catch (_) {}
  const jwt = require(path.join(ROOT, 'node_modules', 'jsonwebtoken'));
  const secret = process.env.JWT_SECRET
    || '9607dd7cac5d2f4f6ace760668ee90d853ff3b4bac5c26cc4ad1a3e722eaa0aa';
  const fresh = jwt.sign(
    { tenantId: 'valerie-simon', userId: 'diag', role: 'superadmin' },
    secret,
  );
  try { fs.writeFileSync(TOKEN_PATH, fresh); } catch (_) {}
  return fresh;
}

async function apiGet(pathname, { asText = false, retries = 3 } = {}) {
  const token = loadToken();
  const url   = `${BASE}${pathname}`;
  let last;
  for (let i = 1; i <= retries; i++) {
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 502) { last = new Error('HTTP 502'); await sleep(2000); continue; }
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`GET ${pathname} → HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      return asText ? await res.text() : await res.json();
    } catch (e) {
      last = e;
      if (i < retries) await sleep(2000);
    }
  }
  throw last;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const [supplierKey, fileIdArg] = process.argv.slice(2);
  if (!supplierKey || !fileIdArg) {
    console.error('Usage: node scripts/export-golden.js <supplier-key> <file_id>');
    process.exit(2);
  }
  const fileId = Number(fileIdArg);
  if (!Number.isFinite(fileId)) {
    console.error(`Invalid file_id: ${fileIdArg}`);
    process.exit(2);
  }

  const outDir = path.join(GOLDEN_DIR, supplierKey);
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`[export] fetching file_id=${fileId} for supplier=${supplierKey}`);

  const filesList = await apiGet('/api/import/files');
  const fileMeta  = (filesList.files || []).find((f) => Number(f.file_id) === fileId);
  if (!fileMeta) {
    console.error(`file_id ${fileId} not present in /api/import/files response`);
    process.exit(3);
  }

  const preview = await apiGet(`/api/import/files/${fileId}/preview`);
  const rawText = await apiGet(`/api/import/files/${fileId}/raw-text`, { asText: true });

  const rawPath      = path.join(outDir, 'raw_text.txt');
  const previewPath  = path.join(outDir, 'expected_preview.json');
  const metaPath     = path.join(outDir, 'meta.json');

  const note = SUPPLIER_NOTES[supplierKey] || 'TODO: ajouter note par fournisseur';

  const meta = {
    file_id:             fileId,
    source_filename:     fileMeta.source_filename,
    manufacturer:        preview.target_manufacturer
                          || fileMeta.target_manufacturer
                          || null,
    season_tag:          preview.season_tag || fileMeta.season_tag || null,
    destination_shop_id: fileMeta.destination_shop_id || null,
    extraction_source:   preview.extraction_source || null,
    extracted_at:        preview.preview_computed_at || fileMeta.uploaded_at || null,
    captured_at:         new Date().toISOString(),
    notes:               note,
  };

  // For Brax VS specifically we must record whether the size-mismatch
  // heuristic is still tripping — the operator uses this to decide whether
  // to re-extract with a tightened prompt before treating the golden as OK.
  if (supplierKey === 'brax-vs') {
    const inc = !!preview.summary?.incomplete;
    meta.incomplete_at_capture = inc;
    if (inc) {
      meta.notes += ` ATTENTION : summary.incomplete=true au moment de la capture (code(s): ${
        (preview.summary?.incomplete_reasons || []).map((r) => r.code).join(', ') || 'n/a'
      }). Le golden fige cet état — les fixes size_mismatch de la soirée n'ont pas résolu tous les cas.`;
    }
  }

  fs.writeFileSync(rawPath, rawText || '');
  fs.writeFileSync(previewPath, JSON.stringify(preview, null, 2));
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  console.log(`  wrote ${rawPath}`);
  console.log(`  wrote ${previewPath}`);
  console.log(`  wrote ${metaPath}`);
}

main().catch((e) => {
  console.error(`[export] fatal: ${e.message}`);
  process.exit(1);
});
