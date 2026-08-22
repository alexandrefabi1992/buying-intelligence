'use strict';
// Unit tests for lib/nos-tag.js — resolution of the tenant's NOS tag.
// Run: node tests/nos-tag.test.js   OR   npm run test:nos-tag

const { resolveNosTag, escapeLikePattern, NOS_DISABLED_MESSAGE } = require('../lib/nos-tag');

let failed = 0;
const check = (n, f) => { try { f(); console.log('  ok   ' + n); } catch (e) { failed++; console.error('  FAIL ' + n + ' — ' + e.message); } };
const eq = (a, b, l) => { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${l ?? ''} attendu ${y}, obtenu ${x}`); };

console.log('escapeLikePattern');
check('rien à échapper', () => eq(escapeLikePattern('core'), 'core'));
check('% échappé', () => eq(escapeLikePattern('50%off'), '50\\%off'));
check('_ échappé', () => eq(escapeLikePattern('a_b'), 'a\\_b'));
check('les deux à la fois', () => eq(escapeLikePattern('50%_off'), '50\\%\\_off'));
check('antislash doublé en premier', () => eq(escapeLikePattern('a\\b'), 'a\\\\b'));
check('antislash + % : pas de double échappement', () => eq(escapeLikePattern('a\\%b'), 'a\\\\\\%b'));
check('valeur absente', () => { eq(escapeLikePattern(null), ''); eq(escapeLikePattern(undefined), ''); });

console.log('\nresolveNosTag — les trois états');
check('config absente → repli historique %nos%', () =>
  eq(resolveNosTag({}), { state: 'legacy', like: '%nos%' }));
check('null / valeur invalide → repli historique', () => {
  eq(resolveNosTag(null), { state: 'legacy', like: '%nos%' });
  eq(resolveNosTag([1]), { state: 'legacy', like: '%nos%' });
  eq(resolveNosTag('x'), { state: 'legacy', like: '%nos%' });
});
check('config avec balise → cette balise', () =>
  eq(resolveNosTag({ boutique_name: 'X', nos_enabled: 'yes', nos_tag: 'core' }),
     { state: 'enabled', like: '%core%' }));
check('config sans NOS → désactivé, aucun motif', () =>
  eq(resolveNosTag({ boutique_name: 'X', nos_enabled: 'no', nos_tag: null }),
     { state: 'disabled', like: null }));
check('étape NOS sautée (nos_enabled absent) → désactivé, pas repli', () =>
  eq(resolveNosTag({ boutique_name: 'X' }), { state: 'disabled', like: null }));
check('nos_enabled=yes mais balise vide → désactivé', () => {
  eq(resolveNosTag({ boutique_name: 'X', nos_enabled: 'yes', nos_tag: '' }), { state: 'disabled', like: null });
  eq(resolveNosTag({ boutique_name: 'X', nos_enabled: 'yes', nos_tag: '   ' }), { state: 'disabled', like: null });
});
check('espaces autour de la balise ignorés', () =>
  eq(resolveNosTag({ boutique_name: 'X', nos_enabled: 'yes', nos_tag: '  core ' }).like, '%core%'));

console.log('\nresolveNosTag — caractères spéciaux');
check('balise "50%_off" échappée dans le motif', () =>
  eq(resolveNosTag({ boutique_name: 'X', nos_enabled: 'yes', nos_tag: '50%_off' }).like, '%50\\%\\_off%'));
check('les % encadrants restent des jokers', () => {
  const like = resolveNosTag({ boutique_name: 'X', nos_enabled: 'yes', nos_tag: '50%_off' }).like;
  if (!like.startsWith('%') || !like.endsWith('%')) throw new Error(like);
});

console.log('\ndivers');
check('le message de désactivation renvoie vers le wizard', () => {
  if (!/NOS/.test(NOS_DISABLED_MESSAGE) || !/Configuration/.test(NOS_DISABLED_MESSAGE))
    throw new Error(NOS_DISABLED_MESSAGE);
});
check('la casse de la balise est conservée (ILIKE fait le reste)', () =>
  eq(resolveNosTag({ boutique_name: 'X', nos_enabled: 'yes', nos_tag: 'CoRe' }).like, '%CoRe%'));

console.log(failed ? `\n❌  ${failed} test(s) échoué(s).` : '\n✅  Tous les tests nos-tag passent.');
process.exit(failed ? 1 : 0);
