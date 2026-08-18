# Bloc B commit #4 — Switch from legacy sync.js to sync-worker

**When**: mercredi 19 août 2026, ~02:00 EDT (low-activity window)
**Duration**: ~10 min execution + 1h active monitoring
**Rollback window**: any time within 48h via `git revert`

---

## 🚨 EMERGENCY ROLLBACK — copy-paste block

**If anything looks wrong**, run these three commands. Zero thinking required.

```bash
# 1. Web service — re-enable legacy sync, kill the producer
railway service buying-intelligence
railway variables --set SYNC_DISABLED=0 --set SYNC_PRODUCER_ENABLED=0

# 2. Worker service — force drain
railway service sync-worker
railway variables --set SYNC_WORKER_COUNT=0

# 3. Return to web service so subsequent commands hit the right place
railway service buying-intelligence
```

Both services restart automatically on env-var change (~30-60s).
After the restart:
- Legacy `sync.js` resumes on its hourly cron (`0 * * * *`).
- Sync-worker returns to idle observer (reclaim + stats loops only).
- Any job in `status='running'` at the moment of rollback stays stuck
  in that state until `reclaimStuckJobs()` bumps it back to `'pending'`
  after 60 min (per `SYNC_RECLAIM_MINUTES=60` on the worker) — cosmetic
  only, no data loss (no worker to consume it).

**Verify rollback worked** (must all be true within 2 min):
```bash
railway logs --service buying-intelligence --lines 10 | grep -E "sync/cron|producer"
# Expected: "[sync/cron] Hourly sync scheduled" AND "[producer] disabled"

railway logs --service sync-worker --lines 10 | grep -E "sync-worker|worker:1"
# Expected: "idle observer mode" (no worker:N spawned)
```

Only *after* the deployment is stable via env-var rollback, consider
a full code revert. Full Bloc B history, most recent first:
```bash
git revert b05fd03  # playbook: --skip-deploys + ordered redeploys (docs only)
git revert 65fa503  # health endpoint whitelist + redeploy race docs
git revert 6d4bfd3  # bake-health-check.sh shell fixes
git revert 4c3dd03  # /api/health/sync HEALTH_CHECK_SECRET redaction
git revert fdada37  # cold review: 3 blockers + 3 tightenings
git revert 5a66f6e  # /api/health/sync endpoint + bake-health-check.sh
git revert ca50bba  # entrypoint dispatcher (web + sync-worker)
git revert 79a23ae  # playbook: scope caveat (docs only)
git revert 7bdaff7  # admin UI (public/admin.html)
git revert ebe26da  # env fallback gate primary-only
git revert 67eb1f8  # SYNC_DISABLED gate + switch playbook
git revert 7214f99  # producer + sync_checkpoints migration
git revert 511257a  # sync-worker.js + test dédup
git revert 32c94ee  # lib/sync-tenant.js
git revert d6a4124  # scanner baseline refresh (docs only)
git revert a417452  # sync_jobs table + lib/sync-queue.js
git revert 0c0d2bd  # 4 fromEnv → fromTenant in import-routes.js
git push
```
Docs-only reverts are safe to skip if the diff is trivial; runtime
reverts (32c94ee, 511257a, 7214f99, ebe26da, ca50bba, 4c3dd03, 65fa503,
fdada37, a417452, 0c0d2bd) are the ones that actually restore behaviour.

---

## Pre-flight (do before 02:00 EDT)

- [ ] Everyone who could push a PO or trigger a manual sync is asleep / notified
- [ ] Take a snapshot of pre-migration state (§ 5 below)
- [ ] Confirm `Monitor` tool is armed to watch Railway logs
- [ ] **Trigger a Railway Postgres backup manually** (belt-and-braces):
      Dashboard → Postgres service → Backups tab → click "New backup".
      Wait for it to complete (~30s-2min, depends on DB size). This gives
      you a timestamped snapshot dedicated to the switch, in addition to
      the daily auto-backup. Restore path if needed: same Backups tab →
      hover the snapshot → "Restore". Restore is ~5-15min and creates a
      new volume, not in-place — safe.

## Scope caveat — what this switch actually validates

VS (valerie-simon) today has **no token** in `tenants.ls_refresh_token`;
it authenticates via the `LIGHTSPEED_REFRESH_TOKEN` env var. The
`getAccessToken()` helper in `lib/sync-tenant.js` has a guarded
fallback: when `ctx.tenantId === LIGHTSPEED_PRIMARY_TENANT` and no DB
token is present, it uses the env var.

**Consequence**: the first sync cycle post-switch exercises the **env-var
fallback path**, not the normal `fromTenant()` → decrypt-DB-token path
that any future tenant #2 will take.

That's fine for validating the switch itself (queue → worker →
syncTenant → DB writes are all shared), but **the full end-to-end
"DB-encrypted-token → decrypt → Lightspeed → per-tenant write" path
stays untested until a real tenant #2 is onboarded**. Plan a follow-up
smoke test with T2 after 48h bake completes:
1. Create T2 via /admin.html
2. Click "Lightspeed" → OAuth flow → token lands encrypted in
   `tenants.ls_refresh_token`
3. Manually enqueue a sync_jobs row for T2 → observe worker uses
   `fromTenant()` (not env fallback), decrypts, syncs T2's own account.

After that smoke test passes, VS can be migrated off env-var and onto
DB-stored token via `/oauth/start?tenant_id=valerie-simon` — one final
change to make the deployment fully symmetric.

## Step 1 — Verify sync-worker service exists and is idle

The sync-worker Railway service was created in the pre-flight session
(via `railway add --service sync-worker`) and has been running in idle
observer mode (`SYNC_WORKER_COUNT=0`) since. Both services share the
same GitHub repo; the `entrypoint.js` dispatcher picks the right
top-level module based on `SERVICE_ROLE`.

Verify the service is up and idle before proceeding:

```bash
railway service sync-worker
railway logs --lines 10 | grep -E "boot|stats|worker:1"
# Expected:
#   [sync-worker] boot — WORKER_COUNT=0 POLL=5000ms RECLAIM=…
#   [sync-worker] idle observer mode — no workers spawned
#   [stats] sync_jobs pending=0 running=0 done=0 failed=0
# Expected NOT to see: [worker:1] started (that shows up after switch)
```

If the service is missing, down, or spawning workers already, STOP and
debug before proceeding — the switch procedure below assumes idle state.

## Step 2 — Set env vars on Railway

**Ordering rationale**: use `--skip-deploys` to stage all changes without
triggering redeploys, then trigger redeploys manually in a specific
order so the system is always in a valid state:

1. Worker first: activate WORKER_COUNT=1. Queue is still empty (producer
   not yet active), worker sits idle. Zero user-visible change; no
   effect on UptimeRobot (health endpoint lives on the web service).
2. Web second: SYNC_DISABLED=1 stops the legacy cron, SYNC_PRODUCER_ENABLED=1
   starts enqueueing. Worker immediately picks up jobs. This is the
   ONE moment where UptimeRobot might catch a redeploy blip → 1 possible
   spurious 401 alert (documented; treat as expected).

**Worker service env vars already set in the pre-flight session** — just
verify they're still there:
```bash
railway service sync-worker
railway variables --json | node -e "let s=''; process.stdin.on('data', c => s+=c); process.stdin.on('end', () => { const j = JSON.parse(s); ['SERVICE_ROLE','SYNC_WORKER_COUNT','SYNC_RECLAIM_MINUTES','DATABASE_URL','TENANT_TOKEN_KEY','LIGHTSPEED_CLIENT_ID','LIGHTSPEED_CLIENT_SECRET','LIGHTSPEED_ACCOUNT_ID','LIGHTSPEED_REFRESH_TOKEN','LIGHTSPEED_PRIMARY_TENANT'].forEach(k => console.log((j[k] ? '✓' : '✗') + ' ' + k)); });"
```
All should show ✓. If any ✗, fix before proceeding.

**Stage the switch env vars (both services, no redeploys yet)**:
```bash
# Worker: flip WORKER_COUNT 0 → 1 with --skip-deploys
railway service sync-worker
railway variables --set SYNC_WORKER_COUNT=1 --skip-deploys

# Web: enable SYNC_DISABLED + SYNC_PRODUCER_ENABLED with --skip-deploys
railway service buying-intelligence
railway variables --set SYNC_DISABLED=1 --set SYNC_PRODUCER_ENABLED=1 --skip-deploys
```

**Trigger redeploys in order**:
```bash
# 1. Worker first (invisible to users, no health-check impact)
railway service sync-worker
railway redeploy

# Wait ~60s for the worker to come up. Verify:
railway logs --service sync-worker --lines 10 | grep -E "boot|worker:1|stats"
# Expected: "[sync-worker] boot — WORKER_COUNT=1" AND "[worker:1] started"

# 2. Web second (this is the one that might blip UptimeRobot briefly)
railway service buying-intelligence
railway redeploy

# Wait ~60s. Verify:
railway logs --service buying-intelligence --lines 15 | grep -E "sync/cron|producer"
# Expected: "[sync/cron] DISABLED" AND "[producer] scheduled"
```

**Sanity checklist** on sync-worker service (re-check these were set
in the pre-flight session — should all be ✓ from the verification above):
- [x] `SERVICE_ROLE=sync-worker`
- [x] `DATABASE_URL` (Railway ref var to Postgres)
- [x] `SYNC_WORKER_COUNT=1` (flipped from 0 in the staging step above)
- [x] `SYNC_RECLAIM_MINUTES=60` (worker only — override the 30-min default)
- [x] `LIGHTSPEED_CLIENT_ID` + `_SECRET` + `_ACCOUNT_ID` + `_PRIMARY_TENANT`
- [x] `TENANT_TOKEN_KEY` (for decrypting ls_refresh_token from tenants table)
- [x] `LIGHTSPEED_REFRESH_TOKEN` (still needed until VS is re-OAuth'd off env fallback
      — see the Scope caveat block above). Post-bake, once VS's token lives in
      `tenants.ls_refresh_token`, this env var can be removed.

## Step 3 — Deploy & watch

Both services should redeploy automatically when env vars change.

Watch Railway logs live:
```bash
railway logs --service buying-intelligence # tail #1 — should show [producer] scheduled + [sync/cron] DISABLED
railway logs --service sync-worker # tail #2 — should show [sync-worker] boot WORKER_COUNT=1
```

Expected first-minute output:
```
[web]         [producer] scheduled: 0 5 * * * (SYNC_PURGE_DAYS=30)
[web]         [sync/cron] DISABLED via SYNC_DISABLED=1 — legacy sync.js will not run.
[sync-worker] [sync-worker] boot — WORKER_COUNT=1 POLL=5000ms RECLAIM=300000ms/60min
[sync-worker] [worker:1] started
[sync-worker] [stats] sync_jobs pending=0 running=0 done=0 failed=0
```

## Step 4 — Trigger the first cycle manually

Instead of waiting for the 05:00 UTC producer cron, force an immediate
tick by enqueueing valerie-simon by hand:

```bash
# Via psql on Railway
railway connect Postgres
INSERT INTO sync_jobs (tenant_id, status) VALUES ('valerie-simon', 'pending');
\q
```

Within 5 seconds the worker should:
1. Claim the job (`[worker:1] claimed job N for tenant 'valerie-simon' (attempt 1)`)
2. Run syncTenant (10-30 min based on delta size)
3. Mark done (`[worker:1] job N done — tenant='valerie-simon' duration=...ms steps={shops:N,items:...} orphans={rescued:0,stubs:0,skipped:0}`)

## Step 5 — Pre/post snapshots (compare after cycle #1)

**Take these BEFORE Step 4:**

```bash
railway connect Postgres
```

```sql
-- Pre-migration snapshot (save output)
SELECT COUNT(*) AS n_sale_lines FROM sale_lines WHERE tenant_id='valerie-simon';
SELECT COUNT(*) AS n_products FROM products WHERE tenant_id='valerie-simon';
SELECT COUNT(*) AS n_inventory FROM inventory WHERE tenant_id='valerie-simon';
SELECT COUNT(*) AS n_transfers FROM transfers WHERE tenant_id='valerie-simon';
SELECT COUNT(*) AS n_orders FROM orders WHERE tenant_id='valerie-simon';
SELECT MAX(completed_time) AS latest_sale FROM sale_lines WHERE tenant_id='valerie-simon';
SELECT MAX(synced_at) AS latest_inv FROM inventory WHERE tenant_id='valerie-simon';
SELECT step, processed_count, updated_at FROM sync_checkpoints
  WHERE tenant_id='valerie-simon' ORDER BY step;
```

**After cycle #1 completes**, run the exact same queries again and compare:

| Metric | Expected delta |
|---|---|
| `n_sale_lines` | +0 to +N (new sales since last sync) — MUST be ≥ 0 (never negative) |
| `n_products` | +0 to +50 (products change slowly) |
| `n_inventory` | ±small (transfers/receptions) |
| `latest_sale` | ~ now (within last few hours) |
| `latest_inv` | ~ now (updated_at fresh) |
| `sync_checkpoints` | all steps show recent updated_at (< 5 min ago) |

**Fail thresholds → ROLLBACK immediately** (see §6):
- Any row count decreased
- `latest_sale` older than 4 hours
- `sync_checkpoints` shows an error step in `next_url` (starts with "Error:")
- A job ends with status='failed' with attempts=3
- More than 3 orphan_rescued (way above baseline)

## Step 6 — Rollback procedure (if any red threshold hit)

Fastest rollback = disable the switch without redeploying:

```bash
# 1. Turn off the multi-tenant sync
railway service buying-intelligence
railway variables --set SYNC_DISABLED=0 --set SYNC_PRODUCER_ENABLED=0

# 2. Turn off the worker
railway service sync-worker
railway variables --set SYNC_WORKER_COUNT=0

# Both services will restart. Legacy sync.js resumes on the hourly cron.
# In-flight jobs stay in 'running' state and will be reclaimed after 60 min.
```

Then debug offline. **For the full code revert list**, use the block in
the top-of-file 🚨 EMERGENCY ROLLBACK section — it's kept in sync with
the git log. Copy-pasting from there guarantees you don't miss a commit.

## Step 7 — Bake period (48h after successful cycle #1)

The switch is only "committed" after 48h of clean operation. During bake:
- Do NOT re-enable the legacy sync.js (SYNC_DISABLED stays 1)
- Do NOT re-OAuth VS to move its token off the env fallback — one change at a time
- Run `npm run test:isolation` daily — must stay 0 fail

### Automated health endpoint

`GET /api/health/sync` returns JSON with every bake threshold + an overall
`healthy: boolean`. HTTP 200 = green, HTTP 503 = red.

Quick manual check anytime:
```bash
./scripts/bake-health-check.sh
# → pretty-printed output with ✓/✗ per threshold, exit 0/1/2
```

### Recommended monitoring cadence during bake

Since there's no in-house alerting stack, the plan is scheduled manual
checks. Pick ONE of these three options — pick the one you'll actually
follow through on.

**Option A: External uptime monitor (recommended, zero manual effort)**
- Sign up for a free tier: [UptimeRobot](https://uptimerobot.com/) (free
  50 monitors, 5-min interval) or [Better Uptime](https://betterstack.com/)
- Monitor URL: `https://buying-intelligence-production.up.railway.app/api/health/sync`
- Alert on: HTTP status != 200 (so anything other than green)
- Alert to: SMS / email — your choice
- Setup: 5 minutes. Runs unattended for the whole 48h.
- Note: the endpoint is public but returns only `{healthy: bool}` without
  a valid X-Health-Secret header. Uptime monitors only need the status
  code — no header setup required for the free tier flow.

**⚠️ Deploy-related false-alert window (free tier limitation)**

Every `railway variables --set …` or `railway redeploy` triggers a
container swap ~30-60s. During the swap window, the old container may
briefly serve requests that hit the auth middleware fallback instead
of the health handler, returning HTTP 401. This is a Railway rolling-
deploy artefact, NOT a real sync failure.

**Free-tier UptimeRobot has NO configurable "N consecutive failures"
setting** — an alert fires as soon as the internal retry (~30s, 3
attempts, hard-coded) still shows a failure. That means the deploy-race
window can plausibly cause 1 spurious alert per redeploy.

**Mitigations in use (already implemented):**

1. Step 2 of this playbook uses `railway variables --skip-deploys` +
   an explicit `railway redeploy` in a specific order → reduces the
   switch to **ONE redeploy on the web service** (the only service
   hosting `/api/health/sync`). Worker redeploys are invisible to the
   monitor.
2. If a spurious 401 alert fires during the switch, ignore it —
   confirm the state via the manual `./scripts/bake-health-check.sh`
   which returns to GREEN within 60-90s of the redeploy completing.
3. During the 48h bake, no planned redeploys — the monitor should
   stay quiet unless something real happens.

If false alerts still bother you post-switch, upgrade UptimeRobot to a
paid tier (starts at ~$7/month) which unlocks the "confirmed down after
N tries" setting.

### End-to-end alerting test — ALREADY VALIDATED

Tuesday evening (2026-08-17 21:48 EDT) we ran the full loop end-to-end:

1. Inserted a fake `failed` job into `sync_jobs` → endpoint 503.
2. UptimeRobot polled ~2 min later → alert notification received.
3. Deleted the fake job → endpoint 200.
4. UptimeRobot polled ~2 min later → resolve notification received.

Total round-trip: ~7 min. Both alert and resolve delivered to the
configured channel. If you want to re-run this test at any point:

```bash
# 1. Force RED: insert a fake failed job
railway connect Postgres
INSERT INTO sync_jobs (tenant_id, status, attempts, error, finished_at, created_at)
VALUES ('valerie-simon', 'failed', 3, 'ALERTING TEST — will be deleted', now(), now());
\q
# Wait for alert (typically ≤ 5 min on free tier)

# 2. Clean up: DELETE the fake job
railway connect Postgres
DELETE FROM sync_jobs WHERE error = 'ALERTING TEST — will be deleted';
\q
# Wait for resolve (typically ≤ 5 min after cleanup)
```

**Option B: Manual check at fixed hours (fallback if you don't want a monitor)**
Run this cron in a screen/tmux session on your laptop, or on any always-on
machine you have:
```bash
# In your shell profile or a cron entry:
0 8,12,18,22 * * *  cd ~/Documents/buying-intelligence && ./scripts/bake-health-check.sh || osascript -e 'display notification "sync bake RED" with title "Buying Intelligence"'
```
That's 4 checks per day (~every 5h) — enough that a persistent red
issue can't hide for more than 5h before you see it.

**Option C: Just run it manually 3× a day**
Morning coffee, lunch, dinner:
```bash
./scripts/bake-health-check.sh
```
Least reliable — a red state at 3am goes unnoticed until morning. Only
use this if you're OK with up to ~8h of blindness overnight.

### Bake success criteria (must all hold for 48h)

- `no_failed_jobs`: 0 jobs in `status='failed'`
- `sale_lines_freshness`: MAX(completed_time) never > 28h old
- `inventory_freshness`: MAX(synced_at) never > 28h old
- `no_checkpoint_errors`: no sync_checkpoints row with next_url starting `Error:`
- `sale_lines` row count grows monotonically (never decreases)
- `products` row count delta between cycles ≤ 500
- `orphan_rescued` count per cycle stays under baseline × 1.5 (baseline = value
  captured in /tmp/pre-switch-baseline.json before the switch)

If ANY criterion fails and doesn't self-heal within 1 cycle (~24h): rollback.

## Step 8 — Cleanup (commit B.5, after bake success)

Only after 48h of green bake:

```bash
# Code changes
git rm sync.js
# Also remove: SYNC_DISABLED-conditional block in server.js, sync_state migration,
# /api/sync/checkpoints fallback to sync_state
git commit -m "cleanup: remove sync.js + sync_state legacy after Bloc B bake period"
git push

# DB cleanup — run manually after commit deploys
railway connect Postgres
DROP TABLE sync_state CASCADE;
```

## Contact / Notes

- Any anomaly during monitoring: alert on Slack / here
- The `Monitor` tool armed by Claude will notify on `ERROR|FAILED|429|5[0-9][0-9]|sync_jobs|worker` matches
