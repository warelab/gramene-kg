# Curated layer (M3): contract

The ETL graph is rebuilt per release. The curated layer is the only part people write, and the only
non-reproducible data, so it lives in its own db (`kg_curation`), is backed up nightly (bin/kg-backup), and
reaches a build in two ways: the API shows published assertions immediately, and the next build bakes them
into Parquet, Mongo, Solr and KGX. Curators never edit ETL nodes or edges.

## Auth and roles

- Firebase ID tokens of project `gramene-auth` (the SorghumBase/Gramene sign-in), sent as
  `Authorization: Bearer <id token>`. The API verifies them with `firebase-admin` initialised with
  `projectId: 'gramene-auth'` only: Google's public keys, no service-account file.
- Test tokens, for dev servers only: when `KG_AUTH_TEST_SECRET` is set, HS256 JWTs signed with it
  (`{uid, email, exp, iat?}`) are accepted too. `exp` is required, must be in the future and at most 1 h
  ahead; `iat`, when present, must not be in the future. The server refuses to start with
  `KG_AUTH_TEST_SECRET` and `NODE_ENV=production` together (pm2 `gramene-kg-api` never sets it), and with
  test tokens on it listens on 127.0.0.1 unless `KG_HOST` says otherwise (then it logs a warning).
- Permission unit: the **workspace** (g2p's "dataset"). Roles per (user, workspace): owner > curator >
  contributor > reader, from the vendored g2p policy (`packages/policy`, copied from
  `gramene-g2p/packages/policy/src/index.ts`; all checks go through `assertRole` / `readableDatasetFilter`).
  - any signed-in user may create a **private** workspace (they become its owner);
  - reader: read a private workspace; contributor: create/edit drafts, submit;
  - curator: publish, reject, retract; owner: also ACL and visibility.
- **Site curators** gate the public graph (below): in a **public** workspace publish, reject and retract
  need a site curator, and making a workspace public (creating it public, or PATCH `visibility: public`)
  needs an owner of it who is also a site curator. Private workspaces keep the workspace roles unchanged.
- Public workspaces are readable anonymously. Anything not readable is a **404**, never a 403 (no
  existence leak).
- **Identities shown.** Members of a workspace (its owner, or anyone with a user or org ACL entry) see raw
  uids in its `owner`, `created_by`, `updated_by`, `revisions[].updated_by` and review events' `by`. Anyone
  else (anonymous callers, signed-in non-members reading a public workspace, a site curator without a role
  there) sees the user's `display_name` when `display_opt_in` is true, else the pseudonym
  `user-<sha256("<workspace id>|<uid>"), first 12 hex>`: stable within a workspace, different across
  workspaces. Workspaces carry `member: true|false` for the caller.

### Site curators

`kg_curation.site_roles` lists them: `{_id: <uid>, role: 'site_curator', email, added_by, added_at}`. There
is no API route to edit it; the operator adds the first one (and any later one) by hand, e.g.

```
mongosh kg_curation --eval 'db.site_roles.insertOne({_id: "<firebase uid>", role: "site_curator",
  email: "<email>", added_by: "<operator>", added_at: new Date().toISOString()})'
```

and removes one with `db.site_roles.deleteOne({_id: "<uid>"})`. The uid is the one `GET /curate/me` returns
for that person. `GET /curate/me` gives the caller's `site_role` (`'site_curator'` or null).

| action | private workspace | public workspace |
|---|---|---|
| submit, edit drafts | contributor | contributor (the site role adds nothing) |
| publish, reject, retract | curator | **site curator** (with or without a role in the workspace); workspace curators and owners who are not site curators get 403 |
| make public (create public, PATCH `visibility: public`) | owner **and** site curator | (already public) |
| write a curated node record (POST `/nodes`) | contributor | **site curator** (with or without a role in the workspace): a record is public as soon as it is written, there is no publish step |
| make private, rename, ACL | owner | owner |

So a workspace's statements enter the public graph only after a site curator made the workspace public
(and so vouched for what it already holds) or published them there. A site curator who should make someone
else's workspace public is first given the `owner` ACL role on it by its owner.

## Mongo: db `kg_curation`

Written only by the API's write client, which is bound to this db name and asserts it at startup.
Build stages only read it. Every doc carries `created_at`/`updated_at` (ISO strings) and `created_by` (uid).

| collection | `_id` | fields |
|---|---|---|
| `workspaces` | `ws_<12 hex>` | name, description, ownerUid, visibility `private`/`public`, acls `[{principal:{type:'user'|'org', id}, role}]` (g2p Dataset shape) |
| `users` | uid | email, display_name, display_opt_in (bool, default false), last_seen |
| `site_roles` | uid | role `site_curator`, email, added_by, added_at (operator-edited; see above) |
| `curated_nodes` | `<workspace>\|<CURIE>` | curie, workspace (unique `{curie, workspace}`), cls (`GramenePublication`, `AnalysisRun`, `KgCollection`, `Association`), name, description, xrefs[], attrs{}, rev, content_sha256; Association records also assertion, assertion_rev |
| `assertions` | `<asn id>@<rev>` | id `asn_<12 hex>`, rev (1..), latest (bool), workspace, state, subject, predicate, object, qualifiers{}, negated, evidence `[{publications[], has_evidence[], knowledge_level, note}]`, note, disputes (edge id or null), supersedes (`<id>@<rev>` or null), association_id (or null), edge_id, content_sha256 |
| `review_events` | ObjectId | assertion, rev, from, to, by, at, reason |
| `attach_reports` | `<release>@<build>` | release, build, created_at, unresolved `[{assertion, rev, curie, role:'subject'|'object', suggestions[<=5]}]` |
| `audit` | ObjectId | at, uid, action, target, detail |

- **Revisions are append-only.** Any edit or state change inserts `<id>@<rev+1>` with `latest:true`,
  then derives the Association node (below), then sets the previous revision `latest:false` (no
  transactions). The insert is the arbiter: a concurrent change that loses it (the `<id>@<rev+1>` `_id`
  exists) is a **409** and has changed nothing; if deriving the node fails, the inserted revision is
  removed again before the error is returned. Readers take the **highest rev** per assertion, never
  `latest:true` alone (two revisions are `latest:true` for a moment, or for good if the process dies
  between the writes): workspace listings, their `total` and the per-state counts group by assertion id
  in an aggregation and keep the highest revision. `content_sha256` = sha256 of the canonical JSON of the
  semantic fields (subject, predicate, object, qualifiers, negated, evidence, note, disputes).
- **States:** `draft → submitted → published | rejected`; `rejected → draft` (edit); `published →
  retracted` (reason required). Only drafts are editable; a correction to a published assertion is a
  new assertion with `supersedes`.
- **Predicates** come from the allow-list in `config/curation.yaml` (with domain/range classes where
  Biolink gives them). Subject and object must resolve in the current build (`/resolve` rules) **or** be
  a curated node; otherwise the API refuses the draft with candidates, except that a published assertion
  whose CURIE disappears in a later build is reported in `attach_reports`, not deleted.
- **Association node:** an assertion with 2 or more evidence lines (or extra participants) gets a
  curated node `gramene.assoc:<sha256-24 of subject|predicate|object|assertion id>` (record
  `<workspace>|gramene.assoc:…`) with `attrs:{subject, predicate, object, qualifiers}`; its edge `_id`
  equals the association id. It is derived from the assertion's **highest** revision after each insert:
  upserted when that revision has an association id, any other Association node of the assertion
  deleted. Node writes carry `assertion_rev` and only replace an older one, and the derivation re-reads
  the highest revision until it did not move, so after concurrent edits the node exists exactly when
  the highest revision has two or more evidence lines.
- **Curated nodes are per workspace.** `POST /curate/workspaces/:ws/nodes` writes this workspace's record
  of a CURIE (`_id` `<ws>|<curie>`); the same CURIE may be curated in any number of workspaces, and there
  is no cross-workspace check (no 409, no existence oracle). Writes are optimistic: a create is an insert
  (a concurrent create of the same record loses on the `_id`: 409), an update is a `findOneAndUpdate`
  conditional on the revision read (409 when it moved). The body may carry `rev`, the revision the change
  is based on (0 = new); a different current revision is a 409. A 409 changes nothing.
- **disputes** names an edge of the build, or the edge of a published assertion (its highest revision)
  of the same workspace or of a public one. Anything else, a private workspace's edge included, is the
  same 422 as an unknown id, so no private edge id is confirmed or copied into another workspace.
- **Edge identity:** curated edge `_id` = `gramene.assoc:` + sha256-24 of
  `subject|predicate|object|infores:sorghumbase-curation|<qualifiers json>|<assertion id>`. Provenance:
  `primary_knowledge_source infores:sorghumbase-curation`, `agent_type manual_agent`, `knowledge_level`
  from the evidence (default `knowledge_assertion`), `has_evidence` and `publications` from the
  evidence lines, `layer: 'curated'`, `asn: {id, rev}`.

## API: `/kg/v1/curate/*`

| method | route | role |
|---|---|---|
| GET | `/curate/me` (incl. `site_role`) | signed in |
| POST/GET | `/curate/workspaces` (GET lists readable ones; POST public: site curator) | signed in / any |
| GET, PATCH | `/curate/workspaces/:ws` (PATCH to public: owner + site curator) | reader / owner |
| PUT | `/curate/workspaces/:ws/acl` | owner |
| POST/GET | `/curate/workspaces/:ws/nodes` (Publication nodes enriched from `kg_meta.publication_cache`) | contributor / reader |
| POST/GET | `/curate/workspaces/:ws/assertions?state=` | contributor / reader |
| GET, PATCH | `/curate/assertions/:id` (`?rev=` for history) | reader / contributor (drafts only) |
| POST | `/curate/assertions/:id/{submit,publish,reject,retract}` (reason for reject/retract) | contributor / curator; in a public workspace publish, reject, retract: site curator |
| GET | `/curate/assertions/:id/events` | reader |
| GET | `/curate/reports?release=` | any (public workspaces' entries only unless reader) |

Errors use the API's envelope (`{error, hint, ...}`), 401 without a token where one is required, 404
for anything unreadable.

## Read side (existing routes)

- `/node/:curie`, `/node/:curie/edges`, `/edge/:id` and GraphQL show curated edges with
  `layer:'curated'` and `curation:{assertion, rev, state, workspace}`:
  - baked curated edges (in the build) whose `asn.{id, rev}` is still the latest published revision;
  - plus assertions published after the build was made (read live from `kg_curation`);
  - minus baked edges whose assertion was since retracted or superseded.
- Visibility: anonymous callers see public workspaces only; a signed-in caller also sees workspaces
  they can read. Anonymous reads use a cache (at most 10 s) of the public workspace ids and of the time
  of the last published/retracted change in them; the API process drops it on each of its own curation
  writes, so its changes show at once (another process's within 10 s).
- Every overlay query is served by an index (`explain()` shows IXSCAN; the list is in docs/api.md
  "Mongo"), so the cost does not grow with the revision history.
- `degree` is adjusted for the union and the masking, and `meta.warnings` says
  `curated counts as of build <id>` wherever Solr/card fields cannot reflect post-build changes.
- Curated nodes (Publication, Analysis, Collection, Association) resolve through `/node/:curie` the
  same way. All **visible** records of a CURIE are merged (`/node`, GraphQL `node`/`nodes`, edge
  end-points): each under `attributes.curated.<workspace>` as `{source, rev, content_sha256, cls, name,
  description, xrefs, attrs}` (null fields left out, the build's shape). A CURIE not in the build takes
  class and top-level attrs from its oldest visible record (created_at, then workspace id), name and
  description from the first non-empty one in that order, xrefs from all, and `curation: {workspace, rev,
  workspaces[]}`. A build node keeps its ETL fields; its `attributes.curated` is replaced by the caller's
  visible records (baked entries of workspaces the caller cannot read are dropped) and left out when there
  are none.
- A baked node made from curated records alone (an Association node, or a node the build marks
  `attrs.curated_only: true`) none of whose records the caller can see, e.g. because its workspace went
  private after the build, is treated as absent: 404 on `/node`, null in GraphQL, left out of `/search`
  rows and `/resolve` results, no end-point node on edges. Search `total` and facets still count it until
  the next build.
- A curated self-loop (subject = object) is listed twice by `/node/:curie/edges`, direction `out` and
  `in`, before the build as after it, matching `degree` (out 1, in 1).

## Build side

- **kg20** reads `kg_curation` (highest revision, `state: published`, public workspaces only) as a source:
  curated node records merge per CURIE, each public workspace's record under `attrs.curated.<ws>`, into
  existing nodes (a curated Publication adds to the ETL one, never replaces it); a node created from curated
  records alone carries `attrs.curated_only: true` (the read side hides it when none of its records is
  visible any more);
  curated edges get the ids above, unresolved CURIEs go to `attach_report.json` and to
  `kg_curation.attach_reports` (written by the build's own short-lived client, the one exception to
  "stages only read"; documented in docs/operations.md).
- **kg30** gates: no duplicate edge ids including curated ones; every curated edge has `asn`; every
  curated edge's assertion is published and latest.
- **kg50** writes curated edges to KGX like any other source (`infores:sorghumbase-curation` file), and
  also, only them, to `kgx/by_layer/<prefix>_curated_edges.tsv.gz` / `.jsonl.gz` (listed in `manifest.json`
  `kgx.by_layer.curated` and the RO-Crate; `counts.edges_by_layer` is always written). The
  `infores:sorghumbase-curation` file also holds CSHL ETL edges, so a check for curated edges uses the
  by_layer file or `gramene:layer == curated`.
- **Hook** `subsites/sorghum/v11/build/stages/80_kg.sh` + a phony Makefile target `80_kg`, not in `all`;
  the script checks `is_done 65_solr_suggestions && is_done 22_germplasm`, clears the stamp and runs
  `env -u MYSQL_PASS -u MYSQL_USER -u MYSQL_HOST make -C /usr/local/gramene/gramene-kg/build
  RELEASE_ROOT=$RELEASE_ROOT NEW_BUILD=1 build`, so every run starts a new kg build (published curation
  changes no stamp); `KG_RESUME=1 make 80_kg` resumes a failed kg build instead. `.state/80_kg.done` only
  records that the last run succeeded; the `refresh-*` targets remove it (the KG predates the refreshed
  release data). See docs/operations.md.
