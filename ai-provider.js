'use strict';
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
        shops:  { type: 'string', description: 'IDs de boutiques séparés par virgules (optionnel), ex: "1,2,5"' },
        limit:  { type: 'integer', description: 'Nombre maximum de marques à retourner (défaut: 20)' },
      },
      required: ['season'],
    },
  },
  {
    name: 'get_sales_analysis',
    description: 'Analyser les ventes par marque et/ou boutique sur une période donnée. Retourne les ventes brutes HT (prix de vente après escompte) et le coût des ventes. Pour les totaux compagnie (toutes marques), utilise total_only=true — sinon la requête est limitée aux 50 premiers résultats.',
    parameters: {
      type: 'object',
      properties: {
        period:       { type: 'string',  description: 'OBLIGATOIRE pour toute période relative. Valeurs: "1y" "2y" "3y" "4y" "5y" "6m" "3m" "1m" "4w" "8w" "10w" "12w" "30d" "ytd" "last_year". Ex: "4 dernières années" → "4y", "10 dernières semaines" → "10w", "cette année" → "ytd"' },
        season:       { type: 'string',  description: 'Code de saison (ex: p26, a25) — seulement si la question porte sur une saison nommée' },
        manufacturer: { type: 'string',  description: 'Nom de la marque (optionnel)' },
        shop_id:      { type: 'string',  description: 'ID de la boutique (optionnel)' },
        total_only:   { type: 'boolean', description: 'true pour total toutes marques par boutique (ventes globales compagnie)' },
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
        shops:  { type: 'string',  description: 'Filtre boutiques (optionnel)' },
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
        tag:                { type: 'string', description: 'N\'importe quelle balise produit Lightspeed, ex: "p26", "a25", "consigne", "nos", "solde". Filtre les produits qui ONT cette balise. Pour exclure une balise, utiliser exclude_tag.' },
        exclude_tag:        { type: 'string', description: 'Exclure les produits qui ont cette balise. Ex: "consigne" pour exclure les consignes, "nos" pour exclure les permanents.' },
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
        tag:                { type: 'string',  description: 'N\'importe quelle balise produit Lightspeed, ex: "p26", "a25", "consigne", "nos". Filtre les produits qui ONT cette balise.' },
        exclude_tag:        { type: 'string',  description: 'Exclure les produits qui ont cette balise. Ex: "consigne" pour exclure les consignes.' },
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
        tag:          { type: 'string',  description: 'N\'importe quelle balise produit Lightspeed, ex: "p26", "a25", "consigne", "nos". Filtre les produits qui ONT cette balise.' },
        exclude_tag:  { type: 'string',  description: 'Exclure les produits qui ont cette balise. Ex: "consigne" pour exclure les consignes, "nos" pour exclure les permanents.' },
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

BOUTIQUES : utilise get_shops_list() si tu as besoin des IDs exacts.

RÈGLES ABSOLUES
- Réponds TOUJOURS en français
- Sois BREF : 1 tableau ou 3-4 lignes max — jamais de blocs d'explication non demandés
- JAMAIS inventer un chiffre — toujours appeler un outil pour obtenir les données
- JAMAIS répondre à une question de suivi en puisant dans ta mémoire — toujours rappeler l'outil avec les bons filtres
- Si l'utilisateur dit que ton chiffre est faux : appelle IMMÉDIATEMENT l'outil à nouveau sans poser de questions
- Ne JAMAIS dire "vérifie tes données" ou proposer des choix quand l'utilisateur conteste un résultat
- TAILLES : si 0 résultat pour la taille demandée, réponds "0 unité" — JAMAIS substituer une autre taille
- REÇUS : utiliser get_sellthrough_by_size (reçus = vendu + stock restant) — jamais estimer depuis le stock seul
- Quand tu affiches plusieurs boutiques, ajoute toujours une ligne TOTAL
- Formate les montants: $1 234,56 — les pourcentages: 67,3%
- Si tu n'es pas certain du nom exact d'une catégorie : appelle get_categories(manufacturer=X) d'abord
- TRANSFERTS : pour toute question sur le stock dormant, les transferts recommandés ou "quoi bouger", utiliser get_transfer_recommendations — JAMAIS inventer une réponse
- MATRICES / TAILLES : pour voir toutes les tailles d'un modèle ou le stock par taille, utiliser get_matrix_info avec le code modèle (ex: "A45118") dans description_search
- TAGS : le paramètre "tag" filtre les produits QUI ONT ce tag (ex: tag="consigne" → uniquement les consignes). Le paramètre "exclude_tag" filtre les produits QUI N'ONT PAS ce tag (ex: exclude_tag="consigne" → tout sauf les consignes). Utiliser pour n'importe quel tag Lightspeed : saisons (p26, a25), types (consigne, nos, solde), etc.
- QUESTIONS DE CLARIFICATION : UNE SEULE question, UNIQUEMENT si l'info manquante est BLOQUANTE. JAMAIS demander la couleur, la boutique ou la période.`;
}

const SYSTEM_PROMPT = buildSystemPrompt();

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
    // Convert back to OpenAI-style message so the agentic loop stays unified
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
