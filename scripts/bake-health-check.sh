#!/usr/bin/env bash
# Bake-period health check for the sync-worker rollout (docs/switch-to-sync-worker.md § 7).
# Hits /api/health/sync and prints a human-readable red/green summary.
# Non-zero exit code if any threshold is breached.
#
# Usage (from your dev laptop):
#   ./scripts/bake-health-check.sh
#
# Or from a cron-like external monitor:
#   */30 * * * *  curl -sf https://buying-intelligence-production.up.railway.app/api/health/sync || echo "sync bake alert"
#
# During bake, run this at least 4 times/day (breakfast, noon, dinner, bedtime).

set -u
HOST="${BAKE_HOST:-https://buying-intelligence-production.up.railway.app}"

resp=$(curl -sS -w "\n---HTTP:%{http_code}---" --max-time 30 "$HOST/api/health/sync" 2>&1)
status=$(echo "$resp" | grep -oE "HTTP:[0-9]+" | sed 's/HTTP://')
body=$(echo "$resp"  | sed '/---HTTP:/,$d')

echo "=== sync bake health @ $(date '+%Y-%m-%d %H:%M:%S %Z') ==="
echo "HTTP: $status"

if [ -z "$status" ] || [ "$status" = "" ]; then
  echo "✗ NO RESPONSE — server unreachable"
  exit 2
fi

# Pretty-print with node (jq alternative — assume node is always installed on the dev laptop)
echo "$body" | node -e "
const j = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const c = j.checks || {};
const line = (label, ok, detail) => console.log(\`  \${ok ? '✓' : '✗'} \${label}\${detail ? '  ' + detail : ''}\`);

console.log(\`Overall: \${j.healthy ? '✓ GREEN' : '✗ RED'}  (tenant: \${j.tenant})\`);
if (c.no_failed_jobs)         line('no failed jobs',          c.no_failed_jobs.pass,          \`(\${c.no_failed_jobs.value} / max \${c.no_failed_jobs.threshold})\`);
if (c.sale_lines_freshness)   line('sale_lines freshness',    c.sale_lines_freshness.pass,    \`(\${c.sale_lines_freshness.value_hours}h / max \${c.sale_lines_freshness.threshold_hours}h — latest \${c.sale_lines_freshness.latest})\`);
if (c.inventory_freshness)    line('inventory freshness',     c.inventory_freshness.pass,     \`(\${c.inventory_freshness.value_hours}h / max \${c.inventory_freshness.threshold_hours}h)\`);
if (c.no_checkpoint_errors)   line('no checkpoint errors',    c.no_checkpoint_errors.pass,    c.no_checkpoint_errors.errored_steps?.length ? \`(errored: \${c.no_checkpoint_errors.errored_steps.join(', ')})\` : '');
if (c.counts)                 console.log(\`  · counts:      \${JSON.stringify(c.counts)}\`);
if (c.sync_jobs)              console.log(\`  · sync_jobs:   \${JSON.stringify(c.sync_jobs)}\`);
"

# Exit 0 on 200, 1 on 503, 2 on anything else
case "$status" in
  200) exit 0 ;;
  503) exit 1 ;;
  *)   exit 2 ;;
esac
