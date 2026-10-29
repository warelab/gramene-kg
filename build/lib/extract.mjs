// kg10 extract: stream release stores and files into typed NDJSON under BUILD_OUT/extract/.
// Read-only. Genes are scanned per genome through the taxon_id+db_type+gene_idx index, a few genomes
// at a time. Only the 9 anchor genomes get their annotation xrefs / pathways / orthologs extracted.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { MongoClient } from 'mongodb';
import { env, loadReleaseConfig, buildOut, NdjsonWriter, pool, sha1Text, log } from './kgio.mjs';

const SRC_DB = env('SRC_DB');
const cfg = loadReleaseConfig();
const I = cfg.inputs;
const NO_VARIANTS = process.env.NO_VARIANTS === '1';
const only = process.env.KG_ONLY ? new Set(process.env.KG_ONLY.split(',')) : null;
const want = (k) => !only || only.has(k);
const X = (name) => buildOut('extract', `${name}.ndjson`);
const counts = {};

const client = await MongoClient.connect(env('MONGO_URI'), { maxPoolSize: 12 });
const src = client.db(SRC_DB);
const ont = client.db('ontology');

async function dumpCollection(name, coll, filter = {}, projection = undefined, map = (d) => d) {
  const w = new NdjsonWriter(X(name));
  for await (const d of coll.find(filter, { projection, batchSize: 5000 })) {
    const r = map(d); if (r) { const p = w.write(r); if (p) await p; }
  }
  counts[name] = await w.close();
  log(`${name}: ${counts[name]}`);
}

// ---- genomes ---------------------------------------------------------------------------------
const maps = await src.collection('maps').find({}, { projection: { regions: 0 } }).toArray();
const anchors = new Set(maps.filter(m => m.is_anchor).map(m => m.taxon_id));
if (anchors.size !== 9) log(`WARNING: expected 9 anchor genomes, found ${anchors.size}`);
if (want('maps')) {
  const w = new NdjsonWriter(X('maps'));
  for (const m of maps) await w.write({ map_id: m._id, core_db: m.db, taxon_id: m.taxon_id, anchor_taxon_id: m.anchor_taxon_id,
    system_name: m.system_name, display_name: m.display_name, is_anchor: !!m.is_anchor, in_compara: !!m.in_compara,
    length: m.length, num_genes: m.num_genes });
  counts.maps = await w.close();
}

// ---- genes -----------------------------------------------------------------------------------
if (want('genes')) {
  const wGenes = new NdjsonWriter(X('genes'));
  const wXref = new NdjsonWriter(X('gene_xref'));
  const wPath = new NdjsonWriter(X('gene_pathway'));
  const wO2O = new NdjsonWriter(X('gene_o2o'));
  const XDB = new Set(['GO', 'PO', 'TO', 'domains', 'PUBMED', 'Grassius']);
  const genomes = maps.map(m => m.taxon_id);
  const t0 = Date.now();
  let done = 0;
  await pool(genomes, 6, async (taxon) => {
    const isAnchor = anchors.has(taxon);
    const projection = { name: 1, description: 1, biotype: 1, taxon_id: 1, system_name: 1, db_type: 1, location: 1, alt_id: 1, synonyms: 1,
      'homology.gene_tree.id': 1, 'homology.gene_tree.root_taxon_id': 1, 'homology.gene_tree.representative': 1 };
    if (isAnchor) Object.assign(projection, { xrefs: 1, 'annotations.pathways.entries.id': 1, 'homology.homologous_genes.ortholog_one2one': 1 });
    const cur = src.collection('genes').find({ taxon_id: taxon }, { projection, batchSize: 5000 });
    for await (const g of cur) {
      const t = g.homology?.gene_tree; const rep = t?.representative ?? {};
      let p = wGenes.write({ id: g._id, name: g.name ?? null, description: g.description ?? null, biotype: g.biotype ?? null,
        taxon_id: g.taxon_id, system_name: g.system_name, db_type: g.db_type ?? null,
        map: g.location?.map ?? null, region: g.location?.region ?? null, start: g.location?.start ?? null, end: g.location?.end ?? null,
        strand: g.location?.strand ?? null, alt_id: g.alt_id ?? [], synonyms: g.synonyms ?? [],
        tree: t?.id ?? null, tree_root_taxon_id: t?.root_taxon_id ?? null,
        rep_closest: rep.closest?.id ?? null, rep_closest_pid: rep.closest?.percent_identity ?? null,
        rep_model: rep.model?.id ?? null, rep_model_pid: rep.model?.percent_identity ?? null, anchor: isAnchor });
      if (p) await p;
      if (!isAnchor) continue;
      for (const x of g.xrefs ?? []) {
        if (!XDB.has(x.db)) continue;
        for (const v of x.ids ?? []) {
          const [id, ec] = Array.isArray(v) ? v : [v, null];
          p = wXref.write({ gene: g._id, db: x.db, id: String(id), ec: ec ?? null, source: x.source ?? null, text: x.text ?? null });
          if (p) await p;
        }
      }
      for (const e of g.annotations?.pathways?.entries ?? []) { p = wPath.write({ gene: g._id, id: e.id }); if (p) await p; }
      for (const o of g.homology?.homologous_genes?.ortholog_one2one ?? []) { p = wO2O.write({ gene: g._id, other: o }); if (p) await p; }
    }
    done++;
    if (done % 10 === 0) log(`genes: ${done}/${genomes.length} genomes, ${wGenes.n} genes, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  });
  counts.genes = await wGenes.close(); counts.gene_xref = await wXref.close();
  counts.gene_pathway = await wPath.close(); counts.gene_o2o = await wO2O.close();
  log(`genes ${counts.genes}, anchor xrefs ${counts.gene_xref}, pathways ${counts.gene_pathway}, o2o ${counts.gene_o2o}`);
}

// ---- gene trees: walk nested children for the leaf set ----------------------------------------
if (want('trees')) {
  const w = new NdjsonWriter(X('trees'));
  const leaves = (n, out) => { if (n.gene_stable_id) out.push(n.gene_stable_id); for (const c of n.children ?? []) leaves(c, out); return out; };
  for await (const t of src.collection('genetree').find({}, { batchSize: 200, projection: { 'children.children.children.sequence': 0 } })) {
    const l = leaves(t, []).sort();
    const p = w.write({ id: t._id, compara_db: t.compara_db ?? null, root_taxon_id: t.taxon_id ?? null, root_taxon_name: t.taxon_name ?? null,
      node_type: t.node_type ?? null, representative: t.representative?.id ?? null, n_leaves: l.length, leafset_sha1: sha1Text(l.join(',')) });
    if (p) await p;
  }
  counts.trees = await w.close(); log(`trees: ${counts.trees}`);
}

// ---- small release collections ----------------------------------------------------------------
if (want('taxonomy')) await dumpCollection('taxonomy', src.collection('taxonomy'), {}, { _id: 1, name: 1, rank: 1, is_a: 1, synonym: 1 },
  d => ({ taxon_id: d._id, name: d.name, rank: d.rank, parent: (d.is_a ?? [])[0] ?? null }));
if (want('qtls')) await dumpCollection('qtls', src.collection('qtls'), {}, undefined,
  d => ({ id: d._id, map: d.location.map, region: d.location.region, start: d.location.start, end: d.location.end,
    source: d.source, description: d.description ?? null, terms: [...new Set(d.terms ?? [])] }));
if (want('germplasm')) await dumpCollection('germplasm', src.collection('germplasm'), {}, undefined,
  d => ({ doc_id: d._id, ens_id: d.ens_id ?? null, pop_id: d.pop_id ?? null, pub_id: d.pub_id ?? null,
    germplasm_dbid: d.germplasm_dbid ?? null, stock_center: d.stock_center ?? null }));
if (want('experiments')) await dumpCollection('experiments', src.collection('experiments'), {}, undefined,
  d => ({ id: d._id, name: d.name ?? null, description: d.description ?? null, type: d.type ?? null, source: d.source ?? null,
    taxon_id: d.taxon_id ?? null, factors: d.factors ?? [], pi: d.jgi?.pi ?? null, annotation: d.jgi?.annotation ?? null }));
if (want('assays')) {
  const wA = new NdjsonWriter(X('assays')); const wT = new NdjsonWriter(X('assay_terms'));
  for await (const a of src.collection('assays').find({}, { batchSize: 5000 })) {
    await wA.write({ id: a._id, experiment: a.experiment, group: a.group, taxon_id: a.taxon_id ?? null,
      sra_runs: a.jgi?.sra_runs ?? [], sra_studies: a.jgi?.sra_studies ?? [], n_replicates: a.jgi?.n_replicates ?? null,
      label: [...(a.factor ?? [])].map(f => f.label).filter(Boolean).join(', ') || null });
    const seen = new Set();
    for (const kind of ['factor', 'characteristic']) for (const c of a[kind] ?? []) {
      if (!c.id) continue;
      const key = `${c.type}|${c.id}`; if (seen.has(key)) continue; seen.add(key);
      const p = wT.write({ assay: a._id, kind, type: c.type, label: c.label ?? null, term: c.id }); if (p) await p;
    }
  }
  counts.assays = await wA.close(); counts.assay_terms = await wT.close(); log(`assays ${counts.assays}, assay terms ${counts.assay_terms}`);
}

// ---- shared ontology db: node sets ------------------------------------------------------------
const termMap = (d) => ({ id: d._id, name: d.name ?? null, namespace: d.namespace ?? null, def: d.def ?? null,
  synonyms: (d.synonyms ?? []).map(s => s.name ?? s), alt_ids: d.alt_ids ?? [], obsolete: !!d.obsolete,
  replaced_by: d.replaced_by ?? null, parents: (d.parents ?? []).map(p => ({ id: p.id, rel: p.rel })) });
for (const o of ['go', 'po', 'to', 'eco']) if (want(o)) await dumpCollection(`ont_${o}`, ont.collection(o), {}, undefined, termMap);
if (want('interpro')) await dumpCollection('ont_interpro', ont.collection('interpro'), {}, undefined,
  d => ({ id: d._id, name: d.name ?? null, short_name: d.short_name ?? null, type: d.type ?? null, parent: d.parent ?? null, go: d.go ?? [] }));
if (want('reactome')) {
  const taxids = [...new Set(maps.filter(m => m.is_anchor).map(m => m.anchor_taxon_id))];
  await dumpCollection('ont_reactome', ont.collection('plant_reactome'), {}, undefined,
    d => ({ id: d._id, base_id: d.base_id ?? null, name: d.name ?? null, species: d.species ?? null, taxid: d.taxid ?? null, parents: d.parents ?? [] }));
  await dumpCollection('ont_reactome_genes', ont.collection('plant_reactome_genes'), { taxid: { $in: taxids } }, undefined,
    d => ({ gene: d.gene_id, pathway: d.pathway, source: d.source ?? null, evidence: d.evidence ?? null, taxid: d.taxid }));
  // release pathways: lineage per species taxon gives reaction -> parent pathways
  // per-anchor lineage paths ([[root, ..., event]]) keyed by release taxon id: the only source of
  // reaction -> parent pathway links for events that the shared ontology db does not carry
  const anchorTaxa = maps.filter(m => m.is_anchor).map(m => m.taxon_id);
  await dumpCollection('pathways', src.collection('pathways'), {}, undefined,
    d => ({ base_id: String(d._id), name: d.name ?? null, type: d.type ?? null,
      lineages: anchorTaxa.flatMap(t => (d[`lineage_${t}`] ?? []).map(path => ({ taxon: t, path: path.map(String) }))) }));
}
if (want('ncbi_taxonomy')) {
  const ids = (await src.collection('taxonomy').distinct('_id', { rank: { $ne: 'genome' } }));
  await dumpCollection('ont_ncbi_taxonomy', ont.collection('ncbi_taxonomy'), { _id: { $in: ids } }, { _id: 1, name: 1, rank: 1, parent: 1 },
    d => ({ taxon_id: d._id, name: d.name, rank: d.rank, parent: d.parent ?? null }));
  await dumpCollection('ont_ncbi_merged', ont.collection('ncbi_taxonomy_merged'), { _id: { $in: ids } }, undefined,
    d => ({ taxon_id: d._id, merged_into: d.merged_into ?? null }));
}

// ---- user collections: public gene lists / saved views + Solr membership ------------------------
if (want('collections')) {
  const ud = client.db('userData1');
  const lists = await ud.collection('genelists').find({ isPublic: true, deletedAt: { $exists: false } }).toArray();
  const views = await ud.collection('savedviews').find({ isPublic: true, deletedAt: { $exists: false } }).toArray();
  const wc = new NdjsonWriter(X('collections')); const wm = new NdjsonWriter(X('collection_members'));
  const solr = env('SOLR_URL');
  for (const l of lists) {
    await wc.write({ id: String(l.hash), kind: 'gene_list', label: l.label || null, n_genes: l.n_genes ?? null, owner: l.owner ?? null,
      uid: l.uid ?? null, site: l.site ?? null, created_at: l.createdAt?.toISOString?.() ?? null, definition: null });
    const r = await fetch(`${solr}/${cfg.genes_core}/select?q=saved_search:${encodeURIComponent(l.hash)}&fl=id&rows=10000&wt=json`);
    const ids = r.ok ? (await r.json()).response.docs.map(d => d.id) : [];
    for (const id of ids) await wm.write({ collection: String(l.hash), gene: id, source: 'solr' });
  }
  for (const v of views) await wc.write({ id: String(v.hash), kind: 'saved_view', label: v.label || null, n_genes: null, owner: v.owner ?? null,
    uid: v.uid ?? null, site: v.site ?? null, created_at: v.createdAt?.toISOString?.() ?? null, description: v.description ?? null,
    definition: JSON.stringify(v.state?.filters ?? null) });
  counts.collections = await wc.close(); counts.collection_members = await wm.close();
  log(`collections ${counts.collections}, members ${counts.collection_members}`);
}
// ---- expression organ calls (anchor genes; level per organ from the expression_attributes pipeline) ----
if (!NO_VARIANTS && want('organ_expression')) {
  const w = new NdjsonWriter(X('organ_expression')); const wg = new NdjsonWriter(X('gene_expression_profile'));
  for await (const d of src.collection('expression_attributes').find({}, { projection: { per_organ: 1, breadth: 1, tau: 1, max_tpm: 1, peak_organs: 1, n_organs_detected: 1, n_organs_with_data: 1 }, batchSize: 5000 })) {
    for (const [organ, c] of Object.entries(d.per_organ ?? {})) {
      if (!c || c.level === 'no_data') continue;
      const p = w.write({ gene: d._id, organ, level: c.level, tpm: c.tpm ?? null, n_samples: c.n_samples ?? null }); if (p) await p;
    }
    const p = wg.write({ gene: d._id, breadth: d.breadth ?? null, tau: d.tau ?? null, max_tpm: d.max_tpm ?? null, peak_organs: d.peak_organs ?? [],
      n_organs_detected: d.n_organs_detected ?? null, n_organs_with_data: d.n_organs_with_data ?? null }); if (p) await p;
  }
  counts.organ_expression = await w.close(); counts.gene_expression_profile = await wg.close();
  log(`organ expression calls ${counts.organ_expression} (no_data dropped), gene profiles ${counts.gene_expression_profile}`);
}
await client.close();

// ---- files -----------------------------------------------------------------------------------
// ---- gene -> experiment (expression detected) from the genes core: same rule the site uses
// (mongo2solr.join.js: any baseline group >= 0.5, or any contrast with p < 0.05 and |log2fc| >= 1)
if (!NO_VARIANTS && want('expression_detected')) {
  const w = new NdjsonWriter(X('expression_detected')); const solr = env('SOLR_URL'); let cursor = '*';
  for (;;) {
    const u = `${solr}/${cfg.genes_core}/select?q=*:*&fq=expressed_in_gxa_attr_ss:*&fl=id,expressed_in_gxa_attr_ss&sort=id%20asc&rows=10000&wt=json&cursorMark=${encodeURIComponent(cursor)}`;
    const r = await fetch(u); if (!r.ok) throw new Error(`solr ${r.status} reading expressed_in_gxa_attr_ss`);
    const j = await r.json();
    for (const d of j.response.docs) for (const e of d.expressed_in_gxa_attr_ss ?? []) { const p = w.write({ gene: d.id, experiment: e }); if (p) await p; }
    if (j.nextCursorMark === cursor) break; cursor = j.nextCursorMark;
  }
  counts.expression_detected = await w.close(); log(`expression detected pairs ${counts.expression_detected}`);
}
// ---- rsIDs: VCF records for the rsIDs windowed onto anchor genes (one line per biallelic split) ----
if (!NO_VARIANTS && want('variants')) {
  const ids = new Set();
  const rl = readline.createInterface({ input: fs.createReadStream(I.rsid_table), crlfDelay: Infinity });
  for await (const line of rl) { const c = line.split('\t'); for (const r of (c[2] ?? '').split(',')) if (r) ids.add(r); }
  const idFile = buildOut('work', 'rsids.txt'); fs.writeFileSync(idFile, [...ids].join('\n') + '\n');
  log(`rsIDs in ${path.basename(I.rsid_table)}: ${ids.size}`);
  const out = fs.createWriteStream(X('rsid_vcf').replace(/\.ndjson$/, '.tsv'));
  const bc = spawn(process.env.BCFTOOLS || 'bcftools', ['query', '-i', `ID=@${idFile}`, '-f', '%ID\t%CHROM\t%POS\t%REF\t%ALT\t%INFO/VC\t%INFO/SID\n', I.rsid_vcf]);
  bc.stdout.pipe(out); let err = ''; bc.stderr.on('data', (b) => { err += b; });
  const code = await new Promise((res) => bc.on('close', res)); await new Promise((res) => out.end(res));
  if (code !== 0) throw new Error(`bcftools exited ${code}: ${err.slice(0, 400)}`);
  counts.rsid_vcf_lines = Number((await new Promise((res) => { let n = 0; fs.createReadStream(X('rsid_vcf').replace(/\.ndjson$/, '.tsv')).on('data', (b) => { for (const x of b) if (x === 10) n++; }).on('end', () => res(n)); })));
  counts.rsid_ids = ids.size; log(`rsid VCF lines ${counts.rsid_vcf_lines}`);
}

if (want('idf')) {
  const w = new NdjsonWriter(X('idf'));
  for (const f of fs.readdirSync(I.atlas_dir).filter(f => f.endsWith('.idf.txt')).sort()) {
    const lines = fs.readFileSync(path.join(I.atlas_dir, f), 'utf8').split(/\r?\n/);
    const field = (k) => (lines.find(l => l.startsWith(k + '\t')) ?? '').split('\t').slice(1).map(s => s.trim()).filter(Boolean);
    await w.write({ experiment: f.replace(/\.idf\.txt$/, ''), title: field('Investigation Title')[0] ?? null,
      pub_titles: field('Publication Title'), pmids: field('PubMed ID'), dois: field('Publication DOI'),
      release_date: field('Public Release Date')[0] ?? null });
  }
  counts.idf = await w.close();
}
if (want('contrasts')) {
  const exps = new Set(fs.readFileSync(X('experiments'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => e.type === 'Differential').map(e => e.id));
  const w = new NdjsonWriter(X('contrasts')); const seen = new Set();
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(I.atlas_dir, 'contrastdetails.tsv')), crlfDelay: Infinity });
  for await (const line of rl) {
    const [exp, contrast] = line.split('\t');
    if (!exps.has(exp) || seen.has(exp + '.' + contrast)) continue;
    seen.add(exp + '.' + contrast);
    // GXA contrast ids are <reference>_<test> (verified: E-CURD-148 g5_g1, g5 = mock control)
    const [ref, test] = contrast.split('_');
    await w.write({ id: `${exp}.${contrast}`, experiment: exp, reference_group: `${exp}.${ref}`, test_group: `${exp}.${test}` });
  }
  counts.contrasts = await w.close();
}
if (want('grassius')) {
  const w = new NdjsonWriter(X('grassius'));
  for (const line of fs.readFileSync(I.grassius_tsv, 'utf8').split('\n')) {
    const [gene, gname, family] = line.split('\t'); if (gene && family) await w.write({ gene, family: family.trim(), gene_name: gname || null, method: 'direct' });
  }
  const proj = path.join(cfg.release_root, 'gramene-solr/genes/grassius_homolog_attrib_table.txt');
  if (fs.existsSync(proj)) {
    const rl = readline.createInterface({ input: fs.createReadStream(proj), crlfDelay: Infinity }); let first = true;
    for await (const line of rl) { if (first) { first = false; continue; }
      const [gene, , fams] = line.split('\t'); for (const f of (fams ?? '').split(',').filter(Boolean)) await w.write({ gene, family: f.trim(), gene_name: null, method: 'tree_projection' }); }
  }
  counts.grassius = await w.close();
}
if (want('grin')) {
  const w = new NdjsonWriter(X('grin'));
  for (const g of JSON.parse(fs.readFileSync(I.grin_export, 'utf8'))) await w.write({ germplasm_dbid: g.germplasmDbId, name: g.germplasmName ?? null,
    accession_number: g.accessionNumber ?? null, country: g.countryOfOriginCode ?? null, institute: g.instituteName ?? null,
    subtaxa: g.subtaxa ?? null, pedigree: g.pedigree ?? null });
  counts.grin = await w.close();
}
fs.writeFileSync(buildOut('extract', 'counts.json'), JSON.stringify({ ...JSON.parse(fs.existsSync(buildOut('extract', 'counts.json')) ? fs.readFileSync(buildOut('extract', 'counts.json'), 'utf8') : '{}'), ...counts }, null, 1));
log('extract complete', JSON.stringify(counts));
