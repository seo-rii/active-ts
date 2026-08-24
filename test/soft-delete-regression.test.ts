import test from 'node:test';
import assert from 'node:assert/strict';
import {
	MemoryCacheAdapter,
	MemoryStoreAdapter,
	Model,
	clearDefaultContext,
	createActiveTs,
	createSoftDeletePlugin,
	defineModel,
	restore,
	setDefaultContext,
	softDelete
} from '../src/index.js';
import { BOUND_CONTEXT } from '../src/core/model-markers.js';
import { isSoftDeletePlanGuardHook } from '../src/core/soft-delete-guard.js';

type ScopedSoftData = {
	id: number;
	tenantId: string;
	status: 'open' | 'pending' | 'closed';
	amount: number;
	deletedAt?: string | null;
};

class ScopedSoftRecord extends Model<ScopedSoftData> {}
class CachedSoftRecord extends Model<ScopedSoftData> {}

class NoMissingNullStore extends MemoryStoreAdapter {
	override readonly capabilities = {
		or: true,
		contains: false,
		arrayContains: true,
		textContains: true,
		jsonContains: true,
		startsWith: true,
		cursor: true,
		offset: true,
		select: true,
		nestedFields: true,
		numericComparisons: true,
		aggregate: true,
		transaction: true,
		transactionConflictDetection: true,
		savepoint: false,
		uniqueIndex: false,
		optimisticLock: true,
		nullOperators: true,
		missingFieldNulls: false,
		native: false
	};
	queryCalls = 0;
	queryPlans: any[] = [];

	override async query(...args: Parameters<MemoryStoreAdapter['query']>) {
		this.queryCalls++;
		this.queryPlans.push(args[1]);
		return await super.query(...args);
	}
}

defineModel<ScopedSoftData>('scoped_soft_record')
	.id('id')
	.validate((input) => input as ScopedSoftData)
	.scope('tenant', ({ viewer }) => ({ tenantId: (viewer as { tenantId: string }).tenantId }))
	.attach(ScopedSoftRecord);

defineModel<ScopedSoftData>({ name: 'cached_soft_record', cache: { ttl: 60 } })
	.id('id')
	.validate((input) => input as ScopedSoftData)
	.attach(CachedSoftRecord);

test('soft delete constraints apply to aggregate whereAny branches and tenant scopes', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({
		stores: { default: store },
		plugins: [createSoftDeletePlugin({ models: ['scoped_soft_record'] })]
	});
	const Record = ScopedSoftRecord.use(context) as unknown as typeof ScopedSoftRecord;
	await store.seed('scoped_soft_record', [
		{ id: 1, tenantId: 'a', status: 'open', amount: 10, deletedAt: null },
		{ id: 2, tenantId: 'a', status: 'pending', amount: 20, deletedAt: null },
		{ id: 3, tenantId: 'a', status: 'open', amount: 30, deletedAt: '2026-05-13T00:00:00.000Z' },
		{ id: 4, tenantId: 'b', status: 'open', amount: 40, deletedAt: null }
	]);

	const liveAggregate = await Record.scope('tenant', { tenantId: 'a' })
		.whereAny({ status: 'open' }, { status: 'pending' })
		.aggregate({
			count: 'count',
			total: { op: 'sum', field: 'amount' },
			highest: { op: 'max', field: 'amount' }
		});
	assert.deepEqual(liveAggregate, { count: 2, total: 30, highest: 20 });

	const deletedAggregate = await Record.scope('tenant', { tenantId: 'a' })
		.onlyDeleted()
		.whereAny({ status: 'open' }, { status: 'pending' })
		.aggregate({
			count: 'count',
			total: { op: 'sum', field: 'amount' }
		});
	assert.deepEqual(deletedAggregate, { count: 1, total: 30 });
});

test('soft delete treats missing deletedAt as live data in memory queries', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({
		stores: { default: store },
		plugins: [createSoftDeletePlugin({ models: ['scoped_soft_record'] })]
	});
	const Record = ScopedSoftRecord.use(context) as unknown as typeof ScopedSoftRecord;
	await store.seed('scoped_soft_record', [
		{ id: 1, tenantId: 'a', status: 'open', amount: 10 },
		{ id: 2, tenantId: 'a', status: 'pending', amount: 20, deletedAt: null },
		{ id: 3, tenantId: 'a', status: 'closed', amount: 30, deletedAt: '2026-05-13T00:00:00.000Z' }
	]);

	const live = await Record.query().orderBy('id').load();
	assert.deepEqual(live.list.map((item) => item.data.id), [1, 2]);

	const deleted = await Record.onlyDeleted().load();
	assert.deepEqual(deleted.list.map((item) => item.data.id), [3]);

	const all = await Record.withDeleted().orderBy('id').load();
	assert.deepEqual(all.list.map((item) => item.data.id), [1, 2, 3]);
});

test('soft delete constraints cannot be bypassed by explicit deletedAt filters', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({
		stores: { default: store },
		plugins: [createSoftDeletePlugin({ models: ['scoped_soft_record'] })]
	});
	const Record = ScopedSoftRecord.use(context) as unknown as typeof ScopedSoftRecord;
	await store.seed('scoped_soft_record', [
		{ id: 1, tenantId: 'a', status: 'open', amount: 10, deletedAt: null },
		{ id: 2, tenantId: 'a', status: 'closed', amount: 20, deletedAt: '2026-05-13T00:00:00.000Z' }
	]);

	const defaultScope = await Record.query().where('deletedAt', 'isNotNull').load();
	assert.deepEqual(defaultScope.list.map((item) => item.data.id), []);

	const onlyDeleted = await Record.onlyDeleted().where('deletedAt', 'isNull').load();
	assert.deepEqual(onlyDeleted.list.map((item) => item.data.id), []);
});

test('soft delete plugin materializes deletedAt null on created rows', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({
		stores: { default: store },
		plugins: [createSoftDeletePlugin({ models: ['scoped_soft_record'] })]
	});
	const Record = ScopedSoftRecord.use(context) as unknown as typeof ScopedSoftRecord;

	await Record.create({ id: 5, tenantId: 'a', status: 'open', amount: 10 });

	assert.deepEqual(store.dump('scoped_soft_record'), [
		{ id: 5, tenantId: 'a', status: 'open', amount: 10, deletedAt: null }
	]);
});

test('soft delete materializes undefined and nested field paths consistently', async () => {
	const defaultStore = new MemoryStoreAdapter();
	const defaultContext = createActiveTs({
		stores: { default: defaultStore },
		plugins: [createSoftDeletePlugin({ models: ['scoped_soft_record'] })]
	});
	const DefaultRecord = ScopedSoftRecord.use(defaultContext) as unknown as typeof ScopedSoftRecord;
	await DefaultRecord.create({
		id: 18,
		tenantId: 'a',
		status: 'open',
		amount: 10,
		deletedAt: undefined
	} as any);
	assert.deepEqual(defaultStore.dump('scoped_soft_record'), [
		{ id: 18, tenantId: 'a', status: 'open', amount: 10, deletedAt: null }
	]);

	const nestedStore = new MemoryStoreAdapter();
	const nestedContext = createActiveTs({
		stores: { default: nestedStore },
		plugins: [createSoftDeletePlugin({ models: ['scoped_soft_record'], field: 'audit.deletedAt' })]
	});
	const NestedRecord = ScopedSoftRecord.use(nestedContext) as unknown as typeof ScopedSoftRecord;
	await NestedRecord.create({
		id: 19,
		tenantId: 'a',
		status: 'open',
		amount: 10,
		audit: { deletedAt: undefined }
	} as any);
	assert.deepEqual(nestedStore.dump('scoped_soft_record'), [
		{ id: 19, tenantId: 'a', status: 'open', amount: 10, audit: { deletedAt: null } }
	]);
	assert.equal((nestedStore.dump('scoped_soft_record')[0] as any)['audit.deletedAt'], undefined);

	await softDelete(NestedRecord, 19, undefined, {
		field: 'audit.deletedAt',
		now: () => '2026-05-16T00:00:00.000Z'
	});
	assert.equal((nestedStore.dump('scoped_soft_record')[0] as any).audit.deletedAt, '2026-05-16T00:00:00.000Z');
	assert.equal((nestedStore.dump('scoped_soft_record')[0] as any)['audit.deletedAt'], undefined);

	await restore(NestedRecord, 19, undefined, { field: 'audit.deletedAt' });
	assert.equal((nestedStore.dump('scoped_soft_record')[0] as any).audit.deletedAt, null);
});

test('soft delete plugin rejects create data accessors before materializing nulls', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({
		stores: { default: store },
		plugins: [createSoftDeletePlugin({ models: ['scoped_soft_record'] })]
	});
	const Record = ScopedSoftRecord.use(context) as unknown as typeof ScopedSoftRecord;
	let dataReads = 0;
	const accessorData = Object.defineProperty(
		{ id: 15, tenantId: 'a', status: 'open', amount: 10 },
		'extra',
		{
			enumerable: true,
			get() {
				dataReads++;
				return 'hidden';
			}
		}
	);

	await assert.rejects(
		() => Record.create(accessorData as any),
		/Unsupported data accessor at "\$\.extra"/
	);
	assert.equal(dataReads, 0);
	assert.deepEqual(store.dump('scoped_soft_record'), []);

	await assert.rejects(
		() => Record.create({ id: 16, tenantId: 'a', status: 'open', amount: 10, [Symbol('hidden')]: true } as any),
		/Unsupported data symbol key at "\$"/
	);
	assert.deepEqual(store.dump('scoped_soft_record'), []);
});

test('soft delete plugin rejects hidden create fields before materializing nulls', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({
		stores: { default: store },
		plugins: [createSoftDeletePlugin({ models: ['scoped_soft_record'] })]
	});
	const Record = ScopedSoftRecord.use(context) as unknown as typeof ScopedSoftRecord;
	const hiddenData = Object.defineProperty(
		{ id: 17, tenantId: 'a', status: 'open', amount: 10 },
		'extra',
		{ enumerable: false, value: 'hidden' }
	);

	await assert.rejects(
		() => Record.create(hiddenData as any),
		/Unsupported non-enumerable data key "\$\.extra"/
	);
	assert.deepEqual(store.dump('scoped_soft_record'), []);
});

test('soft delete plugin rejects hook-mutated plan and model accessors without invoking them', async () => {
	let metaReads = 0;
	const metaStore = new MemoryStoreAdapter();
	const metaContext = createActiveTs({
		stores: { default: metaStore },
		plugins: [
			{
				name: 'accessor-plan-meta',
				hooks: {
					beforeQuery(payload) {
						return {
							plan: Object.defineProperty({ ...(payload.plan as any) }, 'meta', {
								enumerable: true,
								get() {
									metaReads++;
									return {};
								}
							}) as any
						};
					}
				}
			},
			createSoftDeletePlugin({ models: ['scoped_soft_record'] })
		]
	});
	const MetaRecord = ScopedSoftRecord.use(metaContext) as unknown as typeof ScopedSoftRecord;
	await assert.rejects(
		() => MetaRecord.query().load(),
		/Hook result key "plan"\.meta must be a data property/
	);
	assert.equal(metaReads, 0);

	let whereReads = 0;
	const whereStore = new MemoryStoreAdapter();
	const whereContext = createActiveTs({
		stores: { default: whereStore },
		plugins: [
			{
				name: 'accessor-plan-where',
				hooks: {
					beforeQuery(payload) {
						return {
							plan: Object.defineProperty({ ...(payload.plan as any) }, 'where', {
								enumerable: true,
								get() {
									whereReads++;
									return [];
								}
							}) as any
						};
					}
				}
			},
			createSoftDeletePlugin({ models: ['scoped_soft_record'] })
		]
	});
	const WhereRecord = ScopedSoftRecord.use(whereContext) as unknown as typeof ScopedSoftRecord;
	await assert.rejects(
		() => WhereRecord.query().load(),
		/Hook result key "plan"\.where must be a data property/
	);
	assert.equal(whereReads, 0);

	let modelReads = 0;
	const modelContext = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		plugins: [createSoftDeletePlugin()]
	});
	const accessorModel = Object.defineProperty({ hooks: {} }, 'name', {
		enumerable: true,
		get() {
			modelReads++;
			return 'scoped_soft_record';
		}
	});
	await assert.rejects(
		() => modelContext.runHooks('beforeQuery', {
			operation: 'query',
			model: accessorModel as any,
			plan: { where: [], or: [], sort: [], include: [] }
		}),
		/soft-delete hook model\.name must be a data property/
	);
	assert.equal(modelReads, 0);
});

test('soft delete plugin rejects hook-mutated hidden plan fields', async () => {
	const whereStore = new MemoryStoreAdapter();
	const whereContext = createActiveTs({
		stores: { default: whereStore },
		plugins: [
			{
				name: 'hidden-plan-where',
				hooks: {
					beforeQuery(payload) {
						return {
							plan: Object.defineProperty({ ...(payload.plan as any) }, 'where', {
								enumerable: false,
								value: [],
								writable: true,
								configurable: true
							}) as any
						};
					}
				}
			},
			createSoftDeletePlugin({ models: ['scoped_soft_record'] })
		]
	});
	const WhereRecord = ScopedSoftRecord.use(whereContext) as unknown as typeof ScopedSoftRecord;
	await assert.rejects(
		() => WhereRecord.query().load(),
		/Hook result key "plan"\.where must be enumerable/
	);

	const metaStore = new MemoryStoreAdapter();
	const metaContext = createActiveTs({
		stores: { default: metaStore },
		plugins: [
			{
				name: 'hidden-plan-meta-field',
				hooks: {
					beforeQuery(payload) {
						const meta = Object.defineProperty({}, 'softDelete', {
							enumerable: false,
							value: 'with'
						});
						return { plan: { ...(payload.plan as any), meta } as any };
					}
				}
			},
			createSoftDeletePlugin({ models: ['scoped_soft_record'] })
		]
	});
	const MetaRecord = ScopedSoftRecord.use(metaContext) as unknown as typeof ScopedSoftRecord;
	await assert.rejects(
		() => MetaRecord.query().load(),
		/Hook result key "plan"\.meta\.softDelete must be enumerable/
	);
});

test('soft delete hook plan arrays do not execute custom mutation methods', async () => {
	let pushCalls = 0;
	const pushStore = new MemoryStoreAdapter();
	const pushContext = createActiveTs({
		stores: { default: pushStore },
		plugins: [
			{
				name: 'custom-push-plan',
				hooks: {
					beforeQuery(payload) {
						if (payload.model?.name !== 'scoped_soft_record' || !payload.plan) return;
						const where = [] as any[];
						Object.defineProperty(where, 'push', {
							value() {
								pushCalls++;
								throw new Error('custom soft-delete where push should not run');
							}
						});
						payload.plan.where = where;
					}
				}
			},
			createSoftDeletePlugin({ models: ['scoped_soft_record'] })
		]
	});
	const PushRecord = ScopedSoftRecord.use(pushContext) as unknown as typeof ScopedSoftRecord;
	await pushStore.seed('scoped_soft_record', [
		{ id: 21, tenantId: 'a', status: 'open', amount: 1, deletedAt: null },
		{ id: 22, tenantId: 'a', status: 'open', amount: 1, deletedAt: '2026-05-15T00:00:00.000Z' }
	]);

	const live = await PushRecord.query().orderBy('id').load();

	assert.deepEqual(live.list.map((item) => item.data.id), [21]);
	assert.equal(pushCalls, 0);

	let iteratorCalls = 0;
	const symbolStore = new MemoryStoreAdapter();
	const symbolContext = createActiveTs({
		stores: { default: symbolStore },
		plugins: [
			{
				name: 'symbol-plan-array',
				hooks: {
					beforeQuery(payload) {
						if (payload.model?.name !== 'scoped_soft_record' || !payload.plan) return;
						const where = [] as any[];
						Object.defineProperty(where, Symbol.iterator, {
							value() {
								iteratorCalls++;
								throw new Error('custom soft-delete where iterator should not run');
							}
						});
						payload.plan.where = where;
					}
				}
			},
			createSoftDeletePlugin({ models: ['scoped_soft_record'] })
		]
	});
	const SymbolRecord = ScopedSoftRecord.use(symbolContext) as unknown as typeof ScopedSoftRecord;
	await assert.rejects(
		() => SymbolRecord.query().load(),
		/soft-delete hook plan\.where cannot contain symbol fields/
	);
	assert.equal(iteratorCalls, 0);
});

test('soft delete hook plan arrays reject non-writable lengths before raw push errors', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({
		stores: { default: store },
		plugins: [
			{
				name: 'non-writable-soft-delete-where',
				hooks: {
					beforeQuery(payload) {
						if (payload.model?.name !== 'scoped_soft_record' || !payload.plan) return;
						const where = [] as any[];
						Object.defineProperty(where, 'length', {
							value: 0,
							writable: false
						});
						payload.plan.where = where;
					}
				}
			},
			createSoftDeletePlugin({ models: ['scoped_soft_record'] })
		]
	});
	const Record = ScopedSoftRecord.use(context) as unknown as typeof ScopedSoftRecord;
	await store.seed('scoped_soft_record', [{ id: 71, tenantId: 'a', status: 'open', amount: 1, deletedAt: null }]);

	await assert.rejects(
		() => Record.query().load(),
		/soft-delete hook plan\.where\.length must be writable/
	);
});

test('soft delete fails fast on stores without missing-field null semantics unless nulls are materialized', async () => {
	const unsafeStore = new NoMissingNullStore();
	const unsafeContext = createActiveTs({
		stores: { default: unsafeStore },
		plugins: [createSoftDeletePlugin({ models: ['scoped_soft_record'] })]
	});
	const UnsafeRecord = ScopedSoftRecord.use(unsafeContext) as unknown as typeof ScopedSoftRecord;
	await assert.rejects(() => UnsafeRecord.query().load(), /missing fields as null/);
	assert.equal(unsafeStore.queryCalls, 0);

	const materializedStore = new NoMissingNullStore();
	const materializedContext = createActiveTs({
		stores: { default: materializedStore },
		plugins: [createSoftDeletePlugin({ models: ['scoped_soft_record'], materializedNulls: true })]
	});
	const MaterializedRecord = ScopedSoftRecord.use(materializedContext) as unknown as typeof ScopedSoftRecord;
	await materializedStore.seed('scoped_soft_record', [{ id: 6, tenantId: 'a', status: 'open', amount: 10, deletedAt: null }]);

	const live = await MaterializedRecord.query().load();

	assert.deepEqual(live.list.map((item) => item.data.id), [6]);
	assert.equal(materializedStore.queryCalls, 1);
	assert.deepEqual(materializedStore.queryPlans[0].where, [
		{ field: 'deletedAt', op: '=', value: null }
	]);
});

test('soft delete helpers use bound model context when no explicit context is provided', async () => {
	const defaultStore = new MemoryStoreAdapter();
	const boundStore = new MemoryStoreAdapter();
	const defaultContext = createActiveTs({
		stores: { default: defaultStore },
		plugins: [createSoftDeletePlugin({ models: ['scoped_soft_record'] })]
	});
	const boundContext = createActiveTs({
		stores: { default: boundStore },
		plugins: [createSoftDeletePlugin({ models: ['scoped_soft_record'] })]
	});
	setDefaultContext(defaultContext);
	const BoundRecord = ScopedSoftRecord.use(boundContext) as unknown as typeof ScopedSoftRecord;
	await defaultStore.seed('scoped_soft_record', [{ id: 7, tenantId: 'default', status: 'open', amount: 1 }]);
	await boundStore.seed('scoped_soft_record', [{ id: 7, tenantId: 'bound', status: 'open', amount: 2 }]);

	await softDelete(BoundRecord, 7, undefined, { now: () => '2026-05-13T00:00:00.000Z' });
	assert.deepEqual(defaultStore.dump('scoped_soft_record'), [
		{ id: 7, tenantId: 'default', status: 'open', amount: 1 }
	]);
	assert.equal(boundStore.dump('scoped_soft_record')[0].deletedAt, '2026-05-13T00:00:00.000Z');

	await restore(BoundRecord, 7);
	assert.equal(boundStore.dump('scoped_soft_record')[0].deletedAt, null);
});

test('soft delete helpers follow ambient transaction scope for bound root models', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({
		stores: { default: store },
		plugins: [createSoftDeletePlugin({ models: ['scoped_soft_record'] })]
	});
	const Record = ScopedSoftRecord.use(context) as unknown as typeof ScopedSoftRecord;
	await store.seed('scoped_soft_record', [{ id: 9, tenantId: 'a', status: 'open', amount: 1, deletedAt: null }]);

	await assert.rejects(
		() =>
			context.transaction(async () => {
				await softDelete(Record, 9, undefined, { now: () => '2026-05-13T00:00:00.000Z' });
				throw new Error('rollback soft delete');
			}),
		/rollback soft delete/
	);

	assert.deepEqual(store.dump('scoped_soft_record'), [
		{ id: 9, tenantId: 'a', status: 'open', amount: 1, deletedAt: null }
	]);
});

test('soft delete helpers write from fresh store rows instead of stale entity cache', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: new MemoryCacheAdapter() },
		plugins: [createSoftDeletePlugin({ models: ['cached_soft_record'] })]
	});
	const Record = CachedSoftRecord.use(context) as unknown as typeof CachedSoftRecord;
	const meta = context.meta(CachedSoftRecord);

	await Record.create({ id: 1, tenantId: 'a', status: 'open', amount: 1, deletedAt: null });
	await Record.find(1).load();
	await store.update(meta, 1, { id: 1, tenantId: 'a', status: 'pending', amount: 99, deletedAt: null });
	await softDelete(Record, 1, context, { now: () => '2026-05-17T00:00:00.000Z' });

	assert.deepEqual(store.dump('cached_soft_record')[0], {
		id: 1,
		tenantId: 'a',
		status: 'pending',
		amount: 99,
		deletedAt: '2026-05-17T00:00:00.000Z'
	});

	await Record.create({ id: 2, tenantId: 'a', status: 'closed', amount: 2, deletedAt: '2026-05-18T00:00:00.000Z' });
	await Record.find(2).load();
	await store.update(meta, 2, {
		id: 2,
		tenantId: 'a',
		status: 'pending',
		amount: 88,
		deletedAt: '2026-05-18T00:00:00.000Z'
	});
	await restore(Record, 2, context);

	assert.deepEqual(store.dump('cached_soft_record')[1], {
		id: 2,
		tenantId: 'a',
		status: 'pending',
		amount: 88,
		deletedAt: null
	});
});

test('soft delete helpers ignore Function prototype bound context markers', async () => {
	const defaultStore = new MemoryStoreAdapter();
	const pollutedStore = new MemoryStoreAdapter();
	const defaultContext = createActiveTs({
		stores: { default: defaultStore },
		plugins: [createSoftDeletePlugin({ models: ['scoped_soft_record'] })]
	});
	const pollutedContext = createActiveTs({
		stores: { default: pollutedStore },
		plugins: [createSoftDeletePlugin({ models: ['scoped_soft_record'] })]
	});
	await defaultStore.seed('scoped_soft_record', [{ id: 8, tenantId: 'default', status: 'open', amount: 1 }]);
	await pollutedStore.seed('scoped_soft_record', [{ id: 8, tenantId: 'polluted', status: 'open', amount: 2 }]);

	Object.defineProperty(Function.prototype, BOUND_CONTEXT, {
		value: pollutedContext,
		configurable: true
	});
	try {
		setDefaultContext(defaultContext);
		await softDelete(ScopedSoftRecord, 8, undefined, { now: () => '2026-05-14T00:00:00.000Z' });
		assert.equal(defaultStore.dump('scoped_soft_record')[0].deletedAt, '2026-05-14T00:00:00.000Z');
		assert.equal(pollutedStore.dump('scoped_soft_record')[0].deletedAt, undefined);
	} finally {
		delete (Function.prototype as any)[BOUND_CONTEXT];
		clearDefaultContext();
	}
});

test('soft delete field options are validated before mutating data', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = ScopedSoftRecord.use(context) as unknown as typeof ScopedSoftRecord;
	await store.seed('scoped_soft_record', [{ id: 11, tenantId: 'a', status: 'open', amount: 1 }]);

	assert.throws(() => createSoftDeletePlugin({ field: '__deletedAt' }), /soft-delete field/);
	assert.throws(() => createSoftDeletePlugin(null as any), /Soft-delete options must be an object/);
	assert.throws(
		() => createSoftDeletePlugin(Object.assign(Object.create({}), { field: 'deletedAt' }) as any),
		/Soft-delete options must be a plain object/
	);
	let getterCalls = 0;
	const accessorOptions = Object.defineProperty({}, 'field', {
		enumerable: true,
		get() {
			getterCalls++;
			return 'deletedAt';
		}
	});
	assert.throws(
		() => createSoftDeletePlugin(accessorOptions as any),
		/Soft-delete options "field" must be a data property/
	);
	assert.equal(getterCalls, 0);
	const hiddenOptions = Object.defineProperty({}, 'field', {
		enumerable: false,
		value: 'deletedAt'
	});
	assert.throws(
		() => createSoftDeletePlugin(hiddenOptions as any),
		/Soft-delete options "field" must be enumerable/
	);
	assert.throws(
		() => createSoftDeletePlugin({ [Symbol('field')]: 'deletedAt' } as any),
		/Soft-delete options cannot contain symbol fields/
	);
	assert.throws(() => createSoftDeletePlugin({ models: 'scoped_soft_record' as any }), /models must be an array/);
	assert.throws(() => createSoftDeletePlugin({ models: ['__bad'] }), /soft-delete model name/);
	let iteratorCalls = 0;
	const iteratorModels = ['scoped_soft_record'] as any[];
	Object.defineProperty(iteratorModels, Symbol.iterator, {
		value() {
			iteratorCalls++;
			throw new Error('custom models iterator should not run');
		}
	});
	assert.throws(
		() => createSoftDeletePlugin({ models: iteratorModels }),
		/Soft-delete models cannot contain symbol fields/
	);
	assert.equal(iteratorCalls, 0);
	assert.throws(
		() => createSoftDeletePlugin({ materializedNulls: 'yes' as any }),
		/materializedNulls must be a boolean/
	);
	await assert.rejects(() => softDelete(Record, 11, undefined, { field: '__deletedAt' }), /soft-delete field/);
	await assert.rejects(() => softDelete(Record, 11, undefined, null as any), /Soft-delete options must be an object/);
	await assert.rejects(
		() => softDelete(Record, 11, undefined, { now: 'soon' as any }),
		/Soft-delete now must be a function/
	);
	await assert.rejects(
		() => softDelete(Record, 11, undefined, { now: (() => ({ unsafe: true })) as any }),
		/soft-delete timestamp must be a string/
	);
	await assert.rejects(
		() => softDelete(Record, 11, undefined, { now: () => 'soon' }),
		/soft-delete timestamp must be a canonical ISO timestamp/
	);
	const hiddenHelperOptions = Object.defineProperty({}, 'now', {
		enumerable: false,
		value: () => '2026-05-14T00:00:00.000Z'
	});
	await assert.rejects(
		() => softDelete(Record, 11, undefined, hiddenHelperOptions as any),
		/Soft-delete options "now" must be enumerable/
	);
	assert.throws(
		() => createSoftDeletePlugin({ fiel: 'deletedAt' } as any),
		/Soft-delete options contains unknown option "fiel"/
	);
	const hiddenUnknownOptions = Object.defineProperty({}, 'fiel', {
		enumerable: false,
		value: 'deletedAt'
	});
	assert.throws(
		() => createSoftDeletePlugin(hiddenUnknownOptions as any),
		/Soft-delete options contains unknown option "fiel"/
	);
	await assert.rejects(
		() => restore(Record, 11, undefined, { materializedNull: true } as any),
		/Soft-delete options contains unknown option "materializedNull"/
	);
	await assert.rejects(() => restore(Record, 11, undefined, [] as any), /Soft-delete options must be an object/);
	assert.equal(store.dump('scoped_soft_record')[0].__deletedAt, undefined);
});

test('soft delete option and model allowlists use captured Set intrinsics', async () => {
	const store = new MemoryStoreAdapter();
	await store.seed('scoped_soft_record', [
		{ id: 12, tenantId: 'a', status: 'open', amount: 1, deletedAt: null },
		{ id: 13, tenantId: 'a', status: 'closed', amount: 1, deletedAt: '2026-05-14T00:00:00.000Z' }
	]);
	const setHas = Set.prototype.has;
	const setAdd = Set.prototype.add;
	Set.prototype.has = function () {
		throw new Error('patched Set.has');
	};
	Set.prototype.add = function () {
		throw new Error('patched Set.add');
	};
	try {
		assert.throws(
			() => createSoftDeletePlugin({ fiel: 'deletedAt' } as any),
			/Soft-delete options contains unknown option "fiel"/
		);
		const context = createActiveTs({
			stores: { default: store },
			plugins: [createSoftDeletePlugin({ models: ['scoped_soft_record'] })]
		});
		const Record = ScopedSoftRecord.use(context) as unknown as typeof ScopedSoftRecord;
		const rows = await Record.query().load();
		assert.deepEqual(rows.list.map((row) => row.data.id), [12]);
	} finally {
		Set.prototype.has = setHas;
		Set.prototype.add = setAdd;
	}
});

test('soft delete timestamp validation ignores patched Date.parse', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({
		stores: { default: store },
		plugins: [createSoftDeletePlugin({ models: ['scoped_soft_record'] })]
	});
	const Record = ScopedSoftRecord.use(context) as unknown as typeof ScopedSoftRecord;
	await Record.create({ id: 14, tenantId: 'a', status: 'open', amount: 10 });

	const originalParse = Date.parse;
	Date.parse = () => {
		throw new Error('patched Date.parse should not run');
	};
	try {
		await softDelete(Record, 14, undefined, { now: () => '2026-05-14T00:00:00.000Z' });
	} finally {
		Date.parse = originalParse;
	}

	assert.equal(store.dump('scoped_soft_record')[0].deletedAt, '2026-05-14T00:00:00.000Z');
});

test('soft delete options ignore inherited fields and callbacks', async () => {
	const pluginStore = new MemoryStoreAdapter();
	Object.defineProperty(Object.prototype, 'field', {
		value: '__deletedAt',
		configurable: true
	});
	try {
		const context = createActiveTs({
			stores: { default: pluginStore },
			plugins: [createSoftDeletePlugin({})]
		});
		const Record = ScopedSoftRecord.use(context) as unknown as typeof ScopedSoftRecord;
		await Record.create({ id: 12, tenantId: 'a', status: 'open', amount: 1 });
	} finally {
		delete (Object.prototype as Record<string, unknown>).field;
	}
	assert.equal(pluginStore.dump('scoped_soft_record')[0].deletedAt, null);
	assert.equal(pluginStore.dump('scoped_soft_record')[0].__deletedAt, undefined);

	const helperStore = new MemoryStoreAdapter();
	const helperContext = createActiveTs({
		stores: { default: helperStore },
		plugins: [createSoftDeletePlugin({ models: ['scoped_soft_record'] })]
	});
	const HelperRecord = ScopedSoftRecord.use(helperContext) as unknown as typeof ScopedSoftRecord;
	await helperStore.seed('scoped_soft_record', [{ id: 13, tenantId: 'a', status: 'open', amount: 1 }]);
	Object.defineProperty(Object.prototype, 'now', {
		value: () => ({ unsafe: true }),
		configurable: true
	});
	try {
		await softDelete(HelperRecord, 13, undefined, {});
	} finally {
		delete (Object.prototype as Record<string, unknown>).now;
	}
	assert.match(String(helperStore.dump('scoped_soft_record')[0].deletedAt), /^\d{4}-\d{2}-\d{2}T/);
});

test('soft delete constraints apply recursively to hook-supplied nested OR branches', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({
		stores: { default: store },
		plugins: [
			{
				name: 'nested-or-policy',
				hooks: {
					beforeQuery(payload) {
						if (payload.model?.name !== 'scoped_soft_record' || !payload.plan) return;
						payload.plan.or = [
							{
								where: [{ field: 'status', op: '=', value: 'missing' }],
								or: [
									{
										where: [{ field: 'status', op: '=', value: 'closed' }],
										or: [],
										sort: [],
										include: []
									}
								],
								sort: [],
								include: []
							}
						];
					}
				}
			},
			createSoftDeletePlugin({ models: ['scoped_soft_record'] })
		]
	});
	const Record = ScopedSoftRecord.use(context) as unknown as typeof ScopedSoftRecord;
	await store.seed('scoped_soft_record', [
		{ id: 1, tenantId: 'a', status: 'open', amount: 10, deletedAt: null },
		{ id: 2, tenantId: 'a', status: 'closed', amount: 20, deletedAt: '2026-05-15T00:00:00.000Z' },
		{ id: 3, tenantId: 'a', status: 'closed', amount: 30, deletedAt: null }
	]);

	const live = await Record.query().load();

	assert.deepEqual(live.list.map((item) => item.data.id), [3]);
});

test('soft delete constraints survive later hook plan replacement', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({
		stores: { default: store },
		plugins: [
			createSoftDeletePlugin({ models: ['scoped_soft_record'] }),
			{
				name: 'replace-plan-after-soft-delete',
				hooks: {
					beforeQuery(payload) {
						if (payload.model?.name !== 'scoped_soft_record') return;
						return {
							plan: {
								where: [],
								or: [],
								sort: [],
								include: []
							}
						};
					},
					beforeAggregate(payload) {
						if (payload.model?.name !== 'scoped_soft_record') return;
						return {
							plan: {
								where: [],
								or: [],
								aggregates: (payload.plan as any).aggregates
							}
						};
					}
				}
			}
		]
	});
	const Record = ScopedSoftRecord.use(context) as unknown as typeof ScopedSoftRecord;
	await store.seed('scoped_soft_record', [
		{ id: 31, tenantId: 'a', status: 'open', amount: 10, deletedAt: null },
		{ id: 32, tenantId: 'a', status: 'closed', amount: 20, deletedAt: '2026-05-15T00:00:00.000Z' }
	]);

	const live = await Record.query().load();
	const count = await Record.count();

	assert.deepEqual(live.list.map((item) => item.data.id), [31]);
	assert.equal(count, 1);
});

test('soft delete final guard honors hook-updated withDeleted mode', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({
		stores: { default: store },
		plugins: [
			createSoftDeletePlugin({ models: ['scoped_soft_record'] }),
			{
				name: 'force-with-deleted',
				hooks: {
					beforeQuery(payload) {
						if (payload.model?.name !== 'scoped_soft_record') return;
						return {
							plan: {
								...(payload.plan as any),
								meta: { softDelete: 'with' }
							}
						};
					},
					beforeAggregate(payload) {
						if (payload.model?.name !== 'scoped_soft_record') return;
						return {
							plan: {
								...(payload.plan as any),
								meta: { softDelete: 'with' }
							}
						};
					}
				}
			}
		]
	});
	const Record = ScopedSoftRecord.use(context) as unknown as typeof ScopedSoftRecord;
	await store.seed('scoped_soft_record', [
		{ id: 51, tenantId: 'a', status: 'open', amount: 10, deletedAt: null },
		{ id: 52, tenantId: 'a', status: 'closed', amount: 20, deletedAt: '2026-05-15T00:00:00.000Z' }
	]);

	const all = await Record.query().orderBy('id').load();
	const count = await Record.count();

	assert.deepEqual(all.list.map((item) => item.data.id), [51, 52]);
	assert.equal(count, 2);
});

test('custom hooks cannot spoof the soft-delete final guard marker', async () => {
	const store = new MemoryStoreAdapter();
	let spoofedHookRuns = 0;
	const spoofedHook = (payload: any) => {
		if (payload.model?.name === 'scoped_soft_record') spoofedHookRuns++;
	};
	Object.defineProperty(spoofedHook, Symbol.for('active-ts.soft-delete.plan-guard'), {
		value: true,
		enumerable: false
	});
	const context = createActiveTs({
		stores: { default: store },
		plugins: [
			{
				name: 'spoofed-final-guard',
				hooks: {
					beforeQuery: spoofedHook
				}
			}
		]
	});
	const Record = ScopedSoftRecord.use(context) as unknown as typeof ScopedSoftRecord;
	await store.seed('scoped_soft_record', [{ id: 41, tenantId: 'a', status: 'open', amount: 10 }]);

	await Record.query().load();

	assert.equal(spoofedHookRuns, 1);
});

test('soft-delete final guard trust ignores polluted WeakSet methods', () => {
	const weakSetHas = Object.getOwnPropertyDescriptor(WeakSet.prototype, 'has')!;
	const weakSetAdd = Object.getOwnPropertyDescriptor(WeakSet.prototype, 'add')!;
	try {
		Object.defineProperty(WeakSet.prototype, 'has', {
			value() {
				return true;
			}
		});
		Object.defineProperty(WeakSet.prototype, 'add', {
			value() {
				throw new Error('patched WeakSet.add should not run');
			}
		});
		const hook = () => undefined;

		assert.equal(isSoftDeletePlanGuardHook('beforeQuery', hook), false);
		assert.equal(isSoftDeletePlanGuardHook('beforeAggregate', hook), false);
	} finally {
		Object.defineProperty(WeakSet.prototype, 'has', weakSetHas);
		Object.defineProperty(WeakSet.prototype, 'add', weakSetAdd);
	}
});
