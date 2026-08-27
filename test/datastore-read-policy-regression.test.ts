import test from 'node:test';
import assert from 'node:assert/strict';
import {
	MemoryCacheAdapter,
	MemoryStoreAdapter,
	Model,
	createActiveTs,
	datastoreReadOptions,
	defineModel,
	setDefaultContext,
	type AggregatePlan,
	type QueryPlan,
	type ResolvedModelMeta,
	type StoreAdapter,
	type StoreReadOptions
} from '../src/index.js';
import { createDatastoreStoreAdapter } from '../src/adapters/store/datastore.js';

type ReadPolicyData = {
	id: number;
	value: string;
};

class ReadPolicyRecord extends Model<ReadPolicyData> {}

defineModel<ReadPolicyData>({ name: 'datastore_read_policy_record', cache: { ttl: 60 } })
	.id('id')
	.validate((input) => input as ReadPolicyData)
	.attach(ReadPolicyRecord);

const adapterMeta: ResolvedModelMeta<ReadPolicyData> = {
	model: class {},
	name: 'datastore_read_policy_record',
	store: 'default',
	idField: 'id',
	readValidation: 'off',
	indexes: [],
	searchIndexes: [],
	relations: new Map(),
	hooks: {},
	views: new Map(),
	policies: new Map(),
	scopes: new Map(),
	fieldCodecs: new Map(),
	fieldTypes: new Map([['value', 'string']])
};

const emptyPlan: QueryPlan = { where: [], or: [], sort: [], include: [] };

function readPolicyFromOptions(options: StoreReadOptions | undefined) {
	return options?.meta?.datastoreRead as { readTime?: number; consistency?: string } | undefined;
}

function readPolicyFromPlan(plan: QueryPlan | AggregatePlan) {
	return plan.meta?.datastoreRead as { readTime?: number; consistency?: string } | undefined;
}

function highLevelReadStore() {
	const getManyOptions: Array<StoreReadOptions | undefined> = [];
	const queryPlans: QueryPlan[] = [];
	const queryOptions: Array<StoreReadOptions | undefined> = [];
	const aggregatePlans: AggregatePlan[] = [];
	const writes = { update: 0, delete: 0 };
	const store: StoreAdapter = {
		kind: 'datastore-read-policy-test',
		capabilities: {
			aggregate: true,
			select: true,
			datastoreReadPolicy: true
		},
		get: async (_model, id, options) => ({
			id,
			value: readPolicyFromOptions(options) ? 'historical' : 'current'
		}),
		getMany: async (_model, ids, options) => {
			getManyOptions[getManyOptions.length] = options;
			return ids.map((id) => ({
				id,
				value: readPolicyFromOptions(options) ? 'historical' : 'current'
			}));
		},
		query: async (_model, plan, options) => {
			queryPlans[queryPlans.length] = plan;
			queryOptions[queryOptions.length] = options;
			return {
				list: [{ id: 1, value: readPolicyFromPlan(plan) ? 'historical-query' : 'current-query' }],
				more: false
			};
		},
		aggregate: async (_model, plan) => {
			aggregatePlans[aggregatePlans.length] = plan;
			return { total: readPolicyFromPlan(plan) ? 7 : 1 };
		},
		create: async () => undefined,
		update: async () => { writes.update++; },
		delete: async () => { writes.delete++; }
	};
	return { store, getManyOptions, queryPlans, queryOptions, aggregatePlans, writes };
}

function datastoreQuery() {
	return {
		filter() { return this; },
		order() { return this; },
		limit() { return this; },
		offset() { return this; },
		start() { return this; },
		select() { return this; },
		hasAncestor() { return this; }
	};
}

function datastoreClient(overrides: Record<string, unknown> = {}) {
	return {
		key: (input: unknown) => input,
		get: async () => [undefined],
		save: async () => undefined,
		delete: async () => undefined,
		update: async () => undefined,
		createQuery: () => datastoreQuery(),
		runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }],
		...overrides
	};
}

test('datastoreReadOptions normalizes typed read policies and scoped ancestors', () => {
	const readTime = new Date('2026-07-17T00:00:00.000Z');
	const ancestor = { path: [{ kind: 'parent', id: 1 }] };
	const options = datastoreReadOptions({ readTime, ancestor });
	assert.deepEqual(options, {
		meta: {
			datastoreRead: { readTime: readTime.getTime() },
			datastoreAncestor: { ...ancestor, namespace: undefined }
		}
	});
	assert.equal(Object.isFrozen(options), true);
	assert.equal(Object.isFrozen(options.meta), true);
	assert.equal(Object.isFrozen(options.meta.datastoreRead), true);
	assert.throws(
		() => datastoreReadOptions({ readTime: 1, consistency: 'strong' } as any),
		/cannot combine readTime with consistency/
	);
	assert.throws(
		() => datastoreReadOptions({ readTime: Number.NaN } as any),
		/positive safe integer timestamp/
	);
	assert.throws(
		() => datastoreReadOptions({ readTime: Object.create(Date.prototype) } as any),
		/positive safe integer timestamp/
	);
	assert.throws(() => datastoreReadOptions({ readTime: 0 }), /positive safe integer timestamp/);
	assert.throws(
		() => datastoreReadOptions({ consistency: 'cached' } as any),
		/consistency must be "strong" or "eventual"/
	);
	assert.throws(
		() => datastoreReadOptions({ readTime: 1, readtime: 2 } as any),
		/unknown option "readtime"/
	);
	let accessorCalls = 0;
	const accessorOptions = Object.defineProperty({}, 'readTime', {
		enumerable: true,
		get() {
			accessorCalls++;
			return 1;
		}
	});
	assert.throws(() => datastoreReadOptions(accessorOptions as any), /readTime must be a data property/);
	assert.equal(accessorCalls, 0);
});

test('high-level Datastore read policies bypass caches, survive hooks, and make historical models read-only', async () => {
	const { store, getManyOptions, queryPlans, queryOptions, aggregatePlans, writes } = highLevelReadStore();
	let writeHookCalls = 0;
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: new MemoryCacheAdapter() },
		plugins: [{
			name: 'read-policy-plan-rewrite',
			hooks: {
				beforeQuery: ({ plan }) => ({ plan: { ...(plan as QueryPlan), meta: undefined } }),
				beforeAggregate: ({ plan }) => ({ plan: { ...(plan as AggregatePlan), meta: undefined } }),
				beforeUpdate: () => { writeHookCalls++; },
				beforeDelete: () => { writeHookCalls++; }
			}
		}]
	});
	setDefaultContext(context);

	assert.equal((await ReadPolicyRecord.find(1).load())?.data.value, 'current');
	const historical = await ReadPolicyRecord.find(1).readAt(1_700_000_000_000).load();
	assert.equal(historical?.data.value, 'historical');
	assert.equal((await ReadPolicyRecord.find(1).load())?.data.value, 'current');
	assert.equal(getManyOptions.length, 2);
	assert.deepEqual(readPolicyFromOptions(getManyOptions[1]), { readTime: 1_700_000_000_000 });
	historical!.data.value = 'restore-attempt';
	await assert.rejects(() => historical!.save(), /historical snapshots are read-only/);
	await assert.rejects(() => historical!.delete(), /historical snapshots are read-only/);

	const queried = await ReadPolicyRecord.query().readAt(new Date(1_700_000_000_100)).load();
	assert.equal(queried.list[0].data.value, 'historical-query');
	assert.deepEqual(readPolicyFromPlan(queryPlans[0]), { readTime: 1_700_000_000_100 });
	assert.deepEqual(readPolicyFromOptions(queryOptions[0]), { readTime: 1_700_000_000_100 });
	await assert.rejects(() => queried.list[0].save(), /historical snapshots are read-only/);
	assert.deepEqual(writes, { update: 0, delete: 0 });
	assert.equal(writeHookCalls, 0);

	const consistent = await ReadPolicyRecord.find(2).readConsistency('strong').load();
	await consistent!.save();
	assert.deepEqual(writes, { update: 1, delete: 0 });
	assert.equal(writeHookCalls, 1);

	const aggregate = await ReadPolicyRecord.query().readConsistency('eventual').aggregate({ total: 'count' });
	assert.deepEqual(aggregate, { total: 7 });
	assert.deepEqual(readPolicyFromPlan(aggregatePlans[0]), { consistency: 'eventual' });

	await assert.rejects(
		() => ReadPolicyRecord.query().readAt(1).include('related').load(),
		/cannot be combined with include/
	);
	await assert.rejects(
		() => ReadPolicyRecord.find(1).readAt(1).include('related').load(),
		/cannot be combined with include/
	);
	await assert.rejects(
		() => ReadPolicyRecord.query().readAt(1).find(1).update({ value: 'changed' }),
		/cannot be updated/
	);
	await assert.rejects(
		() => ReadPolicyRecord.query().readAt(1).find(1).delete(),
		/cannot be deleted/
	);
	assert.throws(
		() => ReadPolicyRecord.query().readAt(1).readConsistency('strong'),
		/cannot be combined with readAt/
	);
});

test('stores without Datastore read-policy capability fail before reads', async () => {
	const memory = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: memory } });
	setDefaultContext(context);
	await assert.rejects(
		() => ReadPolicyRecord.query().readAt(1).load(),
		/does not support Datastore read policies/
	);
	await assert.rejects(
		() => ReadPolicyRecord.find(1).readConsistency('strong').load(),
		/does not support Datastore read policies/
	);
	await assert.rejects(
		() => memory.query(adapterMeta, { ...emptyPlan, meta: { datastoreRead: undefined } }),
		/does not support Datastore read policies/
	);
	assert.equal(memory.stats.query, 0);
	assert.equal(memory.stats.getMany, 0);
});

test('Datastore adapter forwards readTime and consistency to every SDK read shape', async () => {
	const calls: Array<{ operation: string; options: unknown }> = [];
	let client: ReturnType<typeof datastoreClient>;
	client = datastoreClient({
		get: async (_input: unknown, options: unknown) => {
			calls[calls.length] = { operation: 'get', options };
			return [Array.isArray(_input) ? [] : undefined];
		},
		runQuery: async (_query: unknown, options: unknown) => {
			calls[calls.length] = { operation: 'runQuery', options };
			return [[], { moreResults: 'NO_MORE_RESULTS' }];
		},
		createAggregationQuery: () => ({
			count() { return this; },
			sum() { return this; },
			average() { return this; }
		}),
		runAggregationQuery: async function (this: unknown, _query: unknown, options: unknown) {
			assert.equal(this, client);
			calls[calls.length] = { operation: 'runAggregationQuery', options };
			return [[{ total: 3 }], {}];
		}
	});
	const datastore = await createDatastoreStoreAdapter({ client });
	const readTime = 1_700_000_000_000;
	await datastore.get(adapterMeta, 1, datastoreReadOptions({ readTime }));
	await datastore.getMany(adapterMeta, [1], datastoreReadOptions({ consistency: 'strong' }));
	await datastore.query(adapterMeta, {
		...emptyPlan,
		meta: { datastoreRead: { consistency: 'eventual' } }
	});
	await datastore.aggregate!(adapterMeta, {
		where: [],
		or: [],
		aggregates: [{ op: 'count', as: 'total' }],
		meta: { datastoreRead: { readTime } }
	});
	await datastore.aggregate!(adapterMeta, {
		where: [],
		or: [],
		aggregates: [{ op: 'min', field: 'value', as: 'minimum' }],
		meta: { datastoreRead: { consistency: 'strong' } }
	});
	assert.deepEqual(calls, [
		{ operation: 'get', options: { readTime } },
		{ operation: 'get', options: { consistency: 'strong' } },
		{ operation: 'runQuery', options: { consistency: 'eventual' } },
		{ operation: 'runAggregationQuery', options: { readTime } },
		{ operation: 'runQuery', options: { consistency: 'strong' } }
	]);
});

test('Datastore scan fallbacks retain read policy on backend pages', async () => {
	const optionsSeen: unknown[] = [];
	let queryPages = 0;
	const fallbackMeta = { ...adapterMeta, fieldTypes: new Map<string, never>() };
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			runQuery: async (_query: unknown, options: unknown) => {
				optionsSeen[optionsSeen.length] = options;
				if (queryPages++ === 0) {
					return [[], { moreResults: 'MORE_RESULTS_AFTER_LIMIT', endCursor: 'next-page' }];
				}
				return [[], { moreResults: 'NO_MORE_RESULTS' }];
			}
		}),
		allowQueryScanFallback: true,
		allowAggregateScanFallback: true
	});
	await datastore.query(fallbackMeta, {
		...emptyPlan,
		where: [{ field: 'value', op: '!=', value: 'skip' }],
		meta: { datastoreRead: { readTime: 1234 } }
	});
	await datastore.aggregate!(adapterMeta, {
		where: [],
		or: [],
		aggregates: [{ op: 'count', as: 'total' }],
		meta: { datastoreRead: { consistency: 'eventual' } }
	});
	assert.deepEqual(optionsSeen, [
		{ readTime: 1234 },
		{ readTime: 1234 },
		{ consistency: 'eventual' }
	]);
});

test('Datastore rejects native and transactional reads with policies before SDK execution', async () => {
	let nativeCalls = 0;
	let transactionGetCalls = 0;
	let rollbackCalls = 0;
	const transaction = {
		run: async () => undefined,
		commit: async () => undefined,
		rollback: async () => { rollbackCalls++; },
		key: (input: unknown) => input,
		get: async () => {
			transactionGetCalls++;
			return [undefined];
		},
		save: async () => undefined,
		delete: async () => undefined,
		update: async () => undefined,
		createQuery: () => datastoreQuery(),
		runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }]
	};
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({ transaction: () => transaction })
	});
	await assert.rejects(
		() => datastore.query(adapterMeta, {
			...emptyPlan,
			native: { payload: async () => { nativeCalls++; return { list: [] }; } },
			meta: { datastoreRead: { readTime: 1234 } }
		}),
		/native function queries cannot be combined/
	);
	assert.equal(nativeCalls, 0);
	await assert.rejects(
		() => datastore.transaction!(
			(tx) => tx.get(adapterMeta, 1, datastoreReadOptions({ readTime: 1234 }))
		),
		/cannot use Datastore readTime or consistency inside a transaction/
	);
	assert.equal(transactionGetCalls, 0);
	assert.equal(rollbackCalls, 1);
});
