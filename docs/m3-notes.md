# M3 notes: curated layer, build hook, public exposure

Built, reviewed and deployed on 2026-11-04. The contract is docs/curation.md. The API on :12000 (public
at https://data.sorghumbase.org/kg) serves the curation routes; nothing curated is public yet.

## Delivered

| piece | where |
|---|---|
| auth | `apps/api/auth.mjs`: Firebase ID tokens of `gramene-auth`, verified with the project id only (Google's public keys; no service-account file). Dev-only HS256 test tokens (`KG_AUTH_TEST_SECRET`, must expire within 1 h, refused with `NODE_ENV=production`, dev server forced to 127.0.0.1). |
| policy | `packages/policy/index.mjs`, vendored from gramene-g2p (owner > curator > contributor > reader per workspace), plus **site curators** (`kg_curation.site_roles`) |
| write client | `apps/api/curation-db.mjs`: bound to `kg_curation` (or `kg_curation_test*`), refuses any other db, creates its indexes |
| routes | `apps/api/curation.mjs`: workspaces, ACLs, curated nodes, assertions with append-only revisions, submit / publish / reject / retract, events, reports, `/curate/predicates`, `/curate/me` |
| read side | `apps/api/core.mjs`: curated edges in `/node`, `/node/:curie/edges` (a fifth paging phase `cur`), `/edge/:id`, `/path`, `/search`, `/resolve` and GraphQL, with visibility per caller, retract/supersede masking and degree adjustment |
| build | `build/lib/curated.mjs` (kg20): reads public workspaces' latest published records, snapshots them into `extract/snapshots/kg_curation.json` (a Dataset/Distribution), merges curated nodes under `attrs.curated.<ws>`, writes curated edges and `attach_report.json`; kg30 gates; kg50 writes `kgx/by_layer/*_curated_edges.*` |
| v11 hook | `subsites/sorghum/v11/build/stages/80_kg.sh` and a phony `80_kg` target (not in `all`, no stamp prerequisites): checks `65_solr_suggestions` and `22_germplasm`, then starts a NEW kg build with the MySQL variables unset (`KG_RESUME=1` resumes instead). Uncommitted, like the rest of that tree's pending changes. |
| UI | `apps/ui/curate.js`, `auth.js`, `picker.js`: Google sign-in, workspaces, nodes, assertions with resolver-backed pickers, history and actions by role; a curated panel on node pages. Firebase JS SDK 12.19.0 vendored under `apps/ui/vendor/firebase/` with SHA256SUMS; `/kg/ui/*` is served with a Content-Security-Policy (`apps/ui/csp.json`). |
| backups | `bin/kg-backup` now dumps kg_curation too; first archive `kg_curation-20261104T162712.archive.gz` |

## User decisions

- **Site curators only** publish into the public graph. In a public workspace, publish, reject, retract
  and writing a curated node record need a site curator; making a workspace public needs an owner who is
  a site curator. Private workspaces keep the g2p roles. First site curator: olson.cshl.edu@gmail.com
  (uid `F4mjPxYxbiguvNFS94OOQcmIQDR2`), added 2026-11-04.
- Curated nodes are **per workspace** (`_id` `<ws>|<curie>`): the same PMID may be curated in several
  workspaces with no cross-workspace check or existence oracle.

## Verified

- Real Firebase token, through the public URL (`/scratch/olson/gramene-kg/tmp/m3-e2e/e2e.mjs`, 14/14):
  a custom token for the throwaway user `kg-e2e-test` was exchanged for an ID token; `/curate/me`;
  401 without or with a tampered token; 403 for a public workspace without the site role; private
  workspace → draft `PMID:29712755 biolink:mentions gxa.expt:E-MTAB-5956` → submit → publish; the owner
  sees the edge with `provenance.layer: curated`, state published; anonymous sees nothing and gets 404 on
  the assertion; review events carry who and when. The test user and its data were deleted.
- `test/curation.test.mjs` 19/19 (every route, transition and role boundary; site-curator rules;
  per-workspace nodes; concurrency; Association nodes; masking; write-client refusal); eval 60/60;
  42 anonymous URLs byte-identical to the pre-M3 API with an empty kg_curation.
- Build side on fixture data against the live Parquet: curated nodes/edges/attach report as specified;
  with an empty kg_curation the outputs are unchanged.
- `make -n 80_kg` in the v11 tree prints only `bash stages/80_kg.sh`; `make -n all` does not mention it.

## Review

Four reviewers (authz, state/revisions, build, UI/ops) reported findings that an adversarial verifier
checked: 21 confirmed. After fixes, a re-verification confirmed every one fixed and found five more,
also fixed:

- Most serious: two workspaces creating the same curated node at once both got 2xx and the second
  silently took it over; and any Google account could publish into the public graph unreviewed. Fixed
  by per-workspace node records and the site-curator rule.
- Also fixed: lost updates on concurrent node edits (now optimistic, 409), Association nodes written
  before the revision that won, listings that counted a revision twice, a live self-loop counted twice,
  disputes as an existence oracle, raw uids shown to non-members (now display names on opt-in or an
  opaque per-workspace label), test tokens without expiry, overlay queries scanning the whole
  collection (now indexed and cached for 10 s), `80_kg` that did nothing after the first run, stale
  attach reports, ETL xref order changed by merging, curated edges indistinct in KGX.

## Open

- **A rebuild has not been run with this code.** It was held because another session was running a
  grapevine v5 build stage. With kg_curation holding no public content, it should reproduce build
  202611041048 except for provenance records; run `NEW_BUILD=1 make -C build RELEASE_ROOT=… build` when
  the trees are idle. Baking real curated content needs a public assertion published by a site curator.
- **Plan checks to read differently:** `zgrep -c infores:sorghumbase-curation kgx/*_edges.tsv.gz` passes
  on 174 ETL edges alone; check `kgx/by_layer/*_curated_edges.*` instead. A dangling CURIE such as
  `gramene.genetree:SB10GT_1` is refused at draft time (422 with candidates) rather than appearing in
  `/curate/reports`, which lists only published assertions whose CURIE disappeared in a later build.
- `make -n` on the **gramene-kg** `build` target is not a dry run (its recipe uses `$(MAKE)`, so the
  stages run); an integration agent started kg00 that way and it stopped at the read-only gates with no
  effect but 13 log lines. The v11 `make -n 80_kg` is safe.
- Not in the UI yet: the ACL editor and the reports view. No rate limits on workspace or assertion
  creation. Google sign-in in a real browser under the CSP, and `data.sorghumbase.org` as an authorized
  Firebase domain, are untested.
- Hiding a workspace that was baked public leaves its curated xrefs on merged nodes and its counts in
  `/search` facets until the next build (attrs.curated and the edges are hidden at once).
- The live gramene-mcp still lacks the kg tools: fold the staging `kg-tools` branch in at its next
  scheduled restart.
- The backup cron entry is still not installed (docs/backups.md has the line, now with
  `KG_BACKUP_REQUIRE_CURATION=1`).
- Not ours: the v11 Makefile's uncommitted JGI-expression change makes `58_expression_attributes` depend
  on a `57_jgi_expression` stamp that does not exist, so `make all` there would rerun 57 → 58 → 60 → 65.
