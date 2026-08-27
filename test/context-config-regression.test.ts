import test from 'node:test';
import assert from 'node:assert/strict';
import {
	ActiveContext,
	MemoryCacheAdapter,
	MemorySearchAdapter,
	MemoryStoreAdapter,
	Model,
	clearDefaultContext,
	createActiveTs,
	defineModel,
	datastoreKey,
	mergeHooks,
	sanitizeHooks,
	setDefaultContext,
	type CacheAdapter,
	type FieldCodec,
	type ResolvedModelMeta,
	type SchemaPlan,
	type SearchAdapter,
	type StoreAdapter
} from '../src/index.js';
import { createNativeSearchAdapter } from '../src/adapters/search/native.js';

function config(overrides: Record<string, unknown> = {}) {
	return {
		stores: { default: new MemoryStoreAdapter() },
		...overrides
	};
}

class BoundContextConfigRecord extends Model<{ id: number }> {}
class PlannerContextConfigRecord extends Model<{ id: number; value: string }> {}
class DirectCodecRouteRecord extends Model<{ id: number; token: string; score: number }> {}
class DirectNoQueryCodecRouteRecord extends Model<{ id: number; token: string }> {}
class TransactionSchemaStoreARecord extends Model<{ id: number }> {}
class TransactionSchemaStoreBRecord extends Model<{ id: number }> {}
class TransactionSchemaSearchRecord extends Model<{ id: number; title: string }> {}
class RuntimeContextSetRecord extends Model<{ id: number; value: string }> {}
class RuntimeContextWeakMapRecord extends Model<{ id: number; value: string }> {}
class ContextHandleSearchRecord extends Model<{ id: number; title: string }> {}
class ContextDatastoreWriteRecord extends Model<{ id: number; parentId: number; value: string }> {}

defineModel<{ id: number; value: string }>('planner_context_config_record')
	.id('id')
	.validate((input) => input as { id: number; value: string })
	.attach(PlannerContextConfigRecord);

const routeTokenCodec: FieldCodec = {
	name: 'route-token-codec',
	encode: (value) => `stored:${String(value)}`,
	decode: (value) => String(value).replace(/^stored:/, ''),
	encodeQuery: (value) => `stored:${String(value)}`
};

defineModel<{ id: number; token: string; score: number }>('direct_codec_route_record')
	.id('id')
	.validate((input) => input as { id: number; token: string; score: number })
	.fieldCodec('token', routeTokenCodec)
	.attach(DirectCodecRouteRecord);

defineModel<{ id: number; token: string }>('direct_no_query_codec_route_record')
	.id('id')
	.validate((input) => input as { id: number; token: string })
	.fieldCodec('token', {
		name: 'route-no-query-token-codec',
		encode: (value) => `stored:${String(value)}`,
		decode: (value) => String(value).replace(/^stored:/, '')
	})
	.attach(DirectNoQueryCodecRouteRecord);

defineModel<{ id: number }>({ name: 'transaction_schema_store_a_record', store: 'a' })
	.id('id')
	.validate((input) => input as { id: number })
	.attach(TransactionSchemaStoreARecord);

defineModel<{ id: number }>({ name: 'transaction_schema_store_b_record', store: 'b' })
	.id('id')
	.validate((input) => input as { id: number })
	.attach(TransactionSchemaStoreBRecord);

defineModel<{ id: number; title: string }>({ name: 'transaction_schema_search_record', search: 'tx-search' })
	.id('id')
	.validate((input) => input as { id: number; title: string })
	.search('tx-search', ['title'])
	.attach(TransactionSchemaSearchRecord);

defineModel<{ id: number; title: string }>('context_handle_search_record')
	.id('id')
	.validate((input) => input as { id: number; title: string })
	.search('default', ['title'])
	.attach(ContextHandleSearchRecord);

defineModel<{ id: number; parentId: number; value: string }>('context_datastore_write_record')
	.id('id')
	.validate((input) => input as { id: number; parentId: number; value: string })
	.datastore({
		ancestor: ({ data }) => data?.parentId === undefined ? undefined : datastoreKey('context_parent', data.parentId),
		ancestorFields: ['parentId']
	})
	.attach(ContextDatastoreWriteRecord);

defineModel<{ id: number; value: string }>({ name: 'runtime_context_set_record', cache: { ttl: 60 } })
	.id('id')
	.validate((input) => input as { id: number; value: string })
	.attach(RuntimeContextSetRecord);

defineModel<{ id: number; value: string }>({ name: 'runtime_context_weakmap_record', cache: { ttl: 60 } })
	.id('id')
	.validate((input) => input as { id: number; value: string })
	.attach(RuntimeContextWeakMapRecord);

class RuntimeSetCache implements CacheAdapter {
	readonly kind = 'runtime-set-cache';
	failDeletes = 0;
	private readonly entries = new Map<string, unknown>();

	async getMany(keys: string[]) {
		return keys.map((key) => this.entries.get(key));
	}

	async setMany(entries: Array<[string, unknown]>) {
		for (const [key, value] of entries) this.entries.set(key, structuredClone(value));
	}

	async deleteMany(keys: string[]) {
		if (this.failDeletes > 0) {
			this.failDeletes--;
			throw new Error('runtime cache delete failed');
		}
		for (const key of keys) this.entries.delete(key);
	}
}

test('createActiveTs validates top-level and optional config shapes', () => {
	assert.throws(() => createActiveTs(null as any), /active-ts config must be a plain object/);
	assert.throws(() => createActiveTs([] as any), /active-ts config must be a plain object/);
	assert.throws(
		() => createActiveTs({ stores: { default: new MemoryStoreAdapter(), [Symbol('extra')]: new MemoryStoreAdapter() } as any }),
		/store adapter name registry cannot contain symbol adapter names/
	);
	assert.throws(
		() =>
			createActiveTs({
				stores: { default: new MemoryStoreAdapter() },
				caches: { default: new MemoryCacheAdapter(), [Symbol('extra')]: new MemoryCacheAdapter() } as any
			}),
		/cache adapter name registry cannot contain symbol adapter names/
	);
	assert.throws(
		() =>
			createActiveTs({
				stores: { default: new MemoryStoreAdapter() },
				search: { default: new MemorySearchAdapter(), [Symbol('extra')]: new MemorySearchAdapter() } as any
			}),
		/search adapter name registry cannot contain symbol adapter names/
	);
	assert.throws(
		() => createActiveTs({ stores: { default: new MemoryStoreAdapter() }, caches: null as any }),
		/cache adapter name registry must be an object/
	);
	assert.throws(
		() => createActiveTs({ stores: { default: new MemoryStoreAdapter() }, search: null as any }),
		/search adapter name registry must be an object/
	);
	let optionReads = 0;
	const accessorConfig = Object.defineProperty({}, 'stores', {
		enumerable: true,
		get() {
			optionReads++;
			return { default: new MemoryStoreAdapter() };
		}
	});
	assert.throws(
		() => createActiveTs(accessorConfig as any),
		/active-ts config\.stores must be a data property/
	);
	assert.equal(optionReads, 0);
	const hiddenConfig = Object.defineProperty({}, 'stores', {
		enumerable: false,
		value: { default: new MemoryStoreAdapter() }
	});
	assert.throws(
		() => createActiveTs(hiddenConfig as any),
		/active-ts config\.stores must be enumerable/
	);
	const accessorRegistry = Object.defineProperty({}, 'default', {
		enumerable: true,
		get() {
			optionReads++;
			return new MemoryStoreAdapter();
		}
	});
	assert.throws(
		() => createActiveTs({ stores: accessorRegistry } as any),
		/store adapter name registry\.default must be a data property/
	);
	assert.equal(optionReads, 0);
	const hiddenRegistry = Object.defineProperty({}, 'default', {
		enumerable: false,
		value: new MemoryStoreAdapter()
	});
	assert.throws(
		() => createActiveTs({ stores: hiddenRegistry } as any),
		/store adapter name registry\.default must be enumerable/
	);
	Object.defineProperty(Object.prototype, 'default', {
		value: 'polluted-default-adapter',
		writable: false,
		configurable: true
	});
	try {
		const pollutedContext = createActiveTs({
			stores: { default: new MemoryStoreAdapter() },
			caches: { default: new MemoryCacheAdapter() },
			search: { default: new MemorySearchAdapter() },
			defaultSearch: 'default'
		});
		assert.ok(pollutedContext instanceof ActiveContext);
	} finally {
		delete (Object.prototype as Record<string, unknown>).default;
	}
	const accessorSchema = Object.defineProperty({}, 'autoSync', {
		enumerable: true,
		get() {
			optionReads++;
			return 'safe';
		}
	});
	assert.throws(
		() => createActiveTs(config({ schema: accessorSchema }) as any),
		/schema\.autoSync must be a data property/
	);
	assert.equal(optionReads, 0);
	const hiddenSchema = Object.defineProperty({}, 'autoSync', {
		enumerable: false,
		value: 'safe'
	});
	assert.throws(
		() => createActiveTs(config({ schema: hiddenSchema }) as any),
		/schema\.autoSync must be enumerable/
	);
	assert.throws(() => createActiveTs(config({ lazyWarnings: 'yes' }) as any), /lazyWarnings must be a boolean/);
	assert.throws(
		() => createActiveTs(config({ defaultStor: 'other' }) as any),
		/active-ts config contains unknown option "defaultStor"/
	);
	assert.throws(() => createActiveTs(config({ schema: null }) as any), /schema must be a plain object/);
	assert.throws(() => createActiveTs(config({ schema: { autoSync: 'force' } }) as any), /schema.autoSync/);
	assert.throws(
		() => createActiveTs(config({ schema: { autosync: 'safe' } }) as any),
		/schema contains unknown option "autosync"/
	);
	assert.throws(() => createActiveTs(config({ batch: [] }) as any), /batch must be a plain object/);
	assert.throws(
		() => createActiveTs(config({ batch: { maxsize: 10 } }) as any),
		/batch contains unknown option "maxsize"/
	);
	let batchCoercionCalls = 0;
	const hostileBatchSize = {
		toString() {
			batchCoercionCalls++;
			throw new Error('batch maxSize coercion should not run');
		}
	};
	assert.throws(
		() => createActiveTs(config({ batch: { maxSize: hostileBatchSize } }) as any),
		/batch.maxSize must be a positive safe integer/
	);
	assert.equal(batchCoercionCalls, 0);
	assert.throws(
		() => createActiveTs(config({ aggregate: { allowQueryFallback: 'yes' } }) as any),
		/aggregate.allowQueryFallback must be a boolean/
	);
	assert.throws(
		() => createActiveTs(config({ aggregate: { allowFallback: true } }) as any),
		/aggregate contains unknown option "allowFallback"/
	);
	assert.throws(
		() => createActiveTs(config({ queryPlanner: { routeQuery: 'store' } }) as any),
		/queryPlanner.routeQuery must be a function/
	);
	assert.throws(
		() => createActiveTs(config({ queryPlanner: { routequery: () => 'default' } }) as any),
		/queryPlanner contains unknown option "routequery"/
	);
	assert.throws(
		() => createActiveTs(config({ queryPlanner: { schemaSearchAdapters: 'search' } }) as any),
		/queryPlanner\.schemaSearchAdapters must be an array or a function/
	);
	assert.throws(
		() => createActiveTs(config({ queryPlanner: { schemaSearchAdapters: ['search', 'search'] } }) as any),
		/queryPlanner\.schemaSearchAdapters contains duplicate search adapter "search"/
	);
	assert.throws(() => createActiveTs(config({ cacheKey: 'cache' }) as any), /cacheKey must be a function/);
	assert.throws(() => new ActiveContext(config(), null as any), /ActiveContext options must be a plain object/);
	assert.throws(
		() => new ActiveContext(config(), { skipPluginSetup: 'yes' } as any),
		/ActiveContext options\.skipPluginSetup must be a boolean/
	);
	assert.throws(
		() => new ActiveContext(config(), { skipPlugins: true } as any),
		/ActiveContext options contains unknown option "skipPlugins"/
	);
	assert.doesNotThrow(() =>
		createActiveTs(config({
			lazyWarnings: false,
			schema: { autoSync: 'safe' },
			batch: { maxSize: 10 },
			aggregate: { allowQueryFallback: false },
			queryPlanner: { routeQuery: () => undefined, schemaSearchAdapters: ['default'] },
			cacheKey: ({ baseKey }: any) => baseKey
		}) as any)
	);
});

test('context option, capability, and hook payload allowlists use captured Set intrinsics', async () => {
	const originalHas = Set.prototype.has;
	const originalAdd = Set.prototype.add;
	const typoStore = new MemoryStoreAdapter() as any;
	Object.defineProperty(typoStore, 'capabilities', {
		enumerable: true,
		configurable: true,
		value: { ...typoStore.capabilities, typo: true }
	});

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
		assert.throws(
			() => createActiveTs(config({ defaultStor: 'default' }) as any),
			/active-ts config contains unknown option "defaultStor"/
		);
		assert.throws(
			() => new ActiveContext(config(), { skipPlugins: true } as any),
			/ActiveContext options contains unknown option "skipPlugins"/
		);
		assert.throws(
			() => createActiveTs({ stores: { default: typoStore } } as any),
			/store adapter name "default"\.capabilities contains unknown capability "typo"/
		);
		const context = createActiveTs(config());
		await assert.rejects(
			() => context.runHooks('beforeQuery', { operation: 'query', typo: true } as any),
			/Hook payload key "typo" is not recognized/
		);
	} finally {
		Object.defineProperty(Set.prototype, 'has', { configurable: true, value: originalHas });
		Object.defineProperty(Set.prototype, 'add', { configurable: true, value: originalAdd });
	}
});

test('context search where operator capability allowlist ignores patched Array includes', () => {
	const includes = Object.getOwnPropertyDescriptor(Array.prototype, 'includes')!;
	const search: SearchAdapter = {
		kind: 'array-includes-context-search',
		capabilities: { where: true, whereOperators: { textContains: true } },
		search: async () => ({ list: [] }),
		index: async () => undefined,
		delete: async () => undefined
	};

	Object.defineProperty(Array.prototype, 'includes', {
		configurable: true,
		value() {
			throw new Error('patched Array.includes');
		}
	});
	try {
		assert.doesNotThrow(() =>
			createActiveTs({
				stores: { default: new MemoryStoreAdapter() },
				search: { default: search }
			})
		);
	} finally {
		Object.defineProperty(Array.prototype, 'includes', includes);
	}
});

test('context config, schema migration, and transaction paths ignore patched collection transforms', async () => {
	const store = new MemoryStoreAdapter();
	const native = createNativeSearchAdapter(store);
	const filteredSearch: SearchAdapter = {
		kind: 'context-array-transform-search',
		capabilities: { where: true, whereOperators: { textContains: true } },
		search: async () => ({ list: [] }),
		index: async () => undefined,
		delete: async () => undefined
	};
	const arrayMap = Array.prototype.map;
	const arrayFlatMap = Array.prototype.flatMap;
	const arrayFind = Array.prototype.find;
	const objectEntries = Object.entries;
	Object.defineProperty(Array.prototype, 'map', {
		configurable: true,
		value() {
			throw new Error('patched Array.map');
		}
	});
	Object.defineProperty(Array.prototype, 'flatMap', {
		configurable: true,
		value() {
			throw new Error('patched Array.flatMap');
		}
	});
	Object.defineProperty(Array.prototype, 'find', {
		configurable: true,
		value() {
			throw new Error('patched Array.find');
		}
	});
	Object.defineProperty(Object, 'entries', {
		configurable: true,
		value() {
			throw new Error('patched Object.entries');
		}
	});
	let migration;
	let transactionResult;
	try {
		const context = createActiveTs({
			stores: {
				default: store,
				other: new MemoryStoreAdapter()
			},
			search: {
				default: native,
				filtered: filteredSearch
			},
			plugins: [{ name: 'array-transform-plugin' }]
		});
		migration = await context.schemaMigration([PlannerContextConfigRecord], 'array_transform_migration');
		transactionResult = await context.transaction(async () => 'committed');
	} finally {
		Object.defineProperty(Array.prototype, 'map', { configurable: true, value: arrayMap });
		Object.defineProperty(Array.prototype, 'flatMap', { configurable: true, value: arrayFlatMap });
		Object.defineProperty(Array.prototype, 'find', { configurable: true, value: arrayFind });
		Object.defineProperty(Object, 'entries', { configurable: true, value: objectEntries });
	}
	assert.equal(transactionResult, 'committed');
	assert.deepEqual(migration?.summary, ['default:create-collection:planner_context_config_record']);
});

test('context runtime Set, WeakSet, and WeakMap state uses captured intrinsics', async () => {
	const cache = new RuntimeSetCache();
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache }
	});
	const Record = RuntimeContextSetRecord.use(context) as unknown as typeof RuntimeContextSetRecord;
	await Record.create({ id: 1, value: 'seed' });
	const cached = await Record.find(1).load();
	assert.equal(cached?.data.value, 'seed');
	const meta = context.meta(RuntimeContextSetRecord);
	await store.update(meta, 1, { id: 1, value: 'saved' });

	const originalSetHas = Set.prototype.has;
	const originalSetAdd = Set.prototype.add;
	const originalSetDelete = Set.prototype.delete;
	const originalWeakSetHas = WeakSet.prototype.has;
	const originalWeakSetAdd = WeakSet.prototype.add;
	const originalWeakMapGet = WeakMap.prototype.get;
	const originalWeakMapSet = WeakMap.prototype.set;
	const originalWeakMapDelete = WeakMap.prototype.delete;
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
	Object.defineProperty(Set.prototype, 'delete', {
		configurable: true,
		value() {
			throw new Error('patched Set.delete');
		}
	});
	Object.defineProperty(WeakSet.prototype, 'has', {
		configurable: true,
		value() {
			throw new Error('patched WeakSet.has');
		}
	});
	Object.defineProperty(WeakSet.prototype, 'add', {
		configurable: true,
		value() {
			throw new Error('patched WeakSet.add');
		}
	});
	Object.defineProperty(WeakMap.prototype, 'get', {
		configurable: true,
		value() {
			throw new Error('patched WeakMap.get');
		}
	});
	Object.defineProperty(WeakMap.prototype, 'set', {
		configurable: true,
		value() {
			throw new Error('patched WeakMap.set');
		}
	});
	Object.defineProperty(WeakMap.prototype, 'delete', {
		configurable: true,
		value() {
			throw new Error('patched WeakMap.delete');
		}
	});
	try {
		const WeakMapRecord = RuntimeContextWeakMapRecord.use(context) as unknown as typeof RuntimeContextWeakMapRecord;
		assert.equal(context.meta(RuntimeContextWeakMapRecord).name, 'runtime_context_weakmap_record');
		assert.equal(await WeakMapRecord.find(999).load(), null);

		cache.failDeletes = 1;
		await assert.rejects(() => context.invalidate(meta, 1), /runtime cache delete failed/);
		await context.invalidate(meta, 1);
		const afterFailedInvalidation = await Record.find(1).load();
		assert.equal(afterFailedInvalidation?.data.value, 'saved');

		const result = await context.transaction(async (tx) => {
			await tx.invalidate(tx.meta(RuntimeContextSetRecord), 1);
			const row = tx.instantiate(RuntimeContextSetRecord, { id: 2, value: 'tx' });
			return { row, nested: [row] };
		});
		assert.ok(result.row);
		assert.equal(result.row.data.value, 'tx');
	} finally {
		Object.defineProperty(Set.prototype, 'has', { configurable: true, value: originalSetHas });
		Object.defineProperty(Set.prototype, 'add', { configurable: true, value: originalSetAdd });
		Object.defineProperty(Set.prototype, 'delete', { configurable: true, value: originalSetDelete });
		Object.defineProperty(WeakSet.prototype, 'has', { configurable: true, value: originalWeakSetHas });
		Object.defineProperty(WeakSet.prototype, 'add', { configurable: true, value: originalWeakSetAdd });
		Object.defineProperty(WeakMap.prototype, 'get', { configurable: true, value: originalWeakMapGet });
		Object.defineProperty(WeakMap.prototype, 'set', { configurable: true, value: originalWeakMapSet });
		Object.defineProperty(WeakMap.prototype, 'delete', { configurable: true, value: originalWeakMapDelete });
	}

	assert.equal((await Record.find(1).load())?.data.value, 'saved');
});

test('context runtime Map state uses captured intrinsics', async () => {
	const rows = [{ id: 7, value: 'from map-safe store' }];
	const store: StoreAdapter = {
		kind: 'runtime-map-store',
		capabilities: {},
		get: async (_model, id) => rows.find((row) => row.id === id) ?? null,
		getMany: async (_model, ids) => ids.map((id) => rows.find((row) => row.id === id) ?? null),
		query: async () => ({ list: [], more: false }),
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	const cache: CacheAdapter = {
		kind: 'runtime-map-cache',
		getMany: async (keys) => keys.map(() => undefined),
		setMany: async () => undefined,
		deleteMany: async () => undefined
	};
	const search: SearchAdapter = {
		kind: 'runtime-map-search',
		capabilities: {},
		search: async () => ({ list: [], more: false }),
		index: async () => undefined,
		delete: async () => undefined
	};
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache },
		search: { default: search }
	});
	const meta = context.meta(RuntimeContextSetRecord);
	const originalMapGet = Map.prototype.get;
	const originalMapHas = Map.prototype.has;
	const originalMapSet = Map.prototype.set;
	Object.defineProperty(Map.prototype, 'get', {
		configurable: true,
		value() {
			throw new Error('patched Map.get');
		}
	});
	Object.defineProperty(Map.prototype, 'has', {
		configurable: true,
		value() {
			throw new Error('patched Map.has');
		}
	});
	Object.defineProperty(Map.prototype, 'set', {
		configurable: true,
		value() {
			throw new Error('patched Map.set');
		}
	});
	try {
		assert.equal(context.store('default').kind, 'runtime-map-store');
		assert.equal(context.cache('default')?.kind, 'runtime-map-cache');
		assert.equal(context.searchAdapter('default').kind, 'runtime-map-search');
		const Record = RuntimeContextSetRecord.use(context) as unknown as typeof RuntimeContextSetRecord;
		assert.equal((await Record.find(7).load())?.data.value, 'from map-safe store');

		const txState = {
			root: context,
			storeName: 'default',
			internalAfterCommit: [],
			afterCommit: [],
			afterRollback: [],
			modelInstances: new Set<object>(),
			dirtyCacheKeys: new Set<string>(),
			cacheInvalidations: new Map<string, { meta: ResolvedModelMeta; id: number }>(),
			cacheKeyOwners: new Map<string, string>(),
			entityCacheKeys: new Map<string, string>(),
			callbackOperationState: {},
			callbackOperations: {
				track: <T>(run: () => Promise<T>) => run(),
				hasPendingOperations: () => false,
				waitForPendingOperations: async () => undefined
			}
		};
		(context as any).transactionState = txState;
		await context.invalidate(meta, 1);
		assert.equal(txState.internalAfterCommit.length, 1);
		(context as any).transactionState = undefined;

		await context.invalidate(meta, 1);
	} finally {
		(context as any).transactionState = undefined;
		Object.defineProperty(Map.prototype, 'get', { configurable: true, value: originalMapGet });
		Object.defineProperty(Map.prototype, 'has', { configurable: true, value: originalMapHas });
		Object.defineProperty(Map.prototype, 'set', { configurable: true, value: originalMapSet });
	}
});

test('context adapter registration rejects accessor members without invoking them', () => {
	let memberReads = 0;
	const accessorStore: any = {
		kind: 'accessor-store',
		capabilities: {},
		getMany: async () => [],
		query: async () => ({ list: [], more: false }),
		create: async () => {},
		update: async () => {},
		delete: async () => {}
	};
	Object.defineProperty(accessorStore, 'get', {
		enumerable: true,
		get() {
			memberReads++;
			return async () => null;
		}
	});
	assert.throws(
		() => createActiveTs({ stores: { default: accessorStore } } as any),
		/store adapter name "default"\.get must be a data property/
	);
	assert.equal(memberReads, 0);

	const accessorCapabilities = Object.defineProperty({}, 'or', {
		enumerable: true,
		get() {
			memberReads++;
			return true;
		}
	});
	const capabilityStore = new MemoryStoreAdapter() as any;
	capabilityStore.capabilities = accessorCapabilities;
	assert.throws(
		() => createActiveTs({ stores: { default: capabilityStore } } as any),
		/store adapter name "default"\.capabilities\.or must be a data property/
	);
	assert.equal(memberReads, 0);

	const accessorWhereOperators = Object.defineProperty({ '=': true }, 'textContains', {
		enumerable: true,
		get() {
			memberReads++;
			return true;
		}
	});
	const accessorSearch: any = {
		kind: 'accessor-search-capability',
		capabilities: { where: true, whereOperators: accessorWhereOperators },
		search: async () => ({ list: [], more: false }),
		index: async () => undefined,
		delete: async () => undefined
	};
	assert.throws(
		() => createActiveTs({ stores: { default: new MemoryStoreAdapter() }, search: { default: accessorSearch } } as any),
		/search adapter name "default"\.capabilities\.whereOperators\.textContains must be a data property/
	);
	assert.equal(memberReads, 0);
	assert.throws(
		() =>
			createActiveTs({
				stores: { default: new MemoryStoreAdapter() },
				search: {
					default: {
						...accessorSearch,
						capabilities: { where: true, whereOperators: { [Symbol('=')]: true } }
					}
				}
			} as any),
		/search adapter name "default"\.capabilities\.whereOperators cannot contain symbol fields/
	);
});

test('context store handles sanitize direct read and write boundaries', async () => {
	const sourceRow = { id: 1, value: 'safe' };
	let mode:
		| 'ok'
		| 'undefined-get'
		| 'wrong-get'
		| 'wrong-many'
		| 'short-many'
		| 'sparse-many'
		| 'wrong-query'
		| 'duplicate-query'
		| 'cursor-query'
		| 'extra-aggregate' = 'ok';
	let createCalls = 0;
	let createData: any;
	let updateOptions: unknown;
	let deleteOptions: unknown;
	const store: StoreAdapter = {
		kind: 'context-direct-boundary-store',
		capabilities: { aggregate: true, optimisticLock: true },
		get: async () => {
			if (mode === 'undefined-get') return undefined as any;
			if (mode === 'wrong-get') return { id: 2, value: 'wrong' };
			return sourceRow;
		},
		getMany: async () => {
			if (mode === 'wrong-many') return [{ id: 2, value: 'wrong' }];
			if (mode === 'short-many') return [{ id: 1, value: 'one' }];
			if (mode === 'sparse-many') return new Array(1) as any;
			return [{ id: 1, value: 'one' }, null];
		},
		query: async () => {
			if (mode === 'wrong-query') return { list: [{ value: 'missing-id' }], more: false };
			if (mode === 'duplicate-query') return { list: [{ id: 1, value: 'a' }, { id: 1, value: 'b' }], more: false };
			if (mode === 'cursor-query') return { list: [], more: false, cursor: 'native-cursor' };
			return { list: [{ id: 1, value: 'queried' }], more: false };
		},
		aggregate: async (): Promise<any> => {
			if (mode === 'extra-aggregate') return { total: 1, unexpected: 2 };
			return { total: 1 };
		},
		create: async (_model, _id, data) => {
			createCalls++;
			createData = data;
			data.value = 'adapter-mutated';
		},
		update: async (_model, _id, data, options) => {
			data.value = 'adapter-mutated';
			updateOptions = options;
		},
		delete: async (_model, _id, options) => {
			deleteOptions = options;
		}
	};
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(PlannerContextConfigRecord);
	const handle = context.store('default');

	const row = await handle.get(meta, 1);
	assert.deepEqual(row, { id: 1, value: 'safe' });
	(row as any).value = 'caller-mutated';
	assert.equal(sourceRow.value, 'safe');

	mode = 'undefined-get';
	await assert.rejects(() => handle.get(meta, 1), /context store get result must be a plain object or null/);
	mode = 'wrong-get';
	await assert.rejects(() => handle.get(meta, 1), /context store get result id field "id" must match/);

	mode = 'wrong-many';
	await assert.rejects(() => handle.getMany(meta, [1]), /context store getMany result\[0\] id field "id" must match/);
	mode = 'short-many';
	await assert.rejects(() => handle.getMany(meta, [1, 2]), /context store getMany result must contain 2 entries/);
	mode = 'sparse-many';
	await assert.rejects(() => handle.getMany(meta, [1]), /context store getMany result\[0\] is missing/);

	mode = 'wrong-query';
	await assert.rejects(
		() => handle.query(meta, { where: [], or: [], sort: [], include: [] }),
		/context store query result\.list\[0\] is missing id field "id"/
	);
	mode = 'duplicate-query';
	await assert.rejects(
		() => handle.query(meta, { where: [], or: [], sort: [], include: [] }),
		/context store query result contains duplicate id "1"/
	);
	mode = 'cursor-query';
	await assert.rejects(
		() => handle.query(meta, { where: [], or: [], sort: [], include: [] }),
		/does not support returning portable cursors/
	);
	mode = 'extra-aggregate';
	await assert.rejects(
		() => handle.aggregate!(meta, { where: [], or: [], aggregates: [{ op: 'count', as: 'total' }] }),
		/context store aggregate result result contains unknown option "unexpected"/
	);

	const createInput = { id: 1, value: 'created' };
	await handle.create(meta, 1, createInput);
	assert.equal(createCalls, 1);
	assert.equal(createInput.value, 'created');
	assert.deepEqual(createData, { id: 1, value: 'adapter-mutated' });
	await assert.rejects(() => handle.create(meta, 1, { id: 2, value: 'wrong-id' }), /context store create data id field "id" must match the operation id/);
	await assert.rejects(
		() => handle.create(meta, 1, { id: 1, value: new Date('2026-06-13T00:00:00.000Z') } as any),
		/Unsupported stored data date/
	);
	await assert.rejects(
		() => handle.create(meta, 1, { id: 1, value: 'created' }, { expectedVersion: 1 }),
		/context store create options does not support expectedVersion/
	);

	const updateInput = { id: 1, value: 'updated' };
	await handle.update(meta, 1, updateInput, { expectedVersion: 3 });
	assert.equal(updateInput.value, 'updated');
	assert.deepEqual(updateOptions, { expectedVersion: 3 });
	await assert.rejects(
		() => handle.update(meta, 1, { id: 1, value: 'updated' }, { expectedVersion: -1 } as any),
		/context store update options\.expectedVersion/
	);
	await handle.delete(meta, 1, { expectedVersion: 4 });
	assert.deepEqual(deleteOptions, { expectedVersion: 4 });
	await assert.rejects(
		() => handle.delete(meta, 1, { expectedVersion: Number.MAX_SAFE_INTEGER + 1 } as any),
		/context store delete options\.expectedVersion/
	);
});

test('context store handles reject unsupported optimistic lock write options before adapter calls', async () => {
	let updateCalls = 0;
	let deleteCalls = 0;
	const store: StoreAdapter = {
		kind: 'context-no-cas-store',
		capabilities: { optimisticLock: false },
		get: async () => null,
		getMany: async (model, ids) => ids.map(() => null),
		query: async () => ({ list: [], more: false }),
		create: async () => undefined,
		update: async () => {
			updateCalls++;
		},
		delete: async () => {
			deleteCalls++;
		}
	};
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(PlannerContextConfigRecord);
	const handle = context.store('default');

	await assert.rejects(
		() => handle.update(meta, 1, { id: 1, value: 'updated' }, { expectedVersion: 1 }),
		/context store update options does not support expectedVersion/
	);
	await assert.rejects(
		() => handle.delete(meta, 1, { expectedVersion: 1 }),
		/context store delete options does not support expectedVersion/
	);
	assert.equal(updateCalls, 0);
	assert.equal(deleteCalls, 0);
});

test('context store handles reject unsupported Datastore ancestor write metadata before adapter calls', async () => {
	let createCalls = 0;
	let updateCalls = 0;
	let deleteCalls = 0;
	const store: StoreAdapter = {
		kind: 'context-no-datastore-ancestor-store',
		capabilities: { datastoreAncestor: false },
		get: async () => null,
		getMany: async (_model, ids) => ids.map(() => null),
		query: async () => ({ list: [], more: false }),
		create: async () => {
			createCalls++;
		},
		update: async () => {
			updateCalls++;
		},
		delete: async () => {
			deleteCalls++;
		}
	};
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(PlannerContextConfigRecord);
	const handle = context.store('default');
	const ancestor = datastoreKey('context_parent', 1);

	await assert.rejects(
		() => handle.create(meta, 1, { id: 1, value: 'created' }, { meta: { datastoreAncestor: ancestor } }),
		/context store create options does not support Datastore ancestor write metadata/
	);
	await assert.rejects(
		() => handle.create(meta, 1, { id: 1, value: 'created' }, { meta: { datastoreAncestor: undefined } }),
		/context store create options does not support Datastore ancestor write metadata/
	);
	await assert.rejects(
		() => handle.update(meta, 1, { id: 1, value: 'updated' }, { meta: { datastoreAncestor: ancestor } }),
		/context store update options does not support Datastore ancestor write metadata/
	);
	await assert.rejects(
		() => handle.delete(meta, 1, { meta: { datastoreAncestor: ancestor } }),
		/context store delete options does not support Datastore ancestor write metadata/
	);
	assert.equal(createCalls, 0);
	assert.equal(updateCalls, 0);
	assert.equal(deleteCalls, 0);
});

test('context store handles reject Datastore write metadata outside payload ancestors before adapter calls', async () => {
	let createCalls = 0;
	let updateCalls = 0;
	const txStore: StoreAdapter = {
		kind: 'context-datastore-write-scope-store:tx',
		capabilities: { datastoreAncestor: true, transaction: false },
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
	const store: StoreAdapter = {
		...txStore,
		kind: 'context-datastore-write-scope-store',
		capabilities: { datastoreAncestor: true, transaction: true },
		transaction: async (fn) => await fn(txStore)
	};
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(ContextDatastoreWriteRecord);
	const handle = context.store('default');
	const scopedAncestor = datastoreKey('context_parent', 10);
	const wrongPayload = { id: 1, parentId: 20, value: 'wrong' };

	await assert.rejects(
		() => handle.create(meta, 1, wrongPayload, { meta: { datastoreAncestor: scopedAncestor } }),
		/context store create options Datastore ancestor does not match its payload data/
	);
	await assert.rejects(
		() => handle.update(meta, 1, wrongPayload, { meta: { datastoreAncestor: scopedAncestor } }),
		/context store update options Datastore ancestor does not match its payload data/
	);
	await handle.transaction!(async (tx) => {
		await assert.rejects(
			() => tx.create(meta, 1, wrongPayload, { meta: { datastoreAncestor: scopedAncestor } }),
			/context store transaction create options Datastore ancestor does not match its payload data/
		);
		await assert.rejects(
			() => tx.update(meta, 1, wrongPayload, { meta: { datastoreAncestor: scopedAncestor } }),
			/context store transaction update options Datastore ancestor does not match its payload data/
		);
	});
	assert.equal(createCalls, 0);
	assert.equal(updateCalls, 0);
});

test('context store transaction handles sanitize transaction and callback store boundaries', async () => {
	let transactionCalls = 0;
	let nestedTransactionCalls = 0;
	let createCalls = 0;
	let updateCalls = 0;
	let deleteCalls = 0;
	const txStore: StoreAdapter = {
		kind: 'context-direct-tx-store',
		capabilities: { optimisticLock: false, transaction: true },
		get: async () => null,
		getMany: async (_model, ids) => ids.map(() => null),
		query: async () => ({ list: [], more: false }),
		create: async () => {
			createCalls++;
		},
		update: async () => {
			updateCalls++;
		},
		delete: async () => {
			deleteCalls++;
		},
		transaction: async (fn) => {
			nestedTransactionCalls++;
			return await fn(txStore);
		}
	};
	const store: StoreAdapter = {
		...txStore,
		capabilities: { transaction: true, optimisticLock: false },
		transaction: async (fn) => {
			transactionCalls++;
			return await fn(txStore);
		}
	};
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(PlannerContextConfigRecord);
	const handle = context.store('default');

	await assert.rejects(
		() => handle.transaction!(async () => undefined, { join: 'reuse' } as any),
		/context store transaction options contains unknown option "join"/
	);
	assert.equal(transactionCalls, 0);

	await handle.transaction!(async (tx) => {
		await assert.rejects(
			() => tx.create(meta, 1, { id: 1, value: 'created' }, { expectedVersion: 1 }),
			/context store transaction create options does not support expectedVersion/
		);
		await assert.rejects(
			() => tx.update(meta, 1, { id: 1, value: 'updated' }, { expectedVersion: 1 }),
			/context store transaction update options does not support expectedVersion/
		);
		await assert.rejects(
			() => tx.delete(meta, 1, { expectedVersion: 1 }),
			/context store transaction delete options does not support expectedVersion/
		);
		const ancestor = datastoreKey('context_parent', 1);
		await assert.rejects(
			() => tx.create(meta, 1, { id: 1, value: 'created' }, { meta: { datastoreAncestor: ancestor } }),
			/context store transaction create options does not support Datastore ancestor write metadata/
		);
		await assert.rejects(
			() => tx.update(meta, 1, { id: 1, value: 'updated' }, { meta: { datastoreAncestor: ancestor } }),
			/context store transaction update options does not support Datastore ancestor write metadata/
		);
		await assert.rejects(
			() => tx.delete(meta, 1, { meta: { datastoreAncestor: ancestor } }),
			/context store transaction delete options does not support Datastore ancestor write metadata/
		);
		assert.equal(tx.transaction, undefined);
		assert.equal(tx.capabilities?.transaction, false);
		assert.equal(tx.schema, undefined);
	});
	assert.equal(transactionCalls, 1);
	assert.equal(nestedTransactionCalls, 0);
	assert.equal(createCalls, 0);
	assert.equal(updateCalls, 0);
	assert.equal(deleteCalls, 0);
});

test('context cache and search handles sanitize direct boundaries', async () => {
	const cacheSource = { value: 'cached', nested: { flag: true } };
	let cacheMode: 'ok' | 'short' | 'sparse' | 'date' | 'bad-codec' = 'ok';
	let cacheSetOptions: unknown;
	let cacheSetValue: any;
	const cache: CacheAdapter = {
		kind: 'context-boundary-cache',
		getMany: async () => {
			if (cacheMode === 'short') return [];
			if (cacheMode === 'sparse') return new Array(1) as any;
			if (cacheMode === 'date') return [new Date('2026-06-13T00:00:00.000Z') as any];
			return [cacheSource];
		},
		setMany: async (entries, options) => {
			cacheSetOptions = options;
			cacheSetValue = entries[0][1];
			entries[0][1].value = 'adapter-mutated';
		},
		deleteMany: async () => undefined,
		codecKey: (key) => (cacheMode === 'bad-codec' ? '' : `coded:${key}`)
	};
	let searchMode: 'ok' | 'missing-id' | 'duplicate' | 'cursor' | 'cursor-count' | 'extra-result' = 'ok';
	let searchIndexData: any;
	let deletedId: unknown;
	const search: SearchAdapter = {
		kind: 'context-boundary-search',
		capabilities: { index: true },
		search: async () => {
			if (searchMode === 'missing-id') return { list: [{ title: 'missing' }], more: false };
			if (searchMode === 'duplicate') return { list: [{ id: 1, title: 'a' }, { id: 1, title: 'b' }], more: false };
			if (searchMode === 'cursor') return { list: [], more: false, cursor: 'native-cursor' };
			if (searchMode === 'cursor-count') return { list: [], more: false, count: 1.5, cursor: 'native-cursor' };
			if (searchMode === 'extra-result') return { list: [], more: false, totla: 1 } as any;
			return { list: [{ id: 1, title: 'found' }], more: false };
		},
		index: async (_model, _id, data) => {
			searchIndexData = data;
			data.title = 'adapter-mutated';
		},
		delete: async (_model, id) => {
			deletedId = id;
		}
	};
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		caches: { default: cache },
		search: { default: search },
		defaultSearch: 'default'
	});

	const cacheHandle = context.cache('default')!;
	const [hit] = await cacheHandle.getMany(['cache-key']);
	assert.deepEqual(hit, { value: 'cached', nested: { flag: true } });
	(hit as any).nested.flag = false;
	assert.equal(cacheSource.nested.flag, true);
	cacheMode = 'short';
	await assert.rejects(() => cacheHandle.getMany(['cache-key']), /context cache getMany result must be an array with 1 entries/);
	cacheMode = 'sparse';
	await assert.rejects(() => cacheHandle.getMany(['cache-key']), /context cache getMany result\[0\] is missing/);
	cacheMode = 'date';
	await assert.rejects(() => cacheHandle.getMany(['cache-key']), /Cache values cannot contain Date/);
	cacheMode = 'ok';
	await assert.rejects(() => cacheHandle.getMany(['']), /context cache getMany keys\[0\] cannot be empty/);
	await assert.rejects(
		() => cacheHandle.setMany([['dup', { value: 1 }], ['dup', { value: 2 }]]),
		/context cache setMany entries contains duplicate key "dup"/
	);
	await assert.rejects(
		() => cacheHandle.setMany([['cache-key', { value: new Date('2026-06-13T00:00:00.000Z') } as any]]),
		/Cache values cannot contain Date/
	);
	const cacheInput = { value: 'input' };
	await cacheHandle.setMany([['cache-key', cacheInput]], { ttl: 10 });
	assert.equal(cacheInput.value, 'input');
	assert.deepEqual(cacheSetOptions, { ttl: 10 });
	assert.deepEqual(cacheSetValue, { value: 'adapter-mutated' });
	await assert.rejects(
		() => cacheHandle.setMany([['cache-key', { value: 'input' }]], { ttl: 0 } as any),
		/context cache setMany options\.ttl/
	);
	cacheMode = 'bad-codec';
	assert.throws(() => cacheHandle.codecKey!('cache-key'), /context cache codecKey result cannot be empty/);

	const searchHandle = context.searchAdapter('default');
	const searchMeta = context.meta(ContextHandleSearchRecord);
	const result = await searchHandle.search(searchMeta, 'found', {});
	assert.deepEqual(result.list, [{ id: 1, title: 'found' }]);
	(result.list[0] as any).title = 'caller-mutated';
	searchMode = 'ok';
	assert.deepEqual((await searchHandle.search(searchMeta, 'found', {})).list, [{ id: 1, title: 'found' }]);
	searchMode = 'missing-id';
	await assert.rejects(() => searchHandle.search(searchMeta, 'found', {}), /context search result\.list\[0\] is missing id field "id"/);
	searchMode = 'duplicate';
	await assert.rejects(() => searchHandle.search(searchMeta, 'found', {}), /context search result contains duplicate id "1"/);
	searchMode = 'cursor';
	await assert.rejects(() => searchHandle.search(searchMeta, 'found', {}), /does not support returning portable cursors/);
	searchMode = 'cursor-count';
	await assert.rejects(
		() => searchHandle.search(searchMeta, 'found', {}),
		/context search result\.count must be a non-negative safe integer/
	);
	searchMode = 'extra-result';
	await assert.rejects(() => searchHandle.search(searchMeta, 'found', {}), /context search result contains unknown option "totla"/);
	await assert.rejects(() => searchHandle.search(searchMeta, 'found', { cursor: 'next' }), /does not support cursor pagination/);

	const indexInput = { id: 1, title: 'indexed' };
	await searchHandle.index(searchMeta, 1, indexInput);
	assert.equal(indexInput.title, 'indexed');
	assert.deepEqual(searchIndexData, { id: 1, title: 'adapter-mutated' });
	await assert.rejects(() => searchHandle.index(searchMeta, 1, { id: 2, title: 'wrong' }), /search document id must match/);
	await searchHandle.delete(searchMeta, 1);
	assert.equal(deletedId, 1);

	const readOnlySearch: SearchAdapter = {
		...search,
		capabilities: {},
		index: async () => {
			throw new Error('index should not run');
		}
	};
	const readOnlyContext = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { default: readOnlySearch },
		defaultSearch: 'default'
	});
	await assert.rejects(
		() => readOnlyContext.searchAdapter('default').index(readOnlyContext.meta(ContextHandleSearchRecord), 1, { id: 1, title: 'nope' }),
		/Search adapter "context-boundary-search" does not support indexing/
	);
});

test('context schema handles normalize direct store and search schema boundaries', async () => {
	let storePlanMode: 'unsafe-field' | 'ok' = 'unsafe-field';
	let storeApplyCalls = 0;
	const store: StoreAdapter = {
		kind: 'context-schema-store',
		capabilities: {},
		get: async () => null,
		getMany: async () => [],
		query: async () => ({ list: [], more: false }),
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined,
		schema: {
			plan: async () =>
				storePlanMode === 'unsafe-field'
					? {
							adapter: 'context-schema-store',
							changes: [
								{
									type: 'create-index',
									target: 'planner_context_config_record',
									name: 'bad_field',
									fields: ['__proto__']
								}
							]
						} as any
					: { adapter: 'context-schema-store', changes: [] },
			apply: async () => {
				storeApplyCalls++;
				return { adapter: 'context-schema-store', changes: [] };
			}
		}
	};
	let searchMode: 'unsupported-index' | 'ok' | 'bad-sync' = 'unsupported-index';
	let searchApplyCalls = 0;
	const search: SearchAdapter = {
		kind: 'context-schema-search',
		capabilities: {},
		search: async () => ({ list: [], more: false }),
		index: async () => undefined,
		delete: async () => undefined,
		schema: {
			plan: async () =>
				searchMode === 'unsupported-index'
					? {
							adapter: 'context-schema-search',
							changes: [
								{
									type: 'create-search-index',
									target: 'context_handle_search_record',
									name: 'search_title',
									fields: ['title']
								}
							]
						}
					: { adapter: 'context-schema-search', changes: [] },
			apply: async () => {
				searchApplyCalls++;
				return { adapter: 'context-schema-search', changes: [] };
			}
		},
		syncSchema: async () =>
			searchMode === 'bad-sync'
				? ({ adapter: 'context-schema-search', changes: new Array(1) } as any)
				: { adapter: 'context-schema-search', changes: [] }
	};
	const context = createActiveTs({
		stores: { default: store },
		search: { default: search },
		defaultSearch: 'default'
	});
	const storeMeta = context.meta(PlannerContextConfigRecord);
	const searchMeta = context.meta(ContextHandleSearchRecord);

	await assert.rejects(
		() => context.store('default').schema!.plan([storeMeta]),
		/Store adapter "default" schema plan\.changes\[0\]\.fields\[0\]/
	);
	storePlanMode = 'ok';
	assert.deepEqual(await context.store('default').schema!.plan([storeMeta]), {
		adapter: 'context-schema-store',
		changes: []
	});
	await assert.rejects(
		() => context.store('default').schema!.apply([storeMeta], { modee: 'safe' } as any),
		/Store adapter "default" schema apply options contains unknown option "modee"/
	);
	assert.equal(storeApplyCalls, 0);
	assert.deepEqual(await context.store('default').schema!.apply([storeMeta], { mode: 'safe' }), {
		adapter: 'context-schema-store',
		changes: []
	});
	assert.equal(storeApplyCalls, 1);

	await assert.rejects(
		() => context.searchAdapter('default').schema!.plan([searchMeta]),
		/Search adapter "context-schema-search" does not support indexing/
	);
	const indexedSearch: SearchAdapter = { ...search, capabilities: { index: true } };
	const indexedContext = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { default: indexedSearch },
		defaultSearch: 'default'
	});
	const indexedSearchMeta = indexedContext.meta(ContextHandleSearchRecord);
	searchMode = 'ok';
	await assert.rejects(
		() => indexedContext.searchAdapter('default').schema!.apply([indexedSearchMeta], { modee: 'safe' } as any),
		/Search adapter "default" schema apply options contains unknown option "modee"/
	);
	assert.equal(searchApplyCalls, 0);
	assert.deepEqual(await indexedContext.searchAdapter('default').schema!.apply([indexedSearchMeta], { mode: 'safe' }), {
		adapter: 'context-schema-search',
		changes: []
	});
	assert.equal(searchApplyCalls, 1);
	searchMode = 'bad-sync';
	await assert.rejects(
		() => indexedContext.searchAdapter('default').syncSchema!([indexedSearchMeta]),
		/Search adapter "default" syncSchema plan\.changes\[0\] is missing/
	);
});

test('query planner config ignores inherited route callbacks', async () => {
	const defaultStore = new MemoryStoreAdapter();
	const otherStore = new MemoryStoreAdapter();
	await defaultStore.seed('planner_context_config_record', [{ id: 1, value: 'default' }]);
	await otherStore.seed('planner_context_config_record', [{ id: 1, value: 'other' }]);
	Object.defineProperty(Object.prototype, 'routeQuery', {
		value: () => 'other',
		configurable: true
	});
	try {
		const context = createActiveTs(config({
			stores: { default: defaultStore, other: otherStore },
			queryPlanner: {}
		}) as any);
		const Record = PlannerContextConfigRecord.use(context) as unknown as typeof PlannerContextConfigRecord;
		const rows = await Record.query().load();
		assert.deepEqual(rows.list.map((item) => item.data.value), ['default']);
	} finally {
		delete (Object.prototype as Record<string, unknown>).routeQuery;
	}
});

test('query planner config validation ignores patched Object entries', () => {
	const originalEntries = Object.entries;
	Object.defineProperty(Object, 'entries', {
		configurable: true,
		value() {
			throw new Error('patched Object.entries should not run for query planner config validation');
		}
	});
	try {
		assert.throws(
			() => createActiveTs(config({ queryPlanner: { routeQuery: 'bad' as any } }) as any),
			/queryPlanner\.routeQuery must be a function/
		);
	} finally {
		Object.defineProperty(Object, 'entries', { configurable: true, value: originalEntries });
	}
});

test('query planner callbacks cannot mutate plans before adapter execution', async () => {
	let queryPlan: any;
	let aggregatePlan: any;
	let searchOptions: any;
	const store: any = {
		kind: 'planner-mutation-store',
		capabilities: { aggregate: true, offset: true },
		get: async () => null,
		getMany: async () => [],
		query: async (_model: unknown, plan: unknown) => {
			queryPlan = plan;
			return { list: [], more: false };
		},
		aggregate: async (_model: unknown, plan: unknown) => {
			aggregatePlan = plan;
			return { count: 0 };
		},
		create: async () => {},
		update: async () => {},
		delete: async () => {}
	};
	const search: any = {
		kind: 'planner-mutation-search',
		capabilities: { where: true, whereOperators: { '=': true }, index: true },
		search: async (_model: unknown, _query: string, options: unknown) => {
			searchOptions = options;
			return { list: [], more: false };
		},
		index: async () => {},
		delete: async () => {}
	};
	const context = createActiveTs({
		stores: { default: store },
		search: { default: search },
		defaultSearch: 'default',
		plugins: [
			{
				name: 'nested-plan-meta',
				hooks: {
					beforeQuery(payload: any) {
						return { plan: { ...payload.plan, meta: { marker: { label: 'safe' } } } };
					},
					beforeAggregate(payload: any) {
						return { plan: { ...payload.plan, meta: { marker: { label: 'safe' } } } };
					}
				}
			}
		],
		queryPlanner: {
			routeQuery: ({ plan }: any) => {
				plan.where[0].field = '__proto__';
				plan.offset = 999;
				plan.native = { payload: { unsafe: true } };
				plan.meta.marker.label = 'unsafe';
				return 'default';
			},
			routeAggregate: ({ plan }: any) => {
				plan.where[0].field = '__proto__';
				plan.aggregates[0].as = '__proto__';
				plan.meta.marker.label = 'unsafe';
				return 'default';
			},
			routeSearch: ({ options }: any) => {
				options.where.value = '__proto__';
				options.native = { unsafe: true };
				return 'default';
			}
		}
	} as any);
	const Record = PlannerContextConfigRecord.use(context) as unknown as typeof PlannerContextConfigRecord;

	await Record.where({ value: 'safe' }).offset(1).load();
	await Record.where({ value: 'safe' }).count();
	await Record.search('safe').where({ value: 'safe' }).load();

	assert.equal(queryPlan.where[0].field, 'value');
	assert.equal(queryPlan.offset, 1);
	assert.equal(queryPlan.native, undefined);
	assert.deepEqual(queryPlan.meta, { marker: { label: 'safe' } });
	assert.equal(aggregatePlan.where[0].field, 'value');
	assert.equal(aggregatePlan.aggregates[0].as, 'count');
	assert.deepEqual(aggregatePlan.meta, { marker: { label: 'safe' } });
	assert.deepEqual(searchOptions.where, { value: 'safe' });
	assert.equal(searchOptions.native, undefined);
});

test('direct route helpers validate plans before planner callbacks', () => {
	let queryRoutes = 0;
	let aggregateRoutes = 0;
	let searchRoutes = 0;
	let getterCalls = 0;
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { default: new MemorySearchAdapter() },
		defaultSearch: 'default',
		queryPlanner: {
			routeQuery: () => {
				queryRoutes++;
				return 'default';
			},
			routeAggregate: () => {
				aggregateRoutes++;
				return 'default';
			},
			routeSearch: () => {
				searchRoutes++;
				return 'default';
			}
		}
	});
	const meta = context.meta(PlannerContextConfigRecord);
	const queryPlan = Object.defineProperty({ where: [], or: [], sort: [], include: [] }, 'native', {
		enumerable: true,
		get() {
			getterCalls++;
			return { payload: { unsafe: true } };
		}
	});
	const aggregatePlan = Object.defineProperty({ where: [], or: [], aggregates: [{ op: 'count', as: 'count' }] }, 'native', {
		enumerable: true,
		get() {
			getterCalls++;
			return { payload: { unsafe: true } };
		}
	});
	const searchOptions = Object.defineProperty({}, 'where', {
		enumerable: true,
		get() {
			getterCalls++;
			return { value: 'unsafe' };
		}
	});

	assert.throws(
		() => context.storeForQuery(meta, queryPlan as any),
		/store route query plan\.native must be a data property/
	);
	assert.throws(
		() => context.storeForAggregate(meta, aggregatePlan as any),
		/store route aggregate plan\.native must be a data property/
	);
	assert.throws(
		() => context.searchAdapterRouteFor(meta, 'safe', searchOptions as any),
		/search route options "where" must be a data property/
	);
	assert.equal(getterCalls, 0);
	assert.equal(queryRoutes, 0);
	assert.equal(aggregateRoutes, 0);
	assert.equal(searchRoutes, 0);
});

test('direct route helpers encode field-codec operands before planner callbacks', () => {
	let queryPlanValue: unknown;
	let aggregatePlanValue: unknown;
	let noQueryRoutes = 0;
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		queryPlanner: {
			routeQuery: ({ plan }) => {
				queryPlanValue = plan.where[0]?.value;
				return 'default';
			},
			routeAggregate: ({ plan }) => {
				aggregatePlanValue = plan.where[0]?.value;
				return 'default';
			}
		}
	});
	const meta = context.meta(DirectCodecRouteRecord);
	context.storeForQuery(meta, {
		where: [{ field: 'token', op: '=', value: 'alpha' }],
		or: [],
		sort: [],
		include: []
	});
	context.storeForAggregate(meta, {
		where: [{ field: 'token', op: '=', value: 'alpha' }],
		or: [],
		aggregates: [{ op: 'sum', field: 'score', as: 'scoreSum' }]
	});

	assert.equal(queryPlanValue, 'stored:alpha');
	assert.equal(aggregatePlanValue, 'stored:alpha');

	const noQueryContext = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		queryPlanner: {
			routeQuery: () => {
				noQueryRoutes++;
				return 'default';
			}
		}
	});
	const noQueryMeta = noQueryContext.meta(DirectNoQueryCodecRouteRecord);
	assert.throws(
		() =>
			noQueryContext.storeForQuery(noQueryMeta, {
				where: [{ field: 'token', op: '=', value: 'alpha' }],
				or: [],
				sort: [],
				include: []
			}),
		/does not support portable query operands/
	);
	assert.equal(noQueryRoutes, 0);
});

test('explicit store native adapter routes take precedence over query planner routes', async () => {
	const calls: string[] = [];
	const nativeStore = (name: string): StoreAdapter => ({
		kind: name,
		capabilities: { native: true, aggregate: true },
		get: async () => null,
		getMany: async () => [],
		query: async (_model, plan) => {
			calls.push(`${name}:query:${(plan.native?.payload as any)?.marker}`);
			return { list: [{ id: 1, value: name }], more: false };
		},
		aggregate: async (_model, plan) => {
			calls.push(`${name}:aggregate:${(plan.native?.payload as any)?.marker}`);
			return { count: name === 'primary-native' ? 7 : 9 };
		},
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	});
	const context = createActiveTs({
		stores: {
			default: nativeStore('primary-native'),
			replica: nativeStore('replica-native')
		},
		queryPlanner: {
			routeQuery: () => 'replica',
			routeAggregate: () => 'replica'
		}
	});
	const Record = PlannerContextConfigRecord.use(context) as unknown as typeof PlannerContextConfigRecord;

	const queried = await Record.query().native({ marker: 'selected-query' }, 'default').load();
	assert.equal(queried.list[0].data.value, 'primary-native');
	assert.equal(await Record.query().native({ marker: 'selected-aggregate' }, 'default').count(), 7);
	assert.deepEqual(calls, [
		'primary-native:query:selected-query',
		'primary-native:aggregate:selected-aggregate'
	]);
});

test('nested context option snapshots ignore inherited fields', () => {
	Object.defineProperty(Object.prototype, 'autoSync', {
		value: 'safe',
		configurable: true
	});
	Object.defineProperty(Object.prototype, 'maxSize', {
		value: 1,
		configurable: true
	});
	Object.defineProperty(Object.prototype, 'allowQueryFallback', {
		value: true,
		configurable: true
	});
	try {
		const context = createActiveTs(config({
			schema: {},
			batch: {},
			aggregate: {}
		}) as any);
		assert.equal(context.allowsAggregateFallback(), false);
		assert.equal((context as any).maxBatchSize, 500);
	} finally {
		delete (Object.prototype as Record<string, unknown>).autoSync;
		delete (Object.prototype as Record<string, unknown>).maxSize;
		delete (Object.prototype as Record<string, unknown>).allowQueryFallback;
	}
});

test('forked contexts preserve absent optional default adapter registries', async () => {
	for (const context of [
		createActiveTs({ stores: { default: new MemoryStoreAdapter() } }),
		createActiveTs({ stores: { default: new MemoryStoreAdapter() }, caches: { default: new MemoryCacheAdapter() } }),
		createActiveTs({ stores: { default: new MemoryStoreAdapter() }, search: { default: new MemorySearchAdapter() } })
	]) {
		const Record = PlannerContextConfigRecord.use(context) as unknown as typeof PlannerContextConfigRecord;
		await context.transaction(async (tx) => {
			const TxRecord = PlannerContextConfigRecord.use(tx) as unknown as typeof PlannerContextConfigRecord;
			await TxRecord.create({ id: 901, value: 'created in fork' });
		});
		assert.equal((await Record.find(901).load())?.data.value, 'created in fork');
	}
});

test('transaction contexts reject schema side effects', async () => {
	const storeA = new MemoryStoreAdapter();
	const storeB = new MemoryStoreAdapter();
	let storeApplyCalls = 0;
	storeB.schema.apply = async (): Promise<SchemaPlan> => {
		storeApplyCalls++;
		return { adapter: 'b', changes: [] };
	};
	const search = new MemorySearchAdapter() as MemorySearchAdapter & {
		syncSchema: SearchAdapter['syncSchema'];
	};
	let searchSyncCalls = 0;
	search.syncSchema = async (models: ResolvedModelMeta[]): Promise<SchemaPlan> => {
		searchSyncCalls += models.length;
		return { adapter: 'tx-search', changes: [] };
	};
	const context = createActiveTs({
		stores: { a: storeA, b: storeB },
		defaultStore: 'a',
		search: { 'tx-search': search },
		defaultSearch: 'tx-search'
	});

	await assert.rejects(
		() =>
			context.transaction(
				async (tx) => {
					assert.equal(tx.store('a').schema, undefined);
					assert.equal(tx.store('b').schema, undefined);
					await tx.schemaApply([TransactionSchemaStoreBRecord], { mode: 'safe' });
				},
				{ store: 'a' }
			),
		/Cannot apply schema changes inside a transaction/
	);
	assert.equal(storeApplyCalls, 0);

	await assert.rejects(
		() =>
			context.transaction(
				async () => {
					await context.schemaApply([TransactionSchemaStoreBRecord], { mode: 'safe' });
				},
				{ store: 'a' }
			),
		/Cannot apply schema changes inside a transaction/
	);
	assert.equal(storeApplyCalls, 0);

	await assert.rejects(
		() =>
			context.transaction(
				async (tx) => {
					await tx.schemaApply([TransactionSchemaSearchRecord], { mode: 'safe' });
				},
				{ store: 'a' }
			),
		/Cannot apply schema changes inside a transaction/
	);
	assert.equal(searchSyncCalls, 0);
});

test('forked contexts validate own adapter registry overrides', () => {
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		caches: { default: new MemoryCacheAdapter() },
		search: { default: new MemorySearchAdapter() }
	});

	assert.throws(() => (context as any).fork({ stores: null }), /store adapter name registry must be an object/);
	assert.throws(() => (context as any).fork({ caches: null }), /cache adapter name registry must be an object/);
	assert.throws(() => (context as any).fork({ search: null }), /search adapter name registry must be an object/);
	assert.throws(() => (context as any).fork({ stores: [] }), /store adapter name registry must be an object/);
	assert.throws(() => (context as any).fork({ stores: { extra: null } }), /store adapter name "extra" must be an adapter object/);

	let reads = 0;
	const accessorFork = Object.defineProperty({}, 'stores', {
		enumerable: true,
		get() {
			reads++;
			return { extra: new MemoryStoreAdapter() };
		}
	});
	assert.throws(() => (context as any).fork(accessorFork), /fork config\.stores must be a data property/);
	assert.equal(reads, 0);

	const inherited = Object.create({
		stores: { inherited: new MemoryStoreAdapter() },
		defaultStore: 'inherited'
	});
	assert.throws(() => (context as any).fork(inherited), /fork config must be a plain object/);
});

test('context snapshots registered adapter methods', async () => {
	const store = {
		kind: 'snapshot-store',
		capabilities: { aggregate: true },
		get: async () => ({ id: 1, value: 'store-get' }),
		getMany: async () => [{ id: 1, value: 'store-getMany' }],
		query: async () => ({ list: [{ id: 1, value: 'store-query' }], more: false }),
		aggregate: async () => ({ count: 1 }),
		create: async () => {},
		update: async () => {},
		delete: async () => {},
		schema: {
			plan: async () => ({ adapter: 'snapshot-store', changes: [{ type: 'create-collection', target: 'original' }] }),
			apply: async () => ({ adapter: 'snapshot-store', changes: [] })
		}
	};
	const cache = {
		kind: 'snapshot-cache',
		getMany: async () => ['cache-original'],
		setMany: async () => {},
		deleteMany: async () => {}
	};
	const search = {
		kind: 'snapshot-search',
		capabilities: {},
		search: async () => ({ list: [{ id: 1, value: 'search-original' }], more: false }),
		index: async () => {},
		delete: async () => {},
		syncSchema: async () => ({
			adapter: 'snapshot-search',
			changes: [{ type: 'create-search-index', target: 'original', name: 'idx', fields: ['id'] }]
		})
	};
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: cache },
		search: { default: search }
	} as any);

	(store as any).query = async () => ({ list: [{ id: 1, value: 'mutated' }], more: false });
	(cache as any).getMany = async () => ['cache-mutated'];
	(search as any).search = async () => ({ list: [{ id: 1, value: 'search-mutated' }], more: false });
	(store.schema as any).plan = async () => ({
		adapter: 'snapshot-store',
		changes: [{ type: 'create-collection', target: 'mutated' }]
	});
	(store as any).schema = {
		plan: async () => ({
			adapter: 'snapshot-store',
			changes: [{ type: 'create-collection', target: 'replaced' }]
		}),
		apply: async () => ({ adapter: 'snapshot-store', changes: [] })
	};

	const Record = PlannerContextConfigRecord.use(context) as unknown as typeof PlannerContextConfigRecord;
	assert.deepEqual((await Record.query().load()).list.map((item) => item.data.value), ['store-query']);
	assert.deepEqual(await context.cache('default')!.getMany(['k']), ['cache-original']);
	assert.deepEqual((await context.searchAdapter('default').search(context.meta(PlannerContextConfigRecord), 'q', {})).list, [
		{ id: 1, value: 'search-original' }
	]);
	assert.equal((await context.schemaPlan([PlannerContextConfigRecord]))[0].changes[0].target, 'original');
});

test('sanitized and merged hook arrays are immutable snapshots', () => {
	const first = () => undefined;
	const second = () => undefined;
	const sanitized = sanitizeHooks({ beforeQuery: [first] });
	const merged = mergeHooks(sanitized, { beforeQuery: second });

	assert.throws(() => {
		(sanitized.beforeQuery as any[]).push(second);
	}, TypeError);
	assert.throws(() => {
		(merged.beforeQuery as any[]).push(first);
	}, TypeError);
	assert.throws(() => {
		(merged as any).afterQuery = first;
	}, TypeError);
});

test('hook list validation ignores patched Array forEach', () => {
	const first = () => undefined;
	const forEach = Object.getOwnPropertyDescriptor(Array.prototype, 'forEach')!;
	Object.defineProperty(Array.prototype, 'forEach', {
		configurable: true,
		value() {
			throw new Error('patched Array.forEach');
		}
	});
	try {
		const sanitized = sanitizeHooks({ beforeQuery: [first] });
		assert.equal(Array.isArray(sanitized.beforeQuery), true);
		assert.equal((sanitized.beforeQuery as any[])[0], first);
	} finally {
		Object.defineProperty(Array.prototype, 'forEach', forEach);
	}
});

test('default context setter rejects non-context values', () => {
	assert.throws(() => setDefaultContext(null as any), /Default active-ts context must be an ActiveContext/);
	assert.throws(() => setDefaultContext({} as any), /Default active-ts context must be an ActiveContext/);
	const context = createActiveTs(config());
	assert.doesNotThrow(() => setDefaultContext(context));
	clearDefaultContext();
});

test('bound model context rejects non-context values', () => {
	assert.throws(() => BoundContextConfigRecord.use(null as any), /Model\.use context must be an ActiveContext/);
	assert.throws(() => BoundContextConfigRecord.use({} as any), /Model\.use context must be an ActiveContext/);
	const context = createActiveTs(config());
	assert.doesNotThrow(() => BoundContextConfigRecord.use(context));
});

test('bound model static writes return instances bound to explicit context overrides', async () => {
	const boundStore = new MemoryStoreAdapter();
	const explicitStore = new MemoryStoreAdapter();
	const boundContext = createActiveTs({ stores: { default: boundStore } });
	const explicitContext = createActiveTs({ stores: { default: explicitStore } });
	const BoundRecord = PlannerContextConfigRecord.use(boundContext) as unknown as typeof PlannerContextConfigRecord;

	const item = await BoundRecord.create({ id: 981, value: 'created in explicit context' }, explicitContext);
	item.data.value = 'saved in explicit context';
	await item.save();

	assert.equal(await boundStore.get(boundContext.meta(PlannerContextConfigRecord), 981), null);
	assert.equal(
		(await explicitStore.get(explicitContext.meta(PlannerContextConfigRecord), 981))?.value,
		'saved in explicit context'
	);
});

test('context operation options reject malformed runtime inputs', async () => {
	const context = createActiveTs(config());
	const detachedRunHooks = context.runHooks;
	let detachedResult!: Promise<unknown>;
	assert.doesNotThrow(() => {
		detachedResult = detachedRunHooks('beforeRead', {});
	});
	await assert.rejects(() => detachedResult, TypeError);
	let symbolResult!: Promise<unknown>;
	assert.doesNotThrow(() => {
		symbolResult = context.runHooks(Symbol('invalid hook') as any, {});
	});
	await assert.rejects(() => symbolResult, TypeError);

	await assert.rejects(() => context.schemaPlan(null as any), /schemaPlan models must be an array/);
	await assert.rejects(() => context.schemaPlan(new Array(1) as any), /schemaPlan models\[0\] is missing/);
	await assert.rejects(() => context.schemaPlan([{} as any]), /schemaPlan models\[0\] must be a model constructor/);
	const models = [PlannerContextConfigRecord] as any[];
	let modelForEachCalls = 0;
	Object.defineProperty(models, 'forEach', {
		value() {
			modelForEachCalls++;
			throw new Error('custom schema model forEach should not run');
		}
	});
	await context.schemaPlan(models);
	assert.equal(modelForEachCalls, 0);
	const iteratorModels = [PlannerContextConfigRecord] as any[];
	let modelIteratorCalls = 0;
	Object.defineProperty(iteratorModels, Symbol.iterator, {
		value() {
			modelIteratorCalls++;
			throw new Error('custom schema model iterator should not run');
		}
	});
	await assert.rejects(() => context.schemaPlan(iteratorModels), /schemaPlan models cannot contain symbol fields/);
	assert.equal(modelIteratorCalls, 0);
	await assert.rejects(() => context.schemaApply([], null as any), /schemaApply options must be a plain object/);
	await assert.rejects(() => context.schemaApply([], { mode: 'force' } as any), /schemaApply options\.mode/);
	await assert.rejects(
		() => context.schemaApply([], { modee: 'safe' } as any),
		/schemaApply options contains unknown option "modee"/
	);
	let optionReads = 0;
	const accessorApplyOptions = Object.defineProperty({}, 'mode', {
		enumerable: true,
		get() {
			optionReads++;
			return 'safe';
		}
	});
	await assert.rejects(
		() => context.schemaApply([], accessorApplyOptions as any),
		/schemaApply options\.mode must be a data property/
	);
	assert.equal(optionReads, 0);
	await assert.rejects(() => context.schemaMigration(null as any, 'migration'), /schemaMigration models must be an array/);
	await assert.rejects(() => context.transaction(null as any), /transaction callback must be a function/);
	await assert.rejects(
		() => context.transaction(async () => undefined, null as any),
		/transaction options must be a plain object/
	);
	const accessorTransactionOptions = Object.defineProperty({}, 'store', {
		enumerable: true,
		get() {
			optionReads++;
			return 'default';
		}
	});
	await assert.rejects(
		() => context.transaction(async () => undefined, accessorTransactionOptions as any),
		/transaction options\.store must be a data property/
	);
	assert.equal(optionReads, 0);
	await assert.rejects(
		() => context.transaction(async () => undefined, { store: '__proto__' } as any),
		/transaction store/
	);
	await assert.rejects(
		() => context.transaction(async () => undefined, { stores: 'default' } as any),
		/transaction options contains unknown option "stores"/
	);
	await assert.rejects(
		() => context.transaction(async () => undefined, { isolation: 'snapshot' } as any),
		/transaction options\.isolation/
	);
	await assert.rejects(
		() => context.transaction(async () => undefined, { readOnly: 'yes' } as any),
		/transaction options\.readOnly/
	);
	await assert.rejects(
		() => context.transaction(async () => undefined, { timeoutMs: 0 } as any),
		/transaction options\.timeoutMs/
	);
	await assert.rejects(
		() => context.transaction(async () => undefined, { join: 'nested' } as any),
		/transaction options\.join/
	);
	const isolationBase = new MemoryStoreAdapter();
	const isolationStore: StoreAdapter = {
		kind: 'isolation-option-store',
		capabilities: isolationBase.capabilities,
		schema: isolationBase.schema,
		get: (model, id, options) => isolationBase.get(model, id, options),
		getMany: (model, ids, options) => isolationBase.getMany(model, ids, options),
		query: (model, plan, options) => isolationBase.query(model, plan, options),
		aggregate: (model, plan) => isolationBase.aggregate(model, plan),
		create: (model, id, data) => isolationBase.create(model, id, data),
		update: (model, id, data, options) => isolationBase.update(model, id, data, options),
		delete: (model, id, options) => isolationBase.delete(model, id, options),
		transaction: (callback) => isolationBase.transaction(callback)
	};
	const isolationContext = createActiveTs({ stores: { default: isolationStore } });
	await assert.rejects(
		() =>
			isolationContext.transaction(
				async () => {
					await isolationContext.transaction(async () => undefined, { join: 'reuse', isolation: 'serializable' });
				},
				{ isolation: 'readCommitted' }
			),
		/Cannot change transaction isolation/
	);
	const BoundTransactionRecord = PlannerContextConfigRecord.use(context) as unknown as typeof PlannerContextConfigRecord;
	let modelOptionReads = 0;
	const accessorModelTransactionOptions = Object.defineProperty({}, 'join', {
		enumerable: true,
		get() {
			modelOptionReads++;
			return 'reuse';
		}
	});
	await assert.rejects(
		() => BoundTransactionRecord.transaction(async () => undefined, accessorModelTransactionOptions as any),
		/transaction options\.join must be a data property/
	);
	assert.equal(modelOptionReads, 0);
	await assert.rejects(
		() => BoundTransactionRecord.transaction(async () => undefined, { store: 'default' } as any),
		/Model\.transaction options cannot include store/
	);
	await assert.rejects(() => context.afterCommit(null as any), /afterCommit task must be a function/);
	let afterCommitRan = false;
	await assert.rejects(
		() => context.afterCommit(() => {
			afterCommitRan = true;
		}),
		/Cannot register afterCommit tasks outside a transaction/
	);
	assert.equal(afterCommitRan, false);
	await assert.rejects(() => context.afterRollback('task' as any), /afterRollback task must be a function/);
	let afterRollbackRan = false;
	await assert.rejects(
		() => context.afterRollback(() => {
			afterRollbackRan = true;
		}),
		/Cannot register afterRollback tasks outside a transaction/
	);
	assert.equal(afterRollbackRan, false);
	await assert.rejects(
		() => context.loadManyNow(PlannerContextConfigRecord, new Array(1) as any),
		/loadManyNow ids\[0\] is missing/
	);
});

test('context normalizes schema adapter output before returning it', async () => {
	let mode: 'sparse' | 'unsafe-field' | 'accessor' | 'symbol' = 'sparse';
	let getterCalls = 0;
	const store = {
		kind: 'schema-output-store',
		capabilities: {},
		get: async () => null,
		getMany: async (_model: unknown, ids: unknown[]) => ids.map(() => null),
		query: async () => ({ list: [], more: false }),
		create: async () => {},
		update: async () => {},
		delete: async () => {},
		schema: {
			plan: async () => {
				if (mode === 'sparse') return { adapter: 'schema-output-store', changes: new Array(1) };
				if (mode === 'accessor') {
					return Object.defineProperty({ adapter: 'schema-output-store', changes: [] }, 'status', {
						enumerable: true,
						get() {
							getterCalls++;
							return 'planned';
						}
					});
				}
				if (mode === 'symbol') return { adapter: 'schema-output-store', changes: [], [Symbol('schema')]: true };
				return {
					adapter: 'schema-output-store',
					changes: [{ type: 'create-index', target: 'planner_context_config_record', name: 'idx', fields: ['__proto__'] }]
				};
			},
			apply: async () => ({ adapter: 'schema-output-store', changes: [{ type: 'create-collection', target: 'safe_target' }] })
		}
	};
	const context = createActiveTs({ stores: { default: store } } as any);

	await assert.rejects(
		() => context.schemaPlan([PlannerContextConfigRecord]),
		/Store adapter "default" schema plan\.changes\[0\] is missing/
	);
	mode = 'unsafe-field';
	await assert.rejects(
		() => context.schemaPlan([PlannerContextConfigRecord]),
		/Store adapter "default" schema plan\.changes\[0\]\.fields\[0\]/
	);
	mode = 'accessor';
	await assert.rejects(
		() => context.schemaPlan([PlannerContextConfigRecord]),
		/Store adapter "default" schema plan\.status must be a data property/
	);
	assert.equal(getterCalls, 0);
	mode = 'symbol';
	await assert.rejects(
		() => context.schemaPlan([PlannerContextConfigRecord]),
		/Store adapter "default" schema plan cannot contain symbol fields/
	);
	assert.deepEqual(await context.schemaApply([PlannerContextConfigRecord], { mode: 'safe' }), [
		{ adapter: 'schema-output-store', changes: [{ type: 'create-collection', target: 'safe_target' }], route: 'default' }
	]);
});
