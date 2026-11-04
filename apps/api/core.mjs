// gramene-kg read logic shared by REST (server.mjs) and GraphQL (graphql.mjs), so the two cannot diverge.
// Every query function takes plain values (no Fastify objects) and returns { ctx, data, extra }:
//   ctx   = { rel, db, manifest } of the release served; extra = meta fields beyond warnings ([] by default).
// Errors are thrown as httpError(status, message, hint) and rendered by each surface.
// Read-only: the only Mongo dbs touched are kg_meta and kg_<release>_b<build>.
import { MongoClient } from 'mongodb';
import fs from 'node:fs';
import path from 'node:path';
import * as derivedLib from './derived.mjs';

const MONGO_URL = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017';
const SOLR_URL = process.env.SOLR_URL || 'http://127.0.0.1:8983/solr';
const DEFAULT_SITE = process.env.KG_SITE || 'sorghumbase';
export const BUILDS_DIR = process.env.KG_BUILDS_DIR || '/scratch/olson/gramene-kg/builds';
export const MAX_LIMIT = 500, MAX_TIME_MS = 20000, MAX_RESOLVE = 5000, PATH_CAP = 20000;

export const mongo = await MongoClient.connect(MONGO_URL, { maxPoolSize: 20 });
const meta = mongo.db('kg_meta');

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
// q: { release, resolve }
export async function node(curie, q = {}) {
  const ctx = await resolveRelease(q.release);
  const { n, warnings } = await resolveNode(ctx, curie, q);
  return out(ctx, { ...nodeOut(n), provenance: nodeProv(ctx) }, { warnings });
}
// exact-id batch fetch for GraphQL loaders: ids -> same-order array of node outputs (null when absent)
export async function nodesByIds(release, ids) {
  const ctx = await resolveRelease(release);
  const docs = await ctx.db.collection('nodes').find({ _id: { $in: [...new Set(ids)] } }, { projection: { aliases_lc: 0 }, maxTimeMS: MAX_TIME_MS }).toArray();
  const m = new Map(docs.map(d => [d._id, d]));
  return { ctx, rows: ids.map(id => m.has(id) ? { ...nodeOut(m.get(id)), provenance: nodeProv(ctx) } : null) };
}

// Paging runs through ordered phases; the cursor names the phase and the last _id returned in it.
//   out      materialised edges with subject = node   (index s,p,_id)
//   slot_out gene -> genome / tree (node fields)
//   in       materialised edges with object = node    (index o,p,_id)
//   slot_in  genes whose tree / genome field is this node
const PHASES = ['out', 'slot_out', 'in', 'slot_in'];
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
export async function nodeEdges(curie, qy = {}) {
  const ctx = await resolveRelease(qy.release);
  const { n, warnings } = await resolveNode(ctx, curie, qy, { cls: 1, genome: 1, tree: 1, loc: 1, deg: 1 });
  const id = n._id;
  const dir = ['out', 'in', 'both'].includes(qy.direction) ? qy.direction : 'both';
  const limit = intParam(qy.limit, 100, MAX_LIMIT, 'limit') || 1;
  const includeNeg = qy.include_negated === '1' || qy.include_negated === 'true';
  const deg = n.deg ?? {};
  const predsArg = qy.predicate ? resolvePredicates(ctx, deg, qy.predicate, warnings) : null;
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
      const rows = await E.find(f, { sort: { _id: 1 }, limit: k, maxTimeMS: MAX_TIME_MS, hint: ph === 'out' ? { s: 1, p: 1, _id: 1 } : { o: 1, p: 1, _id: 1 } }).toArray();
      return rows.map(e => ({ e, d: ph, ph }));
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
    if (rows.length > rem) { rows.length = rem; rowsOut.push(...rows); next = b64({ ph, id: rows[rem - 1].e._id }); break; }
    rowsOut.push(...rows);
  }
  const others = [...new Set(rowsOut.map(({ e, d }) => d === 'out' ? e.o : e.s))];
  const on = new Map((await N.find({ _id: { $in: others } }, { projection: { cls: 1, cat: 1, name: 1 } }).toArray()).map(o => [o._id, o]));
  const data = rowsOut.map(({ e, d }) => ({ ...edgeOut(e, ctx, nodeOut(on.get(d === 'out' ? e.o : e.s), { full: false }) ?? { id: d === 'out' ? e.o : e.s }), direction: d }));
  if (slotInKind === 'genome' && dir !== 'out' && (await N.findOne({ genome: id, cls: 'SequenceVariant' }, { projection: { _id: 1 } })))
    warnings.push('sequence variants located in this genome are not listed here (millions); query them by position with /kg/v1/region?category=SequenceVariant');
  const r = out(ctx, data, { degree: deg, next, warnings });
  Object.defineProperty(r, 'cursors', { value: rowsOut.map(({ e, ph }) => b64({ ph, id: e._id })) });
  return r;
}

export async function edge(eid, q = {}) {
  const ctx = await resolveRelease(q.release);
  const id = String(eid).replace(/^gramene\.assoc:/, '');
  const e = await ctx.db.collection('edges').findOne({ _id: id });
  if (!e) throw httpError(404, `no edge '${eid}'`);
  const ends = new Map((await ctx.db.collection('nodes').find({ _id: { $in: [e.s, e.o] } }, { projection: { cls: 1, cat: 1, name: 1 } }).toArray()).map(o => [o._id, nodeOut(o, { full: false })]));
  return out(ctx, { ...edgeOut(e, ctx), subject_node: ends.get(e.s) ?? null, object_node: ends.get(e.o) ?? null });
}

// ---- resolve: exact CURIE, bare id under known prefixes (BARE_PREFIXES), aliases; all matches with genome ----
async function resolveIds(ctx, ids, { genome, category }) {
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
// src: { release, ids (array or comma/space string), genome, category }
export async function resolve(src) {
  const ctx = await resolveRelease(src.release);
  const raw = Array.isArray(src.ids) ? src.ids : String(src.ids ?? '').split(/[,\s]+/);
  const all = raw.map(String).filter(Boolean);
  if (all.length > MAX_RESOLVE) throw httpError(400, `at most ${MAX_RESOLVE} ids per request (got ${all.length})`);
  const res = await resolveIds(ctx, all, { genome: src.genome, category: resolveCls(ctx, src.category) });
  return out(ctx, res, res.ambiguous.length ? { warnings: ['ambiguous ids: pass genome=<GCA> or category= to disambiguate'] } : {});
}

// ---- search -----------------------------------------------------------------------------------
const solrPhrase = (v) => `"${String(v).replace(/[\\"]/g, '\\$&')}"`;
// q: { release, q, rows, start, category, genome, source, taxon, system_name }
export async function search(qy = {}) {
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
  const data = j.response.docs.map(d => ({ id: d.id, name: d.name_s, class: d.category_leaf_s, category: d.category_ss, genome: d.genome_s ?? null,
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
  return out(ctx, data, { total: j.response.numFound, facets, gene_fq_core: ctx.rel.genes_core, resolved: resolvedExtra,
    warnings: ['full-text search covers non-gene nodes and the 9 anchor genomes; meta.resolved adds exact id/alias matches from all genomes'] });
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
export async function findPath(qy = {}) {
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
    return res;
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
    for (const e2 of second) {
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
