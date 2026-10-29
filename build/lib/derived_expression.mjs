// kg15 derived expression: per-gene values from <SRC_DB>.expression, one row per (gene, experiment, group)
//   parquet/derived/expression/bucket=<0..63>/part-0.parquet  (sorted by gene_id; bucket = hash(gene_id) % 64)
// baseline   {group:"g1", value}            -> assay_id    gramene.assay:<exp>.<group>
// differential {group:"g2_g1", p_value, l2fc} -> contrast_id gramene.contrast:<exp>.<reference>_<test>
import fs from 'node:fs';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { env, buildOut, q, exec, sqlStr, log, NdjsonWriter } from './kgio.mjs';

const BUCKETS = 64;
const NDJ = buildOut('work', 'derived_expression.ndjson');
const OUT = path.dirname(buildOut('parquet', 'derived', 'expression', 'x'));
const t0 = Date.now();
const secs = () => Math.round((Date.now() - t0) / 1000);
const num = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v : null;

function mergeCounts(obj) {   // shared with derived_homology.mjs: merge our keys, keep theirs
  const f = buildOut('derived_counts.json');
  const cur = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
  fs.writeFileSync(f, JSON.stringify({ ...cur, ...obj }, null, 2) + '\n');
}

// 1) Mongo -> NDJSON (read-only cursor)
const mongo = await MongoClient.connect(env('MONGO_URI'));
const coll = mongo.db(env('SRC_DB')).collection('expression');
const w = new NdjsonWriter(NDJ);
let docs = 0, odd = 0;
for await (const d of coll.find({}).batchSize(500)) {
  docs++;
  for (const [exp, arr] of Object.entries(d)) {
    if (exp === '_id' || !Array.isArray(arr)) continue;
    for (const e of arr) {
      const diff = e.l2fc !== undefined || e.p_value !== undefined;
      if (!diff && e.value === undefined) { odd++; continue; }
      const p = w.write({ gene_id: d._id, experiment: exp, kind: diff ? 'differential' : 'baseline', group: String(e.group),
        value: diff ? null : num(e.value), p_value: diff ? num(e.p_value) : null, l2fc: diff ? num(e.l2fc) : null });
      if (p) await p;
    }
  }
  if (docs % 50000 === 0) log(`  ${docs} genes, ${w.n} rows`);
}
await mongo.close();
const rows = await w.close();
log(`expression: ${docs} genes -> ${rows} rows, ${odd} entries without value/p_value/l2fc skipped (${secs()}s)`);

// 2) NDJSON -> sorted bucket files
await exec(`CREATE TABLE ex AS SELECT gene_id, experiment, kind, "group",
    CASE WHEN kind = 'baseline' THEN 'gramene.assay:' || experiment || '.' || "group" END AS assay_id,
    CASE WHEN kind = 'differential' THEN 'gramene.contrast:' || experiment || '.' || "group" END AS contrast_id,
    value, p_value, l2fc, (hash(gene_id) % ${BUCKETS})::INTEGER AS bucket
  FROM read_json(${sqlStr(NDJ)}, format='newline_delimited', columns={gene_id: 'VARCHAR', experiment: 'VARCHAR', kind: 'VARCHAR',
    "group": 'VARCHAR', value: 'DOUBLE', p_value: 'DOUBLE', l2fc: 'DOUBLE'})`);
fs.rmSync(OUT, { recursive: true, force: true });
for (let k = 0; k < BUCKETS; k++) {
  const dst = path.join(OUT, `bucket=${k}`, 'part-0.parquet');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  await exec(`COPY (SELECT * EXCLUDE (bucket) FROM ex WHERE bucket = ${k} ORDER BY gene_id, experiment, kind, "group")
    TO ${sqlStr(dst)} (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 20480)`);
}
log(`wrote ${BUCKETS} buckets (${secs()}s)`);

// 3) counts; ids that would not resolve to a graph node (prefixes.yaml patterns) are counted, not dropped
const kinds = await q(`SELECT kind, count(*)::BIGINT n, count(DISTINCT gene_id)::BIGINT genes, count(DISTINCT experiment)::BIGINT exps FROM ex GROUP BY kind ORDER BY kind`);
const [bad] = await q(`SELECT
    count(*) FILTER (WHERE kind = 'baseline' AND NOT regexp_full_match(experiment || '.' || "group", '[A-Za-z0-9-]+\\.g[0-9]+'))::BIGINT assay,
    count(*) FILTER (WHERE kind = 'differential' AND NOT regexp_full_match(experiment || '.' || "group", '[A-Za-z0-9-]+\\.g[0-9]+_g[0-9]+'))::BIGINT contrast,
    min(c)::BIGINT bmin, max(c)::BIGINT bmax
  FROM ex, (SELECT max(n) c FROM (SELECT count(*) n FROM ex GROUP BY bucket) UNION ALL SELECT min(n) FROM (SELECT count(*) n FROM ex GROUP BY bucket))`);
mergeCounts({ expression: { genes: docs, total: rows,
  by_kind: Object.fromEntries(kinds.map(r => [r.kind, Number(r.n)])),
  genes_by_kind: Object.fromEntries(kinds.map(r => [r.kind, Number(r.genes)])),
  experiments_by_kind: Object.fromEntries(kinds.map(r => [r.kind, Number(r.exps)])),
  skipped_entries: odd, ids_not_matching_prefix: { assay: Number(bad.assay), contrast: Number(bad.contrast) }, seconds: secs() } });
log(`expression rows ${rows} (${kinds.map(r => `${r.kind} ${r.n}`).join(', ')}); bad assay ids ${bad.assay}, bad contrast ids ${bad.contrast}; ${secs()}s`);
fs.rmSync(NDJ, { force: true });
