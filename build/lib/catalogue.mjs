// kg05 catalogue: PROV/DCAT nodes for this build.
//   KgRelease, KgDataset, KgDistribution (sha256 of every input), IngestRun, AnalysisRun, SoftwareAgent.
// Reads release stores and files only. Never reads credentials: ensembl_db_info.json is parsed
// for database *names* and nothing else.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { MongoClient } from 'mongodb';
import {
  env, loadReleaseConfig, buildOut, sha256File, sha256Text, pool, NdjsonWriter, ndjsonToParquet, log,
} from './kgio.mjs';

const RELEASE = env('RELEASE');
const BUILD_ID = env('BUILD_ID');
const RELEASE_ROOT = env('RELEASE_ROOT');
const KG_ROOT = env('KG_ROOT');
const SRC_DB = env('SRC_DB');
const cfg = loadReleaseConfig();
const I = cfg.inputs;
const now = new Date().toISOString();
const RUN_ID = `gramene.run:${RELEASE}-${BUILD_ID}`;
const RELEASE_ID = `gramene.release:${RELEASE}`;

const git = (dir, ...a) => { try { return execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim(); } catch { return null; } };
const mtimeIso = (p) => fs.statSync(p).mtime.toISOString();

// ---- 1. input files -> Distributions -----------------------------------------------------------
const files = [];   // {path, dataset, role}
const add = (p, dataset, role) => { if (fs.existsSync(p) && fs.statSync(p).isFile()) files.push({ path: p, dataset, role }); };
const addGlob = (dir, re, dataset, role) => {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir).sort()) if (re.test(f)) add(path.join(dir, f), dataset, role);
};

const datasets = new Map();   // slug@version -> node
const ds = (slug, version, attrs = {}) => {
  const id = `gramene.dataset:${slug}@${String(version).replace(/[\s/]+/g, '_')}`;
  if (!datasets.has(id)) datasets.set(id, { id, category: ['biolink:Dataset'], name: `${slug} ${version}`, version: String(version), ...attrs });
  return id;
};

// ontology versions actually used by the release build (release tree), vs the shared ontology db
function oboDataVersion(obo) {
  const fd = fs.openSync(obo, 'r'); const buf = Buffer.alloc(8192); fs.readSync(fd, buf, 0, 8192, 0); fs.closeSync(fd);
  const m = buf.toString('utf8').match(/^data-version:\s*(\S+)/m);
  return m ? m[1] : null;
}
function globalJsonVersion(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8'))['data-version'] ?? null; } catch { return null; }
}
const ontTmp = I.ontology_tmp;
for (const o of ['GO', 'PO', 'TO']) {
  const v = globalJsonVersion(path.join(ontTmp, `${o}.Global.json`)) ?? oboDataVersion(path.join(ontTmp, `${o}.obo`)) ?? 'unknown';
  const d = ds(`release-tree-${o.toLowerCase()}`, v, {
    description: `${o} as downloaded by the ${RELEASE} build (edges cite this version)`,
    source_url: `http://purl.obolibrary.org/obo/${o.toLowerCase()}.obo`,
  });
  for (const ext of ['obo', 'Global.json', 'Term.json']) add(path.join(ontTmp, `${o}.${ext}`), d, 'ontology');
}
const ipr = (() => {
  const head = zlib.gunzipSync(fs.readFileSync(path.join(ontTmp, 'interpro.xml.gz'))).subarray(0, 20000).toString('utf8');
  const out = {};
  for (const m of head.matchAll(/<dbinfo version="([^"]+)" dbname="([^"]+)"/g)) out[m[2]] = m[1];
  return out;
})();
const iprDs = ds('release-tree-interpro', ipr.INTERPRO ?? 'unknown', {
  description: 'InterPro release used by the release build', member_db_versions: JSON.stringify(ipr),
  source_url: 'https://ftp.ebi.ac.uk/pub/databases/interpro/current_release/interpro.xml.gz',
});
add(path.join(ontTmp, 'interpro.xml.gz'), iprDs, 'ontology');
add(path.join(ontTmp, 'ParentChildTreeFile.txt'), iprDs, 'ontology');

// compara homology dumps
const comparaNames = (() => {
  const j = JSON.parse(fs.readFileSync(path.join(RELEASE_ROOT, 'gramene-mongodb/ensembl_db_info.json'), 'utf8'));
  return {
    compara: j.compara?.database ?? null,
    cores: (j.cores ?? []).map(c => (typeof c === 'string' ? c : c.database)).filter(Boolean),
    variations: (j.variations ?? []).map(c => (typeof c === 'string' ? c : c.database)).filter(Boolean),
  };
})();
const compDs = ds('ensembl-compara', comparaNames.compara ?? 'unknown', { description: 'Compara db the gene trees and homologies came from' });
for (const f of ['homology.tsv.gz', 'homology_member.tsv.gz', 'gene_member.tsv.gz', 'homolog_pairs.sorted.tsv.gz'])
  add(path.join(I.homology_dir, f), compDs, 'homology');
for (const v of comparaNames.variations) ds('ensembl-variation', v, { description: 'Ensembl variation database (names only)' });

// expression
const atlasDs = ds('expression-atlas-downloads', mtimeIso(I.atlas_dir).slice(0, 10), {
  description: 'EBI Expression Atlas IDF and assay-group files downloaded by the release build',
  source_url: 'https://ftp.ebi.ac.uk/pub/databases/microarray/data/atlas/experiments/',
});
addGlob(I.atlas_dir, /\.idf\.txt$|^(contrastdetails|assaygroupsdetails)\.tsv$/, atlasDs, 'expression');
const jgiDs = ds('jgi-sorghum-expression', 'Sbicolor.v3.1.1', { description: 'JGI/Phytozome sorghum expression (curator TSVs); citation awaiting submitter' });
addGlob(I.jgi_dir, /\.tsv$/, jgiDs, 'expression');
const exprManifest = path.join(I.expression_pipeline, 'manifest.json');
const exprSha = fs.existsSync(exprManifest) ? (await sha256File(exprManifest)).slice(0, 12) : 'unknown';
const exprDs = ds('expression-attributes-inputs', exprSha, { description: 'Inputs and code of the expression_attributes pipeline' });
addGlob(I.expression_pipeline, /^(manifest\.json|expression_panel\.json|inv_\d+\.json|ref_\d+\.json|po_map\.py|score\.py|expr_lib\.py|assemble_config\.py)$/, exprDs, 'expression');

// variation / germplasm
const okDate = mtimeIso(I.rsid_ok).slice(0, 10);
const rsidDs = ds('rsid-projection-anchor', okDate, { description: 'EVA rsIDs windowed onto sorghum_bicolor genes (anchor genome)' });
add(I.rsid_table, rsidDs, 'variation'); add(I.rsid_ok, rsidDs, 'variation'); add(I.rsid_vcf, rsidDs, 'variation');
const vepDs = ds('vep-lof-table', 'v10', { description: 'Per-gene VEP LoF sample table reused by v11 (lineage: v9 sorghum_vep.txt2)' });
add(I.vep_table, vepDs, 'variation'); add(fs.realpathSync(I.vep_lineage), vepDs, 'variation');
const grinDs = ds('grin-global-sorghum-export', path.basename(I.grin_export).match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? 'unknown', {
  description: 'GRIN-Global BrAPI germplasm export staged in gramene-g2p test@1', source_url: 'https://npgsweb.ars-grin.gov/gringlobal/brapi/v2/germplasm',
});
add(I.grin_export, grinDs, 'germplasm');
const grDs = ds('grassius', mtimeIso(I.grassius_tsv).slice(0, 10), { description: 'GRASSIUS transcription factor family table' });
add(I.grassius_tsv, grDs, 'annotation');
const ssDs = ds('saved-search-backup', mtimeIso(I.saved_search_backup).slice(0, 10), { description: 'saved_search tags exported from the genes core' });
add(I.saved_search_backup, ssDs, 'collection');
const vsiDs = ds('vep-study-info', git(path.dirname(I.vep_study_info), 'log', '-1', '--format=%h', '--', path.basename(I.vep_study_info)) ?? 'unknown', {
  description: 'gramene-search study/population labels (vepStudyInfo.js)' });
add(I.vep_study_info, vsiDs, 'germplasm');

// the KG's own curated config tables
const cfgDs = ds('gramene-kg-config', git(KG_ROOT, 'rev-parse', '--short=12', 'HEAD') ?? 'uncommitted', { description: 'gramene-kg crosswalk and evidence tables' });
for (const f of ['populations.tsv', 'germplasm_sources.tsv', 'genome_registry.tsv', 'po_organ_map.json', 'release.yaml'])
  add(path.join(cfg.release_cfg_dir, f), cfgDs, 'config');
for (const f of ['prefixes.yaml', 'infores.yaml', 'evidence-map.yaml', 'known_dangling.yaml'])
  add(path.join(KG_ROOT, 'config', f), cfgDs, 'config');
const blDs = ds('biolink-model', '4.4.6', { source_url: 'https://raw.githubusercontent.com/biolink/biolink-model/v4.4.6/biolink-model.yaml' });
add(path.join(KG_ROOT, 'schema/vendor/biolink-model-4.4.6.yaml'), blDs, 'schema');
add(path.join(KG_ROOT, 'schema/vendor/attributes.yaml'), blDs, 'schema');

// ---- 2. network snapshots (sha256-stamped; offline-safe) --------------------------------------
const snapDir = buildOut('extract', 'snapshots', '.keep').replace(/\.keep$/, '');
const snapshots = await pool(Object.entries(cfg.snapshots ?? {}), 4, async ([name, url]) => {
  const file = path.join(snapDir, `${name}.json`);
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = Buffer.from(await r.arrayBuffer());
    JSON.parse(body.toString('utf8'));       // must be JSON
    await fsp.writeFile(file, body);
    log(`snapshot ${name}: ${body.length} bytes`);
    return { name, url, file, ok: true };
  } catch (e) {
    log(`snapshot ${name} FAILED (${e.message}); continuing without it`);
    return { name, url, file: null, ok: false, error: e.message };
  }
});
for (const s of snapshots) if (s.ok) add(s.file, ds(`snapshot-${s.name}`, now.slice(0, 10), { source_url: s.url }), 'snapshot');

// ---- 3. Mongo catalogue: shared loads ledgers, core dbs, release stamps -----------------------
const client = await MongoClient.connect(env('MONGO_URI'));
const ontLoads = await client.db('ontology').collection('loads').aggregate([
  { $match: { status: 'ok' } }, { $sort: { finished_at: -1 } },
  { $group: { _id: '$collection', r: { $first: '$$ROOT' } } }]).toArray();
for (const { r } of ontLoads) ds(`ontology-db-${r.collection}`, r.version ?? 'unknown', {
  description: `shared ontology db collection ${r.collection} (node set)`, source_url: r.source_url ?? null,
  loaded_at: r.finished_at?.toISOString?.() ?? null, count: r.count ?? null });
const ensLoads = await client.db('ensembl').collection('loads').find({ status: 'ok' }).sort({ finished_at: -1 }).limit(1).toArray();
for (const r of ensLoads) ds('ensembl-organisms-species', r.source_last_updated ?? r.version ?? 'unknown', { source_url: r.source_url ?? null });
const maps = await client.db(SRC_DB).collection('maps').find({}, { projection: { _id: 1, db: 1, system_name: 1 } }).toArray();
for (const m of maps) ds('ensembl-core', m.db, { description: `Ensembl core db for ${m.system_name} (${m._id})` });
await client.close();

const stampsDir = path.join(RELEASE_ROOT, 'build/.state');
const stageStamps = Object.fromEntries(fs.readdirSync(stampsDir).filter(f => f.endsWith('.done')).sort()
  .map(f => [f.replace(/\.done$/, ''), fs.readFileSync(path.join(stampsDir, f), 'utf8').trim()]));

// ---- 4. hash every Distribution ---------------------------------------------------------------
log(`hashing ${files.length} input files`);
const t0 = Date.now();
const dists = await pool(files, 4, async (f) => {
  const st = fs.statSync(f.path);
  const sha = await sha256File(f.path);
  return {
    id: `gramene.dist:sha256-${sha}`, category: ['biolink:DatasetDistribution'],
    name: path.basename(f.path), path: f.path, sha256: sha, bytes: st.size, mtime: st.mtime.toISOString(),
    dataset: f.dataset, role: f.role, release: RELEASE_ID, ingest_run: RUN_ID,
  };
});
log(`hashed ${dists.length} files, ${(dists.reduce((a, d) => a + d.bytes, 0) / 1e9).toFixed(2)} GB in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
// identical files (same sha) are one Distribution; keep every path
const distById = new Map();
for (const d of dists) {
  const e = distById.get(d.id);
  if (e) { e.paths = [...new Set([...(e.paths ?? [e.path]), d.path])]; e.datasets = [...new Set([...(e.datasets ?? [e.dataset]), d.dataset])]; }
  else distById.set(d.id, { ...d });
}

// ---- 5. software, analyses, release, run --------------------------------------------------------
const kgSha = git(KG_ROOT, 'rev-parse', 'HEAD');
const kgDirty = (git(KG_ROOT, 'status', '--porcelain') ?? '').length > 0;
const software = [{ id: `gramene.software:gramene-kg@${(kgSha ?? '0000000').slice(0, 12)}`, name: 'gramene-kg', git_sha: kgSha, dirty: kgDirty,
  repo: 'https://github.com/warelab/gramene-kg' }];
for (const r of ['build', 'gramene-mongodb', 'gramene-solr', 'gramene-mongodb-config']) {
  const sha = git(path.join(RELEASE_ROOT, r), 'rev-parse', 'HEAD');
  if (sha) software.push({ id: `gramene.software:${r.toLowerCase()}@${sha.slice(0, 12)}`, name: r, git_sha: sha,
    branch: git(path.join(RELEASE_ROOT, r), 'rev-parse', '--abbrev-ref', 'HEAD'), repo: `https://github.com/warelab/${r}` });
}
for (const s of software) s.category = ['biolink:Agent'];

// rsID windowing parameters: read only RSID_* defaults from the release config (never the MySQL lines)
const rsidParams = Object.fromEntries(fs.readFileSync(path.join(RELEASE_ROOT, 'build/config.sh'), 'utf8').split('\n')
  .map(l => l.match(/^export (RSID_[A-Z_]+)="\$\{\1:-([^}]*)\}"/)).filter(Boolean).map(m => [m[1], m[2]]));
const distsOf = (dsId) => [...distById.values()].filter(d => (d.datasets ?? [d.dataset]).includes(dsId)).map(d => d.id);
const analyses = [
  { id: `gramene.analysis:expression_attributes@${exprSha}`, name: 'expression_attributes (organ-level calls)',
    description: 'gramene-solr/expression_pipeline score.py over Atlas + JGI baseline experiments',
    used: distsOf(exprDs), parameters: JSON.stringify({ manifest_sha12: exprSha }),
    ended_at: stageStamps['58_expression_attributes'] ?? null },
  { id: `gramene.analysis:rsid-windowing@${sha256Text(JSON.stringify(rsidParams)).slice(0, 12)}`, name: 'rsID projection and CDS windowing',
    used: distsOf(rsidDs), parameters: JSON.stringify(rsidParams), ended_at: stageStamps['62_attr_atomic_rsid'] ?? null },
  { id: 'gramene.analysis:vep-lof-table@v10', name: 'per-gene VEP LoF sample table',
    description: 'dump_gene_level_VEP_table.pl over sorghum_bicolor_variation_11_108_30; VEP version not recorded',
    used: distsOf(vepDs), parameters: JSON.stringify({ variation_dbs: comparaNames.variations }) },
  { id: `gramene.analysis:qtl-containment@${(kgSha ?? '0000000').slice(0, 7)}`, name: 'gene-in-QTL interval containment',
    description: 'gene fully inside a QTL interval on the same map and region (rule of addQtlXrefs.js), QTL ids kept',
    used: [], parameters: JSON.stringify({ rule: 'g.map=q.map AND g.region=q.region AND g.start>=q.start AND g.end<=q.end' }) },
];
for (const a of analyses) { a.category = ['biolink:Activity']; a.was_associated_with = software[0].id; a.release = RELEASE_ID; }

const release = {
  id: RELEASE_ID, category: ['biolink:Dataset'], name: `SorghumBase ${RELEASE}`, site: cfg.site, db_name: SRC_DB,
  genes_core: cfg.genes_core, suggestions_core: cfg.suggestions_core, passthrough_api: cfg.passthrough_api,
  previous_release: cfg.previous_release, compara_db: comparaNames.compara, n_core_dbs: comparaNames.cores.length,
  variation_dbs: comparaNames.variations, stage_stamps: JSON.stringify(stageStamps),
  built_at: Object.values(stageStamps).sort().at(-1) ?? null,
};
const run = {
  id: RUN_ID, category: ['biolink:Activity'], name: `gramene-kg build ${BUILD_ID} of ${RELEASE}`, started_at: now,
  used: [...distById.keys()], was_associated_with: software[0].id, release: RELEASE_ID,
  parameters: JSON.stringify({ build_id: BUILD_ID, release_root: RELEASE_ROOT, src_db: SRC_DB }),
  snapshots: JSON.stringify(snapshots.map(({ name, url, ok, error }) => ({ name, url, ok, error }))),
};
for (const d of datasets.values()) { d.release = RELEASE_ID; d.ingest_run = RUN_ID; }

// ---- 6. write NDJSON + Parquet ---------------------------------------------------------------
const classes = {
  KgRelease: [release], IngestRun: [run], SoftwareAgent: software, AnalysisRun: analyses,
  KgDataset: [...datasets.values()], KgDistribution: [...distById.values()],
};
const counts = {};
for (const [cls, rows] of Object.entries(classes)) {
  const nd = buildOut('catalogue', `${cls}.ndjson`);
  const w = new NdjsonWriter(nd);
  for (const r of rows) await w.write(r);
  await w.close();
  counts[cls] = await ndjsonToParquet(nd, buildOut('parquet', 'nodes', `${cls}.parquet`));
  log(`${cls}: ${counts[cls]}`);
}
fs.writeFileSync(buildOut('catalogue', 'summary.json'), JSON.stringify({ release: RELEASE, build_id: BUILD_ID, run: RUN_ID, counts,
  snapshots: run.snapshots && JSON.parse(run.snapshots), ontology_versions_release_tree: [...datasets.values()].filter(d => d.id.includes('release-tree')).map(d => d.id) }, null, 2));
const bad = [...distById.values()].filter(d => !/^[0-9a-f]{64}$/.test(d.sha256));
if (bad.length) { log(`FATAL: ${bad.length} distributions without sha256`); process.exit(1); }
log('catalogue complete');
