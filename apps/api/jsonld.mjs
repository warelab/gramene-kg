// JSON-LD for GET /kg/v1/node/{curie} with Accept: application/ld+json, using the LinkML-generated context
// (schema/generated/jsonld/context.jsonld, served at /kg/v1/context.jsonld). The node is the REST node output:
// "id" (-> @id) is its CURIE, @type its Biolink categories plus its class (vocab-relative), attributes are
// flattened to top-level keys, so a key that is a LinkML slot takes the slot's IRI and any other key falls under
// the context's @vocab. A key that would be read as something else (a term for rdf:type, as InterPro's 'type'
// would be; a prefix or keyword alias; a CURIE-like key) is written as the absolute @vocab IRI instead.
// A second inline context fills only the prefixes the generated one leaves unresolved
// (http://example.org/UNKNOWN/...) or omits, from config/prefixes.yaml (local prefixes -> the KG node page);
// it disappears by itself once the LinkML schema declares those prefixes.
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
export const CONTEXT_FILE = path.join(ROOT, 'schema/generated/jsonld/context.jsonld');
export const contextDoc = fs.readFileSync(CONTEXT_FILE, 'utf8');
const terms = JSON.parse(contextDoc)['@context'];
const iriOf = (t) => typeof t === 'string' ? t : t?.['@id'];

export const overrides = (() => {
  const o = {};
  let px = {}; try { px = yaml.load(fs.readFileSync(path.join(ROOT, 'config/prefixes.yaml'), 'utf8')); } catch { return o; }
  const unresolved = (p) => { const i = iriOf(terms[p]); return !i || i.startsWith('http://example.org/UNKNOWN/'); };
  for (const p of Object.keys(px.local ?? {})) if (unresolved(p) && px.local_resolver?.endsWith('$1'))
    o[p] = { '@id': px.local_resolver.slice(0, -2) + encodeURIComponent(`${p}:`), '@prefix': true };
  for (const [p, v] of Object.entries(px.external ?? {})) if (unresolved(p) && v?.resolver?.endsWith('$1'))
    o[p] = { '@id': v.resolver.slice(0, -2), '@prefix': true };
  return o;
})();

const VOCAB = terms['@vocab'] ?? 'https://w3id.org/gramene/kg/';
const NOT_A_SLOT = (k) => k.includes(':') || Object.hasOwn(overrides, k) || typeof terms[k] === 'string' || (Object.hasOwn(terms, k) && iriOf(terms[k]) === 'rdf:type');
const FIXED = new Set(['id', 'category', 'name', 'description', 'aliases', 'xref', 'in_taxon', 'genome', 'gene_tree', 'region', 'start', 'end', 'strand', 'card', 'release', 'ingest_run']);
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && !(Array.isArray(v) && !v.length)));

// d = REST /node data (core.node().data); ctxUrl = absolute URL of the served context
export function nodeJsonLd(d, ctxUrl) {
  const attrs = Object.fromEntries(Object.entries(d.attributes ?? {}).filter(([k]) => !k.startsWith('@') && !FIXED.has(k))
    .map(([k, v]) => [NOT_A_SLOT(k) ? VOCAB + encodeURIComponent(k) : k, v]));
  const loc = d.location ?? {};
  return {
    '@context': Object.keys(overrides).length ? [ctxUrl, overrides] : ctxUrl,
    ...clean({ id: d.id, '@type': [...new Set([...(d.category ?? []), d.class && !(d.category ?? []).includes(`biolink:${d.class}`) ? d.class : null].filter(Boolean))], category: d.category, name: d.name, description: d.description,
      aliases: d.aliases, xref: d.xrefs, in_taxon: d.in_taxon, genome: d.genome, gene_tree: d.gene_tree,
      region: loc.region, start: loc.start, end: loc.end, strand: loc.strand }),
    ...attrs,
    ...clean({ card: d.card, release: d.provenance?.release, ingest_run: d.provenance?.ingest_run }),
  };
}
