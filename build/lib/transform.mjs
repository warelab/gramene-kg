// kg20 transform: extract NDJSON -> normalised node and edge Parquet (BUILD_OUT/parquet/graph/).
//
// Node table schema (every class):
//   id, category[], cls, name, description, aliases[], xrefs[], in_taxon, genome, tree,
//   region, start, end, strand, attrs (JSON text)
// Edge table schema (every family):
//   id, subject, predicate, object, primary_knowledge_source, aggregator_knowledge_source[],
//   knowledge_level, agent_type, has_evidence[], original_evidence, publications[],
//   has_supporting_studies[], method, original_subject, original_object, source_record,
//   knowledge_source_version, negated, layer, qualifiers (JSON text), family, slot
// slot = true marks N:1 relations kept as node fields in Mongo and emitted as edges only in KGX.
import fs from 'node:fs';
import path from 'node:path';
import { env, loadReleaseConfig, loadYaml, buildOut, NdjsonWriter, exec, q, sqlStr, log } from './kgio.mjs';

const KG_ROOT = env('KG_ROOT');
const RELEASE = env('RELEASE');
const NO_VARIANTS = process.env.NO_VARIANTS === '1';
const cfg = loadReleaseConfig();
const EV = loadYaml(path.join(KG_ROOT, 'config/evidence-map.yaml'));
const X = (n) => sqlStr(buildOut('extract', `${n}.ndjson`));
const SNAP = (n) => buildOut('extract', 'snapshots', `${n}.json`);
const GRAPH = (kind, name) => buildOut('parquet', 'graph', kind, `${name}.parquet`);
const CFG = (f) => path.join(cfg.release_cfg_dir, f);
const counts = { nodes: {}, edges: {}, dropped: {} };

// versions recorded by kg05 (release-tree versions are what these edges were built from)
const catDatasets = await q(`SELECT id, version FROM ${sqlStr(buildOut('parquet', 'nodes', 'KgDataset.parquet'))}`);
const dsVersion = (prefix) => catDatasets.find(d => d.id.startsWith(`gramene.dataset:${prefix}@`))?.version ?? null;
const V = { go: dsVersion('release-tree-go'), interpro: dsVersion('release-tree-interpro'), compara: dsVersion('ensembl-compara'),
  reactome: dsVersion('ontology-db-plant_reactome_genes'), po: dsVersion('release-tree-po'), to: dsVersion('release-tree-to') };
const analyses = await q(`SELECT id FROM ${sqlStr(buildOut('parquet', 'nodes', 'AnalysisRun.parquet'))}`);
const QTL_METHOD = analyses.find(a => a.id.startsWith('gramene.analysis:qtl-containment@'))?.id ?? 'qtl-containment';

// ---------------------------------------------------------------------------------------------
// SQL builders
// ---------------------------------------------------------------------------------------------
const L = (a) => a == null ? 'NULL::VARCHAR' : sqlStr(a);
const LIST = (arr) => (arr && arr.length) ? `[${arr.map(sqlStr).join(',')}]::VARCHAR[]` : '[]::VARCHAR[]';

function nodeSql(cls, category, from, f) {
  const c = (k, d) => f[k] ?? d;
  return `SELECT
    (${f.id})::VARCHAR AS id, ${c('category', LIST(category))} AS category, ${sqlStr(cls)} AS cls,
    (${c('name', 'NULL')})::VARCHAR AS name, (${c('description', 'NULL')})::VARCHAR AS description,
    (${c('aliases', '[]::VARCHAR[]')})::VARCHAR[] AS aliases, (${c('xrefs', '[]::VARCHAR[]')})::VARCHAR[] AS xrefs,
    (${c('in_taxon', 'NULL')})::VARCHAR AS in_taxon, (${c('genome', 'NULL')})::VARCHAR AS genome, (${c('tree', 'NULL')})::VARCHAR AS tree,
    (${c('region', 'NULL')})::VARCHAR AS region, (${c('start', 'NULL')})::BIGINT AS start, (${c('end', 'NULL')})::BIGINT AS "end",
    (${c('strand', 'NULL')})::INTEGER AS strand, (${c('attrs', "'{}'")})::VARCHAR AS attrs
  FROM ${from}`;
}

// prov: {pks, kl, at, ev[]} constants or SQL expressions (prefix 'sql:')
const P = (v) => (typeof v === 'string' && v.startsWith('sql:')) ? v.slice(4) : L(v);
const PL = (v) => (typeof v === 'string' && v.startsWith('sql:')) ? v.slice(4) : LIST(v);
function edgeSql(family, from, e) {
  const quals = e.qualifiers ?? "'{}'";
  return `SELECT
    substr(sha256(concat_ws('|', s, p, o, pks, qual)), 1, 24) AS id,
    s AS subject, p AS predicate, o AS object, pks AS primary_knowledge_source,
    ['infores:gramene-kg', 'infores:sorghumbase']::VARCHAR[] AS aggregator_knowledge_source,
    kl AS knowledge_level, agt AS agent_type, ev AS has_evidence, oev AS original_evidence,
    pubs AS publications, studies AS has_supporting_studies, method, osubj AS original_subject, oobj AS original_object,
    rec AS source_record, ksv AS knowledge_source_version, neg AS negated, 'etl' AS layer, qual AS qualifiers,
    ${sqlStr(family)} AS family, ${e.slot ? 'true' : 'false'} AS slot
  FROM (SELECT
    (${e.subject})::VARCHAR AS s, (${e.predicate})::VARCHAR AS p, (${e.object})::VARCHAR AS o,
    (${P(e.pks)})::VARCHAR AS pks, (${P(e.kl)})::VARCHAR AS kl, (${P(e.at)})::VARCHAR AS agt,
    (${PL(e.ev)})::VARCHAR[] AS ev, (${e.oev ?? 'NULL'})::VARCHAR AS oev,
    (${e.pubs ?? '[]::VARCHAR[]'})::VARCHAR[] AS pubs, (${e.studies ?? '[]::VARCHAR[]'})::VARCHAR[] AS studies,
    (${P(e.method)})::VARCHAR AS method, (${e.osubj ?? 'NULL'})::VARCHAR AS osubj, (${e.oobj ?? 'NULL'})::VARCHAR AS oobj,
    (${P(e.rec)})::VARCHAR AS rec, (${P(e.ksv)})::VARCHAR AS ksv, (${e.negated ?? 'false'})::BOOLEAN AS neg, (${quals})::VARCHAR AS qual
    FROM ${from}) t
  WHERE s IS NOT NULL AND o IS NOT NULL`;
}

async function writeNodes(cls, sql) {
  const p = GRAPH('nodes', cls);
  await exec(`COPY (${sql}) TO ${sqlStr(p)} (FORMAT parquet, COMPRESSION zstd)`);
  const [{ n }] = await q(`SELECT count(*)::BIGINT n FROM ${sqlStr(p)}`);
  counts.nodes[cls] = Number(n); log(`nodes ${cls}: ${n}`);
}
async function writeEdges(family, sql) {
  const p = GRAPH('edges', family);
  await exec(`COPY (${sql}) TO ${sqlStr(p)} (FORMAT parquet, COMPRESSION zstd)`);
  const [{ n }] = await q(`SELECT count(*)::BIGINT n FROM ${sqlStr(p)}`);
  counts.edges[family] = Number(n); log(`edges ${family}: ${n}`);
}

// ---------------------------------------------------------------------------------------------
// staging views over extract NDJSON
// ---------------------------------------------------------------------------------------------
const rj = (n) => `read_json_auto(${X(n)}, format='newline_delimited', sample_size=-1)`;
await exec(`CREATE TABLE maps AS SELECT * FROM ${rj('maps')}`);
await exec(`CREATE TABLE genome_ids AS SELECT map_id, system_name, taxon_id, anchor_taxon_id, is_anchor,
  CASE WHEN regexp_matches(map_id, '^GCA_[0-9]{9}(\\.[0-9]+)?$') THEN 'insdc.gca:' || map_id ELSE 'gramene.genome:' || system_name END AS gid
  FROM maps`);
await exec(`CREATE TABLE genes AS SELECT g.*, m.gid, 'NCBITaxon:' || m.anchor_taxon_id AS tax FROM ${rj('genes')} g JOIN genome_ids m ON g.map = m.map_id`);
const [{ ng }] = await q(`SELECT count(*)::BIGINT ng FROM genes`);
log(`genes staged: ${ng}`);
await exec(`CREATE TABLE anchor_genes AS SELECT id, system_name, taxon_id FROM genes WHERE anchor`);
await exec(`CREATE TABLE xref AS SELECT x.*, g.system_name FROM ${rj('gene_xref')} x JOIN anchor_genes g ON g.id = x.gene`);
for (const o of ['go', 'po', 'to', 'eco']) await exec(`CREATE TABLE ont_${o} AS SELECT * FROM ${rj('ont_' + o)}`);
await exec(`CREATE TABLE go_alt AS SELECT unnest(alt_ids) AS alt, id FROM ont_go WHERE len(alt_ids) > 0`);

// ---------------------------------------------------------------------------------------------
// NODES
// ---------------------------------------------------------------------------------------------
await writeNodes('GeneModel', nodeSql('GeneModel', ['biolink:Gene'], 'genes', {
  id: `'gramene.gene:' || id`, name: `coalesce(name, id)`, description: `regexp_replace(description, '\\s*\\[Source:[^\\]]*\\]', '')`,
  aliases: `list_distinct(list_concat(coalesce(alt_id, []), coalesce(synonyms, [])))`,
  in_taxon: 'tax', genome: 'gid', tree: `CASE WHEN tree IS NULL THEN NULL ELSE 'gramene.genetree:' || tree END`,
  region: 'region', start: 'start', end: '"end"', strand: 'strand',
  attrs: `to_json({biotype: biotype, system_name: system_name, release_taxon_id: taxon_id, anchor: anchor, db_type: db_type,
    description_source: regexp_extract(description, '\\[Source:([^\\]]*)\\]', 1),
    representative_closest: rep_closest, representative_closest_pid: rep_closest_pid,
    representative_model: rep_model, representative_model_pid: rep_model_pid, tree_root_taxon_id: tree_root_taxon_id})`,
}));

await writeNodes('GenomeAssembly', nodeSql('GenomeAssembly', ['biolink:Genome'], `maps m JOIN genome_ids g USING (map_id)`, {
  id: 'g.gid', name: 'm.display_name', in_taxon: `'NCBITaxon:' || m.anchor_taxon_id`, aliases: `[m.system_name, m.map_id]`,
  attrs: `to_json({system_name: m.system_name, release_map_id: m.map_id, core_db: m.core_db,
    ensembl_release: try_cast(regexp_extract(m.core_db, '_core_[0-9]+_([0-9]+)_', 1) AS INTEGER),
    release_taxon_id: m.taxon_id, is_anchor: m.is_anchor, in_compara: m.in_compara, length: m.length, num_genes: m.num_genes})`,
}));

// taxa: release taxonomy minus genome rank; NCBI-resolved else synthetic
await exec(`CREATE TABLE taxa AS
  SELECT t.taxon_id, coalesce(n.name, t.name) AS name, coalesce(n.rank, t.rank) AS rank, t.parent,
         (n.taxon_id IS NULL AND m.taxon_id IS NULL) AS synthetic,
         CASE WHEN n.taxon_id IS NULL AND m.taxon_id IS NULL THEN 'gramene.taxon:' ELSE 'NCBITaxon:' END || t.taxon_id AS tid
  FROM ${rj('taxonomy')} t
  LEFT JOIN ${rj('ont_ncbi_taxonomy')} n ON n.taxon_id = t.taxon_id
  LEFT JOIN ${rj('ont_ncbi_merged')} m ON m.taxon_id = t.taxon_id
  WHERE t.rank IS DISTINCT FROM 'genome'`);
await writeNodes('GrameneTaxon', nodeSql('GrameneTaxon', ['biolink:OrganismTaxon'], 'taxa', {
  id: 'tid', name: 'name', attrs: `to_json({rank: rank, synthetic: synthetic})` }));

await exec(`CREATE TABLE trees AS SELECT * FROM ${rj('trees')}`);
await writeNodes('GeneTree', nodeSql('GeneTree', ['biolink:GeneFamily'], 'trees tr LEFT JOIN taxa tx ON tx.taxon_id = tr.root_taxon_id', {
  id: `'gramene.genetree:' || tr.id`, name: `tr.id || coalesce(' (' || tr.root_taxon_name || ')', '')`,
  in_taxon: `CASE WHEN tr.root_taxon_id IS NULL THEN NULL ELSE coalesce(tx.tid, 'NCBITaxon:' || tr.root_taxon_id) END`,
  attrs: `to_json({compara_db: tr.compara_db, root_taxon_id: tr.root_taxon_id, root_taxon_name: tr.root_taxon_name, root_node_type: tr.node_type,
    representative: tr.representative, n_leaves: tr.n_leaves, leafset_sha1: tr.leafset_sha1})` }));

// ontology terms
const goCat = `CASE namespace WHEN 'molecular_function' THEN ['biolink:MolecularActivity'] WHEN 'cellular_component' THEN ['biolink:CellularComponent'] ELSE ['biolink:BiologicalProcess'] END`;
const termAttrs = `to_json({namespace: namespace, obsolete: obsolete, replaced_by: replaced_by, alt_ids: alt_ids})`;
await writeNodes('GoTerm', nodeSql('GoTerm', null, 'ont_go', { id: 'id', category: goCat, name: 'name', description: 'def', aliases: 'synonyms', attrs: termAttrs }));
await writeNodes('PlantAnatomyTerm', nodeSql('PlantAnatomyTerm', ['biolink:AnatomicalEntity'], `ont_po WHERE namespace IS DISTINCT FROM 'plant_structure_development_stage'`,
  { id: 'id', name: 'name', description: 'def', aliases: 'synonyms', attrs: termAttrs }));
await writeNodes('PlantStageTerm', nodeSql('PlantStageTerm', ['biolink:LifeStage'], `ont_po WHERE namespace = 'plant_structure_development_stage'`,
  { id: 'id', name: 'name', description: 'def', aliases: 'synonyms', attrs: termAttrs }));
await writeNodes('TraitTerm', nodeSql('TraitTerm', ['biolink:PhenotypicFeature'], 'ont_to', { id: 'id', name: 'name', description: 'def', aliases: 'synonyms', attrs: termAttrs }));
counts.dropped.eco_malformed_ids = Number((await q(`SELECT count(*)::BIGINT n FROM ont_eco WHERE NOT regexp_full_match(id, 'ECO:[0-9]{7}')`))[0].n);
await exec(`DELETE FROM ont_eco WHERE NOT regexp_full_match(id, 'ECO:[0-9]{7}')`);
await writeNodes('EvidenceCodeTerm', nodeSql('EvidenceCodeTerm', ['biolink:EvidenceType'], 'ont_eco', { id: 'id', name: 'name', description: 'def', aliases: 'synonyms', attrs: termAttrs }));
await exec(`CREATE TABLE interpro AS SELECT * FROM ${rj('ont_interpro')}`);
await exec(`CREATE TABLE interpro_stubs AS SELECT DISTINCT id FROM xref WHERE db = 'domains' AND id NOT IN (SELECT id FROM interpro)`);
counts.dropped.interpro_retired_stubbed = Number((await q(`SELECT count(*)::BIGINT n FROM interpro_stubs`))[0].n);
await writeNodes('InterProEntry', nodeSql('InterProEntry', ['biolink:ProteinDomain'], `(SELECT id, name, short_name, type, false AS stub FROM interpro
    UNION ALL SELECT id, NULL, NULL, NULL, true FROM interpro_stubs)`, {
  id: `'interpro:' || id`, name: 'coalesce(name, id)', aliases: `CASE WHEN short_name IS NULL THEN [] ELSE [short_name] END`,
  attrs: `CASE WHEN stub THEN to_json({stub: true, obsolete: true, reason: 'referenced by Ensembl core xrefs; absent from InterPro ' || ${L(V.interpro)} || ' and ' || ${L(dsVersion('ontology-db-interpro'))}})
    ELSE to_json({type: type, version: ${L(dsVersion('ontology-db-interpro'))}}) END` }));

// Plant Reactome: anchor-species pathways from the ontology db + events referenced by anchor genes
const prefixes = (await q(`SELECT DISTINCT substr(id, 1, 5) AS p FROM ${rj('gene_pathway')}`)).map(r => r.p);
await exec(`CREATE TABLE gp AS SELECT * FROM ${rj('gene_pathway')}`);
await exec(`CREATE TABLE rel_pathways AS SELECT * FROM ${rj('pathways')}`);
await exec(`CREATE TABLE prefix_taxon AS SELECT DISTINCT regexp_extract(gp.id, '^(R-[A-Z]+-)', 1) AS prefix, g.taxon_id AS taxon FROM gp JOIN genes g ON g.id = gp.gene`);
await exec(`CREATE TABLE lineage_parent AS
  SELECT DISTINCT pt.prefix || l.path[list_position(l.path, rp.base_id) - 1] AS parent, pt.prefix || rp.base_id AS event
  FROM rel_pathways rp, unnest(rp.lineages) AS u(l) JOIN prefix_taxon pt ON pt.taxon = l.taxon
  WHERE list_position(l.path, rp.base_id) > 1`);
await exec(`CREATE TABLE reactome AS
  SELECT id, name, base_id::VARCHAR AS base_id, species, 'Pathway' AS event_type, parents FROM ${rj('ont_reactome')}
   WHERE substr(id, 1, 5) IN (${prefixes.map(sqlStr).join(',') || "''"})
  UNION ALL
  SELECT gp.id, min(p.name), min(regexp_extract(gp.id, '^R-[A-Z]+-([0-9]+)', 1)), NULL, coalesce(min(p.type), 'Reaction'),
         coalesce(list(DISTINCT lp.parent ORDER BY lp.parent) FILTER (WHERE lp.parent IS NOT NULL), []::VARCHAR[])
    FROM (SELECT DISTINCT id FROM gp) gp LEFT JOIN rel_pathways p ON p.base_id = regexp_extract(gp.id, '^R-[A-Z]+-([0-9]+)', 1)
    LEFT JOIN lineage_parent lp ON lp.event = gp.id
   WHERE gp.id NOT IN (SELECT id FROM ${rj('ont_reactome')}) GROUP BY gp.id`);
await writeNodes('PlantReactomeEvent', nodeSql('PlantReactomeEvent', ['biolink:Pathway'], 'reactome', {
  id: `'reactome:' || id`, name: 'name', attrs: `to_json({base_id: base_id, species: species, event_type: event_type})` }));

await exec(`CREATE TABLE qtls AS SELECT q.*, g.gid FROM ${rj('qtls')} q LEFT JOIN genome_ids g ON g.map_id = q.map`);
await writeNodes('QuantitativeTraitLocus', nodeSql('QuantitativeTraitLocus', ['biolink:BiologicalEntity'], 'qtls', {
  id: `'gramene.qtl:' || id`, name: `coalesce(description, id)`, genome: 'gid', region: 'region', start: 'start', end: '"end"',
  attrs: `to_json({source: source, sequence_ontology_type: 'SO:0000771', is_point_qtl: ("end" - start) <= 1})` }));

// ---- germplasm: accessions (per stock centre) + genotyped samples (ens_id) ---------------------
await exec(`CREATE TABLE pops AS SELECT * FROM read_csv(${sqlStr(CFG('populations.tsv'))}, delim='\t', header=true, all_varchar=true)`);
await exec(`CREATE TABLE gsrc AS SELECT * FROM read_csv(${sqlStr(CFG('germplasm_sources.tsv'))}, delim='\t', header=true, all_varchar=true)`);
await exec(`CREATE MACRO norm_id(s) AS upper(regexp_replace(coalesce(s, ''), '[\\s\\-_.]', '', 'g'))`);
await exec(`CREATE TABLE germ AS
  SELECT g.*, coalesce(nullif(g.germplasm_dbid, ''), NULL) AS dbid,
         p.system_name AS pop_system, 'gramene.population:' || p.system_name || '.' || g.pop_id AS pop_curie, p.system_name AS species_system
  FROM ${rj('germplasm')} g LEFT JOIN pops p ON p.pop_id = g.pop_id`);
// accession key
await exec(`CREATE TABLE germ_acc AS SELECT *,
  CASE
    WHEN stock_center = 'ARS' AND dbid IS NOT NULL AND dbid <> '0' THEN 'ars.' || dbid
    WHEN stock_center = 'ICRISAT' AND dbid IS NOT NULL AND dbid <> '0' THEN 'icrisat.' || replace(dbid, ' ', '')
    WHEN stock_center = 'IRRI' AND dbid IS NOT NULL AND dbid <> '0' THEN 'irri.' || dbid
    WHEN stock_center = 'CNCG/CAAS' AND dbid IS NOT NULL AND dbid <> '0' THEN 'cncg.' || dbid
    WHEN stock_center = 'sorbmutdb' THEN 'sorbmutdb.' || norm_id(pub_id)
    WHEN pub_id IS NOT NULL AND pub_id <> 'NOT FOUND' THEN 'unresolved.' || lower(regexp_replace(coalesce(stock_center, 'none'), '[^A-Za-z]', '', 'g')) || '.' || norm_id(pub_id)
    ELSE 'unresolved.sample.' || norm_id(ens_id)
  END AS acc_key FROM germ`);
// a key that names more than one accession (e.g. CNCG dbid 21-03879) is disambiguated by pub_id hash
await exec(`CREATE TABLE acc_multi AS SELECT acc_key FROM germ_acc GROUP BY acc_key HAVING count(DISTINCT coalesce(pub_id, '')) > 1`);
await exec(`UPDATE germ_acc SET acc_key = acc_key || '.' || substr(sha256(coalesce(pub_id, '')), 1, 6) WHERE acc_key IN (SELECT acc_key FROM acc_multi) AND acc_key NOT LIKE 'unresolved.%'`);
counts.dropped.accession_keys_disambiguated = Number((await q(`SELECT count(*)::BIGINT n FROM acc_multi`))[0].n);
await exec(`CREATE TABLE grin AS SELECT * FROM ${rj('grin')}`);
await exec(`CREATE TABLE accessions AS
  SELECT 'gramene.germplasm:' || a.acc_key AS id, min(a.pub_id) AS accession_number, min(a.stock_center) AS stock_center,
         min(a.dbid) AS dbid, list(DISTINCT a.pop_curie ORDER BY a.pop_curie) FILTER (WHERE a.pop_curie IS NOT NULL) AS populations,
         list(DISTINCT 'gramene.sample:' || a.ens_id ORDER BY 'gramene.sample:' || a.ens_id) FILTER (WHERE a.ens_id IS NOT NULL) AS samples,
         min(a.species_system) AS species_system,
         CASE WHEN a.acc_key LIKE 'unresolved.%' THEN 'unresolved' ELSE 'resolved' END AS resolution_status,
         min(r.name) AS grin_name, min(r.country) AS country
  FROM germ_acc a LEFT JOIN grin r ON a.stock_center = 'ARS' AND r.germplasm_dbid = a.dbid
  GROUP BY a.acc_key`);
await writeNodes('GermplasmAccession', nodeSql('GermplasmAccession', ['biolink:OrganismalEntity'], `accessions a LEFT JOIN gsrc s ON s.stock_center = a.stock_center`, {
  id: 'a.id', name: 'coalesce(a.grin_name, a.accession_number, a.id)', aliases: `list_filter([a.accession_number, a.dbid], lambda x: x IS NOT NULL)`,
  in_taxon: `CASE a.species_system WHEN 'sorghum_bicolor' THEN 'NCBITaxon:4558' WHEN 'oryza_sativa' THEN 'NCBITaxon:4530' END`,
  xrefs: `CASE WHEN s.url_template IS NOT NULL AND a.dbid IS NOT NULL AND a.dbid <> '0' AND s.id_field = 'germplasm_dbid' THEN [replace(s.url_template, '$1', a.dbid)] ELSE [] END`,
  attrs: `to_json({accession_number: a.accession_number, stock_center: a.stock_center, germplasm_db_id: a.dbid, populations: a.populations,
    samples: a.samples, resolution_status: a.resolution_status, country_of_origin: a.country})` }));
await exec(`CREATE TABLE samples AS
  SELECT 'gramene.sample:' || ens_id AS id, ens_id, list(DISTINCT pop_curie ORDER BY pop_curie) FILTER (WHERE pop_curie IS NOT NULL) AS populations,
         list(DISTINCT doc_id ORDER BY doc_id) AS source_records, min('gramene.germplasm:' || acc_key) AS accession, count(DISTINCT acc_key) AS n_acc,
         min(species_system) AS species_system
  FROM germ_acc WHERE ens_id IS NOT NULL GROUP BY ens_id`);
await writeNodes('GenotypedSample', nodeSql('GenotypedSample', ['biolink:MaterialSample'], 'samples', {
  id: 'id', name: 'ens_id',
  in_taxon: `CASE species_system WHEN 'sorghum_bicolor' THEN 'NCBITaxon:4558' WHEN 'oryza_sativa' THEN 'NCBITaxon:4530' END`,
  attrs: `to_json({accession: accession, populations: populations, source_records: source_records})` }));
await writeNodes('GramenePopulation', nodeSql('GramenePopulation', ['biolink:PopulationOfIndividualOrganisms'], 'pops', {
  id: `'gramene.population:' || system_name || '.' || pop_id`, name: 'label',
  in_taxon: `CASE system_name WHEN 'sorghum_bicolor' THEN 'NCBITaxon:4558' WHEN 'oryza_sativa' THEN 'NCBITaxon:4530' END`,
  attrs: `to_json({pop_id: pop_id, system_name: system_name, panel_type: panel_type, ensembl_population_name: nullif(ensembl_population_name, ''),
    population_size: try_cast(ensembl_size AS INTEGER), n_germplasm_docs: try_cast(n_germplasm_docs AS INTEGER),
    doi: nullif(doi, ''), match_method: match_method, species_confidence: species_confidence, note: nullif(note, '')})` }));

// ---- variation studies (REST snapshot) ---------------------------------------------------------
if (fs.existsSync(SNAP('ensembl_variation_sources'))) {
  await exec(`CREATE TABLE varstudy AS SELECT * FROM read_json_auto(${sqlStr(SNAP('ensembl_variation_sources'))})`);
  await writeNodes('VariationStudy', nodeSql('VariationStudy', ['biolink:Study'], 'varstudy', {
    id: `'gramene.varstudy:' || name`, name: 'name', description: 'description',
    xrefs: `CASE WHEN url IS NULL THEN [] ELSE [url] END`, attrs: `to_json({version: version, data_types: data_types})` }));
}

// ---- publications: parse every source of PMIDs / DOIs in JS, then nodes + mention edges in SQL ---
const parsePubs = (raw) => {
  const out = []; if (raw == null) return out;
  const s = String(raw);
  for (const m of s.matchAll(/(?:^|[^0-9.])(10\.[0-9]{4,9}\/[^\s;,"]+)/g)) out.push('doi:' + m[1].replace(/[).]+$/, '').toLowerCase());
  const pm = s.match(/^\s*(?:PMID:?\s*)?([0-9]{4,9})\s*$/i) ?? s.match(/PMID:?\s*([0-9]{4,9})/i);
  if (pm) return ['PMID:' + Number(pm[1])];
  return [...new Set(out)];
};
const wMent = new NdjsonWriter(buildOut('work', 'mentions.ndjson'));
let unparsed = 0;
for (const line of fs.readFileSync(buildOut('extract', 'gene_xref.ndjson'), 'utf8').split('\n')) {
  if (!line) continue; const r = JSON.parse(line); if (r.db !== 'PUBMED') continue;
  const ids = parsePubs(r.id); if (!ids.length) { unparsed++; continue; }
  for (const p of ids) await wMent.write({ pub: p, target: 'gramene.gene:' + r.gene, kind: 'gene', source: r.source ?? 'core', text: r.text, raw: r.id });
}
for (const line of fs.readFileSync(buildOut('extract', 'idf.ndjson'), 'utf8').split('\n')) {
  if (!line) continue; const r = JSON.parse(line);
  const exp = /^[AEP]-\w{4}-\d+$/.test(r.experiment) ? 'gxa.expt:' + r.experiment : 'gramene.expt:' + r.experiment;
  const pm = r.pmids.flatMap(parsePubs);
  const ids = new Set(pm.length ? pm : r.dois.flatMap(parsePubs));
  for (const p of ids) await wMent.write({ pub: p, target: exp, kind: 'experiment', source: 'idf', text: r.pub_titles[0] ?? null, raw: null });
}
if (fs.existsSync(SNAP('ensembl_variation_sources'))) for (const s of JSON.parse(fs.readFileSync(SNAP('ensembl_variation_sources'), 'utf8'))) {
  const ids = new Set([...(s.name.match(/PMID(\d+)/) ? ['PMID:' + Number(s.name.match(/PMID(\d+)/)[1])] : []), ...parsePubs(s.url ?? '')]);
  for (const p of ids) await wMent.write({ pub: p, target: 'gramene.varstudy:' + s.name, kind: 'variation_study', source: 'ensembl_variation', text: s.description ?? null, raw: s.name });
}
for (const line of fs.readFileSync(CFG('populations.tsv'), 'utf8').split('\n').slice(1)) {
  const c = line.split('\t'); if (!c[7]) continue;
  await wMent.write({ pub: 'doi:' + c[7].toLowerCase(), target: `gramene.population:${c[1]}.${c[0]}`, kind: 'population', source: 'ensembl_population', text: c[2], raw: c[7] });
}
await wMent.close();
counts.dropped.unparsed_publication_strings = unparsed;
{
  const { MongoClient } = await import('mongodb');
  const cl = await MongoClient.connect(env('MONGO_URI'));
  const rows = await cl.db('kg_meta').collection('publication_cache').find({ _id: /^PMID:/, doi: { $ne: null } }, { projection: { doi: 1 } }).toArray();
  await cl.close();
  fs.writeFileSync(buildOut('work', 'doi_to_pmid.ndjson'), rows.map(r => JSON.stringify({ doi: 'doi:' + r.doi.toLowerCase(), pmid: r._id })).join('\n') + '\n');
  counts.doi_to_pmid_known = rows.length;
}
await exec(`CREATE TABLE mentions_raw AS SELECT * FROM read_json_auto(${sqlStr(buildOut('work', 'mentions.ndjson'))}, format='newline_delimited')`);
await exec(`CREATE TABLE doi2pmid AS SELECT DISTINCT doi, min(pmid) AS pmid FROM read_json(${sqlStr(buildOut('work', 'doi_to_pmid.ndjson'))}, format='newline_delimited', columns={doi:'VARCHAR', pmid:'VARCHAR'}) GROUP BY doi`);
await exec(`CREATE TABLE mentions AS SELECT coalesce(d.pmid, m.pub) AS pub, m.* EXCLUDE (pub) FROM mentions_raw m LEFT JOIN doi2pmid d ON d.doi = m.pub`);
counts.dropped.doi_mentions_remapped_to_pmid = Number((await q(`SELECT count(*)::BIGINT n FROM mentions_raw m JOIN doi2pmid d ON d.doi = m.pub`))[0].n);
await writeNodes('GramenePublication', nodeSql('GramenePublication', ['biolink:Publication'], `(SELECT pub, min(text) FILTER (WHERE kind IN ('experiment')) AS title FROM mentions GROUP BY pub)`, {
  id: 'pub', name: 'coalesce(title, pub)', attrs: `to_json({enriched: false})` }));

// ---- expression experiments, sample groups, contrasts ---------------------------------------
await exec(`CREATE TABLE experiments AS SELECT e.*, i.title AS idf_title, i.release_date FROM ${rj('experiments')} e LEFT JOIN ${rj('idf')} i ON i.experiment = e.id`);
const exptId = (col) => `CASE WHEN regexp_matches(${col}, '^[AEP]-\\w{4}-[0-9]+$') THEN 'gxa.expt:' ELSE 'gramene.expt:' END || ${col}`;
await exec(`CREATE TABLE assays AS SELECT * FROM ${rj('assays')}`);
await exec(`CREATE TABLE expt_stubs AS SELECT DISTINCT experiment AS id, min(taxon_id) AS taxon_id FROM assays WHERE experiment NOT IN (SELECT id FROM experiments) GROUP BY experiment`);
counts.dropped.experiments_stubbed_from_assays = Number((await q(`SELECT count(*)::BIGINT n FROM expt_stubs`))[0].n);
await writeNodes('ExpressionExperiment', nodeSql('ExpressionExperiment', ['biolink:Study'], `(SELECT id, name, idf_title, description, taxon_id, type, source, factors, release_date, pi, annotation, false AS stub FROM experiments
    UNION ALL SELECT id, NULL, NULL, NULL, taxon_id, NULL, NULL, []::VARCHAR[], NULL, NULL, NULL, true FROM expt_stubs)`, {
  id: exptId('id'), name: 'coalesce(name, idf_title, id)', description: 'description', in_taxon: `'NCBITaxon:' || taxon_id`,
  attrs: `CASE WHEN stub THEN to_json({stub: true, reason: 'assay groups exist but no experiment document in the release db'})
    ELSE to_json({experiment_type: type, source: source, factors: factors, release_date: release_date, pi: pi, annotation: annotation}) END` }));
await writeNodes('SampleGroup', nodeSql('SampleGroup', ['biolink:MaterialSample'], 'assays', {
  id: `'gramene.assay:' || id`, name: `id || coalesce(': ' || label, '')`, in_taxon: `'NCBITaxon:' || taxon_id`,
  attrs: `to_json({experiment: ${exptId('experiment')}, "group": "group", sra_runs: sra_runs, sra_studies: sra_studies, n_replicates: n_replicates})` }));
await exec(`CREATE TABLE contrasts AS SELECT * FROM ${rj('contrasts')}`);
await writeNodes('ExpressionContrast', nodeSql('ExpressionContrast', ['biolink:StudyResult'], 'contrasts', {
  id: `'gramene.contrast:' || id`, name: 'id',
  attrs: `to_json({experiment: ${exptId('experiment')}, reference_group: 'gramene.assay:' || reference_group, test_group: 'gramene.assay:' || test_group,
    id_convention: '<reference>_<test>'})` }));

// assay terms: resolve against loaded ontologies, else stub
await exec(`CREATE TABLE assay_terms AS SELECT * FROM ${rj('assay_terms')}`);
await exec(`CREATE TABLE known_terms AS SELECT id FROM ont_go UNION SELECT id FROM ont_po UNION SELECT id FROM ont_to UNION SELECT tid FROM taxa`);
await exec(`CREATE TABLE stubs AS SELECT term AS id, min(label) AS label, split_part(term, ':', 1) AS prefix
  FROM assay_terms WHERE term NOT IN (SELECT id FROM known_terms) GROUP BY term`);
const stubCat = `CASE WHEN prefix IN ('UBERON','FBbt','BTO') THEN ['biolink:AnatomicalEntity'] WHEN prefix = 'CL' THEN ['biolink:Cell']
  WHEN prefix = 'FBdv' THEN ['biolink:LifeStage'] WHEN prefix = 'NCBITaxon' THEN ['biolink:OrganismTaxon'] ELSE ['biolink:NamedThing'] END`;
await writeNodes('OntologyClassStub', nodeSql('OntologyClassStub', null, 'stubs', { id: 'id', category: stubCat, name: 'label', attrs: `to_json({stub: true, prefix: prefix})` }));

// ---- TF families, collections -----------------------------------------------------------------
counts.dropped.grassius_direct_gene_unknown = Number((await q(`SELECT count(*)::BIGINT n FROM ${rj('grassius')} x WHERE method = 'direct' AND x.gene NOT IN (SELECT id FROM genes)`))[0].n);
counts.dropped.grassius_projection_non_anchor = Number((await q(`SELECT count(*)::BIGINT n FROM ${rj('grassius')} x WHERE method <> 'direct' AND x.gene NOT IN (SELECT id FROM anchor_genes)`))[0].n);
await exec(`CREATE TABLE grassius AS SELECT x.* FROM ${rj('grassius')} x JOIN anchor_genes g ON g.id = x.gene`);
await writeNodes('TranscriptionFactorFamily', nodeSql('TranscriptionFactorFamily', ['biolink:GeneFamily'], `(SELECT DISTINCT family FROM grassius)`, {
  id: `'gramene.tffamily:' || regexp_replace(family, '[^A-Za-z0-9_.-]', '_', 'g')`, name: 'family' }));
await exec(`CREATE TABLE collections AS SELECT id, min(kind) AS kind, min(label) FILTER (WHERE label IS NOT NULL) AS label, min(n_genes) AS n_genes, min(site) AS site, min(created_at) AS created_at, min(description) AS description, min(definition) AS definition, count(*) AS n_owners FROM ${rj('collections')} GROUP BY id`);
await writeNodes('KgCollection', nodeSql('KgCollection', ['biolink:InformationContentEntity'], 'collections', {
  id: `'gramene.collection:' || id`, name: `coalesce(nullif(label, ''), kind || ' ' || id)`, description: 'description',
  attrs: `to_json({kind: kind, n_genes: n_genes, n_owners: n_owners, owner_display: NULL, site: site, created_at: created_at, definition: definition})` }));

// ---- catalogue classes (kg05) normalised into the node schema --------------------------------
for (const [cls, cat] of [['KgRelease', 'biolink:Dataset'], ['KgDataset', 'biolink:Dataset'], ['KgDistribution', 'biolink:DatasetDistribution'],
  ['IngestRun', 'biolink:Activity'], ['AnalysisRun', 'biolink:Activity'], ['SoftwareAgent', 'biolink:Agent']]) {
  const src = sqlStr(buildOut('parquet', 'nodes', `${cls}.parquet`));
  await writeNodes(cls, nodeSql(cls, [cat], `${src} c`, { id: 'c.id', name: 'c.name',
    description: (await q(`SELECT count(*) n FROM (DESCRIBE SELECT * FROM ${src}) WHERE column_name = 'description'`))[0].n > 0 ? 'c.description' : 'NULL',
    attrs: `to_json(c)` }));
}

// ---------------------------------------------------------------------------------------------
// EDGES
// ---------------------------------------------------------------------------------------------
const F = EV.families;
const S = F.structural;

// structural slots (KGX only)
await writeEdges('gene_genome', edgeSql('gene_genome', 'genes', { subject: `'gramene.gene:' || id`, predicate: `'biolink:located_in'`, object: 'gid',
  pks: 'infores:ensembl-gene', kl: S.knowledge_level, at: S.agent_type, rec: `${RELEASE}.genes.location.map`, osubj: 'id', oobj: 'map',
  qualifiers: `to_json({region: region, start: start, "end": "end", strand: strand})`, slot: true }));
await writeEdges('gene_tree', edgeSql('gene_tree', 'genes WHERE tree IS NOT NULL', { subject: `'gramene.gene:' || id`, predicate: `'biolink:member_of'`,
  object: `'gramene.genetree:' || tree`, pks: F.gene_tree_membership.primary_knowledge_source, kl: F.gene_tree_membership.knowledge_level,
  at: F.gene_tree_membership.agent_type, ev: F.gene_tree_membership.has_evidence, rec: `${RELEASE}.genes.homology.gene_tree.id`, ksv: V.compara, slot: true }));
await writeEdges('genome_taxon', edgeSql('genome_taxon', 'genome_ids', { subject: 'gid', predicate: `'biolink:in_taxon'`, object: `'NCBITaxon:' || anchor_taxon_id`,
  pks: 'infores:ensembl-gene', kl: S.knowledge_level, at: S.agent_type, rec: `${RELEASE}.maps.anchor_taxon_id`, slot: false }));
await writeEdges('taxon_parent', edgeSql('taxon_parent', `taxa c JOIN taxa p ON p.taxon_id = c.parent`, { subject: 'c.tid', predicate: `'biolink:subclass_of'`,
  object: 'p.tid', pks: 'infores:gramene-kg', kl: S.knowledge_level, at: S.agent_type, rec: `${RELEASE}.taxonomy.is_a` }));

// gene -> GO (by aspect), alt ids resolved to primary
await exec(`CREATE TABLE gene_go AS SELECT x.gene, coalesce(a.id, x.id) AS go, x.id AS raw, x.ec FROM xref x LEFT JOIN go_alt a ON a.alt = x.id WHERE x.db = 'GO'`);
const goEco = Object.entries(EV.go_evidence_to_eco).map(([k, v]) => `WHEN ${sqlStr(k)} THEN ${sqlStr(v.eco)}`).join(' ');
await writeEdges('gene_go', edgeSql('gene_go', `(SELECT g.gene, g.go, g.ec, min(g.raw) AS raw, min(t.namespace) AS namespace FROM gene_go g JOIN ont_go t ON t.id = g.go GROUP BY g.gene, g.go, g.ec)`, {
  subject: `'gramene.gene:' || gene`, object: 'go',
  predicate: `CASE namespace WHEN 'molecular_function' THEN 'biolink:enables' WHEN 'cellular_component' THEN 'biolink:located_in' ELSE 'biolink:actively_involved_in' END`,
  pks: F.gene_go.primary_knowledge_source,
  kl: `sql:CASE WHEN coalesce(ec, '') = '' THEN 'not_provided' WHEN ec = 'IEA' THEN ${sqlStr(F.gene_go.by_code.IEA.knowledge_level)} ELSE ${sqlStr(F.gene_go.by_code.default.knowledge_level)} END`,
  at: `sql:CASE WHEN coalesce(ec, '') = '' THEN 'not_provided' WHEN ec = 'IEA' THEN ${sqlStr(F.gene_go.by_code.IEA.agent_type)} ELSE ${sqlStr(F.gene_go.by_code.default.agent_type)} END`,
  ev: `sql:list_filter([CASE ec ${goEco} END], lambda x: x IS NOT NULL)`,
  oev: 'ec', oobj: 'raw', rec: `${RELEASE}.genes.xrefs[db=GO]`, ksv: V.go, qualifiers: `to_json({evidence: ec})` }));

// curated PO (anatomy -> expressed_in, stage -> expressed_during) and TO (has_phenotype)
const byGenome = (fam, key) => `sql:CASE system_name ${Object.entries(F[fam]).filter(([k]) => k !== 'default').map(([k, v]) => `WHEN ${sqlStr(k)} THEN ${sqlStr(v[key])}`).join(' ')} ELSE ${sqlStr(F[fam].default[key])} END`;
const byGenomeList = (fam) => `sql:CASE system_name ${Object.entries(F[fam]).filter(([k]) => k !== 'default').map(([k, v]) => `WHEN ${sqlStr(k)} THEN ${LIST(v.has_evidence)}`).join(' ')} ELSE ${LIST(F[fam].default.has_evidence)} END`;
counts.dropped.po_xref_term_unknown = Number((await q(`SELECT count(*)::BIGINT n FROM xref WHERE db = 'PO' AND id NOT IN (SELECT id FROM ont_po)`))[0].n);
counts.dropped.to_xref_term_unknown = Number((await q(`SELECT count(*)::BIGINT n FROM xref WHERE db = 'TO' AND id NOT IN (SELECT id FROM ont_to)`))[0].n);
counts.dropped.go_xref_term_unknown = Number((await q(`SELECT count(*)::BIGINT n FROM gene_go WHERE go NOT IN (SELECT id FROM ont_go)`))[0].n);
await writeEdges('gene_po', edgeSql('gene_po', `(SELECT DISTINCT x.gene, x.id, x.ec, x.system_name, t.namespace FROM xref x JOIN ont_po t ON t.id = x.id WHERE x.db = 'PO')`, {
  subject: `'gramene.gene:' || gene`, object: 'id',
  predicate: `CASE WHEN namespace = 'plant_structure_development_stage' THEN 'gramene:expressed_during' ELSE 'biolink:expressed_in' END`,
  pks: byGenome('gene_po_curated', 'primary_knowledge_source'), kl: byGenome('gene_po_curated', 'knowledge_level'),
  at: byGenome('gene_po_curated', 'agent_type'), ev: byGenomeList('gene_po_curated'), oev: 'ec', rec: `${RELEASE}.genes.xrefs[db=PO]`, ksv: V.po }));
await writeEdges('gene_to', edgeSql('gene_to', `(SELECT DISTINCT x.gene, x.id, x.ec, x.system_name FROM xref x JOIN ont_to t ON t.id = x.id WHERE x.db = 'TO')`, {
  subject: `'gramene.gene:' || gene`, object: 'id', predicate: `'biolink:has_phenotype'`,
  pks: byGenome('gene_to_curated', 'primary_knowledge_source'), kl: byGenome('gene_to_curated', 'knowledge_level'),
  at: byGenome('gene_to_curated', 'agent_type'), ev: byGenomeList('gene_to_curated'), oev: 'ec', rec: `${RELEASE}.genes.xrefs[db=TO]`, ksv: V.to }));
await writeEdges('gene_domain', edgeSql('gene_domain', `(SELECT DISTINCT gene, id FROM xref WHERE db = 'domains')`, {
  subject: `'gramene.gene:' || gene`, object: `'interpro:' || id`, predicate: `'gramene:has_domain'`,
  pks: F.gene_domain.primary_knowledge_source, kl: F.gene_domain.knowledge_level, at: F.gene_domain.agent_type, ev: F.gene_domain.has_evidence,
  rec: `${RELEASE}.genes.xrefs[db=domains]`, ksv: V.interpro }));
// No per-association evidence is available: genes carry reaction ids while plant_reactome_genes
// holds lowest-level pathway ids, and every non-rice row there says 'none'. Rice TAS rows need a
// UniProt -> gene mapping (M4). So original_evidence stays NULL rather than a synthetic value.
await writeEdges('gene_pathway', edgeSql('gene_pathway', `(SELECT DISTINCT gene, id FROM gp)`, {
  subject: `'gramene.gene:' || gene`, object: `'reactome:' || id`, predicate: `'biolink:participates_in'`,
  pks: F.gene_pathway.by_evidence.default.primary_knowledge_source, kl: F.gene_pathway.by_evidence.default.knowledge_level,
  at: F.gene_pathway.by_evidence.default.agent_type, ev: [], rec: `${RELEASE}.genes.annotations.pathways`, ksv: V.reactome }));
counts.dropped.reactome_parent_unknown = Number((await q(`SELECT count(*)::BIGINT n FROM (SELECT unnest(parents) AS parent FROM reactome) WHERE parent NOT IN (SELECT id FROM reactome)`))[0].n);
await writeEdges('reactome_parent', edgeSql('reactome_parent', `(SELECT id, parent FROM (SELECT id, unnest(parents) AS parent FROM reactome) WHERE parent IN (SELECT id FROM reactome))`, {
  subject: `'reactome:' || id`, object: `'reactome:' || parent`, predicate: `'biolink:part_of'`, pks: 'infores:plant-reactome',
  kl: 'knowledge_assertion', at: 'manual_agent', rec: 'ontology.plant_reactome.parents', ksv: V.reactome }));

// QTLs
await exec(`CREATE TABLE qtl_gene AS SELECT g.id AS gene, q.id AS qtl, q.source FROM genes g JOIN qtls q
  ON g.map = q.map AND g.region = q.region AND g.start >= q.start AND g."end" <= q."end"`);
const qtlPks = `CASE source WHEN 'Sorghum_QTL_Atlas' THEN 'infores:sorghum-qtl-atlas' WHEN 'Gramene_QTLdb' THEN 'infores:gramene-qtldb' ELSE 'infores:ensembl-variation' END`;
await writeEdges('gene_qtl', edgeSql('gene_qtl', 'qtl_gene', { subject: `'gramene.gene:' || gene`, object: `'gramene.qtl:' || qtl`, predicate: `'biolink:overlaps'`,
  pks: `sql:${qtlPks}`, kl: F.qtl_containment.knowledge_level, at: F.qtl_containment.agent_type, method: QTL_METHOD,
  rec: `${RELEASE}.qtls.location x ${RELEASE}.genes.location`, qualifiers: `'{"containment":"full"}'` }));
counts.dropped.qtl_terms_not_TO = Number((await q(`SELECT count(*)::BIGINT n FROM (SELECT unnest(terms) AS t FROM qtls) WHERE NOT starts_with(t, 'TO:')`))[0].n);
await writeEdges('qtl_trait', edgeSql('qtl_trait', `(SELECT * FROM (SELECT id, source, unnest(terms) AS term FROM qtls) WHERE starts_with(term, 'TO:'))`, {
  subject: `'gramene.qtl:' || id`, object: 'term', predicate: `'biolink:associated_with'`, pks: `sql:${qtlPks}`,
  kl: 'statistical_association', at: 'manual_agent', ev: ['ECO:0000061'], rec: `${RELEASE}.qtls.terms` }));
await writeEdges('qtl_genome', edgeSql('qtl_genome', 'qtls', { subject: `'gramene.qtl:' || id`, object: 'gid', predicate: `'biolink:located_in'`,
  pks: `sql:${qtlPks}`, kl: S.knowledge_level, at: S.agent_type, rec: `${RELEASE}.qtls.location.map`,
  qualifiers: `to_json({region: region, start: start, "end": "end"})`, slot: false }));

// publications -> genes / experiments / studies / populations
const mPks = Object.entries(F.publication_mention).filter(([k]) => k !== 'default').map(([k, v]) => `WHEN ${sqlStr(k)} THEN ${sqlStr(v.primary_knowledge_source)}`).join(' ');
const mAt = Object.entries(F.publication_mention).filter(([k]) => k !== 'default').map(([k, v]) => `WHEN ${sqlStr(k)} THEN ${sqlStr(v.agent_type)}`).join(' ');
await writeEdges('pub_mentions', edgeSql('pub_mentions', `(SELECT pub, target, kind, source, min(text) AS text, min(raw) AS raw FROM mentions GROUP BY ALL)`, {
  subject: 'pub', object: 'target', predicate: `'biolink:mentions'`,
  pks: `sql:CASE WHEN kind = 'experiment' THEN 'infores:expression-atlas' WHEN kind IN ('variation_study','population') THEN 'infores:ensembl-variation'
         ELSE CASE source ${mPks} ELSE ${sqlStr(F.publication_mention.default.primary_knowledge_source)} END END`,
  kl: 'knowledge_assertion', at: `sql:CASE WHEN kind = 'gene' THEN CASE source ${mAt} ELSE 'not_provided' END ELSE 'manual_agent' END`,
  osubj: 'raw', rec: `sql:CASE kind WHEN 'gene' THEN '${RELEASE}.genes.xrefs[db=PUBMED]' WHEN 'experiment' THEN 'atlas IDF' ELSE 'ensembl variation REST' END`,
  qualifiers: `to_json({mention_source: source, statement: text})` }));

// TF families
await writeEdges('gene_tffamily', edgeSql('gene_tffamily', `(SELECT DISTINCT gene, family, method FROM grassius)`, {
  subject: `'gramene.gene:' || gene`, object: `'gramene.tffamily:' || regexp_replace(family, '[^A-Za-z0-9_.-]', '_', 'g')`, predicate: `'biolink:member_of'`,
  pks: F.tf_family.direct.primary_knowledge_source,
  kl: `sql:CASE method WHEN 'direct' THEN ${sqlStr(F.tf_family.direct.knowledge_level)} ELSE ${sqlStr(F.tf_family.projected.knowledge_level)} END`,
  at: `sql:CASE method WHEN 'direct' THEN ${sqlStr(F.tf_family.direct.agent_type)} ELSE ${sqlStr(F.tf_family.projected.agent_type)} END`,
  ev: `sql:CASE method WHEN 'direct' THEN []::VARCHAR[] ELSE ['ECO:0000080'] END`, rec: 'grassius.tsv | grassius_homolog_attrib_table.txt',
  qualifiers: `to_json({method: method})` }));

// anchor <-> anchor one-to-one orthologs (the full homology layer stays derived)
await writeEdges('gene_ortholog', edgeSql('gene_ortholog', `(SELECT o.gene, o.other FROM ${rj('gene_o2o')} o JOIN anchor_genes a ON a.id = o.other
    JOIN anchor_genes b ON b.id = o.gene WHERE a.system_name <> b.system_name)`, {
  subject: `'gramene.gene:' || gene`, object: `'gramene.gene:' || other`, predicate: `'biolink:orthologous_to'`,
  pks: F.orthology.primary_knowledge_source, kl: F.orthology.knowledge_level, at: F.orthology.agent_type, ev: F.orthology.has_evidence,
  rec: `${RELEASE}.genes.homology.homologous_genes.ortholog_one2one`, ksv: V.compara, qualifiers: `'{"homology_type":"ortholog_one2one"}'` }));

// germplasm: sample -> accession, sample -> population, accession -> population
await writeEdges('sample_accession', edgeSql('sample_accession', 'samples', { subject: 'id', object: 'accession', predicate: `'biolink:derives_from'`,
  pks: 'infores:sorghumbase', kl: S.knowledge_level, at: 'manual_agent', rec: `${RELEASE}.germplasm`, osubj: 'ens_id', slot: false }));
await writeEdges('sample_population', edgeSql('sample_population', `(SELECT id, unnest(populations) AS pop FROM samples)`, { subject: 'id', object: 'pop',
  predicate: `'biolink:member_of'`, pks: 'infores:ensembl-variation', kl: S.knowledge_level, at: 'manual_agent', rec: `${RELEASE}.germplasm.pop_id`, slot: false }));

await writeEdges('accession_population', edgeSql('accession_population', `(SELECT DISTINCT accession, unnest(populations) AS pop FROM samples)`, {
  subject: 'accession', object: 'pop', predicate: `'biolink:member_of'`, pks: 'infores:sorghumbase', kl: 'logical_entailment', at: 'data_analysis_pipeline',
  method: 'via genotyped samples (sample derives_from accession; sample member_of population)', rec: `${RELEASE}.germplasm.pop_id` }));

// expression: assay -> experiment, assay -> term, contrast -> assays
await writeEdges('assay_experiment', edgeSql('assay_experiment', 'assays', { subject: `'gramene.assay:' || id`, object: exptId('experiment'),
  predicate: `'biolink:part_of'`, pks: `sql:CASE WHEN starts_with(experiment, 'JGI') THEN 'infores:jgi-phytozome' ELSE 'infores:expression-atlas' END`,
  kl: S.knowledge_level, at: 'manual_agent', rec: `${RELEASE}.assays.experiment`, slot: false }));
await writeEdges('assay_term', edgeSql('assay_term', `(SELECT assay, term, min(type) AS type, min(label) AS label, string_agg(DISTINCT kind, ',' ORDER BY kind) AS kinds FROM assay_terms GROUP BY assay, term)`, {
  subject: `'gramene.assay:' || assay`, object: 'term', predicate: `'gramene:has_sample_characteristic'`,
  pks: `sql:CASE WHEN starts_with(assay, 'JGI') THEN 'infores:jgi-phytozome' ELSE 'infores:expression-atlas' END`,
  kl: 'knowledge_assertion', at: 'manual_agent', rec: `${RELEASE}.assays.characteristic|factor`,
  qualifiers: `to_json({characteristic_type: type, label: label, recorded_as: kinds})` }));
await writeEdges('contrast_assay', edgeSql('contrast_assay', `(SELECT id, reference_group AS g, 'reference' AS role FROM contrasts UNION ALL SELECT id, test_group, 'test' FROM contrasts)`, {
  subject: `'gramene.contrast:' || id`, object: `'gramene.assay:' || g`, predicate: `'biolink:has_part'`, pks: 'infores:expression-atlas',
  kl: 'knowledge_assertion', at: 'manual_agent', rec: 'atlas contrastdetails.tsv', qualifiers: `to_json({role: role})` }));

// ontology hierarchies (is_a / part_of only; other relations stay in node attrs)
for (const o of ['go', 'po', 'to', 'eco']) {
  const pfx = o.toUpperCase();
  counts.dropped[`${o}_cross_ontology_parents`] = Number((await q(`SELECT count(*)::BIGINT n FROM (SELECT unnest(parents) AS p FROM ont_${o}) WHERE p.rel IN ('is_a','part_of') AND NOT starts_with(p.id, '${pfx}:')`))[0].n);
  await writeEdges(`${o}_parent`, edgeSql(`${o}_parent`, `(SELECT id, unnest(parents) AS p FROM ont_${o}) WHERE p.rel IN ('is_a','part_of') AND starts_with(p.id, '${pfx}:') AND p.id IN (SELECT id FROM ont_${o})`, {
    subject: 'id', object: 'p.id', predicate: `CASE p.rel WHEN 'part_of' THEN 'biolink:part_of' ELSE 'biolink:subclass_of' END`,
    pks: o === 'go' ? 'infores:go' : 'infores:gramene-kg', kl: 'knowledge_assertion', at: 'manual_agent', rec: `ontology.${o}.parents`,
    ksv: dsVersion(`ontology-db-${o}`) }));
}
await writeEdges('interpro_parent', edgeSql('interpro_parent', `interpro WHERE parent IS NOT NULL`, { subject: `'interpro:' || id`, object: `'interpro:' || parent`,
  predicate: `'biolink:subclass_of'`, pks: 'infores:interpro', kl: 'knowledge_assertion', at: 'manual_agent', rec: 'ontology.interpro.parent',
  ksv: dsVersion('ontology-db-interpro') }));

// collections
await writeEdges('collection_member', edgeSql('collection_member', `(SELECT DISTINCT collection, gene FROM ${rj('collection_members')})`, {
  subject: `'gramene.collection:' || collection`, object: `'gramene.gene:' || gene`, predicate: `'biolink:has_member'`,
  pks: 'infores:sorghumbase', kl: 'knowledge_assertion', at: 'manual_agent', rec: `${cfg.genes_core}.saved_search` }));

// ---------------------------------------------------------------------------------------------
// M1b layers: rsID variants on the anchor genome, predicted LoF calls, organ expression
// ---------------------------------------------------------------------------------------------
if (!NO_VARIANTS) {
  const AN = (pfx) => analyses.find(a => a.id.startsWith(`gramene.analysis:${pfx}@`))?.id ?? null;
  const I = cfg.inputs;

  // variants: one node per rsID (biallelic split lines aggregated), located on the anchor assembly
  await exec(`CREATE TABLE rsid_gene AS SELECT gene, rsid, list_contains(ptv, rsid) AS ptv, list_contains(pav, rsid) AS pav FROM (
      SELECT column0 AS gene, unnest(string_split(column2, ',')) AS rsid, string_split(coalesce(column3, ''), ',') AS ptv, string_split(coalesce(column4, ''), ',') AS pav
      FROM read_csv(${sqlStr(I.rsid_table)}, delim='\t', header=false, all_varchar=true, quote='', escape='')) WHERE rsid <> ''`);
  // an rsID can span several biallelic records with different REFs (e.g. TCAAAA>T and TCAAA>T): keep REF/ALT pairs
  await exec(`CREATE TABLE rsid_vcf AS SELECT column0 AS rsid, min(column1) AS chrom, min(column2::BIGINT) AS pos, max(length(column3)) AS ref_len,
      list(DISTINCT struct_pack(ref := column3, alt := column4) ORDER BY struct_pack(ref := column3, alt := column4)) AS alleles,
      list(DISTINCT column5 ORDER BY column5) AS so_classes,
      list_sort(list_distinct(flatten(list(string_split(coalesce(column6, ''), ','))))) AS studies
    FROM read_csv(${sqlStr(buildOut('extract', 'rsid_vcf.tsv'))}, delim='\t', header=false, all_varchar=true, quote='', escape='') GROUP BY column0`);
  counts.dropped.rsid_not_in_vcf = Number((await q(`SELECT count(DISTINCT rsid)::BIGINT n FROM rsid_gene WHERE rsid NOT IN (SELECT rsid FROM rsid_vcf)`))[0].n);
  await exec(`UPDATE rsid_vcf SET studies = list_filter(studies, lambda x: x <> '')`);
  await writeNodes('SequenceVariant', nodeSql('SequenceVariant', ['biolink:SequenceVariant'], 'rsid_vcf', {
    id: `'dbsnp:' || rsid`, name: 'rsid', in_taxon: `'NCBITaxon:4558'`, genome: L(cfg.anchor_genome_ref),
    region: 'chrom', start: 'pos', end: 'pos + ref_len - 1',
    attrs: `to_json({so_class: CASE WHEN len(so_classes) = 1 THEN so_classes[1] ELSE NULL END, so_classes: so_classes, alleles: alleles, studies: studies,
      assembly: ${L(cfg.anchor_genome_ref)}})` }));
  await writeEdges('variant_gene', edgeSql('variant_gene', `rsid_gene r JOIN rsid_vcf v USING (rsid)`, {
    subject: `'dbsnp:' || r.rsid`, object: `'gramene.gene:' || r.gene`, predicate: `'biolink:is_sequence_variant_of'`,
    pks: F.variant_gene.primary_knowledge_source, kl: F.variant_gene.knowledge_level, at: F.variant_gene.agent_type, ev: F.variant_gene.has_evidence,
    studies: `list_transform(list_filter(v.studies, lambda x: starts_with(x, 'PRJ')), lambda x: 'bioproject:' || x)`,
    method: AN('rsid-windowing'), rec: path.basename(I.rsid_table) + ' (rsid_projection work_conseq, column 3)',
    qualifiers: `to_json({protein_truncating: r.ptv, protein_altering: r.pav})` }));
  await writeEdges('variant_genome', edgeSql('variant_genome', 'rsid_vcf', { subject: `'dbsnp:' || rsid`, object: L(cfg.anchor_genome_ref),
    predicate: `'biolink:located_in'`, pks: F.variant_gene.primary_knowledge_source, kl: S.knowledge_level, at: S.agent_type,
    rec: path.basename(I.rsid_vcf), qualifiers: `to_json({region: chrom, start: pos, "end": pos + ref_len - 1})`, slot: true }));

  // predicted loss of function: sample -> gene, one edge per pair with every (consequence, zygosity, population) call
  await exec(`CREATE TABLE lof_calls AS SELECT column0 AS gene, regexp_extract(column1, '__([0-9]+)$', 1) AS pop, column2 AS pop_type, column3 AS consequence,
      CASE column4 WHEN 'het' THEN 'heterozygous' ELSE 'homozygous' END AS zygosity, unnest(string_split(column5, ',')) AS sample
    FROM read_csv(${sqlStr(I.vep_long)}, delim='\t', header=false, all_varchar=true, quote='', escape='')`);
  counts.dropped.lof_population_9_calls = Number((await q(`SELECT count(*)::BIGINT n FROM lof_calls WHERE pop = '9'`))[0].n);
  await exec(`DELETE FROM lof_calls WHERE pop = '9' OR sample = ''`);
  await writeEdges('sample_lof', edgeSql('sample_lof', `(SELECT sample, gene, list(struct_pack(consequence := consequence, zygosity := zygosity,
        population := 'gramene.population:sorghum_bicolor.' || pop) ORDER BY consequence, zygosity, pop) AS calls,
        list(DISTINCT 'gramene.population:sorghum_bicolor.' || pop ORDER BY 'gramene.population:sorghum_bicolor.' || pop) AS pops
      FROM lof_calls GROUP BY sample, gene)`, {
    subject: `'gramene.sample:' || sample`, object: `'gramene.gene:' || gene`, predicate: `'gramene:carries_predicted_lof_allele_of'`,
    pks: F.sample_lof.primary_knowledge_source, kl: F.sample_lof.knowledge_level, at: F.sample_lof.agent_type, ev: F.sample_lof.has_evidence,
    studies: 'pops', method: AN('vep-lof-table'), rec: path.basename(I.vep_long), osubj: 'sample',
    qualifiers: `to_json({calls: calls})` }));

  // organ expression calls -> expressed_in (anatomy terms); not_expressed is negated; no_data was dropped in kg10
  const organMap = Object.entries(JSON.parse(fs.readFileSync(CFG('po_organ_map.json'), 'utf8'))).filter(([k]) => !k.startsWith('_'));
  await exec(`CREATE TABLE organ_po AS SELECT * FROM (VALUES ${organMap.map(([k, v]) => `(${sqlStr(k)}, ${sqlStr(v)})`).join(', ')}) t(organ, po)`);
  await exec(`CREATE TABLE organ_expr AS SELECT x.*, o.po FROM ${rj('organ_expression')} x LEFT JOIN organ_po o USING (organ)`);
  counts.dropped.organ_expression_unmapped_organ = Number((await q(`SELECT count(*)::BIGINT n FROM organ_expr WHERE po IS NULL`))[0].n);
  const OE = F.organ_expression;
  await writeEdges('organ_expression', edgeSql('organ_expression', `organ_expr WHERE po IS NOT NULL`, {
    subject: `'gramene.gene:' || gene`, object: 'po', predicate: `'biolink:expressed_in'`,
    pks: OE.primary_knowledge_source, kl: OE.knowledge_level, at: OE.agent_type, ev: OE.has_evidence, method: AN('expression_attributes'),
    rec: `${RELEASE}.expression_attributes.per_organ`, negated: `level = 'not_expressed'`,
    qualifiers: `to_json({organ: organ, expression_level: level, median_tpm: tpm, n_sample_groups: n_samples})` }));

  // gene -> experiment where expression was detected
  const ED = F.expression_detected;
  await writeEdges('expression_detected', edgeSql('expression_detected', `(SELECT DISTINCT gene, experiment FROM ${rj('expression_detected')})`, {
    subject: `'gramene.gene:' || gene`, object: exptId('experiment'), predicate: `'gramene:expression_detected_in'`,
    pks: `sql:CASE WHEN starts_with(experiment, 'JGI') THEN ${sqlStr(ED.JGI.primary_knowledge_source)} ELSE ${sqlStr(ED.EBI.primary_knowledge_source)} END`,
    kl: ED.EBI.knowledge_level, at: ED.EBI.agent_type, ev: ED.EBI.has_evidence, studies: `[${exptId('experiment')}]`,
    method: 'any baseline assay group >= 0.5, or any contrast with p < 0.05 and |log2FC| >= 1 (gramene-solr genes/mongo2solr.join.js)',
    rec: `${cfg.genes_core}.expressed_in_gxa_attr_ss` }));
}

// curated layer (M3): published assertions become one more source here
counts.curated = { note: 'kg_curation not read before M3' };

fs.writeFileSync(buildOut('transform_counts.json'), JSON.stringify(counts, null, 1));
log('transform complete', JSON.stringify({ nodes: Object.values(counts.nodes).reduce((a, b) => a + b, 0), edges: Object.values(counts.edges).reduce((a, b) => a + b, 0) }));
