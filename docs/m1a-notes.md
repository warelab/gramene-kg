# M1a notes: measured results and deviations from the plan

Build `202610291544` of sorghum11, promoted 2026-10-29 (replacing `202610291429` after the review fixes below).

## Measured

| | value |
|---|---|
| nodes | 5,636,022 (29 classes) |
| edges | 14,109,436, of which 6,020,887 materialised in Mongo; gene→genome and gene→tree are KGX-only slots |
| Solr docs | 517,624 (all non-gene nodes + 288,734 anchor-genome genes) |
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

## Review fixes (build 202610291544)

An independent review of the first promoted build found 21 defects; all were fixed before this build.

- **Data.**
  - Reactome hierarchy: event→parent edges rose from 1,943 to 7,565. Gene→pathway no longer joins the
    evidence table, and rice-only Reactome genes outside the anchor taxa are dropped.
  - Pathway lineages are kept per taxon.
  - GO annotations with an empty evidence code get `not_provided` rather than a guessed level.
  - `any_value`/unordered `string_agg` were replaced with `min`/ordered aggregates, so edge ids are
    deterministic: gold answers regenerated from this build are byte-identical.
- **Build safety.**
  - Stamps carry the build id, and `NEW_BUILD=1` really starts a new build.
  - A per-release `flock` covers `build` and `promote`.
  - Stages refuse to overwrite the live build's artifacts, db or core.
  - Promote verifies Mongo and Solr counts, keeps the new and previous builds, and sweeps only older,
    unprotected builds. It unloads the Solr core first and queues failures in `pending_retire`.
- **API.**
  - `/edges` pages through four phases (`out`, `slot_out`, `in`, `slot_in`). Predicates are expanded
    from the node's degree map, so every query uses the `{s|o, p, _id}` indexes.
  - A full last page probes the next phase before emitting a cursor.
  - Genome and tree nodes list their member genes inbound, and every filter applies to slot edges.
  - Page walks at sizes 1–500 equal Mongo totals with no duplicates.
  - `/path` uses exact second-hop queries, includes slot neighbours, excludes negated edges, and warns
    when it truncates.
  - `/resolve` has a POST form for up to 5,000 ids. Search falls back to exact id/alias resolution over
    all 5.4M genes (`meta.resolved`) and matches lower-cased full and local ids (`id_lc_s`,
    `local_id_lc_s`).
  - Category names accept the internal class or the Biolink category; unknown ones return 400.
  - `rows`/`start` are validated, fq values escaped, and Solr parse errors return 400.
- **Second review of the API rewrite** (6 reproduced defects, fixed and re-checked):
  - A Biolink category that covers several classes now matches all of them. GeneFamily covers GeneTree
    and TF family; Study, MaterialSample, AnatomicalEntity, Dataset and Activity each cover two.
  - A 5,000-id `/resolve` takes 0.3 s, down from 4.5 s spent in an O(n²) loop that blocked the event
    loop.
  - Search `meta.resolved` honours `genome=`, and bare GCA values are accepted there.
  - Forged cursors return 400.
  - `/path` with the same `from` and `to` returns 400.
  - Not testable: this build has 0 negated edges, so `include_negated` is unexercised until M1b
    expression.
- **DOIs.**
  - DOIs are case-normalised.
  - A publication keyed by PMID is also found by its DOI: `doi:` xrefs are indexed in `aliases_lc`.
    `/node/doi:10.1101%2Fgr.227462.117` resolves to `PMID:29712755`, with a warning.
- **This build.** The dev.gramene.org curated-gene feeds (`rapdb_curated`, `cshl_curated`) failed to
  fetch, so this build has 2 fewer Dataset/Distribution records. No extract stage reads those
  snapshots; the curated gene data comes from `sorghum11`.
