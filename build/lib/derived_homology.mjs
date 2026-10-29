// kg15 derived homology: every compara homology as two directed rows (A->B, B->A), bucketed by gene
//   parquet/derived/homology/bucket=<0..63>/part-0.parquet  (sorted by gene_id; bucket = hash(gene_id) % 64)
// Matches the site's homolog store (build_homologs.js -> homolog_pairs.sorted.tsv.gz): every kind except
// gene_split comes from the plain join; gene_split rows survive only where the site's skip heuristic kept them.
import fs from 'node:fs';
import path from 'node:path';
import { buildOut, q, exec, sqlStr, log, loadReleaseConfig } from './kgio.mjs';

const cfg = loadReleaseConfig();
const DIR = cfg.inputs.homology_dir;
const GT_PREFIX = cfg.genetree_prefix ?? 'SB11GT_';
const EXPECT = 190368450, BUCKETS = 64, CHUNKS = Number(process.env.DERIVED_CHUNKS || 10);
const IN = (f) => sqlStr(path.join(DIR, f));
const WORK = buildOut('work', 'derived_homology', 'x');
const W = (f) => sqlStr(path.join(path.dirname(WORK), f));
const OUT = path.dirname(buildOut('parquet', 'derived', 'homology', 'x'));
const tsv = (f, cols) => `read_csv(${IN(f)}, delim='\t', header=false, quote='', escape='', nullstr=['NULL',''], columns=${cols})`;
const t0 = Date.now();
// derived_counts.json is shared with derived_expression.mjs: merge our keys, keep theirs
function mergeCounts(obj) {
  const f = buildOut('derived_counts.json');
  const cur = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
  fs.writeFileSync(f, JSON.stringify({ ...cur, ...obj }, null, 2) + '\n');
}
const secs = () => Math.round((Date.now() - t0) / 1000);

// 1) stage the gz dumps once as parquet so each homology_id chunk is a cheap filtered scan, not a re-gunzip
await exec(`CREATE TABLE gdb AS SELECT * FROM ${tsv('genome_db.tsv.gz', `{'gdb': 'INTEGER', 'genome': 'VARCHAR'}`)}`);
await exec(`CREATE TABLE gm AS SELECT gm.gmid, gm.stable_id, gdb.genome
  FROM ${tsv('gene_member.tsv.gz', `{'gmid': 'BIGINT', 'stable_id': 'VARCHAR', 'gdb': 'INTEGER', 'dnafrag_id': 'BIGINT', 'dstart': 'BIGINT', 'dend': 'BIGINT', 'dstrand': 'TINYINT'}`)} gm
  LEFT JOIN gdb USING (gdb)`);
await exec(`COPY (SELECT * FROM ${tsv('homology.tsv.gz', `{'hid': 'BIGINT', 'kind': 'VARCHAR', 'root': 'BIGINT'}`)})
  TO ${W('homology.parquet')} (FORMAT parquet, COMPRESSION zstd)`);
await exec(`COPY (SELECT * FROM ${tsv('homology_member.tsv.gz', `{'hid': 'BIGINT', 'gmid': 'BIGINT', 'ppos': 'DOUBLE'}`)})
  TO ${W('members.parquet')} (FORMAT parquet, COMPRESSION zstd)`);
// the site's surviving gene_split pairs (both directions are already in the file)
await exec(`CREATE TABLE split_keep AS SELECT DISTINCT gene, other
  FROM ${tsv('homolog_pairs.sorted.tsv.gz', `{'gene': 'VARCHAR', 'other': 'VARCHAR', 'kind': 'VARCHAR'}`)} WHERE kind = 'gene_split'`);
const [st] = await q(`SELECT (SELECT count(*) FROM gm)::BIGINT gm, (SELECT count(*) FROM ${W('homology.parquet')})::BIGINT h,
  (SELECT count(*) FROM ${W('members.parquet')})::BIGINT hm, (SELECT count(*) FROM split_keep)::BIGINT split,
  (SELECT min(hid) FROM ${W('homology.parquet')})::BIGINT lo, (SELECT max(hid) FROM ${W('homology.parquet')})::BIGINT hi`);
log(`staged: gene_member ${st.gm}, homology ${st.h}, homology_member ${st.hm}, kept gene_split pairs ${st.split} (${secs()}s)`);

// 2) homology_id chunks -> unsorted staging partitions
const STAGE = path.join(path.dirname(WORK), 'staging');
fs.rmSync(STAGE, { recursive: true, force: true });
const lo = Number(st.lo), hi = Number(st.hi), step = Math.ceil((hi - lo + 1) / CHUNKS);
for (let c = 0; c < CHUNKS; c++) {
  const a = lo + c * step, b = Math.min(hi, a + step - 1);
  await exec(`COPY (
    WITH m AS (SELECT hm.hid, hm.gmid, hm.ppos, g.stable_id, g.genome FROM read_parquet(${W('members.parquet')}) hm
               JOIN gm g USING (gmid) WHERE hm.hid BETWEEN ${a} AND ${b})
    SELECT x.stable_id AS gene_id, y.stable_id AS homolog_id, h.kind, x.ppos AS perc_pos, y.ppos AS homolog_perc_pos,
           ${sqlStr('gramene.genetree:' + GT_PREFIX)} || h.root AS gene_tree_id, h.hid AS homology_id,
           x.genome, y.genome AS homolog_genome, (hash(x.stable_id) % ${BUCKETS})::INTEGER AS bucket
    FROM m x JOIN m y ON y.hid = x.hid AND y.gmid <> x.gmid
    JOIN (SELECT * FROM read_parquet(${W('homology.parquet')}) WHERE hid BETWEEN ${a} AND ${b}) h ON h.hid = x.hid
    WHERE h.kind <> 'gene_split'
       OR EXISTS (SELECT 1 FROM split_keep s WHERE s.gene = x.stable_id AND s.other = y.stable_id)
  ) TO ${sqlStr(STAGE)} (FORMAT parquet, COMPRESSION zstd, PARTITION_BY (bucket), FILENAME_PATTERN 'c${c}_{i}', OVERWRITE_OR_IGNORE)`);
  log(`chunk ${c + 1}/${CHUNKS} homology_id ${a}..${b} (${secs()}s)`);
}

// 3) one sorted file per bucket; small row groups so a gene lookup touches one or two
fs.rmSync(OUT, { recursive: true, force: true });
for (let k = 0; k < BUCKETS; k++) {
  const dst = path.join(OUT, `bucket=${k}`, 'part-0.parquet');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  await exec(`COPY (SELECT * FROM read_parquet(${sqlStr(path.join(STAGE, `bucket=${k}`, '*.parquet'))}, hive_partitioning=false)
    ORDER BY gene_id, kind, homolog_id) TO ${sqlStr(dst)} (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 20480)`);
}
fs.rmSync(STAGE, { recursive: true, force: true });
log(`wrote ${BUCKETS} buckets (${secs()}s)`);

// 4) counts + expectation
const ALL = sqlStr(path.join(OUT, '*', '*.parquet'));
const kinds = await q(`SELECT kind, count(*)::BIGINT n FROM read_parquet(${ALL}) GROUP BY kind ORDER BY kind`);
const byKind = Object.fromEntries(kinds.map(r => [r.kind, Number(r.n)]));
const total = Object.values(byKind).reduce((s, n) => s + n, 0);
const [bk] = await q(`SELECT min(n)::BIGINT mn, max(n)::BIGINT mx FROM (SELECT count(*) n FROM read_parquet(${ALL}, hive_partitioning=true) GROUP BY bucket)`);
const [nulls] = await q(`SELECT count(*) FILTER (WHERE genome IS NULL OR homolog_genome IS NULL)::BIGINT n FROM read_parquet(${ALL})`);
mergeCounts({ homology: { total, by_kind: byKind, gene_split_pairs_in_site_file: Number(st.split), bucket_rows_min: Number(bk.mn),
  bucket_rows_max: Number(bk.mx), rows_missing_genome: Number(nulls.n), expected: EXPECT, seconds: secs() } });
log(`homology rows ${total} (${JSON.stringify(byKind)}); bucket rows ${bk.mn}..${bk.mx}; ${secs()}s`);
fs.rmSync(path.dirname(WORK), { recursive: true, force: true });
if (Math.abs(total - EXPECT) / EXPECT > 0.01 && process.env.DERIVED_EXPECT_SKIP !== '1') {
  log(`FATAL: homology rows ${total} deviate > 1% from ${EXPECT} (set DERIVED_EXPECT_SKIP=1 to accept)`); process.exit(1);
}
