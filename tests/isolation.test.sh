#!/usr/bin/env bash
# Multi-tenant isolation active test suite
#
# Fires read-only API calls against a running server with two JWTs (a real
# tenant's superadmin and a fake tenant) and flags any response where the
# fake tenant retrieves data belonging to the real tenant.
#
# Usage:
#   TOKEN_A=<real-tenant-jwt> TOKEN_B=<fake-tenant-jwt> ./tests/isolation.test.sh
#
# Optional env:
#   BASE_URL       — defaults to https://buying-intelligence-production.up.railway.app
#   LEAK_KEYWORDS  — pipe-separated regex of tenant-specific strings that must
#                    NOT appear in TOKEN_B's response bodies. Default matches
#                    valerie-simon (adjust when running against a different tenant).
#   RESULTS_LOG    — path for the pipe-delimited results log (default /tmp/isolation-results.log)
#   SHARED_PATHS   — pipe-separated regex of paths that legitimately serve shared
#                    content cross-tenant. Three legitimate cases:
#                      1. Static content (help text)
#                      2. Promoted global rows (tenant_id IS NULL) like recipes
#                      3. Settings endpoints that fall back to hardcoded defaults
#                         when a tenant hasn't customized — two tenants both on
#                         defaults will get identical bodies without any leak.
#                    Matches here downgrade FAIL/REVIEW to "SHARED" (informational).
#
# Exit code: 0 if no leaks detected, 1 if any FAIL, 2 if any REVIEW-needed.
#
# How to generate TOKEN_B (a fake-tenant JWT for the audit):
#   node -e "console.log(require('jsonwebtoken').sign(
#     { userId: 'audit', email: 'audit@example.com', role: 'user', tenantId: 'fake-tenant-audit' },
#     process.env.JWT_SECRET, { expiresIn: '1h' }))"

set -u

BASE_URL="${BASE_URL:-https://buying-intelligence-production.up.railway.app}"
LEAK_KEYWORDS="${LEAK_KEYWORDS:-valerie.simon|Fan Club|Filles d.Ève|Filles d.Eve|Boutique Valérie|Saint-Bruno|Saint-Sauveur|Pour lui}"
RESULTS_LOG="${RESULTS_LOG:-/tmp/isolation-results.log}"
# Paths that legitimately return shared content cross-tenant. Match here means
# the endpoint is *supposed* to serve the same body to any authenticated user
# (or to serve tenant_id-NULL rows shared globally). Downgraded to "SHARED".
SHARED_PATHS="${SHARED_PATHS:-^/api/help$|^/api/import/recipes(/|$|\?)|^/api/sync/checkpoints$|^/api/settings/(seasons|multipliers|budget-params|budget-projection|nos-lead-times|nos-excluded|cost-of-capital|import-colors)$}"

if [ -z "${TOKEN_A:-}" ] || [ -z "${TOKEN_B:-}" ]; then
  echo "ERROR: TOKEN_A and TOKEN_B env vars are required" >&2
  echo "" >&2
  echo "  TOKEN_A: JWT of a superadmin in the tenant you want to protect" >&2
  echo "  TOKEN_B: JWT of a fake/other tenant (must NOT see TOKEN_A's data)" >&2
  echo "" >&2
  echo "See file header for usage examples." >&2
  exit 64
fi

FAILS=0
PASSES=0
REVIEWS=0
SHARED=0
TOTAL=0

test_endpoint() {
  local method="$1"
  local path="$2"
  TOTAL=$((TOTAL+1))

  local respA_raw respA_status respA_body respB_raw respB_status respB_body
  respA_raw=$(curl -sS -X "$method" -H "Authorization: Bearer $TOKEN_A" \
    -w "\n---HTTP:%{http_code}---" \
    --max-time 25 \
    "$BASE_URL$path" 2>/dev/null)
  respA_status=$(echo "$respA_raw" | grep -oE "HTTP:[0-9]+" | tail -1 | sed 's/HTTP://')
  respA_body=$(echo "$respA_raw" | sed '/---HTTP:/,$d')

  respB_raw=$(curl -sS -X "$method" -H "Authorization: Bearer $TOKEN_B" \
    -w "\n---HTTP:%{http_code}---" \
    --max-time 25 \
    "$BASE_URL$path" 2>/dev/null)
  respB_status=$(echo "$respB_raw" | grep -oE "HTTP:[0-9]+" | tail -1 | sed 's/HTTP://')
  respB_body=$(echo "$respB_raw" | sed '/---HTTP:/,$d')

  local a_len=${#respA_body}
  local b_len=${#respB_body}

  local verdict="PASS"
  local reason=""

  if [[ "$respB_status" =~ ^[45] ]]; then
    verdict="PASS"
    reason="B status=$respB_status (errors treated as safe)"
    PASSES=$((PASSES+1))
  else
    if echo "$respB_body" | grep -qiE "$LEAK_KEYWORDS"; then
      verdict="FAIL_KEYWORD"
      reason="B body contains tenant-A specific keywords"
      FAILS=$((FAILS+1))
    elif [ "$b_len" -gt 200 ] && [ "$respB_body" != "[]" ] && [ "$respB_body" != "{}" ]; then
      if [ "$respA_body" = "$respB_body" ]; then
        verdict="FAIL_SAME_BODY"
        reason="B body identical to A body ($b_len bytes)"
        FAILS=$((FAILS+1))
      else
        verdict="REVIEW"
        reason="B body large ($b_len bytes) — manual review required"
        REVIEWS=$((REVIEWS+1))
      fi
    else
      verdict="PASS"
      reason="B body empty/small ($b_len bytes)"
      PASSES=$((PASSES+1))
    fi
  fi

  # Downgrade FAIL/REVIEW to SHARED for endpoints that legitimately serve
  # cross-tenant content by design. This lets us keep the assertion tight
  # (any *new* endpoint that matches will fail) while acknowledging known-shared paths.
  if [[ "$verdict" == FAIL* || "$verdict" == "REVIEW" ]] && echo "$path" | grep -qE "$SHARED_PATHS"; then
    case "$verdict" in
      FAIL*)  FAILS=$((FAILS-1)) ;;
      REVIEW) REVIEWS=$((REVIEWS-1)) ;;
    esac
    verdict="SHARED"
    reason="path in SHARED_PATHS allowlist — expected cross-tenant"
    SHARED=$((SHARED+1))
  fi

  echo "$verdict|$method|$path|A=$respA_status/${a_len}b|B=$respB_status/${b_len}b|$reason" >> "$RESULTS_LOG"

  printf "%-14s %-6s %-58s A:%s (%db)  B:%s (%db)  %s\n" \
    "$verdict" "$method" "$path" "$respA_status" "$a_len" "$respB_status" "$b_len" "$reason"

  if [ "$verdict" != "PASS" ]; then
    local safe_path
    safe_path=$(echo "$path" | sed 's|/|_|g' | sed 's|[?&=]|_|g' | cut -c1-100)
    echo "$respA_body" > "/tmp/isolation-A${safe_path}.json"
    echo "$respB_body" > "/tmp/isolation-B${safe_path}.json"
  fi
}

rm -f "$RESULTS_LOG"
touch "$RESULTS_LOG"

echo "=== Multi-tenant isolation active test suite ==="
echo "Base URL: $BASE_URL"
echo "Results log: $RESULTS_LOG"
echo ""

echo "--- Core data ---"
test_endpoint GET "/api/shops"
test_endpoint GET "/api/manufacturers"
test_endpoint GET "/api/nos"
test_endpoint GET "/api/transfers"
test_endpoint GET "/api/sizes"
test_endpoint GET "/api/sizes/brands"

echo ""
echo "--- Budget ---"
test_endpoint GET "/api/budget/nos"
test_endpoint GET "/api/budget/marque?season=p26"
test_endpoint GET "/api/budget-plan?season=p26"
test_endpoint GET "/api/budget-plan/documents?season=p26&manufacturer=Brax"

echo ""
echo "--- Settings ---"
test_endpoint GET "/api/settings/multipliers"
test_endpoint GET "/api/settings/seasons"
test_endpoint GET "/api/settings/budget-params"
test_endpoint GET "/api/settings/budget-projection"
test_endpoint GET "/api/settings/nos-lead-times"
test_endpoint GET "/api/settings/nos-excluded"
test_endpoint GET "/api/settings/tenant"
test_endpoint GET "/api/settings/cost-of-capital"
test_endpoint GET "/api/settings/import-colors"

echo ""
echo "--- NOS ---"
test_endpoint GET "/api/nos/urgent?shop=1"

echo ""
echo "--- Brand/Matrix (per-tenant resources) ---"
test_endpoint GET "/api/brand/Brax"
test_endpoint GET "/api/brand/Brax?season=p26&shop=1"
test_endpoint GET "/api/brand/Brax/top-attributes"
test_endpoint GET "/api/matrix/1"
test_endpoint GET "/api/matrix/12345"

echo ""
echo "--- Velocity ---"
test_endpoint GET "/api/velocity/brands"
test_endpoint GET "/api/velocity/matrices?manufacturer=Brax"
test_endpoint GET "/api/velocity/articles?manufacturer=Brax"

echo ""
echo "--- Conversations ---"
test_endpoint GET "/api/conversations"
test_endpoint GET "/api/conversations/1"

echo ""
echo "--- Inventory history ---"
test_endpoint GET "/api/inventory-history?item_id=1&shop_id=1"
test_endpoint GET "/api/inventory-history/timeline?shop_id=1"

echo ""
echo "--- Accounting ---"
test_endpoint GET "/api/accounting/brands"

echo ""
echo "--- Import ---"
test_endpoint GET "/api/import/files"
test_endpoint GET "/api/import/files/1"
test_endpoint GET "/api/import/files/1/preview"
test_endpoint GET "/api/import/files/1/progress"
test_endpoint GET "/api/import/files/1/raw-text"
test_endpoint GET "/api/import/recipes"
test_endpoint GET "/api/import/recipes/1"
test_endpoint GET "/api/import/lightspeed/vendors"
test_endpoint GET "/api/import/lightspeed/categories"

echo ""
echo "--- Sync ---"
test_endpoint GET "/api/sync/checkpoints"

echo ""
echo "--- Help (expected tenant-neutral) ---"
test_endpoint GET "/api/help"

echo ""
echo "=== Summary ==="
echo "Total: $TOTAL   Pass: $PASSES   Shared: $SHARED   Fail: $FAILS   Review: $REVIEWS"
echo "Full log: $RESULTS_LOG"

if [ "$FAILS" -gt 0 ]; then
  exit 1
elif [ "$REVIEWS" -gt 0 ]; then
  exit 2
fi
exit 0
