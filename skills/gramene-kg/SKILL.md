---
name: gramene-kg
description: How to answer questions with the Gramene/SorghumBase knowledge graph through the kg_* MCP tools (kg_resolve, kg_node, kg_neighbors, kg_edges, kg_evidence, kg_path, kg_region, kg_search, kg_schema, kg_release, kg_derived, kg_changes). Covers id/CURIE conventions, which predicates exist, how to cite provenance, ambiguity, paging, worked walks with real ids, what the graph cannot answer, and common pitfalls.
---

# Gramene knowledge graph (kg_* tools)

The graph is a typed, provenance-carrying view of SorghumBase release **sorghum11**: ~10.0M nodes and
~31.5M edges (19.0M stored edges plus 12.4M "slot" edges for gene -> genome and gene -> gene tree).
Every edge has a primary knowledge source (an `infores:` id), a knowledge level and an agent type. All
tools are read-only.

**Always read the release and build from the tool result.** Every kg_* result starts with
`release` and `build`. The build id changes when a new build is promoted, so do not hard-code it. Call
`kg_release` to state the build, its previous build, the promotion time and the counts. Examples below
were captured on build `202611041048` (previous build `202610291704`).

## Ids (CURIEs)

| thing | CURIE form | example |
|---|---|---|
| gene model (any genome) | `gramene.gene:<stable id>` | `gramene.gene:SORBI_3006G221000` (BTx623 v3), `gramene.gene:Sobic.007G158500` (T2T-CAS), `gramene.gene:Os04g0624600` |
| genome assembly | `insdc.gca:<GCA>` or `gramene.genome:<name>` | `insdc.gca:GCA_000003195.3` = **BTx623 v3, the sorghum anchor**; `gramene.genome:sorghum_bicolort2tcas` |
| gene tree | `gramene.genetree:` | `gramene.genetree:SB11GT_825318` |
| sequence variant | `dbsnp:rs<n>` | `dbsnp:rs5449093678` |
| publication | `PMID:<n>` or `doi:<lower-case doi>` | `PMID:38602082`; `doi:10.1101/gr.227462.117` is an alias of `PMID:29712755` |
| genotyped sample | `gramene.sample:` | `gramene.sample:PI562982` |
| germplasm accession (GRIN) | `gramene.germplasm:ars.<GRIN id>` | `gramene.germplasm:ars.1457953` |
| population | `gramene.population:<species>.<n>` | `gramene.population:sorghum_bicolor.3` (Lozano) |
| QTL | `gramene.qtl:` | `gramene.qtl:QPRCN7.1` |
| ontology terms | `GO:`, `PO:`, `TO:`, `ECO:` + 7 digits | `GO:2001070`, `PO:0009005` (root), `TO:0000598` (protein content) |
| InterPro, Plant Reactome | `interpro:`, `reactome:` | `interpro:IPR011009`, `reactome:R-SBI-1120805` |
| expression experiment / contrast / assay group | `gxa.expt:` or `gramene.expt:`, `gramene.contrast:`, `gramene.assay:` | `gxa.expt:E-GEOD-141035`, `gramene.contrast:E-CURD-148.g5_g1` |
| edge | `gramene.assoc:<hex>` | `gramene.assoc:4e440cd67c5c4cbf1269f8e3` |
| source (provenance value, not a node) | `infores:<name>` | `infores:sorghum-qtl-atlas` (in `primary_knowledge_source`; kg_node cannot fetch it) |

A sample (`gramene.sample:`) is a genotyped individual and is not the same node as a germplasm accession
(`gramene.germplasm:`). They are linked by `derives_from`. Prefixes are case-sensitive in tool arguments.
`doi:` is lower-case, but kg_resolve also matches `DOI:10.1101/GR.227462.117` and maps it to the PMID.

## Node classes (kg_schema)

GeneModel (5.4M, all genomes), SequenceVariant (4.3M, BTx623 v3 only), InterProEntry, GeneTree, GoTerm,
GramenePublication, QuantitativeTraitLocus, GenotypedSample, GermplasmAccession, PlantReactomeEvent,
SampleGroup (expression assay group), EvidenceCodeTerm, TraitTerm (TO), PlantAnatomyTerm and
PlantStageTerm (PO), ExpressionContrast, ExpressionExperiment, GenomeAssembly (128), GrameneTaxon,
TranscriptionFactorFamily, GramenePopulation (11), VariationStudy, and metadata classes (KgDataset,
KgDistribution, AnalysisRun, SoftwareAgent, IngestRun, KgRelease, KgCollection, OntologyClassStub).
Use `kg_schema {category:"GeneModel"}` for one class's in and out relations.

## Predicates present (subject -> object, source)

Bare names get the `biolink:` prefix. `gramene:` predicates must be written in full.

| predicate | subject -> object | primary source(s) |
|---|---|---|
| `located_in` | GeneModel / SequenceVariant / QTL -> GenomeAssembly; GeneModel -> GoTerm (cellular component) | ensembl-gene, eva, QTL sources |
| `member_of` | GeneModel -> GeneTree (slot), GeneModel -> TranscriptionFactorFamily, GenotypedSample -> GramenePopulation, GermplasmAccession -> GramenePopulation | ensembl-compara, grassius, ensembl-variation, sorghumbase |
| `overlaps` | GeneModel -> QTL (qualifier `containment: full`; the gene lies inside the QTL on the QTL's genome) | sorghum-qtl-atlas, gramene-qtldb |
| `associated_with` | QTL -> TraitTerm | sorghum-qtl-atlas, gramene-qtldb |
| `is_sequence_variant_of` | SequenceVariant -> GeneModel (qualifiers `protein_truncating`, `protein_altering`) | eva |
| `gramene:carries_predicted_lof_allele_of` | GenotypedSample -> GeneModel (qualifier `calls[]`: consequence, zygosity, population) | ensembl-variation |
| `derives_from` | GenotypedSample -> GermplasmAccession | sorghumbase |
| `expressed_in` | GeneModel -> PlantAnatomyTerm: organ-level calls (sorghumbase, can be negated) and curated PO annotations (tair, rap-db) | sorghumbase, tair, rap-db |
| `gramene:expressed_during` | GeneModel -> PlantStageTerm | tair, rap-db |
| `gramene:expression_detected_in` | GeneModel -> ExpressionExperiment | expression-atlas, jgi-phytozome |
| `enables`, `actively_involved_in`, `located_in` | GeneModel -> GoTerm (qualifier `evidence`, provenance `has_evidence` ECO) | ensembl-gene |
| `gramene:has_domain` | GeneModel -> InterProEntry | interpro |
| `participates_in` | GeneModel -> PlantReactomeEvent | plant-reactome |
| `has_phenotype` | GeneModel -> TraitTerm | rap-db |
| `orthologous_to` | GeneModel <-> GeneModel (anchor orthologs only; qualifier `homology_type`) | ensembl-compara |
| `mentions` | GramenePublication -> GeneModel / ExpressionExperiment / VariationStudy / GramenePopulation | ncbi-gene, rap-db, sorghumbase-curation, expression-atlas, ensembl-variation |
| `subclass_of`, `part_of` | ontology hierarchies (GO, PO, TO, ECO, InterPro, Reactome, taxon) | go, interpro, plant-reactome, gramene-kg |
| `has_part`, `part_of`, `gramene:has_sample_characteristic` | expression metadata: contrast -> assay group -> experiment / terms | expression-atlas, jgi-phytozome |
| `in_taxon`, `has_member` | GenomeAssembly -> GrameneTaxon; KgCollection -> GeneModel | ensembl-gene, sorghumbase |

## Provenance and how to cite

Each edge in kg_edges, kg_neighbors and kg_path has a `provenance` block. kg_evidence returns the full
block for one edge id.

- `primary_knowledge_source`: who asserted it, for example `infores:sorghum-qtl-atlas`. Cite this one.
- `knowledge_level`: `knowledge_assertion` (curated statement), `logical_entailment` (computed from
  coordinates or other facts, for example QTL containment), `statistical_association` (QTL -> trait),
  `prediction` (IEA GO, InterPro, Compara, LoF), `observation` (expression calls), `not_provided`.
- `agent_type`: `manual_agent`, `automated_agent`, `computational_model`, `data_analysis_pipeline`, `not_provided`.
- `publications`: the field exists but is empty for every edge in sorghum11. Literature is modelled as
  `mentions` edges from the publication node, so cite the PMID that is the subject of that edge.
- `has_evidence` (ECO) and `original_evidence` (for example `IEA`) on GO edges; `method` (analysis id,
  for example `gramene.analysis:qtl-containment@ae59d78`), `source_record`, and `knowledge_source_version`.
- `release` (`gramene.release:sorghum11`) on every edge, plus `build` at the top of the result.
  `provenance_context` gives the aggregators (`infores:gramene-kg`, `infores:sorghumbase`) and the
  ingest run once per result.

Cite an answer like this: "SORBI_3007G160200 lies inside QTL QPRCN7.1 (protein content)
[infores:sorghum-qtl-atlas, logical_entailment, data_analysis_pipeline; Gramene KG sorghum11, build
202611041048]". Separate curated facts (knowledge_assertion) from predictions and computed links.

## Negated edges

Organ-level `expressed_in` calls from `infores:sorghumbase` can be negated. A negated call means "not
expressed" (qualifier `expression_level: not_expressed`). kg_edges and kg_neighbors hide negated edges
unless you pass `include_negated: true`. The degree counts include negated edges. In walk 5, the degree is 13
but kg_edges returns 5 edges, because 8 of the 13 calls are negated. kg_path never uses negated edges.
Never report a negated edge as a positive finding.

## Ambiguity

- Sorghum v3 ids such as `Sobic.007G158500` are aliases of BTx623 v3 genes (`gramene.gene:SORBI_3007G158500`) and
  also the stable ids of T2T-CAS genes (`gramene.gene:Sobic.007G158500`, a different locus). Without a
  genome, kg_resolve returns them as `ambiguous` with both candidates. Pass `genome: "GCA_000003195.3"`
  to get the anchor gene. Do not pick a candidate yourself unless the user's context decides it.
- Gene symbols resolve across all species. `tb1` resolves to rice `gramene.gene:Os03g0706500` (FC1), and
  `CRTISO` is ambiguous between an InterPro entry and a rice gene, even though the sorghum gene
  `SORBI_3001G018000` is named CRTISO. Check `genome` on every resolved hit.
- Display names are not always aliases. kg_resolve returns `SbSSIII` as `unknown`, but kg_search finds
  it (`gramene.gene:SORBI_3006G221000`). For gene names, try kg_search with `category: "GeneModel"`.
- An ambiguous id in kg_node, kg_neighbors or kg_edges comes back as `status: "ambiguous"` with
  `candidates`. An unknown id comes back as `status: "not_found"` with advice. Both are normal results,
  not tool errors.

## Paging and limits

- kg_edges: `limit` up to 500 (default 50). Pass `next_cursor` back as `cursor` with exactly the same curie,
  predicate, direction, category, source, include_negated, genome and release; any other combination is
  rejected rather than silently skipping edges. A page may come back shorter than `limit`, with `truncated`,
  to stay under the result size limit: nothing is skipped, keep following `next_cursor`. `next_cursor: null`
  means there are no more edges. Use `degree` (per `predicate|direction`) to say "N of M" without paging.
- kg_neighbors: up to 10 predicates, up to 100 edges each. A block with more edges has `next_args`: call
  kg_edges with exactly those arguments (one predicate, its cursor) to continue.
- kg_path: at most 2 hops and 50 paths. Hub nodes are truncated, and a warning says so.
- kg_region: at most 5 Mb and 2000 features. It returns every feature that **overlaps** the window, so a
  gene that only partly overlaps is included. Items are sorted by start and paged with `next_offset`.
  `complete:false` / `total_is_lower_bound` means the window holds more than 2000 features and paging cannot
  reach the rest: split the window (`narrower_windows`) or pass `category:"GeneModel"`.
- kg_derived: homologs are paged with `limit`/`offset` (`next_offset`). Expression is paged by the tool.
- kg_resolve: up to 5000 ids per call. Inputs are trimmed and de-duplicated. A long list may come back in
  chunks with `truncated.next_offset`: call again with the same ids and `offset`.

## Which tool for which question

| question | tool |
|---|---|
| "what is X" for an id or alias you got from the user | kg_resolve, then kg_node |
| a gene name or free text ("starch synthase", "plant height QTL") | kg_search (`category`, `genome`, `source` filters) |
| what X links to, with counts | kg_neighbors (summary, plus predicates you name) |
| all links of one type, complete | kg_edges plus cursor |
| where a fact comes from | kg_evidence with the edge id |
| how A is connected to B | kg_path (1 to 2 hops) |
| what lies in chromosome window | kg_region (genome + region + start/end) |
| which predicates and classes exist, and how many | kg_schema |
| which release or build this is, sources and versions | kg_release (`detail: true` for every dataset and file) |
| expression values (TPM, log2FC), all homolog pairs | kg_derived (`layer: "expression"` or `"homologs"`) |
| what changed since the last build | kg_changes |

Resources: `kg://skill` (this file), `kg://sorghum11/schema`, `kg://sorghum11/manifest`,
`kg://sorghum11/node/<curie>`, `kg://evidence-map`.

## Worked walks (real calls and results, build 202611041048)

### 1. QTL -> genes -> trait
`kg_neighbors {curie:"gramene.qtl:QPRCN7.1", predicates:["overlaps","associated_with"]}`.
The node is "Protein content" on BTx623 v3 7:59441932-59533357, from the Sorghum QTL Atlas. The result has:
- `overlaps` in (4 edges): `SORBI_3007G160200`, `SORBI_3007G160300`, `SORBI_3007G160400`, `SORBI_3007G160501`. Each has
  `containment: full` and `[infores:sorghum-qtl-atlas; logical_entailment; data_analysis_pipeline]`, with
  method `gramene.analysis:qtl-containment@ae59d78`.
- `associated_with` out: `TO:0000598` (protein content) `[infores:sorghum-qtl-atlas; statistical_association; manual_agent]`.
`kg_region {genome:"GCA_000003195.3", region:"7", start:59441932, end:59533357, category:"GeneModel"}` returns 5 genes.
The extra gene is `SORBI_3007G160050` (59437391-59456374), which only partly overlaps the QTL, so it has no `overlaps` edge.

### 2. Gene -> publications
`kg_edges {curie:"gramene.gene:SORBI_3006G221000", predicate:"mentions", direction:"in"}` returns one edge,
`PMID:38602082 mentions SORBI_3006G221000` with qualifiers `{mention_source:"CSHL", statement:"starch synthases 3"}`
and `[infores:sorghumbase-curation; knowledge_assertion; manual_agent]`. `kg_node {curie:"PMID:38602082"}` gives the
title "Transcriptome-wide expression landscape and starch synthesis pathway co-expression network in
sorghum." and shows that it mentions 14 genes. Most gene -> publication links come from `infores:ncbi-gene` and `infores:rap-db`
(other species). For sorghum genes, the sorghumbase-curation edges are the curated ones.

### 3. Sample -> accession -> population -> publication
`kg_edges {curie:"gramene.sample:PI562982", direction:"out", predicate:["derives_from","member_of"]}` returns:
- `derives_from gramene.germplasm:ars.1457953` `[infores:sorghumbase; knowledge_assertion]`
- `member_of gramene.population:sorghum_bicolor.3` `[infores:ensembl-variation; knowledge_assertion]`

`kg_path {from:"gramene.sample:PI562982", to:"gramene.population:sorghum_bicolor.3"}` finds 2 paths: the direct
`member_of` edge, and a path through the accession (accession `member_of` population is `logical_entailment`, `infores:sorghumbase`).
`kg_neighbors {curie:"gramene.population:sorghum_bicolor.3", predicates:["mentions"], direction:"in"}` shows that the population is
"Lozano" with 977 members, and `PMID:33452486 mentions` it ("Comparative evolutionary genetics of deleterious load in
sorghum and maize") `[infores:ensembl-variation]`.

### 4. Gene -> predicted loss-of-function carriers
`kg_edges {curie:"gramene.gene:SORBI_3004G266300", predicate:"gramene:carries_predicted_lof_allele_of", direction:"in"}` returns:
- `gramene.sample:LBK_25M2-1211`, calls `[{consequence:"stop_gained", zygosity:"heterozygous", population:"gramene.population:sorghum_bicolor.4"}]`
- `gramene.sample:PI562982`, calls `[{consequence:"frameshift_variant", zygosity:"heterozygous", population:"gramene.population:sorghum_bicolor.3"}]`

Both are `[infores:ensembl-variation; prediction; computational_model]`. These are predictions from
VEP consequences. Population `sorghum_bicolor.9` (SGT) is excluded. To list the genes one sample
carries, query the sample with `direction:"out"`. PI562982 has 3280 such genes, so page through them.

### 5. Gene -> organ expression, including negated calls
`kg_edges {curie:"gramene.gene:SORBI_3003G249000", predicate:"expressed_in", direction:"out", source:"infores:sorghumbase"}`
returns 5 organs: root PO:0009005 (low, median TPM 2.35), shoot PO:0009006 (low, 1.52), flower PO:0009046
(medium, 5.5), anther/pollen PO:0009066 (low, 4), and pericarp PO:0009084 (low, 2). They are
`[infores:sorghumbase; observation; data_analysis_pipeline]`. The degree says `expressed_in|out: 13`.
With `include_negated: true` you also get 8 `negated: true` calls with `expression_level: not_expressed`:
endosperm, meristem, embryo, inflorescence, seed, leaf, vasculature, and stem (stem has median TPM 0.43
over 61 sample groups). For the per-experiment values, use
`kg_derived {gene:"SORBI_3003G249000", layer:"expression"}`, which returns 203 rows over 20 experiments,
including the JGI-SB-* experiments.

### 6. Variant -> gene -> QTL
`kg_node {curie:"dbsnp:rs5449093678"}` places it at BTx623 v3 9:56387196-56387198.
`kg_edges {curie:"dbsnp:rs5449093678", predicate:"is_sequence_variant_of", direction:"out"}` returns
`gramene.gene:SORBI_3009G220500` with qualifiers `{protein_truncating:true, protein_altering:true}` and
`[infores:eva; logical_entailment; data_analysis_pipeline]`.
`kg_edges {curie:"gramene.gene:SORBI_3009G220500", predicate:"overlaps", direction:"out"}` returns 53 QTLs (from the degree), for example
`gramene.qtl:QJYLD9.1`, `QTFWT9.1` and `QHGHT9.30`, all with `containment: full` and `infores:sorghum-qtl-atlas`. Page with the cursor
to get all 53. Then call kg_neighbors on each QTL with `associated_with` to get its trait. Make clear that variant -> gene -> QTL is
co-location only. It is not a genotype-phenotype association.

### Extras
- `kg_evidence {id:"gramene.assoc:4e440cd67c5c4cbf1269f8e3"}` returns the full provenance: `original_subject: "38602082"`,
  `source_record: "sorghum11.genes.xrefs[db=PUBMED]"`, `layer: "etl"`, `ingest_run`, and both end nodes with names.
- GO edges have evidence. For `SORBI_3006G221000 enables GO:2001070` the evidence is `original_evidence: "IEA"`, `has_evidence: ["ECO:0000501"]`,
  and `knowledge_source_version: "releases/2026-06-15"`.
- `kg_changes {}` compares build `202610291704` with `202611041048`: nodes +4 (KgDataset +2, KgDistribution +2), edges +0.
  Use `only_changed:false` for every class.

## Not answerable in increment 1

Say so plainly. Do not approximate these from other edges.
- **Phenotype observations on germplasm** (for example, "plant height of PI562982"). The graph has no trait values for accessions or samples.
- **Per-variant genotype calls for a sample** (for example, "which allele of rs5449093678 does PI562982 carry"). The graph only has the
  gene-level summary `carries_predicted_lof_allele_of`.
- **Genotype x phenotype associations** (GWAS hits, marker-trait associations). QTL -> trait edges are QTL-level
  statistical associations from QTL studies. Gene and variant links to QTLs are co-location only.
- **Expression values and homolog pairs as edges.** TPM, log2FC and p-values, and the full homology pair list (one2many,
  many2many, paralogs, non-anchor genomes), are only available through `kg_derived`. The graph has organ-level
  `expressed_in` calls, gene -> experiment `expression_detected_in`, and anchor `orthologous_to`.

## Pitfalls

1. **Non-anchor genes have no annotation edges.** Pan-genome genes, for example the T2T-CAS gene
   `gramene.gene:Sobic.007G158500`, have only `located_in` (genome), for some `member_of` (tree), and rarely `has_member` from a
   KgCollection. GO, InterPro, Reactome, QTL,
   expression, variants, LoF and literature are attached to the BTx623 v3 genes (`SORBI_*`) and to the anchor
   genes of other species. If a pan-genome gene shows nothing, go through its gene tree or orthologs to the anchor gene. Do not report "no function".
2. **`Sobic.*` ids are ambiguous**: use `kg_resolve` with `genome:"GCA_000003195.3"`. `kg_node`, `kg_edges`, `kg_path` and
   `kg_derived` return `status:"ambiguous"` with both candidates for a bare `Sobic.*`; pass `genome:"GCA_000003195.3"` to pick the
   BTx623 v3 gene. Any id resolved from a bare id or alias carries a warning and `resolved_from`: read them.
3. **rsIDs exist only on the anchor genome** (BTx623 v3). There are no variants on other sorghum assemblies.
4. **Variants are not in kg_search full text.** `kg_search {q:"rs5449093678"}` returns `total: 0`. The exact-id
   hit is only in `resolved`. Use `kg_node` or `kg_resolve` with the `dbsnp:` id, or kg_region with `category:"SequenceVariant"`.
   kg_edges on a genome node does not list its variants.
5. **Predicates: copy them as `degree` shows them.** A bare local name (`"has_domain"`) resolves to the release predicate
   with that name; a name the release does not use returns 0 edges plus a warning listing the valid predicates. Read the warnings.
6. **QTL containment and window overlap are different.** An `overlaps` edge means the gene lies fully inside the QTL. kg_region
   returns every feature that overlaps the window.
7. **Degree counts include negated edges.** Compare with `include_negated:true` before saying "N organs".
8. **Two QTL sources on different genomes**: sorghum QTLs come from `infores:sorghum-qtl-atlas` (5843, on BTx623 v3).
   `infores:gramene-qtldb` QTLs (7123) are rice QTLs, located on `insdc.gca:GCA_001433935.1`. So a sorghum gene's `overlaps`
   edges are always Atlas QTLs. Report the source with each QTL.
9. **`publications: []` does not mean "no literature".** Literature is in `mentions` edges.
10. **State the build.** Answers can change between builds, so say "release sorghum11, build <build>" using the build
    from the result, and check `kg_changes` when you compare with an earlier answer.
