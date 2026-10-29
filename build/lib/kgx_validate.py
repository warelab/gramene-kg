"""kg50 gate: KGX validation of the Biolink-native sample against the vendored Biolink 4.4.6.

kgx validate only knows the prefixes in Biolink's own JSON-LD context; the gramene.* and other local
prefixes are declared by our generated context (schema/generated/jsonld/context.jsonld) and
config/prefixes.yaml, so they are added to the validator's prefix set. Everything else is KGX's
standard check. Usage: kgx_validate.py <nodes.(tsv|jsonl).gz> <edges.(tsv|jsonl).gz> <report.json>
Exit 1 when any ERROR-level message remains.
"""
import json
import os
import sys

import yaml
from bmt import Toolkit
from kgx.transformer import Transformer
from kgx.validator import Validator

root = os.environ["KG_ROOT"]
nodes, edges, report = sys.argv[1:4]
Validator._currently_active_toolkit = Toolkit(schema=os.path.join(root, "schema", "vendor", "biolink-model-4.4.6.yaml"))
v = Validator()
pf = yaml.safe_load(open(os.path.join(root, "config", "prefixes.yaml")))
local = set()
for section in pf.values():
    if isinstance(section, dict):
        local |= set(section.keys())
v.prefixes = set(v.prefixes) | local
Transformer(stream=True).transform(
    input_args={"filename": [nodes, edges], "format": "jsonl" if nodes.endswith(".jsonl.gz") else "tsv", "compression": "gz"},
    output_args={"format": "null"},
    inspector=v,
)
errors = v.get_errors()
# KGX false positive: its importer (kgx_utils.is_property_multivalued via the toolkit) turns in_taxon into a
# list on read, then the validator rejects the list because Biolink 4.4.6 declares `in taxon` single-valued.
# We write a single string, so this one message is dropped and reported separately.
KNOWN = ["Single-valued node property 'in_taxon'"]
ignored = {}
for by_type in errors.values():
    for etype, msgs in by_type.items():
        for m in [m for m in msgs if any(m.startswith(k) for k in KNOWN)]:
            ignored[m] = len(msgs.pop(m))
for lvl in list(errors):
    errors[lvl] = {t: m for t, m in errors[lvl].items() if m}
    if not errors[lvl]:
        del errors[lvl]
with open(report, "w") as fh:
    json.dump(errors, fh, indent=1, default=lambda o: sorted(o) if isinstance(o, set) else str(o))
summary = {lvl: {etype: sum(len(ids) for ids in msgs.values()) for etype, msgs in by_type.items()} for lvl, by_type in errors.items()}
print(json.dumps({"ignored_known_kgx_false_positives": ignored, "added_local_prefixes": sorted(local - set(Validator.get_all_prefixes(v.jsonld))), "summary": summary}, indent=1))
n_err = sum(summary.get("ERROR", {}).values())
sys.exit(1 if n_err else 0)
