'use strict';
// ---------------------------------------------------------------------------
// NOS tag resolution.
//
// "NOS" (never out of stock) items are permanents that sit outside the seasonal
// cycle. Sixteen queries used to hardcode ILIKE '%nos%', while the onboarding
// wizard has always asked the merchant which tag they actually use. A shop
// tagging its permanents 'core' therefore got empty NOS budgets AND had those
// same items inflating its seasonal budget — silently, with no error anywhere.
//
// Three states, deliberately distinguished:
//
//   legacy   tenant_config does not exist at all → keep '%nos%'. Every tenant
//            in production is in this state today; removing the fallback would
//            zero out their NOS budgets overnight.
//   enabled  nos_enabled === 'yes' with a tag → use that tag.
//   disabled tenant_config exists but NOS is off (or step 6 was skipped) → the
//            tenant has no NOS items. Selecting routes say so explicitly;
//            excluding routes drop the condition, since there is nothing to
//            exclude.
// ---------------------------------------------------------------------------

// Escape the LIKE metacharacters so a tag such as "50%_off" matches literally
// rather than as a wildcard. PostgreSQL's default escape character for
// LIKE/ILIKE is the backslash, so no ESCAPE clause is needed at the call site.
// Order matters: the backslash must be doubled first.
function escapeLikePattern(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/[%_]/g, m => '\\' + m);
}

// resolveNosTag(tenantConfig) → { state, like }
//   state: 'legacy' | 'enabled' | 'disabled'
//   like:  the ILIKE pattern to bind, or null when disabled
//
// getTenantConfig() returns {} for a tenant with no saved configuration, which
// is what separates 'legacy' from 'disabled': an empty object means the wizard
// was never completed, a populated one means the merchant answered.
function resolveNosTag(tenantConfig) {
  const cfg = tenantConfig && typeof tenantConfig === 'object' && !Array.isArray(tenantConfig)
    ? tenantConfig : {};
  if (Object.keys(cfg).length === 0) {
    return { state: 'legacy', like: '%nos%' };
  }
  const tag = typeof cfg.nos_tag === 'string' ? cfg.nos_tag.trim() : '';
  if (cfg.nos_enabled !== 'yes' || !tag) {
    return { state: 'disabled', like: null };
  }
  return { state: 'enabled', like: `%${escapeLikePattern(tag)}%` };
}

// Message returned by the routes that SELECT NOS items, so an empty table is
// never mistaken for "you have no shortage".
const NOS_DISABLED_MESSAGE =
  "Aucun produit NOS configuré pour ce compte. Indiquez votre balise NOS dans " +
  "Configuration de la boutique (étape « Produits permanents ») pour activer ce rapport.";

module.exports = { escapeLikePattern, resolveNosTag, NOS_DISABLED_MESSAGE };
