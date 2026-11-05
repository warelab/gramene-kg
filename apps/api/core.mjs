// gramene-kg read logic shared by REST (server.mjs) and GraphQL (graphql.mjs), so the two cannot diverge.
// Every query function takes plain values (no Fastify objects) and returns { ctx, data, extra }:
//   ctx   = { rel, db, manifest } of the release served; extra = meta fields beyond warnings ([] by default).
// Errors are thrown as httpError(status, message, hint) and rendered by each surface.
// Read-only: the Mongo dbs read are kg_meta, kg_<release>_b<build> and kg_curation (the curated overlay below);
// writes to kg_curation go only through curation-db.mjs's bound client (curation.mjs).
// Functions that show curated data take a trailing `who` (the caller's policy Principal {uid, orgs}, or null for
// anonymous); visibility of curated edges and nodes depends on it.
import { MongoClient } from 'mongodb';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import * as derivedLib from './derived.mjs';
import { readableDatasetFilter } from '../../packages/policy/index.mjs';
import { curationDbName } from './curation-db.mjs';
import { CURATION_SOURCE } from './curation-ids.mjs';

const MONGO_URL = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017';
const SOLR_URL = process.env.SOLR_URL || 'http://127.0.0.1:8983/solr';
const DEFAULT_SITE = process.env.KG_SITE || 'sorghumbase';
export const BUILDS_DIR = process.env.KG_BUILDS_DIR || '/scratch/olson/gramene-kg/builds';
export const MAX_LIMIT = 500, MAX_TIME_MS = 20000, MAX_RESOLVE = 5000, PATH_CAP = 20000;

export const mongo = await MongoClient.connect(MONGO_URL, { maxPoolSize: 20 });
const meta = mongo.db('kg_meta');
export const CURATION_DB = curationDbName();
const curDb = mongo.db(CURATION_DB);                 // read only here
export const CURATION_CFG = yaml.load(fs.readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../config/curation.yaml'), 'utf8'));

export const httpError = (code, msg, hint) => { const e = new Error(msg); e.statusCode = code; e.hint = hint ?? null; return e; };

// ---- release resolution (cached 30 s) ---------------------------------------------------------
let relCache = { at: 0, rows: [] };
export async function releases() {
  if (Date.now() - relCache.at > 30000) relCache = { at: Date.now(), rows: await meta.collection('releases').find({}).toArray() };
  return relCache.rows;
}
const manifestCache = new Map();
// want = the caller's release= value (falsy -> the current release of KG_SITE)
export async function resolveRelease(want) {
  const rows = await releases();
  const rel = want ? rows.find(r => r._id === want) : rows.find(r => r.is_current && r.site === DEFAULT_SITE) ?? rows.find(r => r.is_current);
  if (!rel) throw httpError(want ? 400 : 503, want ? `unknown release '${want}'` : 'no current release', `available: ${rows.map(r => r._id).join(', ') || 'none'}`);
  const db = mongo.db(rel.db_name);
  if (!manifestCache.has(rel.db_name)) manifestCache.set(rel.db_name, await db.collection('manifest').findOne({ _id: 'build' }));
  return { rel, db, manifest: manifestCache.get(rel.db_name) };
}
const out = (ctx, data, extra = {}) => ({ ctx, data, extra });

// ---- ids, classes ------------------------------------------------------------------------------
// DOIs are case-insensitive and stored lower-case; everything else is case-sensitive.
export const normId = (c) => {
  const s = String(c ?? '').trim();
  if (/^doi:/i.test(s)) return 'doi:' + s.slice(4).toLowerCase();
  if (/^10\.[0-9]{4,9}\//.test(s)) return 'doi:' + s.toLowerCase();
  return s;
};
// accepts the internal class (GeneModel) or a Biolink category (biolink:GeneFamily / GeneFamily); returns
// every class it names (a category can cover several classes, e.g. GeneFamily = GeneTree + TF family)
export function resolveCls(ctx, c) {
  if (c == null || c === '') return null;
  const classes = ctx.manifest?.schema_stats?.classes ?? [];
  const exact = classes.filter(x => x.class === c);
  const hits = exact.length ? exact : classes.filter(x => x.category === c || x.category === `biolink:${c}`);
  if (!hits.length) throw httpError(400, `unknown category '${c}'`, `classes: ${classes.map(x => `${x.class} (${x.category})`).join(', ')}`);
  return hits.map(x => x.class);
}
const normGenome = (g) => g ? (String(g).includes(':') ? String(g) : `insdc.gca:${g}`) : null;
// A bare id (no ':') is tried under these prefixes (all declared in config/prefixes.yaml) by /resolve and by
// every single-node lookup (/node, /node/{curie}/edges, /path, /derived), so the two always agree.
const BARE_PREFIXES = ['gramene.gene', 'gramene.qtl', 'gramene.sample', 'gramene.genetree', 'gramene.population', 'gramene.germplasm',
  'gxa.expt', 'gramene.expt', 'gramene.assay', 'gramene.contrast', 'gramene.collection', 'interpro', 'reactome', 'dbsnp', 'PMID', 'gramene.tffamily', 'insdc.gca'];
const bareCandidates = (norm) => norm.includes(':') ? [norm] : BARE_PREFIXES.map(p => `${p}:${norm}`);
// One node for a CURIE: the exact id wins; otherwise the bare id under BARE_PREFIXES and the aliases are pooled
// (narrowed by query.genome and opts.classes, as /resolve narrows them). One candidate -> it, with a warning saying
// how it was found (opts.quietPrefix: no warning for a bare id found under that prefix); several -> 409 with
// candidates; none -> 404. query.resolve === '0' turns the fallback off.
export async function resolveNode(ctx, curie, query = {}, projection, opts = {}) {
  const nodes = ctx.db.collection('nodes'); const id = normId(curie); const warnings = [];
  let n = await nodes.findOne({ _id: id }, { projection, maxTimeMS: MAX_TIME_MS });
  if (!n && query.resolve !== '0') {
    const proj = { projection: { _id: 1, cls: 1, genome: 1 }, maxTimeMS: MAX_TIME_MS };
    const byId = id.includes(':') ? [] : await nodes.find({ _id: { $in: bareCandidates(id) } }, proj).toArray();
    const byAlias = await nodes.find({ aliases_lc: id.toLowerCase() }, { ...proj, limit: 20 }).toArray();
    const seen = new Set();
    const all = [...byId.map(h => ({ h, match: 'id' })), ...byAlias.map(h => ({ h, match: 'alias' }))].filter(x => !seen.has(x.h._id) && seen.add(x.h._id));
    const g = normGenome(query.genome);
    const hits = all.filter(x => (!opts.classes || opts.classes.includes(x.h.cls)) && (!g || !x.h.genome || x.h.genome === g));
    if (hits.length === 1) {
      const { h, match } = hits[0];
      n = await nodes.findOne({ _id: h._id }, { projection, maxTimeMS: MAX_TIME_MS });
      if (match === 'alias') warnings.push(`'${curie}' resolved by alias to ${n._id}`);
      else if (h._id !== `${opts.quietPrefix}:${id}`) warnings.push(`'${curie}' resolved as the bare id of ${n._id}`);
    } else if (hits.length > 1) {
      const narrow = !g && new Set(hits.map(({ h }) => h.genome ?? '-')).size > 1 ? '; pass genome= to pick one' : '';
      const e = httpError(409, `'${curie}' is ambiguous`, `${hits.map(({ h }) => `${h._id} (${h.cls}, ${h.genome ?? '-'})`).join('; ')}${narrow}`);
      e.candidates = hits.map(({ h, match }) => ({ id: h._id, class: h.cls, genome: h.genome ?? null, match })); throw e;
    } else if (all.length) {
      throw httpError(404, `no node '${curie}' in ${ctx.rel._id}${g ? ` with genome ${g}` : ''}${opts.classes ? ` of class ${opts.classes.join('/')}` : ''}`,
        `outside the filter: ${all.map(({ h }) => `${h._id} (${h.cls}, ${h.genome ?? '-'})`).join('; ')}`);
    }
  }
  if (!n) throw httpError(404, `no node '${curie}' in ${ctx.rel._id}`, 'try /kg/v1/resolve?ids=...');
  return { n, warnings };
}

// ---- shaping ---------------------------------------------------------------------------------
export function nodeOut(n, { full = true } = {}) {
  if (!n) return null;
  const o = { id: n._id, category: n.cat, class: n.cls, name: n.name ?? null };
  if (!full) return o;
  return { ...o, description: n.desc ?? null, aliases: n.aliases ?? [], xrefs: n.xrefs ?? [], in_taxon: n.tax ?? null,
    genome: n.genome ?? null, gene_tree: n.tree ?? null, location: n.loc ?? null, attributes: n.attrs ?? {},
    degree: n.deg ?? {}, card: n.card ?? null };
}
const nodeProv = (ctx) => ({ release: `gramene.release:${ctx.rel._id}`, ingest_run: ctx.manifest?.ingest_run });
export function edgeOut(e, ctx, other) {
  return {
    id: e._id && !String(e._id).startsWith('slot') ? `gramene.assoc:${e._id}` : null,
    subject: e.s, predicate: e.p, object: e.o, qualifiers: e.q ?? {}, ...(e.slot ? { slot: true } : {}),
    ...(other !== undefined ? { other } : {}),
    provenance: {
      primary_knowledge_source: e.src, aggregator_knowledge_source: ctx.manifest?.aggregator_knowledge_source ?? [],
      knowledge_level: e.kl, agent_type: e.at, has_evidence: e.ev ?? [], original_evidence: e.oev ?? null,
      publications: e.pubs ?? [], has_supporting_studies: e.studies ?? [], method: e.m ?? null,
      original_subject: e.orig?.s ?? null, original_object: e.orig?.o ?? null, source_record: e.rec ?? null,
      knowledge_source_version: e.ksv ?? null, negated: !!e.neg, layer: e.layer ?? 'etl',
      release: `gramene.release:${ctx.rel._id}`, ingest_run: ctx.manifest?.ingest_run ?? null,
    },
    ...(e.curation ? { curation: e.curation } : {}),
  };
}
// gene -> genome and gene -> tree are node fields (KGX-only slots), exposed here as edges
const SLOT = {
  genome: { p: 'biolink:located_in', src: 'infores:ensembl-gene', kl: 'knowledge_assertion', at: 'automated_agent', ev: [], rec: 'genes.location.map', ocls: 'GenomeAssembly' },
  tree: { p: 'biolink:member_of', src: 'infores:ensembl-compara', kl: 'prediction', at: 'computational_model', ev: ['ECO:0000080'], rec: 'genes.homology.gene_tree.id', ocls: 'GeneTree' },
};
// rsID variants carry the same genome slot; their location comes from the EVA VCF
const VARIANT_GENOME = { src: 'infores:eva', rec: 'sorghum_bicolor.vcf.gz' };   // = transform variant_genome source_record
const slotEdge = (ctx, gene, kind, target, loc) => {
  const v = kind === 'genome' && gene.startsWith('dbsnp:');
  return { _id: `slot:${kind}:${gene}`, slot: true, s: gene, o: target, p: SLOT[kind].p, src: v ? VARIANT_GENOME.src : SLOT[kind].src,
    kl: SLOT[kind].kl, at: SLOT[kind].at, ev: SLOT[kind].ev, q: kind === 'genome' ? loc : undefined,
    rec: v ? VARIANT_GENOME.rec : `${ctx.rel._id}.${SLOT[kind].rec}`, layer: 'etl' };
};
const HAS_SLOTS = new Set(['GeneModel', 'SequenceVariant']);

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const unb64 = (s) => { try { return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')); } catch { return null; } };
export const intParam = (v, dflt, max, name) => {
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw httpError(400, `${name} must be a non-negative integer`);
  return Math.min(n, max);
};

// ---- curated overlay (docs/curation.md "Read side") ---------------------------------------------
// Curated edges shown = baked curated edges (layer 'curated', asn {id, rev}) whose assertion revision is still the
// latest, published, unsuperseded one in a workspace the caller can read, plus such assertions not yet baked
// (published after the build), synthesised from kg_curation. Everything else curated is masked, and degrees are
// adjusted to match. With no assertion touching the nodes asked for, every output is exactly the ETL one.
const hexId = (eid) => String(eid).replace(/^gramene\.assoc:/, '');
const ASN_PROJ = { id: 1, rev: 1, latest: 1, workspace: 1, state: 1, subject: 1, predicate: 1, object: 1, qualifiers: 1, negated: 1, evidence: 1,
  supersedes: 1, association_id: 1, edge_id: 1 };
const NODE_CAT = Object.fromEntries(Object.entries(CURATION_CFG.node_classes ?? {}).map(([c, v]) => [c, v.category]));
// Principal of a signed-in user: orgs from kg_curation.users (as g2p's principal.ts takes them from its users)
export async function principal(user) {
  if (!user?.uid) return null;
  const u = await curDb.collection('users').findOne({ _id: user.uid }, { projection: { orgs: 1 } });
  return { uid: user.uid, orgs: Array.isArray(u?.orgs) ? u.orgs : [] };
}
// Anonymous state, cached PUBLIC_TTL_MS (10 s) and dropped at once by this process's own writes
// (invalidateCuratedCache, called by curation.mjs): the public workspace ids; the published corrections in them
// (supersedes key -> workspaces, for visibility()); and the latest updated_at of a published or retracted assertion
// in them (for curatedSinceBuild). Another process's writes show within the TTL.
const PUBLIC_TTL_MS = 10000;
let pubCache = null, pubGen = 0;
export function invalidateCuratedCache() { pubCache = null; pubGen++; }
async function publicState() {
  if (pubCache && Date.now() - pubCache.at < PUBLIC_TTL_MS) return pubCache;
  const gen = pubGen, at = Date.now();
  const ws = new Set((await curDb.collection('workspaces').find({ visibility: 'public' }, { projection: { _id: 1 }, maxTimeMS: MAX_TIME_MS }).toArray()).map(w => w._id));
  const last = ws.size ? await curDb.collection('assertions').find({ latest: true, state: { $in: ['published', 'retracted'] }, workspace: { $in: [...ws] } },
    { projection: { updated_at: 1 }, sort: { updated_at: -1 }, limit: 1, maxTimeMS: MAX_TIME_MS }).next() : null;
  const corr = ws.size ? latestOnly(await curDb.collection('assertions').find({ latest: true, workspace: { $in: [...ws] }, supersedes: { $type: 'string' } },
    { projection: { id: 1, rev: 1, state: 1, workspace: 1, supersedes: 1 }, maxTimeMS: MAX_TIME_MS }).toArray()).filter(a => a.state === 'published') : [];
  const sup = new Map();
  for (const a of corr) sup.set(a.supersedes, new Set([...(sup.get(a.supersedes) ?? []), a.workspace]));
  const st = { at, ws, sup, lastChange: last?.updated_at ?? null };
  if (gen === pubGen) pubCache = st;
  return st;
}
export async function readableWorkspaceIds(who) {
  if (!who) return new Set((await publicState()).ws);
  return new Set((await curDb.collection('workspaces').find(readableDatasetFilter(who), { projection: { _id: 1 }, maxTimeMS: MAX_TIME_MS }).toArray()).map(w => w._id));
}
// highest revision per assertion id (two latest:true revisions coexist for a moment during a revision write)
const latestOnly = (docs) => [...docs.reduce((m, a) => (!m.has(a.id) || m.get(a.id).rev < a.rev ? m.set(a.id, a) : m), new Map()).values()];
// visible(a) for latest revisions: published, readable workspace, not superseded by a published assertion of the same workspace
async function visibility(who, latest) {
  const key = (a) => `${a.id}@${a.rev}`;
  if (!who) {                                        // anonymous: public workspaces and their corrections, cached
    const st = latest.length ? await publicState() : { ws: new Set(), sup: new Map() };
    return (a) => a.state === 'published' && st.ws.has(a.workspace) && !st.sup.get(key(a))?.has(a.workspace);
  }
  const ws = latest.length ? await readableWorkspaceIds(who) : new Set();
  const pub = latest.filter(a => a.state === 'published' && ws.has(a.workspace));
  // a correction counts only while its highest revision is published (latestOnly: the two-step revision write can leave two latest)
  const sup = pub.length ? latestOnly(await curDb.collection('assertions').find({ latest: true, supersedes: { $in: pub.map(key) } },
    { projection: { id: 1, rev: 1, state: 1, supersedes: 1, workspace: 1 }, maxTimeMS: MAX_TIME_MS }).toArray()).filter(s => s.state === 'published') : [];
  const wsOf = new Map(pub.map(a => [key(a), a.workspace]));
  const gone = new Set(sup.filter(s => wsOf.get(s.supersedes) === s.workspace).map(s => s.supersedes));
  return (a) => a.state === 'published' && ws.has(a.workspace) && !gone.has(key(a));
}
const curationOf = (a) => ({ assertion: a.id, rev: a.rev, state: a.state, workspace: a.workspace });
// an assertion as a build edge document (shaped by edgeOut like any other)
export function assertionEdge(a) {
  const ev = a.evidence ?? [];
  const uniq = (xs) => [...new Set(xs)];
  return { _id: hexId(a.edge_id), s: a.subject, p: a.predicate, o: a.object, q: a.qualifiers ?? {}, src: CURATION_SOURCE,
    kl: ev.find(e => e.knowledge_level)?.knowledge_level ?? 'knowledge_assertion', at: 'manual_agent',
    ev: uniq(ev.flatMap(e => e.has_evidence ?? [])), pubs: uniq(ev.flatMap(e => e.publications ?? [])), neg: !!a.negated,
    rec: `${CURATION_DB}.assertions ${a.id}@${a.rev}`, layer: 'curated', asn: { id: a.id, rev: a.rev }, curation: curationOf(a) };
}
// overlay for a set of node ids: { mask: baked edge ids to hide, live: synthesised edges, delta: id -> {deg key: +-n}, any }
export async function curatedOverlay(ctx, who, ids) {
  const latest = latestOnly(await curDb.collection('assertions').find({ latest: true, $or: [{ subject: { $in: ids } }, { object: { $in: ids } }] },
    { projection: ASN_PROJ, maxTimeMS: MAX_TIME_MS }).toArray());
  const res = { mask: [], live: [], delta: new Map(), any: latest.length > 0 };
  if (!latest.length) return res;
  const vis = await visibility(who, latest);
  const baked = new Map((await ctx.db.collection('edges').find({ _id: { $in: latest.map(a => hexId(a.edge_id)) } },
    { projection: { s: 1, p: 1, o: 1, asn: 1, layer: 1 }, maxTimeMS: MAX_TIME_MS }).toArray()).map(e => [e._id, e]));
  const want = new Set(ids);
  const bump = (id, k, d) => { if (!want.has(id)) return; const m = res.delta.get(id) ?? {}; m[k] = (m[k] ?? 0) + d; res.delta.set(id, m); };
  for (const a of latest) {
    const b = baked.get(hexId(a.edge_id));
    if (b && b.layer !== 'curated') continue;        // id clash with an ETL edge: never touch ETL edges
    const v = vis(a);
    if (b) {
      if (v && b.asn?.id === a.id && b.asn?.rev === a.rev) continue;   // baked and still current: shown as stored
      res.mask.push(b._id); bump(b.s, `${b.p}|out`, -1); bump(b.o, `${b.p}|in`, -1);
    } else if (v) { const e = assertionEdge(a); res.live.push(e); bump(e.s, `${e.p}|out`, 1); bump(e.o, `${e.p}|in`, 1); }
  }
  return res;
}
export const applyDelta = (deg = {}, d) => {
  if (!d || !Object.keys(d).length) return deg;
  const o = { ...deg };
  for (const [k, v] of Object.entries(d)) { const n = (o[k] ?? 0) + v; if (n > 0) o[k] = n; else delete o[k]; }
  return o;
};
// baked curated edges in rows (get(row) -> edge doc): keep the visible ones, annotated with `curation`; drop the rest.
// Rows without curated edges come back untouched (no query).
export async function filterBaked(who, rows, get = (r) => r, set = (r, e) => e) {
  const cs = rows.filter(r => get(r).layer === 'curated');
  if (!cs.length) return rows;
  const latest = latestOnly(await curDb.collection('assertions').find({ id: { $in: [...new Set(cs.map(r => get(r).asn?.id).filter(Boolean))] }, latest: true },
    { projection: ASN_PROJ, maxTimeMS: MAX_TIME_MS }).toArray());
  const vis = await visibility(who, latest);
  const by = new Map(latest.map(a => [a.id, a]));
  return rows.flatMap(r => {
    const e = get(r); if (e.layer !== 'curated') return [r];
    const a = by.get(e.asn?.id);
    return a && vis(a) && a.rev === e.asn.rev && hexId(a.edge_id) === e._id ? [set(r, { ...e, curation: curationOf(a) })] : [];
  });
}
// Curated nodes are per workspace (kg_curation.curated_nodes _id "<ws>|<curie>", fields workspace + curie): one CURIE
// can be curated in several workspaces. A record is visible when its workspace is readable; an Association record
// only while its assertion is visible (and still names it). Visible records of a CURIE are merged: the oldest one
// (created_at, then workspace id) gives class and top-level attrs, name and description are the first non-empty in
// that order, xrefs are unioned, and every record appears under attrs.curated.<workspace> (the build bakes the same
// shape, public workspaces only).
const byAge = (a, b) => (String(a.created_at ?? '') < String(b.created_at ?? '') ? -1 : String(a.created_at ?? '') > String(b.created_at ?? '') ? 1 : a.workspace < b.workspace ? -1 : 1);
async function visibleRecords(who, docs) {
  if (!docs.length) return new Map();
  const ws = await readableWorkspaceIds(who);
  let ok = docs.filter(d => ws.has(d.workspace));
  const assoc = ok.filter(d => d.cls === 'Association');
  if (assoc.length) {
    const latest = latestOnly(await curDb.collection('assertions').find({ id: { $in: assoc.map(d => d.assertion) }, latest: true }, { projection: ASN_PROJ, maxTimeMS: MAX_TIME_MS }).toArray());
    const vis = await visibility(who, latest); const by = new Map(latest.map(a => [a.id, a]));
    ok = ok.filter(d => d.cls !== 'Association' || (by.get(d.assertion) && vis(by.get(d.assertion)) && by.get(d.assertion).association_id === d.curie));
  }
  const m = new Map();
  for (const d of ok) m.set(d.curie, [...(m.get(d.curie) ?? []), d]);
  for (const v of m.values()) v.sort(byAge);
  return m;
}
// one workspace's record under attrs.curated.<ws>, the shape the build bakes (null fields left out); an Association
// record also names its assertion and the assertion revision it was derived from
const curatedEntry = (d) => Object.fromEntries(Object.entries({ source: CURATION_SOURCE, rev: d.rev, content_sha256: d.content_sha256, cls: d.cls,
  name: d.name, description: d.description, xrefs: d.xrefs ?? [], attrs: d.attrs ?? {},
  ...(d.cls === 'Association' ? { assertion: d.assertion, assertion_rev: d.assertion_rev } : {}) }).filter(([, v]) => v != null));
const curatedMap = (recs) => Object.fromEntries(recs.map(d => [d.workspace, curatedEntry(d)]));
// a curated-only node (not in the build) from its visible records, build-node shaped
function mergedNode(recs) {
  const p = recs[0];
  return { _id: p.curie, cat: [NODE_CAT[p.cls] ?? 'biolink:NamedThing'], cls: p.cls, name: recs.map(r => r.name).find(Boolean) ?? null,
    desc: recs.map(r => r.description).find(x => x != null) ?? null, aliases: [],
    xrefs: [...new Set(recs.flatMap(r => r.xrefs ?? []))], attrs: { ...(p.attrs ?? {}), curated: curatedMap(recs) }, deg: {},
    curation: { workspace: p.workspace, rev: p.rev, workspaces: recs.map(r => r.workspace) } };
}
// a build node's attrs.curated replaced by the caller's visible records (baked entries of workspaces the caller cannot
// read are dropped; the rest are shown as they are now). Nodes with neither come back untouched.
function withCurated(n, recs) {
  const live = recs ?? [];
  if (!live.length && !(n.attrs && typeof n.attrs === 'object' && 'curated' in n.attrs)) return n;
  const { curated, ...attrs } = n.attrs ?? {};
  return { ...n, attrs: live.length ? { ...attrs, curated: curatedMap(live) } : attrs };
}
// curated records for build-node ids: { visible: curie -> visible records, hidden: build nodes to treat as absent }.
// Hidden: a baked node made from curated records alone (an Association, or attrs.curated_only) that has records,
// none of them visible to the caller (e.g. its workspace went private after the build). One indexed query when
// kg_curation has nothing for these ids.
export async function curatedFor(ctx, who, ids) {
  const docs = ids.length ? await curDb.collection('curated_nodes').find({ curie: { $in: ids } }, { maxTimeMS: MAX_TIME_MS }).toArray() : [];
  if (!docs.length) return { visible: new Map(), hidden: new Set() };
  const visible = await visibleRecords(who, docs);
  const orphan = [...new Set(docs.map(d => d.curie))].filter(c => !visible.has(c));
  const hidden = new Set(orphan.filter(c => c.startsWith('gramene.assoc:')));
  const rest = orphan.filter(c => !hidden.has(c));
  if (rest.length) for (const n of await ctx.db.collection('nodes').find({ _id: { $in: rest }, 'attrs.curated_only': true }, { projection: { _id: 1 }, maxTimeMS: MAX_TIME_MS }).toArray()) hidden.add(n._id);
  return { visible, hidden };
}
// curated-only nodes the caller may see, by exact CURIE: id -> build-node shaped doc
export async function curatedNodes(who, ids) {
  if (!ids.length) return new Map();
  const docs = await curDb.collection('curated_nodes').find({ curie: { $in: ids } }, { maxTimeMS: MAX_TIME_MS }).toArray();
  return new Map([...(await visibleRecords(who, docs))].map(([id, recs]) => [id, mergedNode(recs)]));
}
// node lookup for the read routes: the build node (resolveNode rules); else a visible curated node with that exact id.
// A baked curated-only node none of whose records is visible (curatedFor) is a 404 like any unknown node; a full
// build node gets attrs.curated from the caller's visible records.
async function findNode(ctx, curie, query, projection, who, opts = {}) {
  let r;
  try { r = await resolveNode(ctx, curie, query, projection, opts); } catch (e) {
    if (e.statusCode !== 404) throw e;
    const cn = (await curatedNodes(who, [normId(curie)])).get(normId(curie));
    if (!cn) throw e;
    return { n: cn, warnings: [] };
  }
  const cv = await curatedFor(ctx, who, [r.n._id]);
  if (cv.hidden.has(r.n._id)) throw httpError(404, `no node '${curie}' in ${ctx.rel._id}`, 'try /kg/v1/resolve?ids=...');
  if (!projection) r.n = withCurated(r.n, cv.visible.get(r.n._id));
  return r;
}
// meta.warnings entry wherever Solr/card fields predate curated changes
const curatedWarning = (ctx) => `curated counts as of build ${ctx.rel.current_build}`;
// any curated change visible to the caller since the build was loaded (published or retracted after loaded_at)
async function curatedSinceBuild(ctx, who) {
  const at = ctx.manifest?.loaded_at; if (!at) return false;
  if (!who) { const st = await publicState(); return !!st.lastChange && st.lastChange > new Date(at).toISOString(); }
  const rows = await curDb.collection('assertions').find({ latest: true, state: { $in: ['published', 'retracted'] }, updated_at: { $gt: new Date(at).toISOString() } },
    { projection: { workspace: 1 }, limit: 500, maxTimeMS: MAX_TIME_MS }).toArray();
  if (!rows.length) return false;
  const ws = await readableWorkspaceIds(who);
  return rows.some(r => ws.has(r.workspace));
}

// ---- releases, schema ------------------------------------------------------------------------
export async function health() {
  const rows = await releases();
  return { ok: true, releases: rows.map(r => ({ id: r._id, build: r.current_build, current: !!r.is_current })) };
}
export const releaseList = async () => (await releases()).map(r => ({ id: r._id, site: r.site, build: r.current_build, previous_build: r.previous_build,
  previous_release: r.previous_release, is_current: !!r.is_current, promoted_at: r.promoted_at, counts: r.counts,
  manifest: `/kg/v1/releases/${r._id}/manifest` }));
export async function releaseInfo(id) {
  const ctx = await resolveRelease(id);
  return out(ctx, { id: ctx.rel._id, build: ctx.rel.current_build, db: ctx.rel.db_name, solr_core: ctx.rel.solr_core,
    counts: ctx.manifest?.counts, catalogue: ctx.manifest?.catalogue });
}
export async function releaseManifest(id) {
  const ctx = await resolveRelease(id);
  const cat = (cls) => ctx.db.collection('nodes').find({ cls }, { projection: { card: 0, deg: 0 } }).toArray();
  return out(ctx, { release: ctx.rel._id, build: ctx.rel.current_build, ingest_run: ctx.manifest?.ingest_run,
    datasets: (await cat('KgDataset')).map(n => nodeOut(n)), distributions: (await cat('KgDistribution')).map(n => nodeOut(n)),
    analyses: (await cat('AnalysisRun')).map(n => nodeOut(n)), software: (await cat('SoftwareAgent')).map(n => nodeOut(n)) });
}

// changes between two builds of a release, from each build's counts.json (<BUILDS_DIR>/<release>/<build>/counts.json)
const buildsOnDisk = (relId) => {
  const dir = path.join(BUILDS_DIR, relId);
  let names = []; try { names = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory() && /^\d{12}$/.test(d.name)).map(d => d.name); } catch {}
  return names.filter(b => fs.existsSync(path.join(dir, b, 'counts.json'))).sort();
};
export async function releaseChanges(id, { from, to } = {}) {
  const ctx = await resolveRelease(id);
  const avail = buildsOnDisk(ctx.rel._id);
  const hint = `builds_available: ${avail.join(', ') || 'none'}`;
  const toB = to ? String(to) : ctx.rel.current_build;
  if (!avail.includes(toB)) throw httpError(404, `no counts.json for build '${toB}' of ${ctx.rel._id}`, hint);
  // default from: the release's recorded previous build when diffing the current one, else the build before `to` on disk
  const fromB = from ? String(from) : (toB === ctx.rel.current_build && ctx.rel.previous_build ? ctx.rel.previous_build : avail[avail.indexOf(toB) - 1]);
  if (!fromB) throw httpError(404, `no build before '${toB}' of ${ctx.rel._id}; pass from=`, hint);
  if (!avail.includes(fromB)) throw httpError(404, `no counts.json for build '${fromB}' of ${ctx.rel._id}`, hint);
  const read = (b) => JSON.parse(fs.readFileSync(path.join(BUILDS_DIR, ctx.rel._id, b, 'counts.json'), 'utf8'));
  const a = read(fromB), b = read(toB);
  const tri = (x, y) => ({ from: x ?? 0, to: y ?? 0, delta: (y ?? 0) - (x ?? 0) });
  const diff = (x = {}, y = {}) => Object.fromEntries([...new Set([...Object.keys(x), ...Object.keys(y)])].sort().map(k => [k, tri(x[k], y[k])]));
  const sum = (o = {}) => Object.values(o).reduce((s, v) => s + v, 0);
  return out(ctx, { from: fromB, to: toB, builds_available: avail, nodes: diff(a.nodes, b.nodes), edges: diff(a.edges, b.edges),
    totals: { nodes: tri(a.nodes_total ?? sum(a.nodes), b.nodes_total ?? sum(b.nodes)), edges: tri(a.edges_total ?? sum(a.edges), b.edges_total ?? sum(b.edges)) } },
  { source: `${path.join(BUILDS_DIR, ctx.rel._id)}/{${fromB},${toB}}/counts.json` });
}

export async function schema(release) {
  const ctx = await resolveRelease(release);
  return out(ctx, ctx.manifest?.schema_stats ?? { node_classes: ctx.manifest?.counts?.nodes, edge_families: ctx.manifest?.counts?.edges });
}
export async function schemaCategory(category, release) {
  const ctx = await resolveRelease(release);
  const st = ctx.manifest?.schema_stats;
  if (!st) return out(ctx, null, { warnings: ['schema_stats not built for this release'] });
  const cls = resolveCls(ctx, category);
  const one = (k) => ({ ...st.classes.find(x => x.class === k), out: st.relations.filter(r => r.subject_class === k), in: st.relations.filter(r => r.object_class === k) });
  return out(ctx, cls.length === 1 ? one(cls[0]) : cls.map(one));
}

// ---- nodes, edges ---------------------------------------------------------------------------
// node output: degree adjusted by the curated overlay; curated nodes carry curation {workspace, rev}
const nodeFull = (ctx, n, ov) => ({ ...nodeOut({ ...n, deg: applyDelta(n.deg, ov?.delta.get(n._id)) }), ...(n.curation ? { curation: n.curation } : {}), provenance: nodeProv(ctx) });
// q: { release, resolve }
export async function node(curie, q = {}, who = null) {
  const ctx = await resolveRelease(q.release);
  const { n, warnings } = await findNode(ctx, curie, q, undefined, who);
  const ov = await curatedOverlay(ctx, who, [n._id]);
  if (ov.mask.length || ov.live.length) warnings.push(curatedWarning(ctx));
  return out(ctx, nodeFull(ctx, n, ov), { warnings });
}
// exact-id batch fetch for GraphQL loaders: ids -> same-order array of node outputs (null when absent or not visible)
export async function nodesByIds(release, ids, who = null) {
  const ctx = await resolveRelease(release);
  const uniq = [...new Set(ids)];
  const docs = await ctx.db.collection('nodes').find({ _id: { $in: uniq } }, { projection: { aliases_lc: 0 }, maxTimeMS: MAX_TIME_MS }).toArray();
  const m = new Map(docs.map(d => [d._id, d]));
  // as findNode: hidden baked curated-only nodes dropped, attrs.curated from visible records, curated-only nodes added
  const cv = await curatedFor(ctx, who, uniq);
  for (const id of cv.hidden) m.delete(id);
  for (const [id, d] of m) m.set(id, withCurated(d, cv.visible.get(id)));
  for (const [id, recs] of cv.visible) if (!m.has(id) && !cv.hidden.has(id)) m.set(id, mergedNode(recs));
  const ov = await curatedOverlay(ctx, who, [...m.keys()]);
  return { ctx, rows: ids.map(id => m.has(id) ? nodeFull(ctx, m.get(id), ov) : null) };
}

// Paging runs through ordered phases; the cursor names the phase and the last _id returned in it.
//   out      materialised edges with subject = node   (index s,p,_id)
//   slot_out gene -> genome / tree (node fields)
//   in       materialised edges with object = node    (index o,p,_id)
//   slot_in  genes whose tree / genome field is this node
//   cur      curated edges not in the build (published after it), both directions, by edge id
// Baked curated edges stay in out/in; the curated overlay masks the ones no longer visible to the caller.
const PHASES = ['out', 'slot_out', 'in', 'slot_in', 'cur'];
// predicate= (comma list) -> prefixed predicates. A bare name takes the prefix of the release predicate with that
// local name (biolink:overlaps, gramene:carries_predicted_lof_allele_of); biolink: when none or several match.
// A name the release does not use, or a bare name matching several predicates, adds a warning listing the valid ones.
function resolvePredicates(ctx, deg, arg, warnings) {
  const known = [...new Set([...(ctx.manifest?.schema_stats?.relations ?? []).map(r => r.predicate), ...Object.keys(deg).map(k => k.split('|')[0])])].sort();
  const local = (p) => p.slice(p.indexOf(':') + 1);
  const bad = [];
  const res = String(arg).split(',').map(p => p.trim()).filter(Boolean).flatMap(p => {
    if (p.includes(':')) { if (known.length && !known.includes(p)) bad.push(p); return [p]; }
    const m = known.filter(k => local(k) === p);
    if (m.length === 1) return m;
    if (m.length > 1) { warnings.push(`predicate '${p}' matches ${m.join(', ')}; all of them are used (pass a prefixed name to pick one)`); return m; }
    bad.push(p); return [`biolink:${p}`];
  });
  if (bad.length) warnings.push(`predicate ${bad.map(p => `'${p}'`).join(', ')} not used in ${ctx.rel._id}; predicates: ${known.join(', ')}`);
  return [...new Set(res)];
}
// q: { release, resolve, predicate, direction, category, source, include_negated, limit, cursor }
// returns extra { degree, next, warnings } and, out of band, cursors[i] = the cursor resuming after data[i]
export async function nodeEdges(curie, qy = {}, who = null) {
  const ctx = await resolveRelease(qy.release);
  const { n, warnings } = await findNode(ctx, curie, qy, { cls: 1, genome: 1, tree: 1, loc: 1, deg: 1 }, who);
  const id = n._id;
  const ov = await curatedOverlay(ctx, who, [id]);
  const dir = ['out', 'in', 'both'].includes(qy.direction) ? qy.direction : 'both';
  const limit = intParam(qy.limit, 100, MAX_LIMIT, 'limit') || 1;
  const includeNeg = qy.include_negated === '1' || qy.include_negated === 'true';
  const deg = n.deg ?? {}; const degOut = applyDelta(deg, ov.delta.get(id));
  const predsArg = qy.predicate ? resolvePredicates(ctx, { ...deg, ...degOut }, qy.predicate, warnings) : null;
  const ocls = resolveCls(ctx, qy.category);
  const predsFor = (d) => {
    const fromDeg = [...new Set(Object.keys(deg).filter(k => k.endsWith(`|${d}`)).map(k => k.split('|')[0]))];
    return predsArg ? fromDeg.filter(p => predsArg.includes(p)).concat(predsArg.filter(p => !fromDeg.includes(p))) : fromDeg;
  };
  const E = ctx.db.collection('edges'); const N = ctx.db.collection('nodes');
  const slotInKind = n.cls === 'GeneTree' ? 'tree' : (n.cls === 'GenomeAssembly' ? 'genome' : null);

  // returns up to k rows of a phase after cursor id `after` (sorted by _id), as {e, d, ph}
  async function fetchPhase(ph, after, k) {
    if (k <= 0) return [];
    if (ph === 'out' || ph === 'in') {
      if (dir !== 'both' && dir !== ph) return [];
      const preds = predsFor(ph); if (!preds.length) return [];
      const f = { [ph === 'out' ? 's' : 'o']: id, p: { $in: preds } };
      if (qy.source) f.src = String(qy.source);
      if (!includeNeg) f.neg = { $ne: true };
      if (ocls) f[ph === 'out' ? 'oc' : 'sc'] = { $in: ocls };
      if (after) f._id = { $gt: after };
      if (ov.mask.length) f._id = { ...f._id, $nin: ov.mask };
      const rows = await E.find(f, { sort: { _id: 1 }, limit: k, maxTimeMS: MAX_TIME_MS, hint: ph === 'out' ? { s: 1, p: 1, _id: 1 } : { o: 1, p: 1, _id: 1 } }).toArray();
      return filterBaked(who, rows.map(e => ({ e, d: ph, ph })), r => r.e, (r, e) => ({ ...r, e }));
    }
    if (ph === 'cur') {
      if (!ov.live.length) return [];
      // a self-loop (subject = object) is listed twice, out then in (cursor key <edge id>|in), as the baked one is in
      // the out and in phases, so the rows match the degree (out 1, in 1)
      return ov.live.flatMap(e => e.s === id && e.o === id ? [{ e, d: 'out', ph, k: e._id }, { e, d: 'in', ph, k: `${e._id}|in` }] : [{ e, d: e.s === id ? 'out' : 'in', ph, k: e._id }])
        .filter(({ e, d, k }) => (dir === 'both' || dir === d) && (!predsArg || predsArg.includes(e.p)) && (!qy.source || e.src === qy.source) && (includeNeg || !e.neg)
          && (!ocls || ocls.includes(liveCls.get(d === 'out' ? e.o : e.s))) && (!after || k > after))
        .sort((a, b) => (a.k < b.k ? -1 : 1)).slice(0, k);
    }
    if (ph === 'slot_out') {
      if (dir === 'in' || !HAS_SLOTS.has(n.cls)) return [];
      const rows = [];
      if (n.genome) rows.push(slotEdge(ctx, id, 'genome', n.genome, n.loc));
      if (n.tree) rows.push(slotEdge(ctx, id, 'tree', n.tree));
      return rows.filter(e => (!predsArg || predsArg.includes(e.p)) && (!qy.source || e.src === qy.source)
        && (!ocls || ocls.includes(SLOT[e._id.split(':')[1]].ocls)) && (!after || e._id > after)).slice(0, k).map(e => ({ e, d: 'out', ph }));
    }
    if (ph === 'slot_in') {
      if (dir === 'out' || !slotInKind) return [];
      const S = SLOT[slotInKind];
      if ((predsArg && !predsArg.includes(S.p)) || (qy.source && qy.source !== S.src) || (ocls && !ocls.includes('GeneModel'))) return [];
      const f = { [slotInKind]: id, cls: 'GeneModel' }; if (after) f._id = { $gt: after.replace(/^slot:[a-z]+:/, '') };
      const genes = await N.find(f, { projection: { _id: 1, loc: 1 }, sort: { _id: 1 }, limit: k, maxTimeMS: MAX_TIME_MS }).toArray();
      return genes.map(g => ({ e: slotEdge(ctx, g._id, slotInKind, id, g.loc), d: 'in', ph }));
    }
    return [];
  }

  // class of the far end of each live curated edge (for category=)
  const liveCls = new Map();
  if (ov.live.length && ocls) {
    const ends = [...new Set(ov.live.map(e => e.s === id ? e.o : e.s))];
    for (const d of await N.find({ _id: { $in: ends } }, { projection: { cls: 1 } }).toArray()) liveCls.set(d._id, d.cls);
    for (const [k, d] of await curatedNodes(who, ends.filter(e => !liveCls.has(e)))) liveCls.set(k, d.cls);
  }
  const cur = qy.cursor ? unb64(qy.cursor) : null;
  if (qy.cursor && (!cur || !PHASES.includes(cur.ph) || typeof cur.id !== 'string')) throw httpError(400, 'invalid cursor');
  const rowsOut = []; let next = null;
  for (const ph of PHASES.slice(PHASES.indexOf(cur?.ph ?? 'out'))) {
    const after = cur && cur.ph === ph ? cur.id : null;
    const rem = limit - rowsOut.length;
    if (rem === 0) {                                  // page full: is there anything left in this phase?
      if ((await fetchPhase(ph, after, 1)).length) { next = b64({ ph, id: after ?? '' }); break; }
      continue;
    }
    const rows = await fetchPhase(ph, after, rem + 1);
    if (rows.length > rem) { rows.length = rem; rowsOut.push(...rows); next = b64({ ph, id: rows[rem - 1].k ?? rows[rem - 1].e._id }); break; }
    rowsOut.push(...rows);
  }
  const others = [...new Set(rowsOut.map(({ e, d }) => d === 'out' ? e.o : e.s))];
  const on = new Map((await N.find({ _id: { $in: others } }, { projection: { cls: 1, cat: 1, name: 1 } }).toArray()).map(o => [o._id, o]));
  if (ov.any) {
    const cv = await curatedFor(ctx, who, others);
    for (const h of cv.hidden) on.delete(h);
    for (const [k, recs] of cv.visible) if (!on.has(k) && !cv.hidden.has(k)) on.set(k, mergedNode(recs));
  }
  const data = rowsOut.map(({ e, d }) => ({ ...edgeOut(e, ctx, nodeOut(on.get(d === 'out' ? e.o : e.s), { full: false }) ?? { id: d === 'out' ? e.o : e.s }), direction: d }));
  if (slotInKind === 'genome' && dir !== 'out' && (await N.findOne({ genome: id, cls: 'SequenceVariant' }, { projection: { _id: 1 } })))
    warnings.push('sequence variants located in this genome are not listed here (millions); query them by position with /kg/v1/region?category=SequenceVariant');
  const r = out(ctx, data, { degree: degOut, next, warnings });
  Object.defineProperty(r, 'cursors', { value: rowsOut.map(({ e, ph, k }) => b64({ ph, id: k ?? e._id })) });
  return r;
}

// a baked curated edge is shown only while its assertion revision is visible; an unbaked one comes from kg_curation
export async function edge(eid, q = {}, who = null) {
  const ctx = await resolveRelease(q.release);
  const id = String(eid).replace(/^gramene\.assoc:/, '');
  let e = await ctx.db.collection('edges').findOne({ _id: id });
  if (e?.layer === 'curated') e = (await filterBaked(who, [e]))[0];
  else if (!e) {
    const a = latestOnly(await curDb.collection('assertions').find({ edge_id: `gramene.assoc:${id}`, latest: true }, { projection: ASN_PROJ }).toArray())[0];
    if (a && (await visibility(who, [a]))(a)) e = assertionEdge(a);
  }
  if (!e) throw httpError(404, `no edge '${eid}'`);
  const ends = new Map((await ctx.db.collection('nodes').find({ _id: { $in: [e.s, e.o] } }, { projection: { cls: 1, cat: 1, name: 1 } }).toArray()).map(o => [o._id, nodeOut(o, { full: false })]));
  if (e.layer === 'curated') {
    const cv = await curatedFor(ctx, who, [e.s, e.o]);
    for (const h of cv.hidden) ends.delete(h);
    for (const [k, recs] of cv.visible) if (!ends.has(k) && !cv.hidden.has(k)) ends.set(k, nodeOut(mergedNode(recs), { full: false }));
  }
  return out(ctx, { ...edgeOut(e, ctx), subject_node: ends.get(e.s) ?? null, object_node: ends.get(e.o) ?? null });
}

// ---- resolve: exact CURIE, bare id under known prefixes (BARE_PREFIXES), aliases; all matches with genome ----
export async function resolveIds(ctx, ids, { genome, category } = {}) {
  const nodes = ctx.db.collection('nodes');
  const cands = new Map();                           // candidate _id -> [inputs]
  for (const input of ids) {
    const norm = normId(input);
    const cs = bareCandidates(norm);
    for (const c of cs) cands.set(c, [...(cands.get(c) ?? []), input]);
  }
  const proj = { projection: { cls: 1, genome: 1, name: 1, aliases_lc: 1 }, maxTimeMS: MAX_TIME_MS };
  const exact = await nodes.find({ _id: { $in: [...cands.keys()] } }, proj).toArray();
  const lc = [...new Set(ids.map(i => normId(i).toLowerCase()))];
  const alias = await nodes.find({ aliases_lc: { $in: lc } }, { ...proj, limit: 50 * lc.length }).toArray();
  const g = normGenome(genome);
  const push = (m, k, v) => { const a = m.get(k); if (a) a.push(v); else m.set(k, [v]); };
  const byInput = new Map(), byAlias = new Map();
  for (const h of exact) for (const input of new Set(cands.get(h._id) ?? [])) push(byInput, input, h);
  for (const h of alias) for (const a of h.aliases_lc ?? []) push(byAlias, a, h);
  const resolved = [], ambiguous = [], unknown = [];
  for (const input of ids) {
    const nlc = normId(input).toLowerCase(); const seen = new Set();
    let hits = [...(byInput.get(input) ?? []).map(h => ({ h, match: 'id' })), ...(byAlias.get(nlc) ?? []).map(h => ({ h, match: 'alias' }))]
      .filter(x => !seen.has(x.h._id) && seen.add(x.h._id));
    if (category) hits = hits.filter(x => category.includes(x.h.cls));
    if (g) hits = hits.filter(x => !x.h.genome || x.h.genome === g);
    const rows = hits.map(({ h, match }) => ({ input, id: h._id, class: h.cls, name: h.name ?? null, genome: h.genome ?? null, match }));
    if (!rows.length) unknown.push(input); else if (rows.length === 1) resolved.push(rows[0]); else ambiguous.push({ input, candidates: rows });
  }
  return { resolved, ambiguous, unknown };
}
// hidden baked curated-only nodes (curatedFor) taken out of a resolveIds result, as if absent from the build
export async function dropHidden(ctx, who, res) {
  const ids = [...new Set([...res.resolved.map(r => r.id), ...res.ambiguous.flatMap(a => a.candidates.map(c => c.id))])];
  const { hidden } = await curatedFor(ctx, who, ids);
  if (!hidden.size) return res;
  const out = { resolved: [], ambiguous: [], unknown: [...res.unknown] };
  for (const r of res.resolved) if (hidden.has(r.id)) out.unknown.push(r.input); else out.resolved.push(r);
  for (const a of res.ambiguous) {
    const c = a.candidates.filter(x => !hidden.has(x.id));
    if (!c.length) out.unknown.push(a.input); else if (c.length === 1) out.resolved.push(c[0]); else out.ambiguous.push({ ...a, candidates: c });
  }
  return out;
}
// src: { release, ids (array or comma/space string), genome, category }
export async function resolve(src, who = null) {
  const ctx = await resolveRelease(src.release);
  const raw = Array.isArray(src.ids) ? src.ids : String(src.ids ?? '').split(/[,\s]+/);
  const all = raw.map(String).filter(Boolean);
  if (all.length > MAX_RESOLVE) throw httpError(400, `at most ${MAX_RESOLVE} ids per request (got ${all.length})`);
  const res = await dropHidden(ctx, who, await resolveIds(ctx, all, { genome: src.genome, category: resolveCls(ctx, src.category) }));
  return out(ctx, res, res.ambiguous.length ? { warnings: ['ambiguous ids: pass genome=<GCA> or category= to disambiguate'] } : {});
}

// ---- search -----------------------------------------------------------------------------------
const solrPhrase = (v) => `"${String(v).replace(/[\\"]/g, '\\$&')}"`;
// q: { release, q, rows, start, category, genome, source, taxon, system_name }
export async function search(qy = {}, who = null) {
  const ctx = await resolveRelease(qy.release);
  const q = String(qy.q ?? '').trim();
  const rows = intParam(qy.rows, 20, 200, 'rows'); const start = intParam(qy.start, 0, 10000, 'start');
  const fq = [];
  const cls = resolveCls(ctx, qy.category);
  if (cls) fq.push(`category_leaf_s:(${cls.map(solrPhrase).join(' OR ')})`);
  const genome = normGenome(qy.genome);
  if (genome) fq.push(`genome_s:${solrPhrase(genome)}`);
  if (qy.source) fq.push(`source_ss:${solrPhrase(qy.source)}`);
  if (qy.taxon) fq.push(`taxon_s:${solrPhrase(qy.taxon)}`);
  if (qy.system_name) fq.push(`system_name_s:${solrPhrase(qy.system_name)}`);
  const p = new URLSearchParams({ q: q.toLowerCase() || '*:*', defType: 'edismax',
    qf: 'id_lc_s^30 local_id_lc_s^25 aliases_lc_ss^12 name_t^6 synonyms_t^3 description_t card_t', pf: 'name_t^4', mm: '2<-1 5<80%',
    rows, start, wt: 'json', timeAllowed: 10000, fl: 'id,name_s,category_leaf_s,category_ss,genome_s,taxon_s,source_ss,degree_i,gene_fq_s,card_t,score',
    facet: 'true', 'facet.mincount': 1, 'facet.limit': 30 });
  for (const f of ['category_leaf_s', 'system_name_s', 'source_ss', 'taxon_s']) p.append('facet.field', f);
  for (const f of fq) p.append('fq', f);
  const r = await fetch(`${SOLR_URL}/${ctx.rel.solr_core}/select`, { method: 'POST', body: p, signal: AbortSignal.timeout(15000) });
  if (r.status === 400) throw httpError(400, 'search query could not be parsed', (await r.json().catch(() => ({})))?.error?.msg ?? null);
  if (!r.ok) throw httpError(502, `search backend error ${r.status}`);
  const j = await r.json();
  const facets = Object.fromEntries(Object.entries(j.facet_counts?.facet_fields ?? {}).map(([k, v]) => [k, Object.fromEntries(v.reduce((a, x, i) => (i % 2 ? a.at(-1).push(x) : a.push([x]), a), []))]));
  let data = j.response.docs.map(d => ({ id: d.id, name: d.name_s, class: d.category_leaf_s, category: d.category_ss, genome: d.genome_s ?? null,
    sources: d.source_ss ?? [], degree: d.degree_i ?? 0, gene_fq: d.gene_fq_s ?? null, card: d.card_t?.slice(0, 600) ?? null, score: d.score }));
  // The Solr core holds non-gene nodes and anchor-genome genes. A single-token query also tries exact id /
  // alias resolution over all 5.4M genes, so pan-genome gene ids are found.
  let resolvedExtra = [];
  if (q && !/\s/.test(q) && start === 0 && !qy.source && (!cls || cls.includes('GeneModel'))) {
    const res = await resolveIds(ctx, [q], { category: cls, genome });
    const seen = new Set(data.map(d => d.id));
    resolvedExtra = [...res.resolved, ...res.ambiguous.flatMap(a => a.candidates)].filter(x => !seen.has(x.id))
      .map(x => ({ id: x.id, name: x.name, class: x.class, genome: x.genome, match: x.match }));
  }
  const warnings = ['full-text search covers non-gene nodes and the 9 anchor genomes; meta.resolved adds exact id/alias matches from all genomes'];
  if (await curatedSinceBuild(ctx, who)) warnings.push(curatedWarning(ctx));
  // baked curated-only nodes the caller may not see (curatedFor) are left out (facets and total still count them)
  const { hidden } = await curatedFor(ctx, who, [...new Set([...data.map(d => d.id), ...resolvedExtra.map(x => x.id)])]);
  if (hidden.size) { data = data.filter(d => !hidden.has(d.id)); resolvedExtra = resolvedExtra.filter(x => !hidden.has(x.id)); }
  return out(ctx, data, { total: j.response.numFound, facets, gene_fq_core: ctx.rel.genes_core, resolved: resolvedExtra, warnings });
}

// q: { release, genome, region, start, end, category }
export async function region(qy = {}) {
  const ctx = await resolveRelease(qy.release);
  const { genome, region } = qy; const start = Number(qy.start), end = Number(qy.end);
  if (!genome || !region || !Number.isFinite(start) || !Number.isFinite(end) || end < start) throw httpError(400, 'genome, region, start, end required');
  if (end - start > 5e6) throw httpError(400, 'region larger than 5 Mb');
  const cls = resolveCls(ctx, qy.category);
  const N = ctx.db.collection('nodes'); const g = normGenome(genome);
  if (!(await N.findOne({ _id: g, cls: 'GenomeAssembly' }, { projection: { _id: 1 }, maxTimeMS: MAX_TIME_MS })))
    throw httpError(404, `no genome '${genome}' in ${ctx.rel._id}`, 'genome is a GCA accession (GCA_000003195.3), insdc.gca:<GCA> or gramene.genome:<name>; list them with /kg/v1/search?category=GenomeAssembly&rows=200');
  const f = { genome: g, 'loc.region': String(region), 'loc.start': { $lte: end }, 'loc.end': { $gte: start } };
  if (cls) f.cls = { $in: cls };
  const rows = await N.find(f, { projection: { cls: 1, cat: 1, name: 1, loc: 1 }, limit: 2001, maxTimeMS: MAX_TIME_MS }).toArray();
  const warnings = rows.length > 2000 ? ['more than 2000 features; narrow the region or pass category='] : [];
  if (!rows.length && !(await N.findOne({ genome: g, 'loc.region': String(region) }, { projection: { _id: 1 }, maxTimeMS: MAX_TIME_MS })))
    warnings.push(`${g} has no features on a region named '${region}'; regions are named as in the assembly (e.g. '1', not 'chr1')`);
  return out(ctx, rows.slice(0, 2000).map(r => ({ ...nodeOut(r, { full: false }), location: r.loc })), { total: Math.min(rows.length, 2000), warnings });
}

// ---- path: up to 2 hops over materialised and slot edges ----------------------------------------
// q: { release, from, to, max_hops, resolve }
// curated edges: baked ones only, and only while visible to the caller (curated edges published after the build are
// not walked by /path until the next build bakes them)
export async function findPath(qy = {}, who = null) {
  const ctx = await resolveRelease(qy.release);
  const maxHops = Math.min(2, intParam(qy.max_hops, 2, 2, 'max_hops') || 1);
  if (!qy.from || !qy.to) throw httpError(400, 'from and to required');
  const ends = [await resolveNode(ctx, qy.from, qy, { cls: 1, genome: 1, tree: 1, deg: 1, loc: 1 }), await resolveNode(ctx, qy.to, qy, { cls: 1, genome: 1, tree: 1, deg: 1, loc: 1 })];
  const [from, to] = ends.map(x => x.n);
  if (from._id === to._id) throw httpError(400, `from and to are the same node (${from._id})`);
  const E = ctx.db.collection('edges'); const N = ctx.db.collection('nodes'); const warnings = ends.flatMap(x => x.warnings);
  const degree = (n) => Object.values(n.deg ?? {}).reduce((a, b) => a + b, 0);
  async function neighbours(n) {                     // [{e, other}] including slot edges, negated excluded
    const res = [];
    for (const [k, f] of [['o', { s: n._id }], ['s', { o: n._id }]]) {
      const rows = await E.find({ ...f, neg: { $ne: true } }, { limit: PATH_CAP, maxTimeMS: MAX_TIME_MS }).toArray();
      if (rows.length >= PATH_CAP) warnings.push(`neighbourhood of ${n._id} truncated at ${PATH_CAP} edges per direction`);
      res.push(...rows.map(e => ({ e, other: e[k] })));
    }
    if (HAS_SLOTS.has(n.cls)) { if (n.genome) res.push({ e: slotEdge(ctx, n._id, 'genome', n.genome, n.loc), other: n.genome });
      if (n.tree) res.push({ e: slotEdge(ctx, n._id, 'tree', n.tree), other: n.tree }); }
    const kind = n.cls === 'GeneTree' ? 'tree' : n.cls === 'GenomeAssembly' ? 'genome' : null;
    if (kind) {
      const genes = await N.find({ [kind]: n._id, cls: 'GeneModel' }, { projection: { _id: 1, loc: 1 }, limit: PATH_CAP, maxTimeMS: MAX_TIME_MS }).toArray();
      if (genes.length >= PATH_CAP) warnings.push(`members of ${n._id} truncated at ${PATH_CAP}`);
      res.push(...genes.map(g => ({ e: slotEdge(ctx, g._id, kind, n._id, g.loc), other: g._id })));
    }
    return filterBaked(who, res, x => x.e, (x, e) => ({ ...x, e }));
  }
  // expand the endpoint with the smaller degree, then look for direct edges from each neighbour to the other end
  const [small, big] = degree(from) <= degree(to) ? [from, to] : [to, from];
  const nb = await neighbours(small);
  const paths = [];
  for (const x of nb) if (x.other === big._id) paths.push([x.e]);
  if (maxHops >= 2) {
    const mids = [...new Set(nb.map(x => x.other).filter(o => o !== big._id && o !== small._id))];
    const second = [];
    for (let i = 0; i < mids.length && second.length < 1000; i += 5000) {
      const chunk = mids.slice(i, i + 5000);
      second.push(...await E.find({ $or: [{ s: { $in: chunk }, o: big._id }, { o: { $in: chunk }, s: big._id }], neg: { $ne: true } }, { limit: 1000, maxTimeMS: MAX_TIME_MS }).toArray());
    }
    const midSet = new Set(mids);
    if (HAS_SLOTS.has(big.cls)) for (const [kind, t] of [['genome', big.genome], ['tree', big.tree]]) if (t && midSet.has(t)) second.push(slotEdge(ctx, big._id, kind, t, big.loc));
    for (const kind of ['tree', 'genome']) if ((big.cls === 'GeneTree' && kind === 'tree') || (big.cls === 'GenomeAssembly' && kind === 'genome')) {
      const gs = await N.find({ _id: { $in: mids.filter(m => m.startsWith('gramene.gene:')) }, [kind]: big._id }, { projection: { _id: 1, loc: 1 }, maxTimeMS: MAX_TIME_MS }).toArray();
      second.push(...gs.map(g => slotEdge(ctx, g._id, kind, big._id, g.loc)));
    }
    for (const e2 of await filterBaked(who, second)) {
      const mid = e2.s === big._id ? e2.o : e2.s;
      for (const x of nb) if (x.other === mid) { paths.push([x.e, e2]); if (paths.length >= 50) break; }
      if (paths.length >= 50) { warnings.push('first 50 paths returned'); break; }
    }
  }
  const ordered = paths.slice(0, 50).map(p => (small._id === from._id ? p : [...p].reverse()).map(e => edgeOut(e, ctx)));
  return out(ctx, ordered, { warnings: [...new Set(warnings)] });
}

// ---- derived layers: per-gene homology pairs and expression values from the build's bucketed parquet ----
// kind = 'homologs' | 'expression'; opts are validated by the caller (intParam) before release resolution
export async function derived(kind, raw, q = {}, opts = {}) {
  const fn = kind === 'homologs' ? derivedLib.homologs : derivedLib.expression;
  const ctx = await resolveRelease(q.release);
  // the parameter is always a gene: resolved like /node (exact id, bare id, alias; genome= narrows), candidates
  // restricted to genes, so an id that is one gene's id and another gene's alias is a 409, not a silent pick
  const { n, warnings } = await resolveNode(ctx, raw, q, { cls: 1 }, { classes: ['GeneModel'], quietPrefix: 'gramene.gene' });
  if (n.cls !== 'GeneModel') throw httpError(400, `${n._id} is a ${n.cls}, not a gene`);
  const dir = path.join(BUILDS_DIR, ctx.rel._id, ctx.rel.current_build);
  const data = await fn(dir, n._id.replace(/^gramene\.gene:/, ''), opts);
  return out(ctx, data, { warnings, source: `${ctx.rel._id} build ${ctx.rel.current_build} parquet/derived (not graph edges)` });
}
