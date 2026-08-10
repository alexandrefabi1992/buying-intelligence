# Golden files — PO ingestion regression suite

## What this is

The LLM prompt in `lib/llm-extractor.js` carries per-supplier extraction
rules for ~12 fournisseurs. Every prompt tweak (add a rule for supplier A,
tighten a size regex, reword an example) risks silently breaking a case
that used to work. This directory freezes the raw text fed to the LLM plus
the resulting `preview_json` for each supplier we've validated by hand, so
those regressions surface immediately.

Each subdirectory `<supplier>/` contains:

- `raw_text.txt` — the padded text saved during LLM extraction (exact input
  the model saw). For `oui/` this file is a placeholder (recipe path skips
  the LLM entirely and never persists raw text).
- `expected_preview.json` — the cached `preview_json` returned by
  `GET /api/import/files/:id/preview`, enriched with post-processing
  (buildPreview, style-resolver, color translations, etc.).
- `meta.json` — file_id, source filename, brand, saison, shop, extraction
  source, timestamps and a short note explaining any known caveats for
  this specific golden.

## Running the tests

Fast, no LLM cost (default). Fetches each file's live preview from prod
and compares summary fields + runs the per-supplier assertion:

```bash
node scripts/run-golden-tests.js
```

Filter to a subset:

```bash
node scripts/run-golden-tests.js --only=meyer,brax-pl
```

Full LLM re-extraction (each supplier consumes ~$0.02 of Mistral credit).
Requires the original PDFs on disk — point the runner at their directory:

```bash
node scripts/run-golden-tests.js --live --pdf-dir=/path/to/pdfs
# or set once:
export GOLDEN_PDF_DIR=/path/to/pdfs
node scripts/run-golden-tests.js --live
```

Live mode calls `lib/llm-extractor.extractPdfWithLlm` (real prompt, real
Mistral) then re-runs `lib/preview-generator.buildPreview` locally with an
empty resolutions map. Cross-PO reuse assertions (Brax VS) can't run in
live mode because there's no DB context — use diff mode for those.

## Diff-mode failure ≠ live-mode failure

- **Diff mode** catches changes in `preview-generator`, `style-resolver`,
  color translations, `buildPreview`, and any server-side post-processing.
- **Live mode** additionally catches changes in the LLM prompt itself,
  provider drift (Mistral model updates), and size-hint detection in
  `extractExpectedSizes`.

## Adding a new golden

1. Upload the PDF via the operator UI. Wait until preview completes (or push).
2. Find the `file_id` in `GET /api/import/files`.
3. Run:
   ```bash
   node scripts/export-golden.js <slug> <file_id>
   ```
   where `<slug>` is a short lowercase identifier for the supplier
   (`marc-cain`, `bugatchi`, etc.). Known slugs get a supplier-specific
   note pre-filled in `meta.json`; unknown slugs get a `TODO` placeholder
   to edit before committing.
4. Add a supplier-specific assertion to `scripts/run-golden-tests.js` in
   the `ASSERTIONS` map. Keep it minimal — one invariant that would break
   if the prompt regressed for that supplier.
5. Run `node scripts/run-golden-tests.js` and confirm PASS for the new slug.
6. Commit the three files under `tests/golden/<slug>/` plus the
   `ASSERTIONS` entry.

## Refreshing an existing golden

If a prompt/pipeline change is intentional and should update the frozen
values, just re-run the export script — it overwrites in place:

```bash
node scripts/export-golden.js meyer 30
```

Commit the diff. If assertions need updating too, update them at the same
time so the two moves stay coupled.

## Assertions ciblées actuelles (12 goldens)

| Slug              | Ce qui est verrouillé |
|-------------------|-----------------------|
| `oui`             | `summed_cost_total === declared_amount_total` (recipe path déterministe) |
| `fradi`           | Chaque matrix a ≥1 variante (jamais `variants=[]`) — accessoires en OS |
| `liu-jo`          | Structure intacte (`units_match=true`) — golden PRE-fix taille numérique, pas ré-testable |
| `numph`           | Structure intacte — golden PRE-fix prepacks (commit 40eb0bd), assertion prepacks non ajoutable |
| `marcoliani`      | `units_match=true` malgré `retail_price=null` (calculé via multiplicateur) |
| `brax-pl`         | `summary.incomplete === false` post-fixes 5287525 + b25965e + 7b17ef8 |
| `brax-vs`         | Matrix `73214 BOZEN` a `action='complete_existing'` + `reused_matrix_id` non-null (verrouille style-resolver cross-PO) |
| `meyer`           | Aucun `style_ref` ne contient `/`, chaque matrix a `color_normalized` non-null |
| `marc-cain`       | Aucun `style_ref` ne commence par `N ` ou contient `/N`, aucun `variants[].size` ne commence par `N` (protège contre un column-shift de la colonne préfixe `N`) |
| `patrick-assaraf` | Chaque `style_ref` composé est proprement concaténé (pas d'espaces consécutifs, pas de `--`, pas de `-` en début/fin) |
| `bugatchi`        | Aucun `variants[].size === 'ONE'` (normalisation `ONE→OS` obligatoire) et chaque matrix a `unit_cost > 0` |
| `dph`             | Chaque matrix a `color_normalized` non-null/non-vide ; si une matrix PAULA est présente, au moins une variante `size='OS'` et aucune `size='T0'` |

## Notes par golden

- **oui** — Fichier `raw_text.txt` quasi vide : la recette Oui court-circuite
  le LLM et ne persiste pas de texte brut. Assertion sur summary suffit.
- **liu-jo** — Golden capturé AVANT les fixes taille numérique. Une
  re-extraction pourrait diverger et c'est attendu — refresh le golden si
  la re-extraction est intentionnelle.
- **numph** — Même chose, golden PRE-fix commit 40eb0bd. `summed_units=194`
  alors que `declared=189` (5 unités de trop dues aux prepacks mal comptés).
- **brax-vs** — Golden capturé avec `summary.incomplete=true`
  (code `size_mismatch_suspected`). C'est un état connu que les fixes de la
  soirée n'ont pas totalement résolu — voir `incomplete_at_capture` dans
  `meta.json`. À re-évaluer si un futur fix cible cet edge case.
- **meyer** — Golden reflète l'état post-fixes format Meyer (commits e49fdbc
  + 50f785b) : `style_ref` épuré, `color_label = color_code` en fallback,
  `description = 'BONN'/'ROMA'/'DUBLIN'` extrait du nom modèle.
- **marc-cain** — PDF avec colonne préfixe `N` immédiatement à gauche des
  colonnes de tailles (T0/T1/T2/T3). Historique : le validator
  `max_size_mismatch_ratio` avait déjà attrapé un column-shift ici. PAULA
  (dress) est bien mappé en size=OS. NEPSY sort en tailles numériques
  80/85/90 (bustiers) — comportement attendu.
- **patrick-assaraf** — Chemises/manteaux. Tous les style_ref sont des
  codes atomiques (CM000012U, GA000192U…) — pas de composition base+modifier
  sur ce PO, mais l'assertion protège contre une future régression du
  concaténateur. Deux matrices sortent avec `description=null` (le champ
  n'est pas obligatoire côté LLM).
- **bugatchi** — Ce PDF déclenche la recette `bugatchi-socks` (pas le LLM).
  BUG CONNU : la recette n'applique PAS la normalisation `ONE→OS` (celle-ci
  ne vit que dans le prompt LLM). Résultat : l'assertion bugatchi échoue —
  c'est voulu, elle signale qu'un post-processing devrait normaliser en
  sortie de recette aussi. À corriger côté pipeline (probablement dans
  `preview-generator` ou dans `generic-recipe`).
- **dph** — Golden extrait AVEC les fixes DPH commit 7bbe198 (header
  T0/T1/T2/T3 ABOVE row prioritaire). Sur ce PO, les tailles sortent en
  N1..N6 (convention DPH). PAULA n'est pas dans ce PO (c'est en fait un
  produit Marc Cain). L'assertion PAULA est skip-si-absent.
