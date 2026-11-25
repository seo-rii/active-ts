import test from 'node:test';
import assert from 'node:assert/strict';
import { createActiveTs, createFunctionCache, MemoryCacheAdapter, MemoryStoreAdapter } from '../src/index.js';

test('function caches resolve the configured default adapter for reads, writes and invalidation', async () => {
	const primary = new MemoryCacheAdapter();
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		caches: { primary }, defaultCache: 'primary'
	});
	let calls = 0;
	const cache = createFunctionCache({ prefix: 'configured-default', context, memory: false,
		factory: () => `computed-${++calls}` });
	assert.equal(await cache.get(1), 'computed-1');
	assert.equal(await cache.get(1), 'computed-1');
	assert.equal(calls, 1);
	await cache.set(1, 'assigned');
	assert.equal(await cache.peek(1), 'assigned');
	await cache.invalidate(1);
	assert.equal(await cache.peek(1), undefined);
	assert.equal(await cache.get(1), 'computed-2');
	assert.equal(primary.stats.setMany, 3);
});

test('explicit named and direct adapters override the configured default', async () => {
	const primary = new MemoryCacheAdapter(), secondary = new MemoryCacheAdapter(), direct = new MemoryCacheAdapter();
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() },
		caches: { primary, secondary }, defaultCache: 'primary' });
	for (const adapter of ['secondary', direct] as const) {
		const cache = createFunctionCache({ prefix: typeof adapter === 'string' ? 'explicit-named' : 'explicit-direct',
			context, cache: adapter, memory: false, factory: () => 'value' });
		await cache.set(1, 'explicit');
		assert.equal(await cache.get(1), 'explicit');
		await cache.invalidate(1);
	}
	assert.equal(primary.stats.getMany, 0);
	assert.equal(primary.stats.setMany, 0);
	assert.equal(primary.stats.deleteMany, 0);
	assert.equal(secondary.stats.setMany, 1);
	assert.equal(direct.stats.setMany, 1);
});

test('transaction-deferred cache tasks retain the configured default adapter', async () => {
	const primary = new MemoryCacheAdapter(), decoy = new MemoryCacheAdapter();
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() },
		caches: { primary, default: decoy }, defaultCache: 'primary' });
	const cache = createFunctionCache({ prefix: 'transaction-configured-default', context, memory: false,
		factory: () => 'computed' });
	await context.transaction(async () => {
		await cache.set(1, 'committed');
		assert.equal(primary.stats.setMany, 0);
		assert.equal(decoy.stats.setMany, 0);
	});
	assert.equal(await cache.peek(1), 'committed');
	assert.deepEqual(Object.values(primary.snapshot()).map(entry => entry.value), ['committed']);
	assert.equal(decoy.stats.setMany, 0);
	await assert.rejects(context.transaction(async () => {
		await cache.set(1, 'rolled back');
		throw new Error('rollback');
	}), /rollback/);
	assert.equal(await cache.peek(1), 'committed');
	await context.transaction(async () => {
		await cache.invalidate(1);
		assert.equal(primary.stats.deleteMany, 0);
	});
	assert.equal(await cache.peek(1), undefined);
	assert.equal(primary.stats.deleteMany, 1);
	assert.equal(decoy.stats.deleteMany, 0);
});

test('omitting the adapter still permits a context without registered caches', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	let calls = 0;
	const cache = createFunctionCache({ prefix: 'no-registered-cache', context, factory: () => ++calls });
	assert.equal(await cache.get(1), 1);
	assert.equal(await cache.get(1), 1);
	assert.equal(calls, 1);
});
