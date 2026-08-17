#!/usr/bin/env node
'use strict';
// Multi-tenant sync worker entrypoint.
//
// Runs a pool of N worker loops (env SYNC_WORKER_COUNT, default 0 = idle
// observer for safe deploy) that claim jobs from sync_jobs via
// lib/sync-queue and execute the per-tenant sync via lib/sync-tenant.
//
// Life of a worker loop:
//   1. Poll for the next ready 'pending' job (FOR UPDATE SKIP LOCKED)
//   2. If nothing → sleep POLL_INTERVAL_MS and retry
//   3. If a job → call syncTenant(pool, tenantId, {})
//   4. On success → markDone. On error → markFailed (queue applies retry
//      backoff and eventually marks 'failed' after MAX_ATTEMPTS)
//
// Deploying with SYNC_WORKER_COUNT=0 lets us ship the code without
// changing behavior — the process just logs "idle observer" and exits
// cleanly (or stays up if `--watch` is passed for the reclaim loop only).
//
// Graceful shutdown: SIGTERM / SIGINT stop the poll loops after the
// current job finishes. Any in-flight job is left in 'running' state and
// will be reclaimed by reclaimStuckJobs() (30-min threshold by default).

require('dotenv').config();
const { Pool } = require('pg');
const {
  claim, markDone, markFailed, reclaimStuckJobs, getStats,
} = require('./lib/sync-queue');
const { syncTenant } = require('./lib/sync-tenant');

const WORKER_COUNT      = parseInt(process.env.SYNC_WORKER_COUNT ?? '0', 10);
const POLL_INTERVAL_MS  = parseInt(process.env.SYNC_POLL_INTERVAL_MS ?? '5000', 10);
const RECLAIM_INTERVAL  = parseInt(process.env.SYNC_RECLAIM_INTERVAL_MS ?? '300000', 10); // 5 min
const RECLAIM_THRESHOLD = parseInt(process.env.SYNC_RECLAIM_MINUTES ?? '30', 10);
const STATS_INTERVAL    = parseInt(process.env.SYNC_STATS_INTERVAL_MS ?? '300000', 10); // 5 min

const poolConfig = { connectionString: process.env.DATABASE_URL };
if (process.env.DATABASE_URL) poolConfig.ssl = { rejectUnauthorized: false };
const pool = new Pool(poolConfig);

let shuttingDown = false;

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// One worker loop — polls until shuttingDown flips true.
async function workerLoop(id) {
  console.log(`[worker:${id}] started`);
  while (!shuttingDown) {
    let job = null;
    try {
      job = await claim(pool);
    } catch (err) {
      console.error(`[worker:${id}] claim() failed:`, err.message);
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (!job) {
      // Nothing to do — wait and retry
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const { id: jobId, tenantId, attempts } = job;
    console.log(`[worker:${id}] claimed job ${jobId} for tenant '${tenantId}' (attempt ${attempts})`);

    try {
      const result = await syncTenant(pool, tenantId, {});
      await markDone(pool, jobId);
      console.log(
        `[worker:${id}] job ${jobId} done — tenant='${tenantId}' duration=${result.durationMs}ms ` +
        `steps=${JSON.stringify(result.steps)} orphans={rescued:${result.orphanRescued},stubs:${result.orphanStubs},skipped:${result.orphanSkipped}} unresolvedMfg=${result.unresolvedMfg}`
      );
    } catch (err) {
      const errMsg = err?.stack ?? String(err?.message ?? err);
      const outcome = await markFailed(pool, jobId, errMsg);
      console.error(
        `[worker:${id}] job ${jobId} FAILED — tenant='${tenantId}' attempt=${attempts} ` +
        `→ status='${outcome.finalStatus}'` +
        (outcome.nextRetryAt ? ` retry_at=${outcome.nextRetryAt.toISOString()}` : ' (giving up)'),
      );
      console.error(`[worker:${id}] error detail:`, errMsg.slice(0, 500));
    }
  }
  console.log(`[worker:${id}] stopped`);
}

// ---------------------------------------------------------------------------
// Reclaim loop — resets 'running' rows that have been orphaned by a
// crashed worker. Runs on its own timer regardless of WORKER_COUNT.
async function reclaimLoop() {
  while (!shuttingDown) {
    try {
      const n = await reclaimStuckJobs(pool, RECLAIM_THRESHOLD);
      if (n > 0) console.log(`[reclaim] reclaimed ${n} stuck job(s) (running > ${RECLAIM_THRESHOLD} min)`);
    } catch (err) {
      console.error('[reclaim] failed:', err.message);
    }
    await sleep(RECLAIM_INTERVAL);
  }
}

// ---------------------------------------------------------------------------
// Stats loop — periodic snapshot for monitoring.
async function statsLoop() {
  while (!shuttingDown) {
    try {
      const s = await getStats(pool);
      console.log(`[stats] sync_jobs pending=${s.pending} running=${s.running} done=${s.done} failed=${s.failed}`);
    } catch (err) {
      console.error('[stats] failed:', err.message);
    }
    await sleep(STATS_INTERVAL);
  }
}

// ---------------------------------------------------------------------------
async function main() {
  console.log(`[sync-worker] boot — WORKER_COUNT=${WORKER_COUNT} POLL=${POLL_INTERVAL_MS}ms RECLAIM=${RECLAIM_INTERVAL}ms/${RECLAIM_THRESHOLD}min`);

  if (WORKER_COUNT === 0) {
    console.log('[sync-worker] idle observer mode — no workers spawned (set SYNC_WORKER_COUNT ≥ 1 to consume jobs)');
    // Still run reclaim + stats so the observer is useful for monitoring.
    await Promise.all([reclaimLoop(), statsLoop()]);
    return;
  }

  // Register graceful shutdown BEFORE spawning workers so signals during
  // startup are caught cleanly.
  const stop = (sig) => {
    if (shuttingDown) return;
    console.log(`[sync-worker] received ${sig}, draining workers…`);
    shuttingDown = true;
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT',  () => stop('SIGINT'));

  const workers = [];
  for (let i = 1; i <= WORKER_COUNT; i++) workers.push(workerLoop(i));
  workers.push(reclaimLoop());
  workers.push(statsLoop());

  await Promise.all(workers);

  console.log('[sync-worker] all workers stopped, exiting');
  await pool.end();
}

main().catch(err => {
  console.error('[sync-worker] fatal:', err);
  process.exit(1);
});
