// #/curate (my workspaces, create) · #/curate/ws/<id>[?state=] (assertions, curated nodes, create forms)
// #/curate/assertion/<id>[?rev=] (revision, evidence, history, review events, state buttons by role).
// Contract: docs/curation.md. Roles shown here are for display only; the API enforces every check.
import { api, ApiError } from './api.js';
import { h, dl, nodeLink, pubLink, predLabel, fmtNum, STATES, roleOf, atLeast, actionsFor, needsReason, splitIds, normEco,
  KNOWLEDGE_LEVELS, parseQualifiers, fmtQualifiers, wsHref, asnHref, fill, isMember, isSiteCurator, publishersText, curieOf } from './lib.js';
import { announce, setTitle, badge, stateBadge, errorBox, section } from './ui.js';
import { initAuth, currentUser, loadFirebase, signInGoogle, signInTest, testMode } from './auth.js';
import { curiePicker } from './picker.js';

const enc = encodeURIComponent;
const wsId = (w) => w?._id ?? w?.id;
const when = (s) => (s ? String(s).replace('T', ' ').replace(/(\.\d+)?Z$/, '').slice(0, 16) : '');
const stmt = (a) => [nodeLink(a.subject), ' ', a.negated ? badge('NOT', 'neg') : null, ' ', h('strong', null, predLabel(a.predicate)), ' ', nodeLink(a.object)];
const rerender = () => window.dispatchEvent(new HashChangeEvent('hashchange'));
const field = (label, input, hint) => h('div', { class: 'field' }, h('label', { for: input.id }, label), input, hint ? h('div', { class: 'small muted' }, hint) : null);
let fid = 0;
const nid = (p) => `${p}${++fid}`;
const select = (opts, value, attrs = {}) => h('select', { id: nid('sel'), ...attrs }, opts.map(([v, l]) => h('option', { value: v, selected: v === value ? true : null }, l ?? v)));
const textIn = (attrs = {}) => h('input', { id: nid('in'), type: 'text', spellcheck: 'false', ...attrs });
const textArea = (attrs = {}, text = '') => { const t = h('textarea', { id: nid('ta'), rows: 2, ...attrs }); t.value = text; return t; };

// ---- predicate allow-list (config/curation.yaml) ----------------------------------------------------
// Taken from the API when it exposes the list (GET curate/predicates or curate/config); otherwise this copy of
// config/curation.yaml's `predicates` (domain / range as Biolink categories), which must be kept in step by hand.
export const FALLBACK_PREDICATES = [
  ['biolink:mentions', 'Publication, InformationContentEntity'],
  ['biolink:has_phenotype', 'Gene, SequenceVariant, OrganismalEntity, MaterialSample, BiologicalEntity, PopulationOfIndividualOrganisms', 'PhenotypicFeature'],
  ['biolink:associated_with'], ['biolink:related_to'],
  ['biolink:expressed_in', 'Gene', 'AnatomicalEntity'], ['gramene:expressed_during', 'Gene', 'LifeStage'],
  ['biolink:participates_in', 'Gene', 'Pathway, BiologicalProcess'], ['biolink:actively_involved_in', 'Gene', 'BiologicalProcess'],
  ['biolink:orthologous_to', 'Gene', 'Gene'], ['biolink:interacts_with', 'Gene', 'Gene'], ['biolink:regulates', 'Gene', 'Gene'],
  ['biolink:has_member', 'InformationContentEntity, GeneFamily, PopulationOfIndividualOrganisms'],
  ['biolink:member_of', null, 'InformationContentEntity, GeneFamily, PopulationOfIndividualOrganisms'],
  ['biolink:has_input', 'Activity'], ['biolink:has_output', 'Activity'], ['biolink:same_as'],
].map(([id, domain = null, range = null]) => ({ id, domain, range }));
export function normPredicates(d) {
  const P = d?.predicates;
  const arr = Array.isArray(d) ? d : Array.isArray(P) ? P : P && typeof P === 'object' ? Object.entries(P).map(([id, v]) => ({ id, ...(v ?? {}) })) : [];
  return arr.map(p => (typeof p === 'string' ? { id: p } : { id: p.id ?? p.predicate, label: p.label ?? null, domain: p.domain ?? null, range: p.range ?? null }))
    .filter(p => typeof p.id === 'string' && p.id);
}
let predP = null;
function predicates() {
  predP ??= (async () => {
    for (const p of ['curate/predicates', 'curate/config']) {
      try { const list = normPredicates((await api(p)).data); if (list.length) return { list, from: `/kg/v1/${p}` }; } catch { /* not exposed */ }
    }
    return { list: FALLBACK_PREDICATES, from: null };
  })();
  return predP;
}

// ---- entry ----------------------------------------------------------------------------------------
export async function renderCurate(main, route, signal) {
  const [kind, ...rest] = route.arg.split('/');
  const id = rest.join('/');
  setTitle('Curate');
  await initAuth();
  if (signal.aborted) return;
  // public workspaces and their assertions are readable anonymously (docs/curation.md): only the home page's
  // own content and the forms need an account, and a private one answers 404 until the reader signs in
  const anon = !currentUser();
  const page = (kind === 'ws' || kind === 'assertion') && id ? kind : null;
  if (anon && !page) return anonHome(main, signal);
  try {
    if (page === 'ws') await wsPage(main, id, route, signal);
    else if (page === 'assertion') await asnPage(main, id, route, signal);
    else await homePage(main, signal);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return signInPrompt(main, 'The server did not accept your sign-in; please sign in again.');
    if (anon && e instanceof ApiError && e.status === 404)
      return signInPrompt(main, `No public ${page === 'ws' ? 'workspace' : 'assertion'} '${id}'. If it belongs to a private workspace, sign in to open it.`);
    throw e;
  }
}
// GET /curate/me for a signed-in caller (uid, email, orgs, site_role); null when anonymous (the route needs a token)
const meOf = async (signal) => (currentUser() ? (await api('curate/me', {}, { signal })).data : null);
const anonNote = () => h('p', { class: 'notice small', role: 'status' }, 'You are not signed in: this is a public workspace, shown read-only. ',
  h('a', { href: '#/curate' }, 'Sign in'), ' to add statements or to see private workspaces.');

// #/curate anonymously: the sign-in prompt, then the public workspaces (readable without an account)
async function anonHome(main, signal) {
  await signInPrompt(main, null);
  let list = [];
  try { list = (await api('curate/workspaces', {}, { signal })).data ?? []; } catch (e) { if (e.name === 'AbortError') throw e; return; }
  if (signal.aborted || !list.length) return;
  main.append(section(`Public workspaces (${list.length})`, wsTable(list.map(w => ({ w, role: null })), { roleCol: false })));
}

async function signInPrompt(main, why) {
  setTitle('Sign in');
  loadFirebase().catch(() => {});   // preload, so the popup opens within the click's user activation
  const msg = h('div', { 'aria-live': 'polite' });
  const btn = h('button', { type: 'button', class: 'primary', onclick: async () => {
    btn.disabled = true; fill(msg, h('p', { class: 'muted' }, 'Opening the Google sign-in window…'));
    try { await signInGoogle(); fill(msg); }
    catch (e) { fill(msg, errorBox(e?.code === 'auth/popup-closed-by-user' ? new Error('the sign-in window was closed') : e)); }
    finally { btn.disabled = false; }
  } }, 'Sign in with Google');
  fill(main, h('h1', null, 'Curate'),
    h('p', null, why ?? 'Curation workspaces hold statements that curators add to the knowledge graph. Sign in with your SorghumBase / Gramene account to create a workspace or add statements.'),
    h('p', null, btn), msg,
    h('p', { class: 'small muted' }, 'Browsing and search need no account.'));
  announce('Sign in required');
  if (await testMode()) main.append(testSignIn());
}

// dev servers only: the API says it is in auth test mode (KG_AUTH_TEST_SECRET set; refused with NODE_ENV=production)
function testSignIn() {
  const ta = textArea({ rows: 3, class: 'mono', 'aria-describedby': 'tt-help' });
  const msg = h('div', { 'aria-live': 'polite' });
  return h('section', { class: 'panel test-mode' }, h('h2', null, 'Test sign-in ', badge('auth test mode', 'warn')),
    h('p', { id: 'tt-help', class: 'small' }, 'This server accepts HS256 test tokens signed with KG_AUTH_TEST_SECRET ({uid, email}). Paste one to sign in for this tab only.'),
    field('Test token', ta),
    h('p', null, h('button', { type: 'button', onclick: async () => {
      try { await signInTest(ta.value); } catch (e) { fill(msg, errorBox(e)); }
    } }, 'Use test token')), msg);
}

// ---- #/curate -------------------------------------------------------------------------------------
const wsTable = (rs, { roleCol = true } = {}) => h('div', { class: 'scroll' }, h('table', { class: 'data' },
  h('thead', null, h('tr', null, ['Workspace', 'Visibility', roleCol ? 'Your role' : null, 'Updated'].filter(Boolean).map(c => h('th', { scope: 'col' }, c)))),
  h('tbody', null, rs.map(({ w, role }) => h('tr', null,
    h('td', null, h('a', { href: wsHref(wsId(w)) }, w.name || wsId(w)), w.description ? h('div', { class: 'small muted' }, w.description) : null),
    h('td', null, badge(w.visibility, w.visibility === 'public' ? 'ok' : '')), roleCol ? h('td', null, role ?? '') : null, h('td', { class: 'small' }, when(w.updated_at)))))));

async function homePage(main, signal) {
  const [me, { data: list, meta }] = await Promise.all([meOf(signal), api('curate/workspaces', {}, { signal })]);
  const uid = me?.uid ?? currentUser()?.uid;
  const site = isSiteCurator(me);
  // membership is not the API's `role` (which says 'reader' for every public workspace): owner / ACL / `member`
  const rows = (list ?? []).map(w => ({ w, role: roleOf(w, uid), member: isMember(w, uid, me?.orgs) }));
  const mine = rows.filter(r => r.member), others = rows.filter(r => !r.member);
  setTitle('Curate');
  announce(`${mine.length} workspaces`);
  fill(main,
    h('h1', null, 'Curate'),
    h('p', { class: 'muted' }, 'Signed in as ', h('strong', null, me?.display_name || me?.email || uid), me?.email && me?.display_name ? ` (${me.email})` : '',
      currentUser()?.kind === 'test' ? [' ', badge('test token', 'warn')] : null, site ? [' ', badge('site curator', 'ok')] : null),
    h('p', { class: 'small muted' }, site
      ? 'As a site curator you publish, reject and retract statements in public workspaces, and you can make a workspace you own public.'
      : 'Statements in public workspaces enter the public graph only when a site curator publishes them; making a workspace public also needs a site curator.'),
    section(`Your workspaces (${mine.length})`, mine.length ? wsTable(mine) : h('p', null, 'None yet. Create one below.')),
    others.length ? section(`Public workspaces (${others.length})`, wsTable(others)) : null,
    meta?.next ? h('p', { class: 'small muted' }, 'More workspaces exist than are listed here.') : null,
    section('New workspace', workspaceForm(site)));
}

function workspaceForm(site) {
  const name = textIn({ required: true, maxlength: 200 }), desc = textArea({ rows: 2 });
  const vis = select([['private', 'private (only people you add)'], ['public', 'public (anyone can read; published statements enter the graph)']], 'private');
  if (!site) for (const o of vis.options) if (o.value === 'public') { o.disabled = true; o.textContent += ' (site curators only)'; }
  const msg = h('div', { 'aria-live': 'polite' });
  const btn = h('button', { type: 'submit', class: 'primary' }, 'Create workspace');
  return h('form', { class: 'cform', onsubmit: async (ev) => {
    ev.preventDefault();
    if (!name.value.trim()) { fill(msg, errorBox(new Error('a name is required'))); return; }
    btn.disabled = true;
    try {
      const { data } = await api('curate/workspaces', {}, { method: 'POST', body: { name: name.value.trim(), description: desc.value.trim() || null, visibility: vis.value } });
      location.hash = wsHref(wsId(data));
    } catch (e) { fill(msg, errorBox(e)); } finally { btn.disabled = false; }
  } }, field('Name', name), field('Description', desc), field('Visibility', vis, site ? null : 'A site curator can make the workspace public later.'), h('p', null, btn), msg);
}

// ---- #/curate/ws/<id> -----------------------------------------------------------------------------
async function wsPage(main, id, route, signal) {
  const state = STATES.includes(route.params.get('state')) ? route.params.get('state') : '';
  const base = `curate/workspaces/${enc(id)}`;
  const [me, { data: ws }, asn, nodesRes] = await Promise.all([meOf(signal), api(base, {}, { signal }),
    api(`${base}/assertions`, { state, limit: LIMIT }, { signal }), api(`${base}/nodes`, { limit: LIMIT }, { signal })]);
  const uid = me?.uid ?? currentUser()?.uid;
  const anon = !uid;
  const role = anon ? null : roleOf(ws, uid);
  const site = isSiteCurator(me);
  const nodes = [...(nodesRes.data ?? [])];
  setTitle(ws.name || id);
  announce(`Workspace ${ws.name || id}`);

  const asnRows = h('tbody');
  const addAsn = (list) => { for (const a of list) asnRows.append(h('tr', null,
    h('td', null, h('a', { href: asnHref(a.id) }, a.id), h('span', { class: 'muted small' }, ` rev ${a.rev ?? ''}`)),
    h('td', null, stmt(a)), h('td', null, stateBadge(a.state)), h('td', { class: 'num' }, fmtNum((a.evidence ?? []).length)),
    h('td', { class: 'small' }, when(a.updated_at ?? a.created_at), a.created_by ? h('div', { class: 'muted' }, a.created_by) : null))); };
  addAsn(asn.data ?? []);
  let counts = ws.assertions && typeof ws.assertions === 'object' ? ws.assertions : null;
  const exact = !!counts || (!state && !asn.meta?.next && !(asn.meta?.total > (asn.data ?? []).length));
  if (!counts) { counts = {}; for (const a of asn.data ?? []) counts[a.state] = (counts[a.state] ?? 0) + 1; }
  const allN = Object.values(counts).reduce((x, y) => x + y, 0);
  const chips = h('nav', { class: 'chips', 'aria-label': 'Filter by state' },
    h('a', { href: wsHref(id), class: 'chip', 'aria-current': state ? null : 'page' }, 'all', exact ? ` (${fmtNum(allN)})` : ''),
    STATES.map(s => h('a', { href: `${wsHref(id)}?state=${s}`, class: 'chip', 'aria-current': state === s ? 'page' : null }, s, exact ? ` (${fmtNum(counts[s] ?? 0)})` : '')));

  const nodeRows = h('tbody');
  const addNodes = (list) => { for (const n of list) nodeRows.append(h('tr', null,
    h('td', null, nodeLink(curieOf(n), n.name || curieOf(n)), n.name ? h('div', null, h('code', { class: 'small' }, curieOf(n))) : null),
    h('td', null, badge(n.class ?? n.cls)), h('td', null, n.description ?? ''), h('td', { class: 'small' }, when(n.updated_at ?? n.created_at)))); };
  addNodes(nodes);
  const curNodes = () => nodes.map(n => ({ id: curieOf(n), name: n.name ?? null, class: n.class ?? n.cls ?? null }));

  const canWrite = atLeast(role, 'contributor');
  const owner = ws.owner ?? ws.ownerUid;
  fill(main,
    h('p', { class: 'crumbs small' }, h('a', { href: '#/curate' }, 'Curate'), ' › workspace'),
    h('h1', null, ws.name || id, ' ', badge(ws.visibility, ws.visibility === 'public' ? 'ok' : '')),
    anon ? anonNote() : null,
    ws.description ? h('p', { class: 'desc' }, ws.description) : null,
    dl([['Id', h('code', null, wsId(ws) ?? id)], anon ? null : ['Your role', [role ?? 'none', site ? [' ', badge('site curator', 'ok')] : null]],
      ['Owner', owner && owner === uid ? 'you' : owner],
      ['Members', (ws.acls ?? []).length ? h('ul', { class: 'quals' }, ws.acls.map(a => h('li', null, `${a.principal?.type ?? ''} ${a.principal?.id ?? ''}: ${a.role}`))) : null],
      ['Who may publish', publishersText(ws)],
      ['Created', when(ws.created_at)], ['Updated', when(ws.updated_at)]].filter(Boolean)),
    // any owner may make a workspace private; making it public is a site curator's act
    role === 'owner' ? (site || ws.visibility === 'public' ? visibilityToggle(id, ws) : h('p', { class: 'small muted' }, 'Only a site curator can make this workspace public.')) : null,
    h('section', { class: 'panel' }, h('h2', null, 'Assertions'), chips,
      (asn.data ?? []).length ? h('div', { class: 'scroll' }, h('table', { class: 'data' },
        h('thead', null, h('tr', null, ['Assertion', 'Statement', 'State', 'Evidence', 'Updated'].map(c => h('th', { scope: 'col' }, c)))), asnRows))
        : h('p', null, state ? `No ${state} assertions.` : 'No assertions yet.'),
      moreButton(`${base}/assertions`, { state }, asn, addAsn)),
    h('section', { class: 'panel' }, h('h2', null, `Curated nodes (${fmtNum(nodesRes.meta?.total ?? nodes.length)}${nodesRes.meta?.next ? '+' : ''})`),
      nodes.length ? h('div', { class: 'scroll' }, h('table', { class: 'data' },
        h('thead', null, h('tr', null, ['Node', 'Class', 'Description', 'Updated'].map(c => h('th', { scope: 'col' }, c)))), nodeRows))
        : h('p', null, 'No curated nodes. Statements about things already in the graph need none; add a node for a new publication, analysis or collection.'),
      moreButton(`${base}/nodes`, {}, nodesRes, (l) => { nodes.push(...l); addNodes(l); })),
    canWrite ? h('details', { class: 'panel form-panel' }, h('summary', null, h('h2', null, 'New curated node')), nodeForm(base)) : null,
    canWrite ? h('section', { class: 'panel form-panel' }, h('h2', null, 'New assertion'), await assertionForm({
      nodes: curNodes, submitLabel: 'Save draft',
      send: (body) => api(`${base}/assertions`, {}, { method: 'POST', body }),
      done: (data) => { location.hash = asnHref(data?.id ?? String(wsId(data) ?? '').split('@')[0]); } })) : null,
    !canWrite ? h('p', { class: 'muted' }, anon ? 'Sign in to add statements.' : 'You can read this workspace. Ask its owner for the contributor role to add statements.') : null);
}

// "Load more" for a list route: offset paging against meta.total (the curate API), or meta.next cursors
const LIMIT = 100;
function moreButton(path, params, res, add) {
  let loaded = (res.data ?? []).length, cursor = res.meta?.next ?? null;
  const total = res.meta?.total;
  const left = () => (cursor ? true : typeof total === 'number' && loaded < total && loaded > 0);
  if (!left()) return null;
  const b = h('button', { type: 'button', class: 'more', onclick: async () => {
    b.disabled = true;
    try {
      const r = await api(path, { ...params, limit: LIMIT, ...(cursor ? { cursor } : { offset: loaded }) });
      add(r.data ?? []); loaded += (r.data ?? []).length; cursor = r.meta?.next ?? null;
      b.hidden = !left() || !(r.data ?? []).length;
    } catch (e) { b.replaceWith(errorBox(e)); } finally { b.disabled = false; }
  } }, 'Load more');
  return b;
}

function visibilityToggle(id, ws) {
  const to = ws.visibility === 'public' ? 'private' : 'public';
  const msg = h('span', { 'aria-live': 'polite' });
  return h('p', { class: 'toolbar' }, h('button', { type: 'button', onclick: async (ev) => {
    if (to === 'public' && !confirm('Make this workspace public? Anyone can then read it, and its published statements enter the public graph.')) return;
    ev.target.disabled = true;
    try { await api(`curate/workspaces/${enc(id)}`, {}, { method: 'PATCH', body: { visibility: to } }); rerender(); }
    catch (e) { fill(msg, errorBox(e)); ev.target.disabled = false; }
  } }, `Make ${to}`), msg);
}

const NODE_CLASSES = [['GramenePublication', 'Publication'], ['AnalysisRun', 'Analysis'], ['KgCollection', 'Collection']];
function nodeForm(base) {
  const cls = select(NODE_CLASSES, 'GramenePublication');
  const id = textIn({ placeholder: 'PMID:29712755 or doi:10.… (analyses and collections: leave empty to get a new id)' });
  const name = textIn(), desc = textArea(), xrefs = textIn({ placeholder: 'space-separated CURIEs' });
  const members = textArea({ rows: 3, placeholder: 'one CURIE per line or space-separated' });
  const attrs = textArea({ rows: 2, placeholder: 'key=value, one per line', class: 'mono' });
  const memBox = field('Members (collection)', members, 'stored as attrs.members');
  const sync = () => { memBox.hidden = cls.value !== 'KgCollection'; };
  cls.addEventListener('change', sync); sync();
  const msg = h('div', { 'aria-live': 'polite' });
  const btn = h('button', { type: 'submit', class: 'primary' }, 'Create node');
  return h('form', { class: 'cform', onsubmit: async (ev) => {
    ev.preventDefault();
    const a = parseQualifiers(attrs.value);
    if (cls.value === 'KgCollection') { const m = members.value.split(/[\s,;]+/).filter(Boolean); if (m.length) a.members = m; }
    const body = { id: id.value.trim() || undefined, class: cls.value, name: name.value.trim() || null, description: desc.value.trim() || null,
      xrefs: xrefs.value.split(/[\s,;]+/).filter(Boolean), attrs: a };
    if (!body.id && cls.value === 'GramenePublication') { fill(msg, errorBox(new Error('a publication needs its PMID or DOI'))); return; }
    btn.disabled = true;
    try { await api(`${base}/nodes`, {}, { method: 'POST', body }); rerender(); }
    catch (e) { fill(msg, errorBox(e)); } finally { btn.disabled = false; }
  } }, field('Class', cls), field('Id', id, 'Publications are filled in from the publication cache when the id is a PMID or DOI.'),
  field('Name', name), field('Description', desc), field('Cross-references', xrefs), memBox, field('Other attributes', attrs), h('p', null, btn), msg);
}

// ---- assertion form (create, and edit of a draft / rejected revision) --------------------------------
function evidenceLine(init = {}) {
  const pubs = textIn({ value: (init.publications ?? []).join(' '), placeholder: 'PMID:29712755 doi:10.…' });
  const eco = textIn({ value: (init.has_evidence ?? []).join(' '), placeholder: 'ECO:0000269' });
  const kl = select(KNOWLEDGE_LEVELS.map(k => [k, k.replace(/_/g, ' ')]), init.knowledge_level ?? 'knowledge_assertion');
  const note = textIn({ value: init.note ?? '' });
  const legend = h('legend');
  const rm = h('button', { type: 'button', class: 'link small' }, 'remove');
  const el = h('fieldset', { class: 'evidence' }, legend, h('div', { class: 'grid2' },
    field('Publications', pubs, 'PMIDs (bare numbers are read as PMIDs) or DOIs'), field('Evidence (ECO)', eco, 'ECO ids, e.g. ECO:0000269 (experimental evidence used in manual assertion)'),
    field('Knowledge level', kl), field('Note', note)), rm);
  return { el, legend, rm, value: () => ({ publications: splitIds(pubs.value), has_evidence: normEco(eco.value), knowledge_level: kl.value, note: note.value.trim() || null }) };
}
// client-side checks; the API repeats them (and checks the CURIEs resolve)
export function checkAssertion(b) {
  const errs = [];
  if (!b.subject) errs.push('subject is required');
  if (!b.object) errs.push('object is required');
  if (!b.predicate) errs.push('predicate is required');
  if (!b.evidence.length) errs.push('at least one evidence line is required');
  b.evidence.forEach((e, i) => {
    if (!e.publications.length && !e.has_evidence.length) errs.push(`evidence line ${i + 1}: give a publication or an ECO code`);
    for (const p of e.publications) if (!/^(PMID:\d+|doi:10\.\S+)$/i.test(p)) errs.push(`evidence line ${i + 1}: “${p}” is not a PMID or DOI`);
    for (const c of e.has_evidence) if (!/^ECO:\d{7}$/.test(c)) errs.push(`evidence line ${i + 1}: “${c}” is not an ECO id`);
  });
  if (b.supersedes && !/^asn_[0-9a-f]{12}(@\d+)?$/.test(b.supersedes)) errs.push('supersedes must be an assertion id (asn_…)');
  return errs;
}

export async function assertionForm({ nodes, init = {}, submitLabel, send, done, edit = false }) {
  const { list: preds, from } = await predicates();
  const subj = curiePicker({ label: 'Subject', name: 'subject', required: true, value: init.subject ?? '', extra: nodes });
  const obj = curiePicker({ label: 'Object', name: 'object', required: true, value: init.object ?? '', extra: nodes });
  const known = preds.some(p => p.id === init.predicate);
  const pred = select([['', '— choose —'], ...(init.predicate && !known ? [[init.predicate, `${init.predicate} (not in the allow-list)`]] : []),
    ...preds.map(p => [p.id, `${p.label ?? predLabel(p.id)}  (${p.id})${p.domain || p.range ? ` ${p.domain ?? 'any'} → ${p.range ?? 'any'}` : ''}`])], init.predicate ?? '', { required: true });
  const neg = h('input', { type: 'checkbox', id: nid('cb'), checked: init.negated ? true : null });
  const quals = textArea({ rows: 2, class: 'mono', placeholder: 'key=value, one per line' }, fmtQualifiers(init.qualifiers));
  const note = textArea({ rows: 2 }, init.note ?? '');
  const disputes = textIn({ value: init.disputes ?? '', placeholder: 'gramene.assoc:… (an edge this statement disputes)' });
  const supersedes = textIn({ value: init.supersedes ?? '', placeholder: 'asn_…@rev (a published assertion this corrects)' });
  const evBox = h('div');
  const lines = [];
  const renumber = () => lines.forEach((l, i) => { l.legend.textContent = `Evidence line ${i + 1}`; l.rm.hidden = lines.length < 2; });
  const addLine = (init) => {
    const l = evidenceLine(init);
    l.rm.addEventListener('click', () => { lines.splice(lines.indexOf(l), 1); l.el.remove(); renumber(); });
    lines.push(l); evBox.append(l.el); renumber();
  };
  for (const e of init.evidence?.length ? init.evidence : [{}]) addLine(e);
  const msg = h('div', { 'aria-live': 'polite' });
  const btn = h('button', { type: 'submit', class: 'primary' }, submitLabel);
  const pickers = { subject: subj, object: obj };

  return h('form', { class: 'cform', onsubmit: async (ev) => {
    ev.preventDefault();
    const body = { subject: subj.value, predicate: pred.value, object: obj.value, negated: neg.checked, qualifiers: parseQualifiers(quals.value),
      evidence: lines.map(l => l.value()), note: note.value.trim() || null, disputes: disputes.value.trim() || null };
    if (!edit) body.supersedes = supersedes.value.trim() || null;   // PATCH takes no supersedes
    const errs = checkAssertion(body);
    if (errs.length) { fill(msg, h('div', { class: 'error', role: 'alert' }, h('strong', null, 'Please fix: '), h('ul', null, errs.map(e => h('li', null, e))))); return; }
    btn.disabled = true; fill(msg);
    try { const { data } = await send(body); done(data); }
    catch (e) { fill(msg, errorBox(e, candidatesBox(e.candidates ?? e.body?.candidates, pickers))); }
    finally { btn.disabled = false; }
  } },
  h('div', { class: 'grid2' }, subj.el, obj.el),
  field('Predicate', pred, from ? `allow-list from ${from}` : 'allow-list: config/curation.yaml (copy built into the UI)'),
  h('p', null, h('label', { for: neg.id }, neg, ' negated (the statement says this is NOT the case)')),
  h('h3', null, 'Evidence'), evBox, h('p', null, h('button', { type: 'button', onclick: () => addLine({}) }, 'Add evidence line'),
    h('span', { class: 'small muted' }, ' two or more lines make an Association node')),
  h('details', { class: 'more-fields', open: init.note || init.disputes || init.supersedes || Object.keys(init.qualifiers ?? {}).length ? true : null },
    h('summary', null, edit ? 'Note, qualifiers, disputes' : 'Note, qualifiers, disputes, supersedes'),
    field('Note', note), field('Qualifiers', quals), field('Disputes', disputes), edit ? null : field('Supersedes', supersedes, 'a correction to a published assertion of this workspace; it replaces that one when published')),
  h('p', null, btn), msg);
}

// the API refuses a draft whose subject/object does not resolve, with candidates; offer them as one-click fixes
function candidatesBox(c, pickers) {
  if (!c) return null;
  const groups = Array.isArray(c) ? [[null, c]] : Object.entries(c).filter(([, v]) => Array.isArray(v));
  if (!groups.some(([, v]) => v.length)) return null;
  return h('div', { class: 'cands' }, groups.map(([role, list]) => h('div', null,
    h('p', null, role ? `Candidates for the ${role}:` : 'Candidates:'),
    h('ul', null, list.map(x => {
      const r = role ?? x.role ?? null;
      const use = (p) => h('button', { type: 'button', class: 'link', onclick: () => pickers[p].set(x.id) }, `use as ${p}`);
      return h('li', null, h('code', null, x.id), ' ', badge(x.class), x.name ? ` ${x.name}` : '', x.genome ? h('span', { class: 'muted small' }, ` ${x.genome}`) : null, ' ',
        r && pickers[r] ? use(r) : [use('subject'), ' ', use('object')]);
    })))));
}

// ---- #/curate/assertion/<id> ------------------------------------------------------------------------
async function asnPage(main, id, route, signal) {
  const wantRev = route.params.get('rev');
  const path = `curate/assertions/${enc(id)}`;
  const [me, { data: latest }, evRes] = await Promise.all([meOf(signal), api(path, {}, { signal }),
    api(`${path}/events`, {}, { signal }).catch(e => { if (e.name === 'AbortError') throw e; return e; })]);
  const a = wantRev && String(latest.rev) !== wantRev ? (await api(path, { rev: wantRev }, { signal })).data : latest;
  const isLatest = a.rev === latest.rev;
  let ws = null;
  try { ws = (await api(`curate/workspaces/${enc(a.workspace)}`, {}, { signal })).data; } catch (e) { if (e.name === 'AbortError') throw e; }
  const uid = me?.uid ?? currentUser()?.uid;
  const anon = !uid;
  const role = anon ? null : roleOf(ws, uid);
  const site = isSiteCurator(me);
  setTitle(`Assertion ${id}`);
  announce(`Assertion ${id}, ${a.state}`);
  const acts = isLatest && !anon ? actionsFor(a.state, role, { publicWs: ws?.visibility === 'public', siteCurator: site }) : [];

  const evid = (a.evidence ?? []).length ? h('div', { class: 'scroll' }, h('table', { class: 'data' },
    h('thead', null, h('tr', null, ['#', 'Publications', 'Evidence', 'Knowledge level', 'Note'].map(c => h('th', { scope: 'col' }, c)))),
    h('tbody', null, a.evidence.map((e, i) => h('tr', null, h('td', null, String(i + 1)),
      h('td', null, (e.publications ?? []).flatMap((p, j) => (j ? [', ', pubLink(p)] : [pubLink(p)]))),
      h('td', null, (e.has_evidence ?? []).flatMap((p, j) => (j ? [', ', nodeLink(p)] : [nodeLink(p)]))),
      h('td', null, (e.knowledge_level ?? '').replace(/_/g, ' ')), h('td', null, e.note ?? '')))))) : h('p', null, 'No evidence lines.');

  const events = evRes instanceof Error ? errorBox(evRes) : (evRes.data ?? []).length ? h('div', { class: 'scroll' }, h('table', { class: 'data' },
    h('thead', null, h('tr', null, ['When', 'Who', 'Change', 'Rev', 'Reason'].map(c => h('th', { scope: 'col' }, c)))),
    h('tbody', null, evRes.data.map(e => h('tr', null, h('td', { class: 'small' }, when(e.at)), h('td', null, e.by_name ?? e.by ?? ''),
      h('td', null, e.from ? stateBadge(e.from) : '—', ' → ', stateBadge(e.to)), h('td', null, e.rev != null ? h('a', { href: asnHref(id, e.rev) }, String(e.rev)) : ''),
      h('td', null, e.reason ?? '')))))) : h('p', null, 'No review events yet.');

  const revs = (latest.revisions?.length ? [...latest.revisions] : Array.from({ length: Number(latest.rev) || 0 }, (_, i) => ({ rev: i + 1 }))).sort((x, y) => y.rev - x.rev);
  const history = h('ol', { class: 'revs', reversed: true }, revs.map(({ rev: r, state: st, updated_at, updated_by }) => h('li', { value: r },
    r === a.rev ? h('strong', { 'aria-current': 'true' }, `rev ${r}`) : h('a', { href: asnHref(id, r === latest.rev ? null : r) }, `rev ${r}`),
    st ? [' ', stateBadge(st)] : null, updated_at ? h('span', { class: 'muted small' }, ` ${when(updated_at)}${updated_by ? ` by ${updated_by}` : ''}`) : null,
    r === latest.rev ? h('span', { class: 'muted small' }, ' (latest)') : null)));

  fill(main,
    h('p', { class: 'crumbs small' }, h('a', { href: '#/curate' }, 'Curate'), ' › ', ws ? h('a', { href: wsHref(a.workspace) }, ws.name || a.workspace) : a.workspace, ' › assertion'),
    h('h1', null, `Assertion ${id} `, stateBadge(a.state)),
    anon ? anonNote() : null,
    !isLatest ? h('div', { class: 'notice', role: 'status' }, `You are viewing revision ${a.rev}. `, h('a', { href: asnHref(id) }, `Latest is revision ${latest.rev} (${latest.state}).`)) : null,
    h('p', { class: 'statement' }, stmt(a)),
    dl([
      ['Revision', `${a.rev}${a.latest === false ? ' (superseded by a later revision)' : ''}`],
      ['Workspace', ws ? h('a', { href: wsHref(a.workspace) }, ws.name || a.workspace) : a.workspace],
      anon ? null : ['Your role', [role ?? 'none', site ? [' ', badge('site curator', 'ok')] : null]],
      ws ? ['Who may publish', publishersText(ws)] : null,
      ['Qualifiers', Object.keys(a.qualifiers ?? {}).length ? h('pre', null, fmtQualifiers(a.qualifiers)) : null],
      ['Note', a.note], ['Disputes', a.disputes ? h('code', null, a.disputes) : null],
      ['Supersedes', a.supersedes ? h('a', { href: asnHref(String(a.supersedes).split('@')[0], String(a.supersedes).split('@')[1]) }, a.supersedes) : null],
      ['Edge', a.edge_id ? h('code', null, a.edge_id) : null],
      ['Association node', a.association_id ? nodeLink(a.association_id) : null],
      ['Created', [when(a.created_at), a.created_by ? ` by ${a.created_by}` : '']], ['Updated', when(a.updated_at)],
      ['Content SHA-256', a.content_sha256 ? h('code', { class: 'small' }, a.content_sha256) : null],
    ]),
    acts.filter(x => x !== 'edit').length ? actionBar(path, a, acts.filter(x => x !== 'edit')) : null,
    section(`Evidence (${(a.evidence ?? []).length})`, evid),
    acts.includes('edit') ? h('details', { class: 'panel form-panel', open: a.state === 'rejected' ? true : null },
      h('summary', null, h('h2', null, a.state === 'rejected' ? 'Edit (returns it to draft)' : 'Edit draft')),
      await assertionForm({ nodes: () => [], init: a, submitLabel: 'Save new revision', edit: true,
        send: (body) => api(path, {}, { method: 'PATCH', body }), done: () => { location.hash === asnHref(id) ? rerender() : (location.hash = asnHref(id)); } })) : null,
    section('Review events', events),
    section('History', history));
}

const ACTION_LABEL = { submit: 'Submit for review', publish: 'Publish', reject: 'Reject', retract: 'Retract' };
function actionBar(path, a, acts) {
  const msg = h('div', { 'aria-live': 'polite' });
  const reasonBox = h('div');
  const run = async (act, reason, btn) => {
    btn.disabled = true; fill(msg);
    try { await api(`${path}/${act}`, {}, { method: 'POST', body: reason ? { reason } : {} }); announce(`${ACTION_LABEL[act]}: done`); rerender(); }
    catch (e) { fill(msg, errorBox(e)); btn.disabled = false; }
  };
  const btns = acts.map(act => h('button', { type: 'button', class: act === 'publish' ? 'primary' : act === 'reject' || act === 'retract' ? 'danger' : null, onclick: (ev) => {
    if (!needsReason(act)) return run(act, null, ev.currentTarget);
    const ta = textArea({ rows: 2, required: true });
    const go = h('button', { type: 'submit', class: 'danger' }, `${ACTION_LABEL[act]} with this reason`);
    fill(reasonBox, h('form', { class: 'cform', onsubmit: (e2) => { e2.preventDefault(); if (!ta.value.trim()) { ta.focus(); return; } run(act, ta.value.trim(), go); } },
      field(`Reason (${act})`, ta, act === 'retract' ? 'The statement disappears from the graph at once; the reason is kept in the review events.' : 'The contributor sees this reason.'),
      h('p', null, go, ' ', h('button', { type: 'button', onclick: () => fill(reasonBox) }, 'Cancel'))));
    ta.focus();
  } }, ACTION_LABEL[act]));
  return h('section', { class: 'panel actions', 'aria-label': 'Review actions' }, h('p', { class: 'toolbar' }, btns), reasonBox, msg);
}
