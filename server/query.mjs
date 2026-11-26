// Query execution and verification.
//
// Three independent ways to answer "which rows match":
//   pruned   - open only the partitions the compiler selected, then re-evaluate
//              the predicate per row (the production path);
//   fullscan - open every partition, evaluate exactly the same predicate (the
//              correctness oracle for pruning);
//   rollup   - sum manifest aggregates, opening zero row pages, when the
//              selection is whole-day aligned.
//
// The predicate is ALWAYS re-evaluated per row: pruning is a physical
// optimisation, never the source of truth. That is what makes the cross-checks
// meaningful rather than circular.

import { openDb, readManifest, datasetCoverage } from './db.mjs';
import { compileExpression } from './compiler.mjs';
import { US_PER_DAY, dayFromDateKey } from './tz.mjs';
import { intervalsContainUs, totalWidthUs } from './intervals.mjs';
import { parseExpression, stringifyExpression, validateExpression } from './expr.mjs';

// ---------------------------------------------------------------------------
// Per-row predicate evaluation
// ---------------------------------------------------------------------------

/**
 * Build a fast (tsUs) => boolean evaluator for a compiled query.
 * All literals are resolved once; local-time conversion is integer arithmetic
 * over the compiled offset timeline (no Intl calls per row).
 */
export function makeRowEvaluator(compiled) {
  const resolved = new Map();
  const timeline = compiled.mode === 'zoned' ? compiled.timeline : null;

  const localDay = (tsUs) => {
    if (!timeline) return Math.floor(tsUs / US_PER_DAY);
    return timeline.localDayAtSec(Math.floor(tsUs / 1_000_000));
  };
  const localWallSec = (tsUs) => {
    if (!timeline) return Math.floor(tsUs / 1_000_000);
    const sec = Math.floor(tsUs / 1_000_000);
    return sec + timeline.offsetAt(sec);
  };

  const resolveLiteral = (field, lit) => {
    const key = `${field}|${lit.type}|${lit.text}`;
    let bound = resolved.get(key);
    if (bound) return bound;
    const day = dayFromDateKey(lit.text.slice(0, 10));
    if (field === 'local_date') {
      bound = { kind: 'date', day };
    } else if (field === 'local_ts') {
      bound = { kind: 'wall', wallSec: day * 86400 + lit.hour * 3600 + lit.minute * 60 + lit.second };
    } else if (lit.type === 'instant') {
      const us = day * US_PER_DAY + lit.hour * 3_600_000_000 + lit.minute * 60_000_000
        + lit.second * 1_000_000 + (lit.fracUs ?? 0) - lit.offsetSec * 1_000_000;
      bound = { kind: 'instant', us };
    } else if (lit.type === 'at') {
      const occurrences = resolveAtLiteral(lit, compiled, timeline);
      bound = {
        kind: 'at',
        occurrences,
        set: new Set(occurrences),
        min: occurrences.length ? occurrences[0] : null,
        max: occurrences.length ? occurrences[occurrences.length - 1] : null,
        gapSplitUs: occurrences.length === 0 && timeline ? gapSplit(lit, timeline) : null,
      };
    } else {
      throw new Error(`Literal ${lit.type} cannot be compared with field ${field}`);
    }
    resolved.set(key, bound);
    return bound;
  };

  const compare = (a, op, b) => {
    switch (op) {
      case '=': return a === b;
      case '!=': return a !== b;
      case '<': return a < b;
      case '<=': return a <= b;
      case '>': return a > b;
      case '>=': return a >= b;
      default: throw new Error(`Unknown operator ${op}`);
    }
  };

  const evalComparison = (field, op, lit, tsUs) => {
    const bound = resolveLiteral(field, lit);
    if (bound.kind === 'date') return compare(localDay(tsUs), op, bound.day);
    if (bound.kind === 'wall') return compare(localWallSec(tsUs), op, bound.wallSec);
    if (bound.kind === 'instant') return compare(tsUs, op, bound.us);
    // AT literal
    if (op === '=') return bound.set.has(tsUs);
    if (op === '!=') return !bound.set.has(tsUs);
    if (bound.occurrences.length === 0) {
      if (bound.gapSplitUs == null) return false;
      return compare(tsUs, op, bound.gapSplitUs);
    }
    const anchor = op === '>=' || op === '>' ? bound.min : bound.max;
    return compare(tsUs, op, anchor);
  };

  const evalNode = (node, tsUs) => {
    switch (node.type) {
      case 'and': return evalNode(node.left, tsUs) && evalNode(node.right, tsUs);
      case 'or': return evalNode(node.left, tsUs) || evalNode(node.right, tsUs);
      case 'not': return !evalNode(node.operand, tsUs);
      case 'compare': return evalComparison(node.field.name, node.op, node.literal, tsUs);
      case 'between': {
        const inside = evalComparison(node.field.name, '>=', node.lo, tsUs)
          && evalComparison(node.field.name, '<=', node.hi, tsUs);
        return node.negated ? !inside : inside;
      }
      case 'in': {
        const hit = node.values.some((lit) => evalComparison(node.field.name, '=', lit, tsUs));
        return node.negated ? !hit : hit;
      }
      default: throw new Error(`Unknown node type ${node.type}`);
    }
  };

  return (tsUs) => evalNode(compiled.ast, tsUs);
}

function resolveAtLiteral(lit, compiled, timeline) {
  const day = dayFromDateKey(lit.text.slice(0, 10));
  const timeOfDay = lit.hour * 3600 + lit.minute * 60 + lit.second;
  if (!timeline) {
    return [day * US_PER_DAY + timeOfDay * 1_000_000];
  }
  const occurrences = timeline.resolveLocalTime(day, timeOfDay).map((sec) => sec * 1_000_000);
  if (occurrences.length <= 1) return occurrences;
  if (compiled.policy === 'earlier') return [occurrences[0]];
  if (compiled.policy === 'later') return [occurrences[occurrences.length - 1]];
  return occurrences;
}

function gapSplit(lit, timeline) {
  const day = dayFromDateKey(lit.text.slice(0, 10));
  const wallSec = day * 86400 + lit.hour * 3600 + lit.minute * 60 + lit.second;
  for (const tr of timeline.dayAnatomy(day).transitions) {
    if (!tr.gap) continue;
    const gapFrom = (tr.atUs + tr.fromOffset * 1e6) / 1e6;
    const gapTo = (tr.atUs + tr.toOffset * 1e6) / 1e6;
    if (wallSec >= gapFrom && wallSec < gapTo) return tr.atUs;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Query preparation
// ---------------------------------------------------------------------------

export function prepareQuery({ expression, zone, policy = 'earlier', mode = 'zoned' }) {
  const db = openDb({ readOnly: true });
  const manifest = readManifest(db);
  const coverage = datasetCoverage(manifest);
  if (!coverage) throw new Error('Dataset is empty');
  const ast = typeof expression === 'string' ? parseExpression(expression) : expression;
  validateExpression(ast, true);
  const started = performance.now();
  const compiled = compileExpression(ast, {
    zone: mode === 'naive' ? 'UTC' : zone,
    universe: { loUs: coverage.loUs, hiUs: coverage.hiUs },
    policy,
    mode,
  });
  const compileMs = performance.now() - started;
  return {
    db,
    manifest,
    coverage,
    ast,
    compiled,
    compileMs,
    zone: mode === 'naive' ? 'UTC' : zone,
    policy,
    mode,
    expression: stringifyExpression(ast),
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export function runQuery(query, { limit = 200, offset = 0, withFullScan = true } = {}) {
  const evaluator = makeRowEvaluator(query.compiled);
  const selected = new Set(query.compiled.partitions.map((p) => p.dayKey));

  const prunedStart = performance.now();
  const pruned = scanPartitions(query, evaluator, { dayKeys: selected, limit, offset, trackPartitions: true });
  const prunedMs = performance.now() - prunedStart;

  let fullscan = null;
  if (withFullScan) {
    const fullStart = performance.now();
    fullscan = scanPartitions(query, evaluator, { dayKeys: null, limit: 0, offset: 0, trackPartitions: false });
    fullscan.ms = performance.now() - fullStart;
  }

  const rollupBuckets = rollupFromBuckets(query.db, query.compiled.intervals);
  const rollupPartitions = rollupFromPartitions(query.manifest, query.compiled.partitions);

  const perPartition = query.compiled.partitions.map((p) => {
    const stats = pruned.partitionStats.get(p.dayKey);
    return {
      dayKey: p.dayKey,
      fullDay: p.fullDay,
      coverageRatio: p.coverageRatio,
      overlapUs: p.overlapUs,
      rowsScanned: stats?.rowsScanned ?? 0,
      rowsMatched: stats?.rowsMatched ?? 0,
      sumBytes: stats?.sumBytes ?? 0,
      errorCount: stats?.errorCount ?? 0,
    };
  });

  return {
    query: publicQuery(query),
    rows: pruned.rows,
    hiddenRows: pruned.matched - pruned.rows.length,
    stats: {
      matched: pruned.matched,
      sumBytes: pruned.sumBytes,
      sumLatencyMs: pruned.sumLatencyMs,
      errorCount: pruned.errorCount,
      scannedRows: pruned.scannedRows,
      scannedPartitions: pruned.scannedPartitions,
      selectedPartitions: query.compiled.partitions.length,
      totalPartitions: query.manifest.length,
      compileMs: query.compileMs,
      evalMs: prunedMs,
      fullScan: fullscan && {
        matched: fullscan.matched,
        scannedRows: fullscan.scannedRows,
        scannedPartitions: fullscan.scannedPartitions,
        ms: fullscan.ms,
      },
      speedup: fullscan && prunedMs > 0 ? fullscan.ms / prunedMs : null,
    },
    aggregates: {
      rollup: rollupBuckets.exact ? rollupBuckets : rollupPartitions,
      bucketRollup: rollupBuckets,
      partitionRollup: rollupPartitions,
      rowScan: fullscan && {
        count: fullscan.matched,
        sumBytes: fullscan.sumBytes,
        sumLatencyMs: fullscan.sumLatencyMs,
        errorCount: fullscan.errorCount,
      },
    },
    partitions: perPartition,
  };
}

function scanPartitions(query, evaluator, { dayKeys, limit, offset, trackPartitions }) {
  const { db, manifest } = query;
  let scannedRows = 0;
  let matched = 0;
  let sumBytes = 0;
  let sumLatencyMs = 0;
  let errorCount = 0;
  let scannedPartitions = 0;
  const rows = [];
  const partitionStats = new Map();

  for (const part of manifest) {
    if (dayKeys && !dayKeys.has(part.dayKey)) continue;
    scannedPartitions += 1;
    let rowsScanned = 0;
    let rowsMatched = 0;
    let partBytes = 0;
    let partErrors = 0;
    const stmt = db.prepare(
      `SELECT id, ts_us, service, level, latency_ms, bytes, msg FROM ${part.table} ORDER BY ts_us`,
    );
    for (const row of stmt.iterate()) {
      rowsScanned += 1;
      scannedRows += 1;
      if (!evaluator(row.ts_us)) continue;
      matched += 1;
      rowsMatched += 1;
      sumBytes += row.bytes;
      sumLatencyMs += row.latency_ms;
      partBytes += row.bytes;
      if (row.level === 'error') {
        errorCount += 1;
        partErrors += 1;
      }
      if (rows.length < offset + limit) rows.push(serializeRow(row, part.dayKey, query));
    }
    if (trackPartitions) {
      partitionStats.set(part.dayKey, {
        rowsScanned,
        rowsMatched,
        sumBytes: partBytes,
        errorCount: partErrors,
      });
    }
  }
  return {
    rows: rows.slice(offset, offset + limit),
    matched,
    scannedRows,
    scannedPartitions,
    sumBytes,
    sumLatencyMs,
    errorCount,
    partitionStats,
  };
}

function serializeRow(row, dayKey, query) {
  const timeline = query.compiled.mode === 'zoned' ? query.compiled.timeline : null;
  const local = timeline ? timeline.localLabelAtUs(row.ts_us) : null;
  return {
    id: row.id,
    tsUs: row.ts_us,
    utc: isoFromUs(row.ts_us),
    partition: dayKey,
    local,
    localDate: timeline ? local.slice(0, 10) : isoFromUs(row.ts_us).slice(0, 10),
    service: row.service,
    level: row.level,
    latencyMs: row.latency_ms,
    bytes: row.bytes,
    msg: row.msg,
  };
}

export function isoFromUs(us) {
  const totalSec = Math.floor(us / 1_000_000);
  const day = Math.floor(totalSec / 86400);
  const sod = totalSec - day * 86400;
  const frac = us - totalSec * 1_000_000;
  const { year, month, day: d } = civil(day);
  return `${year}-${p2(month)}-${p2(d)}T${p2(Math.floor(sod / 3600))}:${p2(Math.floor((sod % 3600) / 60))}:${p2(sod % 60)}`
    + (frac ? `.${String(frac).padStart(6, '0')}` : '') + 'Z';
}

function p2(n) { return String(n).padStart(2, '0'); }

function civil(z) {
  let x = z + 719468;
  const era = Math.floor(x / 146097);
  const doe = x - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: y + (month <= 2 ? 1 : 0), month, day };
}

const BUCKET_US = 60_000_000;

/**
 * Aggregate from pre-computed minute buckets.
 *
 * Exact only when every interval boundary falls on a minute boundary; a bucket
 * that straddles a boundary cannot be attributed without reading rows, so the
 * method declines rather than approximate.
 */
export function rollupFromBuckets(db, intervals) {
  if (intervals.length === 0) {
    return { method: 'buckets', exact: true, count: 0, sumBytes: 0, sumLatencyMs: 0, errorCount: 0, buckets: 0, aligned: true };
  }
  const misaligned = intervals.filter((iv) => iv.loUs % BUCKET_US !== 0 || iv.hiUs % BUCKET_US !== 0);
  if (misaligned.length > 0) {
    return {
      method: 'buckets',
      exact: false,
      aligned: false,
      reason: `interval boundary not minute-aligned (${misaligned.length} of ${intervals.length}); buckets cannot answer exactly`,
      count: null,
      sumBytes: null,
      sumLatencyMs: null,
      errorCount: null,
      buckets: null,
    };
  }
  let count = 0;
  let sumBytes = 0;
  let sumLatencyMs = 0;
  let errorCount = 0;
  let buckets = 0;
  const stmt = db.prepare(
    'SELECT row_count, sum_bytes, sum_latency_ms, error_count FROM buckets WHERE bucket_lo_us >= ? AND bucket_lo_us < ?',
  );
  for (const iv of intervals) {
    for (const b of stmt.iterate(iv.loUs, iv.hiUs)) {
      count += b.row_count;
      sumBytes += b.sum_bytes;
      sumLatencyMs += b.sum_latency_ms;
      errorCount += b.error_count;
      buckets += 1;
    }
  }
  return { method: 'buckets', exact: true, aligned: true, count, sumBytes, sumLatencyMs, errorCount, buckets };
}

export function rollupFromPartitions(manifest, partitions) {
  if (partitions.length === 0) {
    return { method: 'partitions', exact: true, count: 0, sumBytes: 0, sumLatencyMs: 0, errorCount: 0, partitions: 0 };
  }
  if (!partitions.every((p) => p.fullDay)) {
    return {
      method: 'partitions',
      exact: false,
      reason: 'selection is not whole-partition aligned; manifest totals cover whole UTC days only',
      count: null,
      sumBytes: null,
      sumLatencyMs: null,
      errorCount: null,
      partitions: partitions.length,
    };
  }
  const byKey = new Map(manifest.map((m) => [m.dayKey, m]));
  let count = 0;
  let sumBytes = 0;
  let sumLatencyMs = 0;
  let errorCount = 0;
  for (const p of partitions) {
    const m = byKey.get(p.dayKey);
    count += m.rowCount;
    sumBytes += m.sumBytes;
    sumLatencyMs += m.sumLatencyMs;
    errorCount += m.errorCount;
  }
  return { method: 'partitions', exact: true, count, sumBytes, sumLatencyMs, errorCount, partitions: partitions.length };
}

// ---------------------------------------------------------------------------
// Public payload
// ---------------------------------------------------------------------------

export function publicQuery(query) {
  const { compiled } = query;
  const timeline = compiled.mode === 'zoned' ? compiled.timeline : null;
  const label = (us) => (timeline ? timeline.localLabelAtUs(us) : null);
  return {
    expression: query.expression,
    zone: query.zone,
    policy: query.policy,
    mode: query.mode,
    coverage: query.coverage,
    compiled: {
      intervals: compiled.intervals.map((iv) => ({
        loUs: iv.loUs,
        hiUs: iv.hiUs,
        loLocal: label(iv.loUs),
        hiLocal: label(iv.hiUs - 1),
      })),
      coverage: compiled.coverage,
      partitions: compiled.partitions.map((p) => ({
        dayKey: p.dayKey,
        fullDay: p.fullDay,
        coverageRatio: p.coverageRatio,
        overlapUs: p.overlapUs,
        loLocal: label(p.intervals[0].loUs),
        hiLocal: label(p.intervals[p.intervals.length - 1].hiUs - 1),
      })),
      partitionStats: compiled.partitionStats,
      localDays: compiled.localDays,
      nodes: compiled.nodes,
      diagnostics: compiled.diagnostics,
    },
  };
}

// ---------------------------------------------------------------------------
// Verification: independent recomputation
// ---------------------------------------------------------------------------

export function verifyQuery(query, options = {}) {
  const { sampleLimit = 50 } = options;
  const evaluator = makeRowEvaluator(query.compiled);
  const selected = new Set(query.compiled.partitions.map((p) => p.dayKey));
  const universeLo = query.coverage.loUs;
  const universeHi = query.coverage.hiUs;
  const timeline = query.compiled.mode === 'zoned' ? query.compiled.timeline : null;

  // --- Pass 1: one brute-force sweep. Gathers row-level truth, per-partition
  // match counts and per-partition aggregate sums in a single scan.
  const sweepStart = performance.now();
  let bruteMatched = 0;
  let bruteBytes = 0;
  let bruteLatency = 0;
  let bruteErrors = 0;
  const rowsOutsideSelection = [];
  const selectedWithoutRows = [];
  const aggDifferences = [];
  const samples = [];
  let rowsChecked = 0;

  const manifestByKey = new Map(query.manifest.map((m) => [m.dayKey, m]));

  for (const part of query.manifest) {
    const isSelected = selected.has(part.dayKey);
    let matches = 0;
    let sumBytes = 0;
    let sumLatency = 0;
    let errors = 0;
    const stmt = query.db.prepare(`SELECT id, ts_us, service, level, latency_ms, bytes FROM ${part.table} ORDER BY ts_us`);
    for (const row of stmt.iterate()) {
      rowsChecked += 1;
      if (!evaluator(row.ts_us)) continue;
      matches += 1;
      bruteMatched += 1;
      sumBytes += row.bytes;
      sumLatency += row.latency_ms;
      if (row.level === 'error') errors += 1;
      if (!isSelected && rowsOutsideSelection.length < 20) {
        rowsOutsideSelection.push({ dayKey: part.dayKey, id: row.id, tsUs: row.ts_us });
      }
      if (samples.length < sampleLimit) {
        samples.push({
          id: row.id,
          dayKey: part.dayKey,
          tsUs: row.ts_us,
          utc: isoFromUs(row.ts_us),
          local: timeline ? timeline.localLabelAtUs(row.ts_us) : null,
          selected: isSelected,
        });
      }
    }
    bruteBytes += sumBytes;
    bruteLatency += sumLatency;
    bruteErrors += errors;
    if (isSelected && matches === 0) selectedWithoutRows.push(part.dayKey);
    const m = manifestByKey.get(part.dayKey);
    if (isSelected && m) {
      const wholeDay = query.compiled.partitions.find((p) => p.dayKey === part.dayKey)?.fullDay;
      if (wholeDay) {
        if (matches !== m.rowCount || sumBytes !== m.sumBytes || sumLatency !== m.sumLatencyMs || errors !== m.errorCount) {
          if (aggDifferences.length < 10) {
            aggDifferences.push({
              dayKey: part.dayKey,
              rows: { count: matches, sumBytes, sumLatency, errors },
              partition: { count: m.rowCount, sumBytes: m.sumBytes, sumLatency: m.sumLatencyMs, errors: m.errorCount },
            });
          }
        }
      }
    }
  }
  const sweepMs = performance.now() - sweepStart;

  // --- Pass 2: interval semantics probes, with no DB access.
  const probes = new Set([universeLo, universeHi - 1]);
  for (const part of query.manifest) {
    probes.add(part.loUs);
    probes.add(part.loUs + 1);
    probes.add(part.hiUs - 1);
  }
  if (timeline) {
    for (const tr of timeline.transitionsBetween(universeLo, universeHi)) {
      for (const delta of [-1_000_000, -1, 0, 1, 1_000_000]) probes.add(tr.atSec * 1_000_000 + delta);
    }
  }
  for (const p of query.compiled.partitions) {
    for (const iv of p.intervals) {
      for (const delta of [0, 1, -1]) {
        probes.add(iv.loUs + delta);
        probes.add(iv.hiUs - 1 + delta);
      }
    }
  }
  const probeMismatches = [];
  let probesRun = 0;
  for (const us of probes) {
    if (us < universeLo || us >= universeHi) continue;
    probesRun += 1;
    const expected = evaluator(us);
    const actual = intervalsContainUs(query.compiled.intervals, us);
    if (expected !== actual && probeMismatches.length < 12) {
      probeMismatches.push({
        tsUs: us,
        utc: isoFromUs(us),
        local: timeline ? timeline.localLabelAtUs(us) : null,
        predicate: expected,
        intervalSet: actual,
      });
    }
  }

  // --- Pass 3: partition selection soundness and necessity.
  const selectedNoInstant = checkSelectedPartitionsHaveInstant(query, evaluator);
  const bucketRollup = rollupFromBuckets(query.db, query.compiled.intervals);
  const partitionRollup = rollupFromPartitions(query.manifest, query.compiled.partitions);
  const rowAgg = {
    count: bruteMatched,
    sumBytes: bruteBytes,
    sumLatencyMs: bruteLatency,
    errorCount: bruteErrors,
  };
  const agreesWith = (agg) => agg.exact
    && agg.count === rowAgg.count
    && agg.sumBytes === rowAgg.sumBytes
    && agg.sumLatencyMs === rowAgg.sumLatencyMs
    && agg.errorCount === rowAgg.errorCount;
  const bestRollup = bucketRollup.exact ? bucketRollup : partitionRollup;

  return {
    ok: probeMismatches.length === 0
      && rowsOutsideSelection.length === 0
      && aggDifferences.length === 0
      && selectedNoInstant.length === 0,
    rowScan: {
      rowsChecked,
      matched: bruteMatched,
      sumBytes: bruteBytes,
      sumLatencyMs: bruteLatency,
      errorCount: bruteErrors,
      ms: sweepMs,
    },
    intervalSemantics: {
      ok: probeMismatches.length === 0,
      probes: probesRun,
      mismatches: probeMismatches,
      widthHours: totalWidthUs(query.compiled.intervals) / 3.6e9,
    },
    partitionSelection: {
      ok: rowsOutsideSelection.length === 0 && selectedNoInstant.length === 0,
      selectedCount: selected.size,
      totalCount: query.manifest.length,
      rowsOutsideSelection,
      selectedWithoutMatchingRows: selectedWithoutRows,
      selectedWithoutMatchingInstant: selectedNoInstant,
    },
    aggregates: {
      ok: aggDifferences.length === 0,
      differences: aggDifferences,
      bucketRollup,
      partitionRollup,
      best: bestRollup,
      rowScan: rowAgg,
      bucketAgrees: bucketRollup.exact ? agreesWith(bucketRollup) : null,
      partitionAgrees: partitionRollup.exact ? agreesWith(partitionRollup) : null,
    },
    samples,
  };
}

/**
 * Necessity check: each selected partition must contain at least one *instant*
 * satisfying the predicate, not merely share a boundary with a neighbour.
 * Probes the clipped overlap at second granularity for small overlaps and at
 * both endpoints + midpoint for full-day selections.
 */
function checkSelectedPartitionsHaveInstant(query, evaluator) {
  const bad = [];
  for (const p of query.compiled.partitions) {
    let found = false;
    for (const iv of p.intervals) {
      const candidates = [iv.loUs, iv.hiUs - 1, iv.loUs + Math.floor((iv.hiUs - iv.loUs) / 2)];
      if (evaluator(candidates[0]) || evaluator(candidates[1]) || evaluator(candidates[2])) {
        found = true;
        break;
      }
      // Predicate may be satisfied only in a narrow middle band; scan at 1 s.
      if (iv.hiUs - iv.loUs <= 2 * US_PER_DAY) {
        for (let us = iv.loUs; us < iv.hiUs; us += 1_000_000) {
          if (evaluator(us)) { found = true; break; }
        }
      }
      if (found) break;
    }
    if (!found) bad.push(p.dayKey);
  }
  return bad;
}
