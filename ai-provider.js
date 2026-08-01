'use strict';
const HELP_CONTENT = require('./help-content');
// ---------------------------------------------------------------------------
// AI Provider Abstraction Layer
//
// Switch providers via environment variables — no code changes needed:
//
//   Mistral cloud (default):
//     AI_PROVIDER=mistral
//     MISTRAL_API_KEY=sk-...
//     AI_MODEL=mistral-small-latest          (or mistral-large-latest)
//
//   Mistral self-hosted (vLLM / Ollama — OpenAI-compatible endpoint):
//     AI_PROVIDER=mistral
//     MISTRAL_API_KEY=ignored-or-any-string
//     MISTRAL_BASE_URL=http://your-gpu-server:8000/v1
//     AI_MODEL=mistral-small-3.1            (name as loaded on your server)
//
//   OpenAI:
//     AI_PROVIDER=openai
//     OPENAI_API_KEY=sk-...
//     AI_MODEL=gpt-4o-mini
//
//   Anthropic:
//     AI_PROVIDER=anthropic
//     ANTHROPIC_API_KEY=sk-ant-...
//     AI_MODEL=claude-haiku-4-5-20251001
//
// All providers expose the same interface:
//   provider.complete(messages) → { message, tool_calls[], content }
//
// Messages use the OpenAI format throughout the codebase.
// Anthropic conversion is handled internally by AnthropicProvider.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shared tool definitions (provider-agnostic)
// ---------------------------------------------------------------------------
const TOOL_DEFS = [
  {
    name: 'get_budget_recommendations',
    description: "Obtenir les budgets d'achat recommandés par marque pour une saison. Retourne le budget net suggéré, le sell-through moyen, la tendance et le multiplicateur appliqué.",
    parameters: {
      type: 'object',
      properties: {
        season: { type: 'string', description: 'Code de saison, ex: p26, a26, p25' },
        shops:  { type: 'string', description: 'Noms ou IDs de boutiques séparés par virgules (optionnel), ex: "Saint-Bruno,Fan Club". La résolution par nom se fait automatiquement.' },
        limit:  { type: 'integer', description: 'Nombre maximum de marques à retourner (défaut: 20)' },
      },
      required: ['season'],
    },
  },
  {
    name: 'get_sales_analysis',
    description: '⚠️ VENTES D\'UNE MARQUE SPÉCIFIQUE + SAISON : NE PAS appeler immédiatement — vérifier d\'abord si le périmètre est précisé. Si "toute la marque"/"NOS inclus" dans le message → utiliser get_brand_ranking(include_nos=true, manufacturer=...) à la place. Si périmètre absent → poser Q1 (règle CLARIFICATION PÉRIMÈTRE MARQUE) et attendre. Ce tool avec season= filtre TOUJOURS par tag. Appel direct autorisé pour : (1) périmètre explicitement "collection seulement", (2) question globale sans marque précise, (3) question de période sans saison. — Analyser les ventes par marque et/ou boutique. Retourne les ventes brutes HT et le coût des ventes. Sans manufacturer ni category : total toutes marques par boutique. Avec category sans manufacturer : top des marques dans cette catégorie.',
    parameters: {
      type: 'object',
      properties: {
        period:       { type: 'string',  description: 'Période relative. Valeurs sémantiques: today, yesterday, last_7_days, last_14_days, last_30_days, last_90_days, last_week (lun–dim sem. précédente), this_week, this_month, last_month, this_year, last_4_weeks, last_12_weeks. Forme objet: {"from":"YYYY-MM-DD","to":"YYYY-MM-DD"}. Legacy: 1y, 6m, 30d, ytd, last_year. Si season est fourni et period absent, utilise les dates de la saison.' },
        season:       { type: 'string',  description: 'Code de saison (ex: p26, a25). Filtre par tag de saison ET définit la période de vente si period absent. Privilégier season pour les questions sur une saison.' },
        manufacturer: { type: 'string',  description: 'Nom de la marque (optionnel)' },
        category:     { type: 'string',  description: 'Type de produit Lightspeed (optionnel). Ex: "Chandail", "Pantalon", "Femme/Hauts/Chandail". Quand fourni sans manufacturer : retourne le top des marques dans cette catégorie.' },
        shop_id:      { type: 'string',  description: 'Nom ou ID de la boutique (optionnel). Ex: "Saint-Bruno", "Fan Club".' },
        tags:         { type: 'array', items: { type: 'string' }, description: 'Filtres supplémentaires par tag (optionnel)' },
        exclude_tags: { type: 'array', items: { type: 'string' }, description: 'Exclure ces tags (optionnel)' },
      },
      required: [],
    },
  },
  {
    name: 'get_stock_levels',
    description: 'Obtenir les niveaux de stock actuels par marque et/ou boutique.',
    parameters: {
      type: 'object',
      properties: {
        manufacturer:   { type: 'string',  description: 'Nom de la marque (optionnel)' },
        shop_id:        { type: 'string',  description: 'ID de la boutique (optionnel)' },
        low_stock_only: { type: 'boolean', description: 'Si true, retourner seulement les articles avec stock ≤ 2' },
      },
      required: [],
    },
  },
  {
    name: 'get_plan_vs_recommended',
    description: 'Comparer le budget planifié (saisi par acheteur) vs le budget recommandé par algorithme, par marque.',
    parameters: {
      type: 'object',
      properties: {
        season: { type: 'string', description: 'Code de saison' },
      },
      required: ['season'],
    },
  },
  {
    name: 'get_top_performers',
    description: 'Classement des meilleures ou pires marques selon un critère.',
    parameters: {
      type: 'object',
      properties: {
        season: { type: 'string',  description: 'Code de saison' },
        metric: { type: 'string',  enum: ['sell_through', 'sold_cost', 'net_budget'], description: 'Critère de tri' },
        order:  { type: 'string',  enum: ['desc', 'asc'], description: 'desc = meilleures en premier, asc = pires en premier' },
        limit:  { type: 'integer', description: 'Nombre de marques (défaut: 10)' },
        shops:  { type: 'string',  description: 'Noms ou IDs de boutiques séparés par virgules (optionnel), ex: "Saint-Bruno,Fan Club".' },
      },
      required: ['season', 'metric'],
    },
  },
  {
    name: 'get_shops_list',
    description: 'Obtenir la liste des boutiques disponibles avec leurs identifiants.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'search_brands',
    description: 'Rechercher des marques par nom (recherche partielle).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Terme de recherche' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_seasons_list',
    description: 'Obtenir la liste des saisons configurées avec leurs dates.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_sales_by_variant',
    description: 'Analyser les ventes par variante (taille, description de produit). Utiliser quand on veut les ventes d\'un produit précis ou d\'une taille spécifique (ex: "chemise Eton 15.5", "pantalon taille 32"). IMPORTANT: Ne PAS utiliser description_search pour des catégories génériques comme "chemise", "pantalon", "polo" — les descriptions sont des codes produits, pas des catégories. Utiliser seulement manufacturer + size pour les requêtes par taille.',
    parameters: {
      type: 'object',
      properties: {
        manufacturer:       { type: 'string', description: 'Nom de la marque (optionnel)' },
        size:               { type: 'string', description: 'Taille à rechercher, ex: "15.5", "M", "40". Supporte automatiquement "15 1/2" = "15.5"' },
        category:           { type: 'string', description: 'Type de produit dans la catégorie Lightspeed, ex: "Pantalon", "Chemise", "Jean", "Hauts", "Chandail". Ne pas inclure le genre ici — utiliser le paramètre "genre" séparément.' },
        genre:              { type: 'string', description: 'Genre du produit : "Homme" ou "Femme". Cherche dans la catégorie, les balises ET la description du produit. Utiliser quand l\'utilisateur précise homme/femme/pour lui/pour elle.' },
        tags:               { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'Balises à inclure (AND) — retourne les produits qui ont TOUS ces tags. Ex: ["p26", "consigne"]. Accepte aussi une seule valeur.' },
        exclude_tags:       { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'Balises à exclure (AND) — retourne les produits qui n\'ont AUCUN de ces tags. Ex: ["nos", "solde"]. Accepte aussi une seule valeur.' },
        description_search: { type: 'string', description: 'Mot-clé dans la description : couleur (ex: "BLEU", "BLANC", "MARINE"), coupe (ex: "SLIM", "CONTEMPORAIN"), style (ex: "TUXEDO", "TWILL"). Jamais pour le genre ni le type de produit.' },
        shop_id:            { type: 'string', description: 'ID de la boutique (optionnel)' },
        period:             { type: 'string', description: 'Période relative. Valeurs sémantiques: today, yesterday, last_7_days, last_14_days, last_30_days, last_90_days, last_week (lun–dim sem. précédente), this_week, this_month, last_month, this_year, last_4_weeks, last_12_weeks. Forme objet: {"from":"YYYY-MM-DD","to":"YYYY-MM-DD"}. Legacy: 1y, 6m, 30d, ytd, last_year.' },
        season:             { type: 'string', description: 'Code de saison (ex: p26, a25). Filtre par tag ET définit la période si period absent. Combinable avec period.' },
      },
      required: [],
    },
  },
  {
    name: 'get_stock_by_variant',
    description: 'Obtenir le stock actuel détaillé par variante (taille, couleur, description) pour une marque. Retourne UNIQUEMENT le stock actuel — NE PAS utiliser pour calculer les unités reçues ou le sell-through. Pour les reçus ou le ST, utiliser get_sellthrough_by_size à la place.',
    parameters: {
      type: 'object',
      properties: {
        manufacturer:       { type: 'string',  description: 'Nom de la marque (optionnel)' },
        size:               { type: 'string',  description: 'Taille à rechercher dans la description, ex: "15.5", "M", "40" (optionnel)' },
        category:           { type: 'string',  description: 'Type de produit dans la catégorie, ex: "Pantalon", "Chemise", "Jean", "Hauts". Ne pas inclure le genre ici — utiliser "genre" séparément.' },
        genre:              { type: 'string',  description: 'Genre du produit : "Homme" ou "Femme". Cherche dans la catégorie, les balises ET la description. Utiliser quand l\'utilisateur précise homme/femme/pour lui/pour elle.' },
        tags:               { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'Balises à inclure (AND) — produits ayant TOUS ces tags. Ex: ["p26", "consigne"].' },
        exclude_tags:       { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'Balises à exclure (AND) — produits n\'ayant AUCUN de ces tags. Ex: ["nos", "solde"].' },
        description_search: { type: 'string',  description: 'Mot-clé dans la description : couleur (ex: "BLEU", "BLANC"), coupe (ex: "SLIM", "CONTEMPORAIN"), style (ex: "TUXEDO"). Jamais pour le genre ni le type de produit.' },
        shop_id:            { type: 'string',  description: 'ID de la boutique (optionnel)' },
        period:             { type: 'string',  description: 'Accepté mais ignoré — le stock est toujours le snapshot actuel. Valeurs: last_7_days, last_30_days, last_week, this_month, etc.' },
      },
      required: [],
    },
  },
  {
    name: 'get_sellthrough_by_size',
    description: 'Calculer le sell-through (ST), les ventes et les unités reçues par variante pour une marque et une saison. Retourne vendu + stock restant + ST% par article. Utiliser pour: (1) top/flop tailles ("quelles tailles se vendent le mieux"), (2) comparer deux saisons, (3) décisions de réachat, (4) toute question sur les unités REÇUES ("avons-nous reçu plus?", "combien de reçus?") — reçus = vendu + stock restant. IMPORTANT: les totaux globaux (total_recu_fournisseur, total_vendu, total_stock_actuel_en_boutique) sont TOUJOURS exacts — utiliser ces champs pour répondre, JAMAIS sommer les variantes individuelles. Si AVERTISSEMENT apparaît dans le résultat (données tronquées), rappeler avec limit=nb_variantes_total pour tout voir. IMPORTANT: ce tool ne supporte PAS les filtres par date — quand season est fourni, les dates de la saison sont utilisées automatiquement (date_from/date_to sont ignorés).',
    parameters: {
      type: 'object',
      properties: {
        manufacturer: { type: 'string',  description: 'Nom de la marque' },
        size:         { type: 'string',  description: 'Taille à filtrer, ex: "15.5", "36", "L". Optionnel — omettre pour voir toutes les tailles.' },
        category:     { type: 'string',  description: 'Type de produit, ex: "Pantalon", "Chemise"' },
        genre:        { type: 'string',  description: '"Homme" ou "Femme"' },
        tags:         { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'Balises à inclure (AND) — produits ayant TOUS ces tags. Ex: ["p26", "consigne"].' },
        exclude_tags: { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'Balises à exclure (AND) — produits n\'ayant AUCUN de ces tags. Ex: ["nos", "solde"].' },
        season:       { type: 'string',  description: 'Code saison pour la période de vente, ex: "p26", "a25". Filtre par tag ET définit les dates si period absent.' },
        period:       { type: 'string',  description: 'Période relative. Valeurs: today, yesterday, last_7_days, last_14_days, last_30_days, last_90_days, last_week, this_week, this_month, last_month, this_year, last_4_weeks, last_12_weeks. Combinable avec season pour cibler une fenêtre dans une saison.' },
        shop_id:      { type: 'string',  description: 'ID boutique (optionnel)' },
        sort:         { type: 'string',  enum: ['st_desc', 'st_asc', 'sold_desc'], description: 'Tri: st_desc = meilleures performances, st_asc = pires performances (flop), sold_desc = plus vendu' },
        limit:        { type: 'integer', description: 'Nombre max de variantes (défaut: 200, max: 500). Augmenter si AVERTISSEMENT données tronquées.' },
      },
      required: [],
    },
  },
  {
    name: 'get_transfer_recommendations',
    description: "Obtenir les recommandations de transfert de stock : modèles dormants dans une boutique qui se vendent encore dans une autre. Utiliser quand l'utilisateur demande quoi transférer, quel stock dort, ou quelles pièces bouger entre boutiques.",
    parameters: {
      type: 'object',
      properties: {
        days_dormant:      { type: 'integer', description: 'Nombre de jours sans vente pour considérer le stock comme dormant (défaut: 14)' },
        min_stock:         { type: 'integer', description: 'Stock minimum pour déclencher une recommandation (défaut: 1)' },
        receiving_shop_id: { type: 'string',  description: 'Filtrer par boutique réceptrice (nom partiel, ex: "Fan Club", "Saint-Bruno"). Laisser vide pour toutes les boutiques.' },
        category:          { type: 'string',  description: 'Filtrer par catégorie de produit (optionnel)' },
        exclude_nos:       { type: 'boolean', description: 'Si true, exclure les produits NOS (permanents)' },
      },
      required: [],
    },
  },
  {
    name: 'get_matrix_info',
    description: "Obtenir les informations sur les matrices de produits (modèles regroupant toutes leurs tailles/couleurs). Utiliser quand l'utilisateur demande les tailles disponibles d'un modèle, le stock par taille, ou veut voir toutes les variantes d'un produit.",
    parameters: {
      type: 'object',
      properties: {
        manufacturer:       { type: 'string', description: 'Nom de la marque (optionnel)' },
        description_search: { type: 'string', description: 'Mot-clé dans la description du produit ou le code modèle (ex: "A45118", "MARON", "RENA")' },
        category:           { type: 'string', description: 'Catégorie de produit (optionnel)' },
        shop_id:            { type: 'string', description: 'Filtrer le stock par boutique (optionnel)' },
      },
      required: [],
    },
  },
  {
    name: 'get_categories',
    description: 'Obtenir la liste des catégories de produits disponibles dans la base de données. UTILISER AVANT de filtrer par category dans get_sales_by_variant ou get_stock_by_variant quand on ne connaît pas la structure exacte des catégories. Retourne l\'arbre complet des catégories avec le nombre de produits par catégorie.',
    parameters: {
      type: 'object',
      properties: {
        manufacturer: { type: 'string', description: 'Filtrer par marque pour voir ses catégories spécifiques (optionnel). Ex: "Brax", "Eton".' },
      },
      required: [],
    },
  },
  {
    name: 'compare_seasons',
    description: 'Comparer les performances d\'une marque (ou de toutes les marques) sur plusieurs saisons côte à côte. Retourne pour chaque saison : unités vendues, ventes brutes, coût des ventes, stock restant, reçus fournisseur et sell-through. Utiliser pour les questions inter-saisons : "comment P26 se compare à P25 et P24 ?", "évolution sur 3 saisons", "croissance par rapport à l\'an dernier".',
    parameters: {
      type: 'object',
      properties: {
        seasons:      { type: 'array', items: { type: 'string' }, description: 'Codes de saisons à comparer, ex: ["p26", "p25", "p24"]. Maximum 5 saisons.' },
        manufacturer: { type: 'string',  description: 'Nom de la marque (optionnel — omettre pour toutes les marques)' },
        shop_id:      { type: 'string',  description: 'Nom ou ID de la boutique (optionnel)' },
      },
      required: ['seasons'],
    },
  },
  {
    name: 'get_sales_by_category',
    description: 'Analyser les ventes agrégées par catégorie de produit pour une période ou une saison. Retourne ventes brutes, unités et coût par catégorie. Utiliser quand l\'utilisateur demande : "quelle catégorie se vend le mieux ?", "répartition des ventes par type de produit", "top catégories pour cette saison". Pour une marque spécifique, ajouter manufacturer.',
    parameters: {
      type: 'object',
      properties: {
        season:       { type: 'string', description: 'Code de saison (ex: p26). Filtre par tag de saison ET définit la période si period absent.' },
        period:       { type: 'string', description: 'Période relative. Valeurs: today, yesterday, last_7_days, last_14_days, last_30_days, last_90_days, last_week, this_week, this_month, last_month, this_year, last_4_weeks, last_12_weeks. Legacy: 1y, 6m, ytd, last_year.' },
        date_from:    { type: 'string', description: 'Date de début ISO (YYYY-MM-DD)' },
        date_to:      { type: 'string', description: 'Date de fin ISO (YYYY-MM-DD)' },
        manufacturer: { type: 'string', description: 'Filtrer par marque (optionnel)' },
        shop_id:      { type: 'string', description: 'Nom ou ID de la boutique (optionnel)' },
      },
      required: [],
    },
  },
  {
    name: 'get_inventory_at_date',
    description: 'Obtenir le stock réel (unités, valeur coût, valeur détail) à une date donnée — aujourd\'hui ou dans le passé. Utiliser pour TOUTE question sur la quantité ou la valeur du stock : "quels sont mes stocks", "valeur totale de l\'inventaire", "stock par boutique aujourd\'hui", "quel était le stock le [date]", "combien d\'unités [marque] avons-nous". Sans date = snapshot le plus récent (hier soir). Le résultat contient un champ "totaux" avec les vrais totaux compagnie — TOUJOURS lire ce champ pour répondre. JAMAIS inventer ni calculer un total. Si la date précède le premier snapshot, l\'outil retourne une erreur explicite.',
    parameters: {
      type: 'object',
      properties: {
        date:         { type: 'string', description: 'Date ISO (YYYY-MM-DD). Omettre ou utiliser la date du jour pour le stock actuel.' },
        shop_id:      { type: 'string', description: 'Nom ou ID de la boutique (optionnel). Sans ce paramètre : retourne le breakdown par boutique.' },
        manufacturer: { type: 'string', description: 'Nom de la marque (optionnel)' },
      },
      required: [],
    },
  },
  {
    name: 'get_payment_terms_analysis',
    description: 'Analyser les termes de paiement fournisseur et recommander si prendre l\'escompte ou payer à terme. UTILISER pour toute question sur : escomptes, termes de paiement, "devrais-je payer [marque] rapidement", "est-ce rentable de payer sous X jours", "quels escomptes prendre", rendement annualisé. RÈGLES ABSOLUES : (1) ne JAMAIS citer un escompte ou un taux sans avoir appelé cet outil — même pour une marque bien connue. (2) Si termes_non_configures=true : DIRE EXPLICITEMENT que les termes ne sont pas configurés dans l\'application — JAMAIS supposer des termes standards. (3) Le champ "recommandation" est "take_discount" ou "full_term" — toujours citer ce champ pour conclure.',
    parameters: {
      type: 'object',
      properties: {
        manufacturer: { type: 'string', description: 'Nom de la marque (optionnel). Sans ce paramètre : retourne l\'analyse de toutes les marques avec le top des escomptes à prendre.' },
      },
      required: [],
    },
  },
  {
    name: 'resolve_search_term',
    description: "Résoudre le type d'un terme de recherche avant d'appeler un outil de données. Utiliser quand le terme n'est pas clairement un nom de marque connu (codes modèle, SKU, références partielles). Retourne resolved_type et les détails pour choisir le bon outil suivant.",
    parameters: {
      type: 'object',
      properties: {
        terme: { type: 'string', description: 'Le terme à résoudre (code modèle, SKU, référence, nom partiel)' },
      },
      required: ['terme'],
    },
  },
  {
    name: 'get_matrix_sellthrough',
    description: "Obtenir le sell-through complet (reçus, vendus, stock, ST%) pour un modèle précis identifié par son matrix_id. Inclut le détail par taille et par couleur. Utiliser après resolve_search_term quand resolved_type='matrix', avec le matrix_id retourné.",
    parameters: {
      type: 'object',
      properties: {
        matrix_id: { type: 'string', description: 'ID de la matrice — retourné par resolve_search_term dans le champ matrix_id' },
        season:    { type: 'string', description: 'Code de saison (ex: p26). Filtre par tag et dates de la saison.' },
        shop_id:   { type: 'string', description: 'Nom ou ID de la boutique (optionnel)' },
      },
      required: ['matrix_id'],
    },
  },
  {
    name: 'get_product_by_description',
    description: "Rechercher des produits par mot-clé dans la description et retourner un agrégat ST par modèle (matrice). Utiliser après resolve_search_term quand resolved_type='description' (plusieurs matrices matchent le terme).",
    parameters: {
      type: 'object',
      properties: {
        terme:   { type: 'string', description: 'Terme de recherche dans la description des produits' },
        season:  { type: 'string', description: 'Code de saison (optionnel, ex: p26)' },
        shop_id: { type: 'string', description: 'Nom ou ID de la boutique (optionnel)' },
      },
      required: ['terme'],
    },
  },
  {
    name: 'get_brand_ranking',
    description: "Classement analytique des marques par ST, revenue, unités vendues, stock dormant ou marge — calculé directement depuis les ventes (pas le cache budget). Utiliser quand l'utilisateur demande : 'quelle marque a le meilleur ST cette saison', 'classement par chiffre d'affaires', 'quelles marques ont du stock qui dort', 'top marques par marge', 'marques sous 50% de ST'. Supporte filtres min_st/max_st pour cibler une plage de ST au niveau marque. Différent de get_top_performers qui dépend du cache budget.",
    parameters: {
      type: 'object',
      properties: {
        season:  { type: 'string', description: 'Code de saison (ex: p26). Filtre par tag ET définit la période si period absent. Sans season ni period : 12 semaines glissantes.' },
        period:  { type: 'string', description: 'Période relative. Valeurs: today, yesterday, last_7_days, last_14_days, last_30_days, last_90_days, last_week, this_week, this_month, last_month, this_year, last_4_weeks, last_12_weeks. Combinable avec season.' },
        shop_id: { type: 'string', description: 'Nom ou ID de la boutique (optionnel)' },
        manufacturer: { type: 'string',  description: 'Filtrer sur une marque spécifique (optionnel). Utiliser quand l\'utilisateur demande "toute la marque [X]" pour une seule saison.' },
        sort_by:      { type: 'string', enum: ['st', 'revenue', 'stock_dormant', 'units_sold', 'margin'], description: "Critère de tri. 'st'=sell-through, 'revenue'=chiffre d'affaires, 'stock_dormant'=stock invendu, 'units_sold'=unités vendues, 'margin'=marge brute. Défaut: 'st'" },
        limit:        { type: 'integer', description: 'Nombre de marques à retourner (1-50, défaut: 20)' },
        include_nos:  { type: 'boolean', description: "Si true, inclut tous les articles de la marque vendus dans la fenêtre (pas seulement ceux taggés avec la saison). Si false (défaut), filtre par le tag de saison — uniquement la collection saisonnière. Retourne le champ scope_produits pour indiquer le périmètre." },
        min_st:       { type: 'number', description: 'ST minimum en % au niveau marque (ex: 60 pour marques avec ST ≥ 60%). Filtre les marques sous ce seuil.' },
        max_st:       { type: 'number', description: 'ST maximum en % au niveau marque (ex: 50 pour marques avec ST ≤ 50%). Filtre les marques au-dessus de ce seuil.' },
      },
      required: [],
    },
  },
  {
    name: 'get_season_comparison',
    description: "Comparaison détaillée de deux saisons avec deltas calculés (ST, revenue, unités, marge). Utiliser pour : 'P26 vs P25 pour Brax', 'est-ce qu'on a fait mieux cette saison', 'évolution du ST entre deux saisons'. Retourne les métriques des deux saisons et les variations (positif = amélioration). Différent de compare_seasons qui compare N saisons sans calculer les deltas.",
    parameters: {
      type: 'object',
      properties: {
        season1:           { type: 'string',  description: 'Saison de référence (la plus récente), ex: p26' },
        season2:           { type: 'string',  description: 'Saison de comparaison (la plus ancienne), ex: p25' },
        manufacturer:      { type: 'string',  description: 'Nom de la marque (optionnel — omettre pour toutes les marques)' },
        shop_id:           { type: 'string',  description: 'Nom ou ID de la boutique (optionnel)' },
        include_nos:       { type: 'boolean', description: "Si true, inclut tous les articles de la marque vendus dans la fenêtre (pas seulement ceux taggés). Si false (défaut), filtre par le tag de saison. Retourne le champ scope_produits." },
        comparable_window: { type: 'boolean', description: "Si true (défaut) et que season1 est en cours et season2 terminée, recalcule season2 sur la même durée écoulée que season1 pour une comparaison équitable. Passer false si l'utilisateur veut la saison2 complète (toutes ses données). Pertinent surtout quand include_nos=true." },
      },
      required: ['season1', 'season2'],
    },
  },
  {
    name: 'get_items_by_criteria',
    description: "Rechercher des modèles (matrices) selon des critères de performance : ST, stock, ventes, marque. Agrège au niveau modèle (toutes tailles/couleurs combinées). Utiliser pour : 'quels articles réapprovisionner' (min_st=80, min_stock=1), 'articles jamais vendus' (has_sales=false, min_stock=1), 'stock dormant Brax' (manufacturer=Brax, max_st=35, min_stock=1), 'modèles à plus de 80% ST'. Retourne taille_manquante pour les modèles épuisés à fort ST.",
    parameters: {
      type: 'object',
      properties: {
        season:       { type: 'string',  description: 'Code de saison (ex: p26). Filtre par tag ET définit la période si period absent. Sans season ni period : 12 semaines glissantes.' },
        period:       { type: 'string',  description: 'Période relative. Valeurs: today, yesterday, last_7_days, last_14_days, last_30_days, last_90_days, last_week, this_week, this_month, last_month, this_year, last_4_weeks, last_12_weeks. Combinable avec season.' },
        shop_id:      { type: 'string',  description: 'Nom ou ID de la boutique (optionnel)' },
        min_st:       { type: 'number',  description: 'ST minimum en % (ex: 80 pour ST ≥ 80%)' },
        max_st:       { type: 'number',  description: 'ST maximum en % (ex: 35 pour ST ≤ 35%)' },
        min_stock:    { type: 'integer', description: 'Stock minimum en unités' },
        max_stock:    { type: 'integer', description: 'Stock maximum en unités' },
        has_sales:    { type: 'boolean', description: 'true = au moins une vente dans la période ; false = aucune vente' },
        manufacturer: { type: 'string',  description: 'Filtrer par marque (optionnel)' },
        sort_by:      { type: 'string',  enum: ['st', 'stock', 'stock_dormant', 'revenue'], description: "Critère de tri. Défaut: 'st'" },
        limit:        { type: 'integer', description: 'Nombre de modèles (1-200, défaut: 50)' },
      },
      required: [],
    },
  },
  {
    name: 'get_restock_recommendations',
    description: "Identifie les modèles qui vont tomber en rupture avant la fin de saison — ST élevé et couverture de stock insuffisante. Retourne les unités manquantes, les tailles à réassortir en priorité, si le stock existe dans une autre boutique (transfert plutôt qu'achat), et la date limite de commande selon le délai fournisseur. Utiliser pour : 'quoi réassortir', 'qu'est-ce qui va manquer', 'quelles ruptures à venir', 'quoi recommander en urgence'.",
    parameters: {
      type: 'object',
      properties: {
        season:                  { type: 'string',  description: 'Code saison obligatoire, ex: p26, a26' },
        shop_id:                 { type: 'string',  description: 'Nom ou ID de la boutique (optionnel — sans filtre: toutes boutiques agrégées)' },
        manufacturer:            { type: 'string',  description: 'Filtrer par marque (optionnel)' },
        min_st:                  { type: 'number',  description: 'ST minimum en % pour inclure un modèle (défaut: 70). Ex: 80 pour les modèles très bien vendus.' },
        max_semaines_couverture: { type: 'number',  description: 'Couverture max en semaines (optionnel). Ex: 4 = seulement les modèles avec moins de 4 semaines de stock.' },
        include_nos:             { type: 'boolean', description: 'Si true, inclut aussi les articles NOS (permanents, sans tag saison). Défaut: false.' },
        limit:                   { type: 'integer', description: 'Nombre maximum de modèles (1-100, défaut: 30).' },
      },
      required: ['season'],
    },
  },
];

// ---------------------------------------------------------------------------
// System prompt — built dynamically from tenant config
// ---------------------------------------------------------------------------
function buildSystemPrompt(tenantConfig = {}) {
  const boutique    = tenantConfig.boutique_name ?? 'la boutique';
  const ptField     = tenantConfig.product_type_field ?? 'category';
  const genreOn     = tenantConfig.genre_enabled === 'yes';
  const genreFields = tenantConfig.genre_fields ?? ['category', 'tag', 'description'];
  const genreH      = tenantConfig.genre_values?.homme ?? 'Homme';
  const genreF      = tenantConfig.genre_values?.femme ?? 'Femme';
  const nosTag      = tenantConfig.nos_tag ?? null;
  const nosEnabled  = tenantConfig.nos_enabled === 'yes' && nosTag;

  const ptInstruction = ptField === 'description'
    ? `Le TYPE DE PRODUIT (pantalon, chemise, polo...) est dans le champ "description" — utiliser description_search pour filtrer par type de produit.`
    : ptField === 'tag'
    ? `Le TYPE DE PRODUIT (pantalon, chemise, polo...) est dans les balises (tags) — utiliser le paramètre "tag" pour filtrer par type.`
    : `Le TYPE DE PRODUIT (pantalon, chemise, polo...) est dans le champ "category" — utiliser le paramètre "category". JAMAIS mettre un type de produit dans description_search.`;

  const genreInstruction = genreOn
    ? `Le genre distingue "${genreH}" et "${genreF}" (champs: ${genreFields.join(', ')}). Quand l'utilisateur précise le genre, passe-le dans "genre". homme/pour lui/men → "${genreH}" ; femme/pour elle/women → "${genreF}". Si genre non précisé ET la marque a les deux genres : pose UNE seule question "Pour ${genreH.toLowerCase()} ou ${genreF.toLowerCase()} ?"`
    : `Ce catalogue ne distingue pas homme/femme — ne pas filtrer par genre ni poser de question à ce sujet.`;

  const nosInstruction = nosEnabled
    ? `Les produits NOS (permanents) sont identifiés par la balise "${nosTag}".`
    : `Aucune balise NOS configurée.`;

  return `Tu es un assistant expert en achat pour ${boutique}.
Tu as accès à des outils qui interrogent la base de données de l'application Buying Intelligence.

CONTEXTE
- L'app gère des budgets d'achat saisonniers par marque et par boutique
- Les saisons : P = Printemps, A = Automne + année (ex: p26 = Printemps 2026)
- Sell-through (ST) = unités vendues / unités reçues × 100%
- Un bon ST est généralement ≥ 65%. En dessous de 35%, la marque est sous-performante
- Ventes brutes = prix de vente HT − escomptes. Coût des ventes = prix d'achat × quantités vendues

STRUCTURE DES DONNÉES
- ${ptInstruction}
- ${genreInstruction}
- ${nosInstruction}

BOUTIQUES : passe toujours le nom de la boutique tel quel dans shop_id (ex: "Saint-Bruno", "Fan Club") — JAMAIS inventer ou deviner un ID numérique. La résolution se fait automatiquement.
"la compagnie" / "le réseau" / "toutes les boutiques" / "l'entreprise" / "the business" / "all stores" = aucun filtre shop_id — retourner les données agrégées pour l'ensemble du réseau sans demander de précision.

RÈGLES ABSOLUES

⚠️ INTÉGRITÉ DES DONNÉES — RÈGLE N°1 ABSOLUE
Tu ne cites JAMAIS un chiffre (unités, montants, pourcentages, coûts) qui ne provient pas directement du résultat d'un outil appelé dans cette conversation.
Tu ne nommes JAMAIS une marque, catégorie, boutique ou saison qui ne provient pas d'un résultat d'outil.
Si aucun outil ne peut répondre à la question posée, tu le dis explicitement : "Je n'ai pas d'outil pour répondre à cette question précise" et tu proposes ce que tu PEUX faire à la place.
Inventer un chiffre ou un nom est la pire erreur possible — pire que de ne pas répondre.

- MARQUE INTROUVABLE : si un outil retourne marque_introuvable: true, tu DOIS répondre "La marque « [marque_cherchee] » est introuvable dans le catalogue." puis proposer les suggestions si présentes ("Vouliez-vous dire : [suggestions] ?"). JAMAIS afficher un chiffre (0 unité, 0$, 0%) dans ce cas — le zéro serait trompeur.
- Réponds TOUJOURS en français
- Sois BREF : 1 tableau ou 3-4 lignes max — jamais de blocs d'explication non demandés
- JAMAIS inventer un chiffre — toujours appeler un outil pour obtenir les données
- JAMAIS répondre à une question de suivi en puisant dans ta mémoire — toujours rappeler l'outil avec les bons filtres
- Si l'utilisateur dit que ton chiffre est faux : appelle IMMÉDIATEMENT l'outil à nouveau sans poser de questions
- Ne JAMAIS dire "vérifie tes données" ou proposer des choix quand l'utilisateur conteste un résultat
- TAILLES : si 0 résultat pour la taille demandée, réponds "0 unité" — JAMAIS substituer une autre taille
- REÇUS : utiliser get_sellthrough_by_size (reçus = vendu + stock restant) — jamais estimer depuis le stock seul
- TOTAUX get_sellthrough_by_size : TOUJOURS utiliser les champs total_recu_fournisseur, total_vendu, total_stock_actuel_en_boutique pour les totaux — JAMAIS les sommer depuis les variantes individuelles (elles peuvent être tronquées). Si le champ AVERTISSEMENT est présent, rappeler l'outil avec limit=nb_variantes_total avant de faire tout calcul par taille ou catégorie.
- DESCRIPTIONS : get_sellthrough_by_size retourne une ligne par variante avec sa description complète. JAMAIS agréger par taille ni résumer plusieurs lignes en une. JAMAIS inventer ou deviner des noms de modèles (ex: "Soffys", "Aminase") — utiliser uniquement les descriptions exactes retournées par l'outil.
- DATES get_sellthrough_by_size : ce tool ne supporte PAS les filtres par date personnalisés. Quand season est fourni, les dates de la saison sont utilisées automatiquement. Si l'utilisateur demande une plage de dates spécifique pour les "reçus", le lui expliquer clairement — la formule reçus=vendu+stock est valide seulement sur la fenêtre complète de la saison.
- Quand tu affiches plusieurs boutiques, ajoute toujours une ligne TOTAL
- Formate les montants: $1 234,56 — les pourcentages: 67,3%
- Si tu n'es pas certain du nom exact d'une catégorie : appelle get_categories(manufacturer=X) d'abord
- COMPARAISONS INTER-SAISONS : pour toute question comparant plusieurs saisons ("P26 vs P25", "évolution sur 3 saisons", "croissance d'une saison à l'autre"), utiliser compare_seasons avec la liste des codes de saison dans "seasons". Pour une comparaison approfondie ENTRE DEUX saisons avec deltas calculés ("+X% de ST", "variation du revenue") → utiliser get_season_comparison(season1, season2) à la place
- CLARIFICATION PÉRIMÈTRE MARQUE — CONDITION PRÉALABLE : cette règle ne s'applique QUE si la question mentionne une saison (code P26/A25, mot "printemps"/"automne", "la saison", "cette saison", "la collection", etc.).
  Si aucune saison n'est mentionnée — l'utilisateur demande une fenêtre temporelle pure ("la semaine dernière", "ce mois-ci", "les 30 derniers jours") ou aucune période — NE PAS poser la question de périmètre. Répondre directement : sans saison, il n'y a pas de filtre de tag, le périmètre est nécessairement toute la marque. Dans ce cas, utiliser get_brand_ranking(manufacturer=..., period=..., include_nos=true) et terminer la note de périmètre par "Ces chiffres couvrent tous les articles de la marque vendus [période]."
  Exemples NON-déclencheurs : "Ventes de Brax la semaine dernière" → répondre directement. "Combien j'ai vendu de Marc Cain ce mois-ci" → répondre directement.
  DÉCLENCHEUR (saison mentionnée) : pour toute question "ventes / ST / revenue de [MARQUE X] en [SAISON Y]", si le message NE contient PAS l'un de ces termes : "toute la marque", "NOS inclus", "tous les articles", "collection seulement", "taggés [saison]", "uniquement [saison]" → NE PAS appeler get_sales_analysis, get_brand_ranking ni get_season_comparison. Répondre UNIQUEMENT avec la question : "Quel périmètre souhaitez-vous pour [marque X] en [saison Y] ? **(A)** Collection [saison Y] seulement — articles achetés pour cette saison (taggés [saison Y]) **(B)** Toute la marque — tous les articles [marque X] vendus dans la fenêtre, NOS et anciens stocks inclus". ATTENDRE la réponse avant tout appel. Exemples déclencheurs : "Ventes de Marc Cain ce printemps" → STOP, poser Q. "Combien j'ai vendu de Brax en P26" → STOP, poser Q. "Ventes de Brax P26 la semaine dernière" → STOP, poser Q. Exemples non-déclencheurs supplémentaires : "Stock de Marc Cain" (stock ≠ ventes), "Top des ventes" (pas de marque précise), "Ventes de Marc Cain, toute la marque" (scope déjà présent). Routing scope connu : "collection seulement" → get_sales_analysis(season=..., manufacturer=...) ; "toute la marque" → get_brand_ranking(season=..., include_nos=true, manufacturer=..., sort_by='revenue').
  POUR get_season_comparison SEULEMENT : si comparable_window non précisé, poser Q2 en plus : "(A) Saison complète (B) Fenêtre comparable : même durée écoulée dans les deux saisons".
- NOTE DE PÉRIMÈTRE OBLIGATOIRE : Toute réponse affichant des chiffres issus de get_brand_ranking ou get_season_comparison DOIT inclure une note de périmètre en fin de réponse : "Ces chiffres portent sur [scope_produits] du [debut] au [fin]." (utiliser le champ scope_produits du résultat, et les champs periode.de/periode.a pour get_brand_ranking ou saison_reference.periode/saison_comparaison.periode pour get_season_comparison).
- CLASSEMENT DES MARQUES (analytique) : pour "quelle marque a le meilleur ST", "classement par revenue", "marques avec stock dormant", "top par marge" → utiliser get_brand_ranking. JAMAIS inventer un classement. get_brand_ranking et get_top_performers sont complémentaires : get_brand_ranking calcule tout en temps réel (ST, revenue, marge, stock dormant) ; get_top_performers lit le cache budget (disponible après calcul de budget)
- MODÈLES PAR CRITÈRES : pour "quels articles réapprovisionner" (min_st=80, min_stock=1), "modèles jamais vendus" (has_sales=false, min_stock=1), "stock dormant chez [marque]" (manufacturer=X, max_st=35, min_stock=1), "quels modèles épuisés" (min_st=80, max_stock=0) → utiliser get_items_by_criteria. Ce tool agrège au niveau modèle complet (toutes tailles combinées), pas par variante individuelle. TRONCATURE : si nb_articles_affiches < nb_articles_total dans le résultat, signaler EXPLICITEMENT : "⚠️ Résultats partiels : X modèles affichés sur Y au total. Pour voir tous les modèles, rappeler avec limit=Y." Ne jamais présenter un résultat tronqué comme complet.
- CATÉGORIES : pour toute question sur les ventes/répartition par TYPE DE PRODUIT ("quelle catégorie se vend le mieux?", "top catégories", "répartition par type de produit"), utiliser get_sales_by_category — JAMAIS get_sales_by_variant ni get_categories pour ces questions
- COLLECTIONS/MARQUES : en mode achat, "collection" désigne la gamme saisonnière d'une marque, PAS une catégorie de produit. "quelle collection se vend le mieux" = "quelle marque performe le mieux cette saison" → utiliser get_top_performers (metric="sold_cost") ou get_sales_analysis sans manufacturer. NE JAMAIS appeler get_sales_by_category pour une question qui contient le mot "collection".
- SUIVI PAR MOT UNIQUE : si l'utilisateur répond avec un seul mot comme "marque", "catégorie", "boutique", "saison" après une réponse précédente, interpréter comme "donne-moi le top [mot] avec les mêmes filtres boutique/saison/période que la question précédente" — appeler l'outil approprié avec ces filtres. NE PAS creuser dans un sous-résultat de la réponse précédente (ex: ne pas filtrer par la catégorie affichée dans la réponse d'avant).
- TRANSFERTS : pour toute question sur le stock dormant, les transferts recommandés ou "quoi bouger", utiliser get_transfer_recommendations — JAMAIS inventer une réponse
- NIVEAUX DE STOCK / VALEUR D'INVENTAIRE : pour toute question sur la valeur ou la quantité totale du stock ("quels sont mes stocks", "valeur totale de l'inventaire", "stock par boutique", "combien d'unités en stock", "quel était le stock le [date]"), utiliser get_inventory_at_date. Sans date précise = utiliser la date d'aujourd'hui (le tool trouve automatiquement le dernier snapshot). Retourne les VRAIS totaux dans le champ "totaux" — lire ce champ pour répondre, JAMAIS calculer ni inventer un total. Si l'outil retourne une erreur (aucun snapshot), le dire EXPLICITEMENT — JAMAIS estimer.
- LECTURE DES TRANSFERTS DANS LE SELL-THROUGH : le champ "stock_actuel" est EXCLUSIF des transferts sortants (les unités transférées ont déjà quitté la boutique et sont déduites de l'inventaire). Ne JAMAIS dire que le stock "inclut" des unités transférées. La formule est : reçu_fournisseur = vendu + stock_actuel + transferts_sortants − transferts_entrants. Présenter les transferts comme une ligne séparée, pas comme faisant partie du stock.
- MATRICES / TAILLES : pour voir toutes les tailles d'un modèle ou le stock par taille, utiliser get_matrix_info avec le code modèle (ex: "A45118") dans description_search
- RÉSOLUTION DU TERME : avant toute question sur ST/ventes/stock d'un produit ou d'une référence (SKU, code modèle, référence partielle), si le terme n'est PAS clairement un nom de marque connu, appeler resolve_search_term en premier. Ne jamais supposer manufacturer par défaut. Selon resolved_type : 'manufacturer' → get_sellthrough_by_size ; 'matrix' → get_matrix_sellthrough(matrix_id retourné) ; 'description' → get_product_by_description ; 'ambiguous' → demander à l'utilisateur "Je trouve X marque(s) [noms] et Y article(s) — vous cherchez la marque ou l'article ?" ; 'not_found' → indiquer le terme introuvable et proposer les suggestions du champ suggestions.
- TAGS : "tags" (tableau, max 10) filtre les produits qui ont TOUS les tags listés — logique AND. Ex: tags=["p26","consigne"] → uniquement les produits avec les deux tags. "exclude_tags" (tableau, max 10) exclut les produits ayant N'IMPORTE LEQUEL de ces tags. Ex: exclude_tags=["nos","solde"] → aucun NOS ni solde. Les deux paramètres sont combinables simultanément.
- PARSING DES TAGS : quand l'utilisateur dit "tager X", "tagé X", "tagué X", "avec le tag X", "avec la balise X", "tagged X", "with tag X", "labelled X", "étiquetté X" — extraire X comme tag et NE JAMAIS l'inclure dans le nom de la marque. Ex: "Part Two tager p26" → manufacturer="Part Two", tags=["p26"]. Ex: "Eton tagged p25 slim" → manufacturer="Eton", tags=["p25"], description_search="slim".
- QUESTIONS DE CLARIFICATION : UNE SEULE question, UNIQUEMENT si l'info manquante est BLOQUANTE. JAMAIS demander la couleur, la boutique ou la période.
- PÉRIODES — PARSING LANGAGE NATUREL : convertir toujours les expressions temporelles de l'utilisateur en valeur "period" avant d'appeler un outil. Table de correspondance (non exhaustive) :
  | Expression utilisateur | Valeur period |
  |---|---|
  | "la semaine dernière", "last week", "la semaine passée" | last_week |
  | "cette semaine", "this week", "depuis lundi" | this_week |
  | "aujourd'hui", "today" | today |
  | "hier", "yesterday" | yesterday |
  | "les 7 derniers jours", "les 7 jours", "last 7 days" | last_7_days |
  | "les 14 derniers jours", "les 2 dernières semaines" | last_14_days |
  | "les 30 derniers jours", "le mois passé glissant" | last_30_days |
  | "les 90 derniers jours", "les 3 derniers mois glissants" | last_90_days |
  | "ce mois-ci", "this month", "en juillet", "en [mois actuel]" | this_month |
  | "le mois dernier", "last month", "en [mois précédent]" | last_month |
  | "cette année", "since January", "depuis janvier", "depuis le début de l'année", "YTD" | this_year |
  | "les 4 dernières semaines" | last_4_weeks |
  | "les 12 dernières semaines" | last_12_weeks |
  | "il y a X semaines" → calculer { from, to } manuellement | objet {from, to} |
  Règle last_week : TOUJOURS lundi–dimanche de la SEMAINE CALENDAIRE PRÉCÉDENTE — pas les 7 derniers jours.
  Si l'utilisateur mentionne une SAISON ET une période (ex: "ventes Brax en P26 la semaine dernière"), passer les DEUX : season="p26" ET period="last_week".
  Si l'expression est ambiguë ("récemment", "depuis quelque temps") : utiliser last_30_days sans demander de précision.
- FORMAT DES TABLEAUX : le panneau de chat est étroit. Limiter les tableaux à 5 colonnes MAXIMUM. Choisir les colonnes selon la question posée, jamais toutes les données disponibles. Pour get_restock_recommendations, les 5 colonnes par défaut sont : Marque | Modèle | Urgence | Ventes manquées | Transfert. Les détails secondaires (ST%, stock actuel, unités manquantes, valeur réassort, catégorie, tailles à réassortir) vont dans une liste à puces sous le tableau, uniquement pour les 3 premières lignes, ou sur demande explicite. Si l'utilisateur demande plus de colonnes ou un détail précis, les fournir. Sinon, rester à 5.
- RÉASSORT (get_restock_recommendations) : quand l'outil retourne des modèles avec transfert_possible: 'complet' ou 'partiel', TOUJOURS le mentionner explicitement — un transfert est moins coûteux qu'une commande fournisseur ('partiel' = stock insuffisant mais exploitable). Utiliser valeur_ventes_manquees_estimee (revenu perdu) comme chiffre principal. Quand nb_marques_sans_delai > 0 dans le résultat, ajouter EN FIN DE RÉPONSE : "⚠️ [nb] marque(s) sans délai fournisseur configuré — configurer les délais dans Paramètres améliorerait la précision des recommandations." JAMAIS omettre cette note si nb_marques_sans_delai > 0.
- TERMES DE PAIEMENT / ESCOMPTES : pour toute question sur les escomptes fournisseur, les termes de paiement, "devrais-je payer [marque] rapidement", "est-ce rentable de prendre l'escompte", "quel est le rendement de l'escompte", "quelle marque a les meilleurs termes" → utiliser get_payment_terms_analysis. Si le résultat contient termes_non_configures=true : le DIRE explicitement — JAMAIS inventer un escompte ou supposer que les termes sont standard.

GUIDE DES SECTIONS DE L'APPLICATION
${Object.values(HELP_CONTENT.fr).map(s =>
  `### ${s.icon} ${s.title}\n${s.summary}\n${s.sections.map(sec => `**${sec.heading}**\n${sec.body}`).join('\\n\\n')}`
).join('\\n\\n---\\n\\n')}
`;
}

const SYSTEM_PROMPT = buildSystemPrompt();

// ---------------------------------------------------------------------------
// Shared SSE stream parser for OpenAI-compatible APIs (Mistral + OpenAI)
// ---------------------------------------------------------------------------
async function _parseOpenAIStream(res, onToken) {
  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', content = '', toolCalls = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n'); buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (raw === '[DONE]') continue;
      try {
        const chunk = JSON.parse(raw);
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content)     { content += delta.content; onToken(delta.content); }
        if (delta.tool_calls)  {
          for (const tc of delta.tool_calls) {
            const i = tc.index ?? 0;
            if (!toolCalls[i]) toolCalls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
            if (tc.id)                    toolCalls[i].id += tc.id;
            if (tc.function?.name)        toolCalls[i].function.name += tc.function.name;
            if (tc.function?.arguments)   toolCalls[i].function.arguments += tc.function.arguments;
          }
        }
      } catch {}
    }
  }
  const message = { role: 'assistant', content: content || null, tool_calls: toolCalls.length ? toolCalls : undefined };
  return { message, tool_calls: toolCalls, content };
}

// ---------------------------------------------------------------------------
// Mistral Provider
// Compatible avec: api.mistral.ai ET tout serveur OpenAI-compatible (vLLM, Ollama)
// Pour self-host: MISTRAL_BASE_URL=http://votre-serveur:8000/v1
// ---------------------------------------------------------------------------
class MistralProvider {
  constructor() {
    this.apiKey  = process.env.MISTRAL_API_KEY ?? '';
    this.baseUrl = (process.env.MISTRAL_BASE_URL ?? 'https://api.mistral.ai/v1').replace(/\/$/, '');
    this.model   = process.env.AI_MODEL ?? 'mistral-small-latest';
  }

  async complete(messages, attempt = 0) {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model:       this.model,
        messages,
        tools:       TOOL_DEFS.map(t => ({ type: 'function', function: t })),
        tool_choice: 'auto',
        temperature: 0.2,
      }),
    });
    if (res.status === 429 && attempt < 3) {
      const wait = (attempt + 1) * 2000;
      await new Promise(r => setTimeout(r, wait));
      return this.complete(messages, attempt + 1);
    }
    if (!res.ok) throw new Error(`Mistral ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const msg  = data.choices[0].message;
    return { message: msg, tool_calls: msg.tool_calls ?? [], content: msg.content ?? '' };
  }

  async stream(messages, onToken, { noTools = false } = {}) {
    const body = {
      model: this.model, messages, temperature: 0.2, stream: true,
    };
    if (!noTools) {
      body.tools = TOOL_DEFS.map(t => ({ type: 'function', function: t }));
      body.tool_choice = 'auto';
    }
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Mistral ${res.status}: ${await res.text()}`);
    return _parseOpenAIStream(res, onToken);
  }
}

// ---------------------------------------------------------------------------
// OpenAI Provider
// Identique à Mistral côté format — swap quasi transparent
// Pour basculer: AI_PROVIDER=openai OPENAI_API_KEY=sk-...
// ---------------------------------------------------------------------------
class OpenAIProvider {
  constructor() {
    this.apiKey  = process.env.OPENAI_API_KEY ?? '';
    this.baseUrl = (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.model   = process.env.AI_MODEL ?? 'gpt-4o-mini';
  }

  async complete(messages) {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model:       this.model,
        messages,
        tools:       TOOL_DEFS.map(t => ({ type: 'function', function: t })),
        tool_choice: 'auto',
        temperature: 0.2,
      }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const msg  = data.choices[0].message;
    return { message: msg, tool_calls: msg.tool_calls ?? [], content: msg.content ?? '' };
  }

  async stream(messages, onToken, { noTools = false } = {}) {
    const body = {
      model: this.model, messages, temperature: 0.2, stream: true,
    };
    if (!noTools) {
      body.tools = TOOL_DEFS.map(t => ({ type: 'function', function: t }));
      body.tool_choice = 'auto';
    }
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
    return _parseOpenAIStream(res, onToken);
  }
}

// ---------------------------------------------------------------------------
// Anthropic Provider
// Format différent — la conversion est gérée ici, le reste du code reste unifié
// Pour basculer: AI_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-...
// ---------------------------------------------------------------------------
class AnthropicProvider {
  constructor() {
    this.apiKey = process.env.ANTHROPIC_API_KEY ?? '';
    this.model  = process.env.AI_MODEL ?? 'claude-haiku-4-5-20251001';
  }

  _toAnthropicMessages(messages) {
    const result = [];
    for (const m of messages) {
      if (m.role === 'system') continue;
      if (m.role === 'tool') {
        // Tool result → user message with tool_result block
        const last = result[result.length - 1];
        const block = { type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content };
        if (last?.role === 'user' && Array.isArray(last.content)) {
          last.content.push(block);
        } else {
          result.push({ role: 'user', content: [block] });
        }
      } else if (m.tool_calls?.length) {
        result.push({
          role:    'assistant',
          content: m.tool_calls.map(tc => ({
            type:  'tool_use',
            id:    tc.id,
            name:  tc.function.name,
            input: JSON.parse(tc.function.arguments),
          })),
        });
      } else {
        result.push({ role: m.role, content: m.content ?? '' });
      }
    }
    return result;
  }

  async complete(messages) {
    const systemMsg = messages.find(m => m.role === 'system');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      this.model,
        max_tokens: 4096,
        system:     systemMsg?.content ?? SYSTEM_PROMPT,
        messages:   this._toAnthropicMessages(messages),
        tools:      TOOL_DEFS.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })),
      }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
    const data       = await res.json();
    const toolUses   = data.content.filter(c => c.type === 'tool_use');
    const textBlocks = data.content.filter(c => c.type === 'text');
    const content    = textBlocks.map(c => c.text).join('');
    const tool_calls = toolUses.map(t => ({
      id:       t.id,
      type:     'function',
      function: { name: t.name, arguments: JSON.stringify(t.input) },
    }));
    const message = {
      role:       'assistant',
      content:    content || null,
      tool_calls: tool_calls.length ? tool_calls : undefined,
    };
    return { message, tool_calls, content };
  }

  async stream(messages, onToken) {
    const systemMsg = messages.find(m => m.role === 'system');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model, max_tokens: 4096,
        system: systemMsg?.content ?? SYSTEM_PROMPT,
        messages: this._toAnthropicMessages(messages),
        tools: TOOL_DEFS.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })),
        stream: true,
      }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', content = '', toolCalls = [], toolIdx = -1;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const ev = JSON.parse(line.slice(6));
          if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
            toolIdx++;
            toolCalls[toolIdx] = { id: ev.content_block.id, type: 'function', function: { name: ev.content_block.name, arguments: '' } };
          } else if (ev.type === 'content_block_delta') {
            if (ev.delta?.type === 'text_delta')       { content += ev.delta.text; onToken(ev.delta.text); }
            if (ev.delta?.type === 'input_json_delta' && toolIdx >= 0) toolCalls[toolIdx].function.arguments += ev.delta.partial_json;
          }
        } catch {}
      }
    }
    const message = { role: 'assistant', content: content || null, tool_calls: toolCalls.length ? toolCalls : undefined };
    return { message, tool_calls: toolCalls, content };
  }
}

// ---------------------------------------------------------------------------
// Factory — one env var to rule them all
// ---------------------------------------------------------------------------
function createProvider() {
  const name = (process.env.AI_PROVIDER ?? 'mistral').toLowerCase();
  switch (name) {
    case 'mistral':   return new MistralProvider();
    case 'openai':    return new OpenAIProvider();
    case 'anthropic': return new AnthropicProvider();
    default: throw new Error(
      `AI_PROVIDER="${name}" non reconnu. Valeurs supportées: mistral, openai, anthropic`
    );
  }
}

module.exports = { createProvider, TOOL_DEFS, SYSTEM_PROMPT, buildSystemPrompt };
