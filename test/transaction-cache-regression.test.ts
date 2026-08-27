import test from 'node:test';
import assert from 'node:assert/strict';
import { types as utilTypes } from 'node:util';
import {
	ActiveTsConflictError,
	ActiveTsCommittedTransactionError,
	ActiveTsCommittedWriteError,
	ActiveTsNotFoundError,
	MemoryCacheAdapter,
	MemoryOutboxAdapter,
	MemorySearchAdapter,
	MemoryStoreAdapter,
	Model,
	type ActiveContext,
	type AggregatePlan,
	datastoreKey,
	type QueryPlan,
	type StoreAdapter,
	type StoreTransactionOptions,
	StoreOutboxAdapter,
	assertContextBoundCacheAdapter,
	assertContextBoundSearchAdapter,
	assertContextBoundStoreAdapter,
	clearDefaultContext,
	createActiveTs,
	createCacheMiddlewareAdapter,
	createOutboxPlugin,
	createSearchMiddlewareAdapter,
	createStoreMiddlewareAdapter,
	defineModel,
	getCurrentDefaultContext,
	isContextBoundCacheAdapter,
	isContextBoundSearchAdapter,
	isContextBoundStoreAdapter,
	setDefaultContext,
	trackStoreTransactionWork
} from '../src/index.js';
import { createNativeSearchAdapter } from '../src/adapters/search/native.js';
import {
	datastoreSearchDocumentIdentity,
	searchHitDocumentIdentity
} from '../src/core/search-utils.js';
import {
	createCloseGuardedStoreAdapter,
	createTransactionOperationTracker
} from '../src/core/store-options.js';

type TransactionCacheData = {
	id: number;
	value: string;
};

type TransactionAuditData = {
	id: number;
	value: string;
};

type TransactionIsolationData = {
	id: number;
	value: string;
};

type TransactionVersionData = {
	id: number;
	value: string;
	version: number;
};

type TransactionNoCacheData = {
	id: number;
	value: string;
};

type TransactionFailingHookData = {
	id: number;
	value: string;
};

type TransactionNativeSearchData = {
	id: number;
	value: string;
};

type TransactionDatastoreNativeSearchData = {
	id: number;
	parentId: number;
	value: string;
};

type TransactionMemorySearchData = {
	id: number;
	value: string;
};

type TransactionReadOnlyHookData = {
	id: number;
	value: string;
};

class TransactionCacheRecord extends Model<TransactionCacheData> {}
class TransactionAuditRecord extends Model<TransactionAuditData> {}
class TransactionIsolationRecord extends Model<TransactionIsolationData> {}
class TransactionVersionRecord extends Model<TransactionVersionData> {}
class TransactionNoCacheRecord extends Model<TransactionNoCacheData> {}
class TransactionFailingHookRecord extends Model<TransactionFailingHookData> {}
class TransactionNativeSearchRecord extends Model<TransactionNativeSearchData> {}
class TransactionTracedNativeSearchRecord extends Model<TransactionNativeSearchData> {}
class TransactionDatastoreNativeSearchRecord extends Model<TransactionDatastoreNativeSearchData> {}
class TransactionMemorySearchRecord extends Model<TransactionMemorySearchData> {}
class TransactionReadOnlyHookRecord extends Model<TransactionReadOnlyHookData> {}

function createMalformedMemorySavepointStore(
	kind: string,
	createSavepoint: (tx: StoreAdapter) => NonNullable<StoreAdapter['savepoint']>,
	onTransactionRollback?: () => void
) {
	const backing = new MemoryStoreAdapter();
	const store: StoreAdapter = {
		kind,
		capabilities: { ...backing.capabilities, transaction: true, savepoint: false },
		get: (model, id, options) => backing.get(model, id, options),
		getMany: (model, ids, options) => backing.getMany(model, ids, options),
		query: (model, plan, options) => backing.query(model, plan, options),
		aggregate: (model, plan) => backing.aggregate(model, plan),
		create: (model, id, data, options) => backing.create(model, id, data, options),
		update: (model, id, data, options) => backing.update(model, id, data, options),
		delete: (model, id, options) => backing.delete(model, id, options),
		transaction: async (fn, options) => {
			try {
				return await backing.transaction(async (tx) => fn({
					...tx,
					capabilities: { ...(tx.capabilities ?? {}), transaction: false, savepoint: true },
					savepoint: createSavepoint(tx)
				}), options);
			} catch (error) {
				onTransactionRollback?.();
				throw error;
			}
		}
	};
	return { backing, store };
}

let transactionReadOnlyHookEvents: string[] = [];

defineModel<TransactionCacheData>({ name: 'transaction_cache_record', cache: { ttl: 60, negativeTtl: 60 } })
	.id('id')
	.validate((input) => input as TransactionCacheData)
	.attach(TransactionCacheRecord);

defineModel<TransactionAuditData>({ name: 'transaction_cache_audit_record', store: 'audit' })
	.id('id')
	.validate((input) => input as TransactionAuditData)
	.attach(TransactionAuditRecord);

defineModel<TransactionIsolationData>('transaction_isolation_record')
	.id('id')
	.validate((input) => input as TransactionIsolationData)
	.attach(TransactionIsolationRecord);

defineModel<TransactionVersionData>('transaction_version_record')
	.id('id')
	.validate((input) => input as TransactionVersionData)
	.attach(TransactionVersionRecord);

defineModel<TransactionNoCacheData>({ name: 'transaction_no_cache_record', cache: false })
	.id('id')
	.validate((input) => input as TransactionNoCacheData)
	.attach(TransactionNoCacheRecord);

defineModel<TransactionFailingHookData>('transaction_failing_hook_record')
	.id('id')
	.validate((input) => input as TransactionFailingHookData)
	.hooks({
		afterCreate() {
			throw new Error('after create hook failed');
		}
	})
	.attach(TransactionFailingHookRecord);

defineModel<TransactionNativeSearchData>({ name: 'transaction_native_search_record', search: 'native' })
	.id('id')
	.validate((input) => input as TransactionNativeSearchData)
	.search('native', ['value'])
	.attach(TransactionNativeSearchRecord);

defineModel<TransactionNativeSearchData>({ name: 'transaction_traced_native_search_record', store: 'traced', search: 'native' })
	.id('id')
	.validate((input) => input as TransactionNativeSearchData)
	.search('native', ['value'])
	.attach(TransactionTracedNativeSearchRecord);

defineModel<TransactionDatastoreNativeSearchData>({ name: 'transaction_datastore_native_search_record', search: 'native' })
	.id('id')
	.validate((input) => input as TransactionDatastoreNativeSearchData)
	.datastore({
		ancestor: ({ data }) => data === undefined ? undefined : datastoreKey('transaction_native_search_parent', data.parentId),
		ancestorFields: ['parentId']
	})
	.search('native', ['value'])
	.attach(TransactionDatastoreNativeSearchRecord);

defineModel<TransactionMemorySearchData>({ name: 'transaction_memory_search_record', search: 'memory' })
	.id('id')
	.validate((input) => input as TransactionMemorySearchData)
	.search('memory', ['value'])
	.attach(TransactionMemorySearchRecord);

defineModel<TransactionReadOnlyHookData>('transaction_read_only_hook_record')
	.id('id')
	.validate((input) => input as TransactionReadOnlyHookData)
	.hooks({
		beforeCreate() {
			transactionReadOnlyHookEvents.push('beforeCreate');
		},
		beforeUpdate() {
			transactionReadOnlyHookEvents.push('beforeUpdate');
		},
		beforeDelete() {
			transactionReadOnlyHookEvents.push('beforeDelete');
		}
	})
	.attach(TransactionReadOnlyHookRecord);

function createNativeMutatingStore(backing: MemoryStoreAdapter, onNative: () => void): StoreAdapter {
	const createLeakedAuditRow = async (model: any) => {
		onNative();
		await backing.create(model, 91, { id: 91, value: 'native-leak' });
	};
	return {
		kind: 'native-mutating-memory',
		capabilities: { ...backing.capabilities, transaction: false, native: true },
		get: (model, id, options) => backing.get(model, id, options),
		getMany: (model, ids, options) => backing.getMany(model, ids, options),
		query: async (model, plan, options) => {
			if (plan.native) {
				await createLeakedAuditRow(model);
				return { list: [] };
			}
			return await backing.query(model, plan, options);
		},
		aggregate: async (model, plan) => {
			if (plan.native) {
				await createLeakedAuditRow(model);
				return { count: 0 };
			}
			return await backing.aggregate(model, plan);
		},
		create: (model, id, data) => backing.create(model, id, data),
		update: (model, id, data, options) => backing.update(model, id, data, options),
		delete: (model, id) => backing.delete(model, id)
	};
}

test('transaction rollback does not invalidate cache entries or publish outbox events', async () => {
	const store = new MemoryStoreAdapter();
	const cache = new MemoryCacheAdapter();
	const outbox = new MemoryOutboxAdapter();
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache },
		plugins: [createOutboxPlugin({ outbox, includeData: true, id: () => 'rollback-event' })]
	});
	const Record = TransactionCacheRecord.use(context) as unknown as typeof TransactionCacheRecord;
	await store.seed('transaction_cache_record', [{ id: 1, value: 'cached' }]);
	await Record.find(1).load();
	assert.equal(cache.stats.setMany, 1);

	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				const TxRecord = TransactionCacheRecord.use(tx) as unknown as typeof TransactionCacheRecord;
				const loaded = await TxRecord.find(1).load();
				loaded!.data.value = 'rolled-back';
				await loaded!.save();
				await TxRecord.create({ id: 2, value: 'created-then-rolled-back' });
				throw new Error('rollback');
			}),
		/rollback/
	);

	assert.equal(cache.stats.deleteMany, 0);
	assert.deepEqual(await outbox.list(), []);
	assert.equal((await Record.find(1).load())?.data.value, 'cached');
	assert.equal(await Record.find(2).load(), null);
});

test('transaction afterRollback callbacks run after adapter rollback completes', async () => {
	class OrderedRollbackStore extends MemoryStoreAdapter {
		events: string[] = [];

		override async transaction<T>(fn: (tx: StoreAdapter) => Promise<T>): Promise<T> {
			const txStore = new MemoryStoreAdapter();
			try {
				return await fn(txStore);
			} catch (error) {
				this.events.push('adapter rollback');
				throw error;
			}
		}
	}
	const store = new OrderedRollbackStore();
	const context = createActiveTs({ stores: { default: store } });

	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				await tx.afterRollback(() => {
					store.events.push('afterRollback');
				});
				throw new Error('rollback order');
			}),
		/rollback order/
	);

	assert.deepEqual(store.events, ['adapter rollback', 'afterRollback']);
});

test('low-level memory transaction adapters close after callbacks settle', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(TransactionNoCacheRecord);
	let committed!: StoreAdapter;
	await store.transaction(async (tx) => {
		committed = tx;
		await tx.create(meta, 5101, { id: 5101, value: 'committed' });
	});

	await assert.rejects(
		() => committed.create(meta, 5102, { id: 5102, value: 'late' }),
		/closed memory store transaction adapter after commit/
	);
	assert.equal((await store.get(meta, 5101))?.value, 'committed');
	assert.equal(await store.get(meta, 5102), null);

	let rolledBack!: StoreAdapter;
	await assert.rejects(
		() =>
			store.transaction(async (tx) => {
				rolledBack = tx;
				await tx.create(meta, 5103, { id: 5103, value: 'rolled-back' });
				throw new Error('rollback low-level memory');
			}),
		/rollback low-level memory/
	);
	await assert.rejects(
		() => rolledBack.get(meta, 5103),
		/closed memory store transaction adapter after rollback/
	);
	assert.equal(await store.get(meta, 5103), null);
});

test('memory transactions preserve concurrent same-row operation order', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(TransactionNoCacheRecord);
	await store.seed(meta, [
		{ id: 5201, value: 'replace-me' },
		{ id: 5202, value: 'delete-before-read' },
		{ id: 5203, value: 'delete-before-update' }
	]);

	await store.transaction(async (tx) => {
		const deletion = tx.delete(meta, 5201);
		const recreation = tx.create(meta, 5201, { id: 5201, value: 'replacement' });
		const replacementResults = await Promise.allSettled([deletion, recreation]);
		assert.equal(replacementResults[0].status, 'fulfilled');
		assert.equal(replacementResults[1].status, 'fulfilled');
		assert.equal((await tx.get(meta, 5201))?.value, 'replacement');

		const readDeletion = tx.delete(meta, 5202);
		const readAfterDelete = tx.get(meta, 5202);
		const [, deletedRow] = await Promise.all([readDeletion, readAfterDelete]);
		assert.equal(deletedRow, null);

		const updateDeletion = tx.delete(meta, 5203);
		const updateAfterDelete = tx.update(meta, 5203, { id: 5203, value: 'must-not-update' });
		const updateResults = await Promise.allSettled([updateDeletion, updateAfterDelete]);
		assert.equal(updateResults[0].status, 'fulfilled');
		assert.equal(updateResults[1].status, 'rejected');
		if (updateResults[1].status === 'rejected') {
			assert.ok(updateResults[1].reason instanceof ActiveTsNotFoundError);
		}
	});

	assert.deepEqual(store.dump('transaction_no_cache_record'), [
		{ id: 5201, value: 'replacement' }
	]);
});

test('memory transactions roll back unobserved operation failures that settle before callback drain', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(TransactionNoCacheRecord);
	await store.seed(meta, [
		{ id: 5301, value: 'duplicate-original' },
		{ id: 5302, value: 'must-roll-back' }
	]);
	let ignoredCreate!: Promise<void>;

	await assert.rejects(
		() =>
			store.transaction(async (tx) => {
				ignoredCreate = tx.create(meta, 5301, { id: 5301, value: 'duplicate' });
				await new Promise<void>((resolve) => setImmediate(resolve));
				await tx.update(meta, 5302, { id: 5302, value: 'updated' });
				return 'must-not-commit';
			}),
		ActiveTsConflictError
	);
	await assert.rejects(() => ignoredCreate, ActiveTsConflictError);

	assert.deepEqual(store.dump('transaction_no_cache_record'), [
		{ id: 5301, value: 'duplicate-original' },
		{ id: 5302, value: 'must-roll-back' }
	]);
});

test('memory transactions allow callback code to handle settled operation failures', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(TransactionNoCacheRecord);
	await store.seed(meta, [
		{ id: 5311, value: 'duplicate-original' },
		{ id: 5312, value: 'update-me' }
	]);

	await store.transaction(async (tx) => {
		const duplicate = tx.create(meta, 5311, { id: 5311, value: 'duplicate' });
		assert.equal(duplicate instanceof Promise, true);
		assert.equal(utilTypes.isPromise(duplicate), true);
		await assert.rejects(
			() => duplicate.then((value) => value),
			ActiveTsConflictError
		);
		await tx.update(meta, 5312, { id: 5312, value: 'updated' });
	});

	assert.deepEqual(store.dump('transaction_no_cache_record'), [
		{ id: 5311, value: 'duplicate-original' },
		{ id: 5312, value: 'updated' }
	]);
});

test('context transaction work tracking retains discarded native Promise wrapper failures', async () => {
	const wrappers: Array<{
		name: string;
		wrap: (run: () => Promise<unknown>) => Promise<unknown>;
	}> = [
		{ name: 'Promise.resolve', wrap: (run) => Promise.resolve(run()) },
		{ name: 'Promise.all', wrap: (run) => Promise.all([run()]) },
		{ name: 'async helper', wrap: async (run) => await run() }
	];

	for (let index = 0; index < wrappers.length; index++) {
		const wrapper = wrappers[index];
		const store = new MemoryStoreAdapter();
		const context = createActiveTs({ stores: { default: store } });
		const duplicateId = 5313 + index * 2;
		const updatedId = duplicateId + 1;
		await store.seed('transaction_no_cache_record', [
			{ id: duplicateId, value: `${wrapper.name}-original` },
			{ id: updatedId, value: 'must-roll-back' }
		]);

		await assert.rejects(
			() => context.transaction(async (tx) => {
				const TxRecord = TransactionNoCacheRecord.use(tx) as unknown as typeof TransactionNoCacheRecord;
				void tx.track(() => wrapper.wrap(() => TxRecord.create({
					id: duplicateId,
					value: 'duplicate'
					})));
				await new Promise<void>((resolve) => setImmediate(resolve));
				await TxRecord.update(updatedId, { value: 'updated' });
			}),
			ActiveTsConflictError,
			wrapper.name
		);
		assert.deepEqual(store.dump('transaction_no_cache_record'), [
			{ id: duplicateId, value: `${wrapper.name}-original` },
			{ id: updatedId, value: 'must-roll-back' }
		]);
	}
});

test('low-level transaction work tracking retains discarded aggregate failures', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(TransactionNoCacheRecord);
	await store.seed(meta, [
		{ id: 5319, value: 'duplicate-original' },
		{ id: 5320, value: 'must-roll-back' }
	]);

	await assert.rejects(
		() => store.transaction(async (tx) => {
			void trackStoreTransactionWork(tx, () => Promise.all([
				tx.create(meta, 5319, { id: 5319, value: 'duplicate' })
			]));
			await new Promise<void>((resolve) => setImmediate(resolve));
			await tx.update(meta, 5320, { id: 5320, value: 'updated' });
		}),
		ActiveTsConflictError
	);
	assert.deepEqual(store.dump('transaction_no_cache_record'), [
		{ id: 5319, value: 'duplicate-original' },
		{ id: 5320, value: 'must-roll-back' }
	]);
});

test('transaction work tracking rejects nontransactional handles before starting work', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	let contextWorkStarted = false;
	let storeWorkStarted = false;
	let contextStoreWorkStarted = false;

	await assert.rejects(
		() => context.track(async () => {
			contextWorkStarted = true;
		}),
		/Cannot track work outside a transaction/
	);
	await assert.rejects(
		() => trackStoreTransactionWork(store, async () => {
			storeWorkStarted = true;
		}),
		/transaction-scoped store adapter/
	);
	await assert.rejects(
		() => trackStoreTransactionWork(context.store('default'), async () => {
			contextStoreWorkStarted = true;
		}),
		/transaction-scoped store adapter/
	);
	assert.equal(contextWorkStarted, false);
	assert.equal(storeWorkStarted, false);
	assert.equal(contextStoreWorkStarted, false);
});

test('context transactions roll back unobserved high-level model store failures', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	await store.seed('transaction_no_cache_record', [{ id: 5361, value: 'duplicate-original' }]);
	let ignoredCreate!: Promise<TransactionNoCacheRecord>;

	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				const TxRecord = TransactionNoCacheRecord.use(tx) as unknown as typeof TransactionNoCacheRecord;
				ignoredCreate = TxRecord.create({ id: 5361, value: 'duplicate' });
				void Promise.prototype.then.call(ignoredCreate, undefined, () => undefined);
				await new Promise<void>((resolve) => setImmediate(resolve));
				await TxRecord.create({ id: 5362, value: 'must-roll-back' });
			}),
		ActiveTsConflictError
	);
	await assert.rejects(() => ignoredCreate, ActiveTsConflictError);
	assert.deepEqual(store.dump('transaction_no_cache_record'), [
		{ id: 5361, value: 'duplicate-original' }
	]);
});

test('context transactions roll back unobserved high-level model hook failures', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	let ignoredCreate!: Promise<TransactionFailingHookRecord>;

	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				const FailingRecord = TransactionFailingHookRecord.use(tx) as unknown as typeof TransactionFailingHookRecord;
				const ValidRecord = TransactionNoCacheRecord.use(tx) as unknown as typeof TransactionNoCacheRecord;
				ignoredCreate = FailingRecord.create({ id: 5363, value: 'hook-failure' });
				void Promise.prototype.then.call(ignoredCreate, undefined, () => undefined);
				await new Promise<void>((resolve) => setImmediate(resolve));
				await ValidRecord.create({ id: 5364, value: 'must-roll-back' });
			}),
		/after create hook failed/
	);
	await assert.rejects(() => ignoredCreate, /after create hook failed/);
	assert.deepEqual(store.dump('transaction_failing_hook_record'), []);
	assert.deepEqual(store.dump('transaction_no_cache_record'), []);
});

test('context transactions allow callback code to handle high-level model failures', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	await store.seed('transaction_no_cache_record', [{ id: 5371, value: 'duplicate-original' }]);

	await context.transaction(async (tx) => {
		const TxRecord = TransactionNoCacheRecord.use(tx) as unknown as typeof TransactionNoCacheRecord;
		const duplicate = TxRecord.create({ id: 5371, value: 'duplicate' });
		assert.equal(duplicate instanceof Promise, true);
		assert.equal(utilTypes.isPromise(duplicate), true);
		await assert.rejects(() => duplicate, ActiveTsConflictError);
		await TxRecord.create({ id: 5372, value: 'committed' });
	});

	assert.deepEqual(store.dump('transaction_no_cache_record'), [
		{ id: 5371, value: 'duplicate-original' },
		{ id: 5372, value: 'committed' }
	]);
});

test('context transactions preserve callback errors over ignored high-level model failures', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const callbackError = new Error('high-level transaction callback failed');
	await store.seed('transaction_no_cache_record', [{ id: 5373, value: 'duplicate-original' }]);
	let ignoredCreate!: Promise<TransactionNoCacheRecord>;

	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				const TxRecord = TransactionNoCacheRecord.use(tx) as unknown as typeof TransactionNoCacheRecord;
				await TxRecord.create({ id: 5374, value: 'must-roll-back' });
				ignoredCreate = TxRecord.create({ id: 5373, value: 'duplicate' });
				void Promise.prototype.then.call(ignoredCreate, undefined, () => undefined);
				await new Promise<void>((resolve) => setImmediate(resolve));
				throw callbackError;
			}),
		(error: unknown) => error === callbackError
	);
	await assert.rejects(() => ignoredCreate, ActiveTsConflictError);
	assert.deepEqual(store.dump('transaction_no_cache_record'), [
		{ id: 5373, value: 'duplicate-original' }
	]);
});

test('context transactions drain successful high-level model hooks before commit', async () => {
	type PendingHookData = { id: number; value: string };
	class PendingHookRecord extends Model<PendingHookData> {}
	let markHookStarted!: () => void;
	let releaseHook!: () => void;
	const hookStarted = new Promise<void>((resolve) => {
		markHookStarted = resolve;
	});
	const hookBarrier = new Promise<void>((resolve) => {
		releaseHook = resolve;
	});
	defineModel<PendingHookData>({ name: 'transaction_pending_model_hook_record', cache: false })
		.id('id')
		.validate((input) => input as PendingHookData)
		.hooks({
			async afterCreate() {
				markHookStarted();
				await hookBarrier;
			}
		})
		.attach(PendingHookRecord);

	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	let ignoredCreate!: Promise<PendingHookRecord>;
	let transactionSettled = false;
	const transaction = context.transaction(async (tx) => {
		const TxRecord = PendingHookRecord.use(tx) as unknown as typeof PendingHookRecord;
		ignoredCreate = TxRecord.create({ id: 5375, value: 'committed-after-hook' });
	});
	void transaction.then(
		() => {
			transactionSettled = true;
		},
		() => {
			transactionSettled = true;
		}
	);

	await hookStarted;
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(transactionSettled, false);
	releaseHook();
	await transaction;
	await ignoredCreate;
	assert.deepEqual(store.dump('transaction_pending_model_hook_record'), [
		{ id: 5375, value: 'committed-after-hook' }
	]);
});

test('context transaction drains allow tracked model operations to start nested writes', async () => {
	const baseStore = new MemoryStoreAdapter();
	let markReadStarted!: () => void;
	let releaseRead!: () => void;
	const readStarted = new Promise<void>((resolve) => {
		markReadStarted = resolve;
	});
	const readBarrier = new Promise<void>((resolve) => {
		releaseRead = resolve;
	});
	let blockRead = true;
	const store = createStoreMiddlewareAdapter(baseStore, [
		async (middlewareContext, next) => {
			if (
				blockRead &&
				middlewareContext.operation === 'getMany' &&
				Array.isArray(middlewareContext.args[0]) &&
				middlewareContext.args[0][0] === 5376
			) {
				blockRead = false;
				markReadStarted();
				await readBarrier;
			}
			return await next();
		}
	]);
	const context = createActiveTs({ stores: { default: store } });
	await baseStore.seed('transaction_no_cache_record', [{ id: 5376, value: 'before' }]);
	let ignoredUpdate!: Promise<TransactionNoCacheRecord | null>;
	let transactionSettled = false;

	const transaction = context.transaction(async (tx) => {
		const TxRecord = TransactionNoCacheRecord.use(tx) as unknown as typeof TransactionNoCacheRecord;
		ignoredUpdate = TxRecord.update(5376, { value: 'after' });
	});
	void transaction.then(
		() => {
			transactionSettled = true;
		},
		() => {
			transactionSettled = true;
		}
	);
	await readStarted;
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(transactionSettled, false);
	releaseRead();
	await transaction;
	await ignoredUpdate;
	assert.deepEqual(baseStore.dump('transaction_no_cache_record'), [
		{ id: 5376, value: 'after' }
	]);
});

test('context-bound store transactions roll back unobserved wrapper failures', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(TransactionNoCacheRecord);
	await store.seed(meta, [{ id: 5381, value: 'duplicate-original' }]);
	let ignoredCreate!: Promise<void>;

	await assert.rejects(
		() =>
			context.store('default').transaction!(async (tx) => {
				await tx.create(meta, 5382, { id: 5382, value: 'must-roll-back' });
				ignoredCreate = tx.create(meta, 5381, { id: 5381, value: 'duplicate' });
				void Promise.prototype.then.call(ignoredCreate, undefined, () => undefined);
				await new Promise<void>((resolve) => setImmediate(resolve));
			}),
		ActiveTsConflictError
	);
	await assert.rejects(() => ignoredCreate, ActiveTsConflictError);
	assert.deepEqual(store.dump('transaction_no_cache_record'), [
		{ id: 5381, value: 'duplicate-original' }
	]);
});

test('context-bound store transactions allow handled wrapper failures', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(TransactionNoCacheRecord);
	await store.seed(meta, [{ id: 5389, value: 'duplicate-original' }]);

	await context.store('default').transaction!(async (tx) => {
		await assert.rejects(
			() => tx.create(meta, 5389, { id: 5389, value: 'duplicate' }),
			ActiveTsConflictError
		);
		await tx.create(meta, 5390, { id: 5390, value: 'committed' });
	});

	assert.deepEqual(store.dump('transaction_no_cache_record'), [
		{ id: 5389, value: 'duplicate-original' },
		{ id: 5390, value: 'committed' }
	]);
});

test('ambient context store handles roll back unobserved wrapper failures', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const handle = context.store('default');
	const meta = context.meta(TransactionNoCacheRecord);
	await store.seed(meta, [{ id: 5383, value: 'duplicate-original' }]);
	let ignoredCreate!: Promise<void>;

	await assert.rejects(
		() =>
			context.transaction(async () => {
				await handle.create(meta, 5384, { id: 5384, value: 'must-roll-back' });
				ignoredCreate = handle.create(meta, 5383, { id: 5383, value: 'duplicate' });
				void Promise.prototype.then.call(ignoredCreate, undefined, () => undefined);
				await new Promise<void>((resolve) => setImmediate(resolve));
			}),
		ActiveTsConflictError
	);
	await assert.rejects(() => ignoredCreate, ActiveTsConflictError);
	assert.deepEqual(store.dump('transaction_no_cache_record'), [
		{ id: 5383, value: 'duplicate-original' }
	]);
});

test('high-level query failures remain visible to context transactions', async () => {
	const queryError = new Error('transaction query wrapper failed');
	const baseStore = new MemoryStoreAdapter();
	const store = createStoreMiddlewareAdapter(baseStore, [
		async (middlewareContext, next) => {
			if (
				middlewareContext.operation === 'query' &&
				middlewareContext.model.name === 'transaction_no_cache_record'
			) {
				throw queryError;
			}
			return await next();
		}
	]);
	const context = createActiveTs({ stores: { default: store } });
	let ignoredQuery!: Promise<unknown>;

	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				const TxRecord = TransactionNoCacheRecord.use(tx) as unknown as typeof TransactionNoCacheRecord;
				ignoredQuery = TxRecord.query().load();
				void Promise.prototype.then.call(ignoredQuery, undefined, () => undefined);
				await new Promise<void>((resolve) => setImmediate(resolve));
				await TxRecord.create({ id: 5385, value: 'must-roll-back' });
			}),
		(error: unknown) => error === queryError
	);
	await assert.rejects(() => ignoredQuery, (error: unknown) => error === queryError);
	assert.deepEqual(baseStore.dump('transaction_no_cache_record'), []);
});

test('high-level aggregate failures remain visible to context transactions', async () => {
	const aggregateError = new Error('transaction aggregate wrapper failed');
	const baseStore = new MemoryStoreAdapter();
	const store = createStoreMiddlewareAdapter(baseStore, [
		async (middlewareContext, next) => {
			if (
				middlewareContext.operation === 'aggregate' &&
				middlewareContext.model.name === 'transaction_no_cache_record'
			) {
				throw aggregateError;
			}
			return await next();
		}
	]);
	const context = createActiveTs({ stores: { default: store } });
	let ignoredAggregate!: Promise<unknown>;

	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				const TxRecord = TransactionNoCacheRecord.use(tx) as unknown as typeof TransactionNoCacheRecord;
				ignoredAggregate = TxRecord.query().count();
				void Promise.prototype.then.call(ignoredAggregate, undefined, () => undefined);
				await new Promise<void>((resolve) => setImmediate(resolve));
				await TxRecord.create({ id: 5396, value: 'must-roll-back' });
			}),
		(error: unknown) => error === aggregateError
	);
	await assert.rejects(() => ignoredAggregate, (error: unknown) => error === aggregateError);
	assert.deepEqual(baseStore.dump('transaction_no_cache_record'), []);
});

test('lazy relation failures remain visible to context transactions', async () => {
	type LazyOwnerData = { id: number; value: string };
	type LazyChildData = { id: number; ownerId: number; value: string };
	class LazyOwnerRecord extends Model<LazyOwnerData> {}
	class LazyChildRecord extends Model<LazyChildData> {}
	defineModel<LazyChildData>({ name: 'transaction_lazy_child_record', cache: false })
		.id('id')
		.validate((input) => input as LazyChildData)
		.attach(LazyChildRecord);
	defineModel<LazyOwnerData>({ name: 'transaction_lazy_owner_record', cache: false })
		.id('id')
		.validate((input) => input as LazyOwnerData)
		.hasMany('children', () => LazyChildRecord, {
			localKey: 'id',
			foreignKey: 'ownerId',
			warnOnLazy: false
		})
		.attach(LazyOwnerRecord);

	const relationError = new Error('transaction lazy relation failed');
	const baseStore = new MemoryStoreAdapter();
	const store = createStoreMiddlewareAdapter(baseStore, [
		async (middlewareContext, next) => {
			if (
				middlewareContext.operation === 'query' &&
				middlewareContext.model.name === 'transaction_lazy_child_record'
			) {
				throw relationError;
			}
			return await next();
		}
	]);
	const context = createActiveTs({ stores: { default: store } });
	let ignoredRelation!: Promise<unknown>;

	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				const TxOwner = LazyOwnerRecord.use(tx) as unknown as typeof LazyOwnerRecord;
				const TxRecord = TransactionNoCacheRecord.use(tx) as unknown as typeof TransactionNoCacheRecord;
				const owner = await TxOwner.create({ id: 5393, value: 'must-roll-back' });
				ignoredRelation = owner.ref<LazyChildRecord>('children').load();
				void Promise.prototype.then.call(ignoredRelation, undefined, () => undefined);
				await new Promise<void>((resolve) => setImmediate(resolve));
				await TxRecord.create({ id: 5394, value: 'must-roll-back' });
			}),
		(error: unknown) => error === relationError
	);
	await assert.rejects(() => ignoredRelation, (error: unknown) => error === relationError);
	assert.deepEqual(baseStore.dump('transaction_lazy_owner_record'), []);
	assert.deepEqual(baseStore.dump('transaction_no_cache_record'), []);
});

test('transaction native search failures remain visible through context handles', async () => {
	const searchError = new Error('transaction native search wrapper failed');
	const baseStore = new MemoryStoreAdapter();
	const store = createStoreMiddlewareAdapter(baseStore, [
		async (middlewareContext, next) => {
			if (
				middlewareContext.operation === 'query' &&
				middlewareContext.model.name === 'transaction_native_search_record'
			) {
				throw searchError;
			}
			return await next();
		}
	]);
	const context = createActiveTs({
		stores: { default: store },
		search: { native: createNativeSearchAdapter(store) },
		defaultSearch: 'native'
	});
	let ignoredSearch!: Promise<unknown>;

	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				const TxRecord = TransactionNoCacheRecord.use(tx) as unknown as typeof TransactionNoCacheRecord;
				ignoredSearch = tx.searchAdapter('native').search(
					tx.meta(TransactionNativeSearchRecord),
					'ignored failure',
					{}
				);
				void Promise.prototype.then.call(ignoredSearch, undefined, () => undefined);
				await new Promise<void>((resolve) => setImmediate(resolve));
				await TxRecord.create({ id: 5386, value: 'must-roll-back' });
			}),
		(error: unknown) => error === searchError
	);
	await assert.rejects(() => ignoredSearch, (error: unknown) => error === searchError);
	assert.deepEqual(baseStore.dump('transaction_no_cache_record'), []);
});

test('native search wrappers preserve guarded store transaction failures', async () => {
	for (const wrapSearch of [false, true]) {
		const searchError = new Error(`raw transaction native search failed: ${String(wrapSearch)}`);
		const store = new MemoryStoreAdapter();
		const context = createActiveTs({ stores: { default: store } });
		const meta = context.meta(TransactionNativeSearchRecord);
		let ignoredSearch!: Promise<unknown>;

		await assert.rejects(
			() =>
				store.transaction(async (tx) => {
					const rejectingStore = createStoreMiddlewareAdapter(tx, [
						async (middlewareContext, next) => {
							if (middlewareContext.operation === 'query') throw searchError;
							return await next();
						}
					]);
					const native = createNativeSearchAdapter(rejectingStore);
					const search = wrapSearch ? createSearchMiddlewareAdapter(native, []) : native;
					ignoredSearch = search.search(meta, 'ignored failure', {});
					void Promise.prototype.then.call(ignoredSearch, undefined, () => undefined);
					await new Promise<void>((resolve) => setImmediate(resolve));
					await tx.create(meta, 5395, { id: 5395, value: 'must-roll-back' });
				}),
			(error: unknown) => error === searchError
		);
		await assert.rejects(() => ignoredSearch, (error: unknown) => error === searchError);
		assert.deepEqual(store.dump('transaction_native_search_record'), []);
	}
});

test('middleware around guarded transaction stores retains unobserved failures', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(TransactionNoCacheRecord);
	await store.seed(meta, [{ id: 5387, value: 'duplicate-original' }]);
	let ignoredCreate!: Promise<void>;

	await assert.rejects(
		() =>
			store.transaction(async (tx) => {
				const wrapped = createStoreMiddlewareAdapter(tx, []);
				await wrapped.create(meta, 5388, { id: 5388, value: 'must-roll-back' });
				ignoredCreate = wrapped.create(meta, 5387, { id: 5387, value: 'duplicate' });
				void Promise.prototype.then.call(ignoredCreate, undefined, () => undefined);
				await new Promise<void>((resolve) => setImmediate(resolve));
			}),
		ActiveTsConflictError
	);
	await assert.rejects(() => ignoredCreate, ActiveTsConflictError);
	assert.deepEqual(store.dump('transaction_no_cache_record'), [
		{ id: 5387, value: 'duplicate-original' }
	]);
});

test('draining model hooks can handle nested operation failures', async () => {
	type NestedHookData = { id: number; value: string };
	class NestedHookRecord extends Model<NestedHookData> {}
	defineModel<NestedHookData>({ name: 'transaction_nested_operation_hook_record', cache: false })
		.id('id')
		.validate((input) => input as NestedHookData)
		.hooks({
			async afterUpdate({ context: hookContext }) {
				await assert.rejects(
					() => TransactionNoCacheRecord.create(
						{ id: 5391, value: 'duplicate-from-hook' },
						hookContext
					),
					ActiveTsConflictError
				);
			}
		})
		.attach(NestedHookRecord);

	const baseStore = new MemoryStoreAdapter();
	let markReadStarted!: () => void;
	let releaseRead!: () => void;
	const readStarted = new Promise<void>((resolve) => {
		markReadStarted = resolve;
	});
	const readBarrier = new Promise<void>((resolve) => {
		releaseRead = resolve;
	});
	let blockRead = true;
	const store = createStoreMiddlewareAdapter(baseStore, [
		async (middlewareContext, next) => {
			if (
				blockRead &&
				middlewareContext.operation === 'getMany' &&
				middlewareContext.model.name === 'transaction_nested_operation_hook_record'
			) {
				blockRead = false;
				markReadStarted();
				await readBarrier;
			}
			return await next();
		}
	]);
	const context = createActiveTs({ stores: { default: store } });
	await baseStore.seed('transaction_no_cache_record', [{ id: 5391, value: 'duplicate-original' }]);
	await baseStore.seed('transaction_nested_operation_hook_record', [{ id: 5392, value: 'before' }]);
	let ignoredUpdate!: Promise<NestedHookRecord | null>;

	const transaction = context.transaction(async (tx) => {
		const TxRecord = NestedHookRecord.use(tx) as unknown as typeof NestedHookRecord;
		ignoredUpdate = TxRecord.update(5392, { value: 'after' });
	});
	await readStarted;
	releaseRead();
	await transaction;
	await ignoredUpdate;
	assert.deepEqual(baseStore.dump('transaction_no_cache_record'), [
		{ id: 5391, value: 'duplicate-original' }
	]);
	assert.deepEqual(baseStore.dump('transaction_nested_operation_hook_record'), [
		{ id: 5392, value: 'after' }
	]);
});

test('draining sibling operations cannot handle each other failures', async () => {
	const baseStore = new MemoryStoreAdapter();
	let failedCreate!: Promise<TransactionNoCacheRecord>;
	let markReadStarted!: () => void;
	let releaseRead!: () => void;
	const readStarted = new Promise<void>((resolve) => {
		markReadStarted = resolve;
	});
	const readBarrier = new Promise<void>((resolve) => {
		releaseRead = resolve;
	});
	const store = createStoreMiddlewareAdapter(baseStore, [
		async (middlewareContext, next) => {
			if (
				middlewareContext.operation === 'getMany' &&
				Array.isArray(middlewareContext.args[0]) &&
				middlewareContext.args[0][0] === 5402
			) {
				markReadStarted();
				await readBarrier;
				try {
					await failedCreate;
				} catch {
					// A sibling cannot acknowledge this failure after the callback closes.
				}
			}
			return await next();
		}
	]);
	const context = createActiveTs({ stores: { default: store } });
	await baseStore.seed('transaction_no_cache_record', [
		{ id: 5401, value: 'duplicate-original' },
		{ id: 5402, value: 'before' }
	]);
	let ignoredUpdate!: Promise<TransactionNoCacheRecord | null>;

	const transaction = context.transaction(async (tx) => {
		const TxRecord = TransactionNoCacheRecord.use(tx) as unknown as typeof TransactionNoCacheRecord;
		failedCreate = TxRecord.create({ id: 5401, value: 'duplicate' });
		void Promise.prototype.then.call(failedCreate, undefined, () => undefined);
		ignoredUpdate = TxRecord.update(5402, { value: 'after' });
		await readStarted;
	});
	await readStarted;
	await new Promise<void>((resolve) => setImmediate(resolve));
	releaseRead();
	await assert.rejects(() => transaction, ActiveTsConflictError);
	await ignoredUpdate;
	assert.deepEqual(baseStore.dump('transaction_no_cache_record'), [
		{ id: 5401, value: 'duplicate-original' },
		{ id: 5402, value: 'before' }
	]);
});

test('draining child operations cannot handle ancestor failures', async () => {
	const ancestorError = new Error('ancestor transaction operation failed');
	let closed: string | undefined;
	let markChildStarted!: () => void;
	let releaseChild!: () => void;
	const childStarted = new Promise<void>((resolve) => {
		markChildStarted = resolve;
	});
	const childBarrier = new Promise<void>((resolve) => {
		releaseChild = resolve;
	});
	const tracker = createTransactionOperationTracker(() => closed, 'lineage test');
	let ancestor!: Promise<void>;
	let child!: Promise<void>;

	ancestor = tracker.track(async () => {
		child = tracker.track(async () => {
			markChildStarted();
			await childBarrier;
			try {
				await ancestor;
			} catch {
				// A child cannot acknowledge its ancestor after callback settlement.
			}
		});
		void Promise.prototype.then.call(child, undefined, () => undefined);
		await childStarted;
		throw ancestorError;
	});
	void Promise.prototype.then.call(ancestor, undefined, () => undefined);
	await childStarted;
	await new Promise<void>((resolve) => setImmediate(resolve));
	closed = 'callback finished';
	const draining = tracker.waitForPendingOperations();
	releaseChild();
	await child;
	await assert.rejects(() => draining, (error: unknown) => error === ancestorError);
});

test('transaction drains include ignored derived continuations and their child work', async () => {
	let closed: string | undefined;
	let releaseSource!: () => void;
	let releaseContinuation!: () => void;
	const sourceBarrier = new Promise<void>((resolve) => {
		releaseSource = resolve;
	});
	const continuationBarrier = new Promise<void>((resolve) => {
		releaseContinuation = resolve;
	});
	const tracker = createTransactionOperationTracker(() => closed, 'derived continuation test');
	let continuationStarted = false;
	let drainingSettled = false;

	const source = tracker.track(async () => {
		await sourceBarrier;
		return 'source-result';
	});
	const derived = source.then(() => tracker.track(async () => {
		continuationStarted = true;
		await continuationBarrier;
	}));
	void Promise.prototype.then.call(derived, undefined, () => undefined);

	closed = 'callback finished';
	const draining = tracker.waitForPendingOperations();
	void Promise.prototype.then.call(
		draining,
		() => {
			drainingSettled = true;
		},
		() => {
			drainingSettled = true;
		}
	);
	releaseSource();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(continuationStarted, true);
	assert.equal(drainingSettled, false);

	releaseContinuation();
	await draining;
});

test('transaction drains retain failures from ignored derived continuations', async () => {
	const continuationError = new Error('derived transaction continuation failed');
	let closed: string | undefined;
	let releaseSource!: () => void;
	const sourceBarrier = new Promise<void>((resolve) => {
		releaseSource = resolve;
	});
	const tracker = createTransactionOperationTracker(() => closed, 'derived failure test');
	const source = tracker.track(async () => {
		await sourceBarrier;
	});
	const derived = source.then(() => {
		throw continuationError;
	});
	void Promise.prototype.then.call(derived, undefined, () => undefined);

	closed = 'callback finished';
	const draining = tracker.waitForPendingOperations();
	releaseSource();
	await assert.rejects(() => draining, (error: unknown) => error === continuationError);
});

test('transaction drains admit delayed middleware next calls from active operations', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(TransactionNoCacheRecord);
	let markCreateStarted!: () => void;
	let releaseCreate!: () => void;
	const createStarted = new Promise<void>((resolve) => {
		markCreateStarted = resolve;
	});
	const createBarrier = new Promise<void>((resolve) => {
		releaseCreate = resolve;
	});
	let ignoredCreate!: Promise<void>;

	const transaction = store.transaction(async (tx) => {
		const wrapped = createStoreMiddlewareAdapter(tx, [
			async (_middlewareContext, next) => {
				markCreateStarted();
				await createBarrier;
				return await next();
			}
		]);
		ignoredCreate = wrapped.create(meta, 5403, { id: 5403, value: 'committed' });
		await createStarted;
	});
	await createStarted;
	await new Promise<void>((resolve) => setImmediate(resolve));
	releaseCreate();
	await transaction;
	await ignoredCreate;
	assert.deepEqual(store.dump('transaction_no_cache_record'), [
		{ id: 5403, value: 'committed' }
	]);
});

test('retained store and native search middleware preserve transaction close guards', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const storeMeta = context.meta(TransactionNoCacheRecord);
	const searchMeta = context.meta(TransactionNativeSearchRecord);
	let retainedStore!: StoreAdapter;
	let retainedSearch!: ReturnType<typeof createSearchMiddlewareAdapter>;
	let storeMiddlewareRan = false;
	let searchMiddlewareRan = false;

	await store.transaction(async (tx) => {
		retainedStore = createStoreMiddlewareAdapter(tx, [
			async () => {
				storeMiddlewareRan = true;
				return { id: 5404, value: 'short-circuit' };
			}
		]);
		retainedSearch = createSearchMiddlewareAdapter(createNativeSearchAdapter(tx), [
			async () => {
				searchMiddlewareRan = true;
				return { list: [], count: 0, more: false };
			}
		]);
	});

	await assert.rejects(
		() => retainedStore.get(storeMeta, 5404),
		/closed memory store transaction/
	);
	await assert.rejects(
		() => retainedSearch.search(searchMeta, 'retained', {}),
		/closed memory store transaction/
	);
	assert.equal(storeMiddlewareRan, false);
	assert.equal(searchMiddlewareRan, false);
});

test('ignored reused model transactions remain visible to the outer transaction', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	await store.seed('transaction_no_cache_record', [{ id: 5405, value: 'duplicate-original' }]);
	let ignoredNested!: Promise<void>;

	await assert.rejects(
		() => context.transaction(async (tx) => {
			const TxRecord = TransactionNoCacheRecord.use(tx) as unknown as typeof TransactionNoCacheRecord;
			await TxRecord.create({ id: 5406, value: 'must-roll-back' });
			ignoredNested = TxRecord.transaction(
				async () => {
					await TxRecord.create({ id: 5405, value: 'duplicate' });
				},
				{ join: 'reuse' }
			);
			void Promise.prototype.then.call(ignoredNested, undefined, () => undefined);
			await new Promise<void>((resolve) => setImmediate(resolve));
		}),
		ActiveTsConflictError
	);
	await assert.rejects(() => ignoredNested, ActiveTsConflictError);
	assert.deepEqual(store.dump('transaction_no_cache_record'), [
		{ id: 5405, value: 'duplicate-original' }
	]);
});

test('context and middleware transaction wrappers retain ambient preflight failures', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const contextStore = context.store('default');
	const directTransaction = contextStore.transaction;
	const middlewareTransaction = createStoreMiddlewareAdapter(contextStore, []).transaction;
	assert.ok(directTransaction);
	assert.ok(middlewareTransaction);
	const transactions: Array<NonNullable<StoreAdapter['transaction']>> = [
		directTransaction,
		middlewareTransaction
	];

	for (let index = 0; index < transactions.length; index++) {
		let ignoredTransaction!: Promise<unknown>;
		await assert.rejects(
			() => context.transaction(async (tx) => {
				const TxRecord = TransactionNoCacheRecord.use(tx) as unknown as typeof TransactionNoCacheRecord;
				ignoredTransaction = transactions[index](async () => {
					throw new Error('nested callback must not run');
				});
				void Promise.prototype.then.call(ignoredTransaction, undefined, () => undefined);
				await new Promise<void>((resolve) => setImmediate(resolve));
				await TxRecord.create({ id: 5413 + index, value: 'must-roll-back' });
			}),
			/does not expose transactions in this context/
		);
		await assert.rejects(
			() => ignoredTransaction,
			/does not expose transactions in this context/
		);
	}
	assert.deepEqual(store.dump('transaction_no_cache_record'), []);
});

test('store middleware layers preserve context transaction operation tracking', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(TransactionNoCacheRecord);
	await store.seed(meta, [{ id: 5407, value: 'duplicate-original' }]);
	const wrapped = createStoreMiddlewareAdapter(
		createStoreMiddlewareAdapter(context.store('default'), []),
		[]
	);
	let ignoredCreate!: Promise<void>;

	await assert.rejects(
		() => context.transaction(async (tx) => {
			const TxRecord = TransactionNoCacheRecord.use(tx) as unknown as typeof TransactionNoCacheRecord;
			ignoredCreate = wrapped.create(meta, 5407, { id: 5407, value: 'duplicate' });
			void Promise.prototype.then.call(ignoredCreate, undefined, () => undefined);
			await new Promise<void>((resolve) => setImmediate(resolve));
			await TxRecord.create({ id: 5408, value: 'must-roll-back' });
		}),
		ActiveTsConflictError
	);
	await assert.rejects(() => ignoredCreate, ActiveTsConflictError);
	assert.deepEqual(store.dump('transaction_no_cache_record'), [
		{ id: 5407, value: 'duplicate-original' }
	]);
});

test('cache middleware layers preserve context transaction operation tracking', async () => {
	const cacheError = new Error('context cache middleware failed');
	const store = new MemoryStoreAdapter();
	const cache = new MemoryCacheAdapter();
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache },
		defaultCache: 'default'
	});
	const contextCache = context.cache('default');
	assert.ok(contextCache);
	const wrapped = createCacheMiddlewareAdapter(
		createCacheMiddlewareAdapter(contextCache, [
			async () => {
				throw cacheError;
			}
		]),
		[]
	);
	let ignoredCacheRead!: Promise<unknown>;

	await assert.rejects(
		() => context.transaction(async (tx) => {
			const TxRecord = TransactionNoCacheRecord.use(tx) as unknown as typeof TransactionNoCacheRecord;
			ignoredCacheRead = wrapped.getMany(['transaction-cache-carrier']);
			void Promise.prototype.then.call(ignoredCacheRead, undefined, () => undefined);
			await new Promise<void>((resolve) => setImmediate(resolve));
			await TxRecord.create({ id: 5409, value: 'must-roll-back' });
		}),
		(error: unknown) => error === cacheError
	);
	await assert.rejects(() => ignoredCacheRead, (error: unknown) => error === cacheError);
	assert.deepEqual(store.dump('transaction_no_cache_record'), []);
});

test('search middleware layers preserve context transaction operation tracking', async () => {
	const searchError = new Error('context search middleware failed');
	const store = new MemoryStoreAdapter();
	const search = new MemorySearchAdapter();
	const context = createActiveTs({
		stores: { default: store },
		search: { memory: search },
		defaultSearch: 'memory'
	});
	const wrapped = createSearchMiddlewareAdapter(
		createSearchMiddlewareAdapter(context.searchAdapter('memory'), [
			async () => {
				throw searchError;
			}
		]),
		[]
	);
	let ignoredSearch!: Promise<unknown>;

	await assert.rejects(
		() => context.transaction(async (tx) => {
			const TxRecord = TransactionNoCacheRecord.use(tx) as unknown as typeof TransactionNoCacheRecord;
			ignoredSearch = wrapped.search(tx.meta(TransactionMemorySearchRecord), 'ignored', {});
			void Promise.prototype.then.call(ignoredSearch, undefined, () => undefined);
			await new Promise<void>((resolve) => setImmediate(resolve));
			await TxRecord.create({ id: 5410, value: 'must-roll-back' });
		}),
		(error: unknown) => error === searchError
	);
	await assert.rejects(() => ignoredSearch, (error: unknown) => error === searchError);
	assert.deepEqual(store.dump('transaction_no_cache_record'), []);
});

test('context schema and hook boundaries retain ignored transaction failures', async () => {
	const hookError = new Error('direct context hook failed');
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({
		stores: { default: store },
		plugins: [{
			name: 'direct-context-hook-failure',
			hooks: {
				beforeRead() {
					throw hookError;
				}
			}
		}]
	});
	const retainedSchema = context.store('default').schema;
	assert.ok(retainedSchema);
	let ignoredSchema!: Promise<unknown>;

	await assert.rejects(
		() => context.transaction(async (tx) => {
			const TxRecord = TransactionNoCacheRecord.use(tx) as unknown as typeof TransactionNoCacheRecord;
			ignoredSchema = retainedSchema.plan(new Array(1) as any);
			void Promise.prototype.then.call(ignoredSchema, undefined, () => undefined);
			await new Promise<void>((resolve) => setImmediate(resolve));
			await TxRecord.create({ id: 5411, value: 'must-roll-back' });
		}),
		/does not expose schema planning in this context/
	);
	await assert.rejects(() => ignoredSchema, /does not expose schema planning in this context/);

	let ignoredHook!: Promise<unknown>;
	await assert.rejects(
		() => context.transaction(async (tx) => {
			const TxRecord = TransactionNoCacheRecord.use(tx) as unknown as typeof TransactionNoCacheRecord;
			ignoredHook = tx.runHooks('beforeRead', {
				model: tx.meta(TransactionNoCacheRecord),
				operation: 'read'
			});
			void Promise.prototype.then.call(ignoredHook, undefined, () => undefined);
			await new Promise<void>((resolve) => setImmediate(resolve));
			await TxRecord.create({ id: 5412, value: 'must-roll-back' });
		}),
		(error: unknown) => error === hookError
	);
	await assert.rejects(() => ignoredHook, (error: unknown) => error === hookError);
	assert.deepEqual(store.dump('transaction_no_cache_record'), []);
});

test('memory transactions retain failures propagated through ignored Promise chains', async () => {
	const finallyStore = new MemoryStoreAdapter();
	const finallyContext = createActiveTs({ stores: { default: finallyStore } });
	const finallyMeta = finallyContext.meta(TransactionNoCacheRecord);
	await finallyStore.seed(finallyMeta, [
		{ id: 5331, value: 'duplicate-original' },
		{ id: 5332, value: 'must-roll-back' }
	]);
	let finalizerRan = false;

	await assert.rejects(
		() =>
			finallyStore.transaction(async (tx) => {
				const propagated = tx.create(finallyMeta, 5331, { id: 5331, value: 'duplicate' }).finally(() => {
					finalizerRan = true;
				});
				void Promise.prototype.then.call(propagated, undefined, () => undefined);
				await new Promise<void>((resolve) => setImmediate(resolve));
				await tx.update(finallyMeta, 5332, { id: 5332, value: 'updated' });
			}),
		ActiveTsConflictError
	);
	assert.equal(finalizerRan, true);
	assert.deepEqual(finallyStore.dump('transaction_no_cache_record'), [
		{ id: 5331, value: 'duplicate-original' },
		{ id: 5332, value: 'must-roll-back' }
	]);

	const catchStore = new MemoryStoreAdapter();
	const catchContext = createActiveTs({ stores: { default: catchStore } });
	const catchMeta = catchContext.meta(TransactionNoCacheRecord);
	await catchStore.seed(catchMeta, [
		{ id: 5341, value: 'duplicate-original' },
		{ id: 5342, value: 'must-roll-back' }
	]);
	await assert.rejects(
		() =>
			catchStore.transaction(async (tx) => {
				const propagated = tx.create(catchMeta, 5341, { id: 5341, value: 'duplicate' }).catch((error) => {
					throw error;
				});
				void Promise.prototype.then.call(propagated, undefined, () => undefined);
				await new Promise<void>((resolve) => setImmediate(resolve));
				await tx.update(catchMeta, 5342, { id: 5342, value: 'updated' });
			}),
		ActiveTsConflictError
	);
	assert.deepEqual(catchStore.dump('transaction_no_cache_record'), [
		{ id: 5341, value: 'duplicate-original' },
		{ id: 5342, value: 'must-roll-back' }
	]);
});

test('transaction Promise tampering cannot acknowledge a failure before handler attachment', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(TransactionNoCacheRecord);
	await store.seed(meta, [
		{ id: 5351, value: 'duplicate-original' },
		{ id: 5352, value: 'must-roll-back' }
	]);

	await assert.rejects(
		() =>
			store.transaction(async (tx) => {
				const failure = tx.create(meta, 5351, { id: 5351, value: 'duplicate' });
				assert.deepEqual(Object.keys(failure), []);
				Object.defineProperty(failure, 'constructor', { value: null });
				assert.throws(() => failure.catch(() => undefined), TypeError);
				await new Promise<void>((resolve) => setImmediate(resolve));
				await tx.update(meta, 5352, { id: 5352, value: 'updated' });
			}),
		ActiveTsConflictError
	);
	assert.deepEqual(store.dump('transaction_no_cache_record'), [
		{ id: 5351, value: 'duplicate-original' },
		{ id: 5352, value: 'must-roll-back' }
	]);
});

test('transaction drains do not forgive failures observed after callback handles close', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(TransactionNoCacheRecord);
	const earlyError = new ActiveTsConflictError('early transaction operation failed');
	let releasePending!: () => void;
	const pendingBarrier = new Promise<void>((resolve) => {
		releasePending = resolve;
	});
	const adapter: StoreAdapter = {
		kind: 'transaction-drain-probe',
		capabilities: {},
		get: async () => null,
		getMany: async (_model, ids) => ids.map(() => null),
		query: async () => ({ list: [] }),
		create: async (_model, id) => {
			if (id === 5321) return await pendingBarrier;
			throw earlyError;
		},
		update: async () => undefined,
		delete: async () => undefined
	};
	let closed: string | undefined;
	const guarded = createCloseGuardedStoreAdapter(adapter, () => closed, 'test store');
	const pendingCreate = guarded.adapter.create(meta, 5321, { id: 5321, value: 'pending' });
	const earlyFailure = guarded.adapter.create(meta, 5322, { id: 5322, value: 'failed' });
	await new Promise<void>((resolve) => setImmediate(resolve));

	closed = 'callback finished';
	const draining = guarded.waitForPendingOperations();
	await assert.rejects(() => earlyFailure, (error: unknown) => error === earlyError);
	releasePending();
	await pendingCreate;
	await assert.rejects(() => draining, (error: unknown) => error === earlyError);
});

test('transaction commit invalidates cache and publishes outbox events after store commit', async () => {
	const events: string[] = [];
	class OrderedStore extends MemoryStoreAdapter {
		override async transaction<T>(fn: (tx: any) => Promise<T>) {
			events.push('begin');
			const result = await super.transaction(fn);
			events.push('commit');
			return result;
		}
	}
	class OrderedCache extends MemoryCacheAdapter {
		override async deleteMany(keys: string[]) {
			events.push(`cache:${keys.join(',')}`);
			await super.deleteMany(keys);
		}
	}
	const store = new OrderedStore();
	const cache = new OrderedCache();
	const outbox = new MemoryOutboxAdapter();
	let eventId = 0;
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache },
		plugins: [createOutboxPlugin({ outbox, includeData: true, id: () => `event-${++eventId}` })]
	});
	const Record = TransactionCacheRecord.use(context) as unknown as typeof TransactionCacheRecord;
	await store.seed('transaction_cache_record', [{ id: 10, value: 'before' }]);
	await Record.find(10).load();
	cache.resetStats();

	await context.transaction(async (tx) => {
		const TxRecord = TransactionCacheRecord.use(tx) as unknown as typeof TransactionCacheRecord;
		const loaded = await TxRecord.find(10).load();
		loaded!.data.value = 'after';
		await loaded!.save();
		await TxRecord.create({ id: 11, value: 'created' });
		assert.equal(cache.stats.deleteMany, 0);
	});

	assert.equal(cache.stats.deleteMany, 2);
	assert.deepEqual(events, ['begin', 'commit', 'cache:transaction_cache_record:number:10', 'cache:transaction_cache_record:number:11']);
	assert.deepEqual(
		(await outbox.list()).map((event) => [event.modelId, event.operation]),
		[
			[10, 'update'],
			[11, 'create']
		]
	);
});

test('transaction id-based update and delete misses invalidate stale positive cache after commit', async () => {
	const store = new MemoryStoreAdapter();
	const cache = new MemoryCacheAdapter();
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache }
	});
	const Record = TransactionCacheRecord.use(context) as unknown as typeof TransactionCacheRecord;
	const meta = context.meta(TransactionCacheRecord);
	await store.seed(meta, [
		{ id: 12, value: 'update-stale' },
		{ id: 13, value: 'delete-stale' }
	]);
	await Record.find(12).load();
	await Record.find(13).load();
	cache.resetStats();
	await store.delete(meta, 12);
	await store.delete(meta, 13);

	await context.transaction(async (tx) => {
		const TxRecord = TransactionCacheRecord.use(tx) as unknown as typeof TransactionCacheRecord;
		const updated = await TxRecord.update(12, { value: 'ignored' });
		await TxRecord.delete(13);

		assert.equal(updated, null);
		assert.equal(cache.stats.deleteMany, 0);
	});

	assert.equal(cache.stats.deleteMany, 2);
	assert.equal(await Record.find(12).load(), null);
	assert.equal(await Record.find(13).load(), null);
});

test('transaction user afterCommit callbacks run after internal cache and outbox tasks', async () => {
	const events: string[] = [];
	class OrderedCache extends MemoryCacheAdapter {
		override async deleteMany(keys: string[]) {
			events.push(`cache:${keys.join(',')}`);
			await super.deleteMany(keys);
		}
	}
	class OrderedOutbox extends MemoryOutboxAdapter {
		override async append(event: any) {
			events.push(`outbox:${event.operation}:${String(event.modelId)}`);
			await super.append(event);
		}
	}
	const store = new MemoryStoreAdapter();
	const cache = new OrderedCache();
	const outbox = new OrderedOutbox();
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache },
		plugins: [createOutboxPlugin({ outbox, includeData: true, id: () => 'ordered-after-commit-event' })]
	});
	const Record = TransactionCacheRecord.use(context) as unknown as typeof TransactionCacheRecord;
	await store.seed('transaction_cache_record', [{ id: 12, value: 'before' }]);
	await Record.find(12).load();

	await context.transaction(async (tx) => {
		await tx.afterCommit(async () => {
			const loaded = await Record.find(12).load();
			events.push(`user:${loaded?.data.value}`);
		});
		const TxRecord = TransactionCacheRecord.use(tx) as unknown as typeof TransactionCacheRecord;
		const loaded = await TxRecord.find(12).load();
		loaded!.data.value = 'after';
		await loaded!.save();
	});

	assert.deepEqual(events, [
		'cache:transaction_cache_record:number:12',
		'outbox:update:12',
		'user:after'
	]);
});

test('transaction user afterCommit callbacks run even when internal afterCommit fails', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const events: string[] = [];

	await assert.rejects(
		() => context.transaction(async (tx) => {
			await tx.afterCommitInternal(async () => {
				events.push('internal');
				throw new Error('internal afterCommit failed');
			});
			await tx.afterCommit(async () => {
				events.push('user');
				throw new Error('user afterCommit failed');
			});
			return 'committed-result';
		}),
		(error: unknown) => {
			assert.ok(error instanceof ActiveTsCommittedTransactionError);
			assert.equal(error.committed, true);
			assert.equal(error.result, 'committed-result');
			assert.ok(error.cause instanceof AggregateError);
			const errors = error.cause.errors as Error[];
			assert.equal(errors.length, 2);
			assert.match(errors[0]!.message, /internal afterCommit failed/);
			assert.match(errors[1]!.message, /user afterCommit failed/);
			return true;
		}
	);

	assert.deepEqual(events, ['internal', 'user']);
});

test('committed transaction cleanup failures preserve afterCommit failures', async () => {
	class CommittedCleanupFailureStore extends MemoryStoreAdapter {
		override async transaction<T>(fn: (tx: StoreAdapter) => Promise<T>): Promise<T> {
			const result = await super.transaction(fn);
			throw new ActiveTsCommittedTransactionError(
				'transaction committed but cleanup failed: cleanup failed',
				new Error('cleanup failed'),
				result
			);
		}
	}

	const store = new CommittedCleanupFailureStore();
	const context = createActiveTs({ stores: { default: store } });
	const events: string[] = [];

	await assert.rejects(
		() => context.transaction(async (tx) => {
			await tx.afterCommit(async () => {
				events.push('afterCommit');
				throw new Error('afterCommit failed');
			});
			return 'committed';
		}),
		(error: unknown) => {
			assert.ok(error instanceof ActiveTsCommittedTransactionError);
			assert.equal(error.committed, true);
			assert.equal(error.result, 'committed');
			assert.match(error.message, /cleanup failed/);
			assert.match(error.message, /afterCommit tasks also failed/);
			assert.ok(error.cause instanceof AggregateError);
			const causes = error.cause.errors as unknown[];
			assert.equal(causes.length, 2);
			assert.ok(causes[0] instanceof ActiveTsCommittedTransactionError);
			assert.ok(causes[1] instanceof AggregateError);
			assert.match(((causes[0] as ActiveTsCommittedTransactionError).cause as Error).message, /cleanup failed/);
			assert.match(((causes[1] as AggregateError).errors[0] as Error).message, /afterCommit failed/);
			return true;
		}
	);

	assert.deepEqual(events, ['afterCommit']);
});

test('committed transaction errors rebind model results before throwing', async () => {
	class CommittedResultFailureStore extends MemoryStoreAdapter {
		override async transaction<T>(fn: (tx: StoreAdapter) => Promise<T>): Promise<T> {
			const result = await super.transaction(fn);
			throw new ActiveTsCommittedTransactionError(
				'transaction committed but cleanup failed: cleanup failed',
				new Error('cleanup failed'),
				result
			);
		}
	}
	const store = new CommittedResultFailureStore();
	const context = createActiveTs({ stores: { default: store } });
	const Record = TransactionNoCacheRecord.use(context) as unknown as typeof TransactionNoCacheRecord;
	let committedResult:
		| {
				items: Map<string, TransactionNoCacheRecord>;
				nested: Set<TransactionNoCacheRecord>;
		  }
		| undefined;

	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				const TxRecord = TransactionNoCacheRecord.use(tx) as unknown as typeof TransactionNoCacheRecord;
				const first = await TxRecord.create({ id: 1351, value: 'cleanup-result-map' });
				const second = await TxRecord.create({ id: 1352, value: 'cleanup-result-set' });
				await tx.afterCommit(() => {
					throw new Error('afterCommit failed');
				});
				return {
					items: new Map([['first', first]]),
					nested: new Set([second])
				};
			}),
		(error: unknown) => {
			assert.ok(error instanceof ActiveTsCommittedTransactionError);
			assert.match(error.message, /afterCommit tasks also failed/);
			committedResult = error.result as typeof committedResult;
			return true;
		}
	);

	const first = committedResult!.items.get('first')!;
	const [second] = committedResult!.nested;
	first.data.value = 'saved-from-committed-error-map';
	second!.data.value = 'saved-from-committed-error-set';
	await first.save();
	await second!.save();

	assert.equal((await Record.find(1351).load())?.data.value, 'saved-from-committed-error-map');
	assert.equal((await Record.find(1352).load())?.data.value, 'saved-from-committed-error-set');
});

test('afterCommit failures leave captured committed models rebound to the root context', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = TransactionNoCacheRecord.use(context) as unknown as typeof TransactionNoCacheRecord;
	let captured: TransactionNoCacheRecord | undefined;

	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				const TxRecord = TransactionNoCacheRecord.use(tx) as unknown as typeof TransactionNoCacheRecord;
				captured = await TxRecord.create({ id: 1353, value: 'after-commit-failure-captured' });
				await tx.afterCommit(() => {
					throw new Error('afterCommit failed after commit');
				});
				return captured;
			}),
		(error: unknown) => {
			assert.ok(error instanceof ActiveTsCommittedTransactionError);
			assert.equal(error.committed, true);
			assert.equal(error.result, captured);
			assert.ok(error.cause instanceof AggregateError);
			assert.match(((error.cause.errors as Error[])[0] as Error).message, /afterCommit failed after commit/);
			return true;
		}
	);

	captured!.data.value = 'saved-after-after-commit-failure';
	await captured!.save();
	assert.equal((await Record.find(1353).load())?.data.value, 'saved-after-after-commit-failure');
});

test('afterCommit callbacks can save committed models that were not returned', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = TransactionNoCacheRecord.use(context) as unknown as typeof TransactionNoCacheRecord;

	const result = await context.transaction(async (tx) => {
		const TxRecord = TransactionNoCacheRecord.use(tx) as unknown as typeof TransactionNoCacheRecord;
		const created = await TxRecord.create({ id: 1354, value: 'before-after-commit' });
		await tx.afterCommit(async () => {
			created.data.value = 'saved-inside-after-commit';
			await created.save();
		});
		return 'committed';
	});

	assert.equal(result, 'committed');
	assert.equal((await Record.find(1354).load())?.data.value, 'saved-inside-after-commit');
});

test('user-thrown committed transaction errors still roll back callback writes', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = TransactionCacheRecord.use(context) as unknown as typeof TransactionCacheRecord;
	const events: string[] = [];

	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				const TxRecord = TransactionCacheRecord.use(tx) as unknown as typeof TransactionCacheRecord;
				await TxRecord.create({ id: 16, value: 'rolled-back' });
				await tx.afterCommit(() => {
					events.push('afterCommit');
				});
				await tx.afterRollback(() => {
					events.push('afterRollback');
				});
				throw new ActiveTsCommittedTransactionError('user-level committed marker', new Error('user marker'), 'not committed');
			}),
		/user-level committed marker/
	);

	assert.equal(await Record.find(16).load(), null);
	assert.deepEqual(events, ['afterRollback']);
});

test('transactional outbox append failures roll back domain writes', async () => {
	const store = new MemoryStoreAdapter();
	let appendCalls = 0;
	let transactionalCalls = 0;
	const outbox = {
		append: async () => {
			appendCalls++;
		},
		appendTransactional: async () => {
			transactionalCalls++;
			throw new Error('transactional outbox down');
		}
	};
	const context = createActiveTs({
		stores: { default: store },
		plugins: [createOutboxPlugin({ outbox, includeData: true, id: () => 'transactional-outbox-fail' })]
	});

	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				const TxRecord = TransactionIsolationRecord.use(tx) as unknown as typeof TransactionIsolationRecord;
				await TxRecord.create({ id: 18, value: 'rolled-back-with-outbox' });
			}),
		/transactional outbox down/
	);

	assert.equal(transactionalCalls, 1);
	assert.equal(appendCalls, 0);
	assert.deepEqual(store.dump('transaction_isolation_record'), []);
});

test('store outbox adapter writes events inside the domain transaction', async () => {
	const store = new MemoryStoreAdapter();
	const storeOutbox = new StoreOutboxAdapter({ store: 'default' });
	let outboxId = 0;
	const context = createActiveTs({
		stores: { default: store },
		plugins: [createOutboxPlugin({ outbox: storeOutbox, includeData: true, id: () => `store-outbox-${++outboxId}` })]
	});

	await context.transaction(async (tx) => {
		const TxRecord = TransactionIsolationRecord.use(tx) as unknown as typeof TransactionIsolationRecord;
		await TxRecord.create({ id: 19, value: 'committed-with-outbox' });
		assert.deepEqual(store.dump('active_ts_outbox_event'), []);
	});

	assert.deepEqual(store.dump('transaction_isolation_record'), [{ id: 19, value: 'committed-with-outbox' }]);
	assert.deepEqual(
		(await storeOutbox.list()).map((event) => [event.id, event.modelId, event.data?.value]),
		[['store-outbox-1', 19, 'committed-with-outbox']]
	);

	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				const TxRecord = TransactionIsolationRecord.use(tx) as unknown as typeof TransactionIsolationRecord;
				await TxRecord.create({ id: 20, value: 'rolled-back-with-outbox' });
				throw new Error('rollback store outbox');
			}),
		/rollback store outbox/
	);

	assert.deepEqual(store.dump('transaction_isolation_record'), [{ id: 19, value: 'committed-with-outbox' }]);
	assert.deepEqual((await storeOutbox.list()).map((event) => event.id), ['store-outbox-1']);
});

test('store outbox adapter validates its store during plugin setup', () => {
	const outbox = new StoreOutboxAdapter({ store: 'missing_outbox_store' });
	assert.throws(
		() =>
			createActiveTs({
				stores: { default: new MemoryStoreAdapter() },
				plugins: [createOutboxPlugin({ outbox, includeData: true })]
			}),
		/Store adapter "missing_outbox_store" is not registered/
	);
});

test('store outbox adapter requeue rolls back batched inserts on failure', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const outbox = new StoreOutboxAdapter({ context });
	await outbox.append({
		id: 'existing-requeue-event',
		model: 'transaction_isolation_record',
		modelId: 21,
		operation: 'create',
		data: { id: 21, value: 'already queued' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});

	await assert.rejects(
		() =>
			outbox.requeue([
				{
					id: 'new-requeue-event',
					model: 'transaction_isolation_record',
					modelId: 22,
					operation: 'create',
					data: { id: 22, value: 'should roll back' },
					createdAt: '2026-05-13T00:00:01.000Z'
				},
				{
					id: 'existing-requeue-event',
					model: 'transaction_isolation_record',
					modelId: 21,
					operation: 'create',
					data: { id: 21, value: 'duplicate' },
					createdAt: '2026-05-13T00:00:02.000Z'
				}
			]),
		/already exists/
	);

	assert.deepEqual((await outbox.list()).map((event) => event.id), ['existing-requeue-event']);
});

test('store outbox adapter requeue compensates inserts without transaction support', async () => {
	const base = new MemoryStoreAdapter();
	const nonTransactional: StoreAdapter = {
		kind: 'non-transaction-store-outbox',
		capabilities: { ...base.capabilities, transaction: false },
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: (model, plan, options) => base.query(model, plan, options),
		create: (model, id, data) => base.create(model, id, data),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: (model, id, options) => base.delete(model, id, options),
		aggregate: (model, plan) => base.aggregate(model, plan)
	};
	const context = createActiveTs({ stores: { default: nonTransactional } });
	const outbox = new StoreOutboxAdapter({ context });
	await outbox.append({
		id: 'existing-nontransactional-requeue-event',
		model: 'transaction_isolation_record',
		modelId: 23,
		operation: 'create',
		data: { id: 23, value: 'already queued' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});

	const originalSlice = Array.prototype.slice;
	const originalReverse = Array.prototype.reverse;
	let requeueError: unknown;
	Object.defineProperty(Array.prototype, 'slice', {
		configurable: true,
		value() {
			throw new Error('patched Array.slice');
		}
	});
	Object.defineProperty(Array.prototype, 'reverse', {
		configurable: true,
		value() {
			throw new Error('patched Array.reverse');
		}
	});
	try {
		try {
			await outbox.requeue([
				{
					id: 'new-nontransactional-requeue-event',
					model: 'transaction_isolation_record',
					modelId: 24,
					operation: 'create',
					data: { id: 24, value: 'should be compensated' },
					createdAt: '2026-05-13T00:00:01.000Z'
				},
				{
					id: 'existing-nontransactional-requeue-event',
					model: 'transaction_isolation_record',
					modelId: 23,
					operation: 'create',
					data: { id: 23, value: 'duplicate' },
					createdAt: '2026-05-13T00:00:02.000Z'
				}
			]);
		} catch (error) {
			requeueError = error;
		}
	} finally {
		Object.defineProperty(Array.prototype, 'slice', { configurable: true, value: originalSlice });
		Object.defineProperty(Array.prototype, 'reverse', { configurable: true, value: originalReverse });
	}

	assert.match(String((requeueError as Error | undefined)?.message), /already exists/);
	assert.deepEqual((await outbox.list()).map((event) => event.id), ['existing-nontransactional-requeue-event']);
});

test('transaction retries isolate deferred tasks to the final attempt', async () => {
	const retry = new Error('retry transaction attempt');
	class RetryingStore extends MemoryStoreAdapter {
		override async transaction<T>(fn: (tx: StoreAdapter) => Promise<T>) {
			try {
				await super.transaction(async (tx) => {
					await fn(tx);
					throw retry;
				});
			} catch (error) {
				if (error !== retry) throw error;
			}
			return await super.transaction(fn);
		}
	}
	const store = new RetryingStore();
	const outbox = new MemoryOutboxAdapter();
	const commitAttempts: number[] = [];
	const rollbackAttempts: number[] = [];
	let eventId = 0;
	let attempts = 0;
	const context = createActiveTs({
		stores: { default: store },
		plugins: [createOutboxPlugin({ outbox, includeData: true, id: () => `retry-event-${++eventId}` })]
	});

	await context.transaction(async (tx) => {
		const attempt = ++attempts;
		await tx.afterCommit(() => {
			commitAttempts.push(attempt);
		});
		await tx.afterRollback(() => {
			rollbackAttempts.push(attempt);
		});
		const TxRecord = TransactionIsolationRecord.use(tx) as unknown as typeof TransactionIsolationRecord;
		await TxRecord.create({ id: attempt, value: `attempt-${attempt}` });
	});

	assert.equal(attempts, 2);
	assert.deepEqual(commitAttempts, [2]);
	assert.deepEqual(rollbackAttempts, [1]);
	assert.deepEqual(store.dump('transaction_isolation_record'), [{ id: 2, value: 'attempt-2' }]);
	assert.deepEqual(
		(await outbox.list()).map((event) => [event.id, event.modelId, event.data?.value]),
		[['retry-event-2', 2, 'attempt-2']]
	);
});

test('transaction cache invalidation failures reject after the store commits', async () => {
	const events: string[] = [];
	const warnings: string[] = [];
	const originalWarn = console.warn;
	class FailingInvalidateCache extends MemoryCacheAdapter {
		override async deleteMany(keys: string[]) {
			events.push(`delete:${keys.join(',')}`);
			throw new Error('cache unavailable');
		}
	}
	const store = new MemoryStoreAdapter();
	const cache = new FailingInvalidateCache();
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache }
	});
	const Record = TransactionCacheRecord.use(context) as unknown as typeof TransactionCacheRecord;
	await store.seed('transaction_cache_record', [{ id: 12, value: 'before' }]);
	await Record.find(12).load();
	console.warn = (message?: unknown) => warnings.push(String(message));
	try {
		await assert.rejects(
			() =>
				context.transaction(async (tx) => {
					const TxRecord = TransactionCacheRecord.use(tx) as unknown as typeof TransactionCacheRecord;
						const loaded = await TxRecord.find(12).load();
						loaded!.data.value = 'after';
						await loaded!.save();
					}),
				(error: unknown) => {
					assert.ok(error instanceof ActiveTsCommittedTransactionError);
					assert.equal(error.committed, true);
					assert.equal(error.result, undefined);
					assert.ok(error.cause instanceof AggregateError);
					assert.match(error.message, /afterCommit task failed/);
					assert.match((error.cause.errors[0] as Error).message, /cache unavailable/);
					return true;
				}
		);
	} finally {
		console.warn = originalWarn;
	}

	assert.deepEqual(events, ['delete:transaction_cache_record:number:12']);
	assert.match(warnings[0], /afterCommit task failed.*cache unavailable/);
	assert.deepEqual(store.dump('transaction_cache_record'), [{ id: 12, value: 'after' }]);
});

test('transaction write hook failures are not reported as committed side effects', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = TransactionFailingHookRecord.use(context) as unknown as typeof TransactionFailingHookRecord;

	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				const TxRecord = TransactionFailingHookRecord.use(tx) as unknown as typeof TransactionFailingHookRecord;
				await TxRecord.create({ id: 13, value: 'rollback' });
			}),
		(error: unknown) => {
			assert.ok(!(error instanceof ActiveTsCommittedWriteError));
			assert.match(error instanceof Error ? error.message : String(error), /after create hook failed/);
			return true;
		}
	);

	assert.equal(await Record.find(13).load(), null);
});

test('transaction reads bypass stale positive and negative cache entries after writes', async () => {
	const store = new MemoryStoreAdapter();
	const cache = new MemoryCacheAdapter();
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache }
	});
	const Record = TransactionCacheRecord.use(context) as unknown as typeof TransactionCacheRecord;
	await store.seed('transaction_cache_record', [{ id: 20, value: 'before' }]);
	await Record.find(20).load();
	await Record.find(21).load();
	assert.equal(cache.stats.setMany, 2);

	await context.transaction(async (tx) => {
		const TxRecord = TransactionCacheRecord.use(tx) as unknown as typeof TransactionCacheRecord;
		const loaded = await TxRecord.find(20).load();
		loaded!.data.value = 'after';
		await loaded!.save();
		await TxRecord.create({ id: 21, value: 'created' });

		assert.equal((await TxRecord.find(20).load())?.data.value, 'after');
		assert.equal((await TxRecord.find(21).load())?.data.value, 'created');
		assert.equal(cache.stats.deleteMany, 0);
	});

	assert.equal((await Record.find(20).load())?.data.value, 'after');
	assert.equal((await Record.find(21).load())?.data.value, 'created');
});

test('transaction reads preserve their store snapshot and reject concurrent external writes', async () => {
	const store = new MemoryStoreAdapter();
	const cache = new MemoryCacheAdapter();
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache }
	});
	const meta = context.meta(TransactionCacheRecord);
	await store.seed(meta, [{ id: 22, value: 'snapshot' }]);

	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				const TxRecord = TransactionCacheRecord.use(tx) as unknown as typeof TransactionCacheRecord;
				assert.equal((await TxRecord.find(22).load())?.data.value, 'snapshot');
				await store.update(meta, 22, { id: 22, value: 'outside' });
				await cache.setMany([['transaction_cache_record:number:22', { id: 22, value: 'outside' }]], { ttl: 60 });

				assert.equal((await TxRecord.find(22).load())?.data.value, 'snapshot');
				assert.equal(cache.stats.getMany, 0);
			}),
		(error: unknown) =>
			error instanceof ActiveTsConflictError && /transactional point read/.test(error.message)
	);
	assert.deepEqual(store.dump(meta.name), [{ id: 22, value: 'outside' }]);
});

test('transaction contexts share entity cache key collision guards with the root context', async () => {
	const store = new MemoryStoreAdapter();
	const cache = new MemoryCacheAdapter();
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache },
		cacheKey: ({ id }) => id === 1 || id === 2 ? 'transaction-shared-cache-key' : `cache:${String(id)}`
	});
	const Record = TransactionCacheRecord.use(context) as unknown as typeof TransactionCacheRecord;
	await store.seed('transaction_cache_record', [
		{ id: 1, value: 'one' },
		{ id: 2, value: 'two' }
	]);

	await context.transaction(async (tx) => {
		const TxRecord = TransactionCacheRecord.use(tx) as unknown as typeof TransactionCacheRecord;
		const row = await TxRecord.find(2).load();
		assert.equal(row?.data.value, 'two');
		row!.data.value = 'two-updated';
		await row!.save();
	});

	await assert.rejects(
		() => Record.find(1).load(),
		/Entity cache key "transaction-shared-cache-key" is already associated with "transaction_cache_record:number:2"/
	);
});

test('rolled-back transactions discard staged entity cache key ownership', async () => {
	const store = new MemoryStoreAdapter();
	const cache = new MemoryCacheAdapter();
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache },
		cacheKey: ({ id }) => id === 1 || id === 2 ? 'rolled-back-shared-cache-key' : `cache:${String(id)}`
	});
	const Record = TransactionCacheRecord.use(context) as unknown as typeof TransactionCacheRecord;

	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				const TxRecord = TransactionCacheRecord.use(tx) as unknown as typeof TransactionCacheRecord;
				await TxRecord.create({ id: 1, value: 'rolled-back' });
				throw new Error('rollback transaction');
			}),
		/rollback transaction/
	);

	await Record.create({ id: 2, value: 'committed' });

	assert.deepEqual(store.dump('transaction_cache_record'), [{ id: 2, value: 'committed' }]);
	assert.equal((await Record.find(2).load())?.data.value, 'committed');
});

test('transaction ambient scope routes default and root-bound static APIs through the transaction context', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const RootRecord = TransactionIsolationRecord.use(context) as unknown as typeof TransactionIsolationRecord;
	const retainedFind = RootRecord.find(41);
	const previous = getCurrentDefaultContext();
	setDefaultContext(context);
	try {
		await assert.rejects(
			() =>
				context.transaction(async () => {
					await TransactionIsolationRecord.create({ id: 40, value: 'default-context' });
					await RootRecord.create({ id: 41, value: 'root-bound-context' });
					assert.equal((await retainedFind.load())?.data.value, 'root-bound-context');
					throw new Error('rollback ambient scope');
				}),
			/rollback ambient scope/
		);
	} finally {
		if (previous) setDefaultContext(previous);
		else clearDefaultContext();
	}

	assert.deepEqual(store.dump('transaction_isolation_record'), []);
});

test('transaction ambient scope routes previously loaded root instances through the transaction context', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = TransactionIsolationRecord.use(context) as unknown as typeof TransactionIsolationRecord;
	await Record.create({ id: 50, value: 'before' });
	const loaded = await Record.find(50).load();
	assert.ok(loaded);

	await assert.rejects(
		() =>
			context.transaction(async () => {
				loaded.data.value = 'rolled-back';
				await loaded.save();
				assert.equal((await Record.find(50).load())?.data.value, 'rolled-back');
				throw new Error('rollback loaded instance');
			}),
		/rollback loaded instance/
	);

	assert.equal((await Record.find(50).load())?.data.value, 'before');
	await assert.rejects(
		() => loaded.save(),
		/closed transaction context after it rolled back/
	);
	assert.equal((await Record.find(50).load())?.data.value, 'before');
});

test('rolled-back transactions stale retained root instances deleted in the transaction', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = TransactionIsolationRecord.use(context) as unknown as typeof TransactionIsolationRecord;
	await Record.create({ id: 51, value: 'before-delete' });
	const loaded = await Record.find(51).load();
	assert.ok(loaded);

	await assert.rejects(
		() =>
			context.transaction(async () => {
				await loaded.delete();
				assert.equal(await Record.find(51).load(), null);
				throw new Error('rollback loaded delete');
			}),
		/rollback loaded delete/
	);

	assert.equal((await Record.find(51).load())?.data.value, 'before-delete');
	await assert.rejects(
		() => loaded.delete(),
		/closed transaction context after it rolled back/
	);
	assert.equal((await Record.find(51).load())?.data.value, 'before-delete');
});

test('transaction retries do not stale retained root instances from retried attempts', async () => {
	const retry = new Error('retry retained root instance');
	class RetryingStore extends MemoryStoreAdapter {
		override async transaction<T>(fn: (tx: StoreAdapter) => Promise<T>) {
			try {
				await super.transaction(async (tx) => {
					await fn(tx);
					throw retry;
				});
			} catch (error) {
				if (error !== retry) throw error;
			}
			return await super.transaction(fn);
		}
	}
	const store = new RetryingStore();
	const context = createActiveTs({ stores: { default: store } });
	const Record = TransactionIsolationRecord.use(context) as unknown as typeof TransactionIsolationRecord;
	await Record.create({ id: 52, value: 'before-retry' });
	const loaded = await Record.find(52).load();
	assert.ok(loaded);
	let attempts = 0;

	await context.transaction(async () => {
		attempts++;
		loaded.data.value = `retry-${attempts}`;
		await loaded.save();
	});

	assert.equal(attempts, 2);
	assert.equal((await Record.find(52).load())?.data.value, 'retry-2');
	loaded.data.value = 'after-retry-commit';
	await loaded.save();
	assert.equal((await Record.find(52).load())?.data.value, 'after-retry-commit');
});

test('transaction ambient scope rejects model APIs bound to unrelated contexts', async () => {
	const primaryStore = new MemoryStoreAdapter();
	const otherStore = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: primaryStore } });
	const otherContext = createActiveTs({ stores: { default: otherStore } });
	const OtherRecord = TransactionIsolationRecord.use(otherContext) as unknown as typeof TransactionIsolationRecord;

	await assert.rejects(
		() =>
			context.transaction(async () => {
				await OtherRecord.create({ id: 60, value: 'outside-context' });
			}),
		/different active-ts context while a transaction is active/
	);

	assert.deepEqual(primaryStore.dump('transaction_isolation_record'), []);
	assert.deepEqual(otherStore.dump('transaction_isolation_record'), []);
});

test('transaction ambient scope rejects nested root context transactions', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });

	await assert.rejects(
		() =>
			context.transaction(async () => {
				await context.transaction(async () => {
					throw new Error('nested transaction should not run');
				});
			}),
		/Cannot start transactions inside a transaction/
	);
});

test('transaction ambient scope can explicitly reuse the active transaction context', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = TransactionIsolationRecord.use(context) as unknown as typeof TransactionIsolationRecord;
	const events: string[] = [];

	const result = await context.transaction(async () => {
		await Record.create({ id: 6101, value: 'outer' });
		const nested = await context.transaction(
			async (tx) => {
				await tx.afterCommit(() => {
					events.push('nested commit');
				});
				return await Record.find(6101).load();
			},
			{ join: 'reuse' }
		);
		nested!.data.value = 'nested';
		await nested!.save();
		return nested!.data.value;
	});

	assert.equal(result, 'nested');
	assert.deepEqual(events, ['nested commit']);
	assert.equal((await Record.find(6101).load())?.data.value, 'nested');
});

test('memory store savepoints isolate rollback while preserving later parent operations', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(TransactionNoCacheRecord);
	const childError = new Error('rollback child');
	let releaseChild!: () => void;
	let childStarted!: () => void;
	const childBarrier = new Promise<void>((resolve) => {
		releaseChild = resolve;
	});
	const started = new Promise<void>((resolve) => {
		childStarted = resolve;
	});
	let retainedChild!: StoreAdapter;

	await store.transaction(async (tx) => {
		assert.equal(tx.capabilities?.savepoint, true);
		assert.ok(tx.savepoint);
		await tx.create(meta, 6110, { id: 6110, value: 'parent-before' });
		const child = tx.savepoint!(async (savepointTx) => {
			retainedChild = savepointTx;
			await savepointTx.create(meta, 6111, { id: 6111, value: 'child-rollback' });
			await savepointTx.savepoint!(async (nestedTx) => {
				await nestedTx.create(meta, 6112, { id: 6112, value: 'nested-rollback' });
			});
			childStarted();
			await childBarrier;
			throw childError;
		});
		await started;
		const parentAfter = tx.create(meta, 6113, { id: 6113, value: 'parent-after' });
		releaseChild();
		await assert.rejects(() => child, (error: unknown) => error === childError);
		await parentAfter;
		assert.equal(await tx.get(meta, 6111), null);
		await assert.rejects(
			() => retainedChild.get(meta, 6110),
			/closed memory store savepoint transaction adapter/
		);
	});

	assert.deepEqual(store.dump('transaction_no_cache_record'), [
		{ id: 6110, value: 'parent-before' },
		{ id: 6113, value: 'parent-after' }
	]);
});

test('memory store savepoints drain ignored child failures before release', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(TransactionNoCacheRecord);
	let ignored!: Promise<void>;

	await store.transaction(async (tx) => {
		await tx.create(meta, 6114, { id: 6114, value: 'existing' });
		await assert.rejects(
			() => tx.savepoint!(async (savepointTx) => {
				await savepointTx.create(meta, 6115, { id: 6115, value: 'rolled-back' });
				ignored = savepointTx.create(meta, 6114, { id: 6114, value: 'duplicate' });
				void Promise.prototype.then.call(ignored, undefined, () => undefined);
			}),
			ActiveTsConflictError
		);
		await assert.rejects(() => ignored, ActiveTsConflictError);
		await tx.create(meta, 6116, { id: 6116, value: 'parent-continues' });
	});

	assert.deepEqual(store.dump('transaction_no_cache_record'), [
		{ id: 6114, value: 'existing' },
		{ id: 6116, value: 'parent-continues' }
	]);
});

test('memory savepoint child handles preserve their boundary across async lineages', { timeout: 2_000 }, async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(TransactionNoCacheRecord);
	let provideChild!: (adapter: StoreAdapter) => void;
	const childHandle = new Promise<StoreAdapter>((resolve) => {
		provideChild = resolve;
	});
	const externalCreate = childHandle.then(async (child) => {
		await child.create(meta, 6150, { id: 6150, value: 'external-child' });
		return await child.get(meta, 6150);
	});

	await store.transaction(async (tx) => {
		await tx.savepoint!(async (child) => {
			provideChild(child);
			assert.deepEqual(await externalCreate, { id: 6150, value: 'external-child' });
		});
	});

	assert.deepEqual(store.dump('transaction_no_cache_record'), [
		{ id: 6150, value: 'external-child' }
	]);
});

test('memory savepoints serialize nested siblings without blocking the active sibling', { timeout: 2_000 }, async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(TransactionNoCacheRecord);

	await store.transaction(async (tx) => {
		await tx.savepoint!(async (outer) => {
			const first = outer.savepoint!(async (child) => {
				await child.create(meta, 6151, { id: 6151, value: 'first-sibling' });
			});
			const second = outer.savepoint!(async (child) => {
				await child.create(meta, 6152, { id: 6152, value: 'second-sibling' });
			});
			await Promise.all([first, second]);
		});
	});

	assert.deepEqual(store.dump('transaction_no_cache_record'), [
		{ id: 6151, value: 'first-sibling' },
		{ id: 6152, value: 'second-sibling' }
	]);
});

test('nested savepoints treat ancestor handles as part of the active child boundary', { timeout: 2_000 }, async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(TransactionNoCacheRecord);

	await store.transaction(async (tx) => {
		await tx.savepoint!(async (outer) => {
			await assert.rejects(
				() => outer.savepoint!(async () => {
					await outer.create(meta, 6154, { id: 6154, value: 'nested-rollback' });
					throw new Error('rollback nested child');
				}),
				/rollback nested child/
			);
			assert.equal(await outer.get(meta, 6154), null);
			await outer.create(meta, 6155, { id: 6155, value: 'outer-continues' });
		});
	});

	assert.deepEqual(store.dump('transaction_no_cache_record'), [
		{ id: 6155, value: 'outer-continues' }
	]);
});

test('savepoints drain ancestor-handle operations before rollback', { timeout: 2_000 }, async () => {
	const backing = new MemoryStoreAdapter();
	let markWriteStarted!: () => void;
	let releaseWrite!: () => void;
	const writeStarted = new Promise<void>((resolve) => {
		markWriteStarted = resolve;
	});
	const writeBarrier = new Promise<void>((resolve) => {
		releaseWrite = resolve;
	});
	const store = createStoreMiddlewareAdapter(backing, [
		async (middlewareContext, next) => {
			if (middlewareContext.operation === 'create' && middlewareContext.args[0] === 6153) {
				markWriteStarted();
				await writeBarrier;
			}
			return await next();
		}
	]);
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(TransactionNoCacheRecord);

	await store.transaction!(async (tx) => {
		const child = tx.savepoint!(async () => {
			void tx.create(meta, 6153, { id: 6153, value: 'must-roll-back' });
			await writeStarted;
			throw new Error('rollback after ancestor write');
		});
		await writeStarted;
		let settled = false;
		void child.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			}
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(settled, false);
		releaseWrite();
		await assert.rejects(() => child, /rollback after ancestor write/);
	});

	assert.deepEqual(backing.dump('transaction_no_cache_record'), []);
});

test('transaction savepoint join mode commits successful child state and rolls back failed child state', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = TransactionNoCacheRecord.use(context) as unknown as typeof TransactionNoCacheRecord;
	const events: string[] = [];
	let retainedRolledBackModel: TransactionNoCacheRecord | undefined;

	await context.transaction(async (tx) => {
		await Record.create({ id: 6117, value: 'parent' });
		const saved = await context.transaction(
			async (savepointContext) => {
				assert.notEqual(savepointContext, tx);
				await savepointContext.afterCommit(() => {
					events.push('child commit');
				});
				await Record.create({ id: 6118, value: 'child-commit' });
				return await Record.find(6118).load();
			},
			{ join: 'savepoint' }
		);
		saved!.data.value = 'child-commit-updated';
		await saved!.save();

		await assert.rejects(
			() => context.transaction(
				async (savepointContext) => {
					await savepointContext.afterRollback(() => {
						events.push('child rollback');
					});
					retainedRolledBackModel = await Record.create({ id: 6119, value: 'child-rollback' });
					throw new Error('rollback savepoint');
				},
				{ join: 'savepoint' }
			),
			/rollback savepoint/
		);
		assert.deepEqual(events, ['child rollback']);
		await assert.rejects(() => retainedRolledBackModel!.save(), /closed transaction context/);
		await Record.create({ id: 6120, value: 'parent-after' });
	});

	assert.deepEqual(events, ['child rollback', 'child commit']);
	assert.deepEqual(store.dump('transaction_no_cache_record'), [
		{ id: 6117, value: 'parent' },
		{ id: 6118, value: 'child-commit-updated' },
		{ id: 6120, value: 'parent-after' }
	]);
});

test('released savepoint afterRollback tasks follow the parent rollback', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = TransactionNoCacheRecord.use(context) as unknown as typeof TransactionNoCacheRecord;
	const events: string[] = [];

	await assert.rejects(
		() =>
			context.transaction(async () => {
				await context.transaction(
					async (savepointContext) => {
						await savepointContext.afterRollback(() => {
							events.push('released child rollback');
						});
						await Record.create({ id: 6121, value: 'released-child' });
					},
					{ join: 'savepoint' }
				);
				throw new Error('rollback parent');
			}),
		/rollback parent/
	);
	assert.deepEqual(events, ['released child rollback']);
	assert.equal(await Record.find(6121).load(), null);
});

test('savepoints merge only committed cache invalidations and outbox work', async () => {
	const store = new MemoryStoreAdapter();
	const cache = new MemoryCacheAdapter();
	const outbox = new MemoryOutboxAdapter();
	let eventId = 0;
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache },
		plugins: [createOutboxPlugin({ outbox, includeData: true, id: () => `savepoint-event-${++eventId}` })]
	});
	const Record = TransactionCacheRecord.use(context) as unknown as typeof TransactionCacheRecord;
	await store.seed('transaction_cache_record', [{ id: 6125, value: 'before' }]);
	await Record.find(6125).load();
	cache.resetStats();

	await context.transaction(async () => {
		await assert.rejects(
			() => context.transaction(
				async () => {
					const record = await Record.find(6125).load();
					record!.data.value = 'rolled-back-child';
					await record!.save();
					throw new Error('rollback child side effects');
				},
				{ join: 'savepoint' }
			),
			/rollback child side effects/
		);
		assert.equal((await Record.find(6125).load())?.data.value, 'before');
	});

	assert.equal(cache.stats.deleteMany, 0);
	assert.deepEqual(await outbox.list(), []);
	assert.equal((await Record.find(6125).load())?.data.value, 'before');

	await context.transaction(async () => {
		await context.transaction(
			async () => {
				const record = await Record.find(6125).load();
				record!.data.value = 'committed-child';
				await record!.save();
			},
			{ join: 'savepoint' }
		);
		assert.equal(cache.stats.deleteMany, 0);
		assert.deepEqual(await outbox.list(), []);
	});

	assert.equal(cache.stats.deleteMany, 1);
	assert.equal((await Record.find(6125).load())?.data.value, 'committed-child');
	assert.deepEqual(
		(await outbox.list()).map((event) => [event.modelId, event.operation]),
		[[6125, 'update']]
	);
});

test('context-bound store savepoints isolate cache, outbox, hooks, and models', async () => {
	const store = new MemoryStoreAdapter();
	const cache = new MemoryCacheAdapter();
	const outbox = new MemoryOutboxAdapter();
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache },
		plugins: [createOutboxPlugin({ outbox, id: () => 'context-store-savepoint-event' })]
	});
	const Record = TransactionCacheRecord.use(context) as unknown as typeof TransactionCacheRecord;
	await store.seed('transaction_cache_record', [{ id: 6154, value: 'before' }]);
	await Record.find(6154).load();
	cache.resetStats();
	const events: string[] = [];
	let leaked!: TransactionCacheRecord;

	await context.transaction(async () => {
		await assert.rejects(
			() => context.store('default').savepoint!(async () => {
				await context.afterCommit(() => {
					events.push('child-commit');
				});
				await context.afterRollback(() => {
					events.push('child-rollback');
				});
				leaked = (await Record.find(6154).load())!;
				leaked.data.value = 'rolled-back';
				await leaked.save();
				throw new Error('rollback context store savepoint');
			}),
			/rollback context store savepoint/
		);
		assert.deepEqual(events, ['child-rollback']);
		await assert.rejects(() => leaked.save(), /closed transaction context/);
	});

	assert.deepEqual(events, ['child-rollback']);
	assert.equal(cache.stats.deleteMany, 0);
	assert.deepEqual(await outbox.list(), []);
	assert.equal((await Record.find(6154).load())?.data.value, 'before');
});

test('savepoints deduplicate parent and child cache invalidations', async () => {
	const store = new MemoryStoreAdapter();
	const cache = new MemoryCacheAdapter();
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache }
	});
	const Record = TransactionCacheRecord.use(context) as unknown as typeof TransactionCacheRecord;
	await store.seed('transaction_cache_record', [{ id: 6155, value: 'before' }]);
	await Record.find(6155).load();
	cache.resetStats();

	await context.transaction(async () => {
		const parentRecord = (await Record.find(6155).load())!;
		parentRecord.data.value = 'parent';
		await parentRecord.save();
		await context.transaction(
			async () => {
				const childRecord = (await Record.find(6155).load())!;
				childRecord.data.value = 'child';
				await childRecord.save();
			},
			{ join: 'savepoint' }
		);
	});

	assert.equal(cache.stats.deleteMany, 1);
	assert.equal((await Record.find(6155).load())?.data.value, 'child');
});

test('malformed early savepoint completion makes the parent transaction rollback-only', async () => {
	const backing = new MemoryStoreAdapter();
	const malformed: StoreAdapter = {
		kind: 'early-savepoint-memory',
		capabilities: { ...backing.capabilities, transaction: true, savepoint: false },
		get: (model, id, options) => backing.get(model, id, options),
		getMany: (model, ids, options) => backing.getMany(model, ids, options),
		query: (model, plan, options) => backing.query(model, plan, options),
		aggregate: (model, plan) => backing.aggregate(model, plan),
		create: (model, id, data, options) => backing.create(model, id, data, options),
		update: (model, id, data, options) => backing.update(model, id, data, options),
		delete: (model, id, options) => backing.delete(model, id, options),
		transaction: (fn, options) => backing.transaction(async (tx) => {
			const malformedTx: StoreAdapter = {
				...tx,
				capabilities: { ...(tx.capabilities ?? {}), transaction: false, savepoint: true },
				savepoint: async <T>(callback: (child: StoreAdapter) => Promise<T>) => {
					void callback(tx);
					await new Promise<void>((resolve) => setImmediate(resolve));
					return 'early' as T;
				}
			};
			return await fn(malformedTx);
		}, options)
	};
	const context = createActiveTs({ stores: { default: malformed } });
	const Record = TransactionNoCacheRecord.use(context) as unknown as typeof TransactionNoCacheRecord;

	await assert.rejects(
		() => context.transaction(async () => {
			await assert.rejects(
				() => context.transaction(
					async () => {
						await new Promise<void>((resolve) => setImmediate(resolve));
						await Record.create({ id: 6156, value: 'late-child' });
						throw new Error('late child failure');
					},
					{ join: 'savepoint' }
				),
				/completed a savepoint before its callback settled/
			);
			await Record.create({ id: 6157, value: 'parent-after-caught-child' });
		}),
		/completed a savepoint before its callback settled/
	);

	assert.deepEqual(backing.dump('transaction_no_cache_record'), []);
});

test('savepoints reject callbacks invoked after an adapter reports completion', async () => {
	const backing = new MemoryStoreAdapter();
	let childCallbackCalls = 0;
	const malformed: StoreAdapter = {
		kind: 'late-callback-savepoint-memory',
		capabilities: { ...backing.capabilities, transaction: true, savepoint: false },
		get: (model, id, options) => backing.get(model, id, options),
		getMany: (model, ids, options) => backing.getMany(model, ids, options),
		query: (model, plan, options) => backing.query(model, plan, options),
		aggregate: (model, plan) => backing.aggregate(model, plan),
		create: (model, id, data, options) => backing.create(model, id, data, options),
		update: (model, id, data, options) => backing.update(model, id, data, options),
		delete: (model, id, options) => backing.delete(model, id, options),
		transaction: (fn, options) => backing.transaction(async (tx) => {
			const malformedTx: StoreAdapter = {
				...tx,
				capabilities: { ...(tx.capabilities ?? {}), transaction: false, savepoint: true },
				savepoint: async <T>(callback: (child: StoreAdapter) => Promise<T>) => {
					setImmediate(() => {
						void callback(tx);
					});
					return 'early' as T;
				}
			};
			return await fn(malformedTx);
		}, options)
	};
	const context = createActiveTs({ stores: { default: malformed } });
	const meta = context.meta(TransactionNoCacheRecord);

	await assert.rejects(
		() => context.transaction(async () => {
			await assert.rejects(
				() => context.transaction(
					async (child) => {
						childCallbackCalls++;
						await child.store('default').create(meta, 6160, { id: 6160, value: 'late-child' });
					},
					{ join: 'savepoint' }
				),
				/completed a savepoint without running the callback/
			);
			await new Promise<void>((resolve) => setImmediate(resolve));
			await context.store('default').create(meta, 6161, { id: 6161, value: 'parent-continues' });
		}),
		/ran a savepoint callback after the savepoint settled/
	);

	assert.equal(childCallbackCalls, 0);
	assert.deepEqual(backing.dump('transaction_no_cache_record'), []);
});

test('savepoints reject same-turn callbacks after adapter promise settlement', async () => {
	const { backing, store } = createMalformedMemorySavepointStore(
		'same-turn-late-savepoint-callback-memory',
		(tx) => <T>(callback: (child: StoreAdapter) => Promise<T>) => new Promise<T>((resolve) => {
			resolve('early' as T);
			void callback(tx);
		})
	);
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(TransactionNoCacheRecord);
	let callbackCalls = 0;

	for (const readOnly of [false, true]) {
		await assert.rejects(
			() => context.transaction(async () => {
				await context.transaction(
					async (child) => {
						callbackCalls++;
						await child.store('default').create(meta, 6181, { id: 6181, value: 'late-child' });
					},
					{ join: 'savepoint' }
				);
			}, { readOnly }),
			/ran a savepoint callback after the savepoint settled/
		);
	}

	assert.equal(callbackCalls, 0);
	assert.deepEqual(backing.dump('transaction_no_cache_record'), []);
});

test('low-level savepoints reject same-turn callbacks after adapter promise settlement', async () => {
	const { backing, store } = createMalformedMemorySavepointStore(
		'low-level-same-turn-late-savepoint-callback-memory',
		(tx) => <T>(callback: (child: StoreAdapter) => Promise<T>) => new Promise<T>((resolve) => {
			resolve('early' as T);
			void callback(tx);
		})
	);
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(TransactionNoCacheRecord);
	let callbackCalls = 0;

	await assert.rejects(
		() => context.store('default').transaction!(async (tx) => {
			await tx.savepoint!(async (child) => {
				callbackCalls++;
				await child.create(meta, 6182, { id: 6182, value: 'late-child' });
			});
		}),
		/savepoint adapter ran its callback after the savepoint settled/
	);

	assert.equal(callbackCalls, 0);
	assert.deepEqual(backing.dump('transaction_no_cache_record'), []);
});

test('savepoint adapter rejection waits for callback work and makes the parent rollback-only', async () => {
	const backing = new MemoryStoreAdapter();
	let markWriteStarted!: () => void;
	let releaseWrite!: () => void;
	const writeStarted = new Promise<void>((resolve) => {
		markWriteStarted = resolve;
	});
	const writeBarrier = new Promise<void>((resolve) => {
		releaseWrite = resolve;
	});
	let childCompletion!: Promise<unknown>;
	const malformed: StoreAdapter = {
		kind: 'rejecting-savepoint-memory',
		capabilities: { ...backing.capabilities, transaction: true, savepoint: false },
		get: (model, id, options) => backing.get(model, id, options),
		getMany: (model, ids, options) => backing.getMany(model, ids, options),
		query: (model, plan, options) => backing.query(model, plan, options),
		aggregate: (model, plan) => backing.aggregate(model, plan),
		create: (model, id, data, options) => backing.create(model, id, data, options),
		update: (model, id, data, options) => backing.update(model, id, data, options),
		delete: (model, id, options) => backing.delete(model, id, options),
		transaction: (fn, options) => backing.transaction(async (tx) => {
			const malformedTx: StoreAdapter = {
				...tx,
				capabilities: { ...(tx.capabilities ?? {}), transaction: false, savepoint: true },
				savepoint: async <T>(callback: (child: StoreAdapter) => Promise<T>) => {
					const delayedChild: StoreAdapter = {
						...tx,
						create: async (...args) => {
							markWriteStarted();
							await writeBarrier;
							await tx.create(...args);
						}
					};
					childCompletion = callback(delayedChild);
					throw new Error('adapter rejected before callback settled');
				}
			};
			return await fn(malformedTx);
		}, options)
	};
	const context = createActiveTs({ stores: { default: malformed } });
	const meta = context.meta(TransactionNoCacheRecord);
	const releaseDelayedWrite = Promise.prototype.then.call(writeStarted, () => releaseWrite()) as Promise<void>;

	await assert.rejects(
		() => context.transaction(async () => {
			await assert.rejects(
				() => context.transaction(
					async (child) => {
						await child.store('default').create(meta, 6162, { id: 6162, value: 'late-child' });
					},
					{ join: 'savepoint' }
				),
				/rejected a savepoint before its callback settled/
			);
			await releaseDelayedWrite;
			await childCompletion;
			await context.store('default').create(meta, 6163, { id: 6163, value: 'parent-after-child' });
		}),
		/rejected a savepoint before its callback settled/
	);

	assert.deepEqual(backing.dump('transaction_no_cache_record'), []);
});

test('low-level context savepoints reject callbacks invoked after adapter completion', async () => {
	const backing = new MemoryStoreAdapter();
	let childCallbackCalls = 0;
	const malformed: StoreAdapter = {
		kind: 'low-level-late-callback-savepoint-memory',
		capabilities: { ...backing.capabilities, transaction: true, savepoint: false },
		get: (model, id, options) => backing.get(model, id, options),
		getMany: (model, ids, options) => backing.getMany(model, ids, options),
		query: (model, plan, options) => backing.query(model, plan, options),
		aggregate: (model, plan) => backing.aggregate(model, plan),
		create: (model, id, data, options) => backing.create(model, id, data, options),
		update: (model, id, data, options) => backing.update(model, id, data, options),
		delete: (model, id, options) => backing.delete(model, id, options),
		transaction: (fn, options) => backing.transaction(async (tx) => fn({
			...tx,
			capabilities: { ...(tx.capabilities ?? {}), transaction: false, savepoint: true },
			savepoint: async <T>(callback: (child: StoreAdapter) => Promise<T>) => {
				setImmediate(() => {
					void callback(tx);
				});
				return 'early' as T;
			}
		}), options)
	};
	const context = createActiveTs({ stores: { default: malformed } });
	const meta = context.meta(TransactionNoCacheRecord);

	await assert.rejects(
		() => context.store('default').transaction!(async (tx) => {
			await assert.rejects(
				() => tx.savepoint!(async (child) => {
					childCallbackCalls++;
					await child.create(meta, 6164, { id: 6164, value: 'late-child' });
				}),
				/savepoint adapter completed without running its callback/
			);
			await new Promise<void>((resolve) => setImmediate(resolve));
			await tx.create(meta, 6165, { id: 6165, value: 'parent-continues' });
		}),
		/savepoint adapter ran its callback after the savepoint settled/
	);

	assert.equal(childCallbackCalls, 0);
	assert.deepEqual(backing.dump('transaction_no_cache_record'), []);
});

test('low-level malformed savepoint rejection poisons the root transaction', async () => {
	const backing = new MemoryStoreAdapter();
	let markWriteStarted!: () => void;
	let releaseWrite!: () => void;
	const writeStarted = new Promise<void>((resolve) => {
		markWriteStarted = resolve;
	});
	const writeBarrier = new Promise<void>((resolve) => {
		releaseWrite = resolve;
	});
	const malformed: StoreAdapter = {
		kind: 'low-level-rejecting-savepoint-memory',
		capabilities: { ...backing.capabilities, transaction: true, savepoint: false },
		get: (model, id, options) => backing.get(model, id, options),
		getMany: (model, ids, options) => backing.getMany(model, ids, options),
		query: (model, plan, options) => backing.query(model, plan, options),
		aggregate: (model, plan) => backing.aggregate(model, plan),
		create: (model, id, data, options) => backing.create(model, id, data, options),
		update: (model, id, data, options) => backing.update(model, id, data, options),
		delete: (model, id, options) => backing.delete(model, id, options),
		transaction: (fn, options) => backing.transaction(async (tx) => fn({
			...tx,
			capabilities: { ...(tx.capabilities ?? {}), transaction: false, savepoint: true },
			savepoint: async <T>(callback: (child: StoreAdapter) => Promise<T>) => {
				void callback({
					...tx,
					create: async (...args) => {
						markWriteStarted();
						await writeBarrier;
						await tx.create(...args);
					}
				});
				throw new Error('low-level adapter rejected before callback settled');
			}
		}), options)
	};
	const context = createActiveTs({ stores: { default: malformed } });
	const meta = context.meta(TransactionNoCacheRecord);
	const releaseDelayedWrite = Promise.prototype.then.call(writeStarted, () => releaseWrite()) as Promise<void>;

	await assert.rejects(
		() => context.store('default').transaction!(async (tx) => {
			await assert.rejects(
				() => tx.savepoint!(async (child) => {
					await child.create(meta, 6166, { id: 6166, value: 'late-child' });
				}),
				/savepoint adapter rejected before its callback settled/
			);
			await releaseDelayedWrite;
			await tx.create(meta, 6167, { id: 6167, value: 'parent-after-child' });
		}),
		/savepoint adapter rejected before its callback settled/
	);

	assert.deepEqual(backing.dump('transaction_no_cache_record'), []);
});

test('savepoints reject adapters that swallow callback failures', async () => {
	const { backing, store } = createMalformedMemorySavepointStore(
		'swallowed-savepoint-callback-memory',
		(tx) => async <T>(callback: (child: StoreAdapter) => Promise<T>) => {
			try {
				return await callback(tx);
			} catch {
				return 'swallowed' as T;
			}
		}
	);
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(TransactionNoCacheRecord);

	await assert.rejects(
		() => context.transaction(async () => {
			await assert.rejects(
				() => context.transaction(
					async (child) => {
						await child.store('default').create(meta, 6168, { id: 6168, value: 'failed-child' });
						throw new Error('callback failure swallowed by adapter');
					},
					{ join: 'savepoint' }
				),
				/completed a savepoint after its callback failed/
			);
			await context.store('default').create(meta, 6169, { id: 6169, value: 'parent-after-child' });
		}),
		/completed a savepoint after its callback failed/
	);

	assert.deepEqual(backing.dump('transaction_no_cache_record'), []);
});

test('low-level savepoints poison transactions when adapters swallow callback failures', async () => {
	const { backing, store } = createMalformedMemorySavepointStore(
		'low-level-swallowed-savepoint-callback-memory',
		(tx) => async <T>(callback: (child: StoreAdapter) => Promise<T>) => {
			try {
				return await callback(tx);
			} catch {
				return 'swallowed' as T;
			}
		}
	);
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(TransactionNoCacheRecord);

	await assert.rejects(
		() => context.store('default').transaction!(async (tx) => {
			await assert.rejects(
				() => tx.savepoint!(async (child) => {
					await child.create(meta, 6170, { id: 6170, value: 'failed-child' });
					throw new Error('low-level callback failure swallowed by adapter');
				}),
				/savepoint adapter completed after its callback failed/
			);
			await tx.create(meta, 6171, { id: 6171, value: 'parent-after-child' });
		}),
		/savepoint adapter completed after its callback failed/
	);

	assert.deepEqual(backing.dump('transaction_no_cache_record'), []);
});

test('savepoints reject duplicate callbacks and make the parent rollback-only', async () => {
	const { backing, store } = createMalformedMemorySavepointStore(
		'duplicate-savepoint-callback-memory',
		(tx) => async <T>(callback: (child: StoreAdapter) => Promise<T>) => {
			const result = await callback(tx);
			void callback(tx);
			return result;
		}
	);
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(TransactionNoCacheRecord);
	let callbackCalls = 0;

	await assert.rejects(
		() => context.transaction(async () => {
			await assert.rejects(
				() => context.transaction(
					async (child) => {
						callbackCalls++;
						await child.store('default').create(meta, 6172, { id: 6172, value: 'first-child' });
					},
					{ join: 'savepoint' }
				),
				/ran a savepoint callback more than once/
			);
			await context.store('default').create(meta, 6173, { id: 6173, value: 'parent-after-child' });
		}),
		/ran a savepoint callback more than once/
	);

	assert.equal(callbackCalls, 1);
	assert.deepEqual(backing.dump('transaction_no_cache_record'), []);
});

test('low-level duplicate savepoint callbacks poison the root transaction', async () => {
	const { backing, store } = createMalformedMemorySavepointStore(
		'low-level-duplicate-savepoint-callback-memory',
		(tx) => async <T>(callback: (child: StoreAdapter) => Promise<T>) => {
			const result = await callback(tx);
			void callback(tx);
			return result;
		}
	);
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(TransactionNoCacheRecord);
	let callbackCalls = 0;

	await assert.rejects(
		() => context.store('default').transaction!(async (tx) => {
			await assert.rejects(
				() => tx.savepoint!(async (child) => {
					callbackCalls++;
					await child.create(meta, 6174, { id: 6174, value: 'first-child' });
				}),
				/savepoint adapter ran its callback more than once/
			);
			await tx.create(meta, 6175, { id: 6175, value: 'parent-after-child' });
		}),
		/savepoint adapter ran its callback more than once/
	);

	assert.equal(callbackCalls, 1);
	assert.deepEqual(backing.dump('transaction_no_cache_record'), []);
});

test('savepoints observe callback failures while malformed adapters settle', async () => {
	const { backing, store } = createMalformedMemorySavepointStore(
		'delayed-swallowed-savepoint-callback-memory',
		(tx) => async <T>(callback: (child: StoreAdapter) => Promise<T>) => {
			void callback(tx);
			await new Promise<void>((resolve) => setTimeout(resolve, 20));
			return 'swallowed' as T;
		}
	);
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(TransactionNoCacheRecord);

	await assert.rejects(
		() => context.transaction(async () => {
			await context.transaction(
				async (child) => {
					await child.store('default').create(meta, 6176, { id: 6176, value: 'failed-child' });
					throw new Error('delayed callback failure swallowed by adapter');
				},
				{ join: 'savepoint' }
			);
		}),
		/completed a savepoint after its callback failed/
	);

	assert.deepEqual(backing.dump('transaction_no_cache_record'), []);
});

test('unconfirmed savepoint rollback tasks wait for physical root rollback', async () => {
	const events: string[] = [];
	const { backing, store } = createMalformedMemorySavepointStore(
		'unconfirmed-savepoint-rollback-memory',
		(tx) => async <T>(callback: (child: StoreAdapter) => Promise<T>) => {
			void callback(tx);
			await new Promise<void>((resolve) => setImmediate(resolve));
			return 'early' as T;
		},
		() => events.push('physical-root-rollback')
	);
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(TransactionNoCacheRecord);

	await assert.rejects(
		() => context.transaction(async (tx) => {
			await tx.afterRollback(() => {
				events.push('parent-afterRollback');
			});
			await assert.rejects(
				() => tx.transaction(
					async (child) => {
						await child.afterRollback(() => {
							events.push('child-afterRollback');
						});
						await child.store('default').create(meta, 6177, { id: 6177, value: 'child-write' });
						await new Promise<void>((resolve) => setImmediate(resolve));
					},
					{ join: 'savepoint' }
				),
				/completed a savepoint before its callback settled/
			);
			events.push('root-callback-finished');
		}),
		/completed a savepoint before its callback settled/
	);

	assert.deepEqual(events, [
		'root-callback-finished',
		'physical-root-rollback',
		'parent-afterRollback',
		'child-afterRollback'
	]);
	assert.deepEqual(backing.dump('transaction_no_cache_record'), []);
});

test('duplicate savepoint protocol errors outrank later adapter rejections', async () => {
	const events: string[] = [];
	const { backing, store } = createMalformedMemorySavepointStore(
		'duplicate-then-reject-savepoint-memory',
		(tx) => async <T>(callback: (child: StoreAdapter) => Promise<T>) => {
			await callback(tx);
			try {
				await callback(tx);
			} catch {
				// Simulate an adapter that swallows the duplicate callback rejection.
			}
			throw new Error('adapter rejected after duplicate callback');
		},
		() => events.push('physical-root-rollback')
	);
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(TransactionNoCacheRecord);

	await assert.rejects(
		() => context.transaction(async (tx) => {
			await tx.afterRollback(() => {
				events.push('parent-afterRollback');
			});
			await assert.rejects(
				() => tx.transaction(
					async (child) => {
						await child.afterRollback(() => {
							events.push('child-afterRollback');
						});
						await child.store('default').create(meta, 6180, { id: 6180, value: 'child-write' });
					},
					{ join: 'savepoint' }
				),
				/callback more than once/
			);
			events.push('root-callback-finished');
		}),
		/callback more than once/
	);

	assert.deepEqual(events, [
		'root-callback-finished',
		'physical-root-rollback',
		'parent-afterRollback',
		'child-afterRollback'
	]);
	assert.deepEqual(backing.dump('transaction_no_cache_record'), []);
});

test('low-level duplicate savepoint protocol errors outrank later adapter rejections', async () => {
	const { backing, store } = createMalformedMemorySavepointStore(
		'low-level-duplicate-then-reject-savepoint-memory',
		(tx) => async <T>(callback: (child: StoreAdapter) => Promise<T>) => {
			await callback(tx);
			try {
				await callback(tx);
			} catch {
				// Simulate an adapter that swallows the duplicate callback rejection.
			}
			throw new Error('adapter rejected after duplicate callback');
		}
	);
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(TransactionNoCacheRecord);
	let callbackCalls = 0;

	await assert.rejects(
		() => context.store('default').transaction!(async (tx) => {
			await assert.rejects(
				() => tx.savepoint!(async (child) => {
					callbackCalls++;
					await child.create(meta, 6183, { id: 6183, value: 'child-write' });
				}),
				/callback more than once/
			);
			await tx.create(meta, 6184, { id: 6184, value: 'parent-write' });
		}),
		/callback more than once/
	);

	assert.equal(callbackCalls, 1);
	assert.deepEqual(backing.dump('transaction_no_cache_record'), []);
});

test('parent rollback task failures retain child rollback task failures', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const primaryError = new Error('rollback transaction');
	const childTaskError = new Error('child rollback task failed');
	const parentTaskError = new Error('parent rollback task failed');

	await assert.rejects(
		() => context.transaction(async (tx) => {
			await tx.afterRollback(() => {
				throw parentTaskError;
			});
			await tx.transaction(
				async (child) => {
					await child.afterRollback(() => {
						throw childTaskError;
					});
					throw primaryError;
				},
				{ join: 'savepoint' }
			);
		}),
		(error: any) => {
			const afterRollbackError = error.afterRollbackError;
			assert.equal(error, primaryError);
			assert.ok(afterRollbackError instanceof AggregateError);
			assert.deepEqual(afterRollbackError.errors, [childTaskError, parentTaskError]);
			return true;
		}
	);
});

test('store middleware and context-bound transaction handles preserve savepoints', async () => {
	const backing = new MemoryStoreAdapter();
	const operations: string[] = [];
	const store = createStoreMiddlewareAdapter(backing, [
		async (middlewareContext, next) => {
			operations.push(middlewareContext.operation);
			return await next();
		}
	]);
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(TransactionNoCacheRecord);
	const direct = context.store('default');
	let retainedSavepoint!: StoreAdapter;

	assert.equal(direct.capabilities?.savepoint, false);
	await direct.transaction!(async (tx) => {
		assert.equal(tx.capabilities?.savepoint, true);
		assert.ok(tx.savepoint);
		await tx.savepoint!(async (savepointTx) => {
			retainedSavepoint = savepointTx;
			await savepointTx.create(meta, 6122, { id: 6122, value: 'direct-savepoint' });
		});
		await assert.rejects(
			() => retainedSavepoint.get(meta, 6122),
			/closed.*savepoint/
		);
		await assert.rejects(() => tx.savepoint!(null as any), /callback must be a function/);
	});

	await assert.rejects(
		() => context.transaction(async () => {
			await context.transaction(
				async () => {
					await context.store('default').create(meta, 6123, { id: 6123, value: 'rolled-back' });
					throw new Error('middleware savepoint rollback');
				},
				{ join: 'savepoint' }
			);
		}),
		/middleware savepoint rollback/
	);

	assert.deepEqual(backing.dump('transaction_no_cache_record'), [
		{ id: 6122, value: 'direct-savepoint' }
	]);
	assert.ok(operations.includes('create'));
});

test('store middleware operations can re-enter transaction savepoints', async () => {
	const backing = new MemoryStoreAdapter();
	let context!: ActiveContext;
	let reentered = false;
	const store = createStoreMiddlewareAdapter(backing, [
		async (middlewareContext, next) => {
			if (middlewareContext.operation === 'create' && !reentered) {
				reentered = true;
				await context.transaction(
					async (child) => {
						const meta = child.meta(TransactionNoCacheRecord);
						await child.store('default').create(meta, 6178, { id: 6178, value: 'savepoint-child' });
					},
					{ join: 'savepoint' }
				);
			}
			return await next();
		}
	]);
	context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(TransactionNoCacheRecord);
	let timeout!: ReturnType<typeof setTimeout>;
	const timedOut = new Promise<never>((_resolve, reject) => {
		timeout = setTimeout(() => reject(new Error('reentrant savepoint timed out')), 1_000);
	});

	try {
		await Promise.race([
			context.transaction(async (tx) => {
				await tx.store('default').create(meta, 6179, { id: 6179, value: 'parent-operation' });
			}),
			timedOut
		]);
	} finally {
		clearTimeout(timeout);
	}

	assert.deepEqual(backing.dump('transaction_no_cache_record'), [
		{ id: 6178, value: 'savepoint-child' },
		{ id: 6179, value: 'parent-operation' }
	]);
});

test('read-only transactions reject writes while allowing reads', async () => {
	const store = new MemoryStoreAdapter();
	Object.defineProperty(store, 'datastoreProjectId', {
		value: 'read-only-project',
		enumerable: true,
		configurable: true
	});
	const context = createActiveTs({ stores: { default: store } });
	const Record = TransactionIsolationRecord.use(context) as unknown as typeof TransactionIsolationRecord;
	await Record.create({ id: 6102, value: 'existing' });

	await context.transaction(
		async (tx) => {
			assert.equal(tx.store('default').datastoreProjectId, 'read-only-project');
			assert.equal((await Record.find(6102).load())?.data.value, 'existing');
			await context.transaction(
				async (savepoint) => {
					assert.equal(savepoint.store('default').datastoreProjectId, 'read-only-project');
					assert.equal((await Record.find(6102).load())?.data.value, 'existing');
					await assert.rejects(
						() => Record.create({ id: 6124, value: 'blocked-savepoint-write' }),
						/read-only/
					);
				},
				{ join: 'savepoint', readOnly: true }
			);
		},
		{ readOnly: true }
	);

	await assert.rejects(
		() =>
			context.transaction(
				async () => {
					await Record.create({ id: 6103, value: 'blocked' });
				},
				{ readOnly: true }
			),
		/read-only/
	);

	assert.equal(await Record.find(6103).load(), null);
});

test('read-only transactions reject model writes before write hooks run', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = TransactionReadOnlyHookRecord.use(context) as unknown as typeof TransactionReadOnlyHookRecord;
	await Record.create({ id: 6120, value: 'existing' });
	transactionReadOnlyHookEvents = [];

	await assert.rejects(
		() =>
			context.transaction(
				async () => {
					await Record.create({ id: 6121, value: 'blocked-create' });
				},
				{ readOnly: true }
			),
		/read-only/
	);
	assert.deepEqual(transactionReadOnlyHookEvents, []);

	await assert.rejects(
		() =>
			context.transaction(
				async () => {
					const loaded = await Record.find(6120).load();
					loaded!.data.value = 'blocked-save';
					await loaded!.save();
				},
				{ readOnly: true }
			),
		/read-only/
	);
	assert.deepEqual(transactionReadOnlyHookEvents, []);

	await assert.rejects(
		() =>
			context.transaction(
				async () => {
					const loaded = await Record.find(6120).load();
					await loaded!.delete();
				},
				{ readOnly: true }
			),
		/read-only/
	);
	assert.deepEqual(transactionReadOnlyHookEvents, []);

	await assert.rejects(
		() =>
			context.transaction(
				async () => {
					await Record.delete(6120);
				},
				{ readOnly: true }
			),
		/read-only/
	);
	assert.deepEqual(transactionReadOnlyHookEvents, []);
	assert.equal((await Record.find(6120).load())?.data.value, 'existing');
	assert.equal(await Record.find(6121).load(), null);
});

test('read-only transactions reject explicit cache invalidation', async () => {
	const store = new MemoryStoreAdapter();
	const cache = new MemoryCacheAdapter();
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache }
	});
	const Record = TransactionCacheRecord.use(context) as unknown as typeof TransactionCacheRecord;
	const meta = context.meta(TransactionCacheRecord);
	await store.seed(meta, [{ id: 6106, value: 'cached' }]);
	await Record.find(6106).load();
	cache.resetStats();

	await assert.rejects(
		() =>
			context.transaction(
				async (tx) => {
					await tx.invalidate(tx.meta(TransactionCacheRecord), 6106);
				},
				{ readOnly: true }
			),
		/read-only transaction/
	);

	assert.equal(cache.stats.deleteMany, 0);
	assert.deepEqual(
		await cache.getMany(['transaction_cache_record:number:6106']),
		[{ id: 6106, value: 'cached' }]
	);
});

test('memory transactions reject unsupported low-level transaction options', async () => {
	const store = new MemoryStoreAdapter();

	await assert.rejects(
		() => store.transaction(async () => undefined, { isolation: 'serializable' }),
		/memory store transaction options\.isolation is not supported/
	);
	await assert.rejects(
		() => store.transaction(async () => undefined, { timeoutMs: 100 }),
		/memory store transaction options\.timeoutMs is not supported/
	);
	await assert.rejects(
		() => store.transaction(async () => undefined, { native: { vendor: true } }),
		/memory store transaction options\.native is not supported/
	);
});

test('model transaction helper scopes the transaction to the model store', async () => {
	const primary = new MemoryStoreAdapter();
	const audit = new MemoryStoreAdapter();
	const context = createActiveTs({
		stores: { default: primary, audit },
		defaultStore: 'default'
	});
	const AuditRecord = TransactionAuditRecord.use(context) as unknown as typeof TransactionAuditRecord;

	await AuditRecord.transaction(async (tx) => {
		const TxAuditRecord = TransactionAuditRecord.use(tx) as unknown as typeof TransactionAuditRecord;
		await TxAuditRecord.create({ id: 6104, value: 'audit' });
		await tx.transaction(
			async (nestedTx) => {
				const NestedAuditRecord = TransactionAuditRecord.use(nestedTx) as unknown as typeof TransactionAuditRecord;
				await NestedAuditRecord.create({ id: 6105, value: 'nested-audit' });
			},
			{ join: 'reuse' }
		);
	});

	assert.deepEqual(primary.dump('transaction_cache_audit_record'), []);
	assert.deepEqual(audit.dump('transaction_cache_audit_record'), [
		{ id: 6104, value: 'audit' },
		{ id: 6105, value: 'nested-audit' }
	]);
});

test('transaction ambient scope routes root context direct reads through the transaction context', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });

	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				const TxRecord = TransactionIsolationRecord.use(tx) as unknown as typeof TransactionIsolationRecord;
				await TxRecord.create({ id: 61, value: 'uncommitted-direct-read' });
				assert.equal(
					(await context.loadByIdFresh(TransactionIsolationRecord, 61))?.data.value,
					'uncommitted-direct-read'
				);
				throw new Error('rollback direct read');
			}),
		/rollback direct read/
	);

	assert.deepEqual(store.dump('transaction_isolation_record'), []);
});

test('transaction ambient scope routes root context direct store access through the transaction context', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(TransactionIsolationRecord);

	await assert.rejects(
		() =>
			context.transaction(async () => {
				await context.store(meta.store).create(meta, 63, { id: 63, value: 'direct-store-create' });
				throw new Error('rollback direct store');
			}),
		/rollback direct store/
	);

	assert.deepEqual(store.dump('transaction_isolation_record'), []);
});

test('transaction ambient scope routes root context non-selected store access to read-only transaction stores', async () => {
	const primary = new MemoryStoreAdapter();
	const audit = new MemoryStoreAdapter();
	const context = createActiveTs({
		stores: { default: primary, audit }
	});
	const meta = context.meta(TransactionAuditRecord);

	await assert.rejects(
		() =>
			context.transaction(async () => {
				await context.store('audit').create(meta, 1, { id: 1, value: 'audit' });
			}),
		/writes to store "audit" are not atomic/
	);

	assert.deepEqual(audit.dump('transaction_cache_audit_record'), []);
});

test('transaction-scoped store handles do not advertise nested transactions', async () => {
	const primaryStore = new MemoryStoreAdapter();
	const auditStore = new MemoryStoreAdapter();
	Object.defineProperty(primaryStore, 'datastoreProjectId', {
		value: 'primary-project',
		enumerable: true,
		configurable: true
	});
	Object.defineProperty(auditStore, 'datastoreProjectId', {
		value: 'audit-project',
		enumerable: true,
		configurable: true
	});
	const context = createActiveTs({
		stores: { default: primaryStore, audit: auditStore }
	});

	await context.transaction(async (tx) => {
		const primary = tx.store('default');
		const secondary = tx.store('audit');
		assert.equal(primary.datastoreProjectId, 'primary-project');
		assert.equal(secondary.datastoreProjectId, 'audit-project');
		assert.equal(primary.capabilities?.transaction, false);
		assert.equal(primary.transaction, undefined);
		assert.equal(secondary.capabilities?.transaction, false);
		assert.equal(secondary.transaction, undefined);
	});
});

test('retained root store handles expose ambient transaction capabilities', async () => {
	const primaryStore = new MemoryStoreAdapter();
	const auditStore = new MemoryStoreAdapter();
	Object.defineProperty(primaryStore, 'datastoreProjectId', {
		value: 'retained-primary-project',
		enumerable: true,
		configurable: true
	});
	Object.defineProperty(auditStore, 'datastoreProjectId', {
		value: 'retained-audit-project',
		enumerable: true,
		configurable: true
	});
	const context = createActiveTs({
		stores: { default: primaryStore, audit: auditStore }
	});
	const retainedPrimary = context.store('default');
	const retainedSecondary = context.store('audit');

	assert.equal(retainedPrimary.capabilities?.transaction, true);
	assert.equal(typeof retainedPrimary.transaction, 'function');
	assert.equal(retainedPrimary.capabilities?.savepoint, false);
	assert.equal(retainedPrimary.savepoint, undefined);
	assert.equal(retainedPrimary.datastoreProjectId, 'retained-primary-project');
	assert.equal(retainedSecondary.datastoreProjectId, 'retained-audit-project');

	await context.transaction(async () => {
		assert.equal(retainedPrimary.capabilities?.transaction, false);
		assert.equal(retainedPrimary.transaction, undefined);
		assert.equal(retainedPrimary.capabilities?.savepoint, true);
		assert.equal(typeof retainedPrimary.savepoint, 'function');
		assert.equal(retainedSecondary.capabilities?.transaction, false);
		assert.equal(retainedSecondary.transaction, undefined);
		assert.equal(retainedSecondary.capabilities?.savepoint, false);
		assert.equal(retainedSecondary.savepoint, undefined);
		assert.equal(retainedPrimary.datastoreProjectId, 'retained-primary-project');
		assert.equal(retainedSecondary.datastoreProjectId, 'retained-audit-project');
		assert.equal(
			await retainedPrimary.savepoint!(async (savepoint) => savepoint.capabilities?.savepoint),
			true
		);
	});

	assert.equal(retainedPrimary.capabilities?.transaction, true);
	assert.equal(typeof retainedPrimary.transaction, 'function');
	assert.equal(retainedPrimary.capabilities?.savepoint, false);
	assert.equal(retainedPrimary.savepoint, undefined);
	assert.equal(retainedPrimary.datastoreProjectId, 'retained-primary-project');
	assert.equal(retainedSecondary.datastoreProjectId, 'retained-audit-project');
});

test('pre-captured retained store transactions cannot bypass active transaction scope', async () => {
	const backing = new MemoryStoreAdapter();
	const store: StoreAdapter = {
		kind: 'closure-transaction-memory',
		capabilities: { ...backing.capabilities, transaction: true },
		get: (model, id, options) => backing.get(model, id, options),
		getMany: (model, ids, options) => backing.getMany(model, ids, options),
		query: (model, plan, options) => backing.query(model, plan, options),
		aggregate: (model, plan) => backing.aggregate(model, plan),
		create: (model, id, data, options) => backing.create(model, id, data, options),
		update: (model, id, data, options) => backing.update(model, id, data, options),
		delete: (model, id, options) => backing.delete(model, id, options),
		transaction: async <T>(callback: (tx: StoreAdapter) => Promise<T>, options?: StoreTransactionOptions) =>
			backing.transaction(callback, options)
	};
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(TransactionIsolationRecord);
	const retainedTransaction = context.store('default').transaction!;

	await assert.rejects(
		() =>
			context.transaction(async () => {
				await retainedTransaction(async (tx) => {
					await tx.create(meta, 6122, { id: 6122, value: 'leaked-inner-transaction' });
				});
				throw new Error('outer rollback');
			}),
		/does not expose transactions in this context|Cannot start transactions inside a transaction/
	);
	assert.deepEqual(backing.dump('transaction_isolation_record'), []);
});

test('transaction read-only stores reject routed native queries before adapter execution', async () => {
	const primary = new MemoryStoreAdapter();
	const auditBacking = new MemoryStoreAdapter();
	let nativeCalls = 0;
	const context = createActiveTs({
		stores: { default: primary, audit: createNativeMutatingStore(auditBacking, () => nativeCalls++) }
	});

	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				const TxAudit = TransactionAuditRecord.use(tx) as unknown as typeof TransactionAuditRecord;
				await TxAudit.query().native({ operation: 'write-outside-transaction' }).load();
			}),
		/does not support native queries/
	);

	assert.equal(nativeCalls, 0);
	assert.deepEqual(auditBacking.dump('transaction_cache_audit_record'), []);
});

test('transaction read-only stores reject direct native plans before adapter execution', async () => {
	const primary = new MemoryStoreAdapter();
	const auditBacking = new MemoryStoreAdapter();
	let nativeCalls = 0;
	const context = createActiveTs({
		stores: { default: primary, audit: createNativeMutatingStore(auditBacking, () => nativeCalls++) }
	});
	const meta = context.meta(TransactionAuditRecord);
	const queryPlan: QueryPlan = {
		where: [],
		or: [],
		sort: [],
		include: [],
		native: { payload: { operation: 'direct-query-write' } }
	};
	const aggregatePlan: AggregatePlan = {
		where: [],
		or: [],
		aggregates: [{ op: 'count', as: 'count' }],
		native: { payload: { operation: 'direct-aggregate-write' } }
	};

	await assert.rejects(
		() =>
			context.transaction(async () => {
				await context.store('audit').query(meta, queryPlan);
			}),
		/native operations on store "audit" are not atomic/
	);
	await assert.rejects(
		() =>
			context.transaction(async () => {
				await context.store('audit').aggregate!(meta, aggregatePlan);
			}),
		/native operations on store "audit" are not atomic/
	);

	assert.equal(nativeCalls, 0);
	assert.deepEqual(auditBacking.dump('transaction_cache_audit_record'), []);
});

test('transaction read-only stores reject unsupported portable features before adapter execution', async () => {
	const primary = new MemoryStoreAdapter();
	let queryCalls = 0;
	let aggregateCalls = 0;
	const audit: StoreAdapter = {
		kind: 'limited-read-only-audit',
		capabilities: {},
		get: async () => null,
		getMany: async () => [],
		query: async () => {
			queryCalls++;
			return { list: [], more: false };
		},
		aggregate: async () => {
			aggregateCalls++;
			return { count: 0 };
		},
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	const context = createActiveTs({ stores: { default: primary, audit } });
	const meta = context.meta(TransactionAuditRecord);

	await assert.rejects(
		() =>
			context.transaction(async () => {
				await context.store('audit').query(meta, {
					where: [],
					or: [{ where: [{ field: 'value', op: '=', value: 'x' }], or: [], sort: [], include: [] }],
					sort: [],
					include: []
				});
			}),
		/does not support orWhere/
	);
	await assert.rejects(
		() =>
			context.transaction(async () => {
				await context.store('audit').query(meta, {
					where: [],
					or: [],
					sort: [],
					include: [],
					select: ['value']
				});
			}),
		/does not support select/
	);
	await assert.rejects(
		() =>
			context.transaction(async () => {
				await context.store('audit').query(meta, {
					where: [],
					or: [],
					sort: [],
					include: [],
					cursor: 'next-page'
				});
			}),
		/does not support cursor pagination/
	);
	await assert.rejects(
		() =>
			context.transaction(async () => {
				await context.store('audit').aggregate!(meta, {
					where: [],
					or: [],
					aggregates: [{ op: 'count', as: 'count' }]
				});
			}),
		/does not support aggregate/
	);

	assert.equal(queryCalls, 0);
	assert.equal(aggregateCalls, 0);
});

test('transaction read-only stores validate direct native accessors before guards', async () => {
	const primary = new MemoryStoreAdapter();
	const auditBacking = new MemoryStoreAdapter();
	let nativeCalls = 0;
	let planGetterCalls = 0;
	let optionGetterCalls = 0;
	const context = createActiveTs({
		stores: { default: primary, audit: createNativeMutatingStore(auditBacking, () => nativeCalls++) }
	});
	const meta = context.meta(TransactionAuditRecord);
	const accessorPlan = {
		where: [],
		or: [],
		sort: [],
		include: [],
		get native() {
			planGetterCalls++;
			return { payload: { operation: 'getter-query-write' } };
		}
	};
	const accessorOptions = {
		get native() {
			optionGetterCalls++;
			return { operation: 'getter-read-write' };
		}
	};

	await assert.rejects(
		() =>
			context.transaction(async () => {
				await context.store('audit').query(meta, accessorPlan as any);
			}),
		/native must be a data property/
	);
	await assert.rejects(
		() =>
			context.transaction(async () => {
				await context.store('audit').get(meta, 1, accessorOptions as any);
			}),
		/native.*data property/
	);

	assert.equal(planGetterCalls, 0);
	assert.equal(optionGetterCalls, 0);
	assert.equal(nativeCalls, 0);
	assert.deepEqual(auditBacking.dump('transaction_cache_audit_record'), []);
});

test('transaction contexts reject direct cache mutations', async () => {
	const cache = new MemoryCacheAdapter();
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		caches: { default: cache }
	});
	await cache.setMany([['transaction-cache-direct-key', 'old']], { ttl: 60 });

	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				assert.deepEqual(await tx.cache('default')!.getMany(['transaction-cache-direct-key']), ['old']);
				await tx.cache('default')!.deleteMany(['transaction-cache-direct-key']);
			}),
		/cannot be mutated directly inside a transaction/
	);
	assert.deepEqual(await cache.getMany(['transaction-cache-direct-key']), ['old']);

	await assert.rejects(
		() =>
			context.transaction(async () => {
				await context.cache('default')!.setMany([['transaction-cache-direct-key', 'tx']], { ttl: 60 });
			}),
		/cannot be mutated directly inside a transaction/
	);
	assert.deepEqual(await cache.getMany(['transaction-cache-direct-key']), ['old']);
});

test('transaction scoped adapter registries ignore polluted inherited route names', async () => {
	Object.defineProperty(Object.prototype, 'default', {
		value: 'polluted route',
		writable: false,
		configurable: true
	});
	try {
		const context = createActiveTs({
			stores: { default: new MemoryStoreAdapter() },
			caches: { default: new MemoryCacheAdapter() },
			search: { default: new MemorySearchAdapter() },
			defaultSearch: 'default'
		});
		await context.transaction(async (tx) => {
			const TxRecord = TransactionCacheRecord.use(tx) as unknown as typeof TransactionCacheRecord;
			await TxRecord.create({ id: 63, value: 'scoped-registry' });
			assert.ok(tx.cache('default'));
			assert.equal(tx.searchAdapter('default').kind, 'memory');
		});
		const Record = TransactionCacheRecord.use(context) as unknown as typeof TransactionCacheRecord;
		assert.equal((await Record.find(63).load())?.data.value, 'scoped-registry');
	} finally {
		delete (Object.prototype as Record<string, unknown>).default;
	}
});

test('retained root adapters follow ambient transaction guards', async () => {
	const store = new MemoryStoreAdapter();
	const cache = new MemoryCacheAdapter();
	const search = new MemorySearchAdapter();
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache },
		search: { default: search },
		defaultSearch: 'default'
	});
	const retainedStore = context.store('default');
	const retainedCache = context.cache('default')!;
	const retainedSearch = context.searchAdapter('default');
	const isolationMeta = context.meta(TransactionIsolationRecord);
	const searchMeta = context.meta(TransactionNativeSearchRecord);

	await assert.rejects(
		() =>
			context.transaction(async () => {
				await retainedStore.create(isolationMeta, 64, { id: 64, value: 'retained-store-write' });
				throw new Error('rollback retained store');
			}),
		/rollback retained store/
	);
	assert.deepEqual(store.dump('transaction_isolation_record'), []);

	await assert.rejects(
		() =>
			context.transaction(async () => {
				await retainedCache.setMany([['transaction-cache-retained-key', 'tx']], { ttl: 60 });
			}),
		/cannot be mutated directly inside a transaction/
	);
	assert.deepEqual(await cache.getMany(['transaction-cache-retained-key']), [undefined]);

	await assert.rejects(
		() =>
			context.transaction(async () => {
				assert.equal(retainedSearch.capabilities?.index, false);
				await retainedSearch.index(searchMeta, 1, { id: 1, value: 'retained search index' });
			}),
		/cannot index or delete documents inside a transaction/
	);
	assert.equal(retainedSearch.capabilities?.index, true);
	assert.deepEqual(search.snapshot(searchMeta.name), []);
});

test('context-bound adapter guards reject raw adapters at extension boundaries', async () => {
	const store = new MemoryStoreAdapter();
	const plainBacking = new MemoryStoreAdapter();
	const plainStore: StoreAdapter = {
		kind: 'plain-boundary-store',
		capabilities: {},
		get: (model, id, options) => plainBacking.get(model, id, options),
		getMany: (model, ids, options) => plainBacking.getMany(model, ids, options),
		query: (model, plan, options) => plainBacking.query(model, plan, options),
		create: (model, id, data, options) => plainBacking.create(model, id, data, options),
		update: (model, id, data, options) => plainBacking.update(model, id, data, options),
		delete: (model, id, options) => plainBacking.delete(model, id, options)
	};
	const cache = new MemoryCacheAdapter();
	const search = new MemorySearchAdapter();
	const context = createActiveTs({
		stores: { default: store, plain: plainStore },
		caches: { default: cache },
		search: { default: search },
		defaultSearch: 'default'
	});
	const retainedStore = context.store('default');
	const retainedPlainStore = context.store('plain');
	const retainedCache = context.cache('default')!;
	const retainedSearch = context.searchAdapter('default');
	const wrappedCache = createCacheMiddlewareAdapter(retainedCache, []);
	const meta = context.meta(TransactionCacheRecord);

	assert.equal(isContextBoundStoreAdapter(store), false);
	assert.equal(isContextBoundStoreAdapter(plainStore), false);
	assert.equal(isContextBoundCacheAdapter(cache), false);
	assert.equal(isContextBoundSearchAdapter(search), false);
	assert.equal(isContextBoundStoreAdapter(retainedStore), true);
	assert.equal(isContextBoundStoreAdapter(retainedPlainStore), true);
	assert.equal(isContextBoundCacheAdapter(retainedCache), true);
	assert.equal(isContextBoundSearchAdapter(retainedSearch), true);
	assert.equal(isContextBoundCacheAdapter(wrappedCache), true);
	assert.equal(assertContextBoundStoreAdapter(retainedStore), retainedStore);
	assert.equal(assertContextBoundCacheAdapter(retainedCache), retainedCache);
	assert.equal(assertContextBoundSearchAdapter(retainedSearch), retainedSearch);
	assert.equal(assertContextBoundCacheAdapter(wrappedCache), wrappedCache);
	assert.throws(
		() => assertContextBoundStoreAdapter(store, 'extension store'),
		/extension store must be a context-bound store adapter.*Raw store adapters do not follow ambient transaction guards/
	);
	assert.throws(
		() => assertContextBoundCacheAdapter(cache, 'extension cache'),
		/extension cache must be a context-bound cache adapter.*Raw cache adapters do not follow ambient transaction guards/
	);
	assert.throws(
		() => assertContextBoundSearchAdapter(search, 'extension search'),
		/extension search must be a context-bound search adapter.*Raw search adapters do not follow ambient transaction guards/
	);

	const storeMarker = Object.getOwnPropertySymbols(retainedStore).find((symbol) =>
		String(symbol).includes('context-bound-store-source')
	)!;
	const cacheMarker = Object.getOwnPropertySymbols(retainedCache).find((symbol) =>
		String(symbol).includes('context-bound-cache-source')
	)!;
	const searchMarker = Object.getOwnPropertySymbols(retainedSearch).find((symbol) =>
		String(symbol).includes('context-bound-search-source')
	)!;
	const originalGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
	try {
		Object.defineProperty(Object, 'getOwnPropertyDescriptor', {
			configurable: true,
			value(target: object, property: PropertyKey) {
				if (target === store && property === storeMarker) {
					return { value: retainedStore, enumerable: false, configurable: false, writable: false };
				}
				if (target === cache && property === cacheMarker) {
					return { value: retainedCache, enumerable: false, configurable: false, writable: false };
				}
				if (target === search && property === searchMarker) {
					return { value: retainedSearch, enumerable: false, configurable: false, writable: false };
				}
				return originalGetOwnPropertyDescriptor.call(Object, target, property);
			}
		});
		assert.equal(isContextBoundStoreAdapter(store), false);
		assert.equal(isContextBoundCacheAdapter(cache), false);
		assert.equal(isContextBoundSearchAdapter(search), false);
		assert.throws(
			() => assertContextBoundStoreAdapter(store, 'patched descriptor store'),
			/patched descriptor store must be a context-bound store adapter/
		);
		assert.throws(
			() => assertContextBoundCacheAdapter(cache, 'patched descriptor cache'),
			/patched descriptor cache must be a context-bound cache adapter/
		);
		assert.throws(
			() => assertContextBoundSearchAdapter(search, 'patched descriptor search'),
			/patched descriptor search must be a context-bound search adapter/
		);
	} finally {
		Object.defineProperty(Object, 'getOwnPropertyDescriptor', {
			configurable: true,
			writable: true,
			value: originalGetOwnPropertyDescriptor
		});
	}
	const malformedStore = {};
	const malformedCache = {};
	const malformedSearch = {};
	Object.defineProperty(malformedStore, storeMarker, { get: () => store, enumerable: false });
	Object.defineProperty(malformedCache, cacheMarker, { get: () => cache, enumerable: false });
	Object.defineProperty(malformedSearch, searchMarker, { get: () => search, enumerable: false });
	assert.equal(isContextBoundStoreAdapter(malformedStore), false);
	assert.equal(isContextBoundCacheAdapter(malformedCache), false);
	assert.equal(isContextBoundSearchAdapter(malformedSearch), false);
	assert.throws(() => assertContextBoundStoreAdapter(malformedStore), /Context-bound store source must be a data property/);
	assert.throws(() => assertContextBoundCacheAdapter(malformedCache), /Context-bound cache source must be a data property/);
	assert.throws(() => assertContextBoundSearchAdapter(malformedSearch), /Context-bound search source must be a data property/);

	await context.transaction(async (tx) => {
		const txStore = tx.store('default');
		const txCache = tx.cache('default')!;
		const txSearch = tx.searchAdapter('default');
		assert.equal(isContextBoundStoreAdapter(retainedStore), true);
		assert.equal(isContextBoundCacheAdapter(retainedCache), true);
		assert.equal(isContextBoundSearchAdapter(retainedSearch), true);
		assert.equal(isContextBoundStoreAdapter(txStore), true);
		assert.equal(isContextBoundStoreAdapter(tx.store('plain')), true);
		assert.equal(isContextBoundCacheAdapter(txCache), true);
		assert.equal(isContextBoundSearchAdapter(txSearch), true);
		assert.equal(assertContextBoundStoreAdapter(txStore), txStore);
		assert.equal(assertContextBoundCacheAdapter(txCache), txCache);
		assert.equal(assertContextBoundSearchAdapter(txSearch), txSearch);
		assert.equal(retainedStore.capabilities?.transaction, false);
		assert.equal(retainedSearch.capabilities?.index, false);
	});

	let retainedLowLevelTx: StoreAdapter | undefined;
	await retainedStore.transaction!(async (txStore) => {
		retainedLowLevelTx = txStore;
		assert.equal(isContextBoundStoreAdapter(txStore), true);
		assert.equal(assertContextBoundStoreAdapter(txStore), txStore);
		assert.equal(txStore.capabilities?.transaction, false);
	});
	assert.equal(isContextBoundStoreAdapter(retainedLowLevelTx), true);
	assert.equal(assertContextBoundStoreAdapter(retainedLowLevelTx), retainedLowLevelTx);
	await assert.rejects(
		() => retainedLowLevelTx!.get(meta, 1),
		/closed context store adapter "default" transaction adapter after callback finished/
	);

	await store.transaction(async (rawTxStore) => {
		assert.equal(isContextBoundStoreAdapter(rawTxStore), false);
		assert.throws(
			() => assertContextBoundStoreAdapter(rawTxStore, 'raw low-level transaction store'),
			/raw low-level transaction store must be a context-bound store adapter/
		);
	});
});

test('transaction ambient scope defers root context direct invalidation through the transaction context', async () => {
	const store = new MemoryStoreAdapter();
	const cache = new MemoryCacheAdapter();
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache }
	});
	const Record = TransactionCacheRecord.use(context) as unknown as typeof TransactionCacheRecord;
	const meta = context.meta(TransactionCacheRecord);
	await store.seed('transaction_cache_record', [{ id: 62, value: 'cached' }]);
	await Record.find(62).load();
	cache.resetStats();

	await assert.rejects(
		() =>
			context.transaction(async () => {
				await context.invalidate(meta, 62);
				assert.equal(cache.stats.deleteMany, 0);
				throw new Error('rollback direct invalidate');
			}),
		/rollback direct invalidate/
	);

	assert.equal(cache.stats.deleteMany, 0);
});

test('transaction ambient scope routes root context transaction helpers to active transaction state', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const events: string[] = [];

	assert.equal(context.isInTransaction(), false);
	assert.equal(context.isTransactionContext(), false);
	await context.transaction(async () => {
		assert.equal(context.isInTransaction(), true);
		assert.equal(context.isTransactionContext(), true);
		await context.afterCommit(() => {
			events.push('commit');
		});
	});
	assert.deepEqual(events, ['commit']);

	await assert.rejects(
		() =>
			context.transaction(async () => {
				await context.afterRollback(() => {
					events.push('rollback');
				});
				throw new Error('rollback helper');
			}),
		/rollback helper/
	);
	assert.deepEqual(events, ['commit', 'rollback']);
});

test('retained transaction contexts reject operations after commit', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	let retained!: ActiveContext;

	await context.transaction(async (tx) => {
		retained = tx;
		const TxRecord = TransactionCacheRecord.use(tx) as unknown as typeof TransactionCacheRecord;
		await TxRecord.create({ id: 30, value: 'committed' });
	});
	const TxRecord = TransactionCacheRecord.use(retained) as unknown as typeof TransactionCacheRecord;

	await assert.rejects(
		() => TxRecord.create({ id: 31, value: 'late' }),
		/closed transaction context after it committed/
	);
	assert.throws(
		() => TxRecord.find(30),
		/closed transaction context after it committed/
	);
	await assert.rejects(
		() => retained.afterCommit(() => undefined),
		/closed transaction context after it committed/
	);
	assert.throws(
		() => retained.store('default'),
		/closed transaction context after it committed/
	);
	assert.deepEqual(store.dump('transaction_cache_record'), [{ id: 30, value: 'committed' }]);
});

test('models returned from committed transactions use the root context afterwards', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = TransactionNoCacheRecord.use(context) as unknown as typeof TransactionNoCacheRecord;

	const result = await context.transaction(async (tx) => {
		const TxRecord = TransactionNoCacheRecord.use(tx) as unknown as typeof TransactionNoCacheRecord;
		const created = await TxRecord.create({ id: 1301, value: 'created-in-tx' });
		await TxRecord.create({ id: 1302, value: 'loaded-in-tx' });
		const loaded = await TxRecord.find(1302).load();
		const mapped = await TxRecord.create({ id: 1304, value: 'mapped-in-tx' });
		const setMember = await TxRecord.create({ id: 1305, value: 'set-in-tx' });
		return {
			created,
			nested: [loaded],
			mapped: new Map([['mapped', mapped]]),
			set: new Set([setMember])
		};
	});

	result.created.data.value = 'saved-after-commit';
	await result.created.save();
	result.nested[0]!.data.value = 'nested-saved-after-commit';
	await result.nested[0]!.save();
	const mapped = result.mapped.get('mapped')!;
	mapped.data.value = 'mapped-saved-after-commit';
	await mapped.save();
	const [setMember] = result.set;
	setMember!.data.value = 'set-saved-after-commit';
	await setMember!.save();

	assert.equal((await Record.find(1301).load())?.data.value, 'saved-after-commit');
	assert.equal((await Record.find(1302).load())?.data.value, 'nested-saved-after-commit');
	assert.equal((await Record.find(1304).load())?.data.value, 'mapped-saved-after-commit');
	assert.equal((await Record.find(1305).load())?.data.value, 'set-saved-after-commit');
});

test('models leaked from rolled-back transactions keep the closed transaction context', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = TransactionNoCacheRecord.use(context) as unknown as typeof TransactionNoCacheRecord;
	let leaked: TransactionNoCacheRecord | undefined;

	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				const TxRecord = TransactionNoCacheRecord.use(tx) as unknown as typeof TransactionNoCacheRecord;
				leaked = await TxRecord.create({ id: 1303, value: 'rolled-back' });
				throw new Error('rollback leaked model');
			}),
		/rollback leaked model/
	);

	assert.ok(leaked);
	leaked.data.value = 'should-not-save';
	await assert.rejects(
		() => leaked!.save(),
		/closed transaction context after it rolled back/
	);
	assert.equal(await Record.find(1303).load(), null);
});

test('retained transaction contexts reject operations after rollback', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	let retained!: ActiveContext;

	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				retained = tx;
				const TxRecord = TransactionCacheRecord.use(tx) as unknown as typeof TransactionCacheRecord;
				await TxRecord.create({ id: 32, value: 'rolled-back' });
				throw new Error('rollback now');
			}),
		/rollback now/
	);
	const TxRecord = TransactionCacheRecord.use(retained) as unknown as typeof TransactionCacheRecord;

	assert.throws(
		() => TxRecord.find(32),
		/closed transaction context after it rolled back/
	);
	await assert.rejects(
		() => retained.afterRollback(() => undefined),
		/closed transaction context after it rolled back/
	);
	assert.deepEqual(store.dump('transaction_cache_record'), []);
});

test('transaction queries reject planner routes away from the model store', async () => {
	const primary = new MemoryStoreAdapter();
	const replica = new MemoryStoreAdapter();
	const context = createActiveTs({
		stores: { default: primary, replica },
		queryPlanner: {
			routeQuery: () => 'replica',
			routeAggregate: () => 'replica'
		}
	});

	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				const TxRecord = TransactionCacheRecord.use(tx) as unknown as typeof TransactionCacheRecord;
				await TxRecord.create({ id: 33, value: 'transaction' });
				await TxRecord.query().load();
			}),
		/Cannot route transaction queries for store "default" to store "replica"/
	);
	assert.deepEqual(primary.dump('transaction_cache_record'), []);

	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				const TxRecord = TransactionCacheRecord.use(tx) as unknown as typeof TransactionCacheRecord;
				await TxRecord.count();
			}),
		/Cannot route transaction aggregate queries for store "default" to store "replica"/
	);
});

test('transaction query planner store routes are validated before route guards', async () => {
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		queryPlanner: {
			routeQuery: () => Symbol('bad-route') as any,
			routeAggregate: () => Symbol('bad-route') as any
		}
	});

	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				const TxRecord = TransactionCacheRecord.use(tx) as unknown as typeof TransactionCacheRecord;
				await TxRecord.query().load();
			}),
		/store route adapter name must be a string/
	);

	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				const TxRecord = TransactionCacheRecord.use(tx) as unknown as typeof TransactionCacheRecord;
				await TxRecord.count();
			}),
		/store route adapter name must be a string/
	);
});

test('root store route helpers follow ambient transaction route guards', async () => {
	const primary = new MemoryStoreAdapter();
	const replica = new MemoryStoreAdapter();
	const context = createActiveTs({
		stores: { default: primary, replica },
		queryPlanner: {
			routeQuery: () => 'replica',
			routeAggregate: () => 'replica'
		}
	});
	const queryPlan = { where: [], or: [], sort: [], include: [] } as any;
	const aggregatePlan = { where: [], or: [], aggregates: [{ op: 'count', as: 'count' }] } as any;

	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				context.storeForQuery(tx.meta(TransactionCacheRecord), queryPlan);
			}),
		/Cannot route transaction queries for store "default" to store "replica"/
	);
	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				context.storeForAggregate(tx.meta(TransactionCacheRecord), aggregatePlan);
			}),
		/Cannot route transaction aggregate queries for store "default" to store "replica"/
	);
});

test('transaction fails fast when the selected store has no transaction support', async () => {
	const memory = new MemoryStoreAdapter();
	let methodCalled = 0;
	const noTransactionStore: StoreAdapter = {
		kind: 'no-transaction',
		capabilities: { transaction: false },
		get: (model, id) => memory.get(model, id),
		getMany: (model, ids) => memory.getMany(model, ids),
		query: (model, plan) => memory.query(model, plan),
		create: (...args) => memory.create(...args),
		update: (...args) => memory.update(...args),
		delete: (...args) => memory.delete(...args),
		transaction: async (callback) => {
			methodCalled++;
			return await callback(memory);
		}
	};
	const omittedCapabilityStore: StoreAdapter = {
		...noTransactionStore,
		kind: 'omitted-transaction-capability',
		capabilities: undefined
	};
	const context = createActiveTs({
		stores: { default: noTransactionStore, omitted: omittedCapabilityStore }
	});

	await assert.rejects(
		() => context.transaction(async () => undefined),
		/does not support transactions/
	);
	await assert.rejects(
		() => context.transaction(async () => undefined, { store: 'omitted' }),
		/does not support transactions/
	);
	assert.equal(methodCalled, 0);
	assert.deepEqual(memory.dump('transaction_cache_record'), []);
});

test('context transactions reject malformed savepoint callback adapters', async () => {
	const store = new MemoryStoreAdapter();
	const transaction = store.transaction.bind(store);
	(store as any).transaction = async (fn: (adapter: StoreAdapter) => Promise<unknown>, options?: StoreTransactionOptions) =>
		transaction(
			(tx) => fn({
				...tx,
				capabilities: Object.freeze({ ...(tx.capabilities ?? {}), savepoint: true }),
				savepoint: undefined
			}),
			options
		);
	const context = createActiveTs({ stores: { default: store } });
	let callbackCalls = 0;

	await assert.rejects(
		() => context.transaction(async () => {
			callbackCalls++;
		}),
		/advertises savepoint support but does not expose savepoint\(\)/
	);
	await assert.rejects(
		() => context.store('default').transaction!(async () => {
			callbackCalls++;
		}),
		/advertises savepoint support but does not expose savepoint\(\)/
	);
	assert.equal(callbackCalls, 0);
});

test('transaction rejects writes to stores outside the selected transaction scope', async () => {
	const defaultStore = new MemoryStoreAdapter();
	const auditStore = new MemoryStoreAdapter();
	const context = createActiveTs({
		stores: { default: defaultStore, audit: auditStore }
	});

	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				const AuditRecord = TransactionAuditRecord.use(tx) as unknown as typeof TransactionAuditRecord;
				await AuditRecord.create({ id: 1, value: 'audit' });
			}),
		/writes to store "audit" are not atomic/
	);
	assert.deepEqual(auditStore.dump('transaction_cache_audit_record'), []);
});

test('memory transactions do not expose uncommitted writes through the parent context', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = TransactionIsolationRecord.use(context) as unknown as typeof TransactionIsolationRecord;
	let release!: () => void;
	const hold = new Promise<void>((resolve) => {
		release = resolve;
	});
	let created!: Promise<void>;
	const entered = new Promise<void>((resolve) => {
		created = context.transaction(async (tx) => {
			const TxRecord = TransactionIsolationRecord.use(tx) as unknown as typeof TransactionIsolationRecord;
			await TxRecord.create({ id: 1, value: 'uncommitted' });
			resolve();
			await hold;
		});
	});

	await entered;
	assert.equal(await Record.find(1).load(), null);
	release();
	await created;
	assert.equal((await Record.find(1).load())?.data.value, 'uncommitted');
});

test('memory transactions recheck optimistic locks at commit time', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = TransactionVersionRecord.use(context) as unknown as typeof TransactionVersionRecord;
	await Record.create({ id: 1, value: 'base', version: 1 });
	let release!: () => void;
	const hold = new Promise<void>((resolve) => {
		release = resolve;
	});
	let ready!: () => void;
	const entered = new Promise<void>((resolve) => {
		ready = resolve;
	});
	const pending = context.transaction(async (tx) => {
		const TxRecord = TransactionVersionRecord.use(tx) as unknown as typeof TransactionVersionRecord;
		const loaded = await TxRecord.find(1).load();
		loaded!.data.value = 'transaction';
		await loaded!.save();
		ready();
		await hold;
	});

	await entered;
	await Record.update(1, { value: 'outside' });
	release();
	await assert.rejects(() => pending, /Optimistic lock failed/);
	const current = await Record.find(1).load();
	assert.equal(current?.data.value, 'outside');
	assert.equal(current?.data.version, 2);
});

test('failed memory transaction commit validation does not create empty parent collections', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const createMeta = context.meta(TransactionNoCacheRecord);
	const versionMeta = context.meta(TransactionVersionRecord);
	await store.seed(versionMeta, [{ id: 1, value: 'base', version: 1 }]);

	await assert.rejects(
		() =>
			store.transaction(async (tx) => {
				await tx.create(createMeta, 1, { id: 1, value: 'created' });
				await tx.update(versionMeta, 1, { id: 1, value: 'transaction', version: 2 }, { expectedVersion: 1 });
				await store.update(versionMeta, 1, { id: 1, value: 'outside', version: 2 }, { expectedVersion: 1 });
			}),
		/Optimistic lock failed/
	);
	assert.deepEqual(store.snapshot(), {
		transaction_version_record: [{ id: 1, value: 'outside', version: 2 }]
	});
});

test('memory transactions keep the original optimistic lock across repeated writes', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = TransactionVersionRecord.use(context) as unknown as typeof TransactionVersionRecord;
	const meta = context.meta(TransactionVersionRecord);
	await Record.create({ id: 1, value: 'base', version: 1 });
	await Record.create({ id: 2, value: 'delete-base', version: 1 });
	await store.seed(meta, [{ id: 3, value: 'replace-base', version: 1 }]);

	await context.transaction(async (tx) => {
		const TxRecord = TransactionVersionRecord.use(tx) as unknown as typeof TransactionVersionRecord;
		const loaded = await TxRecord.find(1).load();
		loaded!.data.value = 'first-write';
		await loaded!.save();
		loaded!.data.value = 'second-write';
		await loaded!.save();
	});

	await context.transaction(async (tx) => {
		const TxRecord = TransactionVersionRecord.use(tx) as unknown as typeof TransactionVersionRecord;
		const loaded = await TxRecord.find(2).load();
		loaded!.data.value = 'delete-after-update';
		await loaded!.save();
		await TxRecord.delete(2);
	});

	await store.transaction(async (tx) => {
		await tx.delete(meta, 3, { expectedVersion: 1 });
		await tx.create(meta, 3, { id: 3, value: 'replacement', version: 1 });
	});

	assert.deepEqual(await store.get(meta, 1), { id: 1, value: 'second-write', version: 3 });
	assert.equal(await store.get(meta, 2), null);
	assert.deepEqual(await store.get(meta, 3), { id: 3, value: 'replacement', version: 1 });
});

test('memory transaction dirty log ignores inherited optimistic lock options', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = TransactionVersionRecord.use(context) as unknown as typeof TransactionVersionRecord;
	const meta = context.meta(TransactionVersionRecord);
	await Record.create({ id: 1, value: 'base', version: 1 });
	Object.defineProperty(Object.prototype, 'expectedVersion', {
		value: 999,
		configurable: true
	});
	try {
		await store.transaction(async (tx) => {
			await tx.update(meta, 1, { id: 1, value: 'transaction', version: 2 }, {});
		});
	} finally {
		delete (Object.prototype as Record<string, unknown>).expectedVersion;
	}

	const current = await Record.find(1).load();
	assert.equal(current?.data.value, 'transaction');
	assert.equal(current?.data.version, 2);
});

test('memory transaction dirty log snapshots write data before await boundaries', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(TransactionCacheRecord);
	await store.seed(meta, [{ id: 1, value: 'base' }]);
	const createData = { id: 2, value: 'created' };
	const updateData = { id: 1, value: 'updated' };

	await store.transaction(async (tx) => {
		const creating = tx.create(meta, 2, createData);
		createData.value = 'mutated-created';
		await creating;

		const updating = tx.update(meta, 1, updateData);
		updateData.value = 'mutated-updated';
		await updating;
	});

	assert.deepEqual(
		store.dump('transaction_cache_record').sort((a, b) => a.id - b.id),
		[
			{ id: 1, value: 'updated' },
			{ id: 2, value: 'created' }
		]
	);
});

test('closed transaction contexts reject search routing before planner execution', async () => {
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { default: new MemorySearchAdapter() },
		queryPlanner: {
			routeSearch: () => {
				throw new Error('routeSearch should not run');
			}
		}
	});
	const meta = context.meta(TransactionNativeSearchRecord);
	let retained!: ActiveContext;

	await context.transaction(async (tx) => {
		retained = tx;
	});

	assert.throws(
		() => retained.searchAdapterRouteFor(meta, 'needle', {}),
		/closed transaction context after it committed/
	);
});

test('ambient transactions reject unrelated context search planners before execution', async () => {
	const root = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	let routeSearchCalls = 0;
	const unrelated = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { default: new MemorySearchAdapter() },
		queryPlanner: {
			routeSearch: () => {
				routeSearchCalls++;
				return 'default';
			}
		}
	});
	const meta = unrelated.meta(TransactionNativeSearchRecord);

	await assert.rejects(
		() =>
			root.transaction(async () => {
				unrelated.searchAdapterRouteFor(meta, 'needle', {});
			}),
		/different active-ts context/
	);

	assert.equal(routeSearchCalls, 0);
});

test('memory transaction adapters do not expose schema hooks', async () => {
	const store = new MemoryStoreAdapter();
	let txSchema: StoreAdapter['schema'] | undefined;

	await store.transaction(async (tx) => {
		txSchema = tx.schema;
	});

	assert.equal(txSchema, undefined);
});

test('transaction contexts reject non-native search reads', async () => {
	const store = new MemoryStoreAdapter();
	const search = new MemorySearchAdapter();
	const context = createActiveTs({
		stores: { default: store },
		search: { memory: search },
		defaultSearch: 'memory'
	});
	const Record = TransactionMemorySearchRecord.use(context) as unknown as typeof TransactionMemorySearchRecord;

	await Record.create({ id: 1, value: 'old indexed value' });
	await search.index(context.meta(TransactionMemorySearchRecord), 1, { id: 1, value: 'old indexed value' });
	assert.equal(context.searchAdapter('memory').capabilities?.where, true);

	await context.transaction(async (tx) => {
		const txSearch = tx.searchAdapter('memory');
		assert.equal(txSearch.capabilities?.where, false);
		assert.equal(txSearch.capabilities?.cursor, false);
		assert.equal(txSearch.capabilities?.native, false);
		assert.equal(txSearch.capabilities?.index, false);
		const TxRecord = TransactionMemorySearchRecord.use(tx) as unknown as typeof TransactionMemorySearchRecord;
		await TxRecord.update(1, { value: 'new transactional value' });
		assert.equal((await TxRecord.find(1).load())?.data.value, 'new transactional value');
		await assert.rejects(
			() => TxRecord.search('old').load(),
			/Search adapter "memory" cannot be read inside a transaction/
		);
	});
});

test('native search adapters are rebound to transaction-scoped stores', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({
		stores: { default: store },
		search: { native: createNativeSearchAdapter(store) },
		defaultSearch: 'native'
	});
	const Record = TransactionNativeSearchRecord.use(context) as unknown as typeof TransactionNativeSearchRecord;

	await context.transaction(async (tx) => {
		const TxRecord = TransactionNativeSearchRecord.use(tx) as unknown as typeof TransactionNativeSearchRecord;
		await TxRecord.create({ id: 1, value: 'needle only in tx' });
		const result = await TxRecord.search('needle').load();
		assert.deepEqual(result.list.map((item) => item.data.id), [1]);
		assert.equal(store.stats.query, 0);
	});

	assert.deepEqual((await Record.search('needle').load()).list.map((item) => item.data.id), [1]);
});

test('transaction native search preserves datastore namespace after rebinding', async () => {
	let rootQueryCalls = 0;
	const rows = new Map<number, TransactionDatastoreNativeSearchData>();
	const store: StoreAdapter = {
		kind: 'transaction-datastore-native-search-store',
		datastoreNamespace: 'transaction_native_tenant',
		capabilities: { datastoreAncestor: true, textContains: true, transaction: true },
		get: async (_model, id) => rows.get(id as number) ?? null,
		getMany: async (_model, ids) => ids.map((id) => rows.get(id as number) ?? null),
		query: async () => {
			rootQueryCalls++;
			return { list: [...rows.values()], more: false, count: rows.size };
		},
		create: async (_model, id, data) => { rows.set(id as number, data); },
		update: async (_model, id, data) => { rows.set(id as number, data); },
		delete: async (_model, id) => { rows.delete(id as number); },
		transaction: async (fn) => {
			const txRows = new Map(rows);
			const txStore: StoreAdapter = {
				kind: 'transaction-datastore-native-search-store-tx',
				capabilities: { datastoreAncestor: true, textContains: true },
				get: async (_model, id) => txRows.get(id as number) ?? null,
				getMany: async (_model, ids) => ids.map((id) => txRows.get(id as number) ?? null),
				query: async () => ({ list: [...txRows.values()], more: false, count: txRows.size }),
				create: async (_model, id, data) => { txRows.set(id as number, data); },
				update: async (_model, id, data) => { txRows.set(id as number, data); },
				delete: async (_model, id) => { txRows.delete(id as number); }
			};
			const result = await fn(txStore);
			rows.clear();
			for (const [id, row] of txRows) rows.set(id, row);
			return result;
		}
	};
	const context = createActiveTs({
		stores: { default: store },
		search: { native: createNativeSearchAdapter(store) },
		defaultSearch: 'native'
	});
	const meta = context.meta(TransactionDatastoreNativeSearchRecord);

	await context.transaction(async (tx) => {
		const TxRecord = TransactionDatastoreNativeSearchRecord.use(tx) as unknown as typeof TransactionDatastoreNativeSearchRecord;
		await TxRecord.create({ id: 7, parentId: 70, value: 'namespaced transaction needle' });
		const retainedResult = await tx.searchAdapter('native').search(
			tx.meta(TransactionDatastoreNativeSearchRecord),
			'needle',
			{}
		);

		assert.deepEqual(retainedResult.list, [
			{ id: 7, parentId: 70, value: 'namespaced transaction needle' }
		]);
		assert.equal(
			searchHitDocumentIdentity(retainedResult.list[0]),
			datastoreSearchDocumentIdentity(
				meta,
				7,
				datastoreKey('transaction_native_search_parent', 70, { namespace: 'transaction_native_tenant' })
			)
		);
		assert.equal(rootQueryCalls, 0);
	});
});

test('retained native search adapters are rebound to transaction-scoped stores', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({
		stores: { default: store },
		search: { native: createNativeSearchAdapter(store) },
		defaultSearch: 'native'
	});
	const retainedNativeSearch = context.searchAdapter('native');

	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				const TxRecord = TransactionNativeSearchRecord.use(tx) as unknown as typeof TransactionNativeSearchRecord;
				await TxRecord.create({ id: 2, value: 'needle only in retained tx' });
				const result = await retainedNativeSearch.search(tx.meta(TransactionNativeSearchRecord), 'needle', {});
				assert.deepEqual(result.list.map((item: any) => item.id), [2]);
				assert.equal(store.stats.query, 0);
				throw new Error('rollback retained native search');
			}),
		/rollback retained native search/
	);

	assert.deepEqual(store.dump('transaction_native_search_record'), []);
});

test('native search adapters over retained context store handles follow ambient transaction scope', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({
		stores: { default: store }
	});
	const retainedStore = context.store('default');
	const retainedNativeSearch = createNativeSearchAdapter(retainedStore);

	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				const TxRecord = TransactionNativeSearchRecord.use(tx) as unknown as typeof TransactionNativeSearchRecord;
				await TxRecord.create({ id: 12, value: 'needle only in retained context store tx' });
				const result = await retainedNativeSearch.search(tx.meta(TransactionNativeSearchRecord), 'needle', {});
				assert.deepEqual(result.list.map((item: any) => item.id), [12]);
				assert.equal(store.stats.query, 0);
				throw new Error('rollback retained context store native search');
			}),
		/rollback retained context store native search/
	);

	assert.deepEqual(store.dump('transaction_native_search_record'), []);
});

test('retained native search middleware adapters rebind to transaction-scoped stores', async () => {
	const store = new MemoryStoreAdapter();
	let middlewareSearchCalls = 0;
	const native = createSearchMiddlewareAdapter(createNativeSearchAdapter(store), [
		async (operation, next) => {
			if (operation.operation === 'search') middlewareSearchCalls++;
			return await next();
		}
	]);
	const context = createActiveTs({
		stores: { default: store },
		search: { native },
		defaultSearch: 'native'
	});
	const retainedNativeSearch = context.searchAdapter('native');

	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				const TxRecord = TransactionNativeSearchRecord.use(tx) as unknown as typeof TransactionNativeSearchRecord;
				await TxRecord.create({ id: 3, value: 'middleware retained tx needle' });
				const result = await retainedNativeSearch.search(tx.meta(TransactionNativeSearchRecord), 'needle', {});
				assert.deepEqual(result.list.map((item: any) => item.id), [3]);
				assert.equal(store.stats.query, 0);
				assert.equal(middlewareSearchCalls, 1);
				throw new Error('rollback retained native middleware search');
			}),
		/rollback retained native middleware search/
	);

	assert.deepEqual(store.dump('transaction_native_search_record'), []);
});

test('native search adapters over store middleware rebind to transaction-scoped stores', async () => {
	const store = new MemoryStoreAdapter();
	let middlewareQueryCalls = 0;
	const tracedStore = createStoreMiddlewareAdapter(store, [
		async (operation, next) => {
			if (operation.operation === 'query') middlewareQueryCalls++;
			return await next();
		}
	]);
	const context = createActiveTs({
		stores: { default: store },
		search: { native: createNativeSearchAdapter(tracedStore) },
		defaultSearch: 'native'
	});

	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				const TxRecord = TransactionNativeSearchRecord.use(tx) as unknown as typeof TransactionNativeSearchRecord;
				await TxRecord.create({ id: 4, value: 'store middleware native tx needle' });
				const result = await TxRecord.search('needle').load();
				assert.deepEqual(result.list.map((item) => item.data.id), [4]);
				assert.equal(store.stats.query, 0);
				assert.equal(middlewareQueryCalls, 0);
				throw new Error('rollback native store middleware search');
			}),
		/rollback native store middleware search/
	);

	assert.deepEqual(store.dump('transaction_native_search_record'), []);
});

test('native search adapters over registered store middleware prefer the closest transaction route', async () => {
	const store = new MemoryStoreAdapter();
	let middlewareQueryCalls = 0;
	const tracedStore = createStoreMiddlewareAdapter(store, [
		async (operation, next) => {
			if (operation.operation === 'query') middlewareQueryCalls++;
			return await next();
		}
	]);
	const context = createActiveTs({
		stores: { default: store, traced: tracedStore },
		search: { native: createNativeSearchAdapter(tracedStore) },
		defaultSearch: 'native'
	});

	await assert.rejects(
		() =>
			context.transaction(
				async (tx) => {
					const TxRecord = TransactionTracedNativeSearchRecord.use(tx) as unknown as typeof TransactionTracedNativeSearchRecord;
					await TxRecord.create({ id: 5, value: 'registered store middleware native tx needle' });
					const result = await TxRecord.search('needle').load();
					assert.deepEqual(result.list.map((item) => item.data.id), [5]);
					assert.equal(store.stats.query, 0);
					assert.equal(middlewareQueryCalls, 1);
					throw new Error('rollback registered store middleware native search');
				},
				{ store: 'traced' }
			),
		/rollback registered store middleware native search/
	);

	assert.deepEqual(store.dump('transaction_traced_native_search_record'), []);
});

test('native search adapters bound to unregistered stores fail inside transactions', async () => {
	const store = new MemoryStoreAdapter();
	const externalStore = new MemoryStoreAdapter();
	const context = createActiveTs({
		stores: { default: store },
		search: { native: createNativeSearchAdapter(externalStore) },
		defaultSearch: 'native'
	});

	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				const TxRecord = TransactionNativeSearchRecord.use(tx) as unknown as typeof TransactionNativeSearchRecord;
				await TxRecord.search('needle').load();
			}),
		/not registered in this transaction context/
	);
	assert.equal(externalStore.stats.query, 0);
});

test('transaction native search rejects adapters bound to a different registered store', async () => {
	const primary = new MemoryStoreAdapter();
	const replica = new MemoryStoreAdapter();
	const context = createActiveTs({
		stores: { default: primary, replica },
		search: { native: createNativeSearchAdapter(replica) },
		defaultSearch: 'native'
	});
	const meta = context.meta(TransactionNativeSearchRecord);
	await replica.create(meta, 2, { id: 2, value: 'replica needle' });

	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				const TxRecord = TransactionNativeSearchRecord.use(tx) as unknown as typeof TransactionNativeSearchRecord;
				await TxRecord.create({ id: 1, value: 'primary needle' });
				await TxRecord.search('needle').load();
			}),
		/Cannot route transaction native searches for store "default" to store "replica"/
	);
	assert.equal(replica.stats.query, 0);

	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				const TxRecord = TransactionNativeSearchRecord.use(tx) as unknown as typeof TransactionNativeSearchRecord;
				await TxRecord.create({ id: 3, value: 'retained primary needle' });
				await tx.searchAdapter('native').search(tx.meta(TransactionNativeSearchRecord), 'needle', {});
			}),
		/Cannot route transaction native searches for store "default" to store "replica"/
	);
	assert.equal(replica.stats.query, 0);
});

test('native search transaction rebinding ignores forged context-bound store descriptors', async () => {
	const store = new MemoryStoreAdapter();
	const externalStore = new MemoryStoreAdapter();
	const context = createActiveTs({
		stores: { default: store },
		search: { native: createNativeSearchAdapter(externalStore) },
		defaultSearch: 'native'
	});
	const retainedStore = context.store('default');
	const storeMarker = Object.getOwnPropertySymbols(retainedStore).find((symbol) =>
		String(symbol).includes('context-bound-store-source')
	)!;
	const originalGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
	try {
		Object.defineProperty(Object, 'getOwnPropertyDescriptor', {
			configurable: true,
			value(target: object, property: PropertyKey) {
				if (target === externalStore && property === storeMarker) {
					return { value: store, enumerable: false, configurable: false, writable: false };
				}
				return originalGetOwnPropertyDescriptor.call(Object, target, property);
			}
		});
		await assert.rejects(
			() =>
				context.transaction(async (tx) => {
					const TxRecord = TransactionNativeSearchRecord.use(tx) as unknown as typeof TransactionNativeSearchRecord;
					await TxRecord.create({ id: 2, value: 'needle forged source' });
					await TxRecord.search('needle').load();
				}),
			/not registered in this transaction context/
		);
	} finally {
		Object.defineProperty(Object, 'getOwnPropertyDescriptor', {
			configurable: true,
			writable: true,
			value: originalGetOwnPropertyDescriptor
		});
	}
	assert.equal(externalStore.stats.query, 0);
});

test('transaction contexts reject direct search indexing side effects', async () => {
	const search = new MemorySearchAdapter();
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { native: search },
		defaultSearch: 'native'
	});
	const meta = context.meta(TransactionNativeSearchRecord);

	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				const TxRecord = TransactionNativeSearchRecord.use(tx) as unknown as typeof TransactionNativeSearchRecord;
				await TxRecord.create({ id: 1, value: 'needle in tx' });
				await tx.searchAdapter('native').index(tx.meta(TransactionNativeSearchRecord), 1, {
					id: 1,
					value: 'needle in tx'
				});
			}),
		/cannot index or delete documents inside a transaction/
	);

	assert.equal(search.stats.index, 0);
	assert.deepEqual(search.snapshot(meta.name), []);
	assert.equal(await context.loadById(TransactionNativeSearchRecord, 1), null);
});

test('direct transaction adapters reject malformed callbacks before execution', async () => {
	const memory = new MemoryStoreAdapter();
	await assert.rejects(
		() => memory.transaction(null as any),
		/memory store transaction callback must be a function/
	);

	let middlewareRan = false;
	const wrapped = createStoreMiddlewareAdapter(memory, [
		async (_context, next) => {
			middlewareRan = true;
			return await next();
		}
	]);
	await assert.rejects(
		() => wrapped.transaction!(null as any),
		/store middleware transaction callback must be a function/
	);
	assert.equal(middlewareRan, false);
});

test('memory transactions require own version fields during commit recheck', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(TransactionVersionRecord);
	await store.seed(meta, [{ id: 3, value: 'base', version: 1 }]);
	Object.defineProperty(Object.prototype, 'version', {
		value: 1,
		configurable: true
	});
	try {
		await assert.rejects(
			() =>
				store.transaction(async (tx) => {
					await tx.update(meta, 3, { id: 3, value: 'transaction', version: 2 }, { expectedVersion: 1 });
					await store.update(meta, 3, { id: 3, value: 'outside' } as any);
				}),
			(error: unknown) =>
				error instanceof ActiveTsConflictError &&
				/Optimistic lock failed/.test(error.message)
		);
	} finally {
		delete (Object.prototype as Record<string, unknown>).version;
	}

	assert.deepEqual(await store.get(meta, 3), { id: 3, value: 'outside' });
});

test('memory transactions detect duplicate creates that appear before commit', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = TransactionIsolationRecord.use(context) as unknown as typeof TransactionIsolationRecord;
	let release!: () => void;
	const hold = new Promise<void>((resolve) => {
		release = resolve;
	});
	let ready!: () => void;
	const entered = new Promise<void>((resolve) => {
		ready = resolve;
	});
	const pending = context.transaction(async (tx) => {
		const TxRecord = TransactionIsolationRecord.use(tx) as unknown as typeof TransactionIsolationRecord;
		await TxRecord.create({ id: 2, value: 'transaction' });
		ready();
		await hold;
	});

	await entered;
	await Record.create({ id: 2, value: 'outside' });
	release();
	await assert.rejects(() => pending, /already exists/);
	assert.equal((await Record.find(2).load())?.data.value, 'outside');
});

test('transaction writes skip cacheKey resolution when the model has no cache', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({
		stores: { default: store },
		cacheKey() {
			throw new Error('cacheKey should not run');
		}
	});
	const Record = TransactionNoCacheRecord.use(context) as unknown as typeof TransactionNoCacheRecord;

	await context.transaction(async (tx) => {
		const TxRecord = TransactionNoCacheRecord.use(tx) as unknown as typeof TransactionNoCacheRecord;
		await TxRecord.create({ id: 1, value: 'created' });
	});

	assert.equal((await Record.find(1).load())?.data.value, 'created');
});
