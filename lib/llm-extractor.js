'use strict';

// LLM-based supplier PO extractor — operator-triggered fallback when no
// parse_recipe matches an uploaded PDF. Reuses the same output shape
// runRecipe() produces so the rest of the pipeline (buildPreview,
// queue-processor, import_batches, import_order_lines) consumes both
// paths identically.
//
// Provider: Mistral Large (MISTRAL_API_KEY, currently provisioned).
// Anthropic support exists in ai-provider.js but no key is set on the
// project — switching provider is a matter of env vars + one URL swap
// here, no other code touches this decision.
//
// FEASIBILITY VALIDATED — see:
//   - /tmp/llm-feasibility.js  (3 non-covered PDFs → 3/3 parseable JSON)
//   - /tmp/llm-size-validation.js (Marc Cain column-shift caught by
//     max_size_mismatch_ratio via validateLlmSizes at 2% threshold)

const { extractWords, wordsToLines } = require('./parsers/generic-recipe');
const { extractExpectedSizes }       = require('./preview-generator');

const MISTRAL_API_URL = 'https://api.mistral.ai/v1/chat/completions';
const MISTRAL_MODEL   = process.env.LLM_EXTRACT_MODEL || 'mistral-large-latest';

class LlmExtractionError extends Error {
  constructor(message, { code, context } = {}) {
    super(message);
    this.name    = 'LlmExtractionError';
    this.code    = code || 'unknown';
    this.context = context || null;
  }
}

// Schema is documented in the system prompt AND validated post-response.
// Field names align with runRecipe() output so preview + queue processor
// consume both paths identically.
const SCHEMA_JSON = `{
  "file": {"supplier_name": "string|null", "target_manufacturer": "string|null"},
  "orders": [{
    "po_number": "string",
    "order_date": "string YYYY-MM-DD | null",
    "customer_reference": "string | null",
    "delivery_date": "string YYYY-MM-DD | null",
    "cancel_date": "string YYYY-MM-DD | null",
    "is_consignment": "boolean",
    "unit_count_declared": "integer | null",
    "amount_declared": "number | null"
  }],
  "products": [{
    "po_number": "string (mirrors an orders[].po_number)",
    "style_ref": "string",
    "description": "string | null",
    "color_code": "string | null",
    "color_label": "string | null",
    "unit_cost": "number | null",
    "retail_price": "number | null",
    "total_qty_declared": "integer | null",
    "variants": [{"size": "string", "qty": "integer >= 1"}]
  }]
}`;

function buildSystemPrompt(sizesHint) {
  const sizesConstraint = sizesHint?.length
    ? `\n\nTAILLES VALIDES DÉTECTÉES DANS CE DOCUMENT (dans l'ordre d'apparition, respecte ces libellés exacts) :\n${JSON.stringify(sizesHint)}\n\nCONTRAINTE STRICTE : chaque variants[].size que tu retournes DOIT provenir de cette liste. N'invente aucune taille et n'ajoute pas de tailles supplémentaires si le tableau source ne les contient pas.`
    : '';
  return `Tu es un extracteur de données de bons de commande fournisseurs. Retourne UNIQUEMENT un objet JSON valide conforme au schéma ci-dessous. Aucun texte hors JSON, aucun markdown.

SCHÉMA :
${SCHEMA_JSON}

RÈGLES :
- Sortie = JSON valide uniquement, parseable directement par JSON.parse.
- Champ absent du PDF → null (ne PAS inventer de valeurs).
- Dates → ISO YYYY-MM-DD si possible, null si format ambigu.
- Prix → nombres décimaux (ex. 12.50), pas de symbole monétaire.
- Un produit peut avoir plusieurs variantes tailles ; extraire chaque combinaison size+qty.
- Si le PDF contient plusieurs commandes distinctes (multi-PO), une entrée par commande dans orders[].
- Si aucun total déclaré n'est visible → unit_count_declared et amount_declared = null.
- Ne JAMAIS ajouter de commentaires ni de justifications.

VARIANTES OBLIGATOIRES — CHAQUE produit DOIT avoir au moins une variante :
- Si aucun tableau/ligne de tailles n'est présent pour ce produit (ex. accessoires "One Size" : chapeaux, écharpes, sacs, bijoux), crée une seule variante avec size="OS" et qty = total_qty_declared du produit.
- Ne laisse JAMAIS variants=[] : un produit sans variantes est perdu dans la synchronisation Lightspeed. Si tu n'arrives pas à extraire les tailles précises, tombe sur OS + qty totale plutôt que de retourner un tableau vide.
- La somme des qty de variants[] doit égaler total_qty_declared du produit. Si le total ne correspond pas, préfère ajouter une variante "OS" pour couvrir l'écart plutôt que d'omettre des unités.

COULEUR (color_label) — règle spéciale :
- Cherche d'abord la valeur dans une colonne couleur dédiée (Colour, Color, Couleur…).
- Si aucune colonne dédiée n'existe OU si la colonne est vide MAIS qu'un nom de couleur évident apparaît dans la description du produit ("Sweatshirt FUOCO Bow", "Bag NERO Camouflage", "Skirt SNOW WHITE Print", "Pant QUARTZ"…), extrais ce nom dans color_label EXACTEMENT tel qu'il apparaît (respecte la casse d'origine).
- Noms de couleur courants à reconnaître (liste non exhaustive) : Nero, Bianco, Rosso, Fuoco, Sienna, Natural, Snow White, Quartz, Denim, Grigio, Cammello, Ecru, Beige, Blu, Verde, Giallo, Rosa, Ottanio, Ottone, Ottavio, Cognac, Panna, Tabacco, Antracite, Marrone, Rubino, Zaffiro, Perla, Cielo, Sabbia.
- Si vraiment aucune couleur ne peut être identifiée → color_label = null (mais évite ce cas au maximum).${sizesConstraint}`;
}

async function callMistral(systemPrompt, userContent) {
  if (!process.env.MISTRAL_API_KEY) {
    throw new LlmExtractionError('MISTRAL_API_KEY not set', { code: 'no_api_key' });
  }
  const started = Date.now();
  const res = await fetch(MISTRAL_API_URL, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${process.env.MISTRAL_API_KEY}`,
    },
    body: JSON.stringify({
      model:           MISTRAL_MODEL,
      temperature:     0,
      response_format: { type: 'json_object' },
      max_tokens:      Number(process.env.LLM_EXTRACT_MAX_TOKENS) || 16000,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userContent },
      ],
    }),
  });
  const elapsedMs = Date.now() - started;
  if (!res.ok) {
    const body = await res.text();
    throw new LlmExtractionError(`Mistral HTTP ${res.status}: ${body.slice(0, 300)}`,
      { code: 'llm_provider_error', context: { status: res.status } });
  }
  const data = await res.json();
  const choice = data.choices?.[0];
  // Detect output-length truncation BEFORE JSON.parse chokes on an
  // unterminated string. finish_reason='length' means we hit max_tokens.
  if (choice?.finish_reason === 'length') {
    throw new LlmExtractionError(
      `LLM output truncated at ${data.usage?.completion_tokens} tokens (max_tokens limit reached). The PDF is too large for a single-pass extraction — try splitting it, or set LLM_EXTRACT_MAX_TOKENS higher.`,
      { code: 'llm_truncated', context: { usage: data.usage } });
  }
  return { text: choice?.message?.content ?? '', usage: data.usage, elapsedMs };
}

// Validate + normalise LLM output. Throws with a clear code on shape errors.
function normaliseLlmOutput(text) {
  let json;
  try { json = JSON.parse(text); }
  catch (e) {
    throw new LlmExtractionError(`LLM did not return valid JSON: ${e.message}`,
      { code: 'invalid_json', context: { snippet: text.slice(0, 200) } });
  }
  if (!json.orders || !Array.isArray(json.orders) || json.orders.length === 0) {
    throw new LlmExtractionError('LLM output has no orders',
      { code: 'no_orders_extracted' });
  }
  if (!json.products || !Array.isArray(json.products) || json.products.length === 0) {
    throw new LlmExtractionError('LLM output has no products',
      { code: 'no_products_extracted' });
  }
  // Coerce types
  for (const o of json.orders) {
    if (o.is_consignment == null) o.is_consignment = false;
    if (o.unit_count_declared != null) o.unit_count_declared = parseInt(o.unit_count_declared, 10);
    if (o.amount_declared     != null) o.amount_declared     = Number(o.amount_declared);
  }
  for (const p of json.products) {
    if (p.unit_cost          != null) p.unit_cost          = Number(p.unit_cost);
    if (p.retail_price       != null) p.retail_price       = Number(p.retail_price);
    if (p.total_qty_declared != null) p.total_qty_declared = parseInt(p.total_qty_declared, 10);
    if (Array.isArray(p.variants)) {
      p.variants = p.variants.filter(v => v.size != null && v.qty != null).map(v => ({
        size: String(v.size),
        qty:  parseInt(v.qty, 10),
      }));
    } else {
      p.variants = [];
    }
  }
  return json;
}

// Extract raw text from a PDF buffer using the same helpers the recipe path
// uses — one line per visual row, preserved order.
function pdfToRawText(pdfBuffer) {
  return extractWordsForText(pdfBuffer);
}
async function extractWordsForText(pdfBuffer) {
  const pages = await extractWords(pdfBuffer);
  return {
    pages,
    rawText: pages.map(p => `--- PAGE ${p.pageNum} ---\n` +
      wordsToLines(p.words).map(l => l.text).join('\n')).join('\n\n'),
  };
}

// Main entry point. Given a PDF buffer, returns a runRecipe-compatible
// output structure. The `_meta` field is added for auditing (tokens, cost,
// sizes hinted).
async function extractPdfWithLlm(pdfBuffer, { supplier_key = null, target_manufacturer = null } = {}) {
  const { pages, rawText } = await extractWordsForText(pdfBuffer);
  const detectedHeaders = extractExpectedSizes(rawText);
  const sizesHint = [...new Set(detectedHeaders.flatMap(h => h.sizes))]
    .map(String).sort();

  const systemPrompt = buildSystemPrompt(sizesHint);
  const userContent  = `Extrait les données de ce bon de commande. Contenu brut :\n\n${rawText}`;

  const { text, usage, elapsedMs } = await callMistral(systemPrompt, userContent);
  const llmJson = normaliseLlmOutput(text);

  // Shape output like runRecipe() so downstream code consumes both paths identically
  const declared_units_total  = llmJson.orders.reduce((s, o) => s + (o.unit_count_declared || 0), 0);
  const declared_amount_total = llmJson.orders.reduce((s, o) => s + Number(o.amount_declared || 0), 0);

  return {
    file: {
      supplier_key:             supplier_key || llmJson.file?.supplier_name || 'llm-extracted',
      target_manufacturer:      target_manufacturer || llmJson.file?.target_manufacturer || null,
      customer_name:            null,
      default_vendor_id:        null,
      default_attribute_set_id: '5',
    },
    orders:   llmJson.orders,
    products: llmJson.products,
    warnings: [],
    declared_totals: {
      totalUnits:  declared_units_total,
      totalAmount: declared_amount_total,
      orders:      [],
    },
    _meta: {
      extraction_source: 'llm',
      llm_model:         MISTRAL_MODEL,
      llm_usage:         usage,
      elapsed_ms:        elapsedMs,
      sizes_hinted:      sizesHint,
      pages_extracted:   pages.length,
    },
    _rawText: rawText,
  };
}

module.exports = {
  extractPdfWithLlm,
  extractWordsForText,
  LlmExtractionError,
};
