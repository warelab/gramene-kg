// kgio.mjs — shared I/O for build stages: config, hashing, NDJSON writers, DuckDB -> Parquet.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import yaml from 'js-yaml';
import { DuckDBInstance } from '@duckdb/node-api';

const require = createRequire(import.meta.url);

export function env(name, dflt) {
  const v = process.env[name] ?? dflt;
  if (v === undefined || v === '') throw new Error(`missing env ${name} (source build/config.sh)`);
  return v;
}

export function loadReleaseConfig() {
  const cfg = yaml.load(fs.readFileSync(env('RELEASE_YAML'), 'utf8'));
  cfg.release_cfg_dir = env('RELEASE_CFG_DIR');
  return cfg;
}

export function loadYaml(p) { return yaml.load(fs.readFileSync(p, 'utf8')); }

export function buildOut(...parts) {
  const base = env('BUILD_OUT');
  const p = path.join(base, ...parts);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return p;
}

// ---- hashing ---------------------------------------------------------------------------------
export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file, { highWaterMark: 1 << 22 })
      .on('data', d => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}
export const sha256Text = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const sha1Text = (s) => crypto.createHash('sha1').update(s).digest('hex');

// Deterministic edge / association id: sha256-24 of the identity fields.
export function edgeId(subject, predicate, object, source, qualifiers = {}, assertionId = '') {
  const q = Object.keys(qualifiers).sort().map(k => `${k}=${JSON.stringify(qualifiers[k])}`).join('&');
  return sha256Text([subject, predicate, object, source, q, assertionId].join('|')).slice(0, 24);
}

// Run async fn over items with bounded concurrency, preserving order.
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  });
  await Promise.all(workers);
  return out;
}

// ---- NDJSON ----------------------------------------------------------------------------------
export class NdjsonWriter {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.file = file; this.n = 0;
    this.stream = fs.createWriteStream(file);
  }
  write(obj) {
    this.n++;
    if (!this.stream.write(JSON.stringify(obj) + '\n')) return new Promise(r => this.stream.once('drain', r));
    return null;
  }
  close() { return new Promise((res, rej) => this.stream.end(err => err ? rej(err) : res(this.n))); }
}

// ---- DuckDB ----------------------------------------------------------------------------------
let _duck;
export async function duck() {
  if (!_duck) {
    const db = await DuckDBInstance.create(':memory:');
    _duck = await db.connect();
    await _duck.run(`SET temp_directory='${env('TMPDIR')}/duckdb'`);
    await _duck.run(`SET memory_limit='${process.env.DUCKDB_MEMORY_LIMIT || '16GB'}'`);
    await _duck.run(`SET threads=${process.env.DUCKDB_THREADS || 16}`);
    await _duck.run(`SET preserve_insertion_order=false`);
  }
  return _duck;
}
export async function q(sql) { const c = await duck(); return (await c.runAndReadAll(sql)).getRowObjects(); }
export async function exec(sql) { const c = await duck(); await c.run(sql); }

const sqlStr = (s) => `'${String(s).replace(/'/g, "''")}'`;
export { sqlStr };

// NDJSON -> Parquet (zstd). Returns row count.
export async function ndjsonToParquet(ndjson, parquet, { columns } = {}) {
  fs.mkdirSync(path.dirname(parquet), { recursive: true });
  const src = columns
    ? `read_json(${sqlStr(ndjson)}, format='newline_delimited', columns=${columns})`
    : `read_json_auto(${sqlStr(ndjson)}, format='newline_delimited', sample_size=-1)`;
  await exec(`COPY (SELECT * FROM ${src}) TO ${sqlStr(parquet)} (FORMAT parquet, COMPRESSION zstd)`);
  const [{ n }] = await q(`SELECT count(*)::BIGINT AS n FROM ${sqlStr(parquet)}`);
  return Number(n);
}

// Release-tree helpers (read-only).
export function releaseMongoConfig(releaseRoot) {
  const c = require(path.join(releaseRoot, 'gramene-mongodb-config/collections.js'));
  return c.getMongoConfig();
}

export async function exists(p) { try { await fsp.access(p); return true; } catch { return false; } }

export function log(...a) { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); console.error(`[${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}]`, ...a); }
