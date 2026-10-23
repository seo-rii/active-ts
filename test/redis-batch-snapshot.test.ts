import test from 'node:test';
import assert from 'node:assert/strict';
import { createRedisValkeyCacheAdapter } from '../src/adapters/cache/redis-valkey.js';

for (const mode of ['lua', 'mset', 'ttl', 'versioned'] as const) {
 test(`Redis ${mode} snapshots all values before an asynchronous codec`, async () => {
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const writes: string[] = [];
  const client = {
   async mGet() { return []; }, async del() { return 0; },
   async mSet(values: Record<string, string>) { writes.push(...Object.values(values)); return 'OK'; },
   multi() { return { set(_key: string, value: string) { writes.push(value); return this; }, async exec() { return ['OK', 'OK']; } }; },
   ...(mode === 'lua' || mode === 'versioned' ? { async eval(_script: string, options: { arguments: string[] }) {
    writes.push(options.arguments[mode === 'versioned' ? 1 : 0]); return 1;
   } } : {})
  };
  const cache = await createRedisValkeyCacheAdapter({ client, codec: {
   name: 'snapshot-test', async encode(value) {
    if (value.sequence === 1) { entered(); await gate; }
    return JSON.stringify(value);
   }, decode: (value) => JSON.parse(value.toString())
  } });
  const second = { sequence: 2, nested: { value: 'original' } };
  const pending = mode === 'versioned'
   ? cache.setManyVersioned!([['first', { sequence: 1 }, 'v1'], ['second', second, 'v2']])
   : cache.setMany([['first', { sequence: 1 }], ['second', second]], mode === 'ttl' ? { ttl: 5 } : {});
  await started;
  let getters = 0;
  Object.defineProperty(second.nested, 'value', { enumerable: true, get() { getters++; return 'changed'; } });
  release(); await pending;
  assert.equal(getters, 0);
  assert.deepEqual(JSON.parse(writes[1]), { sequence: 2, nested: { value: 'original' } });
 });
}
