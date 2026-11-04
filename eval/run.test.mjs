// Eval runner: every question in questions.jsonl, checked against gold + citation rules.
//   REST mode (default):  KG_API_URL=http://127.0.0.1:12000 node --test eval/run.test.mjs        -> results/rest.jsonl
//   MCP mode:             KG_MCP_URL=http://127.0.0.1:11067/mcp/sorghum_v11 node --test eval/run.test.mjs -> results/mcp.jsonl
// REST mode runs q.plan (GET calls); MCP mode runs q.mcp (JSON-RPC initialize, then tools/call of kg_* tools, paging kg_edges
// with next_cursor). Both modes normalise the answer to the same shape and apply the same gold and citation checks.
// (node --test rejects extra CLI flags, so the endpoint comes from the environment.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const MCP = process.env.KG_MCP_URL || null;
const API = process.env.KG_API_URL || 'http://127.0.0.1:12000';
const MODE = MCP ? 'mcp' : 'rest';
const Q = fs.readFileSync(new URL('./questions.jsonl', import.meta.url), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const results = [];

// ---- REST ----------------------------------------------------------------------------------------
const get = async (path) => { const r = await fetch(API + path.replace(/^GET /, '')); return { status: r.status, body: await r.json() }; };

// ---- MCP (streamable HTTP, JSON or SSE response) ---------------------------------------------------
let sid = null, rpcId = 0, initialized = null;
async function rpc(method, params, notify = false) {
  const r = await fetch(MCP, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(sid ? { 'Mcp-Session-Id': sid } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', ...(notify ? {} : { id: ++rpcId }), method, ...(params ? { params } : {}) }) });
  sid = r.headers.get('mcp-session-id') ?? sid;
  const txt = await r.text();
  if (notify) return null;
  if (!r.ok && !txt) throw new Error(`MCP HTTP ${r.status} on ${method}`);
  const msg = /^(event|data|id):/m.test(txt) && !txt.trimStart().startsWith('{')
    ? JSON.parse(txt.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5)).filter(Boolean).pop()) : JSON.parse(txt);
  if (msg.error) throw new Error(`MCP ${method}: ${msg.error.message ?? JSON.stringify(msg.error)}`);
  return msg.result;
}
async function mcpInit() {
  initialized ??= (async () => {
    const r = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'gramene-kg-eval', version: '1' } });
    await rpc('notifications/initialized', undefined, true).catch(() => {});
    return r;
  })();
  return initialized;
}
async function call(tool, args) {
  await mcpInit();
  const r = await rpc('tools/call', { name: tool, arguments: args });
  const text = (r.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  if (r.isError) throw new Error(`${tool} tool error: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}
// kg_edges with cursor paging: returns every item across pages. A small page (KG_EVAL_PAGE, default 10) makes the
// longer gold lists (organ_expression, qtl_genes) cross page boundaries, so cursor handoff is exercised on every run.
const PAGE = Number(process.env.KG_EVAL_PAGE || '10');
let mcpPages = 0;
async function allEdges(args) {
  const items = []; let cursor; let pages = 0;
  do {
    const r = await call('kg_edges', { ...args, limit: PAGE, ...(cursor ? { cursor } : {}) }); mcpPages++;
    if (r.status && r.status !== 'ok') throw new Error(`kg_edges ${r.status}: ${r.error}`);
    items.push(...r.items); cursor = r.next_cursor; pages++;
  } while (cursor && pages < 100);
  return items;
}

// ---- per-kind answers, normalised to {value, edges} ------------------------------------------------
// value: what the gold is compared against; edges: the edges whose provenance must cite must_cite
const farEnd = (e) => e.direction === 'in' ? e.subject : e.object;
const ids = (edges) => edges.map(farEnd).sort();

async function answerRest(q) {
  switch (q.kind) {
    case 'resolve': { const a = await get(q.plan[0]); const b = await get(q.plan[1]);
      return { value: { ambiguous: a.body.data.ambiguous.length, resolved: b.body.data.resolved.map(x => x.id) } }; }
    case 'gene_facts': { const { body } = await get(q.plan[0]); return { value: { tree: body.data.gene_tree, genome: body.data.genome } }; }
    case 'derived_homologs': { const { body } = await get(q.plan[0]); return { value: body.data.by_kind }; }
    case 'path': { const { body } = await get(q.plan[0]); return { value: body.data, edges: body.data.flat() }; }
    case 'region': { const { body } = await get(q.plan[0]); return { value: body.data.map(f => f.id).sort() }; }
    case 'evidence': { const { body } = await get(q.plan[0]); return { value: body.data, edges: [body.data] }; }
    case 'search': { const { body } = await get(q.plan[0]); return { value: body.data.map(h => h.id) }; }
    case 'changes': { const { body } = await get(q.plan[0]); return { value: body.data }; }
    default: { const { body } = await get(q.plan[0] + '&limit=500'); return { value: ids(body.data), edges: body.data }; }
  }
}

async function answerMcp(q) {
  const [s0, s1] = q.mcp;
  if (!s0) throw new Error(`question ${q.id} has no mcp plan (regenerate questions.jsonl)`);
  switch (q.kind) {
    case 'resolve': { const a = await call(s0.tool, s0.arguments); const b = await call(s1.tool, s1.arguments);
      return { value: { ambiguous: a.ambiguous.length, resolved: b.resolved.map(x => x.id) } }; }
    case 'gene_facts': { const r = await call(s0.tool, s0.arguments); return { value: { tree: r.node?.gene_tree, genome: r.node?.genome } }; }
    case 'derived_homologs': { const r = await call(s0.tool, s0.arguments); return { value: r.by_kind }; }
    case 'path': { const r = await call(s0.tool, s0.arguments); const paths = (r.items ?? []).map(p => p.edges); return { value: paths, edges: paths.flat() }; }
    case 'region': { const r = await call(s0.tool, s0.arguments); return { value: (r.items ?? []).map(f => f.id).sort() }; }
    case 'evidence': { const r = await call(s0.tool, s0.arguments); return { value: r.edge, edges: r.edge ? [r.edge] : [] }; }
    case 'search': { const r = await call(s0.tool, s0.arguments); return { value: (r.items ?? []).map(h => h.id) }; }
    case 'changes': { const r = await call(s0.tool, s0.arguments); return { value: r.status === 'ok' ? r : null }; }
    default: { const edges = await allEdges(s0.arguments); return { value: ids(edges), edges }; }
  }
}

// ---- gold + citation checks (shared) --------------------------------------------------------------
const sortKeys = (o) => JSON.stringify(Object.fromEntries(Object.entries(o ?? {}).sort()));
function gold(q, v) {
  const g = q.gold;
  switch (q.kind) {
    case 'resolve': return v.ambiguous === 1 && v.resolved.length === 1 && v.resolved[0] === g.id;
    case 'gene_facts': return v.tree === g.tree && v.genome === g.genome;
    case 'derived_homologs': return sortKeys(v) === sortKeys(g.by_kind);
    case 'path': return v.some(p => p.length === g.hops && p[0].subject === g.from && p[p.length - 1].object === g.to && p.every(e => e.predicate === g.predicate));
    case 'region': return JSON.stringify(v) === JSON.stringify([...g.ids].sort());
    case 'evidence': return v?.provenance?.primary_knowledge_source === g.primary_knowledge_source && v?.provenance?.knowledge_level === g.knowledge_level
      && v.subject === g.subject && v.object === g.object;
    case 'search': return v.slice(0, g.top).includes(g.id);
    case 'changes': return !!v && v.from === g.from && v.to === g.to
      && Object.entries(g.totals).every(([k, t]) => JSON.stringify(v.totals?.[k]) === JSON.stringify(t));
    default: { const want = g.genes ?? g.publications ?? g.populations ?? g.ids; return JSON.stringify(v) === JSON.stringify([...want].sort()); }
  }
}
// every must_cite source appears on at least one returned edge that also carries release + knowledge_level
function cites(edges, must) {
  if (!must.length) return true;
  const es = Array.isArray(edges) ? edges : [];
  return must.every(src => es.some(e => e?.provenance?.primary_knowledge_source === src && e.provenance.release && e.provenance.knowledge_level));
}

for (const q of Q) {
  test(`${q.id}: ${q.q}`, async () => {
    const t0 = Date.now();
    let a;
    try { a = MODE === 'mcp' ? await answerMcp(q) : await answerRest(q); } catch (e) {
      results.push({ id: q.id, kind: q.kind, ok: false, cited: false, ms: Date.now() - t0, error: String(e.message ?? e).slice(0, 300) }); throw e;
    }
    const ok = gold(q, a.value); const cited = cites(a.edges, q.must_cite);
    results.push({ id: q.id, kind: q.kind, ok, cited, ms: Date.now() - t0 });
    assert.ok(ok, `gold mismatch for ${q.id}: got ${JSON.stringify(a.value)?.slice(0, 400)}`);
    assert.ok(cited, `missing provenance citation for ${q.id}`);
  });
}

test('summary', () => {
  const n = results.length, hits = results.filter(r => r.ok).length, cited = results.filter(r => r.cited).length;
  const p95 = results.map(r => r.ms).sort((a, b) => a - b)[Math.floor(0.95 * (n - 1))];
  const byKind = {};
  for (const r of results) { const k = (byKind[r.kind] ??= { n: 0, ok: 0 }); k.n++; if (r.ok) k.ok++; }
  const summary = { mode: MODE, [MODE === 'mcp' ? 'mcp' : 'api']: MODE === 'mcp' ? MCP : API, n, questions: Q.length, gold_hits: hits,
    gold_rate: hits / n, citation_rate: cited / n, p95_ms: p95, ...(MODE === 'mcp' ? { kg_edges_pages: mcpPages, page_size: PAGE } : {}), by_kind: byKind, failed: results.filter(r => !r.ok || !r.cited).map(r => r.error ? `${r.id}: ${r.error}` : r.id), at: new Date().toISOString() };
  fs.mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
  fs.appendFileSync(new URL(`./results/${MODE}.jsonl`, import.meta.url), JSON.stringify(summary) + '\n');
  console.log(JSON.stringify(summary));
  assert.ok(summary.gold_rate >= 0.9 && summary.citation_rate === 1);
});
