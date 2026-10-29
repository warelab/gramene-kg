#!/usr/bin/env bash
# kg10_extract — stream release stores and files into typed NDJSON (read-only).
set -euo pipefail
cd "$(dirname "$0")/.."
. ./config.sh
. ./lib.sh
require_build_id
stage_begin kg10_extract
export RELEASE_ROOT
run "${NODE_BIN}" --max-old-space-size=4096 lib/extract.mjs
for f in genes gene_xref trees maps qtls germplasm experiments assays ont_go ont_po ont_to ont_eco ont_interpro; do
  [ -s "${BUILD_OUT}/extract/${f}.ndjson" ] || die "extract ${f}.ndjson missing or empty"
done
stage_end
