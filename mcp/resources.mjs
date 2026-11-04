// MCP resources for sites with kgBase: resources/list, resources/templates/list, resources/read.
//   kg://{release}/schema   kg://{release}/schema/{category}   kg://{release}/manifest   kg://{release}/node/{curie}
//   kg://skill (skills/gramene-kg/SKILL.md, env KG_SKILL_PATH)   kg://evidence-map (config/evidence-map.yaml, env KG_EVIDENCE_MAP_PATH)
// {curie} may be percent-encoded or raw (doi:10.1101/gr.227462.117 keeps its slash: everything after node/ is the CURIE).
// Errors carry a JSON-RPC code (.code): -32002 resource not found / not available, -32602 bad uri.
import fs from 'node:fs/promises';
import { kgGet, kgReleases, enc, manifestSummary, KgHttpError } from './kg-tools.mjs';

const KG_ROOT = '/usr/local/gramene/gramene-kg';
const skillPath = () => process.env.KG_SKILL_PATH || `${KG_ROOT}/skills/gramene-kg/SKILL.md`;
const evidencePath = () => process.env.KG_EVIDENCE_MAP_PATH || `${KG_ROOT}/config/evidence-map.yaml`;
const rpcErr = (code, msg, data) => Object.assign(new Error(msg), { code, data });
const JSON_MIME = 'application/json';

export async function kgResourceList(site) {
  const rel = site.kgRelease ?? (await kgReleases(site).catch(() => [])).find(r => r.is_current)?.id ?? 'current';
  return { resources: [
    { uri: 'kg://skill', name: 'gramene-kg skill', description: 'How to use the knowledge graph: id conventions, tool routing, pitfalls, what is not answerable, worked walks.', mimeType: 'text/markdown' },
    { uri: `kg://${rel}/schema`, name: `${rel} schema`, description: 'Node classes and relations with counts and sources.', mimeType: JSON_MIME },
    { uri: `kg://${rel}/manifest`, name: `${rel} manifest`, description: 'Build manifest: ingest run, software, analyses, every source dataset and file distribution (sha256).', mimeType: JSON_MIME },
    { uri: 'kg://evidence-map', name: 'evidence map', description: 'Provenance defaults per edge family and GO evidence code -> ECO mapping used by the build.', mimeType: 'application/yaml' },
  ] };
}

export function kgResourceTemplates() {
  return { resourceTemplates: [
    { uriTemplate: 'kg://{release}/schema', name: 'schema', description: 'Classes and relations of a release.', mimeType: JSON_MIME },
    { uriTemplate: 'kg://{release}/schema/{category}', name: 'class schema', description: 'One class (GeneModel) or Biolink category with its in/out relations.', mimeType: JSON_MIME },
    { uriTemplate: 'kg://{release}/manifest', name: 'manifest', description: 'Build manifest of a release.', mimeType: JSON_MIME },
    { uriTemplate: 'kg://{release}/node/{curie}', name: 'node', description: 'One node (CURIE, percent-encoded or raw) with degree and provenance.', mimeType: JSON_MIME },
  ] };
}

async function api(site, path, release) {
  try { return await kgGet(site, path, release ? { release } : {}); } catch (e) {
    if (e instanceof KgHttpError && e.status < 500) throw rpcErr(-32002, e.body.error ?? e.body.message ?? `HTTP ${e.status}`, { hint: e.body.hint ?? null, ...(e.body.candidates ? { candidates: e.body.candidates } : {}) });
    throw e;
  }
}
const jsonContent = (uri, r, data) => ({ contents: [{ uri, mimeType: JSON_MIME, text: JSON.stringify({ release: r.release, build: r.build, data, warnings: r.meta?.warnings ?? [] }, null, 2) }] });

export async function kgReadResource(site, uri) {
  if (typeof uri !== 'string' || !uri.startsWith('kg://')) throw rpcErr(-32602, `not a kg:// resource uri: ${uri}`);
  const rest = uri.slice(5);
  if (rest === 'skill' || rest === 'evidence-map') {
    const f = rest === 'skill' ? skillPath() : evidencePath();
    const text = await fs.readFile(f, 'utf8').catch(() => null);
    if (text === null) throw rpcErr(-32002, rest === 'skill' ? `kg://skill is not available yet: ${f} has not been written` : `kg://evidence-map not found at ${f}`, { uri, path: f });
    return { contents: [{ uri, mimeType: rest === 'skill' ? 'text/markdown' : 'application/yaml', text }] };
  }
  const m = /^([A-Za-z0-9_.-]+)\/(schema|manifest|node)(?:\/(.+))?$/.exec(rest);
  if (!m) throw rpcErr(-32002, `unknown kg resource ${uri}`, { templates: kgResourceTemplates().resourceTemplates.map(t => t.uriTemplate) });
  const [, release, kind, arg] = m;
  if (kind === 'schema') {
    const r = await api(site, arg ? `/schema/${enc(decodeURIComponent(arg))}` : '/schema', release);
    return jsonContent(uri, r, r.data);
  }
  if (kind === 'manifest') {
    if (arg) throw rpcErr(-32002, `unknown kg resource ${uri}`);
    const r = await api(site, `/releases/${enc(release)}/manifest`);
    return jsonContent(uri, r, manifestSummary(r.data, { detail: true }));
  }
  if (!arg) throw rpcErr(-32602, 'kg://{release}/node/{curie} needs a CURIE');
  let curie; try { curie = decodeURIComponent(arg); } catch { throw rpcErr(-32602, `bad percent-encoding in ${uri}`); }
  const r = await api(site, `/node/${enc(curie)}`, release);
  return jsonContent(uri, r, r.data);
}
