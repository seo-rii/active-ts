import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreStoreAdapter } from '../src/adapters/store/firestore.js';
import { createDatastoreStoreAdapter } from '../src/adapters/store/datastore.js';
import type { ResolvedModelMeta } from '../src/index.js';
const meta: ResolvedModelMeta = { model: class {}, name: 'negative_aggregate', store: 'default', idField: 'id',
 readValidation: 'off', indexes: [], searchIndexes: [], relations: new Map(), hooks: {}, views: new Map(),
 policies: new Map(), scopes: new Map(), fieldCodecs: new Map(), fieldTypes: new Map([['score', 'number']]) };
for (const op of ['min', 'max'] as const) {
 for (const value of [null, 5]) {
  test(`Firestore ${op} reuses score != ${value}`, async () => {
   const filters: unknown[][] = [];
   const query = { where(...args: unknown[]) { filters.push(args); return this; }, orderBy() { return this; },
    limit() { return this; }, async get() { return { docs: [{ data: () => ({ id: 1, score: 7 }) }] }; } };
   const store = await createFirestoreStoreAdapter({ client: { collection: () => query, getAll: async () => [], runTransaction: async () => {} } });
   assert.deepEqual(await store.aggregate!(meta, { where: [{ field: 'score', op: '!=', value }], or: [], aggregates: [{ op, field: 'score', as: 'result' }] }), { result: 7 });
   assert.deepEqual(filters, [['score', '!=', value]]);
  });
 }
 test(`Datastore ${op} reuses a null inequality or requires an explicit safe scan`, async () => {
  let queries = 0; const filters: unknown[][] = [];
  const query = { filter(...args: unknown[]) { filters.push(args); return this; }, order() { return this; }, limit() { return this; }, select() { return this; } };
  let rows: Array<{ id: number; score: number | null }> = [{ id: 1, score: 7 }];
  const client = { KEY: Symbol('key'), key: (value: unknown) => value, get: async () => [undefined], save: async () => {}, update: async () => {}, delete: async () => {},
   createQuery() { queries++; return query; }, runQuery: async () => [rows, { moreResults: 'NO_MORE_RESULTS' }],
   createAggregationQuery: () => ({}), runAggregationQuery: async () => [[]] };
  const store = await createDatastoreStoreAdapter({ client });
  assert.deepEqual(await store.aggregate!(meta, { where: [{ field: 'score', op: '!=', value: null }], or: [], aggregates: [{ op, field: 'score', as: 'result' }] }), { result: 7 });
  assert.deepEqual(filters, [['score', '!=', null]]);
  const previousQueries = queries;
  await assert.rejects(store.aggregate!(meta, { where: [{ field: 'score', op: '!=', value: 5 }], or: [], aggregates: [{ op, field: 'score', as: 'result' }] }), /allowAggregateScanFallback/);
  assert.equal(queries, previousQueries);
  rows = [{ id: 1, score: null }, { id: 2, score: 5 }, { id: 3, score: 7 }];
  const fallback = await createDatastoreStoreAdapter({ client, allowAggregateScanFallback: true });
  assert.deepEqual(await fallback.aggregate!(meta, { where: [{ field: 'score', op: '!=', value: 5 }], or: [], aggregates: [{ op, field: 'score', as: 'result' }] }), { result: 7 });
 });
}
