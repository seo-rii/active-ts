import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryCacheAdapter, createCodecCacheAdapter } from '../src/index.js';
import { createRedisValkeyCacheAdapter } from '../src/adapters/cache/redis-valkey.js';
import { normalizeCacheWriteOptions } from '../src/core/cache-input.js';

test('memory, codec, and Redis batches reject invalid later input before any value or backend side effect', async () => {
	let calls = 0;
	const memory = new MemoryCacheAdapter();
	const codec = createCodecCacheAdapter(new MemoryCacheAdapter(), { name: 'probe', encode: value => { calls++; return value; }, decode: value => value });
	const redis = await createRedisValkeyCacheAdapter({ client: {
		mGet: async () => [], mSet: async () => { calls++; }, del: async () => { calls++; }, multi: () => { calls++; throw new Error('unexpected'); }
	} });
	for (const adapter of [memory, codec, redis]) {
		await assert.rejects(adapter.setMany([['valid', 1], [null as any, 2]]));
		await assert.rejects(adapter.setMany([['duplicate', 1], ['duplicate', 2]]), /duplicate key/);
		const options = Object.defineProperty({}, 'ttl', { enumerable: true, get() { calls++; return 1; } });
		await assert.rejects(adapter.setMany([['valid', 1]], options), /data property/);
	}
	assert.equal(calls, 0);
	assert.deepEqual(memory.snapshot(), {});
});

test('write option prototype checks do not depend on mutable array membership methods', () => {
	const options = Object.assign(Object.create({ inherited: true }), { ttl: 30 });
	const includes = Array.prototype.includes;
	try {
		Array.prototype.includes = () => true;
		assert.throws(() => normalizeCacheWriteOptions(options, 'cache options'), /plain object/);
	} finally { Array.prototype.includes = includes; }
});
