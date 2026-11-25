import test from 'node:test';
import assert from 'node:assert/strict';
import { ActiveTsConfigurationError, createActiveTs, MemoryStoreAdapter, type StoreAdapter } from '../src/index.js';
import { StoreOutboxAdapter } from '../src/core/outbox-store.js';
import { storeOutboxUsesOptimisticWrites } from '../src/core/outbox-store.js';

/**
 * A memory store labelled as a Google store that enforces Firestore's
 * transaction rule: every read happens before the first write.
 */
function googleRulesStore(kind: 'firestore' | 'datastore') {
	const store = new MemoryStoreAdapter();
	let transactions = 0;
	const adapter: StoreAdapter = {
		kind,
		cacheScope: store.cacheScope,
		capabilities: Object.freeze({ ...store.capabilities, optimisticLock: true }),
		get: (model, id, options) => store.get(model, id, options),
		getMany: (model, ids, options) => store.getMany(model, ids, options),
		query: (model, plan, options) => store.query(model, plan, options),
		aggregate: (model, plan) => store.aggregate!(model, plan),
		create: (model, id, data, options) => store.create(model, id, data, options),
		update: (model, id, data, options) => store.update(model, id, data, options),
		delete: (model, id, options) => store.delete(model, id, options),
		transaction: (fn, options) => store.transaction!(async (tx) => {
			transactions++;
			let wrote = false;
			const readFirst = () => {
				if (wrote) throw new ActiveTsConfigurationError(`${kind} transaction cannot read unbuffered documents after writes.`);
			};
			return await fn({
				...tx,
				kind,
				capabilities: tx.capabilities,
				get: async (model, id, readOptions) => { readFirst(); return await tx.get(model, id, readOptions); },
				getMany: async (model, ids, readOptions) => { readFirst(); return await tx.getMany(model, ids, readOptions); },
				query: async (model, plan, readOptions) => { readFirst(); return await tx.query(model, plan, readOptions); },
				create: async (model, id, data, writeOptions) => { wrote = true; await tx.create(model, id, data, writeOptions); },
				update: async (model, id, data, writeOptions) => { wrote = true; await tx.update(model, id, data, writeOptions); },
				delete: async (model, id, writeOptions) => { wrote = true; await tx.delete(model, id, writeOptions); }
			});
		}, options)
	};
	return { adapter, transactions: () => transactions };
}

test('Google stores keep per-event outbox transactions after gaining optimistic locking', () => {
	for (const kind of ['firestore', 'datastore'] as const) {
		assert.equal(storeOutboxUsesOptimisticWrites(googleRulesStore(kind).adapter), false, kind);
	}
	assert.equal(storeOutboxUsesOptimisticWrites(new MemoryStoreAdapter()), true);
	const noTransactions = { ...googleRulesStore('datastore').adapter, transaction: undefined };
	assert.equal(storeOutboxUsesOptimisticWrites(noTransactions), true, 'without transactions versions are the only guard');
});

for (const kind of ['firestore', 'datastore'] as const) {
	test(`${kind} outbox retry and dead-letter settle a batch without reading after writes`, async () => {
		const { adapter, transactions } = googleRulesStore(kind);
		const context = createActiveTs({ stores: { default: adapter } });
		const outbox = new StoreOutboxAdapter({ context });
		const createdAt = '2026-11-24T00:00:00.000Z';
		for (const [index, id] of ['first', 'second', 'third'].entries()) {
			await outbox.append({ id, model: 'outbox_google_account', modelId: index + 1, operation: 'update', createdAt });
		}
		const leased = await outbox.lease!();
		assert.equal(leased.length, 3);
		const failure = (event: (typeof leased)[number], maxAttempts: number) => ({
			identity: { id: event.id, leaseToken: event.leaseToken }, event, attempt: 1, maxAttempts,
			failedAt: createdAt, retryAt: createdAt, error: 'delivery failed'
		});
		const before = transactions();
		await outbox.retry!([failure(leased[0]!, 3), failure(leased[1]!, 3)]);
		assert.equal(transactions() - before, 2, 'one transaction per failure');
		await outbox.deadLetter!([failure(leased[2]!, 1)]);
		const remaining = await outbox.list();
		assert.deepEqual(remaining.map(event => [event.id, event.deliveryAttempts ?? 0]).sort(),
			[['first', 1], ['second', 1]]);
		assert.deepEqual((await outbox.listDeadLetters!()).map(event => event.id), ['third']);
	});
}
