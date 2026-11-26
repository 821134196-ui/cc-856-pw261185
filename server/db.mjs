// SQLite storage: one physical table per UTC day ("partition"), plus a manifest
// with per-partition statistics used by the rollup aggregate path.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { US_PER_DAY, dateKeyFromDay } from './tz.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.LAB_DATA_DIR
  ? resolve(process.env.LAB_DATA_DIR)
  : resolve(HERE, '..', '.data');
export const DB_PATH = process.env.LAB_DB_PATH
  ? resolve(process.env.LAB_DB_PATH)
  : resolve(DATA_DIR, 'lab.sqlite');

export function tableNameForDay(dayIndex) {
  return `p_${dateKeyFromDay(dayIndex).replaceAll('-', '')}`;
}

let db = null;

export function openDb({ readOnly = false } = {}) {
  if (db) return db;
  if (!existsSync(DB_PATH)) {
    throw new Error(`Database not found at ${DB_PATH}. Run "npm run seed" first.`);
  }
  db = new DatabaseSync(DB_PATH, readOnly ? { readOnly: true } : undefined);
  if (!readOnly) {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
  }
  db.exec('PRAGMA temp_store = MEMORY');
  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

export function createDb() {
  mkdirSync(DATA_DIR, { recursive: true });
  if (db) {
    db.close();
    db = null;
  }
  db = new DatabaseSync(DB_PATH);
  return db;
}

export function readManifest(database = openDb()) {
  const rows = database.prepare('SELECT * FROM partitions ORDER BY day_index').all();
  return rows.map(serializeManifestRow);
}

function serializeManifestRow(row) {
  return {
    dayIndex: row.day_index,
    dayKey: row.day_key,
    table: row.table_name,
    loUs: row.lo_us,
    hiUs: row.hi_us,
    rowCount: row.row_count,
    sumBytes: row.sum_bytes,
    sumLatencyMs: row.sum_latency_ms,
    errorCount: row.error_count,
    minTsUs: row.min_ts_us,
    maxTsUs: row.max_ts_us,
    serviceCount: row.service_count,
  };
}

export function getManifestRow(dayIndex, database = openDb()) {
  const row = database.prepare('SELECT * FROM partitions WHERE day_index = ?').get(dayIndex);
  return row ? serializeManifestRow(row) : null;
}

export function datasetCoverage(manifest) {
  if (manifest.length === 0) return null;
  return {
    loUs: manifest[0].loUs,
    hiUs: manifest[manifest.length - 1].hiUs,
    firstDayKey: manifest[0].dayKey,
    lastDayKey: manifest[manifest.length - 1].dayKey,
    partitionCount: manifest.length,
    totalRows: manifest.reduce((sum, p) => sum + p.rowCount, 0),
  };
}

export function dbFileStats() {
  const out = { path: DB_PATH, bytes: 0, walBytes: 0 };
  try { out.bytes = statSync(DB_PATH).size; } catch { /* ignore */ }
  try { out.walBytes = statSync(`${DB_PATH}-wal`).size; } catch { /* ignore */ }
  return out;
}

export const ROW_COLUMNS = ['id', 'ts_us', 'service', 'level', 'latency_ms', 'bytes', 'msg'];

export function partitionTableExists(name, database = openDb()) {
  const row = database
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return Boolean(row);
}

export { US_PER_DAY };
