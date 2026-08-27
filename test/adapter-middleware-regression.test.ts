import test from 'node:test';
import assert from 'node:assert/strict';
import {
	assertContextBoundStoreAdapter,
	createActiveTs,
	createCacheMiddlewareAdapter,
	clearDefaultContext,
	createStoreMiddlewareAdapter,
	createSearchMiddlewareAdapter,
	datastoreKey,
	defineModel,
	getCurrentDefaultContext,
	markSearchDocumentIdentity,
	MemoryCacheAdapter,
	MemorySearchAdapter,
	MemoryStoreAdapter,
	Model,
	setDefaultContext,
	type CacheAdapter,
	type SearchAdapter,
	type StoreAdapter
} from '../src/index.js';
import { ACTIVE_TS_ENTITY_KEY } from '../src/core/safe-keys.js';
import { datastoreSearchDocumentIdentity, searchDocumentIdentity } from '../src/core/search-utils.js';
import {
	markStoreTrustsDatastoreEntityKeyRows,
	storeTrustsDatastoreEntityKeyRows
} from '../src/core/store-options.js';

type MiddlewareReadData = {
	id: number;
	value: string;
};

type MiddlewareDatastoreWriteData = {
	id: number;
	parentId: number;
	value: string;
};

class MiddlewareReadRecord extends Model<MiddlewareReadData> {}
class MiddlewareDatastoreWriteRecord extends Model<MiddlewareDatastoreWriteData> {}
class MiddlewareDatastoreSearchRecord extends Model<MiddlewareDatastoreWriteData> {}

defineModel<MiddlewareReadData>('adapter_middleware_read_regression')
	.id('id')
	.search('memory', ['value'])
	.validate((input) => input as MiddlewareReadData)
	.attach(MiddlewareReadRecord);

defineModel<MiddlewareDatastoreWriteData>('adapter_middleware_datastore_write_regression')
	.id('id')
	.validate((input) => input as MiddlewareDatastoreWriteData)
	.datastore({
		ancestor: ({ data }) => data?.parentId === undefined ? undefined : datastoreKey('middleware_parent', data.parentId),
		ancestorFields: ['parentId']
	})
	.attach(MiddlewareDatastoreWriteRecord);

defineModel<MiddlewareDatastoreWriteData>('adapter_middleware_datastore_search_regression')
	.id('id')
	.search('middleware-datastore-delete-search', ['value', 'parentId'])
	.validate((input) => input as MiddlewareDatastoreWriteData)
	.datastore({
		ancestor: ({ data }) => data?.parentId === undefined ? undefined : datastoreKey('middleware_parent', data.parentId),
		ancestorFields: ['parentId']
	})
	.attach(MiddlewareDatastoreSearchRecord);

test('middleware adapters can wrap context-bound store and search handles', async () => {
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory: new MemorySearchAdapter() },
		defaultSearch: 'memory'
	});
	const meta = context.meta(MiddlewareReadRecord);
	const operations: string[] = [];
	const store = createStoreMiddlewareAdapter(context.store('default'), [
		async (operation, next) => {
			operations.push(`store:${operation.operation}`);
			return await next();
		}
	]);
	const search = createSearchMiddlewareAdapter(context.searchAdapter('memory'), [
		async (operation, next) => {
			operations.push(`search:${operation.operation}`);
			return await next();
		}
	]);

	await store.create(meta, 1, { id: 1, value: 'context-bound middleware' });
	assert.deepEqual(await store.get(meta, 1), { id: 1, value: 'context-bound middleware' });
	await search.index(meta, 1, { id: 1, value: 'context-bound middleware' });
	assert.deepEqual(
		(await search.search(meta, 'context-bound', {})).list,
		[{ id: 1, value: 'context-bound middleware' }]
	);
	assert.deepEqual(operations, ['store:create', 'store:get', 'search:index', 'search:search']);
	operations.length = 0;

	assert.equal(store.capabilities?.transaction, true);
	assert.equal(typeof store.transaction, 'function');
	await store.transaction!(async (tx) => {
		assert.equal(assertContextBoundStoreAdapter(tx), tx);
	});
	const retainedStoreTransaction = store.transaction!;
	await assert.rejects(
		() =>
			context.transaction(async () => {
				assert.equal(store.capabilities?.transaction, false);
				assert.equal(store.transaction, undefined);
				await assert.rejects(
					() => retainedStoreTransaction(async () => undefined),
					/does not expose transactions in this context/
				);
				await store.create(meta, 2, { id: 2, value: 'rolled back middleware' });
				assert.deepEqual(await store.get(meta, 2), { id: 2, value: 'rolled back middleware' });
				throw new Error('rollback context-bound middleware store');
			}),
		/rollback context-bound middleware store/
	);
	assert.equal(store.capabilities?.transaction, true);
	assert.equal(typeof store.transaction, 'function');
	assert.equal(await store.get(meta, 2), null);
	assert.deepEqual(operations, ['store:create', 'store:get', 'store:get']);
});

test('store middleware rejects empty Datastore namespace aliases', () => {
	const store = new MemoryStoreAdapter();
	Object.defineProperty(store, 'datastoreNamespace', {
		value: '',
		enumerable: true,
		configurable: true
	});

	assert.throws(
		() => createStoreMiddlewareAdapter(store, []),
		/store middleware adapter\.datastoreNamespace must be a non-empty string without null bytes/
	);
});

test('store middleware validates and snapshots Datastore project identity', () => {
	const invalid = new MemoryStoreAdapter();
	Object.defineProperty(invalid, 'datastoreProjectId', {
		value: '',
		enumerable: true,
		configurable: true
	});
	assert.throws(
		() => createStoreMiddlewareAdapter(invalid, []),
		/store middleware adapter\.datastoreProjectId must be a non-empty string without null bytes/
	);

	const valid = new MemoryStoreAdapter();
	Object.defineProperty(valid, 'datastoreProjectId', {
		value: 'middleware-project',
		enumerable: true,
		configurable: true
	});
	const wrapped = createStoreMiddlewareAdapter(valid, []);
	assert.equal(wrapped.datastoreProjectId, 'middleware-project');
});

test('search middleware preserves context-bound Datastore search namespaces', async () => {
	const store = new MemoryStoreAdapter();
	Object.defineProperty(store, 'datastoreNamespace', {
		value: 'middleware_tenant',
		enumerable: true,
		configurable: true
	});
	const context = createActiveTs({
		stores: { default: store },
		search: { 'middleware-datastore-delete-search': new MemorySearchAdapter() },
		defaultSearch: 'middleware-datastore-delete-search'
	});
	const meta = context.meta(MiddlewareDatastoreSearchRecord);
	const handle = context.searchAdapter('middleware-datastore-delete-search');
	const search = createSearchMiddlewareAdapter(handle, []);

	await handle.index(meta, 1, { id: 1, parentId: 10, value: 'namespaced hit' });

	assert.deepEqual(
		(await search.search(meta, 'namespaced', {})).list,
		[{ id: 1, parentId: 10, value: 'namespaced hit' }]
	);
});

test('search middleware exposes context-bound Datastore namespaces to short-circuit layers', async () => {
	const store = new MemoryStoreAdapter();
	Object.defineProperty(store, 'datastoreNamespace', {
		value: 'middleware_tenant',
		enumerable: true,
		configurable: true
	});
	const context = createActiveTs({
		stores: { default: store },
		search: { 'middleware-datastore-delete-search': new MemorySearchAdapter() },
		defaultSearch: 'middleware-datastore-delete-search'
	});
	const meta = context.meta(MiddlewareDatastoreSearchRecord);
	const middleware = createSearchMiddlewareAdapter(context.searchAdapter('middleware-datastore-delete-search'), [
		async (operation) => {
			const data = { id: 1, parentId: 10, value: 'short-circuit hit' };
			const identity = searchDocumentIdentity(operation.model, 1, 'search middleware short-circuit hit', data);
			return {
				list: [markSearchDocumentIdentity(data, identity)],
				more: false,
				count: 1
			};
		}
	]);

	assert.deepEqual(
		(await middleware.search(meta, 'short-circuit', {})).list,
		[{ id: 1, parentId: 10, value: 'short-circuit hit' }]
	);
});

test('search middleware exposes context-bound Datastore namespaces to index layers', async () => {
	const store = new MemoryStoreAdapter();
	Object.defineProperty(store, 'datastoreNamespace', {
		value: 'middleware_tenant',
		enumerable: true,
		configurable: true
	});
	const context = createActiveTs({
		stores: { default: store },
		search: { 'middleware-datastore-delete-search': new MemorySearchAdapter() },
		defaultSearch: 'middleware-datastore-delete-search'
	});
	const meta = context.meta(MiddlewareDatastoreSearchRecord);
	const observedIdentities: string[] = [];
	const middleware = createSearchMiddlewareAdapter(context.searchAdapter('middleware-datastore-delete-search'), [
		async (operation, next) => {
			if (operation.operation === 'index') {
				const [id, data] = operation.args as [number, MiddlewareDatastoreWriteData];
				observedIdentities[observedIdentities.length] = searchDocumentIdentity(
					operation.model,
					id,
					'search middleware index identity',
					data
				);
			}
			return await next();
		}
	]);

	await middleware.index(meta, 1, { id: 1, parentId: 10, value: 'indexed tenant' });

	assert.deepEqual(observedIdentities, [
		datastoreSearchDocumentIdentity(
			meta,
			1,
			datastoreKey('middleware_parent', 10, { namespace: 'middleware_tenant' })
		)
	]);
});

test('store middleware snapshots getMany result arrays before mapping rows', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(MiddlewareReadRecord);
	let mapCalls = 0;
	const rows = [{ id: 1, value: 'one' }] as any[];
	Object.defineProperty(rows, 'map', {
		value() {
			mapCalls++;
			throw new Error('custom store middleware read result map should not run');
		}
	});
	const wrapped = createStoreMiddlewareAdapter(
		{
			kind: 'custom-read-result-array',
			get: async () => null,
			getMany: async () => rows,
			query: async () => ({ list: [] }),
			create: async () => undefined,
			update: async () => undefined,
			delete: async () => undefined
		} satisfies StoreAdapter,
		[]
	);

	const result = await wrapped.getMany(meta, [1]);
	assert.deepEqual(result, [{ id: 1, value: 'one' }]);
	assert.equal(mapCalls, 0);
	result[0]!.value = 'mutated';
	assert.equal(rows[0].value, 'one');
});

test('middleware read and search results must preserve model ids', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(MiddlewareReadRecord);
	const store = createStoreMiddlewareAdapter(
		{
			kind: 'custom-invalid-id-store',
			get: async () => ({ id: 2, value: 'wrong' }),
			getMany: async () => [{ id: 2, value: 'wrong' }],
			query: async () => ({ list: [{ value: 'missing-id' }] }),
			create: async () => undefined,
			update: async () => undefined,
			delete: async () => undefined
		} satisfies StoreAdapter,
		[]
	);
	await assert.rejects(() => store.get(meta, 1), /get result id field "id" must match/);
	await assert.rejects(() => store.getMany(meta, [1]), /getMany result\[0\] id field "id" must match/);
	await assert.rejects(() => store.query(meta, { where: [], or: [], sort: [], include: [] }), /query result\.list\[0\] is missing id field "id"/);

	const search = createSearchMiddlewareAdapter(
		{
			kind: 'custom-invalid-id-search',
			search: async () => ({ list: [{ value: 'missing-id' }] }),
			index: async () => undefined,
			delete: async () => undefined
		} satisfies SearchAdapter,
		[]
	);
	await assert.rejects(() => search.search(meta, 'query', {}), /search result\.list\[0\] is missing id field "id"/);
});

test('middleware query and search results reject unsupported cursor leaks', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(MiddlewareReadRecord);
	const store = createStoreMiddlewareAdapter(
		{
			kind: 'cursorless-store',
			capabilities: { cursor: false },
			get: async () => null,
			getMany: async (model, ids) => ids.map(() => null),
			query: async () => ({ list: [{ id: 1, value: 'one' }], cursor: 'native-cursor', more: false }),
			create: async () => undefined,
			update: async () => undefined,
			delete: async () => undefined
		} satisfies StoreAdapter,
		[]
	);
	await assert.rejects(
		() => store.query(meta, { where: [], or: [], sort: [], include: [] }),
		/Store adapter "cursorless-store\+middleware" does not support returning portable cursors/
	);

	const search = createSearchMiddlewareAdapter(
		{
			kind: 'cursorless-search',
			capabilities: { where: false, cursor: false, native: false, index: false },
			search: async () => ({ list: [{ id: 1, value: 'one' }], cursor: 'native-cursor', more: false }),
			index: async () => undefined,
			delete: async () => undefined
		} satisfies SearchAdapter,
		[]
	);
	await assert.rejects(
		() => search.search(meta, 'query', {}),
		/Search adapter "cursorless-search\+middleware" does not support returning portable cursors/
	);
});

test('store middleware query normalization dedupes mixed where and or constraints', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(MiddlewareReadRecord);
	let receivedPlan: any;
	const store = createStoreMiddlewareAdapter(
		{
			kind: 'custom-query-plan-capture',
			capabilities: { or: true },
			get: async () => null,
			getMany: async () => [],
			query: async (_model, plan) => {
				receivedPlan = plan;
				return { list: [] };
			},
			create: async () => undefined,
			update: async () => undefined,
			delete: async () => undefined
		} satisfies StoreAdapter,
		[]
	);

	await store.query(meta, {
		where: [{ field: 'tenantId', op: '=', value: 't1' }],
		or: [
			{
				where: [
					{ field: 'tenantId', op: '=', value: 't1' },
					{ field: 'value', op: '=', value: 'open' }
				],
				or: [],
				sort: [],
				include: []
			}
		],
		sort: [],
		include: []
	} as any);

	assert.deepEqual(receivedPlan.where, []);
	assert.deepEqual(receivedPlan.or[0].where, [
		{ field: 'tenantId', op: '=', value: 't1' },
		{ field: 'value', op: '=', value: 'open' }
	]);
});

test('store middleware query results reject duplicate model ids', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(MiddlewareReadRecord);
	const store = createStoreMiddlewareAdapter(
		{
			kind: 'custom-duplicate-query-rows',
			get: async () => null,
			getMany: async () => [],
			query: async () => ({
				list: [
					{ id: 1, value: 'first' },
					{ id: 1, value: 'second' }
				]
			}),
			create: async () => undefined,
			update: async () => undefined,
			delete: async () => undefined
		} satisfies StoreAdapter,
		[]
	);

	await assert.rejects(
		() => store.query(meta, { where: [], or: [], sort: [], include: [] }),
		/store middleware adapter "custom-duplicate-query-rows\+middleware" query result contains duplicate id "1"/
	);
});

test('store middleware forwards normalized transaction options', async () => {
	const native = { vendor: { tag: 'stable' } };
	const seen: unknown[] = [];
	const txStore = new MemoryStoreAdapter();
	const store = createStoreMiddlewareAdapter(
		{
			kind: 'transaction-option-store',
			capabilities: { transaction: true },
			get: (model, id, options) => txStore.get(model, id, options),
			getMany: (model, ids, options) => txStore.getMany(model, ids, options),
			query: (model, plan, options) => txStore.query(model, plan, options),
			create: (model, id, data) => txStore.create(model, id, data),
			update: (model, id, data, options) => txStore.update(model, id, data, options),
			delete: (model, id, options) => txStore.delete(model, id, options),
			transaction: async (callback, options) => {
				seen.push(options);
				return await callback(txStore);
			}
		} satisfies StoreAdapter,
		[]
	);

	const result = await store.transaction!(
		async (tx) => {
			assert.equal(tx.kind, 'transaction-option-store+middleware');
			return 'ok';
		},
		{ isolation: 'serializable', readOnly: true, timeoutMs: 25, native }
	);
	native.vendor.tag = 'mutated';

	assert.equal(result, 'ok');
	assert.deepEqual(seen, [
		{
			isolation: 'serializable',
			readOnly: true,
			timeoutMs: 25,
			native: { vendor: { tag: 'stable' } }
		}
	]);
});

test('store middleware transactions track unobserved preflight failures', async () => {
	const base = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: base } });
	const meta = context.meta(MiddlewareReadRecord);
	const store = createStoreMiddlewareAdapter(base, []);
	const promiseThen = Promise.prototype.then;
	let preflightFailure!: Promise<void>;

	await assert.rejects(() =>
		store.transaction!(async (tx) => {
			await tx.create(meta, 901, { id: 901, value: 'must roll back' });
			preflightFailure = tx.create(meta, 902, { id: 903, value: 'invalid id' });
			void promiseThen.call(preflightFailure, undefined, () => undefined);
		})
	);
	await assert.rejects(() => preflightFailure);
	assert.equal(await base.get(meta, 901), null);

	const callbackError = new Error('middleware callback failure');
	let callbackPreflightFailure!: Promise<void>;
	await assert.rejects(
		() =>
			store.transaction!(async (tx) => {
				await tx.create(meta, 904, { id: 904, value: 'must also roll back' });
				callbackPreflightFailure = tx.create(meta, 905, { id: 906, value: 'invalid callback id' });
				void promiseThen.call(callbackPreflightFailure, undefined, () => undefined);
				throw callbackError;
			}),
		(error) => error === callbackError
	);
	await assert.rejects(() => callbackPreflightFailure);
	assert.equal(await base.get(meta, 904), null);
});

test('model query results reject duplicate model ids from custom stores', async () => {
	const store = {
		kind: 'custom-duplicate-model-query-rows',
		get: async () => null,
		getMany: async () => [],
		query: async () => ({
			list: [
				{ id: 1, value: 'first' },
				{ id: 1, value: 'second' }
			]
		}),
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	} satisfies StoreAdapter;
	const context = createActiveTs({ stores: { default: store } });
	const Record = MiddlewareReadRecord.use(context) as unknown as typeof MiddlewareReadRecord;

	await assert.rejects(
		() => Record.query().load(),
		/Store adapter "custom-duplicate-model-query-rows" query result contains duplicate id "1"/
	);
});

test('middleware query and search results reject unknown metadata keys', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(MiddlewareReadRecord);
	const store = createStoreMiddlewareAdapter(
		{
			kind: 'custom-extra-result-key-store',
			get: async () => null,
			getMany: async () => [],
			query: async () => ({ list: [{ id: 1, value: 'one' }], more: false, totla: 1 }) as any,
			create: async () => undefined,
			update: async () => undefined,
			delete: async () => undefined
		} satisfies StoreAdapter,
		[]
	);
	await assert.rejects(
		() => store.query(meta, { where: [], or: [], sort: [], include: [] }),
		/store middleware adapter "custom-extra-result-key-store\+middleware" query result contains unknown option "totla"/
	);

	const search = createSearchMiddlewareAdapter(
		{
			kind: 'custom-extra-result-key-search',
			search: async () => ({ list: [{ id: 1, value: 'one' }], more: false, totla: 1 }) as any,
			index: async () => undefined,
			delete: async () => undefined
		} satisfies SearchAdapter,
		[]
	);
	await assert.rejects(
		() => search.search(meta, 'query', {}),
		/search middleware adapter "custom-extra-result-key-search\+middleware" search result contains unknown option "totla"/
	);
});

test('cache middleware mutations must reach the wrapped cache for non-empty batches', async () => {
	const base = new MemoryCacheAdapter();
	const skipped = createCacheMiddlewareAdapter(base, [
		async () => undefined
	]);

	await assert.rejects(
		() => skipped.setMany([['middleware-cache-write', { value: 'new' }]], { ttl: 60 }),
		/Cache middleware adapter "memory\+middleware" setMany middleware must call next\(\)/
	);
	await assert.rejects(
		() => skipped.deleteMany(['middleware-cache-write']),
		/Cache middleware adapter "memory\+middleware" deleteMany middleware must call next\(\)/
	);
	assert.equal(base.stats.setMany, 0);
	assert.equal(base.stats.deleteMany, 0);
	assert.deepEqual(await base.getMany(['middleware-cache-write']), [undefined]);

	let middlewareCalls = 0;
	const empty = createCacheMiddlewareAdapter(base, [
		async (_context, next) => {
			middlewareCalls++;
			return await next();
		}
	]);
	await empty.setMany([], { ttl: 60 });
	await empty.deleteMany([]);
	assert.equal(middlewareCalls, 0);
	assert.equal(base.stats.setMany, 0);
	assert.equal(base.stats.deleteMany, 0);
});

test('store middleware write next function is one-shot', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(MiddlewareReadRecord);
	const calls: string[] = [];
	const store = createStoreMiddlewareAdapter(
		{
			kind: 'double-next-store',
			get: async () => null,
			getMany: async () => [],
			query: async () => ({ list: [] }),
			create: async () => {
				calls.push('create');
			},
			update: async () => {
				calls.push('update');
			},
			delete: async () => {
				calls.push('delete');
			}
		} satisfies StoreAdapter,
		[
			async (_context, next) => {
				await next();
				return await next();
			}
		]
	);

	await assert.rejects(
		() => store.create(meta, 1, { id: 1, value: 'one' }),
		/Store middleware adapter "double-next-store\+middleware" create middleware must call next\(\) exactly once/
	);
	await assert.rejects(
		() => store.update(meta, 1, { id: 1, value: 'one' }),
		/Store middleware adapter "double-next-store\+middleware" update middleware must call next\(\) exactly once/
	);
	await assert.rejects(
		() => store.delete(meta, 1),
		/Store middleware adapter "double-next-store\+middleware" delete middleware must call next\(\) exactly once/
	);
	assert.deepEqual(calls, ['create', 'update', 'delete']);
});

test('cache middleware mutation next function is one-shot', async () => {
	const calls: string[] = [];
	const cache = createCacheMiddlewareAdapter(
		{
			kind: 'double-next-cache',
			getMany: async () => [],
			setMany: async () => {
				calls.push('setMany');
			},
			deleteMany: async () => {
				calls.push('deleteMany');
			}
		} satisfies CacheAdapter,
		[
			async (_context, next) => {
				await next();
				return await next();
			}
		]
	);

	await assert.rejects(
		() => cache.setMany([['key', { value: 'one' }]]),
		/Cache middleware adapter "double-next-cache\+middleware" setMany middleware must call next\(\) exactly once/
	);
	await assert.rejects(
		() => cache.deleteMany(['key']),
		/Cache middleware adapter "double-next-cache\+middleware" deleteMany middleware must call next\(\) exactly once/
	);
	assert.deepEqual(calls, ['setMany', 'deleteMany']);
});

test('cache middleware preserves atomic versioning methods', async () => {
	const operations: string[] = [];
	const base: CacheAdapter = {
		kind: 'versioned-cache',
		getMany: async (keys) => keys.map(() => undefined),
		setMany: async () => undefined,
		deleteMany: async () => undefined,
		getManyVersioned: async (keys) => keys.map(() => ({ value: undefined, version: 'v1' })),
		setManyVersioned: async (entries) => entries.map(() => true),
		invalidateMany: async () => undefined
	};
	const cache = createCacheMiddlewareAdapter(base, [async (operation, next) => {
		operations.push(operation.operation);
		return await next();
	}]);
	assert.ok(cache.getManyVersioned && cache.setManyVersioned && cache.invalidateMany);
	assert.deepEqual(await cache.getManyVersioned(['one']), [{ value: undefined, version: 'v1' }]);
	assert.deepEqual(await cache.setManyVersioned([['one', { value: 1 }, 'v1']]), [true]);
	await cache.invalidateMany(['one']);
	assert.deepEqual(operations, ['getManyVersioned', 'setManyVersioned', 'invalidateMany']);

	assert.throws(
		() => createCacheMiddlewareAdapter({ ...base, invalidateMany: undefined }, []),
		/must provide getManyVersioned\(\), setManyVersioned\(\), and invalidateMany\(\) together/
	);
});

test('mutation middleware cannot run a late next after the operation rejects', async () => {
	let mutations = 0;
	let lateNext: Promise<unknown> | undefined;
	const cache = createCacheMiddlewareAdapter(
		{
			kind: 'late-next-cache',
			getMany: async (keys) => keys.map(() => undefined),
			setMany: async () => {
				mutations++;
			},
			deleteMany: async () => undefined
		},
		[
			async (_operation, next) => {
				setTimeout(() => {
					lateNext = next();
				}, 5);
			}
		]
	);

	await assert.rejects(
		() => cache.setMany([['one', { value: 1 }]]),
		/must call next\(\) for cache mutations/
	);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(mutations, 0);
	assert.ok(lateNext);
	await assert.rejects(lateNext, /cannot call next\(\) after it settles/);
});

test('search middleware mutations must call next exactly once', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(MiddlewareReadRecord);
	const base = new MemorySearchAdapter();
	const skipped = createSearchMiddlewareAdapter(base, [async () => undefined]);

	await assert.rejects(
		() => skipped.index(meta, 1, { id: 1, value: 'skipped' }),
		/Search middleware adapter "memory\+middleware" index middleware must call next\(\)/
	);
	await assert.rejects(
		() => skipped.delete(meta, 1),
		/Search middleware adapter "memory\+middleware" delete middleware must call next\(\)/
	);
	assert.equal(base.stats.index, 0);
	assert.equal(base.stats.delete, 0);

	const calledTwice = createSearchMiddlewareAdapter(base, [
		async (_context, next) => {
			await next();
			return await next();
		}
	]);
	await assert.rejects(
		() => calledTwice.index(meta, 2, { id: 2, value: 'twice' }),
		/Search middleware adapter "memory\+middleware" index middleware must call next\(\) exactly once/
	);
	await assert.rejects(
		() => calledTwice.delete(meta, 2),
		/Search middleware adapter "memory\+middleware" delete middleware must call next\(\) exactly once/
	);
	assert.equal(base.stats.index, 1);
	assert.equal(base.stats.delete, 1);
});

test('search middleware waits for an unawaited next mutation to settle', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(MiddlewareReadRecord);
	let releaseLeaf!: () => void;
	let leafStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		leafStarted = resolve;
	});
	const blocked = new Promise<void>((resolve) => {
		releaseLeaf = resolve;
	});
	let indexed = false;
	let indexedValue: unknown;
	const search = createSearchMiddlewareAdapter(
		{
			kind: 'unawaited-next-search',
			capabilities: { index: true },
			search: async () => ({ list: [], more: false }),
			index: async (_model, _id, data) => {
				leafStarted();
				await blocked;
				indexed = true;
				indexedValue = data.value;
			},
			delete: async () => undefined
		} satisfies SearchAdapter,
		[
			async (operation, next) => {
				void next();
				(operation.args[1] as { value: string }).value = 'late overwrite';
			}
		]
	);

	let settled = false;
	const indexing = search.index(meta, 1, { id: 1, value: 'one' }).finally(() => {
		settled = true;
	});
	await started;
	await Promise.resolve();
	assert.equal(settled, false);
	assert.equal(indexed, false);
	releaseLeaf();
	await indexing;
	assert.equal(indexed, true);
	assert.equal(indexedValue, 'one');
});

test('search middleware rejects a swallowed second next after the first leaf settles', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(MiddlewareReadRecord);
	let releaseLeaf!: () => void;
	let leafStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		leafStarted = resolve;
	});
	const blocked = new Promise<void>((resolve) => {
		releaseLeaf = resolve;
	});
	let leafCalls = 0;
	let swallowed: unknown;
	const search = createSearchMiddlewareAdapter(
		{
			kind: 'swallowed-second-next-search',
			capabilities: { index: true },
			search: async () => ({ list: [], more: false }),
			index: async () => {
				leafCalls++;
				leafStarted();
				await blocked;
			},
			delete: async () => undefined
		} satisfies SearchAdapter,
		[
			async (_operation, next) => {
				void next();
				try {
					await next();
				} catch (error) {
					swallowed = error;
				}
			}
		]
	);

	let settled = false;
	const indexing = search.index(meta, 1, { id: 1, value: 'one' }).finally(() => {
		settled = true;
	});
	const rejection = assert.rejects(
		indexing,
		/Search middleware adapter "swallowed-second-next-search\+middleware" index middleware must call next\(\) exactly once/
	);
	await started;
	await Promise.resolve();
	assert.equal(settled, false);
	assert.match(String((swallowed as Error).message), /must call next\(\) exactly once/);
	releaseLeaf();
	await rejection;
	assert.equal(leafCalls, 1);
});

test('search middleware preserves middleware and escaped mutation failures', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(MiddlewareReadRecord);
	const middlewareFailure = new Error('middleware failed first');
	const mutationFailure = new Error('escaped mutation failed later');
	const search = createSearchMiddlewareAdapter(
		{
			kind: 'unawaited-next-errors',
			capabilities: { index: true },
			search: async () => ({ list: [], more: false }),
			index: async () => {
				await Promise.resolve();
				throw mutationFailure;
			},
			delete: async () => undefined
		} satisfies SearchAdapter,
		[
			async (_operation, next) => {
				void next();
				throw middlewareFailure;
			}
		]
	);

	await assert.rejects(
		() => search.index(meta, 1, { id: 1, value: 'one' }),
		(error: AggregateError) => {
			assert.equal(error instanceof AggregateError, true);
			assert.deepEqual(error.errors, [middlewareFailure, mutationFailure]);
			assert.match(error.message, /middleware and search mutation both failed/);
			return true;
		}
	);
});

test('store middleware aggregate results reject unknown aliases without invoking accessors', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(MiddlewareReadRecord);
	const aggregatePlan = {
		where: [],
		or: [],
		aggregates: [{ op: 'count' as const, as: 'total' }]
	};
	const extraAliasStore = createStoreMiddlewareAdapter(
		{
			kind: 'extra-aggregate-alias',
			capabilities: { aggregate: true },
			get: async () => null,
			getMany: async () => [],
			query: async () => ({ list: [] }),
			aggregate: async () => ({ total: 1, totla: 1 }),
			create: async () => undefined,
			update: async () => undefined,
			delete: async () => undefined
		} satisfies StoreAdapter,
		[]
	);
	await assert.rejects(
		() => extraAliasStore.aggregate!(meta, aggregatePlan),
		/store middleware adapter "extra-aggregate-alias\+middleware" aggregate result contains unknown option "totla"/
	);

	let getterCalls = 0;
	const accessorResult = Object.defineProperty({ total: 1 }, 'extra', {
		enumerable: true,
		get() {
			getterCalls++;
			return 2;
		}
	});
	const accessorAliasStore = createStoreMiddlewareAdapter(
		{
			kind: 'accessor-aggregate-alias',
			capabilities: { aggregate: true },
			get: async () => null,
			getMany: async () => [],
			query: async () => ({ list: [] }),
			aggregate: async () => accessorResult as any,
			create: async () => undefined,
			update: async () => undefined,
			delete: async () => undefined
		} satisfies StoreAdapter,
		[]
	);
	await assert.rejects(
		() => accessorAliasStore.aggregate!(meta, aggregatePlan),
		/store middleware adapter "accessor-aggregate-alias\+middleware" aggregate result\.extra must be a data property/
	);
	assert.equal(getterCalls, 0);
});

test('store middleware snapshots reject symbol-bearing native payload arrays before middleware runs', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(MiddlewareReadRecord);
	let middlewareCalls = 0;
	let queryCalls = 0;
	let iteratorCalls = 0;
	const values = ['safe'] as unknown[];
	Object.defineProperty(values, Symbol.iterator, {
		configurable: true,
		value: function* () {
			iteratorCalls++;
			yield 'polluted';
		}
	});
	const wrapped = createStoreMiddlewareAdapter(
		{
			kind: 'custom-native-symbol-array',
			capabilities: { native: true },
			get: async () => null,
			getMany: async () => [],
			query: async () => {
				queryCalls++;
				return { list: [] };
			},
			create: async () => undefined,
			update: async () => undefined,
			delete: async () => undefined
		} satisfies StoreAdapter,
		[
			async (_context, next) => {
				middlewareCalls++;
				return next();
			}
		]
	);

	await assert.rejects(
		() =>
			wrapped.query(meta, {
				where: [],
				or: [],
				sort: [],
				include: [],
				native: { payload: { values } }
			}),
		/store middleware query plan\.native\.payload\.values cannot contain symbol fields/
	);
	assert.equal(iteratorCalls, 0);
	assert.equal(middlewareCalls, 0);
	assert.equal(queryCalls, 0);
});

test('store middleware snapshots reject hidden native payload fields before middleware runs', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(MiddlewareReadRecord);
	let middlewareCalls = 0;
	let queryCalls = 0;
	const values = ['safe'] as unknown[];
	Object.defineProperty(values, 'meta', {
		enumerable: false,
		value: 'hidden'
	});
	const wrapped = createStoreMiddlewareAdapter(
		{
			kind: 'custom-native-hidden-fields',
			capabilities: { native: true },
			get: async () => null,
			getMany: async () => [],
			query: async () => {
				queryCalls++;
				return { list: [] };
			},
			create: async () => undefined,
			update: async () => undefined,
			delete: async () => undefined
		} satisfies StoreAdapter,
		[
			async (_context, next) => {
				middlewareCalls++;
				return next();
			}
		]
	);
	const hiddenPayload = Object.defineProperty({}, 'values', {
		enumerable: false,
		value: []
	});

	await assert.rejects(
		() =>
			wrapped.query(meta, {
				where: [],
				or: [],
				sort: [],
				include: [],
				native: { payload: hiddenPayload }
			}),
		/store middleware query plan\.native\.payload\.values must be enumerable/
	);
	await assert.rejects(
		() =>
			wrapped.query(meta, {
				where: [],
				or: [],
				sort: [],
				include: [],
				native: { payload: { values } }
			}),
		/store middleware query plan\.native\.payload\.values cannot contain non-index array property "meta"/
	);
	assert.equal(middlewareCalls, 0);
	assert.equal(queryCalls, 0);
});

test('store middleware snapshots native payloads before wrapped adapters', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(MiddlewareReadRecord);
	const payload = { values: ['safe'] };
	const wrapped = createStoreMiddlewareAdapter(
		{
			kind: 'custom-native-mutator',
			capabilities: { native: true },
			get: async () => null,
			getMany: async () => [],
			query: async (_model, plan) => {
				((plan.native!.payload as any).values as string[])[0] = 'mutated';
				return { list: [], more: false, count: 0 };
			},
			create: async () => undefined,
			update: async () => undefined,
			delete: async () => undefined
		} satisfies StoreAdapter,
		[]
	);

	await wrapped.query(
		meta,
		{ where: [], or: [], sort: [], include: [], native: { payload } },
		{ native: payload }
	);

	assert.deepEqual(payload, { values: ['safe'] });
});

test('store middleware snapshots preserve own proto data fields safely', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(MiddlewareReadRecord);
	const payload = JSON.parse('{"__proto__":{"polluted":true},"visible":1}');
	let middlewarePayload: any;
	const wrapped = createStoreMiddlewareAdapter(
		{
			kind: 'custom-native-proto-payload',
			capabilities: { native: true },
			get: async () => null,
			getMany: async () => [],
			query: async () => ({ list: [], more: false, count: 0 }),
			create: async () => undefined,
			update: async () => undefined,
			delete: async () => undefined
		} satisfies StoreAdapter,
		[
			async (middlewareContext, next) => {
				middlewarePayload = ((middlewareContext.args[0] as any).native.payload as any);
				return next();
			}
		]
	);

	await wrapped.query(
		meta,
		{ where: [], or: [], sort: [], include: [], native: { payload } },
		{ native: payload }
	);

	assert.equal(Object.prototype.hasOwnProperty.call(middlewarePayload, '__proto__'), true);
	assert.deepEqual(middlewarePayload.__proto__, { polluted: true });
	assert.equal(Object.getPrototypeOf(middlewarePayload), Object.prototype);
	assert.equal(middlewarePayload.polluted, undefined);
	assert.equal(({} as any).polluted, undefined);
});

test('store middleware args isolate mutable native built-ins from wrapped adapters', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(MiddlewareReadRecord);
	const pattern = /safe/g;
	pattern.lastIndex = 2;
	let adapterLastIndex: number | undefined;
	const wrapped = createStoreMiddlewareAdapter(
		{
			kind: 'custom-native-builtin-mutator',
			capabilities: { native: true },
			get: async () => null,
			getMany: async () => [],
			query: async (_model, plan) => {
				adapterLastIndex = ((plan.native!.payload as any).pattern as RegExp).lastIndex;
				return { list: [], more: false, count: 0 };
			},
			create: async () => undefined,
			update: async () => undefined,
			delete: async () => undefined
		} satisfies StoreAdapter,
		[
			async (middlewareContext, next) => {
				(((middlewareContext.args[0] as any).native.payload as any).pattern as RegExp).lastIndex = 99;
				return next();
			}
		]
	);

	await wrapped.query(meta, {
		where: [],
		or: [],
		sort: [],
		include: [],
		native: { payload: { pattern } }
	});

	assert.equal(adapterLastIndex, 2);
	assert.equal(pattern.lastIndex, 2);
});

test('store middleware rejects RegExp subclasses without invoking accessors', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(MiddlewareReadRecord);
	let sourceReads = 0;
	let flagReads = 0;
	let middlewareCalls = 0;
	let adapterCalls = 0;
	class HostileRegExp extends RegExp {
		override get source(): string {
			sourceReads++;
			throw new Error('custom source should not run');
		}

		override get flags(): string {
			flagReads++;
			throw new Error('custom flags should not run');
		}
	}
	const pattern = new HostileRegExp('safe', 'g');
	const wrapped = createStoreMiddlewareAdapter(
		{
			kind: 'custom-native-regexp-subclass',
			capabilities: { native: true },
			get: async () => null,
			getMany: async () => [],
			query: async () => {
				adapterCalls++;
				return { list: [], more: false, count: 0 };
			},
			create: async () => undefined,
			update: async () => undefined,
			delete: async () => undefined
		} satisfies StoreAdapter,
		[
			async (_middlewareContext, next) => {
				middlewareCalls++;
				return next();
			}
		]
	);

	await assert.rejects(
		() =>
			wrapped.query(meta, {
				where: [],
				or: [],
				sort: [],
				include: [],
				native: { payload: { pattern } }
			}),
		/store middleware query plan\.native\.payload\.pattern must be a built-in RegExp value/
	);
	assert.equal(sourceReads, 0);
	assert.equal(flagReads, 0);
	assert.equal(middlewareCalls, 0);
	assert.equal(adapterCalls, 0);
});

test('store middleware schema direct calls normalize inputs, options, and plans', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(MiddlewareReadRecord);
	let planCalls = 0;
	let applyCalls = 0;
	const store = createStoreMiddlewareAdapter(
		{
			kind: 'schema-direct-store',
			get: async () => null,
			getMany: async () => [],
			query: async () => ({ list: [] }),
			create: async () => undefined,
			update: async () => undefined,
			delete: async () => undefined,
			schema: {
				plan: async () => {
					planCalls++;
					return {
						adapter: 'schema-direct-store',
						changes: [
							{
								type: 'create-index',
								target: meta.name,
								name: 'value_index',
								fields: ['value'],
								typo: true
							}
						]
					} as any;
				},
				apply: async () => {
					applyCalls++;
					return { adapter: 'schema-direct-store', changes: [], status: 'forced' } as any;
				}
			}
		} satisfies StoreAdapter,
		[]
	);

	await assert.rejects(
		() => store.schema!.plan(new Array(1) as any),
		/store middleware schema models\[0\] is missing/
	);
	assert.equal(planCalls, 0);
	await assert.rejects(
		() => store.schema!.apply([meta], { mode: 'force' } as any),
		/store middleware schema apply options\.mode must be "safe"/
	);
	assert.equal(applyCalls, 0);
	await assert.rejects(
		() => store.schema!.plan([meta]),
		/schema plan\.changes\[0\] contains unknown option "typo"/
	);
	assert.equal(planCalls, 1);
	await assert.rejects(
		() => store.schema!.apply([meta], { mode: 'safe' }),
		/schema apply plan\.status must be "planned", "applied", or "manual"/
	);
	assert.equal(applyCalls, 1);
});

test('search middleware syncSchema direct calls normalize inputs and plans', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(MiddlewareReadRecord);
	let syncCalls = 0;
	const search = createSearchMiddlewareAdapter(
		{
			kind: 'schema-direct-search',
			search: async () => ({ list: [] }),
			index: async () => undefined,
			delete: async () => undefined,
			syncSchema: async () => {
				syncCalls++;
				return {
					adapter: 'schema-direct-search',
					changes: [
						{
							type: 'create-search-index',
							target: meta.name,
							name: 'value_search',
							fields: ['__unsafe']
						}
					]
				} as any;
			}
		} satisfies SearchAdapter,
		[]
	);

	await assert.rejects(
		() => search.syncSchema!(new Array(1) as any),
		/search middleware syncSchema models\[0\] is missing/
	);
	assert.equal(syncCalls, 0);
	await assert.rejects(
		() => search.syncSchema!([meta]),
		/schema plan\.changes\[0\]\.fields\[0\]/
	);
	assert.equal(syncCalls, 1);
});

test('middleware adapters reject hidden capabilities, result fields, and write options', async () => {
	const hiddenKindStore = {
		get: async () => null,
		getMany: async () => [],
		query: async () => ({ list: [], more: false }),
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	} as any;
	Object.defineProperty(hiddenKindStore, 'kind', {
		enumerable: false,
		value: 'hidden-kind-store'
	});
	assert.throws(
		() => createStoreMiddlewareAdapter(hiddenKindStore, []),
		/store middleware adapter\.kind must be enumerable/
	);

	const hiddenKindCache = {
		getMany: async () => [],
		setMany: async () => undefined,
		deleteMany: async () => undefined
	} as any;
	Object.defineProperty(hiddenKindCache, 'kind', {
		enumerable: false,
		value: 'hidden-kind-cache'
	});
	assert.throws(
		() => createCacheMiddlewareAdapter(hiddenKindCache, []),
		/cache middleware adapter\.kind must be enumerable/
	);

	const hiddenKindSearch = {
		search: async () => ({ list: [], more: false }),
		index: async () => undefined,
		delete: async () => undefined
	} as any;
	Object.defineProperty(hiddenKindSearch, 'kind', {
		enumerable: false,
		value: 'hidden-kind-search'
	});
	assert.throws(
		() => createSearchMiddlewareAdapter(hiddenKindSearch, []),
		/search middleware adapter\.kind must be enumerable/
	);

	const hiddenStore = {
		kind: 'hidden-operation-store',
		get: async () => null,
		getMany: async () => [],
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	} as any;
	Object.defineProperty(hiddenStore, 'query', {
		enumerable: false,
		value: async () => ({ list: [], more: false })
	});
	assert.throws(
		() => createStoreMiddlewareAdapter(hiddenStore, []),
		/store middleware adapter\.query must be enumerable/
	);

	const hiddenSearch = {
		kind: 'hidden-operation-search',
		search: async () => ({ list: [], more: false }),
		delete: async () => undefined
	} as any;
	Object.defineProperty(hiddenSearch, 'index', {
		enumerable: false,
		value: async () => undefined
	});
	assert.throws(
		() => createSearchMiddlewareAdapter(hiddenSearch, []),
		/search middleware adapter\.index must be enumerable/
	);
	assert.doesNotThrow(() => createSearchMiddlewareAdapter(new MemorySearchAdapter(), []));

	const hiddenTopLevelCapabilitiesStore = new MemoryStoreAdapter() as any;
	Object.defineProperty(hiddenTopLevelCapabilitiesStore, 'capabilities', {
		enumerable: false,
		configurable: true,
		value: new MemoryStoreAdapter().capabilities
	});
	assert.throws(
		() => createStoreMiddlewareAdapter(hiddenTopLevelCapabilitiesStore, []),
		/store middleware adapter\.capabilities must be enumerable/
	);

	const hiddenTopLevelCapabilitiesSearch = new MemorySearchAdapter() as any;
	Object.defineProperty(hiddenTopLevelCapabilitiesSearch, 'capabilities', {
		enumerable: false,
		configurable: true,
		value: new MemorySearchAdapter().capabilities
	});
	assert.throws(
		() => createSearchMiddlewareAdapter(hiddenTopLevelCapabilitiesSearch, []),
		/search middleware adapter\.capabilities must be enumerable/
	);

	const hiddenSearchIndexKind = new MemorySearchAdapter() as any;
	Object.defineProperty(hiddenSearchIndexKind, 'searchIndexKind', {
		enumerable: false,
		configurable: true,
		value: 'hidden_index'
	});
	assert.throws(
		() => createSearchMiddlewareAdapter(hiddenSearchIndexKind, []),
		/search middleware adapter\.searchIndexKind must be enumerable/
	);

	const hiddenCapabilities = Object.defineProperty({}, 'or', {
		enumerable: false,
		value: true
	});
	const capabilityStore = new MemoryStoreAdapter() as any;
	Object.defineProperty(capabilityStore, 'capabilities', {
		enumerable: true,
		configurable: true,
		value: hiddenCapabilities
	});
	assert.throws(
		() => createStoreMiddlewareAdapter(capabilityStore, []),
		/store middleware adapter\.capabilities\.or must be enumerable/
	);

	const typoCapabilityStore = new MemoryStoreAdapter() as any;
	typoCapabilityStore.capabilities = { textContain: true };
	assert.throws(
		() => createStoreMiddlewareAdapter(typoCapabilityStore, []),
		/store middleware adapter\.capabilities contains unknown capability "textContain"/
	);
	const typoCapabilitySearch = new MemorySearchAdapter() as any;
	typoCapabilitySearch.capabilities = { whereOperator: {} };
	assert.throws(
		() => createSearchMiddlewareAdapter(typoCapabilitySearch, []),
		/search middleware adapter\.capabilities contains unknown capability "whereOperator"/
	);

	let queryCalls = 0;
	const aggregateCapabilityStore = {
		kind: 'missing-aggregate-method',
		capabilities: { aggregate: true, select: true },
		get: async () => null,
		getMany: async () => [],
		query: async () => {
			queryCalls++;
			return { list: [] };
		},
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	} satisfies StoreAdapter;
	assert.throws(
		() => createActiveTs({ stores: { default: aggregateCapabilityStore }, aggregate: { allowQueryFallback: true } }),
		/store adapter name "default" advertises aggregate support but does not expose aggregate\(\)/
	);
	assert.throws(
		() => createStoreMiddlewareAdapter(aggregateCapabilityStore, []),
		/store middleware adapter "missing-aggregate-method" advertises aggregate support but does not expose aggregate\(\)/
	);
	assert.equal(queryCalls, 0);

	const transactionCapabilityStore = {
		kind: 'missing-transaction-method',
		capabilities: { transaction: true },
		get: async () => null,
		getMany: async () => [],
		query: async () => ({ list: [] }),
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	} satisfies StoreAdapter;
	assert.throws(
		() => createActiveTs({ stores: { default: transactionCapabilityStore } }),
		/store adapter name "default" advertises transaction support but does not expose transaction\(\)/
	);
	assert.throws(
		() => createStoreMiddlewareAdapter(transactionCapabilityStore, []),
		/store middleware adapter "missing-transaction-method" advertises transaction support but does not expose transaction\(\)/
	);

	const savepointCapabilityStore = {
		kind: 'missing-savepoint-method',
		capabilities: { savepoint: true },
		get: async () => null,
		getMany: async () => [],
		query: async () => ({ list: [] }),
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	} satisfies StoreAdapter;
	assert.throws(
		() => createActiveTs({ stores: { default: savepointCapabilityStore } }),
		/store adapter name "default" advertises savepoint support but does not expose savepoint\(\)/
	);
	assert.throws(
		() => createStoreMiddlewareAdapter(savepointCapabilityStore, []),
		/store middleware adapter "missing-savepoint-method" advertises savepoint support but does not expose savepoint\(\)/
	);

	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(MiddlewareReadRecord);
	const hiddenResult = Object.defineProperty({}, 'list', {
		enumerable: false,
		value: []
	});
	const wrapped = createStoreMiddlewareAdapter(
		{
			kind: 'hidden-query-result',
			capabilities: {},
			get: async () => null,
			getMany: async () => [],
			query: async () => hiddenResult as any,
			create: async () => undefined,
			update: async () => undefined,
			delete: async () => undefined
		} satisfies StoreAdapter,
		[]
	);
	await assert.rejects(
		() => wrapped.query(meta, { where: [], or: [], sort: [], include: [] }),
		/store middleware adapter "hidden-query-result\+middleware" query result\.list must be enumerable/
	);

	const cache = createCacheMiddlewareAdapter(new MemoryCacheAdapter(), []);
	const hiddenWriteOptions = Object.defineProperty({}, 'ttl', {
		enumerable: false,
		value: 1
	});
	await assert.rejects(
		() => cache.setMany([['hidden-ttl', 'value']], hiddenWriteOptions as any),
		/cache middleware setMany options\.ttl must be enumerable/
	);
	await assert.rejects(
		() => cache.setMany([['symbol-ttl', 'value']], { [Symbol('ttl')]: 1 } as any),
		/cache middleware setMany options cannot contain symbol fields/
	);
	await assert.rejects(
		() => cache.setMany([['unknown-ttl', 'value']], { ttll: 1 } as any),
		/cache middleware setMany options contains unknown option "ttll"/
	);
	const hiddenUnknownOptions = Object.defineProperty({}, 'ttll', {
		enumerable: false,
		value: 1
	});
	await assert.rejects(
		() => cache.setMany([['hidden-unknown-ttl', 'value']], hiddenUnknownOptions as any),
		/cache middleware setMany options contains unknown option "ttll"/
	);
});

test('middleware capability and input allowlists use captured Set intrinsics', async () => {
	const capabilityStore = new MemoryStoreAdapter() as any;
	capabilityStore.capabilities = { ...capabilityStore.capabilities, textContain: true };
	const cache = createCacheMiddlewareAdapter(new MemoryCacheAdapter(), []);
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
			() => createStoreMiddlewareAdapter(capabilityStore, []),
			/store middleware adapter\.capabilities contains unknown capability "textContain"/
		);
		await assert.rejects(
			() => cache.setMany([['unknown-ttl-set', 'value']], { ttll: 1 } as any),
			/cache middleware setMany options contains unknown option "ttll"/
		);
	} finally {
		Set.prototype.has = setHas;
		Set.prototype.add = setAdd;
	}
});

test('search middleware where operator capability allowlist ignores patched Array includes', () => {
	const includes = Object.getOwnPropertyDescriptor(Array.prototype, 'includes')!;
	Object.defineProperty(Array.prototype, 'includes', {
		configurable: true,
		value() {
			throw new Error('patched Array.includes');
		}
	});
	try {
		assert.doesNotThrow(() => createSearchMiddlewareAdapter(new MemorySearchAdapter(), []));
	} finally {
		Object.defineProperty(Array.prototype, 'includes', includes);
	}
});

test('middleware list validation and execution ignore patched Array iteration helpers', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(MiddlewareReadRecord);
	const events: string[] = [];
	const forEach = Object.getOwnPropertyDescriptor(Array.prototype, 'forEach')!;
	const reduceRight = Object.getOwnPropertyDescriptor(Array.prototype, 'reduceRight')!;
	Object.defineProperty(Array.prototype, 'forEach', {
		configurable: true,
		value() {
			throw new Error('patched Array.forEach');
		}
	});
	Object.defineProperty(Array.prototype, 'reduceRight', {
		configurable: true,
		value() {
			throw new Error('patched Array.reduceRight');
		}
	});
	try {
		const adapter = createStoreMiddlewareAdapter(store, [
			async (_operation, next) => {
				events.push('before');
				const result = await next();
				events.push('after');
				return result;
			}
		]);
		await adapter.create(meta, 901, { id: 901, value: 'middleware' });
		assert.deepEqual(events, ['before', 'after']);
		assert.deepEqual(await store.get(meta, 901), { id: 901, value: 'middleware' });
	} finally {
		Object.defineProperty(Array.prototype, 'forEach', forEach);
		Object.defineProperty(Array.prototype, 'reduceRight', reduceRight);
	}
});

test('store middleware write operations must reach the wrapped adapter', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(MiddlewareReadRecord);
	await store.create(meta, 911, { id: 911, value: 'existing' });
	await store.create(meta, 912, { id: 912, value: 'delete-me' });
	const adapter = createStoreMiddlewareAdapter(store, [
		async (operation, next) => {
			if (operation.operation === 'create' || operation.operation === 'update' || operation.operation === 'delete') {
				return undefined;
			}
			return next();
		}
	]);

	await assert.rejects(
		() => adapter.create(meta, 910, { id: 910, value: 'skipped' }),
		/must call next\(\) for write operations/
	);
	await assert.rejects(
		() => adapter.update(meta, 911, { id: 911, value: 'changed' }),
		/must call next\(\) for write operations/
	);
	await assert.rejects(
		() => adapter.delete(meta, 912),
		/must call next\(\) for write operations/
	);

	assert.equal(await store.get(meta, 910), null);
	assert.deepEqual(await store.get(meta, 911), { id: 911, value: 'existing' });
	assert.deepEqual(await store.get(meta, 912), { id: 912, value: 'delete-me' });
});

test('store middleware write operations require a successful wrapped adapter call', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(MiddlewareReadRecord);
	await store.create(meta, 913, { id: 913, value: 'existing' });
	const adapter = createStoreMiddlewareAdapter(store, [
		async (operation, next) => {
			if (operation.operation !== 'create') return next();
			try {
				await next();
			} catch {
				return undefined;
			}
		}
	]);

	await assert.rejects(
		() => adapter.create(meta, 913, { id: 913, value: 'duplicate' }),
		/must call next\(\) for write operations/
	);
	assert.deepEqual(await store.get(meta, 913), { id: 913, value: 'existing' });
});

test('store middleware rejects Datastore write metadata outside payload ancestors before wrapped adapter calls', async () => {
	let createCalls = 0;
	let updateCalls = 0;
	const rawStore: StoreAdapter = {
		kind: 'middleware-datastore-write-scope-store',
		capabilities: { datastoreAncestor: true },
		get: async () => null,
		getMany: async (_model, ids) => ids.map(() => null),
		query: async () => ({ list: [], more: false }),
		create: async () => {
			createCalls++;
		},
		update: async () => {
			updateCalls++;
		},
		delete: async () => undefined
	};
	const context = createActiveTs({ stores: { default: rawStore } });
	const meta = context.meta(MiddlewareDatastoreWriteRecord);
	const store = createStoreMiddlewareAdapter(rawStore, []);
	const scopedAncestor = datastoreKey('middleware_parent', 10);
	const wrongPayload = { id: 1, parentId: 20, value: 'wrong' };

	await assert.rejects(
		() => store.create(meta, 1, wrongPayload, { meta: { datastoreAncestor: scopedAncestor } }),
		/store middleware create options Datastore ancestor does not match its payload data/
	);
	await assert.rejects(
		() => store.update(meta, 1, wrongPayload, { meta: { datastoreAncestor: scopedAncestor } }),
		/store middleware update options Datastore ancestor does not match its payload data/
	);
	assert.equal(createCalls, 0);
	assert.equal(updateCalls, 0);
});

test('store middleware transactions preserve source Datastore namespace and entity-key trust', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(MiddlewareDatastoreWriteRecord);
	const scopedAncestor = datastoreKey('middleware_parent', 10);
	const namespacedAncestor = datastoreKey('middleware_parent', 10, { namespace: 'middleware_tx_tenant' });
	const row = { id: 7, value: 'trusted transaction row' };
	Object.defineProperty(row, ACTIVE_TS_ENTITY_KEY, {
		value: datastoreKey(meta.name, 7, { parent: namespacedAncestor }),
		enumerable: false
	});
	const rootStore: StoreAdapter = {
		kind: 'middleware-datastore-transaction-store',
		datastoreNamespace: 'middleware_tx_tenant',
		datastoreProjectId: 'middleware-project',
		capabilities: { datastoreAncestor: true, transaction: true },
		get: async () => null,
		getMany: async (_model, ids) => ids.map(() => null),
		query: async () => ({ list: [], more: false }),
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined,
		transaction: async (fn) => {
			const txStore: StoreAdapter = {
				kind: 'middleware-datastore-transaction-store-tx',
				capabilities: { datastoreAncestor: true },
				get: async () => null,
				getMany: async (_model, ids) => ids.map(() => null),
				query: async () => ({ list: [row], more: false, count: 1 }),
				create: async () => undefined,
				update: async () => undefined,
				delete: async () => undefined
			};
			return await fn(txStore);
		}
	};
	markStoreTrustsDatastoreEntityKeyRows(rootStore);
	const middlewareStore = createStoreMiddlewareAdapter(rootStore, []);

	await middlewareStore.transaction!(async (tx) => {
		assert.equal(tx.datastoreNamespace, 'middleware_tx_tenant');
		assert.equal(tx.datastoreProjectId, 'middleware-project');
		assert.equal(storeTrustsDatastoreEntityKeyRows(tx), true);
		const result = await tx.query(meta, {
			where: [{ field: 'id', op: '=', value: 7 }],
			or: [],
			sort: [],
			limit: 1,
			include: [],
			meta: { datastoreAncestor: scopedAncestor }
		});

		assert.deepEqual(result.list, [{ id: 7, value: 'trusted transaction row' }]);
	});
});

test('store middleware does not trust Datastore entity keys from short-circuited read middleware', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(MiddlewareDatastoreWriteRecord);
	const scopedAncestor = datastoreKey('middleware_parent', 10);
	const row = { id: 8, parentId: 20, value: 'forged middleware row' };
	Object.defineProperty(row, ACTIVE_TS_ENTITY_KEY, {
		value: datastoreKey(meta.name, 8, { parent: scopedAncestor }),
		enumerable: false
	});
	const rawStore: StoreAdapter = {
		kind: 'middleware-short-circuit-trusted-store',
		capabilities: { datastoreAncestor: true },
		get: async () => null,
		getMany: async (_model, ids) => ids.map(() => null),
		query: async () => ({ list: [], more: false }),
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	markStoreTrustsDatastoreEntityKeyRows(rawStore);
	const store = createStoreMiddlewareAdapter(rawStore, [
		async (operation, next) => {
			if (operation.operation !== 'query') return await next();
			return { list: [row], more: false };
		}
	]);

	await assert.rejects(
		() =>
			store.query(meta, {
				where: [{ field: 'id', op: '=', value: 8 }],
				or: [],
				sort: [],
				limit: 1,
				include: [],
				meta: { datastoreAncestor: scopedAncestor }
			}),
		/resolved outside the scoped Datastore ancestor/
	);
});

test('model reads strip untrusted Datastore entity keys before later writes', async () => {
	const updates: Array<{ data: unknown; options: unknown }> = [];
	const forgedParent = datastoreKey('middleware_parent', 99);
	const row = { id: 8, parentId: 10, value: 'loaded with forged key' };
	const context = createActiveTs({
		stores: {
			default: {
				kind: 'untrusted-datastore-row-store',
				capabilities: { datastoreAncestor: true },
				get: async () => null,
				getMany: async (_model, ids) => ids.map(() => null),
				query: async () => ({
					list: [
						Object.defineProperty(row, ACTIVE_TS_ENTITY_KEY, {
							value: datastoreKey('adapter_middleware_datastore_write_regression', 8, { parent: forgedParent }),
							enumerable: false
						})
					],
					more: false
				}),
				create: async () => undefined,
				update: async (_model, _id, data, options) => {
					updates[updates.length] = { data, options };
				},
				delete: async () => undefined
			}
		}
	});
	const previous = getCurrentDefaultContext();
	const scopedAncestor = datastoreKey('middleware_parent', 10);
	setDefaultContext(context);
	try {
		const result = await MiddlewareDatastoreWriteRecord.ancestor(scopedAncestor).where({ id: 8 }).load();
		assert.equal(result.list.length, 1);
		assert.equal(Object.getOwnPropertyDescriptor(result.list[0].data, ACTIVE_TS_ENTITY_KEY), undefined);
		result.list[0].data.value = 'updated with payload ancestor';

		await result.list[0].save();

		assert.equal(updates.length, 1);
		assert.deepEqual(updates[0].data, { id: 8, parentId: 10, value: 'updated with payload ancestor' });
		assert.deepEqual((updates[0].options as any)?.meta?.datastoreAncestor, scopedAncestor);
	} finally {
		if (previous) setDefaultContext(previous);
		else clearDefaultContext();
	}
});

test('store middleware rejects mutated trusted Datastore entity keys after next', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(MiddlewareDatastoreWriteRecord);
	const originalAncestor = datastoreKey('middleware_parent', 10);
	const forgedAncestor = datastoreKey('middleware_parent', 11);
	const row = Object.defineProperty(
		{ id: 9, parentId: 10, value: 'trusted original row' },
		ACTIVE_TS_ENTITY_KEY,
		{
			value: datastoreKey(meta.name, 9, { parent: originalAncestor }),
			enumerable: false,
			configurable: true
		}
	);
	const rawStore: StoreAdapter = {
		kind: 'middleware-mutated-trusted-row-store',
		capabilities: { datastoreAncestor: true },
		get: async () => null,
		getMany: async (_model, ids) => ids.map(() => null),
		query: async () => ({ list: [row], more: false }),
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	markStoreTrustsDatastoreEntityKeyRows(rawStore);
	const store = createStoreMiddlewareAdapter(rawStore, [
		async (operation, next) => {
			const result = await next();
			if (operation.operation === 'query') {
				delete (row as any).parentId;
				Object.defineProperty(row, ACTIVE_TS_ENTITY_KEY, {
					value: datastoreKey(meta.name, 9, { parent: forgedAncestor }),
					enumerable: false,
					configurable: true
				});
			}
			return result;
		}
	]);

	await assert.rejects(
		() =>
			store.query(meta, {
				where: [{ field: 'id', op: '=', value: 9 }],
				or: [],
				sort: [],
				limit: 1,
				include: [],
				meta: { datastoreAncestor: forgedAncestor }
			}),
		/active-ts entity key changed after store middleware next\(\)/
	);
});

test('search middleware deletes preflight Datastore physical document identity', async () => {
	const rawSearch: SearchAdapter = {
		kind: 'middleware-datastore-delete-search',
		capabilities: { index: true },
		search: async () => ({ list: [], count: 0 }),
		index: async () => undefined,
		delete: async () => {
			throw new Error('ambiguous Datastore delete reached wrapped adapter');
		}
	};
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { 'middleware-datastore-delete-search': rawSearch }
	});
	const meta = context.meta(MiddlewareDatastoreSearchRecord);
	let layerCalls = 0;
	const search = createSearchMiddlewareAdapter(rawSearch, [
		async (_operation, next) => {
			layerCalls++;
			return await next();
		}
	]);

	await assert.rejects(
		() => search.delete(meta, 1),
		/Search document identity for Datastore model "adapter_middleware_datastore_search_regression" requires ancestor metadata/
	);
	assert.equal(layerCalls, 0);
});

test('search middleware deletes allow forced Datastore physical document identity metadata', async () => {
	const deletes: Array<{ id: number | string; identity?: string }> = [];
	const rawSearch: SearchAdapter = {
		kind: 'middleware-datastore-delete-search',
		capabilities: { index: true },
		search: async () => ({ list: [], count: 0 }),
		index: async () => undefined,
		delete: async (model, id) => {
			deletes[deletes.length] = { id, identity: model.searchDocumentIdentity };
		}
	};
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { 'middleware-datastore-delete-search': rawSearch }
	});
	const meta = context.meta(MiddlewareDatastoreSearchRecord);
	const forcedIdentity = 'middleware-datastore-delete-search:middleware_parent:number:10:id:number:1';
	const search = createSearchMiddlewareAdapter(rawSearch, []);

	await search.delete({ ...meta, searchDocumentIdentity: forcedIdentity }, 1);

	assert.deepEqual(deletes, [{ id: 1, identity: forcedIdentity }]);
});

test('middleware adapters ignore patched Array map during normalization and execution', async () => {
	const store = new MemoryStoreAdapter();
	const cache = new MemoryCacheAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(MiddlewareReadRecord);
	const search: SearchAdapter = {
		kind: 'map-hardened-search',
		capabilities: { index: true, where: true, whereOperators: { textContains: true } },
		search: async () => ({ list: [{ id: 902, value: 'search' }] }),
		index: async () => undefined,
		delete: async () => undefined
	};
	const map = Object.getOwnPropertyDescriptor(Array.prototype, 'map')!;
	Object.defineProperty(Array.prototype, 'map', {
		configurable: true,
		value() {
			throw new Error('patched Array.map');
		}
	});
	try {
		const storeAdapter = createStoreMiddlewareAdapter(store, [
			async (_operation, next) => next()
		]);
		await storeAdapter.create(meta, 902, { id: 902, value: 'store' });
		assert.deepEqual(await storeAdapter.getMany(meta, [902]), [{ id: 902, value: 'store' }]);
		assert.deepEqual(
			await storeAdapter.query(meta, { where: [], or: [], sort: [], include: [] }),
			{ list: [{ id: 902, value: 'store' }], cursor: undefined, more: false, count: 1, total: undefined }
		);

		const cacheAdapter = createCacheMiddlewareAdapter(cache, [
			async (_operation, next) => next()
		]);
		await cacheAdapter.setMany([['middleware-map-key', { id: 902, value: 'cache' }]], { ttl: 60 });
		assert.deepEqual(await cacheAdapter.getMany(['middleware-map-key']), [{ id: 902, value: 'cache' }]);
		await cacheAdapter.deleteMany(['middleware-map-key']);
		assert.deepEqual(await cacheAdapter.getMany(['middleware-map-key']), [undefined]);

		const searchAdapter = createSearchMiddlewareAdapter(search, [
			async (_operation, next) => next()
		]);
		assert.deepEqual(
			await searchAdapter.search(meta, 'search', { where: { value: ['textContains', 'sea'] as any } }),
			{ list: [{ id: 902, value: 'search' }], cursor: undefined, more: undefined, count: 1, total: undefined }
		);
		await searchAdapter.index(meta, 902, { id: 902, value: 'search' });
		await searchAdapter.delete(meta, 902);
	} finally {
		Object.defineProperty(Array.prototype, 'map', map);
	}
});
