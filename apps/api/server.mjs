// gramene-kg read API (M1a): REST over the promoted per-build Mongo db and Solr core.
//   GET /kg/v1/health | /releases | /releases/:id | /releases/:id/manifest | /schema[/:category]
//   GET /kg/v1/node/:curie | /node/:curie/edges | /edge/:id | /resolve | /search | /region | /path
// Every response: { release, build, data, meta } plus X-KG-Release / X-KG-Build headers.
// Read-only: the only Mongo dbs touched are kg_meta and kg_<release>_b<build>.
import Fastify from 'fastify';
import { MongoClient } from 'mongodb';

const PORT = Number(process.env.KG_PORT || 12000);
const HOST = process.env.KG_HOST || '0.0.0.0';
const MONGO_URL = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017';
const SOLR_URL = process.env.SOLR_URL || 'http://127.0.0.1:8983/solr';
const DEFAULT_SITE = process.env.KG_SITE || 'sorghumbase';
const MAX_LIMIT = 500, MAX_TIME_MS = 20000, BIG_FANOUT = 50000;

const mongo = await MongoClient.connect(MONGO_URL, { maxPoolSize: 20, readPreference: 'primary' });
const meta = mongo.db('kg_meta');
const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' }, routerOptions: { maxParamLength: 1000 } });

// ---- release resolution (cached 30 s) ---------------------------------------------------------
let relCache = { at: 0, rows: [] };
async function releases() {
  if (Date.now() - relCache.at > 30000) relCache = { at: Date.now(), rows: await meta.collection('releases').find({}).toArray() };
  return relCache.rows;
}
const manifestCache = new Map();
async function resolveRelease(req) {
  const rows = await releases();
  const want = req.query.release;
  const rel = want ? rows.find(r => r._id === want) : rows.find(r => r.is_current && r.site === DEFAULT_SITE) ?? rows.find(r => r.is_current);
  if (!rel) {
    const e = new Error(want ? `unknown release '${want}'` : 'no current release');
    e.statusCode = want ? 400 : 503; e.hint = `available: ${rows.map(r => r._id).join(', ') || 'none'}`; throw e;
  }
  const db = mongo.db(rel.db_name);
  if (!manifestCache.has(rel.db_name)) manifestCache.set(rel.db_name, await db.collection('manifest').findOne({ _id: 'build' }));
  return { rel, db, manifest: manifestCache.get(rel.db_name) };
}
function send(reply, ctx, data, extra = {}) {
  reply.header('X-KG-Release', ctx.rel._id).header('X-KG-Build', ctx.rel.current_build);
  return { release: ctx.rel._id, build: ctx.rel.current_build, data, meta: { warnings: [], ...extra } };
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
    id: `gramene.assoc:${e._id}`, subject: e.s, predicate: e.p, object: e.o, qualifiers: e.q ?? {},
    other: other ?? undefined,
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
// gene -> genome and gene -> tree are node fields (slots), not edge docs; expose them as edges.
function slotEdges(n, ctx) {
  const out = [];
  if (n.cls === 'GeneModel' && n.genome) out.push({ _id: 'slot', s: n._id, p: 'biolink:located_in', o: n.genome, src: 'infores:ensembl-gene',
    kl: 'knowledge_assertion', at: 'automated_agent', q: n.loc, rec: `${ctx.rel._id}.genes.location.map`, layer: 'etl' });
  if (n.cls === 'GeneModel' && n.tree) out.push({ _id: 'slot', s: n._id, p: 'biolink:member_of', o: n.tree, src: 'infores:ensembl-compara',
    kl: 'prediction', at: 'computational_model', ev: ['ECO:0000080'], rec: `${ctx.rel._id}.genes.homology.gene_tree.id`, layer: 'etl' });
  return out;
}
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const unb64 = (s) => { try { return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')); } catch { return null; } };
const clampLimit = (v, d = 100) => Math.max(1, Math.min(MAX_LIMIT, Number(v) || d));

// ---- routes ----------------------------------------------------------------------------------
app.setErrorHandler((err, req, reply) => {
  const code = err.statusCode && err.statusCode < 600 ? err.statusCode : 500;
  if (code >= 500) req.log.error(err);
  reply.code(code).send({ error: err.message, hint: err.hint ?? null, docs: '/kg/v1/schema' });
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
  const st = ctx.manifest?.schema_stats; const c = req.params.category;
  if (!st) return send(reply, ctx, null, { warnings: ['schema_stats not built for this release'] });
  const cls = st.classes.find(x => x.class === c || x.category === c || x.category === `biolink:${c}`);
  if (!cls) { const e = new Error(`unknown category '${c}'`); e.statusCode = 404; e.hint = st.classes.map(x => x.class).join(', '); throw e; }
  return send(reply, ctx, { ...cls, out: st.relations.filter(r => r.subject_class === cls.class), in: st.relations.filter(r => r.object_class === cls.class) });
});

app.get('/kg/v1/node/:curie', async (req, reply) => {
  const ctx = await resolveRelease(req);
  let n = await ctx.db.collection('nodes').findOne({ _id: req.params.curie }, { maxTimeMS: MAX_TIME_MS });
  const warnings = [];
  if (!n && req.query.resolve !== '0') {
    const hits = await ctx.db.collection('nodes').find({ aliases_lc: req.params.curie.toLowerCase() }, { projection: { _id: 1, cls: 1, genome: 1, name: 1 }, limit: 20 }).toArray();
    if (hits.length === 1) { n = await ctx.db.collection('nodes').findOne({ _id: hits[0]._id }); warnings.push(`'${req.params.curie}' resolved by alias to ${n._id}`); }
    else if (hits.length > 1) { const e = new Error(`'${req.params.curie}' is ambiguous`); e.statusCode = 409; e.hint = hits.map(h => `${h._id} (${h.cls}, ${h.genome ?? '-'})`).join('; '); throw e; }
  }
  if (!n) { const e = new Error(`no node '${req.params.curie}' in ${ctx.rel._id}`); e.statusCode = 404; e.hint = 'try /kg/v1/resolve?ids=...'; throw e; }
  return send(reply, ctx, { ...nodeOut(n), provenance: { release: `gramene.release:${ctx.rel._id}`, ingest_run: ctx.manifest?.ingest_run } }, { warnings });
});

app.get('/kg/v1/node/:curie/edges', async (req, reply) => {
  const ctx = await resolveRelease(req);
  const id = req.params.curie; const qy = req.query;
  const n = await ctx.db.collection('nodes').findOne({ _id: id }, { projection: { cls: 1, genome: 1, tree: 1, loc: 1, deg: 1 } });
  if (!n) { const e = new Error(`no node '${id}' in ${ctx.rel._id}`); e.statusCode = 404; throw e; }
  const dir = ['out', 'in', 'both'].includes(qy.direction) ? qy.direction : 'both';
  const limit = clampLimit(qy.limit); const includeNeg = qy.include_negated === '1' || qy.include_negated === 'true';
  const preds = qy.predicate ? String(qy.predicate).split(',').map(p => p.includes(':') ? p : `biolink:${p}`) : null;
  const deg = n.deg ?? {};
  const degIn = (d) => Object.entries(deg).filter(([k]) => k.endsWith(`|${d}`) && (!preds || preds.includes(k.split('|')[0]))).reduce((a, [, v]) => a + v, 0);
  if (!preds && ((dir !== 'out' && degIn('in') > BIG_FANOUT) || (dir !== 'in' && degIn('out') > BIG_FANOUT))) {
    return send(reply, ctx, [], { degree: deg, warnings: [`degree above ${BIG_FANOUT}: pass predicate= to page through one relation`] });
  }
  const cur = qy.cursor ? unb64(qy.cursor) : null;
  const dirs = dir === 'both' ? ['out', 'in'] : [dir];
  const startDir = cur?.d ?? dirs[0];
  const out = [];
  let next = null;
  for (const d of dirs.slice(dirs.indexOf(startDir))) {
    const f = d === 'out' ? { s: id } : { o: id };
    if (preds) f.p = { $in: preds };
    if (qy.source) f.src = qy.source;
    if (!includeNeg) f.neg = { $ne: true };
    if (qy.category) f[d === 'out' ? 'oc' : 'sc'] = qy.category;
    if (cur && cur.d === d) f._id = { $gt: cur.id };
    const rows = await ctx.db.collection('edges').find(f, { sort: { _id: 1 }, limit: limit - out.length + 1, maxTimeMS: MAX_TIME_MS }).toArray();
    if (rows.length > limit - out.length) { rows.length = limit - out.length; out.push(...rows.map(r => ({ r, d }))); next = b64({ d, id: rows.at(-1)._id }); break; }
    out.push(...rows.map(r => ({ r, d })));
  }
  // slot edges (gene -> genome / tree) on the first page
  const slots = !cur && dir !== 'in' ? slotEdges({ _id: id, ...n }, ctx).filter(e => !preds || preds.includes(e.p)) : [];
  const others = [...new Set([...out.map(({ r, d }) => d === 'out' ? r.o : r.s), ...slots.map(s => s.o)])];
  const on = new Map((await ctx.db.collection('nodes').find({ _id: { $in: others } }, { projection: { cls: 1, cat: 1, name: 1 } }).toArray()).map(o => [o._id, o]));
  const data = [...slots.map(e => ({ ...edgeOut(e, ctx, nodeOut(on.get(e.o), { full: false })), id: null, slot: true })),
    ...out.map(({ r, d }) => ({ ...edgeOut(r, ctx, nodeOut(on.get(d === 'out' ? r.o : r.s), { full: false }) ?? { id: d === 'out' ? r.o : r.s }), direction: d }))];
  return send(reply, ctx, data, { degree: deg, next });
});

app.get('/kg/v1/edge/:id', async (req, reply) => {
  const ctx = await resolveRelease(req);
  const id = req.params.id.replace(/^gramene\.assoc:/, '');
  const e = await ctx.db.collection('edges').findOne({ _id: id });
  if (!e) { const err = new Error(`no edge '${req.params.id}'`); err.statusCode = 404; throw err; }
  const ends = new Map((await ctx.db.collection('nodes').find({ _id: { $in: [e.s, e.o] } }, { projection: { cls: 1, cat: 1, name: 1 } }).toArray()).map(o => [o._id, nodeOut(o, { full: false })]));
  return send(reply, ctx, { ...edgeOut(e, ctx), subject_node: ends.get(e.s) ?? null, object_node: ends.get(e.o) ?? null });
});

// id resolution: exact CURIE, then bare id with known prefixes, then aliases (all matches, with genome)
const BARE_PREFIXES = ['gramene.gene', 'gramene.qtl', 'gramene.sample', 'gramene.genetree', 'gramene.population', 'gramene.germplasm',
  'gxa.expt', 'gramene.expt', 'gramene.assay', 'gramene.contrast', 'gramene.collection', 'interpro', 'reactome', 'dbsnp', 'PMID', 'gramene.tffamily', 'insdc.gca'];
app.get('/kg/v1/resolve', async (req, reply) => {
  const ctx = await resolveRelease(req);
  const ids = String(req.query.ids ?? '').split(/[,\s]+/).filter(Boolean).slice(0, 5000);
  const genome = req.query.genome ? (req.query.genome.includes(':') ? req.query.genome : `insdc.gca:${req.query.genome}`) : null;
  const category = req.query.category ?? null;
  const nodes = ctx.db.collection('nodes');
  const resolved = [], ambiguous = [], unknown = [];
  for (const input of ids) {
    const cands = input.includes(':') ? [input] : BARE_PREFIXES.map(p => `${p}:${input}`);
    const exact = await nodes.find({ _id: { $in: cands } }, { projection: { cls: 1, genome: 1, name: 1 } }).toArray();
    const alias = await nodes.find({ aliases_lc: input.toLowerCase() }, { projection: { cls: 1, genome: 1, name: 1 }, limit: 50 }).toArray();
    let hits = [...exact.map(h => ({ ...h, match: 'id' })), ...alias.filter(a => !exact.some(x => x._id === a._id)).map(h => ({ ...h, match: 'alias' }))];
    const cls = category === 'Gene' ? 'GeneModel' : category;
    if (cls) hits = hits.filter(h => h.cls === cls);
    if (genome) hits = hits.filter(h => !h.genome || h.genome === genome);
    const rows = hits.map(h => ({ input, id: h._id, class: h.cls, name: h.name ?? null, genome: h.genome ?? null, match: h.match }));
    if (!rows.length) unknown.push(input); else if (rows.length === 1) resolved.push(rows[0]); else ambiguous.push({ input, candidates: rows });
  }
  return send(reply, ctx, { resolved, ambiguous, unknown }, ambiguous.length ? { warnings: ['ambiguous ids: pass genome=<GCA> or category= to disambiguate'] } : {});
});

app.get('/kg/v1/search', async (req, reply) => {
  const ctx = await resolveRelease(req);
  const q = String(req.query.q ?? '').trim();
  const rows = Math.min(200, Number(req.query.rows) || 20), start = Math.min(10000, Number(req.query.start) || 0);
  const fq = [];
  if (req.query.category) fq.push(`category_leaf_s:"${String(req.query.category).replace(/"/g, '')}"`);
  if (req.query.genome) fq.push(`genome_s:"${String(req.query.genome).replace(/"/g, '')}"`);
  if (req.query.source) fq.push(`source_ss:"${String(req.query.source).replace(/"/g, '')}"`);
  const p = new URLSearchParams({ q: q || '*:*', defType: 'edismax', qf: 'id^20 aliases_lc_ss^10 name_t^6 synonyms_t^3 description_t card_t',
    pf: 'name_t^4', mm: '2<-1 5<80%', rows, start, wt: 'json', timeAllowed: 10000,
    fl: 'id,name_s,category_leaf_s,category_ss,genome_s,taxon_s,source_ss,degree_i,gene_fq_s,card_t,score',
    facet: 'true', 'facet.mincount': 1, 'facet.limit': 30 });
  for (const f of ['category_leaf_s', 'system_name_s', 'source_ss', 'taxon_s']) p.append('facet.field', f);
  for (const f of fq) p.append('fq', f);
  const r = await fetch(`${SOLR_URL}/${ctx.rel.solr_core}/select`, { method: 'POST', body: p, signal: AbortSignal.timeout(15000) });
  if (!r.ok) { const e = new Error(`search backend error ${r.status}`); e.statusCode = 502; throw e; }
  const j = await r.json();
  const facets = Object.fromEntries(Object.entries(j.facet_counts?.facet_fields ?? {}).map(([k, v]) => [k, Object.fromEntries(v.reduce((a, x, i) => (i % 2 ? a.at(-1).push(x) : a.push([x]), a), []))]));
  return send(reply, ctx, j.response.docs.map(d => ({ id: d.id, name: d.name_s, class: d.category_leaf_s, category: d.category_ss, genome: d.genome_s ?? null,
    sources: d.source_ss ?? [], degree: d.degree_i ?? 0, gene_fq: d.gene_fq_s ?? null, card: d.card_t?.slice(0, 600) ?? null, score: d.score })),
    { total: j.response.numFound, facets, gene_fq_core: ctx.rel.genes_core,
      warnings: ['gene text search covers the 9 anchor genomes; use /kg/v1/resolve for pan-genome gene ids'] });
});

app.get('/kg/v1/region', async (req, reply) => {
  const ctx = await resolveRelease(req);
  const { genome, region } = req.query; const start = Number(req.query.start), end = Number(req.query.end);
  if (!genome || !region || !Number.isFinite(start) || !Number.isFinite(end) || end < start) { const e = new Error('genome, region, start, end required'); e.statusCode = 400; throw e; }
  if (end - start > 5e6) { const e = new Error('region larger than 5 Mb'); e.statusCode = 400; throw e; }
  const g = genome.includes(':') ? genome : `insdc.gca:${genome}`;
  const f = { genome: g, 'loc.region': String(region), 'loc.start': { $lte: end }, 'loc.end': { $gte: start } };
  if (req.query.category) f.cls = req.query.category;
  const rows = await ctx.db.collection('nodes').find(f, { projection: { cls: 1, cat: 1, name: 1, loc: 1 }, limit: 2000, maxTimeMS: MAX_TIME_MS }).toArray();
  return send(reply, ctx, rows.map(r => ({ ...nodeOut(r, { full: false }), location: r.loc })), { total: rows.length });
});

// path: meet-in-the-middle over materialised edges, max 2 hops
app.get('/kg/v1/path', async (req, reply) => {
  const ctx = await resolveRelease(req);
  const { from, to } = req.query; const maxHops = Math.min(2, Number(req.query.max_hops) || 2);
  if (!from || !to) { const e = new Error('from and to required'); e.statusCode = 400; throw e; }
  const E = ctx.db.collection('edges'); const cap = 2000;
  const nbrs = async (id) => [...(await E.find({ s: id }, { limit: cap, maxTimeMS: 10000 }).toArray()).map(e => ({ e, n: e.o })),
    ...(await E.find({ o: id }, { limit: cap, maxTimeMS: 10000 }).toArray()).map(e => ({ e, n: e.s }))];
  const a = await nbrs(from); const paths = [];
  for (const x of a) if (x.n === to) paths.push([edgeOut(x.e, ctx)]);
  if (maxHops >= 2 && paths.length < 50) {
    const b = await nbrs(to); const bm = new Map(); for (const y of b) if (!bm.has(y.n)) bm.set(y.n, y.e);
    for (const x of a) if (bm.has(x.n) && x.n !== from && x.n !== to) { paths.push([edgeOut(x.e, ctx), edgeOut(bm.get(x.n), ctx)]); if (paths.length >= 50) break; }
  }
  return send(reply, ctx, paths, { warnings: a.length >= 2 * cap ? [`neighbourhood of ${from} capped at ${cap} per direction`] : [] });
});

app.addHook('onClose', async () => mongo.close());
await app.listen({ port: PORT, host: HOST });
