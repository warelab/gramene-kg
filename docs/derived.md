# Derived per-gene tables (kg15_derived)

Two gene-keyed tables too large for the graph (190 M homology rows, 104 M expression values) are
written as bucketed parquet next to the build's other artifacts and read by `apps/api/derived.mjs`.
They are not nodes or edges; the graph keeps genes, gene trees, assays and contrasts, and these
rows refer to those ids.

    build/stages/kg15_derived.sh      runs both modules (needs BUILD_ID)
    build/lib/derived_homology.mjs    compara dumps      -> parquet/derived/homology/
    build/lib/derived_expression.mjs  <SRC_DB>.expression -> parquet/derived/expression/
    $BUILD_OUT/derived_counts.json    rows by kind per module (each module merges its own key)

## Buckets

Each table is `parquet/derived/<table>/bucket=<b>/part-0.parquet` with `b = hash(gene_id) % 64`
(DuckDB `hash()` on VARCHAR). Each bucket file is sorted by `gene_id` with 20,480-row row groups,
so a lookup computes the bucket with the same DuckDB expression, opens one file and reads one or
two row groups via the min/max statistics. The build and the API must use the same DuckDB
(`@duckdb/node-api` from this repo, DuckDB v2.0.0); a DuckDB upgrade that changes `hash()` needs
a kg15 re-run before the API reads that build.

## Homology

Inputs (`inputs.homology_dir`, headerless TSV, dumped by `dump_compara_tables.sh`):
`homology.tsv.gz` (homology_id, kind, gene_tree_root_id), `homology_member.tsv.gz` (homology_id,
gene_member_id, perc_pos), `gene_member.tsv.gz`, `genome_db.tsv.gz`, and the site's own output
`homolog_pairs.sorted.tsv.gz` (gene, other, kind) from `build_homologs.js`.

Two directed rows per homology (A->B, B->A). Every kind except `gene_split` comes from the plain
join; `gene_split` rows are kept only where `(gene, other, 'gene_split')` is in
`homolog_pairs.sorted.tsv.gz` (the site's skip heuristic). `synteny.tsv.gz` is empty for
sorghum11, so no `syntenic_` kinds occur. The gz dumps are staged once to parquet, joined in 10
homology_id ranges into unsorted staging partitions, then each bucket is sorted into its final
file. Fails if the total deviates > 1% from 190,368,450 unless `DERIVED_EXPECT_SKIP=1`.

| column | |
|---|---|
| gene_id, homolog_id | gene stable ids |
| kind | ortholog_one2one, ortholog_one2many, ortholog_many2many, within_species_paralog, gene_split |
| perc_pos, homolog_perc_pos | compara perc_pos of each member |
| gene_tree_id | `gramene.genetree:SB11GT_<gene_tree_root_id>` (prefix: release.yaml `genetree_prefix`, default `SB11GT_`) |
| homology_id | compara homology_id |
| genome, homolog_genome | compara genome_db.name |

sorghum11: 190,368,450 rows (one2one 131,284,150; many2many 25,323,870; one2many 18,997,304;
paralog 14,732,112; gene_split 31,014), 2.94-3.01 M rows per bucket, 2.2 GB. The
`(gene, homolog, kind)` multiset equals `homolog_pairs.sorted.tsv.gz` exactly (count and summed
row hash), and per-gene kind counts match `genes.homology.homologous_genes`.

## Expression

Input: `<SRC_DB>.expression`, `{_id: gene, "<experiment>": [{group, value} | {group, p_value, l2fc}]}`.
Streamed (read-only cursor) to `work/derived_expression.ndjson`, then to parquet; the NDJSON is
removed afterwards.

| column | |
|---|---|
| gene_id, experiment, group | `group` is `g<n>` (baseline) or `<reference>_<test>` (differential) |
| kind | baseline \| differential |
| assay_id | baseline: `gramene.assay:<experiment>.<group>` (= `assays._id`) |
| contrast_id | differential: `gramene.contrast:<experiment>.<reference>_<test>` (= kg contrast nodes) |
| value | baseline TPM/FPKM as stored |
| p_value, l2fc | differential |

sorghum11: 365,670 genes, 104,288,184 rows (baseline 79,972,480 over 318,231 genes and 97
experiments; differential 24,315,704 over 317,434 genes and 272 experiments); every id matches
the `config/prefixes.yaml` patterns; 376 MB.

## Timings (sorghum11, 64 cores)

| | wall | peak RSS |
|---|---|---|
| derived_homology | 3 m 16 s (staging 60 s, 10 chunks 56 s, bucket sort 78 s) | 12.2 GB |
| derived_expression | 5 m 10 s (Mongo scan 260 s) | 14.7 GB |

Lookups (`apps/api/derived.mjs`, warm): homologs 30 ms, expression 10-14 ms; first call ~90 ms
(instance start); 50 concurrent mixed lookups 240 ms.

## API functions

    homologs(dir, gene, {kind, limit = 100 (max 1000), offset = 0})
      -> { gene_id, total, by_kind: {kind: n}, rows: [{homolog_id, kind, perc_pos, homolog_perc_pos,
           gene_tree_id, homology_id, genome, homolog_genome}] }      ordered by kind, homolog_id
    expression(dir, gene, {experiment})
      -> { gene_id, rows: [{experiment, kind, group, assay_id, contrast_id, value, p_value, l2fc}] }

`dir` is `$RELEASE_BUILDS/<build_id>`. Gene, kind and experiment are validated by regex and bound
as parameters; invalid input throws an Error with `statusCode` 400. A gene with no rows (or a
build without kg15 output) returns empty rows.
