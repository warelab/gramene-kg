// Vendored from /usr/local/gramene/ensembl-metadata/lib/swap.js (swapIn + loads ledger).
// Change: up to `parallel` insertMany batches in flight (the KG loads millions of docs).
// Docs go to "<name>_staging", get indexed and count-checked, then renamed over "<name>",
// so readers never see a partial collection; each load is recorded in the db's "loads".
const BATCH = 5000;

export async function swapIn(db, name, docs, { indexes = [], meta = {}, parallel = 4 } = {}) {
  const started = new Date();
  const staging = db.collection(`${name}_staging`);
  await staging.drop().catch(() => {});
  let batch = []; let inserted = 0; const inflight = new Set();
  const flush = async () => {
    if (!batch.length) return;
    const b = batch; batch = [];
    const p = staging.insertMany(b, { ordered: false }).then(() => { inserted += b.length; inflight.delete(p); });
    inflight.add(p);
    if (inflight.size >= parallel) await Promise.race(inflight);
  };
  for await (const doc of docs) { batch.push(doc); if (batch.length >= BATCH) await flush(); }
  await flush(); await Promise.all(inflight);
  if (!inserted) throw new Error(`${name}: no documents to load`);
  if (indexes.length) await staging.createIndexes(indexes.map((key) => ('key' in key ? key : { key })));
  const count = await staging.countDocuments();
  if (count !== inserted) throw new Error(`${name}: staging has ${count} docs, inserted ${inserted}`);
  await staging.rename(name, { dropTarget: true });
  await db.collection('loads').insertOne({ collection: name, status: 'ok', ...meta, count, started_at: started, finished_at: new Date() });
  return count;
}

export function lastLoad(db, name) {
  return db.collection('loads').findOne({ collection: name, status: 'ok' }, { sort: { finished_at: -1 } });
}
