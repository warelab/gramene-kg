// Thin client for /kg/v1. The UI lives at /kg/ui/, so the API base is ../v1/ relative to the page.
export const API_BASE = new URL('../v1/', location.href);

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error ?? `HTTP ${status}`);
    this.status = status; this.hint = body?.hint ?? null;
  }
}

export const apiUrl = (path, params = {}) => {
  const u = new URL(path.replace(/^\//, ''), API_BASE);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  return u;
};

// GET path -> parsed JSON envelope {release, build, data, meta}. Bare-array responses (/releases) are wrapped.
export async function api(path, params, { signal } = {}) {
  let r;
  try { r = await fetch(apiUrl(path, params), { signal, headers: { accept: 'application/json' } }); }
  catch (e) { if (e.name === 'AbortError') throw e; throw new ApiError(0, { error: `network error: ${e.message}` }); }
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new ApiError(r.status, body);
  if (Array.isArray(body)) return { release: null, build: null, data: body, meta: {} };
  return { ...body, meta: body?.meta ?? {} };
}

export const nodePath = (curie) => `node/${encodeURIComponent(curie)}`;
