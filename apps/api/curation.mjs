// Curation API /kg/v1/curate/* (contract: docs/curation.md). Writes go only through the bound kg_curation client
// (curation-db.mjs); reads of the build go through core.mjs, so subject/object resolution is exactly /resolve's.
// Roles per workspace come from the vendored g2p policy (packages/policy): every check is can()/assertRole() on the
// workspace, every listing readableDatasetFilter(). Anything the caller cannot read is a 404, never a 403.
// Assertion revisions are append-only: a change inserts <id>@<rev+1> (latest:true), then derives the Association node
// from the highest revision, then unsets the previous latest. A request that loses the insert (409) changes nothing.
// Site curators (kg_curation.site_roles) gate the public graph: publish / reject / retract in a public workspace, and
// making a workspace public. Callers who are not members of a workspace never see raw uids (shownUids).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import * as core from './core.mjs';
import { can, assertRole, highestRole, readableDatasetFilter, ROLES } from '../../packages/policy/index.mjs';
import { connectCurationDb } from './curation-db.mjs';
import { contentSha256, associationId, curatedEdgeId, canonical } from './curation-ids.mjs';
import { testTokensEnabled } from './auth.mjs';

const { httpError, normId, CURATION_CFG: CFG } = core;
const HERE = path.dirname(new URL(import.meta.url).pathname);
const PREFIXES = yaml.load(fs.readFileSync(path.resolve(HERE, '../../config/prefixes.yaml'), 'utf8'));
const idPattern = (prefix) => { const x = PREFIXES.external?.[prefix]?.pattern ?? PREFIXES.local?.[prefix]; return x ? new RegExp(x) : null; };
const PREDICATES = CFG.predicates ?? {};
const KLEVELS = new Set(CFG.knowledge_levels ?? []);
const STATES = ['draft', 'submitted', 'published', 'rejected', 'retracted'];
// action -> [required role, to state, from state, reason required]
const TRANSITIONS = { submit: ['contributor', 'submitted', 'draft', false], publish: ['curator', 'published', 'submitted', false],
  reject: ['curator', 'rejected', 'submitted', true], retract: ['curator', 'retracted', 'published', true] };
// in a public workspace these need a site curator (and only that: no workspace role is required for them)
const SITE_ACTIONS = new Set(['publish', 'reject', 'retract']);
const SITE_HINT = 'site curators are listed in kg_curation.site_roles (docs/curation.md "Site curators")';
const MAX_LIST = 500;
const now = () => new Date().toISOString();
const hex = (n) => crypto.randomBytes(n / 2).toString('hex');
const bad = (msg, hint) => httpError(400, msg, hint);
const str = (v, name, max, { required = false } = {}) => {
  if (v === undefined || v === null || v === '') { if (required) throw bad(`${name} is required`); return null; }
  if (typeof v !== 'string') throw bad(`${name} must be a string`);
  if (v.length > max) throw bad(`${name} is longer than ${max} characters`);
  return v.trim();
};
const strList = (v, name, max = 200) => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > max || v.some(x => typeof x !== 'string' || !x || x.length > 500)) throw bad(`${name} must be an array of at most ${max} non-empty strings`);
  return [...new Set(v.map(x => x.trim()))];
};
const onlyKeys = (b, keys, what) => {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad(`${what}: JSON object body required`);
  const extra = Object.keys(b).filter(k => !keys.includes(k));
  if (extra.length) throw bad(`${what}: unknown field${extra.length > 1 ? 's' : ''} ${extra.join(', ')}`, `fields: ${keys.join(', ')}`);
};
const pageArgs = (q) => ({ limit: core.intParam(q.limit, 100, MAX_LIST, 'limit') || 1, offset: core.intParam(q.offset, 0, 1e6, 'offset') });

// predicate: a key of the allow-list, or its local name when that is unique
function predicateOf(p) {
  if (typeof p !== 'string' || !p) throw bad('predicate is required', `allowed: ${Object.keys(PREDICATES).join(', ')}`);
  if (PREDICATES[p]) return p;
  const m = Object.keys(PREDICATES).filter(k => k.slice(k.indexOf(':') + 1) === p);
  if (m.length === 1) return m[0];
  throw bad(`predicate '${p}' is not in the curation allow-list`, `allowed: ${Object.keys(PREDICATES).join(', ')} (config/curation.yaml)`);
}
const pubId = (x) => {
  const id = normId(x);
  const [pre, local] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
  if (!['PMID', 'doi'].includes(pre) || !idPattern(pre).test(local)) throw bad(`publication '${x}' is not a PMID:<n> or doi:10.<...> CURIE`);
  return id;
};
function evidenceOf(v) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 50) throw bad('evidence must be an array of at most 50 evidence lines');
  return v.map((e, i) => {
    onlyKeys(e, ['publications', 'has_evidence', 'knowledge_level', 'note'], `evidence[${i}]`);
    const has = strList(e.has_evidence, `evidence[${i}].has_evidence`, 20);
    for (const x of has) if (!/^ECO:[0-9]{7}$/.test(x)) throw bad(`evidence[${i}].has_evidence: '${x}' is not an ECO:nnnnnnn id`);
    const kl = e.knowledge_level ?? 'knowledge_assertion';
    if (!KLEVELS.has(kl)) throw bad(`evidence[${i}].knowledge_level '${kl}' is not one of ${[...KLEVELS].join(', ')}`);
    return { publications: [...new Set(strList(e.publications, `evidence[${i}].publications`, 50).map(pubId))], has_evidence: has, knowledge_level: kl,
      note: str(e.note, `evidence[${i}].note`, 4000) };
  });
}
function qualifiersOf(v) {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length > 20) throw bad('qualifiers must be an object of at most 20 keys');
  for (const [k, x] of Object.entries(v)) {
    const okScalar = (y) => ['string', 'number', 'boolean'].includes(typeof y) && String(y).length <= 500;
    if (!/^[A-Za-z_][A-Za-z0-9_:]{0,63}$/.test(k) || !(okScalar(x) || (Array.isArray(x) && x.length <= 50 && x.every(okScalar)))) throw bad(`qualifier '${k}' must be a scalar or an array of scalars`);
  }
  return v;
}

export async function registerCuration(app, { send, who }) {
  const W = await connectCurationDb();
  const check = await W.selfCheck();
  app.log.info({ curation_db: check.db }, 'curation write client bound and indexes ensured');
  app.addHook('onClose', async () => W.close());
  const C = (n) => W.collection(n);
  const ctxOf = (release) => core.resolveRelease(release);
  const env = (reply, ctx, data, extra = {}) => send(reply, { ctx, data, extra });
  // dev servers (KG_AUTH_TEST_SECRET) say so on /curate/me, signed in (meta) or not (401 body): the UI then offers test sign-in
  const TEST_MODE = testTokensEnabled ? { auth_test_mode: true } : {};
  // every write that can change what the read side shows drops core's cached public state at once
  const wrote = () => core.invalidateCuratedCache();

  // ---- identity, users, audit ----
  async function me(req) {
    if (!req.kgUser) { const e = httpError(401, 'authentication required', req.kgAuthError ?? 'send Authorization: Bearer <Firebase ID token>'); e.extra = TEST_MODE; throw e; }
    const t = now();
    await C('users').updateOne({ _id: req.kgUser.uid }, { $set: { email: req.kgUser.email ?? null, last_seen: t, updated_at: t },
      $setOnInsert: { display_name: null, display_opt_in: false, orgs: [], created_at: t, created_by: req.kgUser.uid } }, { upsert: true });
    return core.principal(req.kgUser);
  }
  const audit = (uid, action, target, detail = null) => C('audit').insertOne({ at: now(), uid, action, target, detail });
  // site role of a signed-in caller: 'site_curator' or null (kg_curation.site_roles, edited by the operator only)
  const siteRole = async (p) => (p ? (await C('site_roles').findOne({ _id: p.uid, role: 'site_curator' }, { projection: { role: 1 } }))?.role ?? null : null);
  const needSiteCurator = async (p, what) => { if ((await siteRole(p)) !== 'site_curator') throw httpError(403, `${what} requires a site curator`, SITE_HINT); };

  // ---- identities shown ----
  // members (owner, or a user/org ACL entry) see raw uids; anyone else (anonymous, public-only readers, a site curator
  // without a role there) sees the user's display_name when display_opt_in, else a pseudonym stable per workspace
  const isMember = (p, ws) => !!p && highestRole(p, { ...ws, visibility: 'private' }) !== null;
  const pseudonym = (wsId, uid) => `user-${crypto.createHash('sha256').update(`${wsId}|${uid}`).digest('hex').slice(0, 12)}`;
  // entries: [[ws, [uid...]]] -> show(ws, uid)
  async function shownUids(p, entries) {
    const need = [...new Set(entries.filter(([ws]) => !isMember(p, ws)).flatMap(([, us]) => us).filter(u => typeof u === 'string' && u))];
    const named = new Map(need.length ? (await C('users').find({ _id: { $in: need }, display_opt_in: true }, { projection: { display_name: 1 } }).toArray())
      .filter(u => typeof u.display_name === 'string' && u.display_name.trim()).map(u => [u._id, u.display_name.trim()]) : []);
    return (ws, u) => (u == null || isMember(p, ws) ? u : named.get(u) ?? pseudonym(ws._id, u));
  }

  // ---- workspaces ----
  // the workspace if the caller holds `required` on it; 404 if they cannot read it (whether or not it exists)
  async function workspace(p, id, required = 'reader') {
    const ws = typeof id === 'string' && /^ws_[0-9a-f]{12}$/.test(id) ? await C('workspaces').findOne({ _id: id }) : null;
    if (!ws || !can(p, ws, 'reader')) throw httpError(404, `no workspace '${id}'`);
    if (required !== 'reader') assertRole(p, ws, required);
    return ws;
  }
  const wsOut = (ws, p, show) => {
    const role = highestRole(p, ws);
    return { id: ws._id, name: ws.name, description: ws.description ?? null, visibility: ws.visibility, owner: show(ws, ws.ownerUid), role, member: isMember(p, ws),
      ...(role === 'owner' ? { acls: ws.acls } : {}), created_at: ws.created_at, updated_at: ws.updated_at };
  };
  const wsOuts = async (wss, p) => { const show = await shownUids(p, wss.map(w => [w, [w.ownerUid]])); return wss.map(w => wsOut(w, p, show)); };

  app.get('/kg/v1/curate/me', async (req, reply) => {
    const p = await me(req);
    const u = await C('users').findOne({ _id: p.uid });
    const wss = await C('workspaces').find(readableDatasetFilter(p)).sort({ name: 1 }).limit(MAX_LIST).toArray();
    return env(reply, await ctxOf(), { uid: p.uid, email: u.email, display_name: u.display_name, display_opt_in: u.display_opt_in, orgs: p.orgs,
      site_role: await siteRole(p),
      workspaces: wss.map(w => ({ id: w._id, name: w.name, visibility: w.visibility, role: highestRole(p, w) })) }, TEST_MODE);
  });
  // the predicate allow-list and node classes of config/curation.yaml (for forms; categories without the biolink: prefix)
  const cats = (v) => (v?.length ? v.map(x => x.replace(/^biolink:/, '')).join(', ') : null);
  app.get('/kg/v1/curate/predicates', async (req, reply) => env(reply, await ctxOf(),
    Object.entries(PREDICATES).map(([id, v]) => ({ id, domain: cats(v?.domain), range: cats(v?.range) })),
    { node_classes: Object.fromEntries(Object.entries(CFG.node_classes ?? {}).filter(([, v]) => !v.api_only).map(([k, v]) => [k, v.category])), knowledge_levels: [...KLEVELS] }));

  app.post('/kg/v1/curate/workspaces', async (req, reply) => {
    const p = await me(req);
    const b = req.body ?? {}; onlyKeys(b, ['name', 'description', 'visibility'], 'workspace');
    const vis = b.visibility ?? 'private';
    if (!['private', 'public'].includes(vis)) throw bad(`visibility must be private or public`);
    if (vis === 'public') await needSiteCurator(p, 'a public workspace');
    const t = now();
    const ws = { _id: `ws_${hex(12)}`, name: str(b.name, 'name', 200, { required: true }), description: str(b.description, 'description', 4000),
      ownerUid: p.uid, visibility: vis, acls: [], created_at: t, updated_at: t, created_by: p.uid };
    await C('workspaces').insertOne(ws); wrote();
    await audit(p.uid, 'workspace.create', ws._id, { name: ws.name, visibility: vis });
    reply.code(201);
    return env(reply, await ctxOf(), (await wsOuts([ws], p))[0]);
  });

  app.get('/kg/v1/curate/workspaces', async (req, reply) => {
    const p = await who(req);
    const { limit, offset } = pageArgs(req.query);
    const wss = await C('workspaces').find(readableDatasetFilter(p)).sort({ name: 1, _id: 1 }).skip(offset).limit(limit).toArray();
    return env(reply, await ctxOf(), await wsOuts(wss, p));
  });

  app.get('/kg/v1/curate/workspaces/:ws', async (req, reply) => {
    const p = await who(req);
    const ws = await workspace(p, req.params.ws);
    const counts = Object.fromEntries((await C('assertions').aggregate([...topRevisions(ws._id), { $group: { _id: '$state', n: { $sum: 1 } } }]).toArray()).map(x => [x._id, x.n]));
    return env(reply, await ctxOf(), { ...(await wsOuts([ws], p))[0], assertions: counts, nodes: await C('curated_nodes').countDocuments({ workspace: ws._id }) });
  });

  app.patch('/kg/v1/curate/workspaces/:ws', async (req, reply) => {
    const p = await me(req);
    const ws = await workspace(p, req.params.ws, 'owner');
    const b = req.body ?? {}; onlyKeys(b, ['name', 'description', 'visibility'], 'workspace');
    const set = { updated_at: now() };
    if ('name' in b) set.name = str(b.name, 'name', 200, { required: true });
    if ('description' in b) set.description = str(b.description, 'description', 4000);
    if ('visibility' in b) {
      if (!['private', 'public'].includes(b.visibility)) throw bad('visibility must be private or public');
      // making a workspace public puts its published assertions into the public graph: a site curator's call
      if (b.visibility === 'public' && ws.visibility !== 'public') await needSiteCurator(p, 'making a workspace public');
      set.visibility = b.visibility;
    }
    await C('workspaces').updateOne({ _id: ws._id }, { $set: set }); wrote();
    await audit(p.uid, 'workspace.update', ws._id, { ...set, updated_at: undefined, from: { name: ws.name, visibility: ws.visibility } });
    return env(reply, await ctxOf(), (await wsOuts([{ ...ws, ...set }], p))[0]);
  });

  app.put('/kg/v1/curate/workspaces/:ws/acl', async (req, reply) => {
    const p = await me(req);
    const ws = await workspace(p, req.params.ws, 'owner');
    const b = req.body ?? {}; onlyKeys(b, ['acls'], 'acl');
    if (!Array.isArray(b.acls) || b.acls.length > 200) throw bad('acls must be an array of at most 200 entries', "[{principal: {type: 'user'|'org', id}, role}]");
    const seen = new Map();
    for (const [i, e] of b.acls.entries()) {
      onlyKeys(e, ['principal', 'role'], `acls[${i}]`);
      onlyKeys(e.principal, ['type', 'id'], `acls[${i}].principal`);
      if (!['user', 'org'].includes(e.principal.type)) throw bad(`acls[${i}].principal.type must be user or org`);
      const id = str(e.principal.id, `acls[${i}].principal.id`, 128, { required: true });
      if (!ROLES.includes(e.role)) throw bad(`acls[${i}].role must be one of ${ROLES.join(', ')}`);
      // key order {type, id} matters: readableDatasetFilter matches the principal subdocument exactly
      seen.set(`${e.principal.type}:${id}`, { principal: { type: e.principal.type, id }, role: e.role });
    }
    const acls = [...seen.values()];
    await C('workspaces').updateOne({ _id: ws._id }, { $set: { acls, updated_at: now() } }); wrote();
    await audit(p.uid, 'workspace.acl', ws._id, { acls, from: ws.acls });
    return env(reply, await ctxOf(), (await wsOuts([{ ...ws, acls }], p))[0]);
  });

  // ---- curated nodes ----
  async function publicationEnrichment(id) {
    const pc = core.mongo.db('kg_meta').collection('publication_cache');      // read-only
    const doi = id.startsWith('doi:') ? id.slice(4) : null;
    const esc = (x) => x.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
    const c = doi ? await pc.findOne({ doi: new RegExp(`^${esc(doi)}$`, 'i') }) : await pc.findOne({ _id: id });
    if (!c) return null;
    return { name: c.title ?? null, xrefs: [c._id?.startsWith('PMID:') ? c._id : null, c.doi ? `doi:${String(c.doi).toLowerCase()}` : null].filter(x => x && x !== id),
      attrs: { enriched: true, journal: c.journal ?? null, year: c.year ?? null, authors: c.authors ?? [], ...(c.n_authors ? { n_authors: c.n_authors } : {}), enrichment_source: c.source ?? null } };
  }
  // curated nodes are per workspace: _id "<ws>|<curie>", fields workspace + curie (docs/curation.md)
  const nodeKey = (wsId, curie) => `${wsId}|${curie}`;
  const nodeDocOut = (d, ws, show) => ({ id: d.curie, workspace: d.workspace, class: d.cls, category: CFG.node_classes?.[d.cls]?.category ?? null, name: d.name ?? null,
    description: d.description ?? null, xrefs: d.xrefs ?? [], attrs: d.attrs ?? {}, ...(d.assertion ? { assertion: d.assertion } : {}), rev: d.rev,
    content_sha256: d.content_sha256, created_at: d.created_at, created_by: show(ws, d.created_by), updated_at: d.updated_at });
  // curated node content_sha256: canonical JSON of its semantic fields
  const nodeSha = (d) => crypto.createHash('sha256').update(canonical({ id: d.curie, cls: d.cls, name: d.name, description: d.description, xrefs: d.xrefs, attrs: d.attrs })).digest('hex');

  app.post('/kg/v1/curate/workspaces/:ws/nodes', async (req, reply) => {
    const p = await me(req);
    // a node record in a public workspace is public at once (no publish step), so writing one is a site curator's
    // act, with or without a role in the workspace (as for publish); in a private workspace: contributor
    const ws = await workspace(p, req.params.ws);
    if (ws.visibility === 'public') await needSiteCurator(p, 'writing a curated node in a public workspace');
    else assertRole(p, ws, 'contributor');
    const b = req.body ?? {}; onlyKeys(b, ['id', 'class', 'name', 'description', 'xrefs', 'attrs', 'rev'], 'node');
    if (b.rev !== undefined && (!Number.isInteger(b.rev) || b.rev < 0)) throw bad('rev must be a non-negative integer (the revision the change is based on; 0 = new)');
    const nc = CFG.node_classes?.[b.class];
    if (!nc || nc.api_only) throw bad(`class must be one of ${Object.entries(CFG.node_classes ?? {}).filter(([, v]) => !v.api_only).map(([k]) => k).join(', ')}`,
      'Association nodes are created by the API for assertions with two or more evidence lines');
    let id = b.id ? normId(str(b.id, 'id', 300)) : (nc.mint ? nc.mint.replace('{hex}', hex(12)) : null);
    if (!id) throw bad(`id is required for class ${b.class}`, `prefixes: ${nc.id_prefixes.join(', ')}`);
    const pre = id.slice(0, id.indexOf(':')), local = id.slice(id.indexOf(':') + 1);
    if (!nc.id_prefixes.includes(pre) || !idPattern(pre)?.test(local)) throw bad(`'${id}' is not a valid ${b.class} id`, `prefixes: ${nc.id_prefixes.join(', ')} (patterns in config/prefixes.yaml)`);
    if (b.attrs !== undefined && (typeof b.attrs !== 'object' || Array.isArray(b.attrs) || b.attrs === null || JSON.stringify(b.attrs).length > 20000)) throw bad('attrs must be an object (<= 20 kB JSON)');
    const warnings = [];
    const en = b.class === 'GramenePublication' ? await publicationEnrichment(id) : null;
    if (b.class === 'GramenePublication' && !en) warnings.push(`${id} is not in kg_meta.publication_cache: not enriched (the build enriches it)`);
    const t = now();
    // this workspace's record only: the same CURIE may be curated in other workspaces too (no cross-workspace check)
    const key = nodeKey(ws._id, id);
    const prev = await C('curated_nodes').findOne({ _id: key });
    if (b.rev !== undefined && b.rev !== (prev?.rev ?? 0)) throw httpError(409, `curated node '${id}' is at revision ${prev?.rev ?? 0} in this workspace, not ${b.rev}`, 'reload and retry');
    if (prev && prev.cls !== b.class) throw httpError(409, `'${id}' is a curated ${prev.cls}, not a ${b.class}`);
    const d = { _id: key, curie: id, workspace: ws._id, cls: b.class,
      name: str(b.name, 'name', 1000) ?? en?.name ?? prev?.name ?? null,
      description: 'description' in b ? str(b.description, 'description', 10000) : prev?.description ?? null,
      xrefs: [...new Set([...strList(b.xrefs, 'xrefs').map(normId), ...(en?.xrefs ?? []), ...(b.xrefs === undefined ? prev?.xrefs ?? [] : [])])],
      attrs: { ...(b.attrs === undefined ? prev?.attrs ?? {} : {}), ...(en?.attrs ?? {}), ...(b.attrs ?? {}) },
      rev: (prev?.rev ?? 0) + 1, created_at: prev?.created_at ?? t, created_by: prev?.created_by ?? p.uid, updated_at: t, updated_by: p.uid };
    d.content_sha256 = nodeSha(d);
    // optimistic: a create is an insert (a concurrent create of the same key loses on the unique _id), an update is
    // conditional on the revision read; either loser gets a 409 and changes nothing
    if (!prev) {
      try { await C('curated_nodes').insertOne(d); } catch (e) {
        if (e.code === 11000) throw httpError(409, `curated node '${id}' was created concurrently in this workspace`, 'reload and retry');
        throw e;
      }
    } else {
      const { _id, ...set } = d;
      if (!(await C('curated_nodes').findOneAndUpdate({ _id: key, rev: prev.rev }, { $set: set })))
        throw httpError(409, `curated node '${id}' changed concurrently (revision ${prev.rev} is no longer current)`, 'reload and retry');
    }
    wrote();
    await audit(p.uid, prev ? 'node.update' : 'node.create', id, { workspace: ws._id, rev: d.rev });
    reply.code(prev ? 200 : 201);
    return env(reply, await ctxOf(), nodeDocOut(d, ws, await shownUids(p, [[ws, [d.created_by]]])), { warnings });
  });

  app.get('/kg/v1/curate/workspaces/:ws/nodes', async (req, reply) => {
    const p = await who(req);
    const ws = await workspace(p, req.params.ws);
    const { limit, offset } = pageArgs(req.query);
    const f = { workspace: ws._id, ...(req.query.class ? { cls: String(req.query.class) } : {}) };
    const docs = await C('curated_nodes').find(f).sort({ curie: 1 }).skip(offset).limit(limit).toArray();
    const show = await shownUids(p, [[ws, docs.map(d => d.created_by)]]);
    return env(reply, await ctxOf(), docs.map(d => nodeDocOut(d, ws, show)), { total: await C('curated_nodes').countDocuments(f) });
  });

  // ---- assertions ----
  const asnOut = (a, ws, show) => { const { _id, ...o } = a; return { ...o, created_by: show(ws, a.created_by), updated_by: show(ws, a.updated_by) }; };
  const asnShow = (p, ws, docs) => shownUids(p, [[ws, docs.flatMap(a => [a.created_by, a.updated_by])]]);
  // pipeline head: the highest revision of each assertion of a workspace. Matching latest:true first only narrows the
  // scan (the highest revision is always latest:true; during a revision write the previous one is too, briefly, or
  // for good if the process dies between the two writes), the $group keeps one revision per id.
  const topRevisions = (wsId) => [{ $match: { workspace: wsId, latest: true } }, { $project: { id: 1, rev: 1, state: 1, updated_at: 1 } },
    { $sort: { id: 1, rev: -1 } }, { $group: { _id: '$id', rev: { $first: '$rev' }, state: { $first: '$state' }, updated_at: { $first: '$updated_at' } } }];
  // latest revision (or rev) of an assertion the caller holds `required` on; 404 if unreadable or absent
  async function assertion(p, id, required = 'reader', rev) {
    const latest = typeof id === 'string' && /^asn_[0-9a-f]{12}$/.test(id) ? await C('assertions').find({ id }).sort({ rev: -1 }).limit(1).next() : null;
    const ws = latest && await C('workspaces').findOne({ _id: latest.workspace });
    if (!latest || !ws || !can(p, ws, 'reader')) throw httpError(404, `no assertion '${id}'`);
    if (required !== 'reader') assertRole(p, ws, required);
    if (rev === undefined) return { a: latest, ws };
    const a = await C('assertions').findOne({ id, rev });
    if (!a) throw httpError(404, `assertion '${id}' has no revision ${rev}`, `revisions 1..${latest.rev}`);
    return { a, ws };
  }

  // subject / object: a node of the build, found by /resolve's code (exact, bare id, alias), or a curated node of
  // this workspace or of a public one. Unresolvable -> 422 with candidates (search), ambiguous -> 409 with candidates.
  async function resolveEnd(ctx, raw, role, ws, p) {
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 300) throw bad(`${role} is required (a CURIE)`);
    const id = normId(raw);
    const catOf = new Map((ctx.manifest?.schema_stats?.classes ?? []).map(c => [c.class, c.category]));
    // a curated record of this CURIE in this workspace, else in a public one
    const recs = await C('curated_nodes').find({ curie: id, cls: { $ne: 'Association' } }, { projection: { workspace: 1, cls: 1 } }).toArray();
    const others = recs.filter(r => r.workspace !== ws._id).map(r => r.workspace);
    const pubWs = others.length ? new Set((await C('workspaces').find({ _id: { $in: others }, visibility: 'public' }, { projection: { _id: 1 } }).toArray()).map(w => w._id)) : new Set();
    const cn = recs.find(r => r.workspace === ws._id) ?? recs.find(r => pubWs.has(r.workspace));
    const cnOk = !!cn;
    // build nodes resolve as on /resolve for this caller (a baked curated-only node they cannot see does not)
    const res = await core.dropHidden(ctx, p, await core.resolveIds(ctx, [raw], {}));
    if (res.resolved.length) {
      const r = res.resolved[0];
      const cats = [catOf.get(r.class) ?? null, cnOk && r.id === id ? CFG.node_classes[cn.cls]?.category : null].filter(Boolean);
      return { id: r.id, cats, class: r.class, warning: r.id !== id ? `${role} '${raw}' resolved to ${r.id} (${r.match === 'alias' ? 'by alias' : 'as a bare id'})` : null };
    }
    if (cnOk) return { id, cats: [CFG.node_classes[cn.cls]?.category], class: cn.cls, warning: null };
    if (res.ambiguous.length) {
      const e = httpError(409, `${role} '${raw}' is ambiguous in ${ctx.rel._id}`, 'pass one of the candidate ids');
      e.candidates = res.ambiguous[0].candidates.map(c => ({ id: c.id, class: c.class, name: c.name, genome: c.genome, match: c.match })); throw e;
    }
    let candidates = [];
    try { candidates = (await core.search({ q: raw.replace(/^[A-Za-z.]+:/, ''), rows: 5, release: ctx.rel._id })).data.map(d => ({ id: d.id, class: d.class, name: d.name ?? null })); } catch {}
    // no search hit (e.g. an id of an older release): ids of the build sharing the longest leading part of it
    const ci = id.indexOf(':');
    for (let k = id.length; !candidates.length && ci > 0 && k > ci + 1 && id.length - k < 64; k--) {
      const rx = new RegExp('^' + id.slice(0, k).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      candidates = (await ctx.db.collection('nodes').find({ _id: rx }, { projection: { _id: 1, cls: 1, name: 1 }, maxTimeMS: 2000 }).limit(5).toArray().catch(() => []))
        .map(n => ({ id: n._id, class: n.cls, name: n.name ?? null }));
    }
    const e = httpError(422, `${role} '${raw}' does not resolve in ${ctx.rel._id} and is not a curated node`, candidates.length ? 'candidates are search hits or ids with the same leading part; create a curated node for a new publication, analysis or collection' : 'no candidates found');
    e.candidates = candidates; throw e;
  }
  const catCheck = (pred, which, end) => {
    const allowed = PREDICATES[pred]?.[which];
    if (allowed?.length && !end.cats.some(c => allowed.includes(c)))
      throw bad(`${pred} needs a ${which === 'domain' ? 'subject' : 'object'} of category ${allowed.join(' or ')}; ${end.id} is ${end.cats.join(', ') || 'uncategorised'}`, 'domain/range from config/curation.yaml');
  };
  // disputes: an edge of the build, or the edge of a published assertion (highest revision) of this workspace or of a
  // public one. Anything else, including a private workspace's edge, is the same 422 (no existence oracle, and no
  // private edge id copied into a possibly public assertion).
  async function disputesOf(ctx, v, ws) {
    if (v === undefined || v === null || v === '') return null;
    const h = String(v).replace(/^gramene\.assoc:/, '');
    if (!/^[0-9a-f]{24}$/.test(h)) throw bad(`disputes must be an edge id (gramene.assoc:<24 hex>)`);
    const id = `gramene.assoc:${h}`;
    if (await ctx.db.collection('edges').findOne({ _id: h }, { projection: { _id: 1 } })) return id;
    for (const a of await C('assertions').find({ edge_id: id, latest: true, state: 'published' }, { projection: { id: 1, rev: 1, workspace: 1 } }).limit(20).toArray()) {
      const top = await C('assertions').find({ id: a.id }, { projection: { rev: 1 } }).sort({ rev: -1 }).limit(1).next();
      if (top?.rev !== a.rev) continue;
      if (a.workspace === ws._id || (await C('workspaces').findOne({ _id: a.workspace, visibility: 'public' }, { projection: { _id: 1 } }))) return id;
    }
    throw httpError(422, `disputes: no edge '${id}' in ${ctx.rel._id} or among published assertions`);
  }
  // validated semantic fields + warnings; base = the previous revision (PATCH) or {}
  async function semantic(ctx, b, base, ws, p) {
    const m = { ...base, ...b };
    const predicate = predicateOf(m.predicate);
    const s = await resolveEnd(ctx, m.subject, 'subject', ws, p), o = await resolveEnd(ctx, m.object, 'object', ws, p);
    catCheck(predicate, 'domain', s); catCheck(predicate, 'range', o);
    if (m.negated !== undefined && m.negated !== null && typeof m.negated !== 'boolean') throw bad('negated must be a boolean');
    return { fields: { subject: s.id, predicate, object: o.id, qualifiers: qualifiersOf(m.qualifiers), negated: !!m.negated, evidence: evidenceOf(m.evidence),
      note: str(m.note, 'note', 10000), disputes: await disputesOf(ctx, m.disputes, ws) }, warnings: [s.warning, o.warning].filter(Boolean) };
  }
  // ids and hash of a revision (pure): association id for >= 2 evidence lines, edge id, content_sha256
  function setIds(doc) {
    doc.association_id = doc.evidence.length >= 2 ? associationId(doc.subject, doc.predicate, doc.object, doc.id) : null;
    doc.edge_id = doc.association_id ?? curatedEdgeId(doc.subject, doc.predicate, doc.object, doc.qualifiers, doc.id);
    doc.content_sha256 = contentSha256(doc);
    return doc;
  }
  // The Association node of an assertion, derived from its HIGHEST revision (never from the caller's own, which a
  // concurrent writer may already have passed): upsert it when that revision has an association id, delete any other
  // Association node of the assertion. Node writes are conditional on assertion_rev, so an older revision never
  // overwrites a newer one; the loop re-reads the highest revision until it did not move while syncing.
  async function syncAssociation(asnId, uid) {
    for (let i = 0; i < 5; i++) {
      const top = await C('assertions').find({ id: asnId }).sort({ rev: -1 }).limit(1).next();
      if (!top) { await C('curated_nodes').deleteMany({ cls: 'Association', assertion: asnId }); return; }
      const keep = top.association_id ? nodeKey(top.workspace, top.association_id) : null;
      if (keep) {
        const t = now();
        const n = { curie: top.association_id, workspace: top.workspace, cls: 'Association', name: `${top.subject} ${top.predicate} ${top.object}`, description: top.note ?? null,
          xrefs: [], attrs: { subject: top.subject, predicate: top.predicate, object: top.object, qualifiers: top.qualifiers }, assertion: top.id, assertion_rev: top.rev,
          updated_at: t, updated_by: uid };
        n.content_sha256 = nodeSha(n);
        try {
          await C('curated_nodes').updateOne({ _id: keep, $or: [{ assertion_rev: { $lt: top.rev } }, { assertion_rev: { $exists: false } }] },
            { $set: n, $inc: { rev: 1 }, $setOnInsert: { created_at: t, created_by: uid } }, { upsert: true });
        } catch (e) { if (e.code !== 11000) throw e; }        // already written for this or a newer revision
      }
      await C('curated_nodes').deleteMany({ cls: 'Association', assertion: asnId, $or: [{ assertion_rev: { $lte: top.rev } }, { assertion_rev: { $exists: false } }],
        ...(keep ? { _id: { $ne: keep } } : {}) });
      const again = await C('assertions').find({ id: asnId }, { projection: { rev: 1 } }).sort({ rev: -1 }).limit(1).next();
      if (again?.rev === top.rev) return;
    }
  }
  // insert a revision, then derive its Association node; a lost insert is a 409 that changed nothing, and a failed
  // derivation removes the revision again (and re-derives from what is then the highest) before the error goes out
  async function insertRevision(doc, uid, conflict) {
    try { await C('assertions').insertOne(doc); } catch (e) {
      if (e.code === 11000) throw httpError(409, conflict, 'reload and retry');
      throw e;
    }
    try { await syncAssociation(doc.id, uid); } catch (e) {
      await C('assertions').deleteOne({ _id: doc._id }).catch(() => {});
      await syncAssociation(doc.id, uid).catch(() => {});
      throw e;
    } finally { wrote(); }
  }
  // append revision rev+1 of prev with changes: insert it (and derive), then unset the old latest
  async function revise(prev, changes, uid) {
    const { _id, ...base } = prev;
    const doc = setIds({ ...base, ...changes, rev: prev.rev + 1, latest: true, updated_at: now(), updated_by: uid });
    doc._id = `${doc.id}@${doc.rev}`;
    await insertRevision(doc, uid, `assertion '${prev.id}' changed concurrently (revision ${doc.rev} exists)`);
    await C('assertions').updateOne({ _id: prev._id }, { $set: { latest: false } });
    return doc;
  }
  const event = (a, from, to, uid, reason = null) => C('review_events').insertOne({ assertion: a.id, rev: a.rev, from, to, by: uid, at: a.updated_at, reason });

  app.post('/kg/v1/curate/workspaces/:ws/assertions', async (req, reply) => {
    const p = await me(req);
    const ws = await workspace(p, req.params.ws, 'contributor');
    const b = req.body ?? {};
    onlyKeys(b, ['subject', 'predicate', 'object', 'qualifiers', 'negated', 'evidence', 'note', 'disputes', 'supersedes', 'release'], 'assertion');
    const ctx = await ctxOf(b.release ?? req.query.release);
    const { fields, warnings } = await semantic(ctx, b, {}, ws, p);
    let supersedes = null;
    if (b.supersedes) {
      const sid = String(b.supersedes).split('@')[0];
      const { a: old } = await assertion(p, sid);
      if (old.workspace !== ws._id) throw httpError(422, `supersedes: ${sid} belongs to another workspace`, 'a correction lives in the workspace of the assertion it corrects');
      if (old.state !== 'published') throw httpError(409, `supersedes: ${sid} is ${old.state}, not published`, 'only a published assertion is superseded; edit a draft instead');
      supersedes = `${old.id}@${old.rev}`;
    }
    const t = now(); const id = `asn_${hex(12)}`;
    const doc = setIds({ _id: `${id}@1`, id, rev: 1, latest: true, workspace: ws._id, state: 'draft', ...fields, supersedes,
      created_at: t, created_by: p.uid, updated_at: t, updated_by: p.uid });
    await insertRevision(doc, p.uid, `assertion id ${id} collided; retry`);
    await event(doc, null, 'draft', p.uid);
    await audit(p.uid, 'assertion.create', id, { workspace: ws._id, rev: 1, content_sha256: doc.content_sha256 });
    reply.code(201);
    return env(reply, ctx, asnOut(doc, ws, await asnShow(p, ws, [doc])), { warnings });
  });

  app.get('/kg/v1/curate/workspaces/:ws/assertions', async (req, reply) => {
    const p = await who(req);
    const ws = await workspace(p, req.params.ws);
    const { limit, offset } = pageArgs(req.query);
    let st = null;
    if (req.query.state) { st = String(req.query.state).split(','); if (st.some(x => !STATES.includes(x))) throw bad(`state must be one of ${STATES.join(', ')}`); }
    // one row per assertion (its highest revision), filtered by state, newest change first
    const [r] = await C('assertions').aggregate([...topRevisions(ws._id), ...(st ? [{ $match: { state: { $in: st } } }] : []),
      { $facet: { page: [{ $sort: { updated_at: -1, _id: 1 } }, { $skip: offset }, { $limit: limit }], total: [{ $count: 'n' }] } }], { allowDiskUse: true }).toArray();
    const keys = r.page.map(x => `${x._id}@${x.rev}`);
    const by = new Map((keys.length ? await C('assertions').find({ _id: { $in: keys } }).toArray() : []).map(a => [a._id, a]));
    const docs = keys.map(k => by.get(k)).filter(Boolean);
    const show = await asnShow(p, ws, docs);
    return env(reply, await ctxOf(), docs.map(a => asnOut(a, ws, show)), { total: r.total[0]?.n ?? 0 });
  });

  app.get('/kg/v1/curate/assertions/:id', async (req, reply) => {
    const p = await who(req);
    const rev = req.query.rev !== undefined ? core.intParam(req.query.rev, 0, 1e6, 'rev') : undefined;
    const { a, ws } = await assertion(p, req.params.id, 'reader', rev);
    const revisions = await C('assertions').find({ id: a.id }, { projection: { rev: 1, state: 1, latest: 1, updated_at: 1, updated_by: 1, content_sha256: 1 } }).sort({ rev: 1 }).toArray();
    const show = await asnShow(p, ws, [a, ...revisions]);
    return env(reply, await ctxOf(), { ...asnOut(a, ws, show), revisions: revisions.map(({ _id, ...r }) => ({ ...r, updated_by: show(ws, r.updated_by) })) });
  });

  app.patch('/kg/v1/curate/assertions/:id', async (req, reply) => {
    const p = await me(req);
    const { a: prev, ws } = await assertion(p, req.params.id, 'contributor');
    const b = req.body ?? {};
    onlyKeys(b, ['subject', 'predicate', 'object', 'qualifiers', 'negated', 'evidence', 'note', 'disputes', 'release'], 'assertion');
    if (!['draft', 'rejected'].includes(prev.state))
      throw httpError(409, `assertion ${prev.id} is ${prev.state}: only drafts are editable`, prev.state === 'published' ? 'a correction to a published assertion is a new assertion with supersedes' : 'a submitted assertion is published or rejected by a curator');
    const ctx = await ctxOf(b.release ?? req.query.release);
    const { release, ...rest } = b;
    const { fields, warnings } = await semantic(ctx, rest, Object.fromEntries(['subject', 'predicate', 'object', 'qualifiers', 'negated', 'evidence', 'note', 'disputes'].map(k => [k, prev[k]])), ws, p);
    const doc = await revise(prev, { ...fields, state: 'draft' }, p.uid);
    if (prev.state === 'rejected') await event(doc, 'rejected', 'draft', p.uid);
    await audit(p.uid, 'assertion.edit', doc.id, { rev: doc.rev, content_sha256: doc.content_sha256, from_rev: prev.rev });
    return env(reply, ctx, asnOut(doc, ws, await asnShow(p, ws, [doc])), { warnings });
  });

  app.post('/kg/v1/curate/assertions/:id/:action', async (req, reply) => {
    const tr = TRANSITIONS[req.params.action];
    if (!tr) throw httpError(404, `no route POST /kg/v1/curate/assertions/:id/${req.params.action}`, 'actions: submit, publish, reject, retract');
    const [role, to, from, needReason] = tr;
    const p = await me(req);
    const { a: prev, ws: aws } = await assertion(p, req.params.id);
    // publish / reject / retract in a public workspace: a site curator, with or without a role in the workspace;
    // everything else (and every action in a private workspace): the workspace role
    if (SITE_ACTIONS.has(req.params.action) && aws.visibility === 'public') await needSiteCurator(p, `${req.params.action} in a public workspace`);
    else assertRole(p, aws, role);
    const b = req.body ?? {}; onlyKeys(b, ['reason'], req.params.action);
    const reason = str(b.reason, 'reason', 4000, { required: needReason });
    if (prev.state !== from) throw httpError(409, `cannot ${req.params.action} assertion ${prev.id}: it is ${prev.state}, not ${from}`);
    const warnings = [];
    const ctx = await ctxOf();
    if (req.params.action === 'submit' && !prev.evidence.some(e => e.publications.length || e.has_evidence.length))
      throw httpError(422, `cannot submit ${prev.id}: no evidence line cites a publication or an ECO code`);
    if (req.params.action === 'publish') {
      // the CURIEs must still resolve in the current build (a later build reports, never deletes)
      for (const [role2, v] of [['subject', prev.subject], ['object', prev.object]]) {
        const r = await resolveEnd(ctx, v, role2, aws, p);
        if (r.id !== v) throw httpError(409, `cannot publish ${prev.id}: ${role2} '${v}' now resolves to ${r.id}`, 'edit is not possible after submission: reject it, edit the draft and resubmit');
      }
    }
    const doc = await revise(prev, { state: to }, p.uid);
    await event(doc, from, to, p.uid, reason);
    await audit(p.uid, `assertion.${req.params.action}`, doc.id, { rev: doc.rev, from, to, reason });
    if (to === 'published' && doc.supersedes) warnings.push(`supersedes ${doc.supersedes}, which is no longer shown`);
    return env(reply, ctx, asnOut(doc, aws, await asnShow(p, aws, [doc])), { warnings });
  });

  app.get('/kg/v1/curate/assertions/:id/events', async (req, reply) => {
    const p = await who(req);
    const { a, ws } = await assertion(p, req.params.id);
    const ev = await C('review_events').find({ assertion: a.id }).sort({ at: 1, _id: 1 }).toArray();
    const show = await shownUids(p, [[ws, ev.map(e => e.by)]]);
    return env(reply, await ctxOf(), ev.map(({ _id, ...e }) => ({ ...e, by: show(ws, e.by) })));
  });

  // attach reports: entries of assertions in workspaces the caller can read
  app.get('/kg/v1/curate/reports', async (req, reply) => {
    const p = await who(req);
    const ctx = await ctxOf(req.query.release);
    const reps = await C('attach_reports').find({ release: ctx.rel._id }).sort({ created_at: -1 }).limit(20).toArray();
    const ids = [...new Set(reps.flatMap(r => (r.unresolved ?? []).map(u => u.assertion)))];
    const ws = await core.readableWorkspaceIds(p);
    const wsOfAsn = new Map((await C('assertions').find({ id: { $in: ids }, latest: true }, { projection: { id: 1, workspace: 1 } }).toArray()).map(a => [a.id, a.workspace]));
    return env(reply, ctx, reps.map(({ _id, ...r }) => ({ id: _id, ...r, unresolved: (r.unresolved ?? []).filter(u => ws.has(wsOfAsn.get(u.assertion))),
      ...(r.invalid_nodes ? { invalid_nodes: r.invalid_nodes.filter(n => ws.has(n.workspace)) } : {}) })));
  });

  return { db: check.db };
}
