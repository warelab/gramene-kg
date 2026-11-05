# Vendored Firebase JS SDK (ES modules)

The curate pages sign in with Firebase Auth (project `gramene-auth`). The two SDK modules they import are served
from this directory (same origin) instead of being fetched from gstatic at runtime: `import()` cannot carry
Subresource Integrity, so a CDN response would otherwise run unchecked on the page that holds the curators'
ID tokens (finding ui-ops#5). `apps/ui/csp.json` then allows scripts only from `'self'` plus the Google
sign-in script host.

| file | source URL | upstream sha256 |
|---|---|---|
| `12.19.0/firebase-app.js` | https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js | `39a50952b5def557337b2290069c7d7371f3515ad46c44a43b9c520f734d8d14` |
| `12.19.0/firebase-auth.js` | https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js | `59f60ce3adcb4c85a5260e963fd14134eec088de5b18ddfb9e95771c72f65264` |

- Version **12.19.0** (published 2026-09-09; gstatic `last-modified: Thu, 10 Sep 2026 17:38:49 GMT`), downloaded
  2026-11-04. Same version as `FIREBASE_VERSION` in `apps/ui/auth.js`.
- `firebase-app.js` is byte-identical to upstream.
- `firebase-auth.js` has one change: its only import, `from"https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js"`,
  now reads `from"./firebase-app.js"`, so both modules load from here and share one module instance. Reproduce with
  `sed 's#from"https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js"#from"./firebase-app.js"#'`.
- `SHA256SUMS` holds the hashes of the files as vendored (check with `cd apps/ui/vendor/firebase && sha256sum -c SHA256SUMS`).
- The `sourceMappingURL` comments are left as they are; the `.map` files are not vendored (devtools only).

At runtime `firebase-auth.js` still loads `https://apis.google.com/js/api.js` (the popup/iframe helper) and
talks to `*.googleapis.com` (identitytoolkit, securetoken), with the `gramene-auth.firebaseapp.com` auth iframe
and `accounts.google.com`; `apps/ui/csp.json` allows exactly those.

## Upgrading

1. Pick a release at least two weeks old; download both files into a new, empty directory.
2. Record the upstream sha256 of each file in the table above, apply the `sed` rewrite to `firebase-auth.js`
   (check `grep -c gstatic` is 0 afterwards and that it has no other absolute imports), copy them to
   `<version>/`, and regenerate `SHA256SUMS` (`sha256sum <version>/firebase-app.js <version>/firebase-auth.js`).
3. Change `FIREBASE_VERSION` in `apps/ui/auth.js`, delete the old version directory, and run the UI tests.
