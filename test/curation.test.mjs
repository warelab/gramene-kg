// Curation API and curated read side, end to end against a running dev API (never the pm2 one: it has no test tokens).
//   KG_API_URL=http://127.0.0.1:12001 KG_AUTH_TEST_SECRET=<the server's> [KG_CURATION_DB=<the server's db>] node --test test/curation.test.mjs
// Every workspace this test creates is named "TEST ..." and everything it wrote (workspaces, assertions, review
// events, curated nodes, audit, users, site_roles, attach report fixture) is deleted from KG_CURATION_DB at the end.
// The site curator is inserted into site_roles directly, as the operator does (docs/curation.md "Site curators").
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { MongoClient } from 'mongodb';
import { wrap, curationDbName, connectCurationDb } from '../apps/api/curation-db.mjs';
import { curatedEdgeId, associationId, contentSha256 } from '../apps/api/curation-ids.mjs';

const API = (process.env.KG_API_URL || 'http://127.0.0.1:12001').replace(/\/+$/, '');
const SECRET = process.env.KG_AUTH_TEST_SECRET;
const DB = process.env.KG_CURATION_DB || 'kg_curation';
const MONGO_URL = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017';
if (!SECRET) throw new Error('KG_AUTH_TEST_SECRET is required (the dev server must run with the same value)');

const run = crypto.randomBytes(4).toString('hex');
const U = Object.fromEntries(['owner', 'curator', 'contributor', 'reader', 'other', 'site'].map(r => [r, `test-${r}-${run}`]));
const sign = (claims) => {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const hp = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(claims)}`;
  return `${hp}.${crypto.createHmac('sha256', SECRET).update(hp).digest('base64url')}`;
};
const nowS = () => Math.floor(Date.now() / 1000);
const tok = (uid) => sign({ uid, email: `${uid}@example.org`, iat: nowS(), exp: nowS() + 3600 });
async function api(method, p, { as, body, token } = {}) {
  const headers = {};
  if (as) headers.authorization = `Bearer ${tok(U[as])}`;
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(API + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
const get = (p, as) => api('GET', p, { as });
const gql = (query, as) => api('POST', '/kg/graphql', { as, body: { query } });
const enc = encodeURIComponent;
const S = {};                                       // state shared by the ordered tests

const mongo = await MongoClient.connect(MONGO_URL);
await mongo.db(DB).collection('site_roles').insertOne({ _id: U.site, role: 'site_curator', email: `${U.site}@example.org`, added_by: 'curation.test.mjs', added_at: new Date().toISOString() });
const pseudo = /^user-[0-9a-f]{12}$/;
after(async () => {
  const db = mongo.db(DB);
  await db.collection('site_roles').deleteMany({ _id: { $in: Object.values(U) } });
  const ws = (await db.collection('workspaces').find({ name: /^TEST /, ownerUid: { $in: Object.values(U) } }, { projection: { _id: 1 } }).toArray()).map(w => w._id);
  const asn = (await db.collection('assertions').distinct('id', { workspace: { $in: ws } }));
  await db.collection('review_events').deleteMany({ assertion: { $in: asn } });
  await db.collection('assertions').deleteMany({ workspace: { $in: ws } });
  await db.collection('curated_nodes').deleteMany({ workspace: { $in: ws } });
  await db.collection('audit').deleteMany({ $or: [{ uid: { $in: Object.values(U) } }, { target: { $in: [...ws, ...asn] } }] });
  await db.collection('attach_reports').deleteMany({ _id: `TEST-${run}@000000000000` });
  await db.collection('users').deleteMany({ _id: { $in: Object.values(U) } });
  await db.collection('workspaces').deleteMany({ _id: { $in: ws } });
  const left = await db.collection('workspaces').countDocuments({ ownerUid: { $in: Object.values(U) } });
  await mongo.close();
  assert.equal(left, 0, 'test workspaces left behind');
});

// ---- auth --------------------------------------------------------------------------------------
test('auth: 401 without or with a bad token, /curate/me with a test token', async () => {
  assert.equal((await get('/kg/v1/curate/me')).status, 401);
  const bad = await api('GET', '/kg/v1/curate/me', { token: tok(U.owner).slice(0, -3) + 'AAA' });
  assert.equal(bad.status, 401); assert.match(bad.json.hint, /invalid/);
  const forged = await api('GET', '/kg/v1/curate/me', { token: (() => { const t = tok(U.owner).split('.'); return `${t[0]}.${t[1]}.`; })() });
  assert.equal(forged.status, 401);
  for (const r of Object.keys(U)) {
    const m = await get('/kg/v1/curate/me', r);
    assert.equal(m.status, 200); assert.equal(m.json.data.uid, U[r]); assert.equal(m.json.data.display_opt_in, false);
    assert.equal(m.json.data.site_role, r === 'site' ? 'site_curator' : null);
  }
});
test('auth: test tokens need exp (in the future, at most 1 h ahead) and an iat not in the future', async () => {
  const me = (claims) => api('GET', '/kg/v1/curate/me', { token: sign({ uid: U.other, ...claims }) });
  for (const [what, c] of [['no exp', {}], ['exp 0', { exp: 0 }], ['exp past', { exp: nowS() - 5 }], ['exp string', { exp: String(nowS() + 60) }],
    ['exp > 1 h', { exp: nowS() + 3600 + 120 }], ['exp far', { exp: 9999999999 }], ['iat future', { iat: nowS() + 600, exp: nowS() + 900 }]]) {
    const r = await me(c); assert.equal(r.status, 401, what); assert.match(r.json.hint, /invalid or expired/, what);
  }
  assert.equal((await me({ exp: nowS() + 600 })).status, 200);
  assert.equal((await me({ iat: nowS() - 60, exp: nowS() + 3600 })).status, 200);
});

// ---- workspaces and ACL ------------------------------------------------------------------------
test('workspaces: create, list by visibility, 404 for unreadable, ACL roles', async () => {
  assert.equal((await api('POST', '/kg/v1/curate/workspaces', { body: { name: 'TEST anon' } })).status, 401);
  const priv = await api('POST', '/kg/v1/curate/workspaces', { as: 'owner', body: { name: `TEST priv ${run}`, description: 'curation.test.mjs' } });
  assert.equal(priv.status, 201); assert.equal(priv.json.data.visibility, 'private'); assert.equal(priv.json.data.role, 'owner');
  // a public workspace needs a site curator: created public by one, or made public by an owner who is one
  const pubNo = await api('POST', '/kg/v1/curate/workspaces', { as: 'owner', body: { name: `TEST pub ${run}`, visibility: 'public' } });
  assert.equal(pubNo.status, 403); assert.match(pubNo.json.error, /requires a site curator/);
  const pub = await api('POST', '/kg/v1/curate/workspaces', { as: 'owner', body: { name: `TEST pub ${run}` } });
  assert.equal(pub.status, 201);
  S.priv = priv.json.data.id; S.pub = pub.json.data.id;
  assert.equal((await api('PATCH', `/kg/v1/curate/workspaces/${S.pub}`, { as: 'owner', body: { visibility: 'public' } })).status, 403);
  assert.equal((await api('PATCH', `/kg/v1/curate/workspaces/${S.pub}`, { as: 'site', body: { visibility: 'public' } })).status, 404);   // no role: unreadable
  assert.equal((await api('PUT', `/kg/v1/curate/workspaces/${S.pub}/acl`, { as: 'owner', body: { acls: [{ principal: { type: 'user', id: U.site }, role: 'curator' }] } })).status, 200);
  assert.equal((await api('PATCH', `/kg/v1/curate/workspaces/${S.pub}`, { as: 'site', body: { visibility: 'public' } })).status, 403);   // curator, not owner
  assert.equal((await api('PUT', `/kg/v1/curate/workspaces/${S.pub}/acl`, { as: 'owner', body: { acls: [{ principal: { type: 'user', id: U.site }, role: 'owner' }] } })).status, 200);
  const made = await api('PATCH', `/kg/v1/curate/workspaces/${S.pub}`, { as: 'site', body: { visibility: 'public' } });
  assert.equal(made.status, 200); assert.equal(made.json.data.visibility, 'public');
  // a site curator may create a public workspace; the owner (not a site curator) may still make it private
  const sp = await api('POST', '/kg/v1/curate/workspaces', { as: 'site', body: { name: `TEST site pub ${run}`, visibility: 'public' } });
  assert.equal(sp.status, 201); S.sitePub = sp.json.data.id;
  assert.equal((await api('POST', '/kg/v1/curate/workspaces', { as: 'owner', body: { name: 'TEST x', visibility: 'secret' } })).status, 400);
  assert.equal((await api('POST', '/kg/v1/curate/workspaces', { as: 'owner', body: { name: 'TEST x', bogus: 1 } })).status, 400);

  const anonList = (await get('/kg/v1/curate/workspaces?limit=500')).json.data.map(w => w.id);
  assert.ok(anonList.includes(S.pub)); assert.ok(!anonList.includes(S.priv));
  const ownList = (await get('/kg/v1/curate/workspaces?limit=500', 'owner')).json.data.map(w => w.id);
  assert.ok(ownList.includes(S.priv));
  for (const as of [undefined, 'other', 'reader']) {
    const r = await get(`/kg/v1/curate/workspaces/${S.priv}`, as);
    assert.equal(r.status, 404, `GET private ws as ${as}`); assert.equal(r.json.error, `no workspace '${S.priv}'`);
  }
  assert.equal((await get('/kg/v1/curate/workspaces/ws_000000000000', 'owner')).json.error, "no workspace 'ws_000000000000'");
  const anonPub = await get(`/kg/v1/curate/workspaces/${S.pub}`);
  assert.equal(anonPub.status, 200); assert.equal(anonPub.json.data.role, 'reader'); assert.equal(anonPub.json.data.acls, undefined);
  // no raw uid for non-members: a pseudonym stable per workspace (and different between workspaces)
  assert.match(anonPub.json.data.owner, pseudo); assert.equal(anonPub.json.data.member, false);
  assert.equal((await get(`/kg/v1/curate/workspaces/${S.pub}`, 'other')).json.data.owner, anonPub.json.data.owner);
  const anonRow = (await get('/kg/v1/curate/workspaces?limit=500')).json.data.find(w => w.id === S.pub);
  assert.equal(anonRow.owner, anonPub.json.data.owner); assert.ok(!JSON.stringify(anonRow).includes(U.owner));
  assert.equal((await get(`/kg/v1/curate/workspaces/${S.pub}`, 'owner')).json.data.owner, U.owner);

  // ACL: only the owner; unreadable -> 404, readable without the role -> 403
  const acls = [{ principal: { type: 'user', id: U.curator }, role: 'curator' }, { principal: { type: 'user', id: U.contributor }, role: 'contributor' },
    { principal: { type: 'user', id: U.reader }, role: 'reader' }];
  assert.equal((await api('PUT', `/kg/v1/curate/workspaces/${S.priv}/acl`, { as: 'other', body: { acls } })).status, 404);
  assert.equal((await api('PUT', `/kg/v1/curate/workspaces/${S.priv}/acl`, { body: { acls } })).status, 401);
  assert.equal((await api('PUT', `/kg/v1/curate/workspaces/${S.priv}/acl`, { as: 'owner', body: { acls: [{ principal: { type: 'user', id: 'x' }, role: 'admin' }] } })).status, 400);
  for (const ws of [S.priv, S.pub]) {
    const r = await api('PUT', `/kg/v1/curate/workspaces/${ws}/acl`, { as: 'owner', body: { acls } });
    assert.equal(r.status, 200); assert.equal(r.json.data.acls.length, 3);
  }
  assert.equal((await get(`/kg/v1/curate/workspaces/${S.pub}`)).json.data.visibility, 'public');
  assert.equal((await api('PUT', `/kg/v1/curate/workspaces/${S.priv}/acl`, { as: 'curator', body: { acls } })).status, 403);
  for (const [as, role] of [['curator', 'curator'], ['contributor', 'contributor'], ['reader', 'reader']]) {
    const r = await get(`/kg/v1/curate/workspaces/${S.priv}`, as);
    assert.equal(r.status, 200); assert.equal(r.json.data.role, role); assert.equal(r.json.data.acls, undefined);
    assert.equal(r.json.data.owner, U.owner); assert.equal(r.json.data.member, true);     // members see uids
  }
  assert.equal((await api('PATCH', `/kg/v1/curate/workspaces/${S.priv}`, { as: 'curator', body: { name: 'TEST nope' } })).status, 403);
  const pat = await api('PATCH', `/kg/v1/curate/workspaces/${S.priv}`, { as: 'owner', body: { name: `TEST priv ${run} renamed` } });
  assert.equal(pat.status, 200); assert.equal(pat.json.data.name, `TEST priv ${run} renamed`);
  const me = await get('/kg/v1/curate/me', 'reader');
  assert.deepEqual(me.json.data.workspaces.filter(w => [S.priv, S.pub].includes(w.id)).map(w => w.role), ['reader', 'reader']);
});

// ---- curated nodes ------------------------------------------------------------------------------
test('curated nodes: publication enrichment, minted ids, role checks', async () => {
  const P = `/kg/v1/curate/workspaces/${S.priv}/nodes`;
  assert.equal((await api('POST', P, { as: 'reader', body: { class: 'GramenePublication', id: 'PMID:29712755' } })).status, 403);
  assert.equal((await api('POST', P, { as: 'other', body: { class: 'GramenePublication', id: 'PMID:29712755' } })).status, 404);
  const n = await api('POST', P, { as: 'contributor', body: { class: 'GramenePublication', id: 'PMID:29712755', attrs: { note: 'TEST priv record' } } });
  assert.equal(n.status, 201, n.text);
  assert.equal(n.json.data.id, 'PMID:29712755'); assert.equal(n.json.data.workspace, S.priv);
  assert.equal(n.json.data.attrs.journal, 'Genome research'); assert.equal(n.json.data.attrs.enriched, true);
  assert.match(n.json.data.name, /comparative transcriptional landscape/);
  assert.ok(n.json.data.xrefs.includes('doi:10.1101/gr.227462.117'));
  assert.match(n.json.data.content_sha256, /^[0-9a-f]{64}$/);
  // the same CURIE in another workspace is its own record (no 409, no hint that another workspace holds it)
  const oth = await api('POST', '/kg/v1/curate/workspaces', { as: 'other', body: { name: `TEST other ${run}` } });
  S.otherWs = oth.json.data.id;
  const o2 = await api('POST', `/kg/v1/curate/workspaces/${S.otherWs}/nodes`, { as: 'other', body: { class: 'GramenePublication', id: 'PMID:29712755' } });
  assert.equal(o2.status, 201, o2.text); assert.equal(o2.json.data.workspace, S.otherWs); assert.equal(o2.json.data.rev, 1);
  const col = await api('POST', P, { as: 'contributor', body: { class: 'KgCollection', name: 'TEST collection' } });
  assert.equal(col.status, 201); assert.match(col.json.data.id, /^gramene\.collection:cur_[0-9a-f]{12}$/);
  S.col = col.json.data.id;
  const oc = await api('POST', `/kg/v1/curate/workspaces/${S.otherWs}/nodes`, { as: 'other', body: { class: 'KgCollection', id: S.col, name: 'TEST other collection' } });
  assert.equal(oc.status, 201, oc.text);
  const an = await api('POST', P, { as: 'curator', body: { class: 'AnalysisRun', name: 'TEST analysis', attrs: { software: 'x' } } });
  assert.equal(an.status, 201); assert.match(an.json.data.id, /^gramene\.analysis:curated\.[0-9a-f]{12}@v1$/);
  assert.equal((await api('POST', P, { as: 'contributor', body: { class: 'Association', id: 'gramene.assoc:0123456789abcdef01234567' } })).status, 400);
  assert.equal((await api('POST', P, { as: 'contributor', body: { class: 'GramenePublication', id: 'PMID:abc' } })).status, 400);
  assert.equal((await api('POST', P, { as: 'contributor', body: { class: 'KgCollection', id: 'gramene.collection:a/b' } })).status, 400);
  // a publication the build does not have, curated in the public workspace (used by the association test)
  S.newPub = `PMID:${9990000000 + Number.parseInt(run.slice(0, 4), 16)}`;
  // a node record in a public workspace is public at once: a site curator writes it, a contributor cannot
  assert.equal((await api('POST', `/kg/v1/curate/workspaces/${S.pub}/nodes`, { as: 'contributor', body: { class: 'GramenePublication', id: S.newPub, name: 'TEST unpublished paper' } })).status, 403);
  const np = await api('POST', `/kg/v1/curate/workspaces/${S.pub}/nodes`, { as: 'site', body: { class: 'GramenePublication', id: S.newPub, name: 'TEST unpublished paper' } });
  assert.equal(np.status, 201); assert.ok(np.json.meta.warnings.some(w => /not enriched/.test(w)));
  const list = await get(P, 'reader');
  assert.equal(list.status, 200); assert.ok(list.json.data.some(d => d.id === col.json.data.id));
  assert.equal((await get(P)).status, 404);
  assert.equal((await get(P, 'other')).status, 404);
});

// ---- assertions: resolution and validation -------------------------------------------------------
test('assertions: resolve-or-refuse, allow-list, domain/range', async () => {
  const P = `/kg/v1/curate/workspaces/${S.priv}/assertions`;
  const ev = [{ publications: ['PMID:29712755'], has_evidence: ['ECO:0000352'] }];
  const dangling = await api('POST', P, { as: 'contributor', body: { subject: 'PMID:29712755', predicate: 'biolink:mentions', object: 'gramene.genetree:SB10GT_1', evidence: ev } });
  assert.equal(dangling.status, 422); assert.ok(Array.isArray(dangling.json.candidates)); assert.match(dangling.json.error, /does not resolve/);
  const amb = await api('POST', P, { as: 'contributor', body: { subject: 'PMID:29712755', predicate: 'biolink:mentions', object: 'Sobic.007G158500', evidence: ev } });
  assert.equal(amb.status, 409); assert.ok(amb.json.candidates.length >= 2);
  assert.equal((await api('POST', P, { as: 'contributor', body: { subject: 'PMID:29712755', predicate: 'biolink:eats', object: 'gxa.expt:E-MTAB-5956' } })).status, 400);
  const dom = await api('POST', P, { as: 'contributor', body: { subject: 'PMID:29712755', predicate: 'biolink:expressed_in', object: 'gxa.expt:E-MTAB-5956' } });
  assert.equal(dom.status, 400); assert.match(dom.json.error, /needs a subject of category/);
  assert.equal((await api('POST', P, { as: 'contributor', body: { subject: 'PMID:29712755', predicate: 'mentions', object: 'gxa.expt:E-MTAB-5956', evidence: [{ has_evidence: ['ECO:12'] }] } })).status, 400);
  assert.equal((await api('POST', P, { as: 'reader', body: { subject: 'PMID:29712755', predicate: 'mentions', object: 'gxa.expt:E-MTAB-5956' } })).status, 403);
  assert.equal((await api('POST', P, { as: 'other', body: { subject: 'PMID:29712755', predicate: 'mentions', object: 'gxa.expt:E-MTAB-5956' } })).status, 404);
  assert.equal((await api('POST', P, { body: { subject: 'PMID:29712755', predicate: 'mentions', object: 'gxa.expt:E-MTAB-5956' } })).status, 401);
  // a bare id resolves like /resolve and says so; a bare predicate takes its allow-list prefix
  const ok = await api('POST', P, { as: 'contributor', body: { subject: 'PMID:29712755', predicate: 'mentions', object: 'E-MTAB-5956', evidence: ev, note: 'TEST first' } });
  assert.equal(ok.status, 201, ok.text);
  const a = ok.json.data;
  assert.equal(a.object, 'gxa.expt:E-MTAB-5956'); assert.equal(a.predicate, 'biolink:mentions'); assert.ok(ok.json.meta.warnings.some(w => /resolved to gxa\.expt:E-MTAB-5956/.test(w)));
  assert.equal(a.state, 'draft'); assert.equal(a.rev, 1); assert.equal(a.latest, true); assert.equal(a.workspace, S.priv); assert.equal(a.association_id, null);
  assert.match(a.id, /^asn_[0-9a-f]{12}$/);
  assert.equal(a.edge_id, curatedEdgeId(a.subject, a.predicate, a.object, {}, a.id));
  assert.equal(a.content_sha256, contentSha256(a));
  S.a1 = a;
});

// ---- states, revisions, roles, events ------------------------------------------------------------
test('assertions: edit, submit, publish with role boundaries; revisions and events', async () => {
  const A = `/kg/v1/curate/assertions/${S.a1.id}`;
  for (const as of [undefined, 'other']) assert.equal((await get(A, as)).status, 404, `GET private assertion as ${as}`);
  assert.equal((await get(`${A}/events`)).status, 404);
  assert.equal((await api('PATCH', A, { as: 'reader', body: { note: 'x' } })).status, 403);
  assert.equal((await api('PATCH', A, { as: 'other', body: { note: 'x' } })).status, 404);
  const e1 = await api('PATCH', A, { as: 'contributor', body: { note: 'TEST edited' } });
  assert.equal(e1.status, 200); assert.equal(e1.json.data.rev, 2); assert.equal(e1.json.data.note, 'TEST edited');
  assert.notEqual(e1.json.data.content_sha256, S.a1.content_sha256);
  const r1 = await get(`${A}?rev=1`, 'reader');
  assert.equal(r1.json.data.rev, 1); assert.equal(r1.json.data.latest, false); assert.equal(r1.json.data.note, 'TEST first');
  assert.equal((await get(`${A}?rev=9`, 'reader')).status, 404);
  assert.equal((await api('POST', `${A}/submit`, { as: 'reader' })).status, 403);
  assert.equal((await api('POST', `${A}/publish`, { as: 'curator' })).status, 409);        // still a draft
  const sub = await api('POST', `${A}/submit`, { as: 'contributor' });
  assert.equal(sub.status, 200); assert.equal(sub.json.data.state, 'submitted'); assert.equal(sub.json.data.rev, 3);
  assert.equal((await api('PATCH', A, { as: 'contributor', body: { note: 'late' } })).status, 409);
  assert.equal((await api('POST', `${A}/publish`, { as: 'contributor' })).status, 403);
  assert.equal((await api('POST', `${A}/publish`)).status, 401);
  assert.equal((await api('POST', `${A}/frobnicate`, { as: 'curator' })).status, 404);
  const pubd = await api('POST', `${A}/publish`, { as: 'curator' });
  assert.equal(pubd.status, 200); assert.equal(pubd.json.data.state, 'published'); assert.equal(pubd.json.data.rev, 4);
  assert.equal((await api('PATCH', A, { as: 'owner', body: { note: 'x' } })).status, 409);
  const g = await get(A, 'reader');
  assert.deepEqual(g.json.data.revisions.map(r => [r.rev, r.state, r.latest]), [[1, 'draft', false], [2, 'draft', false], [3, 'submitted', false], [4, 'published', true]]);
  const ev = await get(`${A}/events`, 'reader');
  assert.deepEqual(ev.json.data.map(e => [e.from, e.to, e.by]), [[null, 'draft', U.contributor], ['draft', 'submitted', U.contributor], ['submitted', 'published', U.curator]]);
  assert.ok(ev.json.data.every(e => e.at));
  const list = await get(`/kg/v1/curate/workspaces/${S.priv}/assertions?state=published`, 'reader');
  assert.deepEqual(list.json.data.map(x => x.id), [S.a1.id]);
  assert.equal((await get(`/kg/v1/curate/workspaces/${S.priv}/assertions?state=bogus`, 'reader')).status, 400);
  S.a1 = pubd.json.data;
});

// ---- read side: private visibility on REST and GraphQL ------------------------------------------
const ownEdges = (r, id) => (r.json.data ?? []).filter(e => e.curation?.assertion === id);
async function mentionsIn(as) {
  const r = await get(`/kg/v1/node/${enc('gxa.expt:E-MTAB-5956')}/edges?direction=in&predicate=biolink:mentions&limit=500`, as);
  assert.equal(r.status, 200); return r;
}
test('read side: a private published assertion is visible to readers only (REST, GraphQL)', async () => {
  const eid = S.a1.edge_id;
  const anon = await mentionsIn(); const rdr = await mentionsIn('reader'); const oth = await mentionsIn('other');
  assert.equal(ownEdges(anon, S.a1.id).length, 0); assert.equal(ownEdges(oth, S.a1.id).length, 0);
  const [e] = ownEdges(rdr, S.a1.id);
  assert.ok(e, 'reader sees the curated edge');
  assert.equal(e.id, eid); assert.equal(e.provenance.layer, 'curated'); assert.equal(e.provenance.primary_knowledge_source, 'infores:sorghumbase-curation');
  assert.equal(e.provenance.agent_type, 'manual_agent'); assert.deepEqual(e.provenance.publications, ['PMID:29712755']); assert.deepEqual(e.provenance.has_evidence, ['ECO:0000352']);
  assert.deepEqual(e.curation, { assertion: S.a1.id, rev: 4, state: 'published', workspace: S.priv });
  assert.equal(e.direction, 'in'); assert.equal(e.other.id, 'PMID:29712755');
  assert.equal(rdr.json.meta.degree['biolink:mentions|in'], (anon.json.meta.degree['biolink:mentions|in'] ?? 0) + 1);
  // /node degree and the warning
  const nA = await get(`/kg/v1/node/${enc('gxa.expt:E-MTAB-5956')}`); const nR = await get(`/kg/v1/node/${enc('gxa.expt:E-MTAB-5956')}`, 'reader');
  assert.equal(nR.json.data.degree['biolink:mentions|in'], (nA.json.data.degree['biolink:mentions|in'] ?? 0) + 1);
  assert.ok(nR.json.meta.warnings.some(w => /^curated counts as of build /.test(w)));
  // /edge/:id
  assert.equal((await get(`/kg/v1/edge/${enc(eid)}`)).status, 404); assert.equal((await get(`/kg/v1/edge/${enc(eid)}`, 'other')).status, 404);
  const er = await get(`/kg/v1/edge/${enc(eid)}`, 'reader');
  assert.equal(er.status, 200); assert.equal(er.json.data.curation.assertion, S.a1.id); assert.equal(er.json.data.subject_node.id, 'PMID:29712755');
  // GraphQL: identity passes through to core
  const q = `{ node(id:"gxa.expt:E-MTAB-5956"){ degree neighbors(direction:IN, predicate:"biolink:mentions", first:100){ edges{ node{ id curation provenance{ layer } other{ id } } } } } }`;
  const has = (r) => r.json.data.node.neighbors.edges.some(x => x.node.curation?.assertion === S.a1.id);
  assert.equal(has(await gql(q)), false); assert.equal(has(await gql(q, 'other')), false); assert.equal(has(await gql(q, 'reader')), true);
  const ge = (as) => gql(`{ edge(id:"${eid}"){ id curation subjectNode{ id } } }`, as);
  const gA = await ge(); assert.equal(gA.json.data.edge, null); assert.equal(gA.json.errors[0].extensions.status, 404);
  const gR = await ge('reader'); assert.equal(gR.json.data.edge.curation.workspace, S.priv); assert.equal(gR.json.data.edge.subjectNode.id, 'PMID:29712755');
  const gn = (as) => gql(`{ nodes(ids:["gxa.expt:E-MTAB-5956"]){ degree } }`, as);
  assert.equal((await gn('reader')).json.data.nodes[0].degree['biolink:mentions|in'], ((await gn()).json.data.nodes[0].degree['biolink:mentions|in'] ?? 0) + 1);
  // making the workspace public (a site curator who is an owner there) shows it to everyone at once, although
  // anonymous reads go through a 10 s cache of the public workspaces (dropped by the write); private again hides it
  assert.equal((await api('PATCH', `/kg/v1/curate/workspaces/${S.priv}`, { as: 'owner', body: { visibility: 'public' } })).status, 403);
  await mentionsIn();                                                  // warm the anonymous cache
  const acls = [{ principal: { type: 'user', id: U.curator }, role: 'curator' }, { principal: { type: 'user', id: U.contributor }, role: 'contributor' },
    { principal: { type: 'user', id: U.reader }, role: 'reader' }, { principal: { type: 'user', id: U.site }, role: 'owner' }];
  assert.equal((await api('PUT', `/kg/v1/curate/workspaces/${S.priv}/acl`, { as: 'owner', body: { acls } })).status, 200);
  assert.equal((await api('PATCH', `/kg/v1/curate/workspaces/${S.priv}`, { as: 'site', body: { visibility: 'public' } })).status, 200);
  assert.equal(ownEdges(await mentionsIn(), S.a1.id).length, 1);
  const anonA = await get(`/kg/v1/curate/assertions/${S.a1.id}`);
  assert.equal(anonA.status, 200);
  // anonymous: no raw uid anywhere (assertion, revisions, events, nodes), a pseudonym instead
  assert.ok(!anonA.text.includes(U.contributor) && !anonA.text.includes(U.curator), 'uids leaked to anonymous');
  assert.match(anonA.json.data.created_by, pseudo); assert.ok(anonA.json.data.revisions.every(r => pseudo.test(r.updated_by)));
  const anonEv = await get(`/kg/v1/curate/assertions/${S.a1.id}/events`);
  assert.ok(anonEv.json.data.every(e => pseudo.test(e.by))); assert.ok(!anonEv.text.includes(U.contributor));
  assert.equal(anonEv.json.data[0].by, anonA.json.data.created_by);                  // stable within the workspace
  const anonN = await get(`/kg/v1/curate/workspaces/${S.priv}/nodes`);
  assert.ok(!anonN.text.includes(U.contributor) && !anonN.text.includes(U.curator));
  const anonL = await get(`/kg/v1/curate/workspaces/${S.priv}/assertions`);
  assert.ok(!anonL.text.includes(U.contributor));
  // display_name only with display_opt_in
  await mongo.db(DB).collection('users').updateOne({ _id: U.contributor }, { $set: { display_name: 'TEST Contributor', display_opt_in: false } });
  assert.match((await get(`/kg/v1/curate/assertions/${S.a1.id}`)).json.data.created_by, pseudo);
  await mongo.db(DB).collection('users').updateOne({ _id: U.contributor }, { $set: { display_opt_in: true } });
  assert.equal((await get(`/kg/v1/curate/assertions/${S.a1.id}`, 'other')).json.data.created_by, 'TEST Contributor');
  assert.equal((await get(`/kg/v1/curate/assertions/${S.a1.id}`, 'reader')).json.data.created_by, U.contributor);   // member
  assert.equal((await api('PATCH', `/kg/v1/curate/workspaces/${S.priv}`, { as: 'owner', body: { visibility: 'private' } })).status, 200);
  assert.equal(ownEdges(await mentionsIn(), S.a1.id).length, 0);
  assert.equal((await get(`/kg/v1/curate/assertions/${S.a1.id}`)).status, 404);
});

// ---- reject -> draft, retract masks -------------------------------------------------------------
test('reject needs a reason and returns to draft by editing; retract masks the edge and the degree', async () => {
  const P = `/kg/v1/curate/workspaces/${S.priv}/assertions`;
  const b = await api('POST', P, { as: 'contributor', body: { subject: 'PMID:29712755', predicate: 'biolink:mentions', object: 'TO:0000207', evidence: [{ publications: ['PMID:29712755'] }] } });
  assert.equal(b.status, 201);
  const A = `/kg/v1/curate/assertions/${b.json.data.id}`;
  assert.equal((await api('POST', `${A}/submit`, { as: 'contributor' })).status, 200);
  assert.equal((await api('POST', `${A}/reject`, { as: 'curator' })).status, 400);
  assert.equal((await api('POST', `${A}/reject`, { as: 'contributor', body: { reason: 'no' } })).status, 403);
  const rj = await api('POST', `${A}/reject`, { as: 'curator', body: { reason: 'TEST wrong trait' } });
  assert.equal(rj.status, 200); assert.equal(rj.json.data.state, 'rejected');
  assert.equal((await api('POST', `${A}/submit`, { as: 'contributor' })).status, 409);
  const back = await api('PATCH', A, { as: 'contributor', body: { note: 'TEST fixed' } });
  assert.equal(back.status, 200); assert.equal(back.json.data.state, 'draft');
  const ev = (await get(`${A}/events`, 'reader')).json.data;
  assert.deepEqual(ev.map(e => [e.from, e.to]), [[null, 'draft'], ['draft', 'submitted'], ['submitted', 'rejected'], ['rejected', 'draft']]);
  assert.equal(ev[2].reason, 'TEST wrong trait'); assert.equal(ev[2].by, U.curator);

  const A1 = `/kg/v1/curate/assertions/${S.a1.id}`;
  const before = await mentionsIn('reader');
  assert.equal((await api('POST', `${A1}/retract`, { as: 'curator' })).status, 400);
  assert.equal((await api('POST', `${A1}/retract`, { as: 'contributor', body: { reason: 'x' } })).status, 403);
  const rt = await api('POST', `${A1}/retract`, { as: 'curator', body: { reason: 'TEST retract' } });
  assert.equal(rt.status, 200); assert.equal(rt.json.data.state, 'retracted');
  const afterR = await mentionsIn('reader');
  assert.equal(ownEdges(afterR, S.a1.id).length, 0);
  assert.equal(afterR.json.meta.degree['biolink:mentions|in'] ?? 0, before.json.meta.degree['biolink:mentions|in'] - 1);
  assert.equal((await get(`/kg/v1/edge/${enc(S.a1.edge_id)}`, 'reader')).status, 404);
  assert.equal((await api('POST', `${A1}/retract`, { as: 'curator', body: { reason: 'again' } })).status, 409);
});

// ---- Association node, curated node on /node, supersedes ----------------------------------------
test('two evidence lines create an Association node; curated nodes resolve via /node; supersedes masks', async () => {
  const P = `/kg/v1/curate/workspaces/${S.pub}/assertions`;
  const body = { subject: S.newPub, predicate: 'biolink:mentions', object: 'TO:0000207',
    evidence: [{ publications: [S.newPub], knowledge_level: 'knowledge_assertion' }, { has_evidence: ['ECO:0000352'], note: 'second line' }] };
  const c = await api('POST', P, { as: 'contributor', body });
  assert.equal(c.status, 201, c.text);
  const a = c.json.data;
  assert.equal(a.association_id, associationId(a.subject, a.predicate, a.object, a.id)); assert.equal(a.edge_id, a.association_id);
  const nodes = (await get(`/kg/v1/curate/workspaces/${S.pub}/nodes?class=Association`, 'reader')).json.data;
  const an = nodes.find(n => n.id === a.association_id);
  assert.deepEqual(an.attrs, { subject: S.newPub, predicate: 'biolink:mentions', object: 'TO:0000207', qualifiers: {} }); assert.equal(an.assertion, a.id);
  // a draft's association node and edge are not on the read side
  assert.equal((await get(`/kg/v1/node/${enc(a.association_id)}`)).status, 404);
  assert.equal((await get(`/kg/v1/edge/${enc(a.edge_id)}`)).status, 404);
  assert.equal((await api('POST', `/kg/v1/curate/assertions/${a.id}/submit`, { as: 'contributor' })).status, 200);
  // a public workspace: publish needs a site curator; the workspace curator and owner get 403, a site curator with
  // no role in the workspace may
  for (const as of ['curator', 'owner']) {
    const r = await api('POST', `/kg/v1/curate/assertions/${a.id}/publish`, { as });
    assert.equal(r.status, 403, as); assert.match(r.json.error, /publish in a public workspace requires a site curator/);
  }
  assert.equal((await api('POST', `/kg/v1/curate/assertions/${a.id}/publish`, { as: 'site' })).status, 200);
  const node = await get(`/kg/v1/node/${enc(a.association_id)}`);
  assert.equal(node.status, 200); assert.equal(node.json.data.class, 'Association'); assert.deepEqual(node.json.data.category, ['biolink:Association']);
  assert.equal(node.json.data.attributes.object, 'TO:0000207'); assert.equal(node.json.data.curation.workspace, S.pub);
  const edge = await get(`/kg/v1/edge/${enc(a.edge_id)}`);
  assert.equal(edge.status, 200); assert.equal(edge.json.data.provenance.layer, 'curated'); assert.equal(edge.json.data.subject_node.name, 'TEST unpublished paper');
  // the curated publication resolves through /node and its edges
  const pn = await get(`/kg/v1/node/${enc(S.newPub)}`);
  assert.equal(pn.status, 200); assert.equal(pn.json.data.class, 'GramenePublication'); assert.equal(pn.json.data.degree['biolink:mentions|out'], 1);
  assert.deepEqual(Object.keys(pn.json.data.attributes.curated), [S.pub]); assert.equal(pn.json.data.attributes.curated[S.pub].name, 'TEST unpublished paper');
  const pe = await get(`/kg/v1/node/${enc(S.newPub)}/edges`);
  assert.equal(pe.json.data.length, 1); assert.equal(pe.json.data[0].other.name, 'plant height'); assert.equal(pe.json.data[0].direction, 'out');
  assert.equal((await get(`/kg/v1/node/${enc(S.newPub)}/edges?direction=in`)).json.data.length, 0);
  assert.equal((await get(`/kg/v1/node/${enc(S.newPub)}/edges?category=GoTerm`)).json.data.length, 0);
  const pg = await get(`/kg/v1/node/${enc(S.newPub)}/edges?limit=1&category=TraitTerm`);
  assert.equal(pg.json.data.length, 1); assert.equal(pg.json.meta.next, null);
  const gq = await gql(`{ node(id:"${S.newPub}"){ __typename name neighbors{ edges{ node{ id curation other{ name } } } } } }`);
  assert.equal(gq.json.data.node.neighbors.edges[0].node.other.name, 'plant height');
  // a private-workspace curated node is a 404 for anonymous /node
  const col = (await get(`/kg/v1/curate/workspaces/${S.priv}/nodes?class=KgCollection`, 'reader')).json.data[0];
  assert.equal((await get(`/kg/v1/node/${enc(col.id)}`)).status, 404); assert.equal((await get(`/kg/v1/node/${enc(col.id)}`, 'reader')).status, 200);
  assert.equal((await gql(`{ node(id:"${col.id}"){ id } }`)).json.data.node, null);
  assert.equal((await gql(`{ node(id:"${col.id}"){ id } }`, 'reader')).json.data.node.id, col.id);
  // per-workspace records merge per caller: the reader sees only priv's record of the collection, 'other' only its own
  const cR = (await get(`/kg/v1/node/${enc(col.id)}`, 'reader')).json.data, cO = (await get(`/kg/v1/node/${enc(col.id)}`, 'other')).json.data;
  assert.deepEqual(Object.keys(cR.attributes.curated), [S.priv]); assert.equal(cR.name, 'TEST collection');
  assert.deepEqual(Object.keys(cO.attributes.curated), [S.otherWs]); assert.equal(cO.name, 'TEST other collection');
  assert.ok(!JSON.stringify(cR).includes(S.otherWs) && !JSON.stringify(cO).includes(S.priv));
  // a build node: attributes.curated holds the caller's visible records only, none for anonymous
  const etlA = (await get('/kg/v1/node/PMID:29712755')).json.data, etlR = (await get('/kg/v1/node/PMID:29712755', 'reader')).json.data;
  assert.equal(etlA.attributes.curated, undefined);
  assert.deepEqual(Object.keys(etlR.attributes.curated), [S.priv]); assert.equal(etlR.attributes.curated[S.priv].attrs.note, 'TEST priv record');
  assert.equal(etlR.attributes.journal, 'Genome research');                                // ETL attributes kept
  assert.deepEqual(Object.keys((await get('/kg/v1/node/PMID:29712755', 'other')).json.data.attributes.curated), [S.otherWs]);
  // a second public workspace curating the same new publication: both records, the older one names the node
  assert.equal((await api('POST', `/kg/v1/curate/workspaces/${S.sitePub}/nodes`, { as: 'site', body: { class: 'GramenePublication', id: S.newPub, name: 'TEST later name' } })).status, 201);
  const two = (await get(`/kg/v1/node/${enc(S.newPub)}`)).json.data;
  assert.deepEqual(Object.keys(two.attributes.curated).sort(), [S.pub, S.sitePub].sort()); assert.equal(two.name, 'TEST unpublished paper');
  assert.deepEqual(two.curation.workspaces, [S.pub, S.sitePub]);

  // supersedes: only a published assertion of the same workspace; publishing the correction hides the original
  assert.equal((await api('POST', P, { as: 'contributor', body: { ...body, supersedes: S.a1.id } })).status, 422);
  const fix = await api('POST', P, { as: 'contributor', body: { subject: S.newPub, predicate: 'biolink:mentions', object: 'TO:0000207', evidence: [{ publications: [S.newPub] }], supersedes: a.id } });
  assert.equal(fix.status, 201); assert.equal(fix.json.data.supersedes, `${a.id}@3`);
  for (const [act, as] of [['submit', 'contributor'], ['publish', 'site']]) assert.equal((await api('POST', `/kg/v1/curate/assertions/${fix.json.data.id}/${act}`, { as })).status, 200);
  assert.equal((await get(`/kg/v1/edge/${enc(a.edge_id)}`)).status, 404);
  assert.equal((await get(`/kg/v1/node/${enc(a.association_id)}`)).status, 404);
  const pe2 = await get(`/kg/v1/node/${enc(S.newPub)}/edges`);
  assert.deepEqual(pe2.json.data.map(e => e.curation.assertion), [fix.json.data.id]);
  assert.equal((await get(`/kg/v1/node/${enc(S.newPub)}`)).json.data.degree['biolink:mentions|out'], 1);
  S.pubEdge = fix.json.data.edge_id;
});

// ---- site curators on reject / retract; private workspaces keep the workspace roles ----------------
test('site curators: reject and retract in a public workspace; no say in a private one without a role', async () => {
  const P = `/kg/v1/curate/workspaces/${S.pub}/assertions`;
  const body = { subject: 'PMID:29712755', predicate: 'mentions', object: 'TO:0000207', evidence: [{ publications: ['PMID:29712755'] }] };
  const x = (await api('POST', P, { as: 'contributor', body })).json.data.id;
  assert.equal((await api('POST', `/kg/v1/curate/assertions/${x}/submit`, { as: 'contributor' })).status, 200);
  assert.equal((await api('POST', `/kg/v1/curate/assertions/${x}/reject`, { as: 'curator', body: { reason: 'no' } })).status, 403);
  assert.equal((await api('POST', `/kg/v1/curate/assertions/${x}/reject`, { as: 'site', body: { reason: 'TEST site reject' } })).status, 200);
  const y = (await api('POST', P, { as: 'contributor', body })).json.data.id;
  assert.equal((await api('POST', `/kg/v1/curate/assertions/${y}/submit`, { as: 'contributor' })).status, 200);
  assert.equal((await api('POST', `/kg/v1/curate/assertions/${y}/publish`, { as: 'site' })).status, 200);
  assert.equal((await api('POST', `/kg/v1/curate/assertions/${y}/retract`, { as: 'owner', body: { reason: 'x' } })).status, 403);
  assert.equal((await api('POST', `/kg/v1/curate/assertions/${y}/retract`, { as: 'site', body: { reason: 'TEST site retract' } })).status, 200);
  // a site curator gets no edit or submit rights from the site role (those stay workspace roles)
  const z = (await api('POST', P, { as: 'contributor', body })).json.data.id;
  assert.equal((await api('PATCH', `/kg/v1/curate/assertions/${z}`, { as: 'site', body: { note: 'x' } })).status, 403);
  assert.equal((await api('POST', `/kg/v1/curate/assertions/${z}/submit`, { as: 'site' })).status, 403);
  // a private workspace without a role: unreadable, so 404 for a site curator too
  const q = (await api('POST', `/kg/v1/curate/workspaces/${S.otherWs}/assertions`, { as: 'other', body })).json.data.id;
  assert.equal((await api('POST', `/kg/v1/curate/assertions/${q}/submit`, { as: 'other' })).status, 200);
  assert.equal((await api('POST', `/kg/v1/curate/assertions/${q}/publish`, { as: 'site' })).status, 404);
  const op = await api('POST', `/kg/v1/curate/assertions/${q}/publish`, { as: 'other' });     // owner of a private one
  assert.equal(op.status, 200); S.privEdge = op.json.data.edge_id;
});

// ---- disputes ----------------------------------------------------------------------------------
test('disputes: a build edge or a published edge of this or a public workspace; anything else the same 422', async () => {
  const P = `/kg/v1/curate/workspaces/${S.pub}/assertions`;
  const body = (d) => ({ subject: 'PMID:29712755', predicate: 'mentions', object: 'TO:0000207', evidence: [{ publications: ['PMID:29712755'] }], disputes: d });
  const priv = await api('POST', P, { as: 'contributor', body: body(S.privEdge) });
  const none = await api('POST', P, { as: 'contributor', body: body('gramene.assoc:aaaaaaaaaaaaaaaaaaaaaaaa') });
  assert.equal(priv.status, 422); assert.equal(none.status, 422);
  assert.equal(priv.json.error.replace(S.privEdge, 'X'), none.json.error.replace('gramene.assoc:aaaaaaaaaaaaaaaaaaaaaaaa', 'X'));
  assert.equal(priv.json.hint, none.json.hint);
  const pubE = await api('POST', `/kg/v1/curate/workspaces/${S.priv}/assertions`, { as: 'contributor', body: body(S.pubEdge) });
  assert.equal(pubE.status, 201, pubE.text); assert.equal(pubE.json.data.disputes, S.pubEdge);
  const build = await api('POST', P, { as: 'contributor', body: body('2fea85bd7e7ff713e19baa7e') });
  assert.equal(build.status, 201, build.text); assert.equal(build.json.data.disputes, 'gramene.assoc:2fea85bd7e7ff713e19baa7e');
});

// ---- concurrency: curated nodes, Association nodes, listings ---------------------------------------
test('curated nodes: per-workspace records; optimistic updates give 409, never a lost write', async () => {
  const cn = mongo.db(DB).collection('curated_nodes');
  const newId = () => `gramene.collection:cur_${crypto.randomBytes(6).toString('hex')}`;
  for (let i = 0; i < 5; i++) {                       // one id created at once in two workspaces: two records
    const id = newId();
    const [a, b] = await Promise.all([api('POST', `/kg/v1/curate/workspaces/${S.pub}/nodes`, { as: 'site', body: { id, class: 'KgCollection', name: 'TEST A' } }),
      api('POST', `/kg/v1/curate/workspaces/${S.priv}/nodes`, { as: 'contributor', body: { id, class: 'KgCollection', name: 'TEST B' } })]);
    assert.deepEqual([a.status, b.status], [201, 201]);
    assert.deepEqual((await cn.find({ curie: id }).toArray()).map(r => [r._id, r.workspace, r.name, r.rev]).sort(),
      [[`${S.priv}|${id}`, S.priv, 'TEST B', 1], [`${S.pub}|${id}`, S.pub, 'TEST A', 1]].sort());
    const n = (await get(`/kg/v1/node/${enc(id)}`)).json.data;
    assert.equal(n.name, 'TEST A'); assert.deepEqual(Object.keys(n.attributes.curated), [S.pub]);
  }
  const P = `/kg/v1/curate/workspaces/${S.pub}/nodes`;   // public: node records are written by the site curator
  for (let i = 0; i < 5; i++) {                       // one id created at once in one workspace: one create wins
    const id = newId();
    const rs = await Promise.all([1, 2].map(k => api('POST', P, { as: 'site', body: { id, class: 'KgCollection', name: `TEST ${k}` } })));
    const st = rs.map(r => r.status).sort();
    assert.ok(JSON.stringify(st) === '[201,409]' || JSON.stringify(st) === '[200,201]', JSON.stringify(st));
    assert.equal(await cn.countDocuments({ curie: id }), 1);
  }
  for (let i = 0; i < 8; i++) {                       // concurrent edits of different fields
    const id = newId();
    assert.equal((await api('POST', P, { as: 'site', body: { id, class: 'KgCollection', name: 'orig' } })).status, 201);
    const [x, y] = await Promise.all([api('POST', P, { as: 'site', body: { id, class: 'KgCollection', name: 'A' } }),
      api('POST', P, { as: 'site', body: { id, class: 'KgCollection', description: 'B' } })]);
    assert.ok([x, y].every(r => [200, 409].includes(r.status)), `${x.status} ${y.status}`);
    const ok = [x, y].filter(r => r.status === 200);
    assert.ok(ok.length >= 1);
    if (ok.length === 2) assert.notEqual(x.json.data.rev, y.json.data.rev);
    const d = await cn.findOne({ _id: `${S.pub}|${id}` });
    if (x.status === 200) assert.equal(d.name, 'A'); else assert.equal(d.name, 'orig');
    if (y.status === 200) assert.equal(d.description, 'B'); else assert.equal(d.description, null);
    assert.equal(d.rev, 1 + ok.length);
  }
  // `rev` in the body: the revision the change is based on; a stale one is a 409 that changes nothing
  const id = newId();
  assert.equal((await api('POST', P, { as: 'site', body: { id, class: 'KgCollection', name: 'v1', rev: 0 } })).status, 201);
  assert.equal((await api('POST', P, { as: 'site', body: { id, class: 'KgCollection', name: 'v2', rev: 1 } })).status, 200);
  const stale = await api('POST', P, { as: 'site', body: { id, class: 'KgCollection', name: 'v3', rev: 1 } });
  assert.equal(stale.status, 409); assert.match(stale.json.error, /at revision 2/);
  assert.equal((await cn.findOne({ _id: `${S.pub}|${id}` })).name, 'v2');
  assert.equal((await api('POST', P, { as: 'site', body: { id, class: 'KgCollection', rev: 'x' } })).status, 400);
});

test('Association node follows the highest revision under concurrent edits; a 409 changes nothing', async () => {
  const db = mongo.db(DB);
  const P = `/kg/v1/curate/workspaces/${S.priv}/assertions`;
  const one = [{ publications: ['PMID:29712755'] }], two = [...one, { has_evidence: ['ECO:0000352'] }];
  for (let i = 0; i < 8; i++) {
    const c = await api('POST', P, { as: 'contributor', body: { subject: 'PMID:29712755', predicate: 'mentions', object: 'TO:0000207', evidence: i % 2 ? two : one } });
    assert.equal(c.status, 201);
    const id = c.json.data.id;
    // alternate 1 / 2 lines (i even), or one 2-line PATCH first and 1-line ones just after (i odd)
    const rs = await Promise.all([0, 1, 2, 3, 4, 5].map(k => new Promise(r => setTimeout(r, i % 2 && k ? 3 : 0))
      .then(() => api('PATCH', `/kg/v1/curate/assertions/${id}`, { as: 'contributor', body: { evidence: i % 2 ? (k ? one : two) : (k % 2 ? two : one), note: `TEST ${k}` } }))));
    assert.ok(rs.every(r => [200, 409].includes(r.status)), rs.map(r => r.status).join());
    const wins = rs.filter(r => r.status === 200).length; assert.ok(wins >= 1);
    const revs = (await db.collection('assertions').find({ id }, { projection: { rev: 1 } }).toArray()).map(a => a.rev).sort((a, b) => a - b);
    assert.deepEqual(revs, Array.from({ length: 1 + wins }, (_, k) => k + 1));
    assert.equal(await db.collection('assertions').countDocuments({ id, latest: true }), 1);
    const top = await db.collection('assertions').find({ id }).sort({ rev: -1 }).limit(1).next();
    const nodes = await db.collection('curated_nodes').find({ cls: 'Association', assertion: id }).toArray();
    if (top.association_id) {
      assert.deepEqual(nodes.map(n => [n._id, n.curie, n.assertion_rev]), [[`${S.priv}|${top.association_id}`, top.association_id, top.rev]]);
      assert.equal(nodes[0].description, top.note);
    } else assert.equal(nodes.length, 0, `orphan Association node for ${id}`);
  }
  // the workspace's Association nodes all belong to an assertion whose highest revision names them
  const all = await db.collection('curated_nodes').find({ workspace: S.priv, cls: 'Association' }).toArray();
  for (const n of all) {
    const top = await db.collection('assertions').find({ id: n.assertion }).sort({ rev: -1 }).limit(1).next();
    assert.equal(top.association_id, n.curie);
  }
});

test('listings and counts take the highest revision per assertion, also with two latest:true revisions', async () => {
  const A = mongo.db(DB).collection('assertions');
  const id = S.a1.id;                                           // revisions 1..5, 5 = retracted
  await A.updateOne({ _id: `${id}@4` }, { $set: { latest: true } });   // as if the process died mid-write
  try {
    const l = await get(`/kg/v1/curate/workspaces/${S.priv}/assertions?limit=500`, 'reader');
    const ids = l.json.data.map(a => a.id);
    assert.equal(new Set(ids).size, ids.length); assert.equal(l.json.meta.total, ids.length);
    assert.deepEqual(l.json.data.filter(a => a.id === id).map(a => [a.rev, a.state]), [[5, 'retracted']]);
    assert.ok(!(await get(`/kg/v1/curate/workspaces/${S.priv}/assertions?state=published&limit=500`, 'reader')).json.data.some(a => a.id === id));
    const w = (await get(`/kg/v1/curate/workspaces/${S.priv}`, 'reader')).json.data;
    assert.equal(Object.values(w.assertions).reduce((x, y) => x + y, 0), ids.length);
    // paging: offset/limit over distinct assertions
    const p1 = (await get(`/kg/v1/curate/workspaces/${S.priv}/assertions?limit=2`, 'reader')).json;
    const p2 = (await get(`/kg/v1/curate/workspaces/${S.priv}/assertions?limit=2&offset=2`, 'reader')).json;
    assert.deepEqual([...p1.data, ...p2.data].map(a => a.id), ids.slice(0, 4)); assert.equal(p1.meta.total, ids.length);
  } finally { await A.updateOne({ _id: `${id}@4` }, { $set: { latest: false } }); }
});

// ---- self-loops ----------------------------------------------------------------------------------
test('a live curated self-loop is listed out and in, matching the degree', async () => {
  const g = 'gramene.gene:SORBI_3002G146900', E = `/kg/v1/node/${enc(g)}/edges?predicate=biolink:interacts_with&source=infores:sorghumbase-curation`;
  const before = (await get(`/kg/v1/node/${enc(g)}`)).json.data.degree;
  const c = await api('POST', `/kg/v1/curate/workspaces/${S.pub}/assertions`, { as: 'contributor',
    body: { subject: g, predicate: 'biolink:interacts_with', object: g, evidence: [{ has_evidence: ['ECO:0000314'] }] } });
  assert.equal(c.status, 201, c.text);
  assert.equal((await api('POST', `/kg/v1/curate/assertions/${c.json.data.id}/submit`, { as: 'contributor' })).status, 200);
  assert.equal((await api('POST', `/kg/v1/curate/assertions/${c.json.data.id}/publish`, { as: 'site' })).status, 200);
  const mine = (r) => r.json.data.filter(e => e.curation?.assertion === c.json.data.id);
  const all = await get(`${E}&limit=500`);
  assert.deepEqual(mine(all).map(e => e.direction), ['out', 'in']);
  const k = 'biolink:interacts_with';
  assert.equal(all.json.meta.degree[`${k}|out`], (before[`${k}|out`] ?? 0) + 1); assert.equal(all.json.meta.degree[`${k}|in`], (before[`${k}|in`] ?? 0) + 1);
  assert.deepEqual(mine(await get(`${E}&direction=in&limit=500`)).map(e => e.direction), ['in']);
  assert.deepEqual(mine(await get(`${E}&direction=out&limit=500`)).map(e => e.direction), ['out']);
  // paging one row at a time reaches both rows
  const seen = []; let cursor = null;
  for (let i = 0; i < 50; i++) {
    const r = await get(`${E}&limit=1${cursor ? `&cursor=${cursor}` : ''}`);
    seen.push(...mine(r).map(e => e.direction)); cursor = r.json.meta.next; if (!cursor) break;
  }
  assert.deepEqual(seen, ['out', 'in']);
});

// ---- indexes: every overlay query has one --------------------------------------------------------
test('read-side overlay queries use indexes (explain shows IXSCAN, no COLLSCAN)', async () => {
  const db = mongo.db(DB), A = db.collection('assertions');
  for (const [what, cur] of [
    ['changes since a build', A.find({ latest: true, state: { $in: ['published', 'retracted'] }, updated_at: { $gt: '2026-01-01T00:00:00.000Z' } })],
    ['public last change', A.find({ latest: true, state: { $in: ['published', 'retracted'] }, workspace: { $in: [S.pub] } }).sort({ updated_at: -1 }).limit(1)],
    ['supersedes', A.find({ latest: true, state: 'published', supersedes: { $in: ['asn_000000000000@1'] } })],
    ['public corrections', A.find({ latest: true, workspace: { $in: [S.pub] }, supersedes: { $type: 'string' } })],
    ['overlay by node', A.find({ latest: true, $or: [{ subject: { $in: ['PMID:1'] } }, { object: { $in: ['PMID:1'] } }] })],
    ['by assertion id', A.find({ id: { $in: ['asn_000000000000'] }, latest: true })],
    ['by edge id', A.find({ edge_id: 'gramene.assoc:000000000000000000000000', latest: true })],
    ['curated records by CURIE', db.collection('curated_nodes').find({ curie: { $in: ['PMID:1'] } })],
    ['workspace nodes', db.collection('curated_nodes').find({ workspace: S.pub }).sort({ curie: 1 })]]) {
    const plan = JSON.stringify((await cur.explain()).queryPlanner.winningPlan);
    assert.match(plan, /IXSCAN/, what); assert.doesNotMatch(plan, /COLLSCAN/, what);
  }
});

// ---- attach reports -----------------------------------------------------------------------------
test('reports: entries of private workspaces only for their readers', async () => {
  const pubAsn = (await get(`/kg/v1/curate/workspaces/${S.pub}/assertions`, 'reader')).json.data[0].id;
  const rel = (await get('/kg/v1/curate/workspaces')).json.release;
  await mongo.db(DB).collection('attach_reports').insertOne({ _id: `TEST-${run}@000000000000`, release: rel, build: '000000000000', created_at: '2000-01-01T00:00:00Z',
    unresolved: [{ assertion: S.a1.id, rev: 5, curie: 'gramene.genetree:SB10GT_1', role: 'object', suggestions: [] }, { assertion: pubAsn, rev: 1, curie: 'x:y', role: 'subject', suggestions: [] }] });
  const mine = (r) => r.json.data.find(x => x.id === `TEST-${run}@000000000000`);
  const anon = await get(`/kg/v1/curate/reports?release=${rel}`);
  assert.equal(anon.status, 200); assert.deepEqual(mine(anon).unresolved.map(u => u.assertion), [pubAsn]);
  assert.deepEqual(mine(await get('/kg/v1/curate/reports', 'reader')).unresolved.map(u => u.assertion), [S.a1.id, pubAsn]);
});

// ---- the write client --------------------------------------------------------------------------
test('write client: bound to one curation db, refuses every other db', async () => {
  for (const n of ['sorghum11', 'search70', 'kg_meta', 'ontology', 'ensembl', 'gramene_g2p', 'userData', 'kg_sorghum11_b202611041048', 'kg_curationx', 'admin'])
    assert.throws(() => curationDbName(n), /curation db must be/, n);
  assert.equal(curationDbName('kg_curation'), 'kg_curation'); assert.equal(curationDbName('kg_curation_test_x'), 'kg_curation_test_x');
  await assert.rejects(() => connectCurationDb(MONGO_URL, 'kg_meta'), /curation db must be/);
  assert.throws(() => wrap(mongo, 'kg_sorghum11_b202611041048'), /curation db must be/);
  const w = wrap(mongo, DB);
  assert.equal(w.collection('assertions').dbName, DB);
  for (const n of ['kg_meta', 'sorghum11', 'kg_curation_fixture']) if (n !== DB) assert.throws(() => w.db(n), /refusing db/);
  assert.equal(w.db(DB), w);
  assert.equal(Object.isFrozen(w), true); assert.equal(w.client, undefined);
  const idx = (await mongo.db(DB).collection('assertions').indexes()).map(i => JSON.stringify(i.key));
  for (const k of [{ id: 1, rev: -1 }, { workspace: 1, latest: 1, state: 1 }, { subject: 1 }, { object: 1 }, { edge_id: 1 }, { latest: 1, state: 1, updated_at: 1 }, { supersedes: 1 }])
    assert.ok(idx.includes(JSON.stringify(k)), JSON.stringify(k));
  const cni = await mongo.db(DB).collection('curated_nodes').indexes();
  assert.ok(cni.some(i => JSON.stringify(i.key) === JSON.stringify({ curie: 1, workspace: 1 }) && i.unique), 'unique {curie, workspace}');
});

// ---- baked curated edges (no build has any yet): the overlay against a fixture edges collection ---------
// Runs in a child process whose KG_CURATION_DB is a throwaway kg_curation_fixture_* db that also holds a fake
// `edges` collection standing in for a build's; the db is dropped at the end.
test('overlay on baked curated edges: current shown, retracted/superseded/private masked, unbaked added', async () => {
  const fx = `kg_curation_fixture_api_${run}`;
  const script = `
    import assert from 'node:assert/strict';
    const core = await import(${JSON.stringify(new URL('../apps/api/core.mjs', import.meta.url).href)});
    const { curatedEdgeId } = await import(${JSON.stringify(new URL('../apps/api/curation-ids.mjs', import.meta.url).href)});
    const db = core.mongo.db(${JSON.stringify(fx)});
    try {
      const N = 'gxa.expt:FIXTURE-1', P = 'biolink:mentions';
      await db.collection('workspaces').insertMany([{ _id: 'ws_00000000000a', ownerUid: 'u1', visibility: 'public', acls: [] },
        { _id: 'ws_00000000000b', ownerUid: 'u1', visibility: 'private', acls: [{ principal: { type: 'user', id: 'u2' }, role: 'reader' }] }]);
      const mk = (id, rev, state, ws, s, extra = {}) => ({ _id: id + '@' + rev, id, rev, latest: true, workspace: ws, state, subject: s, predicate: P, object: N, qualifiers: {},
        negated: false, evidence: [{ publications: [s], has_evidence: [], knowledge_level: 'knowledge_assertion', note: null }], supersedes: null, association_id: null,
        edge_id: curatedEdgeId(s, P, N, {}, id), ...extra });
      const A = [mk('asn_00000000000a', 3, 'published', 'ws_00000000000a', 'PMID:1'),   // baked at rev 3, still current -> shown
        mk('asn_00000000000b', 4, 'retracted', 'ws_00000000000a', 'PMID:2'),             // baked at rev 3, retracted since -> masked
        mk('asn_00000000000c', 3, 'published', 'ws_00000000000a', 'PMID:3'),             // published after the build -> live
        mk('asn_00000000000d', 3, 'published', 'ws_00000000000b', 'PMID:4'),             // baked, workspace now private -> masked for anonymous
        mk('asn_00000000000e', 3, 'published', 'ws_00000000000a', 'PMID:5'),             // baked, superseded by f -> masked
        mk('asn_00000000000f', 3, 'published', 'ws_00000000000a', 'PMID:6', { supersedes: 'asn_00000000000e@3' })];
      await db.collection('assertions').insertMany(A);
      const hex = (a) => a.edge_id.slice('gramene.assoc:'.length);
      const baked = (a, rev) => ({ _id: hex(a), s: a.subject, p: P, o: N, layer: 'curated', asn: { id: a.id, rev } });
      await db.collection('edges').insertMany([baked(A[0], 3), baked(A[1], 3), baked(A[3], 3), baked(A[4], 3), baked(A[5], 3),
        { _id: 'etl000000000000000000000', s: 'PMID:9', p: P, o: N, layer: 'etl' }]);
      const ctx = { db, rel: { _id: 'fixture', current_build: '000000000000' }, manifest: {} };
      const anon = await core.curatedOverlay(ctx, null, [N]);
      assert.deepEqual(anon.mask.sort(), [hex(A[1]), hex(A[3]), hex(A[4])].sort());
      assert.deepEqual(anon.live.map(e => e.asn.id), ['asn_00000000000c']);
      assert.deepEqual(anon.delta.get(N), { [P + '|in']: -2 });
      const u2 = await core.curatedOverlay(ctx, { uid: 'u2', orgs: [] }, [N]);
      assert.deepEqual(u2.mask.sort(), [hex(A[1]), hex(A[4])].sort());
      assert.deepEqual(core.applyDelta({ [P + '|in']: 5, x: 1 }, anon.delta.get(N)), { [P + '|in']: 3, x: 1 });
      assert.deepEqual(core.applyDelta({ [P + '|in']: 2 }, anon.delta.get(N)), {});
      const rows = await db.collection('edges').find({}).sort({ _id: 1 }).toArray();
      const shown = await core.filterBaked(null, rows);
      assert.deepEqual(shown.map(e => e.asn?.id ?? e._id).sort(), ['asn_00000000000a', 'asn_00000000000f', 'etl000000000000000000000']);
      assert.deepEqual(shown.find(e => e.asn?.id === 'asn_00000000000a').curation, { assertion: 'asn_00000000000a', rev: 3, state: 'published', workspace: 'ws_00000000000a' });
      // a baked edge whose rev is not the latest is masked even if a later rev were published
      assert.equal((await core.filterBaked(null, [{ ...baked(A[0], 2) }])).length, 0);
      // baked curated-only node (attrs.curated_only) whose only record is in a private workspace: hidden from callers
      // who cannot read it (also from /resolve results); an ETL node with curated records is never hidden
      const CO = 'gramene.collection:cur_f1x7e0000001';
      await db.collection('nodes').insertMany([{ _id: CO, cls: 'KgCollection', attrs: { curated_only: true, curated: { ws_00000000000b: { rev: 1 } } } },
        { _id: 'PMID:7', cls: 'GramenePublication', attrs: { journal: 'J', curated: { ws_00000000000b: { rev: 1 } } } }]);
      const rec = (ws, curie, extra) => ({ _id: ws + '|' + curie, curie, workspace: ws, cls: curie.startsWith('PMID') ? 'GramenePublication' : 'KgCollection', rev: 1, xrefs: [], attrs: {}, ...extra });
      await db.collection('curated_nodes').insertMany([rec('ws_00000000000b', CO, { name: 'private col', created_at: '2026-01-01' }),
        rec('ws_00000000000b', 'PMID:7', { name: 'old private', created_at: '2026-01-01' }), rec('ws_00000000000a', 'PMID:7', { name: 'public rec', created_at: '2026-02-01', rev: 2 })]);
      const cvA = await core.curatedFor(ctx, null, [CO, 'PMID:7', 'PMID:8']);
      assert.deepEqual([...cvA.hidden], [CO]);
      assert.deepEqual(cvA.visible.get('PMID:7').map(r => r.workspace), ['ws_00000000000a']);
      const cvU = await core.curatedFor(ctx, { uid: 'u2', orgs: [] }, [CO, 'PMID:7']);
      assert.equal(cvU.hidden.size, 0); assert.deepEqual(cvU.visible.get('PMID:7').map(r => r.workspace), ['ws_00000000000b', 'ws_00000000000a']);
      const cnU = (await core.curatedNodes({ uid: 'u2', orgs: [] }, ['PMID:7'])).get('PMID:7');
      assert.equal(cnU.name, 'old private'); assert.deepEqual(Object.keys(cnU.attrs.curated), ['ws_00000000000b', 'ws_00000000000a']);
      assert.deepEqual(cnU.curation, { workspace: 'ws_00000000000b', rev: 1, workspaces: ['ws_00000000000b', 'ws_00000000000a'] });
      const dr = await core.dropHidden(ctx, null, { resolved: [{ input: 'x', id: CO }, { input: 'y', id: 'PMID:7' }], ambiguous: [{ input: 'z', candidates: [{ id: CO }, { id: 'PMID:7' }] }], unknown: [] });
      assert.deepEqual(dr, { resolved: [{ input: 'y', id: 'PMID:7' }, { id: 'PMID:7' }], ambiguous: [], unknown: ['x'] });
      console.log('FIXTURE OK');
    } finally { await db.dropDatabase(); await core.mongo.close(); }`;
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, KG_CURATION_DB: fx }, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /FIXTURE OK/);
  const left = (await mongo.db().admin().listDatabases()).databases.map(d => d.name);
  assert.ok(!left.includes(fx), `${fx} not dropped`);
});
