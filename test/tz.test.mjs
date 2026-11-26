// Timezone foundation: local day anatomy and calendar conversions.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SEC_PER_DAY,
  getTimeline,
  daysFromCivil,
  civilFromDays,
  dateKeyFromDay,
  dayFromDateKey,
  localDateKeyAtSec,
} from '../server/tz.mjs';

function anatomy(zone, dayKey) {
  const day = dayFromDateKey(dayKey);
  const tl = getTimeline(zone, day * SEC_PER_DAY - 3 * SEC_PER_DAY, (day + 1) * SEC_PER_DAY + 3 * SEC_PER_DAY);
  return tl.dayAnatomy(day);
}

test('civilFromDays round-trips every day in 1900-2100', () => {
  const lo = daysFromCivil(1900, 1, 1);
  const hi = daysFromCivil(2100, 12, 31);
  for (let d = lo; d <= hi; d += 1) {
    const c = civilFromDays(d);
    assert.equal(daysFromCivil(c.year, c.month, c.day), d, `day ${d} -> ${c.year}-${c.month}-${c.day}`);
  }
});

test('date keys map back to day indices', () => {
  for (const key of ['1900-01-01', '1970-01-01', '2026-02-28', '2026-12-31', '2100-12-31']) {
    assert.equal(dateKeyFromDay(dayFromDateKey(key)), key);
  }
});

test('24h local days in a zone without DST', () => {
  for (const [zone, dayKey] of [
    ['Asia/Shanghai', '2026-03-08'],
    ['UTC', '2026-11-01'],
  ]) {
    const a = anatomy(zone, dayKey);
    assert.equal(a.lengthSec, SEC_PER_DAY, `${zone} ${dayKey} length`);
    assert.equal(a.midnightStatus, 'normal');
  }
});

test('New York 2026: spring-forward day is 23h with a normal midnight', () => {
  const a = anatomy('America/New_York', '2026-03-08');
  assert.equal(a.lengthSec, 23 * 3600);
  assert.equal(a.midnightStatus, 'normal');
  assert.equal(a.transitions.length, 1);
  assert.equal(a.transitions[0].kind, 'gap');
  assert.equal(a.transitions[0].deltaSec, 3600);
});

test('New York 2026: fall-back day is 25h and contains a repeated hour', () => {
  const a = anatomy('America/New_York', '2026-11-01');
  assert.equal(a.lengthSec, 25 * 3600);
  assert.equal(a.midnightStatus, 'normal');
  const fold = a.transitions.find((tr) => tr.kind === 'fold');
  assert.ok(fold, 'expected a fold transition');
  assert.equal(fold.deltaSec, -3600);
  assert.equal(fold.fold.seconds, 3600);
});

test('Havana 2026-03-08 has no local midnight and starts at 01:00', () => {
  const a = anatomy('America/Havana', '2026-03-08');
  assert.equal(a.midnightStatus, 'skipped');
  assert.equal(a.lengthSec, 23 * 3600);
  assert.match(a.startLocal, /2026-03-08 01:00:00/);
});

test('Havana 2026-11-01 repeats midnight and is 25h long', () => {
  const a = anatomy('America/Havana', '2026-11-01');
  assert.equal(a.midnightStatus, 'repeated');
  assert.equal(a.midnightOccurrences.length, 2);
  assert.equal(a.lengthSec, 25 * 3600);
  assert.equal(a.midnightOccurrences[1] - a.midnightOccurrences[0], 3600 * 1e6);
});

test('Lord Howe uses a 30-minute DST shift', () => {
  const spring = anatomy('Australia/Lord_Howe', '2026-10-04');
  assert.equal(spring.lengthSec, 23.5 * 3600);
  const autumn = anatomy('Australia/Lord_Howe', '2026-04-05');
  assert.equal(autumn.lengthSec, 24.5 * 3600);
});

test('days tile the timeline: end of one local day is the start of the next', () => {
  for (const zone of ['America/New_York', 'America/Havana', 'Australia/Lord_Howe', 'Pacific/Chatham', 'Asia/Beirut']) {
    const day = dayFromDateKey('2026-03-07');
    const tl = getTimeline(zone, day * SEC_PER_DAY - 2 * SEC_PER_DAY, (day + 5) * SEC_PER_DAY);
    for (let d = day; d < day + 4; d += 1) {
      assert.equal(tl.dayEndSec(d), tl.dayStartSec(d + 1), `${zone} day ${d}`);
      assert.ok(tl.dayLengthSec(d) > 20 * 3600 && tl.dayLengthSec(d) < 29 * 3600, `${zone} day ${d} length`);
    }
  }
});

test('local date is non-decreasing across every supported featured zone in 2026', () => {
  for (const zone of ['America/New_York', 'America/Havana', 'America/Santiago', 'Australia/Lord_Howe', 'Pacific/Chatham', 'Atlantic/Azores', 'Asia/Beirut', 'America/Nuuk', 'Africa/Cairo']) {
    const lo = daysFromCivil(2026, 1, 1) * SEC_PER_DAY;
    const hi = daysFromCivil(2027, 1, 1) * SEC_PER_DAY;
    const tl = getTimeline(zone, lo - 2 * SEC_PER_DAY, hi + 2 * SEC_PER_DAY);
    assert.equal(tl.foldRegressions().length, 0, `${zone} has a local-date regression`);
    assert.ok(tl.transitions.length > 0, `${zone} should have transitions in 2026`);
  }
});

test('local dates agree with Intl for a sample of instants', () => {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Havana', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const tl = getTimeline('America/Havana', 0, 0);
  for (let day = daysFromCivil(2026, 1, 1); day < daysFromCivil(2026, 1, 10); day += 1) {
    for (const hour of [0, 6, 12, 18, 23]) {
      const sec = day * SEC_PER_DAY + hour * 3600;
      const expected = fmt.format(new Date(sec * 1000));
      assert.equal(localDateKeyAtSec('America/Havana', sec), expected);
      assert.equal(dateKeyFromDay(tl.localDayAtSec(sec)), expected);
    }
  }
});
