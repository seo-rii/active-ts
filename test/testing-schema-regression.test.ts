import test from 'node:test';
import assert from 'node:assert/strict';
import {
	MemoryStoreAdapter,
	MemoryCacheAdapter,
	MemorySearchAdapter,
	Model,
	type QueryResult,
	type ResolvedModelMeta,
	type SchemaPlan,
	type SearchAdapter,
	type SearchOptions,
	type StoreAdapter,
	ActiveTsConfigurationError,
	applyModelMeta,
	createActiveTs,
	datastoreKey,
	defineModel,
	getCurrentDefaultContext
} from '../src/index.js';
import { createAlgoliaSearchAdapter } from '../src/adapters/search/algolia.js';
import { createElasticsearchSearchAdapter } from '../src/adapters/search/elasticsearch.js';
import {
	captureLazyLoadWarnings,
	createAdapterContractSuite,
	createCacheAdapterContractSuite,
	createIntegrationHarness,
	createSearchAdapterContractSuite,
	createTestContext,
	resetTestContext,
	runSearchAdapterContract,
	runStoreAdapterContract,
	withTestContext
} from '../src/testing/index.js';
import { normalizeSchemaModels, normalizeSchemaPlan } from '../src/core/schema-utils.js';
import { normalizeStoreSchemaApplyOptions } from '../src/core/schema-options.js';

type TestingSeedData = {
	slug: string;
	title: string;
};

type TestingDatastoreSchemaData = TestingSeedData & {
	parentId: number;
};

class TestingSeedRecord extends Model<TestingSeedData> {}
class MixedSearchSchemaRecord extends Model<TestingSeedData> {}
class MissingSearchSchemaRecord extends Model<TestingSeedData> {}
class PlannerSearchSchemaRecord extends Model<TestingSeedData> {}
class RouteDependentSearchSchemaRecord extends Model<TestingSeedData> {}
class PhysicalAliasSearchSchemaRecord extends Model<TestingSeedData> {}
class NonUniqueSchemaRecord extends Model<TestingSeedData> {}
class DirectionalManualSchemaRecord extends Model<TestingSeedData> {}
class ManualDatastoreSchemaRecord extends Model<TestingDatastoreSchemaData> {}
class UnsafeDatastoreManualSchemaRecord extends Model<TestingSeedData> {}
class PrimarySchemaRouteRecord extends Model<TestingSeedData> {}
class ArchiveSchemaRouteRecord extends Model<TestingSeedData> {}
class UniqueSchemaRecord extends Model<TestingSeedData> {}

defineModel<TestingSeedData>('testing_seed_record')
	.id('slug')
	.validate((input) => input as TestingSeedData)
	.search('search-schema', ['title'])
	.attach(TestingSeedRecord);

defineModel<TestingSeedData>({ name: 'mixed_search_schema_record', search: 'default-search-schema' })
	.id('slug')
	.validate((input) => input as TestingSeedData)
	.attach(MixedSearchSchemaRecord);

defineModel<TestingSeedData>({ name: 'missing_search_schema_record', search: 'missing-search-schema' })
	.id('slug')
	.validate((input) => input as TestingSeedData)
	.search('missing-search-schema', ['title'])
	.attach(MissingSearchSchemaRecord);

defineModel<TestingSeedData>('planner_search_schema_record')
	.id('slug')
	.validate((input) => input as TestingSeedData)
	.attach(PlannerSearchSchemaRecord);

defineModel<TestingSeedData>('route_dependent_search_schema_record')
	.id('slug')
	.validate((input) => input as TestingSeedData)
	.attach(RouteDependentSearchSchemaRecord);

defineModel<TestingSeedData>('physical_alias_search_schema_record')
	.id('slug')
	.validate((input) => input as TestingSeedData)
	.search('algolia', ['title'], { name: 'physical_alias_title' })
	.attach(PhysicalAliasSearchSchemaRecord);

defineModel<TestingSeedData>('non_unique_schema_record')
	.id('slug')
	.validate((input) => input as TestingSeedData)
	.index('title', { name: 'title_idx' })
	.attach(NonUniqueSchemaRecord);

defineModel<TestingSeedData>('directional_manual_schema_record')
	.id('slug')
	.validate((input) => input as TestingSeedData)
	.index('title', { name: 'title_desc_idx', directions: ['desc'] })
	.attach(DirectionalManualSchemaRecord);

defineModel<TestingDatastoreSchemaData>('manual_datastore_schema_record')
	.id('slug')
	.validate((input) => input as TestingDatastoreSchemaData)
	.index('parent_title', { name: 'parent_title_idx', fields: ['parentId', 'title'] })
	.datastore({
		ancestor: ({ data }) =>
			data === undefined ? undefined : datastoreKey('manual_schema_parent', data.parentId),
		ancestorFields: ['parentId']
	})
	.attach(ManualDatastoreSchemaRecord);

defineModel<TestingSeedData>('unsafe_datastore_manual_schema_record')
	.id('slug')
	.validate((input) => input as TestingSeedData)
	.index('profile/name', { name: 'unsafe_path_idx' })
	.attach(UnsafeDatastoreManualSchemaRecord);

defineModel<TestingSeedData>({ name: 'primary_schema_route_record', store: 'primary' })
	.id('slug')
	.validate((input) => input as TestingSeedData)
	.attach(PrimarySchemaRouteRecord);

defineModel<TestingSeedData>({ name: 'archive_schema_route_record', store: 'archive' })
	.id('slug')
	.validate((input) => input as TestingSeedData)
	.attach(ArchiveSchemaRouteRecord);

defineModel<TestingSeedData>('unique_schema_record')
	.id('slug')
	.validate((input) => input as TestingSeedData)
	.index('title', { name: 'unique_title', unique: true })
	.attach(UniqueSchemaRecord);

applyModelMeta(MixedSearchSchemaRecord, {
	searchIndexes: [
		{ name: 'default_title', fields: ['title'] },
		{ name: 'elastic_title', adapter: 'elastic-search-schema', fields: ['title'] }
	]
});

applyModelMeta(PlannerSearchSchemaRecord, {
	searchIndexes: [{ name: 'planner_title', fields: ['title'] }]
});

applyModelMeta(RouteDependentSearchSchemaRecord, {
	searchIndexes: [{ name: 'route_dependent_title', fields: ['title'] }]
});

class LegacySeedStore extends MemoryStoreAdapter {
	seenModelName?: string;
	override seedModel = undefined as any;

	override async seed(modelName: string, rows: any[]) {
		this.seenModelName = modelName;
		await super.seed(modelName, rows.map((row) => ({ ...row, id: row.slug })));
	}
}

class CreateOnlyStore extends MemoryStoreAdapter {
	override seed = undefined as any;
	override seedModel = undefined as any;

	override async update(): Promise<void> {
		throw new Error('update fallback should not be used for test seeding');
	}
}

class SeedModelSpyStore extends MemoryStoreAdapter {
	calls = 0;

	override async seedModel() {
		this.calls++;
	}
}

class MutatingSeedModelStore extends MemoryStoreAdapter {
	override async seedModel(meta: ResolvedModelMeta, rows: any[]) {
		await super.seedModel(meta, rows);
		rows[0].title = 'Mutated by helper';
	}
}

class MutatingContractCapabilityStore extends MemoryStoreAdapter {
	override readonly capabilities = { ...new MemoryStoreAdapter().capabilities };
	selectedQuerySeen = false;

	override async query(...args: Parameters<MemoryStoreAdapter['query']>) {
		const plan = args[1];
		if (plan.select?.includes('name')) {
			this.selectedQuerySeen = true;
			this.capabilities.select = true;
		} else {
			this.capabilities.select = false;
		}
		return await super.query(...args);
	}
}

class UnsupportedUniqueSchemaStore extends MemoryStoreAdapter {
	override readonly capabilities = { ...new MemoryStoreAdapter().capabilities, uniqueIndex: false };

	override schema = {
		plan: async (models: ResolvedModelMeta[]): Promise<SchemaPlan> => {
			const safeModels = normalizeSchemaModels(models, 'unsupported unique schema models');
			return {
				adapter: 'unsupported-unique-schema',
				changes: safeModels.flatMap((model) =>
					model.indexes.map((index) => ({
						type: 'create-index' as const,
						target: model.name,
						name: index.name,
						fields: index.fields,
						unique: index.unique
					}))
				)
			};
		},
		apply: async (models: ResolvedModelMeta[]): Promise<SchemaPlan> => this.schema.plan(models)
	};
}

class SilentUniqueSchemaStore extends MemoryStoreAdapter {
	override readonly capabilities = { ...new MemoryStoreAdapter().capabilities, uniqueIndex: false };
	readonly calls = { plan: 0, apply: 0 };

	override schema = {
		plan: async (models: ResolvedModelMeta[]): Promise<SchemaPlan> => {
			this.calls.plan++;
			normalizeSchemaModels(models, 'silent unique schema models');
			return { adapter: 'silent-unique-schema', changes: [] };
		},
		apply: async (models: ResolvedModelMeta[]): Promise<SchemaPlan> => {
			this.calls.apply++;
			normalizeSchemaModels(models, 'silent unique schema models');
			return { adapter: 'silent-unique-schema', changes: [] };
		}
	};
}

class NoSchemaHookStore extends MemoryStoreAdapter {
	override schema = undefined as any;
}

class DatastoreNoSchemaHookStore extends NoSchemaHookStore {
	override readonly capabilities = { ...new MemoryStoreAdapter().capabilities, datastoreAncestor: true };
}

class DuplicateSchemaChangeStore extends MemoryStoreAdapter {
	override schema = {
		plan: async (): Promise<SchemaPlan> => this.duplicatePlan(),
		apply: async (): Promise<SchemaPlan> => this.duplicatePlan()
	};

	private duplicatePlan(): SchemaPlan {
		return {
			adapter: 'duplicate-schema-change-store',
			changes: [
				{
					type: 'create-index',
					target: 'non_unique_schema_record',
					name: 'title_idx',
					fields: ['title']
				},
				{
					type: 'create-index',
					target: 'non_unique_schema_record',
					name: 'title_idx',
					fields: ['slug']
				}
			]
		};
	}
}

class SchemaSearchAdapter implements SearchAdapter {
	readonly capabilities = { where: false, cursor: false, native: false, index: true };
	seenModels: string[] = [];
	seenIndexes: Record<string, string[]> = {};
	calls = { plan: 0, apply: 0, sync: 0 };

	constructor(readonly kind = 'search-schema') {}

	async search(_model: ResolvedModelMeta, _query: string, _options: SearchOptions): Promise<QueryResult> {
		return { list: [], more: false, count: 0 };
	}

	async index() {}
	async delete() {}

	schema = {
		plan: async (models: ResolvedModelMeta[]): Promise<SchemaPlan> => this.schemaPlan(models, 'plan'),
		apply: async (models: ResolvedModelMeta[]): Promise<SchemaPlan> => this.schemaPlan(models, 'apply')
	};

	async syncSchema(models: ResolvedModelMeta[]): Promise<SchemaPlan> {
		return this.schemaPlan(models, 'sync');
	}

	private async schemaPlan(models: ResolvedModelMeta[], operation: keyof SchemaSearchAdapter['calls']): Promise<SchemaPlan> {
		this.calls[operation]++;
		this.seenModels = models.map((model) => model.name);
		this.seenIndexes = Object.fromEntries(
			models.map((model) => [model.name, model.searchIndexes.map((index) => index.name)])
		);
		return {
			adapter: this.kind,
			changes: models.flatMap((model) =>
				model.searchIndexes.map((index) => ({
					type: 'create-search-index' as const,
					target: model.name,
					name: index.name,
					fields: index.fields
				}))
			)
		};
	}
}

test('test context preserves legacy string seed helpers', async () => {
	const store = new LegacySeedStore();
	const ctx = createTestContext({ store });

	await ctx.seed(TestingSeedRecord, [{ slug: 'legacy', title: 'Legacy' }]);

	assert.equal(store.seenModelName, 'testing_seed_record');
	assert.deepEqual(store.dump('testing_seed_record'), [{ slug: 'legacy', title: 'Legacy', id: 'legacy' }]);
});

test('test context seed snapshots row arrays before adapter helpers', async () => {
	const store = new LegacySeedStore();
	const ctx = createTestContext({ store });
	let mapCalls = 0;
	const rows = [{ slug: 'array-method', title: 'Array Method' }] as any[];
	Object.defineProperty(rows, 'map', {
		value() {
			mapCalls++;
			throw new Error('custom map should not run');
		}
	});

	await ctx.seed(TestingSeedRecord, rows);

	assert.equal(mapCalls, 0);
	assert.deepEqual(store.dump('testing_seed_record'), [
		{ slug: 'array-method', title: 'Array Method', id: 'array-method' }
	]);

	let iteratorCalls = 0;
	const iteratorRows = [{ slug: 'iterator', title: 'Iterator' }] as any[];
	Object.defineProperty(iteratorRows, Symbol.iterator, {
		value() {
			iteratorCalls++;
			throw new Error('custom iterator should not run');
		}
	});
	await assert.rejects(
		() => createTestContext({ store: new CreateOnlyStore() }).seed(TestingSeedRecord, iteratorRows),
		/ActiveTestContext\.seed\(\) rows cannot contain symbol fields/
	);
	assert.equal(iteratorCalls, 0);
});

test('test context seed validates and clones row objects before adapter helpers', async () => {
	const store = new LegacySeedStore();
	const ctx = createTestContext({ store });
	let getterCalls = 0;
	const accessorRow = Object.defineProperty({}, 'slug', {
		enumerable: true,
		get() {
			getterCalls++;
			return 'accessor';
		}
	});

	await assert.rejects(
		() => ctx.seed(TestingSeedRecord, [accessorRow as TestingSeedData]),
		/Unsupported data accessor.*slug/
	);
	assert.equal(getterCalls, 0);
	assert.deepEqual(store.dump('testing_seed_record'), []);

	const row = { slug: 'cloned', title: 'Original' };
	const [seeded] = await ctx.seed(TestingSeedRecord, [row]);
	seeded.title = 'Mutated return';
	row.title = 'Mutated input';

	assert.deepEqual(store.dump('testing_seed_record'), [{ slug: 'cloned', title: 'Original', id: 'cloned' }]);
});

test('test context seed helper mutations do not rewrite returned fixtures', async () => {
	const store = new MutatingSeedModelStore();
	const ctx = createTestContext({ store });

	const [seeded] = await ctx.seed(TestingSeedRecord, [{ slug: 'helper-mutation', title: 'Original' }]);

	assert.deepEqual(seeded, { slug: 'helper-mutation', title: 'Original' });
	assert.deepEqual(store.dump('testing_seed_record'), [{ slug: 'helper-mutation', title: 'Original' }]);
});

test('test context seed validates ids before adapter helpers', async () => {
	const store = new SeedModelSpyStore();
	const ctx = createTestContext({ store });

	await assert.rejects(
		() => ctx.seed(TestingSeedRecord, [{ title: 'Missing slug' } as any]),
		/ActiveTestContext\.seed\(\) testing_seed_record\.slug/
	);
	assert.equal(store.calls, 0);
});

test('test context seed fallback uses create instead of update-as-upsert', async () => {
	const store = new CreateOnlyStore();
	const ctx = createTestContext({ store });

	await ctx.seed(TestingSeedRecord, [{ slug: 'created', title: 'Created' }]);

	assert.deepEqual(store.dump('testing_seed_record'), [{ slug: 'created', title: 'Created' }]);
});

test('test context seed fallback ignores inherited id fields', async () => {
	const store = new CreateOnlyStore();
	const ctx = createTestContext({ store });
	Object.defineProperty(Object.prototype, 'slug', {
		value: 'polluted-slug',
		configurable: true
	});
	try {
		await assert.rejects(
			() => ctx.seed(TestingSeedRecord, [{ title: 'Missing slug' } as any]),
			/ActiveTestContext\.seed\(\) testing_seed_record\.slug/
		);
		assert.deepEqual(store.dump('testing_seed_record'), []);
	} finally {
		delete (Object.prototype as Record<string, unknown>).slug;
	}
});

test('test context ignores inherited testing helper methods', async () => {
	const rows: unknown[] = [];
	const store: StoreAdapter = {
		kind: 'minimal-testing-store',
		capabilities: {},
		get: async () => null,
		getMany: async (_model, ids) => ids.map(() => null),
		query: async () => ({ list: [], more: false, count: 0 }),
		create: async (_model, _id, data) => {
			rows.push(data);
		},
		update: async () => undefined,
		delete: async () => undefined
	};
	const ctx = createTestContext({ store });
	Object.defineProperties(Object.prototype, {
		seedModel: { value: () => { throw new Error('polluted seedModel should not run'); }, configurable: true },
		seed: { value: () => { throw new Error('polluted seed should not run'); }, configurable: true },
		reset: { value: () => { throw new Error('polluted reset should not run'); }, configurable: true },
		snapshot: { value: () => ['polluted'], configurable: true },
		stats: { value: { polluted: true }, configurable: true },
		clear: { value: () => { throw new Error('polluted clear should not run'); }, configurable: true }
	});
	try {
		await ctx.seed(TestingSeedRecord, [{ slug: 'created', title: 'Created' }]);
		await ctx.reset();
		assert.deepEqual(rows, [{ slug: 'created', title: 'Created' }]);
		assert.equal(ctx.snapshotStore(), undefined);
		assert.equal(ctx.stats().store, undefined);
	} finally {
		delete (Object.prototype as Record<string, unknown>).seedModel;
		delete (Object.prototype as Record<string, unknown>).seed;
		delete (Object.prototype as Record<string, unknown>).reset;
		delete (Object.prototype as Record<string, unknown>).snapshot;
		delete (Object.prototype as Record<string, unknown>).stats;
		delete (Object.prototype as Record<string, unknown>).clear;
	}
});

test('test context rejects hidden own testing helper members', async () => {
	const seedStore = new MemoryStoreAdapter() as StoreAdapter & {
		seedModel?: (meta: ResolvedModelMeta, rows: unknown[]) => Promise<void>;
	};
	Object.defineProperty(seedStore, 'seedModel', {
		enumerable: false,
		value: async () => {
			throw new Error('hidden seedModel should not run');
		}
	});
	await assert.rejects(
		() => createTestContext({ store: seedStore }).seed(TestingSeedRecord, [{ slug: 'hidden-seed', title: 'Hidden' }]),
		/Testing adapter property "seedModel" must be enumerable/
	);

	const statsStore = new MemoryStoreAdapter() as StoreAdapter & { stats?: unknown };
	Object.defineProperty(statsStore, 'stats', {
		enumerable: false,
		value: { reads: 1 }
	});
	assert.throws(
		() => createTestContext({ store: statsStore }).stats(),
		/Testing adapter property "stats" must be enumerable/
	);
});

test('test context rejects non-function own testing helper members', async () => {
	const seedStore = new MemoryStoreAdapter() as StoreAdapter & { seedModel?: unknown };
	seedStore.seedModel = false;
	await assert.rejects(
		() => createTestContext({ store: seedStore }).seed(TestingSeedRecord, [{ slug: 'bad-seed-helper', title: 'Bad' }]),
		/Testing adapter property "seedModel" must be a function/
	);

	const resetStore = new MemoryStoreAdapter() as StoreAdapter & { reset?: unknown };
	resetStore.reset = 'not-a-function';
	assert.throws(
		() => createTestContext({ store: resetStore }).reset(),
		/Testing adapter property "reset" must be a function/
	);

	const snapshotStore = new MemoryStoreAdapter() as StoreAdapter & { snapshot?: unknown };
	snapshotStore.snapshot = 1;
	assert.throws(
		() => createTestContext({ store: snapshotStore }).snapshotStore(),
		/Testing adapter property "snapshot" must be a function/
	);
});

test('test context stats snapshots and validates adapter stat objects', () => {
	const store = new MemoryStoreAdapter();
	const ctx = createTestContext({ store });
	const stats = ctx.stats();
	assert.equal(stats.store?.get, 0);
	(stats.store as any).get = 99;
	assert.equal(store.stats.get, 0);
	store.stats.get = 7;
	assert.equal((stats.store as any).get, 99);

	let getterCalls = 0;
	const unsafeStats = Object.defineProperty({}, 'reads', {
		enumerable: true,
		get() {
			getterCalls++;
			return 1;
		}
	});
	const unsafeStore = new MemoryStoreAdapter() as unknown as StoreAdapter & { stats: unknown };
	Object.defineProperty(unsafeStore, 'stats', {
		enumerable: true,
		configurable: true,
		value: unsafeStats
	});
	assert.throws(
		() => createTestContext({ store: unsafeStore }).stats(),
		/Unsupported data accessor.*reads/
	);
	assert.equal(getterCalls, 0);
});

test('test context snapshots clone and validate adapter snapshot outputs', () => {
	const liveStoreSnapshot = { records: [{ slug: 'live-store', title: 'Live Store' }] };
	const store = new MemoryStoreAdapter() as MemoryStoreAdapter & { snapshot?: (modelName?: string) => unknown };
	Object.defineProperty(store, 'snapshot', {
		enumerable: true,
		configurable: true,
		value: () => liveStoreSnapshot
	});
	const liveCacheSnapshot = { key: { value: 'cached', expires: undefined } };
	const cache = new MemoryCacheAdapter() as MemoryCacheAdapter & { snapshot?: () => unknown };
	Object.defineProperty(cache, 'snapshot', {
		enumerable: true,
		configurable: true,
		value: () => liveCacheSnapshot
	});
	const liveSearchSnapshot = [{ slug: 'live-search', title: 'Live Search' }];
	const search = new MemorySearchAdapter() as MemorySearchAdapter & { snapshot?: () => unknown };
	Object.defineProperty(search, 'snapshot', {
		enumerable: true,
		configurable: true,
		value: () => liveSearchSnapshot
	});
	const ctx = createTestContext({ store, cache, search });

	const storeSnapshot = ctx.snapshotStore() as typeof liveStoreSnapshot;
	storeSnapshot.records[0].title = 'Mutated Store';
	assert.equal(liveStoreSnapshot.records[0].title, 'Live Store');

	const fullSnapshot = ctx.snapshot();
	(fullSnapshot.cache as typeof liveCacheSnapshot).key.value = 'mutated-cache';
	(fullSnapshot.search as typeof liveSearchSnapshot)[0].title = 'Mutated Search';
	assert.equal(liveCacheSnapshot.key.value, 'cached');
	assert.equal(liveSearchSnapshot[0].title, 'Live Search');

	let getterCalls = 0;
	const unsafeSnapshot = Object.defineProperty({}, 'records', {
		enumerable: true,
		get() {
			getterCalls++;
			return [];
		}
	});
	Object.defineProperty(store, 'snapshot', {
		enumerable: true,
		configurable: true,
		value: () => unsafeSnapshot
	});
	assert.throws(
		() => ctx.snapshotStore(),
		/Testing store snapshot is not safe data: Unsupported data accessor.*records/
	);
	assert.equal(getterCalls, 0);
});

test('model-scoped test context reset clears stale cache entries', async () => {
	const ctx = createTestContext();
	const Record = TestingSeedRecord.use(ctx.context) as unknown as typeof TestingSeedRecord;

	await ctx.seed(Record, [{ slug: 'cached', title: 'Old' }]);
	assert.equal((await Record.find('cached').load())?.data.title, 'Old');

	await ctx.reset(Record);
	await ctx.seed(Record, [{ slug: 'cached', title: 'New' }]);

	assert.equal((await Record.find('cached').load())?.data.title, 'New');
});

test('test context reset awaits async adapter cleanup helpers', async () => {
	const store = new MemoryStoreAdapter() as MemoryStoreAdapter & { reset?: (modelName?: string) => Promise<void> };
	const cache = new MemoryCacheAdapter() as MemoryCacheAdapter & { clear?: () => Promise<void> };
	const search = new MemorySearchAdapter() as MemorySearchAdapter & { clear?: (modelName?: string) => Promise<void> };
	const events: string[] = [];
	Object.defineProperty(store, 'reset', {
		enumerable: true,
		configurable: true,
		value: async (modelName?: string) => {
			events.push(`store-start:${modelName ?? '*'}`);
			await new Promise((resolve) => setTimeout(resolve, 0));
			events.push(`store-end:${modelName ?? '*'}`);
		}
	});
	Object.defineProperty(cache, 'clear', {
		enumerable: true,
		configurable: true,
		value: async () => {
			events.push('cache-start');
			await new Promise((resolve) => setTimeout(resolve, 0));
			events.push('cache-end');
		}
	});
	Object.defineProperty(search, 'clear', {
		enumerable: true,
		configurable: true,
		value: async (modelName?: string) => {
			events.push(`search-start:${modelName ?? '*'}`);
			await new Promise((resolve) => setTimeout(resolve, 0));
			events.push(`search-end:${modelName ?? '*'}`);
		}
	});
	const ctx = createTestContext({ store, cache, search });

	const reset = ctx.reset(TestingSeedRecord);
	assert.deepEqual(events, ['store-start:testing_seed_record', 'cache-start', 'search-start:testing_seed_record']);
	await reset;
	assert.deepEqual(events.sort(), [
		'cache-end',
		'cache-start',
		'search-end:testing_seed_record',
		'search-start:testing_seed_record',
		'store-end:testing_seed_record',
		'store-start:testing_seed_record'
	]);
});

test('resetTestContext propagates async cleanup failures', async () => {
	const store = new MemoryStoreAdapter() as MemoryStoreAdapter & { reset?: () => Promise<void> };
	Object.defineProperty(store, 'reset', {
		enumerable: true,
		configurable: true,
		value: async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
			throw new Error('async reset failed');
		}
	});
	const ctx = createTestContext({ store });

	await withTestContext(ctx, async () => {
		await assert.rejects(() => resetTestContext(), /async reset failed/);
	});
});

test('integration harness stops resources when context creation fails', async () => {
	const events: string[] = [];
	const harness = createIntegrationHarness({
		name: 'failing-harness',
		start: () => {
			events.push('start');
			return { id: 1 };
		},
		stop: () => {
			events.push('stop');
		},
		createStore: async () => {
			events.push('store');
			throw new Error('store unavailable');
		}
	});

	await assert.rejects(() => harness.createContext(), /store unavailable/);
	assert.deepEqual(events, ['start', 'store', 'stop']);
});

test('integration harness stops resources when startup fails', async () => {
	const events: string[] = [];
	const harness = createIntegrationHarness({
		name: 'startup-failing-harness',
		start: async () => {
			events.push('start');
			throw new Error('start unavailable');
		},
		stop: async () => {
			events.push('stop');
		},
		createStore: async () => {
			events.push('store');
			return new MemoryStoreAdapter();
		}
	});

	await assert.rejects(() => harness.createContext(), /start unavailable/);
	assert.deepEqual(events, ['start', 'stop']);
});

test('integration harness preserves omitted cache and search adapters', async () => {
	const harness = createIntegrationHarness({
		name: 'store-only-harness',
		createStore: async () => new MemoryStoreAdapter()
	});

	const handle = await harness.createContext();
	try {
		assert.equal(handle.context.cache, undefined);
		assert.equal(handle.context.search, undefined);
		assert.equal(handle.context.context.cache('default'), undefined);
		assert.throws(
			() => handle.context.context.searchAdapter('default'),
			/Search adapter "default" is not registered/
		);
	} finally {
		await handle.close();
	}
});

test('integration harness rejects factory results that would silently fall back', async () => {
	const events: string[] = [];
	const missingStoreHarness = createIntegrationHarness({
		name: 'missing-store-harness',
		start: () => {
			events.push('start');
			return {};
		},
		stop: () => {
			events.push('stop');
		},
		createStore: async () => undefined as any
	});
	await assert.rejects(
		() => missingStoreHarness.createContext(),
		/Integration harness "missing-store-harness" createStore\(\) must return a store adapter/
	);
	assert.deepEqual(events, ['start', 'stop']);

	const falseCacheHarness = createIntegrationHarness({
		name: 'false-cache-harness',
		createStore: async () => new MemoryStoreAdapter(),
		createCache: async () => false as any
	});
	await assert.rejects(
		() => falseCacheHarness.createContext(),
		/Integration harness "false-cache-harness" createCache\(\) must return an adapter or undefined/
	);

	const falseSearchHarness = createIntegrationHarness({
		name: 'false-search-harness',
		createStore: async () => new MemoryStoreAdapter(),
		createSearch: async () => false as any
	});
	await assert.rejects(
		() => falseSearchHarness.createContext(),
		/Integration harness "false-search-harness" createSearch\(\) must return an adapter or undefined/
	);
});

test('integration harness rejects null optional adapters without default fallback', async () => {
	const nullCacheHarness = createIntegrationHarness({
		name: 'null-cache-harness',
		createStore: async () => new MemoryStoreAdapter(),
		createCache: async () => null as any
	});
	await assert.rejects(
		() => nullCacheHarness.createContext(),
		/Integration harness "null-cache-harness" createCache\(\) must return an adapter or undefined/
	);

	const nullSearchHarness = createIntegrationHarness({
		name: 'null-search-harness',
		createStore: async () => new MemoryStoreAdapter(),
		createSearch: async () => null as any
	});
	await assert.rejects(
		() => nullSearchHarness.createContext(),
		/Integration harness "null-search-harness" createSearch\(\) must return an adapter or undefined/
	);
});

test('integration harness preserves setup and cleanup failures', async () => {
	const harness = createIntegrationHarness({
		name: 'cleanup-failing-harness',
		start: () => ({ id: 1 }),
		stop: () => {
			throw new Error('stop unavailable');
		},
		createStore: async () => {
			throw new Error('store unavailable');
		}
	});

	await assert.rejects(
		() => harness.createContext(),
		(error: unknown) => {
			assert.ok(error instanceof AggregateError);
			assert.match(error.message, /cleanup-failing-harness/);
			assert.deepEqual(
				error.errors.map((item: Error) => item.message),
				['store unavailable', 'stop unavailable']
			);
			return true;
		}
	);
});

test('integration harness runStoreContract preserves contract and cleanup failures', async () => {
	const harness = createIntegrationHarness({
		name: 'contract-cleanup-failing-harness',
		start: () => ({ id: 1 }),
		stop: () => {
			throw new Error('stop unavailable');
		},
		createStore: async () => {
			throw new Error('store unavailable');
		}
	});

	await assert.rejects(
		() => harness.runStoreContract(),
		(error: unknown) => {
			assert.ok(error instanceof AggregateError);
			assert.match(error.message, /contract-cleanup-failing-harness/);
			assert.deepEqual(
				error.errors.map((item: Error) => item.message),
				['store unavailable', 'stop unavailable']
			);
			return true;
		}
	);
});

test('integration harness validates store contract options before starting resources', async () => {
	let starts = 0;
	const harness = createIntegrationHarness({
		name: 'store-options-harness',
		start: () => {
			starts++;
			return {};
		},
		createStore: async () => new MemoryStoreAdapter()
	});

	await assert.rejects(
		() => harness.runStoreContract({ nativeProbe: true } as any),
		/Store adapter contract options\.nativeProbe must be a function/
	);
	assert.equal(starts, 0);
});

test('integration harness withContext preserves callback and cleanup failures', async () => {
	const harness = createIntegrationHarness({
		name: 'with-context-cleanup-failing-harness',
		start: () => ({ id: 1 }),
		stop: () => {
			throw new Error('stop unavailable');
		},
		createStore: async () => new MemoryStoreAdapter()
	});

	await assert.rejects(
		() =>
			harness.withContext(async () => {
				throw new Error('callback failed');
			}),
		(error: unknown) => {
			assert.ok(error instanceof AggregateError);
			assert.match(error.message, /with-context-cleanup-failing-harness/);
			assert.deepEqual(
				error.errors.map((item: Error) => item.message),
				['callback failed', 'stop unavailable']
			);
			return true;
		}
	);
});

test('integration harness withContext validates callback before starting resources', async () => {
	const events: string[] = [];
	const harness = createIntegrationHarness({
		name: 'with-context-invalid-callback-harness',
		start: () => {
			events.push('start');
			return {};
		},
		createStore: async () => {
			events.push('store');
			return new MemoryStoreAdapter();
		},
		stop: () => {
			events.push('stop');
		}
	});

	await assert.rejects(
		() => harness.withContext(undefined as any),
		/withTestContext fn must be a function/
	);
	assert.deepEqual(events, []);
});

test('integration harness withContext validates options before starting resources', async () => {
	const events: string[] = [];
	const harness = createIntegrationHarness({
		name: 'with-context-invalid-options-harness',
		start: () => {
			events.push('start');
			return {};
		},
		createStore: async () => {
			events.push('store');
			return new MemoryStoreAdapter();
		},
		stop: () => {
			events.push('stop');
		}
	});

	await assert.rejects(
		() => harness.withContext(async () => undefined, { install: 'yes' as any }),
		/options.install must be a boolean/
	);
	assert.deepEqual(events, []);
});

test('integration harness withContext can avoid global context installation', async () => {
	const harness = createIntegrationHarness({
		name: 'parallel-no-install-harness',
		createStore: async () => new MemoryStoreAdapter()
	});

	const [first, second] = await Promise.all([
		harness.withContext(async (ctx) => {
			assert.notEqual(currentDefaultContextOrUndefined(), ctx.context);
			return ctx.store.kind;
		}, { install: false }),
		harness.withContext(async (ctx) => {
			assert.notEqual(currentDefaultContextOrUndefined(), ctx.context);
			return ctx.store.kind;
		}, { install: false })
	]);

	assert.deepEqual([first, second], ['memory', 'memory']);
});

test('integration harness context cleanup can be retried after a stop failure', async () => {
	let stopCalls = 0;
	const harness = createIntegrationHarness({
		name: 'retry-cleanup-harness',
		start: () => ({ id: 1 }),
		stop: () => {
			stopCalls++;
			if (stopCalls === 1) throw new Error('temporary stop failure');
		},
		createStore: async () => new MemoryStoreAdapter()
	});

	const handle = await harness.createContext();
	await assert.rejects(() => handle.close(), /temporary stop failure/);
	assert.equal(stopCalls, 1);
	await handle.close();
	assert.equal(stopCalls, 2);
	await handle.close();
	assert.equal(stopCalls, 2);
});

test('test helper APIs reject malformed runtime inputs clearly', async () => {
	assert.throws(
		() => createTestContext(null as any),
		(error: unknown) =>
			error instanceof ActiveTsConfigurationError &&
			/Test context options must be an object/.test(error.message)
	);
	assert.throws(
		() => createTestContext({ lazyLoadWarnings: 'silent' as any }),
		/lazyLoadWarnings/
	);
	assert.throws(
		() => createTestContext({ store: null as any }),
		/Test context store cannot be null/
	);
	assert.throws(
		() => createTestContext({ cache: null as any }),
		/Test context cache cannot be null/
	);
	assert.throws(
		() => createTestContext({ search: null as any }),
		/Test context search cannot be null/
	);
	let presetCoercions = 0;
	const hostilePreset = {
		toString() {
			presetCoercions++;
			throw new Error('test preset coercion should not run');
		}
	};
	assert.throws(
		() => createTestContext({ preset: hostilePreset as any }),
		/Unknown test preset/
	);
	assert.equal(presetCoercions, 0);
	assert.throws(
		() => createTestContext({ config: null as any }),
		/Test context config must be an object/
	);
	assert.throws(
		() => createTestContext({ config: [] as any }),
		/Test context config must be an object/
	);
	assert.throws(
		() => createTestContext({ config: { stores: { other: new MemoryStoreAdapter() } } as any }),
		/Test context config cannot include adapter registry "stores"/
	);
	assert.throws(
		() => createTestContext({ config: { caches: { other: new MemoryCacheAdapter() } } as any }),
		/Test context config cannot include adapter registry "caches"/
	);
	assert.throws(
		() => createTestContext({ config: { search: { other: new MemorySearchAdapter() } } as any }),
		/Test context config cannot include adapter registry "search"/
	);
	let optionReads = 0;
	const accessorTestOptions = Object.defineProperty({}, 'store', {
		enumerable: true,
		get() {
			optionReads++;
			return new MemoryStoreAdapter();
		}
	});
	assert.throws(
		() => createTestContext(accessorTestOptions as any),
		/Test context options\.store must be a data property/
	);
	assert.equal(optionReads, 0);

	const ctx = createTestContext();
	await assert.rejects(
		() => withTestContext({} as any, async () => undefined),
		/ActiveTestContext/
	);
	await assert.rejects(
		() => withTestContext(ctx, undefined as any),
		/withTestContext fn must be a function/
	);
	await assert.rejects(
		() => withTestContext(ctx, async () => undefined, { install: 'yes' as any }),
		/options.install must be a boolean/
	);
	const accessorWithOptions = Object.defineProperty({}, 'install', {
		enumerable: true,
		get() {
			optionReads++;
			return false;
		}
	});
	await assert.rejects(
		() => withTestContext(ctx, async () => undefined, accessorWithOptions as any),
		/withTestContext options\.install must be a data property/
	);
	assert.equal(optionReads, 0);
	await assert.rejects(
		() => ctx.seed(TestingSeedRecord, undefined as any),
		/rows must be an array/
	);
	await assert.rejects(
		() => ctx.seed(TestingSeedRecord, new Array(1) as any),
		/ActiveTestContext\.seed\(\) rows\[0\] is missing/
	);

	assert.throws(() => createIntegrationHarness(null as any), /Integration harness must be an object/);
	assert.throws(
		() => createIntegrationHarness({ name: 'bad' } as any),
		/createStore must be a function/
	);
	const accessorHarness = Object.defineProperty({}, 'name', {
		enumerable: true,
		get() {
			optionReads++;
			return 'accessor-harness';
		}
	});
	assert.throws(
		() => createIntegrationHarness(accessorHarness as any),
		/Integration harness\.name must be a data property/
	);
	assert.equal(optionReads, 0);
	await assert.rejects(
		() => runStoreAdapterContract(null as any),
		/Store contract adapter must be a store adapter object/
	);
	const accessorContractStore: any = {
		kind: 'accessor-contract-store',
		getMany: async () => [],
		query: async () => ({ list: [], more: false }),
		create: async () => {},
		update: async () => {},
		delete: async () => {}
	};
	Object.defineProperty(accessorContractStore, 'get', {
		enumerable: true,
		get() {
			optionReads++;
			return async () => null;
		}
	});
	await assert.rejects(
		() => runStoreAdapterContract(accessorContractStore),
		/Testing adapter property "get" must be a data property/
	);
	assert.equal(optionReads, 0);
	assert.throws(
		() => createAdapterContractSuite(null as any),
		/Adapter contract suite must be an object/
	);
	assert.throws(
		() => createAdapterContractSuite({ bad: { kind: 'bad-store' } as any }),
		/Adapter contract suite "bad" adapter\.get must be a function/
	);
	assert.throws(
		() => createAdapterContractSuite({ [Symbol('memory')]: new MemoryStoreAdapter() } as any),
		/Adapter contract suite cannot contain symbol adapter names/
	);
	assert.throws(
		() => createCacheAdapterContractSuite(null as any),
		/Cache adapter contract suite must be an object/
	);
	assert.throws(
		() => createCacheAdapterContractSuite({ bad: { kind: 'bad-cache' } as any }),
		/Cache adapter contract suite "bad" adapter\.getMany must be a function/
	);
	assert.throws(
		() => createSearchAdapterContractSuite({ bad: { kind: 'bad-search' } as any }),
		/Search adapter contract suite "bad" adapter\.search must be a function/
	);
	assert.throws(
		() => createSearchAdapterContractSuite({ memory: new MemorySearchAdapter() }, { settleMs: -1 } as any),
		/Search adapter contract options\.settleMs/
	);
	const accessorSuite = Object.defineProperty({}, 'memory', {
		enumerable: true,
		get() {
			optionReads++;
			return new MemoryStoreAdapter();
		}
	});
	assert.throws(
		() => createAdapterContractSuite(accessorSuite as any),
		/Adapter contract suite\.memory must be a data property/
	);
	assert.equal(optionReads, 0);
	const hiddenSuite = Object.defineProperty({}, 'memory', {
		enumerable: false,
		value: new MemoryStoreAdapter()
	});
	assert.throws(
		() => createAdapterContractSuite(hiddenSuite as any),
		/Adapter contract suite\.memory must be enumerable/
	);
	assert.throws(
		() =>
			createIntegrationHarness({
				name: 'bad-warnings',
				createStore: () => new MemoryStoreAdapter(),
				lazyLoadWarnings: 'silent' as any
			}),
		/lazyLoadWarnings/
	);
});

test('adapter contract suite snapshots validated adapter entries', async () => {
	const adapters: Record<string, any> = { memory: () => new MemoryStoreAdapter() };
	const suite = createAdapterContractSuite(adapters);
	adapters.bad = { kind: 'bad-after-create' };

	await suite.run();
});

test('store adapter contract validates schema apply plans', async () => {
	const store = new MemoryStoreAdapter();
	const schema = store.schema;
	Object.defineProperty(store, 'schema', {
		value: {
			plan: schema.plan.bind(schema),
			apply: async (models: ResolvedModelMeta[], options: { mode: 'safe' }) => {
				await schema.apply(models, options);
				return { adapter: 'memory', changes: [null] } as any;
			}
		}
	});

	await assert.rejects(
		() => runStoreAdapterContract(store),
		/Store contract adapter "memory" schema apply plan\.changes\[0\] must be a plain object/
	);
});

test('store adapter contract validates schema plan output', async () => {
	const store = new MemoryStoreAdapter();
	const schema = store.schema;
	Object.defineProperty(store, 'schema', {
		value: {
			plan: async () => ({ adapter: 'memory', changes: [null] }) as any,
			apply: schema.apply.bind(schema)
		}
	});

	await assert.rejects(
		() => runStoreAdapterContract(store),
		/Store contract adapter "memory" schema plan\.changes\[0\] must be a plain object/
	);
});

test('store adapter contract avoids range filters when numeric comparisons are not advertised', async () => {
	const adapter = new MemoryStoreAdapter();
	Object.defineProperty(adapter, 'capabilities', {
		value: { ...adapter.capabilities, numericComparisons: false },
		configurable: true
	});

	await runStoreAdapterContract(adapter);
});

test('store adapter contract snapshots capabilities before adapter execution', async () => {
	const adapter = new MutatingContractCapabilityStore();

	await runStoreAdapterContract(adapter);

	assert.equal(adapter.selectedQuerySeen, true);
});

test('store adapter contract validates capability declarations like core adapters', async () => {
	const inherited = new MemoryStoreAdapter();
	Object.defineProperty(inherited, 'capabilities', {
		value: Object.assign(Object.create({ select: true }), inherited.capabilities),
		configurable: true
	});
	await assert.rejects(
		() => runStoreAdapterContract(inherited),
		/Store contract adapter\.capabilities must be a plain object/
	);

	const unknown = new MemoryStoreAdapter();
	Object.defineProperty(unknown, 'capabilities', {
		value: { ...unknown.capabilities, selekt: true },
		configurable: true
	});
	await assert.rejects(
		() => runStoreAdapterContract(unknown),
		/Store contract adapter\.capabilities contains unknown capability "selekt"/
	);
});

test('testing contract allowlists use captured Set intrinsics', async () => {
	const originalHas = Set.prototype.has;
	const originalAdd = Set.prototype.add;
	Object.defineProperty(Set.prototype, 'has', {
		configurable: true,
		value() {
			throw new Error('patched Set.has');
		}
	});
	Object.defineProperty(Set.prototype, 'add', {
		configurable: true,
		value() {
			throw new Error('patched Set.add');
		}
	});
	try {
		const unknownStoreCapability = new MemoryStoreAdapter();
		Object.defineProperty(unknownStoreCapability, 'capabilities', {
			value: { ...unknownStoreCapability.capabilities, selekt: true },
			configurable: true
		});
		await assert.rejects(
			() => runStoreAdapterContract(unknownStoreCapability),
			/Store contract adapter\.capabilities contains unknown capability "selekt"/
		);

		const unknownSearchCapability = new MemorySearchAdapter();
		Object.defineProperty(unknownSearchCapability, 'capabilities', {
			value: { ...unknownSearchCapability.capabilities, selekt: true },
			configurable: true
		});
		await assert.rejects(
			() => runSearchAdapterContract(unknownSearchCapability),
			/Search contract adapter\.capabilities contains unknown capability "selekt"/
		);

		const unknownWhereOperator = new MemorySearchAdapter();
		Object.defineProperty(unknownWhereOperator, 'capabilities', {
			value: {
				...unknownWhereOperator.capabilities,
				whereOperators: { ...unknownWhereOperator.capabilities.whereOperators, nope: true }
			},
			configurable: true
		});
		await assert.rejects(
			() => runSearchAdapterContract(unknownWhereOperator),
			/Search contract adapter\.capabilities\.whereOperators contains unknown operator "nope"/
		);

		await assert.rejects(
			() => runSearchAdapterContract(new MemorySearchAdapter(), { settleMs: 1, extra: true } as any),
			/Search adapter contract options contains unknown option "extra"/
		);

		const extraResultSearch: SearchAdapter = {
			kind: 'extra-result-search-contract-set',
			capabilities: { index: true },
			search: async () => ({ list: [], more: false, unexpected: true }) as any,
			index: async () => undefined,
			delete: async () => undefined
		};
		await assert.rejects(
			() => runSearchAdapterContract(extraResultSearch),
			/Search contract adapter "extra-result-search-contract-set" result contains unknown result property "unexpected"/
		);
	} finally {
		Object.defineProperty(Set.prototype, 'has', { configurable: true, value: originalHas });
		Object.defineProperty(Set.prototype, 'add', { configurable: true, value: originalAdd });
	}
});

test('testing contract suites ignore patched Array transforms', async () => {
	const originalMap = Array.prototype.map;
	const originalSome = Array.prototype.some;
	const originalEvery = Array.prototype.every;
	const originalSort = Array.prototype.sort;
	Object.defineProperty(Array.prototype, 'map', {
		configurable: true,
		value() {
			throw new Error('patched Array.map');
		}
	});
	Object.defineProperty(Array.prototype, 'some', {
		configurable: true,
		value() {
			throw new Error('patched Array.some');
		}
	});
	Object.defineProperty(Array.prototype, 'every', {
		configurable: true,
		value() {
			throw new Error('patched Array.every');
		}
	});
	Object.defineProperty(Array.prototype, 'sort', {
		configurable: true,
		value() {
			throw new Error('patched Array.sort');
		}
	});
	try {
		await runStoreAdapterContract(new MemoryStoreAdapter());
		await runSearchAdapterContract(new MemorySearchAdapter());
	} finally {
		Object.defineProperty(Array.prototype, 'map', { configurable: true, value: originalMap });
		Object.defineProperty(Array.prototype, 'some', { configurable: true, value: originalSome });
		Object.defineProperty(Array.prototype, 'every', { configurable: true, value: originalEvery });
		Object.defineProperty(Array.prototype, 'sort', { configurable: true, value: originalSort });
	}
});

test('store adapter contract model names do not depend on Math.random', async () => {
	const originalRandom = Math.random;
	let randomCalls = 0;
	Math.random = () => {
		randomCalls++;
		throw new Error('Math.random should not be used by contract model naming');
	};
	try {
		await runStoreAdapterContract(new MemoryStoreAdapter());
	} finally {
		Math.random = originalRandom;
	}
	assert.equal(randomCalls, 0);
});

test('test helper options ignore inherited fields', async () => {
	const inheritedStore = new MemoryStoreAdapter();
	Object.defineProperty(Object.prototype, 'store', {
		value: inheritedStore,
		configurable: true
	});
	Object.defineProperty(Object.prototype, 'lazyLoadWarnings', {
		value: 'throw',
		configurable: true
	});
	try {
		const ctx = createTestContext({});
		assert.notEqual(ctx.store, inheritedStore);
		await withTestContext(ctx, async () => {
			console.warn('captured warning');
		});
		assert.deepEqual(ctx.warnings, ['captured warning']);
	} finally {
		delete (Object.prototype as Record<string, unknown>).store;
		delete (Object.prototype as Record<string, unknown>).lazyLoadWarnings;
	}

	const ctx = createTestContext();
	Object.defineProperty(Object.prototype, 'install', {
		value: false,
		configurable: true
	});
	try {
		await withTestContext(ctx, async () => {
			assert.equal(getCurrentDefaultContext(), ctx.context);
		}, {});
	} finally {
		delete (Object.prototype as Record<string, unknown>).install;
	}

	Object.defineProperty(Object.prototype, 'createStore', {
		value: () => new MemoryStoreAdapter(),
		configurable: true
	});
	try {
		assert.throws(
			() => createIntegrationHarness({ name: 'inherited-create-store' } as any),
			/Integration harness createStore must be a function/
		);
	} finally {
		delete (Object.prototype as Record<string, unknown>).createStore;
	}
});

test('test helper option objects reject hidden fields', async () => {
	const hiddenStoreOptions = Object.defineProperty({}, 'store', {
		enumerable: false,
		value: new MemoryStoreAdapter()
	});
	assert.throws(
		() => createTestContext(hiddenStoreOptions as any),
		/Test context options\.store must be enumerable/
	);

	const hiddenInstallOptions = Object.defineProperty({}, 'install', {
		enumerable: false,
		value: false
	});
	const ctx = createTestContext();
	await assert.rejects(
		() => withTestContext(ctx, async () => undefined, hiddenInstallOptions as any),
		/withTestContext options\.install must be enumerable/
	);

	const hiddenHarness = Object.defineProperty(
		{
			createStore: () => new MemoryStoreAdapter()
		},
		'name',
		{
			enumerable: false,
			value: 'hidden-harness'
		}
	);
	assert.throws(
		() => createIntegrationHarness(hiddenHarness as any),
		/Integration harness\.name must be enumerable/
	);
});

test('test helper option objects reject unknown fields', async () => {
	assert.throws(
		() => createTestContext({ storee: new MemoryStoreAdapter() } as any),
		/Test context options contains unknown option "storee"/
	);

	const ctx = createTestContext();
	await assert.rejects(
		() => withTestContext(ctx, async () => undefined, { instal: false } as any),
		/withTestContext options contains unknown option "instal"/
	);

	assert.throws(
		() =>
			createIntegrationHarness({
				name: 'unknown-harness-option',
				createStore: () => new MemoryStoreAdapter(),
				createCashe: () => undefined
			} as any),
		/Integration harness contains unknown option "createCashe"/
	);
});

test('lazy warning capture records each warning once and validates callbacks', async () => {
	await assert.rejects(
		() => captureLazyLoadWarnings(undefined as any),
		/captureLazyLoadWarnings fn must be a function/
	);
	const captured = await captureLazyLoadWarnings(() => {
		console.warn('first warning');
		console.warn('second', 'warning');
		return 42;
	});

	assert.equal(captured.result, 42);
	assert.deepEqual(captured.warnings, ['first warning', 'second warning']);
});

test('lazy warning capture formats unsafe warning objects without invoking coercion', async () => {
	let toStringCalls = 0;
	let getterCalls = 0;
	const warningArg: Record<string, unknown> = { label: 'unsafe' };
	Object.defineProperty(warningArg, 'secret', {
		enumerable: true,
		get() {
			getterCalls++;
			throw new Error('warning getter should not run');
		}
	});
	Object.defineProperty(warningArg, 'toString', {
		enumerable: true,
		value() {
			toStringCalls++;
			throw new Error('warning toString should not run');
		}
	});

	const captured = await captureLazyLoadWarnings(() => {
		console.warn('captured unsafe warning', warningArg);
		return 42;
	});

	assert.equal(captured.result, 42);
	assert.equal(toStringCalls, 0);
	assert.equal(getterCalls, 0);
	assert.match(captured.warnings[0], /captured unsafe warning/);
	assert.match(captured.warnings[0], /secret: \[Getter\]/);

	const ctx = createTestContext({ lazyLoadWarnings: 'capture' });
	ctx.install();
	try {
		console.warn('context unsafe warning', warningArg);
	} finally {
		ctx.restore();
	}
	assert.equal(toStringCalls, 0);
	assert.equal(getterCalls, 0);
	assert.match(ctx.warnings[0], /context unsafe warning/);

	const throwingCtx = createTestContext({ lazyLoadWarnings: 'throw' });
	throwingCtx.install();
	try {
		assert.throws(() => console.warn('throw unsafe warning', warningArg), /throw unsafe warning/);
	} finally {
		throwingCtx.restore();
	}
	assert.equal(toStringCalls, 0);
	assert.equal(getterCalls, 0);
});

test('lazy warning capture rejects overlapping global console hooks', async () => {
	await assert.rejects(
		() =>
			captureLazyLoadWarnings(() =>
				captureLazyLoadWarnings(() => {
					console.warn('nested warning');
				})
			),
		/cannot overlap/
	);

	const ctx = createTestContext();
	ctx.install();
	try {
		await assert.rejects(
			() => captureLazyLoadWarnings(() => undefined),
			/cannot overlap/
		);
	} finally {
		ctx.restore();
	}

	await assert.rejects(
		() =>
			captureLazyLoadWarnings(() =>
				withTestContext(createTestContext(), async () => {
					console.warn('nested context warning');
				})
			),
		/cannot overlap/
	);
});

test('schema plan and explicit apply include search adapter schema hooks', async () => {
	const search = new SchemaSearchAdapter();
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { 'search-schema': search },
		defaultSearch: 'search-schema'
	});

	const planned = await context.schemaPlan([TestingSeedRecord]);
	assert.deepEqual(planned.map((plan) => plan.adapter), ['memory', 'search-schema']);
	assert.deepEqual(planned.map((plan) => plan.route), ['default', 'search-schema']);
	assert.deepEqual(search.seenModels, ['testing_seed_record']);
	assert.deepEqual(search.calls, { plan: 1, apply: 0, sync: 0 });

	assert.deepEqual(await context.schemaApply([TestingSeedRecord]), []);
	const applied = await context.schemaApply([TestingSeedRecord], { mode: 'safe' });
	assert.deepEqual(applied.map((plan) => plan.adapter), ['memory', 'search-schema']);
	assert.deepEqual(applied.map((plan) => plan.route), ['default', 'search-schema']);
	assert.deepEqual(search.calls, { plan: 1, apply: 1, sync: 0 });
});

test('schema planning does not call legacy search syncSchema hooks', async () => {
	let syncCalls = 0;
	const legacySearch: SearchAdapter = {
		kind: 'legacy-search-schema',
		capabilities: { index: true },
		search: async () => ({ list: [], more: false, count: 0 }),
		index: async () => undefined,
		delete: async () => undefined,
		syncSchema: async (models) => {
			syncCalls++;
			return {
				adapter: 'legacy-search-schema',
				status: 'applied',
				changes: models.flatMap((model) =>
					model.searchIndexes.map((index) => ({
						type: 'create-search-index' as const,
						target: model.name,
						name: index.name,
						fields: index.fields
					}))
				)
			};
		}
	};
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { 'search-schema': legacySearch },
		defaultSearch: 'search-schema'
	});

	const planned = await context.schemaPlan([TestingSeedRecord]);
	assert.equal(syncCalls, 0);
	assert.deepEqual(planned.find((plan) => plan.route === 'search-schema'), {
		adapter: 'legacy-search-schema',
		route: 'search-schema',
		status: 'manual',
		note: 'Search adapter "search-schema" does not expose schema planning. Apply declared search indexes manually or use an adapter with schema hooks.',
		changes: [
			{
				type: 'create-search-index',
				target: 'testing_seed_record',
				name: 'title',
				fields: ['title']
			}
		]
	});

	const applied = await context.schemaApply([TestingSeedRecord], { mode: 'safe' });
	assert.equal(syncCalls, 1);
	assert.equal(applied.find((plan) => plan.route === 'search-schema')?.status, 'applied');
});

test('search schema planning rejects adapters without indexing capability', async () => {
	const noIndexSearch: SearchAdapter = {
		kind: 'no-index-search-schema',
		capabilities: { index: false },
		search: async () => ({ list: [], more: false, count: 0 }),
		index: async () => undefined,
		delete: async () => undefined
	};
	const manualContext = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { 'search-schema': noIndexSearch },
		defaultSearch: 'search-schema'
	});

	await assert.rejects(
		() => manualContext.schemaPlan([TestingSeedRecord]),
		/Search adapter "search-schema" does not support indexing/
	);
	await assert.rejects(
		() => manualContext.schemaApply([TestingSeedRecord], { mode: 'safe' }),
		/Search adapter "search-schema" does not support indexing/
	);

	const schemaSearch: SearchAdapter = {
		...noIndexSearch,
		schema: {
			plan: async () => ({
				adapter: 'no-index-search-schema',
				changes: [{ type: 'create-search-index', target: 'testing_seed_record', name: 'title', fields: ['title'] }]
			}),
			apply: async () => ({
				adapter: 'no-index-search-schema',
				changes: [{ type: 'create-search-index', target: 'testing_seed_record', name: 'title', fields: ['title'] }]
			})
		}
	};
	const schemaContext = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { 'search-schema': schemaSearch },
		defaultSearch: 'search-schema'
	});
	await assert.rejects(
		() => schemaContext.schemaPlan([TestingSeedRecord]),
		/Search adapter "search-schema" does not support indexing/
	);
	await assert.rejects(
		() => schemaContext.schemaApply([TestingSeedRecord], { mode: 'safe' }),
		/Search adapter "search-schema" does not support indexing/
	);
});

test('search schema plans reject fields overlapping model id fields', async () => {
	const invalidPlan = {
		adapter: 'invalid-id-overlap-search',
		changes: [
			{
				type: 'create-search-index' as const,
				target: 'testing_seed_record',
				name: 'slug_value',
				fields: ['slug.value']
			}
		]
	};
	const search: SearchAdapter = {
		kind: 'invalid-id-overlap-search',
		capabilities: { index: true },
		search: async () => ({ list: [], more: false, count: 0 }),
		index: async () => undefined,
		delete: async () => undefined,
		schema: {
			plan: async () => invalidPlan,
			apply: async () => invalidPlan
		}
	};
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { 'search-schema': search },
		defaultSearch: 'search-schema'
	});

	await assert.rejects(
		() => context.schemaPlan([TestingSeedRecord]),
		/Search adapter "search-schema" schema plan\.changes\[0\]\.fields cannot include both "slug" and nested field "slug\.value"/
	);
	await assert.rejects(
		() => context.schemaApply([TestingSeedRecord], { mode: 'safe' }),
		/Search adapter "search-schema" schema apply plan\.changes\[0\]\.fields cannot include both "slug" and nested field "slug\.value"/
	);
});

test('schema plan and apply fail fast on unsupported unique index plans', async () => {
	const context = createActiveTs({
		stores: { default: new UnsupportedUniqueSchemaStore() }
	});

	await assert.rejects(
		() => context.schemaPlan([UniqueSchemaRecord]),
		/does not support unique indexes.*unique_title/
	);
	await assert.rejects(
		() => context.schemaApply([UniqueSchemaRecord], { mode: 'safe' }),
		/does not support unique indexes.*unique_title/
	);
});

test('schema plan normalization rejects duplicate changes', async () => {
	const duplicatePlans = [
		{
			adapter: 'duplicate-schema-change',
			changes: [
				{ type: 'create-collection', target: 'records' },
				{ type: 'create-collection', target: 'records' }
			]
		},
		{
			adapter: 'duplicate-schema-change',
			changes: [
				{ type: 'create-index', target: 'records', name: 'by_title', fields: ['title'] },
				{ type: 'create-index', target: 'records', name: 'by_title', fields: ['slug'] }
			]
		},
		{
			adapter: 'duplicate-schema-change',
			changes: [
				{ type: 'create-search-index', target: 'records', name: 'search_title', fields: ['title'] },
				{ type: 'create-search-index', target: 'records', name: 'search_title', fields: ['slug'] }
			]
		}
	];

	for (let index = 0; index < duplicatePlans.length; index++) {
		assert.throws(
			() => normalizeSchemaPlan(duplicatePlans[index], `duplicate schema plan ${index}`),
			/duplicates schema change/
		);
	}

	const context = createActiveTs({
		stores: { default: new DuplicateSchemaChangeStore() }
	});

	await assert.rejects(
		() => context.schemaPlan([NonUniqueSchemaRecord]),
		/duplicates schema change "create-index:non_unique_schema_record:title_idx"/
	);
	await assert.rejects(
		() => context.schemaApply([NonUniqueSchemaRecord], { mode: 'safe' }),
		/duplicates schema change "create-index:non_unique_schema_record:title_idx"/
	);

	const duplicateSearch: SearchAdapter = {
		kind: 'duplicate-schema-change-search',
		capabilities: { index: true },
		search: async () => ({ list: [], more: false, count: 0 }),
		index: async () => undefined,
		delete: async () => undefined,
		schema: {
			plan: async () => ({
				adapter: 'duplicate-schema-change-search',
				changes: [
					{ type: 'create-search-index', target: 'testing_seed_record', name: 'title', fields: ['title'] },
					{ type: 'create-search-index', target: 'testing_seed_record', name: 'title', fields: ['slug'] }
				]
			}),
			apply: async () => ({
				adapter: 'duplicate-schema-change-search',
				changes: [
					{ type: 'create-search-index', target: 'testing_seed_record', name: 'title', fields: ['title'] },
					{ type: 'create-search-index', target: 'testing_seed_record', name: 'title', fields: ['slug'] }
				]
			})
		}
	};
	const searchContext = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { 'search-schema': duplicateSearch },
		defaultSearch: 'search-schema'
	});

	await assert.rejects(
		() => searchContext.schemaPlan([TestingSeedRecord]),
		/duplicates schema change "create-search-index:testing_seed_record:title"/
	);
	await assert.rejects(
		() => searchContext.schemaApply([TestingSeedRecord], { mode: 'safe' }),
		/duplicates schema change "create-search-index:testing_seed_record:title"/
	);
});

test('schema plan and apply reject unsupported unique indexes before adapters can ignore them', async () => {
	const store = new SilentUniqueSchemaStore();
	const context = createActiveTs({
		stores: { default: store }
	});

	await assert.rejects(
		() => context.schemaPlan([UniqueSchemaRecord]),
		/does not support unique indexes.*unique_title/
	);
	await assert.rejects(
		() => context.schemaApply([UniqueSchemaRecord], { mode: 'safe' }),
		/does not support unique indexes.*unique_title/
	);
	assert.deepEqual(store.calls, { plan: 0, apply: 0 });
});

test('memory store direct schema rejects unsupported unique index metadata', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(UniqueSchemaRecord);

	await assert.rejects(
		() => store.schema.plan([meta]),
		/Memory store adapter does not support unique indexes.*unique_title/
	);
	await assert.rejects(
		() => store.schema.apply([meta], { mode: 'safe' }),
		/Memory store adapter does not support unique indexes.*unique_title/
	);
});

test('schema plan emits manual store index plans when schema hooks are absent', async () => {
	const context = createActiveTs({
		stores: { default: new NoSchemaHookStore() }
	});

	const planned = await context.schemaPlan([NonUniqueSchemaRecord, DirectionalManualSchemaRecord]);
	const applied = await context.schemaApply([NonUniqueSchemaRecord, DirectionalManualSchemaRecord], { mode: 'safe' });

	for (const plans of [planned, applied]) {
		assert.deepEqual(plans, [
			{
				adapter: 'memory',
				route: 'default',
				status: 'manual',
				note: 'Store adapter "default" does not expose schema planning. Apply declared indexes manually or use an adapter with schema hooks.',
				changes: [
					{
						type: 'create-index',
						target: 'non_unique_schema_record',
						name: 'title_idx',
						fields: ['title']
					},
					{
						type: 'create-index',
						target: 'directional_manual_schema_record',
						name: 'title_desc_idx',
						fields: ['title'],
						directions: ['desc']
					}
				]
			}
		]);
	}
});

test('manual store schema plans emit both Datastore ancestor index modes', async () => {
	const context = createActiveTs({
		stores: { default: new DatastoreNoSchemaHookStore() }
	});

	const planned = await context.schemaPlan([ManualDatastoreSchemaRecord, DirectionalManualSchemaRecord]);
	const applied = await context.schemaApply(
		[ManualDatastoreSchemaRecord, DirectionalManualSchemaRecord],
		{ mode: 'safe' }
	);

	for (const plans of [planned, applied]) {
		assert.deepEqual(plans, [
			{
				adapter: 'memory',
				route: 'default',
				status: 'manual',
				note: 'Store adapter "default" does not expose schema planning. Apply declared indexes manually or use an adapter with schema hooks.',
				changes: [
					{
						type: 'create-index',
						target: 'manual_datastore_schema_record',
						name: 'parent_title_idx',
						fields: ['parentId', 'title', 'slug'],
						directions: ['asc', 'asc', 'asc'],
						ancestor: true
					},
					{
						type: 'create-index',
						target: 'manual_datastore_schema_record',
						name: 'parent_title_idx',
						fields: ['parentId', 'title', 'slug'],
						directions: ['asc', 'asc', 'asc'],
						ancestor: false
					},
					{
						type: 'create-index',
						target: 'directional_manual_schema_record',
						name: 'title_desc_idx',
						fields: ['title', 'slug'],
						directions: ['desc', 'asc'],
						ancestor: false
					}
				]
			}
		]);
	}
});

test('Datastore-like manual store schema plans reject slash-containing fields', async () => {
	const context = createActiveTs({
		stores: { default: new DatastoreNoSchemaHookStore() }
	});

	await assert.rejects(
		() => context.schemaPlan([UnsafeDatastoreManualSchemaRecord]),
		/Datastore schema index field "profile\/name" cannot contain "\/"/
	);
});

test('schema plan emits manual search index plans when schema hooks are absent', async () => {
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { 'search-schema': new MemorySearchAdapter() },
		defaultSearch: 'search-schema'
	});

	const planned = await context.schemaPlan([TestingSeedRecord]);
	const manualSearchPlan = planned.find((plan) => plan.route === 'search-schema');

	assert.deepEqual(manualSearchPlan, {
		adapter: 'memory',
		route: 'search-schema',
		status: 'manual',
		note: 'Search adapter "search-schema" does not expose schema planning. Apply declared search indexes manually or use an adapter with schema hooks.',
		changes: [
			{
				type: 'create-search-index',
				target: 'testing_seed_record',
				name: 'title',
				fields: ['title']
			}
		]
	});
});

test('schema migration summaries preserve registered adapter routes', async () => {
	const context = createActiveTs({
		stores: {
			primary: new MemoryStoreAdapter(),
			archive: new MemoryStoreAdapter()
		},
		defaultStore: 'primary'
	});

	const migration = await context.schemaMigration(
		[PrimarySchemaRouteRecord, ArchiveSchemaRouteRecord],
		'route_migration'
	);

	assert.deepEqual(migration.plans.map((plan) => [plan.adapter, plan.route]), [
		['memory', 'primary'],
		['memory', 'archive']
	]);
	assert.deepEqual(migration.summary, [
		'primary:create-collection:primary_schema_route_record',
		'archive:create-collection:archive_schema_route_record'
	]);
});

test('schema plan routes mixed untagged and tagged search indexes to filtered adapters', async () => {
	const defaultSearch = new SchemaSearchAdapter('default-search-schema');
	const elasticSearch = new SchemaSearchAdapter('elastic-search-schema');
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: {
			'default-search-schema': defaultSearch,
			'elastic-search-schema': elasticSearch
		},
		defaultSearch: 'default-search-schema'
	});

	const planned = await context.schemaPlan([MixedSearchSchemaRecord]);

	assert.deepEqual(planned.map((plan) => plan.adapter), ['memory', 'default-search-schema', 'elastic-search-schema']);
	assert.deepEqual(defaultSearch.seenIndexes, { mixed_search_schema_record: ['default_title'] });
	assert.deepEqual(elasticSearch.seenIndexes, { mixed_search_schema_record: ['default_title', 'elastic_title'] });
});

test('search schema routes include explicit adapter-tagged indexes outside planner candidates', () => {
	const defaultSearch = new SchemaSearchAdapter('default-search-schema');
	const elasticSearch = new SchemaSearchAdapter('elastic-search-schema');
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: {
			'default-search-schema': defaultSearch,
			'elastic-search-schema': elasticSearch
		},
		defaultSearch: 'default-search-schema',
		queryPlanner: {
			schemaSearchAdapters: ['default-search-schema']
		}
	});

	const routes = context.searchAdapterSchemaRoutesFor(context.meta(MixedSearchSchemaRecord));

	assert.deepEqual(routes.map((route) => [route.name, route.indexKind]), [
		['default-search-schema', 'default-search-schema'],
		['elastic-search-schema', 'elastic-search-schema']
	]);
});

test('search schema routes physical search index kinds through registered aliases', async () => {
	const primary = Object.assign(new SchemaSearchAdapter('wrapped-algolia-schema'), {
		searchIndexKind: 'algolia'
	});
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { primary },
		defaultSearch: 'primary',
		queryPlanner: {
			schemaSearchAdapters: ['primary']
		}
	});

	const routes = context.searchAdapterSchemaRoutesFor(context.meta(PhysicalAliasSearchSchemaRecord));
	const directPlan = await context.searchAdapter('primary').schema!.plan([
		context.meta(PhysicalAliasSearchSchemaRecord)
	]);
	const planned = await context.schemaPlan([PhysicalAliasSearchSchemaRecord]);

	assert.deepEqual(routes.map((route) => [route.name, route.indexKind]), [['primary', 'algolia']]);
	assert.deepEqual(
		directPlan.changes.map((change) => change.type === 'create-search-index' ? change.name : undefined),
		['physical_alias_title']
	);
	assert.deepEqual(planned.map((plan) => [plan.adapter, plan.route]), [
		['memory', 'default'],
		['wrapped-algolia-schema', 'primary']
	]);
	assert.deepEqual(primary.seenIndexes, { physical_alias_search_schema_record: ['physical_alias_title'] });
});

test('search schema discovers physical search index aliases outside planner candidates', async () => {
	const short = new SchemaSearchAdapter('short-search-schema');
	const long = new SchemaSearchAdapter('long-search-schema');
	const primary = Object.assign(new SchemaSearchAdapter('wrapped-algolia-schema'), {
		searchIndexKind: 'algolia'
	});
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { short, long, primary },
		defaultSearch: 'short',
		queryPlanner: {
			schemaSearchAdapters: ['short', 'long']
		}
	});

	const routes = context.searchAdapterSchemaRoutesFor(context.meta(PhysicalAliasSearchSchemaRecord));
	const planned = await context.schemaPlan([PhysicalAliasSearchSchemaRecord]);

	assert.deepEqual(routes.map((route) => [route.name, route.indexKind]), [['primary', 'algolia']]);
	assert.deepEqual(planned.map((plan) => [plan.adapter, plan.route]), [
		['memory', 'default'],
		['wrapped-algolia-schema', 'primary']
	]);
	assert.deepEqual(short.seenIndexes, {});
	assert.deepEqual(long.seenIndexes, {});
	assert.deepEqual(primary.seenIndexes, { physical_alias_search_schema_record: ['physical_alias_title'] });
});

test('schema plan fails fast for unregistered declared search adapters', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });

	await assert.rejects(
		() => context.schemaPlan([MissingSearchSchemaRecord]),
		/Search adapter "missing-search-schema" is not registered/
	);
});

test('schema plan routes untagged search indexes through query planner search routes', async () => {
	const routed = new SchemaSearchAdapter('planner-routed-search-schema');
	let routeCalls = 0;
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { 'planner-routed-search-schema': routed },
		queryPlanner: {
			routeSearch(input) {
				routeCalls++;
				assert.equal(input.model.name, 'planner_search_schema_record');
				assert.equal(input.query, '');
				assert.deepEqual(input.options, { where: undefined, limit: undefined, cursor: undefined, native: undefined });
				return 'planner-routed-search-schema';
			}
		}
	});

	const planned = await context.schemaPlan([PlannerSearchSchemaRecord]);

	assert.equal(routeCalls, 0);
	assert.deepEqual(planned.map((plan) => [plan.adapter, plan.route]), [
		['memory', 'default'],
		['planner-routed-search-schema', 'planner-routed-search-schema']
	]);
	assert.deepEqual(routed.seenIndexes, { planner_search_schema_record: ['planner_title'] });
});

test('schema plan includes every registered search adapter for query-dependent routes', async () => {
	const shortQuery = new SchemaSearchAdapter('short-query-search-schema');
	const longQuery = new SchemaSearchAdapter('long-query-search-schema');
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: {
			'short-query-search-schema': shortQuery,
			'long-query-search-schema': longQuery
		},
		queryPlanner: {
			routeSearch(input) {
				return input.query.length < 3 ? 'short-query-search-schema' : 'long-query-search-schema';
			}
		}
	});

	const planned = await context.schemaPlan([RouteDependentSearchSchemaRecord]);

	assert.deepEqual(planned.map((plan) => [plan.adapter, plan.route]), [
		['memory', 'default'],
		['short-query-search-schema', 'short-query-search-schema'],
		['long-query-search-schema', 'long-query-search-schema']
	]);
	assert.deepEqual(shortQuery.seenIndexes, { route_dependent_search_schema_record: ['route_dependent_title'] });
	assert.deepEqual(longQuery.seenIndexes, { route_dependent_search_schema_record: ['route_dependent_title'] });
});

test('schema plan search route candidates exclude unrelated registered adapters', async () => {
	const shortQuery = new SchemaSearchAdapter('short-query-candidate-schema');
	const longQuery = new SchemaSearchAdapter('long-query-candidate-schema');
	const unused = new SchemaSearchAdapter('unused-query-candidate-schema');
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: {
			'short-query-candidate-schema': shortQuery,
			'long-query-candidate-schema': longQuery,
			'unused-query-candidate-schema': unused
		},
		queryPlanner: {
			schemaSearchAdapters: () => ['short-query-candidate-schema', 'long-query-candidate-schema'],
			routeSearch(input) {
				return input.query.length < 3 ? 'short-query-candidate-schema' : 'long-query-candidate-schema';
			}
		}
	});

	const planned = await context.schemaPlan([RouteDependentSearchSchemaRecord]);

	assert.deepEqual(planned.map((plan) => [plan.adapter, plan.route]), [
		['memory', 'default'],
		['short-query-candidate-schema', 'short-query-candidate-schema'],
		['long-query-candidate-schema', 'long-query-candidate-schema']
	]);
	assert.deepEqual(shortQuery.seenIndexes, { route_dependent_search_schema_record: ['route_dependent_title'] });
	assert.deepEqual(longQuery.seenIndexes, { route_dependent_search_schema_record: ['route_dependent_title'] });
	assert.deepEqual(unused.seenIndexes, {});
});

test('direct schema adapters reject sparse model metadata arrays', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(TestingSeedRecord);
	const store = new MemoryStoreAdapter();

	let forEachCalls = 0;
	const models = [meta] as any[];
	Object.defineProperty(models, 'forEach', {
		value() {
			forEachCalls++;
			throw new Error('custom models forEach should not run');
		}
	});
	await store.schema.plan(models);
	assert.equal(forEachCalls, 0);

	let fieldForEachCalls = 0;
	const fields = ['title'] as any[];
	Object.defineProperty(fields, 'forEach', {
		value() {
			fieldForEachCalls++;
			throw new Error('custom field forEach should not run');
		}
	});
	await store.schema.plan([{ ...meta, indexes: [{ name: 'title_index', fields }] }] as any);
	assert.equal(fieldForEachCalls, 0);

	await assert.rejects(
		() => store.schema.plan(new Array(1) as any),
		/memory store schema models\[0\] is missing/
	);
	await assert.rejects(
		() => store.schema.plan([{ ...meta, name: '__unsafe' }] as any),
		/memory store schema models\[0\]\.name/
	);
	await assert.rejects(
		() => store.schema.plan([{ ...meta, idField: 'profile.id' }] as any),
		/memory store schema models\[0\]\.idField "profile\.id" must be a top-level field/
	);
	let getterCalls = 0;
	const accessorMeta = Object.defineProperty({ ...meta }, 'name', {
		enumerable: true,
		get() {
			getterCalls++;
			return 'testing_seed_record';
		}
	});
	await assert.rejects(
		() => store.schema.plan([accessorMeta] as any),
		/memory store schema models\[0\]\.name must be a data property/
	);
	assert.equal(getterCalls, 0);
	const hiddenMeta = Object.defineProperty({ ...meta }, 'name', {
		enumerable: false,
		value: 'testing_seed_record'
	});
	await assert.rejects(
		() => store.schema.plan([hiddenMeta] as any),
		/memory store schema models\[0\]\.name must be enumerable/
	);
	await assert.rejects(
		() => store.schema.plan([{ ...meta, [Symbol('meta')]: true }] as any),
		/memory store schema models\[0\] cannot contain symbol fields/
	);
	const protoMeta = { ...meta } as any;
	Object.defineProperty(protoMeta, '__proto__', {
		enumerable: true,
		value: null
	});
	await assert.rejects(
		() => store.schema.plan([protoMeta] as any),
		/memory store schema models\[0\] cannot contain reserved metadata field "__proto__"/
	);
	await assert.rejects(
		() => store.schema.plan([{ ...meta, constructor: 'unsafe' }] as any),
		/memory store schema models\[0\] cannot contain reserved metadata field "constructor"/
	);
	await assert.rejects(
		() => store.schema.plan([{ ...meta, indexes: [{ name: '__unsafe', fields: ['title'] }] }] as any),
		/memory store schema models\[0\]\.indexes\[0\]\.name/
	);
	await assert.rejects(
		() => store.schema.plan([{ ...meta, indexes: new Array(1) }] as any),
		/memory store schema models\[0\]\.indexes\[0\] is missing/
	);
	await assert.rejects(
		() => store.schema.plan([{ ...meta, indexes: [{ name: 'unsafe_field', fields: ['__unsafe'] }] }] as any),
		/memory store schema models\[0\]\.indexes\[0\]\.fields\[0\]/
	);
	await assert.rejects(
		() => store.schema.plan([{ ...meta, indexes: [{ name: 'bad_unique', fields: ['title'], unique: 'false' }] }] as any),
		/memory store schema models\[0\]\.indexes\[0\]\.unique must be a boolean/
	);
	await assert.rejects(
		() => store.schema.plan([{ ...meta, indexes: [{ name: 'bad_typo', fields: ['title'], uniq: true }] }] as any),
		/memory store schema models\[0\]\.indexes\[0\] contains unknown option "uniq"/
	);
	await store.schema.apply([meta], { mode: 'safe' });
	await assert.rejects(
		() => store.schema.apply([meta], { mode: 'force' } as any),
		/memory store schema apply options\.mode must be "safe"/
	);
	await assert.rejects(
		() => store.schema.apply([meta], { modee: 'safe' } as any),
		/memory store schema apply options contains unknown option "modee"/
	);
	const accessorApplyOptions = Object.defineProperty({}, 'mode', {
		enumerable: true,
		get() {
			throw new Error('custom schema apply option getter should not run');
		}
	});
	await assert.rejects(
		() => store.schema.apply([meta], accessorApplyOptions as any),
		/memory store schema apply options\.mode must be a data property/
	);
	const hiddenApplyOptions = Object.defineProperty({}, 'mode', {
		enumerable: false,
		value: 'safe'
	});
	await assert.rejects(
		() => store.schema.apply([meta], hiddenApplyOptions as any),
		/memory store schema apply options\.mode must be enumerable/
	);
	await assert.rejects(
		() => store.schema.apply([meta], { mode: 'safe', [Symbol('mode')]: true } as any),
		/memory store schema apply options cannot contain symbol fields/
	);

	const algolia = await createAlgoliaSearchAdapter({
		client: {
			searchSingleIndex: async () => ({ hits: [] }),
			saveObject: async () => undefined,
			deleteObject: async () => undefined
		}
	});
	await assert.rejects(
		() => algolia.syncSchema!(new Array(1) as any),
		/Algolia syncSchema models\[0\] is missing/
	);
	await assert.rejects(
		() => algolia.syncSchema!([{ ...meta, searchIndexes: [{ name: '__unsafe', fields: ['title'] }] }] as any),
		/Algolia syncSchema models\[0\]\.searchIndexes\[0\]\.name/
	);
	await assert.rejects(
		() => algolia.syncSchema!([{ ...meta, searchIndexes: [{ name: 'bad_adapter', adapter: {}, fields: ['title'] }] }] as any),
		/Algolia syncSchema models\[0\]\.searchIndexes\[0\]\.adapter/
	);
	await assert.rejects(
		() => algolia.syncSchema!([{ ...meta, searchIndexes: [{ name: 'bad_unique', fields: ['title'], unique: true }] }] as any),
		/Algolia syncSchema models\[0\]\.searchIndexes\[0\] contains unknown option "unique"/
	);
	const { searchIndexes: _searchIndexes, ...missingSearchIndexes } = meta;
	await assert.rejects(
		() => algolia.syncSchema!([missingSearchIndexes] as any),
		/Algolia syncSchema models\[0\]\.searchIndexes must be an array/
	);

	const elastic = await createElasticsearchSearchAdapter({
		client: {
			search: async () => ({ hits: { hits: [] } }),
			index: async () => undefined,
			delete: async () => undefined
		}
	});
	await assert.rejects(
		() => elastic.syncSchema!([{ ...meta, searchIndexes: new Array(1) }] as any),
		/Elasticsearch syncSchema models\[0\]\.searchIndexes\[0\] is missing/
	);
});

test('schema model normalization snapshots nested index arrays before adapters', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(TestingSeedRecord);
	const storeFields = ['title'] as any[];
	const searchFields = ['title'] as any[];
	const indexes = [{ name: 'store_title', fields: storeFields, unique: false }] as any[];
	const searchIndexes = [{ name: 'search_title', adapter: 'algolia', fields: searchFields }] as any[];
	let indexesMapCalls = 0;
	let searchIndexesMapCalls = 0;
	let storeFieldsMapCalls = 0;
	let searchFieldsMapCalls = 0;
	Object.defineProperty(indexes, 'map', {
		value() {
			indexesMapCalls++;
			throw new Error('custom indexes.map should not run');
		}
	});
	Object.defineProperty(searchIndexes, 'map', {
		value() {
			searchIndexesMapCalls++;
			throw new Error('custom searchIndexes.map should not run');
		}
	});
	Object.defineProperty(storeFields, 'map', {
		value() {
			storeFieldsMapCalls++;
			throw new Error('custom index fields.map should not run');
		}
	});
	Object.defineProperty(searchFields, 'map', {
		value() {
			searchFieldsMapCalls++;
			throw new Error('custom search fields.map should not run');
		}
	});

	const [normalized] = normalizeSchemaModels([{ ...meta, indexes, searchIndexes }], 'schema models');

	assert.deepEqual(normalized.indexes, [{ name: 'store_title', fields: ['title'], unique: false }]);
	assert.deepEqual(normalized.searchIndexes, [{ name: 'search_title', fields: ['title'], adapter: 'algolia' }]);
	assert.notEqual(normalized.indexes, indexes);
	assert.notEqual(normalized.searchIndexes, searchIndexes);
	assert.notEqual(normalized.indexes[0].fields, storeFields);
	assert.notEqual(normalized.searchIndexes[0].fields, searchFields);

	const algolia = await createAlgoliaSearchAdapter({
		client: {
			searchSingleIndex: async () => ({ hits: [] }),
			saveObject: async () => undefined,
			deleteObject: async () => undefined
		}
	});
	const plan = await algolia.syncSchema!([{ ...meta, searchIndexes } as any]);
	assert.deepEqual(plan.changes, [
		{ type: 'create-search-index', target: 'testing_seed_record', name: 'search_title', fields: ['title'] }
	]);
	assert.equal(indexesMapCalls, 0);
	assert.equal(searchIndexesMapCalls, 0);
	assert.equal(storeFieldsMapCalls, 0);
	assert.equal(searchFieldsMapCalls, 0);
});

test('schema model normalization rejects overlapping search projection fields', () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(TestingSeedRecord);
	assert.throws(
		() =>
			normalizeSchemaModels([
				{
					...meta,
					searchIndexes: [{ name: 'bad_search_projection', fields: ['title', 'title.label'] }]
				}
			], 'schema models'),
		/schema models\[0\]\.searchIndexes\[0\]\.fields cannot include both "title" and nested field "title\.label"/
	);
	assert.throws(
		() =>
			normalizeSchemaModels([
				{
					...meta,
					searchIndexes: [{ name: 'bad_id_projection', fields: ['slug.value'] }]
				}
			], 'schema models'),
		/schema models\[0\]\.searchIndexes\[0\]\.fields cannot include both "slug" and nested field "slug\.value"/
	);
});

test('schema model and plan normalization ignore patched Array map', () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(TestingSeedRecord);
	const map = Object.getOwnPropertyDescriptor(Array.prototype, 'map')!;
	let normalized: ResolvedModelMeta[] = [];
	let plan: SchemaPlan | undefined;
	Object.defineProperty(Array.prototype, 'map', {
		configurable: true,
		value() {
			throw new Error('patched Array.map');
		}
	});
	try {
		normalized = normalizeSchemaModels([
			{
				...meta,
				indexes: [{ name: 'store_title', fields: ['title'], directions: ['desc'], unique: true }],
				searchIndexes: [{ name: 'search_title', adapter: 'algolia', fields: ['title'] }]
			}
		], 'schema models');
		plan = normalizeSchemaPlan({
			adapter: 'memory',
			changes: [
				{ type: 'create-index', target: 'testing_seed_record', name: 'title_index', fields: ['title'], directions: ['desc'], ancestor: true },
				{ type: 'create-search-index', target: 'testing_seed_record', name: 'search_title', fields: ['title'] }
			]
		}, 'schema plan');
	} finally {
		Object.defineProperty(Array.prototype, 'map', map);
	}

	assert.deepEqual(normalized[0].indexes, [{ name: 'store_title', fields: ['title'], directions: ['desc'], unique: true }]);
	assert.deepEqual(normalized[0].searchIndexes, [{ name: 'search_title', fields: ['title'], adapter: 'algolia' }]);
	assert.deepEqual(plan?.changes, [
		{ type: 'create-index', target: 'testing_seed_record', name: 'title_index', fields: ['title'], directions: ['desc'], ancestor: true },
		{ type: 'create-search-index', target: 'testing_seed_record', name: 'search_title', fields: ['title'] }
	]);
});

test('schema plan normalization snapshots change arrays before mapping', () => {
	let mapCalls = 0;
	const changes = [
		{ type: 'create-index', target: 'testing_seed_record', name: 'title_index', fields: ['title'] }
	] as any[];
	Object.defineProperty(changes, 'map', {
		value() {
			mapCalls++;
			throw new Error('custom changes map should not run');
		}
	});

	const plan = normalizeSchemaPlan({ adapter: 'memory', changes }, 'schema plan');

	assert.deepEqual(plan.changes, [
		{ type: 'create-index', target: 'testing_seed_record', name: 'title_index', fields: ['title'] }
	]);
	assert.equal(mapCalls, 0);
	assert.deepEqual(
		normalizeSchemaPlan({
			adapter: 'datastore',
			changes: [
				{ type: 'create-index', target: 'testing_seed_record', name: 'title_index', fields: ['title'], ancestor: false },
				{ type: 'create-index', target: 'testing_seed_record', name: 'title_index', fields: ['title'], ancestor: true }
			]
		}, 'schema plan').changes,
		[
			{ type: 'create-index', target: 'testing_seed_record', name: 'title_index', fields: ['title'], ancestor: false },
			{ type: 'create-index', target: 'testing_seed_record', name: 'title_index', fields: ['title'], ancestor: true }
		]
	);

	const hiddenPlan = Object.defineProperty({ adapter: 'memory' }, 'changes', {
		enumerable: false,
		value: []
	});
	assert.throws(
		() => normalizeSchemaPlan(hiddenPlan, 'schema plan'),
		/schema plan\.changes must be enumerable/
	);
	assert.throws(
		() => normalizeSchemaPlan({ adapter: 'memory', changes: [], statuz: 'planned' } as any, 'schema plan'),
		/schema plan contains unknown option "statuz"/
	);

	const hiddenChange = Object.defineProperty(
		{ type: 'create-index', target: 'testing_seed_record', fields: ['title'] },
		'name',
		{
			enumerable: false,
			value: 'title_index'
		}
	);
	assert.throws(
		() => normalizeSchemaPlan({ adapter: 'memory', changes: [hiddenChange] }, 'schema plan'),
		/schema plan\.changes\[0\]\.name must be enumerable/
	);
	assert.throws(
		() =>
			normalizeSchemaPlan(
				{
					adapter: 'memory',
					changes: [
						{ type: 'create-index', target: 'testing_seed_record', name: 'title_index', fields: ['title'], uniq: true }
					]
				} as any,
				'schema plan'
			),
		/schema plan\.changes\[0\] contains unknown option "uniq"/
	);
	assert.throws(
		() =>
			normalizeSchemaPlan(
				{
					adapter: 'datastore',
					changes: [
						{ type: 'create-index', target: 'testing_seed_record', name: 'title_index', fields: ['title'], ancestor: 'yes' }
					]
				} as any,
				'schema plan'
			),
		/schema plan\.changes\[0\]\.ancestor must be a boolean/
	);
	assert.throws(
		() =>
			normalizeSchemaPlan(
				{
					adapter: 'memory',
					changes: [
						{ type: 'create-search-index', target: 'testing_seed_record', name: 'title_index', fields: ['title'], unique: true }
					]
				} as any,
				'schema plan'
			),
		/schema plan\.changes\[0\] contains unknown option "unique"/
	);
	assert.throws(
		() =>
			normalizeSchemaPlan(
				{
					adapter: 'memory',
					changes: [
						{
							type: 'create-search-index',
							target: 'testing_seed_record',
							name: 'title_index',
							fields: ['title', 'title.label']
						}
					]
				},
				'schema plan'
			),
		/schema plan\.changes\[0\]\.fields cannot include both "title" and nested field "title\.label"/
	);
});

test('schema option and plan allowlists use captured Set intrinsics', () => {
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
			() => normalizeStoreSchemaApplyOptions({ modee: 'safe' }, 'schemaApply options'),
			/schemaApply options contains unknown option "modee"/
		);
		assert.throws(
			() => normalizeSchemaPlan({ adapter: 'memory', changes: [], statuz: 'planned' } as any, 'schema plan'),
			/schema plan contains unknown option "statuz"/
		);
		assert.throws(
			() =>
				normalizeSchemaPlan(
					{
						adapter: 'memory',
						changes: [
							{ type: 'create-index', target: 'testing_seed_record', name: 'title_index', fields: ['title'], uniq: true }
						]
					} as any,
					'schema plan'
				),
			/schema plan\.changes\[0\] contains unknown option "uniq"/
		);
	} finally {
		Set.prototype.has = setHas;
		Set.prototype.add = setAdd;
	}
});

function currentDefaultContextOrUndefined() {
	try {
		return getCurrentDefaultContext();
	} catch {
		return undefined;
	}
}
