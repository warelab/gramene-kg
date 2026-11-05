// Vendored from gramene-g2p packages/policy/src/index.ts (repo /usr/local/gramene/gramene-g2p,
// HEAD 47cfb19e668b4100af24b9549628aadfadbd9b5e; last commit touching the file a3002cde3dd53ae99daab0a7ac02fad1ef755942).
// Plain JS ESM copy: types stripped, logic unchanged. Do not edit here; change g2p and re-vendor.
// In gramene-kg the permission unit is the curation *workspace* (g2p's dataset): { _id, ownerUid, visibility, acls }.

/**
 * The single authoritative authorization module.
 *
 * Permission unit: dataset. Roles per (principal, dataset):
 *   owner > curator > contributor > reader.
 * Public datasets are readable without authentication.
 *
 * Every read query in the api MUST be filtered through `readableDatasetFilter`
 * and every write MUST go through `assertRole`. Do not hand-roll ACL checks
 * elsewhere.
 */

// Role = "owner" | "curator" | "contributor" | "reader"
const RANK = { reader: 0, contributor: 1, curator: 2, owner: 3 };

// Principal = { uid: string, orgs: string[] }
// AclEntry = { datasetId?: string, principal: { type: "user" | "org", id: string }, role: Role }
// Dataset = { _id: string, ownerUid: string, visibility: "private" | "public", acls: AclEntry[] }

export function highestRole(p, d) {
  if (p && d.ownerUid === p.uid) return "owner";
  let best = null;
  if (d.visibility === "public") best = "reader";
  if (!p) return best;
  for (const e of d.acls) {
    const matches =
      (e.principal.type === "user" && e.principal.id === p.uid) ||
      (e.principal.type === "org" && p.orgs.includes(e.principal.id));
    if (matches && (!best || RANK[e.role] > RANK[best])) best = e.role;
  }
  return best;
}

export function can(p, d, required) {
  const r = highestRole(p, d);
  return r !== null && RANK[r] >= RANK[required];
}

export function assertRole(p, d, required) {
  if (!can(p, d, required)) {
    const reason = !p ? "authentication required" : `requires ${required}`;
    throw Object.assign(new Error(reason), { statusCode: !p ? 401 : 403 });
  }
}

/**
 * Build a Mongo filter that returns only datasets the caller can read.
 * Combine with the rest of your query: `{ ...readableDatasetFilter(p), studyDbId }`.
 */
export function readableDatasetFilter(p) {
  const orClauses = [{ visibility: "public" }];
  if (p) {
    orClauses.push({ ownerUid: p.uid });
    orClauses.push({ "acls.principal": { type: "user", id: p.uid } });
    if (p.orgs.length) {
      orClauses.push({ "acls.principal": { $in: p.orgs.map((id) => ({ type: "org", id })) } });
    }
  }
  return { $or: orClauses };
}

// gramene-kg addition (not in g2p): the role names, lowest first
export const ROLES = Object.keys(RANK);
