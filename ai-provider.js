'use strict';
const HELP = require('./help-content');
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
    description: 'Analyser les ventes par marque et/ou boutique sur une période donnée. Retourne les ventes brutes HT (prix de vente après escompte) et le coût des ventes. IMPORTANT: quand season est fourni, il filtre par le tag de la saison ET définit les dates — résultats limités aux articles de cette saison. Pour une marque spécifique (ex: "Oui"), TOUJOURS passer manufacturer. Sans manufacturer mais avec category : retourne le classement des marques dans cette catégorie. Sans manufacturer ni category : retourne le total de toutes les marques par boutique (chiffre global compagnie).',
    parameters: {
      type: 'object',
      properties: {
        period:       { type: 'string',  description: 'Période relative. Valeurs: "1y" "2y" "3y" "4y" "5y" "6m" "3m" "1m" "4w" "8w" "10w" "12w" "30d" "ytd" "last_year". Si season est fourni, omettre period pour utiliser les dates de la saison.' },
        season:       { type: 'string',  description: 'Code de saison (ex: p26, a25). Filtre par tag de saison ET définit la période de vente. Privilégier season plutôt que period pour les questions sur une saison.' },
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
        period:             { type: 'string', description: 'Période relative, ex: "1y", "2y", "ytd", "last_year", "6m"' },
        season:             { type: 'string', description: 'Code de saison (ex: p26, a25) — si la question porte sur une saison' },
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
      },
      required: [],
    },
  },
  {
    name: 'get_sellthrough_by_size',
    description: 'Calculer le sell-through (ST), les ventes et les unités reçues par variante pour une marque et une saison. Retourne vendu + stock restant + ST% par article. Utiliser pour: (1) top/flop tailles ("quelles tailles se vendent le mieux"), (2) comparer deux saisons, (3) décisions de réachat, (4) toute question sur les unités REÇUES ("avons-nous reçu plus?", "combien de reçus?") — reçus = vendu + stock restant.',
    parameters: {
      type: 'object',
      properties: {
        manufacturer: { type: 'string',  description: 'Nom de la marque' },
        size:         { type: 'string',  description: 'Taille à filtrer, ex: "15.5", "36", "L". Optionnel — omettre pour voir toutes les tailles.' },
        category:     { type: 'string',  description: 'Type de produit, ex: "Pantalon", "Chemise"' },
        genre:        { type: 'string',  description: '"Homme" ou "Femme"' },
        tags:         { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'Balises à inclure (AND) — produits ayant TOUS ces tags. Ex: ["p26", "consigne"].' },
        exclude_tags: { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'Balises à exclure (AND) — produits n\'ayant AUCUN de ces tags. Ex: ["nos", "solde"].' },
        season:       { type: 'string',  description: 'Code saison pour la période de vente, ex: "p26", "a25"' },
        shop_id:      { type: 'string',  description: 'ID boutique (optionnel)' },
        sort:         { type: 'string',  enum: ['st_desc', 'st_asc', 'sold_desc'], description: 'Tri: st_desc = meilleures performances, st_asc = pires performances (flop), sold_desc = plus vendu' },
        limit:        { type: 'integer', description: 'Nombre max de variantes (défaut: 50)' },
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
        season:       { type: 'string', description: 'Code de saison (ex: p26). Filtre par tag de saison ET définit la période.' },
        period:       { type: 'string', description: 'Période relative, ex: "1y", "ytd", "6m"' },
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

- Réponds TOUJOURS en français
- Sois BREF : 1 tableau ou 3-4 lignes max — jamais de blocs d'explication non demandés
- JAMAIS inventer un chiffre — toujours appeler un outil pour obtenir les données
- JAMAIS répondre à une question de suivi en puisant dans ta mémoire — toujours rappeler l'outil avec les bons filtres
- Si l'utilisateur dit que ton chiffre est faux : appelle IMMÉDIATEMENT l'outil à nouveau sans poser de questions
- Ne JAMAIS dire "vérifie tes données" ou proposer des choix quand l'utilisateur conteste un résultat
- TAILLES : si 0 résultat pour la taille demandée, réponds "0 unité" — JAMAIS substituer une autre taille
- REÇUS : utiliser get_sellthrough_by_size (reçus = vendu + stock restant) — jamais estimer depuis le stock seul
- DESCRIPTIONS : get_sellthrough_by_size retourne une ligne par variante avec sa description complète. JAMAIS agréger par taille ni résumer plusieurs lignes en une. JAMAIS inventer ou deviner des noms de modèles (ex: "Soffys", "Aminase") — utiliser uniquement les descriptions exactes retournées par l'outil.
- Quand tu affiches plusieurs boutiques, ajoute toujours une ligne TOTAL
- Formate les montants: $1 234,56 — les pourcentages: 67,3%
- Si tu n'es pas certain du nom exact d'une catégorie : appelle get_categories(manufacturer=X) d'abord
- COMPARAISONS INTER-SAISONS : pour toute question comparant plusieurs saisons ("P26 vs P25", "évolution sur 3 saisons", "croissance d'une saison à l'autre"), utiliser compare_seasons avec la liste des codes de saison dans "seasons"
- CATÉGORIES : pour toute question sur les ventes/répartition par TYPE DE PRODUIT ("quelle catégorie se vend le mieux?", "top catégories", "répartition par type de produit"), utiliser get_sales_by_category — JAMAIS get_sales_by_variant ni get_categories pour ces questions
- COLLECTIONS/MARQUES : en mode achat, "collection" désigne la gamme saisonnière d'une marque, PAS une catégorie de produit. "quelle collection se vend le mieux" = "quelle marque performe le mieux cette saison" → utiliser get_top_performers (metric="sold_cost") ou get_sales_analysis sans manufacturer. NE JAMAIS appeler get_sales_by_category pour une question qui contient le mot "collection".
- SUIVI PAR MOT UNIQUE : si l'utilisateur répond avec un seul mot comme "marque", "catégorie", "boutique", "saison" après une réponse précédente, interpréter comme "donne-moi le top [mot] avec les mêmes filtres boutique/saison/période que la question précédente" — appeler l'outil approprié avec ces filtres. NE PAS creuser dans un sous-résultat de la réponse précédente (ex: ne pas filtrer par la catégorie affichée dans la réponse d'avant).
- TRANSFERTS : pour toute question sur le stock dormant, les transferts recommandés ou "quoi bouger", utiliser get_transfer_recommendations — JAMAIS inventer une réponse
- NIVEAUX DE STOCK / VALEUR D'INVENTAIRE : pour toute question sur la valeur ou la quantité totale du stock ("quels sont mes stocks", "valeur totale de l'inventaire", "stock par boutique", "combien d'unités en stock", "quel était le stock le [date]"), utiliser get_inventory_at_date. Sans date précise = utiliser la date d'aujourd'hui (le tool trouve automatiquement le dernier snapshot). Retourne les VRAIS totaux dans le champ "totaux" — lire ce champ pour répondre, JAMAIS calculer ni inventer un total. Si l'outil retourne une erreur (aucun snapshot), le dire EXPLICITEMENT — JAMAIS estimer.
- LECTURE DES TRANSFERTS DANS LE SELL-THROUGH : le champ "stock_actuel" est EXCLUSIF des transferts sortants (les unités transférées ont déjà quitté la boutique et sont déduites de l'inventaire). Ne JAMAIS dire que le stock "inclut" des unités transférées. La formule est : reçu_fournisseur = vendu + stock_actuel + transferts_sortants − transferts_entrants. Présenter les transferts comme une ligne séparée, pas comme faisant partie du stock.
- MATRICES / TAILLES : pour voir toutes les tailles d'un modèle ou le stock par taille, utiliser get_matrix_info avec le code modèle (ex: "A45118") dans description_search
- TAGS : "tags" (tableau, max 10) filtre les produits qui ont TOUS les tags listés — logique AND. Ex: tags=["p26","consigne"] → uniquement les produits avec les deux tags. "exclude_tags" (tableau, max 10) exclut les produits ayant N'IMPORTE LEQUEL de ces tags. Ex: exclude_tags=["nos","solde"] → aucun NOS ni solde. Les deux paramètres sont combinables simultanément.
- PARSING DES TAGS : quand l'utilisateur dit "tager X", "tagé X", "tagué X", "avec le tag X", "avec la balise X", "tagged X", "with tag X", "labelled X", "étiquetté X" — extraire X comme tag et NE JAMAIS l'inclure dans le nom de la marque. Ex: "Part Two tager p26" → manufacturer="Part Two", tags=["p26"]. Ex: "Eton tagged p25 slim" → manufacturer="Eton", tags=["p25"], description_search="slim".
- QUESTIONS DE CLARIFICATION : UNE SEULE question, UNIQUEMENT si l'info manquante est BLOQUANTE. JAMAIS demander la couleur, la boutique ou la période.

GUIDE DES SECTIONS DE L’APPLICATION
${Object.values(HELP).map(s =>
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
