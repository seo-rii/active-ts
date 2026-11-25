import test from 'node:test';
import assert from 'node:assert/strict';
import { ActiveTsValidationError, MemoryStoreAdapter } from '../src/index.js';

async function populatedStore() {
	const store = new MemoryStoreAdapter();
	await store.seed('store_scope_one', [{ id: 1, value: 'one' }]);
	await store.seed('store_scope_two', [{ id: 2, value: 'two' }]);
	return store;
}

test('invalid explicit memory store reset scopes preserve every collection and stats', async () => {
	const store = await populatedStore();
	store.stats.get = 3;
	const before = store.snapshot();
	const stats = { ...store.stats };
	for (const scope of ['', null, false, 0, NaN, true, {}, [], Symbol('scope'), 'bad.name']) {
		assert.throws(() => store.reset(scope as string), ActiveTsValidationError);
		assert.deepEqual(store.snapshot(), before);
		assert.deepEqual(store.stats, stats);
	}
});

test('invalid explicit memory store snapshot scopes cannot select every collection', async () => {
	const store = await populatedStore();
	const before = store.snapshot();
	for (const scope of ['', null, false, 0, NaN, true, {}, [], Symbol('scope'), 'bad.name']) {
		assert.throws(() => store.snapshot(scope as string), ActiveTsValidationError);
	}
	assert.deepEqual(store.snapshot(), before);
});

test('valid model scopes and omitted or undefined global scopes retain their behavior', async () => {
	const store = await populatedStore();
	assert.deepEqual(store.snapshot('store_scope_one'), [{ id: 1, value: 'one' }]);
	store.reset('store_scope_one');
	assert.deepEqual(store.snapshot(), { store_scope_two: [{ id: 2, value: 'two' }] });
	assert.deepEqual(store.snapshot('store_scope_one'), []);
	store.reset(undefined);
	assert.deepEqual(store.snapshot(), {});
	await store.seed('store_scope_one', [{ id: 3, value: 'three' }]);
	store.reset();
	assert.deepEqual(store.snapshot(), {});
});
