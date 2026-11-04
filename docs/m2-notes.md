# M2 notes: AI surface (MCP tools, SKILL.md, eval, GraphQL, backups)

Built and deployed on squam on 2026-11-04 against build `202611041048` of sorghum11. Nothing in M2 is
public yet: the API is on `:12000` and the staging MCP on `127.0.0.1:11067`.

## Delivered

| piece | where | state |
|---|---|---|
| 12 `kg_*` MCP tools + `kg://` resources | `mcp/kg-tools.mjs`, `mcp/resources.mjs`, copied by `bin/sync-mcp` into the staging checkout `/home/olson/src/warelab/gramene-mcp-kg` (branch `kg-tools`, `kg/`) | pm2 `gramene-mcp-kg` on 127.0.0.1:11067, from `ecosystem.kg.config.cjs` |
| agent guide | `skills/gramene-kg/SKILL.md` (264 lines), served as `kg://skill` | live on :11067 |
| GraphQL | `/kg/graphql` (mercurius 16.12.0, graphql 16.14.2), `apps/api/graphql.mjs` | live on :12000 |
| shared query logic | `apps/api/core.mjs`; REST routes in `server.mjs` and GraphQL resolvers both call it | live |
| JSON-LD | `GET /kg/v1/node/:curie` with `Accept: application/ld+json`; context at `/kg/v1/context.jsonld` | live |
| release changes | `GET /kg/v1/releases/:id/changes?from=&to=` (counts.json of two builds) | live |
| eval | 60 questions, REST and MCP modes (`KG_API_URL` / `KG_MCP_URL`) | 60/60 gold, 100% citation in both |
| backups | `bin/kg-backup` (kg_meta, kg_curation), `docs/backups.md` | ran by hand; **cron entry not installed** |

The staging checkout's server gained `kgBase`/`kgRelease` per site; only sites with `kgBase` list or
serve the kg tools and resources. Non-kg sites answer byte-identically to git HEAD, except `kb_relations`,
whose three known errors (GO/PO/TO collection names, `QTL_TO__ancestors` semantics, germplasm `_id`) were
fixed and checked against sorghum11.

## Measured

- MCP eval: 60/60 gold, citation 1.0, p95 37 ms. Edge questions page through kg_edges with page size 10
  (38 pages), so cursor paging is exercised on every run; a page-size-1 run also passed.
- REST eval: 60/60, citation 1.0. The 10 new questions (path, region, evidence, search, changes) take
  their gold from the build Parquet and `counts.json`.
- REST parity: 61 sample URLs were captured from the pre-M2 API and compared after the refactor. The only
  differences are the intended ones listed below.
- Plan check: `node(id:"gramene.qtl:QPGYR5.1"){ neighbors(predicate:"biolink:overlaps", direction:IN, first:5) … }`
  returns 5 edges, all `infores:sorghum-qtl-atlas`.
- `tools/list` on `:11067/mcp/sorghum_v11`: 30 tools, 12 of them `kg_*`.
- Backup: `kg_meta` archive 2.86 MB; `mongorestore` into a scratch db restored 22,293 documents, equal to live.

## Intended REST behaviour changes

- **Bare ids resolve like `/resolve`.** `/node/:curie` (and `/edges`, `/path`, `/derived/*`, GraphQL
  `node`/`nodes`) try the exact id, then the bare id under every known prefix, then aliases. One match is
  returned with a warning; several give 409 with candidates (`Sobic.007G158500` is both a T2T-CAS gene and a
  BTx623 v3 alias); `genome=` picks one. Before, `/node/SORBI_3001G018000` was 404 and `/node/Sobic.007G158500`
  silently returned the BTx623 gene.
- **Unprefixed predicates resolve** to the release predicate with that local name
  (`predicate=carries_predicted_lof_allele_of`); an unknown predicate returns 0 edges with a warning listing
  the valid ones. Before, both silently returned nothing.
- 409 candidates carry `match` (id, alias). `X-KG-Warnings` is ASCII-escaped JSON.

## Review

Four independent reviewers (MCP, API, security/ops, docs/tests) reported 29 findings. A second agent tried
to refute each one: 3 were refuted, 1 was resolved by SKILL.md existing, and 25 were fixed. A third round
re-ran every original reproduction against the deployed services. It confirmed the fixes and found new
defects in the fixes themselves, which are now fixed and re-checked:

- **GraphQL cost analysis was exponential in repeated fragment spreads.** A ~1 KB query
  (`F0{...F1 ...F1} F1{...F2 ...F2} …`) blocked the event loop for seconds to hours. The analysis now counts
  every selection it visits and rejects the operation past 20,000 (`QUERY_TOO_LARGE`, ~40 ms).
- **Variables named `constructor`, `valueOf`, `__proto__`, … skipped their defaults** in the cost analysis,
  which reopened the complexity bypass. Variables now live in a null-prototype object.
- kg_resolve dropped inputs the API trims; edge cursors did not bind `genome=` and bound bare predicates as
  `biolink:`; `sync-mcp` could write through a symlinked file inside `kg/`.

Main fixes from the first round:

- GraphQL limits apply to every operation, introspection included: complexity counts variable defaults
  and supplied variables; each root field costs its backend work; at most 20 root fields and 50 aliases;
  one operation per request unless `operationName`; introspection is costed by response size against twice
  the standard IntrospectionQuery.
- MCP results stay under the 200 KB result cap by sizing their own pages; continuation tokens always
  point just after the last item returned (before, the server's generic trimming silently dropped up to
  480 edges per page).
- The JSON-LD `@context` URL comes from `KG_PUBLIC_URL`, never from the Host header.
- The staging checkout's `ecosystem.config.cjs` is back at git HEAD. The staging app lives in
  `ecosystem.kg.config.cjs`, which defines only `gramene-mcp-kg`.
- kg-backup verifies an archive before it gets its final name, never prunes the newest verified archive,
  and can be told to fail when `kg_curation` is missing (`KG_BACKUP_REQUIRE_CURATION=1`, for after M3).

## Open

- **The backup cron entry is not installed.** The sandbox blocked writing the crontab. The line is in
  docs/backups.md.
- `KG_PUBLIC_URL` stays at its local default until the gorgonzola proxy is live; then set it to
  `https://data.sorghumbase.org/kg`.
- The API binds `0.0.0.0:12000` (needed for the proxy). GraphQL is bounded; REST `/path` has no rate limit.
- GraphQL `nodes` is `[Node]!`: a field-level error such as an unknown `release` nulls sibling root fields.
- The staging checkout's `ecosystem.config.cjs` still defines `gramene-mcp`: any pm2 verb on that file
  acts on the live process. Use only `ecosystem.kg.config.cjs` there (docs/operations.md).
- The M1a plan check `/node/doi:10.1101%2Fgr.227462.117 → doi:…` now returns `PMID:29712755`: the DOI is
  remapped to its PMID once the publication cache knows it, and stays in the node's xrefs.
- The live MCP checkout has an uncommitted `v70` site in its `ecosystem.config.cjs` from the release70
  work. It is not part of M2.
- Folding the kg tools into the live gramene-mcp is M3, at its next scheduled restart.
