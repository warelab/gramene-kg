// curated.mjs — the curated layer as a kg20 source (docs/curation.md "Build side").
//
// Reads kg_curation (db KG_CURATION_DB, default kg_curation): public workspaces, their curated nodes
// (one record per workspace and CURIE: _id "<ws>|<curie>"), and per assertion id the highest revision,
// kept when it is `published` and not superseded by another baked assertion. What was read is written canonically to extract/snapshots/kg_curation.json (sha256
// recorded as a KgDataset + KgDistribution), so KG_CURATION_SNAPSHOT=<that file> replays a build
// without Mongo. Firebase uids, ACLs and emails are never read into the snapshot.
//
// Output (only when the snapshot holds a node or an assertion; an empty kg_curation changes no node or edge):
//   graph nodes: curated nodes merged into existing ones (ETL fields kept, ETL xrefs kept in order with new
//     curated xrefs appended, each public workspace's record under attrs.curated.<ws>), new ones appended
//     to their class file, Association nodes (>= 2 evidence lines);
//   graph/curated/node_overlay.parquet: the merge patch, re-applied by kg40 (kg25 rewrites Publication attrs);
//   graph edges/curated.parquet: one edge per baked assertion, id per the contract, layer 'curated',
//     asn {id, rev};
//   attach_report.json + kg_curation.attach_reports[<release>@<build>] (the build's one write there), written
//     on every run (an empty list when nothing is unresolved); an empty read also removes a stale snapshot.
import fs from 'node:fs';
import path from 'node:path';
import { env, loadYaml, buildOut, sha256Text, NdjsonWriter, exec, q, sqlStr, log } from './kgio.mjs';
// one implementation of the contract ids, shared with the API (pure functions, no I/O)
import { CURATION_SOURCE, associationId, curatedEdgeId } from '../../apps/api/curation-ids.mjs';

export { CURATION_SOURCE };
const CLS = { GramenePublication: ['biolink:Publication'], AnalysisRun: ['biolink:Activity'],
  KgCollection: ['biolink:InformationContentEntity'], Association: ['biolink:Association'] };
const KL = ['knowledge_assertion', 'logical_entailment', 'prediction', 'statistical_association', 'observation', 'text_co_occurrence', 'not_provided'];
const NODE_F = ['_id', 'curie', 'workspace', 'cls', 'name', 'description', 'xrefs', 'attrs', 'rev', 'content_sha256', 'created_at', 'updated_at'];
const ASN_F = ['_id', 'id', 'rev', 'latest', 'workspace', 'state', 'subject', 'predicate', 'object', 'qualifiers', 'negated', 'evidence',
  'note', 'disputes', 'supersedes', 'association_id', 'edge_id', 'content_sha256', 'created_at', 'updated_at'];
// the only dbs the attach-report write may target
const WRITABLE_DB = /^kg_curation(_fixture\w*|_test\w*)?$/;

// canonical JSON: sorted keys, no whitespace, undefined dropped, Dates as ISO strings
export const canon = (v) => v instanceof Date ? JSON.stringify(v.toISOString())
  : Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : (v && typeof v === 'object') ? `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`
  : JSON.stringify(v ?? null);
const pick = (o, f) => Object.fromEntries(f.filter(k => o[k] !== undefined).map(k => [k, o[k]]));
const bare = (id) => id.replace(/^gramene\.assoc:/, '');
// a curated node record's CURIE (_id "<ws>|<curie>"; snapshots before per-workspace nodes had _id = the CURIE)
export const curieOf = (n) => n.curie ?? (String(n._id).includes('|') ? String(n._id).slice(String(n._id).indexOf('|') + 1) : n._id);
// SQL: the ETL xrefs unchanged (order and multiplicity), then the curated xrefs the ETL list lacks
export const xrefMergeSql = (etl, cur) => `CASE WHEN len(list_filter(coalesce(${cur}, []), lambda x: NOT list_contains(coalesce(${etl}, []), x))) = 0 THEN ${etl}
  ELSE list_concat(coalesce(${etl}, []), list_filter(${cur}, lambda x: NOT list_contains(coalesce(${etl}, []), x))) END`;
const uniq = (xs) => [...new Set(xs)];
// contract ids (docs/curation.md), as 24-hex edge ids: association = sha256-24 of subject|predicate|object|assertion id;
// edge = sha256-24 of subject|predicate|object|infores:sorghumbase-curation|<canonical qualifiers json>|assertion id
export const associationHex = (a) => bare(associationId(a.subject, a.predicate, a.object, a.id));
export const curatedEdgeHex = (a) => bare(curatedEdgeId(a.subject, a.predicate, a.object, a.qualifiers, a.id));
export const isAssociation = (a) => (a.evidence ?? []).length >= 2 || !!a.association_id;

// ---- read ---------------------------------------------------------------------------------------
export async function readCuration({ uri = env('MONGO_URI'), dbName = process.env.KG_CURATION_DB || 'kg_curation' } = {}) {
  const { MongoClient } = await import('mongodb');
  const cl = await MongoClient.connect(uri);
  try {
    const db = cl.db(dbName);
    const workspaces = (await db.collection('workspaces').find({ visibility: 'public' }, { projection: { _id: 1, name: 1, visibility: 1 } })
      .sort({ _id: 1 }).toArray());
    const ws = workspaces.map(w => w._id);
    // per workspace and CURIE (unique index {curie, workspace}); a CURIE may be curated in several workspaces
    const curated_nodes = (await db.collection('curated_nodes').find({ workspace: { $in: ws } }).sort({ curie: 1, workspace: 1, _id: 1 }).toArray())
      .map(n => pick(n, NODE_F));
    // highest revision per assertion id (readers take the highest rev; `latest` can briefly be true on two)
    const top = await db.collection('assertions').aggregate([{ $match: { workspace: { $in: ws } } }, { $sort: { id: 1, rev: -1 } },
      { $group: { _id: '$id', doc: { $first: '$$ROOT' } } }]).toArray();
    const assertions = top.map(t => t.doc).filter(a => a.state === 'published').map(a => pick(a, ASN_F)).sort((a, b) => a.id < b.id ? -1 : 1);
    return { db: dbName, workspaces, curated_nodes, assertions, read_at: new Date().toISOString() };
  } finally { await cl.close(); }
}
export const snapshotText = (s) => canon({ format: 'gramene-kg kg_curation snapshot v2', db: s.db,
  rule: 'public workspaces; curated nodes of those (one record per workspace and CURIE); per assertion id the highest revision when state is published',
  workspaces: s.workspaces, curated_nodes: s.curated_nodes, assertions: s.assertions }) + '\n';
export const isEmpty = (s) => !s.curated_nodes.length && !s.assertions.length;

// ---- transform --------------------------------------------------------------------------------
// snap: from readCuration (or a replayed snapshot file). Returns counts for transform_counts.json.
export async function curatedLayer(snap, { release, build, writeReport = true, prefixes, evidence }) {
  const G = (kind, name) => buildOut('parquet', 'graph', kind, `${name}.parquet`);
  const NODES = sqlStr(path.join(env('BUILD_OUT'), 'parquet', 'graph', 'nodes', '*.parquet'));
  const counts = { db: snap.db, public_workspaces: snap.workspaces.length, curated_nodes_read: snap.curated_nodes.length,
    published_assertions_read: snap.assertions.length, nodes_merged: 0, nodes_added: {}, nodes_skipped_bad_id: [], association_nodes: 0,
    edges: 0, superseded_excluded: 0, unresolved: 0, eco_dropped: [], knowledge_level_defaulted: 0, id_mismatch: [] };
  const DEF = evidence ?? { primary_knowledge_source: CURATION_SOURCE, knowledge_level: 'knowledge_assertion', agent_type: 'manual_agent' };

  // ---- snapshot -> extract/, Dataset + Distribution ----
  const text = snapshotText(snap);
  const snapFile = buildOut('extract', 'snapshots', 'kg_curation.json');
  fs.writeFileSync(snapFile, text);
  const sha = sha256Text(text); const v12 = sha.slice(0, 12);
  const RUN = `gramene.run:${release}-${build}`; const REL = `gramene.release:${release}`;
  const dsId = `gramene.dataset:kg-curation@${v12}`;
  const dataset = { id: dsId, category: ['biolink:Dataset'], name: `kg-curation ${v12}`, version: v12,
    description: `${snap.db}: published assertions and curated nodes of public workspaces, read ${snap.read_at ?? 'from a replayed snapshot'}`,
    read_at: snap.read_at ?? null, db: snap.db, n_assertions: snap.assertions.length, n_curated_nodes: snap.curated_nodes.length,
    release: REL, ingest_run: RUN };
  const st = fs.statSync(snapFile);
  const dist = { id: `gramene.dist:sha256-${sha}`, category: ['biolink:DatasetDistribution'], name: 'kg_curation.json', path: snapFile,
    sha256: sha, bytes: st.size, mtime: st.mtime.toISOString(), dataset: dsId, role: 'curation', release: REL, ingest_run: RUN };
  counts.dataset = dsId; counts.snapshot_sha256 = sha;

  // ---- id rules (config/prefixes.yaml, same rule as the kg30 gate) ----
  const rules = new Map([...Object.entries(prefixes.external).map(([p, v]) => [p, new RegExp(v.pattern)]),
    ...Object.entries(prefixes.local).map(([p, re]) => [p, new RegExp(re)])]);
  const validId = (id) => { const i = String(id).indexOf(':'); const re = i > 0 && rules.get(id.slice(0, i));
    return !!re && re.test(id.slice(i + 1)) && (!id.slice(i + 1).includes('/') || id.startsWith('doi:')); };

  // ---- assertions: drop those a baked assertion supersedes ----
  const supersededIds = new Set(snap.assertions.map(a => a.supersedes).filter(Boolean).map(s => String(s).split('@')[0]));
  const asns = snap.assertions.filter(a => !supersededIds.has(a.id));
  counts.superseded_excluded = snap.assertions.length - asns.length;

  // ---- curated nodes, grouped by CURIE (Association nodes are derived from assertions below) ----
  // One graph node per CURIE; each public workspace's record goes under attrs.curated.<ws>. A CURIE new to
  // the graph takes cls, name, description and top-level attrs from its earliest record (created_at, then
  // workspace id); its xrefs are the records' xrefs in that order, without repeats.
  const groups = new Map();
  for (const n of snap.curated_nodes) {
    const curie = curieOf(n);
    if (n.cls === 'Association') continue;
    if (!CLS[n.cls] || !validId(curie)) { counts.nodes_skipped_bad_id.push({ id: curie, workspace: n.workspace ?? null, cls: n.cls }); continue; }
    if (!groups.has(curie)) groups.set(curie, []);
    groups.get(curie).push(n);
  }
  const first = (a, b) => String(a.created_at ?? '') < String(b.created_at ?? '') ? -1 : String(a.created_at ?? '') > String(b.created_at ?? '') ? 1
    : String(a.workspace) < String(b.workspace) ? -1 : String(a.workspace) > String(b.workspace) ? 1 : 0;
  const cnodes = [...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([curie, recs]) => { recs.sort(first); return { curie, recs, primary: recs[0], xrefs: uniq(recs.flatMap(r => r.xrefs ?? [])) }; });
  counts.curated_node_curies = cnodes.length;
  // one workspace's record (null fields left out, so merged and new nodes carry the same shape)
  const wsRecord = (n, extra = {}) => Object.fromEntries(Object.entries({ source: CURATION_SOURCE, rev: n.rev, content_sha256: n.content_sha256,
    cls: n.cls, name: n.name, description: n.description, xrefs: n.xrefs ?? [], attrs: n.attrs ?? {}, ...extra }).filter(([, v]) => v != null));
  const curatedPatch = (g, etlCls = null) => ({ curated: Object.fromEntries(g.recs.map(r => [r.workspace,
    wsRecord(r, etlCls && etlCls !== r.cls ? { etl_cls: etlCls } : {})])) });

  // stage curated node ids + assertion CURIEs, look them up in the graph once
  const wd = (f) => buildOut('work', 'curated', f);
  const wIds = new NdjsonWriter(wd('ids.ndjson'));
  for (const g of cnodes) await wIds.write({ id: g.curie });
  for (const a of asns) { await wIds.write({ id: a.subject }); await wIds.write({ id: a.object }); }
  await wIds.write({ id: '' }); await wIds.close();
  await exec(`CREATE OR REPLACE TABLE cur_ids AS SELECT DISTINCT id FROM read_json(${sqlStr(wd('ids.ndjson'))}, format='newline_delimited', columns={id:'VARCHAR'})`);
  const found = await q(`SELECT n.id, n.cls, n.filename FROM read_parquet(${NODES}, union_by_name=true, filename=true) n SEMI JOIN cur_ids c ON c.id = n.id`);
  const inGraph = new Map(found.map(r => [r.id, r]));

  // merged vs new
  const overlay = []; const newNodes = [];
  for (const g of cnodes) {
    const hit = inGraph.get(g.curie);
    if (hit) { overlay.push({ id: g.curie, xrefs: g.xrefs, patch: canon(curatedPatch(g, hit.cls)), file: hit.filename }); counts.nodes_merged++; }
    else {
      const p = g.primary;
      newNodes.push({ id: g.curie, category: CLS[p.cls], cls: p.cls, name: g.recs.map(r => r.name).find(Boolean) || g.curie,
        description: g.recs.map(r => r.description).find(Boolean) ?? null, aliases: [], xrefs: g.xrefs,
        attrs: canon({ ...(p.attrs ?? {}), ...curatedPatch(g), curated_only: true }) });
      // curated_only also in the overlay, so the kg40 re-apply restores it if kg25 rewrote the node's attrs
      overlay.push({ id: g.curie, xrefs: g.xrefs, patch: canon({ ...curatedPatch(g), curated_only: true }), file: null });
    }
  }
  const known = new Set([...inGraph.keys(), ...newNodes.map(n => n.id)]);

  // ---- resolve endpoints; unresolved -> attach report ----
  const unresolved = []; const baked = [];
  for (const a of asns) {
    const miss = [['subject', a.subject], ['object', a.object]].filter(([, c]) => !known.has(c));
    if (miss.length) { for (const [role, curie] of miss) unresolved.push({ assertion: a.id, rev: a.rev, curie, role, suggestions: [] }); }
    else baked.push(a);
  }
  counts.unresolved = unresolved.length;
  if (unresolved.length) {
    const wu = new NdjsonWriter(wd('unresolved.ndjson'));
    for (const c of new Set(unresolved.map(u => u.curie))) { const i = c.indexOf(':');
      await wu.write({ curie: c, prefix: i > 0 ? c.slice(0, i) : '', local: i > 0 ? c.slice(i + 1) : c }); }
    await wu.close();
    // exact id (any case) 3, alias / xref 2, same prefix by Jaro-Winkler >= 0.8 (score = similarity)
    const sug = await q(`WITH u AS (SELECT * FROM read_json(${sqlStr(wd('unresolved.ndjson'))}, format='newline_delimited', columns={curie:'VARCHAR', prefix:'VARCHAR', local:'VARCHAR'})),
      n AS (SELECT id, aliases, xrefs, split_part(id, ':', 1) AS prefix, substr(id, length(split_part(id, ':', 1)) + 2) AS local FROM read_parquet(${NODES}, union_by_name=true)),
      al AS (SELECT id, lower(unnest(list_concat(coalesce(aliases, []), coalesce(xrefs, []), [local]))) AS k FROM n),
      uk AS (SELECT curie, lower(local) AS k FROM u UNION SELECT curie, lower(curie) FROM u),
      c AS (SELECT u.curie, n.id, 3.0 AS score FROM u JOIN n ON lower(n.id) = lower(u.curie)
        UNION ALL SELECT uk.curie, al.id, 2.0 FROM uk JOIN al ON al.k = uk.k
        UNION ALL SELECT u.curie, n.id, jaro_winkler_similarity(lower(n.local), lower(u.local)) FROM u JOIN n ON n.prefix = u.prefix
          WHERE jaro_winkler_similarity(lower(n.local), lower(u.local)) >= 0.8)
      SELECT curie, to_json(list(id ORDER BY score DESC, id)[1:5])::VARCHAR AS ids FROM (SELECT curie, id, max(score) AS score FROM c GROUP BY ALL) GROUP BY curie`);
    const byCurie = new Map(sug.map(r => [r.curie, JSON.parse(r.ids)]));
    for (const u of unresolved) u.suggestions = byCurie.get(u.curie) ?? [];
  }

  // ---- edges + Association nodes ----
  const eco = new Set((await q(`SELECT id FROM read_parquet(${sqlStr(G('nodes', 'EvidenceCodeTerm'))})`)).map(r => r.id));
  const edges = [];
  for (const a of baked) {
    const ev = a.evidence ?? [];
    const allEco = [...new Set(ev.flatMap(e => e.has_evidence ?? []))];
    const okEco = allEco.filter(e => eco.has(e)).sort();
    for (const e of allEco) if (!eco.has(e)) counts.eco_dropped.push({ assertion: a.id, eco: e });
    let kl = ev.map(e => e.knowledge_level).find(Boolean) ?? DEF.knowledge_level;
    if (!KL.includes(kl)) { kl = DEF.knowledge_level; counts.knowledge_level_defaulted++; }
    const assoc = isAssociation(a);
    const hex = assoc ? associationHex(a) : curatedEdgeHex(a);
    // ids the API stored on the assertion must agree with the build's
    if (assoc && a.association_id && String(a.association_id).replace(/^gramene\.assoc:/, '') !== hex) counts.id_mismatch.push({ assertion: a.id, field: 'association_id', stored: a.association_id, build: hex });
    if (a.edge_id && String(a.edge_id).replace(/^gramene\.assoc:/, '') !== hex) counts.id_mismatch.push({ assertion: a.id, field: 'edge_id', stored: a.edge_id, build: hex });
    edges.push({ id: hex, subject: a.subject, predicate: a.predicate, object: a.object, primary_knowledge_source: DEF.primary_knowledge_source,
      aggregator_knowledge_source: ['infores:gramene-kg', 'infores:sorghumbase'], knowledge_level: kl, agent_type: DEF.agent_type,
      has_evidence: okEco, original_evidence: null, publications: [...new Set(ev.flatMap(e => e.publications ?? []))].sort(),
      has_supporting_studies: [], method: null, original_subject: null, original_object: null,
      source_record: `${snap.db}.assertions ${a.id}@${a.rev}`, knowledge_source_version: v12, negated: !!a.negated, layer: 'curated',
      qualifiers: canon(a.qualifiers ?? {}), family: 'curated', slot: false, asn: { id: a.id, rev: a.rev } });
    if (assoc) {
      const aid = `gramene.assoc:${hex}`; const cn = snap.curated_nodes.find(n => curieOf(n) === aid && n.workspace === a.workspace);
      newNodes.push({ id: aid, category: CLS.Association, cls: 'Association', name: cn?.name || `${a.subject} ${a.predicate} ${a.object}`,
        description: cn?.description ?? a.note ?? null, aliases: [], xrefs: [],
        attrs: canon({ subject: a.subject, predicate: a.predicate, object: a.object, qualifiers: a.qualifiers ?? {}, negated: !!a.negated,
          // the API's Association record of this workspace, in the shape the API shows (wsRecord + assertion, assertion_rev)
          evidence: ev, curated: { [a.workspace]: cn ? wsRecord(cn, { assertion: a.id, assertion_rev: a.rev })
            : { source: CURATION_SOURCE, cls: 'Association', assertion: a.id, assertion_rev: a.rev } } }) });
      counts.association_nodes++;
    }
  }
  counts.edges = edges.length;

  // ---- write nodes ----
  const NODE_COLS = `{id:'VARCHAR', category:'VARCHAR[]', cls:'VARCHAR', name:'VARCHAR', description:'VARCHAR', aliases:'VARCHAR[]', xrefs:'VARCHAR[]', attrs:'VARCHAR'}`;
  const NODE_SEL = (src) => `SELECT id, category, cls, name, description, aliases, xrefs, NULL::VARCHAR AS in_taxon, NULL::VARCHAR AS genome, NULL::VARCHAR AS tree,
    NULL::VARCHAR AS region, NULL::BIGINT AS start, NULL::BIGINT AS "end", NULL::INTEGER AS strand, attrs FROM ${src}`;
  const wOv = new NdjsonWriter(wd('overlay.ndjson'));
  for (const o of overlay) await wOv.write({ id: o.id, xrefs: o.xrefs, patch: o.patch });
  await wOv.close();
  await exec(`CREATE OR REPLACE TABLE cur_overlay AS SELECT * FROM read_json(${sqlStr(wd('overlay.ndjson'))}, format='newline_delimited', columns={id:'VARCHAR', xrefs:'VARCHAR[]', patch:'VARCHAR'})`);
  await exec(`COPY cur_overlay TO ${sqlStr(G('curated', 'node_overlay'))} (FORMAT parquet, COMPRESSION zstd)`);
  const wN = new NdjsonWriter(wd('new_nodes.ndjson'));
  for (const n of newNodes) await wN.write(n);
  // the two catalogue rows, normalised as kg20 does for kg05 classes (attrs = the whole record)
  await wN.write({ id: dataset.id, category: dataset.category, cls: 'KgDataset', name: dataset.name, description: dataset.description, aliases: [], xrefs: [], attrs: canon(dataset) });
  await wN.write({ id: dist.id, category: dist.category, cls: 'KgDistribution', name: dist.name, description: null, aliases: [], xrefs: [], attrs: canon(dist) });
  await wN.close();
  await exec(`CREATE OR REPLACE TABLE cur_new AS ${NODE_SEL(`read_json(${sqlStr(wd('new_nodes.ndjson'))}, format='newline_delimited', columns=${NODE_COLS})`)}`);
  // the snapshot's own Distribution can already exist (identical file read twice): keep one
  await exec(`DELETE FROM cur_new WHERE cls IN ('KgDataset', 'KgDistribution') AND id IN (SELECT id FROM read_parquet(${NODES}, union_by_name=true) WHERE cls IN ('KgDataset', 'KgDistribution'))`);
  const touched = new Set([...overlay.filter(o => o.file).map(o => path.basename(o.file, '.parquet')),
    ...(await q(`SELECT DISTINCT cls FROM cur_new`)).map(r => r.cls)]);
  const nodeDelta = {};
  for (const cls of [...touched].sort()) {
    const f = G('nodes', cls); const tmp = f.replace(/\.parquet$/, '.curated.parquet');
    const old = fs.existsSync(f) ? `SELECT n.* REPLACE (CASE WHEN o.id IS NULL THEN n.xrefs ELSE ${xrefMergeSql('n.xrefs', 'o.xrefs')} END AS xrefs,
        CASE WHEN o.id IS NULL THEN n.attrs ELSE json_merge_patch(n.attrs, o.patch)::VARCHAR END AS attrs)
      FROM read_parquet(${sqlStr(f)}) n LEFT JOIN cur_overlay o ON o.id = n.id UNION ALL BY NAME ` : '';
    await exec(`COPY (${old}SELECT * FROM cur_new WHERE cls = ${sqlStr(cls)}) TO ${sqlStr(tmp)} (FORMAT parquet, COMPRESSION zstd)`);
    fs.renameSync(tmp, f);
    nodeDelta[cls] = Number((await q(`SELECT count(*)::BIGINT n FROM ${sqlStr(f)}`))[0].n);
    const added = Number((await q(`SELECT count(*)::BIGINT n FROM cur_new WHERE cls = ${sqlStr(cls)}`))[0].n);
    if (added) counts.nodes_added[cls] = added;
  }

  // ---- write edges (always a file, possibly empty, so asn is a column whenever a snapshot exists) ----
  const wE = new NdjsonWriter(wd('edges.ndjson'));
  for (const e of edges) await wE.write(e);
  await wE.close();
  await exec(`COPY (SELECT * FROM read_json(${sqlStr(wd('edges.ndjson'))}, format='newline_delimited', columns={id:'VARCHAR', subject:'VARCHAR', predicate:'VARCHAR',
      object:'VARCHAR', primary_knowledge_source:'VARCHAR', aggregator_knowledge_source:'VARCHAR[]', knowledge_level:'VARCHAR', agent_type:'VARCHAR',
      has_evidence:'VARCHAR[]', original_evidence:'VARCHAR', publications:'VARCHAR[]', has_supporting_studies:'VARCHAR[]', method:'VARCHAR',
      original_subject:'VARCHAR', original_object:'VARCHAR', source_record:'VARCHAR', knowledge_source_version:'VARCHAR', negated:'BOOLEAN',
      layer:'VARCHAR', qualifiers:'VARCHAR', family:'VARCHAR', slot:'BOOLEAN', asn:'STRUCT(id VARCHAR, rev INTEGER)'})) TO ${sqlStr(G('edges', 'curated'))} (FORMAT parquet, COMPRESSION zstd)`);

  // ---- attach report ----
  await writeAttachReport({ _id: `${release}@${build}`, release, build, created_at: new Date().toISOString(), snapshot_sha256: sha, unresolved,
    ...(counts.nodes_skipped_bad_id.length ? { invalid_nodes: counts.nodes_skipped_bad_id } : {}) }, snap.db, writeReport);
  log(`curated: ${edges.length} edges, ${counts.nodes_merged} nodes merged, ${JSON.stringify(counts.nodes_added)} added, ${unresolved.length} unresolved`);
  return { counts, nodeCounts: nodeDelta };
}

// attach_report.json, and (unless replaying a snapshot) the kg_curation.attach_reports doc <release>@<build>, both replaced
export async function writeAttachReport(report, dbName, toMongo) {
  fs.writeFileSync(buildOut('attach_report.json'), JSON.stringify(report, null, 1));
  if (!toMongo) return;
  if (!WRITABLE_DB.test(dbName)) throw new Error(`refusing to write attach_reports to ${dbName}`);
  const { MongoClient } = await import('mongodb');
  const cl = await MongoClient.connect(env('MONGO_URI'));
  try { await cl.db(dbName).collection('attach_reports').replaceOne({ _id: report._id }, report, { upsert: true }); } finally { await cl.close(); }
  log(`attach report ${report._id}: ${report.unresolved.length} unresolved CURIEs -> ${dbName}.attach_reports`);
}

// kg20 entry: read (or replay KG_CURATION_SNAPSHOT), then transform unless there is nothing published.
export async function curatedStage({ release, build, kgRoot }) {
  const replay = process.env.KG_CURATION_SNAPSHOT;
  let snap;
  if (replay) {
    const j = JSON.parse(fs.readFileSync(replay, 'utf8'));
    snap = { db: j.db, workspaces: j.workspaces, curated_nodes: j.curated_nodes, assertions: j.assertions, read_at: null };
    log(`curated: replaying ${replay}`);
  } else snap = await readCuration();
  if (isEmpty(snap)) {
    log(`curated: ${snap.db} has no published assertions or curated nodes in public workspaces; nothing to add`);
    // a re-run of kg20 in the same build must not leave the previous run's snapshot (kg30/kg50 key on it) or report
    fs.rmSync(path.join(env('BUILD_OUT'), 'extract', 'snapshots', 'kg_curation.json'), { force: true });
    await writeAttachReport({ _id: `${release}@${build}`, release, build, created_at: new Date().toISOString(), snapshot_sha256: null, unresolved: [],
      note: `${snap.db}: nothing published in public workspaces` }, snap.db, !replay);
    return { counts: { db: snap.db, public_workspaces: snap.workspaces.length, curated_nodes_read: 0, published_assertions_read: 0, edges: 0 }, nodeCounts: {} };
  }
  const EV = loadYaml(path.join(kgRoot, 'config/evidence-map.yaml'));
  return curatedLayer(snap, { release, build, writeReport: !replay, prefixes: loadYaml(path.join(kgRoot, 'config/prefixes.yaml')),
    evidence: EV.families?.curated_assertion });
}
