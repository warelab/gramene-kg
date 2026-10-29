// Derived per-gene lookups over a build's bucketed parquet (written by build/lib/derived_*.mjs, stage kg15_derived):
//   <dir>/parquet/derived/{homology,expression}/bucket=<hash(gene_id) % 64>/part-0.parquet
// dir = $RELEASE_BUILDS/<build_id>. Pure functions, no Fastify. One lazy in-memory DuckDB shared by all calls;
// only the gene's bucket is read, and every caller value is validated and bound as a parameter.
import fs from 'node:fs';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';

const BUCKETS = 64, MAX_LIMIT = 1000;
const GENE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KIND_RE = /^[a-z0-9_]{1,64}$/;
const EXP_RE = /^[A-Za-z0-9-]{1,64}$/;

let _inst;
async function conn() {
  if (!_inst) _inst = (async () => {
    const db = await DuckDBInstance.create(':memory:', { threads: String(process.env.DERIVED_DUCKDB_THREADS || 4) });
    const c = await db.connect();
    await c.run(`SET memory_limit='${process.env.DERIVED_DUCKDB_MEMORY || '2GB'}'`);
    await c.run('SET enable_object_cache=true');   // parquet footers cached across lookups
    return db;
  })();
  return (await _inst).connect();
}
const rows = async (c, sql, values) => (await c.runAndReadAll(sql, values)).getRowObjectsJS();
// one short-lived connection per lookup (connections are cheap; the instance and its object cache are shared)
async function withConn(fn) { const c = await conn(); try { return await fn(c); } finally { c.closeSync(); } }
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const badArg = (msg) => Object.assign(new Error(msg), { statusCode: 400 });

// same expression the build used, so buckets agree by construction
const bucketCache = new Map();
async function bucketFile(c, dir, kind, gene) {
  if (typeof gene !== 'string' || !GENE_RE.test(gene)) throw badArg(`invalid gene id '${String(gene).slice(0, 80)}'`);
  let b = bucketCache.get(gene);
  if (b === undefined) {
    [{ b }] = await rows(c, `SELECT (hash($1::VARCHAR) % ${BUCKETS})::INTEGER AS b`, [gene]);
    if (bucketCache.size > 100000) bucketCache.clear();
    bucketCache.set(gene, b);
  }
  const f = path.join(dir, 'parquet', 'derived', kind, `bucket=${b}`, 'part-0.parquet');
  return fs.existsSync(f) ? f : null;
}

// homologs(dir, gene, {kind, limit, offset}) -> { gene_id, total, by_kind, rows: [{homolog_id, kind, perc_pos, ...}] }
export async function homologs(dir, gene, { kind, limit = 100, offset = 0 } = {}) {
  if (kind != null && !KIND_RE.test(kind)) throw badArg(`invalid kind '${String(kind).slice(0, 80)}'`);
  limit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), MAX_LIMIT);
  offset = Math.max(parseInt(offset, 10) || 0, 0);
  return withConn(async (c) => {
    const f = await bucketFile(c, dir, 'homology', gene);
    if (!f) return { gene_id: gene, total: 0, by_kind: {}, rows: [] };
    const src = `read_parquet(${lit(f)})`;
    const counts = await rows(c, `SELECT kind, count(*)::INTEGER n FROM ${src} WHERE gene_id = $1 GROUP BY kind ORDER BY kind`, [gene]);
    const by_kind = Object.fromEntries(counts.map(r => [r.kind, r.n]));
    const total = kind != null ? (by_kind[kind] ?? 0) : counts.reduce((s, r) => s + r.n, 0);
    if (!total || offset >= total) return { gene_id: gene, total, by_kind, rows: [] };
    const out = await rows(c, `SELECT homolog_id, kind, perc_pos, homolog_perc_pos, gene_tree_id, homology_id::INTEGER AS homology_id,
        genome, homolog_genome
      FROM ${src} WHERE gene_id = $1 AND ($2::VARCHAR IS NULL OR kind = $2::VARCHAR)
      ORDER BY kind, homolog_id LIMIT ${limit} OFFSET ${offset}`, [gene, kind ?? null]);
    return { gene_id: gene, total, by_kind, rows: out };
  });
}

// expression(dir, gene, {experiment}) -> { gene_id, rows: [{experiment, kind, group, assay_id, contrast_id, value, p_value, l2fc}] }
export async function expression(dir, gene, { experiment } = {}) {
  if (experiment != null && !EXP_RE.test(experiment)) throw badArg(`invalid experiment '${String(experiment).slice(0, 80)}'`);
  return withConn(async (c) => {
    const f = await bucketFile(c, dir, 'expression', gene);
    if (!f) return { gene_id: gene, rows: [] };
    const out = await rows(c, `SELECT experiment, kind, "group", assay_id, contrast_id, value, p_value, l2fc
      FROM read_parquet(${lit(f)}) WHERE gene_id = $1 AND ($2::VARCHAR IS NULL OR experiment = $2::VARCHAR)
      ORDER BY experiment, kind, "group"`, [gene, experiment ?? null]);
    return { gene_id: gene, rows: out };
  });
}
