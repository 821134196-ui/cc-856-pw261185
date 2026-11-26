// Compiler correctness: the exact UTC interval set must equal instant-by-instant
// predicate evaluation, across DST edge cases, and partition selection must be
// sound (no match outside the selected set) and necessary (all selected
// partitions actually contain a match).
import test from 'node:test';
import assert from 'node:assert/strict';

import { compileExpression } from '../server/compiler.mjs';
import { makeRowEvaluator } from '../server/query.mjs';
import { intervalsContainUs } from '../server/intervals.mjs';
import { daysFromCivil, dayFromDateKey, getTimeline, SEC_PER_DAY, US_PER_DAY } from '../server/tz.mjs';

const UNIVERSE = {
  loUs: daysFromCivil(2026, 1, 1) * US_PER_DAY,
  hiUs: daysFromCivil(2027, 1, 1) * US_PER_DAY,
};

function compile(expression, { zone = 'UTC', policy = 'earlier', mode = 'zoned' } = {}) {
  return compileExpression(expression, { zone, universe: UNIVERSE, policy, mode });
}

/**
 * Count how many sampled instants inside [fromUs, toUs) differ between the
 * per-instant predicate and interval-set membership.
 */
function disagreements(compiled, fromUs, toUs, stepUs) {
  const evaluator = makeRowEvaluator(compiled);
  const bad = [];
  for (let us = fromUs; us < toUs; us += stepUs) {
    const expected = evaluator(us);
    const actual = intervalsContainUs(compiled.intervals, us);
    if (expected !== actual && bad.length < 8) bad.push({ us, expected, actual });
  }
  return bad;
}

function windowAround(dayKey, padDays = 2) {
  const day = dayFromDateKey(dayKey);
  return { loUs: (day - padDays) * US_PER_DAY, hiUs: (day + padDays + 1) * US_PER_DAY };
}

const CASES = [
  {
    name: 'single local date, no DST',
    zone: 'Asia/Shanghai',
    expr: "local_date(ts) = DATE '2026-06-15'",
    dayKey: '2026-06-15',
    expectIntervals: 1,
    expectHours: 24,
  },
  {
    name: 'single local date, spring forward (23h)',
    zone: 'America/New_York',
    expr: "local_date(ts) = DATE '2026-03-08'",
    dayKey: '2026-03-08',
    expectIntervals: 1,
    expectParts: 2, // 23h day still spans two UTC days
    expectHours: 23,
  },
  {
    name: 'single local date, fall back (25h)',
    zone: 'America/New_York',
    expr: "local_date(ts) = DATE '2026-11-01'",
    dayKey: '2026-11-01',
    expectIntervals: 1,
    expectHours: 25,
  },
  {
    name: 'local date with no midnight, starts at 01:00',
    zone: 'America/Havana',
    expr: "local_date(ts) = DATE '2026-03-08'",
    dayKey: '2026-03-08',
    expectIntervals: 1,
    expectParts: 2, // ends at 23:59:59 -04:00 = 03:59:59Z next day
    expectHours: 23,
  },
  {
    name: 'local date with repeated midnight (25h)',
    zone: 'America/Havana',
    expr: "local_date(ts) = DATE '2026-11-01'",
    dayKey: '2026-11-01',
    expectIntervals: 1,
    expectHours: 25,
  },
  {
    name: 'half-hour DST shift',
    zone: 'Australia/Lord_Howe',
    expr: "local_date(ts) = DATE '2026-10-04'",
    dayKey: '2026-10-04',
    expectIntervals: null,
    expectHours: 23.5,
  },
  {
    name: 'repeated wall hour keeps both folds',
    zone: 'America/New_York',
    expr: "local_ts(ts) = WALL '2026-11-01 01:30:00'",
    dayKey: '2026-11-01',
    expectIntervals: 2,
    expectHours: 2 / 3600,
  },
];

test('targeted zoned cases produce exact interval sets', () => {
  for (const c of CASES) {
    const compiled = compile(c.expr, { zone: c.zone });
    const widthHours = compiled.coverage.widthHours;
    assert.ok(
      Math.abs(widthHours - c.expectHours) < 1e-6,
      `${c.name}: expected ${c.expectHours}h, got ${widthHours}h`,
    );
    if (c.expectIntervals != null) {
      assert.equal(compiled.intervals.length, c.expectIntervals, `${c.name}: interval count`);
    }
    if (c.expectParts != null) {
      assert.equal(compiled.partitions.length, c.expectParts, `${c.name}: partition count`);
    }
    const win = windowAround(c.dayKey, 2);
    const bad = disagreements(compiled, win.loUs, win.hiUs, 60 * 1e6);
    assert.equal(bad.length, 0, `${c.name}: ${JSON.stringify(bad)}`);
  }
});

test('wall-clock equality inside a repeated hour matches both instants', () => {
  const compiled = compile("local_ts(ts) = WALL '2026-11-01 01:30:00'", { zone: 'America/New_York' });
  assert.equal(compiled.intervals.length, 2);
  const evaluator = makeRowEvaluator(compiled);
  for (const iv of compiled.intervals) {
    assert.equal(iv.hiUs - iv.loUs, 1_000_000, 'each occurrence lasts one local second');
    assert.ok(evaluator(iv.loUs));
    assert.ok(evaluator(iv.hiUs - 1));
  }
  // Both occurrences are exactly one hour apart.
  assert.equal(compiled.intervals[1].loUs - compiled.intervals[0].loUs, 3600 * 1e6);
});

test('AT literals honour the ambiguity policy', () => {
  const expr = "ts >= AT '2026-11-01 01:30:00'";
  const earlier = compile(expr, { zone: 'America/New_York', policy: 'earlier' });
  const later = compile(expr, { zone: 'America/New_York', policy: 'later' });
  const both = compile(expr, { zone: 'America/New_York', policy: 'both' });
  assert.equal(earlier.intervals[0].loUs + 3600 * 1e6, later.intervals[0].loUs);
  assert.equal(both.intervals[0].loUs, earlier.intervals[0].loUs);

  // Evaluator and compiler must agree for each policy.
  const win = windowAround('2026-11-01', 1);
  for (const compiled of [earlier, later, both]) {
    const bad = disagreements(compiled, win.loUs, win.hiUs, 60 * 1e6);
    assert.equal(bad.length, 0, JSON.stringify(bad));
  }
});

test('AT literal inside a spring-forward gap matches nothing', () => {
  const compiled = compile("ts = AT '2026-03-08 02:30:00'", { zone: 'America/New_York' });
  assert.equal(compiled.intervals.length, 0);
  const noteText = compiled.nodes.flatMap((n) => n.notes ?? []).join(' ');
  assert.match(noteText, /gap/);
});

test('NOT and IN compose exactly', () => {
  const expr = "local_date(ts) IN (DATE '2026-03-08', DATE '2026-11-01')";
  const compiled = compile(expr, { zone: 'America/New_York' });
  assert.equal(compiled.intervals.length, 2);
  assert.ok(Math.abs(compiled.coverage.widthHours - (23 + 25)) < 1e-9);

  const negated = compile(`NOT (${expr})`, { zone: 'America/New_York' });
  assert.equal(negated.intervals.length, 3);
  assert.ok(Math.abs(negated.coverage.widthHours - (365 * 24 - 48)) < 1e-6);

  const win = windowAround('2026-03-08', 3);
  assert.equal(disagreements(negated, win.loUs, win.hiUs, 30 * 1e6).length, 0);
});

test('BETWEEN over a local date range is exact', () => {
  const compiled = compile(
    "local_date(ts) BETWEEN DATE '2026-03-07' AND DATE '2026-03-09'",
    { zone: 'America/Havana' },
  );
  // 24 + 23 + 24 hours.
  assert.ok(Math.abs(compiled.coverage.widthHours - 71) < 1e-6);
  const win = windowAround('2026-03-08', 3);
  assert.equal(disagreements(compiled, win.loUs, win.hiUs, 60 * 1e6).length, 0);
});

test('partition selection is sound and necessary for every case', () => {
  for (const c of CASES) {
    const compiled = compile(c.expr, { zone: c.zone });
    const evaluator = makeRowEvaluator(compiled);
    const selected = new Set(compiled.partitions.map((p) => p.dayKey));
    // Soundness: any instant satisfying the predicate is inside a selected day.
    const win = windowAround(c.dayKey, 3);
    for (let us = win.loUs; us < win.hiUs; us += 17 * 60 * 1e6) {
      if (!evaluator(us)) continue;
      const day = Math.floor(us / US_PER_DAY);
      const key = new Date(day * 86400 * 1000).toISOString().slice(0, 10);
      assert.ok(selected.has(key), `${c.name}: instant ${us} in ${key} not covered`);
    }
    // Necessity: every selected day contains at least one matching instant.
    for (const p of compiled.partitions) {
      let found = false;
      for (const iv of p.intervals) {
        if (evaluator(iv.loUs) || evaluator(iv.hiUs - 1)) { found = true; break; }
      }
      assert.ok(found, `${c.name}: selected ${p.dayKey} has no matching instant`);
    }
  }
});

test('covering ratios are consistent with interval widths', () => {
  const compiled = compile("local_date(ts) >= DATE '2026-03-01' AND local_date(ts) < DATE '2026-04-01'", {
    zone: 'America/Santiago',
  });
  const sum = compiled.partitions.reduce((acc, p) => acc + p.overlapUs, 0);
  assert.equal(sum, compiled.coverage.widthUs);
  for (const p of compiled.partitions) {
    assert.ok(p.coverageRatio > 0 && p.coverageRatio <= 1);
    assert.equal(p.fullDay, p.overlapUs === US_PER_DAY);
  }
});

test('naive mode treats local time as UTC and disagrees on DST days', () => {
  const expr = "local_date(ts) = DATE '2026-03-08'";
  const zoned = compile(expr, { zone: 'America/Havana' });
  const naive = compile(expr, { zone: 'America/Havana', mode: 'naive' });
  assert.equal(zoned.coverage.widthHours, 23);
  assert.equal(naive.coverage.widthHours, 24);
  const zonedKeys = new Set(zoned.partitions.map((p) => p.dayKey));
  const naiveKeys = new Set(naive.partitions.map((p) => p.dayKey));
  // The Havana local day runs to 03:59:59Z on 03-09, so a naive UTC-date
  // selection would never open that partition and would silently lose rows.
  const missedByNaive = [...zonedKeys].filter((k) => !naiveKeys.has(k));
  assert.deepEqual(missedByNaive, ['2026-03-09']);
  assert.deepEqual([...naiveKeys].filter((k) => !zonedKeys.has(k)), []);
});

test('randomized differential test: 96 expressions vs per-instant evaluation', () => {
  const zones = ['America/New_York', 'America/Havana', 'Australia/Lord_Howe', 'Pacific/Chatham', 'Europe/Berlin', 'UTC'];
  const days = ['2026-03-07', '2026-03-08', '2026-03-09', '2026-10-03', '2026-10-04', '2026-10-31', '2026-11-01', '2026-11-02'];
  const ops = ['=', '<', '<=', '>', '>='];
  let checked = 0;
  let seed = 20261126;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];

  for (let i = 0; i < 96; i += 1) {
    const zone = pick(zones);
    const day = pick(days);
    const op = pick(ops);
    const useWall = rand() < 0.5;
    const expr = useWall
      ? `local_ts(ts) ${op} WALL '${day} ${String(Math.floor(rand() * 24)).padStart(2, '0')}:30:00'`
      : `local_date(ts) ${op} DATE '${day}'`;
    const compiled = compile(expr, { zone });
    const win = windowAround(day, 2);
    const bad = disagreements(compiled, win.loUs, win.hiUs, 30 * 60 * 1e6);
    assert.equal(bad.length, 0, `${zone} ${expr} -> ${JSON.stringify(bad)}`);
    checked += 1;
  }
  assert.equal(checked, 96);
});

test('day boundaries at second granularity match timeline.dayAnatomy', () => {
  for (const zone of ['America/New_York', 'America/Havana', 'Australia/Lord_Howe']) {
    const day = dayFromDateKey('2026-11-01');
    const tl = getTimeline(zone, (day - 2) * SEC_PER_DAY, (day + 2) * SEC_PER_DAY);
    const compiled = compile("local_date(ts) = DATE '2026-11-01'", { zone });
    const anatomy = tl.dayAnatomy(day);
    assert.equal(compiled.intervals[0].loUs, anatomy.startUs, `${zone} start`);
    assert.equal(compiled.intervals[compiled.intervals.length - 1].hiUs, anatomy.endUs, `${zone} end`);
  }
});
