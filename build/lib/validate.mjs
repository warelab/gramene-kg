// kg30 validate: gates over parquet/graph. Exit 1 on any failure (nothing is loaded).
// EXPECTATIONS_MODE=record (or a missing expectations.json) writes counts as the new expectations
// and only warns on count drift; check (default) fails on drift beyond the tolerance.
import fs from 'node:fs';
import path from 'node:path';
import { env, loadReleaseConfig, loadYaml, buildOut, q, exec, sqlStr, log } from './kgio.mjs';

const KG_ROOT = env('KG_ROOT');
const cfg = loadReleaseConfig();
const G = (kind) => sqlStr(buildOut('parquet', 'graph', kind, '*.parquet'));
const PREF = loadYaml(path.join(KG_ROOT, 'config/prefixes.yaml'));
const INFORES = loadYaml(path.join(KG_ROOT, 'config/infores.yaml'));
const ALLOW = loadYaml(path.join(KG_ROOT, 'config/known_dangling.yaml')).allow ?? [];
const EXP_FILE = path.join(cfg.release_cfg_dir, 'expectations.json');
const MODE = process.env.EXPECTATIONS_MODE || (fs.existsSync(EXP_FILE) ? 'check' : 'record');
const TOL = Number(process.env.EXPECTATIONS_TOLERANCE || 0.10);
const results = []; let failed = 0;
const gate = (name, ok, detail = '') => { results.push({ name, ok, detail }); if (!ok) failed++; log(`${ok ? '✓' : '✗ GATE FAILED:'} ${name}${detail ? ' — ' + detail : ''}`); };
const warn = (name, detail) => { results.push({ name, ok: true, warning: true, detail }); log(`⚠ ${name} — ${detail}`); };
const one = async (sql) => Number(Object.values((await q(sql))[0])[0]);

await exec(`CREATE VIEW nodes AS SELECT * FROM read_parquet(${G('nodes')}, union_by_name=true)`);
await exec(`CREATE VIEW edges AS SELECT * FROM read_parquet(${G('edges')}, union_by_name=true)`);
await exec(`CREATE TABLE node_ids AS SELECT id, cls FROM nodes`);

// ---- uniqueness ------------------------------------------------------------------------------
const dupN = await q(`SELECT id, list(DISTINCT cls) cls, count(*) n FROM node_ids GROUP BY id HAVING count(*) > 1 LIMIT 10`);
gate('node ids unique', dupN.length === 0, dupN.map(r => `${r.id} ${r.cls}`).join('; '));
const dupE = await one(`SELECT count(*) FROM (SELECT id FROM edges GROUP BY id HAVING count(*) > 1)`);
gate('edge ids unique', dupE === 0, `${dupE} duplicated`);

// ---- dangling edge ends ------------------------------------------------------------------------
const allowSql = ALLOW.length ? ALLOW.map(a => `(family = ${sqlStr(a.family)} AND regexp_matches(${a.end}, ${sqlStr(a.pattern)}))`).join(' OR ') : 'false';
await exec(`CREATE TABLE dangling AS
  SELECT family, 'subject' AS "end", subject AS id FROM edges e WHERE NOT EXISTS (SELECT 1 FROM node_ids n WHERE n.id = e.subject)
  UNION ALL
  SELECT family, 'object', object FROM edges e WHERE NOT EXISTS (SELECT 1 FROM node_ids n WHERE n.id = e.object)`);
await exec(`COPY (SELECT family, "end", count(*) AS n, list(DISTINCT id)[1:20] AS examples,
    bool_and(${ALLOW.length ? ALLOW.map(a => `(family = ${sqlStr(a.family)} AND regexp_matches(id, ${sqlStr(a.pattern)}))`).join(' OR ') : 'false'}) AS allowed
  FROM dangling GROUP BY ALL ORDER BY n DESC) TO ${sqlStr(buildOut('dangling_report.tsv'))} (HEADER, DELIMITER '\t')`);
const dang = await q(`SELECT family, "end", count(*)::BIGINT n, any_value(id) ex FROM dangling
  WHERE NOT (${ALLOW.length ? ALLOW.map(a => `(family = ${sqlStr(a.family)} AND regexp_matches(id, ${sqlStr(a.pattern)}))`).join(' OR ') : 'false'})
  GROUP BY ALL ORDER BY n DESC`);
gate('no dangling edge ends (after allowlist)', dang.length === 0, dang.map(d => `${d.family}.${d.end}: ${d.n} e.g. ${d.ex}`).join('; '));
void allowSql;

// ---- provenance ------------------------------------------------------------------------------
const KL = ['knowledge_assertion', 'logical_entailment', 'prediction', 'statistical_association', 'observation', 'text_co_occurrence', 'not_provided'];
const AT = ['manual_agent', 'automated_agent', 'data_analysis_pipeline', 'computational_model', 'text_mining_agent', 'image_processing_agent',
  'manual_validation_of_automated_agent', 'not_provided'];
const nullProv = await q(`SELECT family, count(*)::BIGINT n FROM edges WHERE primary_knowledge_source IS NULL OR knowledge_level IS NULL
  OR agent_type IS NULL OR layer IS NULL OR predicate IS NULL GROUP BY 1`);
gate('required provenance present on every edge', nullProv.length === 0, nullProv.map(r => `${r.family}:${r.n}`).join(', '));
const badEnum = await q(`SELECT family, knowledge_level, agent_type, count(*)::BIGINT n FROM edges
  WHERE knowledge_level NOT IN (${KL.map(sqlStr)}) OR agent_type NOT IN (${AT.map(sqlStr)}) GROUP BY ALL`);
gate('knowledge_level / agent_type are Biolink 4.4.6 enum values', badEnum.length === 0, JSON.stringify(badEnum));
const infores = Object.keys(INFORES);
const badInf = await q(`SELECT DISTINCT primary_knowledge_source s FROM edges WHERE primary_knowledge_source NOT IN (${infores.map(sqlStr)})`);
gate('primary_knowledge_source listed in config/infores.yaml', badInf.length === 0, badInf.map(r => r.s).join(', '));
const unreg = infores.filter(k => !INFORES[k].registered);
const usedUnreg = (await q(`SELECT DISTINCT primary_knowledge_source s FROM edges WHERE primary_knowledge_source IN (${unreg.map(sqlStr)})`)).map(r => r.s);
if (usedUnreg.length) warn('provisional infores ids in use (not yet in the registry)', usedUnreg.join(', '));
const badEco = await q(`SELECT DISTINCT e FROM (SELECT unnest(has_evidence) e FROM edges) WHERE e NOT IN (SELECT id FROM nodes WHERE cls = 'EvidenceCodeTerm')`);
gate('every has_evidence ECO id is an EvidenceCodeTerm node', badEco.length === 0, badEco.map(r => r.e).join(', '));
const stageExpr = await one(`SELECT count(*) FROM edges e JOIN node_ids n ON n.id = e.object WHERE e.predicate = 'biolink:expressed_in' AND n.cls = 'PlantStageTerm'`);
gate('no expressed_in edge points at a PO stage term', stageExpr === 0, `${stageExpr} found`);
const maxQ = await q(`SELECT object, count(*)::BIGINT n FROM edges WHERE family = 'gene_qtl' GROUP BY 1 ORDER BY 2 DESC LIMIT 1`);
gate('per-QTL containment fan-out <= 10,000', !maxQ.length || maxQ[0].n <= 10000, maxQ.length ? `max ${maxQ[0].n} (${maxQ[0].object})` : '');

// ---- id patterns ----------------------------------------------------------------------------
const rules = [...Object.entries(PREF.external).map(([p, v]) => [p, v.pattern]), ...Object.entries(PREF.local)];
const caseSql = rules.map(([p, re]) => `WHEN prefix = ${sqlStr(p)} THEN regexp_full_match(local, ${sqlStr(re.replace(/^\^|\$$/g, ''))})`).join(' ');
const badIds = await q(`SELECT cls, prefix, count(*)::BIGINT n, any_value(id) ex FROM (
    SELECT id, cls, split_part(id, ':', 1) AS prefix, substr(id, length(split_part(id, ':', 1)) + 2) AS local FROM node_ids)
  WHERE NOT coalesce(CASE ${caseSql} ELSE false END, false) GROUP BY ALL ORDER BY n DESC`);
gate('every node id matches config/prefixes.yaml', badIds.length === 0, badIds.map(r => `${r.cls} ${r.prefix}:${r.n} e.g. ${r.ex}`).join('; '));
const slashIds = await one(`SELECT count(*) FROM node_ids WHERE id LIKE '%/%' AND NOT starts_with(id, 'doi:')`);
gate('no local id contains "/"', slashIds === 0, `${slashIds}`);

// ---- anchor-restricted cross-checks against the live genes core --------------------------------
const anchorTaxa = (await q(`SELECT DISTINCT json_extract(attrs, '$.release_taxon_id')::BIGINT t FROM nodes WHERE cls = 'GenomeAssembly' AND json_extract(attrs, '$.is_anchor')::BOOLEAN`)).map(r => r.t);
const solrCount = async (fq) => {
  const u = `${env('SOLR_URL')}/${cfg.genes_core}/select?q=*:*&rows=0&wt=json&fq=${encodeURIComponent(fq)}&fq=${encodeURIComponent(`taxon_id:(${anchorTaxa.join(' ')})`)}`;
  try { return (await (await fetch(u, { signal: AbortSignal.timeout(30000) })).json()).response.numFound; } catch { return null; }
};
const cross = [
  ['genes with GO edges', `SELECT count(DISTINCT subject) FROM edges WHERE family = 'gene_go'`, 'capabilities:GO', 0.001],
  ['genes with a current InterPro edge', `SELECT count(DISTINCT subject) FROM edges e JOIN nodes n ON n.id = e.object WHERE e.family = 'gene_domain' AND NOT coalesce(json_extract(n.attrs, '$.stub')::BOOLEAN, false)`, 'capabilities:domains', 0.001],
  ['genes with publication mentions', `SELECT count(DISTINCT object) FROM edges WHERE family = 'pub_mentions' AND starts_with(object, 'gramene.gene:')`, 'capabilities:pubs', 0.02],
  ['genes inside a QTL', `SELECT count(DISTINCT subject) FROM edges WHERE family = 'gene_qtl'`, 'capabilities:QTL_TO', 0.05],
  ['genes with a pathway edge', `SELECT count(DISTINCT subject) FROM edges WHERE family = 'gene_pathway'`, 'capabilities:pathways', 0.01],
];
const crossOut = {};
for (const [name, sql, fq, tol] of cross) {
  const kg = await one(sql); const solr = await solrCount(fq);
  crossOut[name] = { kg, solr };
  if (solr == null) { warn(`cross-check ${name}`, 'Solr unreachable'); continue; }
  const rel = solr ? Math.abs(kg - solr) / solr : (kg ? 1 : 0);
  gate(`cross-check ${name}: kg ${kg} vs ${cfg.genes_core} ${solr}`, rel <= tol, `${(rel * 100).toFixed(2)}% (tolerance ${(tol * 100).toFixed(1)}%)`);
}

// ---- JSON Schema sample (edges carry the provenance contract) ------------------------------------
const sample = await q(`SELECT id, subject, predicate, object, primary_knowledge_source, knowledge_level, agent_type, layer, has_evidence, publications
  FROM edges USING SAMPLE 2000 ROWS`);
fs.writeFileSync(buildOut('work', 'edge_sample.json'), JSON.stringify(sample.map(r => ({
  id: `gramene.assoc:${r.id}`, subject: r.subject, predicate: r.predicate, object: r.object, category: ['gramene:GrameneAssociation'],
  primary_knowledge_source: r.primary_knowledge_source, knowledge_level: r.knowledge_level, agent_type: r.agent_type, layer: r.layer,
  ...(r.has_evidence?.length ? { has_evidence: r.has_evidence } : {}), ...(r.publications?.length ? { publications: r.publications } : {}),
}))));

// ---- counts & expectations ------------------------------------------------------------------------
const counts = {
  nodes: Object.fromEntries((await q(`SELECT cls, count(*)::BIGINT n FROM node_ids GROUP BY 1 ORDER BY 1`)).map(r => [r.cls, Number(r.n)])),
  edges: Object.fromEntries((await q(`SELECT family, count(*)::BIGINT n FROM edges GROUP BY 1 ORDER BY 1`)).map(r => [r.family, Number(r.n)])),
  edges_materialised: await one(`SELECT count(*) FROM edges WHERE NOT slot`),
  edges_slot: await one(`SELECT count(*) FROM edges WHERE slot`),
  solr_docs: await one(`SELECT count(*) FROM nodes WHERE cls NOT IN ('GeneModel') OR json_extract(attrs, '$.anchor')::BOOLEAN`),
  cross_checks: crossOut,
};
counts.nodes_total = Object.values(counts.nodes).reduce((a, b) => a + b, 0);
counts.edges_total = Object.values(counts.edges).reduce((a, b) => a + b, 0);
fs.writeFileSync(buildOut('counts.json'), JSON.stringify(counts, null, 1));
const NO_GATE = new Set(['KgCollection', 'collection_member', 'KgDistribution', 'KgDataset', 'IngestRun', 'SoftwareAgent', 'AnalysisRun']);
if (MODE === 'record') {
  const exp = { recorded_at: new Date().toISOString(), build_id: env('BUILD_ID'), tolerance: TOL, nodes: counts.nodes, edges: counts.edges,
    not_gated: [...NO_GATE] };
  if (fs.existsSync(EXP_FILE)) { const old = JSON.parse(fs.readFileSync(EXP_FILE, 'utf8')); exp.nodes = { ...old.nodes, ...exp.nodes }; exp.edges = { ...old.edges, ...exp.edges }; }
  fs.writeFileSync(EXP_FILE, JSON.stringify(exp, null, 1) + '\n');
  warn('expectations', `recorded to ${EXP_FILE} (record mode; counts are not gated this run)`);
} else {
  const exp = JSON.parse(fs.readFileSync(EXP_FILE, 'utf8'));
  for (const kind of ['nodes', 'edges']) for (const [k, want] of Object.entries(exp[kind])) {
    if (NO_GATE.has(k)) continue;
    const have = counts[kind][k] ?? 0;
    if (have === 0 && process.env.NO_VARIANTS === '1' && /variant|lof|expressed|expression_detected/.test(k)) continue;
    const rel = want ? Math.abs(have - want) / want : (have ? 1 : 0);
    if (rel > (exp.tolerance ?? TOL)) gate(`count ${kind}.${k} ${have} within ${(exp.tolerance ?? TOL) * 100}% of ${want}`, false);
  }
  const newKeys = ['nodes', 'edges'].flatMap(kind => Object.keys(counts[kind]).filter(k => !(k in exp[kind])).map(k => `${kind}.${k}`));
  if (newKeys.length) gate('no unexpected node classes / edge families (re-record expectations to add)', false, newKeys.join(', '));
  else gate('counts within expectations', true, `tolerance ${(exp.tolerance ?? TOL) * 100}%`);
}

fs.writeFileSync(buildOut('validation.json'), JSON.stringify({ mode: MODE, failed, results }, null, 1));
log(`validation: ${results.length} checks, ${failed} failed (mode ${MODE})`);
process.exit(failed ? 1 : 0);
