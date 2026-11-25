import test from 'node:test';
import assert from 'node:assert/strict';
import { createActiveTs, defineModel, MemoryStoreAdapter, MemoryCacheAdapter, Model } from '../src/index.js';

class OwnershipRecord extends Model<{ id: number }> {}
defineModel<{ id: number }>({ name: 'bounded_ownership_record', cache: { ttl: 1 } }).id('id').attach(OwnershipRecord);

function setup(options: { cacheKeyOwnerLimit?: number; cacheKey?: ({ baseKey }: { baseKey: string }) => string } = {}) {
	const store = new MemoryStoreAdapter();
	const cache = new MemoryCacheAdapter();
	const context = createActiveTs({ stores: { default: store }, caches: { default: cache }, ...options });
	return { context, store, cache, Record: OwnershipRecord.use(context) as typeof OwnershipRecord };
}

test('built-in cache keys retain no ownership history for high-cardinality misses', async () => {
	const { context, Record } = setup({ cacheKeyOwnerLimit: 2 });
	await context.loadManyNow(Record, Array.from({ length: 512 }, (_, index) => index));
	assert.equal((context as any).cacheKeyOwners.size, 0);
	assert.equal((context as any).entityCacheKeys.size, 0);
});

test('custom cache key ownership has an explicit bound and retains existing collision guards', async () => {
	const { context, cache, Record } = setup({ cacheKey: ({ baseKey }) => baseKey, cacheKeyOwnerLimit: 2 });
	await Record.find(1).load();
	await Record.find(2).load();
	cache.clear();
	await Record.find(1).load();
	await assert.rejects(() => Record.find(3).load(), /cacheKeyOwnerLimit \(2\)/);
	assert.equal((context as any).cacheKeyOwners.size, 2);
	assert.equal((context as any).entityCacheKeys.size, 2);
	const collision = setup({ cacheKey: () => 'same', cacheKeyOwnerLimit: 2 });
	await collision.Record.find(1).load();
	await assert.rejects(() => collision.Record.find(2).load(), /already associated/);
});

test('rolled back ownership releases the custom resolver budget', async () => {
	const { context, store, Record } = setup({ cacheKey: ({ baseKey }) => baseKey, cacheKeyOwnerLimit: 1 });
	await assert.rejects(() => context.transaction(async (tx) => {
		await (OwnershipRecord.use(tx) as typeof OwnershipRecord).create({ id: 1 });
		throw new Error('rollback');
	}), /rollback/);
	await Record.create({ id: 2 });
	await assert.rejects(() => Record.find(3).load(), /cacheKeyOwnerLimit/);
	assert.deepEqual(store.dump('bounded_ownership_record'), [{ id: 2 }]);
});

test('cacheKeyOwnerLimit validates its complete numeric domain', () => {
	for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2', null]) {
		assert.throws(() => setup({ cacheKeyOwnerLimit: value as number }), /cacheKeyOwnerLimit must be a positive safe integer/);
	}
});
