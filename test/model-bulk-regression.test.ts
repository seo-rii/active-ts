import test from 'node:test';
import assert from 'node:assert/strict';
import {
	MemoryCacheAdapter,
	MemoryOutboxAdapter,
	MemoryStoreAdapter,
	Model,
	createActiveTs,
	createOutboxPlugin,
	datastoreKey,
	defineModel,
	type StoreAdapter,
	type StoreTransactionOptions
} from '../src/index.js';

type BulkData = {
	id: string | number;
	value: string;
	secret?: string;
	version?: number;
};

class TracedMemoryStore extends MemoryStoreAdapter {
	transactionCalls = 0;

	constructor(private readonly events: string[]) {
		super();
	}

	override async transaction<T>(
		fn: (tx: StoreAdapter) => Promise<T>,
		options?: StoreTransactionOptions
	): Promise<T> {
		this.transactionCalls++;
		this.events.push('transaction:begin');
		try {
			const result = await super.transaction(async (tx) => {
				const traced: StoreAdapter = {
					...tx,
					create: (model, id, data, writeOptions) => {
						this.events.push(`write:create:${String(id)}`);
						return tx.create(model, id, data, writeOptions);
					},
					update: (model, id, data, writeOptions) => {
						this.events.push(`write:update:${String(id)}`);
						return tx.update(model, id, data, writeOptions);
					},
					delete: (model, id, writeOptions) => {
						this.events.push(`write:delete:${String(id)}`);
						return tx.delete(model, id, writeOptions);
					}
				};
				return await fn(traced);
			}, options);
			this.events.push('transaction:commit');
			return result;
		} catch (error) {
			this.events.push('transaction:rollback');
			throw error;
		}
	}
}

test('createMany preflights every lifecycle row before ordered writes', async () => {
	const events: string[] = [];
	class BulkCreateRecord extends Model<BulkData> {}
	defineModel<BulkData>('model_bulk_create_record')
		.id('id')
		.validate((input) => input as BulkData)
		.hooks({
			beforeCreate(payload) {
				const data = payload.data as BulkData;
				events.push(`beforeCreate:${String(data.id)}:${data.value}`);
				return { data: { ...data, value: data.value.trim() } };
			},
			beforeValidate(payload) {
				events.push(`beforeValidate:${String((payload.data as BulkData).id)}`);
			},
			afterValidate(payload) {
				events.push(`afterValidate:${String((payload.data as BulkData).id)}`);
			},
			afterInstantiate(payload) {
				events.push(`afterInstantiate:${String(payload.id ?? (payload.data as BulkData).id)}`);
			},
			afterCreate(payload) {
				events.push(`afterCreate:${String(payload.id)}`);
			}
		})
		.attach(BulkCreateRecord);

	const store = new TracedMemoryStore(events);
	const context = createActiveTs({ stores: { default: store } });
	const Record = BulkCreateRecord.use(context) as typeof BulkCreateRecord;
	const first: BulkData = { id: 1, value: ' one ' };
	const pending = Record.createMany([first, { id: 2, value: ' two ' }]);
	first.value = 'mutated';
	const items = await pending;

	assert.deepEqual(items.map((item) => item.data.value), ['one', 'two']);
	assert.deepEqual(events, [
		'transaction:begin',
		'beforeCreate:1: one ',
		'beforeValidate:1',
		'afterValidate:1',
		'beforeCreate:2: two ',
		'beforeValidate:2',
		'afterValidate:2',
		'write:create:1',
		'write:create:2',
		'afterInstantiate:1',
		'afterCreate:1',
		'afterInstantiate:2',
		'afterCreate:2',
		'transaction:commit'
	]);
	assert.equal(store.transactionCalls, 1);
});

test('createMany rejects a later preflight failure before any store mutation', async () => {
	const events: string[] = [];
	class BulkPreflightRecord extends Model<BulkData> {}
	defineModel<BulkData>('model_bulk_preflight_record')
		.id('id')
		.validate((input) => input as BulkData)
		.hooks({
			beforeCreate(payload) {
				const id = (payload.data as BulkData).id;
				events.push(`beforeCreate:${String(id)}`);
				if (id === 2) throw new Error('second row rejected');
			}
		})
		.attach(BulkPreflightRecord);

	const store = new TracedMemoryStore(events);
	const context = createActiveTs({ stores: { default: store } });
	const Record = BulkPreflightRecord.use(context) as typeof BulkPreflightRecord;

	await assert.rejects(
		() => Record.createMany([{ id: 1, value: 'one' }, { id: 2, value: 'two' }]),
		/second row rejected/
	);
	assert.equal(events.some((event) => event.startsWith('write:')), false);
	assert.deepEqual(events, [
		'transaction:begin',
		'beforeCreate:1',
		'beforeCreate:2',
		'transaction:rollback'
	]);
	assert.equal(await store.get(context.meta(BulkPreflightRecord), 1), null);
});

test('upsertMany reports create and update outcomes while preserving codecs and optimistic locks', async () => {
	const events: string[] = [];
	let outboxId = 0;
	class BulkUpsertRecord extends Model<BulkData> {}
	defineModel<BulkData>({ name: 'model_bulk_upsert_record', cache: { ttl: 60 } })
		.id('id')
		.validate((input) => input as BulkData)
		.fieldCodec('secret', {
			name: 'bulk-secret',
			encode: (value) => `encoded:${String(value)}`,
			decode: (value) => String(value).replace(/^encoded:/, '')
		})
		.hooks({
			beforeCreate(payload) {
				events.push(`beforeCreate:${String((payload.data as BulkData).id)}`);
			},
			beforeUpdate(payload) {
				events.push(`beforeUpdate:${String(payload.id)}`);
			},
			afterCreate(payload) {
				events.push(`afterCreate:${String(payload.id)}`);
			},
			afterUpdate(payload) {
				events.push(`afterUpdate:${String(payload.id)}`);
			}
		})
		.attach(BulkUpsertRecord);

	const store = new TracedMemoryStore(events);
	const cache = new MemoryCacheAdapter();
	const outbox = new MemoryOutboxAdapter();
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache },
		plugins: [createOutboxPlugin({ outbox, includeData: true, id: () => `bulk-${++outboxId}` })]
	});
	const Record = BulkUpsertRecord.use(context) as typeof BulkUpsertRecord;
	await Record.create({ id: 1, value: 'old', secret: 'old-secret', version: 4 });
	await outbox.drain();
	await Record.find(1).load();
	store.transactionCalls = 0;
	events.length = 0;

	const results = await Record.upsertMany([
		{ id: 1, value: 'updated', secret: 'next-secret' },
		{ id: 2, value: 'created', secret: 'new-secret' }
	]);

	assert.deepEqual(results.map((result) => result.operation), ['update', 'create']);
	assert.equal(results[0].item.data.version, 5);
	assert.equal(results[0].item.data.secret, 'next-secret');
	assert.equal(results[1].item.data.secret, 'new-secret');
	assert.deepEqual(events.filter((event) => event.startsWith('write:')), [
		'write:update:1',
		'write:create:2'
	]);
	assert.ok(events.indexOf('beforeCreate:2') < events.indexOf('write:update:1'));
	assert.ok(events.indexOf('write:create:2') < events.indexOf('afterUpdate:1'));
	assert.equal(store.transactionCalls, 1);
	const raw = await store.get(context.meta(BulkUpsertRecord), 1);
	assert.equal(raw?.secret, 'encoded:next-secret');
	assert.equal((await Record.find(1).load())?.data.value, 'updated');
	assert.deepEqual((await outbox.list()).map((event) => ({
		operation: event.operation,
		modelId: event.modelId,
		data: event.data,
		dataEncoding: event.dataEncoding
	})), [
		{
			operation: 'update',
			modelId: 1,
			data: { id: 1, value: 'updated', secret: 'encoded:next-secret', version: 5 },
			dataEncoding: 'stored'
		},
		{
			operation: 'create',
			modelId: 2,
			data: { id: 2, value: 'created', secret: 'encoded:new-secret' },
			dataEncoding: 'stored'
		}
	]);
});

test('model bulk cache invalidations commit and rolled-back invalidations stay staged', async () => {
	class BulkCacheRecord extends Model<BulkData> {}
	defineModel<BulkData>({ name: 'model_bulk_cache_record', cache: { ttl: 60, negativeTtl: 60 } })
		.id('id')
		.validate((input) => input as BulkData)
		.hooks({
			afterCreate(payload) {
				if (payload.id === 4) throw new Error('cache rollback');
			}
		})
		.attach(BulkCacheRecord);

	const store = new MemoryStoreAdapter();
	const cache = new MemoryCacheAdapter();
	const context = createActiveTs({ stores: { default: store }, caches: { default: cache } });
	const Record = BulkCacheRecord.use(context) as typeof BulkCacheRecord;

	assert.equal(await Record.find(1).load(), null);
	assert.equal(Object.values(cache.snapshot())[0]?.value, null);
	await Record.createMany([{ id: 1, value: 'one' }, { id: 2, value: 'two' }]);
	assert.deepEqual(cache.snapshot(), {});

	await Record.find(1).load();
	await Record.find(2).load();
	assert.equal(Object.keys(cache.snapshot()).length, 2);
	await Record.deleteMany([1, 2]);
	assert.deepEqual(cache.snapshot(), {});

	await Record.find(3).load();
	await Record.find(4).load();
	const negativeSnapshot = cache.snapshot();
	await assert.rejects(
		() => Record.createMany([{ id: 3, value: 'three' }, { id: 4, value: 'four' }]),
		/cache rollback/
	);
	assert.deepEqual(cache.snapshot(), negativeSnapshot);
});

test('bulk optimistic-lock conflicts roll back earlier updates and deletes', async () => {
	class ConflictingBulkStore extends MemoryStoreAdapter {
		operation: 'update' | 'delete' = 'update';
		readonly expectedVersions: Array<{ operation: 'update' | 'delete'; id: string | number; version: number | undefined }> = [];

		override async transaction<T>(
			fn: (tx: StoreAdapter) => Promise<T>,
			options?: StoreTransactionOptions
		): Promise<T> {
			return await super.transaction(async (tx) => {
				const wrapped: StoreAdapter = {
					...tx,
					update: async (model, id, data, writeOptions) => {
						this.expectedVersions.push({ operation: 'update', id, version: writeOptions?.expectedVersion });
						if (this.operation === 'update' && id === 2) throw new Error('second update conflict');
						await tx.update(model, id, data, writeOptions);
					},
					delete: async (model, id, writeOptions) => {
						this.expectedVersions.push({ operation: 'delete', id, version: writeOptions?.expectedVersion });
						if (this.operation === 'delete' && id === 2) throw new Error('second delete conflict');
						await tx.delete(model, id, writeOptions);
					}
				};
				return await fn(wrapped);
			}, options);
		}
	}

	class BulkConflictRecord extends Model<BulkData> {}
	defineModel<BulkData>('model_bulk_conflict_record')
		.id('id')
		.validate((input) => input as BulkData)
		.attach(BulkConflictRecord);

	let outboxId = 0;
	const store = new ConflictingBulkStore();
	const outbox = new MemoryOutboxAdapter();
	const context = createActiveTs({
		stores: { default: store },
		plugins: [createOutboxPlugin({ outbox, includeData: true, id: () => `conflict-${++outboxId}` })]
	});
	const Record = BulkConflictRecord.use(context) as typeof BulkConflictRecord;
	const meta = context.meta(BulkConflictRecord);
	await store.seed(meta, [
		{ id: 1, value: 'old-one', version: 4 },
		{ id: 2, value: 'old-two', version: 8 }
	]);

	await assert.rejects(
		() => Record.upsertMany([{ id: 1, value: 'new-one' }, { id: 2, value: 'new-two' }]),
		/second update conflict/
	);
	assert.deepEqual(store.expectedVersions, [
		{ operation: 'update', id: 1, version: 4 },
		{ operation: 'update', id: 2, version: 8 }
	]);
	assert.deepEqual(await store.getMany(meta, [1, 2]), [
		{ id: 1, value: 'old-one', version: 4 },
		{ id: 2, value: 'old-two', version: 8 }
	]);
	assert.deepEqual(await outbox.list(), []);

	store.operation = 'delete';
	store.expectedVersions.length = 0;
	await assert.rejects(() => Record.deleteMany([1, 2]), /second delete conflict/);
	assert.deepEqual(store.expectedVersions, [
		{ operation: 'delete', id: 1, version: 4 },
		{ operation: 'delete', id: 2, version: 8 }
	]);
	assert.deepEqual(await store.getMany(meta, [1, 2]), [
		{ id: 1, value: 'old-one', version: 4 },
		{ id: 2, value: 'old-two', version: 8 }
	]);
	assert.deepEqual(await outbox.list(), []);
});

test('bulk post-write hook failures roll back every mutation and deferred outbox event', async () => {
	const events: string[] = [];
	let outboxId = 0;
	class BulkRollbackRecord extends Model<BulkData> {}
	defineModel<BulkData>('model_bulk_rollback_record')
		.id('id')
		.validate((input) => input as BulkData)
		.hooks({
			afterCreate(payload) {
				if (payload.id === 2) throw new Error('bulk afterCreate failed');
			}
		})
		.attach(BulkRollbackRecord);

	const store = new TracedMemoryStore(events);
	const outbox = new MemoryOutboxAdapter();
	const context = createActiveTs({
		stores: { default: store },
		plugins: [createOutboxPlugin({ outbox, includeData: true, id: () => `rollback-${++outboxId}` })]
	});
	const Record = BulkRollbackRecord.use(context) as typeof BulkRollbackRecord;

	await assert.rejects(
		() => Record.createMany([{ id: 1, value: 'one' }, { id: 2, value: 'two' }]),
		/bulk afterCreate failed/
	);
	assert.deepEqual(events.filter((event) => event.startsWith('write:')), [
		'write:create:1',
		'write:create:2'
	]);
	assert.equal(events.at(-1), 'transaction:rollback');
	assert.equal(await store.get(context.meta(BulkRollbackRecord), 1), null);
	assert.equal(await store.get(context.meta(BulkRollbackRecord), 2), null);
	assert.deepEqual(await outbox.list(), []);
});

test('caught bulk failures poison ambient transactions but remain recoverable through savepoints', async () => {
	const events: string[] = [];
	class BulkCaughtFailureRecord extends Model<BulkData> {}
	defineModel<BulkData>('model_bulk_caught_failure_record')
		.id('id')
		.validate((input) => input as BulkData)
		.hooks({
			afterCreate(payload) {
				if (payload.id === 2) throw new Error('caught bulk failure');
			}
		})
		.attach(BulkCaughtFailureRecord);

	const store = new TracedMemoryStore(events);
	const context = createActiveTs({ stores: { default: store } });
	const Record = BulkCaughtFailureRecord.use(context) as typeof BulkCaughtFailureRecord;

	await assert.rejects(
		() => Record.transaction(async (tx) => {
			await assert.rejects(
				() => Record.createMany([{ id: 1, value: 'one' }, { id: 2, value: 'two' }], tx),
				/caught bulk failure/
			);
			await Record.create({ id: 3, value: 'must roll back' }, tx);
		}),
		/caught bulk failure/
	);
	assert.deepEqual(await store.getMany(context.meta(BulkCaughtFailureRecord), [1, 2, 3]), [null, null, null]);

	await Record.transaction(async (tx) => {
		await assert.rejects(
			() => tx.transaction(async (savepoint) => {
				await assert.rejects(
					() => Record.createMany([{ id: 1, value: 'one' }, { id: 2, value: 'two' }], savepoint),
					/caught bulk failure/
				);
			}, { join: 'savepoint' }),
			/caught bulk failure/
		);
		await Record.create({ id: 3, value: 'parent commits' }, tx);
	});
	assert.deepEqual(await store.getMany(context.meta(BulkCaughtFailureRecord), [1, 2, 3]), [
		null,
		null,
		{ id: 3, value: 'parent commits' }
	]);
});

test('deleteMany preflights existing rows, skips missing hooks, and deletes in input order', async () => {
	const events: string[] = [];
	class BulkDeleteRecord extends Model<BulkData> {}
	defineModel<BulkData>('model_bulk_delete_record')
		.id('id')
		.validate((input) => input as BulkData)
		.hooks({
			beforeDelete(payload) {
				events.push(`beforeDelete:${String(payload.id)}`);
			},
			afterDelete(payload) {
				events.push(`afterDelete:${String(payload.id)}`);
			}
		})
		.attach(BulkDeleteRecord);

	const store = new TracedMemoryStore(events);
	const context = createActiveTs({ stores: { default: store } });
	const Record = BulkDeleteRecord.use(context) as typeof BulkDeleteRecord;
	await store.seed(context.meta(BulkDeleteRecord), [
		{ id: 1, value: 'one' },
		{ id: 2, value: 'two' }
	]);

	await Record.deleteMany([1, 99, 2]);

	assert.deepEqual(events, [
		'transaction:begin',
		'beforeDelete:1',
		'beforeDelete:2',
		'write:delete:1',
		'write:delete:2',
		'afterDelete:1',
		'afterDelete:2',
		'transaction:commit'
	]);
	assert.equal(await store.get(context.meta(BulkDeleteRecord), 1), null);
	assert.equal(await store.get(context.meta(BulkDeleteRecord), 2), null);
});

test('model bulk APIs reuse an ambient transaction instead of nesting', async () => {
	const events: string[] = [];
	class BulkReuseRecord extends Model<BulkData> {}
	defineModel<BulkData>('model_bulk_reuse_record')
		.id('id')
		.validate((input) => input as BulkData)
		.attach(BulkReuseRecord);

	const store = new TracedMemoryStore(events);
	const context = createActiveTs({ stores: { default: store } });
	const Record = BulkReuseRecord.use(context) as typeof BulkReuseRecord;

	await Record.transaction(async (tx) => {
		await Record.createMany([{ id: 1, value: 'one' }], tx);
		const upserted = await Record.upsertMany([
			{ id: 1, value: 'updated' },
			{ id: 2, value: 'temporary' }
		], tx);
		assert.deepEqual(upserted.map((result) => result.operation), ['update', 'create']);
		await Record.deleteMany([2], tx);
	});

	assert.equal(store.transactionCalls, 1);
	assert.equal((await Record.find(1).load())?.data.value, 'updated');
	assert.equal(await Record.find(2).load(), null);
});

test('model bulk APIs reject an ambient transaction scoped to another store before hooks or writes', async () => {
	let hookCalls = 0;
	class CrossStoreBulkRecord extends Model<BulkData> {}
	defineModel<BulkData>({ name: 'model_cross_store_bulk_record', store: 'secondary' })
		.id('id')
		.validate((input) => input as BulkData)
		.hooks({
			beforeCreate() {
				hookCalls++;
			}
		})
		.attach(CrossStoreBulkRecord);

	const primaryEvents: string[] = [];
	const secondaryEvents: string[] = [];
	const primary = new TracedMemoryStore(primaryEvents);
	const secondary = new TracedMemoryStore(secondaryEvents);
	const context = createActiveTs({
		stores: { primary, secondary },
		defaultStore: 'primary'
	});
	const Record = CrossStoreBulkRecord.use(context) as typeof CrossStoreBulkRecord;

	await context.transaction(async (tx) => {
		await assert.rejects(
			() => Record.createMany([{ id: 1, value: 'wrong store' }], tx),
			/Cannot start nested transaction for store "secondary" inside transaction scoped to store "primary"/
		);
	}, { store: 'primary' });

	assert.equal(hookCalls, 0);
	assert.equal(primary.transactionCalls, 1);
	assert.equal(secondary.transactionCalls, 0);
	assert.equal(await secondary.get(context.meta(CrossStoreBulkRecord), 1), null);
});

test('model bulk APIs preserve typed ids and reject duplicate or accessor inputs before writes', async () => {
	const events: string[] = [];
	let accessorCalls = 0;
	class BulkInputRecord extends Model<BulkData> {}
	defineModel<BulkData>('model_bulk_input_record')
		.id('id')
		.validate((input) => input as BulkData)
		.attach(BulkInputRecord);

	const store = new TracedMemoryStore(events);
	const context = createActiveTs({ stores: { default: store } });
	const Record = BulkInputRecord.use(context) as typeof BulkInputRecord;
	const accessorRow = Object.create(null) as Record<string, unknown>;
	Object.defineProperty(accessorRow, 'id', {
		enumerable: true,
		get() {
			accessorCalls++;
			return 3;
		}
	});
	Object.defineProperty(accessorRow, 'value', { enumerable: true, value: 'accessor' });

	const typed = await Record.upsertMany([
		{ id: 1, value: 'number' },
		{ id: '1', value: 'string' }
	]);
	assert.deepEqual(typed.map((result) => result.operation), ['create', 'create']);
	const transactionCalls = store.transactionCalls;
	await assert.rejects(
		() => Record.upsertMany([{ id: 2, value: 'first' }, { id: 2, value: 'duplicate' }]),
		/duplicate id/
	);
	await assert.rejects(() => Record.deleteMany([1, 1]), /duplicate id/);
	await assert.rejects(() => Record.createMany([accessorRow as BulkData]), /data accessor/);
	assert.equal(accessorCalls, 0);
	assert.equal(store.transactionCalls, transactionCalls);
	assert.deepEqual(await Record.createMany([]), []);
	assert.deepEqual(await Record.upsertMany([]), []);
	await Record.deleteMany([]);
	assert.equal(store.transactionCalls, transactionCalls);
});

test('model bulk APIs require transaction support before running write hooks', async () => {
	let hookCalls = 0;
	class BulkUnsupportedRecord extends Model<BulkData> {}
	defineModel<BulkData>('model_bulk_unsupported_record')
		.id('id')
		.validate((input) => input as BulkData)
		.hooks({
			beforeCreate() {
				hookCalls++;
			}
		})
		.attach(BulkUnsupportedRecord);

	const backing = new MemoryStoreAdapter();
	const store: StoreAdapter = {
		kind: 'nontransactional-memory',
		capabilities: { ...backing.capabilities, transaction: false, savepoint: false },
		get: (model, id, options) => backing.get(model, id, options),
		getMany: (model, ids, options) => backing.getMany(model, ids, options),
		query: (model, plan, options) => backing.query(model, plan, options),
		aggregate: (model, plan) => backing.aggregate(model, plan),
		create: (model, id, data, options) => backing.create(model, id, data, options),
		update: (model, id, data, options) => backing.update(model, id, data, options),
		delete: (model, id, options) => backing.delete(model, id, options)
	};
	const context = createActiveTs({ stores: { default: store } });
	const Record = BulkUnsupportedRecord.use(context) as typeof BulkUnsupportedRecord;

	await assert.rejects(
		() => Record.createMany([{ id: 1, value: 'one' }]),
		/does not support transactions/
	);
	assert.equal(hookCalls, 0);
	assert.equal(await backing.get(context.meta(BulkUnsupportedRecord), 1), null);
});

test('createMany distinguishes Datastore ancestor identities and validates adapter namespaces before writes', async () => {
	type AncestorBulkData = { id: number; parentId: number; namespace?: string; value: string };
	class AncestorBulkRecord extends Model<AncestorBulkData> {}
	defineModel<AncestorBulkData>('model_bulk_ancestor_record')
		.id('id')
		.validate((input) => input as AncestorBulkData)
		.datastore({
			ancestor: ({ data }) => data
				? datastoreKey(
						'model_bulk_parent',
						data.parentId,
						data.namespace === undefined ? undefined : { namespace: data.namespace }
					)
				: undefined,
			ancestorFields: ['parentId', 'namespace']
		})
		.attach(AncestorBulkRecord);

	const committed: Array<{ id: string | number; ancestor: unknown }> = [];
	const adapter: StoreAdapter = {
		kind: 'ancestor-transaction-test',
		datastoreNamespace: 'tenant',
		capabilities: {
			transaction: true,
			datastoreAncestor: true,
			optimisticLock: false
		},
		get: async () => null,
		getMany: async (_model, ids) => ids.map(() => null),
		query: async () => ({ list: [] }),
		create: async () => {
			throw new Error('root create must not run');
		},
		update: async () => {
			throw new Error('root update must not run');
		},
		delete: async () => {
			throw new Error('root delete must not run');
		},
		transaction: async (fn) => {
			const pending: Array<{ id: string | number; ancestor: unknown }> = [];
			const tx: StoreAdapter = {
				kind: 'ancestor-transaction-test',
				datastoreNamespace: 'tenant',
				capabilities: {
					transaction: false,
					datastoreAncestor: true,
					optimisticLock: false
				},
				get: async () => null,
				getMany: async (_model, ids) => ids.map(() => null),
				query: async () => ({ list: [] }),
				create: async (_model, id, _data, options) => {
					pending.push({ id, ancestor: options?.meta?.datastoreAncestor });
				},
				update: async () => undefined,
				delete: async () => undefined
			};
			const result = await fn(tx);
			committed.push(...pending);
			return result;
		}
	};
	const context = createActiveTs({ stores: { default: adapter } });
	const Record = AncestorBulkRecord.use(context) as typeof AncestorBulkRecord;

	await Record.createMany([
		{ id: 1, parentId: 10, value: 'left' },
		{ id: 1, parentId: 20, value: 'right' }
	]);
	assert.deepEqual(committed.map((write) => write.id), [1, 1]);
	assert.deepEqual(
		committed.map((write) => (write.ancestor as { path: unknown[] }).path),
		[
			[{ kind: 'model_bulk_parent', id: 10 }],
			[{ kind: 'model_bulk_parent', id: 20 }]
		]
	);

	await assert.rejects(
		() => Record.createMany([
			{ id: 2, parentId: 30, value: 'first' },
			{ id: 2, parentId: 30, value: 'duplicate' }
		]),
		/same entity identity/
	);
	await assert.rejects(
		() => Record.createMany([{ id: 3, parentId: 40, namespace: 'other', value: 'wrong namespace' }]),
		/namespace must match adapter namespace/
	);
	assert.equal(committed.length, 2);
});
