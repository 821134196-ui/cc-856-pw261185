// Interval-set algebra over half-open microsecond ranges.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeIntervalSet,
  unionIntervalSets,
  intersectIntervalSets,
  subtractIntervalSets,
  complementIntervalSet,
  intervalEquals,
  intervalsContainUs,
  totalWidthUs,
  intervalsBounding,
} from '../server/intervals.mjs';

const iv = (loUs, hiUs) => ({ loUs, hiUs });

test('normalize sorts, drops empty intervals and coalesces touching ranges', () => {
  const out = normalizeIntervalSet([iv(20, 30), iv(0, 10), iv(10, 15), iv(5, 5), iv(40, 50)]);
  assert.deepEqual(out.map((x) => [x.loUs, x.hiUs]), [[0, 15], [20, 30], [40, 50]]);
});

test('normalize merges overlapping ranges and keeps the widest extent', () => {
  const out = normalizeIntervalSet([iv(0, 100), iv(20, 40), iv(90, 140)]);
  assert.deepEqual(out.map((x) => [x.loUs, x.hiUs]), [[0, 140]]);
});

test('union is idempotent', () => {
  const a = [iv(0, 10), iv(20, 30)];
  assert.ok(intervalEquals(unionIntervalSets(a, a), a));
});

test('intersection keeps only the shared part', () => {
  const out = intersectIntervalSets([iv(0, 10), iv(20, 30)], [iv(5, 25)]);
  assert.deepEqual(out.map((x) => [x.loUs, x.hiUs]), [[5, 10], [20, 25]]);
});

test('subtraction carves holes and can split an interval', () => {
  const out = subtractIntervalSets([iv(0, 100)], [iv(20, 30), iv(50, 60)]);
  assert.deepEqual(out.map((x) => [x.loUs, x.hiUs]), [[0, 20], [30, 50], [60, 100]]);
});

test('complement is exact and involutive', () => {
  const a = [iv(10, 20), iv(30, 40)];
  const c = complementIntervalSet(a, [0, 50]);
  assert.deepEqual(c.map((x) => [x.loUs, x.hiUs]), [[0, 10], [20, 30], [40, 50]]);
  assert.ok(intervalEquals(complementIntervalSet(c, [0, 50]), a));
});

test('complement of an empty set is the whole universe', () => {
  const c = complementIntervalSet([], [7, 9]);
  assert.deepEqual(c.map((x) => [x.loUs, x.hiUs]), [[7, 9]]);
});

test('membership treats ranges as half-open', () => {
  const set = [iv(10, 20)];
  assert.equal(intervalsContainUs(set, 9), false);
  assert.equal(intervalsContainUs(set, 10), true);
  assert.equal(intervalsContainUs(set, 19), true);
  assert.equal(intervalsContainUs(set, 20), false);
});

test('width and bounding box', () => {
  const set = [iv(0, 10), iv(20, 25)];
  assert.equal(totalWidthUs(set), 15);
  assert.deepEqual(intervalsBounding(set), { loUs: 0, hiUs: 25 });
  assert.equal(intervalsBounding([]), null);
});

test('set algebra agrees with brute force on random inputs', () => {
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const randomSet = () => {
    const parts = [];
    for (let i = 0; i < 4; i += 1) {
      const lo = Math.floor(rand() * 90);
      const hi = lo + 1 + Math.floor(rand() * 20);
      parts.push(iv(lo, hi));
    }
    return normalizeIntervalSet(parts);
  };
  for (let trial = 0; trial < 200; trial += 1) {
    const a = randomSet();
    const b = randomSet();
    const union = unionIntervalSets(a, b);
    const inter = intersectIntervalSets(a, b);
    const diff = complementIntervalSet(a, [0, 120]);
    for (let x = -1; x <= 121; x += 1) {
      const inA = intervalsContainUs(a, x);
      const inB = intervalsContainUs(b, x);
      assert.equal(intervalsContainUs(union, x), inA || inB, `union at ${x}`);
      assert.equal(intervalsContainUs(inter, x), inA && inB, `intersect at ${x}`);
      assert.equal(intervalsContainUs(diff, x), x >= 0 && x < 120 && !inA, `complement at ${x}`);
    }
  }
});
