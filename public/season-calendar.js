'use strict';
// -----------------------------------------------------------------------------
// Season calendar generator.
//
// The onboarding wizard asks for two example tags — one spring/summer, one
// autumn/winter — and derives a working calendar from them. Until now those two
// answers were stored in tenant_config and read by nothing, so a tenant could
// finish the wizard and still have no seasons_config at all.
//
// The shape produced here mirrors the calendar that used to be hardcoded as
// DEFAULT_SEASONS_CONFIG in server.js:
//   spring Y : sells 02-01 → 09-30,       receives from (Y-1)-10-01
//   autumn Y : sells 09-01 → (Y+1)-02-28, receives from Y-05-01
// Selling windows overlap on purpose: autumn stock lands while spring is still
// selling down.
//
// Loaded both as a <script> by public/onboarding.html and as a CommonJS module
// by tests/season-calendar.test.js — one implementation, not two.
// -----------------------------------------------------------------------------

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SeasonCalendar = api;
})(typeof self !== 'undefined' ? self : this, function () {

  // "p26" → { prefix: 'p', digits: 2 }   "spring2026" → { prefix: 'spring', digits: 4 }
  // Returns null when the tag carries no trailing year, which is what makes a
  // calendar derivable in the first place.
  function parseTag(tag) {
    const m = String(tag ?? '').trim().match(/^(.*?)(\d{4}|\d{2})$/);
    if (!m || !m[1]) return null;
    return { prefix: m[1], digits: m[2].length };
  }

  function yearToken(year, digits) {
    return digits === 4 ? String(year) : String(year % 100).padStart(2, '0');
  }

  const pad = (n) => String(n).padStart(2, '0');
  const date = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

  // February end date: the old calendar used a flat 02-28, which silently drops
  // February 29th of a leap year from the autumn selling window.
  function endOfFebruary(year) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return date(year, 2, leap ? 29 : 28);
  }

  // buildSeasonCalendar({ springTag, fallTag, currentYear, yearsBack, yearsForward })
  //   → [{ code, label, reception_from, reception_to, sell_from, sell_to, tag_pattern }]
  //
  // Returns [] when neither tag yields a year — the caller then writes nothing
  // rather than inventing a calendar the tenant never described.
  function buildSeasonCalendar(opts) {
    const o = opts ?? {};
    const spring = parseTag(o.springTag);
    const fall   = parseTag(o.fallTag);
    if (!spring && !fall) return [];

    const currentYear  = o.currentYear ?? new Date().getFullYear();
    const yearsBack    = o.yearsBack    ?? 2;
    const yearsForward = o.yearsForward ?? 1;

    const seasons = [];
    for (let y = currentYear - yearsBack; y <= currentYear + yearsForward; y++) {
      if (spring) {
        const code = `${spring.prefix}${yearToken(y, spring.digits)}`;
        seasons.push({
          code,
          label:          `${code.toUpperCase()} — Printemps/Été ${y}`,
          reception_from: date(y - 1, 10, 1),
          reception_to:   date(y, 9, 30),
          sell_from:      date(y, 2, 1),
          sell_to:        date(y, 9, 30),
          tag_pattern:    code,
        });
      }
      if (fall) {
        const code = `${fall.prefix}${yearToken(y, fall.digits)}`;
        seasons.push({
          code,
          label:          `${code.toUpperCase()} — Automne/Hiver ${y}`,
          reception_from: date(y, 5, 1),
          reception_to:   endOfFebruary(y + 1),
          sell_from:      date(y, 9, 1),
          sell_to:        endOfFebruary(y + 1),
          tag_pattern:    code,
        });
      }
    }
    seasons.sort((a, b) => a.sell_from.localeCompare(b.sell_from));
    return seasons;
  }

  return { buildSeasonCalendar, parseTag };
});
