# gramene-kg browse UI

Static browser UI for the `/kg/v1` read API. Plain HTML + ES modules + CSS: no build step, no npm
dependencies, no CDN, no external fonts.

## Serving

Serve this directory at `/kg/ui/` (with the trailing slash; redirect `/kg/ui` → `/kg/ui/`), and return
`index.html` for `/kg/ui/` itself. Every other file is fetched by path. Routing uses the URL hash, so the server
needs no client-route support:

| Hash | Page |
|---|---|
| `#/search?q=&category=&genome=&source=&start=` | full-text search with facets, exact-id matches, paging |
| `#/node/<encodeURIComponent(curie)>` | node header, card, attributes, aliases, edge groups with provenance |
| `#/release[?id=<release>]` | release/build, counts, manifest (datasets, distributions, analyses, software) |

API calls are relative: `new URL('../v1/', location.href)`, so `/kg/ui/` talks to `/kg/v1/`.

## Files

| File | Role |
|---|---|
| `index.html` | shell: header (nav, search box, current release), `<main>`, live region |
| `app.js` | hash router, header release badge, focus management |
| `api.js` | fetch wrapper (`ApiError` carries `status` + `hint`) |
| `lib.js` | pure helpers (hash parse/build, formatting, link rules) + `h()` DOM builder |
| `ui.js` | shared view helpers (error box, badges, sections) |
| `search.js`, `node.js`, `release.js` | the three pages |
| `style.css` | layout, light/dark via `prefers-color-scheme` |

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
