#!/usr/bin/env bash
# kg00_preflight — refuse to build unless the sources, the host and the target are safe.
# Mints BUILD_ID (YYYYMMDDHHMM) unless one is already set for this release.
set -euo pipefail
cd "$(dirname "$0")/.."
. ./config.sh
. ./lib.sh
stage_begin kg00_preflight

fail=0
gate() { if eval "$2"; then ok "$1"; else warn "GATE FAILED: $1"; fail=1; fi; }

# --- release identity ------------------------------------------------------------------------
[ "$(yget src_db)" = "${SRC_DB}" ] || die "release.yaml src_db=$(yget src_db) but ${RELEASE_ROOT} config says ${SRC_DB}"
ok "release ${RELEASE} -> source db ${SRC_DB} (from ${RELEASE_ROOT}/gramene-mongodb-config)"

# --- source db floors --------------------------------------------------------------------------
while IFS=$'\t' read -r coll min; do
  n="$(src_count "$coll")"
  gate "${SRC_DB}.${coll} = ${n} (>= ${min})" "[ \"${n:-0}\" -ge ${min} ]"
done < <("${PY}" -c 'import yaml,sys; [print(f"{k}\t{v}") for k,v in yaml.safe_load(open(sys.argv[1]))["preflight_min"].items()]' "${RELEASE_YAML}")

# --- shared ontology loads ---------------------------------------------------------------------
for c in $(yget required_ontology_loads | tr -d '[]",'); do
  v="$(mongo_eval_db ontology "const r=db.loads.find({collection:'$c',status:'ok'}).sort({finished_at:-1}).limit(1).toArray()[0]; print(r?r.version:'')" | tail -1)"
  gate "ontology.loads ${c} version '${v}'" "[ -n \"${v}\" ]"
done

# --- input files -------------------------------------------------------------------------------
# .ok markers are empty by design: test existence, not size
gate "input rsid_ok: $(yget inputs.rsid_ok)" "[ -e \"$(yget inputs.rsid_ok)\" ]"
for k in rsid_table rsid_vcf vep_table vep_lineage grassius_tsv saved_search_backup grin_export vep_study_info; do
  f="$(yget inputs.$k)"
  gate "input ${k}: ${f}" "[ -s \"${f}\" ]"
done
for k in atlas_dir homology_dir ontology_tmp expression_pipeline jgi_dir; do
  d="$(yget inputs.$k)"
  gate "input dir ${k}: ${d}" "[ -d \"${d}\" ]"
done
gate "rsID .ok marker newer than or equal to its table" "[ ! \"$(yget inputs.rsid_table)\" -nt \"$(yget inputs.rsid_ok)\" ]"

# --- no release build running in any tree (the 'running' target is never silent; gate on RUNNING:) ---
while read -r tree; do
  [ -d "$tree" ] || continue
  out="$(make -s -C "$tree" running 2>/dev/null || true)"
  # when invoked from a release tree's 80_kg stage, our own ancestry matches its pgrep pattern
  busy="$(printf '%s\n' "$out" | awk '/^RUNNING:/{f=1;next} /^---/{f=0} f' | grep -v -e '80_kg' -e 'gramene-kg' || true)"
  gate "no build stage running in ${tree}" "[ -z \"\$busy\" ]"
  if [ -n "$busy" ]; then printf "%s\n" "$busy" >&2; fi
done < "${KG_ROOT}/config/build_trees.txt"
gate "no genes decorate running" "! pgrep -f 'decorate\.js' >/dev/null"
# kg stages of this release from another process (the build lock covers make; this covers stray runs)
others="$(pgrep -af 'stages/kg[0-9]+_[a-z_]+\.sh' | grep -v -e "^$$ " -e "^${PPID} " -e 'kg00_preflight' || true)"
gate "no other gramene-kg stage running" "[ -z \"\$others\" ]"

# --- host headroom -----------------------------------------------------------------------------
memavail=$(awk '/MemAvailable/{print int($2/1048576)}' /proc/meminfo)
swapfree=$(awk '/SwapFree/{print int($2/1048576)}' /proc/meminfo)
gate "MemAvailable ${memavail} GB > 50 GB" "[ ${memavail} -gt 50 ]"
[ "${swapfree}" -gt 4 ] && ok "free swap ${swapfree} GB" || warn "free swap only ${swapfree} GB (warning, not a gate)"
dfree() { df -BG --output=avail "$1" | tail -1 | tr -dc '0-9'; }
gate "/scratch free $(dfree /scratch) GB > 60" "[ $(dfree /scratch) -gt 60 ]"
gate "/mongodb free $(dfree /mongodb) GB > 40" "[ $(dfree /mongodb) -gt 40 ]"
gate "/solr free $(dfree /solr) GB > 10" "[ $(dfree /solr) -gt 10 ]"

[ "${fail}" -eq 0 ] || die "preflight failed; nothing was written"

# --- mint the build id and check the target is not protected -----------------------------------
if [ -z "${BUILD_ID}" ] || [ "${NEW_BUILD:-0}" = 1 ]; then
  BUILD_ID="$(date '+%Y%m%d%H%M')"
  echo "${BUILD_ID}" > "${STATE_DIR}/build_id"
  # a new build invalidates every later stamp (stamps are per build id anyway)
  clear_downstream kg00_preflight
  log "minted BUILD_ID=${BUILD_ID}"
fi
export BUILD_ID KG_DB="kg_${RELEASE}_b${BUILD_ID}"
assert_not_protected "${KG_DB}"
ok "target build db ${KG_DB}; artifacts ${RELEASE_BUILDS}/${BUILD_ID}"
stage_end
