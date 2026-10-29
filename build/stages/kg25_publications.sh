#!/usr/bin/env bash
# kg25_publications — enrich Publication nodes from NCBI esummary / Crossref (cached in kg_meta).
set -euo pipefail
cd "$(dirname "$0")/.."
. ./config.sh
. ./lib.sh
require_build_id
stage_begin kg25_publications
run "${NODE_BIN}" lib/publications.mjs
stage_end
