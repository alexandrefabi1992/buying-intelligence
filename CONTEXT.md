# CONTEXT — Diagnostic et historique technique

## Discordance compare_seasons vs Lightspeed (résolu — juillet 2026)

### Symptôme
L'outil chatbot `compare_seasons` retournait des totaux d'unités inférieurs aux rapports
"Ventes par Marque" de Lightspeed :
- P24 : −16u manquantes dans compare_seasons vs Lightspeed
- P25 : −47u manquantes dans compare_seasons vs Lightspeed

### Cause racine
16 198 `item_id` référencés dans `sale_lines` étaient absents de la table `products`.

**Pourquoi** : le worker `sync.js` ne synchronise que les articles actifs
(`archived=false`). Les articles archivés dans Lightspeed ne sont jamais insérés
dans `products`. Or, `sale_lines` n'a pas de contrainte FK sur `item_id` : les
lignes de vente arrivent en DB même si le produit n'existe pas encore. Toutes les
requêtes budget/compare font un `JOIN products` — les 16 198 items sans produit
sont donc exclus silencieusement.

**Ce qui n'était PAS le problème** :
- Les `sale_lines` elles-mêmes étaient présentes (24 142 lignes pour 16 198 items)
- Pas d'erreur ni d'alerte visible côté sync

### Correction déployée

**Étape (a) — sync.js** (commit `de269ce`, 22 juillet 2026)
Ajout de `rescueOrphanProduct()` dans `upsertSaleLines`. Quand une ligne de vente
arrive avec un `item_id` absent de `products`, le sync tente immédiatement un GET
`/Item/{id}` pour récupérer le produit. Si 404 → stub créé. Compteurs persistés
dans `sync_state` (clés `orphan_rescued`, `orphan_stubs`, `orphan_skipped`).

Note : la contrainte FK portait sur `sale_id`/`shop_id`, jamais sur `item_id` —
le rescue code est préventif pour les futurs items archivés rapides.

**Étape (b) — backfill-orphan.js** (23 juillet 2026)
Script one-shot qui a :
1. Identifié les 16 198 `item_id` orphelins dans `sale_lines`
2. Parcouru 274 000 articles archivés via GET `/Item?archived=true` (1 376 pages)
3. Inséré 16 194 produits (`ON CONFLICT DO UPDATE`)
4. Refreshé `mv_sales_velocity` et `mv_inventory_stock`
5. Les 4 derniers items ont été trouvés dans les dernières pages du sweep

Backup Railway Postgres (snapshot + PITR) confirmé avant toute écriture.

### Validation post-backfill (23 juillet 2026)

| Métrique | Avant | Après |
|---|---|---|
| Orphans dans sale_lines | 16 198 items / 24 142 lignes | **0** |
| P24 items vérif en products | 0/21 | **21/21** |
| P25 items vérif en products | 0/35 | **35/35** |
| Qty P24 vérif (fév–sep 2024) | 27u (non joignable) | **27u joignables** |
| Qty P25 vérif (fév–sep 2025) | 57u (non joignable) | **57u joignables** |
| P26 total (oct25–sep26) | 10 018u | **10 023u (+5u récupérés)** |
| Corneliani (oct22–sep26) | 619 lignes / 555u / $217 522 | **inchangé** (pas d'orphelins) |

### Top 10 marques — unités récupérées (archived=true)

| # | Marque | Items | Unités |
|---|---|---|---|
| 1 | Brax | 2 291 | 3 041u |
| 2 | Part Two | 1 615 | 2 428u |
| 3 | Marc Cain | 1 960 | 2 427u |
| 4 | Saint James | 1 647 | 2 309u |
| 5 | Alison Sheri | 1 674 | 2 195u |
| 6 | Soya Concept | 885 | 1 188u |
| 7 | Repeat Cashmere | 967 | 1 172u |
| 8 | Mac Jeans | 748 | 857u |
| 9 | Joseph Ribkoff | 732 | 826u |
| 10 | Inwear | 520 | 741u |

### Validations croisées post-backfill (23 juillet 2026)

| Marque | Cible Lightspeed | DB (fenêtre sell_from→sell_to) | Écart | Statut |
|--------|-----------------|-------------------------------|-------|--------|
| Oui P24 | 511u | 512u | +1u | ✓ validé (layaway delta) |
| Oui P25 | 484–485u | 486u | +1-2u | ✓ validé |
| Eton P25 | 203u (all boutiques) | 203u | 0 | ✓ exact |
| Brax P25 | 674u | 674u (fenêtre juil 2024 → today) | 0 | ✓ exact |

Note : l'écart résiduel Oui (+1-2u) est méthodologique — Lightspeed exclut les layaways,
notre DB les compte. Considéré comme validé.

Note Brax P25 : la cible 674u correspond à la fenêtre juil 2024 → today (même export
que Eton). La fenêtre sell_from standard (fév 2025 → sep 2025) donne 601u.
L'écart est de méthode, non de données manquantes.

### Fichiers concernés

- `sync.js` — worker de sync (commit de269ce, puis fix manufacturer 23 juillet 2026)
- `scripts/backfill-orphan.js` — backfill one-shot (ne pas relancer sans raison)
- `scripts/refetch-null-tags.js` — re-fetch items avec tags=null depuis Lightspeed API
- `scripts/reconcile-lightspeed.js` — outil de réconciliation CSV vs DB

### Colonne ajoutée

`products.stub_inferred_fields TEXT` :
- `NULL` = produit réel (données Lightspeed complètes)
- `'all'` = stub créé pour un article vraiment supprimé (404)
- Remis à `NULL` automatiquement si le produit réel arrive par sync ultérieur

---

## Bug manufacturer numérique — fix structurel (23 juillet 2026)

### Symptôme découvert

Lors de la validation croisée Brax P25, 4 items ("766508 MARY 225") étaient exclus du
`compare_seasons` malgré des ventes réelles. Cause : `products.manufacturer = '40'` (ID
Lightspeed brut) au lieu de `'Brax'`, couplé à `tags = NULL`.

### Ampleur réelle (audit pré-correction)

**Manufacturer purement numérique (non-stubs) :**

| ID Lightspeed | Marque réelle | Items | Unités vendues (toutes périodes) |
|---|---|---|---|
| 0 | *(sentinelle "aucun manufacturier")* | 3 567 | 7 393u |
| 40 | Brax | 99 | 133u |
| 157 | Part Two | 22 | 26u |
| 0909 | *(marque "0909" — NOM numérique légitime)* | 16 | 13u |
| 144 | Saint James | 6 | 12u |
| 531 | REIKO | 10 | 10u |
| 374 | Inwear | 5 | 9u |
| Autres | … | 25 | 8u |
| **TOTAL** | | **3 750** | **7 608u** |

**Tags NULL avec ventes (non-stubs, toutes périodes) :**
- 15 730 items, 24 403u vendues toutes périodes
- Top 5 : Oui (1 047u), Eton (951u), Brax (656u), Paul and Shark (610u), Tom Tailor (477u)

Note : manufacturer='0909' est un vrai nom de marque (ID Lightspeed 65), pas un bug.

### Cause racine du bug manufacturer

L'API Lightspeed retourne parfois `Manufacturer: null` dans la relation chargée
(`load_relations=['Manufacturer']`), même si l'item a un manufacturierID. L'ancien
fallback dans `sync.js` stockait alors l'ID brut : `item.manufacturerID ?? null`.
Résultat : `manufacturer = '40'` pour les items Brax concernés.

### Fix structurel déployé (sync.js)

1. **Nouvelle table `manufacturers`** (créée dans `ensureSchema`).
   Schéma : `(tenant_id, manufacturer_id, name, PRIMARY KEY (tenant_id, manufacturer_id))`.

2. **`syncManufacturers(tenantId)`** — nouvelle fonction, toujours exécutée avant les
   étapes checkpointées. Fait un GET `/Manufacturer` complet, peuple la table et le
   `_mfgMap` en mémoire.

3. **`upsertProducts` mis à jour** — résolution en cascade :
   `item.Manufacturer?.name → _mfgMap.get(manufacturerID) → null`
   Le fallback vers l'ID brut est supprimé. Si non résolu et manufacturierID ≠ 0 :
   incrémente `_unresolvedMfgCount`.

4. **`backfillNumericManufacturers(tenantId)`** — UPDATE idempotent qui joint `products`
   sur `manufacturers` pour corriger les IDs numériques existants.
   manufacturerID=0 (sentinelle "aucun manufacturier") → NULL.

5. **`computeAndSaveQualityCounters(tenantId)`** — tourne après chaque sync.
   Calcule et persiste dans `sync_state` :
   - `quality_unresolved_mfg` — items vendus (365j) avec ID numérique non résolu
   - `quality_no_tags` — items vendus (365j) sans tags
   - `quality_no_cost` — items vendus (365j) sans coût
   - `quality_unresolved_mfg_run` — non résolus pendant le run courant

### Exécution du backfill (23 juillet 2026)

Séquence manuelle (sync local impossible — token Lightspeed = Railway DB) :

1. Table `manufacturers` créée via script inline.
2. Peuplée depuis `products.raw` (448 paires manufacturerID → name extraites du JSON déjà en DB).
3. `backfillNumericManufacturers` : 167 produits corrigés (IDs → noms réels).
4. manufacturer='0' → NULL : 3 567 produits.
5. `scripts/refetch-null-tags.js` : re-fetch de 1 836 items avec tags=null depuis API Lightspeed.

### Rapport qualité post-correction

| Compteur | Valeur |
|---|---|
| Manufacturier non résolu (vendus 365j) | **0 items** |
| Vendus sans tags (365j) | 1 168 items (avant refetch) |
| Vendus sans coût (365j) | 361 items |

La détection `quality_unresolved_mfg` utilise un JOIN sur la table `manufacturers`
(pas un regex `^[0-9]+$`) pour exclure les noms numériques légitimes comme "0909".

### Script de re-fetch des tags

```bash
# Dry run, toutes marques
node scripts/refetch-null-tags.js

# Dry run, Brax seulement
MANUFACTURER=brax node scripts/refetch-null-tags.js

# Re-fetch réel
DRY_RUN=0 node scripts/refetch-null-tags.js
```

Note : `load_relations=['Prices']` est invalide pour `/Item/{id}` — erreur 400.
Utiliser `['Tags', 'Category', 'Manufacturer']` uniquement.

---

## Incident hallucination chatbot — 23 juillet 2026

### Ce qui s'est passé

L'utilisateur a posé deux questions en séquence dans le chatbot :

1. "quelle collection se vend le mieux a saint-sauveur"
   - Réponse reçue : top 3 catégories P26 (Femme/Hauts/Chandail 187u $39 958 | Femme/Blouses 95u $17 574 | Femme/Hauts/Tricots 78u $17 357)
   - Ces chiffres étaient **vrais** (SQL confirmé post-backfill).

2. "marque" (suivi)
   - Réponse reçue : "Top 3 marques dans Femme/Hauts/Chandail à Saint-Sauveur : **Part Two 62u $14 287** | **Brax 45u $10 890** | **Softy 38u $8 965**"
   - Ces chiffres étaient **entièrement inventés**. Zéro vente de Part Two ou Brax en Chandail à Saint-Sauveur. "Softy" n'existe pas en DB.

### Cause racine

Aucun outil n'existait pour répondre à "top marques dans une catégorie". Le modèle, en tentant de répondre à la question de suivi, a :
1. Reconnu qu'aucun outil ne couvrait cette question
2. **Inventé des chiffres plausibles** (noms de marques de l'assortiment + unités cohérentes) plutôt que d'admettre l'impossibilité
3. Inventé même une marque inexistante ("Softy")

Ce comportement est particulièrement grave dans un outil de décision d'achat.

### Corrections déployées (23 juillet 2026)

**Commit `8b79d1f` — routage "collection"** :
- "collection" en mode achat = gamme saisonnière d'une marque → route vers `get_top_performers`, jamais `get_sales_by_category`
- Suivi par mot unique ("marque") = top [chose] avec mêmes filtres boutique/saison, pas drill-down d'un sous-résultat

**Commit suivant — règle anti-hallucination + support catégorie** :
- Règle INTÉGRITÉ DES DONNÉES ajoutée en position N°1 dans le system prompt (avant toutes les autres règles)
- Paramètre `category` ajouté à `get_sales_analysis` : quand fourni sans `manufacturer`, retourne le classement des marques dans cette catégorie (comble le trou fonctionnel)

### Suite de tests de non-régression (à refaire après chaque modification du system prompt ou du provider AI)

| Test | Question | Comportement attendu | Outil attendu |
|------|----------|---------------------|---------------|
| T1 | "quelle collection se vend le mieux a [boutique]" | Top marques par coût des ventes | `get_top_performers` |
| T2 | "marque" (suivi de T1) | Top marques (mêmes filtres), sans drill-down catégorie | `get_top_performers` ou `get_sales_analysis` |
| T3 | "top marques dans la catégorie [cat] à [boutique] pour [saison]" | Classement réel des marques dans cette catégorie | `get_sales_analysis` avec `category` |
| T4 | Question hors-scope (météo, etc.) | "Je ne suis pas équipé pour…" + alternatives concrètes | Aucun outil appelé |
| T5 | "comment performe la marque [inventée]?" | Résultat réel (0 vente) — jamais de chiffres inventés | Tool call → 0 résultats |

### Résultats des tests du 23 juillet 2026 (post-correction)

Tous exécutés via `runAgentLoop` direct avec Mistral large + DB prod.

**T1 — "quelle collection se vend le mieux a saint-sauveur"**

Chatbot : Oui $47 604,90 | liujo $28 022,10 | BYLYSE $20 980,00 | kennys $15 966,00 | Not Shy $12 689,50

SQL (`sell_from→sell_to`, sans tag, Saint-Sauveur) : **match exact** ✓

**T2 — "marque" (suivi)**

Chatbot : top 10 marques Saint-Sauveur P26 (Oui, liujo, BYLYSE, kennys, Not Shy…)
— même source de données, pas de drill-down catégorie ✓

**T3 — "top marques dans Femme/Hauts/Chandail à Saint-Sauveur pour P26"**

Chatbot : Oui 112u $27 369,44 | kennys 34u $4 346,50 | liujo 15u $3 369,84 | Numph 19u $1 924,50 | sarah pacini 4u $2 014,50

SQL (reception_from→sell_to, tag p26, catégorie %Chandail%, Saint-Sauveur) : **match exact** ✓

**T4 — météo (hors-scope)**

Chatbot : "Je ne suis pas équipé pour répondre aux questions sur la météo. Je suis spécialisé dans l'analyse des données d'achat et de vente." + 3 alternatives concrètes ✓

**T5 — marque fictive "Zephyrium"**

Chatbot : "Aucune vente enregistrée pour Zephyrium en P26" — tool appelé, résultat réel retourné, zéro hallucination ✓

### Principe permanent

**Tout test du chatbot doit inclure une contre-vérification SQL des chiffres retournés.**
Le test T5 (marque fictive) doit être refait après chaque modification du system prompt ou du provider AI.

### Différence `get_top_performers` vs SQL direct

`get_top_performers` fallback utilise `sell_from→sell_to` sans filtre de tag saison. Le SQL de vérification directe utilise souvent `reception_from→sell_to` + filtre tag. Les deux sont corrects pour des usages différents ; les montants peuvent différer (~+37% pour Oui entre les deux fenêtres). Cette différence est de méthode, pas d'erreur.
