# Buying Intelligence — Contexte projet pour Claude Code

## C'est quoi ce projet ?

Système d'aide à l'achat connecté à Lightspeed R-Series. Il analyse les ventes historiques par marque et par boutique pour générer des budgets d'achat saisonniers. Interface web vanilla JS, backend Node/Express, base PostgreSQL sur Railway.

## Comment démarrer le serveur localement

```bash
cd ~/Documents/buying-intelligence
railway run node server.js
```

Railway CLI injecte automatiquement toutes les variables d'environnement (DATABASE_URL, tokens Lightspeed). Il n'y a pas de fichier `.env` local — les credentials sont sur Railway.

## Architecture

```
sync.js ──► Lightspeed API ──► PostgreSQL (Railway) ──► server.js ──► REST API ──► index.html
```

- `server.js` — tout le backend (API Express + logique métier)
- `public/index.html` — tout le frontend (vanilla JS, Tailwind CDN, pas de framework)
- `sync.js` — worker de synchronisation Lightspeed (cron, lancer séparément)
- `schema.sql` — schéma initial PostgreSQL

## Base de données

PostgreSQL sur Railway. Tables principales :
- `products` — articles Lightspeed (item_id, manufacturer, tags, default_cost, archived, category, description)
- `sale_lines` — lignes de vente (item_id, shop_id, qty, completed_time)
- `inventory` — stock par boutique (item_id, shop_id, qty_on_hand)
- `shops` — boutiques (shop_id, name)
- `app_settings` — paramètres persistés (key TEXT PRIMARY KEY, value JSONB)

## Paramètres configurables (app_settings)

### `multiplier_tiers`
Paliers de TM (taux de mise) qui déterminent le multiplicateur budgétaire :
- ST ≥ 80% → ×1.25 (Augmenter)
- ST ≥ 65% → ×1.10 (Légère hausse)
- ST ≥ 50% → ×1.00 (Reconduire)
- ST ≥ 35% → ×0.80 (Réduire)
- ST < 35% → ×0.50 (Couper)

### `seasons_config`
Liste des saisons avec dates de réception, ventes, et tag_pattern (ex: `p26`, `a26`). Les produits sont taggés dans Lightspeed avec le code de saison.

### `budget_params`
```json
{
  "nb_saisons_reference": 3,
  "carryover_deduction_rate": 0.50,
  "use_global_carryover_rate": true,
  "carryover_rates_by_shop": {},
  "recency_factor": 2.0
}
```

## Logique de calcul du budget par marque (`GET /api/budget/marque`)

### Concept clé : saison de référence vs saison cible

- **Saison cible** (`?season=p27`) : la saison pour laquelle on prépare le budget
- **Saisons de référence** : les N saisons précédentes du même type (P → P, A → A), ex: P26, P25, P24 pour P27

### Étapes de calcul par marque

1. **Implied received** = articles vendus depuis `reception_from` + stock actuel taggé avec cette saison. Proxy pour les réceptions fournisseur sans dépendre des bons de commande.

2. **Sold cost** = coût des ventes pendant la période de vente de la saison.

3. **Projection si saison en cours** :
   - Si la saison de référence est en cours, on projette la fin via la **moyenne historique des ventes dans la fenêtre restante équivalente** des saisons passées (ex: si P26 est à 57%, on regarde ce qui s'est vendu en P25 et P24 entre le 57e% et la fin).
   - Fallback linéaire (÷ completion) si pas de données historiques pour cette marque.

4. **Base budgétaire blendée** = `(implied_received_cost + sold_cost_projeté) / 2`. Ancre le budget à la demande réelle, pas seulement aux achats passés.

5. **Moyenne pondérée** sur les N saisons de référence avec `recency_factor`. Poids = `recencyFactor^(N-1-i)`, i=0 = saison la plus récente. Évite que des vieilles données diluent une croissance récente.

6. **Multiplicateur** appliqué selon le ST moyen pondéré (voir `multiplier_tiers`).

7. **Carryover** = stock actuel taggé − ventes projetées restantes. On déduit `carryover × coRate` du budget ajusté.

8. **Budget net** = budget ajusté − déduction carryover.

### Pourquoi pas juste les réceptions ?

Les réceptions seules perpétuent les erreurs d'achat passées. La base blendée (réceptions + ventes) corrige vers la demande réelle.

### Transferts inter-boutiques

Les articles transférés disparaissent du calcul de la boutique émettrice (ni réception ni vente). C'est voulu : le budget reflète les ventes réelles à chaque boutique.

## Conventions de code importantes

- Pas de `AND p.default_cost > 0` dans les requêtes de budget — exclure les coûts zéro fausserait les unités
- Pas de `AND p.archived = false` dans les requêtes de ventes (Q1 brand page) — les articles archivés ont quand même été vendus
- `AND p.archived = false` est gardé dans les requêtes d'inventaire (Q2) — on ne veut pas de stock fantôme
- Les paramètres SQL sont toujours indexés ($1, $2...) via `[...baseParams, ...]` pour gérer proprement le filtre optionnel par boutique

## Endpoints API principaux

- `GET /api/budget/marque?season=p26&shops=1,2` — budget par marque
- `GET /api/budget/saisonnier` — budget saisonnier global
- `GET /api/budget/nos` — budget NOS (Never Out of Stock)
- `GET /api/settings/seasons` / `PUT /api/settings/seasons` — config des saisons
- `GET /api/settings/budget-params` / `PUT /api/settings/budget-params` — paramètres budget
- `GET /api/settings/multiplier-tiers` / `PUT /api/settings/multiplier-tiers` — paliers multiplicateurs
- `GET /api/brand?manufacturer=X&shop=Y` — données détaillées par marque

## Débogage fréquent

- **Erreur silencieuse `{"error":""}`** : exception JavaScript dans la route, souvent une variable undefined. Chercher dans le log du serveur.
- **Données manquantes dans le budget** : vérifier que les produits sont taggés avec le bon `tag_pattern` dans Lightspeed (ex: `p26`).
- **TM différent de Lightspeed** : "Stocks reçus" dans Lightspeed = dépletion (reçus − restants), pas des ventes. Comparer avec "Ventes par ligne".
