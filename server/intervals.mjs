// Half-open interval sets over integer microseconds since the Unix epoch.
// Intervals are [loUs, hiUs) and stored normalized: sorted, non-overlapping,
// non-adjacent (touching intervals coalesce).

export function normalizeIntervalSet(intervals) {
  const cleaned = intervals
    .filter((iv) => Number.isFinite(iv.loUs) && Number.isFinite(iv.hiUs) && iv.hiUs > iv.loUs)
    .sort((a, b) => a.loUs - b.loUs || a.hiUs - b.hiUs);
  const out = [];
  for (const iv of cleaned) {
    const last = out[out.length - 1];
    if (last && iv.loUs <= last.hiUs) {
      last.hiUs = Math.max(last.hiUs, iv.hiUs);
      if (iv.reason && !last.reason) last.reason = iv.reason;
    } else {
      out.push({ loUs: iv.loUs, hiUs: iv.hiUs, reason: iv.reason ?? null });
    }
  }
  return out;
}

export function unionIntervalSets(a, b) {
  return normalizeIntervalSet([...a, ...b]);
}

export function intersectIntervalSets(a, b) {
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i].loUs, b[j].loUs);
    const hi = Math.min(a[i].hiUs, b[j].hiUs);
    if (hi > lo) out.push({ loUs: lo, hiUs: hi, reason: a[i].reason ?? b[j].reason ?? null });
    if (a[i].hiUs < b[j].hiUs) i += 1;
    else j += 1;
  }
  return out;
}

export function subtractIntervalSets(a, b) {
  let current = a.map((iv) => ({ ...iv }));
  for (const cut of b) {
    const next = [];
    for (const iv of current) {
      if (cut.hiUs <= iv.loUs || cut.loUs >= iv.hiUs) {
        next.push(iv);
        continue;
      }
      if (iv.loUs < cut.loUs) next.push({ loUs: iv.loUs, hiUs: cut.loUs, reason: iv.reason });
      if (iv.hiUs > cut.hiUs) next.push({ loUs: cut.hiUs, hiUs: iv.hiUs, reason: iv.reason });
    }
    current = next;
  }
  return normalizeIntervalSet(current);
}

export function complementIntervalSet(a, universe) {
  const [lo, hi] = universe;
  return subtractIntervalSets([{ loUs: lo, hiUs: hi }], a).filter((iv) => iv.hiUs > iv.loUs);
}

export function intervalEquals(a, b) {
  if (a.length !== b.length) return false;
  return a.every((iv, idx) => iv.loUs === b[idx].loUs && iv.hiUs === b[idx].hiUs);
}

export function intervalsContainUs(intervals, us) {
  let lo = 0;
  let hi = intervals.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const iv = intervals[mid];
    if (us < iv.loUs) hi = mid - 1;
    else if (us >= iv.hiUs) lo = mid + 1;
    else return true;
  }
  return false;
}

export function totalWidthUs(intervals) {
  return intervals.reduce((sum, iv) => sum + (iv.hiUs - iv.loUs), 0);
}

export function intervalsBounding(intervals) {
  if (intervals.length === 0) return null;
  return { loUs: intervals[0].loUs, hiUs: intervals[intervals.length - 1].hiUs };
}
