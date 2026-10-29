#!/usr/bin/env bash
# kg70_solr — create core kg_<release>_b<BUILD_ID> from solr/conf and index Solr-eligible nodes.
# Only the per-build kg core is ever created or unloaded here; release cores are never touched.
set -euo pipefail
cd "$(dirname "$0")/.."
. ./config.sh
. ./lib.sh
require_build_id
assert_not_live
export SOLR_CORE="kg_${RELEASE}_b${BUILD_ID}"
[[ "${SOLR_CORE}" =~ ^kg_[a-z]+[0-9]+_b[0-9]{12}$ ]] || die "unexpected core name ${SOLR_CORE}"
stage_begin kg70_solr

# atomic updates rebuild docs from stored fields: refuse a schema with an indexed, unstored,
# non-copyField-target field (the 62_attr_atomic.sh rule)
"${PY}" - "${KG_ROOT}/solr/conf/managed-schema" <<'PY' || die "unsafe solr schema"
import re, sys
s = open(sys.argv[1]).read()
copy = set(re.findall(r'<copyField[^>]*dest="([^"]+)"', s))
bad = [m.group(1) for m in re.finditer(r'<field name="([^"]+)"([^>]*)/>', s)
       if 'stored="false"' in m.group(2) and 'indexed="true"' in m.group(2) and m.group(1) not in copy | {'_root_'}]
print("unsafe fields:", bad or "none"); sys.exit(1 if bad else 0)
PY

core_exists() { curl -s "${SOLR_URL}/admin/cores?action=STATUS&core=$1&wt=json" | grep -q "\"name\":\"$1\""; }
inst="${SOLR_DATA_DIR}/${SOLR_CORE}"
if core_exists "${SOLR_CORE}"; then
  log "unloading existing ${SOLR_CORE} (same build re-run)"
  curl -s "${SOLR_URL}/admin/cores?action=UNLOAD&core=${SOLR_CORE}&deleteIndex=true&wt=json" >/dev/null
fi
rm -rf "${inst}/conf"; mkdir -p "${inst}/conf"; cp -r "${KG_ROOT}/solr/conf/." "${inst}/conf/"
chmod -R 777 "${inst}" 2>/dev/null || warn "could not chmod ${inst}"
resp="$(curl -s "${SOLR_URL}/admin/cores?action=CREATE&name=${SOLR_CORE}&instanceDir=${inst}&config=solrconfig.xml&schema=managed-schema&wt=json")"
core_exists "${SOLR_CORE}" || die "CREATE ${SOLR_CORE} failed: ${resp}"
ok "core ${SOLR_CORE} created (instanceDir ${inst})"
run "${NODE_BIN}" --max-old-space-size=4096 lib/solr_index.mjs
n="$(curl -s "${SOLR_URL}/${SOLR_CORE}/select?q=*:*&rows=0&wt=json" | "${NODE_BIN}" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).response.numFound))')"
want="$("${NODE_BIN}" -e 'console.log(require(process.argv[1]).solr_docs)' "${BUILD_OUT}/counts.json")"
[ "$n" = "$want" ] || die "numDocs ${n} != expected ${want}"
ok "numDocs ${n} == counts.json solr_docs"
stage_end
