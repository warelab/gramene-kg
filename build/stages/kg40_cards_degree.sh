#!/usr/bin/env bash
# kg40_cards_degree — per-node degree, deterministic cards for Solr-indexed nodes, Mongo edge table.
set -euo pipefail
cd "$(dirname "$0")/.."
. ./config.sh
. ./lib.sh
require_build_id
stage_begin kg40_cards_degree
rm -rf "${BUILD_OUT}/parquet/final"
DUCKDB_MEMORY_LIMIT="${DUCKDB_MEMORY_LIMIT:-16GB}" run "${NODE_BIN}" --max-old-space-size=4096 lib/cards.mjs
stage_end
