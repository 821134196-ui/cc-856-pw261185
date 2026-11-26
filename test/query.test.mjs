// End-to-end query + verification against the seeded database.
//
// These tests are skipped when no dataset has been seeded, so `npm test` still
// works on a fresh checkout; run `npm run seed` to include them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { prepareQuery, runQuery, verifyQuery, rollupFromBuckets, makeRowEvaluator } from '../server/query.mjs';
import { DB_PATH } from '../server/db.mjs';

const hasData = existsSync(DB_PATH);
const skip = hasData ? false : `no dataset at ${DB_PATH} (run npm run seed)`;

function run(expression, options = {}) {
  const query = prepareQuery({ expression, zone: 'UTC', policy: 'earlier', mode: 'zoned', ...options });
  return { query, result: runQuery(query, { limit: 5, withFullScan: true }) };
}

test('single local day: pruned scan equals full scan', { skip }, () => {
  const { result } = run("local_date(ts) = DATE '2026-03-08'", { zone: 'America/Havana' });
  assert.equal(result.stats.matched, result.stats.fullScan.matched);
  assert.ok(result.stats.scannedPartitions < result.stats.totalPartitions);
  assert.ok(result.stats.fullScan.scannedPartitions === result.stats.totalPartitions);
  assert.ok(result.stats.speedup > 1);
});

test('verification passes for every featured zone and edge case', { skip }, () => {
  const cases = [
    { zone: 'America/New_York', expression: "local_date(ts) = DATE '2026-03-08'" },
    { zone: 'America/New_York', expression: "local_date(ts) = DATE '2026-11-01'" },
    { zone: 'America/Havana', expression: "local_date(ts) = DATE '2026-03-08'" },
    { zone: 'America/Havana', expression: "local_date(ts) = DATE '2026-11-01'" },
    { zone: 'Australia/Lord_Howe', expression: "local_date(ts) = DATE '2026-10-04'" },
    { zone: 'America/Santiago', expression: "local_date(ts) >= DATE '2026-03-01' AND local_date(ts) < DATE '2026-04-01'" },
    { zone: 'America/New_York', expression: "local_ts(ts) BETWEEN WALL '2026-11-01 01:00:00' AND WALL '2026-11-01 01:59:59'" },
    { zone: 'Europe/Berlin', expression: "NOT (local_date(ts) BETWEEN DATE '2026-06-01' AND DATE '2026-06-30')" },
    { zone: 'Asia/Shanghai', expression: "local_date(ts) IN (DATE '2026-03-08', DATE '2026-09-06', DATE '2026-11-01')" },
    { zone: 'America/New_York', expression: "ts >= AT '2026-11-01 01:30:00'" },
  ];
  for (const c of cases) {
    const query = prepareQuery({ expression: c.expression, zone: c.zone, policy: 'earlier', mode: 'zoned' });
    const result = runQuery(query, { limit: 3, withFullScan: false });
    const v = verifyQuery(query);
    assert.equal(v.ok, true, `${c.zone} ${c.expression}: ${JSON.stringify(v.intervalSemantics.mismatches)}`);
    assert.equal(v.rowScan.matched, result.stats.matched, `${c.zone} ${c.expression}: pruned vs full scan`);
    assert.equal(v.partitionSelection.rowsOutsideSelection.length, 0, `${c.zone}: matches outside selection`);
  }});

test('aggregate rollups agree with row-by-row truth', { skip }, () => {
  const cases = [
    { zone: 'America/Havana', expression: "local_date(ts) = DATE '2026-03-08'" },
    { zone: 'America/New_York', expression: "local_date(ts) = DATE '2026-11-01'" },
    { zone: 'Asia/Shanghai', expression: "local_date(ts) >= DATE '2026-05-01' AND local_date(ts) < DATE '2026-05-04'" },
  ];
  for (const c of cases) {
    const { query, result } = run(c.expression, { zone: c.zone });
    const bucket = rollupFromBuckets(query.db, query.compiled.intervals);
    const truth = result.aggregates.rowScan;
    assert.equal(bucket.exact, true, `${c.zone}: bucket rollup should be exact`);
    assert.equal(bucket.count, truth.count, `${c.zone}: count`);
    assert.equal(bucket.sumBytes, truth.sumBytes, `${c.zone}: bytes`);
    assert.equal(bucket.sumLatencyMs, truth.sumLatencyMs, `${c.zone}: latency`);
    assert.equal(bucket.errorCount, truth.errorCount, `${c.zone}: errors`);
    assert.equal(bucket.count, result.stats.matched);
  }
});

test('non-minute-aligned predicates decline the bucket rollup instead of approximating', { skip }, () => {
  const query = prepareQuery({
    expression: "ts >= TS '2026-07-01T00:00:30.500Z' AND ts < TS '2026-07-01T00:00:40Z'",
    zone: 'UTC',
    policy: 'earlier',
    mode: 'zoned',
  });
  const bucket = rollupFromBuckets(query.db, query.compiled.intervals);
  assert.equal(bucket.exact, false);
  assert.match(bucket.reason, /minute-aligned/);
});

test('fold-hour query covers both occurrences', { skip }, () => {
  const { query, result } = run(
    "local_ts(ts) BETWEEN WALL '2026-11-01 01:00:00' AND WALL '2026-11-01 01:59:59'",
    { zone: 'America/New_York' },
  );
  // First occurrence 05:00–05:59:59Z (EDT) and second 06:00–06:59:59Z (EST) are
  // contiguous, so normalization merges them into one two-hour interval.
  assert.equal(query.compiled.intervals.length, 1);
  assert.equal(query.compiled.coverage.widthHours, 2);
  assert.ok(result.stats.matched > 0);
  const evaluator = makeRowEvaluator(query.compiled);
  const [iv] = query.compiled.intervals;
  assert.equal(evaluator(iv.loUs), true);
  assert.equal(evaluator(iv.hiUs - 1), true);
  assert.equal(evaluator(iv.hiUs), false);
  // Both wall-clock occurrences of 01:30 are inside the set.
  const start = new Date('2026-11-01T05:30:00Z').getTime() * 1000;
  assert.equal(evaluator(start), true);
  assert.equal(evaluator(start + 3600 * 1e6), true);
  assert.equal(evaluator(start + 7200 * 1e6), false);
});

test('empty result sets are internally consistent', { skip }, () => {
  const query = prepareQuery({
    expression: "local_date(ts) = DATE '2026-06-15' AND local_date(ts) = DATE '2026-06-16'",
    zone: 'America/New_York',
    policy: 'earlier',
    mode: 'zoned',
  });
  const result = runQuery(query, { limit: 5, withFullScan: true });
  assert.equal(query.compiled.intervals.length, 0);
  assert.equal(query.compiled.partitions.length, 0);
  assert.equal(result.stats.scannedPartitions, 0);
  assert.equal(result.stats.matched, 0);
  assert.equal(result.stats.fullScan.matched, 0);
  const v = verifyQuery(query);
  assert.equal(v.ok, true);
  assert.equal(v.aggregates.bucketRollup.exact, true);
  assert.equal(v.aggregates.bucketRollup.count, 0);
});

test('full coverage selection equals the whole dataset', { skip }, () => {
  // In UTC, local_date >= 2026-01-01 is exactly the dataset's own extent.
  const query = prepareQuery({
    expression: "local_date(ts) >= DATE '2026-01-01'",
    zone: 'UTC',
    policy: 'earlier',
    mode: 'zoned',
  });
  const result = runQuery(query, { limit: 1, withFullScan: false });
  assert.equal(result.stats.scannedPartitions, result.stats.totalPartitions);
  assert.equal(result.stats.matched, result.stats.scannedRows);
  assert.equal(result.stats.matched, query.coverage.totalRows ?? result.stats.matched);
  assert.equal(result.stats.matched, 263927);
});

test('query offset and limit window the matched rows without changing totals', { skip }, () => {
  const query = prepareQuery({
    expression: "local_date(ts) = DATE '2026-05-05'",
    zone: 'Asia/Shanghai',
    policy: 'earlier',
    mode: 'zoned',
  });
  const page1 = runQuery(query, { limit: 3, offset: 0, withFullScan: false });
  const page2 = runQuery(query, { limit: 3, offset: 3, withFullScan: false });
  assert.equal(page1.stats.matched, page2.stats.matched);
  assert.equal(page1.rows.length, 3);
  assert.notDeepEqual(page1.rows.map((r) => r.id), page2.rows.map((r) => r.id));
});
