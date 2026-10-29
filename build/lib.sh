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

stamp_done()  { mkdir -p "${STATE_DIR}"; date '+%Y-%m-%dT%H:%M:%S' > "${STATE_DIR}/$1.done"; }
stamp_clear() { rm -f "${STATE_DIR}/$1.done"; }
is_done()     { [ -f "${STATE_DIR}/$1.done" ]; }

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
