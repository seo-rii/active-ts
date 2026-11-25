import test from 'node:test';
import assert from 'node:assert/strict';
import {
	createActiveTs, createFunctionCache, getFunctionCacheDiagnostics, MemoryCacheAdapter, MemoryStoreAdapter
} from '../src/index.js';

test('failed distributed preflight does not poison valid caches sharing a logical key', async () => {
	const prefix = 'invalidation-preflight-shared-key';
	const backing = new MemoryCacheAdapter();
	let calls = 0;
	const valid = createFunctionCache({ prefix, cache: backing, memory: false, factory: () => `computed-${++calls}` });
	await valid.set(1, 'cached');
	const before = getFunctionCacheDiagnostics();
	const invalid = createFunctionCache({ prefix, cache: new MemoryCacheAdapter(), consistency: 'distributed', factory: () => 0 });
	for (let attempt = 0; attempt < 2; attempt++) {
		await assert.rejects(invalid.invalidate(1), /does not support versioned/);
		assert.equal(getFunctionCacheDiagnostics().pendingInvalidationKeys, before.pendingInvalidationKeys);
		assert.equal(getFunctionCacheDiagnostics().invalidationEpochs, before.invalidationEpochs);
		assert.equal(await valid.peek(1), 'cached');
	}
	await valid.invalidate(1);
	await valid.set(1, 'assigned');
	assert.equal(await valid.get(1), 'assigned');
	assert.equal(await valid.get(1), 'assigned');
	assert.equal(calls, 0);
	assert.equal(getFunctionCacheDiagnostics().pendingInvalidationKeys, before.pendingInvalidationKeys);
});

test('missing distributed adapter fails without retaining pending invalidation state', async () => {
	const before = getFunctionCacheDiagnostics();
	const invalid = createFunctionCache({ prefix: 'invalidation-preflight-no-adapter', cache: false,
		consistency: 'distributed', factory: () => 0 });
	await assert.rejects(invalid.invalidate(1), /requires a cache adapter/);
	assert.deepEqual(getFunctionCacheDiagnostics(), before);
});

test('hook failures still clear pending invalidations and allow recovery after a valid set', async () => {
	let failing = true;
	const backing = new MemoryCacheAdapter();
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() }, caches: { default: backing },
		plugins: [{ name: 'preflight-hook-failure', hooks: { beforeCacheInvalidate() { if (failing) throw undefined; } } }] });
	const cache = createFunctionCache({ prefix: 'invalidation-preflight-hook', context, memory: false, factory: () => 'computed' });
	await cache.set(1, 'old');
	const before = getFunctionCacheDiagnostics().pendingInvalidationKeys;
	await assert.rejects(cache.invalidate(1), error => error === undefined);
	assert.equal(getFunctionCacheDiagnostics().pendingInvalidationKeys, before);
	assert.equal(backing.stats.deleteMany, 0);
	await cache.set(1, 'new');
	assert.equal(await cache.peek(1), 'new');
	failing = false;
	await cache.invalidate(1);
	assert.equal(await cache.peek(1), undefined);
	assert.equal(backing.stats.deleteMany, 1);
	assert.equal(getFunctionCacheDiagnostics().pendingInvalidationKeys, before);
});

test('backend invalidation failures still clear pending state and permit successful retry', async () => {
	let failing = true;
	class FailingCache extends MemoryCacheAdapter {
		override async deleteMany(keys: string[]) {
			if (failing) throw 0;
			return await super.deleteMany(keys);
		}
	}
	const backing = new FailingCache();
	const cache = createFunctionCache({ prefix: 'invalidation-preflight-backend', cache: backing, memory: false,
		factory: () => 'computed' });
	await cache.set(1, 'old');
	const before = getFunctionCacheDiagnostics().pendingInvalidationKeys;
	await assert.rejects(cache.invalidate(1), error => error === 0);
	assert.equal(getFunctionCacheDiagnostics().pendingInvalidationKeys, before);
	failing = false;
	await cache.invalidate(1);
	await cache.set(1, 'new');
	assert.equal(await cache.peek(1), 'new');
	assert.equal(getFunctionCacheDiagnostics().pendingInvalidationKeys, before);
});
