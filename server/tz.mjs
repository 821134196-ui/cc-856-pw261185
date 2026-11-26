// Timezone primitives built on the runtime's ICU data (Intl), with an
// integer-arithmetic timeline so per-row evaluation costs no Intl calls.
//
// Core semantic definitions used throughout the lab:
//   local day d starts at the *earliest* instant whose local calendar date is d.
//   A day is therefore 23 h, 24 h, 25 h (or 23.5/24.5 h with 30-min DST),
//   and a repeated midnight hour belongs to exactly one local day.
//   A local date skipped entirely has zero width.

export const SEC_PER_DAY = 86_400;
export const US_PER_DAY = 86_400_000_000;

const formatterCache = new Map();

function formatterFor(zone) {
  let f = formatterCache.get(zone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        calendar: 'gregory',
        numberingSystem: 'latn',
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch (err) {
      throw new Error(`Unknown timezone: ${zone}`);
    }
    // Fail fast on aliases the runtime does not know.
    try {
      f.formatToParts(new Date(0));
    } catch (err) {
      throw new Error(`Unknown timezone: ${zone}`);
    }
    formatterCache.set(zone, f);
  }
  return f;
}

export function assertZone(zone) {
  formatterFor(zone);
  return zone;
}

export function listZones() {
  return Intl.supportedValuesOf('timeZone');
}

/** Wall-clock parts for a UTC instant (seconds). */
export function wallPartsAt(zone, utcSec) {
  const f = formatterFor(zone);
  const parts = f.formatToParts(new Date(utcSec * 1000));
  const p = {};
  for (const part of parts) {
    if (part.type !== 'literal') p[part.type] = part.value;
  }
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

export function offsetSecondsAt(zone, utcSec) {
  const p = wallPartsAt(zone, utcSec);
  const wall = daysFromCivil(p.year, p.month, p.day) * SEC_PER_DAY
    + p.hour * 3600 + p.minute * 60 + p.second;
  return wall - utcSec;
}

export function formatOffset(offSec) {
  const sign = offSec < 0 ? '-' : '+';
  const abs = Math.abs(offSec);
  const hh = Math.floor(abs / 3600);
  const mm = Math.floor((abs % 3600) / 60);
  const ss = abs % 60;
  return `${sign}${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}${ss ? ':' + String(ss).padStart(2, '0') : ''}`;
}

export function formatWall(p) {
  return `${String(p.year).padStart(4, '0')}-${pad2(p.month)}-${pad2(p.day)}`
    + ` ${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}`;
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

// --- Proleptic Gregorian civil date <-> epoch day (Howard Hinnant) ---

export function daysFromCivil(year, month, day) {
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function civilFromDays(z) {
  let x = z + 719468;
  const era = Math.floor(x / 146097);
  const doe = x - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = y + (month <= 2 ? 1 : 0);
  return { year, month, day };
}

export function dateKeyFromDay(dayIndex) {
  const c = civilFromDays(dayIndex);
  return `${String(c.year).padStart(4, '0')}-${pad2(c.month)}-${pad2(c.day)}`;
}

export function dayFromDateKey(key) {
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(key);
  if (!m) throw new Error(`Invalid date (expected YYYY-MM-DD): ${key}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) throw new Error(`Invalid date: ${key}`);
  const c = civilFromDays(daysFromCivil(year, month, day));
  if (c.year !== year || c.month !== month || c.day !== day) throw new Error(`Invalid date: ${key}`);
  return daysFromCivil(year, month, day);
}

export function weekdayOfDay(dayIndex) {
  // 1970-01-01 was a Thursday (index 4, Monday = 0).
  return ((dayIndex + 4) % 7 + 7) % 7;
}

export const WEEKDAY_NAMES = ['一', '二', '三', '四', '五', '六', '日'];

export function floorDiv(a, b) {
  return Math.floor(a / b);
}

export function utcTimestampLabel(us) {
  const sec = Math.floor(us / 1_000_000);
  const day = floorDiv(sec, SEC_PER_DAY);
  const sod = sec - day * SEC_PER_DAY;
  return `${dateKeyFromDay(day)}T${pad2(Math.floor(sod / 3600))}:${pad2(Math.floor((sod % 3600) / 60))}:${pad2(sod % 60)}Z`;
}

export function localDateKeyAtSec(zone, utcSec, off) {
  const offSec = off ?? offsetSecondsAt(zone, utcSec);
  return dateKeyFromDay(floorDiv(utcSec + offSec, SEC_PER_DAY));
}

/**
 * A zone's offset timeline over a bounded range. Transitions are discovered by
 * sampling ICU at a fixed step and bisecting to the exact second. Per-row work
 * afterwards is pure integer math.
 */
export class ZoneTimeline {
  constructor(zone, minSec, maxSec) {
    this.zone = zone;
    this.minSec = Math.floor(minSec);
    this.maxSec = Math.ceil(maxSec);
    this.initialOffset = offsetSecondsAt(zone, this.minSec);
    this.transitions = discoverTransitions(zone, this.minSec, this.maxSec);
    this.dayStartCache = new Map();
    this.anatomyCache = new Map();
  }

  expandTo(minSec, maxSec) {
    if (minSec >= this.minSec && maxSec <= this.maxSec) return this;
    const lo = Math.min(this.minSec, Math.floor(minSec));
    const hi = Math.max(this.maxSec, Math.ceil(maxSec));
    return new ZoneTimeline(this.zone, lo, hi);
  }

  offsetAt(utcSec) {
    const trs = this.transitions;
    let lo = 0;
    let hi = trs.length - 1;
    let answer = this.initialOffset;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (trs[mid].atSec <= utcSec) {
        answer = trs[mid].toOffset;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return answer;
  }

  /** Local calendar day index for an instant. */
  localDayAtSec(utcSec) {
    return floorDiv(utcSec + this.offsetAt(utcSec), SEC_PER_DAY);
  }

  localDayAtUs(utcUs) {
    return this.localDayAtSec(Math.floor(utcUs / 1_000_000));
  }

  localPartsAtSec(utcSec) {
    const off = this.offsetAt(utcSec);
    const wall = utcSec + off;
    const day = floorDiv(wall, SEC_PER_DAY);
    const sod = wall - day * SEC_PER_DAY;
    const c = civilFromDays(day);
    return {
      ...c,
      hour: Math.floor(sod / 3600),
      minute: Math.floor((sod % 3600) / 60),
      second: sod % 60,
      offsetSeconds: off,
      dayIndex: day,
    };
  }

  localPartsAtUs(utcUs) {
    return this.localPartsAtSec(Math.floor(utcUs / 1_000_000));
  }

  localLabelAtUs(utcUs) {
    const p = this.localPartsAtUs(utcUs);
    const key = `${String(p.year).padStart(4, '0')}-${pad2(p.month)}-${pad2(p.day)}`;
    return `${key} ${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)} ${formatOffset(p.offsetSeconds)}`;
  }

  /**
   * Earliest instant (seconds) whose local date index is >= dayIndex.
   * Binary search is valid because local date is non-decreasing in the range
   * where this lab runs (asserted by `foldRegressions` and tests).
   */
  dayStartSec(dayIndex) {
    const cached = this.dayStartCache.get(dayIndex);
    if (cached !== undefined) return cached;
    const naive = dayIndex * SEC_PER_DAY;
    let lo = naive - 36 * 3600;
    let hi = naive + 36 * 3600;
    const loDay = this.localDayAtSec(lo);
    const hiDay = this.localDayAtSec(hi);
    if (loDay >= dayIndex) {
      this.dayStartCache.set(dayIndex, lo);
      return lo;
    }
    if (hiDay < dayIndex) {
      // Dateline-scale jump: widen once.
      hi = naive + 72 * 3600;
      if (this.localDayAtSec(hi) < dayIndex) {
        throw new Error(`Cannot resolve local day ${dateKeyFromDay(dayIndex)} in ${this.zone}`);
      }
    }
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (this.localDayAtSec(mid) >= dayIndex) hi = mid;
      else lo = mid;
    }
    this.dayStartCache.set(dayIndex, hi);
    return hi;
  }

  dayStartUs(dayIndex) {
    return this.dayStartSec(dayIndex) * 1_000_000;
  }

  /** Exclusive UTC end (µs) of local day d = start of local day d+1. */
  dayEndUs(dayIndex) {
    return this.dayStartUs(dayIndex + 1);
  }

  /** Exclusive UTC end (seconds) of local day d. */
  dayEndSec(dayIndex) {
    return this.dayStartSec(dayIndex + 1);
  }

  dayLengthSec(dayIndex) {
    return this.dayStartSec(dayIndex + 1) - this.dayStartSec(dayIndex);
  }

  /** All instants whose wall clock equals `timeOfDaySec` on local day d. */
  resolveLocalTime(dayIndex, timeOfDaySec) {
    const naive = dayIndex * SEC_PER_DAY + timeOfDaySec;
    const candidates = new Set();
    const offsets = new Set([
      this.offsetAt(naive - 2 * SEC_PER_DAY),
      this.offsetAt(naive),
      this.offsetAt(naive + 2 * SEC_PER_DAY),
    ]);
    for (const tr of this.transitions) {
      if (tr.atSec >= naive - 2 * SEC_PER_DAY && tr.atSec <= naive + 2 * SEC_PER_DAY) {
        offsets.add(tr.fromOffset);
        offsets.add(tr.toOffset);
      }
    }
    for (const off of offsets) {
      const t = naive - off;
      if (this.offsetAt(t) !== off) continue;
      if (this.localDayAtSec(t) === dayIndex) {
        const wallSec = (t + off) - dayIndex * SEC_PER_DAY;
        if (wallSec === timeOfDaySec) candidates.add(t);
      }
    }
    return [...candidates].sort((a, b) => a - b);
  }

  transitionsBetween(fromUs, toUs) {
    const from = Math.floor(fromUs / 1_000_000);
    const to = Math.ceil(toUs / 1_000_000);
    return this.transitions.filter((t) => t.atSec >= from && t.atSec <= to);
  }

  /** Local date regressions (would break the day-range transform). */
  foldRegressions() {
    const bad = [];
    for (const tr of this.transitions) {
      if (tr.kind !== 'fold') continue;
      const before = this.localDayAtSec(tr.atSec - 1);
      const after = this.localDayAtSec(tr.atSec);
      if (after < before) bad.push({ transition: tr, before, after });
    }
    return bad;
  }

  /** Rich description of a local calendar day, including midnight and DST. */
  dayAnatomy(dayIndex) {
    const cached = this.anatomyCache.get(dayIndex);
    if (cached) return cached;
    const startUs = this.dayStartUs(dayIndex);
    const endUs = this.dayEndUs(dayIndex);
    const lengthSec = (endUs - startUs) / 1_000_000;
    const midnight = this.resolveLocalTime(dayIndex, 0);
    const midnightStatus = midnight.length === 0 ? 'skipped' : midnight.length > 1 ? 'repeated' : 'normal';
    const transitions = this.transitionsBetween(startUs, endUs).map((tr) => {
      const before = this.localPartsAtSec(tr.atSec - 1);
      const after = this.localPartsAtSec(tr.atSec);
      const localBefore = `${formatWall(before)} ${formatOffset(before.offsetSeconds)}`;
      const localAfter = `${formatWall(after)} ${formatOffset(after.offsetSeconds)}`;
      let localGap = null;
      let localFold = null;
      if (tr.kind === 'gap') {
        const lo = tr.atSec + tr.fromOffset;
        const hi = tr.atSec + tr.toOffset;
        localGap = {
          fromUs: tr.atSec * 1_000_000,
          toUs: (tr.atSec + (tr.toOffset - tr.fromOffset)) * 1_000_000,
          fromWall: this.wallFromAbsSec(lo),
          toWall: this.wallFromAbsSec(hi),
          seconds: tr.toOffset - tr.fromOffset,
        };
      } else {
        const localLo = tr.atSec + tr.toOffset;
        const localHi = tr.atSec + tr.fromOffset;
        localFold = {
          fromUs: (tr.atSec - (tr.fromOffset - tr.toOffset)) * 1_000_000,
          firstOccurrenceUs: (tr.atSec - (tr.fromOffset - tr.toOffset)) * 1_000_000,
          transitionUs: tr.atSec * 1_000_000,
          toUs: (tr.atSec + (tr.fromOffset - tr.toOffset)) * 1_000_000,
          fromWall: this.wallFromAbsSec(localLo),
          toWall: this.wallFromAbsSec(localHi),
          seconds: tr.fromOffset - tr.toOffset,
        };
      }
      const repeatedSpan = tr.kind === 'fold'
        ? [tr.atSec - (tr.fromOffset - tr.toOffset), tr.atSec + (tr.fromOffset - tr.toOffset)]
        : null;
      const midnightAffected = tr.kind === 'gap'
        ? (tr.atSec + tr.fromOffset) <= dayIndex * SEC_PER_DAY + 1 && (tr.atSec + tr.toOffset) >= (dayIndex + 1) * SEC_PER_DAY
          || rangesOverlap([tr.atSec + tr.fromOffset, tr.atSec + tr.toOffset], [dayIndex * SEC_PER_DAY, dayIndex * SEC_PER_DAY + 3600])
        : rangesOverlap(repeatedSpan, [dayIndex * SEC_PER_DAY, dayIndex * SEC_PER_DAY + 3600]);
      return {
        atUs: tr.atSec * 1_000_000,
        fromOffset: tr.fromOffset,
        toOffset: tr.toOffset,
        kind: tr.kind,
        deltaSec: tr.toOffset - tr.fromOffset,
        localBefore,
        localAfter,
        gap: localGap,
        fold: localFold,
        affectsMidnight: midnightAffected,
      };
    });
    const result = {
      zone: this.zone,
      dayIndex,
      dayKey: dateKeyFromDay(dayIndex),
      startUs,
      endUs,
      startLocal: this.localLabelAtUs(startUs),
      endLocal: this.localLabelAtUs(endUs - 1),
      lengthSec,
      lengthHours: lengthSec / 3600,
      midnightStatus,
      midnightOccurrences: midnight.map((s) => s * 1_000_000),
      transitions,
    };
    this.anatomyCache.set(dayIndex, result);
    return result;
  }

  /** Local wall label for an absolute "wall seconds" value (no offset math). */
  wallFromAbsSec(absSec) {
    const day = floorDiv(absSec, SEC_PER_DAY);
    const sod = absSec - day * SEC_PER_DAY;
    const c = civilFromDays(day);
    return `${String(c.year).padStart(4, '0')}-${pad2(c.month)}-${pad2(c.day)} ${pad2(Math.floor(sod / 3600))}:${pad2(Math.floor((sod % 3600) / 60))}:${pad2(sod % 60)}`;
  }

  describeTransition(tr) {
    const before = this.localPartsAtSec(tr.atSec - 1);
    const after = this.localPartsAtSec(tr.atSec);
    return {
      atUs: tr.atSec * 1_000_000,
      atUtc: utcTimestampLabel(tr.atSec * 1_000_000),
      kind: tr.kind,
      fromOffset: tr.fromOffset,
      toOffset: tr.toOffset,
      deltaSec: tr.toOffset - tr.fromOffset,
      localBefore: `${formatWall(before)} ${formatOffset(before.offsetSeconds)}`,
      localAfter: `${formatWall(after)} ${formatOffset(after.offsetSeconds)}`,
    };
  }
}

function rangesOverlap(a, b) {
  return a[0] < b[1] && b[0] < a[1];
}

function discoverTransitions(zone, minSec, maxSec) {
  const step = 6 * 3600;
  const transitions = [];
  let prevAt = minSec;
  let prevOffset = offsetSecondsAt(zone, minSec);
  for (let t = minSec + step; t <= maxSec + step; t += step) {
    const at = Math.min(t, maxSec);
    const offset = offsetSecondsAt(zone, at);
    if (offset !== prevOffset) {
      let lo = prevAt;
      let hi = at;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (offsetSecondsAt(zone, mid) === prevOffset) lo = mid;
        else hi = mid;
      }
      transitions.push({
        atSec: hi,
        fromOffset: prevOffset,
        toOffset: offset,
        kind: offset > prevOffset ? 'gap' : 'fold',
      });
      prevOffset = offset;
      prevAt = hi;
    } else {
      prevAt = at;
    }
    if (at === maxSec) break;
  }
  return transitions;
}

const timelineCache = new Map();

export function getTimeline(zone, minSec, maxSec) {
  assertZone(zone);
  const existing = timelineCache.get(zone);
  if (existing && minSec >= existing.minSec && maxSec <= existing.maxSec) return existing;
  const lo = Math.min(Math.floor(minSec), existing ? existing.minSec : Infinity);
  const hi = Math.max(Math.ceil(maxSec), existing ? existing.maxSec : -Infinity);
  const timeline = new ZoneTimeline(zone, lo, hi);
  timelineCache.set(zone, timeline);
  return timeline;
}

export function clearTimelineCache() {
  timelineCache.clear();
}
