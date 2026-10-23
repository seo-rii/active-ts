import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatastoreStoreAdapter, datastoreReadOptions } from '../src/adapters/store/datastore.js';
import type { AggregateSpec, ResolvedModelMeta } from '../src/index.js';

const meta: ResolvedModelMeta = { model: class {}, name: 'aggregate_input_sets', store: 'default', idField: 'id',
 readValidation: 'off', indexes: [], searchIndexes: [], relations: new Map(), hooks: {}, views: new Map(), policies: new Map(),
 scopes: new Map(), fieldCodecs: new Map(), fieldTypes: new Map([['left', 'number'], ['right', 'number']]) };
const cases: Array<{ aggregates: AggregateSpec[]; expected: Record<string, number> }> = [
 { aggregates: [{ op: 'count', as: 'count' }, { op: 'sum', field: 'left', as: 'total' }], expected: { count: 3, total: 10 } },
 { aggregates: [{ op: 'sum', field: 'left', as: 'left' }, { op: 'avg', field: 'right', as: 'right' }], expected: { left: 10, right: 20 } }
];
for (const { aggregates, expected } of cases) {
 test(`Datastore preserves sparse input sets for ${aggregates.map(spec => spec.as).join(', ')}`, async () => {
  let nativeCalls = 0; const readOptions: unknown[] = [];
  const client = { KEY: Symbol('key'), key: (value: unknown) => value, get: async () => [undefined], save: async () => {},
   update: async () => {}, delete: async () => {}, createQuery: () => ({}),
   runQuery: async (_query: unknown, options: unknown) => { readOptions.push(options); return [[{ id: 1, left: 10 }, { id: 2, right: 20 }, { id: 3 }], { moreResults: 'NO_MORE_RESULTS' }]; },
   createAggregationQuery() { nativeCalls++; throw new Error('native query intersects aggregate inputs'); }, runAggregationQuery: async () => [[]]
  };
  const native = await createDatastoreStoreAdapter({ client });
  await assert.rejects(native.aggregate!(meta, { where: [], or: [], aggregates }), /preserve each aggregate input set/);
  assert.equal(nativeCalls, 0); assert.equal(readOptions.length, 0);
  const scan = await createDatastoreStoreAdapter({ client, allowAggregateScanFallback: true });
  const readTime = 1_753_000_000_000;
  assert.deepEqual(await scan.aggregate!(meta, { where: [], or: [], aggregates, meta: datastoreReadOptions({ readTime }).meta }), expected);
  assert.deepEqual(readOptions, [{ readTime }]); assert.equal(nativeCalls, 0);
 });
}

for (const op of ['sum', 'avg'] as const) {
 test(`Datastore ${op} scan ignores missing and null fields and rejects nonnumeric data`, async () => {
  let rows: Array<Record<string, unknown>> = [{ id: 1, left: 10 }, { id: 2 }, { id: 3, left: null }];
  const client = { KEY: Symbol('key'), key: (value: unknown) => value, get: async () => [undefined], save: async () => {},
   update: async () => {}, delete: async () => {}, createQuery: () => ({}),
   runQuery: async () => [rows, { moreResults: 'NO_MORE_RESULTS' }],
   createAggregationQuery() { throw new Error('explicit scan must not aggregate natively'); }, runAggregationQuery: async () => [[]]
  };
  const scan = await createDatastoreStoreAdapter({ client, allowAggregateScanFallback: true });
  const plan = { where: [], or: [], aggregates: [{ op, field: 'left', as: 'result' }] };
  assert.deepEqual(await scan.aggregate!(meta, plan), { result: 10 });
  rows = [{ id: 1, left: '10' }];
  await assert.rejects(scan.aggregate!(meta, plan), /number|numeric/);
 });
}
