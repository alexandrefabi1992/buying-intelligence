'use strict';
// Unit tests for public/season-calendar.js — the wizard's calendar generator.
//
// Run: node tests/season-calendar.test.js   OR   npm run test:season-calendar

const { buildSeasonCalendar, parseTag } = require('../public/season-calendar.js');

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failed++; console.error('  FAIL ' + name + ' — ' + e.message); }
};
const eq = (a, b, l) => {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${l ?? ''} attendu ${y}, obtenu ${x}`);
};

console.log('parseTag');
check('préfixe + année sur 2 chiffres', () => eq(parseTag('p26'), { prefix: 'p', digits: 2 }));
check('préfixe multi-lettres', () => eq(parseTag('ss26'), { prefix: 'ss', digits: 2 }));
check('année sur 4 chiffres', () => eq(parseTag('spring2026'), { prefix: 'spring', digits: 4 }));
check('espaces ignorés', () => eq(parseTag('  fw26 '), { prefix: 'fw', digits: 2 }));
check('sans année → null', () => { eq(parseTag('printemps'), null); eq(parseTag(''), null); eq(parseTag(null), null); });
check('année seule sans préfixe → null', () => eq(parseTag('2026'), null));

console.log('\nbuildSeasonCalendar');
const cal = buildSeasonCalendar({ springTag: 'p26', fallTag: 'a26', currentYear: 2026 });

check('4 ans × 2 saisons = 8 entrées', () => eq(cal.length, 8));
check('ordre chronologique', () => {
  const sorted = [...cal].sort((a, b) => a.sell_from.localeCompare(b.sell_from));
  eq(cal.map(s => s.code), sorted.map(s => s.code));
});
check('couvre l\'année en cours −2 / +1', () =>
  eq(cal.map(s => s.code), ['p24','a24','p25','a25','p26','a26','p27','a27']));

// The generated calendar must reproduce what used to be hardcoded, otherwise a
// tenant onboarded today would get different numbers than one migrated.
check('reproduit le calendrier historique pour p26', () => {
  const p26 = cal.find(s => s.code === 'p26');
  eq(p26.reception_from, '2025-10-01'); eq(p26.reception_to, '2026-09-30');
  eq(p26.sell_from, '2026-02-01');      eq(p26.sell_to, '2026-09-30');
  eq(p26.tag_pattern, 'p26');
});
check('reproduit le calendrier historique pour a26', () => {
  const a26 = cal.find(s => s.code === 'a26');
  eq(a26.reception_from, '2026-05-01'); eq(a26.reception_to, '2027-02-28');
  eq(a26.sell_from, '2026-09-01');      eq(a26.sell_to, '2027-02-28');
});
check('la fenêtre automne chevauche la fin du printemps', () => {
  const p26 = cal.find(s => s.code === 'p26'), a26 = cal.find(s => s.code === 'a26');
  if (!(a26.sell_from < p26.sell_to)) throw new Error('pas de chevauchement');
});
check('29 février pris en compte les années bissextiles', () => {
  const a27 = cal.find(s => s.code === 'a27'); // se termine en 2028, bissextile
  eq(a27.sell_to, '2028-02-29');
});
check('tous les champs attendus par seasons_config sont présents', () => {
  const keys = ['code','label','reception_from','reception_to','sell_from','sell_to','tag_pattern'];
  for (const s of cal) eq(Object.keys(s).sort(), [...keys].sort(), s.code);
});

console.log('\nformats de balise alternatifs');
check('ss/fw sur 2 chiffres', () => {
  const c = buildSeasonCalendar({ springTag: 'ss26', fallTag: 'fw26', currentYear: 2026 });
  eq(c.map(s => s.code).slice(0, 4), ['ss24','fw24','ss25','fw25']);
});
check('année sur 4 chiffres conservée', () => {
  const c = buildSeasonCalendar({ springTag: 'spring2026', fallTag: 'fall2026', currentYear: 2026 });
  eq(c[0].code, 'spring2024');
});

console.log('\ncas dégradés');
check('aucune balise exploitable → tableau vide (on n\'invente rien)', () => {
  eq(buildSeasonCalendar({ springTag: '', fallTag: '' }), []);
  eq(buildSeasonCalendar({ springTag: 'printemps', fallTag: 'automne' }), []);
  eq(buildSeasonCalendar({}), []);
});
check('une seule balise → calendrier à une saison par an', () => {
  const c = buildSeasonCalendar({ springTag: 'p26', fallTag: '', currentYear: 2026 });
  eq(c.map(s => s.code), ['p24','p25','p26','p27']);
});
check('profondeur configurable', () => {
  const c = buildSeasonCalendar({ springTag: 'p26', fallTag: 'a26', currentYear: 2026, yearsBack: 0, yearsForward: 0 });
  eq(c.map(s => s.code), ['p26','a26']);
});

console.log(failed ? `\n❌  ${failed} test(s) échoué(s).` : '\n✅  Tous les tests du générateur passent.');
process.exit(failed ? 1 : 0);
