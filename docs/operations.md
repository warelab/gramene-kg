# Operations

## Build a release

    cd /usr/local/gramene/gramene-kg
    make -C build RELEASE_ROOT=/usr/local/gramene/subsites/sorghum/v11 status
    NEW_BUILD=1 make -C build RELEASE_ROOT=/usr/local/gramene/subsites/sorghum/v11 build   # kg00 .. kg70
    make -C build RELEASE_ROOT=/usr/local/gramene/subsites/sorghum/v11 promote             # kg80

- `kg00` mints `BUILD_ID` (YYYYMMDDHHMM). `NEW_BUILD=1` forces a new one and clears later stamps.
- A stage target re-runs that stage; its prerequisites run only if their stamps are missing.
- Artifacts: `/scratch/olson/gramene-kg/builds/<release>/<BUILD_ID>/` (`latest` = last started,
  `current` = promoted). Logs: `logs/<release>/<stage>.log`; ledger: `.state/<release>/stages.tsv`.
- Each build lands in its own Mongo db `kg_<release>_b<BUILD_ID>` and Solr core of the same name.
  Promotion is one update of `kg_meta.releases`; the API follows it within 30 s, no restart.
  Promotion keeps the current and previous build and drops older ones (db, core, artifacts).
- A full sorghum11 build takes about 15 minutes (extract 3, transform 1, load 6, Solr 1.5) with
  ~20 GB peak RSS. Publication enrichment is cached in `kg_meta.publication_cache`; only new ids
  are fetched.

## Validation (kg30)

`validation.json` and `dangling_report.tsv` in the build directory list every gate. Counts are
compared with `config/releases/<release>/expectations.json` (±10%). After an intended change in
counts (new source, new edge family) re-record them:

    make -C build RELEASE_ROOT=... kg30_validate EXPECTATIONS_MODE=record

then review the diff of `expectations.json` before committing it.

## Curated layer in builds

kg20 reads the curated layer (docs/curation.md) as one more source, in `build/lib/curated.mjs`:

- **What is read**: db `kg_curation` (`KG_CURATION_DB`, which build/config.sh sets): workspaces with `visibility: public`, their
  `curated_nodes` (one record per workspace and CURIE, `_id` `<ws>|<curie>`; private workspaces' records are never
  read), and for each assertion id its highest revision when that revision is `published`.
  An assertion superseded (`supersedes: <id>@<rev>`) by another published one is not baked. Firebase uids,
  ACLs and emails are not read.
- **Snapshot**: what was read is written canonically to `extract/snapshots/kg_curation.json` and recorded as
  `gramene.dataset:kg-curation@<sha12>` + `gramene.dist:sha256-<sha>`; curated edges carry the sha12 as
  `knowledge_source_version`. To rebuild from artifacts without Mongo (and without writing an attach report):
  `KG_CURATION_SNAPSHOT=<old build>/extract/snapshots/kg_curation.json make -C build ... kg20_transform`.
- **Nodes**: one graph node per CURIE. Every public workspace's record of it goes under `attrs.curated.<ws>`
  (`source`, `rev`, `content_sha256`, `cls`, `name`, `description`, `xrefs`, `attrs`; `etl_cls` when it differs).
  A CURIE already in the graph is merged: ETL fields kept, its `xrefs` unchanged (order and repeats), then the
  curated xrefs it lacks appended. A new CURIE is appended to its class, taking class, name and top-level `attrs`
  from its earliest record (`created_at`, then workspace id); `GramenePublication` nodes then go
  through kg25 enrichment. The merge patch is kept in `parquet/graph/curated/node_overlay.parquet` and
  re-applied by kg40, because kg25 rewrites Publication attrs. An assertion with 2 or more evidence lines
  gets an `Association` node `gramene.assoc:<id>` whose id is also its edge's id (`attrs.curated.<ws>` holds
  the assertion id and revision).
- **Edges**: `parquet/graph/edges/curated.parquet`, family and layer `curated`, ids and provenance as in
  docs/curation.md, plus `asn {id, rev}` (Mongo edges keep it, with a partial index `asn_id_curated`).
  ECO ids that are not EvidenceCodeTerm nodes are dropped (listed in `transform_counts.json` `curated.eco_dropped`).
  kg50 writes them, and only them, to `kgx/by_layer/<prefix>_curated_edges.tsv.gz` and `.jsonl.gz` (listed in
  `manifest.json` `kgx.by_layer` and in the RO-Crate; `counts.edges_by_layer` in the manifest); they are also in
  the whole-graph files and in the `infores:sorghumbase-curation` by-source file, which holds ETL edges too
  (CSHL mentions, gene_to_curated), so check curated KGX output with `gramene:layer == curated` or the by-layer
  file, never by the infores string. Solr sets `has_curated_b` on nodes they touch.
- **Unresolved CURIEs** (subject or object not a node of this build): the assertion is not baked and is
  listed with up to 5 suggestions in `attach_report.json` and in `kg_curation.attach_reports`
  (`_id: <release>@<build>`). Both are written on every kg20 run, with `unresolved: []` when nothing is
  unresolved, and replace those of an earlier kg20 run of the same build (not written when replaying a snapshot). That upsert, by a short-lived client in kg20, is the one
  write a build stage makes to `kg_curation`; it refuses any db not named `kg_curation`,
  `kg_curation_fixture*` or `kg_curation_test*`.
- **kg30** adds, when a snapshot exists: every curated edge carries `asn`; its assertion is published and
  the latest revision in the snapshot; its id matches the contract hash; `layer curated` iff family `curated`.
  Assertions retracted after kg20 are only warned about (the API masks them). Curated counts (family
  `curated`, class `Association`) are never recorded in or gated by `expectations.json`.
- **Empty `kg_curation`** (or no published assertion / curated node in a public workspace): kg20 writes no
  snapshot, node, edge or overlay (and removes a snapshot left by an earlier kg20 run of the same build), so the
  graph, Mongo, Solr and KGX data are the same as before M3; it only writes an empty `attach_report.json` and
  replaces the build's `kg_curation.attach_reports` entry with an empty one (`snapshot_sha256: null`).

The release tree's hook runs the whole build after a release build: `make -C
/usr/local/gramene/subsites/sorghum/v11/build 80_kg` (`stages/80_kg.sh`; not in `all`, no stamp
prerequisites; it checks `65_solr_suggestions` and `22_germplasm` are done). `80_kg` is phony and every run
starts a **new** kg build (`make build NEW_BUILD=1`, so a `NEW_BUILD` in the environment does not matter):
neither newly published curation nor a release stage re-run outside `refresh-*` changes a stamp, so a
stamp-gated or resuming target would skip a needed rebuild. After a failed kg stage, `KG_RESUME=1 make 80_kg`
(or `make -C build ... build` here) resumes the current kg build instead. `.state/80_kg.done` only records that
the last run succeeded: the script removes it when it starts, and the `refresh-*` targets remove it (which,
as those targets end in `make all` and `80_kg` is not in `all`, means "the KG predates the refreshed release
data; run `make 80_kg`"). Promotion stays manual.

## API

    env -i HOME=$HOME USER=$USER PATH=$PATH pm2 start ecosystem.config.cjs --only gramene-kg-api
    pm2 restart gramene-kg-api          # by name only; never `pm2 restart all`
    curl -s localhost:12000/kg/v1/health

Start pm2 apps with `env -i` so no shell variables leak into the app environment
(`pm2 restart --update-env` merges rather than replaces).

The API serves REST (`/kg/v1`), GraphQL (`/kg/graphql`) and the browse UI (`/kg/ui/`); see docs/api.md.
`KG_PUBLIC_URL` is the base written into JSON-LD `@context`; ecosystem.config.cjs sets it to
`https://data.sorghumbase.org/kg` (the public proxy, live since 2026-11-04; default without it:
`http://127.0.0.1:12000/kg`). After changing env in ecosystem.config.cjs:

    env -i HOME=$HOME USER=$USER PATH=$PATH pm2 startOrRestart ecosystem.config.cjs --only gramene-kg-api --update-env

## Staging MCP (kg_* tools)

The kg_* tools live in `mcp/kg-tools.mjs` and `mcp/resources.mjs` here and are copied into the
staging checkout `/home/olson/src/warelab/gramene-mcp-kg` (branch `kg-tools`, imported from its `kg/`):

    bin/sync-mcp /home/olson/src/warelab/gramene-mcp-kg     # copies, prints sha256 of both sides
    cd /home/olson/src/warelab/gramene-mcp-kg
    env -i HOME=$HOME USER=$USER PATH=$PATH pm2 start ecosystem.kg.config.cjs   # first time only: defines ONLY gramene-mcp-kg
    pm2 restart gramene-mcp-kg                               # after a sync
    MCP_URL=http://127.0.0.1:11067/mcp/sorghum_v11 node --test test/kg-tools.test.mjs

Never run pm2 against the checkout's `ecosystem.config.cjs`. It is the committed copy of the live
app's file (kept at git HEAD for a clean merge), and it defines the app named `gramene-mcp`, so any pm2
verb on it acts on the live process on :11065 by name, with an older environment (no v70 site). `bin/sync-mcp` refuses any target
that resolves to the live checkout `/home/olson/src/warelab/gramene-mcp`. The tools reach the live
MCP only when the `kg-tools` branch is merged there at its next scheduled restart (M3).

## Eval

    KG_BUILD_DIR=/scratch/olson/gramene-kg/builds/sorghum11/current node eval/generate.mjs > eval/questions.jsonl
    KG_API_URL=http://127.0.0.1:12000 node --test eval/run.test.mjs
    KG_MCP_URL=http://127.0.0.1:11067/mcp/sorghum_v11 node --test eval/run.test.mjs

Gold answers come from the build Parquet (and `counts.json` for the changes questions), so regenerate
after every promote. Results append to `eval/results/rest.jsonl` or `eval/results/mcp.jsonl`.
`KG_EVAL_PAGE` sets the kg_edges page size in MCP mode (default 10, so paging is always exercised).

## Backups

`bin/kg-backup` dumps `kg_meta` and `kg_curation` nightly; see docs/backups.md for the cron line and
the restore recipe. Restore only into a differently named db.

## Safety rules

- Stages refuse to write to `search*`, `sorghum*`, `userData*`, `ontology`, `ensembl`,
  `gramene_g2p`, `kg_meta` (except promotion) and `kg_curation` (except kg20's `attach_reports` upsert).
- `kg70` only creates or unloads cores named `kg_<release>_b<12 digits>`.
- `kg00` refuses to start while a release build runs in any tree in `config/build_trees.txt`,
  or when MemAvailable is below 50 GB.
- `jq` is not installed on squam; use `bin/kgq '<js expression over j>'`.
