// kg80 promote: flip kg_meta.releases pointer; retire builds older than previous (db + core + artifacts).
import fs from 'node:fs';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { env, loadReleaseConfig, buildOut, log } from './kgio.mjs';

const RELEASE = env('RELEASE'); const BUILD_ID = env('BUILD_ID'); const KG_DB = env('KG_DB');
const SOLR = env('SOLR_URL'); const cfg = loadReleaseConfig();
const client = await MongoClient.connect(env('MONGO_URI'));
const counts = JSON.parse(fs.readFileSync(buildOut('counts.json'), 'utf8'));
const releases = client.db('kg_meta').collection('releases');
const prev = await releases.findOne({ _id: RELEASE });
const history = [...new Set([BUILD_ID, ...(prev?.builds ?? [])])].sort().reverse();
const keep = history.slice(0, 2); const retire = history.slice(2);
await releases.updateOne({ _id: RELEASE }, { $set: {
  site: cfg.site, current_build: BUILD_ID, db_name: KG_DB, solr_core: `kg_${RELEASE}_b${BUILD_ID}`,
  previous_build: prev?.current_build && prev.current_build !== BUILD_ID ? prev.current_build : (prev?.previous_build ?? null),
  previous_release: cfg.previous_release, genes_core: cfg.genes_core, suggestions_core: cfg.suggestions_core, passthrough_api: cfg.passthrough_api,
  anchor_genome_ref: cfg.anchor_genome_ref, counts: { nodes: counts.nodes_total, edges: counts.edges_total, edges_materialised: counts.edges_materialised },
  promoted_at: new Date(), builds: keep, is_current: true,
} }, { upsert: true });
log(`kg_meta.releases.${RELEASE} -> ${BUILD_ID} (${KG_DB}); keeping builds ${keep.join(', ')}`);
for (const b of retire) {
  const db = `kg_${RELEASE}_b${b}`; const core = db;
  if (!/^kg_[a-z]+[0-9]+_b[0-9]{12}$/.test(db)) { log(`skip suspicious name ${db}`); continue; }
  await client.db(db).dropDatabase();
  await fetch(`${SOLR}/admin/cores?action=UNLOAD&core=${core}&deleteIndex=true&deleteInstanceDir=true&wt=json`);
  fs.rmSync(path.join(env('RELEASE_BUILDS'), b), { recursive: true, force: true });
  log(`retired build ${b}: dropped ${db}, unloaded core ${core}, removed artifacts`);
}
await client.close();
