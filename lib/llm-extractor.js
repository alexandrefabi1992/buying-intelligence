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

AMOUNT_DECLARED — règle critique (pré-taxes) :
- amount_declared DOIT être le SOUS-TOTAL PRÉ-TAXES (subtotal, sous-total, avant taxes, "Merchandise Total", "Total avant taxes", "Sous-total marchandise", "Amount before tax", etc.).
- Ne PAS utiliser le "Grand Total" / "Total TTC" / "Total incl. tax" / "Balance Due" qui inclut les taxes (TPS+TVQ = ~15% au Canada, VAT en Europe, etc.).
- Si le PDF affiche à la fois un sous-total et un total TTC (souvent à côté d'une ligne "TPS", "TVQ", "GST", "HST", "VAT", "Tax") : PRENDRE le sous-total, IGNORER le total TTC.
- Si seul un total est visible sans mention de taxes → prendre ce total tel quel (probablement pré-taxes déjà).
- Cette valeur sera comparée à la somme des unit_cost × qty. Un mismatch ~13-15% signale un total TTC extrait par erreur.

VARIANTES OBLIGATOIRES — CHAQUE produit DOIT avoir au moins une variante :
- Si aucun tableau/ligne de tailles n'est présent pour ce produit (ex. accessoires "One Size" : chapeaux, écharpes, sacs, bijoux), crée une seule variante avec size="OS" et qty = total_qty_declared du produit.
- Ne laisse JAMAIS variants=[] : un produit sans variantes est perdu dans la synchronisation Lightspeed. Si tu n'arrives pas à extraire les tailles précises, tombe sur OS + qty totale plutôt que de retourner un tableau vide.
- La somme des qty de variants[] doit égaler total_qty_declared du produit. Si le total ne correspond pas, préfère ajouter une variante "OS" pour couvrir l'écart plutôt que d'omettre des unités.

PREPACKS / ASSORTIMENTS — règle critique :
- Si la description du produit contient "Prepack N", "PACK N", "PP N", "Assortment", "Asst", "Sortiment", ou tout autre marqueur indiquant un pré-assortiment fermé (une seule SKU vendue avec plusieurs tailles pré-emballées ensemble) :
  - Le produit est vendu comme 1 unité par pack commandé, PAS N unités individuelles.
  - total_qty_declared = nombre de packs commandés (voir la colonne "Cmdé"/"Qty" — typiquement 1, 2, 3…).
  - variants[] = UNE seule variante avec size="OS" (ou "Prepack") et qty = total_qty_declared.
  - N'extrait PAS les tailles individuelles listées à l'intérieur du pack (S/M/L/XL etc. font partie de la composition du pack, pas des SKU distinctes).
- Comment reconnaître un prepack : la colonne "Cmdé" affiche un nombre bas (souvent 1) alors qu'un tableau de tailles listé sous le produit contient plusieurs quantités individuelles totalisant beaucoup plus. Contradiction = c'est un prepack.
- Exemple : "Nuluca Socks Prepack 6 Multi" avec Cmdé=1 mais sizes "1 1 1 1 1 1" listées sous — c'est 1 pack de 6 socks, PAS 6 socks individuels. Donc variants=[{size:"OS",qty:1}], pas 6 variants.

ANNOTATIONS SIZE_MAP — SOURCE DE VÉRITÉ POUR L'ALIGNEMENT TAILLES/QTY :
- Certaines lignes du texte brut sont annotées avec [SIZE_MAP: TAILLE=QTY TAILLE=QTY ...] à la fin. Ces annotations sont calculées à partir des coordonnées PDF réelles — elles donnent EXACTEMENT quelles tailles correspondent aux quantités sur cette ligne.
- Quand tu vois un [SIZE_MAP: ...] sur la ligne de qty d'un produit, tu DOIS copier ces paires size=qty telles quelles dans variants[]. Ne recompte pas, ne devine pas, ne shift pas de colonne — l'annotation est la vérité.
- Exemple : ligne "1 1 1 1 1 1   [SIZE_MAP: 40=1 41=1 42=1 43=1 44=1 45=1]" → variants = [{size:"40",qty:1},{size:"41",qty:1},{size:"42",qty:1},{size:"43",qty:1},{size:"44",qty:1},{size:"45",qty:1}].
- S'il n'y a pas de [SIZE_MAP] annoté (ex. le PDF a des tailles ambiguës, colonnes manquantes), fais du mieux avec les headers visibles au-dessus. Mais si l'annotation est là, elle prime sur ta propre interprétation.

SIZES SONT DES LIBELLÉS DU HEADER, JAMAIS DES INDICES NUMÉRIQUES :
- Chaque size dans variants[] DOIT être un libellé RÉEL présent dans le header de tailles du PDF au-dessus du produit (ex : XS, S, M, L, XL, XXL, ou 30, 31, 32, 40, 42, 44, ou OS, U, TU).
- NE JAMAIS retourner size="1", "2", "3" comme si c'étaient des indices de position. Ces nombres sont des POSITIONS/INDICES, pas des tailles.
- Si tu as N quantités par taille mais tu ne sais pas dans quelles colonnes du header elles se placent : utilise les N PREMIÈRES tailles du header applicable (alignement à gauche par défaut).
- Exception : Si le fournisseur utilise vraiment des tailles numériques (ex : Marc Cain avec sizes 1-7 comme tailles réelles, confirmé par le header), alors 1/2/3 sont valides. Le critère : est-ce que ces valeurs apparaissent dans un header de tailles clairement identifié ? Si oui = valide, si non = invalide.

STRUCTURE DE LIGNE PRODUIT AVEC QTY INLINE (Liu Jo pattern) :
- Certains formats mettent tout sur une ligne : STYLE MODEL Description ColorCode qty1 qty2 ... qtyN TOTAL Date1 Date2 $prix1 $prix2 ...
- Règle : parmi les nombres entre le colorCode et la première date, le DERNIER est TOUJOURS le TOTAL. Tous les autres sont les quantités PAR TAILLE.
- Exemple : "T972A Coat Quartz 71510 1 1 2 2026-12-01 ..." → 2 quantités par taille (1 et 1) + total 2 → variants = 2 items qty=1.
- Assigne aux 2 PREMIÈRES tailles du header le plus proche au-dessus (S et M si header = XXS XS S M L XL XXL et 2 tailles ordered).
- Si le header a XXS XS S M L XL XXL et tu as 2 qtys : utilise S, M (les tailles centrales les plus commandées) OU les 2 premières positions selon l'alignement visuel. Ne jamais utiliser 1, 2 comme sizes.

FORMAT DES PETITS HAUTS (DPH) — MÊME TEMPLATE QUE LIU JO + PRÉFIXE "T" POUR SIZES + STYLE COMPOSÉ :
- Reconnaissance : target_manufacturer = "Des Petits Hauts" (ou "DPH"). Layout PDF identique au format Liu Jo (colonnes Marque | Style 1 | Style 2 | Description | Couleur | Quantités | Qté | dates | prix).
- Le "Style 2" est le plus souvent vide chez DPH.

Extraction spécifique DPH :
- style_ref = DESCRIPTION + " " + STYLE 1 (concatenation dans cet ordre). Ex :
  * Row "1H240648 PAULA OURS/LUPIN 2 2 ..." → style_ref = "PAULA 1H240648"
  * Row "1H240012 CELESTIN BOUTONNE 1 1 1 1 4 ..." → style_ref = "CELESTIN BOUTONNE 1H240012"
- description = juste la partie descriptive (ex : "PAULA", "CELESTIN BOUTONNE"). Peut être dupliquée entre style_ref et description, c'est voulu.
- color_label = valeur colonne Couleur.
  * Wrap : la couleur peut apparaître sur une LIGNE ISOLÉE entre deux rows (parce que trop longue pour la colonne). Ex : après row CELESTIN BOUTONNE, "NOIR" apparaît sur sa propre ligne — cette couleur appartient au ROW CELESTIN BOUTONNE ci-dessus (qui n'a pas de couleur inline). Idem pour "QUARTZ" qui appartient à la row CESAR BOUTONNE juste au-dessus.
- Sizes numériques DPH : header "0 1 2 3 4" → SORTIE sizes préfixées "T" :
  * Header "0" → size="T0"
  * Header "1" → size="T1"
  * ... "4" → size="T4"
  * Row qty "1 1 1 3" avec header "0 1 2 3 4" (5 tailles, 3 qtys+total) → 3 variantes qty=1 sizes alignées positionnellement (ex : "T1", "T2", "T3" si centrées, ou "T0", "T1", "T2" si à gauche — regarde le padding pour décider).
- Header "OS" pour accessoires : size="OS" (sans préfixe T), routing single-attr couleur-seule.
- Ordre des prix : 1er = coût wholesale, 2e = retail, 3e = extension coût, 4e = extension retail. Extract unit_cost = 1er, retail_price = 2e.

FORMAT BUGATCHI — KEY: VALUE STRUCTURE :
- Structure d'un produit sur 5 lignes bien étiquetées :
  * Ligne 1 : "DESCRIPTION   CA$UNIT_PRICE   TOTAL_QTY   CA$EXTENSION"
    ex : "FASHION MERCERIZED SOCKS   CA$11.50   3   CA$34.50"
  * Ligne 2 : "Season spring / summer 2027" (info saison, ignorer — season_tag vient du contexte)
  * Ligne 3 : "Style #: LB1006"
  * Ligne 4 : "Color: NAVY"
  * Ligne 5 : "Sizes: TAILLE: QTY[, TAILLE: QTY, ...]"
    ex : "Sizes: ONE: 3"  ou  "Sizes: S: 2, M: 3, L: 1"
- Extraction :
  * description = début de ligne 1, avant "CA$" (ex : "FASHION MERCERIZED SOCKS")
  * unit_cost = 1er "CA$XX.XX" de ligne 1 (ex : 11.50)
  * total_qty_declared = nombre entre les 2 "CA$" de ligne 1 (ex : 3)
  * style_ref = après "Style #: " (ex : "LB1006")
  * color_label = après "Color: " (ex : "NAVY"). Pas de color_code séparé pour Bugatchi — laisse color_code=null.
  * Parse "Sizes: X: qty[, Y: qty2, ...]" en autant de variantes que de paires.
- NORMALISATION CRITIQUE : la taille "ONE" (Bugatchi socks/accessoires) DOIT être normalisée à "OS" en sortie. size="OS" (pas "ONE"). Cette convention active le routing vers attribute_set couleur-seule côté Lightspeed (pas de dimension taille fantôme).
- retail_price : PAS présent dans les PDF Bugatchi (juste wholesale). Laisse retail_price=null.
- amount_declared : "Total Price: CA$862.50" en haut du document. unit_count_declared : "Total Units: 75" en haut aussi.
- PO number : après "Order#: " (ex : "309037143") — utilise ça comme po_number.

FORMAT PATRICK ASSARAF (PYA) — DESCRIPTION AU-DESSUS DU STYLE, MULTI-COULEURS :
- Structure d'un produit sur PLUSIEURS lignes :
  * Ligne 1 : nom du produit (description) — ex "SS ICONIC PIMA COTTON STRETCH CREW TSHIRT"
  * Ligne 2 : "Style #CODE | COLLECTION   Wholesale: CAD XX.XX  Sugg. Retail: CAD YY.YY"
  * Ligne 3-4 : header "Colors ... XS S M L XL XXL 3XL Qty"
  * Lignes couleurs : "NOM_COULEUR CODE   qty qty qty   TOTAL  CAD EXTENSION"
  * Ligne totaux (optionnelle) : "0 0 8 8 8 0 0 24 Total 768.00" — grand total par taille + total commande
- Extraction :
  * style_ref = code après "Style #" JUSQU'AU "|" (ex : "99A08CB", "P144C23D", "P152B11D"). NE PAS inclure le "|" ni la collection.
  * description = LIGNE AU-DESSUS du "Style #" (ex : "SS ICONIC PIMA COTTON STRETCH CREW TSHIRT"). PAS "PATRICK ASSARAF SPRING 2027" (c'est la collection, ignorer).
  * unit_cost = nombre après "Wholesale: CAD " (ex : 32.00)
  * retail_price = nombre après "Sugg. Retail: CAD " (ex : 79.00)
  * Sur chaque ligne couleur : color_label = mot(s) texte au début (ex : "HARBOUR", "MAUVE MORN", "OYSTER MUSHROOM"), color_code = nombre juste après (ex : "473", "518").
  * total_qty_declared = nombre juste avant "CAD" à la fin de la ligne couleur.
- Sizes : header varie par produit (7 tailles "XS S M L XL XXL 3XL" ou 6 tailles "S M L XL XXL 3XL"). Utilise le header LOCAL à ce produit (juste au-dessus).
- IMPORTANT : "3XL" est une taille littérale — extrait "3XL" pas "XXXL".
- Ligne totaux "0 0 8 8 8 0 0 24 Total 768.00" à la fin d'un produit : c'est la somme par-taille + grand-total, IGNORER pour l'extraction des variantes (déjà comptées ligne par couleur).
- Chaque couleur = 1 entrée produit distincte (comme Brax/Fradi). Un style avec 4 couleurs = 4 entrées dans products[].

FORMAT MEYER — SÉPARATEUR "/" DANS LE CODE PRODUIT :
- Certains fournisseurs (Meyer, parfois Brax) affichent le code produit sous la forme "ARTICLE / COLOR_CODE" avec des espaces autour du "/". Exemples : "2-3615 / 19", "9-629 / 20", "2-5628 / 07".
- Le "/" sépare TOUJOURS l'article du code couleur. NE PAS les fusionner dans style_ref.
- Extraction correcte :
  * style_ref = "2-3615" (partie AVANT le "/", sans le "/")
  * color_code = "19" (partie APRÈS le "/")
  * color_label = MÊME valeur que color_code quand aucun nom de couleur textuel n'est disponible (Meyer donne juste des codes numériques). Ex : color_label="19", color_code="19".
  * description = les derniers mots-texte de la même ligne (ex : "BONN", "ROMA", "DUBLIN") — c'est le nom du modèle Meyer
- Ne pas mettre "2-3615/19" comme style_ref, ni "2-3615 / 19", ni "2-3615/BONN". Just "2-3615".
- CRITIQUE : color_label DOIT être rempli (avec le code numérique à défaut), sinon plusieurs commandes du même style avec couleurs différentes seront fusionnées à tort en un seul produit.

FORMAT MARC CAIN — HEADER SIZES NUMÉRIQUE + PRÉFIXE "N" OBLIGATOIRE :
- Marc Cain utilise un tableau de tailles avec header "1 2 3 4 5 6 7" (positions numériques). Ces valeurs SONT de vraies tailles Marc Cain, pas des indices.
- Convention Marc Cain pour Lightspeed : chaque taille DOIT être préfixée par "N" en sortie.
  * Header PDF "1 2 3 4 5 6 7" → sortie sizes : "N1", "N2", "N3", "N4", "N5", "N6", "N7".
  * Ne PAS retourner size="1" — TOUJOURS "N1". Idem pour N2 à N7.
- Le "-" (tiret) dans une colonne signifie AUCUNE quantité pour cette taille — ne pas créer de variante (pas qty=0).
- Colonne "col" (numérique, ex : "223", "112") = code couleur — mêmes règles que Meyer (color_code = "223", color_label = "223" par défaut).
- Colonne "SL" (généralement "N") = flag interne Marc Cain — IGNORER, ne pas mapper vers un champ.
- Colonnes "PP" = wholesale/coût (unit_cost). "RRP" = retail_price. "total price" = extension (qty × unit_cost).
- Exemple : row "AC 21.40 W503 dress 223 N 1 1 1 1 - - - 4 235.40 565.00 941.60" →
  * style_ref="AC 21.40 W503", description="dress", color_label="223", color_code="223"
  * variants=[{size:"N1",qty:1},{size:"N2",qty:1},{size:"N3",qty:1},{size:"N4",qty:1}] (4 variantes, pas 7)
  * unit_cost=235.40, retail_price=565.00, total_qty_declared=4

FORMAT MEYER — SIZES "QTY*SIZE" AVEC ASTÉRISQUE :
- Si les tailles sont formatées "QTY*SIZE" (ex : "1*50", "1*52", "1*54", "1*56", "1*58", "1*60"), chaque token EST une variante complète.
- Splitte sur "*" : la partie AVANT est la quantité, la partie APRÈS est la taille.
- Exemple : "1*50 1*52 1*54 1*56 1*58 1*60" → 6 variants = [{size:"50",qty:1},{size:"52",qty:1},{size:"54",qty:1},{size:"56",qty:1},{size:"58",qty:1},{size:"60",qty:1}].
- NE PAS prendre "1*50" comme size littéral. TOUJOURS splitter.

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
// uses — one line per visual row. Additionally reconstructs approximate
// column alignment via x-coordinates so a size header line like
//   "XXS XS S M L XL XXL XXXL XXXXL"
// and a partial qty line like
//   "1 1 1"
// become
//   "XXS  XS  S    M    L    XL   XXL  XXXL XXXXL"
//   "1    1   1"
// giving the LLM enough spatial info to align quantities to size columns
// (a critical need for the many suppliers that don't fill every column).
function pdfToRawText(pdfBuffer) {
  return extractWordsForText(pdfBuffer);
}

// Reconstitute a positional string from a line's words. `unit` is the number
// of PDF x-units per output character — calibrated per-page from typical
// character widths. Words never overlap: if two are too close to align on a
// column boundary, we fall back to a single-space separator.
function wordsToPaddedLine(words, unit) {
  if (!words.length) return '';
  const sorted = [...words].sort((a, b) => a.x0 - b.x0);
  let out = '';
  for (const w of sorted) {
    const targetCol = Math.max(0, Math.round(w.x0 / unit));
    // Ensure at least one space between adjacent tokens
    const minCol = out.length === 0 ? targetCol : Math.max(targetCol, out.length + 1);
    while (out.length < minCol) out += ' ';
    out += w.text;
  }
  return out.trimEnd();
}

// Detect if a line's words form a size-header run (≥3 contiguous distinct
// size-like tokens). Returns the run of size words with their x-positions,
// or null if not a header.
const SIZE_TOKEN_RE = /^(?:\d{1,3}(?:\.\d+)?|XXS|XS|S|M|L|XL|XXL|XXXL|XXXXL|OS|ONE|U|TU|UNI)$/i;
const QTY_TOKEN_RE  = /^(?:\d{1,2})$/;

function detectSizeHeaderInWords(words) {
  const tokens = [...words].sort((a, b) => a.x0 - b.x0);
  if (tokens.length < 3) return null;
  let bestStart = -1, bestLen = 0, curStart = -1, curLen = 0;
  for (let j = 0; j < tokens.length; j++) {
    if (SIZE_TOKEN_RE.test(tokens[j].text)) {
      if (curStart === -1) curStart = j;
      curLen++;
      if (curLen > bestLen) { bestStart = curStart; bestLen = curLen; }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }
  if (bestLen < 3) return null;
  const run = tokens.slice(bestStart, bestStart + bestLen);
  const uniqueVals = new Set(run.map(w => String(w.text).toLowerCase()));
  if (uniqueVals.size < 3) return null; // reject monotonous runs (qty rows)
  return run.map(w => ({ text: w.text, xCenter: (w.x0 + w.x1) / 2 }));
}

// Given a line's words, if they are all pure quantities (small integers),
// return them sorted by x. Otherwise null.
function detectQtyOnlyLine(words) {
  if (!words.length) return null;
  for (const w of words) if (!QTY_TOKEN_RE.test(w.text)) return null;
  return [...words]
    .sort((a, b) => a.x0 - b.x0)
    .map(w => ({ text: w.text, xCenter: (w.x0 + w.x1) / 2 }));
}

// For each qty word, find the size header column it aligns with (nearest
// x-center). Returns [{size, qty}] pairs. If a qty aligns to a size already
// used, we still emit the mapping — the LLM will see duplicates and decide.
function mapQtysToSizes(headerCols, qtyWords) {
  const pairs = [];
  for (const qw of qtyWords) {
    let bestIdx = 0, bestDist = Infinity;
    for (let i = 0; i < headerCols.length; i++) {
      const d = Math.abs(headerCols[i].xCenter - qw.xCenter);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    pairs.push({ size: headerCols[bestIdx].text, qty: parseInt(qw.text, 10) });
  }
  return pairs;
}

async function extractWordsForText(pdfBuffer) {
  const pages = await extractWords(pdfBuffer);
  return {
    pages,
    rawText: pages.map(p => {
      const lines = wordsToLines(p.words);
      if (!lines.length) return `--- PAGE ${p.pageNum} ---\n`;
      // Estimate the unit (PDF x-units per output character) from typical
      // token widths.
      const perCharWidths = [];
      for (const l of lines) for (const w of l.words) {
        const len = String(w.text).length;
        if (len > 0 && (w.x1 - w.x0) > 0) perCharWidths.push((w.x1 - w.x0) / len);
      }
      perCharWidths.sort((a, b) => a - b);
      const unit = perCharWidths.length
        ? perCharWidths[Math.floor(perCharWidths.length / 2)]
        : 5;
      // Walk lines: if we detect a size header, buffer its x-positions and
      // annotate the immediately following qty-only lines with explicit
      // [SIZE_MAP: ...] hints. This gives the LLM ground-truth alignment
      // without asking it to reason about ASCII columns (which it does
      // notoriously badly).
      const out = [];
      let pendingHeader = null;
      for (const l of lines) {
        const padded = wordsToPaddedLine(l.words, unit);
        // Try to detect a size header FIRST — headers are visible and enable
        // hints for what follows.
        const header = detectSizeHeaderInWords(l.words);
        if (header) {
          pendingHeader = header;
          out.push(padded);
          continue;
        }
        // If a header is pending, look for a qty-only line to annotate.
        if (pendingHeader) {
          const qtys = detectQtyOnlyLine(l.words);
          if (qtys) {
            const pairs = mapQtysToSizes(pendingHeader, qtys);
            const hint = pairs.map(p => `${p.size}=${p.qty}`).join(' ');
            out.push(`${padded}   [SIZE_MAP: ${hint}]`);
            continue;
          }
          // Non-qty line encountered — pending header expires
          pendingHeader = null;
        }
        out.push(padded);
      }
      return `--- PAGE ${p.pageNum} ---\n${out.join('\n')}`;
    }).join('\n\n'),
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
