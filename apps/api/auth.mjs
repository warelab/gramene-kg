// Bearer-token auth for the API, modelled on gramene-g2p apps/api/src/plugins/auth.ts.
//   - Firebase ID tokens of project gramene-auth, verified by firebase-admin with projectId only: Google's public
//     keys, no service-account file (the credential below refuses to mint access tokens; verifyIdToken needs none).
//   - Dev only: with KG_AUTH_TEST_SECRET set, HS256 JWTs {uid, email, exp[, iat]} signed with it are accepted too:
//     exp is required, in the future and at most TEST_TOKEN_MAX_S (1 h) ahead; iat, when present, not in the future.
//     The module refuses to load with KG_AUTH_TEST_SECRET and NODE_ENV=production together.
// Every request gets req.kgUser = {uid, email} or null; a token that fails verification leaves it null and sets
// req.kgAuthError (read routes then answer as for anonymous; curate routes that need a user answer 401).
import crypto from 'node:crypto';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

export const FIREBASE_PROJECT_ID = 'gramene-auth';
const TEST_SECRET = process.env.KG_AUTH_TEST_SECRET || '';
if (TEST_SECRET && process.env.NODE_ENV === 'production') throw new Error('refusing to start: KG_AUTH_TEST_SECRET is set and NODE_ENV=production');
if (TEST_SECRET && TEST_SECRET.length < 16) throw new Error('KG_AUTH_TEST_SECRET must be at least 16 characters');
export const testTokensEnabled = !!TEST_SECRET;
export const TEST_TOKEN_MAX_S = 3600;

const NO_CREDENTIAL = { getAccessToken: async () => { throw new Error('gramene-kg holds no Google credential (ID-token verification only)'); } };
let fb;
const firebaseAuth = () => (fb ??= getAuth(initializeApp({ projectId: FIREBASE_PROJECT_ID, credential: NO_CREDENTIAL }, 'gramene-kg')));

const b64json = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
function verifyTestToken(tok) {
  const [h, p, sig] = tok.split('.');
  const want = crypto.createHmac('sha256', TEST_SECRET).update(`${h}.${p}`).digest();
  const got = Buffer.from(sig ?? '', 'base64url');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) throw new Error('bad test token signature');
  const c = b64json(p);
  const nowS = Date.now() / 1000;
  if (typeof c.exp !== 'number' || !Number.isFinite(c.exp)) throw new Error('test token has no numeric exp');
  if (c.exp <= nowS) throw new Error('test token expired');
  if (c.exp > nowS + TEST_TOKEN_MAX_S) throw new Error(`test token exp is more than ${TEST_TOKEN_MAX_S} s ahead`);
  if (c.iat !== undefined && (typeof c.iat !== 'number' || c.iat > nowS)) throw new Error('test token iat is in the future');
  if (typeof c.uid !== 'string' || !c.uid || c.uid.length > 128) throw new Error('test token has no uid');
  return { uid: c.uid, email: typeof c.email === 'string' ? c.email : null };
}
// test-token signer for tests and dev scripts (same secret); iat = now and exp = now + ttl unless the claims set them
export function signTestToken(claims, secret = TEST_SECRET, ttl = 900) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const iat = Math.floor(Date.now() / 1000);
  const hp = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ iat, exp: iat + ttl, ...claims })}`;
  return `${hp}.${crypto.createHmac('sha256', secret).update(hp).digest('base64url')}`;
}

export async function verifyToken(tok) {
  let alg = null; try { alg = b64json(tok.split('.')[0]).alg; } catch { throw new Error('malformed token'); }
  if (TEST_SECRET && alg === 'HS256') return verifyTestToken(tok);
  const d = await firebaseAuth().verifyIdToken(tok);
  return { uid: d.uid, email: d.email ?? null };
}

export function registerAuth(app) {
  app.decorateRequest('kgUser', null);
  app.decorateRequest('kgAuthError', null);
  app.addHook('onRequest', async (req) => {
    const h = req.headers.authorization;
    if (!h || !/^Bearer /i.test(h)) return;
    try { req.kgUser = await verifyToken(h.slice(7).trim()); } catch (err) {
      req.kgAuthError = 'invalid or expired token';
      req.log.warn({ err: err.message }, 'token verification failed');
    }
  });
  if (TEST_SECRET) app.log.warn('KG_AUTH_TEST_SECRET is set: HS256 test tokens are accepted (dev server only)');
}
