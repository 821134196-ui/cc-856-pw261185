// Deterministic dataset generator.
//
// Layout: one SQLite table per UTC day (the physical partition), plus a manifest
// table with per-partition aggregates so the aggregate path can be checked
// against a row-by-row scan.
//
// Deliberate "edge rows" are planted so the boundaries of the zoned transform
// are observable in the data, not just in theory:
//   * the first and last microsecond of every UTC partition;
//   * rows exactly at every DST transition instant of the featured zones;
//   * rows inside skipped and repeated local hours.

import { createDb, DATA_DIR, DB_PATH, closeDb, tableNameForDay } from './db.mjs';
import { US_PER_DAY, dayFromDateKey, dateKeyFromDay } from './tz.mjs';
import { mkdirSync, rmSync } from 'node:fs';

const START = process.env.LAB_SEED_START ?? '2026-01-01';
const DAYS = Number(process.env.LAB_SEED_DAYS ?? 365);
const ROWS_PER_DAY = 720;

const SERVICES = ['api', 'web', 'worker', 'ingest', 'auth', 'billing'];
const MESSAGES = {
  ok: ['request completed', 'cache hit', 'upstream ok', 'batch flushed', 'session refreshed'],
  warn: ['slow upstream', 'retry scheduled', 'queue depth high', 'token nearing expiry'],
  error: ['upstream 502', 'timeout after 30s', 'db deadlock', 'payload rejected', 'tls handshake failed'],
};

// Featured zones: chosen because their 2026 transitions stress midnight.
const FEATURED_ZONE_TRANSITIONS = [
  '1772953200', // America/New_York spring forward
  '1793512800', // America/New_York fall back
  '1772946000', // America/Havana spring forward (00:00 -> 01:00)
  '1793509200', // America/Havana fall back (01:00 -> 00:00)
  '1743908400', // America/Santiago fall back
  '1757217600', // America/Santiago spring forward (00:00 -> 01:00)
  '1775314800', // Australia/Lord_Howe fall back (30 min)
  '1791041400', // Australia/Lord_Howe spring forward (30 min)
  '1743296400', // Atlantic/Azores spring forward (00:00 -> 01:00)
  '1761440400', // Atlantic/Azores fall back
  '1774746000', // America/Nuuk spring forward
  '1792890000', // America/Nuuk fall back
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function levelFor(rng, hourUtc) {
  // Business hours in Europe/UTC have more traffic and fewer failures.
  const business = hourUtc >= 7 && hourUtc <= 18;
  const r = rng();
  if (business) {
    if (r < 0.012) return 'error';
    if (r < 0.06) return 'warn';
    return 'ok';
  }
  if (r < 0.035) return 'error';
  if (r < 0.12) return 'warn';
  return 'ok';
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function buildRow(rng, tsUs, nextId, forcedLevel = null) {
  const hourUtc = Math.floor((tsUs % US_PER_DAY) / 3_600_000_000);
  const level = forcedLevel ?? levelFor(rng, hourUtc);
  const service = pick(rng, SERVICES);
  const base = level === 'error' ? 450 : level === 'warn' ? 180 : 42;
  const latency = Math.max(1, Math.round(base + gaussian(rng) * (level === 'ok' ? 25 : 120)));
  const bytes = Math.round(Math.max(120, 1400 + gaussian(rng) * 600))
    * (service === 'ingest' ? 3 : 1);
  const msg = pick(rng, MESSAGES[level]);
  return {
    id: nextId,
    tsUs,
    service,
    level,
    latency,
    bytes,
    msg,
  };
}

export function* planSpecialInstants(startDay, days) {
  const instants = new Set();
  for (let i = 0; i < days; i += 1) {
    const day = startDay + i;
    instants.add(day * US_PER_DAY);
    instants.add((day + 1) * US_PER_DAY - 1);
    instants.add(day * US_PER_DAY + 1);
  }
  for (const sec of FEATURED_ZONE_TRANSITIONS) {
    const us = Number(sec) * 1_000_000;
    for (let k = -1; k <= 1; k += 1) instants.add(us + k);
    instants.add(us + 30 * 60 * 1_000_000);
  }
  for (const us of [...instants].sort((a, b) => a - b)) {
    const day = Math.floor(us / US_PER_DAY);
    if (day >= startDay && day < startDay + days) yield us;
  }
}

export function seed({ startKey = START, days = DAYS, rowsPerDay = ROWS_PER_DAY, seedValue = 20261126 } = {}) {
  const started = Date.now();
  if (process.env.LAB_KEEP_DATA !== '1') {
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${DB_PATH}${suffix}`, { force: true });
    }
  }
  mkdirSync(DATA_DIR, { recursive: true });

  const db = createDb();
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = OFF');
  db.exec(`
    CREATE TABLE partitions (
      day_index      INTEGER PRIMARY KEY,
      day_key        TEXT NOT NULL,
      table_name     TEXT NOT NULL,
      lo_us          INTEGER NOT NULL,
      hi_us          INTEGER NOT NULL,
      row_count      INTEGER NOT NULL,
      sum_bytes      INTEGER NOT NULL,
      sum_latency_ms INTEGER NOT NULL,
      error_count    INTEGER NOT NULL,
      min_ts_us      INTEGER NOT NULL,
      max_ts_us      INTEGER NOT NULL,
      service_count  INTEGER NOT NULL
    );
    CREATE TABLE services (
      name  TEXT PRIMARY KEY,
      label TEXT NOT NULL
    );
    CREATE TABLE buckets (
      bucket_lo_us   INTEGER NOT NULL,
      bucket_hi_us   INTEGER NOT NULL,
      row_count      INTEGER NOT NULL,
      sum_bytes      INTEGER NOT NULL,
      sum_latency_ms INTEGER NOT NULL,
      error_count    INTEGER NOT NULL,
      PRIMARY KEY (bucket_lo_us)
    ) WITHOUT ROWID;
  `);
  const insertBucket = db.prepare(`
    INSERT INTO buckets(bucket_lo_us, bucket_hi_us, row_count, sum_bytes, sum_latency_ms, error_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertService = db.prepare('INSERT INTO services(name, label) VALUES (?, ?)');
  const serviceLabels = {
    api: 'API 网关', web: 'Web 前端', worker: '后台任务', ingest: '数据摄取', auth: '认证服务', billing: '计费',
  };
  db.exec('BEGIN');
  for (const s of SERVICES) insertService.run(s, serviceLabels[s]);
  db.exec('COMMIT');

  const startDay = dayFromDateKey(startKey);
  const specialByDay = new Map();
  for (const us of planSpecialInstants(startDay, days)) {
    const day = Math.floor(us / US_PER_DAY);
    if (!specialByDay.has(day)) specialByDay.set(day, []);
    specialByDay.get(day).push(us);
  }

  const manifestInsert = db.prepare(`
    INSERT INTO partitions(day_index, day_key, table_name, lo_us, hi_us, row_count,
      sum_bytes, sum_latency_ms, error_count, min_ts_us, max_ts_us, service_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const summary = [];
  let nextId = 1;
  const totalRows = days * rowsPerDay;
  const t0 = Date.now();

  for (let i = 0; i < days; i += 1) {
    const day = startDay + i;
    const dayKey = dateKeyFromDay(day);
    const table = tableNameForDay(day);
    const loUs = day * US_PER_DAY;
    const hiUs = loUs + US_PER_DAY;
    db.exec(`CREATE TABLE ${table}(
      id INTEGER PRIMARY KEY,
      ts_us INTEGER NOT NULL,
      service TEXT NOT NULL,
      level TEXT NOT NULL,
      latency_ms INTEGER NOT NULL,
      bytes INTEGER NOT NULL,
      msg TEXT NOT NULL
    )`);
    db.exec(`CREATE INDEX ${table}_ts ON ${table}(ts_us)`);

    db.exec('BEGIN');
    const rng = mulberry32(seedValue + day);
    const special = specialByDay.get(day) ?? [];
    const count = rowsPerDay + special.length;
    const stamp = new Map();
    const insertRow = db.prepare(
      `INSERT INTO ${table}(id, ts_us, service, level, latency_ms, bytes, msg) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    // Random instants, then overwrite the first `special.length` slots with the
    // planted edge instants so each one appears exactly once.
    for (let r = 0; r < count; r += 1) {
      let tsUs;
      if (r < special.length) {
        tsUs = special[r];
      } else {
        // Skew toward working hours: mixture of uniform and a bell at 10:00 UTC.
        tsUs = rng() < 0.55
          ? loUs + Math.floor((10 + gaussian(rng) * 3) * 3_600_000_000)
          : loUs + Math.floor(rng() * US_PER_DAY);
        tsUs = Math.min(hiUs - 1, Math.max(loUs, tsUs));
      }
      if (stamp.has(tsUs)) {
        // Keep ids unique but allow duplicate instants (real telemetry does).
        tsUs = Math.min(hiUs - 1, tsUs + 1);
      }
      stamp.set(tsUs, true);
      const row = buildRow(rng, tsUs, nextId);
      nextId += 1;
      insertRow.run(row.id, row.tsUs, row.service, row.level, row.latency, row.bytes, row.msg);
    }

    // Pre-aggregated minute buckets: (UTC instant / 60s) floor. Any query whose
    // interval set is minute-aligned can be answered without touching rows.
    const bucketRows = db.prepare(`
      SELECT (ts_us / 60000000) * 60000000 AS b_lo,
             COUNT(*) AS c,
             SUM(bytes) AS s_bytes,
             SUM(latency_ms) AS s_lat,
             SUM(CASE WHEN level = 'error' THEN 1 ELSE 0 END) AS e
      FROM ${table}
      GROUP BY b_lo
      ORDER BY b_lo
    `).all();
    for (const b of bucketRows) {
      insertBucket.run(b.b_lo, b.b_lo + 60_000_000, b.c, b.s_bytes ?? 0, b.s_lat ?? 0, b.e ?? 0);
    }
    db.exec('COMMIT');
    const stats = db.prepare(`
      SELECT COUNT(*) AS row_count,
             SUM(bytes) AS sum_bytes,
             SUM(latency_ms) AS sum_latency_ms,
             SUM(CASE WHEN level = 'error' THEN 1 ELSE 0 END) AS error_count,
             MIN(ts_us) AS min_ts_us,
             MAX(ts_us) AS max_ts_us,
             COUNT(DISTINCT service) AS service_count
      FROM ${table}
    `).get();
    manifestInsert.run(
      day, dayKey, table, loUs, hiUs,
      stats.row_count, stats.sum_bytes ?? 0, stats.sum_latency_ms ?? 0,
      stats.error_count ?? 0, stats.min_ts_us ?? loUs, stats.max_ts_us ?? loUs,
      stats.service_count ?? 0,
    );
    summary.push({ dayKey, rows: stats.row_count });
    if (i % 60 === 0) {
      const pct = ((i / days) * 100).toFixed(0);
      process.stdout.write(`  seeding ${pct}% (${dayKey}, ${totalRows} rows planned)\n`);
    }
  }
  db.exec('ANALYZE');
  const elapsed = Date.now() - started;
  const totals = db.prepare('SELECT SUM(row_count) rows FROM partitions').get();
  closeDb();

  return {
    path: DB_PATH,
    startKey,
    days,
    rows: totals.rows,
    elapsedMs: elapsed,
    insertMs: Date.now() - t0,
    firstDay: dateKeyFromDay(startDay),
    lastDay: dateKeyFromDay(startDay + days - 1),
  };
}

const isMain = process.argv[1] && process.argv[1].endsWith('seed.mjs');
if (isMain) {
  const reset = process.argv.includes('--reset');
  if (reset) process.stdout.write('Resetting dataset…\n');
  const result = seed();
  process.stdout.write(
    `Seeded ${result.rows} rows across ${result.days} daily partitions `
    + `(${result.firstDay} … ${result.lastDay}) in ${result.elapsedMs} ms\n`
    + `Database: ${result.path}\n`,
  );
}
