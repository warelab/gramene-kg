// #/release[?id=<release>]: release + build, counts, and the build manifest (datasets, distributions, analyses, software).
import { api, apiUrl } from './api.js';
import { h, dl, buildHash, nodeLink, extLink, fmtNum, fmtBytes, shortSha, fmtValue } from './lib.js';
import { announce, setTitle, badge, section } from './ui.js';

const table = (cols, rows, caption) => h('div', { class: 'scroll' }, h('table', { class: 'data' },
  caption ? h('caption', { class: 'sr-only' }, caption) : null,
  h('thead', null, h('tr', null, cols.map(c => h('th', { scope: 'col' }, c)))),
  h('tbody', null, rows.map(r => h('tr', null, r.map(c => h('td', null, c)))))));
const countTable = (obj, label) => table([label, 'Count'],
  Object.entries(obj ?? {}).filter(([, v]) => typeof v === 'number').sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, h('span', { class: 'num' }, fmtNum(v))]), label);

export async function renderRelease(main, route, signal) {
  const { data: rels } = await api('releases', {}, { signal });
  const id = route.params.get('id') || (rels.find(r => r.is_current) ?? rels[0])?.id;
  setTitle(`Release ${id ?? ''}`);
  if (!id) { main.replaceChildren(h('h1', null, 'Release'), h('p', null, 'No releases are loaded.')); return; }
  const [{ data: rel }, { data: man }] = await Promise.all([
    api(`releases/${encodeURIComponent(id)}`, {}, { signal }),
    api(`releases/${encodeURIComponent(id)}/manifest`, {}, { signal }),
  ]);
  const row = rels.find(r => r.id === id) ?? {};
  const c = rel.counts ?? {};
  const manifestUrl = apiUrl(`releases/${encodeURIComponent(id)}/manifest`).href;
  announce(`Release ${id}, build ${rel.build}`);

  const others = rels.length > 1 ? h('nav', { 'aria-label': 'Releases', class: 'chips' }, 'Releases: ',
    rels.map(r => h('a', { href: buildHash('release', '', { id: r.id }), class: 'chip', 'aria-current': r.id === id ? 'page' : null }, r.id, r.is_current ? ' (current)' : ''))) : null;
  const crossChecks = Object.entries(c.cross_checks ?? {});
  const attr = (n, k) => n.attributes?.[k];

  main.replaceChildren(
    h('h1', null, `Release ${id}`, ' ', row.is_current ? badge('current', 'ok') : null),
    others,
    dl([
      ['Build', h('code', null, rel.build)], ['Site', row.site], ['Promoted', row.promoted_at],
      ['Previous build', row.previous_build], ['Previous release', row.previous_release],
      ['Ingest run', man.ingest_run], ['Mongo db', rel.db], ['Solr core', rel.solr_core],
      ['Totals', `${fmtNum(c.nodes_total ?? row.counts?.nodes)} nodes · ${fmtNum(c.edges_total ?? row.counts?.edges)} edges (${fmtNum(c.edges_materialised)} materialised, ${fmtNum(c.edges_slot)} slot) · ${fmtNum(c.solr_docs)} Solr docs`],
      ['Manifest', h('a', { href: manifestUrl }, 'manifest JSON')],
    ]),
    h('div', { class: 'grid2' },
      section('Nodes by class', countTable(c.nodes, 'Class')),
      section('Edges by family', countTable(c.edges, 'Edge family'))),
    crossChecks.length ? section('Cross-checks (KG vs Solr)', table(['Check', 'KG', 'Solr'], crossChecks.map(([k, v]) =>
      [k, h('span', { class: 'num' }, fmtNum(v?.kg)), h('span', { class: `num ${v?.kg !== v?.solr ? 'warn' : ''}` }, fmtNum(v?.solr))]))) : null,
    section(`Datasets (${man.datasets.length})`, table(['Dataset', 'Version', 'Source', 'Description'], man.datasets.map(d => [
      nodeLink(d.id, d.name || d.id), attr(d, 'version') ?? '', attr(d, 'source_url') ? extLink(attr(d, 'source_url'), 'source') : '', d.description ?? '']), 'Datasets')),
    section(`Distributions (${man.distributions.length})`, table(['File', 'Role', 'SHA-256', 'Size', 'Dataset'], man.distributions.map(d => [
      nodeLink(d.id, d.name || d.id), attr(d, 'role') ?? '', h('code', { title: attr(d, 'sha256') ?? '' }, shortSha(attr(d, 'sha256'))),
      h('span', { class: 'num', title: `${fmtNum(attr(d, 'bytes'))} bytes` }, fmtBytes(attr(d, 'bytes'))), attr(d, 'dataset') ? nodeLink(attr(d, 'dataset')) : '']), 'Distributions')),
    section(`Analyses (${man.analyses.length})`, table(['Analysis', 'Description', 'Inputs', 'Parameters', 'Ended'], man.analyses.map(a => [
      nodeLink(a.id, a.name || a.id), a.description ?? '', fmtNum((attr(a, 'used') ?? []).length),
      attr(a, 'parameters') ? h('pre', { class: 'small' }, fmtValue(attr(a, 'parameters'))) : '', attr(a, 'ended_at') ?? '']), 'Analyses')),
    section(`Software (${man.software.length})`, table(['Software', 'Repository', 'Branch', 'Commit'], man.software.map(s => [
      nodeLink(s.id, s.name || s.id), attr(s, 'repo') ? extLink(attr(s, 'repo')) : '', attr(s, 'branch') ?? '',
      [h('code', { title: attr(s, 'git_sha') ?? '' }, shortSha(attr(s, 'git_sha'), 12)), attr(s, 'dirty') ? badge('dirty', 'warn') : null]]), 'Software')),
  );
}
