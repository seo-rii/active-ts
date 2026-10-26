import test from 'node:test';
import assert from 'node:assert/strict';
import { createFunctionCache } from '../src/core/function-cache.js';
import type { CacheAdapter } from '../src/core/types.js';

for (const refresh of [false, true]) test(`distributed function cache heals failed invalidation with a new fence (refresh=${refresh})`, async () => {
	let stored: unknown = 'old', version = 1, outage = true, reads = 0, writes = 0, invalidations = 0, factories = 0;
	const cache: CacheAdapter = {
		kind: 'recovery-probe',
		async getMany() { return [stored]; }, async setMany(entries) { stored = entries[0][1]; version++; }, async deleteMany() {},
		async getManyVersioned() { reads++; return [{ value: stored, version: String(version) }]; },
		async setManyVersioned(entries) {
			writes++;
			if (entries[0][2] !== String(version)) return [false];
			stored = entries[0][1]; return [true];
		},
		async invalidateMany() {
			invalidations++;
			if (outage) throw new Error('cache unavailable');
			version++; stored = undefined;
		}
	};
	const lookup = createFunctionCache({ prefix: refresh ? 'recovery_refresh' : 'recovery_normal', cache,
		consistency: 'distributed', factory: () => { factories++; return 'fresh'; } });
	await assert.rejects(lookup.invalidate('id'), /cache unavailable/);
	await assert.rejects(lookup.get('id', { refresh }), /cache unavailable/);
	assert.equal(stored, 'old');
	assert.equal(reads, 0);
	outage = false;
	assert.equal(await lookup.get('id', { refresh }), 'fresh');
	assert.equal(await lookup.get('id'), 'fresh');
	assert.equal(factories, 1);
	assert.equal(stored, 'fresh');
	assert.equal(invalidations, 3);
	assert.equal(writes, 1);
	assert.equal(reads, 2);
	// A fill holding the pre-outage fence cannot undo the repair.
	assert.deepEqual(await cache.setManyVersioned!([['ignored', 'stale', '1']]), [false]);
	assert.equal(stored, 'fresh');
});
