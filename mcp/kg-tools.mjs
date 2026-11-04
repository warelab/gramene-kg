// kg_* MCP tools: read-only views of the gramene-kg REST API (/kg/v1, apps/api/server.mjs).
// Canonical copy lives in gramene-kg/mcp/; bin/sync-mcp copies it into <gramene-mcp checkout>/kg/.
// Entries have the TOOL_REGISTRY shape {definition:{name,description,inputSchema}, handler(args, site)}.
// site.kgBase = http://host:port/kg (or .../kg/v1); site.kgRelease (optional) pins release= on every call.
// Every result carries release + build; edges keep a compact provenance block (bulk constants hoisted once).
// API 4xx (ambiguous 409, unknown 404, bad params 400) come back as structured results, not tool errors.
// Arguments are checked against each inputSchema before dispatch (the server passes them raw), and every result is kept
// under MCP_MAX_RESULT_BYTES by the tool itself (smaller page, continuation right after the last item returned), so the
// server's generic capResultText never trims a kg result.

const KG_TIMEOUT_MS = Number(process.env.KG_API_TIMEOUT_MS || '30000');
const REL_TTL_MS = 30000;
export const MAX_RESULT_BYTES = Number(process.env.MCP_MAX_RESULT_BYTES || '200000');
const BUDGET = MAX_RESULT_BYTES - 2048;   // headroom for the continuation token / truncation note added after fitting

export class KgHttpError extends Error {
  constructor(status, path, body) {
    super(`KG API HTTP ${status} on ${path}: ${body?.error ?? body?.message ?? JSON.stringify(body)}`);
    this.status = status; this.path = path; this.body = body ?? {};
  }
}

export const kgV1 = (site) => {
  if (!site?.kgBase) throw new Error(`site "${site?.id}" has no kgBase: kg_* tools are not available here`);
  const b = site.kgBase.replace(/\/+$/, '');
  return /\/v1$/.test(b) ? b : `${b}/v1`;
};
export const enc = (curie) => encodeURIComponent(String(curie ?? '').trim());
const relOf = (site, args) => args?.release ?? site.kgRelease ?? undefined;

// GET (or POST with a JSON body) against /kg/v1; params with undefined/null/'' are dropped, arrays joined by ','
export async function kgGet(site, path, params = {}, { body } = {}) {
  const url = new URL(kgV1(site) + path);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const r = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(KG_TIMEOUT_MS),
  }).catch((e) => {
    if (e?.name === 'TimeoutError' || /abort/i.test(e?.message || '')) throw new Error(`KG API timed out after ${KG_TIMEOUT_MS}ms on ${path}: narrow the request (smaller limit, region, or max_hops 1)`);
    throw new Error(`KG API unreachable at ${kgV1(site)} (${e?.cause?.code ?? e?.message ?? e})`);
  });
  const txt = await r.text();
  let j; try { j = JSON.parse(txt); } catch { j = { error: txt.slice(0, 500) || r.statusText }; }
  if (!r.ok) throw new KgHttpError(r.status, path, j);
  return j;
}

// /releases rows (not enveloped), cached per site: fills release/build into error results and kg_changes defaults
const relCache = new Map();
export async function kgReleases(site) {
  const c = relCache.get(site.id);
  if (c && Date.now() - c.at < REL_TTL_MS) return c.rows;
  const rows = await kgGet(site, '/releases');
  relCache.set(site.id, { at: Date.now(), rows });
  return rows;
}
async function relRow(site, release) {
  const rows = await kgReleases(site).catch(() => []);
  return (release ? rows.find(r => r.id === release) : rows.find(r => r.is_current)) ?? null;
}

// ---- shaping ------------------------------------------------------------------------------------
const nonEmpty = (v) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length) && !(typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);
// keeps the citation core always (publications even when empty), the rest only when it says something
export function compactProv(p = {}) {
  const o = { primary_knowledge_source: p.primary_knowledge_source ?? null, knowledge_level: p.knowledge_level ?? null,
    agent_type: p.agent_type ?? null, publications: p.publications ?? [], release: p.release ?? null };
  for (const k of ['has_evidence', 'original_evidence', 'has_supporting_studies', 'method', 'source_record', 'knowledge_source_version', 'original_subject', 'original_object']) if (nonEmpty(p[k])) o[k] = p[k];
  if (p.negated) o.negated = true;
  if (p.layer && p.layer !== 'etl') o.layer = p.layer;
  return o;
}
export function compactEdge(e) {
  const o = { id: e.id ?? null, subject: e.subject, predicate: e.predicate, object: e.object };
  if (e.direction) o.direction = e.direction;
  if (e.other) o.other = { id: e.other.id, class: e.other.class ?? null, name: e.other.name ?? null };
  if (nonEmpty(e.qualifiers)) o.qualifiers = e.qualifiers;
  if (e.slot) o.slot = true;
  o.provenance = compactProv(e.provenance);
  return o;
}
// constants repeated on every edge (aggregators, ingest run), stated once per result
const provContext = (edges) => { const p = edges.find(e => e?.provenance)?.provenance;
  return p ? { aggregator_knowledge_source: p.aggregator_knowledge_source ?? [], ingest_run: p.ingest_run ?? null } : undefined; };
const env = (r, rest) => ({ release: r.release, build: r.build, ...rest, warnings: r.meta?.warnings ?? [] });
const degreeSummary = (deg = {}) => Object.entries(deg).map(([k, n]) => { const [predicate, direction] = k.split('|'); return { predicate, direction, count: n }; })
  .sort((a, b) => b.count - a.count || a.predicate.localeCompare(b.predicate));
export function manifestSummary(d, { detail = false } = {}) {
  const pick = (n, keys) => Object.fromEntries(keys.map(k => [k, n.attributes?.[k] ?? n[k] ?? null]).filter(([, v]) => v !== null));
  const o = { ingest_run: d.ingest_run, counts: { datasets: d.datasets?.length ?? 0, distributions: d.distributions?.length ?? 0, analyses: d.analyses?.length ?? 0, software: d.software?.length ?? 0 },
    software: (d.software ?? []).map(n => ({ id: n.id, ...pick(n, ['name', 'git_sha', 'dirty', 'repo', 'version']) })),
    analyses: (d.analyses ?? []).map(n => ({ id: n.id, name: n.name, description: n.description ?? null })) };
  if (detail) {
    o.datasets = (d.datasets ?? []).map(n => ({ id: n.id, ...pick(n, ['name', 'version', 'source_url']) }));
    o.distributions = (d.distributions ?? []).map(n => ({ id: n.id, ...pick(n, ['name', 'sha256', 'bytes', 'dataset']) }));
  }
  return o;
}

// 4xx from the API -> structured result (status + candidates/hint), never a crash; 5xx/timeouts still throw
async function guarded(site, args, fn) {
  try { return await fn(); } catch (e) {
    if (!(e instanceof KgHttpError) || e.status >= 500) throw e;
    const rel = relOf(site, args); const row = await relRow(site, rel);
    const status = e.status === 409 ? 'ambiguous' : e.status === 404 ? 'not_found' : 'bad_request';
    return { release: rel ?? row?.id ?? null, build: row?.build ?? null, status, http_status: e.status,
      error: e.body.error ?? e.body.message ?? null, hint: e.body.hint ?? null, ...(e.body.candidates ? { candidates: e.body.candidates } : {}),
      advice: status === 'ambiguous' ? 'pick one candidate id, or call kg_resolve with genome= (GCA_000003195.3 = BTx623 v3, the sorghum anchor) or category='
        : status === 'not_found' ? 'check the CURIE prefix and case (doi: lower-case), or try kg_resolve / kg_search' : 'fix the arguments named in error/hint' };
  }
}
const asList = (v) => v === undefined || v === null || v === '' ? undefined : (Array.isArray(v) ? v : String(v).split(/[,\s]+/)).map(String).filter(Boolean);
const bool01 = (v) => v === true || v === 'true' || v === 1 || v === '1' ? '1' : undefined;
const int = (v, dflt, max, name) => { if (v === undefined || v === null) return dflt; if (!Number.isInteger(v) || v < 0) throw new Error(`${name} must be a non-negative integer`); return Math.min(v, max); };
const need = (v, name) => { if (v === undefined || v === null || String(v).trim() === '') throw new Error(`${name} is required`); return v; };

// ---- arguments: the server dispatches raw tool arguments, so each inputSchema is enforced here ------------
const typeName = (s) => s.type === 'array' ? `an array of ${s.items?.type ?? 'value'}s` : s.type === 'integer' ? 'an integer' : `a ${s.type}`;
function schemaError(s, v, path) {   // error text, or null when v satisfies s (the subset of JSON Schema the kg tools use)
  if (s.oneOf) {
    const match = s.oneOf.find(x => x.type === (Array.isArray(v) ? 'array' : typeof v === 'number' && Number.isInteger(v) ? 'integer' : typeof v));
    return match ? schemaError(match, v, path) : `${path} must be ${s.oneOf.map(typeName).join(' or ')}`;
  }
  switch (s.type) {
    case 'string': if (typeof v !== 'string') return `${path} must be a string`; break;
    case 'boolean': if (typeof v !== 'boolean') return `${path} must be a boolean (true/false)`; break;
    case 'integer':
      if (!Number.isInteger(v)) return `${path} must be an integer`;
      if (s.minimum !== undefined && v < s.minimum) return `${path} must be >= ${s.minimum} (got ${v})`;
      if (s.maximum !== undefined && v > s.maximum) return `${path} must be <= ${s.maximum} (got ${v})`;
      break;
    case 'array':
      if (!Array.isArray(v)) return `${path} must be ${typeName(s)}`;
      if (s.minItems !== undefined && v.length < s.minItems) return `${path} needs at least ${s.minItems} entries (got ${v.length})`;
      if (s.maxItems !== undefined && v.length > s.maxItems) return `${path} accepts at most ${s.maxItems} entries (got ${v.length})`;
      if (s.items) for (let i = 0; i < v.length; i++) { const e = schemaError(s.items, v[i], `${path}[${i}]`); if (e) return e; }
      break;
  }
  if (s.enum && !s.enum.includes(v)) return `${path} must be one of ${s.enum.join(', ')} (got ${JSON.stringify(v)})`;
  return null;
}
export function checkArgs(def, args) {
  if (args === undefined || args === null) return {};
  if (typeof args !== 'object' || Array.isArray(args)) throw new Error(`${def.name}: arguments must be an object`);
  const { properties: props = {}, required = [], additionalProperties } = def.inputSchema;
  const extra = additionalProperties === false ? Object.keys(args).filter(k => !Object.hasOwn(props, k)) : [];
  if (extra.length) throw new Error(`${def.name}: unknown argument${extra.length > 1 ? 's' : ''} ${extra.join(', ')} (allowed: ${Object.keys(props).join(', ')})`);
  for (const k of required) if (args[k] === undefined || args[k] === null || args[k] === '') throw new Error(`${def.name}: ${k} is required`);
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue;
    const e = schemaError(props[k], v, k); if (e) throw new Error(`${def.name}: ${e}`);
  }
  return args;
}

// ---- result size: every tool fits its own output (the server's generic trim keeps stale cursors) -------------
export const resultBytes = (o) => Buffer.byteLength(JSON.stringify(o, null, 2));   // the server pretty-prints results
// largest k in [0, n] whose result make(k) fits the budget (make is monotone in k)
function fitCount(n, make) {
  if (resultBytes(make(n)) <= BUDGET) return n;
  let lo = 0, hi = n;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (resultBytes(make(mid)) <= BUDGET) lo = mid; else hi = mid; }
  return lo;
}
const shrunk = (requested, returned, cont) => ({ reason: `page cut from ${requested} to ${returned} items to stay under ${MAX_RESULT_BYTES} bytes`,
  requested, returned, advice: cont ? `nothing was skipped: continue with ${cont}` : 'the rest cannot be paged here: narrow the request' });
// last resort, after the tool has shrunk what it can: an explicit status that keeps release/build, never a generic trim
function sizeGuard(name, out) {
  const bytes = resultBytes(out);
  if (bytes <= MAX_RESULT_BYTES) return out;
  return { release: out?.release ?? null, build: out?.build ?? null, status: 'too_large', http_status: null,
    error: `${name} result is ${bytes} bytes, over the ${MAX_RESULT_BYTES} byte limit even at the smallest page`,
    advice: 'narrow the request: a smaller limit, fewer predicates or ids, a narrower region, or a category filter' };
}

// ---- edge cursors: the API cursor names only {phase, last _id}, not the filters it was issued under; resuming it
// under other filters silently skips edges. The MCP cursor wraps it with those filters, and a mismatch is an error.
// predicates are bound as given (the API resolves bare names), and genome is bound because it picks the node a bare id means
const edgeFilters = (curie, a, release) => ({ curie: String(curie).trim(), predicate: [...new Set((asList(a.predicate) ?? []).map(p => p.trim()))].sort(),
  direction: a.direction ?? 'both', category: a.category ?? null, source: a.source ?? null, include_negated: !!bool01(a.include_negated),
  genome: a.genome ?? null, release: release ?? null });
const bindCursor = (c, f) => c ? Buffer.from(JSON.stringify({ v: 1, c, f })).toString('base64url') : null;
function unbindCursor(cursor, f) {
  let o = null; try { o = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8')); } catch { /* not ours */ }
  if (!o || o.v !== 1 || typeof o.c !== 'string' || !o.f) throw new Error('cursor is not a next_cursor from kg_edges / kg_neighbors: pass next_cursor back exactly as returned, or omit cursor to start from the first edge');
  const diff = Object.keys(f).filter(k => JSON.stringify(o.f[k] ?? null) !== JSON.stringify(f[k] ?? null));
  if (diff.length) throw new Error(`cursor belongs to a different query: it was issued for ${diff.map(k => `${k}=${JSON.stringify(o.f[k] ?? null)}`).join(', ')} but this call has ${diff.map(k => `${k}=${JSON.stringify(f[k])}`).join(', ')}. Resume with the same curie, predicate, direction, category, source, include_negated, genome and release (kg_neighbors blocks give them as next_args), or omit cursor to start over`);
  return o.c;
}

// ---- shared description text ------------------------------------------------------------------
const IDS = [
  'Ids are CURIEs: gramene.gene:<stable id> (gramene.gene:SORBI_3001G018000), gramene.qtl:QPGYR5.1, gramene.genetree:SB11GT_1441062,',
  'gramene.sample:<sample> (gramene.sample:PI533794) vs gramene.germplasm:ars.<GRIN id> (accession), gramene.population:sorghum_bicolor.5,',
  'gxa.expt:E-MTAB-5956, gramene.contrast:<exp>.<test>_<ref>, dbsnp:rs162690701, GO:/PO:/TO:/ECO:<7 digits>, interpro:IPR004294,',
  'reactome:R-ATH-1119449, PMID:29712755, doi:10.1101/gr.227462.117 (doi: always lower-case), insdc.gca:GCA_000003195.3 (genomes),',
  'NCBITaxon:4558. (infores:<source> ids name knowledge sources in provenance and the source= filter; they are not nodes.)',
  'Bare ids and aliases (Sobic.007G158500) go through alias resolution and can be AMBIGUOUS across genomes (Sobic.* is both a',
  'BTx623 v3 alias and a T2T-CAS gene id): use kg_resolve with genome=GCA_000003195.3 (BTx623 v3, the sorghum anchor) to get the',
  'reference gene. Gene symbols are mostly NOT aliases of sorghum genes: a symbol may resolve to another species\' gene only',
  '(tb1 -> rice FC1, Os03g0706500) or to nothing, so always check the genome of a hit; find genes by symbol with kg_search',
  '(q=CRTISO, category=GeneModel, genome=GCA_000003195.3 -> SORBI_3005G160500 and SORBI_3001G018000).',
].join('\n');
const SCOPE = [
  'Not answerable from the graph in increment 1: phenotype observations on germplasm, per-variant genotype calls (which sample carries',
  'which rsID allele), genotype x phenotype associations (GWAS). Expression VALUES (TPM, log2FC) and full homolog pairs are not edges:',
  'get them with kg_derived. Graph edges hold organ-level expressed_in calls, gene->experiment expression_detected_in, anchor orthologs,',
  'predicted LoF carriers (gramene:carries_predicted_lof_allele_of; population sorghum_bicolor.9 / SGT excluded).',
].join('\n');
const CITE = 'Cite each fact with its edge provenance (primary_knowledge_source, knowledge_level, publications) and the release/build.';
const NEG = 'Negated edges (e.g. expressed_in with negated:true = "not expressed") are hidden unless include_negated:true.';
const GENOME = { genome: { type: 'string', description: 'Narrows a bare id or alias that matches genes in several genomes: GCA accession (GCA_000003195.3 = BTx623 v3 anchor) or genome CURIE.' } };
const REL = { release: { type: 'string', description: 'KG release id (default: this site\'s release, e.g. sorghum11). See kg_release.' } };
const CURIE = (d = 'Node CURIE (bare ids are alias-resolved; see kg_resolve).') => ({ type: 'string', description: d });

// ---- tools ----------------------------------------------------------------------------------------
export const KG_TOOL_REGISTRY = {
  kg_resolve: {
    definition: {
      name: 'kg_resolve',
      description: [
        'Map ids, gene symbols or aliases to knowledge-graph CURIEs. Start here whenever an id is not already a CURIE you got from a kg_* result.',
        'Returns resolved (exactly one match), ambiguous (input -> candidates with class and genome) and unknown. Never guess between',
        'ambiguous candidates: re-run with genome= or category=, or ask the user.',
        '', IDS, '',
        'Long lists come back in input order up to the result size limit; truncated.next_offset then says where to resume (same ids, offset=).',
        'Next: kg_node (one node), kg_neighbors / kg_edges (its links), kg_search (free text instead of ids).',
      ].join('\n'),
      inputSchema: { type: 'object', properties: {
        ids: { oneOf: [{ type: 'array', items: { type: 'string' }, maxItems: 5000 }, { type: 'string' }], description: 'Ids to resolve (array, or comma/space separated string). Up to 5000.' },
        genome: { type: 'string', description: 'Restrict gene/variant matches to one genome: GCA accession (GCA_000003195.3 = BTx623 v3 anchor) or genome CURIE.' },
        category: { type: 'string', description: 'Restrict to a class or Biolink category, e.g. GeneModel, biolink:Gene, QuantitativeTraitLocus, GenotypedSample.' },
        offset: { type: 'integer', minimum: 0, maximum: 4999, description: 'Skip this many ids of the list: pass truncated.next_offset of the previous call (same ids).' },
        ...REL }, required: ['ids'], additionalProperties: false },
    },
    handler: (args = {}, site) => guarded(site, args, async () => {
      // the API trims and de-duplicates its inputs: do the same here so every input maps back to exactly one outcome
      const all = [...new Set(asList(need(args.ids, 'ids')).map(s => s.trim()).filter(Boolean))];
      if (all.length > 5000) throw new Error(`kg_resolve: ids accepts at most 5000 ids (got ${all.length})`);
      const offset = args.offset ?? 0;
      if (offset >= all.length) throw new Error(`kg_resolve: offset ${offset} is past the end of the ${all.length} ids`);
      const ids = all.slice(offset);
      const q = { genome: args.genome, category: args.category, release: relOf(site, args) };
      const post = ids.length > 100 || ids.some(s => s.includes(','));   // GET joins ids with ','
      const r = post ? await kgGet(site, '/resolve', {}, { body: { ids, ...q } }) : await kgGet(site, '/resolve', { ids, ...q });
      // each input lands in exactly one of resolved / ambiguous / unknown, each list in input order: rebuild per-input outcomes
      const d = r.data; let ri = 0, ai = 0, ui = 0;
      const per = ids.map(input => d.resolved[ri]?.input === input ? ['resolved', d.resolved[ri++]] : d.ambiguous[ai]?.input === input ? ['ambiguous', d.ambiguous[ai++]]
        : d.unknown[ui] === input ? ['unknown', d.unknown[ui++]] : null);
      const make = (k, extra = {}) => {
        const o = { resolved: [], ambiguous: [], unknown: [] };
        for (const x of per.slice(0, k)) if (x) o[x[0]].push(x[1]);
        return env(r, { ...o, counts: { resolved: o.resolved.length, ambiguous: o.ambiguous.length, unknown: o.unknown.length }, ...extra });
      };
      const consistent = per.every(Boolean) && ri === d.resolved.length && ai === d.ambiguous.length && ui === d.unknown.length;
      // should the API ever answer in another order, pass its lists through whole rather than drop the unmatched inputs
      if (!consistent) return env(r, { resolved: d.resolved, ambiguous: d.ambiguous, unknown: d.unknown,
        counts: { resolved: d.resolved.length, ambiguous: d.ambiguous.length, unknown: d.unknown.length }, ...(offset ? { offset } : {}) });
      const k = Math.max(1, fitCount(ids.length, make));
      if (k === ids.length) return make(k, offset ? { offset } : {});
      return make(k, { offset, truncated: { ...shrunk(ids.length, k, `offset=${offset + k} and the same ids`), ids_total: all.length, next_offset: offset + k } });
    }),
  },

  kg_node: {
    definition: {
      name: 'kg_node',
      description: [
        'One knowledge-graph node: class, Biolink category, name, description, aliases, xrefs, taxon, genome, location, attributes,',
        'card (a one-paragraph text summary of its neighbourhood with sources), degree per predicate|direction, and node provenance.',
        'A bare id (SORBI_3001G018000, QPGYR5.1) or alias is tried under every known prefix and as an alias, exactly like kg_resolve:',
        'one match is returned with a warning saying how it was resolved; several return status "ambiguous" with candidates (pick one,',
        'or pass genome=); none returns status "not_found". Sobic.* ids are ambiguous (T2T-CAS gene id and BTx623 v3 alias).',
        'Next: kg_neighbors (summary + edges of chosen predicates), kg_edges (paging), kg_derived (expression values / homologs of a gene).',
      ].join('\n'),
      inputSchema: { type: 'object', properties: { curie: CURIE(), ...GENOME, ...REL }, required: ['curie'], additionalProperties: false },
    },
    handler: (args = {}, site) => guarded(site, args, async () => {
      const r = await kgGet(site, `/node/${enc(need(args.curie, 'curie'))}`, { genome: args.genome, release: relOf(site, args) });
      return env(r, { status: 'ok', node: r.data, ...(r.data.id !== args.curie ? { resolved_from: args.curie } : {}) });
    }),
  },

  kg_neighbors: {
    definition: {
      name: 'kg_neighbors',
      description: [
        'A node plus a compact neighbourhood: per predicate and direction the edge count (from the node degree; counts include negated',
        'edges), and for each predicate you name the first page of edges with the neighbour\'s id/class/name and provenance.',
        'Use it to see what a node links to before paging with kg_edges: each per-predicate block with more edges carries next_args',
        '= the exact kg_edges arguments (curie, that ONE predicate, direction, include_negated, cursor) for the next page; the cursor is',
        'only valid with those arguments. Blocks are cut evenly when the whole result would exceed the size limit (truncated says so).',
        'Common predicates: overlaps (gene->QTL, containment on the QTL\'s genome), located_in, member_of (gene->tree, sample->population),',
        'orthologous_to, expressed_in (gene->PO organ), gramene:expressed_during (gene->PO stage), gramene:expression_detected_in',
        '(gene->experiment), enables / actively_involved_in / located_in (gene->GO), gramene:has_domain, participates_in (Reactome),',
        'has_phenotype (gene->TO), mentions (publication->gene/experiment), is_sequence_variant_of (rsID->gene), subclass_of / part_of',
        '(ontology), gramene:carries_predicted_lof_allele_of (sample->gene), derives_from (sample->germplasm), associated_with (QTL->TO trait).',
        'A predicate without a prefix resolves to the release predicate with that local name (warnings list the valid ones if none). ' + NEG,
        CITE,
      ].join('\n'),
      inputSchema: { type: 'object', properties: {
        curie: CURIE(),
        predicates: { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'Predicates to fetch edges for (e.g. ["overlaps","gramene:carries_predicted_lof_allele_of"]). Omit for the summary only.' },
        direction: { type: 'string', enum: ['out', 'in', 'both'], description: 'Edge direction relative to the node (default both).' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Edges per predicate (default 10).' },
        include_negated: { type: 'boolean', description: 'Include negated edges (default false).' },
        ...GENOME, ...REL }, required: ['curie'], additionalProperties: false },
    },
    handler: (args = {}, site) => guarded(site, args, async () => {
      const release = relOf(site, args);
      const r = await kgGet(site, `/node/${enc(need(args.curie, 'curie'))}`, { genome: args.genome, release });
      const n = r.data; const limit = int(args.limit, 10, 100, 'limit') || 1;
      const preds = [...new Set(args.predicates ?? [])];
      const page = (p, lim) => kgGet(site, `/node/${enc(n.id)}/edges`, { predicate: p, direction: args.direction, limit: lim, include_negated: bool01(args.include_negated), release });
      const pages = new Map();
      for (const p of preds) pages.set(p, await page(p, limit));
      const { degree, card, ...node } = n;
      const make = (cap, cut = new Set()) => {
        const edges = {}; const all = []; const warnings = [...(r.meta?.warnings ?? [])];
        for (const [p, e] of pages) {
          const rows = e.data.slice(0, cap); all.push(...rows);
          const next = bindCursor(e.meta?.next ?? null, edgeFilters(n.id, { predicate: p, direction: args.direction, include_negated: args.include_negated }, release));
          edges[p] = { count_in_page: rows.length, next_cursor: next,
            ...(next ? { next_args: { curie: n.id, predicate: p, ...(args.direction ? { direction: args.direction } : {}), ...(args.include_negated ? { include_negated: true } : {}), ...(args.release ? { release: args.release } : {}), cursor: next } } : {}),
            ...(cut.has(p) ? { truncated: shrunk(limit, rows.length, 'next_args in kg_edges') } : {}), items: rows.map(compactEdge) };
          warnings.push(...(e.meta?.warnings ?? []));
        }
        return { release: r.release, build: r.build, node: { ...node, card }, predicates: degreeSummary(degree), edges,
          ...(all.length ? { provenance_context: provContext(all) } : {}), ...(cut.size ? { truncated: { reason: `edge blocks cut to at most ${cap} edges each to stay under ${MAX_RESULT_BYTES} bytes`, per_predicate_limit: cap, requested: limit, advice: 'nothing was skipped: page each cut block with its next_args in kg_edges' } } : {}),
          warnings: [...new Set(warnings)] };
      };
      const longest = Math.max(0, ...[...pages.values()].map(e => e.data.length));
      const cap = Math.max(1, fitCount(longest, (k) => make(k)));
      if (cap >= longest) return make(longest);
      // re-fetch the blocks that are cut with limit=cap, so each block's cursor resumes right after its last returned edge
      const cut = new Set();
      for (const [p, e] of pages) if (e.data.length > cap) { pages.set(p, await page(p, cap)); cut.add(p); }
      return make(cap, cut);
    }),
  },

  kg_edges: {
    definition: {
      name: 'kg_edges',
      description: [
        'Page through the edges of one node, filtered by predicate, direction, neighbour category and primary source. Each edge has',
        'subject, predicate, object, direction, the neighbour (other: id/class/name), qualifiers (e.g. containment, zygosity, consequence,',
        'population) and provenance. Pass next_cursor back as cursor with the SAME curie and filters for the next page (a cursor used',
        'with other filters is rejected); next_cursor null = done. A page that would exceed the result size limit comes back shorter',
        '(truncated says so) and next_cursor still resumes right after its last edge, so nothing is skipped.',
        'degree gives the total per predicate|direction, so you can say "5 of 5" without paging everything.',
        NEG + ' ' + CITE,
      ].join('\n'),
      inputSchema: { type: 'object', properties: {
        curie: CURIE(),
        predicate: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, maxItems: 50 }], description: 'One or more predicates, exactly as degree shows them; a bare local name resolves to the release predicate. Omit for all.' },
        direction: { type: 'string', enum: ['out', 'in', 'both'], description: 'Default both.' },
        category: { type: 'string', description: 'Only neighbours of this class / Biolink category (e.g. GenotypedSample, biolink:Gene).' },
        source: { type: 'string', description: 'Only edges with this primary_knowledge_source (e.g. infores:sorghum-qtl-atlas).' },
        include_negated: { type: 'boolean', description: 'Default false.' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Page size (default 50, max 500).' },
        cursor: { type: 'string', description: 'next_cursor from the previous page.' },
        ...GENOME, ...REL }, required: ['curie'], additionalProperties: false },
    },
    handler: (args = {}, site) => guarded(site, args, async () => {
      const curie = need(args.curie, 'curie'); const release = relOf(site, args);
      const f = edgeFilters(curie, args, release);
      const after = args.cursor ? unbindCursor(args.cursor, f) : undefined;
      const want = int(args.limit, 50, 500, 'limit');
      const page = (limit) => kgGet(site, `/node/${enc(curie)}/edges`, { predicate: asList(args.predicate), direction: args.direction,
        category: args.category, source: args.source, include_negated: bool01(args.include_negated), limit, cursor: after, genome: args.genome, release });
      const make = (r, k, extra = {}) => { const rows = r.data.slice(0, k);
        return env(r, { count: rows.length, next_cursor: bindCursor(r.meta?.next ?? null, f), degree: r.meta?.degree ?? {}, provenance_context: provContext(rows), items: rows.map(compactEdge), ...extra }); };
      const r = await page(want);
      const k = fitCount(r.data.length, (k) => make(r, k));
      if (k === r.data.length) return make(r, k);
      // too big: ask again for exactly the edges that fit, so the API's next cursor resumes right after the last one returned
      const r2 = await page(Math.max(1, k));
      return make(r2, r2.data.length, { truncated: shrunk(want, r2.data.length, 'next_cursor') });
    }),
  },

  kg_evidence: {
    definition: {
      name: 'kg_evidence',
      description: [
        'Full provenance of one materialised edge by id (gramene.assoc:<hex>, as returned in edge.id by kg_edges / kg_neighbors / kg_path):',
        'primary and aggregator knowledge sources, knowledge_level, agent_type, ECO evidence, original evidence code, publications,',
        'supporting studies, method (analysis id), source_record, original subject/object ids, negation, layer, ingest run, and both end nodes.',
        'Slot edges (id null: gene->genome located_in, gene->tree member_of) have no id; their provenance is already complete in the listing.',
      ].join('\n'),
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Edge id, e.g. gramene.assoc:1ae6b6e088cbd7958482e00f.' }, ...REL }, required: ['id'], additionalProperties: false },
    },
    handler: (args = {}, site) => guarded(site, args, async () => {
      const r = await kgGet(site, `/edge/${enc(need(args.id, 'id'))}`, { release: relOf(site, args) });
      return env(r, { status: 'ok', edge: r.data });
    }),
  },

  kg_path: {
    definition: {
      name: 'kg_path',
      description: [
        'Paths of 1 or 2 hops between two nodes (non-negated materialised edges plus gene->genome / gene->tree slots), up to 50 paths,',
        'each an ordered list of edges from "from" to "to" with provenance. Use it to explain how two things connect',
        '(gene <-> QTL, sample <-> population, publication <-> gene). Hubs are truncated (warnings say so). Longer chains: walk with kg_edges.',
      ].join('\n'),
      inputSchema: { type: 'object', properties: { from: CURIE('Start node CURIE.'), to: CURIE('End node CURIE.'),
        max_hops: { type: 'integer', minimum: 1, maximum: 2, description: 'Default 2 (the API maximum).' }, ...GENOME, ...REL }, required: ['from', 'to'], additionalProperties: false },
    },
    handler: (args = {}, site) => guarded(site, args, async () => {
      const r = await kgGet(site, '/path', { from: need(args.from, 'from'), to: need(args.to, 'to'), max_hops: args.max_hops, genome: args.genome, release: relOf(site, args) });
      const make = (k, extra = {}) => { const ps = r.data.slice(0, k);
        return env(r, { count: ps.length, provenance_context: provContext(ps.flat()), items: ps.map(p => ({ hops: p.length, edges: p.map(compactEdge) })), ...extra }); };
      const k = fitCount(r.data.length, make);
      return k === r.data.length ? make(k) : make(k, { truncated: { ...shrunk(r.data.length, k, null), total_paths: r.data.length } });
    }),
  },

  kg_region: {
    definition: {
      name: 'kg_region',
      description: [
        'Nodes located in a genome interval (at most 5 Mb, at most 2000 features): genes, QTLs, rsID variants (category SequenceVariant;',
        'variants are only reachable by position or exact id). genome is a GCA accession (GCA_000003195.3 = BTx623 v3) or insdc.gca:/gramene.genome:',
        'CURIE; region is the sequence name as in node locations (sorghum chromosomes "1".."10").',
        'Items are sorted by start and paged by offset: when they do not all fit the result size limit (or limit is smaller), next_offset',
        'gives the next page of the same window. Without category, dense windows are mostly rsID variants: pass category=GeneModel for genes.',
        'If the window holds more than 2000 features the API returns an arbitrary 2000 of them (complete:false, total_is_lower_bound):',
        'paging cannot reach the rest, so split the window (narrower_windows suggests halves) or pass category.',
      ].join('\n'),
      inputSchema: { type: 'object', properties: {
        genome: { type: 'string' }, region: { type: 'string' }, start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 0 },
        category: { type: 'string', description: 'e.g. GeneModel, QuantitativeTraitLocus, SequenceVariant.' },
        offset: { type: 'integer', minimum: 0, maximum: 2000, description: 'Skip this many features of the sorted window (next_offset of the previous call).' },
        limit: { type: 'integer', minimum: 1, maximum: 2000, description: 'At most this many features (default: as many as fit).' }, ...REL },
        required: ['genome', 'region', 'start', 'end'], additionalProperties: false },
    },
    handler: (args = {}, site) => guarded(site, args, async () => {
      const r = await kgGet(site, '/region', { genome: need(args.genome, 'genome'), region: need(args.region, 'region'), start: args.start, end: args.end, category: args.category, release: relOf(site, args) });
      const loc = (x) => x.location ?? {};
      const rows = [...r.data].sort((a, b) => (loc(a).start ?? 0) - (loc(b).start ?? 0) || (loc(a).end ?? 0) - (loc(b).end ?? 0) || String(a.id).localeCompare(String(b.id)));
      const total = r.meta?.total ?? r.data.length;
      const capped = (r.meta?.warnings ?? []).some(w => /more than \d+ features/.test(w));
      const offset = args.offset ?? 0; const want = args.limit ?? rows.length;
      const win = rows.slice(offset, offset + want);
      const mid = Math.floor((args.start + args.end) / 2);
      const make = (k, extra = {}) => env(r, { total, ...(capped ? { complete: false, total_is_lower_bound: true,
          narrower_windows: [{ start: args.start, end: mid }, { start: mid + 1, end: args.end }] } : {}),
        offset, next_offset: offset + k < rows.length ? offset + k : null, items: win.slice(0, k), ...extra });
      const k = Math.max(1, fitCount(win.length, make));
      return k >= win.length ? make(win.length) : make(k, { truncated: shrunk(win.length, k, `offset=${offset + k}`) });
    }),
  },

  kg_search: {
    definition: {
      name: 'kg_search',
      description: [
        'Full-text search over knowledge-graph nodes (names, ids, aliases, synonyms, descriptions, cards): pathways, GO/PO/TO terms, QTLs,',
        'publications, experiments, samples, populations, and genes of the 9 anchor genomes. A single-token query also returns exact',
        'id/alias matches from all genomes in resolved. facets give counts by class, genome system_name, source and taxon; gene_fq is the',
        'filter for the site\'s gene search (gene_search) when a node maps to one. For known ids use kg_resolve instead. A page too large',
        'for the result size limit comes back shorter, with truncated.next_start for the next one.',
        SCOPE,
      ].join('\n'),
      inputSchema: { type: 'object', properties: {
        q: { type: 'string', description: 'Query text (empty = everything, use with filters).' },
        category: { type: 'string', description: 'Class or Biolink category filter.' },
        genome: { type: 'string', description: 'Genome filter (GCA accession or CURIE).' },
        source: { type: 'string', description: 'infores: source filter.' },
        taxon: { type: 'string', description: 'NCBITaxon CURIE filter, e.g. NCBITaxon:4558.' },
        system_name: { type: 'string', description: 'Genome system_name filter, e.g. sorghum_bicolor.' },
        rows: { type: 'integer', minimum: 0, maximum: 200, description: 'Default 20.' },
        start: { type: 'integer', minimum: 0, maximum: 10000 }, ...REL }, additionalProperties: false },
    },
    handler: (args = {}, site) => guarded(site, args, async () => {
      const r = await kgGet(site, '/search', { q: args.q, category: args.category, genome: args.genome, source: args.source, taxon: args.taxon,
        system_name: args.system_name, rows: args.rows, start: args.start, release: relOf(site, args) });
      const make = (k, extra = {}) => env(r, { total: r.meta?.total ?? 0, facets: r.meta?.facets ?? {}, resolved: r.meta?.resolved ?? [], gene_fq_core: r.meta?.gene_fq_core ?? null, items: r.data.slice(0, k), ...extra });
      const k = Math.max(1, fitCount(r.data.length, make));
      if (k >= r.data.length) return make(r.data.length);
      const next = (args.start ?? 0) + k;
      return make(k, { truncated: { ...shrunk(r.data.length, k, `start=${next}`), next_start: next } });
    }),
  },

  kg_schema: {
    definition: {
      name: 'kg_schema',
      description: [
        'What the graph contains: node classes (Biolink category, count, id prefixes, examples) and relations (edge family, predicate,',
        'subject/object class, count, sources). With category: one class with its outgoing and incoming relations. Call this before',
        'assuming a link exists.',
        SCOPE,
      ].join('\n'),
      inputSchema: { type: 'object', properties: { category: { type: 'string', description: 'Class (GeneModel) or Biolink category (biolink:Gene, GeneFamily).' }, ...REL }, additionalProperties: false },
    },
    handler: (args = {}, site) => guarded(site, args, async () => {
      const r = await kgGet(site, args.category ? `/schema/${enc(args.category)}` : '/schema', { release: relOf(site, args) });
      return env(r, { schema: r.data });
    }),
  },

  kg_release: {
    definition: {
      name: 'kg_release',
      description: [
        'Releases served by the KG API (current and previous build, promotion time, node/edge totals) and, for one release, per-class node',
        'and per-family edge counts plus a manifest summary (ingest run, software with git sha, analyses). detail:true adds every source',
        'dataset (name, version, URL) and file distribution (sha256, bytes). Use it to state which release/build an answer comes from.',
      ].join('\n'),
      inputSchema: { type: 'object', properties: { detail: { type: 'boolean', description: 'Include datasets and distributions (large).' }, ...REL }, additionalProperties: false },
    },
    handler: (args = {}, site) => guarded(site, args, async () => {
      const rows = await kgReleases(site);
      const id = relOf(site, args) ?? rows.find(r => r.is_current)?.id;
      if (!id) return { release: null, build: null, releases: rows, warnings: ['no current release'] };
      const r = await kgGet(site, `/releases/${enc(id)}`, {});
      const m = await kgGet(site, `/releases/${enc(id)}/manifest`, {});
      const row = rows.find(x => x.id === id) ?? {};
      return env(r, { current_build: r.build, previous_build: row.previous_build ?? null, previous_release: row.previous_release ?? null, promoted_at: row.promoted_at ?? null,
        db: r.data.db, solr_core: r.data.solr_core, counts: r.data.counts, catalogue: r.data.catalogue, manifest: manifestSummary(m.data, { detail: !!args.detail }),
        releases: rows.map(x => ({ id: x.id, site: x.site, build: x.build, previous_build: x.previous_build, is_current: x.is_current, counts: x.counts })) });
    }),
  },

  kg_derived: {
    definition: {
      name: 'kg_derived',
      description: [
        'Derived per-gene tables that are NOT graph edges (read from the build\'s Parquet): layer "homologs" = every Compara homology pair',
        'of the gene (kind: ortholog_one2one | ortholog_one2many | ortholog_many2many | within_species_paralog | ...; by_kind counts;',
        'perc_pos, gene tree), paged by limit/offset; layer "expression" = expression values (baseline TPM per assay group, differential',
        'log2FC + p-value per contrast), optionally for one experiment (E-MTAB-5956), paged here by limit/offset. gene may be a bare stable',
        'id, an alias or gramene.gene:<id>. The graph only has anchor orthologous_to edges and organ-level expressed_in calls.',
      ].join('\n'),
      inputSchema: { type: 'object', properties: {
        gene: { type: 'string', description: 'Gene id or CURIE.' },
        layer: { type: 'string', enum: ['homologs', 'expression'] },
        kind: { type: 'string', description: 'homologs only: one homology kind.' },
        experiment: { type: 'string', description: 'expression only: one experiment accession (E-MTAB-5956).' },
        limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'Default 100.' },
        offset: { type: 'integer', minimum: 0 }, ...GENOME, ...REL }, required: ['gene', 'layer'], additionalProperties: false },
    },
    handler: (args = {}, site) => guarded(site, args, async () => {
      const gene = enc(need(args.gene, 'gene')); const limit = int(args.limit, 100, 1000, 'limit'); const offset = int(args.offset, 0, 1e7, 'offset');
      // rows that do not fit the result size limit are left for the next page: next_offset = offset + rows returned
      const fit = (rows, make) => { const k = Math.max(1, fitCount(rows.length, make)); return k >= rows.length ? make(rows.length) : make(k, { truncated: shrunk(rows.length, k, `offset=${offset + k}`) }); };
      if (args.layer === 'homologs') {
        const r = await kgGet(site, `/derived/homologs/${gene}`, { kind: args.kind, limit, offset, genome: args.genome, release: relOf(site, args) });
        const rows = r.data.rows;
        return fit(rows, (k, extra = {}) => env(r, { layer: 'homologs', source: r.meta?.source ?? null, gene_id: r.data.gene_id, total: r.data.total, by_kind: r.data.by_kind,
          offset, next_offset: offset + k < r.data.total ? offset + k : null, items: rows.slice(0, k), ...extra }));
      }
      if (args.layer !== 'expression') throw new Error("layer must be 'homologs' or 'expression'");
      // the API returns all of a gene's values (optionally per experiment); paging is done here
      const r = await kgGet(site, `/derived/expression/${gene}`, { experiment: args.experiment, genome: args.genome, release: relOf(site, args) });
      const rows = r.data.rows; const by_experiment = {};
      for (const x of rows) by_experiment[x.experiment] = (by_experiment[x.experiment] ?? 0) + 1;
      const page = rows.slice(offset, offset + limit);
      return fit(page, (k, extra = {}) => env(r, { layer: 'expression', source: r.meta?.source ?? null, gene_id: r.data.gene_id, total: rows.length, by_experiment,
        offset, next_offset: offset + k < rows.length ? offset + k : null, items: page.slice(0, k), ...extra }));
    }),
  },

  kg_changes: {
    definition: {
      name: 'kg_changes',
      description: [
        'What changed between two builds of a release: node counts per class and edge counts per family (from, to, delta) plus totals.',
        'Defaults: to = current build, from = the previous build. builds_available lists builds you can compare. If the deployed API',
        'does not serve this yet, the result says so (status "unavailable") and gives the current/previous build ids from kg_release.',
      ].join('\n'),
      inputSchema: { type: 'object', properties: { from: { type: 'string', description: 'Build id, e.g. 202610291704.' }, to: { type: 'string', description: 'Build id (default current).' },
        only_changed: { type: 'boolean', description: 'Drop classes/families whose delta is 0 (default true).' }, ...REL }, additionalProperties: false },
    },
    handler: async (args = {}, site) => {
      const rows = await kgReleases(site);
      const id = relOf(site, args) ?? rows.find(r => r.is_current)?.id;
      const row = rows.find(r => r.id === id) ?? null;
      try {
        const r = await kgGet(site, `/releases/${enc(id)}/changes`, { from: args.from, to: args.to });
        const d = r.data; const keep = args.only_changed !== false;
        const filt = (o = {}) => Object.fromEntries(Object.entries(o).filter(([, v]) => !keep || v?.delta !== 0));
        return env(r, { status: 'ok', from: d.from, to: d.to, builds_available: d.builds_available ?? [], totals: d.totals, nodes: filt(d.nodes), edges: filt(d.edges),
          ...(keep ? { note: 'classes/families with delta 0 omitted (only_changed:false shows all)' } : {}) });
      } catch (e) {
        if (!(e instanceof KgHttpError) || e.status >= 500) throw e;
        const routeMissing = e.status === 404 && /^Route /.test(e.body?.message ?? '');
        return { release: id ?? null, build: row?.build ?? null, status: routeMissing ? 'unavailable' : (e.status === 404 ? 'not_found' : 'bad_request'),
          error: routeMissing ? 'the deployed KG API does not serve /releases/:id/changes yet; build-to-build diffs are unavailable on this server' : (e.body.error ?? e.body.message ?? null),
          hint: e.body.hint ?? null, current_build: row?.build ?? null, previous_build: row?.previous_build ?? null,
          ...(/^builds_available: /.test(e.body.hint ?? '') ? { builds_available: e.body.hint.slice(18).split(/,\s*/).filter(x => x && x !== 'none') } : {}),
          ...(routeMissing ? { advice: 'kg_release gives current totals; compare against the previous build\'s counts later when the API is updated' } : {}) };
      }
    },
  },
};

// every handler: arguments checked against its inputSchema first, result held under MCP_MAX_RESULT_BYTES last
for (const t of Object.values(KG_TOOL_REGISTRY)) {
  const run = t.handler; const { name } = t.definition;
  t.handler = async (args, site) => sizeGuard(name, await run(checkArgs(t.definition, args), site));
}

// sent after the site paragraph in initialize.instructions for sites with kgBase
export function kgInstructions(site) {
  return [
    `This site also has the Gramene knowledge graph (release ${site.kgRelease ?? 'current'}, API ${kgV1(site)}): the kg_* tools read typed nodes and`,
    'edges with per-edge provenance. Prefer them for "how is X linked to Y", provenance and citation questions, QTL/variant/LoF/sample/',
    'population/publication links; keep the Solr/Mongo tools for gene filtering and bulk gene sets. Typical walk: kg_resolve -> kg_node /',
    'kg_neighbors -> kg_edges (paging) -> kg_evidence; kg_path to explain a link; kg_schema for what exists. Resources: kg://skill (how to',
    'use the graph), kg://<release>/schema, kg://<release>/node/<curie>.', '', IDS, '', SCOPE, '', CITE,
  ].join('\n');
}
