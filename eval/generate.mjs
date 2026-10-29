// Generate eval questions with gold answers from a build's Parquet (never hand-typed).
//   KG_BUILD_DIR=/scratch/olson/gramene-kg/builds/sorghum11/current node eval/generate.mjs > eval/questions.jsonl
// Sampling is deterministic (ORDER BY hash(id)), so the same build yields the same questions.
import { DuckDBInstance } from '@duckdb/node-api';

const B = process.env.KG_BUILD_DIR || '/scratch/olson/gramene-kg/builds/sorghum11/current';
const N = `'${B}/parquet/final/nodes.parquet'`;
const E = `read_parquet('${B}/parquet/graph/edges/*.parquet', union_by_name=true)`;
const c = await (await DuckDBInstance.create(':memory:')).connect();
const rows = async (sql) => (await c.runAndReadAll(sql)).getRowObjectsJson();
const out = [];
const add = (kind, q, plan, gold, must_cite = []) => out.push({ id: `${kind}-${out.filter(x => x.kind === kind).length + 1}`, kind, q, plan, gold, must_cite });

// 1. id resolution: a Sobic alias that is also the _id of a T2T-CAS gene must be ambiguous until genome= is given
for (const r of await rows(`SELECT n.id, a AS alias FROM (SELECT id, unnest(aliases) a FROM ${N} WHERE cls='GeneModel' AND genome='insdc.gca:GCA_000003195.3') n
    JOIN ${N} t ON t.id = 'gramene.gene:' || n.a WHERE n.a LIKE 'Sobic.%' ORDER BY hash(n.id) LIMIT 5`))
  add('resolve', `Which BTx623 v3 gene does ${r.alias} refer to?`,
    [`GET /kg/v1/resolve?ids=${r.alias}`, `GET /kg/v1/resolve?ids=${r.alias}&genome=GCA_000003195.3`],
    { ambiguous_without_genome: true, id: r.id });

// 2. gene facts from slots: tree and genome
for (const r of await rows(`SELECT id, tree, genome FROM ${N} WHERE cls='GeneModel' AND tree IS NOT NULL AND json_extract(attrs,'$.anchor')::BOOLEAN
    AND starts_with(id,'gramene.gene:SORBI_') ORDER BY hash(id) LIMIT 5`))
  add('gene_facts', `Which gene tree is ${r.id.split(':')[1]} in, and on which genome assembly?`, [`GET /kg/v1/node/${r.id}`],
    { tree: r.tree, genome: r.genome });

// 3. QTL containment (small QTLs so the gold list is complete)
for (const r of await rows(`SELECT object AS qtl, list(subject ORDER BY subject) AS genes, any_value(primary_knowledge_source) src FROM ${E}
    WHERE family='gene_qtl' GROUP BY object HAVING count(*) BETWEEN 2 AND 12 ORDER BY hash(object) LIMIT 5`))
  add('qtl_genes', `Which genes lie completely inside QTL ${r.qtl.split(':')[1]}?`,
    [`GET /kg/v1/node/${r.qtl}/edges?predicate=overlaps&direction=in`], { genes: r.genes }, [r.src]);

// 4. literature for sorghum genes (CSHL curation)
for (const r of await rows(`SELECT object AS gene, list(subject ORDER BY subject) AS pubs, any_value(primary_knowledge_source) src FROM ${E}
    WHERE family='pub_mentions' AND starts_with(object,'gramene.gene:SORBI_') GROUP BY object ORDER BY hash(object) LIMIT 5`))
  add('gene_pubs', `Which publications discuss ${r.gene.split(':')[1]}?`, [`GET /kg/v1/node/${r.gene}/edges?predicate=mentions&direction=in`],
    { publications: r.pubs }, [r.src]);

// 5. germplasm: accession -> populations (multi-population accessions)
for (const r of await rows(`SELECT subject AS acc, list(object ORDER BY object) AS pops FROM ${E} WHERE family='accession_population'
    GROUP BY subject HAVING count(*) > 1 ORDER BY hash(subject) LIMIT 5`))
  add('germplasm_pops', `Which sequenced populations include accession ${r.acc}?`, [`GET /kg/v1/node/${r.acc}/edges?predicate=member_of&direction=out`],
    { populations: r.pops }, ['infores:sorghumbase']);

// 6. experiment citations from Atlas IDFs
for (const r of await rows(`SELECT object AS expt, list(subject ORDER BY subject) AS pubs FROM ${E} WHERE family='pub_mentions' AND starts_with(object,'gxa.expt:')
    GROUP BY object ORDER BY hash(object) LIMIT 5`))
  add('experiment_pubs', `Which publication describes expression experiment ${r.expt.split(':')[1]}?`,
    [`GET /kg/v1/node/${r.expt}/edges?predicate=mentions&direction=in`], { publications: r.pubs }, ['infores:expression-atlas']);

for (const q of out) console.log(JSON.stringify(q));
console.error(`${out.length} questions from ${B}`);
