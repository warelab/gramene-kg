#!/usr/bin/env bash
# lib.sh — helpers shared by the kg stages. Adapted from
# /usr/local/gramene/subsites/sorghum/v11/build/lib.sh (logging, stamps, stage scaffolding),
# minus everything that writes to release databases or cores.

_ts()  { date '+%Y-%m-%d %H:%M:%S'; }
log()  { echo "[$(_ts)] $*" >&2; }
ok()   { echo "[$(_ts)] ✓ $*" >&2; }
warn() { echo "[$(_ts)] ⚠ $*" >&2; }
die()  { echo "[$(_ts)] FATAL: $*" >&2; exit 1; }
run()  { log "+ $*"; "$@"; }

# Stage order; a stage that starts clears the stamps of every stage after it, so a re-run upstream
# can never leave downstream stamps describing older artifacts.
KG_STAGE_ORDER=(kg00_preflight kg05_catalogue kg10_extract kg20_transform kg25_publications kg30_validate
                kg40_cards_degree kg60_load_mongo kg70_solr kg80_promote)
# A stamp records the build it belongs to: "<BUILD_ID> <timestamp>".
stamp_done()  { mkdir -p "${STATE_DIR}"; echo "${BUILD_ID} $(date '+%Y-%m-%dT%H:%M:%S')" > "${STATE_DIR}/$1.done"; }
stamp_clear() { rm -f "${STATE_DIR}/$1.done"; }
is_done()     { [ -f "${STATE_DIR}/$1.done" ] && [ "$(cut -d' ' -f1 "${STATE_DIR}/$1.done")" = "${BUILD_ID}" ]; }
clear_downstream() {
  local seen=0 s
  for s in "${KG_STAGE_ORDER[@]}"; do
    if [ "$seen" = 1 ]; then stamp_clear "$s"; fi
    [ "$s" = "$1" ] && seen=1
  done
  return 0
}

# One build at a time per release. `make build/promote` hold the lock for the whole run and export
# KG_LOCK_HELD=1; a stage run on its own takes it here.
take_lock() {
  [ "${KG_LOCK_HELD:-0}" = 1 ] && return 0
  exec 9>"${STATE_DIR}/build.lock"
  flock -n 9 || die "another gramene-kg build of ${RELEASE} holds ${STATE_DIR}/build.lock"
}

# Stages that write build artifacts refuse the promoted build's directory (no Mongo needed).
assert_not_live_artifacts() {
  local cur="${RELEASE_BUILDS}/current"
  if [ -e "$cur" ] && [ -n "${BUILD_ID}" ] && [ "$(readlink -f "$cur")" = "$(readlink -f "${BUILD_OUT}")" ] && [ "${FORCE_LIVE:-0}" != 1 ]; then
    die "build ${BUILD_ID} is the promoted build of ${RELEASE}; its artifacts are read by the API and eval. Start a new build (NEW_BUILD=1) or set FORCE_LIVE=1"
  fi
  return 0
}

# read a value from the release yaml: yget inputs.rsid_table
yget() { "${PY}" -c 'import sys,yaml
v=yaml.safe_load(open(sys.argv[1]))
for k in sys.argv[2].split("."): v=v[k]
print(v if not isinstance(v,(list,dict)) else __import__("json").dumps(v))' "${RELEASE_YAML}" "$1"; }

mongo_eval_db() { "${MONGOSH}" --quiet "${MONGO_URI}/$1" --eval "$2"; }
src_count() { mongo_eval_db "${SRC_DB}" "db.getCollection('$1').estimatedDocumentCount()" | tail -1; }

assert_not_protected() {
  [[ "$1" =~ ${PROTECTED_DB_RE} ]] && die "refusing to write to protected database '$1'"
  [ "$1" = "${KG_META_DB}" ] || [ "$1" = "${KG_CURATION_DB}" ] && die "build stages never target ${1} as a build db"
  return 0
}

require_build_id() { [ -n "${BUILD_ID}" ] || die "no BUILD_ID: run kg00_preflight first (or set BUILD_ID)"; }

stage_begin() {
  STAGE_NAME="$1"
  take_lock
  case "${STAGE_NAME}" in kg00_preflight|kg80_promote) ;; *) assert_not_live_artifacts ;; esac
  clear_downstream "${STAGE_NAME}"
  mkdir -p "${LOG_DIR}"
  exec > >(tee -a "${LOG_DIR}/${STAGE_NAME}.log") 2>&1
  log "════════ STAGE ${STAGE_NAME} release=${RELEASE} build=${BUILD_ID:-new} ════════"
  STAGE_T0=$(date +%s)
  STAGE_MEM0=$(awk '/MemAvailable/{print int($2/1048576)}' /proc/meminfo)
}
stage_end() {
  local dt=$(( $(date +%s) - STAGE_T0 )) mem1
  mem1=$(awk '/MemAvailable/{print int($2/1048576)}' /proc/meminfo)
  stamp_done "${STAGE_NAME}"
  ledger_add stages "${STAGE_NAME}" "${BUILD_ID}" "${dt}s" "memavail_gb=${STAGE_MEM0}->${mem1}"
  ok "════════ STAGE ${STAGE_NAME} complete in ${dt}s (MemAvailable ${STAGE_MEM0} -> ${mem1} GB) ════════"
}

ledger_add() {
  local name="$1"; shift
  mkdir -p "${STATE_DIR}"
  printf '%s\t%s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$(printf '%s\t' "$@" | sed 's/\t$//')" >> "${STATE_DIR}/${name}.tsv"
}

# Stages that write a build's db or core refuse to touch the build that is currently promoted.
assert_not_live() {
  local cur
  cur="$("${MONGOSH}" --quiet "${MONGO_URI}/kg_meta" --eval "const r=db.releases.findOne({_id:'${RELEASE}'}); print(r?r.current_build:'')" | tail -1)"
  if [ -n "${cur}" ] && [ "${cur}" = "${BUILD_ID}" ] && [ "${FORCE_LIVE:-0}" != 1 ]; then
    die "build ${BUILD_ID} is the promoted build of ${RELEASE}; start a new build (NEW_BUILD=1) or set FORCE_LIVE=1"
  fi
}
