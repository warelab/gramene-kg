// Deterministic ids and hashes of the curated layer (docs/curation.md). Pure functions, no I/O: the API and the
// build (kg20) must compute the same values, so the build should import this file rather than re-implement it.
import crypto from 'node:crypto';

export const CURATION_SOURCE = 'infores:sorghumbase-curation';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// canonical JSON: object keys sorted at every level, arrays in order, undefined dropped (as JSON.stringify drops it)
export const canonical = (v) => v === null || typeof v !== 'object' ? JSON.stringify(v ?? null)
  : Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : `{${Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;

// sha256 of the canonical JSON of the semantic fields of an assertion revision
export const SEMANTIC = ['subject', 'predicate', 'object', 'qualifiers', 'negated', 'evidence', 'note', 'disputes'];
export const contentSha256 = (a) => sha(canonical(Object.fromEntries(SEMANTIC.map(k => [k, a[k] ?? null]))));

// Association node id: gramene.assoc:<sha256-24 of subject|predicate|object|assertion id>
export const associationId = (s, p, o, asn) => `gramene.assoc:${sha([s, p, o, asn].join('|')).slice(0, 24)}`;
// curated edge id: gramene.assoc:<sha256-24 of subject|predicate|object|infores:sorghumbase-curation|<qualifiers json>|<assertion id>>,
// <qualifiers json> = canonical JSON ({} when none). An assertion with an Association node uses the association id instead.
export const curatedEdgeId = (s, p, o, qualifiers, asn) => `gramene.assoc:${sha([s, p, o, CURATION_SOURCE, canonical(qualifiers ?? {}), asn].join('|')).slice(0, 24)}`;
export const edgeIdOf = (a) => a.association_id ?? curatedEdgeId(a.subject, a.predicate, a.object, a.qualifiers, a.id);
