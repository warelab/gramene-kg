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

// ---- M1b layers (skipped when the build has no variant / LoF / expression families) ----
const fams = new Set((await rows(`SELECT DISTINCT family FROM ${E}`)).map(r => r.family));
// 7. protein-truncating variants -> genes
if (fams.has('variant_gene')) for (const r of await rows(`SELECT subject AS v, list(object ORDER BY object) AS genes FROM ${E}
    WHERE family='variant_gene' AND json_extract(qualifiers,'$.protein_truncating')::BOOLEAN GROUP BY subject ORDER BY hash(subject) LIMIT 5`))
  add('variant_genes', `Which gene(s) is ${r.v.split(':')[1]} a predicted protein-truncating variant of?`,
    [`GET /kg/v1/node/${r.v}/edges?predicate=is_sequence_variant_of&direction=out`], { ids: r.genes }, ['infores:eva']);
// 8. predicted LoF carriers of a gene (all populations except the excluded SGT panel)
if (fams.has('sample_lof')) for (const r of await rows(`SELECT object AS gene, list(subject ORDER BY subject) AS samples FROM ${E} WHERE family='sample_lof'
    GROUP BY object HAVING count(*) BETWEEN 2 AND 12 ORDER BY hash(object) LIMIT 5`))
  add('lof_carriers', `Which genotyped samples carry a predicted loss-of-function allele of ${r.gene.split(':')[1]}?`,
    [`GET /kg/v1/node/${r.gene}/edges?predicate=gramene:carries_predicted_lof_allele_of&direction=in`], { ids: r.samples }, ['infores:ensembl-variation']);
// 9. organs where a sorghum gene is expressed (negated not_expressed calls excluded)
if (fams.has('organ_expression')) for (const r of await rows(`SELECT subject AS gene, list(object ORDER BY object) AS organs FROM ${E} WHERE family='organ_expression'
    AND NOT negated AND starts_with(subject,'gramene.gene:SORBI_') GROUP BY subject ORDER BY hash(subject) LIMIT 5`))
  add('organ_expression', `In which plant organs is ${r.gene.split(':')[1]} expressed?`,
    [`GET /kg/v1/node/${r.gene}/edges?predicate=expressed_in&direction=out&source=infores:sorghumbase`], { ids: r.organs }, ['infores:sorghumbase']);
// 10. homolog counts by kind from the derived layer
if (fams.has('variant_gene')) for (const r of await rows(`SELECT gene_id, map_from_entries(list(struct_pack(k := kind, v := n) ORDER BY kind)) AS by_kind FROM (
    SELECT gene_id, kind, count(*)::INTEGER n FROM read_parquet('${B}/parquet/derived/homology/*/*.parquet') WHERE gene_id IN (
      SELECT gene_id FROM read_parquet('${B}/parquet/derived/homology/*/*.parquet') WHERE starts_with(gene_id, 'SORBI_') GROUP BY gene_id ORDER BY hash(gene_id) LIMIT 5)
    GROUP BY ALL) GROUP BY gene_id ORDER BY gene_id`))
  add('derived_homologs', `How many homologs of each kind does ${r.gene_id} have?`, [`GET /kg/v1/derived/homologs/gramene.gene:${r.gene_id}?limit=1`], { by_kind: Array.isArray(r.by_kind) ? Object.fromEntries(r.by_kind.map(x => [x.key, x.value])) : r.by_kind });

for (const q of out) console.log(JSON.stringify(q));
console.error(`${out.length} questions from ${B}`);
