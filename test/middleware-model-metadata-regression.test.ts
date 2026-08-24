import test from 'node:test';
import assert from 'node:assert/strict';
import {
	MemoryCacheAdapter,
	MemorySearchAdapter,
	MemoryStoreAdapter,
	Model,
	createActiveTs,
	createCacheMiddlewareAdapter,
	createSearchMiddlewareAdapter,
	createStoreMiddlewareAdapter,
	defineModel,
	type ResolvedModelMeta,
	type StoreAdapter
} from '../src/index.js';

type MiddlewareMetadataData = {
	id: number;
	title: string;
};

class MiddlewareMetadataRecord extends Model<MiddlewareMetadataData> {}

defineModel<MiddlewareMetadataData>({ name: 'middleware_metadata_record', search: 'memory' })
	.id('id')
	.validate((input) => input as MiddlewareMetadataData)
	.search('memory', ['title'])
	.attach(MiddlewareMetadataRecord);

const emptyPlan = { where: [], or: [], sort: [], include: [] };

function modelMetaWithAccessor(
	meta: ResolvedModelMeta<MiddlewareMetadataData>,
	property: 'name' | 'idField' | 'searchIndexes'
) {
	let calls = 0;
	const next = { ...meta };
	Object.defineProperty(next, property, {
		enumerable: true,
		configurable: true,
		get() {
			calls++;
			return meta[property];
		}
	});
	return {
		model: next as ResolvedModelMeta<MiddlewareMetadataData>,
		calls: () => calls
	};
}

test('store middleware snapshots direct model metadata before middleware execution', async () => {
	let middlewareCalls = 0;
	const base = new MemoryStoreAdapter();
	const store = createStoreMiddlewareAdapter(base, [
		async () => {
			middlewareCalls++;
			throw new Error('store middleware should not run');
		}
	]);
	const meta = createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(MiddlewareMetadataRecord);

	const nameAccessor = modelMetaWithAccessor(meta, 'name');
	await assert.rejects(
		() => store.get(nameAccessor.model, 1),
		/store middleware model metadata\.name must be a data property/
	);
	assert.equal(nameAccessor.calls(), 0);

	const idFieldAccessor = modelMetaWithAccessor(meta, 'idField');
	await assert.rejects(
		() => store.query(idFieldAccessor.model, emptyPlan),
		/store middleware model metadata\.idField must be a data property/
	);
	assert.equal(idFieldAccessor.calls(), 0);
	assert.equal(middlewareCalls, 0);
	assert.equal(base.stats.get + base.stats.query, 0);
});

test('store middleware snapshots direct model index arrays before wrapped adapters', async () => {
	const meta = createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(MiddlewareMetadataRecord);
	const fields = ['title'] as any[];
	const indexes = [{ name: 'title_index', fields }] as any[];
	let indexesMapCalls = 0;
	let fieldsMapCalls = 0;
	let seenIndexes: unknown;
	Object.defineProperty(indexes, 'map', {
		value() {
			indexesMapCalls++;
			throw new Error('custom indexes.map should not run');
		}
	});
	Object.defineProperty(fields, 'map', {
		value() {
			fieldsMapCalls++;
			throw new Error('custom index fields.map should not run');
		}
	});
	const base: StoreAdapter = {
		kind: 'custom-store',
		async get() {
			return null;
		},
		async getMany() {
			return [];
		},
		async query(model) {
			seenIndexes = model.indexes.map((index) => ({
				name: index.name,
				fields: index.fields.map((field) => field),
				unique: index.unique
			}));
			return { list: [], more: false, count: 0 };
		},
		async create() {},
		async update() {},
		async delete() {}
	};
	const store = createStoreMiddlewareAdapter(base, []);

	await store.query({ ...meta, indexes }, emptyPlan);

	assert.deepEqual(seenIndexes, [{ name: 'title_index', fields: ['title'], unique: undefined }]);
	assert.equal(indexesMapCalls, 0);
	assert.equal(fieldsMapCalls, 0);
});

test('search middleware snapshots direct model metadata before middleware execution', async () => {
	let middlewareCalls = 0;
	const base = new MemorySearchAdapter();
	const search = createSearchMiddlewareAdapter(base, [
		async () => {
			middlewareCalls++;
			throw new Error('search middleware should not run');
		}
	]);
	const meta = createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(MiddlewareMetadataRecord);

	for (const property of ['name', 'idField', 'searchIndexes'] as const) {
		const accessor = modelMetaWithAccessor(meta, property);
		await assert.rejects(
			() => search.search(accessor.model, 'needle', {}),
			new RegExp(`search middleware model metadata\\.${property} must be a data property`)
		);
		assert.equal(accessor.calls(), 0);
	}

	const indexAccessor = modelMetaWithAccessor(meta, 'name');
	await assert.rejects(
		() => search.index(indexAccessor.model, 1, { id: 1, title: 'needle' }),
		/search middleware model metadata\.name must be a data property/
	);
	assert.equal(indexAccessor.calls(), 0);
	assert.equal(middlewareCalls, 0);
	assert.equal(base.stats.search + base.stats.index + base.stats.delete, 0);
});

test('middleware adapters do not spread raw adapter accessor properties', () => {
	let reads = 0;

	const storeBase = new MemoryStoreAdapter() as MemoryStoreAdapter & { extra?: unknown };
	Object.defineProperty(storeBase, 'extra', {
		enumerable: true,
		get() {
			reads++;
			return 'store-extra';
		}
	});
	const store = createStoreMiddlewareAdapter(storeBase, []) as typeof storeBase;
	assert.equal(reads, 0);
	assert.equal(store.extra, undefined);

	const cacheBase = new MemoryCacheAdapter() as MemoryCacheAdapter & { extra?: unknown };
	Object.defineProperty(cacheBase, 'extra', {
		enumerable: true,
		get() {
			reads++;
			return 'cache-extra';
		}
	});
	const cache = createCacheMiddlewareAdapter(cacheBase, []) as typeof cacheBase;
	assert.equal(reads, 0);
	assert.equal(cache.extra, undefined);

	const searchBase = new MemorySearchAdapter() as MemorySearchAdapter & { extra?: unknown };
	Object.defineProperty(searchBase, 'extra', {
		enumerable: true,
		get() {
			reads++;
			return 'search-extra';
		}
	});
	const search = createSearchMiddlewareAdapter(searchBase, []) as typeof searchBase;
	assert.equal(reads, 0);
	assert.equal(search.extra, undefined);
});
