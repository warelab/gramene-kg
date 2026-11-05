// Sign-in for the curate pages: Firebase Auth (project gramene-auth, Google provider), plus dev-only HS256 test
// tokens when the API says it runs in auth test mode. The ID token goes out as `Authorization: Bearer` via
// api.js's token provider. The Firebase SDK is vendored (vendor/firebase/<version>/, sha256 in its SHA256SUMS) and
// served from this origin; it is loaded only on a curate page or when this browser signed in before
// (localStorage 'kg.auth'), so anonymous browsing loads nothing extra.
import { api, setTokenProvider } from './api.js';
import { jwtPayload } from './lib.js';

export const FIREBASE_VERSION = '12.19.0';                 // published 2026-09-09; vendor/firebase/README.md
// same-origin copies (no runtime CDN code: import() cannot carry SRI; csp.json allows script-src 'self')
const FB = new URL(`./vendor/firebase/${FIREBASE_VERSION}/`, import.meta.url).href;
// PUBLIC web config of gramene-auth (the same values every SorghumBase/g2p page ships to browsers; not a credential)
export const FIREBASE_CONFIG = { apiKey: 'AIzaSyCyTJmxfWgfuhI6-8uqocSiE9KOWUlkgkk', authDomain: 'gramene-auth.firebaseapp.com', projectId: 'gramene-auth' };
const SIGNED_IN = 'kg.auth', TEST_TOKEN = 'kg.testToken';

const store = (kind) => ({
  get: (k) => { try { return globalThis[kind]?.getItem(k) ?? null; } catch { return null; } },
  set: (k, v) => { try { globalThis[kind]?.setItem(k, v); } catch { /* private mode */ } },
  del: (k) => { try { globalThis[kind]?.removeItem(k); } catch { /* private mode */ } },
});
const ls = store('localStorage'), ss = store('sessionStorage');

let user = null, fb = null, fbLoading = null, ready = null, testModeP = null;
const subs = new Set();
export const currentUser = () => user;
export const onAuthChange = (fn) => { subs.add(fn); return () => subs.delete(fn); };
function setUser(u) {
  const changed = (user?.uid ?? null) !== (u?.uid ?? null);
  user = u;
  if (changed) for (const f of subs) { try { f(u); } catch (e) { console.error(e); } }
}
const fromFirebase = (u) => ({ uid: u.uid, email: u.email ?? null, name: u.displayName ?? null, kind: 'firebase' });
const fromTest = (t) => { const p = jwtPayload(t); return p?.uid ? { uid: p.uid, email: p.email ?? null, name: p.name ?? null, kind: 'test' } : null; };

setTokenProvider(async () => {
  const t = ss.get(TEST_TOKEN);
  if (t) return t;
  return fb?.auth.currentUser ? fb.auth.currentUser.getIdToken() : null;   // refreshes an expired token itself
});

// the API reports auth test mode (KG_AUTH_TEST_SECRET set, never in production) on /curate/me, signed in or not
const flag = (b) => !!(b?.auth_test_mode ?? b?.meta?.auth_test_mode ?? b?.data?.auth_test_mode);
export function testMode() {
  testModeP ??= api('curate/me', {}, { auth: false }).then(flag, (e) => flag(e.body));
  return testModeP;
}

export function loadFirebase() {
  fbLoading ??= (async () => {
    const [A, Au] = await Promise.all([import(`${FB}firebase-app.js`), import(`${FB}firebase-auth.js`)]);
    const app = A.getApps().length ? A.getApp() : A.initializeApp(FIREBASE_CONFIG);
    const auth = Au.getAuth(app);
    fb = { Au, auth };
    await new Promise((res) => {
      let first = true;
      Au.onAuthStateChanged(auth, (u) => {
        if (!ss.get(TEST_TOKEN)) { setUser(u ? fromFirebase(u) : null); if (u) ls.set(SIGNED_IN, '1'); else ls.del(SIGNED_IN); }
        if (first) { first = false; res(); }
      });
    });
    return fb;
  })();
  fbLoading.catch(() => { fbLoading = null; });
  return fbLoading;
}

// resolves once the user (if any) is known; never rejects, never waits more than 8 s for the SDK
export function initAuth() {
  ready ??= (async () => {
    const t = ss.get(TEST_TOKEN);
    if (t) { if (await testMode() && fromTest(t)) setUser(fromTest(t)); else ss.del(TEST_TOKEN); }
    if (!user && ls.get(SIGNED_IN) === '1')
      await Promise.race([loadFirebase().catch(e => console.warn('Firebase unavailable:', e)), new Promise(r => setTimeout(r, 8000))]);
  })();
  return ready;
}

export async function signInGoogle() {
  const { Au, auth } = await loadFirebase();
  ss.del(TEST_TOKEN);
  const cred = await Au.signInWithPopup(auth, new Au.GoogleAuthProvider());
  ls.set(SIGNED_IN, '1');
  setUser(fromFirebase(cred.user));
}

// dev servers only: the token is checked by the server (/curate/me) before it is kept for this tab
export async function signInTest(token) {
  token = String(token ?? '').trim();
  if (!(await testMode())) throw new Error('this server is not in auth test mode');
  const u = fromTest(token);
  if (!u) throw new Error('not a JWT with a uid claim');
  ss.set(TEST_TOKEN, token);
  try { await api('curate/me'); } catch (e) { ss.del(TEST_TOKEN); throw e; }
  setUser(u);
}

export async function signOut() {
  ss.del(TEST_TOKEN); ls.del(SIGNED_IN);
  if (fb) await fb.Au.signOut(fb.auth).catch(() => {});
  setUser(null);
}
