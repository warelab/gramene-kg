#!/usr/bin/env bash
# kg80_promote — point kg_meta.releases.<release> at this build (one document update), move the
# 'current' symlink, and drop builds older than the previous one (their db, core and artifacts).
set -euo pipefail
cd "$(dirname "$0")/.."
. ./config.sh
. ./lib.sh
require_build_id
stage_begin kg80_promote
for s in kg30_validate kg60_load_mongo kg70_solr; do is_done "$s" || die "cannot promote: ${s} not done for build ${BUILD_ID}"; done
run "${NODE_BIN}" lib/promote.mjs
ln -sfn "${BUILD_ID}" "${RELEASE_BUILDS}/current"
stage_end
