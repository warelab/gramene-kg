// The curation write client: a MongoClient of its own, bound to ONE db (kg_curation, or a throwaway
// kg_curation_test* / kg_curation_fixture* db for tests). The wrapper is the only handle the API gets: it
// exposes collections of that db and refuses any other db name; the raw client never leaves this module.
import { MongoClient } from 'mongodb';

export const CURATION_DB_RE = /^kg_curation(_(test|fixture)[A-Za-z0-9_]*)?$/;
export const curationDbName = (name = process.env.KG_CURATION_DB || 'kg_curation') => {
  if (!CURATION_DB_RE.test(name)) throw new Error(`curation db must be kg_curation or kg_curation_test*/kg_curation_fixture*, not '${name}'`);
  return name;
};

// keys, or [keys, options]. The read side's overlay queries each have one (docs/api.md "Mongo"): by subject/object,
// assertion id, edge id, {latest, state, updated_at} (changes since a build), supersedes (partial on latest:true).
// curated_nodes are per workspace (_id "<ws>|<curie>"): unique {curie, workspace}; listing {workspace, curie}.
export const INDEXES = {
  assertions: [{ id: 1, rev: -1 }, { workspace: 1, latest: 1, state: 1 }, { subject: 1 }, { object: 1 }, { edge_id: 1 },
    { latest: 1, state: 1, updated_at: 1 }, [{ supersedes: 1 }, { name: 'supersedes_latest', partialFilterExpression: { latest: true } }]],
  review_events: [{ assertion: 1, at: 1 }],
  curated_nodes: [[{ curie: 1, workspace: 1 }, { unique: true }], { workspace: 1, curie: 1 }, { assertion: 1 }],
};

// wrap(client, name): the bound handle. db(other) throws unless other === name.
export function wrap(client, name) {
  curationDbName(name);
  const db = client.db(name);
  const collection = (c) => {
    const coll = db.collection(c);
    if (coll.dbName !== name) throw new Error(`write client: collection ${c} is in ${coll.dbName}, not ${name}`);
    return coll;
  };
  const self = Object.freeze({
    name, collection,
    db: (other) => { if (other !== name) throw new Error(`write client is bound to ${name}; refusing db '${other}'`); return self; },
    // startup self-check: the server reports the bound db, and indexes exist (createIndex is idempotent)
    async selfCheck() {
      const st = await db.command({ dbStats: 1 });
      if (st.db !== name) throw new Error(`write client self-check: dbStats names '${st.db}', expected '${name}'`);
      for (const [c, keys] of Object.entries(INDEXES)) for (const k of keys) await collection(c).createIndex(...(Array.isArray(k) ? k : [k]));
      return { db: st.db, collections: st.collections };
    },
    close: () => client.close(),
  });
  return self;
}

export async function connectCurationDb(url = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017', name = curationDbName()) {
  curationDbName(name);                             // refuse before connecting
  const client = await MongoClient.connect(url, { maxPoolSize: 5 });
  return wrap(client, name);
}
