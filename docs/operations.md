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

## API

    env -i HOME=$HOME USER=$USER PATH=$PATH pm2 start ecosystem.config.cjs --only gramene-kg-api
    pm2 restart gramene-kg-api          # by name only; never `pm2 restart all`
    curl -s localhost:12000/kg/v1/health

Start pm2 apps with `env -i` so no shell variables leak into the app environment
(`pm2 restart --update-env` merges rather than replaces).

## Eval

    KG_BUILD_DIR=/scratch/olson/gramene-kg/builds/sorghum11/current node eval/generate.mjs > eval/questions.jsonl
    KG_API_URL=http://127.0.0.1:12000 node --test eval/run.test.mjs

Gold answers come from the build Parquet. Results append to `eval/results/rest.jsonl`.

## Safety rules

- Stages refuse to write to `search*`, `sorghum*`, `userData*`, `ontology`, `ensembl`,
  `gramene_g2p`, `kg_meta` (except promotion) and `kg_curation`.
- `kg70` only creates or unloads cores named `kg_<release>_b<12 digits>`.
- `kg00` refuses to start while a release build runs in any tree in `config/build_trees.txt`,
  or when MemAvailable is below 50 GB.
- `jq` is not installed on squam; use `bin/kgq '<js expression over j>'`.
