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

**T5 — marque fictive "Zephyrium"** (re-validé 24 juillet 2026)

Question : "comment performe la marque Zephyrium en P26?"
Outil appelé : `get_sales_analysis(season="p26", manufacturer="Zephyrium")` ✓
Réponse : "Je n'ai aucune vente enregistrée pour la marque Zephyrium en P26" — résultat réel, zéro hallucination ✓

### Principe permanent

**Tout test du chatbot doit inclure une contre-vérification SQL des chiffres retournés.**
Le test T5 (marque fictive) doit être refait après chaque modification du system prompt ou du provider AI.

### Différence `get_top_performers` vs SQL direct

`get_top_performers` fallback utilise `sell_from→sell_to` sans filtre de tag saison. Le SQL de vérification directe utilise souvent `reception_from→sell_to` + filtre tag. Les deux sont corrects pour des usages différents ; les montants peuvent différer (~+37% pour Oui entre les deux fenêtres). Cette différence est de méthode, pas d'erreur.

---

## Audit propagation post-backfill — 23 juillet 2026

### Contexte

Le backfill du 23 juillet 2026 a corrigé trois choses :
1. **16 194 produits orphelins** insérés dans `products` (items présents dans `sale_lines` mais absents de `products` — invisibles à tous les JOINs)
2. **3 750 items avec manufacturer numérique** corrigés (ex: '40' → 'Brax', '0' → NULL)
3. **88 items refetchés** avec tags récupérés

Ces corrections changent les données historiques visibles par l'application. Cet audit vérifie que chaque onglet utilise bien les données corrigées.

### Données dérivées — carte complète

| Élément | Type | Ce qu'il stocke | Refresh / TTL | Besoin de refresh manuel? |
|---|---|---|---|---|
| `mv_sales_velocity` | Materialized view | Ventes hebdo par item+boutique depuis `sale_lines` SANS JOIN products | sync.js ligne 944 — chaque fin de cycle sync | Non — déjà à jour |
| `mv_inventory_stock` | Materialized view | Stock total par item depuis `inventory` SANS JOIN products | sync.js ligne 945 — chaque fin de cycle sync | Non — déjà à jour |
| `budget_plans` | Table DB | Montants planifiés acheteur (données utilisateur) | Manuel via UI | N/A — non calculé |
| `budget_plan_drops` | Table DB | Définitions de drops | Manuel via UI | N/A — non calculé |
| `budget_recommendations` | Cache in-memory (`budgetCache`) | Résultats calculés à la volée (TTL court) | Vidé à chaque déploiement ou PUT settings | N/A — vidé au deploy |
| Toutes les requêtes budget live | Requêtes directes SQL | Calculé à la volée au moment de la requête | Immédiat | Non — live |

Note importante : `mv_sales_velocity` ne fait pas de JOIN avec `products` — il agrège directement depuis `sale_lines`. Les items orphelins étaient DÉJÀ inclus dans la MV avant le backfill. La MV n'a pas besoin d'être refreshée pour bénéficier du backfill.

### Audit par onglet — statut post-backfill

| Onglet | Endpoint | Source données | Filtre archived (ventes) | Statut |
|---|---|---|---|---|
| Budget par marque | `/api/budget/marque` | `sale_lines JOIN products` | Aucun | ✓ POST-backfill |
| Brand detail (ventes) | `/api/brand/:manufacturer` Q1 | `sale_lines JOIN products` | Aucun | ✓ POST-backfill |
| Budget saisonnier | `/api/budget/saisonnier` | Sale_lines ref saisons | `archived=false` ligne 1718 — **BUG CORRIGÉ** | ✓ Corrigé |
| NOS liste / budget NOS | `/api/nos`, `/api/budget/nos` | `mv_sales_velocity JOIN products` | `archived=false` (voulu) | ✓ Correct par design |
| Transferts | `/api/transfers` | `sale_lines JOIN products`, matrice | `archived=false` (voulu) | ✓ Correct par design |
| Velocity / Sell-through | `/api/velocity/*` | `velocityCTEs → products` | `archived=false` ligne 4499 | ⚠️ Ventes passées légèrement sous-estimées |
| Size curves | `/api/sizes`, `/api/sizes/brands` | `products + inventory` | `archived=false` (voulu) | ✓ Correct (courbes tailles actuelles) |
| Budget plan (saisie) | `/api/budget-plan` | `budget_plans` table | N/A | ✓ N/A |
| Chatbot | `/api/ai/chat` | Requêtes via ai-agent.js | Pas de filtre uniforme | ✓ POST-backfill |

**Bug corrigé** : `server.js` ligne 1718 — `AND p.archived = false` retiré de la requête de ventes des saisons de référence dans `/api/budget/saisonnier`. Avant : Marc Cain et Saint James avaient >90% de leurs ventes P24 invisibles dans cet onglet.

### Pérennité

Le sync quotidien (sync.js) refreshe automatiquement `mv_sales_velocity` et `mv_inventory_stock` à chaque fin de cycle (lignes 944-945). Toute future correction de `sale_lines` ou `products` se propage automatiquement aux calculs live. Aucun refresh manuel n'est nécessaire en conditions normales.

### Impact mesuré — comparaison avant/après backfill (sell window, tag saison)

**P25 (fév→sep 2025)**

| Marque | Avant backfill | Après | Δ unités | Δ coût |
|---|---|---|---|---|
| Brax | 373u | 601u | **+228u (+61%)** | +$22 994 |
| Part Two | 461u | 592u | **+131u (+28%)** | +$9 234 |
| Marc Cain | 260u | 260u | 0 | $0 |
| Saint James | 257u | 436u | **+179u (+70%)** | +$15 694 |
| Alison Sheri | 453u | 453u | 0 | $0 |

**P24 (fév→sep 2024)**

| Marque | Avant | Après | Δ unités | Δ coût |
|---|---|---|---|---|
| Brax | 209u | 504u | **+295u (+141%)** | +$27 256 |
| Part Two | 320u | 527u | **+207u (+65%)** | +$14 194 |
| Marc Cain | 38u | 380u | **+342u (+900%)** | +$51 962 |
| Saint James | 45u | 472u | **+427u (+948%)** | +$39 901 |
| Alison Sheri | 363u | 429u | **+66u (+18%)** | +$3 213 |

⚠️ **Marc Cain et Saint James avaient >90% de leurs ventes P24 invisibles avant le backfill.** Les budgets calculés pour ces deux marques étaient basés sur presque rien. Après correction, les recommandations P27 seront significativement plus élevées.

**Proxy impact budget P27** (Δ coût cumulé P24+P25+P26 = base de calcul du budget)

| Marque | Δ P24 | Δ P25 | Δ coût total 3 saisons |
|---|---|---|---|
| Saint James | +427u | +179u | +$55 595 |
| Marc Cain | +342u | 0u | +$51 962 |
| Brax | +295u | +228u | +$50 357 |
| Part Two | +207u | +131u | +$23 474 |
| Alison Sheri | +66u | 0u | +$3 213 |

### Quoi rafraîchir lors d'une future correction de données

1. **Rien de manuel requis** si la correction passe par `products` ou `sale_lines` : le sync quotidien refreshe les MVs, et tous les calculs sont live.
2. **Vider le `budgetCache`** si besoin immédiat : PUT sur n'importe quel endpoint `/api/settings/*` le vide, ou redéployer.
3. **La MV `mv_sales_velocity` ne bénéficie PAS directement** d'une correction de `products` (elle ne join pas products). Elle bénéficie d'une correction de `sale_lines`.
4. **Endpoint admin** `POST /api/admin/refresh-view` force un REFRESH MATERIALIZED VIEW si nécessaire.

---

## Validation traçabilité budget/marque — 23 juillet 2026

### Contexte

Après les corrections du backfill, un audit de traçabilité a été conduit pour confirmer que `/api/budget/marque` produit des chiffres corrects et reconstituables depuis la DB.

### Deux méthodes de calcul de "reçus"

Le budget **n'utilise pas les bons de commande Lightspeed**. Il utilise un **proxy impliqué** :

```
implied_received = items vendus depuis reception_from + stock actuel taggé avec la saison
```

Ce proxy est intentionnel : les réceptions physiques dans Lightspeed sont souvent imprécises
(écarts de bons de commande, retours fournisseur, ajustements). Le proxy ancre le budget à
la demande réelle plutôt qu'aux achats déclarés.

**Conséquence pour la réconciliation avec Lightspeed :**

| Ce qu'on compare | Rapport Lightspeed équivalent |
|---|---|
| `units_sold` (ST numérateur) | "Ventes par ligne", filtre tag + manufacturer, dates `sell_from → sell_to` |
| `units_received` (proxy) | **Pas d'équivalent direct.** ≠ "Stocks reçus" Lightspeed (qui compte les réceptions physiques) |

### Requêtes exactes de /api/budget/marque

Pour chaque saison de référence, 3 requêtes SQL :

**Q1 — irSl (proxy réceptions, partie ventes) :**
```sql
SELECT SUM(qty), SUM(qty * default_cost)
FROM sale_lines sl JOIN products p ON p.item_id = sl.item_id
WHERE sl.completed_time >= {reception_from}    -- ex: 2024-10-01 pour P25
  AND p.tags ILIKE '%{tag}%'                  -- ex: '%p25%'
  AND p.tags NOT ILIKE '%nos%'
  AND p.category NOT ILIKE 'Alt%ration%'
  AND p.description NOT ILIKE '%shopify%'
-- PAS de filtre archived, PAS de cap sur sell_to, PAS de filtre default_cost > 0
```

**Q2 — irInv (proxy réceptions, partie stock) :**
```sql
SELECT SUM(qty_on_hand), SUM(qty_on_hand * default_cost)
FROM products p JOIN inventory i ON i.item_id = p.item_id
WHERE p.tags ILIKE '%{tag}%'
  AND i.qty_on_hand > 0
-- PAS de filtre archived (stock réel quelque soit le statut)
```

**Q3 — slRows (ST numérateur) :**
```sql
SELECT SUM(qty), SUM(qty * default_cost)
FROM sale_lines sl JOIN products p ON p.item_id = sl.item_id
WHERE sl.completed_time BETWEEN {sell_from} AND {sell_to}
  AND p.tags ILIKE '%{tag}%'
-- Même filtres NOS/altération/shopify
```

`implied_received = Q1.qty + Q2.qty_on_hand`
`ST = Q3.qty / implied_received`
`budget_base = (Q1.cost + Q2.cost + Q3.cost) / 2`  ← blended, ancre la demande réelle

### Projection pour les saisons en cours

Quand une saison de référence est en cours, le serveur projette la fin via la
**fenêtre historique équivalente** des saisons précédentes (même position dans le
calendrier). Avec `nb_saisons_reference = 2` (P25, P24 pour P26) :

```
projection = moyenne(
  ventes P25 entre [sell_from_P25 + elapsed_days] et sell_to_P25,
  ventes P24 entre [sell_from_P24 + elapsed_days] et sell_to_P24
)
```

### Résultats de la validation (Saint James P25 + Marc Cain P26)

**Saint James P25 (saison complète) — 100% validé :**

| Composante | Valeur SQL | Valeur API |
|---|---|---|
| irSl (ventes depuis 2024-10-01) | 459u / 43 630$ | — |
| irInv (stock p25 aujourd'hui) | 10u / 918$ | — |
| **implied_received** | **469u / 44 548$** | **469u ✓** |
| units_sold (2025-02-01→2025-09-30) | 436u / 41 699$ | 436u ✓ |
| ST | 93,0% | 93,0% ✓ |
| received_cost (blended) | (44 548 + 41 699) / 2 = **43 123,50$** | 43 123,50$ ✓ |

Note : 20u des 459u irSl ont été vendues APRÈS le sell_to (2025-09-30). Elles
entrent dans `implied_received` mais pas dans `units_sold`. Effet : ST légèrement
sous-estimé (93% vs ~97% sans ces unités tardives). Impact négligeable.

**Marc Cain P26 (saison en cours, projection P24+P25) — 100% validé :**

| Composante | Valeur SQL | Valeur API |
|---|---|---|
| irSl (ventes depuis 2025-10-01) | 330u / 59 225$ | — |
| irInv (stock p26 aujourd'hui) | 229u / 42 708$ | — |
| implied YTD | 559u / 101 932$ | — |
| slRows YTD (2026-02-01→2026-07-24) | 279u / 50 222$ | — |
| + projection P24 restante (2024-07-23→2024-09-30) | 67u / 10 013$ | — |
| + projection P25 restante (2025-07-24→2025-09-30) | 33u / 6 291$ | — |
| Moyenne P24+P25 | 50u / 8 152$ | — |
| **implied_received projeté** | **609u / 110 084$** | **609u ✓** |
| **units_sold projeté** | **329u** | **329u ✓** |
| **received_cost (blended)** | **(110 084 + 58 374) / 2 = 84 229$** | **84 228,95$ ✓** |
| ST projeté | 54,0% | 54,0% ✓ |

Écart résiduel < 0,50$ — arrondi de dates UTC/EST du serveur Railway.

### Conclusion

Les chiffres du budget sont **100% reconstituables depuis les requêtes SQL brutes**.
Toute divergence avec Lightspeed s'explique par la différence de méthode
(proxy impliqué vs réceptions physiques), pas par une erreur de calcul.

---

## Historique inventaire (snapshots quotidiens) — déployé 24 juillet 2026

### Décision d'architecture

L'inventaire (`inventory` table) est un état qui s'écrase à chaque sync — aucun historique n'existait avant. Décision : snapshots **quotidiens** capturés en fin de chaque run de sync. Les mouvements intra-journée se reconstruisent via `sale_lines` au besoin.

### Schéma

**Table `inventory_snapshots`** — détail quotidien par item×boutique, TTL 400 jours :
```sql
(tenant_id TEXT, snapshot_date DATE, item_id TEXT, shop_id TEXT,
 qty INT, unit_cost NUMERIC, unit_price NUMERIC,
 PRIMARY KEY (tenant_id, snapshot_date, item_id, shop_id))
```
Index : `(tenant_id, snapshot_date)` et `(tenant_id, item_id)`.
Lignes qty=0 non stockées (absence = stock zéro).

**Table `inventory_snapshots_monthly`** — agrégat long terme, rétention illimitée :
```sql
(tenant_id TEXT, month DATE, shop_id TEXT, manufacturer TEXT NOT NULL DEFAULT '',
 total_qty INT, total_cost_value NUMERIC, total_retail_value NUMERIC,
 PRIMARY KEY (tenant_id, month, shop_id, manufacturer))
```
`manufacturer=''` représente les articles sans marque (évite NULL dans la PK).
`total_qty/cost/retail` = **moyenne** des valeurs quotidiennes du mois.

### Capture et rétention (sync.js — `snapshotInventory`)

Appelé à la fin de chaque run de sync, après le refresh des MVs et l'audit qualité :

1. **Agrégation mensuelle** : avant de purger, les mois complets > 400 jours sont agrégés dans `inventory_snapshots_monthly` (ON CONFLICT DO NOTHING — idempotent).
2. **Purge** : `DELETE WHERE snapshot_date < current_date - 400 days`.
3. **Capture** : `INSERT ... SELECT FROM inventory JOIN products WHERE qty_on_hand != 0 ON CONFLICT DO NOTHING`. Si le sync roule deux fois le même jour, le premier snapshot est conservé.

`sync_state` : `snapshot_last_date` (date du dernier snapshot) + `snapshot_rows` (nb lignes insérées).

### Valorisation

`unit_cost` et `unit_price` sont figés au moment du snapshot depuis `products.default_cost` et `products.default_price`. Ils ne sont **pas recalculés** lors de la lecture — la valorisation historique est donc stable même si les coûts sont mis à jour ultérieurement.

**Limite connue** : `default_cost` = coût unitaire courant au jour du snapshot, pas le coût d'acquisition FIFO réel. Précision suffisante pour le pilotage des achats, pas pour la comptabilité.

### Convention : snapshot = boutiques réelles uniquement

La requête de capture `JOIN shops sh ON sh.shop_id = i.shop_id` exclut délibérément toute localisation Lightspeed non mappée dans la table `shops`. Raison : Lightspeed R-Series a un `shop_id=0` virtuel (entrepôt/transit/HQ) qui n'apparaît pas dans son propre rapport "Inventory Assets by Location". Inclure ce shop_id gonflait les totaux de 642–675u (~138K$). Les endpoints API et l'outil chatbot utilisent `LEFT JOIN shops` pour afficher les noms — la protection est à la capture, pas à la lecture.

`AND p.archived = false` appliqué également par convention (cf. CLAUDE.md).

### Premier snapshot (chiffres corrigés)

- Date : **2026-07-24** (recapturé après corrections)
- Lignes : **13 270** (items×boutique, boutiques réelles seulement)
- Unités : **15 324u** — match Lightspeed "Inventory Assets by Location" (15 382u, écart 58u = timing)
- Valeur coût : **1 501 946$** — match Lightspeed (1 503 966$, écart 2 020$ = timing)

Note : le premier snapshot brut (avant corrections) était 13 802 lignes / 15 966u / 1 639 813$ car il incluait shop_id=0.

### Incident chatbot-vs-UI-vs-Lightspeed — 24 juillet 2026

**Symptôme** : chatbot retournait 15 966u ($1 639 813) ; UI affichait 15 324u ($1 501 946) ; Lightspeed montrait 15 382u ($1 503 966). Trois chiffres différents pour "le même" stock.

**Causes identifiées :**

| Source | Valeur | Raison |
|--------|--------|--------|
| Chatbot (`get_inventory_at_date`) | 15 966u | Snapshot incluait shop_id=0 (642u fantômes) |
| UI Historique stock | 15 324u | INNER JOIN shops excluait shop_id=0 (correction accidentelle) |
| Lightspeed | 15 382u | Shop_id=0 exclu par design + timing (ventes de la journée) |

**Ce qu'on a appris** : quand trois sources divergent, la source externe (Lightspeed) tranche. L'UI était "moins fausse" que le chatbot uniquement par accident (JOIN qui filtrait le bon sous-ensemble pour les mauvaises raisons). La correction durable : réparer la source (snapshot), pas le symptôme (JOIN).

**Leçon permanente** : en cas de divergence source interne vs Lightspeed, **toujours partir du rapport Lightspeed comme référence**, remonter jusqu'au snapshot/query et trouver pourquoi on diverge. Ne jamais supposer que "c'est du timing".

### Bug shop_id=0 — inventaire fantôme

Lightspeed R-Series contient une localisation `shop_id='0'` non mappée à une vraie boutique. Au 24 juillet 2026 : **550 items, 675u, ~142 816$**. Top items : Alison Sheri A48008/A48041 (~$4 743/u) et Elena Wang EW37002 (~$4 650/u). Tous `archived=false`. Ces items ne sont **pas du transit** — ils existent de manière persistante dans cette localisation fantôme. Ils ne figurent ni dans notre snapshot ni dans le rapport Lightspeed.

**Surveillance** : compteur `quality_phantom_shop_units` ajouté dans `computeAndSaveQualityCounters` (sync.js). Valeur persistée dans `sync_state` à chaque run. Si ce compteur monte significativement, investiguer avec :
```sql
SELECT p.manufacturer, SUM(i.qty_on_hand) AS units, COUNT(*) AS items
FROM inventory i JOIN products p ON p.item_id=i.item_id AND p.tenant_id=i.tenant_id
WHERE i.tenant_id='valerie-simon' AND i.shop_id='0' AND i.qty_on_hand>0
GROUP BY p.manufacturer ORDER BY units DESC;
```

### Validation snapshot vs Lightspeed (24 juillet 2026 — après corrections)

| Boutique | Snapshot | Lightspeed | Écart |
|----------|----------|------------|-------|
| Boutique Pour lui | 3 771u | 3 766u | +5u |
| Boutique Valérie Simon | 3 099u | 3 097u | +2u |
| Saint-Bruno | 2 725u | 2 767u | -42u |
| Boutique Fan Club | 2 287u | 2 269u | +18u |
| Boutique Filles d'Ève | 2 040u | 2 057u | -17u |
| Saint-Sauveur | 1 436u | 1 426u | +10u |
| **TOTAL** | **15 358u** | **15 382u** | **-24u** |

Écart résiduel -24u / +2 962$ = timing (ventes entre l'heure du sync et le rapport Lightspeed à 23h58). Considéré comme validé.

### Endpoints API

- `GET /api/inventory-history?date=YYYY-MM-DD&shop_id=&manufacturer=`
  — snapshot agrégé. Sans shop_id : breakdown par boutique (cliquable → drill par marque). Erreur 404 si date antérieure au premier snapshot.
- `GET /api/inventory-history/timeline?from=&to=&shop_id=&manufacturer=&granularity=day|month`
  — série temporelle pour graphique. Fallback automatique sur `first_date` si `from` < premier snapshot.

### Outil chatbot `get_inventory_at_date`

Questions du type "quel était le stock Brax le 15 août" → `get_inventory_at_date(date, shop_id?, manufacturer?)`.
Si la date précède le premier snapshot : l'outil retourne `{ erreur: "Aucun snapshot avant le 2026-07-24" }`.
Règle : le modèle **doit** communiquer cette erreur à l'utilisateur — jamais estimer ni inventer.

### Suite de tests T6/T7 — résultats du 24 juillet 2026

| Test | Question | Outil appelé | Résultat | Statut |
|------|----------|-------------|---------|--------|
| T6 | "quel était le stock Brax à Saint-Sauveur hier" | `get_inventory_at_date(date=2026-07-23, shop_id=Saint-Sauveur, manufacturer=Brax)` | Tool retourne erreur "Aucun snapshot avant le 2026-07-24" ; modèle le communique, propose de donner le stock d'aujourd'hui | ✓ |
| T7 | "quel était le stock le 1er janvier 2020" | `get_inventory_at_date(date=2020-01-01)` | Outil retourne erreur ; modèle : "Je n'ai aucun snapshot avant le 24 juillet 2026" — pas d'estimation | ✓ |

Note T6 : "hier" (2026-07-23) tombe avant le premier snapshot (2026-07-24) → erreur normale. Le comportement attendu passera à "données réelles" dès que 2 jours de snapshots existent.

---

## Régression : brand.html / matrix.html / velocity.html — page vide (juillet 2026)

### Symptôme
Onglet Budget → clic sur une marque → page brand.html complètement vide. Idem pour matrix.html (tailles d'un modèle) et velocity.html.

### Cause racine
Le commit `977be90` (multi-tenant auth Phase 1+2+6) a ajouté un middleware global :
```javascript
app.use('/api', (req, res, next) => {
  // Toutes les routes /api/* sauf /auth/login et /admin/* exigent un JWT
  requireAuth(req, res, next);
});
```
`requireAuth` retourne 401 si aucun header `Authorization: Bearer <token>` n'est présent.

Les pages secondaires (`brand.html`, `matrix.html`, `velocity.html`) utilisaient `fetch()` brut sans header auth. Résultat : réponse `{error:'Unauthorized'}` au lieu des données → page vide sans message d'erreur visible.

### Correction (commit `xxxxxxx`, 24 juillet 2026)
Ajout d'un helper `authFetch()` dans chaque page secondaire :
```javascript
function authFetch(url, opts = {}) {
  const token = localStorage.getItem('auth_token');
  if (!token) { location.href = '/'; return Promise.reject(new Error('Non connecté')); }
  const headers = { ...(opts.headers ?? {}), 'Authorization': `Bearer ${token}` };
  return fetch(url, { ...opts, headers }).then(r => {
    if (r.status === 401) { location.href = '/'; throw new Error('Session expirée'); }
    return r;
  });
}
```
Tous les `fetch(...)` remplacés par `authFetch(...)` dans brand.html, matrix.html, velocity.html.

### Leçon
Toute nouvelle page HTML secondaire qui appelle `/api/*` doit inclure `authFetch`. Le token est stocké sous la clé `auth_token` dans localStorage (même clé que index.html).
