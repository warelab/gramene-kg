# gramene-kg API

`apps/api/server.mjs` (Fastify 5, pm2 `gramene-kg-api`, `:12000`). It reads `kg_meta`, the promoted
`kg_<release>_b<build>` and `kg_curation`, plus the release's Solr core and the build's Parquet and `counts.json`
under `KG_BUILDS_DIR` (default `/scratch/olson/gramene-kg/builds`). It writes only to `kg_curation`, through the
curation write client (see "Curation" below).

| file | role |
|---|---|
| `apps/api/core.mjs` | all query logic: release resolution, nodes, edge paging, resolve, search, region, path, derived, changes |
| `apps/api/server.mjs` | REST routes: maps HTTP onto `core.mjs` and wraps results in the envelope |
| `apps/api/graphql.mjs` | GraphQL schema, resolvers, loaders, depth/complexity rule; resolvers call `core.mjs` |
| `apps/api/jsonld.mjs` | JSON-LD rendering of a node |
| `apps/api/derived.mjs` | DuckDB lookups over the derived Parquet buckets |
| `apps/api/curation.mjs`, `auth.mjs`, `curation-db.mjs`, `curation-ids.mjs` | curation API, tokens, write client, ids (below) |

REST and GraphQL share the same functions, so their results cannot diverge. GraphQL only renames fields
to camelCase and adds connections.

Environment: `KG_PORT`, `KG_HOST`, `KG_SITE` (picks the current release), `MONGO_URL`, `SOLR_URL`,
`KG_BUILDS_DIR`, `KG_CURATION_DB` (default `kg_curation`), `KG_AUTH_TEST_SECRET` (dev only), `KG_PUBLIC_URL` (the public base of `/kg`, used for the JSON-LD `@context` URL; default
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

## Curation `/kg/v1/curate/*` (M3)

The contract is docs/curation.md. Code: `apps/api/curation.mjs` (routes), `apps/api/auth.mjs` (tokens),
`apps/api/curation-db.mjs` (the write client), `apps/api/curation-ids.mjs` (ids and hashes, shared with the build),
`packages/policy/index.mjs` (the g2p policy, vendored), `config/curation.yaml` (predicate allow-list, node classes).

### Auth

`Authorization: Bearer <Firebase ID token>` of project `gramene-auth` (verified by firebase-admin with
`projectId` only: Google's public keys, no service-account file). The token is optional on every route, read
routes included: it decides which curated data is shown. A token that fails verification is treated as no token
on read routes and gives 401 (`hint: invalid or expired token`) on routes that need a user.

Dev servers only: with `KG_AUTH_TEST_SECRET` (≥ 16 characters) set, HS256 JWTs `{uid, email, exp, iat?}` signed
with it are accepted too: `exp` is required, in the future and at most 1 h ahead, `iat` (optional) not in the
future; anything else is a 401 (`invalid or expired token`). The server refuses to start with
`KG_AUTH_TEST_SECRET` and `NODE_ENV=production` together, and pm2 `gramene-kg-api` runs with
`NODE_ENV=production`. With test tokens on, `KG_HOST` defaults to 127.0.0.1 (a non-loopback `KG_HOST` logs a
warning). `signTestToken(claims, secret, ttl = 900)` in `auth.mjs` signs one with `iat` and `exp` set.

```
node -e 'const c=require("crypto"),e=o=>Buffer.from(JSON.stringify(o)).toString("base64url"),n=Math.floor(Date.now()/1000),
  h=e({alg:"HS256",typ:"JWT"})+"."+e({uid:"dev-1",email:"dev@example.org",iat:n,exp:n+3600});
  console.log(h+"."+c.createHmac("sha256",process.env.KG_AUTH_TEST_SECRET).update(h).digest("base64url"))'
```

Roles per workspace (owner > curator > contributor > reader) come from the vendored g2p policy; a principal is
`{uid, orgs}` with `orgs` from `kg_curation.users` (empty until an org is added there by hand). Public workspaces
are readable by anyone. Anything the caller cannot read is a **404** (`no workspace 'ws_…'`, `no assertion
'asn_…'`), whether or not it exists; a readable thing without the role is a 403; a write without a token is a 401.

**Site curators** (`kg_curation.site_roles`, edited by the operator only; docs/curation.md has the mongosh
command): in a public workspace `publish`, `reject` and `retract` need a site curator, who needs no role in the
workspace for them (workspace curators and owners who are not site curators get 403 `… requires a site
curator`). Creating a workspace public, or PATCHing a workspace to `visibility: public`, needs an owner who is a
site curator. Private workspaces keep the workspace roles.

**Uids.** Members of a workspace (owner, user or org ACL entry) see raw uids in `owner`, `created_by`,
`updated_by`, `revisions[].updated_by` and events' `by`; everyone else sees the user's `display_name` when
`display_opt_in`, else `user-<12 hex>` (sha256 of `<workspace id>|<uid>`: stable per workspace).

### Routes

Every response is the usual envelope `{release, build, data, meta}` (`release`/`build` = the release used for
resolution, the current one unless `release=`). Lists take `limit` ≤ 500 (default 100) and `offset`, and give
`meta.total`. Bodies are JSON; an unknown field is a 400 that lists the accepted ones.

| method, route | role | body / query → data |
|---|---|---|
| `GET /curate/me` | signed in | `{uid, email, display_name, display_opt_in, orgs, site_role: 'site_curator'\|null, workspaces[{id, name, visibility, role}]}`; records the user in `users`. On a dev server (`KG_AUTH_TEST_SECRET`) `meta.auth_test_mode: true`, also in the 401 body, so the UI offers test sign-in |
| `GET /curate/predicates` | any | the `config/curation.yaml` allow-list `[{id, domain, range}]` (categories comma-joined without `biolink:`, null = any); `meta.node_classes`, `meta.knowledge_levels` |
| `POST /curate/workspaces` | signed in | `{name, description?, visibility?: private\|public}` → 201 workspace; the caller is its owner; `public` needs a site curator (403) |
| `GET /curate/workspaces` | any | readable workspaces: `[{id, name, description, visibility, owner, role, member, created_at, updated_at}]` (`acls` for the owner only; `owner` per "Uids") |
| `GET /curate/workspaces/:ws` | reader | the workspace plus `assertions` (latest revisions by state) and `nodes` (count) |
| `PATCH /curate/workspaces/:ws` | owner | `{name?, description?, visibility?}`; visibility applies to the read side at once; to `public` also needs a site curator (403) |
| `PUT /curate/workspaces/:ws/acl` | owner | `{acls: [{principal: {type: user\|org, id}, role: reader\|contributor\|curator\|owner}]}` replaces the list |
| `POST /curate/workspaces/:ws/nodes` | contributor | `{class, id?, name?, description?, xrefs?, attrs?, rev?}` → 201 (200 when this workspace already has the id: new rev); 409 when a concurrent write won or `rev` (the revision the change is based on, 0 = new) is not the current one |
| `GET /curate/workspaces/:ws/nodes?class=` | reader | curated nodes `[{id, workspace, class, category, name, description, xrefs, attrs, assertion?, rev, content_sha256, …}]` |
| `POST /curate/workspaces/:ws/assertions` | contributor | `{subject, predicate, object, qualifiers?, negated?, evidence?, note?, disputes?, supersedes?}` → 201 draft |
| `GET /curate/workspaces/:ws/assertions?state=` | reader | one row per assertion (its highest revision), newest change first; `state` is a comma list |
| `GET /curate/assertions/:id[?rev=n]` | reader | the latest (or that) revision plus `revisions[{rev, state, latest, updated_at, updated_by, content_sha256}]` |
| `PATCH /curate/assertions/:id` | contributor | semantic fields, as for POST (minus `supersedes`); drafts and rejected only (rejected → draft); 409 otherwise |
| `POST /curate/assertions/:id/submit` | contributor | draft → submitted; 422 unless an evidence line cites a publication or an ECO code |
| `POST /curate/assertions/:id/publish` | curator (public ws: site curator) | submitted → published; subject and object must still resolve to the same ids (409 otherwise) |
| `POST /curate/assertions/:id/reject` | curator (public ws: site curator) | `{reason}` (required): submitted → rejected |
| `POST /curate/assertions/:id/retract` | curator (public ws: site curator) | `{reason}` (required): published → retracted; hidden on the read side at once |
| `GET /curate/assertions/:id/events` | reader | `[{assertion, rev, from, to, by, at, reason}]`, oldest first (creation is `null → draft`) |
| `GET /curate/reports?release=` | any | `attach_reports` of the release, newest first, `unresolved` cut to assertions of workspaces the caller can read |

A transition from the wrong state is a 409 (`cannot publish assertion asn_…: it is draft, not submitted`). Every
state change and edit appends a revision `<id>@<rev+1>` and a `review_events` row (edits: an `audit` row);
`content_sha256` is the sha256 of the canonical JSON of subject, predicate, object, qualifiers, negated, evidence,
note and disputes.

**Assertion fields.** `predicate` is a key of `config/curation.yaml` `predicates` or its unique local name
(`mentions` → `biolink:mentions`); others are a 400 listing the allow-list. `subject`/`object` are resolved with
`/resolve`'s code (exact id, bare id under the known prefixes, alias) against the release; a bare or alias match
is stored as the resolved id with a `meta.warnings` entry. Otherwise the id must be a curated node of this
workspace or of a public one. Ambiguous → **409** with `candidates` (as `/resolve`); unresolvable → **422** with
`candidates` (top 5 search hits; when search finds none, up to 5 build ids sharing the longest leading part of the CURIE, e.g. `gramene.genetree:SB11GT_*` for `SB10GT_1`). Domain/range: the subject (object) must carry one of the predicate's
`domain` (`range`) Biolink categories (build node `category`, or the curated node class's category), else 400.
`evidence` is `[{publications: [PMID:…|doi:…], has_evidence: [ECO:nnnnnnn], knowledge_level, note}]`
(`knowledge_level` from `knowledge_levels` in the yaml, default `knowledge_assertion`). `qualifiers` is an object of
scalars or scalar arrays. `disputes` is an edge id of the build or of a published assertion of this workspace or
of a public one (the same 422 otherwise, also for a private workspace's edge).
`supersedes` (create only) names a published assertion of the same workspace (`asn_…` or `asn_…@rev`; stored as
`<id>@<its latest rev>`); once the correction is published the original is hidden.

**Ids** (`curation-ids.mjs`, also used by the build's `build/lib/curated.mjs` formula): `edge_id` =
`gramene.assoc:` + sha256-24 of `subject|predicate|object|infores:sorghumbase-curation|<canonical qualifiers
JSON>|<assertion id>`; with two or more evidence lines the API creates (and keeps in step on draft edits) the curated
node `association_id` = `gramene.assoc:` + sha256-24 of `subject|predicate|object|<assertion id>`, class
`Association`, `attrs {subject, predicate, object, qualifiers}`, and the edge id is the association id.

**Curated nodes.** Classes `GramenePublication` (id `PMID:`/`doi:`, required), `AnalysisRun`
(`gramene.analysis:…`, minted `gramene.analysis:curated.<12 hex>@v1` when absent), `KgCollection`
(`gramene.collection:…`, minted `gramene.collection:cur_<12 hex>`); ids are checked against `config/prefixes.yaml`.
A publication found in `kg_meta.publication_cache` (read only) gets `name` = title and `attrs {enriched, journal,
year, authors, n_authors?, enrichment_source}` plus the PMID/DOI xref; otherwise `meta.warnings` says it is not
enriched. Records are per workspace (`_id` `<ws>|<curie>`, fields `curie`, `workspace`): the same CURIE may be
curated in several workspaces, with no cross-workspace check; GET lists this workspace's records by `curie` (the
output `id`). `Association` nodes are API-made only, derived from the assertion's highest revision after each
revision insert (a 409 loser changes nothing).

### Read side (existing routes)

`/node/{curie}`, `/node/{curie}/edges`, `/edge/{id}`, `/path`, `/search` and GraphQL take the caller from the same
token. GraphQL passes it to every core call (`node`, `nodes`, `neighbors`, `edge`, `path`, `search`, and the
`other`/`subjectNode`/`objectNode` loaders), so it shows exactly what REST shows the same caller.

- A curated edge is shown when its assertion's latest revision is `published`, in a workspace the caller can
  read, and not superseded. Baked curated edges (in the build, `asn {id, rev}`) are shown only while `asn.rev` is
  still that revision; assertions published after the build are added from `kg_curation`. Both come out as
  ordinary edges with `provenance.layer: 'curated'`, `primary_knowledge_source infores:sorghumbase-curation`,
  `agent_type manual_agent`, and an extra `curation: {assertion, rev, state, workspace}` (GraphQL
  `Edge.curation: JSON`, null for ETL edges).
- `/node/{curie}/edges` lists unbaked curated edges in a fifth phase `cur` (after `slot_in`, by edge id); filters
  (`direction`, `predicate`, `category`, `source`, `include_negated`) apply as to stored edges. `meta.degree` and
  `/node` `degree` add unbaked and subtract masked curated edges. `/node` adds `meta.warnings: ["curated counts as
  of build <build>"]` when that adjustment is not zero (its `card` and Solr fields still count as of the build), and
  `/search` adds it when a curated change visible to the caller was made since the build was loaded.
- Curated nodes not in the build resolve by exact id through `/node`, `/node/{curie}/edges`, GraphQL `node`/`nodes`
  and the edge end-point loaders; a private workspace's node is a 404 to anyone who cannot read it. The caller's
  visible records of a CURIE are merged: each under `attributes.curated.<ws>` (`{source, rev, content_sha256, cls,
  name, description, xrefs, attrs}`), class / top-level attrs from the oldest record, `curation: {workspace, rev,
  workspaces[]}`. Build nodes get `attributes.curated` the same way (baked entries the caller cannot see dropped;
  absent when none). An `Association` node (curated or baked), and a baked `attrs.curated_only` node, is shown
  only while one of its records is visible: otherwise 404 / null, and left out of `/search` rows and `/resolve`.
- A curated self-loop is listed twice (out and in) by `/node/{curie}/edges`, before and after the build.
- Anonymous visibility uses a ≤ 10 s cache of the public workspaces, dropped by the process's own curation writes.
- `/path` walks baked curated edges only (masked as above); unbaked ones join after the next build.
- With no assertion touching the nodes asked for, every response is byte-identical to the ETL-only API (checked
  over 42 REST and GraphQL URLs with an empty `kg_curation`).

### Mongo

The API holds two clients: the read client (`kg_meta`, the build dbs, and reads of `kg_curation`), and the
curation write client from `curation-db.mjs`, a separate `MongoClient` wrapped so the only handle the API gets
exposes collections of one db and throws on any other db name. The db name is `KG_CURATION_DB` (default
`kg_curation`); only `kg_curation`, `kg_curation_test*` and `kg_curation_fixture*` are accepted, checked before
connecting. At startup it runs `dbStats` to confirm the bound name and creates the indexes (idempotent):
assertions `{id:1, rev:-1}`, `{workspace:1, latest:1, state:1}`, `{subject:1}`, `{object:1}`, `{edge_id:1}`,
`{latest:1, state:1, updated_at:1}` (changes since a build), `{supersedes:1}` (partial on `latest: true`);
review_events `{assertion:1, at:1}`; curated_nodes `{curie:1, workspace:1}` (unique), `{workspace:1, curie:1}`,
`{assertion:1}`. Every read-side overlay query uses one of them (the tests check `explain()` for IXSCAN).
`kg_meta.publication_cache` is only read. `site_roles` is keyed by uid and needs none.

### Tests

```
KG_AUTH_TEST_SECRET=<secret> KG_CURATION_DB=kg_curation_test_api NODE_ENV=development KG_HOST=127.0.0.1 KG_PORT=12001 node apps/api/server.mjs
KG_API_URL=http://127.0.0.1:12001 KG_AUTH_TEST_SECRET=<secret> KG_CURATION_DB=kg_curation_test_api node --test test/curation.test.mjs
```

`test/curation.test.mjs` covers every route, every transition, the role boundaries (owner, curator,
contributor, reader, anonymous, other user, site curator), test-token claims (exp, iat), site-curator rules
(public workspaces, visibility), uid pseudonyms and display names, private and public visibility on the curate
routes and on `/node`, `/node/{curie}/edges`, `/edge/{id}` and GraphQL, per-workspace curated node records and
their merge, optimistic node writes under concurrency, Association nodes under concurrent edits, listings with
two `latest:true` revisions, disputes rules, a live self-loop, the overlay indexes (`explain()`), revisions and
events, retract and supersede masking, unresolvable and ambiguous CURIEs, attach-report filtering, the write
client's db binding, and (in a child process on a throwaway `kg_curation_fixture_*` db) the overlay on baked
curated edges and hidden baked curated-only nodes. It inserts its site curator into `site_roles` directly. Its
workspaces are named `TEST …`; it deletes everything it wrote, and drops the fixture db.

## Verifying a change

1. Capture about 60 REST URLs from the running API before the change, and the same URLs from a dev server
   (`KG_HOST=127.0.0.1 KG_PORT=12001 node apps/api/server.mjs` with the rest of the `ecosystem.config.cjs` env). Compare status,
   content-type, `X-KG-*` headers and body byte for byte.
2. Run `KG_API_URL=http://127.0.0.1:12001 node --test eval/run.test.mjs`.

The M2 refactor gave 0 diffs over 61 URLs (every route, paging cursors in each phase, alias 409s, warnings,
derived, path, region, search, resolve GET and POST, edge, schema, releases and manifest, UI, error cases),
and the eval scored 50/50 gold with 100% citation. The M2 review fixes gave 4 intended diffs over the same
61 URLs: `/node/Sobic.007G158500` is now a 409 (T2T-CAS id vs BTx623 alias, as `/resolve` reports it), and the
three `SbCA3P1` 409s gain `candidates[].match`. The eval scored 60/60 gold with 100% citation.
