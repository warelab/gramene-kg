#!/usr/bin/env bash
# kg30_validate — gates over the graph Parquet. EXPECTATIONS_MODE=record|check (default check, or
# record when config/releases/<release>/expectations.json does not exist yet).
set -euo pipefail
cd "$(dirname "$0")/.."
. ./config.sh
. ./lib.sh
require_build_id
stage_begin kg30_validate
rc=0
"${NODE_BIN}" --max-old-space-size=4096 lib/validate.mjs || rc=$?
log "JSON Schema check of an edge sample (GrameneAssociation)"
"${PY}" lib/schema_sample.py "${KG_ROOT}/schema/generated/json-schema/gramene_kg.schema.json" "${BUILD_OUT}/work/edge_sample.json" || rc=1
[ "${rc}" -eq 0 ] || die "validation failed; see ${BUILD_OUT}/validation.json and dangling_report.tsv"
stage_end
