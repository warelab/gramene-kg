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
export const nodeLink = (id, label) => h('a', { href: nodeHref(id) }, label ?? id);
export function extLink(url, label) {
  const u = safeUrl(url);
  return u ? h('a', { href: u, target: '_blank', rel: 'noopener noreferrer' }, label ?? url) : h('span', null, label ?? String(url ?? ''));
}
// a CURIE that may be a publication: external link if known, else internal node link
export const pubLink = (id) => (pubHref(id) ? extLink(pubHref(id), id) : nodeLink(id));
export const dl = (pairs) => h('dl', { class: 'kv' }, pairs.filter(([, v]) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length))
  .map(([k, v]) => [h('dt', null, k), h('dd', null, v)]));
