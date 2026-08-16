#!/usr/bin/env node
'use strict';
// -----------------------------------------------------------------------------
// Chatbot golden set runner
// -----------------------------------------------------------------------------
// Sends each question from tests/chatbot-golden-set.json to a chosen provider,
// captures the first tool_call, compares against expected_tool/expected_params,
// and reports a pass/fail score.
//
// Usage:
//   node tests/run-golden-set.js --provider mistral --model mistral-small-latest
//   node tests/run-golden-set.js --provider openai  --model gpt-4o-mini
//   node tests/run-golden-set.js --provider anthropic --model claude-haiku-4-5-20251001
//   node tests/run-golden-set.js --provider mistral --model mistral-large-latest --limit 5
//   node tests/run-golden-set.js --provider mistral --model mistral-small-latest --only sales_scope_marque_saison_ambigu
//
// Requires env vars (any one of):
//   MISTRAL_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY
// -----------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

// -----------------------------------------------------------------------------
// CLI parsing
// -----------------------------------------------------------------------------
const args = process.argv.slice(2);
function argVal(flag, dflt) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
function argFlag(flag) { return args.includes(flag); }

const PROVIDER = argVal('--provider', 'mistral').toLowerCase();
const MODEL    = argVal('--model', null);
const LIMIT    = parseInt(argVal('--limit', '0'), 10) || 0;
const ONLY_ID  = argVal('--only', null);
const VERBOSE  = argFlag('--verbose');
const OUTFILE  = argVal('--out', null);
const DELAY_MS = parseInt(argVal('--delay', '800'), 10);

if (!['mistral', 'openai', 'anthropic'].includes(PROVIDER)) {
  console.error(`Unknown provider: "${PROVIDER}". Use mistral | openai | anthropic.`);
  process.exit(1);
}

// Set env so ai-provider.js picks up the right config
process.env.AI_PROVIDER = PROVIDER;
if (MODEL) process.env.AI_MODEL = MODEL;

const keyEnv = { mistral: 'MISTRAL_API_KEY', openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' }[PROVIDER];
if (!process.env[keyEnv]) {
  console.error(`Missing env var: ${keyEnv}. Set it (or use \`railway run node tests/run-golden-set.js\`).`);
  process.exit(1);
}

// -----------------------------------------------------------------------------
// Load provider + build a minimal ctx-like system prompt (same as production)
// -----------------------------------------------------------------------------
const { createProvider, buildSystemPrompt } = require('../ai-provider');

// We inject a minimal liveContext similar to ai-agent.js so the LLM has date +
// seasons context. Keeps the test aligned with real runtime behavior.
const today = new Date().toISOString().slice(0, 10);
const liveContext = `

DATE ACTUELLE : ${today}
BOUTIQUES DISPONIBLES : Fan Club, Saint-Bruno, Saint-Sauveur, Pour lui, Valérie Simon
SAISONS :
- Saison en cours (ventes actives) : P26 — Printemps 2026
- Saison en préparation : A26 — Automne 2026
- Prochaine saison : P27 — Printemps 2027
Toutes les saisons configurées : p24, a24, p25, a25, p26, a26, p27
- "cette saison" → p26
- "ce printemps" / "au printemps" → p26
- "l'automne prochain" → a26
`;

const systemPrompt = buildSystemPrompt({}) + liveContext;

// -----------------------------------------------------------------------------
// Load golden set
// -----------------------------------------------------------------------------
const goldenPath = path.join(__dirname, 'chatbot-golden-set.json');
const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));
let cases = golden.cases;
if (ONLY_ID) cases = cases.filter(c => c.id === ONLY_ID);
if (LIMIT > 0) cases = cases.slice(0, LIMIT);

console.log(`\nRunner Chatbot golden set — ${PROVIDER} / ${MODEL || '(default model)'}`);
console.log(`Cases: ${cases.length} (of ${golden.cases.length} total)`);
console.log(`Date context injected: ${today}\n`);

// -----------------------------------------------------------------------------
// Comparison logic
// -----------------------------------------------------------------------------
function normalizeStr(x) {
  return String(x ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

function paramMatches(expected, actual) {
  if (expected === '__any__') return actual !== undefined && actual !== null;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false;
    if (expected.length !== actual.length) return false;
    return expected.every(v => actual.map(String).map(s => s.toLowerCase()).includes(String(v).toLowerCase()));
  }
  if (typeof expected === 'boolean' || typeof expected === 'number') return expected === actual;
  return normalizeStr(expected) === normalizeStr(actual);
}

function evaluateCase(c, response) {
  const toolCall = response.tool_calls && response.tool_calls[0];
  const actualToolName = toolCall?.function?.name || null;
  const actualArgs = toolCall ? (() => {
    try { return JSON.parse(toolCall.function.arguments || '{}'); }
    catch { return {}; }
  })() : {};
  const actualText = (response.content || '').trim();

  // Case: expect no tool (definition/clarification) — but alternatives still count as pass
  if (c.expected_tool === null || c.expected_tool === '__ASK_CLARIFICATION__') {
    if (!actualToolName) return { pass: true, reason: 'no tool called (as expected)', actual: { tool: null, text: actualText } };
    const acceptedAlts = (c.expected_alternatives || []).filter(x => x && x !== 'MULTI_CALL');
    if (acceptedAlts.includes(actualToolName)) {
      return { pass: true, reason: `tool ${actualToolName} accepted (in alternatives to ${c.expected_tool})`, actual: { tool: actualToolName, args: actualArgs } };
    }
    return { pass: false, reason: `expected no tool (or ${acceptedAlts.join(', ')}), got ${actualToolName}(${JSON.stringify(actualArgs).slice(0,80)})`, actual: { tool: actualToolName, args: actualArgs } };
  }

  // Case: expect a specific tool (with alternatives)
  const acceptedTools = [c.expected_tool, ...(c.expected_alternatives || [])].filter(x => x && x !== 'MULTI_CALL');
  if (!actualToolName) {
    return { pass: false, reason: `expected ${c.expected_tool}, got no tool call. TEXT: "${actualText.slice(0,120)}${actualText.length>120?'…':''}"`, actual: { tool: null, text: actualText } };
  }
  if (!acceptedTools.includes(actualToolName)) {
    return { pass: false, reason: `expected ${c.expected_tool} (or ${c.expected_alternatives || []}), got ${actualToolName}`, actual: { tool: actualToolName, args: actualArgs } };
  }

  // Params check
  const paramErrs = [];
  for (const [k, v] of Object.entries(c.expected_params || {})) {
    if (!paramMatches(v, actualArgs[k])) {
      paramErrs.push(`${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(actualArgs[k])}`);
    }
  }
  if (paramErrs.length) {
    return { pass: false, reason: `tool OK (${actualToolName}) but params mismatch: ${paramErrs.join('; ')}`, actual: { tool: actualToolName, args: actualArgs } };
  }

  return { pass: true, reason: `tool ${actualToolName} + params match`, actual: { tool: actualToolName, args: actualArgs } };
}

// -----------------------------------------------------------------------------
// Run
// -----------------------------------------------------------------------------
async function run() {
  const provider = createProvider();
  const results = [];
  let pass = 0, fail = 0;
  const startAll = Date.now();

  for (const c of cases) {
    const start = Date.now();
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: c.question },
    ];
    let response;
    try {
      response = await provider.complete(messages);
    } catch (err) {
      const r = { id: c.id, pass: false, reason: `PROVIDER ERROR: ${err.message}`, question: c.question };
      results.push(r);
      fail++;
      console.log(`❌ ${c.id.padEnd(45)} — ${r.reason.slice(0, 100)}`);
      continue;
    }
    const evalRes = evaluateCase(c, response);
    const durationMs = Date.now() - start;
    const r = {
      id: c.id,
      category: c.category,
      pass: evalRes.pass,
      reason: evalRes.reason,
      question: c.question,
      expected_tool: c.expected_tool,
      expected_params: c.expected_params,
      actual: evalRes.actual,
      duration_ms: durationMs,
    };
    results.push(r);
    if (evalRes.pass) { pass++; console.log(`✅ ${c.id.padEnd(45)} — ${evalRes.reason.slice(0, 80)} [${durationMs}ms]`); }
    else { fail++; console.log(`❌ ${c.id.padEnd(45)} — ${evalRes.reason.slice(0, 100)} [${durationMs}ms]`); }
    if (VERBOSE) console.log(`   Q: ${c.question}\n   Actual: ${JSON.stringify(evalRes.actual)}\n`);
    if (DELAY_MS > 0) await new Promise(r => setTimeout(r, DELAY_MS));
  }

  const durationTotal = ((Date.now() - startAll) / 1000).toFixed(1);
  const rate = ((pass / (pass + fail)) * 100).toFixed(1);
  console.log(`\n═══════════════════════════════════════════════════════════════`);
  console.log(`RESULT — ${PROVIDER} / ${MODEL || '(default)'}`);
  console.log(`  ${pass} pass / ${fail} fail — ${rate}% (${pass}/${pass+fail})`);
  console.log(`  Total time: ${durationTotal}s (avg ${(durationTotal / cases.length).toFixed(2)}s/case)`);
  console.log(`═══════════════════════════════════════════════════════════════`);

  // Group failures by category
  const failsByCat = {};
  for (const r of results.filter(r => !r.pass)) {
    (failsByCat[r.category || 'unknown'] ??= []).push(r);
  }
  if (Object.keys(failsByCat).length) {
    console.log(`\nÉchecs par catégorie :`);
    for (const [cat, rs] of Object.entries(failsByCat)) {
      console.log(`  ${cat} (${rs.length}) — ${rs.map(r => r.id).join(', ')}`);
    }
  }

  if (OUTFILE) {
    fs.writeFileSync(OUTFILE, JSON.stringify({
      provider: PROVIDER, model: MODEL, date: new Date().toISOString(),
      total: cases.length, pass, fail, rate_percent: parseFloat(rate),
      duration_seconds: parseFloat(durationTotal),
      results,
    }, null, 2));
    console.log(`\nDetailed results written to ${OUTFILE}`);
  }

  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('FATAL:', err);
  process.exit(2);
});
