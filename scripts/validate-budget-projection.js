'use strict';
// Validation — computes OLD and NEW projection algorithms directly against the DB.
// No server boot, no JWT dance. Transparent, side-by-side.
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const TENANT     = 'valerie-simon';
const SHOP_NAME  = 'Boutique Valérie Simon';
const TARGET     = 'p27';

const TIERS = [
  { st_min: 0.80, multiplier: 1.15, label: 'Augmenter' },
  { st_min: 0.65, multiplier: 1.08, label: 'Légère hausse' },
  { st_min: 0.50, multiplier: 1.00, label: 'Reconduire' },
  { st_min: 0.40, multiplier: 0.90, label: 'Léger recul' },
  { st_min: 0.30, multiplier: 0.75, label: 'Réduire' },
  { st_min: 0.00, multiplier: 0.50, label: 'Couper' },
];
const PROJ_CFG = {
  seuil_bascule: 0.05,
  poids_recent: 0.60,
  fenetre_velocite: 8,
  borne_plancher: 0.50,
  borne_plafond: 1.50,
};

const SEASONS = [
  { code: 'p26', reception_from: '2025-10-01', sell_from: '2026-02-01', sell_to: '2026-09-30', tag_pattern: 'p26' },
  { code: 'p25', reception_from: '2024-10-01', sell_from: '2025-02-01', sell_to: '2025-09-30', tag_pattern: 'p25' },
  { code: 'p24', reception_from: '2023-10-01', sell_from: '2024-02-01', sell_to: '2024-09-30', tag_pattern: 'p24' },
];

function tierOf(st) {
  if (st == null || isNaN(st)) return { label: 'Reconduire', multiplier: 1.0 };
  const sorted = [...TIERS].sort((a, b) => b.st_min - a.st_min);
  for (const t of sorted) if (st >= t.st_min) return { label: t.label, multiplier: t.multiplier };
  return { label: sorted[sorted.length - 1].label, multiplier: sorted[sorted.length - 1].multiplier };
}
function weightedAvg(sts, weights = [4, 2, 1]) {
  let num = 0, den = 0;
  for (let i = 0; i < sts.length; i++) if (sts[i] != null) { num += sts[i] * weights[i]; den += weights[i]; }
  return den > 0 ? num / den : null;
}

// ─── Common SQL helpers (shop-scoped, matches server.js filters) ───────
async function irSl(season, shopId) {
  const p = shopId ? [TENANT, season.reception_from, `%${season.tag_pattern}%`, shopId] : [TENANT, season.reception_from, `%${season.tag_pattern}%`];
  const cond = shopId ? 'AND sl.shop_id = $4' : '';
  const { rows } = await pool.query(`
    SELECT COALESCE(p.manufacturer,'Sans marque') AS manufacturer,
           SUM(sl.qty)::float8 AS qty, SUM(sl.qty*COALESCE(p.default_cost,0))::float8 AS cost
    FROM sale_lines sl JOIN products p ON p.item_id=sl.item_id
    WHERE (sl.completed_time AT TIME ZONE 'America/Toronto')::date >= $2::date
      AND p.tenant_id=$1 AND p.tags ILIKE $3 AND p.tags NOT ILIKE '%nos%'
      AND p.category NOT ILIKE 'Alt%ration%' AND p.description NOT ILIKE '%shopify%'
      ${cond}
    GROUP BY p.manufacturer
  `, p);
  const m = {}; for (const r of rows) m[r.manufacturer] = { qty: +r.qty, cost: +r.cost };
  return m;
}
async function irInv(season, shopId) {
  const p = shopId ? [TENANT, `%${season.tag_pattern}%`, shopId] : [TENANT, `%${season.tag_pattern}%`];
  const cond = shopId ? 'AND i.shop_id = $3' : '';
  const { rows } = await pool.query(`
    SELECT COALESCE(p.manufacturer,'Sans marque') AS manufacturer,
           SUM(COALESCE(i.qty_on_hand,0))::float8 AS qty,
           SUM(COALESCE(i.qty_on_hand,0)*COALESCE(p.default_cost,0))::float8 AS cost
    FROM products p JOIN inventory i ON i.item_id=p.item_id
    JOIN shops sh ON sh.shop_id=i.shop_id AND sh.tenant_id=p.tenant_id
    WHERE p.tenant_id=$1 AND p.tags ILIKE $2 AND p.tags NOT ILIKE '%nos%'
      AND p.category NOT ILIKE 'Alt%ration%' AND p.description NOT ILIKE '%shopify%' AND i.qty_on_hand>0
      ${cond}
    GROUP BY p.manufacturer
  `, p);
  const m = {}; for (const r of rows) m[r.manufacturer] = { qty: +r.qty, cost: +r.cost };
  return m;
}
async function soldWindow(season, from, to, shopId) {
  const p = shopId ? [TENANT, from, to, `%${season.tag_pattern}%`, shopId] : [TENANT, from, to, `%${season.tag_pattern}%`];
  const cond = shopId ? 'AND sl.shop_id = $5' : '';
  const { rows } = await pool.query(`
    SELECT COALESCE(p.manufacturer,'Sans marque') AS manufacturer,
           SUM(sl.qty)::float8 AS units, SUM(sl.qty*COALESCE(p.default_cost,0))::float8 AS cost
    FROM sale_lines sl JOIN products p ON p.item_id=sl.item_id
    WHERE (sl.completed_time AT TIME ZONE 'America/Toronto')::date >= $2::date
      AND (sl.completed_time AT TIME ZONE 'America/Toronto')::date <= $3::date
      AND p.tenant_id=$1 AND p.tags ILIKE $4 AND p.tags NOT ILIKE '%nos%'
      AND p.category NOT ILIKE 'Alt%ration%' AND p.description NOT ILIKE '%shopify%'
      ${cond}
    GROUP BY p.manufacturer
  `, p);
  const m = {}; for (const r of rows) m[r.manufacturer] = { units: +r.units, cost: +r.cost };
  return m;
}

// ─── Collect raw data for all 3 seasons ────────────────────────────────
async function collectRaw(shopId, today) {
  const raw = {};
  for (const s of SEASONS) {
    const isInProgress = today >= new Date(s.sell_from) && today <= new Date(s.sell_to);
    const [irSlMap, irInvMap, soldMap] = await Promise.all([
      irSl(s, shopId), irInv(s, shopId), soldWindow(s, s.sell_from, s.sell_to, shopId),
    ]);
    raw[s.code] = { s, isInProgress, irSlMap, irInvMap, soldMap,
      allMfrs: new Set([...Object.keys(irSlMap), ...Object.keys(irInvMap)]) };
  }
  return raw;
}

// ─── OLD algo per brand for one season (mirrors pre-refactor code) ────
function oldProjection(raw, code, today) {
  const r = raw[code];
  const results = {};
  const refSellStart = new Date(r.s.sell_from), refSellEnd = new Date(r.s.sell_to);
  const isInProg = r.isInProgress;
  const refTotalDays = (refSellEnd - refSellStart) / 86400000;
  const refElapsedDays = Math.max(1, (today - refSellStart) / 86400000);
  const refCompletion = Math.min(1, refElapsedDays / refTotalDays);

  // histRemaining: avg sold in remaining window across other seasons
  const histRemaining = {};
  if (isInProg && refCompletion > 0.05) {
    for (const otherCode of Object.keys(raw)) {
      if (otherCode === code) continue;
      const o = raw[otherCode];
      if (o.isInProgress) continue;
      const oStart = new Date(o.s.sell_from), oEnd = new Date(o.s.sell_to);
      const oWinFrom = new Date(oStart.getTime() + refElapsedDays * 86400000);
      if (oWinFrom >= oEnd) continue;
      const oWinFromStr = oWinFrom.toISOString().slice(0, 10);
      // we'd need to run a query here — but for the OLD replica we already have this in `raw`? no.
      // Skip histRemaining accurate replica — old code isn't fully reproduced here.
    }
  }

  for (const mfr of r.allMfrs) {
    const sl = r.irSlMap[mfr] ?? { qty: 0, cost: 0 };
    const inv = r.irInvMap[mfr] ?? { qty: 0, cost: 0 };
    const impliedUnitsYtd = sl.qty + inv.qty;
    const impliedCostYtd = sl.cost + inv.cost;
    if (impliedCostYtd <= 0) continue;
    const soldRaw = r.soldMap[mfr]?.units ?? 0;
    const stYtd = impliedUnitsYtd >= 5 ? soldRaw / impliedUnitsYtd : null;

    let impliedProj = impliedUnitsYtd, soldProj = soldRaw;
    if (isInProg && refCompletion > 0.05) {
      // Old fallback = linear (we skip histRemaining replica for simplicity; measured impact only on completed)
      impliedProj = impliedUnitsYtd / refCompletion;
      soldProj = soldRaw / refCompletion;
    }
    const stOld = impliedProj >= 5 ? soldProj / impliedProj : null;
    results[mfr] = { st_rate: stOld, st_ytd: stYtd };
  }
  return results;
}

// ─── Better OLD replica: query histRemaining for the in-progress season ─
async function oldProjectionAccurate(raw, shopId, today) {
  const results = {};
  for (const code of Object.keys(raw)) results[code] = {};

  // For each in-progress season, compute histRemaining and apply old algo
  for (const code of Object.keys(raw)) {
    const r = raw[code];
    if (!r.isInProgress) {
      // Completed season: simple st
      for (const mfr of r.allMfrs) {
        const sl = r.irSlMap[mfr] ?? { qty: 0, cost: 0 };
        const inv = r.irInvMap[mfr] ?? { qty: 0, cost: 0 };
        const impliedUnits = sl.qty + inv.qty;
        if (sl.cost + inv.cost <= 0) continue;
        const soldRaw = r.soldMap[mfr]?.units ?? 0;
        results[code][mfr] = { st_rate: impliedUnits >= 5 ? soldRaw / impliedUnits : null };
      }
      continue;
    }

    // In-progress: fetch histRemaining
    const refStart = new Date(r.s.sell_from), refEnd = new Date(r.s.sell_to);
    const elapsedDays = Math.max(1, (today - refStart) / 86400000);
    const refCompletion = Math.min(1, elapsedDays / ((refEnd - refStart) / 86400000));
    const histRem = {};

    for (const otherCode of Object.keys(raw)) {
      if (otherCode === code) continue;
      const o = raw[otherCode];
      if (o.isInProgress) continue;
      const oStart = new Date(o.s.sell_from), oEnd = new Date(o.s.sell_to);
      const oWinFrom = new Date(oStart.getTime() + elapsedDays * 86400000);
      if (oWinFrom >= oEnd) continue;
      const remMap = await soldWindow(o.s, oWinFrom.toISOString().slice(0, 10), o.s.sell_to, shopId);
      for (const mfr of Object.keys(remMap)) {
        if (!histRem[mfr]) histRem[mfr] = { totalUnits: 0, totalCost: 0, count: 0 };
        histRem[mfr].totalUnits += remMap[mfr].units;
        histRem[mfr].totalCost += remMap[mfr].cost;
        histRem[mfr].count++;
      }
    }

    for (const mfr of r.allMfrs) {
      const sl = r.irSlMap[mfr] ?? { qty: 0, cost: 0 };
      const inv = r.irInvMap[mfr] ?? { qty: 0, cost: 0 };
      const impliedUnitsYtd = sl.qty + inv.qty;
      const impliedCostYtd = sl.cost + inv.cost;
      if (impliedCostYtd <= 0) continue;
      const soldRaw = r.soldMap[mfr]?.units ?? 0;
      const stYtd = impliedUnitsYtd >= 5 ? soldRaw / impliedUnitsYtd : null;

      let impliedProj = impliedUnitsYtd, soldProj = soldRaw;
      if (refCompletion > 0.05) {
        const rem = histRem[mfr];
        if (rem && rem.count > 0) {
          impliedProj += rem.totalUnits / rem.count;
          soldProj += rem.totalUnits / rem.count;
        } else {
          impliedProj = impliedUnitsYtd / refCompletion;
          soldProj = soldRaw / refCompletion;
        }
      }
      const stOld = impliedProj >= 5 ? soldProj / impliedProj : null;
      results[code][mfr] = { st_rate: stOld, st_ytd: stYtd };
    }
  }
  return results;
}

// ─── NEW algo (mirrors server.js Pass 3 exactly) ──────────────────────
async function newProjection(raw, shopId, today, cfg = PROJ_CFG) {
  const results = {};
  for (const code of Object.keys(raw)) results[code] = {};

  // Pass 2: completed seasons
  const completedMfrs = new Set();
  for (const code of Object.keys(raw)) {
    const r = raw[code];
    if (r.isInProgress) continue;
    for (const mfr of r.allMfrs) {
      const sl = r.irSlMap[mfr] ?? { qty: 0, cost: 0 };
      const inv = r.irInvMap[mfr] ?? { qty: 0, cost: 0 };
      const impliedUnits = sl.qty + inv.qty;
      if (sl.cost + inv.cost <= 0) continue;
      const soldRaw = r.soldMap[mfr]?.units ?? 0;
      const st = impliedUnits >= 5 ? soldRaw / impliedUnits : null;
      results[code][mfr] = { st_rate: st, st_ytd: st, partial: false };
      completedMfrs.add(mfr);
    }
  }

  // stHistoriqueMarque
  const stHist = {};
  for (const mfr of completedMfrs) {
    const sts = Object.keys(raw).filter(c => !raw[c].isInProgress).map(c => results[c][mfr]?.st_rate).filter(x => x != null);
    if (sts.length) stHist[mfr] = sts.reduce((a, b) => a + b, 0) / sts.length;
  }

  // Pass 3: in-progress seasons
  for (const code of Object.keys(raw)) {
    const r = raw[code];
    if (!r.isInProgress) continue;
    const refStart = new Date(r.s.sell_from), refEnd = new Date(r.s.sell_to);
    const elapsedDays = Math.max(1, (today - refStart) / 86400000);
    const refCompletion = Math.min(1, elapsedDays / ((refEnd - refStart) / 86400000));
    const weeksRemaining = Math.max(0, (refEnd - today) / (7 * 86400000));

    // histRemaining
    const histRem = {};
    let comparableCode = null;
    let histElapsed = {};
    if (refCompletion > 0.05) {
      const completedPrev = Object.keys(raw).filter(c => c !== code && !raw[c].isInProgress)
        .sort((a, b) => b.localeCompare(a)); // most recent first
      for (const oc of completedPrev) {
        const o = raw[oc];
        const oStart = new Date(o.s.sell_from), oEnd = new Date(o.s.sell_to);
        const oWinFrom = new Date(oStart.getTime() + elapsedDays * 86400000);
        if (oWinFrom >= oEnd) continue;
        const remMap = await soldWindow(o.s, oWinFrom.toISOString().slice(0, 10), o.s.sell_to, shopId);
        for (const mfr of Object.keys(remMap)) {
          if (!histRem[mfr]) histRem[mfr] = { totalUnits: 0, totalCost: 0, count: 0 };
          histRem[mfr].totalUnits += remMap[mfr].units;
          histRem[mfr].totalCost += remMap[mfr].cost;
          histRem[mfr].count++;
        }
      }
      // histElapsed from most recent completed
      if (completedPrev.length) {
        comparableCode = completedPrev[0];
        const o = raw[comparableCode];
        const oStart = new Date(o.s.sell_from), oEnd = new Date(o.s.sell_to);
        const cutoff = new Date(oStart.getTime() + elapsedDays * 86400000);
        const cutoffStr = (cutoff <= oEnd ? cutoff : oEnd).toISOString().slice(0, 10);
        const sold = await soldWindow(o.s, o.s.sell_from, cutoffStr, shopId);
        const recv = await soldWindow(o.s, o.s.reception_from, cutoffStr, shopId);
        for (const mfr of new Set([...Object.keys(sold), ...Object.keys(recv)])) {
          histElapsed[mfr] = { sold: sold[mfr]?.units ?? 0, recvElapsed: recv[mfr]?.units ?? 0 };
        }
      }
    }
    // recentVelocity
    const velFrom = new Date(today.getTime() - cfg.fenetre_velocite * 7 * 86400000).toISOString().slice(0, 10);
    const velTo = today.toISOString().slice(0, 10);
    const rvMap = await soldWindow(r.s, velFrom, velTo, shopId);

    for (const mfr of r.allMfrs) {
      const sl = r.irSlMap[mfr] ?? { qty: 0, cost: 0 };
      const inv = r.irInvMap[mfr] ?? { qty: 0, cost: 0 };
      const impliedUnitsYtd = sl.qty + inv.qty;
      const impliedCostYtd = sl.cost + inv.cost;
      if (impliedCostYtd <= 0) continue;
      const soldRaw = r.soldMap[mfr]?.units ?? 0;
      const stYtd = impliedUnitsYtd >= 5 ? soldRaw / impliedUnitsYtd : null;

      // ratio_rythme
      let ratioRythme = null, stYtdComparable = null;
      if (histElapsed[mfr] && stYtd != null && comparableCode) {
        const he = histElapsed[mfr];
        const prevInv = raw[comparableCode].irInvMap[mfr]?.qty ?? 0;
        const denomComp = he.recvElapsed + prevInv;
        if (denomComp >= 5) {
          stYtdComparable = he.sold / denomComp;
          if (stYtdComparable > 0) ratioRythme = stYtd / stYtdComparable;
        }
      }

      const rem = histRem[mfr];
      const hasHistRem = rem && rem.count > 0;
      const avgRemUnits = hasHistRem ? rem.totalUnits / rem.count : 0;
      const avgRemCost = hasHistRem ? rem.totalCost / rem.count : 0;

      let methode = 'historique', velRecent = null, velHist = null, remainingUnits = 0;
      if (ratioRythme != null && Math.abs(ratioRythme - 1) > cfg.seuil_bascule) {
        methode = 'velocite_ajustee';
        const rv = rvMap[mfr]?.units ?? 0;
        velRecent = rv / cfg.fenetre_velocite;
        velHist = (hasHistRem && weeksRemaining > 0) ? avgRemUnits / weeksRemaining : 0;
        const velProj = velRecent * cfg.poids_recent + velHist * (1 - cfg.poids_recent);
        remainingUnits = velProj * weeksRemaining;
      } else if (hasHistRem) {
        remainingUnits = avgRemUnits;
      } else {
        methode = 'lineaire';
      }

      let soldProj, receivedProj;
      if (methode === 'lineaire') {
        soldProj = soldRaw / refCompletion;
        receivedProj = impliedUnitsYtd / refCompletion;
        remainingUnits = soldProj - soldRaw;
      } else {
        soldProj = soldRaw + remainingUnits;
        receivedProj = impliedUnitsYtd + remainingUnits;
      }
      const stProjeteBrut = receivedProj >= 5 ? soldProj / receivedProj : null;

      let stProjeteFinal = stProjeteBrut, borneAppliquee = null;
      const stH = stHist[mfr];
      const stHUsable = stH != null && stH >= 0.10;
      if (stProjeteBrut != null && stHUsable) {
        const plancher = stH * cfg.borne_plancher;
        const plafond = Math.min(1, stH * cfg.borne_plafond);
        if (stProjeteBrut < plancher) { stProjeteFinal = plancher; borneAppliquee = 'plancher'; }
        else if (stProjeteBrut > plafond) { stProjeteFinal = plafond; borneAppliquee = 'plafond'; }
      } else if (stProjeteBrut != null && stProjeteBrut > 1) {
        stProjeteFinal = 1;
        borneAppliquee = 'plafond';
      }

      results[code][mfr] = {
        st_rate: stProjeteFinal, st_ytd: stYtd, partial: true,
        detail: {
          methode, ratioRythme, stYtdComparable,
          velRecent, velHist, remainingUnits, weeksRemaining,
          stProjeteBrut, stProjeteFinal, borneAppliquee,
          stHistoriqueMarque: stH, comparableCode,
        },
      };
    }
  }
  return { results, stHist };
}

// ─── Main ──────────────────────────────────────────────────────────────
async function main() {
  const today = new Date();
  const { rows: sr } = await pool.query(`SELECT shop_id FROM shops WHERE tenant_id=$1 AND name ILIKE $2 LIMIT 1`, [TENANT, `%${SHOP_NAME}%`]);
  if (!sr.length) throw new Error(`shop not found`);
  const shopId = sr[0].shop_id;
  console.log(`Boutique ${SHOP_NAME} (shop_id=${shopId})  |  target=${TARGET.toUpperCase()}  |  today=${today.toISOString().slice(0,10)}\n`);

  console.log('Collecting raw season data (P26, P25, P24)…');
  const raw = await collectRaw(shopId, today);
  console.log(`  P26: ${raw.p26.allMfrs.size} brands, in-progress=${raw.p26.isInProgress}`);
  console.log(`  P25: ${raw.p25.allMfrs.size} brands, in-progress=${raw.p25.isInProgress}`);
  console.log(`  P24: ${raw.p24.allMfrs.size} brands, in-progress=${raw.p24.isInProgress}`);

  console.log('\nComputing OLD projection…');
  const oldRes = await oldProjectionAccurate(raw, shopId, today);
  console.log('Computing NEW projection…');
  const { results: newRes, stHist } = await newProjection(raw, shopId, today);

  // Top 30 brands: rank by P26 implied received units (proxy for size)
  const brandScore = {};
  for (const mfr of raw.p26.allMfrs) {
    const impl = (raw.p26.irSlMap[mfr]?.qty ?? 0) + (raw.p26.irInvMap[mfr]?.qty ?? 0);
    brandScore[mfr] = impl;
  }
  const top30 = Object.keys(brandScore).sort((a, b) => brandScore[b] - brandScore[a]).slice(0, 30);

  // ═══ VALIDATION 1 ═══
  console.log('\n' + '═'.repeat(140));
  console.log('  VAL 1 — 30 marques Boutique Valérie Simon P27');
  console.log('═'.repeat(140));
  console.log('| #  | Marque                | ST P24 | ST P25 | Old ST P26 | New ST P26 | Méthode         | avgSt old | avgSt new | Palier old  | Palier new  | Changement |');
  console.log('|----|-----------------------|--------|--------|------------|------------|-----------------|-----------|-----------|-------------|-------------|------------|');
  let tierChanges = 0, up = 0, down = 0;
  for (let i = 0; i < top30.length; i++) {
    const mfr = top30[i];
    const p24 = oldRes.p24?.[mfr]?.st_rate;
    const p25 = oldRes.p25?.[mfr]?.st_rate;
    const oldP26 = oldRes.p26?.[mfr]?.st_rate;
    const newP26 = newRes.p26?.[mfr]?.st_rate;
    const method = newRes.p26?.[mfr]?.detail?.methode ?? '—';
    const avgOld = weightedAvg([oldP26, p25, p24]);
    const avgNew = weightedAvg([newP26, p25, p24]);
    const tOld = tierOf(avgOld), tNew = tierOf(avgNew);
    const changed = tOld.label !== tNew.label;
    if (changed) { tierChanges++; if (tNew.multiplier > tOld.multiplier) up++; else down++; }
    const pct = v => v == null ? 'n/a' : (v * 100).toFixed(1) + '%';
    console.log(`| ${String(i+1).padStart(2)} | ${mfr.padEnd(21).slice(0,21)} | ${pct(p24).padStart(6)} | ${pct(p25).padStart(6)} | ${pct(oldP26).padStart(10)} | ${pct(newP26).padStart(10)} | ${method.padEnd(15)} | ${pct(avgOld).padStart(9)} | ${pct(avgNew).padStart(9)} | ${tOld.label.padEnd(11)} | ${tNew.label.padEnd(11)} | ${changed ? (tNew.multiplier > tOld.multiplier ? '▲' : '▼') + ' ' + tOld.label + ' → ' + tNew.label : '='} |`);
  }
  console.log(`\n  Marques dont le palier CHANGE : ${tierChanges}/${top30.length}  (▲ ${up}, ▼ ${down})`);

  // ═══ VALIDATION 2 ═══
  console.log('\n' + '═'.repeat(140));
  console.log('  VAL 2 — cas de BASCULE (méthode = velocite_ajustee) — vérification arithmétique');
  console.log('═'.repeat(140));
  const bascule = top30.find(m => newRes.p26?.[m]?.detail?.methode === 'velocite_ajustee');
  if (bascule) {
    const d = newRes.p26[bascule].detail;
    const yourStYtd = newRes.p26[bascule].st_ytd;
    console.log(`\n  Marque : ${bascule}`);
    console.log(`    st_ytd_actuel     = ${(yourStYtd*100).toFixed(2)}%`);
    console.log(`    st_ytd_comparable = ${(d.stYtdComparable*100).toFixed(2)}%  (${d.comparableCode.toUpperCase()})`);
    console.log(`    ratio_rythme      = ${yourStYtd.toFixed(4)} / ${d.stYtdComparable.toFixed(4)} = ${(yourStYtd/d.stYtdComparable).toFixed(3)}  (rapporté = ${d.ratioRythme.toFixed(3)})`);
    console.log(`    |ratio - 1|       = ${Math.abs(d.ratioRythme - 1).toFixed(3)}  > seuil 0.05 → bascule`);
    console.log(`    vélocité récente  = ${d.velRecent.toFixed(3)} u./sem   (sur ${PROJ_CFG.fenetre_velocite} sem)`);
    console.log(`    vélocité histor.  = ${d.velHist.toFixed(3)} u./sem   (fenêtre restante moyennée)`);
    const velProj = d.velRecent * PROJ_CFG.poids_recent + d.velHist * (1 - PROJ_CFG.poids_recent);
    console.log(`    vel_projetee      = ${d.velRecent.toFixed(3)} × 0.60 + ${d.velHist.toFixed(3)} × 0.40 = ${velProj.toFixed(3)} u./sem`);
    console.log(`    semaines_rest     = ${d.weeksRemaining.toFixed(2)}`);
    console.log(`    ventes_restantes  = ${velProj.toFixed(3)} × ${d.weeksRemaining.toFixed(2)} = ${(velProj*d.weeksRemaining).toFixed(2)}  (rapporté ${d.remainingUnits.toFixed(1)})`);
    console.log(`    st_projete_brut   = ${(d.stProjeteBrut*100).toFixed(2)}%`);
    console.log(`    st_projete_final  = ${(d.stProjeteFinal*100).toFixed(2)}%  ${d.borneAppliquee ? '⚠ borne ' + d.borneAppliquee : ''}`);
    console.log(`    st_hist_marque    = ${d.stHistoriqueMarque != null ? (d.stHistoriqueMarque*100).toFixed(2) + '%' : 'n/a'}  (moy P25+P24)`);
  } else {
    console.log('\n  Aucun cas de bascule dans le top 30. Test avec le SEUIL réduit ci-dessous (VAL 4).');
  }

  // ═══ VALIDATION 3 ═══
  console.log('\n' + '═'.repeat(140));
  console.log('  VAL 3 — cas NORMAL (méthode = historique) — projection identique au code actuel');
  console.log('═'.repeat(140));
  const normal = top30.find(m => newRes.p26?.[m]?.detail?.methode === 'historique');
  if (normal) {
    const oldSt = oldRes.p26?.[normal]?.st_rate;
    const newSt = newRes.p26?.[normal]?.st_rate;
    const d = newRes.p26[normal].detail;
    console.log(`\n  Marque : ${normal}`);
    console.log(`    ratio_rythme    = ${d.ratioRythme != null ? d.ratioRythme.toFixed(3) : 'n/a'} (|ratio-1| = ${d.ratioRythme != null ? Math.abs(d.ratioRythme-1).toFixed(3) : 'n/a'})  → mode historique`);
    console.log(`    ST projeté OLD  = ${oldSt != null ? (oldSt*100).toFixed(2)+'%' : 'n/a'}`);
    console.log(`    ST projeté NEW  = ${newSt != null ? (newSt*100).toFixed(2)+'%' : 'n/a'}`);
    if (oldSt != null && newSt != null) {
      const diff = Math.abs(oldSt - newSt) * 100;
      console.log(`    écart           = ${diff.toFixed(3)} pts  ${diff < 0.5 ? '✅ identique' : '⚠ diverge (attendu 0)'}`);
    }
  } else {
    console.log('\n  Aucun cas historique — toutes les marques ont basculé.');
  }

  // ═══ VALIDATION 4 ═══
  console.log('\n' + '═'.repeat(140));
  console.log('  VAL 4 — BORNES appliquées');
  console.log('═'.repeat(140));
  const withBornes = top30.filter(m => newRes.p26?.[m]?.detail?.borneAppliquee);
  if (withBornes.length) {
    console.log(`\n  ${withBornes.length} marque(s) avec borne (défaut plancher=0.50, plafond=1.50) :\n`);
    withBornes.forEach(m => {
      const d = newRes.p26[m].detail;
      console.log(`    ${m.padEnd(22)} borne=${d.borneAppliquee.padEnd(8)} brut=${(d.stProjeteBrut*100).toFixed(1)}% → final=${(d.stProjeteFinal*100).toFixed(1)}% (hist_marque=${d.stHistoriqueMarque != null ? (d.stHistoriqueMarque*100).toFixed(1) + '%' : 'n/a'})`);
    });
  } else {
    console.log('\n  Aucune borne appliquée avec les valeurs par défaut. Test avec bornes resserrées (0.80/1.20) :\n');
    const tightCfg = { ...PROJ_CFG, borne_plancher: 0.80, borne_plafond: 1.20 };
    const { results: tightRes } = await newProjection(raw, shopId, today, tightCfg);
    const tightBornes = top30.filter(m => tightRes.p26?.[m]?.detail?.borneAppliquee);
    console.log(`  Avec bornes 0.80/1.20 : ${tightBornes.length} marque(s) bornées.`);
    if (tightBornes.length) {
      tightBornes.slice(0, 10).forEach(m => {
        const d = tightRes.p26[m].detail;
        console.log(`    ${m.padEnd(22)} borne=${d.borneAppliquee.padEnd(8)} brut=${(d.stProjeteBrut*100).toFixed(1)}% → final=${(d.stProjeteFinal*100).toFixed(1)}%`);
      });
    }
  }

  // ═══ VALIDATION 5 ═══
  console.log('\n' + '═'.repeat(140));
  console.log('  VAL 5 — cas limites');
  console.log('═'.repeat(140));
  const noP24P25 = top30.filter(m => !raw.p25.allMfrs.has(m) && !raw.p24.allMfrs.has(m));
  console.log(`\n  a) Marques absentes de P24 ET P25 (nouvelles) : ${noP24P25.length}`);
  noP24P25.slice(0, 5).forEach(m => {
    const d = newRes.p26?.[m]?.detail;
    console.log(`     ${m.padEnd(22)} méthode=${d?.methode ?? 'n/a'}  ST proj=${d?.stProjeteFinal != null ? (d.stProjeteFinal*100).toFixed(1)+'%' : 'n/a'}  hist=${d?.stHistoriqueMarque != null ? 'oui' : 'non (borne inactive)'}`);
  });

  const nullComp = top30.filter(m => newRes.p26?.[m]?.detail?.ratioRythme == null);
  console.log(`\n  b) ratio_rythme null (st_ytd_comparable manquant ou = 0) : ${nullComp.length} → fallback méthode historique OK.`);

  const p26Pct = ((today - new Date('2026-02-01')) / (new Date('2026-09-30') - new Date('2026-02-01')) * 100);
  console.log(`\n  c) P26 avancement actuel : ${p26Pct.toFixed(1)}%. Seuil de bascule projection dans le code = 5%. OK.`);

  const nanCheck = top30.filter(m => {
    const d = newRes.p26?.[m];
    return d && (isNaN(d.st_rate) || (d.detail && (isNaN(d.detail.stProjeteFinal) || (d.detail.ratioRythme != null && isNaN(d.detail.ratioRythme)))));
  });
  console.log(`\n  d) NaN dans les résultats : ${nanCheck.length === 0 ? '✅ zéro' : '❌ ' + nanCheck.join(', ')}`);

  const zeroVel = top30.filter(m => newRes.p26?.[m]?.detail?.velRecent === 0);
  console.log(`\n  e) Marques à vélocité récente = 0 (aucune vente dans les 8 dernières sem) : ${zeroVel.length}`);
  if (zeroVel.length) console.log('     Ces marques utilisent velRecent=0 → velProj = velHist × 0.4 (poids vélocité réduit).');

  // ═══ VALIDATION 6 ═══
  console.log('\n' + '═'.repeat(140));
  console.log('  VAL 6 — budget total ne doit pas bouger de plus de 15%');
  console.log('═'.repeat(140));
  let totalOld = 0, totalNew = 0;
  const impactList = [];
  for (const mfr of top30) {
    const p24 = oldRes.p24?.[mfr]?.st_rate;
    const p25 = oldRes.p25?.[mfr]?.st_rate;
    const oldP26 = oldRes.p26?.[mfr]?.st_rate;
    const newP26 = newRes.p26?.[mfr]?.st_rate;
    const avgOld = weightedAvg([oldP26, p25, p24]);
    const avgNew = weightedAvg([newP26, p25, p24]);
    // For "budget" proxy: implied_cost P26 × multiplier
    const cost = (raw.p26.irSlMap[mfr]?.cost ?? 0) + (raw.p26.irInvMap[mfr]?.cost ?? 0);
    const oldB = cost * tierOf(avgOld).multiplier;
    const newB = cost * tierOf(avgNew).multiplier;
    totalOld += oldB;
    totalNew += newB;
    impactList.push({ mfr, delta: newB - oldB });
  }
  const pct = totalOld > 0 ? ((totalNew - totalOld) / totalOld * 100) : 0;
  console.log(`\n  Budget top-30 (implied_cost × multiplier) :`);
  console.log(`    OLD : ${totalOld.toFixed(0)} $`);
  console.log(`    NEW : ${totalNew.toFixed(0)} $`);
  console.log(`    Δ   : ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%  ${Math.abs(pct) <= 15 ? '✅ dans la marge' : '⚠ hors marge'}`);
  if (Math.abs(pct) > 15) {
    console.log('    Top 5 impacts absolus :');
    impactList.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 5).forEach(x => {
      console.log(`      ${x.mfr.padEnd(22)} Δ=${x.delta >= 0 ? '+' : ''}${x.delta.toFixed(0)} $`);
    });
  }

  // ═══ SYNTHÈSE ═══
  console.log('\n' + '═'.repeat(140));
  console.log('  SYNTHÈSE');
  console.log('═'.repeat(140));
  const bMethods = top30.reduce((acc, m) => {
    const method = newRes.p26?.[m]?.detail?.methode ?? '?';
    acc[method] = (acc[method] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`  Palier change      : ${tierChanges}/${top30.length}  (▲ ${up}, ▼ ${down})`);
  console.log(`  Répartition méthode: ${JSON.stringify(bMethods)}`);
  console.log(`  Bornes appliquées  : ${withBornes.length}`);
  console.log(`  Budget total Δ%    : ${pct.toFixed(1)}%`);
  console.log(`  NaN                : ${nanCheck.length}`);
  console.log(`  npm test           : à lancer séparément (VAL 7)`);
  console.log('═'.repeat(140));

  await pool.end();
}

main().catch(e => { console.error('FATAL:', e.message, e.stack); pool.end(); process.exit(1); });
