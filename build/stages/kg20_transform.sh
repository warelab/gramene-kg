#!/usr/bin/env bash
# kg20_transform — extract NDJSON -> node and edge Parquet with deterministic ids and provenance.
set -euo pipefail
cd "$(dirname "$0")/.."
. ./config.sh
. ./lib.sh
require_build_id
stage_begin kg20_transform
rm -rf "${BUILD_OUT}/parquet/graph" "${BUILD_OUT}/work"
DUCKDB_MEMORY_LIMIT="${DUCKDB_MEMORY_LIMIT:-16GB}" run "${NODE_BIN}" --max-old-space-size=4096 lib/transform.mjs
[ -s "${BUILD_OUT}/transform_counts.json" ] || die "transform wrote no counts"
stage_end
