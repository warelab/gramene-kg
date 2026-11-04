// GraphQL at /kg/graphql (mercurius). Every resolver calls the same core.mjs functions as REST, so the two
// surfaces cannot diverge; GraphQL only renames fields (camelCase) and adds Relay-style connections.
// The Node part is generated at startup: one object type per node class in the served releases' schema_stats
// (descriptions from the LinkML classes in schema/gramene_kg.yaml), all implementing the Node interface;
// a class added by a later build resolves as OtherNode until the API restarts.
// Limits (costRule below): <= 20 root fields, <= 50 aliases, one operation; depth <= 6 (introspection exempt);
// complexity <= 2000 counting each field's backend work; introspection <= 2 x the standard IntrospectionQuery;
// neighbors first <= 500.
import mercurius from 'mercurius';
import { GraphQLScalarType, GraphQLError, Kind, getNamedType, isLeafType, isAbstractType, valueFromASTUntyped, parse, getIntrospectionQuery } from 'graphql';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import * as core from './core.mjs';

export const MAX_DEPTH = 6, MAX_COMPLEXITY = 2000, MAX_IDS = 500, MAX_ROOT_FIELDS = 20, MAX_ALIASES = 50;
const DEF = { neighbors: 20, search: 20, region: 100 };
const HERE = path.dirname(new URL(import.meta.url).pathname);

// ---- JSON scalar ------------------------------------------------------------------------------
const lit = (ast, vars) => valueFromASTUntyped(ast, vars);
const JSONScalar = new GraphQLScalarType({ name: 'JSON', description: 'Any JSON value (attributes, degree, qualifiers, counts).',
  serialize: v => v, parseValue: v => v, parseLiteral: lit });

// ---- depth and complexity (costRule) -----------------------------------------------------------
// Every operation is checked, introspection included, with the values it will run with (supplied variables, else
// the declared variable defaults, else the schema's argument defaults):
//   - at most MAX_ROOT_FIELDS root fields and MAX_ALIASES aliased fields; one operation per request unless
//     operationName picks one;
//   - depth <= MAX_DEPTH, introspection subtrees exempt (the standard IntrospectionQuery is depth 15);
//   - complexity <= MAX_COMPLEXITY: a field costs its own backend work (WORK; 0 for most fields), plus, if it is an
//     object, 1 + its list size (mult) x the cost of its selection. Aliasing a root field therefore repeats its
//     backend work in the cost however small its selection, and leaf root fields (schema) are not free;
//   - introspection (__schema, __type) is costed by the size of what it returns (every field 1, list fields times
//     the schema's average list size) against INTROSPECTION_BUDGET = 2 x the standard IntrospectionQuery.
const mult = (name, args) => {
  if (name === 'neighbors') return args.first ?? DEF.neighbors;
  if (name === 'nodes' || name === 'resolve') return Array.isArray(args.ids) ? args.ids.length : 1;
  if (name === 'search') return args.first ?? DEF.search;
  if (name === 'region') return args.first ?? DEF.region;
  if (name === 'path') return 100;                        // <= 50 paths of <= 2 edges
  if (name === 'releases') return 10;
  return 1;
};
const nIds = (a) => Array.isArray(a.ids) ? a.ids.length : 1;
// backend work of a field itself, by 'Type.field' (neighbors: on every node type), in units of about one Mongo
// lookup: path scans up to 2 x PATH_CAP edges per end, region reads up to 2001 nodes, search is a Solr query plus
// an id resolution, resolve tries ~17 candidate ids per input, manifest builds ~275 KB, neighbors reads a page
const WORK = {
  'Query.node': () => 2, 'Query.edge': () => 2, 'Query.nodes': a => 5 + nIds(a), 'Query.resolve': a => 5 + Math.ceil(nIds(a) / 5),
  'Query.search': () => 20, 'Query.region': () => 50, 'Query.path': () => 600, 'Query.schema': () => 5,
  'Query.releases': () => 1, 'Query.release': () => 2, 'Release.manifest': () => 100, 'Release.changes': () => 10,
  'Release.db': () => 1, 'Release.solrCore': () => 1, 'Release.catalogue': () => 1,
  neighbors: a => 2 + Math.ceil((Number(a.first) || DEF.neighbors) / 10),
};
const workOf = (type, name, args) => (WORK[`${type.name}.${name}`] ?? (name === 'neighbors' ? WORK.neighbors : null))?.(args) ?? 0;

// introspection list sizes: per-type averages over the schema (types, directives: totals; args: per field), so
// the cost tracks the size of the response
function introspectionSizes(schema) {
  const types = Object.values(schema.getTypeMap());
  const per = (f) => types.reduce((a, t) => a + f(t), 0) / types.length;
  const isOut = (t) => typeof t.getInterfaces === 'function';            // object and interface types
  const fields = types.filter(isOut).flatMap(t => Object.values(t.getFields()));
  return { types: types.length, directives: schema.getDirectives().length,
    fields: per(t => isOut(t) ? Object.keys(t.getFields()).length : 0),
    inputFields: per(t => !isOut(t) && t.getFields ? Object.keys(t.getFields()).length : 0),
    enumValues: per(t => t.getValues ? t.getValues().length : 0),
    interfaces: per(t => isOut(t) ? t.getInterfaces().length : 0),
    possibleTypes: per(t => isAbstractType(t) ? schema.getPossibleTypes(t).length : 0),
    args: fields.reduce((a, f) => a + f.args.length, 0) / Math.max(1, fields.length) };
}

const sizes = new WeakMap();
// The analysis expands fragments at every spread, so a document that spreads fragments repeatedly (F0{...F1 ...F1}
// F1{...F2 ...F2} ...) is exponential to walk even though it is ~1 KB; every selection visited counts against
// MAX_VISITS and the analysis gives up (the operation is rejected) rather than block the event loop.
const MAX_VISITS = 20000;
class TooLarge extends Error {}
// cost, introspection cost, root fields, aliases and depth of one operation
function analyse(schema, doc, op, variables) {
  const frags = new Map(doc.definitions.filter(d => d.kind === Kind.FRAGMENT_DEFINITION).map(d => [d.name.value, d]));
  let visits = 0;
  const visit = (set) => { if ((visits += set?.selections?.length ?? 0) > MAX_VISITS) throw new TooLarge(); return set?.selections ?? []; };
  // null prototype: a variable named constructor/toString/__proto__ must not read Object.prototype and skip its default
  const vars = Object.assign(Object.create(null), variables);
  for (const v of op.variableDefinitions ?? []) if (vars[v.variable.name.value] == null && v.defaultValue) vars[v.variable.name.value] = lit(v.defaultValue, {});
  const argsOf = (s, fd) => {
    const a = Object.fromEntries((s.arguments ?? []).map(x => [x.name.value, lit(x.value, vars)]));
    for (const d of fd.args) if (a[d.name] == null && d.defaultValue !== undefined) a[d.name] = d.defaultValue;
    return a;
  };
  // the fields of a selection set, fragments expanded: [{ s, type, seen }] (seen = fragments entered on the way, so a
  // fragment cycle, which the spec rules reject, cannot loop here)
  const fieldsOf = (set, type, seen) => visit(set).flatMap(s =>
    s.kind === Kind.FIELD ? [{ s, type, seen }]
    : s.kind === Kind.INLINE_FRAGMENT ? fieldsOf(s.selectionSet, s.typeCondition ? schema.getType(s.typeCondition.name.value) : type, seen)
    : (f => f && !seen.has(f) ? fieldsOf(f.selectionSet, schema.getType(f.typeCondition.name.value), new Set([...seen, f])) : [])(frags.get(s.name.value)));
  if (!sizes.has(schema)) sizes.set(schema, introspectionSizes(schema));
  const isz = sizes.get(schema);
  let aliases = 0, introCost = 0;
  const intro = (set, seen0) => fieldsOf(set, null, seen0).reduce((c, { s, seen }) => {
    if (s.alias) aliases++;
    return c + 1 + (s.selectionSet ? (isz[s.name.value] ?? 1) * intro(s.selectionSet, seen) : 0);
  }, 0);
  const walk = (set, type, seen0) => {
    let c = 0;
    for (const { s, type: t, seen } of fieldsOf(set, type, seen0)) {
      if (s.alias) aliases++;
      const name = s.name.value;
      if (name === '__schema' || name === '__type') { introCost += 1 + intro(s.selectionSet, seen); continue; }
      const fd = t?.getFields?.()[name]; if (!fd) continue;
      const args = argsOf(s, fd); const ft = getNamedType(fd.type);
      c += workOf(t, name, args);
      if (!isLeafType(ft)) c += 1 + Math.max(1, Number(mult(name, args)) || 1) * walk(s.selectionSet, ft, seen);
    }
    return c;
  };
  const root = op.operation === 'query' ? schema.getQueryType() : op.operation === 'mutation' ? schema.getMutationType() : schema.getSubscriptionType();
  const rootFields = fieldsOf(op.selectionSet, root, new Set()).filter(({ s }) => s.name.value !== '__typename').length;
  const cost = walk(op.selectionSet, root, new Set());
  // depth = nested field levels (leaves count, fragments are transparent), as mercurius queryDepth counts it,
  // except that introspection subtrees (__schema, __type) are exempt so standard tooling can fetch the schema
  const depth = (set, seen) => Math.max(0, ...visit(set).map(s => s.kind === Kind.FIELD ? (s.name.value.startsWith('__') && s.name.value !== '__typename' ? 0 : 1 + depth(s.selectionSet, seen))
    : s.kind === Kind.INLINE_FRAGMENT ? depth(s.selectionSet, seen)
    : (f => f && !seen.has(f) ? depth(f.selectionSet, new Set([...seen, f])) : 0)(frags.get(s.name.value))));
  return { cost, introCost: Math.ceil(introCost), rootFields, aliases, depth: depth(op.selectionSet, new Set()) };
}

// 2 x the introspection cost of the standard IntrospectionQuery (every option on), once per schema
const STD_INTRO = parse(getIntrospectionQuery({ descriptions: true, specifiedByUrl: true, directiveIsRepeatable: true, schemaDescription: true, inputValueDeprecation: true, oneOf: true }));
const budgets = new WeakMap();
export const introspectionBudget = (schema) => {
  if (!budgets.has(schema)) budgets.set(schema, 2 * analyse(schema, STD_INTRO, STD_INTRO.definitions[0], {}).introCost);
  return budgets.get(schema);
};

// reports only the first limit exceeded: with a single error mercurius answers 400, with several 200
export function costRule({ variables = {}, operationName } = {}) {
  return (vctx) => {
    let failed = false;
    const report = (msg, node, ext) => { if (!failed) vctx.reportError(new GraphQLError(msg, { nodes: [node], extensions: ext })); failed = true; };
    return {
      Document(doc) {
        const n = doc.definitions.filter(d => d.kind === Kind.OPERATION_DEFINITION).length;
        if (n > 1 && !operationName) report(`${n} operations in one request: pass operationName to pick one`, doc, { code: 'MULTIPLE_OPERATIONS' });
      },
      OperationDefinition(op) {
        if (failed) return;
        const schema = vctx.getSchema();
        let a;
        try { a = analyse(schema, vctx.getDocument(), op, variables); } catch (e) {
          if (!(e instanceof TooLarge)) throw e;
          return report(`query expands to more than ${MAX_VISITS} selections (repeated fragment spreads?): simplify it`, op, { code: 'QUERY_TOO_LARGE', limit: MAX_VISITS });
        }
        const budget = introspectionBudget(schema);
        const fail = (msg, ext) => report(msg, op, ext);
        if (a.rootFields > MAX_ROOT_FIELDS) fail(`${a.rootFields} root fields exceed the limit of ${MAX_ROOT_FIELDS}: send fewer aliases per request`, { code: 'ROOT_FIELD_LIMIT', count: a.rootFields, limit: MAX_ROOT_FIELDS });
        if (a.aliases > MAX_ALIASES) fail(`${a.aliases} aliased fields exceed the limit of ${MAX_ALIASES}`, { code: 'ALIAS_LIMIT', count: a.aliases, limit: MAX_ALIASES });
        if (a.depth > MAX_DEPTH) fail(`query depth ${a.depth} exceeds the limit of ${MAX_DEPTH}`, { code: 'DEPTH_LIMIT', depth: a.depth, limit: MAX_DEPTH });
        if (a.cost > MAX_COMPLEXITY) fail(`query complexity ${a.cost} exceeds the limit of ${MAX_COMPLEXITY}: each root field costs its backend work and lists multiply their selection by first/ids (neighbors first default ${DEF.neighbors}); lower first, select fewer nested objects or send fewer aliases`, { code: 'COMPLEXITY_LIMIT', cost: a.cost, limit: MAX_COMPLEXITY });
        if (a.introCost > budget) fail(`introspection cost ${a.introCost} exceeds the limit of ${budget} (twice the standard IntrospectionQuery); do not alias introspection fields`, { code: 'INTROSPECTION_LIMIT', cost: a.introCost, limit: budget });
      },
    };
  };
}

// ---- SDL ----------------------------------------------------------------------------------------
const NODE_FIELDS = `
  id: ID!
  "Biolink categories"
  category: [String!]!
  "internal class (= GraphQL __typename unless OtherNode)"
  class: String!
  name: String
  description: String
  aliases: [String!]!
  xrefs: [String!]!
  inTaxon: String
  genome: String
  geneTree: String
  location: JSON
  attributes: JSON
  "edge counts keyed '<predicate>|<out|in>'"
  degree: JSON
  card: String
  provenance: NodeProvenance!
  "edges of this node: same paging, filters and phases as REST /node/{curie}/edges"
  neighbors(predicate: String, direction: Direction = BOTH, category: String, source: String, includeNegated: Boolean = false, first: Int = ${DEF.neighbors}, after: String): EdgeConnection!`;
const RESERVED = new Set(['Query', 'Node', 'OtherNode', 'NodeProvenance', 'Edge', 'EdgeItem', 'EdgeConnection', 'EdgeProvenance', 'PageInfo', 'Direction',
  'JSON', 'Release', 'ResolveResult', 'Match', 'Ambiguous', 'SearchResult', 'SearchHit', 'RegionResult', 'Feature', 'Path', 'String', 'Int', 'Float', 'Boolean', 'ID']);
const gqlDesc = (s) => `"""${String(s).replace(/"""/g, '\\"""')}"""`;

function buildSdl(classes) {
  let ld = {}; try { ld = yaml.load(fs.readFileSync(path.resolve(HERE, '../../schema/gramene_kg.yaml'), 'utf8')).classes ?? {}; } catch {}
  const types = classes.map(({ class: c, category, id_prefixes }) => {
    const l = ld[c]; const d = [l?.description, `Biolink category ${category}${l?.is_a ? `; LinkML is_a ${l.is_a}` : ''}; id prefixes ${(id_prefixes ?? []).join(', ') || '-'}.`].filter(Boolean).join(' ');
    return `${gqlDesc(d)}\ntype ${c} implements Node {${NODE_FIELDS}\n}`;
  });
  return `
scalar JSON
enum Direction { IN OUT BOTH }
"A graph node. Concrete types are generated from the release schema (one per class); OtherNode covers classes added after startup."
interface Node {${NODE_FIELDS}
}
${types.join('\n')}
"A node whose class was not in the schema when the API started."
type OtherNode implements Node {${NODE_FIELDS}
}
type NodeProvenance { release: String ingestRun: String }
type EdgeProvenance {
  primaryKnowledgeSource: String
  aggregatorKnowledgeSource: [String!]!
  knowledgeLevel: String
  agentType: String
  hasEvidence: [String!]!
  originalEvidence: String
  publications: [String!]!
  hasSupportingStudies: [String!]!
  method: String
  originalSubject: String
  originalObject: String
  sourceRecord: String
  knowledgeSourceVersion: String
  negated: Boolean!
  layer: String
  release: String
  ingestRun: String
}
type Edge {
  "gramene.assoc:<id>; null for slot edges (gene->genome, gene->tree), which are node fields"
  id: ID
  subject: String!
  predicate: String!
  object: String!
  "OUT/IN relative to the node whose neighbors were asked for; null elsewhere"
  direction: Direction
  negated: Boolean!
  slot: Boolean!
  qualifiers: JSON
  provenance: EdgeProvenance!
  "the far end (direction OUT: object, IN: subject); batched"
  other: Node
  subjectNode: Node
  objectNode: Node
}
type EdgeItem { cursor: String! node: Edge! }
type PageInfo { hasNextPage: Boolean! endCursor: String }
type EdgeConnection { edges: [EdgeItem!]! pageInfo: PageInfo! degree: JSON warnings: [String!]! }
type Match { input: String! id: ID! class: String name: String genome: String match: String! node: Node }
type Ambiguous { input: String! candidates: [Match!]! }
type ResolveResult { resolved: [Match!]! ambiguous: [Ambiguous!]! unknown: [String!]! warnings: [String!]! }
type SearchHit { id: ID! name: String class: String category: [String!] genome: String sources: [String!]! degree: Int geneFq: String card: String score: Float node: Node }
type SearchResult { total: Int! hits: [SearchHit!]! facets: JSON "exact id/alias matches from all genomes" resolved: [Match!]! geneFqCore: String warnings: [String!]! }
type Feature { id: ID! category: [String!] class: String name: String location: JSON node: Node }
type RegionResult { total: Int! features: [Feature!]! warnings: [String!]! }
type Path { edges: [Edge!]! }
type Release {
  id: ID!
  site: String
  build: String
  previousBuild: String
  previousRelease: String
  isCurrent: Boolean!
  promotedAt: String
  counts: JSON
  db: String
  solrCore: String
  catalogue: JSON
  "datasets, distributions, analyses, software (REST /releases/{id}/manifest)"
  manifest: JSON
  "node/edge count deltas between two builds (REST /releases/{id}/changes)"
  changes(from: String, to: String): JSON
}
type Query {
  "an exact id, else a bare id or alias as REST /node/{curie} resolves it (genome narrows the candidates; ambiguity is an error with candidates)"
  node(id: String!, genome: String, release: String): Node
  "exact ids, bare ids or aliases, in order (max ${MAX_IDS}); null where nothing matches, and null plus an error at [field, i] where an input is ambiguous"
  nodes(ids: [String!]!, genome: String, release: String): [Node]!
  resolve(ids: [String!]!, genome: String, category: String, release: String): ResolveResult!
  search(q: String, category: String, genome: String, source: String, taxon: String, systemName: String, first: Int = ${DEF.search}, offset: Int = 0, release: String): SearchResult!
  "features overlapping genome:region:start-end (<= 5 Mb); first <= 2000"
  region(genome: String!, region: String!, start: Int!, end: Int!, category: String, first: Int = ${DEF.region}, release: String): RegionResult!
  "paths of up to maxHops (<= 2) edges, negated edges excluded"
  path(from: String!, to: String!, maxHops: Int = 2, release: String): [Path!]!
  edge(id: String!, release: String): Edge
  releases: [Release!]!
  release(id: String): Release
  "release schema statistics; with category, one class (or the classes of a Biolink category) with its in/out relations"
  schema(category: String, release: String): JSON
}`;
}

// ---- shaping ------------------------------------------------------------------------------------
const toNode = (o, rel) => o && ({ ...o, inTaxon: o.in_taxon, geneTree: o.gene_tree, provenance: o.provenance && { release: o.provenance.release, ingestRun: o.provenance.ingest_run ?? null }, _rel: rel });
const DIR = { out: 'OUT', in: 'IN' };
const toEdge = (e, rel) => {
  const p = e.provenance;
  return { id: e.id, subject: e.subject, predicate: e.predicate, object: e.object, direction: DIR[e.direction] ?? null, negated: p.negated, slot: !!e.slot,
    qualifiers: e.qualifiers, _rel: rel,
    provenance: { primaryKnowledgeSource: p.primary_knowledge_source, aggregatorKnowledgeSource: p.aggregator_knowledge_source, knowledgeLevel: p.knowledge_level,
      agentType: p.agent_type, hasEvidence: p.has_evidence, originalEvidence: p.original_evidence, publications: p.publications, hasSupportingStudies: p.has_supporting_studies,
      method: p.method, originalSubject: p.original_subject, originalObject: p.original_object, sourceRecord: p.source_record,
      knowledgeSourceVersion: p.knowledge_source_version, negated: p.negated, layer: p.layer, release: p.release, ingestRun: p.ingest_run } };
};
const toMatch = (m, rel) => ({ ...m, _rel: rel, _id: m.id });
const toRelease = (r) => r && ({ id: r.id, site: r.site ?? null, build: r.build, previousBuild: r.previous_build ?? null, previousRelease: r.previous_release ?? null,
  isCurrent: !!r.is_current, promotedAt: r.promoted_at ? new Date(r.promoted_at).toISOString() : null, counts: r.counts ?? null });

// core errors -> GraphQL errors carrying the REST status, hint and candidates
const gqlErr = (e) => e.statusCode && e.statusCode < 500
  ? new mercurius.ErrorWithProps(e.message, { status: e.statusCode, hint: e.hint ?? null, ...(e.candidates ? { candidates: e.candidates } : {}) })
  : e;
// run a core call, record its release/build and warnings for the response extensions
async function call(ctx, fn) {
  let r; try { r = await fn(); } catch (e) { throw gqlErr(e); }
  const k = ctx.kg; k.served.add(`${r.ctx.rel._id}@${r.ctx.rel.current_build}`);
  for (const w of r.extra?.warnings ?? []) k.warnings.add(w);
  return r;
}
const relOf = (r) => r.ctx.rel._id;

// batched node lookups: queries [{obj, params}] -> nodes, grouped per release; key picks the id from obj
const batch = (key) => async (queries, ctx) => {
  const by = new Map();
  queries.forEach(({ obj }, i) => { const k = obj._rel ?? ''; if (!by.has(k)) by.set(k, []); by.get(k).push(i); });
  const res = new Array(queries.length).fill(null);
  for (const [rel, idx] of by) {
    const ids = idx.map(i => key(queries[i].obj)).map(x => x ?? '');
    const { ctx: c, rows } = await core.nodesByIds(rel || undefined, ids).catch(e => { throw gqlErr(e); });
    idx.forEach((i, j) => { res[i] = toNode(rows[j], c.rel._id); });
  }
  return res;
};

function neighborsResolver(parent, a, ctx) {
  if (a.first != null && (a.first < 1 || a.first > core.MAX_LIMIT)) throw new mercurius.ErrorWithProps(`first must be between 1 and ${core.MAX_LIMIT}`, { status: 400 });
  return call(ctx, () => core.nodeEdges(parent.id, { release: parent._rel, resolve: '0', predicate: a.predicate ?? undefined, direction: a.direction ? a.direction.toLowerCase() : undefined,
    category: a.category ?? undefined, source: a.source ?? undefined, include_negated: a.includeNegated ? '1' : undefined, limit: a.first ?? DEF.neighbors, cursor: a.after ?? undefined }))
    .then(r => {
      const rel = relOf(r);
      const edges = r.data.map((e, i) => ({ cursor: r.cursors[i], node: toEdge(e, rel) }));
      return { edges, pageInfo: { hasNextPage: !!r.extra.next, endCursor: r.extra.next ?? edges.at(-1)?.cursor ?? null }, degree: r.extra.degree, warnings: r.extra.warnings };
    });
}

export async function registerGraphql(app) {
  // per-class types from every release's schema_stats (first occurrence wins)
  const seen = new Map();
  for (const r of await core.releases()) {
    const m = await core.resolveRelease(r._id).catch(() => null);
    for (const c of m?.manifest?.schema_stats?.classes ?? []) if (/^[A-Z][A-Za-z0-9_]*$/.test(c.class) && !RESERVED.has(c.class) && !seen.has(c.class)) seen.set(c.class, c);
  }
  const classes = [...seen.values()];
  const typeNames = new Set(classes.map(c => c.class));
  const nodeType = { neighbors: neighborsResolver };
  const resolvers = {
    JSON: JSONScalar,
    Node: { resolveType: (o) => typeNames.has(o.class) ? o.class : 'OtherNode' },
    Query: {
      node: (_, a, ctx) => call(ctx, () => core.node(a.id, { release: a.release, genome: a.genome ?? undefined })).then(r => toNode(r.data, relOf(r))),
      nodes: async (_, a, ctx) => {
        if (a.ids.length > MAX_IDS) throw new mercurius.ErrorWithProps(`at most ${MAX_IDS} ids`, { status: 400 });
        const { ctx: c, rows } = await call(ctx, async () => { const x = await core.nodesByIds(a.release, a.ids); return { ...x, data: null, extra: {} }; });
        // exact misses fall back to the REST resolution: null when unknown; an ambiguous input is returned as its error,
        // which graphql-js turns into null at [field, i] plus an error with the candidates, so the other items survive
        return Promise.all(rows.map((n, i) => n ? toNode(n, c.rel._id)
          : call(ctx, () => core.node(a.ids[i], { release: a.release, genome: a.genome ?? undefined })).then(r => toNode(r.data, relOf(r)), e => e.extensions?.status === 404 ? null : e)));
      },
      resolve: (_, a, ctx) => call(ctx, () => core.resolve({ release: a.release, ids: a.ids, genome: a.genome, category: a.category })).then(r => {
        const rel = relOf(r);
        return { resolved: r.data.resolved.map(m => toMatch(m, rel)), ambiguous: r.data.ambiguous.map(x => ({ input: x.input, candidates: x.candidates.map(m => toMatch(m, rel)) })),
          unknown: r.data.unknown, warnings: r.extra.warnings ?? [] };
      }),
      search: (_, a, ctx) => call(ctx, () => core.search({ release: a.release, q: a.q, category: a.category, genome: a.genome, source: a.source, taxon: a.taxon,
        system_name: a.systemName, rows: a.first, start: a.offset })).then(r => {
        const rel = relOf(r);
        return { total: r.extra.total, hits: r.data.map(d => ({ ...d, geneFq: d.gene_fq, _rel: rel })), facets: r.extra.facets,
          resolved: r.extra.resolved.map(m => toMatch({ input: a.q, ...m }, rel)), geneFqCore: r.extra.gene_fq_core, warnings: r.extra.warnings };
      }),
      region: (_, a, ctx) => {
        if (a.first < 1 || a.first > 2000) throw new mercurius.ErrorWithProps('first must be between 1 and 2000', { status: 400 });
        return call(ctx, () => core.region({ release: a.release, genome: a.genome, region: a.region, start: a.start, end: a.end, category: a.category })).then(r => ({
          total: r.extra.total, features: r.data.slice(0, a.first).map(f => ({ ...f, _rel: relOf(r) })),
          warnings: [...r.extra.warnings, ...(r.data.length > a.first ? [`first ${a.first} of ${r.data.length} features returned`] : [])] }));
      },
      path: (_, a, ctx) => call(ctx, () => core.findPath({ release: a.release, from: a.from, to: a.to, max_hops: a.maxHops })).then(r => r.data.map(p => ({ edges: p.map(e => toEdge(e, relOf(r))) }))),
      edge: (_, a, ctx) => call(ctx, () => core.edge(a.id, { release: a.release })).then(r => toEdge(r.data, relOf(r))),
      releases: async () => (await core.releaseList()).map(r => ({ ...toRelease(r), _id: r.id })),
      release: async (_, a, ctx) => {
        const r = await call(ctx, () => core.releaseInfo(a.id));
        const row = (await core.releaseList()).find(x => x.id === r.data.id);
        return { ...toRelease(row), db: r.data.db, solrCore: r.data.solr_core, counts: r.data.counts ?? row?.counts ?? null, catalogue: r.data.catalogue ?? null, _id: r.data.id };
      },
      schema: (_, a, ctx) => call(ctx, () => a.category ? core.schemaCategory(a.category, a.release) : core.schema(a.release)).then(r => r.data),
    },
    Release: {
      manifest: (p, _, ctx) => call(ctx, () => core.releaseManifest(p.id)).then(r => r.data),
      changes: (p, a, ctx) => call(ctx, () => core.releaseChanges(p.id, { from: a.from ?? undefined, to: a.to ?? undefined })).then(r => r.data),
      db: async (p, _, ctx) => p.db !== undefined ? p.db : (await call(ctx, () => core.releaseInfo(p.id))).data.db,
      solrCore: async (p, _, ctx) => p.solrCore !== undefined ? p.solrCore : (await call(ctx, () => core.releaseInfo(p.id))).data.solr_core,
      catalogue: async (p, _, ctx) => p.catalogue !== undefined ? p.catalogue : (await call(ctx, () => core.releaseInfo(p.id))).data.catalogue ?? null,
    },
  };
  for (const t of [...typeNames, 'OtherNode']) resolvers[t] = nodeType;
  const loaders = {
    Edge: {
      other: batch(e => e.direction === 'OUT' ? e.object : e.direction === 'IN' ? e.subject : null),
      subjectNode: batch(e => e.subject), objectNode: batch(e => e.object),
    },
    Match: { node: batch(m => m._id) }, SearchHit: { node: batch(h => h.id) }, Feature: { node: batch(f => f.id) },
  };
  await app.register(mercurius, {
    schema: buildSdl(classes), resolvers, loaders, path: '/kg/graphql', graphiql: false, jit: 0,
    cache: false,                        // validationRules as a function needs cache off; depth is checked there (not queryDepth, which counts introspection)
    validationRules: ({ variables, operationName }) => [costRule({ variables: variables ?? {}, operationName })],
    context: () => ({ kg: { warnings: new Set(), served: new Set() } }),
  });
  app.graphql.addHook('onResolution', async (execution, ctx) => {
    const served = [...ctx.kg.served];
    if (served.length === 1) { const [rel, build] = served[0].split('@'); ctx.reply.header('X-KG-Release', rel).header('X-KG-Build', build); }
    execution.extensions = { ...(execution.extensions ?? {}), served: served.map(s => { const [release, build] = s.split('@'); return { release, build }; }), warnings: [...ctx.kg.warnings] };
  });
  return { classes: classes.length };
}
