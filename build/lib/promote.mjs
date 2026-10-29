// kg80 promote: verify the build, flip kg_meta.releases.<release> to it, keep {new, previously current},
// retire everything else of this release (Solr core first, then db, then artifacts).
//
// Safety:
//  - refuses unless the build's manifest names this BUILD_ID, Mongo counts match counts.json, and the
//    Solr core exists with numDocs == counts.solr_docs
//  - never retires the build being promoted, the build that was current, the in-progress build id
//    (.state/<release>/build_id), or any build newer than the one being promoted
//  - a core that fails to unload keeps its db and artifacts and goes on pending_retire for the next run
import fs from 'node:fs';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { env, loadReleaseConfig, buildOut, log } from './kgio.mjs';

const RELEASE = env('RELEASE'); const BUILD_ID = env('BUILD_ID'); const KG_DB = env('KG_DB');
const SOLR = env('SOLR_URL'); const cfg = loadReleaseConfig();
const NAME_RE = new RegExp(`^kg_${RELEASE}_b([0-9]{12})$`);
const dbOf = (b) => `kg_${RELEASE}_b${b}`;
const die = (m) => { log(`FATAL: ${m}`); process.exit(1); };

const counts = JSON.parse(fs.readFileSync(buildOut('counts.json'), 'utf8'));
const client = await MongoClient.connect(env('MONGO_URI'));
try {
  // ---- verify the build -----------------------------------------------------------------------
  const db = client.db(KG_DB);
  const man = await db.collection('manifest').findOne({ _id: 'build' });
  if (!man || man.build_id !== BUILD_ID) die(`${KG_DB} has no manifest for build ${BUILD_ID}`);
  const nN = await db.collection('nodes').estimatedDocumentCount(); const nE = await db.collection('edges').estimatedDocumentCount();
  if (nN !== counts.nodes_total) die(`${KG_DB}.nodes has ${nN}, counts.json says ${counts.nodes_total}`);
  if (nE !== counts.edges_materialised) die(`${KG_DB}.edges has ${nE}, counts.json says ${counts.edges_materialised}`);
  const core = dbOf(BUILD_ID);
  const st = await (await fetch(`${SOLR}/admin/cores?action=STATUS&core=${core}&wt=json`)).json();
  const numDocs = st.status?.[core]?.index?.numDocs;
  if (numDocs !== counts.solr_docs) die(`Solr core ${core} numDocs ${numDocs} != counts.json solr_docs ${counts.solr_docs}`);
  log(`verified ${KG_DB}: nodes ${nN}, edges ${nE}, core ${core} numDocs ${numDocs}`);

  // ---- flip the pointer -----------------------------------------------------------------------
  const releases = client.db('kg_meta').collection('releases');
  const prev = await releases.findOne({ _id: RELEASE });
  const wasCurrent = prev?.current_build ?? null;
  const previous = wasCurrent && wasCurrent !== BUILD_ID ? wasCurrent : (prev?.previous_build ?? null);
  const keep = [...new Set([BUILD_ID, previous].filter(Boolean))];
  await releases.updateOne({ _id: RELEASE }, { $set: {
    site: cfg.site, current_build: BUILD_ID, db_name: KG_DB, solr_core: core, previous_build: previous,
    previous_release: cfg.previous_release, genes_core: cfg.genes_core, suggestions_core: cfg.suggestions_core,
    passthrough_api: cfg.passthrough_api, anchor_genome_ref: cfg.anchor_genome_ref,
    counts: { nodes: counts.nodes_total, edges: counts.edges_total, edges_materialised: counts.edges_materialised, solr_docs: counts.solr_docs },
    promoted_at: new Date(), builds: keep, is_current: true,
  } }, { upsert: true });
  log(`kg_meta.releases.${RELEASE} -> ${BUILD_ID}; previous ${previous ?? 'none'}`);

  // ---- retire: everything of this release that is not kept, in progress, or newer ----------------
  const inProgress = (() => { try { return fs.readFileSync(path.join(env('STATE_DIR'), 'build_id'), 'utf8').trim(); } catch { return null; } })();
  const protect = new Set([...keep, inProgress].filter(Boolean));
  const dbs = (await client.db('admin').admin().listDatabases({ nameOnly: true })).databases.map(d => d.name).map(n => n.match(NAME_RE)?.[1]).filter(Boolean);
  const coresAll = Object.keys((await (await fetch(`${SOLR}/admin/cores?action=STATUS&wt=json`)).json()).status ?? {}).map(n => n.match(NAME_RE)?.[1]).filter(Boolean);
  const dirs = fs.readdirSync(env('RELEASE_BUILDS')).filter(d => /^[0-9]{12}$/.test(d));
  const candidates = [...new Set([...dbs, ...coresAll, ...dirs, ...(prev?.pending_retire ?? [])])]
    .filter(b => !protect.has(b) && b < BUILD_ID).sort();
  const pending = [];
  for (const b of candidates) {
    if (b === BUILD_ID || b === wasCurrent || b === previous) die(`refusing to retire protected build ${b}`);
    const name = dbOf(b);
    if (coresAll.includes(b)) {
      let ok = false;
      try {
        const r = await fetch(`${SOLR}/admin/cores?action=UNLOAD&core=${name}&deleteIndex=true&deleteDataDir=true&deleteInstanceDir=true&wt=json`, { signal: AbortSignal.timeout(60000) });
        const j = await r.json().catch(() => ({}));
        ok = r.ok && j.responseHeader?.status === 0;
      } catch { ok = false; }
      if (!ok) { pending.push(b); log(`WARNING: could not unload core ${name}; kept db and artifacts, will retry`); continue; }
      log(`unloaded core ${name}`);
    }
    if (dbs.includes(b)) { await client.db(name).dropDatabase(); log(`dropped db ${name}`); }
    if (dirs.includes(b)) { fs.rmSync(path.join(env('RELEASE_BUILDS'), b), { recursive: true, force: true }); log(`removed artifacts ${b}`); }
  }
  await releases.updateOne({ _id: RELEASE }, { $set: { pending_retire: pending } });
  if (!candidates.length) log('nothing to retire');
} finally {
  await client.close();
}
