'use strict';
// Postgres-backed FIFO queue for tenant sync jobs.
//
// Table: sync_jobs (see server.js boot migration).
//
// Design goals:
// - Multiple workers can safely claim jobs concurrently (SELECT ... FOR
//   UPDATE SKIP LOCKED). No coordination service needed.
// - Failed jobs retry with exponential backoff up to MAX_ATTEMPTS, then
//   stay in 'failed' state for manual investigation.
// - Orphaned 'running' jobs (worker crashed mid-sync) are reclaimed by
//   reclaimStuckJobs() so they can be retried instead of blocking a tenant.
//
// This module knows nothing about Lightspeed or per-tenant sync logic —
// it only manipulates rows in sync_jobs. That separation makes it trivial
// to swap the storage backend (BullMQ, SQS…) later without touching the
// per-tenant sync code.

const MAX_ATTEMPTS = 3;
// Backoff schedule after each failure. Indexed by attempts count *before*
// the failure (attempts=0 → first retry in 5 min, etc.). 3rd failure with
// attempts=2 → next_retry_at = now + 45 min, marked 'pending' — but the
// caller only reaches this branch when attempts+1 <= MAX_ATTEMPTS, so 3rd
// failure actually lands in 'failed'.
const BACKOFF_MINUTES = [5, 15, 45];

// ---------------------------------------------------------------------------
// enqueue(pool, tenantId)
//
// Insert a new 'pending' job for a tenant. Idempotent-by-intent: if the
// tenant already has a pending or running job, we skip (returns null) so
// the producer cron can safely fire on every tick without piling up
// duplicate work for slow syncs.
async function enqueue(pool, tenantId) {
  if (!tenantId) throw new Error('sync-queue: tenantId required');
  const { rows } = await pool.query(
    `INSERT INTO sync_jobs (tenant_id, status)
     SELECT $1, 'pending'
     WHERE NOT EXISTS (
       SELECT 1 FROM sync_jobs
       WHERE tenant_id = $1 AND status IN ('pending','running')
     )
     RETURNING id`,
    [tenantId],
  );
  return rows[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// claim(pool)
//
// Atomically pick the oldest ready 'pending' job and mark it 'running'.
// Uses FOR UPDATE SKIP LOCKED so multiple workers polling in parallel each
// grab a different job without contention.
//
// "Ready" = status='pending' AND (next_retry_at IS NULL OR next_retry_at <= now).
//
// Returns { id, tenant_id, attempts } or null if nothing available.
async function claim(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, tenant_id, attempts FROM sync_jobs
       WHERE status = 'pending'
         AND (next_retry_at IS NULL OR next_retry_at <= now())
       ORDER BY created_at
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
    );
    if (!rows.length) {
      await client.query('COMMIT');
      return null;
    }
    const job = rows[0];
    await client.query(
      `UPDATE sync_jobs
         SET status = 'running',
             started_at = now(),
             attempts = attempts + 1,
             next_retry_at = NULL
       WHERE id = $1`,
      [job.id],
    );
    await client.query('COMMIT');
    return { id: job.id, tenantId: job.tenant_id, attempts: job.attempts + 1 };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// markDone(pool, jobId)
async function markDone(pool, jobId) {
  await pool.query(
    `UPDATE sync_jobs SET status = 'done', finished_at = now(), error = NULL
     WHERE id = $1`,
    [jobId],
  );
}

// ---------------------------------------------------------------------------
// markFailed(pool, jobId, errorMessage)
//
// If the job still has retry budget, sets it back to 'pending' with an
// exponential-backoff next_retry_at so a worker picks it up later.
// Otherwise stamps it 'failed' for manual investigation.
//
// Returns { finalStatus, nextRetryAt } so the caller can log accurately.
async function markFailed(pool, jobId, errorMessage) {
  const { rows } = await pool.query(
    `SELECT attempts FROM sync_jobs WHERE id = $1`,
    [jobId],
  );
  if (!rows.length) return { finalStatus: null, nextRetryAt: null };
  const attempts = rows[0].attempts;
  const msg = String(errorMessage ?? '').slice(0, 4000); // guard against huge stack traces

  if (attempts < MAX_ATTEMPTS) {
    const backoffMin = BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)] ?? 45;
    const { rows: r } = await pool.query(
      `UPDATE sync_jobs
         SET status = 'pending',
             finished_at = now(),
             error = $2,
             next_retry_at = now() + ($3 || ' minutes')::interval
       WHERE id = $1
       RETURNING next_retry_at`,
      [jobId, msg, String(backoffMin)],
    );
    return { finalStatus: 'pending', nextRetryAt: r[0]?.next_retry_at ?? null };
  }

  await pool.query(
    `UPDATE sync_jobs
       SET status = 'failed', finished_at = now(), error = $2
     WHERE id = $1`,
    [jobId, msg],
  );
  return { finalStatus: 'failed', nextRetryAt: null };
}

// ---------------------------------------------------------------------------
// reclaimStuckJobs(pool, minutesStuck = 30)
//
// Reset 'running' jobs whose started_at is older than the threshold back
// to 'pending' so they get retried. Handles the case where a worker
// crashed mid-sync and left its job in-flight.
//
// Returns the number of jobs reclaimed.
async function reclaimStuckJobs(pool, minutesStuck = 30) {
  const { rowCount } = await pool.query(
    `UPDATE sync_jobs
       SET status = 'pending',
           error  = COALESCE(error, '') || ' [reclaimed after ' || $1 || ' min stuck running]'
     WHERE status = 'running'
       AND started_at < now() - ($1 || ' minutes')::interval`,
    [String(minutesStuck)],
  );
  return rowCount;
}

// ---------------------------------------------------------------------------
// purgeDone(pool, days = 30)
//
// Drop terminal 'done' rows older than N days to keep the table small.
// Failed rows are kept — they signal something needs manual attention.
//
// Returns the number of rows deleted.
async function purgeDone(pool, days = 30) {
  const { rowCount } = await pool.query(
    `DELETE FROM sync_jobs
     WHERE status = 'done'
       AND finished_at < now() - ($1 || ' days')::interval`,
    [String(days)],
  );
  return rowCount;
}

// ---------------------------------------------------------------------------
// getStats(pool) — snapshot for monitoring/logging
async function getStats(pool) {
  const { rows } = await pool.query(
    `SELECT status, COUNT(*)::int AS n FROM sync_jobs GROUP BY status`,
  );
  const stats = { pending: 0, running: 0, done: 0, failed: 0 };
  for (const r of rows) stats[r.status] = r.n;
  return stats;
}

module.exports = {
  enqueue,
  claim,
  markDone,
  markFailed,
  reclaimStuckJobs,
  purgeDone,
  getStats,
  MAX_ATTEMPTS,
  BACKOFF_MINUTES,
};
