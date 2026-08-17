#!/usr/bin/env node
'use strict';
// Integration test for lib/sync-queue.js — validates that:
//
//   Scenario A (producer dedup)
//     A previously-enqueued job that is still running MUST prevent a
//     subsequent enqueue() from creating a duplicate pending row for
//     the same tenant. Verifies enqueue()'s NOT EXISTS guard.
//
//   Scenario B (concurrent claim atomicity)
//     Two workers calling claim() at the same instant on a queue with
//     exactly one pending job — exactly one wins, the other sees null.
//     Verifies FOR UPDATE SKIP LOCKED semantics.
//
//   Scenario C (running job cannot be re-claimed)
//     Once a job transitions to 'running', subsequent claim() calls
//     never re-pick it while it stays running (would corrupt state and
//     let two workers execute the same tenant sync in parallel).
//
// Setup: creates a scratch tenant 'sync-queue-test' + a real tenants
// row (FK from sync_jobs.tenant_id). Cleans up on exit.
//
// Usage:
//   railway run node scripts/test-sync-queue-dedup.js
//   (or with DATABASE_URL exported directly)

require('dotenv').config();
const { Pool } = require('pg');
const q = require('../lib/sync-queue');

const TENANT_ID = 'sync-queue-test';

// Prefer the public URL when running outside Railway (internal DNS
// `postgres.railway.internal` doesn't resolve from a dev laptop).
const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
const poolConfig = { connectionString };
if (connectionString) poolConfig.ssl = { rejectUnauthorized: false };
const pool = new Pool(poolConfig);

function assert(cond, msg) {
  if (!cond) { console.error(`  ✗ ${msg}`); process.exitCode = 1; }
  else       { console.log (`  ✓ ${msg}`); }
}

async function setup() {
  await pool.query(
    `INSERT INTO tenants (id, name) VALUES ($1, 'sync-queue-test')
     ON CONFLICT (id) DO NOTHING`,
    [TENANT_ID],
  );
  await pool.query(`DELETE FROM sync_jobs WHERE tenant_id = $1`, [TENANT_ID]);
}

async function cleanup() {
  await pool.query(`DELETE FROM sync_jobs WHERE tenant_id = $1`, [TENANT_ID]);
  // Leave the tenant row (harmless, cheaper than repeat inserts if we re-run)
}

// ---------------------------------------------------------------------------
async function scenarioA() {
  console.log('\n[Scenario A] Producer dedup — enqueue while a job is running');
  await pool.query(`DELETE FROM sync_jobs WHERE tenant_id = $1`, [TENANT_ID]);

  // 1. Enqueue → new pending job
  const id1 = await q.enqueue(pool, TENANT_ID);
  assert(id1 !== null, 'first enqueue returns a job id');

  // 2. Producer tick: enqueue again — should return null (still pending)
  const id2 = await q.enqueue(pool, TENANT_ID);
  assert(id2 === null, 'second enqueue while still pending returns null (dedup)');

  // 3. Simulate worker claim → now 'running'
  const job = await q.claim(pool);
  assert(job?.id === id1, `claim() returns the pending job (${job?.id} === ${id1})`);

  // 4. Producer tick: enqueue while 'running' — should still return null
  const id3 = await q.enqueue(pool, TENANT_ID);
  assert(id3 === null, 'enqueue while running returns null (dedup)');

  // 5. Simulate worker finishing job
  await q.markDone(pool, job.id);

  // 6. Now enqueue should succeed (no pending/running left)
  const id4 = await q.enqueue(pool, TENANT_ID);
  assert(id4 !== null && id4 !== id1, `enqueue after done creates NEW job (${id4} ≠ ${id1})`);

  await pool.query(`DELETE FROM sync_jobs WHERE tenant_id = $1`, [TENANT_ID]);
}

// ---------------------------------------------------------------------------
async function scenarioB() {
  console.log('\n[Scenario B] Concurrent claim atomicity — 2 workers race for 1 job');
  await pool.query(`DELETE FROM sync_jobs WHERE tenant_id = $1`, [TENANT_ID]);

  const enqId = await q.enqueue(pool, TENANT_ID);
  assert(enqId !== null, 'seed: enqueue 1 job');

  // Fire two claim() concurrently.
  const [a, b] = await Promise.all([q.claim(pool), q.claim(pool)]);
  const winners = [a, b].filter(x => x !== null);
  const losers  = [a, b].filter(x => x === null);

  assert(winners.length === 1, `exactly one worker wins (got ${winners.length})`);
  assert(losers.length  === 1, `exactly one worker gets null (got ${losers.length})`);
  assert(winners[0].id === enqId, 'winner has the correct job id');
  assert(winners[0].attempts === 1, 'winner sees attempts=1 (bumped by claim)');

  // DB check: only 1 row, status='running', attempts=1 (not 2)
  const { rows } = await pool.query(
    `SELECT id, status, attempts FROM sync_jobs WHERE tenant_id = $1`,
    [TENANT_ID],
  );
  assert(rows.length === 1, `only 1 row in sync_jobs (got ${rows.length})`);
  assert(rows[0]?.status === 'running', `row status='running' (got '${rows[0]?.status}')`);
  assert(rows[0]?.attempts === 1, `row attempts=1 (got ${rows[0]?.attempts}) — not double-incremented`);

  await pool.query(`DELETE FROM sync_jobs WHERE tenant_id = $1`, [TENANT_ID]);
}

// ---------------------------------------------------------------------------
async function scenarioC() {
  console.log("\n[Scenario C] Running job cannot be re-claimed while in 'running' state");
  await pool.query(`DELETE FROM sync_jobs WHERE tenant_id = $1`, [TENANT_ID]);

  await q.enqueue(pool, TENANT_ID);
  const first = await q.claim(pool);
  assert(first !== null, 'first claim: got the pending job');

  // Now the row is 'running'. Any subsequent claim() must NOT return it.
  const second = await q.claim(pool);
  assert(second === null, "second claim() returns null while first is still 'running'");

  const third = await q.claim(pool);
  assert(third === null, "third claim() also returns null");

  // Simulate worker finishing
  await q.markDone(pool, first.id);

  // Now enqueue+claim: should get a fresh job (not the completed one)
  const enq2 = await q.enqueue(pool, TENANT_ID);
  const fourth = await q.claim(pool);
  assert(fourth?.id === enq2, `after done + re-enqueue, claim gets the NEW job (${fourth?.id} === ${enq2})`);

  await pool.query(`DELETE FROM sync_jobs WHERE tenant_id = $1`, [TENANT_ID]);
}

// ---------------------------------------------------------------------------
async function scenarioD() {
  console.log('\n[Scenario D] markFailed backoff schedule');
  await pool.query(`DELETE FROM sync_jobs WHERE tenant_id = $1`, [TENANT_ID]);

  await q.enqueue(pool, TENANT_ID);
  const j = await q.claim(pool);

  // Fail 1st attempt → should go back to pending with next_retry_at ~5 min
  const r1 = await q.markFailed(pool, j.id, 'first failure');
  assert(r1.finalStatus === 'pending', `1st failure → pending (got '${r1.finalStatus}')`);
  const wait1Min = (r1.nextRetryAt - Date.now()) / 60000;
  assert(Math.abs(wait1Min - 5) < 1, `next retry ~5 min (got ${wait1Min.toFixed(1)} min)`);

  // Manually advance next_retry_at to now so we can claim without waiting
  await pool.query(
    `UPDATE sync_jobs SET next_retry_at = now() - interval '1 minute' WHERE id = $1`,
    [j.id],
  );

  // Claim 2nd time
  const j2 = await q.claim(pool);
  assert(j2?.id === j.id, 'same job reclaimed after backoff (id match)');
  assert(j2?.attempts === 2, `attempts=2 on 2nd claim (got ${j2?.attempts})`);

  const r2 = await q.markFailed(pool, j2.id, 'second failure');
  assert(r2.finalStatus === 'pending', `2nd failure → pending (got '${r2.finalStatus}')`);
  const wait2Min = (r2.nextRetryAt - Date.now()) / 60000;
  assert(Math.abs(wait2Min - 15) < 1, `next retry ~15 min (got ${wait2Min.toFixed(1)} min)`);

  await pool.query(
    `UPDATE sync_jobs SET next_retry_at = now() - interval '1 minute' WHERE id = $1`,
    [j.id],
  );

  // Claim 3rd time — this attempt is the LAST one allowed
  const j3 = await q.claim(pool);
  assert(j3?.attempts === 3, `attempts=3 on 3rd claim (got ${j3?.attempts})`);

  const r3 = await q.markFailed(pool, j3.id, 'third failure');
  assert(r3.finalStatus === 'failed', `3rd failure → 'failed' terminal (got '${r3.finalStatus}')`);
  assert(r3.nextRetryAt === null, 'no next retry after final failure');

  // Cleanup
  await pool.query(`DELETE FROM sync_jobs WHERE tenant_id = $1`, [TENANT_ID]);
}

// ---------------------------------------------------------------------------
async function scenarioE() {
  console.log("\n[Scenario E] reclaimStuckJobs revives crashed workers' jobs");
  await pool.query(`DELETE FROM sync_jobs WHERE tenant_id = $1`, [TENANT_ID]);

  await q.enqueue(pool, TENANT_ID);
  const j = await q.claim(pool);

  // Fake a crash: rewind started_at 45 min into the past
  await pool.query(
    `UPDATE sync_jobs SET started_at = now() - interval '45 minutes' WHERE id = $1`,
    [j.id],
  );

  const n = await q.reclaimStuckJobs(pool, 30);
  assert(n >= 1, `reclaim reports ≥1 (got ${n})`);

  // The job should now be 'pending' again
  const { rows } = await pool.query(
    `SELECT status, error FROM sync_jobs WHERE id = $1`,
    [j.id],
  );
  assert(rows[0]?.status === 'pending', `reclaimed job back to 'pending' (got '${rows[0]?.status}')`);
  assert((rows[0]?.error ?? '').includes('reclaimed'), 'error field annotated with "reclaimed"');

  await pool.query(`DELETE FROM sync_jobs WHERE tenant_id = $1`, [TENANT_ID]);
}

// ---------------------------------------------------------------------------
async function main() {
  console.log('=== sync-queue integration test ===');
  console.log(`tenant scratch id: '${TENANT_ID}'`);

  await setup();
  try {
    await scenarioA();
    await scenarioB();
    await scenarioC();
    await scenarioD();
    await scenarioE();
  } finally {
    await cleanup();
    await pool.end();
  }

  if (process.exitCode) {
    console.log('\n=== FAIL ===');
  } else {
    console.log('\n=== ALL PASS ===');
  }
}

main().catch(err => {
  console.error('fatal:', err);
  process.exit(2);
});
