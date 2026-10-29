#!/usr/bin/env bash
# config.sh — resolve the release being built and every path the stages use.
# Usage: RELEASE_ROOT=/usr/local/gramene/subsites/sorghum/v11 . build/config.sh
set -euo pipefail

export KG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export BUILD_DIR="${KG_ROOT}/build"
export NODE_BIN="$(command -v node)"
export PY="${KG_ROOT}/.venv/bin/python"
export MONGOSH="$(command -v mongosh)"
export MONGO_URI="${MONGO_URI:-mongodb://127.0.0.1:27017}"
export SOLR_URL="${SOLR_URL:-http://127.0.0.1:8983/solr}"
export SOLR_DATA_DIR="${SOLR_DATA_DIR:-/solr/data}"
export SCRATCH="${KG_SCRATCH:-/scratch/olson/gramene-kg}"
# the root filesystem has ~7 GB free: every temp file goes to /scratch
export TMPDIR="${SCRATCH}/tmp"
mkdir -p "${TMPDIR}"

: "${RELEASE_ROOT:?set RELEASE_ROOT, e.g. /usr/local/gramene/subsites/sorghum/v11}"
[ -d "${RELEASE_ROOT}" ] || { echo "FATAL: RELEASE_ROOT ${RELEASE_ROOT} not found" >&2; exit 1; }

# Source db name comes from the release tree's own config (the build's single source of truth).
_cfg="${RELEASE_ROOT}/gramene-mongodb-config/collections.js"
export SRC_DB="$("${NODE_BIN}" -e 'const c=require(process.argv[1]);process.stdout.write(c.getMongoConfig().db);setTimeout(()=>process.exit(0),50)' "${_cfg}")"
[ -n "${SRC_DB}" ] || { echo "FATAL: could not read db name from ${_cfg}" >&2; exit 1; }
export RELEASE="${RELEASE:-${SRC_DB}}"
[[ "${RELEASE}" =~ ^(sorghum|search)[0-9]+$ ]] || { echo "FATAL: unexpected release name ${RELEASE}" >&2; exit 1; }

export RELEASE_CFG_DIR="${KG_ROOT}/config/releases/${RELEASE}"
export RELEASE_YAML="${RELEASE_CFG_DIR}/release.yaml"
[ -f "${RELEASE_YAML}" ] || { echo "FATAL: missing ${RELEASE_YAML}" >&2; exit 1; }

export STATE_DIR="${KG_ROOT}/.state/${RELEASE}"
export LOG_DIR="${KG_ROOT}/logs/${RELEASE}"
mkdir -p "${STATE_DIR}" "${LOG_DIR}"

# BUILD_ID is minted once per build by kg00 and read back by later stages.
if [ -z "${BUILD_ID:-}" ] && [ -f "${STATE_DIR}/build_id" ]; then
  BUILD_ID="$(cat "${STATE_DIR}/build_id")"
fi
export BUILD_ID="${BUILD_ID:-}"
export RELEASE_BUILDS="${SCRATCH}/builds/${RELEASE}"
export BUILD_OUT="${RELEASE_BUILDS}/${BUILD_ID:-_unset}"
export KG_DB="kg_${RELEASE}_b${BUILD_ID:-unset}"
export KG_META_DB="kg_meta"
export KG_CURATION_DB="kg_curation"

# Databases a KG stage must never write to.
export PROTECTED_DB_RE='^(search[0-9]+|sorghum[0-9a-z_]*|userData[0-9]*|ontology|ensembl|gramene_g2p|admin|config|local)$'
