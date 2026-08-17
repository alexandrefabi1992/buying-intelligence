#!/usr/bin/env node
'use strict';
// Static-analysis scanner for missing tenant_id filters on tenant-scoped tables.
//
// Extracts backtick SQL strings from each source file, then flags any query
// that reads/writes a tenant-scoped table without mentioning `tenant_id`.
//
// Exit code: 0 if clean, 1 if any violation, 2 if scanner error.
//
// Usage: node scripts/scan-tenant-isolation.js
//        npm run scan:isolation

const fs   = require('fs');
const path = require('path');

// Source of truth: tables that carry a tenant_id column and must be filtered.
// Confirmed by cross-checking INSERT statements (which always include tenant_id
// for scoped tables) with occurrences near `tenant_id` in existing WHERE clauses.
const TENANT_SCOPED = new Set([
  'app_settings',
  'brand_payment_terms',
  'brand_vendor_map',
  'budget_documents',
  'budget_plan_drops',
  'budget_plans',
  'conversations',
  'import_batches',
  'import_files',
  'import_matrix_overrides',
  'import_order_lines',
  'import_queue',
  'inventory',
  'inventory_snapshots',
  'item_attribute_sets',
  'item_attribute_values',
  'item_matrices',
  'manufacturers',
  'orders',
  'parse_recipes',
  'products',
  'sale_lines',
  'sales',
  'shops',
  'sync_state',
  'transfers',
  'users',
]);

// Files to scan. Add new server/lib files here as the project grows.
const FILES = [
  'server.js',
  'sync.js',
  'ai-agent.js',
  'ai-provider.js',
  'lib/import-routes.js',
  'lib/lightspeed-client.js',
  'lib/token-crypto.js',
  'lib/queue-processor.js',
  'lib/style-resolver.js',
  'lib/pdf-extractor.js',
  'lib/pdf-decoder.js',
];

// Queries in these blocks are known-safe (migration/introspection/etc).
// A comment `// tenant-scan: allow` right before the template literal
// marks it as intentionally not-scoped. See extractStrings for handling.
const ALLOW_MARKER = 'tenant-scan: allow';

// ---------------------------------------------------------------------------
// Very small backtick string extractor. Handles nested `${}` interpolations
// and escaped backticks. Returns [{ startLine, endLine, text }]. Ignores
// template strings that don't contain SQL keywords.
// ---------------------------------------------------------------------------
function extractStrings(source) {
  const out = [];
  let i = 0;
  const N = source.length;
  let line = 1;

  while (i < N) {
    const ch = source[i];
    if (ch === '\n') { line++; i++; continue; }

    // Skip line comments
    if (ch === '/' && source[i+1] === '/') {
      while (i < N && source[i] !== '\n') i++;
      continue;
    }
    // Skip block comments
    if (ch === '/' && source[i+1] === '*') {
      i += 2;
      while (i < N && !(source[i] === '*' && source[i+1] === '/')) {
        if (source[i] === '\n') line++;
        i++;
      }
      i += 2;
      continue;
    }
    // Skip single/double-quoted strings entirely (no SQL there in this codebase)
    if (ch === "'" || ch === '"') {
      const quote = ch; i++;
      while (i < N && source[i] !== quote) {
        if (source[i] === '\\') i += 2;
        else if (source[i] === '\n') { line++; i++; }
        else i++;
      }
      i++;
      continue;
    }
    if (ch === '`') {
      const startLine = line;
      const startIdx = i + 1;
      i++;
      let depth = 0;
      while (i < N) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === '\n') { line++; i++; continue; }
        if (depth === 0 && source[i] === '`') break;
        if (source[i] === '$' && source[i+1] === '{') { depth++; i += 2; continue; }
        if (depth > 0 && source[i] === '}') { depth--; i++; continue; }
        i++;
      }
      const text = source.slice(startIdx, i);
      out.push({ startLine, endLine: line, text });
      i++;
      continue;
    }
    i++;
  }
  return out;
}

// Returns the set of tenant-scoped tables referenced by a SQL string.
// Considers FROM|JOIN|INTO|UPDATE followed by an identifier (with optional
// alias). Skips CTE names by first stripping WITH clauses' RHS names is not
// worth it — a false positive on a CTE that happens to match a real table
// name is preferable to a missed real table.
function tablesReferenced(sql) {
  const found = new Set();
  const re = /\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-z_][a-z0-9_]*)/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const t = m[1].toLowerCase();
    if (TENANT_SCOPED.has(t)) found.add(t);
  }
  return found;
}

function hasTenantIdFilter(sql) {
  // Any mention of tenant_id inside the SQL string counts. In practice the
  // scoped queries do `AND tenant_id = $N` or `WHERE tenant_id = ...`. If a
  // query mentions tenant_id at all, we trust the human wrote the filter.
  return /\btenant_id\b/i.test(sql);
}

function looksLikeSQL(str) {
  return /\b(SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|WITH\s+\w+\s+AS)\b/i.test(str);
}

// If a SQL template contains ${...} interpolation, the WHERE conditions are
// often built dynamically (e.g. conditions.push('tenant_id = $1')). In that
// case we look 30 lines above the opening backtick for any tenant_id mention
// — if found, we consider the query safe. This is a permissive heuristic;
// use `// tenant-scan: allow` to explicitly silence known-safe queries.
const CONTEXT_LINES_BEFORE = 30;

function hasInterpolation(sql) {
  return /\$\{/.test(sql);
}

function tenantIdInContextAbove(lines, startLine) {
  const from = Math.max(0, startLine - 1 - CONTEXT_LINES_BEFORE);
  const to   = Math.max(0, startLine - 1);
  for (let i = from; i < to; i++) {
    if (/\btenant_?[Ii]d\b/.test(lines[i])) return true;
  }
  return false;
}

function scanFile(absPath) {
  const source = fs.readFileSync(absPath, 'utf8');
  const strings = extractStrings(source);
  const violations = [];
  const lines = source.split('\n');

  const allowLines = new Set();
  lines.forEach((ln, idx) => {
    if (ln.includes(ALLOW_MARKER)) allowLines.add(idx + 1);
  });

  for (const s of strings) {
    if (!looksLikeSQL(s.text)) continue;
    const tables = tablesReferenced(s.text);
    if (tables.size === 0) continue;
    if (hasTenantIdFilter(s.text)) continue;
    if (allowLines.has(s.startLine - 1) || allowLines.has(s.startLine)) continue;

    // Permissive: if the query uses ${...} interpolation AND tenant_id shows
    // up in the surrounding code, trust that the human wired it via a
    // dynamic WHERE-builder like conditions.push('tenant_id = $N').
    if (hasInterpolation(s.text) && tenantIdInContextAbove(lines, s.startLine)) {
      continue;
    }

    violations.push({
      file: absPath,
      startLine: s.startLine,
      endLine: s.endLine,
      tables: [...tables].sort(),
      snippet: s.text.trim().slice(0, 160).replace(/\s+/g, ' '),
    });
  }
  return violations;
}

// Baseline mechanism — accepts known-existing violations so the scanner can
// gate CI on *new* violations right away, while the backlog is drained
// progressively. Each line: "<relative-path>:<line>:<tables>".
// Regenerate with: node scripts/scan-tenant-isolation.js --update-baseline
const BASELINE_FILE = '.tenant-scan-baseline';

function loadBaseline(root) {
  const file = path.join(root, BASELINE_FILE);
  if (!fs.existsSync(file)) return new Set();
  return new Set(
    fs.readFileSync(file, 'utf8').split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
  );
}

function violationKey(v, root) {
  const displayFile = path.relative(root, v.file);
  return `${displayFile}:${v.startLine}:${v.tables.join(',')}`;
}

// ---------------------------------------------------------------------------
function main() {
  const root = path.resolve(__dirname, '..');
  const updateMode = process.argv.includes('--update-baseline');
  const baseline = loadBaseline(root);

  const all = [];
  let filesScanned = 0;

  for (const rel of FILES) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    filesScanned++;
    for (const v of scanFile(abs)) all.push(v);
  }

  if (updateMode) {
    const lines = [
      '# Auto-generated by scripts/scan-tenant-isolation.js --update-baseline',
      '# Each line is a known-existing violation. New violations (not listed here)',
      '# will fail the scanner. Drain this list as multi-tenant hardening progresses.',
      '',
      ...all.map(v => violationKey(v, root)).sort(),
    ];
    fs.writeFileSync(path.join(root, BASELINE_FILE), lines.join('\n') + '\n');
    console.log(`Baseline updated: ${all.length} violation(s) recorded in ${BASELINE_FILE}`);
    process.exit(0);
  }

  const newViolations = all.filter(v => !baseline.has(violationKey(v, root)));

  for (const v of newViolations) {
    const displayFile = path.relative(root, v.file);
    console.log(`${displayFile}:${v.startLine} — missing tenant_id filter`);
    console.log(`  tables: ${v.tables.join(', ')}`);
    console.log(`  sql:    ${v.snippet}${v.snippet.length >= 160 ? '…' : ''}`);
    console.log('');
  }

  console.log(`--- Scanned ${filesScanned} files ---`);
  console.log(`Total violations:       ${all.length}`);
  console.log(`In baseline (accepted): ${all.length - newViolations.length}`);
  console.log(`New (blocking):         ${newViolations.length}`);

  if (newViolations.length > 0) {
    console.log('');
    console.log('New violations detected. Options:');
    console.log('  1. Add "// tenant-scan: allow" on the line before the backtick (for known-safe queries)');
    console.log('  2. Add the missing "AND tenant_id = $N" filter (the correct fix)');
    console.log('  3. Refresh the baseline: node scripts/scan-tenant-isolation.js --update-baseline');
    process.exit(1);
  }
  process.exit(0);
}

try { main(); }
catch (e) {
  console.error('scanner error:', e.message);
  process.exit(2);
}
