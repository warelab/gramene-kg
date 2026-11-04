# gramene-kg API

`apps/api/server.mjs` (Fastify 5, pm2 `gramene-kg-api`, `:12000`). Read-only. The only Mongo dbs it touches
are `kg_meta` and the promoted `kg_<release>_b<build>`, plus the release's Solr core and the build's Parquet
and `counts.json` under `KG_BUILDS_DIR` (default `/scratch/olson/gramene-kg/builds`).

| file | role |
|---|---|
| `apps/api/core.mjs` | all query logic: release resolution, nodes, edge paging, resolve, search, region, path, derived, changes |
| `apps/api/server.mjs` | REST routes: maps HTTP onto `core.mjs` and wraps results in the envelope |
| `apps/api/graphql.mjs` | GraphQL schema, resolvers, loaders, depth/complexity rule; resolvers call `core.mjs` |
| `apps/api/jsonld.mjs` | JSON-LD rendering of a node |
| `apps/api/derived.mjs` | DuckDB lookups over the derived Parquet buckets |

REST and GraphQL share the same functions, so their results cannot diverge. GraphQL only renames fields
to camelCase and adds connections.

Environment: `KG_PORT`, `KG_HOST`, `KG_SITE` (picks the current release), `MONGO_URL`, `SOLR_URL`,
`KG_BUILDS_DIR`, `KG_PUBLIC_URL` (the public base of `/kg`, used for the JSON-LD `@context` URL; default
`http://127.0.0.1:12000/kg`), `LOG_LEVEL`. The context URL is never built from the request's `Host` header, which
the client controls and which, behind the planned gorgonzola proxy, would name the internal host. `KG_PUBLIC_URL`
is deliberately not set in `ecosystem.config.cjs` yet: set it to `https://data.sorghumbase.org/kg` once the
`/kg` proxy is live.

## REST `/kg/v1`

Every route except `/health` and `/releases` returns `{release, build, data, meta}`, where `meta.warnings`
is always an array, and sets `X-KG-Release` and `X-KG-Build`. Every route takes `release=` (default: the
current release of `KG_SITE`), except the `/releases/{id}…` routes, which take the release from the path and
ignore `release=`, and `/health`, `/releases` and `/context.jsonld`. An error returns `{error, hint, candidates?, docs}` with status 400, 404,
409 (ambiguous alias), 502 (Solr) or 503. A CURIE in a path segment is percent-encoded, for example
`doi:10.1101%2Fgr.227462.117`.

| route | notes |
|---|---|
| `GET /health` | `{ok, releases}` |
| `GET /releases` | array of releases with builds, counts and manifest link |
| `GET /releases/{id}` | db, Solr core, counts, catalogue |
| `GET /releases/{id}/manifest` | Dataset, Distribution, AnalysisRun and SoftwareAgent nodes |
| `GET /releases/{id}/changes?from=&to=` | **new in M2**: node and edge count deltas between two builds (below) |
| `GET /schema[/{category}]` | schema_stats; a category is a class (`GeneModel`) or a Biolink category (`GeneFamily`, `biolink:Gene`) |
| `GET /node/{curie}` | node card. An exact id wins; otherwise the node is looked up the way `/resolve` does it (below), with `genome=` to narrow; `resolve=0` turns the fallback off. With `Accept: application/ld+json` the response is JSON-LD (below) |
| `GET /node/{curie}/edges` | the node is found as for `/node/{curie}` (`genome=` too). `predicate=` (comma list; a bare name takes the prefix of the release predicate with that local name, e.g. `carries_predicted_lof_allele_of` → `gramene:carries_predicted_lof_allele_of`; a name the release does not use adds a `meta.warnings` entry listing the valid predicates), `direction=out\|in\|both`, `category=` (class or category of the far end), `source=` (infores), `include_negated=1`, `limit` ≤ 500 (default 100), `cursor=` from `meta.next`. `meta.degree` gives counts per `predicate\|direction` |
| `GET /edge/{id}` | `gramene.assoc:<id>` or the bare id, with `subject_node` and `object_node` |
| `GET\|POST /resolve` | `ids=` (comma or space separated, or a JSON array in POST, ≤ 5000), `genome=`, `category=` → `{resolved, ambiguous, unknown}` |
| `GET /search` | `q`, `category`, `genome`, `source`, `taxon`, `system_name`, `rows` ≤ 200, `start`; facets in `meta.facets`; `meta.resolved` adds exact id or alias hits from every genome |
| `GET /region` | `genome`, `region`, `start`, `end` (≤ 5 Mb), `category`; at most 2000 features. A genome that is not a `GenomeAssembly` node (e.g. `gramene.genome:GCA_…`) returns 404; an empty result on a region name the genome does not have (`chr1` for `1`) carries a warning |
| `GET /path` | `from`, `to` (each found as for `/node/{curie}`, `genome=` applies to both), `max_hops` ≤ 2; at most 50 paths, negated edges excluded |
| `GET /derived/homologs/{gene}` | `kind`, `limit` ≤ 1000, `offset` (Parquet, not graph edges). The gene is found as for `/node/{curie}` with the candidates restricted to genes, and `genome=`; a bare id under `gramene.gene:` adds no warning |
| `GET /derived/expression/{gene}` | `experiment`; the gene as for homologs |
| `GET /context.jsonld` | **new in M2**: the LinkML-generated JSON-LD context (`schema/generated/jsonld/context.jsonld`) |

The browse UI is served at `/kg/ui/`.

### Node lookup

`/node/{curie}`, `/node/{curie}/edges`, `/path` (`from`, `to`), `/derived/*` and GraphQL `node`/`nodes` find a
node the same way, so they agree with `/resolve`:

1. the exact id (a DOI is lower-cased);
2. otherwise the candidates are pooled: the bare id under the prefixes `/resolve` tries (`gramene.gene`,
   `gramene.qtl`, `gramene.sample`, `gramene.genetree`, `gramene.population`, `gramene.germplasm`, `gxa.expt`,
   `gramene.expt`, `gramene.assay`, `gramene.contrast`, `gramene.collection`, `interpro`, `reactome`, `dbsnp`,
   `PMID`, `gramene.tffamily`, `insdc.gca`; all from `config/prefixes.yaml`) and every node with the input as an
   alias. `genome=` keeps the candidates in that genome (plus the ones without a genome);
3. one candidate → that node, with a warning saying how it was found (`resolved as the bare id of …` or
   `resolved by alias to …`); several → 409 with `candidates: [{id, class, genome, match}]` (`match` is `id` or
   `alias`); none → 404.

So `SORBI_3001G018000`, `QPGYR5.1`, `E-MTAB-5956` and `rs162690701` work bare, and `Sobic.007G158500` (the
T2T-CAS gene id and an alias of the BTx623 gene `SORBI_3007G158500`) is a 409 until `genome=` picks one.

### Edge paging

Edges are paged in four phases, in this order: `out` (stored edges with subject = node), `slot_out`
(gene → genome and gene → tree, which are stored as node fields), `in`, and `slot_in` (the genes of a tree
or genome). Within a phase, edges are sorted by `_id`. The cursor is base64url JSON `{ph, id}`.
`/node/<genome>/edges` does not list the genome's 4.3M variants. It returns a warning that points to
`/region?category=SequenceVariant`.

### `GET /releases/{id}/changes`

```
data = { from, to, builds_available: [..],
         nodes: { <class>:  {from, to, delta}, ... },
         edges: { <family>: {from, to, delta}, ... },
         totals: { nodes: {from, to, delta}, edges: {from, to, delta} } }
meta.source = the two counts.json paths
```

The data comes from `<KG_BUILDS_DIR>/<release>/<build>/counts.json`. `builds_available` lists the
12-digit build directories that have a `counts.json`. `to` defaults to the current build. `from` defaults
to the release's `previous_build` when `to` is the current build; otherwise it defaults to the build before
`to` on disk. A class or family missing from one build counts as 0 there. `totals` use `nodes_total` and
`edges_total`, which include slot edges. An unknown build, or no earlier build, returns 404 with
`hint: builds_available: …`.

```
curl -s 'localhost:12000/kg/v1/releases/sorghum11/changes' | bin/kgq 'j.data.totals'
# {"nodes":{"from":9982857,"to":9982861,"delta":4},"edges":{"from":31464242,"to":31464242,"delta":0}}
```

### JSON-LD (`Accept: application/ld+json` on `/node/{curie}`)

Without that Accept header the response is the default JSON shown above, unchanged.

- `@context` is the absolute URL of `/kg/v1/context.jsonld`, followed by a small inline context. The inline
  context defines only the prefixes that the generated context leaves as `http://example.org/UNKNOWN/…` or
  omits: the local `gramene.*` prefixes other than `gramene.gene` and `gramene.qtl`. Their IRIs come from
  `config/prefixes.yaml`, where a local prefix maps to the node page
  `https://data.sorghumbase.org/kg/ui/node/<prefix>%3A<id>`. Once the LinkML schema declares these
  prefixes, the inline context is computed empty and disappears.
- `id` (which maps to `@id`) is the CURIE. `@type` is the Biolink categories plus the class, resolved
  against the vocab, e.g. `https://w3id.org/gramene/kg/GeneModel`. `attributes` are flattened to top-level
  keys: a key that is a LinkML slot takes the slot's IRI (`used` → `prov:used`, `version` → `biolink:version`),
  any other key falls under the context's `@vocab`. A key the context would read as something else (a term for
  `rdf:type`, a prefix or keyword alias, a key containing `:`) is written as its absolute `@vocab` IRI instead;
  today that is only InterPro's `type` (`https://w3id.org/gramene/kg/type`), which would otherwise give a
  literal `rdf:type`. Location becomes `region`, `start`, `end` and `strand`. `ingest_run` maps to
  `prov:wasGeneratedBy`; `release` expands to the vocab term `https://w3id.org/gramene/kg/release`. Degree is
  left out.
- The generated context still maps `COB` to `http://example.org/UNKNOWN/COB/` and the inline context does not
  override it (`COB` is not in `config/prefixes.yaml`). No node uses it.
- Lookup warnings are returned in the `X-KG-Warnings` header as a JSON array, with every non-ASCII character
  `\u`-escaped (header values must be Latin-1). The response also sends `Vary: Accept`.
- Checked with jsonld.js 9.0.0 (`expand` in safe mode, then `toRDF`) on 12 nodes of 11 classes. Every
  `@id`, `@type` and property expands to an absolute IRI, no key is dropped, and nothing expands to
  `example.org/UNKNOWN`. `in_taxon` expands to a node reference
  (`http://purl.obolibrary.org/obo/NCBITaxon_4558`). Because the generated context types them
  `xsd:anyURI`, `genome`, `gene_tree`, `release` and `ingest_run` expand as literals holding a CURIE, not
  as node references. Fixing that is a schema change (`range` on those slots).

## GraphQL `/kg/graphql`

The endpoint is mercurius 16.12.0 with graphql 16.14.2. Both were installed with
`npm install --before=2026-10-21`, so every package in the tree is at least two weeks old. It accepts POST
(JSON) and GET (`?query=`). GraphiQL is off.

Each response has `extensions.served` (`[{release, build}]`) and `extensions.warnings`, which collects the
REST `meta.warnings` of every call made. `X-KG-Release` and `X-KG-Build` are set when exactly one release
was served. A core error becomes a GraphQL error with `extensions.status` (the REST status), `hint`, and
`candidates` for a 409.

### Schema summary

```graphql
scalar JSON
enum Direction { IN OUT BOTH }
interface Node {
  id category class name description aliases xrefs inTaxon genome geneTree location: JSON
  attributes: JSON degree: JSON card provenance: NodeProvenance { release ingestRun }
  neighbors(predicate, direction = BOTH, category, source, includeNegated = false, first = 20, after): EdgeConnection!
}
type GeneModel implements Node { … }  # one type per class, generated at startup
type OtherNode implements Node { … }  # a class first seen after startup
type EdgeConnection { edges: [EdgeItem { cursor node: Edge }] pageInfo { hasNextPage endCursor } degree: JSON warnings }
type Edge { id subject predicate object direction negated slot qualifiers: JSON
  provenance { primaryKnowledgeSource aggregatorKnowledgeSource knowledgeLevel agentType hasEvidence originalEvidence
               publications hasSupportingStudies method originalSubject originalObject sourceRecord
               knowledgeSourceVersion negated layer release ingestRun }
  other: Node subjectNode: Node objectNode: Node }          # batched loaders
type Query {
  node(id, genome, release): Node                            # found as REST /node/{curie} finds it
  nodes(ids ≤ 500, genome, release): [Node]                  # exact ids batched; misses as node(); an ambiguous id is null + an error at [field, i]
  resolve(ids, genome, category, release): ResolveResult     # {resolved, ambiguous{input candidates}, unknown, warnings}; Match.node
  search(q, category, genome, source, taxon, systemName, first = 20, offset = 0, release): SearchResult  # {total hits facets resolved geneFqCore warnings}
  region(genome, region, start, end, category, first = 100 (≤ 2000), release): RegionResult              # {total features warnings}
  path(from, to, maxHops = 2, release): [Path { edges }]
  edge(id, release): Edge
  releases: [Release]   release(id): Release   # Release { id site build previousBuild … db solrCore catalogue manifest changes(from, to) }
  schema(category, release): JSON
}
```

The node part is generated at startup. There is one object type per class in every served release's
`schema_stats`, and each implements `Node`. Its description comes from the class in
`schema/gramene_kg.yaml`: the description, Biolink category, `is_a` and id prefixes. As a result,
`__typename` is the class, and `... on GeneModel` works. All node types have the same fields. Class-specific
slots stay in `attributes: JSON`, because the Mongo `attrs` keys are not one-to-one with LinkML slots, and
typing them would let the schema and the data drift apart. A class added by a later build resolves as
`OtherNode` until the API restarts.

`neighbors` calls the same function as `/node/{curie}/edges`, so the phases, filters and order are the same.
`edges[i].cursor` resumes right after edge `i`. `pageInfo.endCursor` is the REST `meta.next` when there is a
next page. GraphQL rejects `first` outside 1–500, where REST clamps it.

`Edge.other`, `subjectNode`, `objectNode`, `Match.node`, `SearchHit.node` and `Feature.node` are mercurius
loaders. They make one `$in` lookup per release per request level, so there is no N+1. Measured: a
neighbors page with `other` and `subjectNode` costs 8–9 Mongo calls whether it returns 5 or 161 edges.

### Limits

All limits are checked before execution by one validation rule (`costRule` in `graphql.mjs`), on every
operation, introspection included, with the values the operation will run with: the supplied variables, else
the variables' declared defaults, else the schema's argument defaults. Only the first limit exceeded is reported,
as HTTP 400 with `extensions.code`.

- **One operation per request**, unless `operationName` picks one (`MULTIPLE_OPERATIONS`).
- **≤ 20 root fields** (aliases included; `ROOT_FIELD_LIMIT`) and **≤ 50 aliased fields** anywhere in the
  operation (`ALIAS_LIMIT`).
- **Depth ≤ 6.** Depth counts nested field levels, including leaves, the same way mercurius `queryDepth`
  counts them. `__schema` and `__type` subtrees are exempt from depth (the standard `IntrospectionQuery` is
  depth 15) but not from the introspection budget below. An over-depth query gives
  `query depth N exceeds the limit of 6`, `DEPTH_LIMIT`.
- **Complexity ≤ 2000** (`COMPLEXITY_LIMIT`). A field costs its own backend work, plus, if it returns an
  object, 1 + its list size × the cost of its selection. The list sizes: `neighbors` `first` (default 20),
  `nodes` and `resolve` the number of ids, `search` `first` (20), `region` `first` (100), `path` 100,
  `releases` 10. The backend work, independent of the selection, so aliasing a root field repeats it:

  | field | work |
  |---|---|
  | `node`, `edge` | 2 |
  | `nodes` | 5 + ids |
  | `resolve` | 5 + ids / 5 (≤ 1 call of 5000 ids per request) |
  | `search` | 20 |
  | `region` | 50 |
  | `path` | 600 (≤ 2 per request) |
  | `schema` | 5 |
  | `releases`, `Release.db`, `solrCore`, `catalogue` | 1 |
  | `release` | 2 |
  | `Release.manifest` | 100 (`releases{manifest}` = 1002: one per request) |
  | `Release.changes` | 10 |
  | `neighbors` | 2 + first / 10 |

- **Introspection ≤ 2 × the standard `IntrospectionQuery`** (`INTROSPECTION_LIMIT`). `__schema`/`__type`
  are costed by the size of what they return: every field 1, and a list field (`types`, `fields`, `args`,
  `inputFields`, `enumValues`, `interfaces`, `possibleTypes`, `directives`) times the schema's average
  list size. The budget is computed at startup from `getIntrospectionQuery()` with every option on (about
  70k for the sorghum11 schema), so the standard query and GraphQL tooling pass, while aliased
  `types`/`fields` stop at about 1 MB of response (before: about 2 GB from one 2 MB request).
- The rule is passed as a mercurius `validationRules` function, so mercurius' query cache is off
  (`cache: false`).

Checked on the dev server (M2 fix round): four aliases of `neighbors(first:$f)` cost 6215 whether `first` is a
literal, a supplied variable or a variable default (default-only used to pass at an assumed 20);
`nodes($ids = [500 ids]){neighbors(first:500)}` costs 27006; 2001 aliases of `resolve`, `nodes`, `path`,
`releases{manifest}`, 500 of `schema`, 50 of `search` and 200 of `__schema` all stop at the root-field
limit; 3 aliased `path`s cost 2103 (19 used to pass); aliased introspection with k = 10 or 40 stops at the
alias limit and deeper unaliased introspection at the introspection budget. The plan acceptance query, the
examples below and the standard `IntrospectionQuery` (default and all options) pass.

### Examples

```graphql
# plan M2 acceptance: 5 edges citing infores:sorghum-qtl-atlas
{ node(id:"gramene.qtl:QPGYR5.1"){ neighbors(predicate:"biolink:overlaps", direction:IN, first:5){
    edges{ node{ subject provenance{ primaryKnowledgeSource } } } } } }

# paging
query($a:String){ node(id:"gramene.gene:SORBI_3001G018000"){ __typename
  neighbors(first:50, after:$a, includeNegated:true){ edges{ cursor node{ predicate object other{ __typename name } } }
    pageInfo{ hasNextPage endCursor } } } }

{ resolve(ids:["Sobic.007G158500"], genome:"GCA_000003195.3"){ resolved{ id node{ name } } } }
{ release(id:"sorghum11"){ build previousBuild changes } }
```

```
curl -s localhost:12000/kg/graphql -H 'content-type: application/json' \
  -d '{"query":"{ node(id:\"gramene.qtl:QPGYR5.1\"){ __typename name } }"}'
```

## Verifying a change

1. Capture about 60 REST URLs from the running API before the change, and the same URLs from a dev server
   (`KG_PORT=12001 node apps/api/server.mjs` with the `ecosystem.config.cjs` env). Compare status,
   content-type, `X-KG-*` headers and body byte for byte.
2. Run `KG_API_URL=http://127.0.0.1:12001 node --test eval/run.test.mjs`.

The M2 refactor gave 0 diffs over 61 URLs (every route, paging cursors in each phase, alias 409s, warnings,
derived, path, region, search, resolve GET and POST, edge, schema, releases and manifest, UI, error cases),
and the eval scored 50/50 gold with 100% citation. The M2 review fixes gave 4 intended diffs over the same
61 URLs: `/node/Sobic.007G158500` is now a 409 (T2T-CAS id vs BTx623 alias, as `/resolve` reports it), and the
three `SbCA3P1` 409s gain `candidates[].match`. The eval scored 60/60 gold with 100% citation.
