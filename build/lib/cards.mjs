// kg40 cards + degree: one final node table (parquet/final/nodes.parquet) with
//   deg   JSON {"<predicate>|out": n, "<predicate>|in": n}  (all edges, slots included)
//   card  deterministic text for Solr-indexed nodes; every fact ends with its sources and release
//   solr  true for non-gene nodes and anchor-genome genes
// and the materialised edge table for Mongo (parquet/final/edges_mongo.parquet) with endpoint classes.
import { env, buildOut, q, exec, sqlStr, log } from './kgio.mjs';

const RELEASE = env('RELEASE');
const G = (kind) => sqlStr(buildOut('parquet', 'graph', kind, '*.parquet'));
const FINAL = (n) => sqlStr(buildOut('parquet', 'final', `${n}.parquet`));

await exec(`CREATE TABLE nodes AS SELECT * FROM read_parquet(${G('nodes')}, union_by_name=true)`);
await exec(`CREATE TABLE edges AS SELECT id, subject, predicate, object, primary_knowledge_source, original_evidence, slot FROM read_parquet(${G('edges')}, union_by_name=true)`);
await exec(`CREATE TABLE card_set AS SELECT id FROM nodes WHERE cls <> 'GeneModel' OR coalesce(json_extract(attrs, '$.anchor')::BOOLEAN, false)`);
log(`nodes ${(await q('SELECT count(*)::BIGINT n FROM nodes'))[0].n}, card set ${(await q('SELECT count(*)::BIGINT n FROM card_set'))[0].n}`);

// degree for every node
await exec(`CREATE TABLE deg AS
  SELECT id, to_json(map_from_entries(list(struct_pack(k := k, v := n) ORDER BY k)))::VARCHAR AS deg, sum(n)::BIGINT AS degree
  FROM (SELECT subject AS id, predicate || '|out' AS k, count(*) AS n FROM edges GROUP BY ALL
        UNION ALL SELECT object, predicate || '|in', count(*) FROM edges GROUP BY ALL) GROUP BY id`);

// card facts: per (node, direction, predicate): count, first 3 neighbour names, sources
await exec(`CREATE TABLE card_edges AS
  SELECT e.subject AS node, 'out' AS dir, e.predicate AS pred, e.object AS nbr, e.primary_knowledge_source AS src FROM edges e SEMI JOIN card_set c ON c.id = e.subject
  UNION ALL
  SELECT e.object, 'in', e.predicate, e.subject, e.primary_knowledge_source FROM edges e SEMI JOIN card_set c ON c.id = e.object`);
await exec(`CREATE TABLE facts AS
  SELECT node, dir, pred, count(*) AS n,
         list(DISTINCT coalesce(nb.name, ce.nbr) ORDER BY coalesce(nb.name, ce.nbr))[1:3] AS ex,
         list(DISTINCT src ORDER BY src) AS srcs
  FROM card_edges ce LEFT JOIN nodes nb ON nb.id = ce.nbr GROUP BY ALL`);
const label = `CASE WHEN dir = 'out' THEN replace(split_part(pred, ':', 2), '_', ' ') ELSE 'inverse of ' || replace(split_part(pred, ':', 2), '_', ' ') END`;
await exec(`CREATE TABLE cards AS
  SELECT node AS id, string_agg(${label} || ' (' || n || '): ' || array_to_string(ex, ', ') || CASE WHEN n > 3 THEN ', …' ELSE '' END
                    || ' [' || array_to_string(srcs, '; ') || '; ${RELEASE}]', '. ' ORDER BY dir DESC, pred) AS facts
  FROM facts GROUP BY node`);

const header = `n.name || ' (' || n.id || '), ' || lower(regexp_replace(n.cls, '([a-z])([A-Z])', '\\1 \\2', 'g'))
  || CASE WHEN n.cls = 'GeneModel' THEN coalesce(' [' || json_extract_string(n.attrs, '$.biotype') || ']', '')
           || coalesce(' on ' || g.name || ' ' || n.region || ':' || n.start || '-' || n."end" || CASE n.strand WHEN 1 THEN ' (+)' WHEN -1 THEN ' (-)' ELSE '' END, '')
          WHEN n.cls = 'QuantitativeTraitLocus' THEN coalesce(' on ' || g.name || ' ' || n.region || ':' || n.start || '-' || n."end", '')
             || coalesce(' from ' || json_extract_string(n.attrs, '$.source'), '')
          ELSE '' END
  || coalesce('. ' || left(n.description, 400), '')`;
await exec(`COPY (
  SELECT n.*, coalesce(d.deg, '{}') AS deg, coalesce(d.degree, 0) AS degree,
         (c.id IS NOT NULL) AS solr,
         CASE WHEN c.id IS NOT NULL THEN ${header} || coalesce('. ' || cd.facts, '') || '.' END AS card
  FROM nodes n LEFT JOIN deg d USING (id) LEFT JOIN card_set c USING (id) LEFT JOIN cards cd USING (id)
  LEFT JOIN nodes g ON g.id = n.genome
) TO ${FINAL('nodes')} (FORMAT parquet, COMPRESSION zstd)`);

// materialised edges for Mongo, with endpoint classes
await exec(`COPY (
  SELECT e.*, s.cls AS subject_cls, o.cls AS object_cls
  FROM read_parquet(${G('edges')}, union_by_name=true) e
  LEFT JOIN (SELECT id, cls FROM nodes) s ON s.id = e.subject
  LEFT JOIN (SELECT id, cls FROM nodes) o ON o.id = e.object
  WHERE NOT e.slot
) TO ${FINAL('edges_mongo')} (FORMAT parquet, COMPRESSION zstd)`);

const [s] = await q(`SELECT count(*)::BIGINT n, count(card)::BIGINT cards, count(*) FILTER (WHERE solr)::BIGINT solr,
  max(length(card))::BIGINT max_card, avg(length(card))::INTEGER avg_card FROM ${FINAL('nodes')}`);
const [e] = await q(`SELECT count(*)::BIGINT n FROM ${FINAL('edges_mongo')}`);
log(`final nodes ${s.n}, solr ${s.solr}, cards ${s.cards} (avg ${s.avg_card} chars, max ${s.max_card}); mongo edges ${e.n}`);
if (Number(s.cards) !== Number(s.solr)) { log('FATAL: card count != solr set'); process.exit(1); }
