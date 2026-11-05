// gramene-kg read API: REST over the promoted per-build Mongo db and Solr core, plus GraphQL.
//   GET  /kg/v1/health | /releases | /releases/:id | /releases/:id/manifest | /releases/:id/changes | /schema[/:category]
//   GET  /kg/v1/node/:curie (Accept: application/ld+json -> JSON-LD) | /node/:curie/edges | /edge/:id | /search | /region | /path
//   GET|POST /kg/v1/resolve        GET /kg/v1/context.jsonld        GET|POST /kg/graphql
//   /kg/v1/curate/*  curation API (curation.mjs; docs/curation.md)
// Auth (auth.mjs): an optional Bearer token on any route; the caller's identity decides which curated data is shown.
// Every REST response: { release, build, data, meta } plus X-KG-Release / X-KG-Build headers.
// The logic lives in core.mjs, shared with graphql.mjs; this file only maps HTTP onto it.
import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import * as core from './core.mjs';
import { registerGraphql } from './graphql.mjs';
import { nodeJsonLd, contextDoc } from './jsonld.mjs';
import { registerAuth } from './auth.mjs';
import { registerCuration } from './curation.mjs';

const PORT = Number(process.env.KG_PORT || 12000);
// a dev server with test tokens (KG_AUTH_TEST_SECRET) listens on loopback unless KG_HOST says otherwise (and then warns)
const HOST = process.env.KG_HOST || (process.env.KG_AUTH_TEST_SECRET ? '127.0.0.1' : '0.0.0.0');
const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' }, routerOptions: { maxParamLength: 1000 }, bodyLimit: 2 * 1024 * 1024 });
const { intParam } = core;

// envelope for a core result { ctx, data, extra }
function send(reply, { ctx, data, extra = {} }) {
  reply.header('X-KG-Release', ctx.rel._id).header('X-KG-Build', ctx.rel.current_build);
  return { release: ctx.rel._id, build: ctx.rel.current_build, data, meta: { warnings: [], ...extra } };
}
const rq = (req) => ({ ...req.query, release: req.query?.release ?? req.body?.release });
const who = (req) => core.principal(req.kgUser);     // policy Principal {uid, orgs} or null
registerAuth(app);

// ---- routes ----------------------------------------------------------------------------------
app.setErrorHandler((err, req, reply) => {
  const code = err.statusCode && err.statusCode < 600 ? err.statusCode : 500;
  if (code >= 500) req.log.error(err);
  if (code === 401) reply.header('WWW-Authenticate', 'Bearer');
  reply.code(code).send({ error: err.message, hint: err.hint ?? null, ...(err.candidates ? { candidates: err.candidates } : {}), ...(err.extra ?? {}), docs: '/kg/v1/schema' });
});

app.get('/kg/v1/health', () => core.health());
app.get('/kg/v1/releases', () => core.releaseList());
app.get('/kg/v1/releases/:id', async (req, reply) => send(reply, await core.releaseInfo(req.params.id)));
app.get('/kg/v1/releases/:id/manifest', async (req, reply) => send(reply, await core.releaseManifest(req.params.id)));
app.get('/kg/v1/releases/:id/changes', async (req, reply) => send(reply, await core.releaseChanges(req.params.id, { from: req.query.from, to: req.query.to })));

app.get('/kg/v1/schema', async (req, reply) => send(reply, await core.schema(rq(req).release)));
app.get('/kg/v1/schema/:category', async (req, reply) => send(reply, await core.schemaCategory(req.params.category, rq(req).release)));

// JSON-LD context generated from the LinkML schema (referenced by the JSON-LD node documents)
app.get('/kg/v1/context.jsonld', (req, reply) => reply.header('Cache-Control', 'public, max-age=3600').type('application/ld+json').send(contextDoc));
// public base of the API (scheme, host and the /kg prefix), never taken from the request: the Host header is
// client-controlled and, behind the planned proxy, names the internal host. Set KG_PUBLIC_URL once /kg is proxied.
const PUBLIC_URL = (process.env.KG_PUBLIC_URL || 'http://127.0.0.1:12000/kg').replace(/\/+$/, '');
const CONTEXT_URL = `${PUBLIC_URL}/v1/context.jsonld`;
// header values must be Latin-1; JSON with every non-ASCII character \u-escaped is still the same JSON
const asciiJson = (v) => JSON.stringify(v).replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
const wantsJsonLd = (req) => /application\/ld\+json/i.test(req.headers.accept ?? '');
app.get('/kg/v1/node/:curie', async (req, reply) => {
  const r = await core.node(req.params.curie, rq(req), await who(req));
  reply.header('Vary', 'Accept');
  if (!wantsJsonLd(req)) return send(reply, r);
  send(reply, r);                                     // headers only
  if (r.extra.warnings?.length) reply.header('X-KG-Warnings', asciiJson(r.extra.warnings));
  return reply.type('application/ld+json').send(JSON.stringify(nodeJsonLd(r.data, CONTEXT_URL)));
});
app.get('/kg/v1/node/:curie/edges', async (req, reply) => send(reply, await core.nodeEdges(req.params.curie, rq(req), await who(req))));
app.get('/kg/v1/edge/:id', async (req, reply) => send(reply, await core.edge(req.params.id, rq(req), await who(req))));

app.get('/kg/v1/resolve', async (req, reply) => send(reply, await core.resolve({ ...req.query, release: rq(req).release }, await who(req))));
app.post('/kg/v1/resolve', async (req, reply) => send(reply, await core.resolve({ ...(req.body ?? {}), release: rq(req).release }, await who(req))));

app.get('/kg/v1/search', async (req, reply) => send(reply, await core.search(rq(req), await who(req))));
app.get('/kg/v1/region', async (req, reply) => send(reply, await core.region(rq(req))));
app.get('/kg/v1/path', async (req, reply) => send(reply, await core.findPath(rq(req), await who(req))));

// ---- derived layers: per-gene homology pairs and expression values from the build's bucketed parquet ----
app.get('/kg/v1/derived/homologs/:gene', async (req, reply) => {
  const opts = { kind: req.query.kind, limit: intParam(req.query.limit, 100, 1000, 'limit'), offset: intParam(req.query.offset, 0, 1e7, 'offset') };
  return send(reply, await core.derived('homologs', req.params.gene, rq(req), opts));
});
app.get('/kg/v1/derived/expression/:gene', async (req, reply) => send(reply, await core.derived('expression', req.params.gene, rq(req), { experiment: req.query.experiment })));

// ---- curation API ------------------------------------------------------------------------------
await registerCuration(app, { send, who });

// ---- GraphQL ----------------------------------------------------------------------------------
await registerGraphql(app);

// ---- browse UI: static files from apps/ui at /kg/ui/ (hash routing, so every other path is index.html) ----
const UI_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../ui');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.md': 'text/markdown; charset=utf-8' };
// Content-Security-Policy for every UI response (apps/ui/csp.json, owned by the UI; finding ui-ops#5)
const UI_CSP = JSON.parse(fs.readFileSync(path.join(UI_DIR, 'csp.json'), 'utf8'));
app.get('/kg/ui', (req, reply) => reply.redirect('/kg/ui/'));
app.get('/kg/ui/*', (req, reply) => {
  const rel = path.normalize(req.params['*'] || 'index.html').replace(/^(\.\.[/\\])+/, '');
  let f = path.join(UI_DIR, rel);
  if (!f.startsWith(UI_DIR + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) f = path.join(UI_DIR, 'index.html');
  reply.header('Cache-Control', 'no-cache').header(UI_CSP.header, UI_CSP.value).type(MIME[path.extname(f)] ?? 'application/octet-stream');
  return reply.send(fs.createReadStream(f));
});

app.addHook('onClose', async () => core.mongo.close());
if (process.env.KG_AUTH_TEST_SECRET && !['127.0.0.1', '::1', 'localhost'].includes(HOST))
  app.log.warn({ host: HOST }, 'test tokens are accepted and the server listens beyond loopback: set KG_HOST=127.0.0.1');
await app.listen({ port: PORT, host: HOST });
