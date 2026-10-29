#!/usr/bin/env bash
# kg15_derived — gene-keyed derived tables (homology pairs, expression values) as 64-bucket parquet for the API.
set -euo pipefail
cd "$(dirname "$0")/.."
. ./config.sh
. ./lib.sh
require_build_id
stage_begin kg15_derived
rm -rf "${BUILD_OUT}/parquet/derived" "${BUILD_OUT}/derived_counts.json"
DUCKDB_MEMORY_LIMIT="${DUCKDB_MEMORY_LIMIT:-16GB}" run "${NODE_BIN}" --max-old-space-size=4096 lib/derived_homology.mjs
DUCKDB_MEMORY_LIMIT="${DUCKDB_MEMORY_LIMIT:-16GB}" run "${NODE_BIN}" --max-old-space-size=4096 lib/derived_expression.mjs
stage_end
