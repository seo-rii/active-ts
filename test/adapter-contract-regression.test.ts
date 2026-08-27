import test from 'node:test';
import assert from 'node:assert/strict';
import {
	Model,
	createActiveTs,
	createCacheMiddlewareAdapter,
	createSearchMiddlewareAdapter,
	createStoreMiddlewareAdapter,
	defineModel,
	type AggregatePlan,
	type DatastoreKey,
	type QueryPlan,
	type QueryResult,
	type ResolvedModelMeta,
	type SchemaPlan,
	type StoreAdapter,
	type SearchAdapter,
	type CacheAdapter,
	MemorySearchAdapter,
	MemoryCacheAdapter,
	MemoryStoreAdapter
} from '../src/index.js';
import { datastoreKeyIdentity } from '../src/core/datastore-key.js';
import {
	createCacheAdapterContractSuite,
	createIntegrationHarness,
	createSearchAdapterContractSuite,
	runCacheAdapterContract,
	runSearchAdapterContract,
	runStoreAdapterContract
} from '../src/testing/index.js';
import { createAlgoliaSearchAdapter } from '../src/adapters/search/algolia.js';

type RegressionRecordData = {
	id: number;
	handle: string;
	tags?: string[];
	body?: string;
	version?: number;
};

class DuplicateCreateRegressionRecord extends Model<RegressionRecordData> {}
class LegacyContainsRegressionRecord extends Model<RegressionRecordData> {}
class TransactionMiddlewareRegressionRecord extends Model<RegressionRecordData> {}

const validateRegressionRecord = (input: unknown) => input as RegressionRecordData;

defineModel<RegressionRecordData>({ name: 'adapter_contract_duplicate_create_regression' })
	.id('id')
	.validate(validateRegressionRecord)
	.attach(DuplicateCreateRegressionRecord);

defineModel<RegressionRecordData>({ name: 'adapter_contract_legacy_contains_regression' })
	.id('id')
	.validate(validateRegressionRecord)
	.attach(LegacyContainsRegressionRecord);

defineModel<RegressionRecordData>({ name: 'adapter_contract_tx_middleware_regression' })
	.id('id')
	.validate(validateRegressionRecord)
	.attach(TransactionMiddlewareRegressionRecord);

function searchContractValueAt(data: any, field: string) {
	let current = data;
	for (const key of field.split('.')) {
		if (!current || typeof current !== 'object') return undefined;
		current = current[key];
	}
	return current;
}

test('contract subagent: memory duplicate create rejects and preserves the original row', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = DuplicateCreateRegressionRecord.use(context) as unknown as typeof DuplicateCreateRegressionRecord;

	await Record.create({ id: 1, handle: 'original', tags: ['kept'], body: 'unchanged' });
	await assert.rejects(
		() => Record.create({ id: 1, handle: 'duplicate', tags: ['lost'], body: 'overwritten' }),
		/already exists/
	);

	const loaded = await Record.find(1).load();
	assert.deepEqual(loaded?.data, {
		id: 1,
		handle: 'original',
		tags: ['kept'],
		body: 'unchanged'
	});
	assert.deepEqual(store.dump('adapter_contract_duplicate_create_regression'), [
		{ id: 1, handle: 'original', tags: ['kept'], body: 'unchanged' }
	]);
});

test('contract subagent: legacy contains is rejected by the planner before store execution', async () => {
	let queryReachedStore = false;
	const store: StoreAdapter = {
		kind: 'no-capability-store',
		get: async () => null,
		getMany: async (model, ids) => ids.map(() => null),
		query: async (_model: ResolvedModelMeta, _plan: QueryPlan): Promise<QueryResult> => {
			queryReachedStore = true;
			throw new Error('query should not reach the store');
		},
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	const context = createActiveTs({ stores: { default: store } });
	const Record = LegacyContainsRegressionRecord.use(context) as unknown as typeof LegacyContainsRegressionRecord;

	assert.throws(
		() => Record.query().where('tags', 'contains' as any, 'cat'),
		/legacy contains operator is ambiguous/
	);
	assert.equal(queryReachedStore, false);
});

test('contract subagent: store middleware remains active for transaction store operations', async () => {
	const events: string[] = [];
	const base = new MemoryStoreAdapter();
	const store = createStoreMiddlewareAdapter(base, [
		async (context, next) => {
			events.push(`${context.operation}:${context.model.name}`);
			return await next();
		}
	]);
	const context = createActiveTs({ stores: { default: store } });

	await context.transaction(async (tx) => {
		const Record = TransactionMiddlewareRegressionRecord.use(tx) as unknown as typeof TransactionMiddlewareRegressionRecord;
		await Record.create({ id: 1, handle: 'created', version: 1 });
		const loaded = await Record.find(1).load();
		assert.equal(loaded?.data.handle, 'created');
		loaded!.data.handle = 'updated';
		await loaded!.save();
		await Record.delete(1);
	});

	assert.deepEqual(events, [
		'create:adapter_contract_tx_middleware_regression',
		'getMany:adapter_contract_tx_middleware_regression',
		'update:adapter_contract_tx_middleware_regression',
		'get:adapter_contract_tx_middleware_regression',
		'delete:adapter_contract_tx_middleware_regression'
	]);
	assert.deepEqual(base.dump('adapter_contract_tx_middleware_regression'), []);
});

test('store middleware args cannot rewrite optimistic lock options before next', async () => {
	const base = new MemoryStoreAdapter();
	const store = createStoreMiddlewareAdapter(base, [
		async (context, next) => {
			if (context.operation === 'update') {
				delete (context.args[2] as { expectedVersion?: number }).expectedVersion;
			}
			return await next();
		}
	]);
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(TransactionMiddlewareRegressionRecord);
	await base.seed(meta, [{ id: 1, handle: 'existing', version: 2 }]);

	await assert.rejects(
		() => store.update(meta, 1, { id: 1, handle: 'updated', version: 3 }, { expectedVersion: 1 }),
		/Optimistic lock failed/
	);
	assert.deepEqual(base.dump('adapter_contract_tx_middleware_regression'), [
		{ id: 1, handle: 'existing', version: 2 }
	]);
});

test('store adapter contract rejects optimistic lock adapters that ignore expectedVersion', async () => {
	const base = new MemoryStoreAdapter();
	const broken: StoreAdapter = {
		kind: 'broken-optimistic-lock-store',
		capabilities: { ...base.capabilities, optimisticLock: true, transaction: false },
		schema: base.schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: (model, plan, options) => base.query(model, plan, options),
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data, options) => base.create(model, id, data, options),
		update: (model, id, data) => base.update(model, id, data),
		delete: (model, id) => base.delete(model, id)
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/Missing expected rejection/
	);
});

test('store adapter contract rejects optimistic lock adapters that ignore delete expectedVersion', async () => {
	const base = new MemoryStoreAdapter();
	const broken: StoreAdapter = {
		kind: 'broken-optimistic-delete-store',
		capabilities: { ...base.capabilities, optimisticLock: true, transaction: false },
		schema: base.schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: (model, plan, options) => base.query(model, plan, options),
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data) => base.create(model, id, data),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: (model, id) => base.delete(model, id)
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/Missing expected rejection/
	);
});

test('store adapter contract rejects transaction adapters that ignore optimistic expectedVersion', async () => {
	const base = new MemoryStoreAdapter();
	const stripExpectedVersion = (options: any) =>
		options?.expectedVersion === undefined ? options : { ...options, expectedVersion: undefined };
	const broken: StoreAdapter = {
		kind: 'broken-transaction-optimistic-lock-store',
		capabilities: { ...base.capabilities, optimisticLock: true, transaction: true },
		schema: base.schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: (model, plan, options) => base.query(model, plan, options),
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data, options) => base.create(model, id, data, options),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: (model, id, options) => base.delete(model, id, options),
		transaction: (callback, options) =>
			base.transaction(
				(tx) =>
					callback({
						...tx,
						capabilities: { ...tx.capabilities, optimisticLock: true, transaction: false },
						update: (model, id, data, options) => tx.update(model, id, data, stripExpectedVersion(options)),
						delete: (model, id, options) => tx.delete(model, id, stripExpectedVersion(options))
					}),
				options
			)
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/Missing expected rejection|stale optimistic transaction/
	);
});

test('store adapter contract rejects advertised get conflict detection that loses writes', async () => {
	const base = new MemoryStoreAdapter();
	const broken: StoreAdapter = {
		kind: 'broken-transaction-conflict-detection-store',
		capabilities: { ...base.capabilities, transactionConflictDetection: true },
		schema: base.schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: (model, plan, options) => base.query(model, plan, options),
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data, options) => base.create(model, id, data, options),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: (model, id, options) => base.delete(model, id, options),
		transaction: (callback, options) =>
			base.transaction(
				(tx) =>
					callback({
						...tx,
						get: (model, id, readOptions) =>
							id === 915 ? base.get(model, id, readOptions) : tx.get(model, id, readOptions)
					}),
				options
			)
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/advertises transactionConflictDetection: true but lost a concurrent write/
	);
});

test('store adapter contract rejects advertised getMany conflict detection that loses writes', async () => {
	const base = new MemoryStoreAdapter();
	const broken: StoreAdapter = {
		kind: 'broken-transaction-get-many-conflict-detection-store',
		capabilities: { ...base.capabilities, transactionConflictDetection: true },
		schema: base.schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: (model, plan, options) => base.query(model, plan, options),
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data, options) => base.create(model, id, data, options),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: (model, id, options) => base.delete(model, id, options),
		transaction: (callback, options) =>
			base.transaction(
				(tx) =>
					callback({
						...tx,
						getMany: (model, ids, readOptions) =>
							ids.length === 1 && ids[0] === 916
								? base.getMany(model, ids, readOptions)
								: tx.getMany(model, ids, readOptions)
					}),
				options
			)
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/advertises transactionConflictDetection: true but lost a concurrent write/
	);
});

test('store adapter contract rejects unsupported expectedVersion deletes that are accepted', async () => {
	const base = new MemoryStoreAdapter();
	const broken: StoreAdapter = {
		kind: 'broken-unsupported-delete-lock-store',
		capabilities: { ...base.capabilities, optimisticLock: false, transaction: false },
		schema: base.schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: (model, plan, options) => base.query(model, plan, options),
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data) => base.create(model, id, data),
		update: async (_model, _id, _data, options) => {
			if (options?.expectedVersion !== undefined) throw new Error('expectedVersion unsupported');
			return await base.update(_model, _id, _data);
		},
		delete: (model, id) => base.delete(model, id)
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/Missing expected rejection/
	);
});

test('store adapter contract rejects aggregate capability without aggregate method', async () => {
	const base = new MemoryStoreAdapter();
	const broken: StoreAdapter = {
		kind: 'broken-missing-aggregate-method-store',
		capabilities: { ...base.capabilities, aggregate: true, transaction: false },
		schema: base.schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: (model, plan, options) => base.query(model, plan, options),
		create: (model, id, data) => base.create(model, id, data),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: (model, id, options) => base.delete(model, id, options)
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/advertises aggregate support but does not expose aggregate/
	);
});

test('store adapter contract rejects transaction aggregate capability without aggregate method', async () => {
	const base = new MemoryStoreAdapter();
	const broken: StoreAdapter = {
		kind: 'broken-transaction-aggregate-store',
		capabilities: { ...base.capabilities, aggregate: true, transaction: true },
		schema: base.schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: (model, plan, options) => base.query(model, plan, options),
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data, options) => base.create(model, id, data, options),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: (model, id, options) => base.delete(model, id, options),
		transaction: (callback, options) =>
			base.transaction!(
				async (tx) =>
					callback({
						...tx,
						kind: 'broken-transaction-aggregate-store:tx',
						capabilities: { ...tx.capabilities, aggregate: true, transaction: false },
						aggregate: undefined
					}),
				options
			)
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/transaction callback adapter advertises capabilities\.aggregate: true but does not expose aggregate/
	);
});

test('store adapter contract rejects savepoint child adapters that drop savepoint capability', async () => {
	const base = new MemoryStoreAdapter();
	const wrapTransactionAdapter = (adapter: StoreAdapter, child: boolean): StoreAdapter => ({
		...adapter,
		capabilities: { ...(adapter.capabilities ?? {}), transaction: false, savepoint: !child },
		savepoint: adapter.savepoint
			? (fn) => adapter.savepoint!((nested) => fn(wrapTransactionAdapter(nested, true)))
			: undefined
	});
	const broken: StoreAdapter = {
		kind: 'broken-savepoint-child-capability-store',
		capabilities: base.capabilities,
		schema: base.schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: (model, plan, options) => base.query(model, plan, options),
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data, options) => base.create(model, id, data, options),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: (model, id, options) => base.delete(model, id, options),
		transaction: (fn, options) => base.transaction(
			(tx) => fn(wrapTransactionAdapter(tx, false)),
			options
		)
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/must preserve savepoint capability on child adapters/
	);
});

test('store adapter contract rejects root savepoint capability without a method', async () => {
	const base = new MemoryStoreAdapter();
	const broken: StoreAdapter = {
		kind: 'broken-root-savepoint-method-store',
		capabilities: { ...base.capabilities, savepoint: true },
		schema: base.schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: (model, plan, options) => base.query(model, plan, options),
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data, options) => base.create(model, id, data, options),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: (model, id, options) => base.delete(model, id, options),
		transaction: (fn, options) => base.transaction(fn, options)
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/advertises savepoint support but does not expose savepoint/
	);
});

test('store adapter contract rejects non-boolean transaction savepoint capability', async () => {
	const base = new MemoryStoreAdapter();
	const broken: StoreAdapter = {
		kind: 'broken-transaction-savepoint-capability-type-store',
		capabilities: base.capabilities,
		schema: base.schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: (model, plan, options) => base.query(model, plan, options),
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data, options) => base.create(model, id, data, options),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: (model, id, options) => base.delete(model, id, options),
		transaction: (fn, options) => base.transaction(
			(tx) => fn({
				...tx,
				capabilities: { ...(tx.capabilities ?? {}), savepoint: 'yes' as any }
			}),
			options
		)
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/capabilities\.savepoint must be a boolean/
	);
});

test('store adapter contract rejects savepoint adapters that run callbacks twice', async () => {
	const base = new MemoryStoreAdapter();
	const duplicateSavepoints = (adapter: StoreAdapter): StoreAdapter => ({
		...adapter,
		savepoint: adapter.savepoint
			? async (fn) => {
					let wrappedChild: StoreAdapter | undefined;
					const result = await adapter.savepoint!(async (child) => {
						wrappedChild = duplicateSavepoints(child);
						return await fn(wrappedChild);
					});
					setImmediate(() => {
						void fn(wrappedChild!).catch(() => undefined);
					});
					return result;
				}
			: undefined
	});
	const broken: StoreAdapter = {
		kind: 'broken-duplicate-savepoint-callback-store',
		capabilities: base.capabilities,
		schema: base.schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: (model, plan, options) => base.query(model, plan, options),
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data, options) => base.create(model, id, data, options),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: (model, id, options) => base.delete(model, id, options),
		transaction: (fn, options) => base.transaction(
			(tx) => fn(duplicateSavepoints(tx)),
			options
		)
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/must run each savepoint callback exactly once/
	);
});

test('store adapter contract rejects savepoint adapters that repeat failed callbacks', async () => {
	const base = new MemoryStoreAdapter();
	const duplicateRejectedSavepoints = (adapter: StoreAdapter): StoreAdapter => ({
		...adapter,
		savepoint: adapter.savepoint
			? (fn) => adapter.savepoint!(async (child) => {
					const wrappedChild = duplicateRejectedSavepoints(child);
					try {
						return await fn(wrappedChild);
					} catch (error) {
						try {
							await fn(wrappedChild);
						} catch {
							// Simulate an adapter that hides the repeated callback failure.
						}
						throw error;
					}
				})
			: undefined
	});
	const broken: StoreAdapter = {
		kind: 'broken-duplicate-rejected-savepoint-callback-store',
		capabilities: base.capabilities,
		schema: base.schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: (model, plan, options) => base.query(model, plan, options),
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data, options) => base.create(model, id, data, options),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: (model, id, options) => base.delete(model, id, options),
		transaction: (fn, options) => base.transaction(
			(tx) => fn(duplicateRejectedSavepoints(tx)),
			options
		)
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/must run each rolled-back savepoint callback exactly once/
	);
});

test('store adapter contract rejects aggregate adapters that drop OR branches', async () => {
	const base = new MemoryStoreAdapter();
	const stripAggregateOr = (plan: AggregatePlan): AggregatePlan => ({ ...plan, or: [] });
	const broken: StoreAdapter = {
		kind: 'broken-aggregate-or-store',
		capabilities: { ...base.capabilities, aggregate: true, or: true, transaction: false },
		schema: base.schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: (model, plan, options) => base.query(model, plan, options),
		aggregate: (model, plan) => base.aggregate(model, stripAggregateOr(plan)),
		create: (model, id, data) => base.create(model, id, data),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: (model, id, options) => base.delete(model, id, options)
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/aggregate OR contract/
	);
});

test('store adapter contract rejects aggregate adapters that drop nested filters', async () => {
	const base = new MemoryStoreAdapter();
	const stripNestedAggregateWhere = (plan: AggregatePlan): AggregatePlan => ({
		...plan,
		where: plan.where.filter((where) => !where.field.includes('.')),
		or: plan.or.map((branch) => ({
			...branch,
			where: branch.where.filter((where) => !where.field.includes('.'))
		}))
	});
	const broken: StoreAdapter = {
		kind: 'broken-aggregate-nested-store',
		capabilities: { ...base.capabilities, aggregate: true, nestedFields: true, transaction: false },
		schema: base.schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: (model, plan, options) => base.query(model, plan, options),
		aggregate: (model, plan) => base.aggregate(model, stripNestedAggregateWhere(plan)),
		create: (model, id, data) => base.create(model, id, data),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: (model, id, options) => base.delete(model, id, options)
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/nested aggregate contract/
	);
});

test('store adapter contract rejects typed id equality queries that collapse id types', async () => {
	const base = new MemoryStoreAdapter();
	const broken: StoreAdapter = {
		kind: 'broken-typed-id-query-store',
		capabilities: { ...base.capabilities, transaction: false },
		schema: base.schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: async (model, plan, options) => {
			if (plan.where.some((where) => where.field === 'id' && where.op === '=' && where.value === '900')) {
				const rows = (await base.getMany(model, [900, '900'], options)).filter((row) => row !== null);
				return { list: rows, count: rows.length, more: false };
			}
			return await base.query(model, plan, options);
		},
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data) => base.create(model, id, data),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: (model, id, options) => base.delete(model, id, options)
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/typed id equality query must not match numeric id 900/
	);
});

test('store adapter contract rejects typed id deletes that collapse id types', async () => {
	const base = new MemoryStoreAdapter();
	const broken: StoreAdapter = {
		kind: 'broken-typed-id-delete-store',
		capabilities: { ...base.capabilities, transaction: false },
		schema: base.schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: (model, plan, options) => base.query(model, plan, options),
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data, options) => base.create(model, id, data, options),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: async (model, id, options) => {
			await base.delete(model, id, options);
			if (id === 900) await base.delete(model, '900', options);
		}
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/typed id delete must not remove string id "900" when deleting number 900/
	);
});

test('store adapter contract rejects get rows whose id does not match the requested id', async () => {
	const base = new MemoryStoreAdapter();
	const broken: StoreAdapter = {
		kind: 'broken-get-id-store',
		capabilities: { ...base.capabilities, transaction: false },
		schema: base.schema,
		get: async (model, id, options) => {
			const row = await base.get(model, id, options);
			if (id === 1 && row) return { ...row, id: 2 };
			return row;
		},
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: (model, plan, options) => base.query(model, plan, options),
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data) => base.create(model, id, data),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: (model, id, options) => base.delete(model, id, options)
	};

	await assert.rejects(() => runStoreAdapterContract(broken), /operation id|must match/);
});

test('store adapter contract rejects getMany rows whose id does not match the requested slot', async () => {
	const base = new MemoryStoreAdapter();
	const broken: StoreAdapter = {
		kind: 'broken-getmany-id-store',
		capabilities: { ...base.capabilities, transaction: false },
		schema: base.schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: async (model, ids, options) => {
			const rows = await base.getMany(model, ids, options);
			if (rows[0]) rows[0] = { ...rows[0], id: 2 };
			return rows;
		},
		query: (model, plan, options) => base.query(model, plan, options),
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data) => base.create(model, id, data),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: (model, id, options) => base.delete(model, id, options)
	};

	await assert.rejects(() => runStoreAdapterContract(broken), /operation id|must match/);
});

test('store adapter contract rejects transaction adapters that do not roll back', async () => {
	const base = new MemoryStoreAdapter();
	const broken: StoreAdapter = {
		kind: 'broken-transaction-store',
		capabilities: { ...base.capabilities, transaction: true },
		schema: base.schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: (model, plan, options) => base.query(model, plan, options),
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data) => base.create(model, id, data),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: (model, id, options) => base.delete(model, id, options),
		transaction: async (callback, options) => {
			await base.transaction(async () => undefined, options);
			let closed = false;
			const assertOpen = () => {
				if (closed) throw new Error('broken transaction closed');
			};
			const tx: StoreAdapter = {
				...base,
				capabilities: { ...base.capabilities, transaction: false },
				schema: undefined,
				get: async (model, id, options) => {
					assertOpen();
					return await base.get(model, id, options);
				},
				getMany: async (model, ids, options) => {
					assertOpen();
					return await base.getMany(model, ids, options);
				},
				query: async (model, plan, options) => {
					assertOpen();
					return await base.query(model, plan, options);
				},
				aggregate: async (model, plan) => {
					assertOpen();
					return await base.aggregate(model, plan);
				},
				create: async (model, id, data, options) => {
					assertOpen();
					return await base.create(model, id, data, options);
				},
				update: async (model, id, data, options) => {
					assertOpen();
					return await base.update(model, id, data, options);
				},
				delete: async (model, id, options) => {
					assertOpen();
					return await base.delete(model, id, options);
				}
			};
			try {
				return await callback(tx);
			} finally {
				closed = true;
			}
		}
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/tx-rolled-back/
	);
});

test('store adapter contract rejects transaction adapters that accept malformed callbacks', async () => {
	const base = new MemoryStoreAdapter();
	const broken: StoreAdapter = {
		kind: 'broken-transaction-callback-store',
		capabilities: { ...base.capabilities, transaction: true },
		schema: base.schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: (model, plan, options) => base.query(model, plan, options),
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data, options) => base.create(model, id, data, options),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: (model, id, options) => base.delete(model, id, options),
		transaction: async (fn, options) => {
			if (fn === null) throw new Error('null callback rejected');
			if (typeof fn !== 'function') return undefined as never;
			return await base.transaction(fn, options);
		}
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/Store contract adapter "broken-transaction-callback-store" must reject malformed transaction callbacks/
	);
});

test('store adapter contract rejects transaction adapters that accept malformed options', async () => {
	const base = new MemoryStoreAdapter();
	const broken: StoreAdapter = {
		kind: 'broken-transaction-option-store',
		capabilities: { ...base.capabilities, transaction: true },
		schema: base.schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: (model, plan, options) => base.query(model, plan, options),
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data, options) => base.create(model, id, data, options),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: (model, id, options) => base.delete(model, id, options),
		transaction: async (fn, options) => {
			if (typeof fn !== 'function') throw new Error('transaction callback must be a function');
			const forwardedOptions =
				options && typeof options === 'object' && !Array.isArray(options) && (options as { readOnly?: unknown }).readOnly === true
					? { readOnly: true }
					: undefined;
			return await base.transaction(fn, forwardedOptions);
		}
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/Store contract adapter "broken-transaction-option-store" must reject malformed transaction options/
	);
});

test('store adapter contract rejects read-only transaction adapters that allow update or delete writes', async () => {
	const createBroken = (leakedOperation: 'update' | 'delete') => {
		const base = new MemoryStoreAdapter();
		const rejectReadOnlyWrite = async () => {
			throw new Error('read-only write rejected');
		};
		const broken: StoreAdapter = {
			kind: `broken-readonly-${leakedOperation}-store`,
			capabilities: { ...base.capabilities, transaction: true },
			schema: base.schema,
			get: (model, id, options) => base.get(model, id, options),
			getMany: (model, ids, options) => base.getMany(model, ids, options),
			query: (model, plan, options) => base.query(model, plan, options),
			aggregate: (model, plan) => base.aggregate(model, plan),
			create: (model, id, data, options) => base.create(model, id, data, options),
			update: (model, id, data, options) => base.update(model, id, data, options),
			delete: (model, id, options) => base.delete(model, id, options),
			transaction: async (fn, options) => {
				if (typeof fn !== 'function') throw new Error('transaction callback must be a function');
				await base.transaction(async () => undefined, options);
				const readOnly =
					options !== undefined &&
					typeof options === 'object' &&
					!Array.isArray(options) &&
					(options as { readOnly?: unknown }).readOnly === true;
				return await base.transaction(async (tx) => {
					const wrappedTx: StoreAdapter = {
						...tx,
						capabilities: { ...tx.capabilities, transaction: false },
						schema: undefined,
						transaction: undefined,
						create: readOnly ? rejectReadOnlyWrite : (model, id, data, writeOptions) => tx.create(model, id, data, writeOptions),
						update:
							readOnly && leakedOperation !== 'update'
								? rejectReadOnlyWrite
								: (model, id, data, writeOptions) => tx.update(model, id, data, writeOptions),
						delete:
							readOnly && leakedOperation !== 'delete'
								? rejectReadOnlyWrite
								: (model, id, writeOptions) => tx.delete(model, id, writeOptions)
					};
					return await fn(wrappedTx);
				});
			}
		};
		return broken;
	};

	await assert.rejects(
		() => runStoreAdapterContract(createBroken('update')),
		/read-only transaction update writes/
	);
	await assert.rejects(
		() => runStoreAdapterContract(createBroken('delete')),
		/read-only transaction delete writes/
	);
});

test('store adapter contract rejects read-only Datastore ancestor transaction writes', async () => {
	const root = new MemoryStoreAdapter();
	const stores = new Map<string, MemoryStoreAdapter>();
	const storeForAncestor = (ancestor: unknown) => {
		if (ancestor === undefined) return root;
		const key = datastoreKeyIdentity(ancestor as DatastoreKey);
		let store = stores.get(key);
		if (!store) {
			store = new MemoryStoreAdapter();
			stores.set(key, store);
		}
		return store;
	};
	const stripDatastoreAncestorPlan = <TPlan extends QueryPlan | AggregatePlan>(plan: TPlan): TPlan =>
		plan.meta?.datastoreAncestor === undefined ? plan : ({ ...plan, meta: undefined } as TPlan);
	const stripDatastoreAncestorOptions = (options: any) =>
		options?.meta?.datastoreAncestor === undefined ? options : { ...options, meta: undefined };
	const requireDatastoreReadAncestor = (model: ResolvedModelMeta, options: any) => {
		if (model.datastore?.ancestor && options?.meta?.datastoreAncestor === undefined) {
			throw new Error('Datastore ancestor read metadata is required');
		}
	};
	const rejectMismatchedWriteAncestor = (model: ResolvedModelMeta, id: any, data: any, options: any) => {
		if (!model.datastore?.ancestor || options?.meta?.datastoreAncestor === undefined) return;
		const expected = model.datastore.ancestor({ model, id, data });
		if (expected === undefined) return;
		if (datastoreKeyIdentity(expected) !== datastoreKeyIdentity(options.meta.datastoreAncestor)) {
			throw new Error('Datastore write metadata must match payload data');
		}
	};
	const isReadOnlyTransaction = (options: unknown) =>
		options !== undefined &&
		typeof options === 'object' &&
		!Array.isArray(options) &&
		(options as { readOnly?: unknown }).readOnly === true;
	const rejectReadOnlyWrite = async () => {
		throw new Error('read-only write rejected');
	};
	const scopedWriteStore = (model: ResolvedModelMeta, options: any, tx: StoreAdapter) =>
		model.datastore?.ancestor && options?.meta?.datastoreAncestor !== undefined
			? storeForAncestor(options.meta.datastoreAncestor)
			: tx;
	const broken: StoreAdapter = {
		kind: 'broken-readonly-ancestor-write-store',
		capabilities: { ...root.capabilities, datastoreAncestor: true, transaction: true },
		get: async (model, id, options) => {
			requireDatastoreReadAncestor(model, options);
			return storeForAncestor(options?.meta?.datastoreAncestor).get(model, id, stripDatastoreAncestorOptions(options));
		},
		getMany: async (model, ids, options) => {
			requireDatastoreReadAncestor(model, options);
			return storeForAncestor(options?.meta?.datastoreAncestor).getMany(model, ids, stripDatastoreAncestorOptions(options));
		},
		query: (model, plan, options) =>
			storeForAncestor(plan.meta?.datastoreAncestor).query(model, stripDatastoreAncestorPlan(plan), options),
		aggregate: (model, plan) =>
			storeForAncestor(plan.meta?.datastoreAncestor).aggregate(model, stripDatastoreAncestorPlan(plan)),
		create: async (model, id, data, options) => {
			rejectMismatchedWriteAncestor(model, id, data, options);
			return storeForAncestor(options?.meta?.datastoreAncestor).create(model, id, data, stripDatastoreAncestorOptions(options));
		},
		update: async (model, id, data, options) => {
			rejectMismatchedWriteAncestor(model, id, data, options);
			return storeForAncestor(options?.meta?.datastoreAncestor).update(model, id, data, stripDatastoreAncestorOptions(options));
		},
		delete: async (model, id, options) => {
			requireDatastoreReadAncestor(model, options);
			return storeForAncestor(options?.meta?.datastoreAncestor).delete(model, id, stripDatastoreAncestorOptions(options));
		},
		transaction: (callback, options) =>
			root.transaction(async (tx) => {
				const readOnly = isReadOnlyTransaction(options);
				const wrappedTx: StoreAdapter = {
					...tx,
					kind: 'broken-readonly-ancestor-write-store:tx',
					capabilities: { ...tx.capabilities, datastoreAncestor: true, transaction: false },
					schema: undefined,
					transaction: undefined,
					get: async (model, id, options) => {
						requireDatastoreReadAncestor(model, options);
						return (model.datastore?.ancestor ? storeForAncestor(options?.meta?.datastoreAncestor) : tx).get(
							model,
							id,
							stripDatastoreAncestorOptions(options)
						);
					},
					getMany: async (model, ids, options) => {
						requireDatastoreReadAncestor(model, options);
						return (model.datastore?.ancestor ? storeForAncestor(options?.meta?.datastoreAncestor) : tx).getMany(
							model,
							ids,
							stripDatastoreAncestorOptions(options)
						);
					},
					query: (model, plan, options) =>
						(model.datastore?.ancestor ? storeForAncestor(plan.meta?.datastoreAncestor) : tx).query(
							model,
							stripDatastoreAncestorPlan(plan),
							options
						),
					aggregate: (model, plan) =>
						(model.datastore?.ancestor ? storeForAncestor(plan.meta?.datastoreAncestor) : tx).aggregate!(
							model,
							stripDatastoreAncestorPlan(plan)
						),
					create: async (model, id, data, options) => {
						rejectMismatchedWriteAncestor(model, id, data, options);
						if (readOnly && (!model.datastore?.ancestor || options?.meta?.datastoreAncestor === undefined)) {
							return rejectReadOnlyWrite();
						}
						return scopedWriteStore(model, options, tx).create(model, id, data, stripDatastoreAncestorOptions(options));
					},
					update: async (model, id, data, options) => {
						rejectMismatchedWriteAncestor(model, id, data, options);
						if (readOnly && (!model.datastore?.ancestor || options?.meta?.datastoreAncestor === undefined)) {
							return rejectReadOnlyWrite();
						}
						return scopedWriteStore(model, options, tx).update(model, id, data, stripDatastoreAncestorOptions(options));
					},
					delete: async (model, id, options) => {
						requireDatastoreReadAncestor(model, options);
						if (readOnly && (!model.datastore?.ancestor || options?.meta?.datastoreAncestor === undefined)) {
							return rejectReadOnlyWrite();
						}
						return scopedWriteStore(model, options, tx).delete(model, id, stripDatastoreAncestorOptions(options));
					}
				};
				return callback(wrappedTx);
			}, options)
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/Store contract adapter "broken-readonly-ancestor-write-store" must reject read-only transaction Datastore ancestor .* writes/
	);
});

test('store adapter contract rejects transaction adapters that drop callback results', async () => {
	const base = new MemoryStoreAdapter();
	const broken: StoreAdapter = {
		kind: 'broken-transaction-result-store',
		capabilities: { ...base.capabilities, transaction: true },
		schema: base.schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: (model, plan, options) => base.query(model, plan, options),
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data, options) => base.create(model, id, data, options),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: (model, id, options) => base.delete(model, id, options),
		transaction: async (fn, options) => {
			if (typeof fn !== 'function') throw new Error('transaction callback must be a function');
			await base.transaction(fn, options);
			return undefined as never;
		}
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/Store contract adapter "broken-transaction-result-store" must resolve transaction callbacks to the callback result/
	);
});

test('store adapter contract rejects transaction adapters that replace rollback callback errors', async () => {
	const base = new MemoryStoreAdapter();
	const broken: StoreAdapter = {
		kind: 'broken-transaction-rollback-error-store',
		capabilities: { ...base.capabilities, transaction: true },
		schema: base.schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: (model, plan, options) => base.query(model, plan, options),
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data, options) => base.create(model, id, data, options),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: (model, id, options) => base.delete(model, id, options),
		transaction: async (fn, options) => {
			if (typeof fn !== 'function') throw new Error('transaction callback must be a function');
			try {
				return await base.transaction(fn, options);
			} catch {
				throw new Error('replacement rollback error');
			}
		}
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/Store contract adapter "broken-transaction-rollback-error-store" must reject rollback transactions with the callback error/
	);
});

test('store adapter contract rejects transaction adapters that keep retained handles open', async () => {
	const base = new MemoryStoreAdapter();
	const broken: StoreAdapter = {
		kind: 'broken-transaction-retained-handle-store',
		capabilities: { ...base.capabilities, transaction: true },
		schema: base.schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: (model, plan, options) => base.query(model, plan, options),
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data, options) => base.create(model, id, data, options),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: (model, id, options) => base.delete(model, id, options),
		transaction: async (fn, options) => {
			if (typeof fn !== 'function') throw new Error('transaction callback must be a function');
			let settled = false;
			return await base.transaction(async (tx) => {
				const leakyTx: StoreAdapter = {
					kind: tx.kind,
					capabilities: { ...tx.capabilities, savepoint: false },
					get: (model, id, readOptions) => (settled ? base : tx).get(model, id, readOptions),
					getMany: (model, ids, readOptions) => (settled ? base : tx).getMany(model, ids, readOptions),
					query: (model, plan, readOptions) => (settled ? base : tx).query(model, plan, readOptions),
					aggregate: tx.aggregate ? (model, plan) => (settled ? base : tx).aggregate!(model, plan) : undefined,
					create: (model, id, data, writeOptions) => (settled ? base : tx).create(model, id, data, writeOptions),
					update: (model, id, data, writeOptions) => (settled ? base : tx).update(model, id, data, writeOptions),
					delete: (model, id, writeOptions) => (settled ? base : tx).delete(model, id, writeOptions)
				};
				try {
					return await fn(leakyTx);
				} finally {
					settled = true;
				}
			}, options);
		}
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/Store contract adapter "broken-transaction-retained-handle-store" must close transaction callback adapters/
	);
});

test('store adapter contract rejects transaction adapters that leak retained writes after reads close', async () => {
	const base = new MemoryStoreAdapter();
	const broken: StoreAdapter = {
		kind: 'broken-transaction-retained-write-store',
		capabilities: { ...base.capabilities, transaction: true },
		schema: base.schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: (model, plan, options) => base.query(model, plan, options),
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data, options) => base.create(model, id, data, options),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: (model, id, options) => base.delete(model, id, options),
		transaction: async (fn, options) => {
			if (typeof fn !== 'function') throw new Error('transaction callback must be a function');
			let settled = false;
			return await base.transaction(async (tx) => {
				const assertReadOpen = () => {
					if (settled) throw new Error('retained read handle closed');
				};
				const leakyTx: StoreAdapter = {
					kind: tx.kind,
					capabilities: { ...tx.capabilities, savepoint: false },
					get: async (model, id, readOptions) => {
						assertReadOpen();
						return await tx.get(model, id, readOptions);
					},
					getMany: async (model, ids, readOptions) => {
						assertReadOpen();
						return await tx.getMany(model, ids, readOptions);
					},
					query: async (model, plan, readOptions) => {
						assertReadOpen();
						return await tx.query(model, plan, readOptions);
					},
					aggregate: tx.aggregate
						? async (model, plan) => {
								assertReadOpen();
								return await tx.aggregate!(model, plan);
							}
						: undefined,
					create: (model, id, data, writeOptions) => (settled ? base : tx).create(model, id, data, writeOptions),
					update: (model, id, data, writeOptions) => (settled ? base : tx).update(model, id, data, writeOptions),
					delete: (model, id, writeOptions) => (settled ? base : tx).delete(model, id, writeOptions)
				};
				try {
					return await fn(leakyTx);
				} finally {
					settled = true;
				}
			}, options);
		}
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/Store contract adapter "broken-transaction-retained-write-store" must close transaction callback adapters after commit \(create\)/
	);
});

test('store adapter contract rejects transaction adapters that skip rollback callbacks', async () => {
	const base = new MemoryStoreAdapter();
	let validTransactions = 0;
	const broken: StoreAdapter = {
		kind: 'broken-transaction-skipped-rollback-callback-store',
		capabilities: { ...base.capabilities, transaction: true },
		schema: base.schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: (model, plan, options) => base.query(model, plan, options),
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data, options) => base.create(model, id, data, options),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: (model, id, options) => base.delete(model, id, options),
		transaction: async (fn, options) => {
			if (typeof fn !== 'function') throw new Error('transaction callback must be a function');
			await base.transaction(async () => undefined, options);
			validTransactions++;
			if (validTransactions === 7) throw new Error('rollback callback skipped');
			return await base.transaction(fn);
		}
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/Store contract adapter "broken-transaction-skipped-rollback-callback-store" must invoke transaction callbacks before rollback/
	);
});

test('store adapter contract rejects transaction adapters that expose schema hooks', async () => {
	const base = new MemoryStoreAdapter();
	const broken: StoreAdapter = {
		kind: 'broken-transaction-schema-store',
		capabilities: { ...base.capabilities, transaction: true },
		schema: base.schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: (model, plan, options) => base.query(model, plan, options),
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data, options) => base.create(model, id, data, options),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: (model, id, options) => base.delete(model, id, options),
		transaction: async (fn, options) => {
			if (typeof fn !== 'function') throw new Error('transaction callback must be a function');
			return await base.transaction(async (tx) => {
				const schemaTx: StoreAdapter = {
					...tx,
					schema: base.schema
				};
				return await fn(schemaTx);
			}, options);
		}
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/Store contract adapter "broken-transaction-schema-store" must not expose schema hooks on transaction callback adapters/
	);
});

test('store adapter contract rejects transaction adapters that expose nested transaction hooks', async () => {
	const base = new MemoryStoreAdapter();
	const broken: StoreAdapter = {
		kind: 'broken-transaction-nested-store',
		capabilities: { ...base.capabilities, transaction: true },
		schema: base.schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: (model, plan, options) => base.query(model, plan, options),
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data, options) => base.create(model, id, data, options),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: (model, id, options) => base.delete(model, id, options),
		transaction: async (fn, options) => {
			if (typeof fn !== 'function') throw new Error('transaction callback must be a function');
			return await base.transaction(async (tx) => {
				const nestedTx: StoreAdapter = {
					...tx,
					capabilities: { ...tx.capabilities, transaction: false },
					transaction: (nestedFn, nestedOptions) => base.transaction(nestedFn, nestedOptions)
				};
				return await fn(nestedTx);
			}, options);
		}
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/Store contract adapter "broken-transaction-nested-store" must not expose nested transaction hooks on transaction callback adapters/
	);
});

test('store adapter contract rejects omitted capabilities that accept optional plans', async () => {
	const base = new MemoryStoreAdapter();
	const permissive: StoreAdapter = {
		kind: 'permissive-omitted-capabilities-store',
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: (model, plan, options) => base.query(model, plan, options),
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data) => base.create(model, id, data),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: (model, id) => base.delete(model, id)
	};

	await assert.rejects(
		() => runStoreAdapterContract(permissive),
		/Missing expected rejection/
	);
});

test('store adapter contract rejects offset-disabled adapters that accept offset plans', async () => {
	const base = new MemoryStoreAdapter();
	const permissive: StoreAdapter = {
		kind: 'permissive-offset-disabled-store',
		capabilities: { ...base.capabilities, offset: false, transaction: false },
		schema: base.schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: (model, plan, options) => base.query(model, plan, options),
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data, options) => base.create(model, id, data, options),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: (model, id, options) => base.delete(model, id, options)
	};

	await assert.rejects(
		() => runStoreAdapterContract(permissive),
		/Missing expected rejection/
	);
});

test('store adapter contract rejects transaction adapters that accept unsupported query capabilities', async () => {
	const base = new MemoryStoreAdapter();
	const rejectCursorPlan = (plan: QueryPlan) => {
		if (plan.cursor !== undefined) throw new Error('cursor unsupported');
	};
	const stripCursorPlan = (plan: QueryPlan): QueryPlan =>
		plan.cursor === undefined ? plan : { ...plan, cursor: undefined };
	const stripCursorResult = async (result: Promise<QueryResult>): Promise<QueryResult> => {
		const rows = await result;
		return rows.cursor === undefined ? rows : { ...rows, cursor: undefined };
	};
	const broken: StoreAdapter = {
		kind: 'broken-transaction-unsupported-query-capability-store',
		capabilities: { ...base.capabilities, cursor: false, transaction: true },
		schema: base.schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: async (model, plan, options) => {
			rejectCursorPlan(plan);
			return await stripCursorResult(base.query(model, plan, options));
		},
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data, options) => base.create(model, id, data, options),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: (model, id, options) => base.delete(model, id, options),
		transaction: (callback, options) =>
			base.transaction(
				(tx) =>
					callback({
						...tx,
						capabilities: { ...tx.capabilities, cursor: false, transaction: false },
						query: async (model, plan, options) =>
							await stripCursorResult(tx.query(model, stripCursorPlan(plan), options))
					}),
				options
			)
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/Missing expected rejection/
	);
});

test('store adapter contract rejects native-capable adapters that ignore native function payloads', async () => {
	const base = new MemoryStoreAdapter();
	const broken: StoreAdapter = {
		kind: 'broken-native-store',
		capabilities: { ...base.capabilities, native: true, transaction: false },
		schema: base.schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: (model, plan, options) => base.query(model, { ...plan, native: undefined }, options),
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data) => base.create(model, id, data),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: (model, id, options) => base.delete(model, id, options)
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken, { nativeProbe: async () => undefined }),
		/native-probe|Expected values/
	);
});

test('store adapter contract requires nativeProbe for advertised native support', async () => {
	const base = new MemoryStoreAdapter();
	const broken: StoreAdapter = {
		kind: 'unprobed-native-store',
		capabilities: { ...base.capabilities, native: true, transaction: false },
		schema: base.schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: (model, plan, options) => base.query(model, plan, options),
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data) => base.create(model, id, data),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: (model, id, options) => base.delete(model, id, options)
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/nativeProbe/
	);
});

test('store adapter contract probes transaction native-capable callback adapters', async () => {
	const base = new MemoryStoreAdapter();
	const txNativeWrapper = (tx: StoreAdapter): StoreAdapter => ({
		kind: 'broken-transaction-native-store:tx',
		capabilities: { ...tx.capabilities, aggregate: false, native: true, savepoint: false },
		get: (model, id, options) => tx.get(model, id, options),
		getMany: (model, ids, options) => tx.getMany(model, ids, options),
		query: (model, plan, options) => tx.query(model, { ...plan, native: undefined }, options),
		create: (model, id, data, options) => tx.create(model, id, data, options),
		update: (model, id, data, options) => tx.update(model, id, data, options),
		delete: (model, id, options) => tx.delete(model, id, options)
	});
	const broken: StoreAdapter = {
		kind: 'broken-transaction-native-store',
		capabilities: { ...base.capabilities, aggregate: false, native: true, transaction: true },
		schema: base.schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: async (model, plan, options) => {
			if (typeof plan.native?.payload === 'function') return (await plan.native.payload()) as QueryResult;
			return base.query(model, plan, options);
		},
		create: (model, id, data, options) => base.create(model, id, data, options),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: (model, id, options) => base.delete(model, id, options),
		transaction: async (fn, options) => await base.transaction!(async (tx) => await fn(txNativeWrapper(tx)), options)
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken, { nativeProbe: async () => undefined }),
		/tx-native-probe|Expected values/
	);
});

test('store adapter contract rejects native-capable aggregate adapters that ignore native aggregate function payloads', async () => {
	const base = new MemoryStoreAdapter();
	const broken: StoreAdapter = {
		kind: 'broken-native-aggregate-store',
		capabilities: { ...base.capabilities, native: true, aggregate: true, transaction: false },
		schema: base.schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: async (model, plan, options) => {
			if (typeof plan.native?.payload === 'function') return (await plan.native.payload()) as QueryResult;
			return base.query(model, plan, options);
		},
		aggregate: (model, plan) => base.aggregate(model, { ...plan, native: undefined }),
		create: (model, id, data) => base.create(model, id, data),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: (model, id, options) => base.delete(model, id, options)
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken, { nativeProbe: async () => undefined }),
		/native aggregate function payload must control aggregate result/
	);
});

test('store adapter contract rejects advertised missing-field null support that only matches explicit null', async () => {
	const base = new MemoryStoreAdapter();
	const broken: StoreAdapter = {
		kind: 'broken-missing-field-nulls-store',
		capabilities: { ...base.capabilities, missingFieldNulls: true },
		schema: base.schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: async (model, plan, options) => {
			const result = await base.query(model, plan, options);
			if (plan.meta?.requiresMissingFieldNulls) {
				return {
					...result,
					list: result.list.filter((item) => item.optionalMarker === null),
					count: result.list.filter((item) => item.optionalMarker === null).length
				};
			}
			return result;
		},
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data) => base.create(model, id, data),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: (model, id) => base.delete(model, id),
		transaction: (callback, options) => base.transaction(callback, options)
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/Expected values to be strictly deep-equal/
	);
});

test('store adapter contract rejects field-codec queries that skip operand encoding', async () => {
	const base = new MemoryStoreAdapter();
	const withoutFieldCodecs = (model: ResolvedModelMeta) => ({ ...model, fieldCodecs: new Map() });
	const broken: StoreAdapter = {
		kind: 'broken-field-codec-query-store',
		capabilities: { ...base.capabilities },
		schema: base.schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: (model, plan, options) => base.query(withoutFieldCodecs(model), plan, options),
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data) => base.create(model, id, data),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: (model, id, options) => base.delete(model, id, options),
		transaction: (callback, options) => base.transaction(callback, options)
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/field codec query contract must encode portable operands/
	);
});

test('store adapter contract rejects codec-backed aggregate fields that are accepted', async () => {
	const base = new MemoryStoreAdapter();
	const withoutFieldCodecs = (model: ResolvedModelMeta) => ({ ...model, fieldCodecs: new Map() });
	const broken: StoreAdapter = {
		kind: 'broken-field-codec-aggregate-store',
		capabilities: { ...base.capabilities },
		schema: base.schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: (model, plan, options) => base.query(model, plan, options),
		aggregate: (model, plan) => base.aggregate(withoutFieldCodecs(model), plan),
		create: (model, id, data) => base.create(model, id, data),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: (model, id, options) => base.delete(model, id, options),
		transaction: (callback, options) => base.transaction(callback, options)
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/field codec aggregate contract must reject codec-backed aggregate fields/
	);
});

test('store adapter contract rejects advertised numeric comparisons that do not narrow rows', async () => {
	const base = new MemoryStoreAdapter();
	const broken: StoreAdapter = {
		kind: 'broken-numeric-comparison-store',
		capabilities: { ...base.capabilities, numericComparisons: true },
		schema: base.schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: (model, plan, options) =>
			base.query(
				model,
				{
					...plan,
					where: plan.where.filter((where) => !['>', '>=', '<', '<='].includes(where.op))
				},
				options
			),
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data) => base.create(model, id, data),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: (model, id, options) => base.delete(model, id, options),
		transaction: (callback, options) => base.transaction(callback, options)
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/numeric comparison contract must narrow score >= 15/
	);
});

test('store adapter contract rejects advertised cursor support without follow-up cursor metadata', async () => {
	const base = new MemoryStoreAdapter();
	const broken: StoreAdapter = {
		kind: 'broken-cursor-store',
		capabilities: { ...base.capabilities, cursor: true },
		schema: base.schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: async (model, plan, options) => {
			const result = await base.query(model, plan, options);
			if (plan.limit !== undefined) return { ...result, cursor: undefined };
			return result;
		},
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data) => base.create(model, id, data),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: (model, id, options) => base.delete(model, id, options),
		transaction: (callback, options) => base.transaction(callback, options)
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/cursor-capable stores must include a cursor/
	);
});

test('store adapter contract rejects cursor-disabled native query cursor leaks', async () => {
	const base = new MemoryStoreAdapter();
	const broken: StoreAdapter = {
		kind: 'broken-native-cursor-leak-store',
		capabilities: { ...base.capabilities, native: true, cursor: false },
		schema: base.schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: (model, plan, options) => {
			if (typeof plan.native?.payload === 'function') {
				return Promise.resolve({
					list: [{ id: 1, name: 'alpha', score: 10 }],
					more: true,
					cursor: 'backend-cursor'
				});
			}
			return base.query(model, plan, options);
		},
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data) => base.create(model, id, data),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: (model, id, options) => base.delete(model, id, options),
		transaction: (callback, options) => base.transaction(callback, options)
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken, { nativeProbe: async () => undefined }),
		/stores without cursor capability must not expose portable cursors from native queries/
	);
});

test('store adapter contract rejects uniqueIndex adapters that omit unique schema changes', async () => {
	const base = new MemoryStoreAdapter();
	const broken: StoreAdapter = {
		kind: 'broken-unique-schema-store',
		capabilities: { ...base.capabilities, uniqueIndex: true },
		schema: {
			plan: async (): Promise<SchemaPlan> => ({ adapter: 'broken-unique-schema-store', changes: [] }),
			apply: async (): Promise<SchemaPlan> => ({ adapter: 'broken-unique-schema-store', changes: [] })
		},
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: (model, plan, options) => base.query(model, plan, options),
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data) => base.create(model, id, data),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: (model, id, options) => base.delete(model, id, options),
		transaction: (callback, options) => base.transaction(callback, options)
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/must include the declared unique index with directions/
	);
});

test('store adapter contract rejects uniqueIndex adapters that omit index directions', async () => {
	const base = new MemoryStoreAdapter();
	const schema = {
		plan: async (models: ResolvedModelMeta[]): Promise<SchemaPlan> => ({
			adapter: 'broken-unique-direction-store',
			changes: models.flatMap((model) =>
				model.indexes.map((index) => ({
					type: 'create-index' as const,
					target: model.name,
					name: index.name,
					fields: index.fields,
					unique: index.unique
				}))
			)
		}),
		apply: async (models: ResolvedModelMeta[]): Promise<SchemaPlan> => schema.plan(models)
	};
	const broken: StoreAdapter = {
		kind: 'broken-unique-direction-store',
		capabilities: { ...base.capabilities, uniqueIndex: true },
		schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: (model, plan, options) => base.query(model, plan, options),
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data) => base.create(model, id, data),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: (model, id, options) => base.delete(model, id, options),
		transaction: (callback, options) => base.transaction(callback, options)
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/must include the declared unique index with directions/
	);
});

test('store adapter contract rejects Datastore ancestor adapters that omit the unscoped index mode', async () => {
	const base = new MemoryStoreAdapter();
	const schema = {
		plan: async (models: ResolvedModelMeta[]): Promise<SchemaPlan> => ({
			adapter: 'broken-ancestor-schema-store',
			changes: models.flatMap((model) =>
				model.indexes.map((index) => ({
					type: 'create-index' as const,
					target: model.name,
					name: index.name,
					fields: [...index.fields, model.idField],
					directions: [...(index.directions ?? index.fields.map(() => 'asc' as const)), 'asc' as const],
					unique: index.unique,
					ancestor: model.datastore?.ancestor === undefined ? false : true
				}))
			)
		}),
		apply: async (models: ResolvedModelMeta[]): Promise<SchemaPlan> => schema.plan(models)
	};
	const broken: StoreAdapter = {
		kind: 'broken-ancestor-schema-store',
		capabilities: { ...base.capabilities, datastoreAncestor: true },
		schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: (model, plan, options) => base.query(model, plan, options),
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data, options) => base.create(model, id, data, options),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: (model, id, options) => base.delete(model, id, options),
		transaction: (callback, options) => base.transaction(callback, options)
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/declared Datastore ancestor index with runtime fields, directions, and both ancestor modes/
	);
});

test('store adapter contract rejects Datastore ancestor schema indexes without runtime fields and directions', async () => {
	const base = new MemoryStoreAdapter();
	const schema = {
		plan: async (models: ResolvedModelMeta[]): Promise<SchemaPlan> => ({
			adapter: 'broken-ancestor-runtime-index-store',
			changes: models.flatMap((model) =>
				model.indexes.map((index) => ({
					type: 'create-index' as const,
					target: model.name,
					name: index.name,
					fields: index.fields,
					directions: index.directions,
					unique: index.unique,
					ancestor: model.datastore?.ancestor ? true : undefined
				}))
			)
		}),
		apply: async (models: ResolvedModelMeta[]): Promise<SchemaPlan> => schema.plan(models)
	};
	const broken: StoreAdapter = {
		kind: 'broken-ancestor-runtime-index-store',
		capabilities: { ...base.capabilities, datastoreAncestor: true },
		schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: (model, plan, options) => base.query(model, plan, options),
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data, options) => base.create(model, id, data, options),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: (model, id, options) => base.delete(model, id, options),
		transaction: (callback, options) => base.transaction(callback, options)
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/declared Datastore ancestor index with runtime fields, directions, and both ancestor modes/
	);
});

test('store adapter contract rejects uniqueIndex adapters that do not enforce duplicates', async () => {
	const base = new MemoryStoreAdapter();
	const schema = {
		plan: async (models: ResolvedModelMeta[]): Promise<SchemaPlan> => ({
			adapter: 'broken-unique-enforcement-store',
			changes: models.flatMap((model) =>
				model.indexes.map((index) => ({
					type: 'create-index' as const,
					target: model.name,
					name: index.name,
					fields: index.fields,
					directions: index.directions,
					unique: index.unique
				}))
			)
		}),
		apply: async (models: ResolvedModelMeta[]): Promise<SchemaPlan> => schema.plan(models)
	};
	const broken: StoreAdapter = {
		kind: 'broken-unique-enforcement-store',
		capabilities: { ...base.capabilities, uniqueIndex: true },
		schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: (model, plan, options) => base.query(model, plan, options),
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data) => base.create(model, id, data),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: (model, id, options) => base.delete(model, id, options),
		transaction: (callback, options) => base.transaction(callback, options)
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/Missing expected rejection/
	);
});

test('store adapter contract rejects adapters that ignore custom id fields', async () => {
	const base = new MemoryStoreAdapter();
	const idModel = (model: ResolvedModelMeta): ResolvedModelMeta =>
		model.idField === 'slug' ? { ...model, idField: 'id' } : model;
	const idData = (model: ResolvedModelMeta, id: string | number, data: any) =>
		model.idField === 'slug' ? { id, name: data.name, score: data.score } : data;
	const broken: StoreAdapter = {
		kind: 'broken-custom-id-store',
		capabilities: base.capabilities,
		schema: {
			plan: (models) => base.schema.plan(models.map(idModel)),
			apply: (models, options) => base.schema.apply(models.map(idModel), options)
		},
		get: (model, id, options) => base.get(idModel(model), id, options),
		getMany: (model, ids, options) => base.getMany(idModel(model), ids, options),
		query: (model, plan, options) => base.query(idModel(model), plan, options),
		aggregate: (model, plan) => base.aggregate(idModel(model), plan),
		create: (model, id, data) => base.create(idModel(model), id, idData(model, id, data)),
		update: (model, id, data, options) => base.update(idModel(model), id, idData(model, id, data), options),
		delete: (model, id, options) => base.delete(idModel(model), id, options),
		transaction: (callback, options) => base.transaction(callback, options)
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/Missing expected rejection|Store contract result id|Expected values to be strictly deep-equal/
	);
});

test('store adapter contract rejects Datastore ancestor metadata without capability', async () => {
	const base = new MemoryStoreAdapter();
	const stripDatastoreAncestorPlan = (plan: QueryPlan): QueryPlan =>
		plan.meta?.datastoreAncestor === undefined
			? plan
			: { ...plan, meta: { ...plan.meta, datastoreAncestor: undefined } };
	const stripDatastoreAncestorWriteOptions = (options: any) =>
		options?.meta?.datastoreAncestor === undefined ? options : { ...options, meta: undefined };
	const broken: StoreAdapter = {
		kind: 'broken-ancestor-unsupported-store',
		capabilities: { ...base.capabilities, datastoreAncestor: false },
		schema: base.schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: (model, plan, options) => base.query(model, stripDatastoreAncestorPlan(plan), options),
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data, options) =>
			base.create(model, id, data, stripDatastoreAncestorWriteOptions(options)),
		update: (model, id, data, options) =>
			base.update(model, id, data, stripDatastoreAncestorWriteOptions(options)),
		delete: (model, id, options) => base.delete(model, id, stripDatastoreAncestorWriteOptions(options)),
		transaction: (callback, options) => base.transaction(callback, options)
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/Missing expected rejection/
	);
});

test('store adapter contract rejects Datastore ancestor aggregate metadata without capability', async () => {
	const base = new MemoryStoreAdapter();
	const rejectDatastoreAncestorPlan = (plan: QueryPlan | AggregatePlan) => {
		if (plan.meta?.datastoreAncestor !== undefined) throw new Error('Datastore ancestor metadata unsupported');
	};
	const rejectDatastoreAncestorOptions = (options: any) => {
		if (options?.meta?.datastoreAncestor !== undefined) throw new Error('Datastore ancestor metadata unsupported');
	};
	const stripDatastoreAncestorAggregatePlan = (plan: AggregatePlan): AggregatePlan =>
		plan.meta?.datastoreAncestor === undefined
			? plan
			: { ...plan, meta: { ...plan.meta, datastoreAncestor: undefined } };
	const broken: StoreAdapter = {
		kind: 'broken-ancestor-aggregate-unsupported-store',
		capabilities: { ...base.capabilities, aggregate: true, datastoreAncestor: false, transaction: false },
		schema: base.schema,
		get: (model, id, options) => {
			rejectDatastoreAncestorOptions(options);
			return base.get(model, id, options);
		},
		getMany: (model, ids, options) => {
			rejectDatastoreAncestorOptions(options);
			return base.getMany(model, ids, options);
		},
		query: (model, plan, options) => {
			rejectDatastoreAncestorPlan(plan);
			return base.query(model, plan, options);
		},
		aggregate: (model, plan) => base.aggregate(model, stripDatastoreAncestorAggregatePlan(plan)),
		create: (model, id, data, options) => {
			rejectDatastoreAncestorOptions(options);
			return base.create(model, id, data, options);
		},
		update: (model, id, data, options) => {
			rejectDatastoreAncestorOptions(options);
			return base.update(model, id, data, options);
		},
		delete: (model, id, options) => {
			rejectDatastoreAncestorOptions(options);
			return base.delete(model, id, options);
		}
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/Missing expected rejection|Datastore ancestor metadata/
	);
});

test('store adapter contract rejects transaction Datastore ancestor metadata without capability', async () => {
	const base = new MemoryStoreAdapter();
	const rejectDatastoreAncestorPlan = (plan: QueryPlan | AggregatePlan) => {
		if (plan.meta?.datastoreAncestor !== undefined) throw new Error('Datastore ancestor metadata unsupported');
	};
	const rejectDatastoreAncestorOptions = (options: any) => {
		if (options?.meta?.datastoreAncestor !== undefined) throw new Error('Datastore ancestor metadata unsupported');
	};
	const stripDatastoreAncestorPlan = <T extends QueryPlan | AggregatePlan>(plan: T): T =>
		plan.meta?.datastoreAncestor === undefined
			? plan
			: { ...plan, meta: { ...plan.meta, datastoreAncestor: undefined } };
	const stripDatastoreAncestorOptions = (options: any) =>
		options?.meta?.datastoreAncestor === undefined ? options : { ...options, meta: undefined };
	const broken: StoreAdapter = {
		kind: 'broken-ancestor-transaction-unsupported-store',
		capabilities: { ...base.capabilities, aggregate: true, datastoreAncestor: false, transaction: true },
		schema: base.schema,
		get: (model, id, options) => {
			rejectDatastoreAncestorOptions(options);
			return base.get(model, id, options);
		},
		getMany: (model, ids, options) => {
			rejectDatastoreAncestorOptions(options);
			return base.getMany(model, ids, options);
		},
		query: (model, plan, options) => {
			rejectDatastoreAncestorPlan(plan);
			return base.query(model, plan, options);
		},
		aggregate: (model, plan) => {
			rejectDatastoreAncestorPlan(plan);
			return base.aggregate(model, plan);
		},
		create: (model, id, data, options) => {
			rejectDatastoreAncestorOptions(options);
			return base.create(model, id, data, options);
		},
		update: (model, id, data, options) => {
			rejectDatastoreAncestorOptions(options);
			return base.update(model, id, data, options);
		},
		delete: (model, id, options) => {
			rejectDatastoreAncestorOptions(options);
			return base.delete(model, id, options);
		},
		transaction: (callback, options) =>
			base.transaction(
				(tx) =>
					callback({
						kind: 'broken-ancestor-transaction-unsupported-tx',
						capabilities: { ...tx.capabilities, aggregate: true, datastoreAncestor: false, transaction: false },
						get: (model, id, options) => tx.get(model, id, stripDatastoreAncestorOptions(options)),
						getMany: (model, ids, options) => tx.getMany(model, ids, stripDatastoreAncestorOptions(options)),
						query: (model, plan, options) => tx.query(model, stripDatastoreAncestorPlan(plan), options),
						aggregate: (model, plan) => tx.aggregate!(model, stripDatastoreAncestorPlan(plan)),
						create: (model, id, data, options) =>
							tx.create(model, id, data, stripDatastoreAncestorOptions(options)),
						update: (model, id, data, options) =>
							tx.update(model, id, data, stripDatastoreAncestorOptions(options)),
						delete: (model, id, options) => tx.delete(model, id, stripDatastoreAncestorOptions(options))
					}),
				options
			)
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/Missing expected rejection|Datastore ancestor metadata/
	);
});

test('store adapter contract rejects Datastore ancestor write metadata without capability', async () => {
	const base = new MemoryStoreAdapter();
	const stripDatastoreAncestorWriteOptions = (options: any) =>
		options?.meta?.datastoreAncestor === undefined ? options : { ...options, meta: undefined };
	const broken: StoreAdapter = {
		kind: 'broken-ancestor-write-unsupported-store',
		capabilities: { ...base.capabilities, datastoreAncestor: false },
		schema: base.schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: (model, plan, options) => base.query(model, plan, options),
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data, options) =>
			base.create(model, id, data, stripDatastoreAncestorWriteOptions(options)),
		update: (model, id, data, options) =>
			base.update(model, id, data, stripDatastoreAncestorWriteOptions(options)),
		delete: (model, id, options) => base.delete(model, id, stripDatastoreAncestorWriteOptions(options)),
		transaction: (callback, options) => base.transaction(callback, options)
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/Missing expected rejection/
	);
});

test('store adapter contract rejects Datastore ancestor update metadata without capability', async () => {
	const base = new MemoryStoreAdapter();
	const broken: StoreAdapter = {
		kind: 'broken-ancestor-update-unsupported-store',
		capabilities: { ...base.capabilities, datastoreAncestor: false },
		schema: base.schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: (model, plan, options) => base.query(model, plan, options),
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data, options) => base.create(model, id, data, options),
		update: (model, id, data, options) =>
			base.update(
				model,
				id,
				data,
				options?.meta?.datastoreAncestor === undefined ? options : { ...options, meta: undefined }
			),
		delete: (model, id, options) => base.delete(model, id, options),
		transaction: (callback, options) => base.transaction(callback, options)
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/Missing expected rejection/
	);
});

test('store adapter contract rejects Datastore ancestor delete metadata without capability', async () => {
	const base = new MemoryStoreAdapter();
	const broken: StoreAdapter = {
		kind: 'broken-ancestor-delete-unsupported-store',
		capabilities: { ...base.capabilities, datastoreAncestor: false },
		schema: base.schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: (model, plan, options) => base.query(model, plan, options),
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data, options) => base.create(model, id, data, options),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: (model, id, options) =>
			base.delete(model, id, options?.meta?.datastoreAncestor === undefined ? options : { ...options, meta: undefined }),
		transaction: (callback, options) => base.transaction(callback, options)
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/Missing expected rejection/
	);
});

test('store adapter contract rejects Datastore ancestor adapters that collapse scoped identities', async () => {
	const base = new MemoryStoreAdapter();
	const stripDatastoreAncestorPlan = (plan: QueryPlan): QueryPlan =>
		plan.meta?.datastoreAncestor === undefined
			? plan
			: { ...plan, meta: { ...plan.meta, datastoreAncestor: undefined } };
	const stripDatastoreAncestorWriteOptions = (options: any) =>
		options?.meta?.datastoreAncestor === undefined ? options : { ...options, meta: undefined };
	const broken: StoreAdapter = {
		kind: 'broken-ancestor-collapsing-store',
		capabilities: { ...base.capabilities, datastoreAncestor: true },
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: (model, plan, options) => base.query(model, stripDatastoreAncestorPlan(plan), options),
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data, options) =>
			base.create(model, id, data, stripDatastoreAncestorWriteOptions(options)),
		update: (model, id, data, options) =>
			base.update(model, id, data, stripDatastoreAncestorWriteOptions(options)),
		delete: (model, id, options) => base.delete(model, id, stripDatastoreAncestorWriteOptions(options)),
		transaction: (callback, options) => base.transaction(callback, options)
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/already exists|Datastore ancestor/
	);
});

test('store adapter contract rejects Datastore ancestor adapters that ignore direct read metadata', async () => {
	const root = new MemoryStoreAdapter();
	const stores = new Map<string, MemoryStoreAdapter>();
	const storeForAncestor = (ancestor: unknown) => {
		if (ancestor === undefined) return root;
		const key = datastoreKeyIdentity(ancestor as DatastoreKey);
		let store = stores.get(key);
		if (!store) {
			store = new MemoryStoreAdapter();
			stores.set(key, store);
		}
		return store;
	};
	const firstAncestorStore = () => {
		for (const store of stores.values()) return store;
		return root;
	};
	const stripDatastoreAncestorPlan = <TPlan extends QueryPlan | AggregatePlan>(plan: TPlan): TPlan =>
		plan.meta?.datastoreAncestor === undefined ? plan : ({ ...plan, meta: undefined } as TPlan);
	const stripDatastoreAncestorOptions = (options: any) =>
		options?.meta?.datastoreAncestor === undefined ? options : { ...options, meta: undefined };
	const broken: StoreAdapter = {
		kind: 'broken-ancestor-direct-read-store',
		capabilities: { ...root.capabilities, datastoreAncestor: true },
		get: (model, id, options) => (model.datastore?.ancestor ? firstAncestorStore() : root).get(model, id, stripDatastoreAncestorOptions(options)),
		getMany: (model, ids, options) => (model.datastore?.ancestor ? firstAncestorStore() : root).getMany(model, ids, stripDatastoreAncestorOptions(options)),
		query: (model, plan, options) =>
			storeForAncestor(plan.meta?.datastoreAncestor).query(model, stripDatastoreAncestorPlan(plan), options),
		aggregate: (model, plan) =>
			storeForAncestor(plan.meta?.datastoreAncestor).aggregate(model, stripDatastoreAncestorPlan(plan)),
		create: (model, id, data, options) =>
			storeForAncestor(options?.meta?.datastoreAncestor).create(model, id, data, stripDatastoreAncestorOptions(options)),
		update: (model, id, data, options) =>
			storeForAncestor(options?.meta?.datastoreAncestor).update(model, id, data, stripDatastoreAncestorOptions(options)),
		delete: (model, id, options) =>
			storeForAncestor(options?.meta?.datastoreAncestor).delete(model, id, stripDatastoreAncestorOptions(options)),
		transaction: (callback, options) => root.transaction(callback, options)
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/Missing expected rejection|direct gets|direct getMany reads|resolved outside the scoped Datastore ancestor/
	);
});

test('store adapter contract rejects Datastore ancestor adapters that ignore getMany read metadata', async () => {
	const root = new MemoryStoreAdapter();
	const stores = new Map<string, MemoryStoreAdapter>();
	const storeForAncestor = (ancestor: unknown) => {
		if (ancestor === undefined) return root;
		const key = datastoreKeyIdentity(ancestor as DatastoreKey);
		let store = stores.get(key);
		if (!store) {
			store = new MemoryStoreAdapter();
			stores.set(key, store);
		}
		return store;
	};
	const firstAncestorStore = () => {
		for (const store of stores.values()) return store;
		return root;
	};
	const stripDatastoreAncestorPlan = <TPlan extends QueryPlan | AggregatePlan>(plan: TPlan): TPlan =>
		plan.meta?.datastoreAncestor === undefined ? plan : ({ ...plan, meta: undefined } as TPlan);
	const stripDatastoreAncestorOptions = (options: any) =>
		options?.meta?.datastoreAncestor === undefined ? options : { ...options, meta: undefined };
	const requireDatastoreReadAncestor = (model: ResolvedModelMeta, options: any) => {
		if (model.datastore?.ancestor && options?.meta?.datastoreAncestor === undefined) {
			throw new Error('Datastore ancestor read metadata is required');
		}
	};
	const broken: StoreAdapter = {
		kind: 'broken-ancestor-getmany-read-store',
		capabilities: { ...root.capabilities, datastoreAncestor: true },
		get: (model, id, options) => {
			requireDatastoreReadAncestor(model, options);
			return storeForAncestor(options?.meta?.datastoreAncestor).get(model, id, stripDatastoreAncestorOptions(options));
		},
		getMany: (model, ids, options) => {
			requireDatastoreReadAncestor(model, options);
			return (model.datastore?.ancestor ? firstAncestorStore() : root).getMany(model, ids, stripDatastoreAncestorOptions(options));
		},
		query: (model, plan, options) =>
			storeForAncestor(plan.meta?.datastoreAncestor).query(model, stripDatastoreAncestorPlan(plan), options),
		aggregate: (model, plan) =>
			storeForAncestor(plan.meta?.datastoreAncestor).aggregate(model, stripDatastoreAncestorPlan(plan)),
		create: (model, id, data, options) =>
			storeForAncestor(options?.meta?.datastoreAncestor).create(model, id, data, stripDatastoreAncestorOptions(options)),
		update: (model, id, data, options) =>
			storeForAncestor(options?.meta?.datastoreAncestor).update(model, id, data, stripDatastoreAncestorOptions(options)),
		delete: (model, id, options) =>
			storeForAncestor(options?.meta?.datastoreAncestor).delete(model, id, stripDatastoreAncestorOptions(options)),
		transaction: (callback, options) => root.transaction(callback, options)
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/Missing expected rejection|direct getMany reads|resolved outside the scoped Datastore ancestor/
	);
});

test('store adapter contract rejects Datastore ancestor adapters that accept mismatched write metadata', async () => {
	const root = new MemoryStoreAdapter();
	const stores = new Map<string, MemoryStoreAdapter>();
	const storeForAncestor = (ancestor: unknown) => {
		if (ancestor === undefined) return root;
		const key = datastoreKeyIdentity(ancestor as DatastoreKey);
		let store = stores.get(key);
		if (!store) {
			store = new MemoryStoreAdapter();
			stores.set(key, store);
		}
		return store;
	};
	const stripDatastoreAncestorPlan = <TPlan extends QueryPlan | AggregatePlan>(plan: TPlan): TPlan =>
		plan.meta?.datastoreAncestor === undefined ? plan : ({ ...plan, meta: undefined } as TPlan);
	const stripDatastoreAncestorOptions = (options: any) =>
		options?.meta?.datastoreAncestor === undefined ? options : { ...options, meta: undefined };
	const requireDatastoreReadAncestor = (model: ResolvedModelMeta, options: any) => {
		if (model.datastore?.ancestor && options?.meta?.datastoreAncestor === undefined) {
			throw new Error('Datastore ancestor read metadata is required');
		}
	};
	const broken: StoreAdapter = {
		kind: 'broken-ancestor-write-mismatch-store',
		capabilities: { ...root.capabilities, datastoreAncestor: true, transaction: false },
		get: (model, id, options) => {
			requireDatastoreReadAncestor(model, options);
			return storeForAncestor(options?.meta?.datastoreAncestor).get(model, id, stripDatastoreAncestorOptions(options));
		},
		getMany: (model, ids, options) => {
			requireDatastoreReadAncestor(model, options);
			return storeForAncestor(options?.meta?.datastoreAncestor).getMany(model, ids, stripDatastoreAncestorOptions(options));
		},
		query: (model, plan, options) =>
			storeForAncestor(plan.meta?.datastoreAncestor).query(model, stripDatastoreAncestorPlan(plan), options),
		aggregate: (model, plan) =>
			storeForAncestor(plan.meta?.datastoreAncestor).aggregate(model, stripDatastoreAncestorPlan(plan)),
		create: (model, id, data, options) =>
			storeForAncestor(options?.meta?.datastoreAncestor).create(model, id, data, stripDatastoreAncestorOptions(options)),
		update: (model, id, data, options) =>
			storeForAncestor(options?.meta?.datastoreAncestor).update(model, id, data, stripDatastoreAncestorOptions(options)),
		delete: (model, id, options) => {
			requireDatastoreReadAncestor(model, options);
			return storeForAncestor(options?.meta?.datastoreAncestor).delete(model, id, stripDatastoreAncestorOptions(options));
		}
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/Datastore create metadata|write metadata|Missing expected rejection/
	);
});

test('store adapter contract rejects Datastore ancestor transaction adapters that accept mismatched write metadata', async () => {
	const root = new MemoryStoreAdapter();
	const stores = new Map<string, MemoryStoreAdapter>();
	const storeForAncestor = (ancestor: unknown) => {
		if (ancestor === undefined) return root;
		const key = datastoreKeyIdentity(ancestor as DatastoreKey);
		let store = stores.get(key);
		if (!store) {
			store = new MemoryStoreAdapter();
			stores.set(key, store);
		}
		return store;
	};
	const stripDatastoreAncestorPlan = <TPlan extends QueryPlan | AggregatePlan>(plan: TPlan): TPlan =>
		plan.meta?.datastoreAncestor === undefined ? plan : ({ ...plan, meta: undefined } as TPlan);
	const stripDatastoreAncestorOptions = (options: any) =>
		options?.meta?.datastoreAncestor === undefined ? options : { ...options, meta: undefined };
	const requireDatastoreReadAncestor = (model: ResolvedModelMeta, options: any) => {
		if (model.datastore?.ancestor && options?.meta?.datastoreAncestor === undefined) {
			throw new Error('Datastore ancestor read metadata is required');
		}
	};
	const rejectMismatchedWriteAncestor = (model: ResolvedModelMeta, id: any, data: any, options: any) => {
		if (!model.datastore?.ancestor || options?.meta?.datastoreAncestor === undefined) return;
		const expected = model.datastore.ancestor({ model, id, data });
		if (expected === undefined) return;
		if (datastoreKeyIdentity(expected) !== datastoreKeyIdentity(options.meta.datastoreAncestor)) {
			throw new Error('Datastore write metadata must match payload data');
		}
	};
	const broken: StoreAdapter = {
		kind: 'broken-ancestor-transaction-write-mismatch-store',
		capabilities: { ...root.capabilities, datastoreAncestor: true, transaction: true },
		get: (model, id, options) => {
			requireDatastoreReadAncestor(model, options);
			return storeForAncestor(options?.meta?.datastoreAncestor).get(model, id, stripDatastoreAncestorOptions(options));
		},
		getMany: (model, ids, options) => {
			requireDatastoreReadAncestor(model, options);
			return storeForAncestor(options?.meta?.datastoreAncestor).getMany(model, ids, stripDatastoreAncestorOptions(options));
		},
		query: (model, plan, options) =>
			storeForAncestor(plan.meta?.datastoreAncestor).query(model, stripDatastoreAncestorPlan(plan), options),
		aggregate: (model, plan) =>
			storeForAncestor(plan.meta?.datastoreAncestor).aggregate(model, stripDatastoreAncestorPlan(plan)),
		create: (model, id, data, options) => {
			rejectMismatchedWriteAncestor(model, id, data, options);
			return storeForAncestor(options?.meta?.datastoreAncestor).create(model, id, data, stripDatastoreAncestorOptions(options));
		},
		update: (model, id, data, options) => {
			rejectMismatchedWriteAncestor(model, id, data, options);
			return storeForAncestor(options?.meta?.datastoreAncestor).update(model, id, data, stripDatastoreAncestorOptions(options));
		},
		delete: (model, id, options) => {
			requireDatastoreReadAncestor(model, options);
			return storeForAncestor(options?.meta?.datastoreAncestor).delete(model, id, stripDatastoreAncestorOptions(options));
		},
		transaction: (callback, options) =>
			root.transaction(async (tx) => callback({
				...tx,
				kind: 'broken-ancestor-transaction-write-mismatch-store:tx',
				capabilities: { ...tx.capabilities, datastoreAncestor: true, transaction: false },
				get: (model, id, options) => {
					requireDatastoreReadAncestor(model, options);
					return storeForAncestor(options?.meta?.datastoreAncestor).get(model, id, stripDatastoreAncestorOptions(options));
				},
				getMany: (model, ids, options) => {
					requireDatastoreReadAncestor(model, options);
					return storeForAncestor(options?.meta?.datastoreAncestor).getMany(model, ids, stripDatastoreAncestorOptions(options));
				},
				query: (model, plan, options) =>
					storeForAncestor(plan.meta?.datastoreAncestor).query(model, stripDatastoreAncestorPlan(plan), options),
				aggregate: (model, plan) =>
					storeForAncestor(plan.meta?.datastoreAncestor).aggregate(model, stripDatastoreAncestorPlan(plan)),
				create: (model, id, data, options) =>
					storeForAncestor(options?.meta?.datastoreAncestor).create(model, id, data, stripDatastoreAncestorOptions(options)),
				update: (model, id, data, options) =>
					storeForAncestor(options?.meta?.datastoreAncestor).update(model, id, data, stripDatastoreAncestorOptions(options)),
				delete: (model, id, options) => {
					requireDatastoreReadAncestor(model, options);
					return storeForAncestor(options?.meta?.datastoreAncestor).delete(model, id, stripDatastoreAncestorOptions(options));
				}
			}), options)
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/Datastore transaction create metadata|Datastore transaction update metadata|write metadata|Missing expected rejection/
	);
});

test('store adapter contract rejects Datastore ancestor transaction adapters that ignore direct read metadata', async () => {
	const root = new MemoryStoreAdapter();
	const stores = new Map<string, MemoryStoreAdapter>();
	const storeForAncestor = (ancestor: unknown) => {
		if (ancestor === undefined) return root;
		const key = datastoreKeyIdentity(ancestor as DatastoreKey);
		let store = stores.get(key);
		if (!store) {
			store = new MemoryStoreAdapter();
			stores.set(key, store);
		}
		return store;
	};
	const firstAncestorStore = () => {
		for (const store of stores.values()) return store;
		return root;
	};
	const stripDatastoreAncestorPlan = <TPlan extends QueryPlan | AggregatePlan>(plan: TPlan): TPlan =>
		plan.meta?.datastoreAncestor === undefined ? plan : ({ ...plan, meta: undefined } as TPlan);
	const stripDatastoreAncestorOptions = (options: any) =>
		options?.meta?.datastoreAncestor === undefined ? options : { ...options, meta: undefined };
	const requireDatastoreReadAncestor = (model: ResolvedModelMeta, options: any) => {
		if (model.datastore?.ancestor && options?.meta?.datastoreAncestor === undefined) {
			throw new Error('Datastore ancestor read metadata is required');
		}
	};
	const broken: StoreAdapter = {
		kind: 'broken-ancestor-transaction-direct-read-store',
		capabilities: { ...root.capabilities, datastoreAncestor: true, transaction: true },
		get: (model, id, options) => {
			requireDatastoreReadAncestor(model, options);
			return storeForAncestor(options?.meta?.datastoreAncestor).get(model, id, stripDatastoreAncestorOptions(options));
		},
		getMany: (model, ids, options) => {
			requireDatastoreReadAncestor(model, options);
			return storeForAncestor(options?.meta?.datastoreAncestor).getMany(model, ids, stripDatastoreAncestorOptions(options));
		},
		query: (model, plan, options) =>
			storeForAncestor(plan.meta?.datastoreAncestor).query(model, stripDatastoreAncestorPlan(plan), options),
		aggregate: (model, plan) =>
			storeForAncestor(plan.meta?.datastoreAncestor).aggregate(model, stripDatastoreAncestorPlan(plan)),
		create: (model, id, data, options) =>
			storeForAncestor(options?.meta?.datastoreAncestor).create(model, id, data, stripDatastoreAncestorOptions(options)),
		update: (model, id, data, options) =>
			storeForAncestor(options?.meta?.datastoreAncestor).update(model, id, data, stripDatastoreAncestorOptions(options)),
		delete: (model, id, options) =>
			storeForAncestor(options?.meta?.datastoreAncestor).delete(model, id, stripDatastoreAncestorOptions(options)),
		transaction: (callback, options) =>
			root.transaction(async (tx) => callback({
				...tx,
				kind: 'broken-ancestor-transaction-direct-read-store:tx',
				capabilities: { ...tx.capabilities, datastoreAncestor: true, transaction: false },
				get: (model, id, options) => {
					requireDatastoreReadAncestor(model, options);
					return (model.datastore?.ancestor ? firstAncestorStore() : tx).get(model, id, stripDatastoreAncestorOptions(options));
				},
				getMany: (model, ids, options) => {
					requireDatastoreReadAncestor(model, options);
					return (model.datastore?.ancestor ? firstAncestorStore() : tx).getMany(model, ids, stripDatastoreAncestorOptions(options));
				}
			}), options)
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/Missing expected rejection|transaction direct gets|transaction direct getMany reads|resolved outside the scoped Datastore ancestor/
	);
});

test('store adapter contract rejects Datastore ancestor transaction adapters that allow unscoped direct reads', async () => {
	const root = new MemoryStoreAdapter();
	const stores = new Map<string, MemoryStoreAdapter>();
	const storeForAncestor = (ancestor: unknown) => {
		if (ancestor === undefined) return root;
		const key = datastoreKeyIdentity(ancestor as DatastoreKey);
		let store = stores.get(key);
		if (!store) {
			store = new MemoryStoreAdapter();
			stores.set(key, store);
		}
		return store;
	};
	const firstAncestorStore = () => {
		for (const store of stores.values()) return store;
		return root;
	};
	const stripDatastoreAncestorPlan = <TPlan extends QueryPlan | AggregatePlan>(plan: TPlan): TPlan =>
		plan.meta?.datastoreAncestor === undefined ? plan : ({ ...plan, meta: undefined } as TPlan);
	const stripDatastoreAncestorOptions = (options: any) =>
		options?.meta?.datastoreAncestor === undefined ? options : { ...options, meta: undefined };
	const requireDatastoreReadAncestor = (model: ResolvedModelMeta, options: any) => {
		if (model.datastore?.ancestor && options?.meta?.datastoreAncestor === undefined) {
			throw new Error('Datastore ancestor read metadata is required');
		}
	};
	const broken: StoreAdapter = {
		kind: 'broken-ancestor-transaction-unscoped-direct-read-store',
		capabilities: { ...root.capabilities, datastoreAncestor: true, transaction: true },
		get: (model, id, options) => {
			requireDatastoreReadAncestor(model, options);
			return storeForAncestor(options?.meta?.datastoreAncestor).get(model, id, stripDatastoreAncestorOptions(options));
		},
		getMany: (model, ids, options) => {
			requireDatastoreReadAncestor(model, options);
			return storeForAncestor(options?.meta?.datastoreAncestor).getMany(model, ids, stripDatastoreAncestorOptions(options));
		},
		query: (model, plan, options) =>
			storeForAncestor(plan.meta?.datastoreAncestor).query(model, stripDatastoreAncestorPlan(plan), options),
		aggregate: (model, plan) =>
			storeForAncestor(plan.meta?.datastoreAncestor).aggregate(model, stripDatastoreAncestorPlan(plan)),
		create: (model, id, data, options) =>
			storeForAncestor(options?.meta?.datastoreAncestor).create(model, id, data, stripDatastoreAncestorOptions(options)),
		update: (model, id, data, options) =>
			storeForAncestor(options?.meta?.datastoreAncestor).update(model, id, data, stripDatastoreAncestorOptions(options)),
		delete: (model, id, options) =>
			storeForAncestor(options?.meta?.datastoreAncestor).delete(model, id, stripDatastoreAncestorOptions(options)),
		transaction: (callback, options) =>
			root.transaction(async (tx) => callback({
				...tx,
				kind: 'broken-ancestor-transaction-unscoped-direct-read-store:tx',
				capabilities: { ...tx.capabilities, datastoreAncestor: true, transaction: false },
				get: (model, id, options) =>
					(model.datastore?.ancestor
						? storeForAncestor(options?.meta?.datastoreAncestor) === root
							? firstAncestorStore()
							: storeForAncestor(options?.meta?.datastoreAncestor)
						: tx).get(model, id, stripDatastoreAncestorOptions(options)),
				getMany: (model, ids, options) =>
					(model.datastore?.ancestor
						? storeForAncestor(options?.meta?.datastoreAncestor) === root
							? firstAncestorStore()
							: storeForAncestor(options?.meta?.datastoreAncestor)
						: tx).getMany(model, ids, stripDatastoreAncestorOptions(options))
			}), options)
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/ancestor-aware query|direct id reads|Missing expected rejection/
	);
});

test('store adapter contract rejects Datastore ancestor transaction adapters that ignore write metadata', async () => {
	const root = new MemoryStoreAdapter();
	const stores = new Map<string, MemoryStoreAdapter>();
	const storeForAncestor = (ancestor: unknown) => {
		if (ancestor === undefined) return root;
		const key = datastoreKeyIdentity(ancestor as DatastoreKey);
		let store = stores.get(key);
		if (!store) {
			store = new MemoryStoreAdapter();
			stores.set(key, store);
		}
		return store;
	};
	const firstAncestorStore = () => {
		for (const store of stores.values()) return store;
		return root;
	};
	const stripDatastoreAncestorPlan = <TPlan extends QueryPlan | AggregatePlan>(plan: TPlan): TPlan =>
		plan.meta?.datastoreAncestor === undefined ? plan : ({ ...plan, meta: undefined } as TPlan);
	const stripDatastoreAncestorOptions = (options: any) =>
		options?.meta?.datastoreAncestor === undefined ? options : { ...options, meta: undefined };
	const requireDatastoreReadAncestor = (model: ResolvedModelMeta, options: any) => {
		if (model.datastore?.ancestor && options?.meta?.datastoreAncestor === undefined) {
			throw new Error('Datastore ancestor read metadata is required');
		}
	};
	const broken: StoreAdapter = {
		kind: 'broken-ancestor-transaction-write-store',
		capabilities: { ...root.capabilities, datastoreAncestor: true, transaction: true },
		get: (model, id, options) => {
			requireDatastoreReadAncestor(model, options);
			return storeForAncestor(options?.meta?.datastoreAncestor).get(model, id, stripDatastoreAncestorOptions(options));
		},
		getMany: (model, ids, options) => {
			requireDatastoreReadAncestor(model, options);
			return storeForAncestor(options?.meta?.datastoreAncestor).getMany(model, ids, stripDatastoreAncestorOptions(options));
		},
		query: (model, plan, options) =>
			storeForAncestor(plan.meta?.datastoreAncestor).query(model, stripDatastoreAncestorPlan(plan), options),
		aggregate: (model, plan) =>
			storeForAncestor(plan.meta?.datastoreAncestor).aggregate(model, stripDatastoreAncestorPlan(plan)),
		create: (model, id, data, options) =>
			storeForAncestor(options?.meta?.datastoreAncestor).create(model, id, data, stripDatastoreAncestorOptions(options)),
		update: (model, id, data, options) =>
			storeForAncestor(options?.meta?.datastoreAncestor).update(model, id, data, stripDatastoreAncestorOptions(options)),
		delete: (model, id, options) =>
			storeForAncestor(options?.meta?.datastoreAncestor).delete(model, id, stripDatastoreAncestorOptions(options)),
		transaction: (callback, options) =>
			root.transaction(async (tx) => callback({
				...tx,
				kind: 'broken-ancestor-transaction-write-store:tx',
				capabilities: { ...tx.capabilities, datastoreAncestor: true, transaction: false },
				get: (model, id, options) => {
					requireDatastoreReadAncestor(model, options);
					return storeForAncestor(options?.meta?.datastoreAncestor).get(model, id, stripDatastoreAncestorOptions(options));
				},
				getMany: (model, ids, options) => {
					requireDatastoreReadAncestor(model, options);
					return storeForAncestor(options?.meta?.datastoreAncestor).getMany(model, ids, stripDatastoreAncestorOptions(options));
				},
				create: (model, id, data, options) =>
					(model.datastore?.ancestor ? firstAncestorStore() : tx).create(model, id, data, stripDatastoreAncestorOptions(options)),
				update: (model, id, data, options) =>
					(model.datastore?.ancestor ? firstAncestorStore() : tx).update(model, id, data, stripDatastoreAncestorOptions(options)),
				delete: (model, id, options) =>
					(model.datastore?.ancestor ? firstAncestorStore() : tx).delete(model, id, stripDatastoreAncestorOptions(options))
			}), options)
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/Missing expected rejection|transaction create and update writes|transaction delete writes|already exists|resolved outside the scoped Datastore ancestor/
	);
});

test('store adapter contract rejects Datastore ancestor aggregates that ignore scoped metadata', async () => {
	const root = new MemoryStoreAdapter();
	const stores = new Map<string, MemoryStoreAdapter>();
	const storeForAncestor = (ancestor: unknown) => {
		if (ancestor === undefined) return root;
		const key = datastoreKeyIdentity(ancestor as DatastoreKey);
		let store = stores.get(key);
		if (!store) {
			store = new MemoryStoreAdapter();
			stores.set(key, store);
		}
		return store;
	};
	const planStore = (plan: QueryPlan | AggregatePlan) => storeForAncestor(plan.meta?.datastoreAncestor);
	const planWithoutDatastoreAncestor = <TPlan extends QueryPlan | AggregatePlan>(plan: TPlan): TPlan =>
		plan.meta?.datastoreAncestor === undefined ? plan : ({ ...plan, meta: undefined } as TPlan);
	const writeStore = (options: any) => storeForAncestor(options?.meta?.datastoreAncestor);
	const writeOptionsWithoutDatastoreAncestor = (options: any) =>
		options?.meta?.datastoreAncestor === undefined ? options : { ...options, meta: undefined };
	const requireDatastoreReadAncestor = (model: ResolvedModelMeta, options: any) => {
		if (model.datastore?.ancestor && options?.meta?.datastoreAncestor === undefined) {
			throw new Error('Datastore ancestor read metadata is required');
		}
	};
	const broken: StoreAdapter = {
		kind: 'broken-ancestor-aggregate-store',
		capabilities: { ...root.capabilities, datastoreAncestor: true, transaction: false },
		get: (model, id, options) => {
			requireDatastoreReadAncestor(model, options);
			return writeStore(options).get(model, id, writeOptionsWithoutDatastoreAncestor(options));
		},
		getMany: (model, ids, options) => {
			requireDatastoreReadAncestor(model, options);
			return writeStore(options).getMany(model, ids, writeOptionsWithoutDatastoreAncestor(options));
		},
		query: (model, plan, options) => planStore(plan).query(model, planWithoutDatastoreAncestor(plan), options),
		aggregate: (model, plan) => storeForAncestor(undefined).aggregate(model, planWithoutDatastoreAncestor(plan)),
		create: (model, id, data, options) =>
			writeStore(options).create(model, id, data, writeOptionsWithoutDatastoreAncestor(options)),
		update: (model, id, data, options) =>
			writeStore(options).update(model, id, data, writeOptionsWithoutDatastoreAncestor(options)),
		delete: (model, id, options) =>
			writeStore(options).delete(model, id, writeOptionsWithoutDatastoreAncestor(options))
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/Missing expected rejection|metadata to aggregates|resolved outside the scoped Datastore ancestor/
	);
});

test('cache and search adapter contracts accept memory adapters', async () => {
	await runCacheAdapterContract(new MemoryCacheAdapter());
	await runSearchAdapterContract(new MemorySearchAdapter());
});

test('search adapter contract accepts Algolia fake SDK with native probe', async () => {
	const documents = new Map<string, Record<string, unknown>>();
	const algolia = await createAlgoliaSearchAdapter({
		client: {
			searchSingleIndex: async ({ searchParams }: any) => {
				const query = String(searchParams.query ?? '').toLowerCase();
				const fields = Array.isArray(searchParams.restrictSearchableAttributes)
					? searchParams.restrictSearchableAttributes
					: undefined;
				const pageSize = searchParams.hitsPerPage ?? Number.MAX_SAFE_INTEGER;
				const page = searchParams.page ?? 0;
				const matches: Record<string, unknown>[] = [];
				for (const document of Array.from(documents.values())) {
					if (
						typeof searchParams.filters === 'string' &&
						searchParams.filters.startsWith('objectID:') &&
						document.objectID !== searchParams.filters.slice('objectID:'.length)
					) {
						continue;
					}
					const searchFields = fields ?? Object.keys(document).filter((field) => field !== 'objectID');
					let matched = query.length === 0 || searchParams.filters !== undefined;
					for (let fieldIndex = 0; fieldIndex < searchFields.length; fieldIndex++) {
						const field = searchFields[fieldIndex];
						let value: unknown = document;
						const segments = field.split('.');
						for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
							const segment = segments[segmentIndex];
							if (!value || typeof value !== 'object' || Array.isArray(value)) {
								value = undefined;
								break;
							}
							value = (value as Record<string, unknown>)[segment];
						}
						const values = Array.isArray(value) ? value : [value];
						for (let valueIndex = 0; valueIndex < values.length; valueIndex++) {
							const entry = values[valueIndex];
							if (typeof entry === 'string' && entry.toLowerCase().includes(query)) matched = true;
						}
					}
					if (!matched) continue;
					const hit: Record<string, unknown> = { objectID: document.objectID };
					const attributes = Array.isArray(searchParams.attributesToRetrieve)
						? searchParams.attributesToRetrieve
						: Object.keys(document);
					for (let attributeIndex = 0; attributeIndex < attributes.length; attributeIndex++) {
						const attribute = attributes[attributeIndex];
						if (Object.prototype.hasOwnProperty.call(document, attribute)) hit[attribute] = document[attribute];
					}
					matches[matches.length] = hit;
				}
				const offset = page * pageSize;
				const hits = matches.slice(offset, offset + pageSize);
				return {
					hits,
					nbHits: matches.length,
					nbPages: pageSize === Number.MAX_SAFE_INTEGER ? (matches.length ? 1 : 0) : Math.ceil(matches.length / pageSize),
					page
				};
			},
			saveObject: async ({ body }: any) => {
				documents.set(body.objectID, { ...body });
			},
			deleteObject: async ({ objectID }: any) => {
				documents.delete(objectID);
			}
		}
	});

	await runSearchAdapterContract(algolia, {
		nativeProbe: async ({ adapter, model }) => {
			await adapter.index(model, 900, {
				id: 900,
				title: 'algolia native probe',
				score: 90,
				tags: ['native'],
				profile: { city: 'Seoul' }
			});
			const nativeOnlyModel = { ...model, searchIndexes: [] };
			const result = await adapter.search(nativeOnlyModel, 'ignored', {
				native: { filters: `objectID:${model.name}:number:900` }
			});
			assert.deepEqual(result.list.map((item) => item.id), [900]);
			await adapter.delete(model, 900);
		}
	});
});

test('store adapter contract metadata maps use captured Map set intrinsic', async () => {
	const originalMapSet = Map.prototype.set;
	let mapSetCalls = 0;
	Object.defineProperty(Map.prototype, 'set', {
		configurable: true,
		value() {
			mapSetCalls++;
			throw new Error('patched Map.set');
		}
	});
	try {
		await runStoreAdapterContract(new MemoryStoreAdapter());
		assert.equal(mapSetCalls, 0);
	} finally {
		Object.defineProperty(Map.prototype, 'set', {
			configurable: true,
			writable: true,
			value: originalMapSet
		});
	}
});

test('cache and search adapter contract suites run matching adapters', async () => {
	await createCacheAdapterContractSuite({
		memory: () => new MemoryCacheAdapter()
	}).run();
	await createSearchAdapterContractSuite({
		memory: () => new MemorySearchAdapter()
	}).run();
});

test('cache and search adapter contract suites reject wrong adapter shapes clearly', async () => {
	assert.throws(
		() => createCacheAdapterContractSuite({ store: new MemoryStoreAdapter() as any }),
		/Cache adapter contract suite "store" adapter\.setMany must be a function/
	);
	assert.throws(
		() => createSearchAdapterContractSuite({ cache: new MemoryCacheAdapter() as any }),
		/Search adapter contract suite "cache" adapter\.search must be a function/
	);
	const badFactorySuite = createCacheAdapterContractSuite({
		bad: () =>
			({
				kind: 'bad-cache-suite-factory',
				getMany: async () => [],
				setMany: async () => undefined,
				deleteMany: 'nope'
			}) as any
	});
	await assert.rejects(
		() => badFactorySuite.run(),
		/bad: Cache contract adapter\.deleteMany must be a function/
	);
});

test('cache adapter contract rejects duplicate hit slots that share object references', async () => {
	const base = new MemoryCacheAdapter();
	const adapter: CacheAdapter = {
		kind: 'aliasing-cache-contract',
		getMany: async (keys) => {
			const result = await base.getMany(keys);
			const seen = new Map<string, unknown>();
			return result.map((value, index) => {
				if (!value || typeof value !== 'object') return value;
				const key = keys[index];
				if (seen.has(key)) return seen.get(key);
				seen.set(key, value);
				return value;
			});
		},
		setMany: (entries, options) => base.setMany(entries, options),
		deleteMany: (keys) => base.deleteMany(keys)
	};

	await assert.rejects(
		() => runCacheAdapterContract(adapter),
		/duplicate cache hit result slots must not share value object references/
	);
	assert.deepEqual(base.snapshot(), {});
});

test('cache adapter contract rejects sparse cache miss slots', async () => {
	const base = new MemoryCacheAdapter();
	const adapter: CacheAdapter = {
		kind: 'sparse-miss-cache-contract',
		getMany: async (keys) => {
			const result = await base.getMany(keys);
			const sparse: unknown[] = [];
			sparse.length = result.length;
			for (let index = 0; index < result.length; index++) {
				if (result[index] !== undefined) sparse[index] = result[index];
			}
			return sparse as any[];
		},
		setMany: (entries, options) => base.setMany(entries, options),
		deleteMany: (keys) => base.deleteMany(keys)
	};

	await assert.rejects(
		() => runCacheAdapterContract(adapter),
		/cache contract miss slots must be dense own properties/
	);
});

test('cache adapter contract validates codecKey behavior', async () => {
	const invalidType: CacheAdapter = {
		kind: 'invalid-codec-key-type-cache-contract',
		getMany: async () => [],
		setMany: async () => undefined,
		deleteMany: async () => undefined,
		codecKey: 'not-a-function' as any
	};
	await assert.rejects(
		() => runCacheAdapterContract(invalidType),
		/Cache contract adapter\.codecKey must be a function/
	);

	const base = new MemoryCacheAdapter();
	const unsafeResult: CacheAdapter = {
		kind: 'unsafe-codec-key-cache-contract',
		getMany: (keys) => base.getMany(keys),
		setMany: (entries, options) => base.setMany(entries, options),
		deleteMany: (keys) => base.deleteMany(keys),
		codecKey: () => ''
	};
	await assert.rejects(
		() => runCacheAdapterContract(unsafeResult),
		/Cache contract adapter\.codecKey result cannot be empty/
	);
});

test('search adapter contract accepts omitted result counts like runtime search loading', async () => {
	const base = new MemorySearchAdapter();
	const adapter: SearchAdapter = {
		kind: 'countless-memory-search',
		capabilities: base.capabilities,
		search: async (model, query, options) => {
			const { count: _count, ...result } = await base.search(model, query, options);
			return result;
		},
		index: (model, id, data) => base.index(model, id, data),
		delete: (model, id) => base.delete(model, id)
	};

	await runSearchAdapterContract(adapter);
});

test('search adapter contract rejects accessor and extra result fields without invoking them', async () => {
	const baseCapabilities = new MemorySearchAdapter().capabilities;
	let listReads = 0;
	let extraReads = 0;
	const accessorResultAdapter: SearchAdapter = {
		kind: 'accessor-result-search-contract',
		capabilities: baseCapabilities,
		search: async () =>
			Object.defineProperty({ more: false }, 'list', {
				enumerable: true,
				get() {
					listReads++;
					return [];
				}
			}) as any,
		index: async () => undefined,
		delete: async () => undefined
	};
	const extraResultAdapter: SearchAdapter = {
		kind: 'extra-result-search-contract',
		capabilities: baseCapabilities,
		search: async () =>
			Object.defineProperty({ list: [], more: false }, 'extra', {
				enumerable: true,
				get() {
					extraReads++;
					return 'hidden';
				}
			}) as any,
		index: async () => undefined,
		delete: async () => undefined
	};
	const symbolResultAdapter: SearchAdapter = {
		kind: 'symbol-result-search-contract',
		capabilities: baseCapabilities,
		search: async () => ({
			list: [],
			more: false,
			[Symbol('result')]: true
		} as any),
		index: async () => undefined,
		delete: async () => undefined
	};

	await assert.rejects(
		() => runSearchAdapterContract(accessorResultAdapter, { settleMs: 0 }),
		/Search contract adapter "accessor-result-search-contract" result\.list must be a data property/
	);
	await assert.rejects(
		() => runSearchAdapterContract(extraResultAdapter, { settleMs: 0 }),
		/Search contract adapter "extra-result-search-contract" result contains unknown result property "extra"/
	);
	await assert.rejects(
		() => runSearchAdapterContract(symbolResultAdapter, { settleMs: 0 }),
		/Search contract adapter "symbol-result-search-contract" result cannot contain symbol fields/
	);
	assert.equal(listReads, 0);
	assert.equal(extraReads, 0);
});

test('search adapter contract rejects unsafe hit objects and mutation leaks', async () => {
	class Hit {
		id = 1;
		title = 'shared number';
		subtitle = null;
		score = 10;
		tags = ['cat'];
		profile = { city: 'Seoul' };
	}
	const base = new MemorySearchAdapter();
	const classHitAdapter: SearchAdapter = {
		kind: 'class-hit-search-contract',
		capabilities: base.capabilities,
		search: async () => ({ list: [new Hit()], more: false }),
		index: async () => undefined,
		delete: async () => undefined
	};
	await assert.rejects(
		() => runSearchAdapterContract(classHitAdapter, { settleMs: 0 }),
		/Unsupported data object/
	);

	let getterCalls = 0;
	const accessorHit = {
		id: 1,
		subtitle: null,
		score: 10,
		tags: ['cat'],
		profile: { city: 'Seoul' }
	} as Record<string, unknown>;
	Object.defineProperty(accessorHit, 'title', {
		enumerable: true,
		get() {
			getterCalls++;
			return 'shared number';
		}
	});
	const accessorHitAdapter: SearchAdapter = {
		kind: 'accessor-hit-search-contract',
		capabilities: base.capabilities,
		search: async () => ({ list: [accessorHit], more: false }),
		index: async () => undefined,
		delete: async () => undefined
	};
	await assert.rejects(
		() => runSearchAdapterContract(accessorHitAdapter, { settleMs: 0 }),
		/Unsupported data accessor/
	);
	assert.equal(getterCalls, 0);

	const leakyBase = new MemorySearchAdapter();
	let cachedShared: QueryResult | undefined;
	const leakyAdapter: SearchAdapter = {
		kind: 'leaky-hit-search-contract',
		capabilities: leakyBase.capabilities,
		search: async (model, query, options) => {
			const result = await leakyBase.search(model, query, options);
			const plainSharedSearch =
				query === 'shared' &&
				options !== undefined &&
				typeof options === 'object' &&
				!Array.isArray(options) &&
				!options.where &&
				!options.limit &&
				!options.cursor &&
				!options.native;
			if (!plainSharedSearch) return result;
			cachedShared ??= result;
			return cachedShared;
		},
		index: (model, id, data) => leakyBase.index(model, id, data),
		delete: (model, id) => leakyBase.delete(model, id)
	};
	await assert.rejects(
		() => runSearchAdapterContract(leakyAdapter, { settleMs: 0 }),
		/Search contract adapter hits must be isolated from caller mutations/
	);

	const nestedBase = new MemorySearchAdapter();
	let sharedProfile: Record<string, unknown> | undefined;
	let sharedTags: unknown[] | undefined;
	const nestedLeakAdapter: SearchAdapter = {
		kind: 'nested-leaky-hit-search-contract',
		capabilities: nestedBase.capabilities,
		search: async (model, query, options) => {
			const result = await nestedBase.search(model, query, options);
			const plainSharedSearch =
				query === 'shared' &&
				options !== undefined &&
				typeof options === 'object' &&
				!Array.isArray(options) &&
				!options.where &&
				!options.limit &&
				!options.cursor &&
				!options.native;
			if (!plainSharedSearch) return result;
			return {
				...result,
				list: result.list.map((hit) => {
					const next = { ...hit };
					if (hit.profile && typeof hit.profile === 'object' && !Array.isArray(hit.profile)) {
						sharedProfile ??= hit.profile as Record<string, unknown>;
						next.profile = sharedProfile;
					}
					if (Array.isArray(hit.tags)) {
						sharedTags ??= hit.tags;
						next.tags = sharedTags;
					}
					return next;
				})
			};
		},
		index: (model, id, data) => nestedBase.index(model, id, data),
		delete: (model, id) => nestedBase.delete(model, id)
	};
	await assert.rejects(
		() => runSearchAdapterContract(nestedLeakAdapter, { settleMs: 0 }),
		/Search contract adapter nested hit objects must be isolated|Search contract adapter hit arrays must be isolated/
	);
});

test('search adapter contract rejects adapters that accept unsafe index payloads', async () => {
	const base = new MemorySearchAdapter();
	const adapter: SearchAdapter = {
		kind: 'unsafe-index-search-contract',
		capabilities: base.capabilities,
		search: (model, query, options) => base.search(model, query, options),
		index: async (model, id, data) => {
			const title = searchContractValueAt(data, 'title');
			if (typeof title === 'string' && title.startsWith('unsafe-contract-')) {
				await base.index(model, id, { id, title });
				return;
			}
			await base.index(model, id, data);
		},
		delete: (model, id) => base.delete(model, id)
	};

	await assert.rejects(
		() => runSearchAdapterContract(adapter, { settleMs: 0 }),
		/Missing expected rejection|unsafe index/
	);
});

test('search adapter contract nativeProbe can verify advertised native support', async () => {
	const base = new MemorySearchAdapter();
	let nativePathCalls = 0;
	const broken: SearchAdapter = {
		kind: 'broken-native-search-contract',
		capabilities: { ...base.capabilities, native: true },
		search: (model, query, options) => {
			if (options?.native !== undefined) return base.search(model, query, { ...options, native: undefined });
			nativePathCalls++;
			return base.search(model, query, options);
		},
		index: (model, id, data) => base.index(model, id, data),
		delete: (model, id) => base.delete(model, id)
	};

	await assert.rejects(
		() =>
			runSearchAdapterContract(broken, {
				nativeProbe: async ({ adapter, model }) => {
					await adapter.search(model, 'ignored', { native: { contract: true } });
					assert.equal(nativePathCalls, 1, 'native probe must reach the adapter native path');
				}
			}),
		/native probe must reach/
	);
});

test('search adapter contract requires nativeProbe for advertised native support', async () => {
	const base = new MemorySearchAdapter();
	const broken: SearchAdapter = {
		kind: 'unprobed-native-search-contract',
		capabilities: { ...base.capabilities, native: true },
		search: (model, query, options) => base.search(model, query, { ...options, native: undefined }),
		index: (model, id, data) => base.index(model, id, data),
		delete: (model, id) => base.delete(model, id)
	};

	await assert.rejects(
		() => runSearchAdapterContract(broken),
		/nativeProbe/
	);
});

test('search adapter contract validates cursor, count, and total metadata semantics', async () => {
	const cursorBase = new MemorySearchAdapter();
	const cursorLeakAdapter: SearchAdapter = {
		kind: 'cursor-leak-search-contract',
		capabilities: { ...cursorBase.capabilities, cursor: false },
		search: async (model, query, options) => {
			const result = await cursorBase.search(model, query, options);
			if (options?.limit !== undefined && result.more === true) return { ...result, cursor: 'native-cursor' };
			return result;
		},
		index: (model, id, data) => cursorBase.index(model, id, data),
		delete: (model, id) => cursorBase.delete(model, id)
	};
	await assert.rejects(
		() => runSearchAdapterContract(cursorLeakAdapter, { settleMs: 0 }),
		/search adapters without cursor capability must not expose portable cursors/
	);

	const countBase = new MemorySearchAdapter();
	const staleCountAdapter: SearchAdapter = {
		kind: 'stale-count-search-contract',
		capabilities: countBase.capabilities,
		search: async (model, query, options) => {
			const result = await countBase.search(model, query, options);
			return result.list.length ? { ...result, count: result.list.length + 10 } : result;
		},
		index: (model, id, data) => countBase.index(model, id, data),
		delete: (model, id) => countBase.delete(model, id)
	};
	await assert.rejects(
		() => runSearchAdapterContract(staleCountAdapter, { settleMs: 0 }),
		/count must equal result\.list length/
	);

	const totalBase = new MemorySearchAdapter();
	const lowTotalAdapter: SearchAdapter = {
		kind: 'low-total-search-contract',
		capabilities: totalBase.capabilities,
		search: async (model, query, options) => {
			const result = await totalBase.search(model, query, options);
			return result.list.length ? { ...result, total: result.list.length - 1 } : result;
		},
		index: (model, id, data) => totalBase.index(model, id, data),
		delete: (model, id) => totalBase.delete(model, id)
	};
	await assert.rejects(
		() => runSearchAdapterContract(lowTotalAdapter, { settleMs: 0 }),
		/total cannot be smaller/
	);
});

test('search adapter contract rejects stale terms after reindexing the same id', async () => {
	const base = new MemorySearchAdapter();
	const previousDocs = new Map<string, any>();
	const staleDocs: any[] = [];
	const adapter: SearchAdapter = {
		kind: 'stale-reindex-memory-search',
		capabilities: base.capabilities,
		search: async (model, query, options) => {
			const result = await base.search(model, query, options);
			const needle = String(query).toLowerCase();
			const staleHits = staleDocs.filter((doc) =>
				model.searchIndexes
					.flatMap((index) => index.fields)
					.some((field) => String(searchContractValueAt(doc, field) ?? '').toLowerCase().includes(needle))
			);
			return {
				...result,
				list: [...result.list, ...staleHits],
				count: result.list.length + staleHits.length,
				more: result.more
			};
		},
		index: async (model, id, data) => {
			const key = `${typeof id}:${String(id)}`;
			const previous = previousDocs.get(key);
			if (previous) staleDocs.push(previous);
			previousDocs.set(key, structuredClone(data));
			await base.index(model, id, data);
		},
		delete: async (model, id) => {
			const key = `${typeof id}:${String(id)}`;
			previousDocs.delete(key);
			for (let index = staleDocs.length - 1; index >= 0; index--) {
				const staleId = searchContractValueAt(staleDocs[index], model.idField);
				if (`${typeof staleId}:${String(staleId)}` === key) staleDocs.splice(index, 1);
			}
			await base.delete(model, id);
		}
	};

	await assert.rejects(
		() => runSearchAdapterContract(adapter),
		/Expected values to be strictly deep-equal|total cannot be smaller/
	);
	assert.deepEqual(
		Object.values(base.snapshot()).flatMap((rows) => rows as unknown[]),
		[]
	);
	assert.equal(previousDocs.size, 0);
	assert.deepEqual(staleDocs, []);
});

test('search adapter contract rejects Datastore ancestor hits without document identity markers', async () => {
	const base = new MemorySearchAdapter();
	const adapter: SearchAdapter = {
		kind: 'unmarked-datastore-search-contract',
		capabilities: base.capabilities,
		search: async (model, query, options) => {
			const result = await base.search(model, query, options);
			if (!model.datastore?.ancestor) return result;
			return {
				...result,
				list: result.list.map((hit) => ({ ...hit }))
			};
		},
		index: (model, id, data) => base.index(model, id, data),
		delete: (model, id) => base.delete(model, id)
	};

	await assert.rejects(
		() => runSearchAdapterContract(adapter),
		/Datastore ancestor hit document identity markers/
	);
});

test('adapter contracts accept runtime-valid middleware adapter kinds', async () => {
	await runStoreAdapterContract(createStoreMiddlewareAdapter(new MemoryStoreAdapter(), []));
	await runCacheAdapterContract(createCacheMiddlewareAdapter(new MemoryCacheAdapter(), []));
	await runSearchAdapterContract(createSearchMiddlewareAdapter(new MemorySearchAdapter(), []));
});

test('adapter contracts reject empty and null-byte adapter kinds like runtime registration', async () => {
	const store = new MemoryStoreAdapter();
	Object.defineProperty(store, 'kind', { value: '', configurable: true });
	await assert.rejects(
		() => runStoreAdapterContract(store),
		/Store contract adapter\.kind must be a non-empty string without null bytes/
	);

	const cache = new MemoryCacheAdapter();
	Object.defineProperty(cache, 'kind', { value: 'cache\u0000bad', configurable: true });
	await assert.rejects(
		() => runCacheAdapterContract(cache),
		/Cache contract adapter\.kind must be a non-empty string without null bytes/
	);

	const search = new MemorySearchAdapter();
	Object.defineProperty(search, 'kind', { value: 'bad\u0000search', configurable: true });
	await assert.rejects(
		() => runSearchAdapterContract(search),
		/Search contract adapter\.kind must be a non-empty string without null bytes/
	);
});

test('adapter contracts clean up successful memory fixtures', async () => {
	const store = new MemoryStoreAdapter();
	const cache = new MemoryCacheAdapter();
	const search = new MemorySearchAdapter();

	await runStoreAdapterContract(store);
	await runCacheAdapterContract(cache);
	await runSearchAdapterContract(search);

	assert.deepEqual(
		Object.values(store.snapshot()).flatMap((rows) => rows as unknown[]),
		[]
	);
	assert.deepEqual(cache.snapshot(), {});
	assert.deepEqual(
		Object.values(search.snapshot()).flatMap((rows) => rows as unknown[]),
		[]
	);
});

test('store adapter contract cleanup does not require missing delete idempotency', async () => {
	const base = new MemoryStoreAdapter();
	const strictDelete: StoreAdapter = {
		kind: 'strict-delete-store-contract',
		capabilities: { ...base.capabilities, optimisticLock: false, transaction: false },
		schema: base.schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: (model, plan, options) => base.query(model, plan, options),
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data, options) => base.create(model, id, data, options),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: async (model, id, options) => {
			if (await base.get(model, id) === null) throw new Error(`missing delete ${String(id)}`);
			await base.delete(model, id, options);
		}
	};

	await runStoreAdapterContract(strictDelete);
	assert.deepEqual(
		Object.values(base.snapshot()).flatMap((rows) => rows as unknown[]),
		[]
	);
});

test('store adapter contract validates direct query result metadata', async () => {
	const cases: Array<{
		kind: string;
		rewrite: (result: QueryResult) => QueryResult;
		message: RegExp;
	}> = [
		{
			kind: 'negative-count',
			rewrite: (result) => ({ ...result, count: -1 }),
			message: /result\.count/
		},
		{
			kind: 'stale-count',
			rewrite: (result) =>
				result.list.length ? { ...result, count: result.list.length + 10 } : result,
			message: /result\.count must equal result\.list length/
		},
		{
			kind: 'low-total',
			rewrite: (result) => (result.list.length ? { ...result, total: result.list.length - 1 } : result),
			message: /result\.total cannot be smaller/
		},
		{
			kind: 'non-boolean-more',
			rewrite: (result) => ({ ...result, more: 'yes' as any }),
			message: /result\.more/
		},
		{
			kind: 'missing-more-on-limited-query',
			rewrite: (result) => {
				if (result.more !== true) return result;
				const { more: _more, cursor: _cursor, ...rest } = result;
				return rest;
			},
			message: /limited query contract/
		},
		{
			kind: 'invalid-cursor',
			rewrite: (result) => ({ ...result, cursor: { page: 2 } as any }),
			message: /result cursor/
		},
		{
			kind: 'sparse-list',
			rewrite: (result) => {
				const sparse = new Array(1) as any[];
				return { ...result, list: sparse };
			},
			message: /result\.list/
		},
		{
			kind: 'unknown-field',
			rewrite: (result) => ({ ...result, totla: 3 } as any),
			message: /unknown option "totla"/
		}
	];

	for (const testCase of cases) {
		const base = new MemoryStoreAdapter();
		const broken: StoreAdapter = {
			kind: `broken-query-result-${testCase.kind}`,
			capabilities: { ...base.capabilities, transaction: false },
			schema: base.schema,
			get: (model, id, options) => base.get(model, id, options),
			getMany: (model, ids, options) => base.getMany(model, ids, options),
			query: async (model, plan, options) => testCase.rewrite(await base.query(model, plan, options)),
			aggregate: (model, plan) => base.aggregate(model, plan),
			create: (model, id, data) => base.create(model, id, data),
			update: (model, id, data, options) => base.update(model, id, data, options),
			delete: (model, id, options) => base.delete(model, id, options)
		};

		await assert.rejects(() => runStoreAdapterContract(broken), testCase.message, testCase.kind);
		assert.deepEqual(
			Object.values(base.snapshot()).flatMap((rows) => rows as unknown[]),
			[],
			testCase.kind
		);
	}
});

test('store adapter contract rejects extra query result accessors without invoking them', async () => {
	const base = new MemoryStoreAdapter();
	let getterCalls = 0;
	const broken: StoreAdapter = {
		kind: 'extra-accessor-query-result',
		capabilities: { ...base.capabilities, transaction: false },
		schema: base.schema,
		get: (model, id, options) => base.get(model, id, options),
		getMany: (model, ids, options) => base.getMany(model, ids, options),
		query: async (model, plan, options) => {
			const result = await base.query(model, plan, options);
			return Object.defineProperty({ ...result }, 'extra', {
				enumerable: true,
				get() {
					getterCalls++;
					return 'hidden';
				}
			}) as QueryResult;
		},
		aggregate: (model, plan) => base.aggregate(model, plan),
		create: (model, id, data) => base.create(model, id, data),
		update: (model, id, data, options) => base.update(model, id, data, options),
		delete: (model, id, options) => base.delete(model, id, options)
	};

	await assert.rejects(
		() => runStoreAdapterContract(broken),
		/Store contract adapter "extra-accessor-query-result" query result\.extra must be a data property/
	);
	assert.equal(getterCalls, 0);
	assert.deepEqual(
		Object.values(base.snapshot()).flatMap((rows) => rows as unknown[]),
		[]
	);
});

test('cache adapter contract uses a fresh namespace for each run', async () => {
	const base = new MemoryCacheAdapter();
	const setKeys: string[][] = [];
	let currentKeys: string[] = [];
	const adapter: CacheAdapter = {
		kind: 'tracked-cache-contract',
		getMany: (keys) => base.getMany(keys),
		setMany: async (entries, options) => {
			currentKeys.push(...entries.map(([key]) => key));
			await base.setMany(entries, options);
		},
		deleteMany: (keys) => base.deleteMany(keys)
	};

	await runCacheAdapterContract(adapter);
	setKeys.push(currentKeys);
	currentKeys = [];
	await runCacheAdapterContract(adapter);
	setKeys.push(currentKeys);

	const first = new Set(setKeys[0]);
	assert.equal(setKeys[1].some((key) => first.has(key)), false);
});

test('search adapter contract can poll eventually visible indexes', async () => {
	const base = new MemorySearchAdapter();
	let staleResponses = 0;
	const eventual: SearchAdapter = {
		kind: 'eventual-memory-search-contract',
		capabilities: base.capabilities,
		search: async (model, query, options) => {
			if (typeof query !== 'string' || !options || typeof options !== 'object' || Array.isArray(options)) {
				return await base.search(model, query, options);
			}
			if (staleResponses > 0) {
				staleResponses--;
				return { list: [], count: 0, total: 0, more: false };
			}
			return await base.search(model, query, options);
		},
		index: async (...args) => {
			await base.index(...args);
			staleResponses = 2;
		},
		delete: async (...args) => {
			await base.delete(...args);
			staleResponses = 2;
		}
	};

	await runSearchAdapterContract(eventual, { settleMs: 200, pollIntervalMs: 1 });
});

test('search adapter contract rejects malformed polling options', async () => {
	await assert.rejects(() =>
		runSearchAdapterContract(new MemorySearchAdapter(), { settleMs: -1 } as any)
	);
	await assert.rejects(() =>
		runSearchAdapterContract(new MemorySearchAdapter(), { pollIntervalMs: 0 } as any)
	);
	await assert.rejects(() =>
		runSearchAdapterContract(new MemorySearchAdapter(), { settleMs: 1, extra: true } as any)
	);
	await assert.rejects(() =>
		runSearchAdapterContract(new MemorySearchAdapter(), { nativeProbe: true } as any),
		/nativeProbe must be a function/
	);
});

test('store adapter contract rejects malformed options', async () => {
	await assert.rejects(() =>
		runStoreAdapterContract(new MemoryStoreAdapter(), { extra: true } as any)
	);
	await assert.rejects(
		() => runStoreAdapterContract(new MemoryStoreAdapter(), { nativeProbe: true } as any),
		/nativeProbe must be a function/
	);
});

test('search adapter contract requires declared index capability', async () => {
	const base = new MemorySearchAdapter();
	const broken: SearchAdapter = {
		kind: 'broken-search-index-capability',
		capabilities: { ...base.capabilities, index: false },
		search: (model, query, options) => base.search(model, query, options),
		index: (model, id, data) => base.index(model, id, data),
		delete: (model, id) => base.delete(model, id)
	};

	await assert.rejects(
		() => runSearchAdapterContract(broken),
		/must declare capabilities\.index: true/
	);
});

test('search adapter contract validates schema hooks and plans', async () => {
	const base = new MemorySearchAdapter();
	const adapter = (schema: SearchAdapter['schema']): SearchAdapter => ({
		kind: 'broken-search-schema-contract',
		capabilities: base.capabilities,
		search: (model, query, options) => base.search(model, query, options),
		index: (model, id, data) => base.index(model, id, data),
		delete: (model, id) => base.delete(model, id),
		schema
	});

	await assert.rejects(
		() => runSearchAdapterContract(adapter({ plan: async () => ({ adapter: 'broken-search-schema-contract', changes: [] }) } as any)),
		/Search contract adapter\.schema\.apply must be a function/
	);
	await assert.rejects(
		() =>
			runSearchAdapterContract(
				adapter({
					plan: async () => ({ adapter: 'broken-search-schema-contract', changes: 'bad' } as any),
					apply: async () => ({ adapter: 'broken-search-schema-contract', changes: [] })
				})
			),
		/Search contract adapter "broken-search-schema-contract" schema plan\.changes must be an array/
	);
	await assert.rejects(
		() =>
			runSearchAdapterContract(
				adapter({
					plan: async () => ({ adapter: 'broken-search-schema-contract', changes: [] }),
					apply: async () => ({ adapter: 'broken-search-schema-contract', changes: [{ type: 'bad', target: 'x' }] as any })
				})
			),
		/Search contract adapter "broken-search-schema-contract" schema apply plan\.changes\[0\]\.type/
	);
});

test('search adapter contract rejects adapters that ignore custom id fields', async () => {
	const base = new MemorySearchAdapter();
	const idModel = (model: ResolvedModelMeta): ResolvedModelMeta =>
		model.idField === 'slug' ? { ...model, idField: 'id' } : model;
	const idData = (model: ResolvedModelMeta, id: string | number, data: any) =>
		model.idField === 'slug' ? { id, title: data.title, score: data.score } : data;
	const broken: SearchAdapter = {
		kind: 'broken-custom-id-search',
		capabilities: base.capabilities,
		search: (model, query, options) => base.search(idModel(model), query, options),
		index: (model, id, data) => base.index(idModel(model), id, idData(model, id, data)),
		delete: (model, id) => base.delete(idModel(model), id)
	};

	await assert.rejects(
		() => runSearchAdapterContract(broken),
		/Missing expected rejection|Search contract result id/
	);
});

test('cache adapter contract rejects adapters with aliasing or invalid delete behavior', async () => {
	const entries = new Map<string, unknown>();
	const broken: CacheAdapter = {
		kind: 'broken-cache-contract',
		getMany: async (keys) => keys.map((key) => entries.get(key)),
		setMany: async (next) => {
			for (const [key, value] of next) entries.set(key, value);
		},
		deleteMany: async () => undefined
	};

	await assert.rejects(() => runCacheAdapterContract(broken));
});

test('cache adapter contract rejects adapters that accept malformed write options', async () => {
	const base = new MemoryCacheAdapter();
	const broken: CacheAdapter = {
		kind: 'broken-cache-options-contract',
		getMany: (keys) => base.getMany(keys),
		setMany: (entries, options) => {
			const ttl = options && typeof options.ttl === 'number' ? options.ttl : undefined;
			return base.setMany(entries, ttl === undefined ? undefined : { ttl });
		},
		deleteMany: (keys) => base.deleteMany(keys)
	};

	await assert.rejects(() => runCacheAdapterContract(broken));
});

test('search adapter contract rejects undeclared-field search and missing projection', async () => {
	const docs = new Map<string, any>();
	const broken: SearchAdapter = {
		kind: 'broken-search-contract',
		capabilities: new MemorySearchAdapter().capabilities,
		search: async (_model, query) => ({
			list: Array.from(docs.values()).filter((item) => JSON.stringify(item).includes(query)),
			more: false
		}),
		index: async (_model, id, data) => {
			docs.set(String(id), data);
		},
		delete: async (_model, id) => {
			docs.delete(String(id));
		}
	};

	await assert.rejects(() => runSearchAdapterContract(broken));
});

test('search adapter contract rejects incorrect total metadata', async () => {
	const base = new MemorySearchAdapter();
	const broken: SearchAdapter = {
		kind: 'broken-search-total-contract',
		capabilities: base.capabilities,
		search: async (model, query, options) => ({
			...(await base.search(model, query, options)),
			total: 999
		}),
		index: (model, id, data) => base.index(model, id, data),
		delete: (model, id) => base.delete(model, id)
	};

	await assert.rejects(
		() => runSearchAdapterContract(broken),
		/total must match the deterministic fixture hit count/
	);
});

test('search adapter contract rejects advertised filters that are ignored', async () => {
	const base = new MemorySearchAdapter();
	const broken: SearchAdapter = {
		kind: 'broken-search-filter-contract',
		capabilities: base.capabilities,
		search: async (model, query, options) => base.search(model, query, { ...options, where: undefined }),
		index: (model, id, data) => base.index(model, id, data),
		delete: (model, id) => base.delete(model, id)
	};

	await assert.rejects(() => runSearchAdapterContract(broken));
});

test('search adapter contract rejects undeclared filters that are accepted', async () => {
	const base = new MemorySearchAdapter();
	const broken: SearchAdapter = {
		kind: 'broken-search-undeclared-filter-contract',
		capabilities: { ...base.capabilities, where: false },
		search: (model, query, options) => base.search(model, query, options),
		index: (model, id, data) => base.index(model, id, data),
		delete: (model, id) => base.delete(model, id)
	};

	await assert.rejects(() => runSearchAdapterContract(broken), /Missing expected rejection/);
});

test('search adapter contract rejects every disabled where operator that is accepted', async () => {
	const base = new MemorySearchAdapter();
	const broken: SearchAdapter = {
		kind: 'broken-search-disabled-operator-contract',
		capabilities: {
			...base.capabilities,
			whereOperators: { ...base.capabilities.whereOperators, '=': false }
		},
		search: (model, query, options) => base.search(model, query, options),
		index: (model, id, data) => base.index(model, id, data),
		delete: (model, id) => base.delete(model, id)
	};

	await assert.rejects(() => runSearchAdapterContract(broken), /Missing expected rejection/);
});

test('search adapter contract rejects ignored result limits', async () => {
	const base = new MemorySearchAdapter();
	const broken: SearchAdapter = {
		kind: 'broken-search-limit-contract',
		capabilities: base.capabilities,
		search: async (model, query, options) => base.search(model, query, { ...options, limit: undefined }),
		index: (model, id, data) => base.index(model, id, data),
		delete: (model, id) => base.delete(model, id)
	};

	await assert.rejects(() => runSearchAdapterContract(broken));
});

test('integration harness can run cache and search adapter contracts', async () => {
	const harness = createIntegrationHarness({
		name: 'memory-all-contracts',
		createStore: () => new MemoryStoreAdapter(),
		createCache: () => new MemoryCacheAdapter(),
		createSearch: () => new MemorySearchAdapter()
	});

	await harness.runCacheContract();
	await harness.runSearchContract();
});

test('integration harness validates search contract options before starting resources', async () => {
	let started = false;
	const harness = createIntegrationHarness({
		name: 'invalid-search-contract-options',
		start: () => {
			started = true;
		},
		createStore: () => new MemoryStoreAdapter(),
		createSearch: () => new MemorySearchAdapter()
	});

	await assert.rejects(() => harness.runSearchContract({ settleMs: -1 } as any), /settleMs/);
	assert.equal(started, false);
});

test('middleware query and search counts normalize to returned list length', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(DuplicateCreateRegressionRecord);
	const row = { id: 1, handle: 'result' };
	const store = createStoreMiddlewareAdapter(
		{
			kind: 'wrong-count-store',
			get: async () => null,
			getMany: async () => [],
			query: async () => ({ list: [row], count: 999, total: 12 }),
			create: async () => undefined,
			update: async () => undefined,
			delete: async () => undefined
		},
		[]
	);
	const search = createSearchMiddlewareAdapter(
		{
			kind: 'wrong-count-search',
			capabilities: new MemorySearchAdapter().capabilities,
			search: async () => ({ list: [row], count: 999, total: 12 }),
			index: async () => undefined,
			delete: async () => undefined
		},
		[]
	);

	const queryResult = await store.query(meta, { where: [], or: [], sort: [], include: [] });
	const searchResult = await search.search(meta, 'result', {});

	assert.equal(queryResult.count, 1);
	assert.equal(queryResult.total, 12);
	assert.equal(searchResult.count, 1);
	assert.equal(searchResult.total, 12);
});
