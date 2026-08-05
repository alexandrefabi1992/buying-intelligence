'use strict';
// Style resolver for the import module.
//
// Given a styleRef (e.g. "99103") and a seasonTag (e.g. "a26"), classifies
// what the module should do at push time:
//
//   'new'                     → no matrix with this styleRef exists.
//                                Push will create a matrix "99103".
//   'exists_current_season'   → a matrix with this styleRef exists AND at
//                                least one of its variants already carries
//                                the current seasonTag. Push will REUSE
//                                that matrix and add only missing variants.
//   'exists_other_season'     → a matrix with this styleRef exists but no
//                                variant carries the seasonTag. Push will
//                                create a NEW matrix "99103 <seasonTag>"
//                                to avoid conflating seasons on the same
//                                matrix (per user's naming convention).
//
// The prefix search matches "99103 " (with a trailing space) too, so the
// resolver strictly filters to matrices whose description is EXACTLY the
// styleRef OR the styleRef followed by whitespace — that avoids catching
// "991030" or "99103A" as false positives for "99103".
//
// This module is pure orchestration on top of LightspeedClient. It does no
// pacing/retry itself — the client handles that globally.

const STRICT_SUFFIX_RE = raw => new RegExp(`^${raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);

// One helper — normalise Tags fields (Lightspeed can return {tag:[]},
// {tag:{}} or {Tag:...}) into a lowercase string[] for comparison.
function extractTagNames(tagsField) {
  if (!tagsField) return [];
  const raw = tagsField.tag ?? tagsField.Tag ?? tagsField;
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr
    .map(t => (typeof t === 'string' ? t : (t.name ?? t.Name)))
    .filter(Boolean)
    .map(s => String(s).trim().toLowerCase())
    .filter(Boolean);
}

// Resolve one styleRef.
// Returns:
//   {
//     status: 'new' | 'exists_current_season' | 'exists_other_season',
//     preferred_matrix_id: <id> | null,   // matrix to REUSE (only set when
//                                          // status === 'exists_current_season')
//     matching_matrices: [
//       {
//         matrix_id, matrix_description,
//         variant_count,
//         variants_with_season_tag,
//         is_season_named,                 // description ends with " <seasonTag>"
//         variants: [ { itemID, description, attribute1, attribute2, tags: [...] } ]
//       }
//     ]
//   }
//
// Classification rules:
//   - 'new' → no matrix has this styleRef as description or as "styleRef X…"
//   - 'exists_current_season' → at least one strict match either
//         (a) has description "styleRef <seasonTag>" (season-named matrix, even if empty),
//         (b) has any variant tagged with the current seasonTag.
//     Push will REUSE preferred_matrix_id and add only missing variants.
//   - 'exists_other_season' → strict match exists but neither (a) nor (b).
//     Push will CREATE a new matrix named "styleRef <seasonTag>".
//
// Rule (a) catches leftover empty season matrices from partial/aborted
// imports — reusing them avoids a duplicate-description error at push time.
async function resolveStyle(client, styleRef, seasonTag) {
  if (!client)    throw new Error('resolveStyle: client required');
  if (!styleRef)  throw new Error('resolveStyle: styleRef required');
  if (!seasonTag) throw new Error('resolveStyle: seasonTag required');

  const seasonLc = seasonTag.toLowerCase();
  const prefixMatches = await client.searchMatrixByPrefix(styleRef);

  // Strict filter: description === styleRef, or styleRef followed by whitespace.
  // Prevents "991030" catching "99103", and "99103A" catching "99103".
  const strictRe = STRICT_SUFFIX_RE(styleRef);
  const strict = prefixMatches.filter(m => {
    const d = String(m.description ?? '');
    return d === styleRef || strictRe.test(d);
  });

  if (!strict.length) {
    return { status: 'new', preferred_matrix_id: null, matching_matrices: [] };
  }

  const seasonNamedRe = new RegExp(`\\b${seasonLc}$`, 'i');
  const matching = [];
  for (const m of strict) {
    const variants = await client.listVariantsForMatrix(m.itemMatrixID);
    const summarised = variants.map(v => {
      const tags = extractTagNames(v.Tags);
      const attrs = v.ItemAttributes ?? {};
      return {
        itemID:       v.itemID,
        description:  v.description,
        attribute1:   attrs.attribute1 ?? null,
        attribute2:   attrs.attribute2 ?? null,
        tags,
      };
    });
    const variants_with_season_tag = summarised.filter(v => v.tags.includes(seasonLc)).length;
    const is_season_named = seasonNamedRe.test(String(m.description ?? '').trim());
    matching.push({
      matrix_id:                m.itemMatrixID,
      matrix_description:       m.description,
      variant_count:            summarised.length,
      variants_with_season_tag,
      is_season_named,
      variants:                 summarised,
    });
  }

  // Prefer a season-named matrix if present; otherwise a bare-styleRef matrix
  // that has variants tagged with the current season.
  const seasonNamed = matching.find(m => m.is_season_named);
  const bareTagged  = matching.find(m => !m.is_season_named && m.variants_with_season_tag > 0);
  const preferred   = seasonNamed || bareTagged || null;

  return {
    status:              preferred ? 'exists_current_season' : 'exists_other_season',
    preferred_matrix_id: preferred?.matrix_id ?? null,
    matching_matrices:   matching,
  };
}

// Batch helper — resolves a set of styleRefs sequentially (relies on the
// client's shared rate limiter). Returns Map<styleRef, resolution>.
// `onProgress` is called after each style with (done, total, styleRef).
async function resolveStyles(client, styleRefs, seasonTag, { onProgress } = {}) {
  const uniq = [...new Set(styleRefs.filter(Boolean))];
  const out = new Map();
  let done = 0;
  for (const s of uniq) {
    try {
      out.set(s, await resolveStyle(client, s, seasonTag));
    } catch (e) {
      out.set(s, { status: 'error', error: e.message, matching_matrices: [] });
    }
    done++;
    if (onProgress) onProgress(done, uniq.length, s);
  }
  return out;
}

module.exports = { resolveStyle, resolveStyles, extractTagNames };
