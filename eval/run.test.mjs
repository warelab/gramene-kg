// Eval runner against the REST API (M1a + M1b layers). M2 adds the MCP variant.
//   KG_API_URL=http://127.0.0.1:12000 node --test eval/run.test.mjs
// (node --test rejects extra CLI flags, so the endpoint comes from the environment.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const API = process.env.KG_API_URL || 'http://127.0.0.1:12000';
const Q = fs.readFileSync(new URL('./questions.jsonl', import.meta.url), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const get = async (path) => { const r = await fetch(API + path.replace(/^GET /, '')); return { status: r.status, body: await r.json() }; };
const results = [];

function cites(body, must) {
  if (!must.length) return true;
  const edges = Array.isArray(body.data) ? body.data : [];
  return must.every(src => edges.some(e => e.provenance?.primary_knowledge_source === src && e.provenance?.release && e.provenance?.knowledge_level));
}

for (const q of Q) {
  test(`${q.id}: ${q.q}`, async () => {
    const t0 = Date.now(); let ok = false; let cited = true;
    if (q.kind === 'resolve') {
      const a = await get(q.plan[0]); const b = await get(q.plan[1]);
      ok = a.body.data.ambiguous.length === 1 && b.body.data.resolved.length === 1 && b.body.data.resolved[0].id === q.gold.id;
    } else if (q.kind === 'gene_facts') {
      const { body } = await get(q.plan[0]);
      ok = body.data.gene_tree === q.gold.tree && body.data.genome === q.gold.genome;
    } else if (q.kind === 'derived_homologs') {
      const { body } = await get(q.plan[0]);
      ok = JSON.stringify(Object.fromEntries(Object.entries(body.data.by_kind).sort())) === JSON.stringify(Object.fromEntries(Object.entries(q.gold.by_kind).sort()));
    } else {
      const { body } = await get(q.plan[0] + '&limit=500');
      const ids = body.data.map(e => e.direction === 'in' ? e.subject : e.object).sort();
      const want = q.gold.genes ?? q.gold.publications ?? q.gold.populations ?? q.gold.ids;
      ok = JSON.stringify(ids) === JSON.stringify([...want].sort());
      cited = cites(body, q.must_cite);
    }
    results.push({ id: q.id, kind: q.kind, ok, cited, ms: Date.now() - t0 });
    assert.ok(ok, `gold mismatch for ${q.id}`);
    assert.ok(cited, `missing provenance citation for ${q.id}`);
  });
}

test('summary', () => {
  const n = results.length, hits = results.filter(r => r.ok).length, cited = results.filter(r => r.cited).length;
  const p95 = results.map(r => r.ms).sort((a, b) => a - b)[Math.floor(0.95 * (n - 1))];
  const summary = { api: API, n, gold_hits: hits, gold_rate: hits / n, citation_rate: cited / n, p95_ms: p95, at: new Date().toISOString() };
  fs.mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
  fs.appendFileSync(new URL('./results/rest.jsonl', import.meta.url), JSON.stringify(summary) + '\n');
  console.log(JSON.stringify(summary));
  assert.ok(summary.gold_rate >= 0.9 && summary.citation_rate === 1);
});
