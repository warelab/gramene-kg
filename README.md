# gramene-kg

Knowledge graph over Gramene / SorghumBase data: data objects, collections, analyses,
annotations and publications as nodes; typed, attributed, provenance-bearing edges.

- Plan: `docs/plan.md` (approved 2026-10-29). Design background: `docs/design.md`,
  corrections: `docs/design-review.md` (the plan and the review win where they disagree).
- Schema: `schema/gramene_kg.yaml`, a LinkML profile of Biolink 4.4.6 (vendored in `schema/vendor/`).
- Build: `make -C build RELEASE_ROOT=/usr/local/gramene/subsites/sorghum/v11 build`
  (artifacts under `/scratch/olson/gramene-kg/builds/<release>/<BUILD_ID>/`).
- Toolchain: Node 24 (`npm install`), `.venv` (LinkML + DuckDB), `.venv-kgx` (KGX validator).
  `jq` is not installed on squam; use `bin/kgq '<js expr over j>'`.
