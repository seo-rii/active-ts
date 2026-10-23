import test from 'node:test';
import assert from 'node:assert/strict';
import {
 inventoryDatastoreIds, createDatastoreIdRepairManifest, applyDatastoreIdRepairManifest,
 datastoreInt64Id, type DatastoreIdInventoryIssue
} from '../src/adapters/store/datastore.js';

const kind = 'native_inventory';
const keySymbol = Symbol('native-key');
const max = '9223372036854775807';
const numericId = (decimal: string) => Number.isSafeInteger(Number(decimal)) ? Number(decimal) : datastoreInt64Id(decimal);
const keyed = (id: unknown, decimal: string, storage: 'id' | 'name' = 'id') => Object.defineProperty({ id, body: 'preserved' }, keySymbol, {
 value: { kind, [storage]: decimal, parent: { kind: 'parent', id: max }, namespace: 'tenant' }
});
async function inventory(rows: unknown[]) {
 const issues: DatastoreIdInventoryIssue[] = [];
 const report = await inventoryDatastoreIds({ kind, namespace: 'tenant', client: {
  KEY: keySymbol, createQuery: () => ({ limit() { return this; } }),
  runQuery: async () => [rows, { moreResults: 'NO_MORE_RESULTS' }]
 }, onIssue: issue => { issues.push(issue); } });
 return { report, issues };
}

for (const decimal of ['-1', '-9223372036854775808', max]) {
 test(`Datastore inventory matches native ${decimal} and preserves ID type drift`, async () => {
  const { report, issues } = await inventory([
   keyed(numericId(decimal), decimal), keyed(decimal, decimal), keyed(numericId(decimal), decimal, 'name')
  ]);
  assert.equal(report.counts.match, 1);
  assert.equal(report.counts['type-mismatch'], 2);
  assert.equal(report.counts['unsupported-key'], 0);
  const payload = issues[1].payload;
  assert.ok('value' in payload);
  assert.equal(payload.type, decimal === '-1' ? 'number' : 'int64');
  assert.equal(payload.value, decimal === '-1' ? -1 : decimal);
  assert.deepEqual(JSON.parse(JSON.stringify(issues)), issues);
 });
 for (const storage of ['id', 'name'] as const) {
  for (const policy of ['key-wins', 'payload-wins'] as const) {
   test(`Datastore ${policy} repairs ${storage} ${decimal} with exact ancestor and leaf IDs`, async () => {
    const originalId = storage === 'id' ? decimal : numericId(decimal);
    const { report, issues } = await inventory([keyed(originalId, decimal, storage)]);
    const planned = createDatastoreIdRepairManifest({ report, issues, target: 'test-project', policy,
     excludeFromIndexes: [], ...(policy === 'payload-wins' ? { allowKeyMoves: true as const, descendantPolicy: 'verified-none' as const } : {}) });
    const manifest = JSON.parse(JSON.stringify(planned));
    const integers: string[] = [];
    const int = (value: string) => { integers.push(value); return { integer: value }; };
    const pathValue = (value: string) => Number.isSafeInteger(Number(value)) ? Number(value) : { integer: value };
    const source = { namespace: 'tenant', path: ['parent', { integer: max }, kind, storage === 'id' ? pathValue(decimal) : decimal] };
    const identity = (key: any) => JSON.stringify([key.namespace, key.path]);
    const rows = new Map([[identity(source), { id: originalId, body: 'preserved' }]]);
    let writes = 0;
    const client = {
     namespace: 'tenant', int, key: (options: unknown) => options,
     get: async (key: unknown) => [rows.get(identity(key))],
     transaction: () => ({ run: async () => {}, commit: async () => {}, rollback: async () => {},
      get: async (key: unknown) => [rows.get(identity(key))],
      update: async ({ key, data }: any) => { writes++; rows.set(identity(key), data); },
      insert: async ({ key, data }: any) => { writes++; rows.set(identity(key), data); },
      delete: async (key: unknown) => { rows.delete(identity(key)); }
     })
    };
    const result = await applyDatastoreIdRepairManifest({ client, manifest, target: 'test-project', confirm: manifest.digest });
    assert.equal(result.repaired, 1);
    assert.equal(rows.size, 1);
    assert.deepEqual(JSON.parse(JSON.stringify([...rows.values()])), [{ id: policy === 'key-wins' ? storage === 'id' ? numericId(decimal) : decimal : originalId, body: 'preserved' }]);
    assert.ok(integers.includes(max));
    if (decimal !== '-1' && (storage === 'id' || policy === 'payload-wins')) assert.ok(integers.includes(decimal));
    if (policy === 'key-wins') {
     const replay = await applyDatastoreIdRepairManifest({ client, manifest, target: 'test-project', confirm: manifest.digest });
     assert.equal(replay.alreadyRepaired, 1);
     assert.equal(writes, 1);
    } else {
     const targetStorage = storage === 'id' ? 'name' : 'id';
     const target = { namespace: 'tenant', path: ['parent', { integer: max }, kind, targetStorage === 'id' ? pathValue(decimal) : decimal] };
     assert.ok(rows.has(identity(target)));
    }
   });
  }
 }
}

test('Datastore inventory still rejects invalid numeric keys', async () => {
 for (const decimal of ['0', '-0', '01', '9223372036854775808', '-9223372036854775809']) {
  await assert.rejects(inventory([keyed('invalid', decimal)]));
 }
});

test('Datastore int64 repair fails before reads when the client lacks int support', async () => {
 const { report, issues } = await inventory([keyed(max, max)]);
 const manifest = createDatastoreIdRepairManifest({ report, issues, target: 'test-project', policy: 'key-wins', excludeFromIndexes: [] });
 let reads = 0;
 const client = { key: (value: unknown) => value, get: async () => { reads++; return []; }, transaction() { throw new Error('unexpected transaction'); } };
 await assert.rejects(applyDatastoreIdRepairManifest({ client, manifest, target: 'test-project', confirm: manifest.digest }), /client.int/);
 assert.equal(reads, 0);
});

test('Datastore repair detects changed int64 payloads during preflight', async () => {
 const { report, issues } = await inventory([keyed(datastoreInt64Id(max), max, 'name')]);
 const manifest = createDatastoreIdRepairManifest({ report, issues, target: 'test-project', policy: 'key-wins', excludeFromIndexes: [] });
 const client = { key: (value: unknown) => value, int: (value: string) => ({ integer: value }),
  get: async () => [{ id: datastoreInt64Id('-9223372036854775808') }], transaction() { throw new Error('unexpected transaction'); } };
 await assert.rejects(applyDatastoreIdRepairManifest({ client, manifest, target: 'test-project', confirm: manifest.digest }), /payload changed/);
});
