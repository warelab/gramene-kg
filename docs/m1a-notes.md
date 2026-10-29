# M1a notes: measured results and deviations from the plan

Build `202610291429` of sorghum11, promoted 2026-10-29.

## Measured

| | value |
|---|---|
| nodes | 5,636,026 (29 classes) |
| edges | 14,103,814, of which 6,015,265 materialised in Mongo; gene→genome and gene→tree are KGX-only slots |
| Solr docs | 517,628 (all non-gene nodes + 288,734 anchor-genome genes) |
| Mongo db | 5.9 GB data, 0.95 GB on disk, 1.15 GB indexes |
| publications | 22,233, all enriched (PubMed esummary + Crossref) |
| eval (REST) | 30/30 gold, 100% provenance citation |
| latency, node + edges | cold p50 36 ms, p95 135 ms; warm p95 18 ms |

Cross-checks against the live `sorghum_genes11` core (anchor genomes): genes with GO edges 185,049 =
185,049; genes inside a QTL 72,845 = 72,845; genes with pathways 8,536 = 8,536; current InterPro
207,743 vs 207,885 (0.07%); genes with publications 13,842 vs 13,846.

## Deviations from the approved plan

- **Contrast ids are `<reference>_<test>`**, not `<test>_<reference>`. Verified on E-CURD-148
  `g5_g1`: g5 is the mock control. The id is kept verbatim; roles come from position.
- **Germplasm accessions: 7,917, not ≈6,600.** The estimate counted distinct dbids only and missed
  the 890 sorbmutdb lines and 432 accessions resolved by stock centre + name. ARS accessions are
  1:1 with accession numbers; 389 accessions span more than one sample.
- **Small N:1 relations are materialised** (sample→accession, sample→population, assay→experiment,
  QTL→genome, genome→taxon) plus a derived accession→population edge. Only gene→genome (5.4M) and
  gene→tree (2.7M) stay KGX-only slots; the API exposes them as edges from node fields.
- **741 retired InterPro ids** referenced by the Ensembl cores (absent from both 109.0 and 110.0;
  IPR003480 alone on 714 genes) are stub nodes with `stub: true, obsolete: true`. The plan review's
  "0 referenced" was wrong.
- **669 experiments are stubs**: assay groups exist in `sorghum11.assays` without an experiment
  document (mostly proteomics, e.g. E-PROT-135).
- **Ontology hierarchy edges stay within one ontology** (98 PO→UBERON and 331 TO→PATO parents not
  emitted, counted in `transform_counts.json`). 9 QTL terms that are not TO ids (`NA`) and 1 malformed
  ECO id are dropped and counted.
- **PMID wins over DOI** for the same paper (IDF rows, composite strings, and any DOI the PubMed
  cache ties to a PMID): 59 duplicate publication nodes removed.
- **The API is JavaScript (ES modules) on Fastify 5**, not TypeScript: one file, no build step.
  GraphQL remains M2.
- **Biolink JSON Schema:** LinkML 1.12's `gen-json-schema` puts the `category` enum on the array
  instead of its items; `build/lib/schema_sample.py` corrects that before validating.
- **DuckDB 2.0** reserves `at`, `as` and `group` and rejects `x -> …` lambdas; the SQL uses
  `lambda x: …` and quoted keys.
