#!/usr/bin/env node
'use strict';
// -----------------------------------------------------------------------------
// One-off backfill: persist a tenant's season calendar into app_settings.
//
// Until now the app fell back to DEFAULT_SEASONS_CONFIG whenever a tenant had no
// 'seasons_config' row — a default that is in fact Valérie Simon's own calendar
// and tag patterns. That made the fallback invisible and wrong for anyone else.
// The fallback is being removed, so every tenant already in production needs its
// calendar written down explicitly, once.
//
// Idempotent and non-destructive: refuses to overwrite an existing config.
//
// Usage:
//   railway run node scripts/seed-seasons-config.js --tenant valerie-simon
//   railway run node scripts/seed-seasons-config.js --tenant X --dry-run
// -----------------------------------------------------------------------------

const { Pool } = require('pg');

const args = process.argv.slice(2);
const argVal = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const tenantId = argVal('--tenant');
const dryRun   = args.includes('--dry-run');

if (!tenantId) {
  console.error('Usage: node scripts/seed-seasons-config.js --tenant <tenant_id> [--dry-run]');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL requis (utiliser: railway run node scripts/seed-seasons-config.js …)');
  process.exit(1);
}

// The calendar that was, until now, hardcoded as DEFAULT_SEASONS_CONFIG in
// server.js. Copied here verbatim so the backfill records exactly the behaviour
// the tenant already had — this script writes down the status quo, it does not
// invent a new calendar.
const SEASONS = [
  { code:'p23', label:'P23 — Printemps 2023', reception_from:'2022-10-01', reception_to:'2023-09-30', sell_from:'2023-02-01', sell_to:'2023-09-30', tag_pattern:'p23' },
  { code:'a23', label:'A23 — Automne 2023',   reception_from:'2023-05-01', reception_to:'2024-02-28', sell_from:'2023-09-01', sell_to:'2024-02-28', tag_pattern:'a23' },
  { code:'p24', label:'P24 — Printemps 2024', reception_from:'2023-10-01', reception_to:'2024-09-30', sell_from:'2024-02-01', sell_to:'2024-09-30', tag_pattern:'p24' },
  { code:'a24', label:'A24 — Automne 2024',   reception_from:'2024-05-01', reception_to:'2025-02-28', sell_from:'2024-09-01', sell_to:'2025-02-28', tag_pattern:'a24' },
  { code:'p25', label:'P25 — Printemps 2025', reception_from:'2024-10-01', reception_to:'2025-09-30', sell_from:'2025-02-01', sell_to:'2025-09-30', tag_pattern:'p25' },
  { code:'a25', label:'A25 — Automne 2025',   reception_from:'2025-05-01', reception_to:'2026-02-28', sell_from:'2025-09-01', sell_to:'2026-02-28', tag_pattern:'a25' },
  { code:'p26', label:'P26 — Printemps 2026', reception_from:'2025-10-01', reception_to:'2026-09-30', sell_from:'2026-02-01', sell_to:'2026-09-30', tag_pattern:'p26' },
  { code:'a26', label:'A26 — Automne 2026',   reception_from:'2026-05-01', reception_to:'2027-02-28', sell_from:'2026-09-01', sell_to:'2027-02-28', tag_pattern:'a26' },
  { code:'p27', label:'P27 — Printemps 2027', reception_from:'2026-10-01', reception_to:'2027-09-30', sell_from:'2027-02-01', sell_to:'2027-09-30', tag_pattern:'p27' },
  { code:'a27', label:'A27 — Automne 2027',   reception_from:'2027-05-01', reception_to:'2028-02-28', sell_from:'2027-09-01', sell_to:'2028-02-28', tag_pattern:'a27' },
];

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    const { rows: tenant } = await pool.query('SELECT id, name FROM tenants WHERE id = $1', [tenantId]);
    if (!tenant.length) { console.error(`Tenant "${tenantId}" introuvable.`); process.exit(1); }

    const { rows: existing } = await pool.query(
      "SELECT jsonb_array_length(value) AS n, updated_at FROM app_settings WHERE tenant_id = $1 AND key = 'seasons_config'",
      [tenantId]);
    if (existing.length) {
      console.log(`Tenant "${tenantId}" a déjà une config de ${existing[0].n} saison(s) ` +
                  `(modifiée le ${existing[0].updated_at.toISOString().slice(0, 10)}). Aucune modification.`);
      process.exit(0);
    }

    console.log(`Tenant : ${tenant[0].name} (${tenantId})`);
    console.log(`Saisons à écrire : ${SEASONS.length} (${SEASONS[0].code} → ${SEASONS[SEASONS.length - 1].code})`);
    if (dryRun) { console.log('--dry-run : rien n\'a été écrit.'); process.exit(0); }

    await pool.query(
      `INSERT INTO app_settings(tenant_id, key, value, updated_at)
       VALUES ($1, 'seasons_config', $2::jsonb, now())`,
      [tenantId, JSON.stringify(SEASONS)]);
    console.log('✅  seasons_config écrite.');
  } finally {
    await pool.end();
  }
})().catch(e => { console.error('Erreur:', e.message); process.exit(1); });
