// Pure helpers (no DOM at import time, so they can be tested under node) plus a tiny safe DOM builder.
// All API text goes through text nodes / attributes — never innerHTML.

// ---- routing -------------------------------------------------------------------------------------
// '#/node/GO%3A1?x=1' -> { page: 'node', arg: 'GO:1', params: URLSearchParams }
export function parseHash(hash) {
  const h = String(hash ?? '').replace(/^#\/?/, '');
  const qi = h.indexOf('?');
  const path = qi < 0 ? h : h.slice(0, qi);
  const params = new URLSearchParams(qi < 0 ? '' : h.slice(qi + 1));
  const slash = path.indexOf('/');
  const page = (slash < 0 ? path : path.slice(0, slash)) || 'search';
  let arg = slash < 0 ? '' : path.slice(slash + 1);
  try { arg = decodeURIComponent(arg); } catch { /* keep raw */ }
  return { page, arg, params };
}
// buildHash('search', '', {q: 'x', start: 0}) -> '#/search?q=x' (empty / null / 0-start values dropped)
export function buildHash(page, arg = '', params = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '' && !(k === 'start' && Number(v) === 0)) p.set(k, String(v));
  const qs = p.toString();
  return `#/${page}${arg ? '/' + encodeURIComponent(arg) : ''}${qs ? '?' + qs : ''}`;
}
export const nodeHref = (curie) => buildHash('node', curie);

// ---- formatting ----------------------------------------------------------------------------------
export const fmtNum = (n) => (typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-US') : String(n ?? ''));
export function fmtBytes(b) {
  if (typeof b !== 'number' || !Number.isFinite(b)) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0, v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${i ? v.toFixed(v < 10 ? 1 : 0) : v} ${u[i]}`;
}
export const shortSha = (s, n = 12) => (s && s.length > n ? s.slice(0, n) + '…' : s ?? '');
export const truncate = (s, n) => (s && s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s ?? '');
// 'biolink:overlaps' -> 'overlaps'; 'gramene:has_domain' -> 'has domain'
export const predLabel = (p) => String(p ?? '').replace(/^biolink:|^gramene:/, '').replace(/_/g, ' ');
export function fmtLocation(loc) {
  if (!loc || loc.region == null) return '';
  const strand = loc.strand === 1 ? ' (+)' : loc.strand === -1 ? ' (−)' : '';
  return `${loc.region}:${fmtNum(loc.start)}-${fmtNum(loc.end)}${strand}`;
}
// node.degree {"biolink:overlaps|in": 5} -> [{key, pred, dir, n}] sorted out-before-in, then by label
export function degreeGroups(degree) {
  return Object.entries(degree ?? {}).map(([key, n]) => {
    const i = key.lastIndexOf('|');
    return { key, pred: i < 0 ? key : key.slice(0, i), dir: i < 0 ? 'both' : key.slice(i + 1), n };
  }).sort((a, b) => (a.dir === b.dir ? 0 : a.dir === 'out' ? -1 : 1) || predLabel(a.pred).localeCompare(predLabel(b.pred)));
}
// does a free-text query look like a single CURIE (prefix:local, no whitespace)?
export const looksLikeCurie = (q) => /^[A-Za-z][\w.-]*:\S+$/.test(String(q ?? '').trim()) && !/^https?:/i.test(q);
// external link for a publication id, or null (caller links internally instead)
export function pubHref(id) {
  const s = String(id ?? '');
  let m = s.match(/^PMID:(\d+)$/i); if (m) return `https://pubmed.ncbi.nlm.nih.gov/${m[1]}/`;
  m = s.match(/^doi:(10\..+)$/i); if (m) return `https://doi.org/${m[1].split('/').map(encodeURIComponent).join('/')}`;
  m = s.match(/^PMC(\d+)$/i) || s.match(/^PMCID:PMC(\d+)$/i); if (m) return `https://www.ncbi.nlm.nih.gov/pmc/articles/PMC${m[1]}/`;
  return null;
}
// only http(s) URLs become hrefs
export function safeUrl(u) {
  try { const x = new URL(String(u)); return x.protocol === 'http:' || x.protocol === 'https:' ? x.href : null; } catch { return null; }
}
// 409 hint 'a:1 (Cls, g); b:2 (Cls, -)' -> [{id, cls, genome}]
export function parseCandidates(hint) {
  return String(hint ?? '').split(/;\s*/).map(s => s.match(/^(\S+) \(([^,]*), ([^)]*)\)$/)).filter(Boolean)
    .map(m => ({ id: m[1], cls: m[2], genome: m[3] === '-' ? null : m[3] }));
}
// render any attribute value as plain text
export function fmtValue(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.every(x => typeof x !== 'object' || x === null) ? v.join(', ') : JSON.stringify(v, null, 1);
  if (typeof v === 'object') return JSON.stringify(v, null, 1);
  if (typeof v === 'number') return Number.isInteger(v) ? fmtNum(v) : String(Math.round(v * 1e4) / 1e4);
  return String(v);
}

// ---- DOM builder ---------------------------------------------------------------------------------
// h('a', {href, class: 'x', onclick: fn}, 'text', child, [more]) — strings become text nodes.
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, kids);
  return el;
}
export function append(el, kids) {
  for (const k of kids.flat(Infinity)) if (k !== null && k !== undefined && k !== false) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return el;
}
// el.replaceChildren(...) that skips null/false and flattens arrays: the DOM method would insert the text "null"
export const fill = (el, ...kids) => { el.replaceChildren(); return append(el, kids); };
export const nodeLink = (id, label) => h('a', { href: nodeHref(id) }, label ?? id);
export function extLink(url, label) {
  const u = safeUrl(url);
  return u ? h('a', { href: u, target: '_blank', rel: 'noopener noreferrer' }, label ?? url) : h('span', null, label ?? String(url ?? ''));
}
// a CURIE that may be a publication: external link if known, else internal node link
export const pubLink = (id) => (pubHref(id) ? extLink(pubHref(id), id) : nodeLink(id));
export const dl = (pairs) => h('dl', { class: 'kv' }, pairs.filter(Boolean).filter(([, v]) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length))
  .map(([k, v]) => [h('dt', null, k), h('dd', null, v)]));

// ---- curation (docs/curation.md) -----------------------------------------------------------------
export const ROLES = ['reader', 'contributor', 'curator', 'owner'];
export const STATES = ['draft', 'submitted', 'published', 'rejected', 'retracted'];
export const atLeast = (role, need) => ROLES.indexOf(role) >= ROLES.indexOf(need) && ROLES.indexOf(need) >= 0;
// the caller's role in a workspace: the API's own answer if it gives one, else owner / user ACL entries
// (org principals are left to the server); public workspaces are readable by anyone. Display only: the
// server enforces every check.
export function roleOf(ws, uid) {
  if (!ws) return null;
  const given = ws.role ?? ws.my_role ?? ws.caller_role;
  if (ROLES.includes(given)) return given;
  let best = null;
  const bump = (r) => { if (ROLES.includes(r) && (!best || atLeast(r, best))) best = r; };
  if (uid && (ws.ownerUid ?? ws.owner) === uid) bump('owner');
  for (const a of ws.acls ?? []) if (uid && a?.principal?.type === 'user' && a.principal.id === uid) bump(a.role);
  if (!best && ws.visibility === 'public') best = 'reader';
  return best;
}
// is the caller a member of the workspace (owner, or an ACL entry for them or one of their orgs), as opposed to
// merely able to read it because it is public? The API's `role` field counts public readability ('reader' on any
// public workspace), so it settles membership only when it says more than that. An explicit `member` flag wins.
export function isMember(ws, uid, orgs = []) {
  if (!ws || !uid) return false;
  if (typeof ws.member === 'boolean') return ws.member;
  if ((ws.ownerUid ?? ws.owner) === uid) return true;
  for (const a of ws.acls ?? []) {
    const p = a?.principal;
    if (p?.type === 'user' && p.id === uid) return true;
    if (p?.type === 'org' && (orgs ?? []).includes(p.id)) return true;
  }
  const given = ws.role ?? ws.my_role ?? ws.caller_role;
  return ROLES.includes(given) && (ws.visibility !== 'public' || given !== 'reader');
}
// the caller's site-wide role from GET /curate/me ('site_curator' or null); accepts a few spellings
export const SITE_CURATOR = 'site_curator';
export function siteRoleOf(me) {
  if (!me) return null;
  const r = me.site_role ?? me.siteRole ?? me.site?.role ?? me.roles?.site ?? null;
  if (typeof r === 'string') return r || null;
  if (Array.isArray(me.site_roles) && me.site_roles.includes(SITE_CURATOR)) return SITE_CURATOR;
  if (me.site_curator === true || me.is_site_curator === true) return SITE_CURATOR;
  return null;
}
export const isSiteCurator = (me) => siteRoleOf(me) === SITE_CURATOR;
// who may publish / reject / retract in a workspace (decision: public workspaces need a site curator)
export const publishersText = (ws) => (ws?.visibility === 'public'
  ? 'site curators only (published statements enter the public graph)'
  : 'curators and owners of this workspace');
// state-machine buttons for an assertion in `state` for a caller with `role`. In a public workspace publish,
// reject and retract need a site curator (who needs no workspace role for them); edit and submit follow `role`.
export function actionsFor(state, role, { publicWs = false, siteCurator = false } = {}) {
  const out = [];
  const review = publicWs ? siteCurator : atLeast(role, 'curator');
  if (atLeast(role, 'contributor') && (state === 'draft' || state === 'rejected')) out.push('edit');
  if (atLeast(role, 'contributor') && state === 'draft') out.push('submit');
  if (review && state === 'submitted') out.push('publish', 'reject');
  if (review && state === 'published') out.push('retract');
  return out;
}
// a curated node record's CURIE: kg_curation.curated_nodes _id is '<ws>|<curie>' (one record per workspace)
export const curieOf = (n) => n?.curie ?? String(n?.id ?? n?._id ?? '').replace(/^ws_[0-9a-f]{12}\|/, '');
// node.attributes.curated -> [[workspace, record], ...]: keyed per workspace ({<ws>: {...}}); an older single
// record ({workspace, rev, ...}) is accepted too
export function curatedRecords(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return [];
  if (typeof c.workspace === 'string') return [[c.workspace, c]];
  return Object.entries(c).filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v)).sort(([a], [b]) => a.localeCompare(b));
}
export const needsReason = (action) => action === 'reject' || action === 'retract';
// 'PMID:1, 2 doi:10.1/x' -> ['PMID:1', 'PMID:2', 'doi:10.1/x'] (bare numbers are PubMed ids)
export const splitIds = (s) => String(s ?? '').split(/[\s,;]+/).filter(Boolean).map(x => (/^\d+$/.test(x) ? `PMID:${x}` : x.replace(/^pmid:/i, 'PMID:')));
// 'ECO:0000269' or a bare 7-digit number -> 'ECO:0000269'
export const normEco = (s) => String(s ?? '').split(/[\s,;]+/).filter(Boolean).map(x => (/^\d{7}$/.test(x) ? `ECO:${x}` : x.replace(/^eco:/i, 'ECO:')));
export const KNOWLEDGE_LEVELS = ['knowledge_assertion', 'logical_entailment', 'prediction', 'statistical_association', 'observation', 'not_provided'];
// payload of a JWT (no verification: only used to show who a dev test token names)
export function jwtPayload(t) {
  try {
    const p = String(t).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(Array.from(atob(p.padEnd(p.length + (4 - p.length % 4) % 4, '=')), c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('')));
  } catch { return null; }
}
// 'key=value' lines -> {key: value}; numbers and true/false are typed, anything else stays a string
export function parseQualifiers(s) {
  const out = {};
  for (const line of String(s ?? '').split('\n')) {
    const i = line.indexOf('='); if (i < 1) continue;
    const k = line.slice(0, i).trim(), v = line.slice(i + 1).trim();
    if (!k) continue;
    out[k] = v === 'true' ? true : v === 'false' ? false : v !== '' && Number.isFinite(Number(v)) ? Number(v) : v;
  }
  return out;
}
export const fmtQualifiers = (q) => Object.entries(q ?? {}).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n');
export const wsHref = (id) => `#/curate/ws/${encodeURIComponent(id)}`;
export const asnHref = (id, rev) => `#/curate/assertion/${encodeURIComponent(id)}${rev ? `?rev=${encodeURIComponent(rev)}` : ''}`;
