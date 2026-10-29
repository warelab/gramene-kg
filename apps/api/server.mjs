// gramene-kg read API: REST over the promoted per-build Mongo db and Solr core.
//   GET  /kg/v1/health | /releases | /releases/:id | /releases/:id/manifest | /schema[/:category]
//   GET  /kg/v1/node/:curie | /node/:curie/edges | /edge/:id | /search | /region | /path
//   GET|POST /kg/v1/resolve
// Every response: { release, build, data, meta } plus X-KG-Release / X-KG-Build headers.
// Read-only: the only Mongo dbs touched are kg_meta and kg_<release>_b<build>.
import Fastify from 'fastify';
import { MongoClient } from 'mongodb';
import fs from 'node:fs';
import path from 'node:path';
import * as derived from './derived.mjs';

const PORT = Number(process.env.KG_PORT || 12000);
const HOST = process.env.KG_HOST || '0.0.0.0';
const MONGO_URL = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017';
const SOLR_URL = process.env.SOLR_URL || 'http://127.0.0.1:8983/solr';
const DEFAULT_SITE = process.env.KG_SITE || 'sorghumbase';
const BUILDS_DIR = process.env.KG_BUILDS_DIR || '/scratch/olson/gramene-kg/builds';
const MAX_LIMIT = 500, MAX_TIME_MS = 20000, MAX_RESOLVE = 5000, PATH_CAP = 20000;

const mongo = await MongoClient.connect(MONGO_URL, { maxPoolSize: 20 });
const meta = mongo.db('kg_meta');
const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' }, routerOptions: { maxParamLength: 1000 }, bodyLimit: 2 * 1024 * 1024 });

const httpError = (code, msg, hint) => { const e = new Error(msg); e.statusCode = code; e.hint = hint ?? null; return e; };

// ---- release resolution (cached 30 s) ---------------------------------------------------------
let relCache = { at: 0, rows: [] };
async function releases() {
  if (Date.now() - relCache.at > 30000) relCache = { at: Date.now(), rows: await meta.collection('releases').find({}).toArray() };
  return relCache.rows;
}
const manifestCache = new Map();
async function resolveRelease(req) {
  const rows = await releases();
  const want = req.query?.release ?? req.body?.release;
  const rel = want ? rows.find(r => r._id === want) : rows.find(r => r.is_current && r.site === DEFAULT_SITE) ?? rows.find(r => r.is_current);
  if (!rel) throw httpError(want ? 400 : 503, want ? `unknown release '${want}'` : 'no current release', `available: ${rows.map(r => r._id).join(', ') || 'none'}`);
  const db = mongo.db(rel.db_name);
  if (!manifestCache.has(rel.db_name)) manifestCache.set(rel.db_name, await db.collection('manifest').findOne({ _id: 'build' }));
  return { rel, db, manifest: manifestCache.get(rel.db_name) };
}
function send(reply, ctx, data, extra = {}) {
  reply.header('X-KG-Release', ctx.rel._id).header('X-KG-Build', ctx.rel.current_build);
  return { release: ctx.rel._id, build: ctx.rel.current_build, data, meta: { warnings: [], ...extra } };
}

// ---- ids, classes ------------------------------------------------------------------------------
// DOIs are case-insensitive and stored lower-case; everything else is case-sensitive.
const normId = (c) => {
  const s = String(c ?? '').trim();
  if (/^doi:/i.test(s)) return 'doi:' + s.slice(4).toLowerCase();
  if (/^10\.[0-9]{4,9}\//.test(s)) return 'doi:' + s.toLowerCase();
  return s;
};
// accepts the internal class (GeneModel) or a Biolink category (biolink:GeneFamily / GeneFamily); returns
// every class it names (a category can cover several classes, e.g. GeneFamily = GeneTree + TF family)
function resolveCls(ctx, c) {
  if (c == null || c === '') return null;
  const classes = ctx.manifest?.schema_stats?.classes ?? [];
  const exact = classes.filter(x => x.class === c);
  const hits = exact.length ? exact : classes.filter(x => x.category === c || x.category === `biolink:${c}`);
  if (!hits.length) throw httpError(400, `unknown category '${c}'`, `classes: ${classes.map(x => `${x.class} (${x.category})`).join(', ')}`);
  return hits.map(x => x.class);
}
const normGenome = (g) => g ? (String(g).includes(':') ? String(g) : `insdc.gca:${g}`) : null;
async function resolveNode(ctx, curie, query = {}, projection) {
  const nodes = ctx.db.collection('nodes'); const id = normId(curie); const warnings = [];
  let n = await nodes.findOne({ _id: id }, { projection, maxTimeMS: MAX_TIME_MS });
  if (!n && query.resolve !== '0') {
    const hits = await nodes.find({ aliases_lc: id.toLowerCase() }, { projection: { _id: 1, cls: 1, genome: 1 }, limit: 20 }).toArray();
    if (hits.length === 1) { n = await nodes.findOne({ _id: hits[0]._id }, { projection }); warnings.push(`'${curie}' resolved by alias to ${n._id}`); }
    else if (hits.length > 1) { const e = httpError(409, `'${curie}' is ambiguous`, hits.map(h => `${h._id} (${h.cls}, ${h.genome ?? '-'})`).join('; '));
      e.candidates = hits.map(h => ({ id: h._id, class: h.cls, genome: h.genome ?? null })); throw e; }
  }
  if (!n) throw httpError(404, `no node '${curie}' in ${ctx.rel._id}`, 'try /kg/v1/resolve?ids=...');
  return { n, warnings };
}

// ---- shaping ---------------------------------------------------------------------------------
function nodeOut(n, { full = true } = {}) {
  if (!n) return null;
  const o = { id: n._id, category: n.cat, class: n.cls, name: n.name ?? null };
  if (!full) return o;
  return { ...o, description: n.desc ?? null, aliases: n.aliases ?? [], xrefs: n.xrefs ?? [], in_taxon: n.tax ?? null,
    genome: n.genome ?? null, gene_tree: n.tree ?? null, location: n.loc ?? null, attributes: n.attrs ?? {},
    degree: n.deg ?? {}, card: n.card ?? null };
}
function edgeOut(e, ctx, other) {
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
const intParam = (v, dflt, max, name) => {
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw httpError(400, `${name} must be a non-negative integer`);
  return Math.min(n, max);
};

// ---- routes ----------------------------------------------------------------------------------
app.setErrorHandler((err, req, reply) => {
  const code = err.statusCode && err.statusCode < 600 ? err.statusCode : 500;
  if (code >= 500) req.log.error(err);
  reply.code(code).send({ error: err.message, hint: err.hint ?? null, ...(err.candidates ? { candidates: err.candidates } : {}), docs: '/kg/v1/schema' });
});

app.get('/kg/v1/health', async () => {
  const rows = await releases();
  return { ok: true, releases: rows.map(r => ({ id: r._id, build: r.current_build, current: !!r.is_current })) };
});
app.get('/kg/v1/releases', async () => (await releases()).map(r => ({ id: r._id, site: r.site, build: r.current_build, previous_build: r.previous_build,
  previous_release: r.previous_release, is_current: !!r.is_current, promoted_at: r.promoted_at, counts: r.counts,
  manifest: `/kg/v1/releases/${r._id}/manifest` })));
app.get('/kg/v1/releases/:id', async (req, reply) => {
  req.query.release = req.params.id; const ctx = await resolveRelease(req);
  return send(reply, ctx, { id: ctx.rel._id, build: ctx.rel.current_build, db: ctx.rel.db_name, solr_core: ctx.rel.solr_core,
    counts: ctx.manifest?.counts, catalogue: ctx.manifest?.catalogue });
});
app.get('/kg/v1/releases/:id/manifest', async (req, reply) => {
  req.query.release = req.params.id; const ctx = await resolveRelease(req);
  const cat = (cls) => ctx.db.collection('nodes').find({ cls }, { projection: { card: 0, deg: 0 } }).toArray();
  return send(reply, ctx, { release: ctx.rel._id, build: ctx.rel.current_build, ingest_run: ctx.manifest?.ingest_run,
    datasets: (await cat('KgDataset')).map(n => nodeOut(n)), distributions: (await cat('KgDistribution')).map(n => nodeOut(n)),
    analyses: (await cat('AnalysisRun')).map(n => nodeOut(n)), software: (await cat('SoftwareAgent')).map(n => nodeOut(n)) });
});

app.get('/kg/v1/schema', async (req, reply) => {
  const ctx = await resolveRelease(req);
  return send(reply, ctx, ctx.manifest?.schema_stats ?? { node_classes: ctx.manifest?.counts?.nodes, edge_families: ctx.manifest?.counts?.edges });
});
app.get('/kg/v1/schema/:category', async (req, reply) => {
  const ctx = await resolveRelease(req);
  const st = ctx.manifest?.schema_stats;
  if (!st) return send(reply, ctx, null, { warnings: ['schema_stats not built for this release'] });
  const cls = resolveCls(ctx, req.params.category);
  const one = (k) => ({ ...st.classes.find(x => x.class === k), out: st.relations.filter(r => r.subject_class === k), in: st.relations.filter(r => r.object_class === k) });
  return send(reply, ctx, cls.length === 1 ? one(cls[0]) : cls.map(one));
});

app.get('/kg/v1/node/:curie', async (req, reply) => {
  const ctx = await resolveRelease(req);
  const { n, warnings } = await resolveNode(ctx, req.params.curie, req.query);
  return send(reply, ctx, { ...nodeOut(n), provenance: { release: `gramene.release:${ctx.rel._id}`, ingest_run: ctx.manifest?.ingest_run } }, { warnings });
});

// Paging runs through ordered phases; the cursor names the phase and the last _id returned in it.
//   out      materialised edges with subject = node   (index s,p,_id)
//   slot_out gene -> genome / tree (node fields)
//   in       materialised edges with object = node    (index o,p,_id)
//   slot_in  genes whose tree / genome field is this node
const PHASES = ['out', 'slot_out', 'in', 'slot_in'];
app.get('/kg/v1/node/:curie/edges', async (req, reply) => {
  const ctx = await resolveRelease(req);
  const qy = req.query;
  const { n, warnings } = await resolveNode(ctx, req.params.curie, qy, { cls: 1, genome: 1, tree: 1, loc: 1, deg: 1 });
  const id = n._id;
  const dir = ['out', 'in', 'both'].includes(qy.direction) ? qy.direction : 'both';
  const limit = intParam(qy.limit, 100, MAX_LIMIT, 'limit') || 1;
  const includeNeg = qy.include_negated === '1' || qy.include_negated === 'true';
  const predsArg = qy.predicate ? String(qy.predicate).split(',').map(p => p.includes(':') ? p : `biolink:${p}`) : null;
  const ocls = resolveCls(ctx, qy.category);
  const deg = n.deg ?? {};
  const predsFor = (d) => {
    const fromDeg = [...new Set(Object.keys(deg).filter(k => k.endsWith(`|${d}`)).map(k => k.split('|')[0]))];
    return predsArg ? fromDeg.filter(p => predsArg.includes(p)).concat(predsArg.filter(p => !fromDeg.includes(p))) : fromDeg;
  };
  const E = ctx.db.collection('edges'); const N = ctx.db.collection('nodes');
  const slotInKind = n.cls === 'GeneTree' ? 'tree' : (n.cls === 'GenomeAssembly' ? 'genome' : null);

  // returns up to k rows of a phase after cursor id `after` (sorted by _id), as {e, d}
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
      return rows.map(e => ({ e, d: ph }));
    }
    if (ph === 'slot_out') {
      if (dir === 'in' || !HAS_SLOTS.has(n.cls)) return [];
      const rows = [];
      if (n.genome) rows.push(slotEdge(ctx, id, 'genome', n.genome, n.loc));
      if (n.tree) rows.push(slotEdge(ctx, id, 'tree', n.tree));
      return rows.filter(e => (!predsArg || predsArg.includes(e.p)) && (!qy.source || e.src === qy.source)
        && (!ocls || ocls.includes(SLOT[e._id.split(':')[1]].ocls)) && (!after || e._id > after)).slice(0, k).map(e => ({ e, d: 'out' }));
    }
    if (ph === 'slot_in') {
      if (dir === 'out' || !slotInKind) return [];
      const S = SLOT[slotInKind];
      if ((predsArg && !predsArg.includes(S.p)) || (qy.source && qy.source !== S.src) || (ocls && !ocls.includes('GeneModel'))) return [];
      const f = { [slotInKind]: id, cls: 'GeneModel' }; if (after) f._id = { $gt: after.replace(/^slot:[a-z]+:/, '') };
      const genes = await N.find(f, { projection: { _id: 1, loc: 1 }, sort: { _id: 1 }, limit: k, maxTimeMS: MAX_TIME_MS }).toArray();
      return genes.map(g => ({ e: slotEdge(ctx, g._id, slotInKind, id, g.loc), d: 'in' }));
    }
    return [];
  }

  const cur = qy.cursor ? unb64(qy.cursor) : null;
  if (qy.cursor && (!cur || !PHASES.includes(cur.ph) || typeof cur.id !== 'string')) throw httpError(400, 'invalid cursor');
  const out = []; let next = null;
  for (const ph of PHASES.slice(PHASES.indexOf(cur?.ph ?? 'out'))) {
    const after = cur && cur.ph === ph ? cur.id : null;
    const rem = limit - out.length;
    if (rem === 0) {                                  // page full: is there anything left in this phase?
      if ((await fetchPhase(ph, after, 1)).length) { next = b64({ ph, id: after ?? '' }); break; }
      continue;
    }
    const rows = await fetchPhase(ph, after, rem + 1);
    if (rows.length > rem) { rows.length = rem; out.push(...rows); next = b64({ ph, id: rows[rem - 1].e._id }); break; }
    out.push(...rows);
  }
  const others = [...new Set(out.map(({ e, d }) => d === 'out' ? e.o : e.s))];
  const on = new Map((await N.find({ _id: { $in: others } }, { projection: { cls: 1, cat: 1, name: 1 } }).toArray()).map(o => [o._id, o]));
  const data = out.map(({ e, d }) => ({ ...edgeOut(e, ctx, nodeOut(on.get(d === 'out' ? e.o : e.s), { full: false }) ?? { id: d === 'out' ? e.o : e.s }), direction: d }));
  if (slotInKind === 'genome' && dir !== 'out' && (await N.findOne({ genome: id, cls: 'SequenceVariant' }, { projection: { _id: 1 } })))
    warnings.push('sequence variants located in this genome are not listed here (millions); query them by position with /kg/v1/region?category=SequenceVariant');
  return send(reply, ctx, data, { degree: deg, next, warnings });
});

app.get('/kg/v1/edge/:id', async (req, reply) => {
  const ctx = await resolveRelease(req);
  const id = req.params.id.replace(/^gramene\.assoc:/, '');
  const e = await ctx.db.collection('edges').findOne({ _id: id });
  if (!e) throw httpError(404, `no edge '${req.params.id}'`);
  const ends = new Map((await ctx.db.collection('nodes').find({ _id: { $in: [e.s, e.o] } }, { projection: { cls: 1, cat: 1, name: 1 } }).toArray()).map(o => [o._id, nodeOut(o, { full: false })]));
  return send(reply, ctx, { ...edgeOut(e, ctx), subject_node: ends.get(e.s) ?? null, object_node: ends.get(e.o) ?? null });
});

// ---- resolve: exact CURIE, bare id under known prefixes, aliases; all matches with genome -------------
const BARE_PREFIXES = ['gramene.gene', 'gramene.qtl', 'gramene.sample', 'gramene.genetree', 'gramene.population', 'gramene.germplasm',
  'gxa.expt', 'gramene.expt', 'gramene.assay', 'gramene.contrast', 'gramene.collection', 'interpro', 'reactome', 'dbsnp', 'PMID', 'gramene.tffamily', 'insdc.gca'];
async function resolveIds(ctx, ids, { genome, category }) {
  const nodes = ctx.db.collection('nodes');
  const cands = new Map();                           // candidate _id -> [inputs]
  for (const input of ids) {
    const norm = normId(input);
    const cs = norm.includes(':') ? [norm] : BARE_PREFIXES.map(p => `${p}:${norm}`);
    for (const c of cs) cands.set(c, [...(cands.get(c) ?? []), input]);
  }
  const proj = { projection: { cls: 1, genome: 1, name: 1, aliases_lc: 1 } };
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
async function resolveHandler(req, reply, src) {
  const ctx = await resolveRelease(req);
  const raw = Array.isArray(src.ids) ? src.ids : String(src.ids ?? '').split(/[,\s]+/);
  const all = raw.map(String).filter(Boolean);
  if (all.length > MAX_RESOLVE) throw httpError(400, `at most ${MAX_RESOLVE} ids per request (got ${all.length})`);
  const res = await resolveIds(ctx, all, { genome: src.genome, category: resolveCls(ctx, src.category) });
  return send(reply, ctx, res, res.ambiguous.length ? { warnings: ['ambiguous ids: pass genome=<GCA> or category= to disambiguate'] } : {});
}
app.get('/kg/v1/resolve', (req, reply) => resolveHandler(req, reply, req.query));
app.post('/kg/v1/resolve', (req, reply) => resolveHandler(req, reply, req.body ?? {}));

// ---- search -----------------------------------------------------------------------------------
const solrPhrase = (v) => `"${String(v).replace(/[\\"]/g, '\\$&')}"`;
app.get('/kg/v1/search', async (req, reply) => {
  const ctx = await resolveRelease(req);
  const q = String(req.query.q ?? '').trim();
  const rows = intParam(req.query.rows, 20, 200, 'rows'); const start = intParam(req.query.start, 0, 10000, 'start');
  const fq = [];
  const cls = resolveCls(ctx, req.query.category);
  if (cls) fq.push(`category_leaf_s:(${cls.map(solrPhrase).join(' OR ')})`);
  const genome = normGenome(req.query.genome);
  if (genome) fq.push(`genome_s:${solrPhrase(genome)}`);
  if (req.query.source) fq.push(`source_ss:${solrPhrase(req.query.source)}`);
  if (req.query.taxon) fq.push(`taxon_s:${solrPhrase(req.query.taxon)}`);
  if (req.query.system_name) fq.push(`system_name_s:${solrPhrase(req.query.system_name)}`);
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
  if (q && !/\s/.test(q) && start === 0 && !req.query.source && (!cls || cls.includes('GeneModel'))) {
    const res = await resolveIds(ctx, [q], { category: cls, genome });
    const seen = new Set(data.map(d => d.id));
    resolvedExtra = [...res.resolved, ...res.ambiguous.flatMap(a => a.candidates)].filter(x => !seen.has(x.id))
      .map(x => ({ id: x.id, name: x.name, class: x.class, genome: x.genome, match: x.match }));
  }
  return send(reply, ctx, data, { total: j.response.numFound, facets, gene_fq_core: ctx.rel.genes_core, resolved: resolvedExtra,
    warnings: ['full-text search covers non-gene nodes and the 9 anchor genomes; meta.resolved adds exact id/alias matches from all genomes'] });
});

app.get('/kg/v1/region', async (req, reply) => {
  const ctx = await resolveRelease(req);
  const { genome, region } = req.query; const start = Number(req.query.start), end = Number(req.query.end);
  if (!genome || !region || !Number.isFinite(start) || !Number.isFinite(end) || end < start) throw httpError(400, 'genome, region, start, end required');
  if (end - start > 5e6) throw httpError(400, 'region larger than 5 Mb');
  const f = { genome: normGenome(genome), 'loc.region': String(region), 'loc.start': { $lte: end }, 'loc.end': { $gte: start } };
  const cls = resolveCls(ctx, req.query.category); if (cls) f.cls = { $in: cls };
  const rows = await ctx.db.collection('nodes').find(f, { projection: { cls: 1, cat: 1, name: 1, loc: 1 }, limit: 2001, maxTimeMS: MAX_TIME_MS }).toArray();
  const warnings = rows.length > 2000 ? ['more than 2000 features; narrow the region or pass category='] : [];
  return send(reply, ctx, rows.slice(0, 2000).map(r => ({ ...nodeOut(r, { full: false }), location: r.loc })), { total: Math.min(rows.length, 2000), warnings });
});

// ---- path: up to 2 hops over materialised and slot edges ----------------------------------------
app.get('/kg/v1/path', async (req, reply) => {
  const ctx = await resolveRelease(req);
  const maxHops = Math.min(2, intParam(req.query.max_hops, 2, 2, 'max_hops') || 1);
  if (!req.query.from || !req.query.to) throw httpError(400, 'from and to required');
  const from = (await resolveNode(ctx, req.query.from, req.query, { cls: 1, genome: 1, tree: 1, deg: 1, loc: 1 })).n;
  const to = (await resolveNode(ctx, req.query.to, req.query, { cls: 1, genome: 1, tree: 1, deg: 1, loc: 1 })).n;
  if (from._id === to._id) throw httpError(400, `from and to are the same node (${from._id})`);
  const E = ctx.db.collection('edges'); const N = ctx.db.collection('nodes'); const warnings = [];
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
      const genes = await N.find({ [kind]: n._id, cls: 'GeneModel' }, { projection: { _id: 1, loc: 1 }, limit: PATH_CAP }).toArray();
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
      const gs = await N.find({ _id: { $in: mids.filter(m => m.startsWith('gramene.gene:')) }, [kind]: big._id }, { projection: { _id: 1, loc: 1 } }).toArray();
      second.push(...gs.map(g => slotEdge(ctx, g._id, kind, big._id, g.loc)));
    }
    for (const e2 of second) {
      const mid = e2.s === big._id ? e2.o : e2.s;
      for (const x of nb) if (x.other === mid) { paths.push([x.e, e2]); if (paths.length >= 50) break; }
      if (paths.length >= 50) { warnings.push('first 50 paths returned'); break; }
    }
  }
  const ordered = paths.slice(0, 50).map(p => (small._id === from._id ? p : [...p].reverse()).map(e => edgeOut(e, ctx)));
  return send(reply, ctx, ordered, { warnings: [...new Set(warnings)] });
});

// ---- derived layers: per-gene homology pairs and expression values from the build's bucketed parquet ----
async function derivedRoute(req, reply, fn, opts) {
  const ctx = await resolveRelease(req);
  // the parameter is always a gene: a bare stable id is tried as gramene.gene:<id> first, then the usual alias resolution
  const raw = req.params.gene;
  const bare = !raw.includes(':') && await ctx.db.collection('nodes').findOne({ _id: `gramene.gene:${raw}` }, { projection: { cls: 1 } });
  const { n, warnings } = bare ? { n: bare, warnings: [] } : await resolveNode(ctx, raw, req.query, { cls: 1 });
  if (n.cls !== 'GeneModel') throw httpError(400, `${n._id} is a ${n.cls}, not a gene`);
  const dir = path.join(BUILDS_DIR, ctx.rel._id, ctx.rel.current_build);
  const data = await fn(dir, n._id.replace(/^gramene\.gene:/, ''), opts);
  return send(reply, ctx, data, { warnings, source: `${ctx.rel._id} build ${ctx.rel.current_build} parquet/derived (not graph edges)` });
}
app.get('/kg/v1/derived/homologs/:gene', (req, reply) => derivedRoute(req, reply, derived.homologs,
  { kind: req.query.kind, limit: intParam(req.query.limit, 100, 1000, 'limit'), offset: intParam(req.query.offset, 0, 1e7, 'offset') }));
app.get('/kg/v1/derived/expression/:gene', (req, reply) => derivedRoute(req, reply, derived.expression, { experiment: req.query.experiment }));

// ---- browse UI: static files from apps/ui at /kg/ui/ (hash routing, so every other path is index.html) ----
const UI_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../ui');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.md': 'text/markdown; charset=utf-8' };
app.get('/kg/ui', (req, reply) => reply.redirect('/kg/ui/'));
app.get('/kg/ui/*', (req, reply) => {
  const rel = path.normalize(req.params['*'] || 'index.html').replace(/^(\.\.[/\\])+/, '');
  let f = path.join(UI_DIR, rel);
  if (!f.startsWith(UI_DIR + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) f = path.join(UI_DIR, 'index.html');
  reply.header('Cache-Control', 'no-cache').type(MIME[path.extname(f)] ?? 'application/octet-stream');
  return reply.send(fs.createReadStream(f));
});

app.addHook('onClose', async () => mongo.close());
await app.listen({ port: PORT, host: HOST });
