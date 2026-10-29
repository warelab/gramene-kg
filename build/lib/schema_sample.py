"""Validate the kg30 edge sample against the LinkML-generated JSON Schema (GrameneAssociation)."""
import json, sys
from jsonschema import Draft202012Validator
schema = json.load(open(sys.argv[1]))
# LinkML 1.12 gen-json-schema bug: for the multivalued type designator `category` it puts the enum
# on the array instead of on its items, so no value can validate. Move it to items.
for d in schema["$defs"].values():
    cat = d.get("properties", {}).get("category")
    if cat and "enum" in cat and "array" in (cat.get("type") or []):
        cat.setdefault("items", {})["enum"] = cat.pop("enum")
sample = json.load(open(sys.argv[2]))
root = {"$defs": schema["$defs"], "$ref": "#/$defs/GrameneAssociation"}
v = Draft202012Validator(root)
errors = {}
for rec in sample:
    for e in v.iter_errors(rec):
        key = f"{'/'.join(map(str, e.path)) or '<root>'}: {e.message[:160]}"
        errors[key] = errors.get(key, 0) + 1
for k, n in sorted(errors.items(), key=lambda x: -x[1])[:15]:
    print(f"  {n:5d}  {k}")
print(f"schema sample: {len(sample)} edges, {sum(errors.values())} errors")
sys.exit(1 if errors else 0)
