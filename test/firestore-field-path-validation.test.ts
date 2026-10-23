import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreStoreAdapter } from '../src/adapters/store/firestore.js';
import { ActiveTsValidationError, type QueryPlan, type ResolvedModelMeta } from '../src/index.js';

const meta: ResolvedModelMeta = {
 model: class {}, name: 'firestore_fields', store: 'default', idField: 'id', readValidation: 'off',
 indexes: [], searchIndexes: [], relations: new Map(), hooks: {}, views: new Map(), policies: new Map(),
 scopes: new Map(), fieldCodecs: new Map(), fieldTypes: new Map()
};
const plan: QueryPlan = { where: [], or: [], sort: [] };
for (const reserved of ['*', '~', '/', '[', ']']) {
 test(`Firestore rejects ${reserved} field paths before reaching the SDK`, async () => {
  let calls = 0;
  const store = await createFirestoreStoreAdapter({ client: {
   collection() { calls++; throw new Error('SDK should not be called'); },
   async getAll() { calls++; return []; }, async runTransaction() { calls++; }
  } });
  const field = `profile.a${reserved}b`;
  for (const badPlan of [
   { ...plan, where: [{ field, op: '=' as const, value: 1 }] },
   { ...plan, select: [field] }, { ...plan, sort: [{ field, direction: 'asc' as const }] }
  ]) await assert.rejects(store.query(meta, badPlan), ActiveTsValidationError);
  await assert.rejects(store.aggregate!(meta, { where: [], or: [], aggregates: [{ op: 'min', field, as: 'result' }] }), ActiveTsValidationError);
  for (const data of [{ id: 1, [`a${reserved}b`]: 2 }, { id: 1, profile: [{ [`a${reserved}b`]: 2 }] }]) {
   await assert.rejects(store.create(meta, 1, data), ActiveTsValidationError);
   await assert.rejects(store.update(meta, 1, data), ActiveTsValidationError);
  }
  await assert.rejects(store.get({ ...meta, fieldTypes: new Map([[field, 'number']]) }, 1), ActiveTsValidationError);
  await assert.rejects(store.schema!.plan([{ ...meta, indexes: [{ name: 'bad_field', fields: [field] }] }]), ActiveTsValidationError);
  assert.equal(calls, 0);
 });
}

test('Firestore retains ordinary nested paths and stored data', async () => {
 const fields: string[] = []; const writes: unknown[] = [];
 const query = { where(field: string) { fields.push(field); return this; },
  async get() { return { docs: [] }; }, doc() { return { async create(data: unknown) { writes.push(data); } }; } };
 const store = await createFirestoreStoreAdapter({ client: { collection: () => query, getAll: async () => [], runTransaction: async () => {} } });
 const data = { id: 1, profile: { 'a-b': 2 }, items: [{ name: 'ok' }] };
 await store.create(meta, 1, data);
 await store.query(meta, { ...plan, where: [{ field: 'profile.a-b', op: '=', value: 2 }] });
 assert.deepEqual(writes, [data]);
 assert.deepEqual(fields, ['profile.a-b']);
});

test('Firestore transaction writes reject unsupported nested field names', async () => {
 let writes = 0;
 const transaction = { get: async () => {}, create: () => { writes++; }, set: () => { writes++; }, delete: () => {} };
 const store = await createFirestoreStoreAdapter({ client: { collection() { throw new Error('unexpected collection'); },
  getAll: async () => [], runTransaction: async (fn: (tx: unknown) => unknown) => fn(transaction) } });
 await store.transaction!(async tx => {
  await assert.rejects(tx.create(meta, 1, { id: 1, profile: { 'a*b': 2 } }), ActiveTsValidationError);
  await assert.rejects(tx.update(meta, 1, { id: 1, profile: { 'a*b': 2 } }), ActiveTsValidationError);
 });
 assert.equal(writes, 0);
});
