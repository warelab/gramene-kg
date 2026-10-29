// #/search?q=&category=&genome=&source=&start=
import { api } from './api.js';
import { h, buildHash, nodeHref, nodeLink, fmtNum, truncate, looksLikeCurie } from './lib.js';
import { announce, setTitle, badge, errorBox } from './ui.js';

const ROWS = 20;
// facet field -> [label, filter param or null (not filterable via the API), link facet values to node pages?]
const FACETS = [
  ['category_leaf_s', 'Class', 'category'],
  ['source_ss', 'Source', 'source'],
  ['system_name_s', 'Genome (system name)', null],
  ['taxon_s', 'Taxon', null, true],
];
const FILTERS = [['category', 'class'], ['genome', 'genome'], ['source', 'source']];

export async function renderSearch(main, route, signal) {
  const P = Object.fromEntries(['q', 'category', 'genome', 'source', 'start'].map(k => [k, route.params.get(k) ?? '']));
  const start = Math.max(0, parseInt(P.start, 10) || 0);
  const q = P.q.trim();
  const qInput = document.getElementById('q');
  if (qInput && document.activeElement !== qInput) qInput.value = q;
  setTitle(q ? `Search: ${q}` : 'Search');
  const link = (over) => buildHash('search', '', { ...P, start: 0, ...over });

  let res, err;
  try { res = await api('search', { q, category: P.category, genome: P.genome, source: P.source, rows: ROWS, start }, { signal }); }
  catch (e) { if (e.name === 'AbortError') throw e; err = e; }

  const jump = q && looksLikeCurie(q)
    ? h('p', { class: 'jump' }, 'Looks like an identifier: ', h('a', { href: nodeHref(q), class: 'button' }, `Go to ${q} →`)) : null;
  const active = FILTERS.filter(([k]) => P[k]).map(([k, label]) =>
    h('a', { href: link({ [k]: '' }), class: 'chip', 'aria-label': `Remove ${label} filter ${P[k]}` }, `${label}: ${P[k]} ×`));

  if (err) {
    main.replaceChildren(h('h1', null, 'Search'), jump, active.length ? h('p', { class: 'chips' }, active) : null, errorBox(err));
    announce(`Search failed: ${err.message}`);
    return;
  }
  const { data, meta } = res;
  const total = meta.total ?? data.length;
  announce(`${fmtNum(total)} results${q ? ` for ${q}` : ''}`);

  const resolved = (meta.resolved ?? []).length ? h('section', { class: 'panel resolved', 'aria-label': 'Exact identifier matches' },
    h('h2', null, 'Exact id / alias matches'),
    h('ul', null, meta.resolved.map(r => h('li', null, nodeLink(r.id, r.name || r.id), ' ', h('code', null, r.id), ' ', badge(r.class),
      r.genome ? h('span', { class: 'muted' }, ` ${r.genome}`) : null, r.match ? h('span', { class: 'muted small' }, ` (${r.match} match)`) : null)))) : null;

  const facetBox = h('aside', { class: 'facets', 'aria-label': 'Filters' }, FACETS.map(([field, label, param, asNode]) => {
    const counts = Object.entries(meta.facets?.[field] ?? {});
    if (!counts.length) return null;
    return h('details', { class: 'facet', open: param || field === 'system_name_s' ? true : null },
      h('summary', null, label, param ? null : h('span', { class: 'muted small' }, ' (counts only)')),
      h('ul', null, counts.map(([v, n]) => {
        const on = param && P[param] === v;
        const lab = [v, ' ', h('span', { class: 'count' }, fmtNum(n))];
        if (param) return h('li', null, h('a', { href: link({ [param]: on ? '' : v }), 'aria-current': on ? 'true' : null,
          'aria-label': `${on ? 'Remove' : 'Filter by'} ${label} ${v} (${n})` }, lab));
        return h('li', null, asNode ? h('a', { href: nodeHref(v) }, lab) : h('span', null, lab));
      })));
  }));

  const list = h('ol', { class: 'results', start: start + 1 }, data.map(d => h('li', null,
    h('div', { class: 'r-head' }, nodeLink(d.id, d.name || d.id), ' ', badge(d.class),
      d.id === q ? badge('exact id', 'ok') : null),
    h('div', { class: 'r-meta' }, h('code', null, d.id),
      d.genome ? [' · ', h('a', { href: link({ genome: d.genome }), title: 'Filter results to this genome' }, d.genome)] : null,
      ` · degree ${fmtNum(d.degree)}`),
    d.card ? h('p', { class: 'card-snippet' }, truncate(d.card, 300)) : null)));

  const pager = total > ROWS ? h('nav', { class: 'pager', 'aria-label': 'Result pages' },
    start > 0 ? h('a', { href: link({ start: Math.max(0, start - ROWS) }), rel: 'prev' }, '← Previous') : h('span', { class: 'muted' }, '← Previous'),
    h('span', null, `${fmtNum(start + 1)}–${fmtNum(Math.min(start + data.length, total))} of ${fmtNum(total)}`),
    start + ROWS < total ? h('a', { href: link({ start: start + ROWS }), rel: 'next' }, 'Next →') : h('span', { class: 'muted' }, 'Next →')) : null;

  main.replaceChildren(
    h('h1', null, q ? ['Search: ', h('q', null, q)] : 'Browse all nodes'),
    jump, active.length ? h('p', { class: 'chips' }, 'Filters: ', active) : null, resolved,
    h('div', { class: 'search-layout' }, facetBox,
      h('section', { class: 'results-col', 'aria-label': 'Results' },
        h('p', { class: 'muted' }, `${fmtNum(total)} result${total === 1 ? '' : 's'}`),
        data.length ? list : h('p', null, 'No results.'), pager,
        (meta.warnings ?? []).map(w => h('p', { class: 'note small' }, w)))));
}
