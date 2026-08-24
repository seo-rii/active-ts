import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
	MemoryCacheAdapter,
	MemoryStoreAdapter,
	MemorySearchAdapter,
	Model,
	createActiveTs,
	createFunctionCache,
	createSoftDeletePlugin,
	defineModel,
	isPartialModel,
	runSearchSyncWorker
} from '../src/index.js';
import { createMongoStoreAdapter } from '../src/adapters/store/mongodb.js';
import { markPartialModel } from '../src/core/partial-model.js';
import {
	attachEntityKey,
	assertSafeEntityIdArray,
	clonePortableData
} from '../src/core/safe-keys.js';
import { filterRows, whereShapeToPlan } from '../src/core/query-utils.js';
import { normalizeStoreSchemaApplyOptions } from '../src/core/schema-options.js';
import { normalizeSchemaModels } from '../src/core/schema-utils.js';
import { normalizeSearchAdapterOptions } from '../src/core/search-utils.js';

test('safe key module initialization ignores patched Array filter', () => {
	const script = `
Object.defineProperty(Array.prototype, 'filter', {
	configurable: true,
	value() {
		throw new Error('patched Array.filter');
	}
});
const safeKeys = await import('./build/src/core/safe-keys.js');
safeKeys.assertSafeFieldPath('name');
`;
	const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
		cwd: process.cwd(),
		encoding: 'utf8'
	});
	assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('public validation boundaries use captured Object inspection intrinsics', () => {
	const originals = {
		entries: Object.getOwnPropertyDescriptor(Object, 'entries')!,
		getOwnPropertyDescriptor: Object.getOwnPropertyDescriptor(Object, 'getOwnPropertyDescriptor')!,
		getOwnPropertyNames: Object.getOwnPropertyDescriptor(Object, 'getOwnPropertyNames')!,
		getOwnPropertySymbols: Object.getOwnPropertyDescriptor(Object, 'getOwnPropertySymbols')!,
		getPrototypeOf: Object.getOwnPropertyDescriptor(Object, 'getPrototypeOf')!,
		isExtensible: Object.getOwnPropertyDescriptor(Object, 'isExtensible')!,
		keys: Object.getOwnPropertyDescriptor(Object, 'keys')!
	};
	let cloned: unknown;
	let queryPlan: unknown;
	let filtered: unknown;
	let ids: unknown;
	let schema: unknown;
	let schemaOptions: unknown;
	let searchOptions: unknown;
	Object.defineProperties(Object, {
		entries: {
			configurable: true,
			value() {
				throw new Error('patched Object.entries');
			}
		},
		getOwnPropertyDescriptor: {
			configurable: true,
			value() {
				throw new Error('patched Object.getOwnPropertyDescriptor');
			}
		},
		getOwnPropertyNames: {
			configurable: true,
			value() {
				throw new Error('patched Object.getOwnPropertyNames');
			}
		},
		getOwnPropertySymbols: {
			configurable: true,
			value() {
				throw new Error('patched Object.getOwnPropertySymbols');
			}
		},
		getPrototypeOf: {
			configurable: true,
			value() {
				throw new Error('patched Object.getPrototypeOf');
			}
		},
		isExtensible: {
			configurable: true,
			value() {
				throw new Error('patched Object.isExtensible');
			}
		},
		keys: {
			configurable: true,
			value() {
				throw new Error('patched Object.keys');
			}
		}
	});
	try {
		const entityKeyTarget = {};
		attachEntityKey(entityKeyTarget, 'captured-object-inspection');
		cloned = clonePortableData({ id: 1, title: 'safe', nested: { keep: true }, omitted: undefined });
		queryPlan = whereShapeToPlan({ 'nested.keep': true, tags: ['arrayContains', 'a'] });
		filtered = filterRows(
			[{ id: 1, nested: { keep: true }, tags: ['a'] }],
			{ where: [{ field: 'tags', op: 'arrayContains', value: 'a' }], or: [] }
		);
		ids = assertSafeEntityIdArray([1, '1']);
		schema = normalizeSchemaModels(
			[{
				name: 'captured_object_model',
				idField: 'id',
				indexes: [{ name: 'captured_object_model_id', fields: ['id'] }],
				searchIndexes: [{ name: 'captured_object_search', fields: ['title'] }]
			}],
			'captured schema models'
		);
		schemaOptions = normalizeStoreSchemaApplyOptions({ mode: 'safe' }, 'captured schema apply options');
		searchOptions = normalizeSearchAdapterOptions({ where: { title: 'safe' }, limit: 1 }, 'captured search options');
	} finally {
		Object.defineProperties(Object, originals);
	}

	assert.deepEqual(cloned, { id: 1, title: 'safe', nested: { keep: true } });
	assert.deepEqual(queryPlan, {
		where: [
			{ field: 'nested.keep', op: '=', value: true },
			{ field: 'tags', op: 'arrayContains', value: 'a' }
		],
		or: []
	});
	assert.deepEqual(filtered, [{ id: 1, nested: { keep: true }, tags: ['a'] }]);
	assert.deepEqual(ids, [1, '1']);
	const [schemaModel] = schema as any[];
	assert.equal(Object.getPrototypeOf(schemaModel), null);
	assert.deepEqual({ ...schemaModel }, {
		name: 'captured_object_model',
		idField: 'id',
		indexes: [{ name: 'captured_object_model_id', fields: ['id'] }],
		searchIndexes: [{ name: 'captured_object_search', fields: ['title'] }]
	});
	assert.deepEqual(schemaOptions, { mode: 'safe' });
	assert.deepEqual(searchOptions, {
		where: { title: 'safe' },
		native: undefined,
		limit: 1,
		cursor: undefined
	});
});

type DescriptorPollutionData = {
	id: number;
	title: string;
	deletedAt?: string | null;
};

type CollectionIntrinsicData = {
	id: number;
	title: string;
};

type CollectionTransformData = {
	id: number;
	score: number;
	token: string;
};

type CollectionSizeData = {
	id: number;
	title: string;
};

class DescriptorPollutionRecord extends Model<DescriptorPollutionData> {}
class CollectionIntrinsicRecord extends Model<CollectionIntrinsicData> {}
class CollectionTransformRecord extends Model<CollectionTransformData> {}
class CollectionSizeRecord extends Model<CollectionSizeData> {}

defineModel<DescriptorPollutionData>({ name: 'descriptor_pollution_record' })
	.id('id')
	.validate((input) => input as DescriptorPollutionData)
	.attach(DescriptorPollutionRecord);

defineModel<CollectionIntrinsicData>({ name: 'collection_intrinsic_record', search: 'memory' })
	.id('id')
	.validate((input) => input as CollectionIntrinsicData)
	.search('memory', ['title'])
	.attach(CollectionIntrinsicRecord);

defineModel<CollectionTransformData>('collection_transform_record')
	.id('id')
	.validate((input) => input as CollectionTransformData)
	.fieldType('score', 'number')
	.fieldCodec('token', {
		name: 'collection_transform_token',
		encode: (value) => `stored:${String(value)}`,
		decode: (value) => String(value).replace(/^stored:/, ''),
		encodeQuery: (value) => `stored:${String(value)}`,
		queryOperators: ['=']
	})
	.attach(CollectionTransformRecord);

defineModel<CollectionSizeData>({
	name: 'collection_size_record',
	cache: { ttl: 60 }
})
	.id('id')
	.validate((input) => input as CollectionSizeData)
	.attach(CollectionSizeRecord);

test('runtime property definitions ignore polluted descriptor prototypes', async () => {
	Object.defineProperties(Object.prototype, {
		get: { value: () => undefined, configurable: true },
		set: { value: () => undefined, configurable: true },
		value: { value: 'polluted descriptor value', configurable: true },
		writable: { value: false, configurable: true }
	});
	try {
		const entityKeyTarget = {};
		attachEntityKey(entityKeyTarget, 'entity-key');
		assert.equal(Object.getOwnPropertyDescriptor(entityKeyTarget, Symbol.for('active-ts.entity-key'))?.value, 'entity-key');

		const partialTarget = {};
		markPartialModel(partialTarget);
		assert.equal(isPartialModel(partialTarget), true);

		const context = createActiveTs({
			stores: { default: new MemoryStoreAdapter() },
			plugins: [createSoftDeletePlugin()]
		});
		const BoundRecord = DescriptorPollutionRecord.use(context) as typeof DescriptorPollutionRecord;
		const created = await BoundRecord.create({ id: 1, title: 'created' });
		assert.equal(created.data.deletedAt, null);
		const [schemaModel] = normalizeSchemaModels([context.meta(DescriptorPollutionRecord)], 'descriptor schema models');
		assert.equal(schemaModel.name, 'descriptor_pollution_record');
		assert.equal(Object.getOwnPropertyDescriptor(schemaModel, 'name')?.value, 'descriptor_pollution_record');

		const drained = [{
			id: 'descriptor-requeue',
			model: 'descriptor_pollution_record',
			modelId: 1,
			operation: 'noop',
			data: { id: 1, title: 'retry' },
			createdAt: '2026-05-24T00:00:00.000Z'
			}];
			const requeued: any[] = [];
			await assert.rejects(
				() =>
					runSearchSyncWorker({
						outbox: {
							append: async () => undefined,
							requeue: async (events: any[]) => {
								requeued.push(...events);
							},
							drain: async () => drained as any
						},
					search: new MemorySearchAdapter(),
					models: [DescriptorPollutionRecord],
					context
					}),
				/unsupported operation/
			);
			assert.equal(requeued.length, 1);
			assert.notEqual(requeued[0], drained[0]);
			assert.deepEqual(requeued[0].data, { id: 1, title: 'retry' });

		let seenFilter: Record<string, unknown> | undefined;
		const mongo = await createMongoStoreAdapter({
			dbName: 'test',
			client: {
				db: () => ({
					collection: () => ({
						find: (filter: Record<string, unknown>) => {
							seenFilter = filter;
							return { toArray: async () => [] };
						}
					})
				})
			}
		});
		await mongo.query(context.meta(DescriptorPollutionRecord), {
			where: [{ field: 'title', op: '=', value: 'created' }],
			or: [],
			sort: [],
			include: []
		});
		assert.deepEqual(seenFilter, {
			$and: [
				{ title: { $exists: true } },
				{ title: { $not: { $type: 'array' } } },
				{ title: { $eq: 'created' } }
			]
		});
	} finally {
		delete (Object.prototype as Record<string, unknown>).get;
		delete (Object.prototype as Record<string, unknown>).set;
		delete (Object.prototype as Record<string, unknown>).value;
		delete (Object.prototype as Record<string, unknown>).writable;
	}
});

test('function cache runtime maps use captured Map accessors', async () => {
	const lookup = createFunctionCache<number, { id: number }>({
		prefix: 'function-cache-map-accessors',
		cache: false,
		memory: { maxEntries: 1 },
		factory: async (id) => ({ id })
	});
	await lookup.get(1);

	const originals = {
		get: Object.getOwnPropertyDescriptor(Map.prototype, 'get')!,
		set: Object.getOwnPropertyDescriptor(Map.prototype, 'set')!,
		delete: Object.getOwnPropertyDescriptor(Map.prototype, 'delete')!,
		has: Object.getOwnPropertyDescriptor(Map.prototype, 'has')!,
		size: Object.getOwnPropertyDescriptor(Map.prototype, 'size')!
	};
	const calls = { get: 0, set: 0, delete: 0, has: 0, size: 0 };
	Object.defineProperties(Map.prototype, {
		get: {
			value() {
				calls.get++;
				throw new Error('polluted Map.get');
			},
			configurable: true
		},
		set: {
			value() {
				calls.set++;
				throw new Error('polluted Map.set');
			},
			configurable: true
		},
		delete: {
			value() {
				calls.delete++;
				throw new Error('polluted Map.delete');
			},
			configurable: true
		},
		has: {
			value() {
				calls.has++;
				throw new Error('polluted Map.has');
			},
			configurable: true
		},
		size: {
			get() {
				calls.size++;
				throw new Error('polluted Map.size');
			},
			configurable: true
		}
	});
	try {
		assert.deepEqual(await lookup.get(1), { id: 1 });
		await lookup.invalidate(1);
		assert.deepEqual(await lookup.get(2), { id: 2 });
		assert.deepEqual(calls, { get: 0, set: 0, delete: 0, has: 0, size: 0 });
	} finally {
		Object.defineProperties(Map.prototype, originals);
	}
});

test('metadata snapshots and transaction rebinding use captured collection intrinsics', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const BoundRecord = CollectionIntrinsicRecord.use(context) as typeof CollectionIntrinsicRecord;
	const transformMeta = context.meta(CollectionTransformRecord);

	await BoundRecord.create({ id: 1, title: 'initial' });

	const originalMapEntries = Map.prototype.entries;
	const originalMapSet = Map.prototype.set;
	const calls = { entries: 0, set: 0 };
	Object.defineProperties(Map.prototype, {
		entries: {
			value() {
				calls.entries++;
				throw new Error('polluted Map.entries');
			},
			configurable: true
		},
		set: {
			value() {
				calls.set++;
				throw new Error('polluted Map.set');
			},
			configurable: true
		}
	});
	try {
		assert.deepEqual(await store.get(context.meta(CollectionIntrinsicRecord), 1), { id: 1, title: 'initial' });
		assert.equal(await store.get(transformMeta, 99), null);
		assert.deepEqual(calls, { entries: 0, set: 0 });
	} finally {
		Object.defineProperties(Map.prototype, {
			entries: {
				value: originalMapEntries,
				configurable: true,
				writable: true
			},
			set: {
				value: originalMapSet,
				configurable: true,
				writable: true
			}
		});
	}

	const originalMapForEach = Map.prototype.forEach;
	const originalSetForEach = Set.prototype.forEach;
	let mapForEachCalls = 0;
	let setForEachCalls = 0;
	Object.defineProperty(Map.prototype, 'forEach', {
		value() {
			mapForEachCalls++;
			throw new Error('polluted Map.forEach');
		},
		configurable: true
	});
	Object.defineProperty(Set.prototype, 'forEach', {
		value() {
			setForEachCalls++;
			throw new Error('polluted Set.forEach');
		},
		configurable: true
	});
	try {
		const result = await context.transaction(async () => {
			const loaded = await BoundRecord.find(1).load();
			assert.ok(loaded);
			return { nested: new Map([[loaded, new Set([loaded])]]) };
		});
		assert.equal(mapForEachCalls, 0);
		assert.equal(setForEachCalls, 0);

		const rebound = result.nested.keys().next().value;
		assert.ok(rebound);
		rebound.data.title = 'updated';
		await rebound.save();
		assert.equal((await BoundRecord.find(1).load())?.data.title, 'updated');
	} finally {
		Object.defineProperty(Map.prototype, 'forEach', {
			value: originalMapForEach,
			configurable: true,
			writable: true
		});
		Object.defineProperty(Set.prototype, 'forEach', {
			value: originalSetForEach,
			configurable: true,
			writable: true
		});
	}
});

test('memory adapters and function cache use captured collection iterators', async () => {
	const store = new MemoryStoreAdapter();
	const cache = new MemoryCacheAdapter();
	const search = new MemorySearchAdapter();
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache },
		search: { memory: search },
		defaultSearch: 'memory'
	});
	const BoundRecord = CollectionIntrinsicRecord.use(context) as typeof CollectionIntrinsicRecord;
	const lookup = createFunctionCache<number, { id: number }>({
		prefix: 'collection-intrinsic-lookup',
		factory: async (id) => ({ id }),
		context,
		memory: { maxEntries: 1 }
	});

	await BoundRecord.create({ id: 10, title: 'ten' });
	await cache.setMany([['collection-intrinsic-key', { ok: true }]]);
	await search.index(context.meta(CollectionIntrinsicRecord), 10, { id: 10, title: 'ten' });
	await lookup.get(1);

	const originals = {
		clear: Map.prototype.clear,
		entries: Map.prototype.entries,
		keys: Map.prototype.keys,
		values: Map.prototype.values
	};
	const calls = { clear: 0, entries: 0, keys: 0, values: 0 };
	Object.defineProperties(Map.prototype, {
		clear: {
			value() {
				calls.clear++;
				throw new Error('polluted Map.clear');
			},
			configurable: true
		},
		entries: {
			value() {
				calls.entries++;
				throw new Error('polluted Map.entries');
			},
			configurable: true
		},
		keys: {
			value() {
				calls.keys++;
				throw new Error('polluted Map.keys');
			},
			configurable: true
		},
		values: {
			value() {
				calls.values++;
				throw new Error('polluted Map.values');
			},
			configurable: true
		}
	});
	try {
		assert.deepEqual(store.dump('collection_intrinsic_record'), [{ id: 10, title: 'ten' }]);
		assert.deepEqual(store.snapshot().collection_intrinsic_record, [{ id: 10, title: 'ten' }]);
		await context.transaction(async () => {
			await BoundRecord.create({ id: 11, title: 'eleven' });
		});
		const [loadedOnce, loadedTwice] = await Promise.all([
			BoundRecord.find(10).load(),
			BoundRecord.find(10).load()
		]);
		assert.equal(loadedOnce?.data.id, 10);
		assert.equal(loadedTwice?.data.id, 10);
		assert.equal(context.meta(CollectionTransformRecord).fieldTypes.get('score'), 'number');

		assert.deepEqual(cache.snapshot()['collection-intrinsic-key'].value, { ok: true });
		assert.deepEqual((await search.search(context.meta(CollectionIntrinsicRecord), 'ten', {})).list, [
			{ id: 10, title: 'ten' }
		]);
		assert.deepEqual(search.snapshot('collection_intrinsic_record'), [{ id: 10, title: 'ten' }]);
		assert.deepEqual(search.snapshot().collection_intrinsic_record, [{ id: 10, title: 'ten' }]);

		await lookup.get(2);
		assert.deepEqual(Object.values(lookup.snapshotMemory()).map((entry) => entry.value), [{ id: 2 }]);
		lookup.clearMemory();
		cache.clear();
		search.clear();
		store.reset();
		assert.deepEqual(calls, { clear: 0, entries: 0, keys: 0, values: 0 });
	} finally {
		Object.defineProperties(Map.prototype, {
			clear: { value: originals.clear, configurable: true, writable: true },
			entries: { value: originals.entries, configurable: true, writable: true },
			keys: { value: originals.keys, configurable: true, writable: true },
			values: { value: originals.values, configurable: true, writable: true }
		});
	}
});

test('memory cache uses captured Map accessors for direct operations', async () => {
	const cache = new MemoryCacheAdapter();
	const originals = {
		get: Map.prototype.get,
		set: Map.prototype.set,
		delete: Map.prototype.delete
	};
	const calls = { get: 0, set: 0, delete: 0 };
	Object.defineProperties(Map.prototype, {
		get: {
			value() {
				calls.get++;
				throw new Error('polluted Map.get');
			},
			configurable: true
		},
		set: {
			value() {
				calls.set++;
				throw new Error('polluted Map.set');
			},
			configurable: true
		},
		delete: {
			value() {
				calls.delete++;
				throw new Error('polluted Map.delete');
			},
			configurable: true
		}
	});
	try {
		await cache.setMany([['collection-intrinsic-cache-key', { ok: true }]]);
		assert.deepEqual(await cache.getMany(['collection-intrinsic-cache-key', 'collection-intrinsic-miss']), [
			{ ok: true },
			undefined
		]);
		await cache.deleteMany(['collection-intrinsic-cache-key']);
		assert.deepEqual(await cache.getMany(['collection-intrinsic-cache-key']), [undefined]);
		assert.deepEqual(calls, { get: 0, set: 0, delete: 0 });
	} finally {
		Object.defineProperties(Map.prototype, {
			get: { value: originals.get, configurable: true, writable: true },
			set: { value: originals.set, configurable: true, writable: true },
			delete: { value: originals.delete, configurable: true, writable: true }
		});
	}
});

test('memory search uses captured Map accessors for direct operations', async () => {
	const search = new MemorySearchAdapter();
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory: search },
		defaultSearch: 'memory'
	});
	const model = context.meta(CollectionIntrinsicRecord);
	const originals = {
		get: Map.prototype.get,
		set: Map.prototype.set,
		delete: Map.prototype.delete
	};
	const calls = { get: 0, set: 0, delete: 0 };
	Object.defineProperties(Map.prototype, {
		get: {
			value() {
				calls.get++;
				throw new Error('polluted Map.get');
			},
			configurable: true
		},
		set: {
			value() {
				calls.set++;
				throw new Error('polluted Map.set');
			},
			configurable: true
		},
		delete: {
			value() {
				calls.delete++;
				throw new Error('polluted Map.delete');
			},
			configurable: true
		}
	});
	try {
		await search.index(model, 10, { id: 10, title: 'ten' });
		assert.deepEqual((await search.search(model, 'ten', {})).list, [{ id: 10, title: 'ten' }]);
		assert.deepEqual(search.snapshot('collection_intrinsic_record'), [{ id: 10, title: 'ten' }]);
		await search.delete(model, 10);
		assert.deepEqual((await search.search(model, 'ten', {})).list, []);
		await search.index(model, 11, { id: 11, title: 'eleven' });
		search.clear('collection_intrinsic_record');
		assert.deepEqual(search.snapshot('collection_intrinsic_record'), []);
		assert.deepEqual(calls, { get: 0, set: 0, delete: 0 });
	} finally {
		Object.defineProperties(Map.prototype, {
			get: { value: originals.get, configurable: true, writable: true },
			set: { value: originals.set, configurable: true, writable: true },
			delete: { value: originals.delete, configurable: true, writable: true }
		});
	}
});

test('memory store uses captured Map accessors for direct operations and transactions', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const model = context.meta(CollectionIntrinsicRecord);
	const originals = {
		get: Map.prototype.get,
		set: Map.prototype.set,
		has: Map.prototype.has,
		delete: Map.prototype.delete
	};
	const calls = { get: 0, set: 0, has: 0, delete: 0 };
	Object.defineProperties(Map.prototype, {
		get: {
			value() {
				calls.get++;
				throw new Error('polluted Map.get');
			},
			configurable: true
		},
		set: {
			value() {
				calls.set++;
				throw new Error('polluted Map.set');
			},
			configurable: true
		},
		has: {
			value() {
				calls.has++;
				throw new Error('polluted Map.has');
			},
			configurable: true
		},
		delete: {
			value() {
				calls.delete++;
				throw new Error('polluted Map.delete');
			},
			configurable: true
		}
	});
	try {
		await store.create(model, 1, { id: 1, title: 'one' });
		assert.deepEqual(await store.get(model, 1), { id: 1, title: 'one' });
		assert.deepEqual(await store.getMany(model, [1, 2]), [{ id: 1, title: 'one' }, null]);
		await store.update(model, 1, { id: 1, title: 'updated' });
		await store.transaction(async (tx) => {
			await tx.create(model, 2, { id: 2, title: 'two' });
			await tx.delete(model, 1);
		});
		await store.seedModel(model, [{ id: 3, title: 'three' }]);
		assert.deepEqual(store.dump('collection_intrinsic_record'), [
			{ id: 2, title: 'two' },
			{ id: 3, title: 'three' }
		]);
		store.reset('collection_intrinsic_record');
		assert.deepEqual(store.dump('collection_intrinsic_record'), []);
		assert.deepEqual(calls, { get: 0, set: 0, has: 0, delete: 0 });
	} finally {
		Object.defineProperties(Map.prototype, {
			get: { value: originals.get, configurable: true, writable: true },
			set: { value: originals.set, configurable: true, writable: true },
			has: { value: originals.has, configurable: true, writable: true },
			delete: { value: originals.delete, configurable: true, writable: true }
		});
	}
});

test('cache cleanup, memory transactions, and Mongo aggregates use captured collection size intrinsics', async () => {
	let entityDeleteShouldFail = true;
	const entityCache = {
		kind: 'collection-size-entity-cache',
		getMany: async (keys: string[]) => keys.map(() => undefined),
		setMany: async () => undefined,
		deleteMany: async () => {
			if (entityDeleteShouldFail) {
				entityDeleteShouldFail = false;
				throw new Error('entity cache delete failed');
			}
		}
	};
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: entityCache }
	});
	const entityMeta = context.meta(CollectionSizeRecord);
	await assert.rejects(() => context.invalidate(entityMeta, 1), /entity cache delete failed/);

	let functionDeleteShouldFail = true;
	const functionCache = {
		kind: 'collection-size-function-cache',
		getMany: async (keys: string[]) => keys.map(() => undefined),
		setMany: async () => undefined,
		deleteMany: async () => {
			if (functionDeleteShouldFail) {
				functionDeleteShouldFail = false;
				throw new Error('function cache delete failed');
			}
		}
	};
	const lookup = createFunctionCache<number, { id: number }>({
		prefix: 'collection-size-function',
		cache: functionCache,
		memory: false,
		factory: async (id) => ({ id })
	});
	await assert.rejects(() => lookup.invalidate(1), /function cache delete failed/);

	const mongo = await createMongoStoreAdapter({
		dbName: 'test',
		client: {
			db: () => ({
				collection: () => ({
					aggregate: () => ({
						toArray: async () => [{ total: 1 }]
					})
				})
			})
		}
	});

	const originalMapSize = Object.getOwnPropertyDescriptor(Map.prototype, 'size')!;
	const originalSetSize = Object.getOwnPropertyDescriptor(Set.prototype, 'size')!;
	const calls = { mapSize: 0, setSize: 0 };
	Object.defineProperties(Map.prototype, {
		size: {
			get() {
				calls.mapSize++;
				throw new Error('polluted Map.size');
			},
			configurable: true
		}
	});
	Object.defineProperties(Set.prototype, {
		size: {
			get() {
				calls.setSize++;
				throw new Error('polluted Set.size');
			},
			configurable: true
		}
	});
	try {
		await context.invalidate(entityMeta, 1);
		await lookup.invalidate(1);

		const transactionMeta = context.meta(CollectionIntrinsicRecord);
		await store.transaction(async (tx) => {
			await tx.create(transactionMeta, 50, { id: 50, title: 'temporary' });
			await tx.delete(transactionMeta, 50);
		});
		assert.equal(await store.get(transactionMeta, 50), null);

		assert.deepEqual(
			await mongo.aggregate!(transactionMeta, {
				where: [],
				or: [],
				aggregates: [{ op: 'count', as: 'total' }]
			}),
			{ total: 1 }
		);
		assert.deepEqual(calls, { mapSize: 0, setSize: 0 });
	} finally {
		Object.defineProperty(Map.prototype, 'size', originalMapSize);
		Object.defineProperty(Set.prototype, 'size', originalSetSize);
	}
});
