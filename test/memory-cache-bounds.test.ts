import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryCacheAdapter, createFunctionCache } from '../src/index.js';

test('memory adapter capacity is optional and configured eviction preserves recent entries', async () => {
	const cache = new MemoryCacheAdapter({ maxEntries: 2 });
	await cache.setMany([['a', 1], ['b', 2], ['c', 3]]);
	assert.deepEqual(await cache.getMany(['a', 'b', 'c']), [undefined, 2, 3]);
	const unlimited = new MemoryCacheAdapter();
	await unlimited.setMany(Array.from({ length: 100 }, (_, id) => [String(id), id]));
	assert.equal((await unlimited.getMany(['0']))[0], 0);
});

test('unrelated accesses gradually release expired adapter entries', async () => {
	const clock = Date.now;
	let now = clock();
	Date.now = () => now;
	try {
		const cache = new MemoryCacheAdapter({ sweepSize: 4 });
		await cache.setMany(Array.from({ length: 40 }, (_, id) => [`expired-${id}`, id]), { ttl: 1 });
		now += 2_000;
		for (let call = 0; call < 20; call++) await cache.getMany(['never-stored']);
		const retained = (cache as unknown as { entries: Map<string, unknown> }).entries.size;
		assert.equal(retained, 0);
	} finally { Date.now = clock; }
});

test('function cache sweeps never-read expired keys and keeps stale values within their refresh window', async () => {
	const clock = Date.now;
	let now = clock();
	Date.now = () => now;
	try {
		let calls = 0;
		const cache = createFunctionCache({ prefix: 'bounded-memory-expiry', cache: false, memory: { ttl: 1, sweepSize: 4 }, factory: async (id: number) => { calls++; return id; } });
		for (let id = 0; id < 40; id++) await cache.get(id);
		now += 2_000;
		for (let call = 0; call < 20; call++) await cache.peek(100);
		assert.equal(Object.keys(cache.snapshotMemory()).length, 0);
		assert.equal(calls, 40);
		const stale = createFunctionCache({ prefix: 'bounded-memory-stale', cache: false, memory: { ttl: 1, sweepSize: 4 }, staleWhileRevalidate: 10, factory: async (id: number) => id });
		await stale.get(1);
		now += 2_000;
		await stale.peek(2);
		assert.equal(Object.keys(stale.snapshotMemory()).length, 1);
		assert.equal(await stale.get(1), 1);
		await stale.get(1, { refresh: true });
	} finally { Date.now = clock; }
});

test('memory cache options reject malformed bounds without evaluating accessors', () => {
	for (const value of [0, -1, 1.5, Infinity]) {
		assert.throws(() => new MemoryCacheAdapter({ maxEntries: value }), /positive safe integer/);
		assert.throws(() => new MemoryCacheAdapter({ sweepSize: value }), /positive safe integer/);
	}
	let called = false;
	assert.throws(() => new MemoryCacheAdapter({ get sweepSize() { called = true; return 1; } }), /data property/);
	assert.equal(called, false);
	assert.throws(() => createFunctionCache({ prefix: 'invalid-sweep-size', factory: (input: number) => input, memory: { sweepSize: 0 } }), /positive safe integer/);
});
