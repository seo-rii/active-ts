import test from 'node:test';
import assert from 'node:assert/strict';
import { createActiveTs, createFunctionCache, MemoryCacheAdapter, MemoryStoreAdapter } from '../src/index.js';

for (const persistent of [false, true]) {
	test(`set snapshots nested values before asynchronous key resolution (${persistent ? 'persistent' : 'memory'})`, async () => {
		const adapter = persistent ? new MemoryCacheAdapter() : false;
		const cache = createFunctionCache<number, { owner: number; nested: { revision: string } }>({
			prefix: `set-value-snapshot-${persistent}`, cache: adapter,
			...(persistent ? { memory: false as const } : {}),
			factory() { throw new Error('A set value should be present.'); }
		});
		const value = { owner: 1, nested: { revision: 'before' } };
		const pending = cache.set(1, value);
		value.owner = 2;
		value.nested.revision = 'after';
		assert.equal(await pending, value);
		assert.deepEqual(await cache.get(1), { owner: 1, nested: { revision: 'before' } });
	});
}

test('set snapshots values before a pending custom key and namespace resolver', async () => {
	let resolveKey!: (key: string) => void;
	const key = new Promise<string>(resolve => { resolveKey = resolve; });
	const cache = createFunctionCache({
		prefix: 'set-value-pending-resolvers', cache: false,
		key: () => key,
		namespace: async () => 'tenant',
		factory: () => ({ list: ['factory'] })
	});
	const value = { list: ['before'] };
	const pending = cache.set(1, value);
	value.list.push('after');
	resolveKey('one');
	await pending;
	assert.deepEqual(await cache.get(1), { list: ['before'] });
});

for (const rollback of [false, true]) {
	test(`transactional set snapshots before key resolution and ${rollback ? 'discards on rollback' : 'publishes after commit'}`, async () => {
		const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
		const adapter = new MemoryCacheAdapter();
		const cache = createFunctionCache({
			prefix: `set-value-transaction-${rollback}`, context, cache: adapter,
			factory: () => ({ revision: 'factory' })
		});
		await cache.set(1, { revision: 'old' });
		const transaction = context.transaction(async () => {
			const value = { revision: 'before' };
			const pending = cache.set(1, value);
			value.revision = 'after';
			await pending;
			assert.deepEqual(Object.values(adapter.snapshot()).map(entry => entry.value), [{ revision: 'old' }]);
			if (rollback) throw new Error('rollback snapshot');
		});
		if (rollback) await assert.rejects(transaction, /rollback snapshot/);
		else await transaction;
		assert.deepEqual(await cache.get(1), { revision: rollback ? 'old' : 'before' });
	});
}
