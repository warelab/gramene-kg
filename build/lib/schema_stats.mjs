// Schema statistics for agents and /kg/v1/schema: node classes with counts, id prefixes and examples;
// relations (family, predicate, subject/object class) with counts and knowledge sources.
// Written into the build db's manifest document (kg60 calls this after loading).
import { MongoClient } from 'mongodb';
import { env, buildOut, q, sqlStr, log } from './kgio.mjs';

const N = sqlStr(buildOut('parquet', 'final', 'nodes.parquet'));
const E = sqlStr(buildOut('parquet', 'graph', 'edges', '*.parquet'));
const classes = await q(`SELECT cls AS class, any_value(category[1]) AS category, count(*)::BIGINT AS count,
    list(DISTINCT split_part(id, ':', 1)) AS id_prefixes, list(id ORDER BY degree DESC)[1:3] AS examples
  FROM ${N} GROUP BY cls ORDER BY count DESC`);
const relations = await q(`SELECT e.family, e.predicate, s.cls AS subject_class, o.cls AS object_class, count(*)::BIGINT AS count,
    list(DISTINCT e.primary_knowledge_source ORDER BY e.primary_knowledge_source) AS sources, bool_or(e.slot) AS slot
  FROM read_parquet(${E}, union_by_name=true) e JOIN (SELECT id, cls FROM ${N}) s ON s.id = e.subject JOIN (SELECT id, cls FROM ${N}) o ON o.id = e.object
  GROUP BY ALL ORDER BY count DESC`);
const fix = (rows) => rows.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])));
const stats = { classes: fix(classes), relations: fix(relations), generated_at: new Date().toISOString() };
const client = await MongoClient.connect(env('MONGO_URI'));
await client.db(env('KG_DB')).collection('manifest').updateOne({ _id: 'build' }, { $set: { schema_stats: stats } });
await client.close();
log(`schema stats: ${stats.classes.length} classes, ${stats.relations.length} relations`);
