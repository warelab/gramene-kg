# gramene-kg browse UI

Static browser UI for the `/kg/v1` API. Plain HTML + ES modules + CSS: no build step, no npm dependencies, no
external fonts, no CDN code: the Firebase JS SDK for the curate pages is vendored in `vendor/firebase/` (below).

## Serving

Serve this directory at `/kg/ui/` (with the trailing slash; redirect `/kg/ui` → `/kg/ui/`), and return
`index.html` for `/kg/ui/` itself. Every other file is fetched by path. Routing uses the URL hash, so the server
needs no client-route support:

| Hash | Page |
|---|---|
| `#/search?q=&category=&genome=&source=&start=` | full-text search with facets, exact-id matches, paging |
| `#/node/<encodeURIComponent(curie)>` | node header, card, attributes, aliases, edge groups with provenance |
| `#/release[?id=<release>]` | release/build, counts, manifest (datasets, distributions, analyses, software) |
| `#/curate` | anonymous: sign-in prompt and the public workspaces; signed in: who you are (site curator badge), your workspaces and public ones, create a workspace |
| `#/curate/ws/<id>[?state=]` | workspace (public ones without sign-in): assertions by state, curated nodes, who may publish, new curated node, new assertion (owner who is a site curator: public/private toggle) |
| `#/curate/assertion/<id>[?rev=]` | one revision: statement, evidence lines, review events, revision history; submit / publish / reject / retract / edit by role |

API calls are relative: `new URL('../v1/', location.href)`, so `/kg/ui/` talks to `/kg/v1/`.

## Files

| File | Role |
|---|---|
| `index.html` | shell: header (nav, search box, current release), `<main>`, live region |
| `app.js` | hash router, header release badge, focus management |
| `api.js` | fetch wrapper (`ApiError` carries `status` + `hint`) |
| `lib.js` | pure helpers (hash parse/build, formatting, link rules) + `h()` DOM builder |
| `ui.js` | shared view helpers (error box, badges, sections) |
| `search.js`, `node.js`, `release.js` | the three read pages (`node.js` also has the curated panel) |
| `auth.js` | Firebase sign-in (Google), dev test tokens, the Bearer token provider for `api.js` |
| `curate.js` | the curate pages and forms; predicate allow-list |
| `picker.js` | CURIE input with autocompletion (`/resolve` + `/search` + the workspace's curated nodes) |
| `style.css` | layout, light/dark via `prefers-color-scheme` |
| `vendor/firebase/<version>/` | the Firebase SDK modules, same origin; `SHA256SUMS` and `README.md` (source URLs, upstream hashes, the one rewrite) |
| `csp.json` | the `Content-Security-Policy` header value for every `/kg/ui/*` response (sent by `apps/api/server.mjs`) |

## Conventions

- API text is only ever inserted as text nodes or attribute values via `h()`; nothing uses `innerHTML`.
  Only `http:`/`https:` URLs become external hrefs.
- Links: CURIEs → `#/node/...`; `PMID:` → PubMed, `doi:` → doi.org; xrefs that are URLs open externally.
- Edge groups come from `node.degree` (`"<predicate>|<dir>": n`). A group loads only when expanded
  (`/node/:curie/edges?predicate=&direction=&limit=50`), then follows `meta.next` with "Load more".
  "show negated edges" re-creates the groups with `include_negated=1`.
- `409` on a node shows the candidates parsed from the error hint; `404` offers a search instead.
  A node reached by alias has its hash replaced with the canonical id.

## Local testing

Any static server plus a proxy for `/kg/v1/*` works, for example a 30-line Node `http` server that serves this
directory under `/kg/ui/` and pipes `/kg/v1/*` to `localhost:12000`.

## Curate pages (docs/curation.md)

- **Sign-in**: Firebase Auth, project `gramene-auth`, Google provider, popup. The SDK (`firebase-app.js`,
  `firebase-auth.js`, version pinned in `auth.js`, currently 12.19.0 of 2026-09-09) is vendored in
  `vendor/firebase/<version>/` (sha256 in `vendor/firebase/SHA256SUMS`; `firebase-auth.js`'s import of
  `firebase-app.js` rewritten to `./firebase-app.js`, see `vendor/firebase/README.md`) and imported from this origin
  only on a `#/curate` page or when this browser signed in before (`localStorage['kg.auth']`); anonymous browsing
  loads nothing extra and sends no token. The web config in `auth.js` is gramene-auth's public browser config (the
  values the g2p UI ships); it is not a credential. The page's host must be in the project's Firebase *authorized
  domains* for the popup to work (`localhost` is by default).
- **CSP**: `csp.json` holds the exact header (`{header, value}`) the API sends on `/kg/ui/*`: scripts from `'self'`
  and `https://apis.google.com` (loaded by firebase-auth for the popup), `connect-src 'self' https://*.googleapis.com`,
  frames `https://gramene-auth.firebaseapp.com` and `https://accounts.google.com`, no objects, no inline scripts.
  Anything new the UI loads from elsewhere must be added there.
- **Token**: `api.js` asks `auth.js` for a token on every call and sends `Authorization: Bearer <ID token>` when
  someone is signed in (`getIdToken()` refreshes it), so a signed-in user's node pages also show curated statements
  from private workspaces they can read. Signing in or out re-renders the current curate or node page.
- **Test sign-in (dev servers only)**: a "Test sign-in" panel, where an HS256 test token (`{uid, email}` signed with
  `KG_AUTH_TEST_SECRET`, e.g. from `signTestToken` in `apps/api/auth.mjs`) is pasted, appears only when
  `GET /kg/v1/curate/me` reports `auth_test_mode: true` (top level, `meta` or `data`, on the 401 too). The token
  is kept in `sessionStorage` (this tab) and dropped on load if the server no longer reports test mode. The
  server stays the authority: production never accepts HS256 tokens.
- **Anonymous reading**: public workspaces and their assertions (with evidence, history and review events) open
  without sign-in (the API serves them anonymously; `/curate/me` is not called). `#/curate` shows the sign-in prompt
  and the public workspaces. A ws/assertion that answers 404 anonymously gets the sign-in prompt (it may be private).
- **Roles** come from the workspace's `role` field (or owner / user ACL entries); they only decide which buttons
  show: contributor: edit (draft, rejected), submit; curator: publish, reject (reason), retract (reason). The API
  enforces every check; a 404 is shown as "Not found".
- **Site curators** (`GET /curate/me` → `site_role: 'site_curator'`; `kg_curation.site_roles`): in a **public**
  workspace only a site curator sees publish / reject / retract (and needs no workspace role for them); workspace
  curators and owners do not. Private workspaces keep the workspace roles. The public/private toggle shows only to
  an owner who is a site curator, and the "public" choice of the new-workspace form is disabled for everyone else.
  Workspace and assertion pages say who may publish; home and role lines carry a `site curator` badge.
- **Membership**: "Your workspaces" lists workspaces you own or hold an ACL role in; others' public workspaces go
  under "Public workspaces". The API's `role` says `reader` for every public workspace, so the UI decides from an
  explicit `member` flag if the API sends one, else owner / ACL (user or one of `me.orgs`), else a role above
  `reader` (non-owners get no `acls`, so an ACL *reader* on a public workspace is listed as public only).
- **Curated nodes are per workspace** (`kg_curation.curated_nodes` `_id` `<ws>|<curie>`): the workspace page lists
  them by CURIE (`curie`, or the id with the `<ws>|` prefix removed); the node page shows `attributes.curated.<ws>`
  as a "Curated records" section, one block per workspace (name, description, xrefs, attrs, rev), and leaves it out
  of the generic attribute table. `curation` may be one `{workspace, rev}` or a list of them.
- **Predicates**: the select takes the allow-list from the API if it exposes one (`GET curate/predicates` or
  `curate/config`); the API does not today, so `FALLBACK_PREDICATES` in `curate.js` is a copy of
  `config/curation.yaml`'s `predicates` (with domain/range) — **update it when that file changes**.
- **Refused drafts**: a 409 (ambiguous) or 422 (does not resolve) lists `candidates` with "use as subject/object".
- **Node page**: a "Curated statements" panel lists edges with `source=infores:sorghumbase-curation` in both
  directions (loaded at once up to a node degree of 50,000, on request above that); curated edges in the edge groups
  and curated nodes carry a purple `curated` badge and link to their assertion / workspace.
- Every DOM write goes through `h()` / `fill()` (`fill` skips null; `replaceChildren(null)` would print "null").

## Testing

No headless browser on this host. `/scratch/olson/gramene-kg/tmp/m3-ui/` holds the harness used for M3: happy-dom
(21.0.4, installed there only, not a dependency of this repo) as the DOM, a module hook that records and blocks
any network (`https:`) import, an in-memory mock of the curate API, and `run2.mjs` / `extra.mjs`, which drive the
pages (sign-in, create, autocompletion, state machine, roles, node page). `uifix.mjs` (mock shaped like the API:
site roles, public `reader` role, `<ws>|<curie>` node ids, per-workspace node records) covers site curators,
membership, anonymous reading and the curated records; `realfix.mjs` repeats membership and anonymous reading against
a dev API (`KG_URL=… KG_SECRET_FILE=…`).
`KG_URL=http://127.0.0.1:<dev port> KG_SECRET=<test secret> INJECT_FLAG=1 node run2.mjs` runs the same flow against
a dev API started with `KG_AUTH_TEST_SECRET` and `KG_CURATION_DB=kg_curation_test_<name>`.
