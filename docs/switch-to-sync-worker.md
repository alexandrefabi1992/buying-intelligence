# Bloc B commit #4 — Switch from legacy sync.js to sync-worker

**When**: mercredi 19 août 2026, ~02:00 EDT (low-activity window)
**Duration**: ~10 min execution + 1h active monitoring
**Rollback window**: any time within 48h via `git revert`

## Pre-flight (do before 02:00 EDT)

- [ ] Everyone who could push a PO or trigger a manual sync is asleep / notified
- [ ] Take a snapshot of pre-migration state (§ 5 below)
- [ ] Confirm `Monitor` tool is armed to watch Railway logs

## Step 1 — Create the sync-worker service on Railway

Via Railway UI (easiest) or CLI:

```bash
# CLI: link to project, then add service
railway link 8fb70d93-bfd0-4493-8a09-326aa822dd61  # noble-compassion
railway environment production
# via UI: New Service → GitHub Repo → same repo → deploy from main
# Set start command: node sync-worker.js
# Set service name: sync-worker
```

The new service will use the SAME repo but a different start command.
It shares the DATABASE_URL with the web service (both point at the same
Postgres via internal DNS).

## Step 2 — Set env vars on Railway

**Web service** (add these):
```bash
railway variables --set SYNC_DISABLED=1 --set SYNC_PRODUCER_ENABLED=1
```

- `SYNC_DISABLED=1` → disables the legacy sync.js hourly cron
- `SYNC_PRODUCER_ENABLED=1` → activates the multi-tenant producer

**Sync-worker service** (add these — MUST be on the worker service, not web):
```bash
railway service sync-worker  # switch context to the new service
railway variables --set SYNC_WORKER_COUNT=1 \
                  --set LIGHTSPEED_CLIENT_ID=$(railway variables --json --service web | jq -r .LIGHTSPEED_CLIENT_ID) \
                  --set LIGHTSPEED_CLIENT_SECRET=$(...) \
                  --set LIGHTSPEED_ACCOUNT_ID=$(...) \
                  --set TENANT_TOKEN_KEY=$(...) \
                  --set DATABASE_URL=\$\{{Postgres.DATABASE_URL\}\}
```

**Sanity checklist** on sync-worker service env vars:
- [ ] `DATABASE_URL` (Railway ref var to Postgres)
- [ ] `SYNC_WORKER_COUNT=1`
- [ ] `LIGHTSPEED_CLIENT_ID` + `_SECRET` (needed by fromTenant() fallback)
- [ ] `TENANT_TOKEN_KEY` (for decrypting ls_refresh_token from tenants table)
- [ ] NO `LIGHTSPEED_REFRESH_TOKEN` (worker reads from tenants.ls_refresh_token per tenant)

## Step 3 — Deploy & watch

Both services should redeploy automatically when env vars change.

Watch Railway logs live:
```bash
railway logs --service web        # tail #1 — should show [producer] scheduled + [sync/cron] DISABLED
railway logs --service sync-worker # tail #2 — should show [sync-worker] boot WORKER_COUNT=1
```

Expected first-minute output:
```
[web]         [producer] scheduled: 0 5 * * * (SYNC_PURGE_DAYS=30)
[web]         [sync/cron] DISABLED via SYNC_DISABLED=1 — legacy sync.js will not run.
[sync-worker] [sync-worker] boot — WORKER_COUNT=1 POLL=5000ms RECLAIM=300000ms/30min
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
railway service web
railway variables --set SYNC_DISABLED=0 --set SYNC_PRODUCER_ENABLED=0

# 2. Turn off the worker
railway service sync-worker
railway variables --set SYNC_WORKER_COUNT=0

# Both services will restart. Legacy sync.js resumes on the hourly cron.
# In-flight jobs stay in 'running' state and will be reclaimed after 30 min.
```

Then debug offline. To revert the code entirely:
```bash
git revert 7214f99  # producer + migration + checkpoints
git revert 511257a  # sync-worker
git revert 32c94ee  # lib/sync-tenant.js
git push
```

## Step 7 — Bake period (48h after successful cycle #1)

The switch is only "committed" after 48h of clean operation. During bake:
- Do NOT re-enable the legacy sync.js (SYNC_DISABLED stays 1)
- Run `npm run test:isolation` daily — must stay 0 fail
- Check `sync_jobs` via `SELECT status, COUNT(*) FROM sync_jobs GROUP BY status` — no persistent 'failed' rows

**Bake success criteria** (all must hold for 48h):
- 0 jobs in `status='failed'`
- `MAX(sale_lines.completed_time)` never > 28h from `now()`
- `MAX(inventory.synced_at)` never > 28h from `now()`
- `sale_lines` row count grows monotonically (never decreases)
- `products` row count delta between cycles ≤ 500
- `orphan_rescued` count per cycle stays under baseline × 1.5 (baseline = value in
  sync_checkpoints at end of first successful cycle)

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
