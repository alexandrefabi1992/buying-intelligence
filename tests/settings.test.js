'use strict';
// Unit tests for lib/settings.js — the tenant settings reader.
//
// The point of this module is that three previously indistinguishable
// situations now log differently while behaving identically. These tests assert
// both halves: the right log channel, and the same fallback in every case.
//
// Run: node tests/settings.test.js   OR   npm run test:settings

const { createSettingsReader, describeJson } = require('../lib/settings');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (err) { failed++; console.error('  FAIL ' + name + ' — ' + err.message); }
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label ?? ''} expected ${e}, got ${a}`);
}

// Capture console output per channel.
function makeLogger() {
  const out = { log: [], warn: [], error: [] };
  return {
    logger: {
      log:   m => out.log.push(m),
      warn:  m => out.warn.push(m),
      error: m => out.error.push(m),
    },
    out,
  };
}
const poolReturning = (rows) => ({ query: async () => ({ rows }) });
const poolFailing   = (msg) => ({ query: async () => { throw new Error(msg); } });

const isArray = v => Array.isArray(v);

(async () => {
  // --- absent row ----------------------------------------------------------
  console.log('ligne absente');
  {
    const { logger, out } = makeLogger();
    const read = createSettingsReader(poolReturning([]), { logger });
    const v = await read('t1', 'seasons_config', isArray, 'un tableau');
    check('retourne null (le caller applique son défaut)', () => eq(v, null));
    check('journalisé en info, pas en warning ni error', () => {
      eq(out.log.length, 1); eq(out.warn.length, 0); eq(out.error.length, 0);
    });
    check('le message nomme le tenant et la clé', () => {
      if (!out.log[0].includes('t1') || !out.log[0].includes('seasons_config')) throw new Error(out.log[0]);
    });
    await read('t1', 'seasons_config', isArray, 'un tableau');
    await read('t1', 'seasons_config', isArray, 'un tableau');
    check('dédupliqué: une seule ligne par (tenant, clé) et par process', () => eq(out.log.length, 1));
    await read('t2', 'seasons_config', isArray, 'un tableau');
    check('un autre tenant produit sa propre ligne', () => eq(out.log.length, 2));
  }

  // --- malformed row -------------------------------------------------------
  console.log('ligne malformée');
  {
    const { logger, out } = makeLogger();
    const read = createSettingsReader(poolReturning([{ value: { p26: {} } }]), { logger });
    const v = await read('t1', 'seasons_config', isArray, 'un tableau non vide de saisons');
    check('retourne null', () => eq(v, null));
    check('journalisé en WARNING', () => {
      eq(out.warn.length, 1); eq(out.log.length, 0); eq(out.error.length, 0);
    });
    check('le message dit ce qui était attendu et ce qui a été trouvé', () => {
      const m = out.warn[0];
      if (!m.includes('un tableau non vide de saisons') || !m.includes('object')) throw new Error(m);
    });
    await read('t1', 'seasons_config', isArray, 'x');
    check('dédupliqué par process', () => eq(out.warn.length, 1));
  }
  {
    const { logger, out } = makeLogger();
    const read = createSettingsReader(poolReturning([{ value: [] }]), { logger });
    const v = await read('t1', 'seasons_config', v => Array.isArray(v) && v.length > 0, 'un tableau non vide');
    check('tableau vide traité comme malformé, pas comme absent', () => {
      eq(v, null); eq(out.warn.length, 1); eq(out.log.length, 0);
      if (!out.warn[0].includes('0 élément')) throw new Error(out.warn[0]);
    });
  }

  // --- real DB error -------------------------------------------------------
  console.log('erreur base de données');
  {
    const { logger, out } = makeLogger();
    const read = createSettingsReader(poolFailing('connection terminated'), { logger });
    const v = await read('t1', 'seasons_config', isArray, 'un tableau');
    check('retourne null (aucune requête ne doit échouer)', () => eq(v, null));
    check('journalisé en ERROR avec le détail', () => {
      eq(out.error.length, 1); eq(out.warn.length, 0); eq(out.log.length, 0);
      if (!out.error[0].includes('connection terminated')) throw new Error(out.error[0]);
    });
    await read('t1', 'seasons_config', isArray, 'un tableau');
    await read('t1', 'seasons_config', isArray, 'un tableau');
    check('JAMAIS dédupliqué: une panne récurrente doit rester visible', () => eq(out.error.length, 3));
  }

  // --- valid row -----------------------------------------------------------
  console.log('ligne valide');
  {
    const { logger, out } = makeLogger();
    const read = createSettingsReader(poolReturning([{ value: [{ code: 'p26' }] }]), { logger });
    const v = await read('t1', 'seasons_config', isArray, 'un tableau');
    check('retourne la valeur stockée', () => eq(v, [{ code: 'p26' }]));
    check('ne journalise rien', () => {
      eq(out.log.length, 0); eq(out.warn.length, 0); eq(out.error.length, 0);
    });
  }

  // --- describeJson --------------------------------------------------------
  console.log('describeJson');
  check('décrit chaque forme', () => {
    eq(describeJson(null), 'null');
    eq(describeJson(undefined), 'null');
    eq(describeJson([1, 2]), 'tableau de 2 élément(s)');
    eq(describeJson({}), 'object');
    eq(describeJson(8), 'number');
  });

  console.log(failed ? `\n❌  ${failed} test(s) échoué(s).` : '\n✅  Tous les tests settings passent.');
  process.exit(failed ? 1 : 0);
})();
