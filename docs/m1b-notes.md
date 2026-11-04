# M1b notes: measured results and deviations from the plan

Build `202610291704` of sorghum11, promoted 2026-10-29. It is the first build with the variant, LoF and
expression layers, the derived tables, the KGX export and the browse UI. Its expectations were recorded
in record mode, then a rerun from kg30 passed in check mode.

It was replaced on 2026-11-04 by build `202611041048`, which carries the review's data fixes (see the
end of this file). That build was a full `NEW_BUILD=1` run in check mode, about 54 minutes. The figures
below hold for both builds except where the last section says otherwise.

## Measured

| | value |
|---|---|
| nodes | 9,982,857 (5,636,023 + 4,346,834 SequenceVariant) |
| edges | 31,464,242 in KGX, of which 19,028,859 are materialised in Mongo |
| Solr docs | 517,625 (variants are exact-id lookups and are not indexed) |
| Mongo db | 15.5 GB data, 2.4 GB on disk, 3.5 GB indexes |
| KGX | 3.2 GB: TSV and JSON lines, whole graph plus 19 per-source edge files; JSON-LD context; manifest; RO-Crate |
| derived | homology 190,368,450 rows (2.2 GB); expression values 104,288,184 rows (376 MB); 64 hash buckets each |
| eval (REST) | 50/50 gold (30 M1a questions + 20 M1b), 100% provenance citation, p95 31 ms |
| build time | about 75 min end to end: kg50 export 21 min, kg60 Mongo load 14 min, kg15 derived 9 min |

New layers, each equal to its source:

| family | edges | check |
|---|---|---|
| `variant_gene` (`is_sequence_variant_of`) | 4,520,517 (PTV 110,472, PAV 738,726) | genes with rsIDs 35,091 = `rsid__attr_ss` on the BTx623 genes |
| `variant_genome` (slot) | 4,346,834 | every windowed rsID found in the EVA VCF |
| `sample_lof` (`gramene:carries_predicted_lof_allele_of`) | 3,120,315 pairs (4,081,054 calls) | 0 population-9 calls |
| `organ_expression` (`expressed_in`) | 1,975,055 = 1,033,358 positive + 941,697 negated | genes 211,528 = `expr_organ_level__attr_ss` |
| `expression_detected` (`gramene:expression_detected_in`) | 3,392,085 | genes 228,004 = `expressed_in_gxa_attr_ss` |

Plan checks:
- `/node/gramene.gene:SORBI_3002G146900/edges?predicate=gramene:carries_predicted_lof_allele_of&direction=in`
  returns 99 carriers. `gramene.sample:PI533794` is among them with a single homozygous `stop_gained`
  call in `sorghum_bicolor.5`, and there are no population-9 calls.
- `expressed_in` without `include_negated` returns only positive calls. For SORBI_3001G018000 that is
  10 organs, or 13 with the 3 negated `not_expressed` organs included.
- `sha256sum -c manifest.sha256` passes.
- `kgx validate` (vendored Biolink 4.4.6) reports zero errors on the Biolink-native sample of 262,010
  nodes and 241,910 edges.

## Deviations from the approved plan

- **The plan's example rsID is not in the graph.** `rs5413863902` is the VCF's first record (1:74). It
  lies in no gene window, so it is not windowed onto a gene. A windowed rsID shows the same facts:
  `dbsnp:rs5438710156` has `so_class` SO:0001483 and `studies` [PRJEB51985].
- **28,954 genes carry LoF calls, not 32,277.** 32,277 is every gene row in the wide v10 table; 3,323
  of those genes have calls only in the excluded SGT population. The source is now the v11 long table
  `gramene-solr/vep/sorghum_vep.txt` (SGT already removed). Its calls are identical to the wide table
  minus the merged and population-9 columns. The analysis id is `vep-lof-table@v11`.
- **The KGX edge count is about 31.5M, not about 16.3M.** The plan's figure left out the 8.1M slot
  edges written to KGX (gene→genome, gene→tree), the 4.35M variant→genome slots, and the 3.39M
  gene→experiment `expression_detected_in` edges.
- **`expression_detected_in` comes from the genes core** (`expressed_in_gxa_attr_ss`, the site's own
  rule in `mongo2solr.join.js`). It is not recomputed from `sorghum11.expression`; the raw values are in
  `/derived/expression`.
- **The KGX validation gate runs on JSON lines, not TSV.** KGX's TSV and JSON readers both turn
  `in_taxon` into a list, while its validator requires a string: Biolink 4.4.6 declares `in taxon`
  single-valued, and that is what we write. `build/lib/kgx_validate.py` drops exactly that message and
  reports how many it dropped. It also adds our declared local prefixes (`config/prefixes.yaml`) to
  the validator's prefix set, and loads Biolink from the vendored YAML, so validation is offline and pinned.
- **In KGX TSV, `|` in free text becomes `¦`.** `|` is the KGX list delimiter, and the reader would
  otherwise split a description into a list. JSON lines keep the original text.
- **Rows in the KGX files are not sorted by id.** They follow the Parquet order, which is
  deterministic; sorting cost about 5 minutes per file.
- **Variants are not in Solr, and genome nodes do not page their variants.** `/node/<genome>/edges`
  lists member genes and returns a warning that points to
  `/region?category=SequenceVariant` for the 4.3M variants.
- **The browse UI is plain ES modules with no build step**, not React + Vite: 541 lines of JS, no
  dependencies. Fastify serves it at `/kg/ui/`. It has only been checked against the live API through a
  DOM shim, because the host has no headless browser.
- **Derived tables are bucketed Parquet read by DuckDB in the API** (10–30 ms per lookup). Bucketing
  uses DuckDB's `hash()`, so a DuckDB upgrade requires rerunning kg15 for any build the API serves (see
  docs/derived.md).
- **The curated-gene feed snapshots on dev.gramene.org failed to fetch** in build 202610291704, which
  therefore had 2 fewer Dataset/Distribution records. No stage reads those snapshots. Both fetched in
  build 202611041048 (`snapshot-cshl_curated`, `snapshot-rapdb_curated`).

## Review of the M1b build (all fixes live since build 202611041048)

An independent review reproduced 6 defects, and all are fixed. The API fixes went live at once. The
data fixes needed a new build, which kg00 refused on 2026-10-29 18:47: a release70 `refresh-curated`
run (decorate + Solr) had started, and kg00 never builds alongside a decorate stage. They went live
with build 202611041048 on 2026-11-04.

- **Data:** 32,118 rsIDs span biallelic records with different REFs (e.g.
  rs162690701: TCAAAA>T and TCAAA>T). Build 202610291704 kept only the shortest REF, so the end
  coordinate is short. Nodes now carry `alleles: [{ref, alt}]` and end = pos + longest REF − 1.
- **KGX TSV:** KGX reads the text `false` in `negated` as true, so false is
  now written empty. `|` in edge `method`, `source_record` and `original_evidence` is escaped like
  node text (3,392,085 + 23,630 rows were affected).
- **API (live):**
  - `/derived/*` resolves aliases (`Sb03g030530`, `tb1`) and returns the alias warning.
  - A malformed `%` escape under `/kg/ui/` serves index.html instead of a 500.
  - The variant slot edge's `source_record` now matches the stored edge.

Verified correct by the same review: variant positions, alleles, SO class and studies (apart from the
REF issue); PTV/PAV flags against the source columns; LoF calls for 87 pairs; organ calls for 40 genes
against Mongo; detected-in against Solr; derived homologs and expression against Mongo; paging over
PO:0009005 (194,831 edges with negated ones = degree); manifest/RO-Crate checksums; UI safety.

### Build 202611041048 against 202610291704

The new build was diffed against the old one with DuckDB over `parquet/final/` (all 9,982,861 nodes
and 19,028,859 Mongo edges). The only differences:

- **SequenceVariant nodes.** Every node's attributes changed shape: `ref` + `alts` became
  `alleles: [{ref, alt}]` (209,619 variants have more than one allele). 32,118 ends got longer and none
  got shorter. `so_class` and `studies` are identical on all 4,346,834 nodes. Nothing in the API, UI,
  eval or MCP code read `ref` or `alts`. Example: `dbsnp:rs162690701` has alleles TCAAA>T and TCAAAA>T
  and end 57566877.
- **Per-build provenance nodes.** IngestRun, SoftwareAgent, the config Dataset, the 2026-11-04 snapshot
  Datasets and their Distributions changed. The two curated-feed snapshots that failed to fetch last
  time came through, giving 4 more nodes.
- **Edges.** Only `method` on the 3,545,448 `gene_qtl` edges changed (`qtl-containment@b473940` →
  `@ae59d78`). Every other column of every edge is identical.
- **KGX TSV.** `negated` is `true` on 941,697 rows (the negated organ calls) and empty on the rest.
  KGX's own TSV reader returns `True` for the first and no property for the second. No `|` remains in
  `gramene:method`, `gramene:source_record` or `gramene:original_evidence`.

`sha256sum -c manifest.sha256` passes, and `kgx validate` reports zero errors (2 known `in_taxon` false
positives dropped). Eval: 50/50 gold and 100% citation, p95 41 ms. The regenerated gold is
byte-identical to the previous `questions.jsonl`.

## Gene references cited by DOI only (release70 format)

Release70 stores references that have no PMID as separate xrefs:
`{db: 'DOI', source: 'rap-db' | 'CSHL', text, ids: ['10.…']}`. Previously the extractor kept only
`PUBMED` xrefs, so these would have been dropped silently. kg10 now extracts `DOI` xrefs too, and kg20
turns them into `mentions` edges. Each edge's `source_record` names the xref db, for example
`genes.xrefs[db=DOI]`, or `db=DOI,PUBMED` when one gene cites the same paper both ways.

On release70's anchors this adds 240 gene–DOI edges over 169 publications: 239 from `infores:rap-db`
and 1 from `infores:sorghumbase-curation`. sorghum11 has no `DOI` xrefs yet, and on its current input
the change reproduces all 34,270 mention edges exactly.

The release70 publication update (CSHL curation, RAP-DB titles) is due to reach sorghum11 later. On
the anchor genomes it moves:

| | sorghum11 now | release70 |
|---|---|---|
| sorghum gene–PMID pairs | 186 | 1,185 |
| rice gene–PMID pairs | 8,549 | 9,403 |
| rice gene–DOI pairs | 0 | 244 |

That is about +6% on `pub_mentions` and +1.5% on publications, inside the ±10% gates. When it lands,
rebuild and re-record the expectations for those families. Gene-xref `text` is never used as a
publication title: for geneRIF rows it is the GeneRIF statement. Titles come from IDFs, PubMed and
Crossref.
