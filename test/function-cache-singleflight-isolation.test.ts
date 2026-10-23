import test from 'node:test';
import assert from 'node:assert/strict';
import { createFunctionCache, type CacheAdapter } from '../src/index.js';

for (const persistent of [false, true]) {
 test(`singleflight isolates nested results from concurrent ${persistent ? 'persistent hits' : 'factory misses'}`, async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let calls = 0;
  const value = { nested: { text: 'stored' }, list: ['original'] };
  const adapter: CacheAdapter = {
   kind: 'blocked-hit',
   async getMany() { calls++; entered(); await gate; return [value]; },
   async setMany() {}, async deleteMany() {}
  };
  const cache = createFunctionCache<number, typeof value>({
   prefix: `singleflight-isolation-${persistent}`, cache: persistent ? adapter : false,
   factory: async () => { calls++; entered(); await gate; return value; }
  });
  const first = cache.get(1);
  const second = cache.get(1);
  await started;
  release();
  const [one, two] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.notEqual(one, two);
  assert.notEqual(one.nested, two.nested);
  one.nested.text = 'unsaved'; one.list.push('changed');
  assert.deepEqual(two, { nested: { text: 'stored' }, list: ['original'] });
  assert.deepEqual(await cache.get(1), two);
 });
}

test('singleflight refreshes still compute once and isolate concurrent results', async () => {
 let calls = 0;
 const original = { value: ['stored'] };
 const cache = createFunctionCache({ prefix: 'singleflight-refresh-isolation', cache: false,
  factory: async () => { calls++; return original; } });
 const [one, two] = await Promise.all([cache.get(1, { refresh: true }), cache.get(1, { refresh: true })]);
 assert.equal(calls, 1);
 one.value.push('changed');
 assert.deepEqual(two.value, ['stored']);
});
