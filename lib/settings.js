'use strict';
// ---------------------------------------------------------------------------
// Tenant settings reader
//
// Every per-tenant setting is read the same way: one row in app_settings, a
// shape check, then a documented default when the row is absent or unusable.
// The five getters in server.js used to share one silent `catch {}`, which made
// three very different situations indistinguishable: a setting nobody ever
// configured, a setting configured wrongly, and a database that is down.
//
// Only the logging changed — the return value is identical in all three cases,
// so a missing or broken setting still never fails a request.
//
//   absent    → info,    once per (tenant, key) per process
//   malformed → warning, once per (tenant, key) per process
//   DB error  → error,   every occurrence (transient, and the rate matters)
//
// "Once per process" is keyed on first read rather than emitted at startup: a
// startup scan would miss every tenant created while the process is running.
//
// Note on "malformed": the column is JSONB, so invalid JSON cannot be stored.
// What this catches is a value of the wrong shape — an object where an array is
// expected, an empty array, a JSON null.
// ---------------------------------------------------------------------------

function describeJson(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `tableau de ${value.length} élément(s)`;
  return typeof value;
}

// createSettingsReader(pool) → readSetting(tenantId, key, isValid, expected)
//
// Returns the stored value when it passes isValid, or null in every fallback
// case. Callers apply their own default to the null, which keeps each default
// next to the getter that documents it.
function createSettingsReader(pool, { logger = console } = {}) {
  const notices = new Set();

  function noticeOnce(kind, tenantId, key, message) {
    const id = `${kind}:${tenantId}:${key}`;
    if (notices.has(id)) return;
    notices.add(id);
    if (kind === 'malformed') logger.warn(message);
    else logger.log(message);
  }

  async function readSetting(tenantId, key, isValid, expected) {
    let rows;
    try {
      ({ rows } = await pool.query(
        'SELECT value FROM app_settings WHERE key = $1 AND tenant_id = $2',
        [key, tenantId]
      ));
    } catch (err) {
      // A real SQL failure is never deduplicated: if the database is failing,
      // seeing it on every read is the point.
      logger.error(
        `[settings] Erreur DB en lisant '${key}' pour le tenant '${tenantId}': ${err.message} — repli sur les valeurs par défaut`
      );
      return null;
    }
    if (!rows.length) {
      noticeOnce('absent', tenantId, key,
        `[settings] '${key}' non configuré pour le tenant '${tenantId}' — utilisation des valeurs par défaut intégrées`);
      return null;
    }
    if (!isValid(rows[0].value)) {
      noticeOnce('malformed', tenantId, key,
        `[settings] '${key}' du tenant '${tenantId}' est inexploitable ` +
        `(attendu: ${expected}; trouvé: ${describeJson(rows[0].value)}) — repli sur les valeurs par défaut`);
      return null;
    }
    return rows[0].value;
  }

  // Test hook: forget which notices were already emitted.
  readSetting.resetNotices = () => notices.clear();
  return readSetting;
}

module.exports = { createSettingsReader, describeJson };
