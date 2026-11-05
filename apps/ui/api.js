// Thin client for /kg/v1. The UI lives at /kg/ui/, so the API base is ../v1/ relative to the page.
export const API_BASE = new URL('../v1/', location.href);

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error ?? body?.message ?? `HTTP ${status}`);
    this.status = status; this.hint = body?.hint ?? null; this.candidates = body?.candidates ?? null; this.body = body ?? null;
  }
}

export const apiUrl = (path, params = {}) => {
  const u = new URL(path.replace(/^\//, ''), API_BASE);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  return u;
};

// auth.js registers a provider: async () => ID token or null. With no signed-in user nothing is sent, so
// anonymous browsing makes exactly the requests it made before sign-in existed.
let tokenProvider = null;
export const setTokenProvider = (fn) => { tokenProvider = fn; };

// path -> parsed JSON envelope {release, build, data, meta}. Bare-array responses (/releases) are wrapped.
// opts: { signal, method, body (JSON), auth: false to never send the token }
export async function api(path, params, { signal, method = 'GET', body, auth = true } = {}) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (auth && tokenProvider) { const t = await tokenProvider().catch(() => null); if (t) headers.authorization = `Bearer ${t}`; }
  let r;
  try { r = await fetch(apiUrl(path, params), { signal, method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); }
  catch (e) { if (e.name === 'AbortError') throw e; throw new ApiError(0, { error: `network error: ${e.message}` }); }
  const b = await r.json().catch(() => null);
  if (!r.ok) throw new ApiError(r.status, b);
  if (Array.isArray(b)) return { release: null, build: null, data: b, meta: {} };
  return { ...b, meta: b?.meta ?? {} };
}

export const nodePath = (curie) => `node/${encodeURIComponent(curie)}`;
