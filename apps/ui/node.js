// #/node/<curie>: header, card, attributes, aliases, and lazily loaded edge groups with provenance.
import { api, apiUrl, nodePath, ApiError } from './api.js';
import { h, buildHash, nodeHref, nodeLink, extLink, pubLink, dl, fmtNum, fmtLocation, fmtValue, predLabel,
  degreeGroups, parseCandidates, looksLikeCurie, safeUrl, pubHref, asnHref, wsHref, fill, curatedRecords } from './lib.js';
import { announce, setTitle, badge, stateBadge, errorBox, section } from './ui.js';

const PAGE = 50;
const CURATION = 'infores:sorghumbase-curation';
const CURATED_AUTO_MAX = 50000;   // above this degree the curated panel loads on request (the source filter scans the node's edges)
const layerOf = (x) => x?.layer ?? x?.provenance?.layer ?? null;
const curationOf = (x) => x?.curation ?? x?.provenance?.curation ?? null;

// strings that are CURIEs become node links, http(s) URLs external links, everything else text
function valueNode(v) {
  if (typeof v === 'string') return safeUrl(v) && /^https?:/i.test(v) ? extLink(v) : looksLikeCurie(v) ? nodeLink(v) : v;
  if (Array.isArray(v) && v.length && v.every(x => typeof x === 'string')) return v.flatMap((x, i) => (i ? [', ', valueNode(x)] : [valueNode(x)]));
  const s = fmtValue(v);
  return s.includes('\n') ? h('pre', null, s) : s;
}
const releaseLink = (rel) => (rel ? h('a', { href: buildHash('release', '', { id: String(rel).replace(/^gramene\.release:/, '') }) }, rel) : null);
const joinNodes = (arr, f) => (arr?.length ? arr.flatMap((x, i) => (i ? [', ', f(x)] : [f(x)])) : null);

export async function renderNode(main, route, signal) {
  const curie = route.arg;
  setTitle(curie);
  let res;
  try { res = await api(nodePath(curie), {}, { signal }); }
  catch (e) {
    if (e.name === 'AbortError') throw e;
    const searchLink = h('p', null, h('a', { href: buildHash('search', '', { q: curie }) }, `Search for “${curie}”`));
    if (e instanceof ApiError && e.status === 409) {
      const cands = parseCandidates(e.hint);
      fill(main, h('h1', null, curie), h('div', { class: 'notice', role: 'status' },
        h('p', null, h('strong', null, 'Ambiguous identifier. '), `“${curie}” matches ${cands.length || 'several'} nodes:`),
        cands.length ? h('ul', null, cands.map(c => h('li', null, nodeLink(c.id), ' ', badge(c.cls), c.genome ? h('span', { class: 'muted' }, ` ${c.genome}`) : null)))
          : h('p', null, e.hint ?? '')), searchLink);
      announce('Ambiguous identifier');
      return;
    }
    fill(main, h('h1', null, curie), errorBox(e), searchLink);
    announce(e.message);
    return;
  }
  const n = res.data;
  if (n.id !== curie) history.replaceState(null, '', nodeHref(n.id));   // alias -> canonical id, no reload
  setTitle(n.name || n.id);
  announce(`Loaded ${n.name || n.id}`);

  const loc = n.location ? [fmtLocation(n.location), n.genome ? h('span', { class: 'muted' }, ` on ${n.genome}`) : null] : null;
  const head = h('header', { class: 'node-head' },
    h('h1', null, n.name || n.id),
    h('p', { class: 'ids' }, h('code', null, n.id), ' ', badge(n.class), layerOf(n) === 'curated' || n.curation ? badge('curated', 'cur') : null, (n.category ?? []).map(c => badge(c, 'cat')),
      ' ', h('a', { href: apiUrl(nodePath(n.id)).href, class: 'small' }, 'JSON'),
      pubHref(n.id) ? [' · ', extLink(pubHref(n.id), /^doi:/i.test(n.id) ? 'doi.org' : 'PubMed')] : null),
    n.description ? h('p', { class: 'desc' }, n.description) : null,
    dl([
      ['Genome', n.genome ? nodeLink(n.genome) : null],
      ['Location', loc],
      ['Taxon', n.in_taxon ? nodeLink(n.in_taxon) : null],
      ['Gene tree', n.gene_tree ? nodeLink(n.gene_tree) : null],
      ['Cross-references', joinNodes(n.xrefs, x => (pubHref(x) ? pubLink(x) : valueNode(x)))],
      ['Curation', curationLink(curationOf(n))],
      ['Release', releaseLink(n.provenance?.release ?? (res.release && `gramene.release:${res.release}`))],
    ]));

  const warn = (res.meta.warnings ?? []).length ? h('div', { class: 'notice', role: 'status' }, res.meta.warnings.map(w => h('p', null, w))) : null;
  // attributes.curated holds the curated records of this CURIE, one per (visible) workspace: its own section
  const recs = curatedRecords(n.attributes?.curated);
  const attrs = Object.entries(n.attributes ?? {}).filter(([k]) => !(k === 'curated' && recs.length));
  const parts = [
    head, warn,
    n.card ? section('Summary', h('p', { class: 'card' }, n.card)) : null,
    n.aliases?.length ? section(`Aliases (${n.aliases.length})`, h('ul', { class: 'aliases' }, n.aliases.map(a => h('li', null, a)))) : null,
    attrs.length ? section('Attributes', h('table', { class: 'attrs' }, h('tbody', null,
      attrs.map(([k, v]) => h('tr', null, h('th', { scope: 'row' }, k.replace(/_/g, ' ')), h('td', null, valueNode(v))))))) : null,
    recs.length ? curatedRecordsSection(recs) : null,
    curatedSection(n),
    edgesSection(n),
  ];
  fill(main, ...parts.filter(Boolean));
}

// ---- edges -----------------------------------------------------------------------------------------
function edgesSection(n) {
  const groups = degreeGroups(n.degree);
  const total = groups.reduce((a, g) => a + g.n, 0);
  const box = h('div', { class: 'edge-groups' });
  const negBox = h('input', { type: 'checkbox', id: 'neg-toggle' });
  const build = () => fill(box, ...groups.map(g => edgeGroup(n.id, g, negBox.checked)));
  negBox.addEventListener('change', () => { build(); announce(negBox.checked ? 'Showing negated edges' : 'Hiding negated edges'); });
  build();
  return h('section', { class: 'panel edges' },
    h('h2', null, `Relationships (${fmtNum(total)})`),
    groups.length ? h('p', { class: 'toolbar' }, h('label', { for: 'neg-toggle' }, negBox, ' show negated edges'),
      h('span', { class: 'muted small' }, ' · counts are from the node’s degree summary; expand a group to load its edges')) : h('p', null, 'No edges.'),
    box);
}

function edgeGroup(id, g, includeNeg) {
  const arrow = g.dir === 'out' ? '→' : g.dir === 'in' ? '←' : '↔';
  const tbody = h('tbody');
  const more = h('button', { type: 'button', class: 'more', hidden: true }, 'Load more');
  const msg = h('p', { class: 'muted small', 'aria-live': 'polite' });
  const table = h('table', { class: 'edges-table' },
    h('thead', null, h('tr', null, ['Neighbour', 'Qualifiers', 'Source', 'Provenance'].map(t => h('th', { scope: 'col' }, t)))), tbody);
  let cursor = null, loaded = 0, started = false, busy = false;

  async function load() {
    if (busy) return;
    busy = true; more.disabled = true; msg.textContent = 'Loading…';
    try {
      const { data, meta } = await api(`${nodePath(id)}/edges`, { predicate: g.pred, direction: g.dir === 'both' ? '' : g.dir,
        limit: PAGE, cursor, include_negated: includeNeg ? 1 : '' });
      for (const e of data) tbody.append(edgeRow(e));
      loaded += data.length; cursor = meta.next ?? null;
      more.hidden = !cursor; msg.textContent = `${fmtNum(loaded)} of ${fmtNum(g.n)} loaded${cursor ? '' : (loaded ? '' : ' — no edges returned')}`;
      if (!cursor && loaded !== g.n) msg.textContent += includeNeg ? '' : ' (negated edges hidden)';
      if (!cursor && more.contains(document.activeElement)) tbody.lastElementChild?.querySelector('a')?.focus();
    } catch (e) {
      fill(msg, errorBox(e) ?? '');
    } finally { busy = false; more.disabled = false; }
  }
  more.addEventListener('click', load);
  const det = h('details', { class: 'edge-group' },
    h('summary', null, h('span', { class: 'pred' }, predLabel(g.pred)), ` (${g.dir}) `, h('span', { class: 'arrow', 'aria-hidden': 'true' }, arrow, ' '),
      h('span', { class: 'count' }, fmtNum(g.n)), h('code', { class: 'muted small' }, ` ${g.pred}`)),
    h('div', { class: 'scroll' }, table), msg, more);
  det.addEventListener('toggle', () => { if (det.open && !started) { started = true; load(); } });
  return det;
}

function qualifiersNode(q) {
  const ent = Object.entries(q ?? {});
  if (!ent.length) return '';
  if ('region' in q && 'start' in q) return fmtLocation(q);
  return h('ul', { class: 'quals' }, ent.map(([k, v]) => h('li', null, h('span', { class: 'muted' }, `${k.replace(/_/g, ' ')}: `), valueNode(v))));
}

function edgeRow(e) {
  const o = e.other ?? {};
  const p = e.provenance ?? {};
  const neg = p.negated;
  const prov = h('details', { class: 'prov' }, h('summary', null, 'details'), dl([
    ['Edge', e.id ? [h('code', null, e.id), ' ', h('a', { href: apiUrl(`edge/${encodeURIComponent(e.id)}`).href }, 'JSON')] : 'derived from a node field (slot edge)'],
    ['Statement', [nodeLink(e.subject), ` ${neg ? 'NOT ' : ''}${predLabel(e.predicate)} `, nodeLink(e.object)]],
    ['Primary source', p.primary_knowledge_source],
    ['Aggregators', p.aggregator_knowledge_source?.join(', ')],
    ['Knowledge level', p.knowledge_level?.replace(/_/g, ' ')],
    ['Agent type', p.agent_type?.replace(/_/g, ' ')],
    ['Evidence', joinNodes(p.has_evidence, nodeLink)],
    ['Original evidence', p.original_evidence],
    ['Publications', joinNodes(p.publications, pubLink)],
    ['Supporting studies', joinNodes(p.has_supporting_studies, nodeLink)],
    ['Method', p.method ? valueNode(p.method) : null],
    ['Original subject', p.original_subject],
    ['Original object', p.original_object],
    ['Source record', p.source_record ? h('code', null, p.source_record) : null],
    ['Source version', p.knowledge_source_version],
    ['Layer', p.layer],
    ['Curation', curationLink(curationOf(e))],
    ['Release', releaseLink(p.release)],
    ['Ingest run', p.ingest_run],
  ]));
  return h('tr', { class: neg ? 'negated' : null },
    h('td', null, neg ? badge('NOT', 'neg') : null, ' ', h('a', { href: nodeHref(o.id) }, o.name || o.id),
      o.name && o.name !== o.id ? h('div', null, h('code', { class: 'small' }, o.id)) : null, badge(o.class),
      pubHref(o.id) ? [' ', extLink(pubHref(o.id), '↗')] : null),
    h('td', null, qualifiersNode(e.qualifiers)),
    h('td', null, h('span', { class: 'small' }, (p.primary_knowledge_source ?? '').replace(/^infores:/, '')), layerOf(e) === 'curated' ? [' ', badge('curated', 'cur')] : null),
    h('td', null, prov));
}

// ---- curated layer -------------------------------------------------------------------------------------
const curationLink = (c) => (Array.isArray(c) ? (c.length ? c.flatMap((x, i) => (i ? ['; ', curationLink(x)] : [curationLink(x)])) : null)
  : Array.isArray(c?.workspaces) ? curationLink(c.workspaces.map(w => (typeof w === 'string' ? { workspace: w } : w)))
  : c?.assertion ? [h('a', { href: asnHref(c.assertion) }, c.assertion), c.rev != null ? ` rev ${c.rev}` : '', ' ', stateBadge(c.state),
  c.workspace ? [' in ', h('a', { href: wsHref(c.workspace) }, c.workspace)] : null]
  : c?.workspace ? ['curated node of ', h('a', { href: wsHref(c.workspace) }, c.workspace), c.rev != null ? `, rev ${c.rev}` : ''] : null);

// curated records of this node, one per workspace (kg_curation.curated_nodes '<ws>|<curie>'): a CURIE may be
// curated in several workspaces; the API merges the ones the caller can read, the build the public ones
const REC_SKIP = new Set(['workspace', 'workspace_name', 'name', 'description', 'xrefs', 'attrs', 'rev', 'class', 'cls', 'source',
  'created_at', 'updated_at', 'created_by', 'updated_by', 'content_sha256', 'curie', 'id', '_id']);
function curatedRecordsSection(recs) {
  const when = (t) => (t ? String(t).replace('T', ' ').replace(/(\.\d+)?Z$/, '').slice(0, 16) : null);
  return h('section', { class: 'panel curated-records' }, h('h2', null, `Curated records (${recs.length}) `, badge('curated', 'cur')),
    recs.length > 1 ? h('p', { class: 'small muted' }, `Curated in ${recs.length} workspaces; each keeps its own record.`) : null,
    recs.map(([ws, r]) => {
      const extra = { ...(r.attrs && typeof r.attrs === 'object' ? r.attrs : {}),
        ...Object.fromEntries(Object.entries(r).filter(([k]) => !REC_SKIP.has(k))) };
      return h('article', { class: 'curated-record' },
        h('h3', null, 'Workspace ', h('a', { href: wsHref(r.workspace ?? ws) }, r.workspace_name || r.workspace || ws),
          r.rev != null ? h('span', { class: 'muted small' }, ` rev ${r.rev}`) : null),
        dl([['Class', r.class ?? r.cls ? badge(r.class ?? r.cls) : null], ['Name', r.name], ['Description', r.description],
          ['Cross-references', joinNodes(r.xrefs, x => (pubHref(x) ? pubLink(x) : valueNode(x)))],
          ['Updated', when(r.updated_at ?? r.created_at)]]),
        Object.keys(extra).length ? h('table', { class: 'attrs' }, h('tbody', null,
          Object.entries(extra).map(([k, v]) => h('tr', null, h('th', { scope: 'row' }, k.replace(/_/g, ' ')), h('td', null, valueNode(v))))))
          : null);
    }));
}

// statements curators added about this node (edges whose primary source is the curation infores, both directions)
function curatedSection(n) {
  const total = Object.values(n.degree ?? {}).reduce((a, b) => a + (Number(b) || 0), 0);
  const tbody = h('tbody');
  const table = h('div', { class: 'scroll', hidden: true }, h('table', { class: 'data' },
    h('thead', null, h('tr', null, ['Statement', 'Evidence', 'Curation'].map(t => h('th', { scope: 'col' }, t)))), tbody));
  const msg = h('p', { class: 'muted small', 'aria-live': 'polite' });
  const more = h('button', { type: 'button', class: 'more', hidden: true }, 'Load more');
  let cursor = null, loaded = 0, busy = false;
  async function load() {
    if (busy) return;
    busy = true; more.disabled = true; msg.textContent = 'Loading curated statements…';
    try {
      const { data, meta } = await api(`${nodePath(n.id)}/edges`, { source: CURATION, direction: 'both', include_negated: 1, limit: PAGE, cursor });
      for (const e of data) tbody.append(curatedRow(n.id, e));
      loaded += data.length; cursor = meta.next ?? null;
      table.hidden = !loaded; more.hidden = !cursor;
      fill(msg, loaded ? `${fmtNum(loaded)} curated statement${loaded === 1 ? '' : 's'}${cursor ? ' so far' : ''}.` : 'No curated statements about this node. ',
        loaded ? null : h('a', { href: '#/curate' }, 'Add one'));
    } catch (e) { fill(msg, errorBox(e) ?? ''); } finally { busy = false; more.disabled = false; }
  }
  more.addEventListener('click', load);
  const start = h('button', { type: 'button', onclick: () => { start.remove(); load(); } }, 'Look for curated statements');
  if (total <= CURATED_AUTO_MAX) load(); else msg.textContent = `This node has ${fmtNum(total)} edges; curated statements load on request. `;
  return h('section', { class: 'panel curated' }, h('h2', null, 'Curated statements ', badge('curated', 'cur')),
    table, msg, total > CURATED_AUTO_MAX ? start : null, more);
}

function curatedRow(id, e) {
  const p = e.provenance ?? {};
  const c = curationOf(e);
  const pubs = [...(p.publications ?? []).map(pubLink), ...(p.has_evidence ?? []).map(x => nodeLink(x))];
  const end = (x) => (x === id ? h('strong', null, x) : nodeLink(x, x === e.other?.id ? e.other?.name || x : x));
  return h('tr', { class: p.negated ? 'negated' : null },
    h('td', null, end(e.subject), ' ', p.negated ? badge('NOT', 'neg') : null, ' ', predLabel(e.predicate), ' ', end(e.object)),
    h('td', null, pubs.flatMap((x, i) => (i ? [', ', x] : [x])), p.knowledge_level ? h('div', { class: 'small muted' }, p.knowledge_level.replace(/_/g, ' ')) : null),
    h('td', null, curationLink(c) ?? h('span', { class: 'muted' }, 'baked into this build')));
}
