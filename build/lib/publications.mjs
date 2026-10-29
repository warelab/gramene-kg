// kg25 publications: title/year/journal/authors for Publication nodes.
// Cache-first in kg_meta.publication_cache (persists across builds); NCBI esummary for PMIDs
// (200 ids per request, <= 3 requests/s, no API key, no email sent), Crossref for DOI-only ids.
// Offline-safe: anything not enriched keeps a bare node flagged enriched=false.
import { MongoClient } from 'mongodb';
import { env, buildOut, q, exec, sqlStr, log } from './kgio.mjs';

const PUB = buildOut('parquet', 'graph', 'nodes', 'GramenePublication.parquet');
const ids = (await q(`SELECT id FROM ${sqlStr(PUB)}`)).map(r => r.id);
const client = await MongoClient.connect(env('MONGO_URI'));
const cache = client.db('kg_meta').collection('publication_cache');
const cached = new Map((await cache.find({ _id: { $in: ids } }).toArray()).map(d => [d._id, d]));
const todo = ids.filter(i => !cached.has(i));
log(`publications: ${ids.length} total, ${cached.size} cached, ${todo.length} to fetch`);
const UA = 'gramene-kg/0.1 (+https://github.com/warelab/gramene-kg)';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const now = new Date();
let fetched = 0, failed = 0;

// --- PubMed esummary ---
const pmids = todo.filter(i => i.startsWith('PMID:')).map(i => i.slice(5));
for (let k = 0; k < pmids.length; k += 200) {
  const batch = pmids.slice(k, k + 200);
  try {
    const r = await fetch('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
      body: new URLSearchParams({ db: 'pubmed', retmode: 'json', tool: 'gramene-kg', id: batch.join(',') }), signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const docs = [];
    for (const id of batch) {
      const d = j.result?.[id]; if (!d || d.error) continue;
      const doi = (d.articleids ?? []).find(a => a.idtype === 'doi')?.value?.toLowerCase() ?? null;
      docs.push({ _id: `PMID:${id}`, title: d.title || null, journal: d.fulljournalname || d.source || null,
        year: Number((d.pubdate ?? '').slice(0, 4)) || null, authors: (d.authors ?? []).slice(0, 10).map(a => a.name),
        n_authors: (d.authors ?? []).length, doi, source: 'ncbi-esummary', fetched_at: now });
    }
    if (docs.length) await cache.bulkWrite(docs.map(d => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } })));
    fetched += docs.length;
  } catch (e) { failed += batch.length; log(`esummary batch ${k} failed: ${e.message}`); }
  if (k % 4000 === 0) log(`esummary ${Math.min(k + 200, pmids.length)}/${pmids.length}`);
  await sleep(350);
}

// --- Crossref for DOI-only ids ---
const dois = todo.filter(i => i.startsWith('doi:')).map(i => i.slice(4));
for (const doi of dois) {
  try {
    const r = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30000) });
    if (r.status === 404) { failed++; continue; }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const m = (await r.json()).message;
    await cache.replaceOne({ _id: `doi:${doi}` }, { _id: `doi:${doi}`, title: m.title?.[0] ?? null, journal: m['container-title']?.[0] ?? null,
      year: m.issued?.['date-parts']?.[0]?.[0] ?? null, authors: (m.author ?? []).slice(0, 10).map(a => [a.family, a.given].filter(Boolean).join(' ')),
      n_authors: (m.author ?? []).length, doi, source: 'crossref', fetched_at: now }, { upsert: true });
    fetched++;
  } catch (e) { failed++; log(`crossref ${doi} failed: ${e.message}`); }
  await sleep(120);
}
log(`fetched ${fetched}, failed/absent ${failed}`);

// --- rewrite the Publication node table with enrichment ---
const all = await cache.find({ _id: { $in: ids } }).toArray();
await client.close();
const tmp = buildOut('work', 'pub_enrich.json');
(await import('node:fs')).writeFileSync(tmp, all.map(d => JSON.stringify({ id: d._id, title: d.title, journal: d.journal, year: d.year,
  authors: d.authors ?? [], doi: d.doi ?? null, enrichment_source: d.source, fetched_at: d.fetched_at })).join('\n') + '\n');
const out = PUB.replace(/\.parquet$/, '.enriched.parquet');
await exec(`COPY (
  SELECT p.id, p.category, p.cls, coalesce(e.title, p.name) AS name, p.description, p.aliases,
         CASE WHEN e.doi IS NOT NULL AND starts_with(p.id, 'PMID:') THEN ['doi:' || e.doi] ELSE p.xrefs END AS xrefs,
         p.in_taxon, p.genome, p.tree, p.region, p.start, p."end", p.strand,
         to_json({enriched: e.id IS NOT NULL, journal: e.journal, year: e.year, authors: e.authors, enrichment_source: e.enrichment_source})::VARCHAR AS attrs
  FROM ${sqlStr(PUB)} p LEFT JOIN read_json(${sqlStr(tmp)}, format='newline_delimited',
    columns={id:'VARCHAR', title:'VARCHAR', journal:'VARCHAR', year:'INTEGER', authors:'VARCHAR[]', doi:'VARCHAR', enrichment_source:'VARCHAR', fetched_at:'VARCHAR'}) e ON e.id = p.id
) TO ${sqlStr(out)} (FORMAT parquet, COMPRESSION zstd)`);
await (await import('node:fs/promises')).rename(out, PUB);
const [{ n, enriched }] = await q(`SELECT count(*)::BIGINT n, count(*) FILTER (WHERE json_extract(attrs, '$.enriched')::BOOLEAN)::BIGINT enriched FROM ${sqlStr(PUB)}`);
log(`Publication nodes: ${n}, enriched ${enriched}`);
