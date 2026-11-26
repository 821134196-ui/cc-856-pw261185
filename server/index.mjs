// Local HTTP server: static files + JSON API. No dependencies.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareQuery, runQuery, verifyQuery } from './query.mjs';
import { openDb, readManifest, datasetCoverage, dbFileStats, getManifestRow, DB_PATH } from './db.mjs';
import {
  assertZone, getTimeline, listZones, dateKeyFromDay, dayFromDateKey,
  formatOffset, WEEKDAY_NAMES, weekdayOfDay, US_PER_DAY, SEC_PER_DAY,
} from './tz.mjs';
import { ExprError } from './expr.mjs';
import { compileExpression } from './compiler.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(HERE, '..', 'public');
const PORT = Number(process.env.PORT ?? 5180);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const FEATURED_ZONES = [
  'America/New_York',
  'America/Havana',
  'America/Santiago',
  'Australia/Lord_Howe',
  'Atlantic/Azores',
  'Asia/Beirut',
  'America/Nuuk',
  'Pacific/Chatham',
  'Africa/Cairo',
  'Europe/Berlin',
  'Asia/Shanghai',
  'UTC',
];

const ZONE_NOTES = {
  'America/New_York': '春秋各一次 1 小时跳变；本地日 23h / 25h',
  'America/Havana': '凌晨 0 点跳变，2026-03-08 没有本地午夜；11-01 午夜出现两次',
  'America/Santiago': '南半球；2026-09-06 直接从 23:59:59 跳到 01:00',
  'Australia/Lord_Howe': '30 分钟夏令时；本地日 23.5h / 24.5h',
  'Atlantic/Azores': '午夜跳变，春季 00:00 → 01:00，秋季 01:00 → 00:00',
  'Asia/Beirut': '午夜跳变（2026-03-29 无 00:00）',
  'America/Nuuk': '午夜边界附近跳变，日期变更与偏移变化同时发生',
  'Pacific/Chatham': '+12:45 / +13:45，非整点偏移',
  'Africa/Cairo': '2026-04-24 无本地午夜',
  'Europe/Berlin': '标准欧洲夏令时，02:00 跳变',
  'Asia/Shanghai': '无夏令时，作为对照',
  UTC: '无偏移，作为对照',
};

const EXAMPLES = [
  {
    id: 'single-day',
    title: '单日',
    expression: "local_date(ts) = DATE '2026-03-08'",
    zone: 'America/New_York',
    note: '23 小时的本地日，跨两个 UTC 分区',
  },
  {
    id: 'midnight-gap',
    title: '午夜缺失',
    expression: "local_date(ts) = DATE '2026-03-08'",
    zone: 'America/Havana',
    note: '当日本地不存在 00:00，日首为 01:00',
  },
  {
    id: 'range',
    title: '区间',
    expression: "local_date(ts) >= DATE '2026-03-01' AND local_date(ts) < DATE '2026-04-01'",
    zone: 'America/Santiago',
    note: '左闭右开区间跨一次秋季回拨',
  },
  {
    id: 'fold-hour',
    title: '重复小时',
    expression: "local_ts(ts) BETWEEN WALL '2026-11-01 01:00:00' AND WALL '2026-11-01 01:59:59'",
    zone: 'America/New_York',
    note: '同一本地小时出现两次，两个区间都保留',
  },
  {
    id: 'fold-day',
    title: '重复午夜',
    expression: "local_date(ts) = DATE '2026-11-01'",
    zone: 'America/Havana',
    note: '25 小时本地日，午夜出现两次',
  },
  {
    id: 'half-hour',
    title: '半小时偏移',
    expression: "local_date(ts) = DATE '2026-10-04'",
    zone: 'Australia/Lord_Howe',
    note: '23.5 小时本地日',
  },
  {
    id: 'disjunction',
    title: 'IN 列表',
    expression: "local_date(ts) IN (DATE '2026-03-08', DATE '2026-09-06', DATE '2026-11-01')",
    zone: 'America/Santiago',
    note: '三个不相邻日期，三个独立区间',
  },
  {
    id: 'negation',
    title: '否定',
    expression: "NOT (local_date(ts) BETWEEN DATE '2026-06-01' AND DATE '2026-06-30')",
    zone: 'Europe/Berlin',
    note: '补集在数据集范围内计算，剪枝后仍有 334 个分区',
  },
  {
    id: 'instant',
    title: '瞬时边界',
    expression: "ts >= AT '2026-11-01 01:30:00' AND ts < AT '2026-11-01 02:30:00'",
    zone: 'America/New_York',
    note: 'AT 落在重复小时，按策略解析',
  },
  {
    id: 'utc-baseline',
    title: 'UTC 基线',
    expression: "local_date(ts) = DATE '2026-03-08'",
    zone: 'UTC',
    note: '对照组：无时区影响的裁剪',
  },
];

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req, limit = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON');
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function metaPayload() {
  const db = openDb({ readOnly: true });
  const manifest = readManifest(db);
  const coverage = datasetCoverage(manifest);
  const zones = listZones();
  return {
    app: 'zoned-slice-lab',
    now: new Date().toISOString(),
    runtime: {
      node: process.version,
      icu: process.versions.icu,
      tz: process.versions.tz,
      hostZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      sqlite: db.prepare('SELECT sqlite_version() AS v').get().v,
    },
    dataset: {
      ...coverage,
      path: DB_PATH,
      bytes: dbFileStats().bytes,
      zonesWithTransitions: coverage ? countZonesWithTransitions(coverage) : 0,
    },
    zones: {
      all: zones,
      featured: FEATURED_ZONES.filter((z) => zones.includes(z)),
      notes: ZONE_NOTES,
    },
    examples: EXAMPLES,
    policies: [
      { id: 'earlier', label: 'earlier（较早的一次）' },
      { id: 'later', label: 'later（较晚的一次）' },
      { id: 'both', label: 'both（两次都算）' },
    ],
  };
}

function countZonesWithTransitions(coverage) {
  let count = 0;
  for (const zone of FEATURED_ZONES) {
    try {
      const tl = getTimeline(zone, Math.floor(coverage.loUs / 1e6), Math.ceil(coverage.hiUs / 1e6));
      if (tl.transitions.length > 0) count += 1;
    } catch { /* ignore */ }
  }
  return count;
}

async function handleQuery(body) {
  const {
    expression,
    zone = 'UTC',
    policy = 'earlier',
    mode = 'zoned',
    limit = 200,
    offset = 0,
    withFullScan = true,
    verify = true,
    compareNaive = true,
  } = body;
  if (typeof expression !== 'string' || expression.trim() === '') {
    throw new HttpError(400, 'expression is required');
  }
  if (mode === 'zoned') assertZone(zone);
  const query = prepareQuery({ expression, zone, policy, mode });
  const result = runQuery(query, {
    limit: clampInt(limit, 1, 1000),
    offset: clampInt(offset, 0, 1_000_000),
    withFullScan: Boolean(withFullScan),
  });
  const out = { ...result };
  if (verify) out.verification = verifyQuery(query);
  if (compareNaive && mode === 'zoned') out.naive = compareNaiveTruth(query, result);
  return out;
}

/**
 * Show what a naive implementation (treat the query date as a UTC date) would
 * prune, and which matching rows it would therefore never see.
 */
function compareNaiveTruth(query, result) {
  const naive = compileExpression(query.ast, {
    zone: query.zone,
    universe: { loUs: query.coverage.loUs, hiUs: query.coverage.hiUs },
    policy: query.policy,
    mode: 'naive',
  });
  const naiveKeys = new Set(naive.partitions.map((p) => p.dayKey));
  const zonedKeys = new Set(query.compiled.partitions.map((p) => p.dayKey));
  const onlyZoned = [...zonedKeys].filter((k) => !naiveKeys.has(k)).sort();
  const onlyNaive = [...naiveKeys].filter((k) => !zonedKeys.has(k)).sort();
  // Rows that satisfy the zoned predicate but sit in a partition naive would skip.
  const perPartition = result.partitions;
  let missedRows = 0;
  let extraPartitionRows = 0;
  for (const p of perPartition) {
    if (!naiveKeys.has(p.dayKey)) missedRows += p.rowsMatched;
    if (!zonedKeys.has(p.dayKey)) extraPartitionRows += p.rowsMatched;
  }
  return {
    selectedPartitions: naive.partitions.length,
    partitions: naive.partitions.map((p) => p.dayKey),
    onlyZoned,
    onlyNaive,
    missedRows,
    note: onlyZoned.length === 0
      ? '这个查询在两种裁剪下分区一致'
      : '按 UTC 日期裁剪会漏掉上方分区',
  };
}

/**
 * Zone profile across dataset coverage: every local day whose length or
 * midnight status is unusual, plus all offset transitions. Used by the
 * workbench map to mark DST-affected days for the chosen zone.
 */
function zoneProfile(zone) {
  assertZone(zone);
  const db = openDb({ readOnly: true });
  const coverage = datasetCoverage(readManifest(db));
  const timeline = getTimeline(
    zone,
    Math.floor(coverage.loUs / 1e6) - 2 * SEC_PER_DAY,
    Math.ceil(coverage.hiUs / 1e6) + 2 * SEC_PER_DAY,
  );
  const firstDay = dayFromDateKey(coverage.firstDayKey);
  const lastDay = dayFromDateKey(coverage.lastDayKey);
  const unusualDays = [];
  const dayLengths = {};
  for (let d = firstDay; d <= lastDay; d += 1) {
    const a = timeline.dayAnatomy(d);
    dayLengths[a.dayKey] = a.lengthHours;
    if (a.lengthHours !== 24 || a.midnightStatus !== 'normal') {
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
  const transitions = timeline
    .transitionsBetween(coverage.loUs, coverage.hiUs)
    .map((tr) => timeline.describeTransition(tr));
  return {
    zone,
    coverage,
    unusualDays,
    transitions,
    days: Object.keys(dayLengths).length,
  };
}

function describeDay(zone, dayKey, expression, policy, mode) {
  assertZone(zone);
  const day = dayFromDateKey(dayKey);
  const db = openDb({ readOnly: true });
  const manifest = readManifest(db);
  const coverage = datasetCoverage(manifest);
  const meta = getManifestRow(day, db);
  if (!meta) throw new HttpError(404, `No partition for ${dayKey} (dataset covers ${coverage.firstDayKey} … ${coverage.lastDayKey})`);
  const dLo = day * US_PER_DAY;
  const dHi = dLo + US_PER_DAY;
  const timeline = mode === 'zoned'
    ? getTimeline(zone, Math.floor(dLo / 1e6) - 2 * SEC_PER_DAY, Math.ceil(dHi / 1e6) + 2 * SEC_PER_DAY)
    : null;

  // Which PCT of the partition the compiled predicate touches (if an
  // expression was supplied), plus a local-labelled view of each interval.
  let selection = null;
  if (expression) {
    try {
      const compiled = compileExpression(expression, {
        zone: mode === 'naive' ? 'UTC' : zone,
        universe: { loUs: coverage.loUs, hiUs: coverage.hiUs },
        policy,
        mode,
      });
      const part = compiled.partitions.find((p) => p.dayKey === dayKey);
      selection = part
        ? {
          selected: true,
          fullDay: part.fullDay,
          coverageRatio: part.coverageRatio,
          overlapUs: part.overlapUs,
          intervals: part.intervals.map((iv) => ({
            loUs: iv.loUs,
            hiUs: iv.hiUs,
            loLocal: timeline ? timeline.localLabelAtUs(iv.loUs) : null,
            hiLocal: timeline ? timeline.localLabelAtUs(iv.hiUs - 1) : null,
          })),
          totalIntervals: compiled.intervals.length,
        }
        : { selected: false, intervals: [], totalIntervals: compiled.intervals.length };
    } catch (err) {
      selection = { error: err.message };
    }
  }

  const rows = db.prepare(`SELECT id, ts_us, service, level, latency_ms, bytes, msg FROM ${meta.table} ORDER BY ts_us`).all();
  const bucketSum = db.prepare(
    'SELECT COUNT(*) AS buckets, SUM(row_count) AS c, SUM(sum_bytes) AS b, SUM(sum_latency_ms) AS l, SUM(error_count) AS e FROM buckets WHERE bucket_lo_us >= ? AND bucket_lo_us < ?',
  ).get(dLo, dHi);
  const rowSum = db.prepare(
    `SELECT COUNT(*) AS c, SUM(bytes) AS b, SUM(latency_ms) AS l,
            SUM(CASE WHEN level = 'error' THEN 1 ELSE 0 END) AS e
     FROM ${meta.table}`,
  ).get();

  // Hour histogram: UTC hours always 24 buckets; local hours can be 23/24/25.
  const utcHours = Array.from({ length: 24 }, () => ({ rows: 0, bytes: 0, errors: 0 }));
  const localHours = new Map();
  const localDays = new Map();
  for (const row of rows) {
    const h = Math.floor((row.ts_us - dLo) / 3_600_000_000);
    if (h >= 0 && h < 24) {
      utcHours[h].rows += 1;
      utcHours[h].bytes += row.bytes;
      if (row.level === 'error') utcHours[h].errors += 1;
    }
    if (timeline) {
      const p = timeline.localPartsAtUs(row.ts_us);
      const dayK = dateKeyFromDay(p.dayIndex);
      let dbucket = localDays.get(dayK);
      if (!dbucket) {
        dbucket = { dayKey: dayK, rows: 0, bytes: 0, errors: 0, firstLocal: null, lastLocal: null };
        localDays.set(dayK, dbucket);
      }
      dbucket.rows += 1;
      dbucket.bytes += row.bytes;
      if (row.level === 'error') dbucket.errors += 1;
      const label = timeline.localLabelAtUs(row.ts_us);
      if (!dbucket.firstLocal) dbucket.firstLocal = label;
      dbucket.lastLocal = label;
      // Include the offset in the key: a repeated local hour is two distinct
      // buckets (same wall clock, different UTC offset), never merged.
      const offsetLabel = formatOffset(p.offsetSeconds);
      const key = `${dateKeyFromDay(p.dayIndex)} ${String(p.hour).padStart(2, '0')} ${offsetLabel}`;
      let bucket = localHours.get(key);
      if (!bucket) {
        bucket = {
          key,
          dayKey: dateKeyFromDay(p.dayIndex),
          hour: p.hour,
          offset: offsetLabel,
          rows: 0,
          bytes: 0,
          errors: 0,
        };
        localHours.set(key, bucket);
      }
      bucket.rows += 1;
      bucket.bytes += row.bytes;
      if (row.level === 'error') bucket.errors += 1;
    }
  }

  const anatomy = timeline
    ? [-1, 0, 1].map((offset) => {
      const d = day + offset;
      const a = timeline.dayAnatomy(d);
      return {
        dayIndex: d,
        dayKey: a.dayKey,
        lengthHours: a.lengthHours,
        startLocal: a.startLocal,
        endLocal: a.endLocal,
        midnightStatus: a.midnightStatus,
        midnightOccurrences: a.midnightOccurrences,
        transitions: a.transitions,
      };
    })
    : [];

  const boundaryRows = {
    first: rows.slice(0, 3).map(serializeRowLocal(timeline)),
    last: rows.slice(-3).map(serializeRowLocal(timeline)),
  };

  return {
    zone,
    mode,
    dayKey,
    weekday: WEEKDAY_NAMES[weekdayOfDay(day)],
    coverage,
    prevDayKey: dateKeyFromDay(day - 1),
    nextDayKey: dateKeyFromDay(day + 1),
    partition: {
      table: meta.table,
      loUs: meta.loUs,
      hiUs: meta.hiUs,
      loUtc: utcLabel(meta.loUs),
      hiUtc: utcLabel(meta.hiUs - 1),
      rowCount: meta.rowCount,
      sumBytes: meta.sumBytes,
      sumLatencyMs: meta.sumLatencyMs,
      errorCount: meta.errorCount,
      minTsUs: meta.minTsUs,
      maxTsUs: meta.maxTsUs,
      serviceCount: meta.serviceCount,
    },
    selection,
    anatomy,
    utcHours,
    // Insertion order is chronological (rows are read ORDER BY ts_us).
    localHours: [...localHours.values()],
    localDays: [...localDays.values()].sort((a, b) => a.dayKey.localeCompare(b.dayKey)),
    reconciliation: {
      manifest: {
        count: meta.rowCount, sumBytes: meta.sumBytes, sumLatencyMs: meta.sumLatencyMs, errorCount: meta.errorCount,
      },
      buckets: {
        buckets: bucketSum.buckets ?? 0,
        count: bucketSum.c ?? 0,
        sumBytes: bucketSum.b ?? 0,
        sumLatencyMs: bucketSum.l ?? 0,
        errorCount: bucketSum.e ?? 0,
      },
      rowScan: {
        count: rowSum.c ?? 0, sumBytes: rowSum.b ?? 0, sumLatencyMs: rowSum.l ?? 0, errorCount: rowSum.e ?? 0,
      },
    },
    boundaryRows,
    transitions: timeline
      ? timeline.transitionsBetween(dLo, dHi).map((tr) => ({
        ...timeline.describeTransition(tr),
        localDayBefore: timeline.localPartsAtSec(tr.atSec - 1),
      }))
      : [],
  };
}

function serializeRowLocal(timeline) {
  return (row) => ({
    id: row.id,
    tsUs: row.ts_us,
    utc: utcLabel(row.ts_us),
    local: timeline ? timeline.localLabelAtUs(row.ts_us) : null,
    level: row.level,
    service: row.service,
  });
}

function utcLabel(us) {
  const sec = Math.floor(us / 1e6);
  const day = Math.floor(sec / 86400);
  const sod = sec - day * 86400;
  const key = dateKeyFromDay(day);
  return `${key}T${String(Math.floor(sod / 3600)).padStart(2, '0')}:${String(Math.floor((sod % 3600) / 60)).padStart(2, '0')}:${String(sod % 60).padStart(2, '0')}.${String(us % 1e6).padStart(6, '0')}Z`;
}

function clampInt(value, lo, hi) {
  const n = Number(value);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}

async function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  if (rel === '/drill' || rel === '/drill/') rel = '/drill.html';
  const target = normalize(join(PUBLIC_DIR, rel));
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[extname(target)] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  try {
    if (url.pathname === '/api/meta' && req.method === 'GET') {
      json(res, 200, metaPayload());
      return;
    }
    if (url.pathname === '/api/query' && req.method === 'POST') {
      const body = await readBody(req);
      json(res, 200, await handleQuery(body));
      return;
    }
    if (url.pathname === '/api/day' && req.method === 'GET') {
      const dayKey = url.searchParams.get('day') ?? '';
      const zone = url.searchParams.get('zone') ?? 'UTC';
      const policy = url.searchParams.get('policy') ?? 'earlier';
      const mode = url.searchParams.get('mode') ?? 'zoned';
      const expression = url.searchParams.get('expression') || null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) throw new HttpError(400, 'day must be YYYY-MM-DD');
      json(res, 200, describeDay(zone, dayKey, expression, policy, mode));
      return;
    }
    if (url.pathname === '/api/zone' && req.method === 'GET') {
      const zone = url.searchParams.get('zone') ?? '';
      json(res, 200, zoneProfile(zone));
      return;
    }
    if (url.pathname === '/api/health') {
      json(res, 200, { ok: true });
      return;
    }
    if (req.method !== 'GET') {
      json(res, 405, { error: 'Method not allowed' });
      return;
    }
    await serveStatic(req, res, url.pathname);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : err instanceof ExprError ? 400 : 500;
    const payload = {
      error: err.message,
      kind: err instanceof ExprError ? 'expression' : err instanceof HttpError ? 'request' : 'server',
    };
    if (err instanceof ExprError && err.position != null) payload.position = err.position;
    if (process.env.LAB_DEBUG) console.error(err);
    json(res, status, payload);
  }
});

server.listen(PORT, () => {
  process.stdout.write(`zoned-slice-lab listening on http://localhost:${PORT}\n`);
  try {
    const coverage = datasetCoverage(readManifest(openDb({ readOnly: true })));
    process.stdout.write(`dataset: ${coverage.partitionCount} partitions, ${coverage.totalRows} rows (${coverage.firstDayKey} … ${coverage.lastDayKey})\n`);
  } catch (err) {
    process.stdout.write(`WARNING: ${err.message}\n`);
  }
});

export { server };
