import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryCacheAdapter } from '../src/adapters/cache/memory.js';

test('invalid trailing keys reject the complete memory cache deletion batch without deleting valid prefixes', async () => {
	const cache = new MemoryCacheAdapter();
	await cache.setMany([['first', 1], ['second', 2]]);
	for (const invalid of [null, undefined, 1, '', 'bad\0key', 'x'.repeat(4097)]) {
		await assert.rejects(cache.deleteMany(['first', 'second', invalid] as string[]));
		assert.deepEqual(await cache.getMany(['first', 'second']), [1, 2]);
	}
	await cache.deleteMany(['first', 'first', 'second']);
	assert.deepEqual(await cache.getMany(['first', 'second']), [undefined, undefined]);
});
