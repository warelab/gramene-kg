#!/usr/bin/env bash
# kg50_export — KGX TSV + JSON lines (whole graph and per source), JSON-LD context, manifest.json,
# manifest.sha256, RO-Crate; gate: kgx validation of the Biolink-native sample has zero ERRORs.
set -euo pipefail
cd "$(dirname "$0")/.."
. ./config.sh
. ./lib.sh
require_build_id
stage_begin kg50_export
DUCKDB_MEMORY_LIMIT="${DUCKDB_MEMORY_LIMIT:-16GB}" run "${NODE_BIN}" --max-old-space-size=4096 lib/export.mjs
log "kgx validate (Biolink 4.4.6, vendored) on the Biolink-native sample"
"${KG_ROOT}/.venv-kgx/bin/python" lib/kgx_validate.py "${BUILD_OUT}/kgx/sample/sample_nodes.jsonl.gz" \
  "${BUILD_OUT}/kgx/sample/sample_edges.jsonl.gz" "${BUILD_OUT}/kgx/sample/kgx_validation.json" 2>"${BUILD_OUT}/kgx/sample/kgx_validate.log" \
  || die "kgx validation reported ERRORs; see ${BUILD_OUT}/kgx/sample/kgx_validation.json"
stage_end
