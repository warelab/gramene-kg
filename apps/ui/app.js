// gramene-kg browse UI: hash router + header. Pages: #/search, #/node/<curie>, #/release[?id=].
import { api } from './api.js';
import { h, parseHash, buildHash, fmtNum } from './lib.js';
import { errorBox, setTitle } from './ui.js';
import { renderSearch } from './search.js';
import { renderNode } from './node.js';
import { renderRelease } from './release.js';

const main = document.getElementById('main');
const relBox = document.getElementById('release-info');
let ctrl = null;

async function loadHeader() {
  try {
    const { data } = await api('releases');
    const cur = data.find(r => r.is_current) ?? data[0];
    if (!cur) return;
    relBox.replaceChildren(h('a', { href: buildHash('release', '', { id: cur.id }), title: `promoted ${cur.promoted_at ?? ''}` },
      h('span', { class: 'rel' }, cur.id), ' · build ', h('code', null, cur.build)),
      cur.counts ? h('span', { class: 'muted small' }, ` · ${fmtNum(cur.counts.nodes)} nodes, ${fmtNum(cur.counts.edges)} edges`) : null);
  } catch (e) { relBox.textContent = 'release unavailable'; }
}

async function route() {
  ctrl?.abort();
  ctrl = new AbortController();
  const { signal } = ctrl;
  const r = parseHash(location.hash);
  for (const a of document.querySelectorAll('nav a[data-page]')) { if (a.dataset.page === r.page) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
  main.replaceChildren(h('p', { class: 'loading' }, 'Loading…'));
  main.setAttribute('aria-busy', 'true');
  try {
    if (r.page === 'node' && r.arg) await renderNode(main, r, signal);
    else if (r.page === 'release') await renderRelease(main, r, signal);
    else await renderSearch(main, r, signal);
  } catch (e) {
    if (e?.name === 'AbortError') return;
    main.replaceChildren(errorBox(e));
    setTitle('Error');
  } finally {
    if (!signal.aborted) main.removeAttribute('aria-busy');
  }
  if (signal.aborted) return;
  // move focus to the page heading for keyboard / screen-reader users (not on first load of search)
  const hd = main.querySelector('h1');
  if (hd && document.activeElement?.tagName !== 'INPUT') { hd.tabIndex = -1; hd.focus({ preventScroll: true }); }
  window.scrollTo(0, 0);
}

// header search box: a new query starts from an unfiltered first page
document.getElementById('search-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const q = document.getElementById('q').value.trim();
  const hash = buildHash('search', '', { q });
  if (location.hash === hash) route(); else location.hash = hash;
});
window.addEventListener('hashchange', route);
loadHeader();
route();
