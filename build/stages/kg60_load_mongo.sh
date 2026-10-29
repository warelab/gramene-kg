#!/usr/bin/env bash
# kg60_load_mongo — final Parquet -> per-build Mongo db kg_<release>_b<BUILD_ID> via swapIn.
set -euo pipefail
cd "$(dirname "$0")/.."
. ./config.sh
. ./lib.sh
require_build_id
assert_not_live
assert_not_protected "${KG_DB}"
stage_begin kg60_load_mongo
log "WiredTiger cache before: $(mongo_eval_db admin 'const c=db.serverStatus().wiredTiger.cache; print((c["bytes currently in the cache"]/1e9).toFixed(1)+" / "+(c["maximum bytes configured"]/1e9).toFixed(1)+" GB")' | tail -1)"
run "${NODE_BIN}" --max-old-space-size=4096 lib/load_mongo.mjs
run "${NODE_BIN}" lib/schema_stats.mjs
log "WiredTiger cache after: $(mongo_eval_db admin 'const c=db.serverStatus().wiredTiger.cache; print((c["bytes currently in the cache"]/1e9).toFixed(1)+" / "+(c["maximum bytes configured"]/1e9).toFixed(1)+" GB")' | tail -1)"
stage_end
