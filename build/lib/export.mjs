// kg50 export: KGX TSV + KGX JSON lines (whole graph and per primary knowledge source), a
// Biolink-native validation sample, the JSON-LD context, manifest.json, manifest.sha256 and
// ro-crate-metadata.json under BUILD_OUT.
//
// KGX is a Biolink-flattened projection: gramene: predicates are written as the nearest Biolink
// predicate with the gramene CURIE in original_predicate; categories are the node's non-mixin
// Biolink classes, the profile class goes in gramene:class. Mongo and the API keep gramene: predicates.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { env, loadReleaseConfig, buildOut, sha256File, q, exec, sqlStr, log } from './kgio.mjs';

const RELEASE = env('RELEASE'); const BUILD_ID = env('BUILD_ID'); const KG_ROOT = env('KG_ROOT');
const cfg = loadReleaseConfig();
const OUT = (...p) => buildOut('kgx', ...p);
const base = `gramene-kg_${RELEASE}_${BUILD_ID}`;
fs.rmSync(buildOut('kgx'), { recursive: true, force: true }); fs.mkdirSync(OUT('by_source'), { recursive: true });
fs.mkdirSync(OUT('sample'), { recursive: true }); fs.mkdirSync(buildOut('jsonld'), { recursive: true });

// nearest Biolink predicate for gramene:/prov: predicates (each is_a in the LinkML profile)
const KGX_PRED = { 'gramene:has_domain': 'biolink:has_part' };
const predSql = `CASE WHEN starts_with(predicate, 'biolink:') THEN predicate ${Object.entries(KGX_PRED).map(([k, v]) => `WHEN predicate = ${sqlStr(k)} THEN ${sqlStr(v)}`).join(' ')} ELSE 'biolink:related_to' END`;
// TSV text: no tabs/newlines, and '|' (the KGX list delimiter) becomes '¦' so free text is not split into lists
const txt = (c) => `replace(regexp_replace(${c}, '[\\t\\r\\n]+', ' ', 'g'), '|', '¦')`;
const pipe = (c) => `array_to_string(${c}, '|')`;

await exec(`CREATE VIEW n AS SELECT * FROM read_parquet(${sqlStr(buildOut('parquet', 'final', 'nodes.parquet'))})`);
await exec(`CREATE VIEW e AS SELECT * FROM read_parquet(${sqlStr(buildOut('parquet', 'graph', 'edges', '*.parquet'))}, union_by_name=true)`);
const runId = (await q(`SELECT id FROM read_parquet(${sqlStr(buildOut('parquet', 'nodes', 'IngestRun.parquet'))}) LIMIT 1`))[0]?.id ?? null;

// one SELECT per format; TSV joins lists with '|', JSON lines keep arrays and nested objects
const nodeCols = (fmt) => fmt === 'tsv' ? `id, ${pipe('category')} AS category, ${txt('name')} AS name, ${txt('description')} AS description,
    ${pipe('xrefs')} AS xref, ${pipe(`list_transform(aliases, lambda a: ${txt('a')})`)} AS synonym, in_taxon, ${sqlStr(`infores:gramene-kg`)} AS provided_by,
    cls AS "gramene:class", genome AS "gramene:genome", tree AS "gramene:gene_tree", region AS "gramene:region", start AS "gramene:start", "end" AS "gramene:end",
    strand AS "gramene:strand", ${txt('attrs')} AS "gramene:attributes"`
  : `id, category, name, description, xrefs AS xref, aliases AS synonym, in_taxon, ['infores:gramene-kg'] AS provided_by, cls AS "gramene:class",
    genome AS "gramene:genome", tree AS "gramene:gene_tree", region AS "gramene:region", start AS "gramene:start", "end" AS "gramene:end",
    strand AS "gramene:strand", json(attrs) AS "gramene:attributes"`;
const edgeCols = (fmt) => {
  const L = fmt === 'tsv' ? pipe : (c) => c;
  // KGX's TSV reader applies bool() to the text, so 'false' would read back as true: false is written empty
  const T = fmt === 'tsv' ? txt : (c) => c;
  return `'gramene.assoc:' || id AS id, subject, ${predSql} AS predicate, object,
    CASE WHEN starts_with(predicate, 'biolink:') THEN NULL ELSE predicate END AS original_predicate,
    primary_knowledge_source, ${L('aggregator_knowledge_source')} AS aggregator_knowledge_source, knowledge_level, agent_type,
    ${L('has_evidence')} AS has_evidence, ${T('original_evidence')} AS "gramene:original_evidence", ${L('publications')} AS publications,
    ${L('has_supporting_studies')} AS has_supporting_studies,
    ${fmt === 'tsv' ? `CASE WHEN negated THEN 'true' END` : 'negated'} AS negated, original_subject, original_object,
    knowledge_source_version AS "gramene:knowledge_source_version", ${T('method')} AS "gramene:method", ${T('source_record')} AS "gramene:source_record",
    ${sqlStr(`gramene.release:${RELEASE}`)} AS "gramene:release", ${sqlStr(runId)} AS "gramene:ingest_run", layer AS "gramene:layer",
    family AS "gramene:family", slot AS "gramene:slot", ${fmt === 'tsv' ? 'qualifiers' : 'json(qualifiers)'} AS "gramene:qualifiers"`;
};
const copyTsv = (sel, file) => exec(`COPY (${sel}) TO ${sqlStr(file)} (FORMAT csv, DELIMITER '\t', HEADER true, QUOTE '', ESCAPE '', NULLSTR '', COMPRESSION gzip)`);
const copyJsonl = (sel, file) => exec(`COPY (${sel}) TO ${sqlStr(file)} (FORMAT json, COMPRESSION gzip)`);

const files = [];
async function emit(kind, sel, file) {
  const t0 = Date.now();
  if (file.includes('.tsv')) await copyTsv(sel, file); else await copyJsonl(sel, file);
  files.push(file); log(`${kind} ${path.relative(buildOut(), file)} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
// TSV with QUOTE '' cannot carry tabs/newlines: text columns are flattened above; ids never contain them
const [{ bad }] = await q(`SELECT count(*)::BIGINT bad FROM e WHERE regexp_matches(coalesce(qualifiers, '') || coalesce(original_subject, '') || coalesce(original_object, '') || coalesce(source_record, ''), '[\\t\\n\\r]')`);
if (Number(bad)) throw new Error(`${bad} edges have tab/newline in qualifiers/original ids/source_record; TSV export would be corrupt`);

await emit('nodes', `SELECT ${nodeCols('tsv')} FROM n`, OUT(`${base}_nodes.tsv.gz`));
await emit('edges', `SELECT ${edgeCols('tsv')} FROM e`, OUT(`${base}_edges.tsv.gz`));
await emit('nodes', `SELECT ${nodeCols('json')} FROM n`, OUT(`${base}_nodes.jsonl.gz`));
await emit('edges', `SELECT ${edgeCols('json')} FROM e`, OUT(`${base}_edges.jsonl.gz`));

// per-source edge files (TSV) with their counts
const sources = await q(`SELECT primary_knowledge_source AS s, count(*)::BIGINT n FROM e GROUP BY 1 ORDER BY 1`);
for (const { s } of sources) await emit('source', `SELECT ${edgeCols('tsv')} FROM e WHERE primary_knowledge_source = ${sqlStr(s)}`,
  OUT('by_source', `${base}_${s.replace(/^infores:/, '')}_edges.tsv.gz`));

// Biolink-native sample: 1% of edges per family whose stored predicate is already Biolink, plus every node they touch
await exec(`CREATE TABLE sample_e AS SELECT * FROM e WHERE starts_with(predicate, 'biolink:') AND hash(id) % 100 = 0`);
await exec(`CREATE TABLE sample_n AS SELECT n.* FROM n SEMI JOIN (SELECT subject AS id FROM sample_e UNION SELECT object FROM sample_e) x ON x.id = n.id`);
await copyTsv(`SELECT ${nodeCols('tsv')} FROM sample_n`, OUT('sample', 'sample_nodes.tsv.gz'));
await copyTsv(`SELECT ${edgeCols('tsv')} FROM sample_e`, OUT('sample', 'sample_edges.tsv.gz'));
// KGX's TSV reader turns in_taxon into a list while its validator wants a string, so the gate runs on JSON lines
await copyJsonl(`SELECT ${nodeCols('json')} FROM sample_n`, OUT('sample', 'sample_nodes.jsonl.gz'));
await copyJsonl(`SELECT ${edgeCols('json')} FROM sample_e`, OUT('sample', 'sample_edges.jsonl.gz'));
const [sampleCounts] = await q(`SELECT (SELECT count(*) FROM sample_n)::BIGINT nodes, (SELECT count(*) FROM sample_e)::BIGINT edges`);
log(`sample: ${sampleCounts.nodes} nodes, ${sampleCounts.edges} edges`);

// JSON-LD context (generated from the LinkML profile); KGX JSON lines + this context read as JSON-LD
const ctxSrc = path.join(KG_ROOT, 'schema', 'generated', 'jsonld', 'context.jsonld');
fs.copyFileSync(ctxSrc, buildOut('jsonld', 'context.jsonld')); files.push(buildOut('jsonld', 'context.jsonld'));

// ---- counts, manifest, checksums, RO-Crate -------------------------------------------------------
const [tot] = await q(`SELECT (SELECT count(*) FROM n)::BIGINT nodes, (SELECT count(*) FROM e)::BIGINT edges`);
const counts = JSON.parse(fs.readFileSync(buildOut('counts.json'), 'utf8'));
if (Number(tot.nodes) !== counts.nodes_total || Number(tot.edges) !== counts.edges_total)
  throw new Error(`export counts ${tot.nodes}/${tot.edges} != counts.json ${counts.nodes_total}/${counts.edges_total}`);
const describe = async (f) => ({ path: path.relative(buildOut(), f), bytes: fs.statSync(f).size, sha256: await sha256File(f) });
const kgxFiles = [];
for (const f of files) kgxFiles.push(await describe(f));
const schemaFile = path.join(KG_ROOT, 'schema', 'gramene_kg.yaml');
const git = (() => { try { return execFileSync('git', ['-C', KG_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return null; } })();
const manifest = {
  release: RELEASE, build_id: BUILD_ID, ingest_run: runId, generated_at: new Date().toISOString(),
  biolink_version: '4.4.6', schema: { path: 'schema/gramene_kg.yaml', sha256: await sha256File(schemaFile) }, git_head: git,
  counts: { nodes: Number(tot.nodes), edges: Number(tot.edges), edges_by_source: Object.fromEntries(sources.map(r => [r.s, Number(r.n)])) },
  kgx: { format: 'KGX TSV (lists joined with |) and KGX JSON lines', predicate_projection: { ...KGX_PRED, default_non_biolink: 'biolink:related_to' },
    sample: { nodes: Number(sampleCounts.nodes), edges: Number(sampleCounts.edges), rule: '1% of edges with a Biolink predicate (hash(id) % 100 = 0) and the nodes they reference' } },
  files: kgxFiles,
};
fs.writeFileSync(buildOut('manifest.json'), JSON.stringify(manifest, null, 1));

// manifest.sha256: every artifact under the build dir (sha256sum -c format), except itself and the DuckDB scratch db
const all = [];
const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name);
  if (f.isDirectory()) walk(p); else if (f.isFile() && !['manifest.sha256', 'kg.duckdb', 'kg.duckdb.wal', 'ro-crate-metadata.json'].includes(f.name)) all.push(p); } };
walk(buildOut());
const known = new Map(kgxFiles.map(f => [f.path, f.sha256]));
const lines = [];
for (const f of all.sort()) { const rel = path.relative(buildOut(), f); lines.push(`${known.get(rel) ?? await sha256File(f)}  ${rel}`); }
fs.writeFileSync(buildOut('manifest.sha256'), lines.join('\n') + '\n');
log(`manifest.sha256: ${lines.length} files`);

// RO-Crate 1.1
const crate = {
  '@context': 'https://w3id.org/ro/crate/1.1/context',
  '@graph': [
    { '@id': 'ro-crate-metadata.json', '@type': 'CreativeWork', conformsTo: { '@id': 'https://w3id.org/ro/crate/1.1' }, about: { '@id': './' } },
    { '@id': './', '@type': 'Dataset', name: `Gramene knowledge graph, ${RELEASE} build ${BUILD_ID}`,
      description: `Knowledge graph of ${cfg.site} release ${RELEASE}: ${tot.nodes} nodes, ${tot.edges} edges with per-edge provenance (Biolink 4.4.6 / KGX).`,
      datePublished: new Date().toISOString().slice(0, 10), version: BUILD_ID, license: { '@id': 'https://creativecommons.org/licenses/by/4.0/' },
      publisher: { '@id': 'https://www.sorghumbase.org' }, isBasedOn: { '@id': `gramene.release:${RELEASE}` },
      conformsTo: [{ '@id': 'https://w3id.org/biolink/vocab/' }, { '@id': 'https://github.com/biolink/kgx' }],
      hasPart: [...kgxFiles.map(f => ({ '@id': f.path })), { '@id': 'manifest.json' }, { '@id': 'manifest.sha256' }] },
    { '@id': 'https://www.sorghumbase.org', '@type': 'Organization', name: 'SorghumBase' },
    { '@id': `gramene.release:${RELEASE}`, '@type': 'Dataset', name: `${cfg.site} ${RELEASE}` },
    ...kgxFiles.map(f => ({ '@id': f.path, '@type': 'File', contentSize: String(f.bytes), sha256: f.sha256,
      encodingFormat: f.path.endsWith('.tsv.gz') ? 'text/tab-separated-values' : f.path.endsWith('.jsonl.gz') ? 'application/x-ndjson' : 'application/ld+json' })),
    { '@id': 'manifest.json', '@type': 'File', encodingFormat: 'application/json' },
    { '@id': 'manifest.sha256', '@type': 'File', encodingFormat: 'text/plain' },
  ],
};
fs.writeFileSync(buildOut('ro-crate-metadata.json'), JSON.stringify(crate, null, 1));
log(`export complete: ${kgxFiles.length} files, ${(kgxFiles.reduce((a, f) => a + f.bytes, 0) / 1e9).toFixed(2)} GB`);
