// kg60 load: final Parquet -> per-build Mongo db kg_<release>_b<BUILD_ID> (nodes, edges, manifest).
// Lean documents: nulls and empty arrays dropped; provenance strings that are constant for the build
// (release, ingest run, aggregator sources) live once in `manifest` and are re-expanded by the API.
import fs from 'node:fs';
import readline from 'node:readline';
import { MongoClient } from 'mongodb';
import { env, buildOut, exec, q, sqlStr, log } from './kgio.mjs';
import { swapIn } from './swap.mjs';

const KG_DB = env('KG_DB'); const RELEASE = env('RELEASE'); const BUILD_ID = env('BUILD_ID');
if (new RegExp(env('PROTECTED_DB_RE')).test(KG_DB) || ['kg_meta', 'kg_curation'].includes(KG_DB)) throw new Error(`refusing to load into ${KG_DB}`);
const FINAL = (n) => sqlStr(buildOut('parquet', 'final', `${n}.parquet`));
const RUN = `gramene.run:${RELEASE}-${BUILD_ID}`;

const clean = (o) => { for (const k of Object.keys(o)) { const v = o[k];
  if (v == null || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)) delete o[k]; } return o; };
async function* ndjson(file, map) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) if (line) yield map(JSON.parse(line));
}

// ---- nodes ----
const nodesNd = buildOut('work', 'mongo_nodes.ndjson');
await exec(`COPY (SELECT id, category, cls, name, description, aliases, xrefs, in_taxon, genome, tree, region, start, "end", strand, attrs, deg, degree, solr, card
  FROM ${FINAL('nodes')}) TO ${sqlStr(nodesNd)} (FORMAT json)`);
const client = await MongoClient.connect(env('MONGO_URI'), { maxPoolSize: 8 });
const db = client.db(KG_DB);
const lc = (a) => a.length ? [...new Set(a.map(x => String(x).toLowerCase()))] : null;
const meta = { release: RELEASE, build_id: BUILD_ID, ingest_run: RUN };
let t0 = Date.now();
const nNodes = await swapIn(db, 'nodes', ndjson(nodesNd, (r) => clean({
  _id: r.id, cat: r.category, cls: r.cls, name: r.name, desc: r.description, aliases: r.aliases,
  // aliases plus doi: xrefs, so a DOI resolves to its PMID-keyed publication
  aliases_lc: lc([...(r.aliases ?? []), ...(r.xrefs ?? []).filter(x => String(x).startsWith('doi:'))]),
  xrefs: r.xrefs, tax: r.in_taxon, genome: r.genome, tree: r.tree,
  loc: r.region != null ? clean({ region: r.region, start: r.start, end: r.end, strand: r.strand }) : null,
  attrs: clean(JSON.parse(r.attrs || '{}')), deg: JSON.parse(r.deg || '{}'), degree: r.degree, solr: r.solr || null, card: r.card,
})), { meta, indexes: [{ cls: 1 }, { aliases_lc: 1 }, { genome: 1, 'loc.region': 1, 'loc.start': 1 }, { tree: 1 }, { name: 1 }] });
log(`nodes ${nNodes} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

// ---- edges (materialised only) ----
const edgesNd = buildOut('work', 'mongo_edges.ndjson');
await exec(`COPY (SELECT * FROM ${FINAL('edges_mongo')}) TO ${sqlStr(edgesNd)} (FORMAT json)`);
t0 = Date.now();
const nEdges = await swapIn(db, 'edges', ndjson(edgesNd, (r) => clean({
  _id: r.id, s: r.subject, p: r.predicate, o: r.object, sc: r.subject_cls, oc: r.object_cls, src: r.primary_knowledge_source,
  kl: r.knowledge_level, at: r.agent_type, ev: r.has_evidence, oev: r.original_evidence, pubs: r.publications, studies: r.has_supporting_studies,
  m: r.method, orig: clean({ s: r.original_subject, o: r.original_object }), rec: r.source_record, ksv: r.knowledge_source_version,
  neg: r.negated ? true : null, q: clean(JSON.parse(r.qualifiers || '{}')), fam: r.family, layer: r.layer,
})), { meta, indexes: [{ s: 1, p: 1, _id: 1 }, { o: 1, p: 1, _id: 1 }] });
log(`edges ${nEdges} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

// ---- manifest ----
const counts = JSON.parse(fs.readFileSync(buildOut('counts.json'), 'utf8'));
const summary = JSON.parse(fs.readFileSync(buildOut('catalogue', 'summary.json'), 'utf8'));
await db.collection('manifest').deleteMany({});
await db.collection('manifest').insertOne({ _id: 'build', release: RELEASE, build_id: BUILD_ID, ingest_run: RUN, loaded_at: new Date(),
  aggregator_knowledge_source: ['infores:gramene-kg', 'infores:sorghumbase'], counts, catalogue: summary, kg_db: KG_DB,
  solr_core: `kg_${RELEASE}_b${BUILD_ID}` });
const st = await db.stats();
log(`db ${KG_DB}: dataSize ${(st.dataSize / 1e9).toFixed(2)} GB, storage ${(st.storageSize / 1e9).toFixed(2)} GB, indexes ${(st.indexSize / 1e9).toFixed(2)} GB`);
await client.close();
fs.rmSync(nodesNd); fs.rmSync(edgesNd);
