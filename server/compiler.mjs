// Compile a zoned predicate into exact UTC interval sets, then into the set of
// UTC-day partitions that can possibly contain matching rows.
//
// Why interval sets rather than "start/end": a local day is not a contiguous
// shift of a UTC day when the zone crosses a midnight DST transition, and a
// query can be a disjunction, a negation or an IN-list. Interval algebra keeps
// every transform exact, so NOT and BETWEEN stay correct.
//
// Two independent notions are kept apart:
//   * semantics  - what the predicate means, evaluated instant by instant;
//   * pruning    - which physical partitions must be opened.
// This module only computes (2) plus an exact set (1); the executor still
// re-evaluates every candidate row, and the verifier recomputes by brute force.

import {
  SEC_PER_DAY,
  US_PER_DAY,
  dateKeyFromDay,
  dayFromDateKey,
  getTimeline,
  WEEKDAY_NAMES,
  weekdayOfDay,
} from './tz.mjs';
import {
  normalizeIntervalSet,
  unionIntervalSets,
  intersectIntervalSets,
  complementIntervalSet,
  intervalsBounding,
  totalWidthUs,
} from './intervals.mjs';
import {
  ExprError,
  fieldLabel,
  literalLabel,
  parseExpression,
  stringifyExpression,
  validateExpression,
} from './expr.mjs';

const FAR_FUTURE_SEC = 253_402_300_800; // 9999-12-31
const FAR_PAST_SEC = -62_135_596_800; // 0001-01-01

export const AMBIGUITY_POLICIES = ['earlier', 'later', 'both'];

export function compileExpression(text, options) {
  const ast = typeof text === 'string' ? parseExpression(text) : text;
  validateExpression(ast, true);
  return compileAst(ast, options);
}

export function compileAst(ast, options) {
  const {
    zone,
    universe,
    policy = 'earlier',
    mode = 'zoned',
  } = options;
  if (!AMBIGUITY_POLICIES.includes(policy)) throw new ExprError(`Unknown ambiguity policy: ${policy}`);
  if (mode !== 'zoned' && mode !== 'naive') throw new ExprError(`Unknown compile mode: ${mode}`);
  if (!universe || !(universe.hiUs > universe.loUs)) throw new ExprError('Dataset coverage is empty');

  const timeline = mode === 'zoned'
    ? getTimeline(zone, Math.floor(universe.loUs / 1e6) - 3 * SEC_PER_DAY, Math.ceil(universe.hiUs / 1e6) + 3 * SEC_PER_DAY)
    : null;
  const ctx = { zone, timeline, universe, policy, mode };
  const compiled = compileNode(ast, ctx);
  const intervals = intersectIntervalSets(compiled.intervals, [{ loUs: universe.loUs, hiUs: universe.hiUs }]);
  const nodes = flattenNodes(compiled);

  const bounds = intervalsBounding(intervals);
  const partitions = selectPartitions(intervals, universe);
  const localDays = mode === 'zoned'
    ? localDaySpan(intervals, timeline)
    : utcDaySpan(intervals);

  return {
    mode,
    zone: mode === 'zoned' ? zone : 'UTC',
    requestedZone: zone,
    policy,
    universe,
    timeline,
    expression: typeof ast === 'string' ? ast : stringifyExpression(ast),
    ast,
    intervals,
    coverage: {
      intervalCount: intervals.length,
      widthUs: totalWidthUs(intervals),
      widthHours: totalWidthUs(intervals) / 3.6e9,
      bounds,
    },
    partitions,
    partitionStats: summarizePartitions(partitions, universe),
    localDays,
    nodes,
    diagnostics: mode === 'zoned' ? collectDiagnostics(ctx, localDays, partitions) : { transitions: [], unusualDays: [], warnings: [] },
    notes: compiled.notes ?? [],
  };
}

// ---------------------------------------------------------------------------
// Node compilation
// ---------------------------------------------------------------------------

function compileNode(node, ctx) {
  switch (node.type) {
    case 'and': {
      const left = compileNode(node.left, ctx);
      const right = compileNode(node.right, ctx);
      return {
        type: 'and',
        label: 'AND',
        intervals: intersectIntervalSets(left.intervals, right.intervals),
        children: [left, right],
        notes: [],
      };
    }
    case 'or': {
      const left = compileNode(node.left, ctx);
      const right = compileNode(node.right, ctx);
      return {
        type: 'or',
        label: 'OR',
        intervals: unionIntervalSets(left.intervals, right.intervals),
        children: [left, right],
        notes: [],
      };
    }
    case 'not': {
      const operand = compileNode(node.operand, ctx);
      return {
        type: 'not',
        label: 'NOT',
        intervals: complementIntervalSet(operand.intervals, [ctx.universe.loUs, ctx.universe.hiUs]),
        children: [operand],
        notes: ['Complement is taken inside dataset coverage.'],
      };
    }
    case 'compare':
      return compileCompare(node, ctx);
    case 'between': {
      const lower = compileCompare({ type: 'compare', field: node.field, op: '>=', literal: node.lo }, ctx);
      const upper = compileCompare({ type: 'compare', field: node.field, op: '<=', literal: node.hi }, ctx);
      const both = {
        type: 'and',
        label: 'BETWEEN',
        intervals: intersectIntervalSets(lower.intervals, upper.intervals),
        children: [lower, upper],
        notes: [],
      };
      return node.negated ? negate(both, ctx) : both;
    }
    case 'in': {
      const branches = node.values.map((literal, idx) => ({
        ...compileCompare({ type: 'compare', field: node.field, op: '=', literal }, ctx),
        label: `IN item ${idx + 1}`,
      }));
      if (branches.length === 1) return node.negated ? negate(branches[0], ctx) : branches[0];
      const union = {
        type: 'or',
        label: 'IN',
        intervals: normalizeIntervalSet(branches.flatMap((b) => b.intervals)),
        children: branches,
        notes: [],
      };
      return node.negated ? negate(union, ctx) : union;
    }
    default:
      throw new ExprError(`Unknown node type ${node.type}`);
  }
}

function negate(node, ctx) {
  return {
    type: 'not',
    label: 'NOT',
    intervals: complementIntervalSet(node.intervals, [ctx.universe.loUs, ctx.universe.hiUs]),
    children: [node],
    notes: ['Complement is taken inside dataset coverage.'],
  };
}

function compileCompare(node, ctx) {
  const field = node.field.name;
  const label = `${fieldLabel(node.field)} ${node.op} ${literalLabel(node.literal)}`;
  let result;
  if (field === 'local_date') {
    result = localDateCompare(node.op, node.literal, ctx);
  } else if (field === 'local_ts') {
    result = localWallCompare(node.op, node.literal, ctx);
  } else if (field === 'ts') {
    result = utcInstantCompare(node.op, node.literal, ctx);
  } else {
    throw new ExprError(`Unknown field ${field}`);
  }
  return {
    type: 'compare',
    label,
    field,
    op: node.op,
    literal: node.literal,
    intervals: intersectIntervalSets(result.intervals, [{ loUs: ctx.universe.loUs, hiUs: ctx.universe.hiUs }]),
    children: [],
    notes: result.notes,
    details: result.details ?? null,
  };
}

// ---------------------------------------------------------------------------
// Field transforms
// ---------------------------------------------------------------------------

/**
 * Iterate constant-offset segments of the timeline across dataset coverage.
 * Each segment is a UTC range where local date and local wall clock are both
 * affine functions of the instant, so every comparison has a closed form.
 */
function eachSegment(ctx, fn) {
  if (ctx.mode === 'naive') {
    // Naive mode: local time is defined as UTC. One segment, offset 0.
    const piece = fn({ aUs: ctx.universe.loUs, bUs: ctx.universe.hiUs, offSec: 0 });
    return piece ? [piece] : [];
  }
  const { timeline, universe } = ctx;
  const transitions = timeline.transitionsBetween(universe.loUs, universe.hiUs);
  const out = [];
  let aUs = universe.loUs;
  for (const tr of transitions) {
    const atUs = tr.atSec * 1_000_000;
    if (atUs > aUs) {
      const piece = fn({ aUs, bUs: atUs, offSec: tr.fromOffset });
      if (piece) out.push(piece);
    }
    aUs = Math.max(aUs, atUs);
  }
  if (aUs < universe.hiUs) {
    const offSec = ctx.timeline.offsetAt(Math.floor(universe.hiUs / 1_000_000) - 1);
    const piece = fn({ aUs, bUs: universe.hiUs, offSec });
    if (piece) out.push(piece);
  }
  return out;
}

function localDateCompare(op, literal, ctx) {
  const day = dayFromDateKey(literal.text);
  const notes = [];
  if (ctx.mode === 'zoned') {
    const anatomy = ctx.timeline.dayAnatomy(day);
    if (anatomy.lengthSec !== SEC_PER_DAY) {
      notes.push(`Local day ${literal.text} is ${formatHours(anatomy.lengthSec)} in ${ctx.zone}.`);
    }
    if (anatomy.midnightStatus === 'skipped') {
      notes.push(`Local midnight at the start of ${literal.text} does not exist; the day starts at ${anatomy.startLocal}.`);
    } else if (anatomy.midnightStatus === 'repeated') {
      notes.push(`Local midnight at the start of ${literal.text} occurs twice; the day starts at the earlier occurrence (${anatomy.startLocal}).`);
    }
  }
  if (op === '!=') {
    const eq = localDateCompare('=', literal, ctx);
    return {
      intervals: complementIntervalSet(eq.intervals, [ctx.universe.loUs, ctx.universe.hiUs]),
      notes: [...notes, "not-equal is the complement of equality within dataset coverage."],
      details: { day },
    };
  }
  const dayKey = dateKeyFromDay(day);
  const pieces = eachSegment(ctx, ({ aUs, bUs, offSec }) => {
    // Local day at instant u is floor((u + off*1e6) / US_PER_DAY).
    const offUs = offSec * 1_000_000;
    const firstDay = Math.floor((aUs + offUs) / US_PER_DAY);
    const lastDay = Math.floor((bUs - 1 + offUs) / US_PER_DAY);
    const clamp = (us) => Math.min(bUs, Math.max(aUs, us));
    const edge = (d) => clamp(d * US_PER_DAY - offUs);
    let lo = aUs;
    let hi = bUs;
    switch (op) {
      case '=':
        lo = edge(day);
        hi = edge(day + 1);
        if (firstDay > day || lastDay < day) return null;
        break;
      case '>=':
        if (lastDay < day) return null;
        lo = edge(day);
        break;
      case '>':
        if (lastDay < day + 1) return null;
        lo = edge(day + 1);
        break;
      case '<':
        if (firstDay >= day) return null;
        hi = edge(day);
        break;
      case '<=':
        if (firstDay > day) return null;
        hi = edge(day + 1);
        break;
      default:
        throw new ExprError(`Unsupported operator ${op}`);
    }
    if (hi <= lo) return null;
    return { loUs: lo, hiUs: hi };
  });
  const intervals = normalizeIntervalSet(pieces);
  return {
    intervals,
    notes,
    details: {
      day,
      dayKey,
      weekday: WEEKDAY_NAMES[weekdayOfDay(day)],
      dayStartUs: ctx.mode === 'zoned' ? ctx.timeline.dayStartUs(day) : day * US_PER_DAY,
      dayEndUs: ctx.mode === 'zoned' ? ctx.timeline.dayEndUs(day) : (day + 1) * US_PER_DAY,
      dayLengthSec: ctx.mode === 'zoned' ? ctx.timeline.dayLengthSec(day) : SEC_PER_DAY,
    },
  };
}

function localWallCompare(op, literal, ctx) {
  const day = dayFromDateKey(literal.text.slice(0, 10));
  const wallAbsUs = day * US_PER_DAY
    + literal.hour * 3_600_000_000
    + literal.minute * 60_000_000
    + literal.second * 1_000_000;
  const notes = [];
  const anatomy = ctx.mode === 'zoned' ? ctx.timeline.dayAnatomy(day) : null;
  if (anatomy) {
    const inGap = anatomy.transitions.some((tr) => tr.gap
      && wallAbsUs >= (tr.atUs + tr.fromOffset * 1e6)
      && wallAbsUs < (tr.atUs + tr.toOffset * 1e6));
    const inFold = anatomy.transitions.some((tr) => tr.fold
      && wallAbsUs >= tr.atUs + tr.toOffset * 1e6
      && wallAbsUs < tr.atUs + tr.fromOffset * 1e6);
    if (inGap) notes.push(`Wall time ${literal.text} does not exist in ${ctx.zone} (spring-forward gap).`);
    if (inFold) notes.push(`Wall time ${literal.text} occurs twice in ${ctx.zone} (fall-back repeated hour); both instants satisfy the predicate.`);
  }
  if (op === '!=') {
    const eq = localWallCompare('=', literal, ctx);
    return {
      intervals: complementIntervalSet(eq.intervals, [ctx.universe.loUs, ctx.universe.hiUs]),
      notes: [...notes, "not-equal is the complement of equality within dataset coverage."],
    };
  }
  const pieces = eachSegment(ctx, ({ aUs, bUs, offSec }) => {
    const offUs = offSec * 1_000_000;
    const clamp = (us) => Math.min(bUs, Math.max(aUs, us));
    switch (op) {
      case '=': {
        // local_ts has one-second resolution: every instant inside the named
        // local second matches, including its microseconds.
        const at = wallAbsUs - offUs;
        if (at < aUs || at >= bUs) return null;
        return { loUs: at, hiUs: Math.min(at + 1_000_000, bUs) };
      }
      case '>=': {
        const lo = clamp(wallAbsUs - offUs);
        if (lo >= bUs) return null;
        return { loUs: lo, hiUs: bUs };
      }
      case '>': {
        const lo = clamp(wallAbsUs + 1_000_000 - offUs);
        if (lo >= bUs) return null;
        return { loUs: lo, hiUs: bUs };
      }
      case '<=': {
        const hi = clamp(wallAbsUs + 1_000_000 - offUs);
        if (hi <= aUs) return null;
        return { loUs: aUs, hiUs: hi };
      }
      case '<': {
        const hi = clamp(wallAbsUs - offUs);
        if (hi <= aUs) return null;
        return { loUs: aUs, hiUs: hi };
      }
      default:
        throw new ExprError(`Unsupported operator ${op}`);
    }
  });
  return { intervals: normalizeIntervalSet(pieces), notes };
}

function utcInstantCompare(op, literal, ctx) {
  const notes = [];
  let values;
  if (literal.type === 'instant') {
    const day = dayFromDateKey(literal.text.slice(0, 10));
    const v = day * US_PER_DAY
      + literal.hour * 3_600_000_000
      + literal.minute * 60_000_000
      + literal.second * 1_000_000
      + literal.fracUs
      - literal.offsetSec * 1_000_000;
    values = [v];
    notes.push(`TS literal resolves to ${formatUsAsIso(v)}.`);
  } else {
    const resolved = resolveAtLiteral(literal, ctx);
    values = resolved.instantsUs;
    notes.push(...resolved.notes);
  }
  if (op === '!=') {
    const eq = utcInstantCompare('=', literal, ctx);
    return {
      intervals: complementIntervalSet(eq.intervals, [ctx.universe.loUs, ctx.universe.hiUs]),
      notes: [...notes, "not-equal is the complement of equality within dataset coverage."],
    };
  }
  if (values.length === 0) {
    // AT literal landing in a gap: no instant has that wall time; comparisons
    // split exactly at the transition, equality is empty.
    if (literal.type === 'at') {
      if (op === '=') return { intervals: [], notes: [...notes, 'No instant matches this wall time.'] };
      const split = gapSplitUs(literal, ctx);
      if (split == null) return { intervals: [], notes: [...notes, 'No instant matches this wall time.'] };
      return { intervals: boundInterval(op, split), notes };
    }
    return { intervals: [], notes };
  }
  if (op === '=') {
    const intervals = values.map((v) => ({ loUs: v, hiUs: v + 1 }));
    return { intervals: normalizeIntervalSet(intervals), notes };
  }
  const lowerOp = op === '>=' || op === '>';
  const anchor = lowerOp ? Math.min(...values) : Math.max(...values);
  return { intervals: boundInterval(op, anchor), notes };
}

function boundInterval(op, anchorUs) {
  switch (op) {
    case '>=': return [{ loUs: anchorUs, hiUs: Number.MAX_SAFE_INTEGER }];
    case '>': return [{ loUs: anchorUs + 1, hiUs: Number.MAX_SAFE_INTEGER }];
    case '<=': return [{ loUs: Number.MIN_SAFE_INTEGER, hiUs: anchorUs + 1 }];
    case '<': return [{ loUs: Number.MIN_SAFE_INTEGER, hiUs: anchorUs }];
    default: throw new ExprError(`Unsupported operator ${op}`);
  }
}

function resolveAtLiteral(literal, ctx) {
  if (ctx.mode === 'naive') {
    const day = dayFromDateKey(literal.text.slice(0, 10));
    const v = day * US_PER_DAY + literal.hour * 3_600_000_000 + literal.minute * 60_000_000 + literal.second * 1_000_000;
    return { instantsUs: [v], kind: 'normal', notes: ['Naive mode treats AT as UTC.'] };
  }
  const day = dayFromDateKey(literal.text.slice(0, 10));
  const timeOfDay = literal.hour * 3600 + literal.minute * 60 + literal.second;
  const occurrences = ctx.timeline.resolveLocalTime(day, timeOfDay).map((s) => s * 1_000_000);
  if (occurrences.length === 1) {
    return {
      instantsUs: occurrences,
      kind: 'normal',
      notes: [`AT ${literal.text} resolves once to ${formatUsAsIso(occurrences[0])} (${ctx.zone}).`],
    };
  }
  if (occurrences.length === 0) {
    return {
      instantsUs: [],
      kind: 'skipped',
      notes: [`AT ${literal.text} falls in a spring-forward gap in ${ctx.zone}; it matches no instant.`],
    };
  }
  if (ctx.policy === 'earlier') {
    return {
      instantsUs: [occurrences[0]],
      kind: 'repeated',
      notes: [`AT ${literal.text} is repeated; policy "earlier" picks ${formatUsAsIso(occurrences[0])}.`],
    };
  }
  if (ctx.policy === 'later') {
    return {
      instantsUs: [occurrences[occurrences.length - 1]],
      kind: 'repeated',
      notes: [`AT ${literal.text} is repeated; policy "later" picks ${formatUsAsIso(occurrences[occurrences.length - 1])}.`],
    };
  }
  return {
    instantsUs: occurrences,
    kind: 'repeated',
    notes: [`AT ${literal.text} is repeated; policy "both" keeps all ${occurrences.length} instants.`],
  };
}

function gapSplitUs(literal, ctx) {
  const day = dayFromDateKey(literal.text.slice(0, 10));
  const wallAbsSec = day * SEC_PER_DAY + literal.hour * 3600 + literal.minute * 60 + literal.second;
  const anatomy = ctx.timeline.dayAnatomy(day);
  for (const tr of anatomy.transitions) {
    if (!tr.gap) continue;
    if (wallAbsSec >= (tr.atUs + tr.fromOffset * 1e6) / 1e6 && wallAbsSec < (tr.atUs + tr.toOffset * 1e6) / 1e6) {
      return tr.atUs;
    }
  }
  return null;
}

function formatUsAsIso(us) {
  const totalSec = Math.floor(us / 1e6);
  const day = Math.floor(totalSec / SEC_PER_DAY);
  const sod = totalSec - day * SEC_PER_DAY;
  const key = dateKeyFromDay(day);
  return `${key}T${String(Math.floor(sod / 3600)).padStart(2, '0')}:${String(Math.floor((sod % 3600) / 60)).padStart(2, '0')}:${String(sod % 60).padStart(2, '0')}${us % 1e6 ? '.' + String(us % 1e6).padStart(6, '0') : ''}Z`;
}

// ---------------------------------------------------------------------------
// Partition selection
// ---------------------------------------------------------------------------

export function utcDayIndexForUs(us) {
  return Math.floor(us / US_PER_DAY);
}

export function partitionKeyForUs(us) {
  return dateKeyFromDay(utcDayIndexForUs(us));
}

export function selectPartitions(intervals, universe) {
  if (intervals.length === 0) return [];
  const firstDay = utcDayIndexForUs(Math.max(intervals[0].loUs, universe.loUs));
  const lastDay = utcDayIndexForUs(Math.min(intervals[intervals.length - 1].hiUs - 1, universe.hiUs - 1));
  const out = [];
  for (let day = firstDay; day <= lastDay; day += 1) {
    const dayLo = day * US_PER_DAY;
    const dayHi = dayLo + US_PER_DAY;
    const overlapUs = intervals.reduce((sum, iv) => {
      const lo = Math.max(iv.loUs, dayLo);
      const hi = Math.min(iv.hiUs, dayHi);
      return sum + Math.max(0, hi - lo);
    }, 0);
    if (overlapUs <= 0) continue;
    const clipped = [];
    for (const iv of intervals) {
      const lo = Math.max(iv.loUs, dayLo);
      const hi = Math.min(iv.hiUs, dayHi);
      if (hi > lo) clipped.push({ loUs: lo, hiUs: hi, reason: iv.reason ?? null });
    }
    out.push({
      dayIndex: day,
      dayKey: dateKeyFromDay(day),
      loUs: dayLo,
      hiUs: dayHi,
      overlapUs,
      coverageRatio: overlapUs / US_PER_DAY,
      fullDay: overlapUs === US_PER_DAY,
      intervals: clipped,
    });
  }
  return out;
}

export function summarizePartitions(partitions, universe) {
  const totalDays = Math.floor((universe.hiUs - 1) / US_PER_DAY) - Math.floor(universe.loUs / US_PER_DAY) + 1;
  const selected = partitions.length;
  return {
    totalPartitions: totalDays,
    selectedPartitions: selected,
    prunedPartitions: Math.max(0, totalDays - selected),
    prunedRatio: totalDays === 0 ? 0 : Math.max(0, totalDays - selected) / totalDays,
    fullPartitions: partitions.filter((p) => p.fullDay).length,
    partialPartitions: partitions.filter((p) => !p.fullDay).length,
  };
}

function localDaySpan(intervals, timeline) {
  if (intervals.length === 0) return null;
  let minDay = Infinity;
  let maxDay = -Infinity;
  for (const iv of intervals) {
    for (const us of [iv.loUs, iv.hiUs - 1]) {
      const day = timeline.localDayAtUs(us);
      minDay = Math.min(minDay, day);
      maxDay = Math.max(maxDay, day);
    }
  }
  return {
    minDay,
    maxDay,
    minKey: dateKeyFromDay(minDay),
    maxKey: dateKeyFromDay(maxDay),
    count: maxDay - minDay + 1,
  };
}

function utcDaySpan(intervals) {
  if (intervals.length === 0) return null;
  const minDay = utcDayIndexForUs(intervals[0].loUs);
  const maxDay = utcDayIndexForUs(intervals[intervals.length - 1].hiUs - 1);
  return { minDay, maxDay, minKey: dateKeyFromDay(minDay), maxKey: dateKeyFromDay(maxDay), count: maxDay - minDay + 1 };
}

// ---------------------------------------------------------------------------
// Diagnostics & explanation flattening
// ---------------------------------------------------------------------------

function collectDiagnostics(ctx, localDays, partitions) {
  if (!localDays) {
    return {
      transitions: [],
      unusualDays: [],
      warnings: [],
      zoneTransitionsInCoverage: [],
    };
  }
  const { timeline } = ctx;
  const fromUs = partitions.length ? partitions[0].loUs : ctx.universe.loUs;
  const toUs = partitions.length ? partitions[partitions.length - 1].hiUs : ctx.universe.hiUs;
  const inCoverage = timeline.transitionsBetween(fromUs, toUs).map((tr) => timeline.describeTransition(tr));
  const unusualDays = [];
  // Only inspect days actually touched by the result set, plus one day either
  // side (a partial first/last partition can still explain a boundary).
  for (let d = localDays.minDay - 1; d <= localDays.maxDay + 1; d += 1) {
    const a = timeline.dayAnatomy(d);
    if (a.lengthSec !== SEC_PER_DAY || a.midnightStatus !== 'normal' || a.transitions.length > 0) {
      unusualDays.push({
        dayKey: a.dayKey,
        lengthHours: a.lengthHours,
        midnightStatus: a.midnightStatus,
        startLocal: a.startLocal,
        endLocal: a.endLocal,
        transitions: a.transitions.map((tr) => ({
          atUs: tr.atUs,
          kind: tr.kind,
          deltaSec: tr.deltaSec,
          localBefore: tr.localBefore,
          localAfter: tr.localAfter,
          affectsMidnight: tr.affectsMidnight,
        })),
      });
    }
  }
  const warnings = [];
  const regressions = timeline.foldRegressions();
  if (regressions.length) {
    warnings.push(`${timeline.zone} has a local-date regression in this range; interval algebra handled it segment by segment.`);
  }
  if (inCoverage.length) {
    warnings.push(`${inCoverage.length} UTC offset transition(s) fall inside the scanned partitions; rows are still filtered by exact local time.`);
  }
  return {
    transitions: inCoverage,
    unusualDays,
    warnings,
    zoneTransitionsInCoverage: inCoverage,
  };
}

function flattenNodes(root) {
  const out = [];
  const walk = (node, depth) => {
    const entry = {
      id: out.length,
      depth,
      type: node.type,
      label: node.label,
      field: node.field ?? null,
      op: node.op ?? null,
      literal: node.literal ? literalLabel(node.literal) : null,
      intervalCount: node.intervals.length,
      widthHours: totalWidthUs(node.intervals) / 3.6e9,
      intervals: node.intervals.slice(0, 8),
      intervalsTruncated: Math.max(0, node.intervals.length - 8),
      notes: node.notes ?? [],
      details: node.details ?? null,
      childIds: [],
    };
    out.push(entry);
    for (const child of node.children ?? []) {
      entry.childIds.push(out.length);
      walk(child, depth + 1);
    }
    return entry;
  };
  walk(root, 0);
  return out;
}

export function formatHours(sec) {
  const h = sec / 3600;
  return Number.isInteger(h) ? `${h}h` : `${h.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}h`;
}

