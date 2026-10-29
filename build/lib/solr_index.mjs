// kg70 solr: index Solr-eligible nodes (non-gene nodes + anchor genes) into core kg_<release>_b<BUILD_ID>.
// The core must already exist (kg70 shell creates it from solr/conf). Upserts by id; one commit at the end.
import fs from 'node:fs';
import readline from 'node:readline';
import { env, buildOut, exec, sqlStr, log } from './kgio.mjs';

const SOLR = env('SOLR_URL'); const CORE = process.env.SOLR_CORE ?? `kg_${env('RELEASE')}_b${env('BUILD_ID')}`;
const RELEASE = env('RELEASE'); const BUILD_ID = env('BUILD_ID');
const FINAL = sqlStr(buildOut('parquet', 'final', 'nodes.parquet'));
const EDGES = sqlStr(buildOut('parquet', 'graph', 'edges', '*.parquet'));
const nd = buildOut('work', 'solr_docs.ndjson');

// numeric part of an OBO / InterPro id, as the genes core's *__ancestors fields store it
const intId = (expr) => `try_cast(regexp_extract(${expr}, '([0-9]+)$', 1) AS BIGINT)`;
await exec(`CREATE TABLE src AS SELECT node, list(DISTINCT pks ORDER BY pks) AS sources FROM (
    SELECT subject AS node, primary_knowledge_source AS pks FROM read_parquet(${EDGES}, union_by_name=true)
    UNION ALL SELECT object, primary_knowledge_source FROM read_parquet(${EDGES}, union_by_name=true)) GROUP BY node`);
await exec(`COPY (
  SELECT n.id, n.category, n.cls, n.name, n.description, n.aliases, n.xrefs, n.in_taxon, n.genome, n.region, n.start, n."end",
         n.deg, n.degree, n.card, s.sources,
         json_extract_string(n.attrs, '$.system_name') AS system_name, json_extract_string(n.attrs, '$.biotype') AS biotype,
         coalesce(json_extract(n.attrs, '$.stub')::BOOLEAN, false) AS stub,
         CASE n.cls
           WHEN 'GeneModel' THEN 'id:' || split_part(n.id, ':', 2)
           WHEN 'GoTerm' THEN 'GO__ancestors:' || ${intId('n.id')}
           WHEN 'PlantAnatomyTerm' THEN 'PO__ancestors:' || ${intId('n.id')}
           WHEN 'PlantStageTerm' THEN 'PO__ancestors:' || ${intId('n.id')}
           WHEN 'TraitTerm' THEN '(TO__ancestors:' || ${intId('n.id')} || ' OR QTL_TO__ancestors:' || ${intId('n.id')} || ')'
           WHEN 'InterProEntry' THEN 'domains__ancestors:' || ${intId('n.id')}
           WHEN 'GeneTree' THEN 'gene_tree:' || split_part(n.id, ':', 2)
           WHEN 'KgCollection' THEN 'saved_search:' || split_part(n.id, ':', 2)
           WHEN 'GrameneTaxon' THEN 'taxonomy__ancestors:' || split_part(n.id, ':', 2)
           WHEN 'GenomeAssembly' THEN 'map:"' || json_extract_string(n.attrs, '$.release_map_id') || '"'
           WHEN 'QuantitativeTraitLocus' THEN '(map:"' || g.map || '" AND region:"' || n.region || '" AND start:[* TO ' || n."end" || '] AND end:[' || n.start || ' TO *])'
           WHEN 'TranscriptionFactorFamily' THEN 'Grassius__xrefs:"' || n.name || '"'
         END AS gene_fq
  FROM ${FINAL} n LEFT JOIN src s ON s.node = n.id
  LEFT JOIN (SELECT id, json_extract_string(attrs, '$.release_map_id') AS map FROM ${FINAL} WHERE cls = 'GenomeAssembly') g ON g.id = n.genome
  WHERE n.solr
) TO ${sqlStr(nd)} (FORMAT json)`);

const safe = (k) => k.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
const toDoc = (r) => {
  const d = { id: r.id, category_ss: r.category, category_leaf_s: r.cls, name_s: r.name, name_t: r.name, description_t: r.description,
    synonyms_t: r.aliases, aliases_lc_ss: r.aliases?.map(a => String(a).toLowerCase()), card_t: r.card, xref_ss: r.xrefs,
    release_s: RELEASE, build_s: BUILD_ID, taxon_s: r.in_taxon, genome_s: r.genome, system_name_s: r.system_name, biotype_s: r.biotype,
    region_s: r.region, start_l: r.start, end_l: r.end, degree_i: r.degree, source_ss: r.sources, is_stub_b: r.stub,
    has_publications_b: false, has_curated_b: false, gene_fq_s: r.gene_fq };
  const deg = JSON.parse(r.deg || '{}');
  for (const [k, v] of Object.entries(deg)) d[`deg_${safe(k)}`] = v;
  d.has_publications_b = (deg['biolink:mentions|in'] ?? 0) > 0;
  for (const k of Object.keys(d)) if (d[k] == null || (Array.isArray(d[k]) && !d[k].length)) delete d[k];
  return d;
};
const post = async (docs) => {
  const r = await fetch(`${SOLR}/${CORE}/update?wt=json`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(docs) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.responseHeader?.status !== 0) throw new Error(`solr update failed: ${r.status} ${JSON.stringify(j.error ?? j).slice(0, 400)}`);
};
let batch = []; let n = 0; const t0 = Date.now();
const rl = readline.createInterface({ input: fs.createReadStream(nd), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line) continue; batch.push(toDoc(JSON.parse(line)));
  if (batch.length >= 10000) { await post(batch); n += batch.length; batch = []; if (n % 100000 === 0) log(`solr ${n} docs, ${((Date.now() - t0) / 1000).toFixed(0)}s`); }
}
if (batch.length) { await post(batch); n += batch.length; }
const c = await fetch(`${SOLR}/${CORE}/update?commit=true&wt=json`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
if (!c.ok) throw new Error(`commit failed ${c.status}`);
fs.rmSync(nd);
log(`indexed ${n} docs into ${CORE} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
