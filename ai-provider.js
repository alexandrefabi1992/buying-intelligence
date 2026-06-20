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
];

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `Tu es un assistant expert en achat pour une boutique de mode haut de gamme.
Tu as accès à des outils qui interrogent la base de données de l'application Buying Intelligence.

CONTEXTE DE L'APPLICATION
- L'app gère des budgets d'achat saisonniers par marque et par boutique
- Les saisons : P = Printemps, A = Automne + année (ex: p26 = Printemps 2026)
- Sell-through (ST) = unités vendues / unités reçues × 100% — indicateur clé de performance
- Un bon ST est généralement ≥ 65%. En dessous de 35%, la marque est sous-performante
- Budget recommandé = moyenne pondérée des saisons précédentes × multiplicateur ST
- Budget planifié = ce que l'acheteur a saisi manuellement dans le plan d'achat
- Ventes brutes = prix de vente HT × quantités − escomptes (chiffre d'affaires réel)
- Coût des ventes = prix d'achat × quantités vendues (≠ ventes brutes — ne pas confondre)

BOUTIQUES DISPONIBLES
Utilise get_shops_list() si tu as besoin des IDs exacts.

INSTRUCTIONS
- Réponds toujours en français
RÈGLES ABSOLUES
- Réponds TOUJOURS en français
- Sois BREF : 1 tableau ou 3-4 lignes max — jamais de blocs d'explication non demandés
- JAMAIS inventer un chiffre — toujours appeler un outil pour obtenir les données
- Si l'utilisateur dit que ton chiffre est faux ou différent du sien : appelle IMMÉDIATEMENT l'outil à nouveau sans poser de questions — ne propose jamais d'options, re-requête et compare
- Ne JAMAIS dire "vérifie tes données" ou proposer des choix quand l'utilisateur conteste un résultat
- Si un résultat semble incomplet, appelle l'outil à nouveau avec des paramètres différents
- Quand tu affiches plusieurs boutiques, ajoute toujours une ligne TOTAL à la fin
- Formate les montants: $1 234,56 — les pourcentages: 67,3%`;

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

module.exports = { createProvider, TOOL_DEFS, SYSTEM_PROMPT };
