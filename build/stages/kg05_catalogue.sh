#!/usr/bin/env bash
# kg05_catalogue — Release / Dataset / Distribution / IngestRun / Analysis / SoftwareAgent nodes.
# sha256 of every input file; network snapshots stamped; sets the 'latest' symlink.
set -euo pipefail
cd "$(dirname "$0")/.."
. ./config.sh
. ./lib.sh
require_build_id
stage_begin kg05_catalogue
mkdir -p "${BUILD_OUT}"
ln -sfn "${BUILD_ID}" "${RELEASE_BUILDS}/latest"
ok "build dir ${BUILD_OUT} (latest -> ${BUILD_ID})"
run "${NODE_BIN}" lib/catalogue.mjs
for f in KgDistribution KgDataset KgRelease IngestRun AnalysisRun SoftwareAgent; do
  [ -s "${BUILD_OUT}/parquet/nodes/${f}.parquet" ] || die "missing ${f}.parquet"
done
stage_end
