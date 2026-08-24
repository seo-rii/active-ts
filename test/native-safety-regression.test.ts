import test from 'node:test';
import assert from 'node:assert/strict';
import {
	ActiveTsConfigurationError,
	ActiveTsValidationError,
	ACTIVE_TS_ENTITY_KEY,
	MemoryCacheAdapter,
	MemorySearchAdapter,
	MemoryStoreAdapter,
	Model,
	createActiveTs,
	defineModel,
	getRelation,
	isPartialModel
} from '../src/index.js';
import type { ActiveTsPlugin } from '../src/index.js';
import type { SearchAdapter, StoreAdapter } from '../src/index.js';
import { createDatastoreStoreAdapter } from '../src/adapters/store/datastore.js';
import { createFirestoreStoreAdapter } from '../src/adapters/store/firestore.js';
import { createMongoStoreAdapter } from '../src/adapters/store/mongodb.js';
import { createPostgresStoreAdapter } from '../src/adapters/store/postgresql.js';
import { cloneJsonTransportPayload, cloneNativePayload } from '../src/core/native-payload.js';
import { optionalImport } from '../src/core/optional-import.js';
import { markPartialModel, PARTIAL_MODEL } from '../src/core/partial-model.js';
import {
	attachEntityKey,
	assertSafeDataKeys,
	cloneSafeData,
	isReservedFieldName
} from '../src/core/safe-keys.js';

type NativeSafetyData = {
	id: number;
	title: string;
};

class NativeSafetyRecord extends Model<NativeSafetyData> {}
class BadScopeRecord extends Model<NativeSafetyData> {}
class ReplaceDataRecord extends Model<NativeSafetyData & { stale?: string }> {}

defineModel<NativeSafetyData>({ name: 'native_safety_record', search: 'memory' })
	.id('id')
	.validate((input) => input as NativeSafetyData)
	.search('memory', ['title'])
	.attach(NativeSafetyRecord);

defineModel<NativeSafetyData>('bad_scope_record')
	.id('id')
	.validate((input) => input as NativeSafetyData)
	.scope('nullish', () => null as any)
	.attach(BadScopeRecord);

defineModel<NativeSafetyData & { stale?: string }>('replace_data_record')
	.id('id')
	.validate((input) => {
		const data = input as NativeSafetyData;
		return { id: data.id, title: data.title };
	})
	.attach(ReplaceDataRecord);

function forgePartialMarker(item: unknown) {
	Object.defineProperty(item as object, PARTIAL_MODEL, {
		value: true,
		enumerable: false,
		configurable: true
	});
}

test('public reserved field helper validates runtime input before checking prefixes', () => {
	let startsWithCalls = 0;
	const hostileField = {
		startsWith() {
			startsWithCalls++;
			return false;
		}
	};

	assert.equal(isReservedFieldName('__meta'), true);
	assert.equal(isReservedFieldName('constructor'), true);
	assert.equal(isReservedFieldName('safe'), false);
	assert.throws(() => isReservedFieldName(null as any), ActiveTsValidationError);
	assert.throws(() => isReservedFieldName(hostileField as any), ActiveTsValidationError);
	assert.equal(startsWithCalls, 0);
});

test('safe data validation ignores polluted WeakSet cycle methods', () => {
	const weakSetAdd = Object.getOwnPropertyDescriptor(WeakSet.prototype, 'add')!;
	const weakSetHas = Object.getOwnPropertyDescriptor(WeakSet.prototype, 'has')!;
	const weakSetDelete = Object.getOwnPropertyDescriptor(WeakSet.prototype, 'delete')!;
	try {
		Object.defineProperty(WeakSet.prototype, 'add', {
			value() {
				throw new Error('patched WeakSet.add should not run');
			}
		});
		Object.defineProperty(WeakSet.prototype, 'has', {
			value() {
				throw new Error('patched WeakSet.has should not run');
			}
		});
		Object.defineProperty(WeakSet.prototype, 'delete', {
			value() {
				throw new Error('patched WeakSet.delete should not run');
			}
		});

		const payload = { nested: { value: 1, omitted: undefined } };
		assert.doesNotThrow(() => assertSafeDataKeys(payload));
		assert.deepEqual(cloneSafeData(payload), { nested: { value: 1 } });

		const circular: any = {};
		circular.self = circular;
		assert.throws(() => assertSafeDataKeys(circular), /Circular data value/);
	} finally {
		Object.defineProperty(WeakSet.prototype, 'add', weakSetAdd);
		Object.defineProperty(WeakSet.prototype, 'has', weakSetHas);
		Object.defineProperty(WeakSet.prototype, 'delete', weakSetDelete);
	}
});

const firestoreClient = (overrides: Record<string, unknown> = {}) => ({
	collection: () => ({}),
	getAll: async () => [],
	runTransaction: async (callback: (transaction: unknown) => Promise<unknown>) =>
		callback({
			get: async () => ({ exists: false }),
			set: async () => undefined
		}),
	...overrides
});

const datastoreClient = (overrides: Record<string, unknown> = {}) => ({
	key: (input: unknown) => input,
	get: async () => [undefined],
	save: async () => undefined,
	delete: async () => undefined,
	update: async () => undefined,
	createQuery: () => ({}),
	runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }],
	...overrides
});

test('native query adapter names fail fast when the store is not registered', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const Record = NativeSafetyRecord.use(context) as unknown as typeof NativeSafetyRecord;

	await assert.rejects(
		() => Record.query().native({ text: 'select 1' }, 'missing-store').load(),
		/Store adapter "missing-store" is not registered/
	);
});

test('context store handles reject mismatched native adapter tags before stores run', async () => {
	let queryCalls = 0;
	let queryPayloadCalls = 0;
	let aggregateCalls = 0;
	let aggregatePayloadCalls = 0;
	const store: StoreAdapter = {
		kind: 'raw_context_native_store',
		capabilities: { native: true, aggregate: true },
		get: async () => null,
		getMany: async () => [],
		query: async () => {
			queryCalls++;
			return { list: [] };
		},
		aggregate: async () => {
			aggregateCalls++;
			return { count: 0 };
		},
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(NativeSafetyRecord);

	await assert.rejects(
		() =>
			context.store('default').query(meta, {
				where: [],
				or: [],
				sort: [],
				include: [],
				native: {
					adapter: 'other_store',
					payload: () => {
						queryPayloadCalls++;
						return { list: [] };
					}
				}
			}),
		/context store query plan targets store adapter "other_store" but reached store adapter "default"/
	);
	await assert.rejects(
		() =>
			context.store('default').aggregate!(meta, {
				where: [],
				or: [],
				aggregates: [{ op: 'count', as: 'count' }],
				native: {
					adapter: 'other_store',
					payload: () => {
						aggregatePayloadCalls++;
						return { count: 0 };
					}
				}
			}),
		/context store aggregate plan targets store adapter "other_store" but reached store adapter "default"/
	);
	assert.equal(queryCalls, 0);
	assert.equal(queryPayloadCalls, 0);
	assert.equal(aggregateCalls, 0);
	assert.equal(aggregatePayloadCalls, 0);
});

test('context store transaction handles validate and strip native adapter tags', async () => {
	let queryCalls = 0;
	let queryPayloadCalls = 0;
	let aggregateCalls = 0;
	let aggregatePayloadCalls = 0;
	let querySeenAdapter: unknown = 'unseen';
	let aggregateSeenAdapter: unknown = 'unseen';
	const txStore: StoreAdapter = {
		kind: 'raw_context_native_transaction_store:tx',
		capabilities: { native: true, aggregate: true },
		get: async () => null,
		getMany: async () => [],
		query: async (_model, plan) => {
			queryCalls++;
			querySeenAdapter = plan.native?.adapter;
			const payload = plan.native?.payload;
			if (typeof payload !== 'function') throw new Error('expected native transaction query payload function');
			return await payload();
		},
		aggregate: async (_model, plan) => {
			aggregateCalls++;
			aggregateSeenAdapter = plan.native?.adapter;
			const payload = plan.native?.payload;
			if (typeof payload !== 'function') throw new Error('expected native transaction aggregate payload function');
			return await payload();
		},
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	const store: StoreAdapter = {
		...txStore,
		kind: 'raw_context_native_transaction_store',
		capabilities: { native: true, aggregate: true, transaction: true },
		transaction: async (fn) => await fn(txStore)
	};
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(NativeSafetyRecord);
	const handle = context.store('default');

	await assert.rejects(
		() =>
			handle.transaction!(async (tx) =>
				await tx.query(meta, {
					where: [],
					or: [],
					sort: [],
					include: [],
					native: {
						adapter: 'other_store',
						payload: () => {
							queryPayloadCalls++;
							return { list: [] };
						}
					}
				})
			),
		/context store transaction query plan targets store adapter "other_store" but reached store adapter "default"/
	);
	await assert.rejects(
		() =>
			handle.transaction!(async (tx) =>
				await tx.aggregate!(meta, {
					where: [],
					or: [],
					aggregates: [{ op: 'count', as: 'count' }],
					native: {
						adapter: 'other_store',
						payload: () => {
							aggregatePayloadCalls++;
							return { count: 0 };
						}
					}
				})
			),
		/context store transaction aggregate plan targets store adapter "other_store" but reached store adapter "default"/
	);
	assert.equal(queryCalls, 0);
	assert.equal(queryPayloadCalls, 0);
	assert.equal(aggregateCalls, 0);
	assert.equal(aggregatePayloadCalls, 0);

	const rows = await handle.transaction!(async (tx) =>
		await tx.query(meta, {
			where: [],
			or: [],
			sort: [],
			include: [],
			native: {
				adapter: 'default',
				payload: () => {
					queryPayloadCalls++;
					return { list: [{ id: 1, title: 'tagged transaction query' }] };
				}
			}
		})
	);
	const aggregate = await handle.transaction!(async (tx) =>
		await tx.aggregate!(meta, {
			where: [],
			or: [],
			aggregates: [{ op: 'count', as: 'count' }],
			native: {
				adapter: 'default',
				payload: () => {
					aggregatePayloadCalls++;
					return { count: 7 };
				}
			}
		})
	);

	assert.deepEqual(rows.list, [{ id: 1, title: 'tagged transaction query' }]);
	assert.deepEqual(aggregate, { count: 7 });
	assert.equal(querySeenAdapter, undefined);
	assert.equal(aggregateSeenAdapter, undefined);
	assert.equal(queryCalls, 1);
	assert.equal(queryPayloadCalls, 1);
	assert.equal(aggregateCalls, 1);
	assert.equal(aggregatePayloadCalls, 1);
});

test('native store adapter aliases strip tags before reaching raw adapters', async () => {
	let querySeenAdapter: unknown = 'unseen';
	let aggregateSeenAdapter: unknown = 'unseen';
	const rawStore: StoreAdapter = {
		kind: 'raw_alias_native_store',
		capabilities: { native: true, aggregate: true },
		get: async () => null,
		getMany: async () => [],
		query: async (_model, plan) => {
			querySeenAdapter = plan.native?.adapter;
			const payload = plan.native?.payload;
			if (typeof payload !== 'function') throw new Error('expected native query payload function');
			return await payload();
		},
		aggregate: async (_model, plan) => {
			aggregateSeenAdapter = plan.native?.adapter;
			const payload = plan.native?.payload;
			if (typeof payload !== 'function') throw new Error('expected native aggregate payload function');
			return await payload();
		},
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	const context = createActiveTs({
		stores: {
			default: new MemoryStoreAdapter(),
			alias: rawStore
		}
	});
	const Record = NativeSafetyRecord.use(context) as unknown as typeof NativeSafetyRecord;

	const rows = await Record.query()
		.native(() => ({ list: [{ id: 1, title: 'alias native' }] }), 'alias')
		.load();
	const count = await Record.query()
		.native(() => ({ count: 7 }), 'alias')
		.count();

	assert.deepEqual(rows.list.map((item) => item.data.title), ['alias native']);
	assert.equal(count, 7);
	assert.equal(querySeenAdapter, undefined);
	assert.equal(aggregateSeenAdapter, undefined);
});

test('native search adapter names fail fast when the search adapter is not registered', async () => {
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory: new MemorySearchAdapter() },
		defaultSearch: 'memory'
	});
	const Record = NativeSafetyRecord.use(context) as unknown as typeof NativeSafetyRecord;

	await assert.rejects(
		() => Record.search('safe').using('missing-search').native({ query: { match_all: {} } }).load(),
		/Search adapter "missing-search" is not registered/
	);
});

test('native payloads must be explicitly defined before routing', async () => {
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory: new MemorySearchAdapter() },
		defaultSearch: 'memory'
	});
	const Record = NativeSafetyRecord.use(context) as unknown as typeof NativeSafetyRecord;

	assert.throws(() => Record.query().native(undefined), /native payload is required/);
	assert.throws(() => Record.search('safe').native(undefined), /native payload is required/);

	let queryCalls = 0;
	let aggregateCalls = 0;
	const nativeStore: StoreAdapter = {
		kind: 'undefined-native-store',
		capabilities: { ...new MemoryStoreAdapter().capabilities, transaction: false, native: true, aggregate: true },
		get: async () => null,
		getMany: async () => [],
		query: async () => {
			queryCalls++;
			return { list: [] };
		},
		aggregate: async () => {
			aggregateCalls++;
			return { count: 0 };
		},
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	const hookContext = createActiveTs({
		stores: { default: nativeStore },
		plugins: [
			{
				name: 'undefined-native-payload',
				hooks: {
					beforeQuery(payload) {
						(payload.plan as any).native = { payload: undefined };
					},
					beforeAggregate(payload) {
						(payload.plan as any).native = { payload: undefined };
					}
				}
			}
		]
	});
	const HookRecord = NativeSafetyRecord.use(hookContext) as unknown as typeof NativeSafetyRecord;

	await assert.rejects(() => HookRecord.query().load(), /query native\.payload is required/);
	await assert.rejects(() => HookRecord.count(), /aggregate native\.payload is required/);
	assert.equal(queryCalls, 0);
	assert.equal(aggregateCalls, 0);
});

test('native payload clones reject accessors before adapters run', async () => {
	let getterCalls = 0;
	let queryCalls = 0;
	let searchCalls = 0;
	const store: StoreAdapter = {
		kind: 'native-payload-store',
		capabilities: { native: true },
		get: async () => null,
		getMany: async () => [],
		query: async () => {
			queryCalls++;
			return { list: [], more: false };
		},
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	const search: SearchAdapter = {
		kind: 'native-payload-search',
		capabilities: { native: true },
		search: async () => {
			searchCalls++;
			return { list: [], more: false };
		},
		index: async () => undefined,
		delete: async () => undefined
	};
	const context = createActiveTs({ stores: { default: store }, search: { default: search } });
	const Record = NativeSafetyRecord.use(context) as unknown as typeof NativeSafetyRecord;
	const accessorPayload = Object.defineProperty({}, 'filter', {
		enumerable: true,
		get() {
			getterCalls++;
			return {};
		}
	});

	assert.throws(() => Record.query().native(accessorPayload), /native payload\.filter must be a data property/);
	assert.throws(() => Record.search('safe').native(accessorPayload), /native payload\.filter must be a data property/);
	assert.equal(getterCalls, 0);
	assert.equal(queryCalls, 0);
	assert.equal(searchCalls, 0);
});

test('native payload clones reject symbol-bearing arrays before adapters run', async () => {
	let iteratorCalls = 0;
	let queryCalls = 0;
	let searchCalls = 0;
	const store: StoreAdapter = {
		kind: 'native-symbol-array-store',
		capabilities: { native: true },
		get: async () => null,
		getMany: async () => [],
		query: async () => {
			queryCalls++;
			return { list: [], more: false };
		},
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	const search: SearchAdapter = {
		kind: 'native-symbol-array-search',
		capabilities: { native: true },
		search: async () => {
			searchCalls++;
			return { list: [], more: false };
		},
		index: async () => undefined,
		delete: async () => undefined
	};
	const context = createActiveTs({ stores: { default: store }, search: { default: search } });
	const Record = NativeSafetyRecord.use(context) as unknown as typeof NativeSafetyRecord;
	const values = ['safe'] as unknown[];
	Object.defineProperty(values, Symbol.iterator, {
		configurable: true,
		value: function* () {
			iteratorCalls++;
			yield 'polluted';
		}
	});

	assert.throws(
		() => Record.query().native({ values }),
		/native payload\.values cannot contain symbol fields/
	);
	assert.throws(
		() => Record.search('safe').native({ values }),
		/native payload\.values cannot contain symbol fields/
	);
	assert.equal(iteratorCalls, 0);
	assert.equal(queryCalls, 0);
	assert.equal(searchCalls, 0);
});

test('native payload clones reject hidden fields and array metadata before adapters run', async () => {
	let queryCalls = 0;
	let searchCalls = 0;
	const store: StoreAdapter = {
		kind: 'native-hidden-payload-store',
		capabilities: { native: true },
		get: async () => null,
		getMany: async () => [],
		query: async () => {
			queryCalls++;
			return { list: [], more: false };
		},
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	const search: SearchAdapter = {
		kind: 'native-hidden-payload-search',
		capabilities: { native: true },
		search: async () => {
			searchCalls++;
			return { list: [], more: false };
		},
		index: async () => undefined,
		delete: async () => undefined
	};
	const context = createActiveTs({ stores: { default: store }, search: { default: search } });
	const Record = NativeSafetyRecord.use(context) as unknown as typeof NativeSafetyRecord;
	const hiddenPayload = Object.defineProperty({}, 'filter', {
		enumerable: false,
		value: {}
	});
	const values = ['safe'] as unknown[];
	Object.defineProperty(values, 'meta', {
		enumerable: false,
		value: 'hidden'
	});

	assert.throws(() => Record.query().native(hiddenPayload), /native payload\.filter must be enumerable/);
	assert.throws(
		() => Record.search('safe').native({ values }),
		/native payload\.values cannot contain non-index array property "meta"/
	);
	assert.equal(queryCalls, 0);
	assert.equal(searchCalls, 0);
});

test('native payload clones mutable built-in values before adapters run', async () => {
	let queryNative: any;
	let searchNative: any;
	const store: StoreAdapter = {
		kind: 'native-builtins-store',
		capabilities: { native: true },
		get: async () => null,
		getMany: async () => [],
		query: async (_model, _plan, options) => {
			queryNative = options?.native;
			return { list: [], more: false };
		},
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	const search: SearchAdapter = {
		kind: 'native-builtins-search',
		capabilities: { native: true },
		search: async (_model, _query, options) => {
			searchNative = options.native;
			return { list: [], more: false };
		},
		index: async () => undefined,
		delete: async () => undefined
	};
	const context = createActiveTs({ stores: { default: store }, search: { memory: search } });
	const Record = NativeSafetyRecord.use(context) as unknown as typeof NativeSafetyRecord;
	class HostileDate extends Date {
		override getTime(): number {
			throw new Error('custom getTime should not run');
		}

		override toISOString(): string {
			throw new Error('custom toISOString should not run');
		}
	}
	const date = new HostileDate('2026-01-01T00:00:00.000Z');
	const bytes = new Uint8Array([1, 2, 3]);
	const pattern = /safe/gi;
	pattern.lastIndex = 2;
	const payload = { filter: { date, bytes, pattern } } as any;

	const query = Record.query().native(payload);
	const searchQuery = Record.search('safe').native(payload);
	date.setUTCFullYear(2030);
	bytes[0] = 9;
	pattern.lastIndex = 0;
	payload.filter.extra = 'late mutation';

	await query.load();
	await searchQuery.load();

	for (const native of [queryNative, searchNative]) {
		assert.equal(native.filter.date.toISOString(), '2026-01-01T00:00:00.000Z');
		assert.notEqual(native.filter.date, date);
		assert.deepEqual(Array.from(native.filter.bytes), [1, 2, 3]);
		assert.notEqual(native.filter.bytes, bytes);
		assert.equal(native.filter.pattern.source, 'safe');
		assert.equal(native.filter.pattern.flags, 'gi');
		assert.equal(native.filter.pattern.lastIndex, 2);
		assert.equal(native.filter.extra, undefined);
	}
});

test('native payload cloning ignores polluted collection tracking methods', () => {
	const weakMapGet = Object.getOwnPropertyDescriptor(WeakMap.prototype, 'get')!;
	const weakMapHas = Object.getOwnPropertyDescriptor(WeakMap.prototype, 'has')!;
	const weakMapSet = Object.getOwnPropertyDescriptor(WeakMap.prototype, 'set')!;
	const weakSetAdd = Object.getOwnPropertyDescriptor(WeakSet.prototype, 'add')!;
	const weakSetHas = Object.getOwnPropertyDescriptor(WeakSet.prototype, 'has')!;
	const weakSetDelete = Object.getOwnPropertyDescriptor(WeakSet.prototype, 'delete')!;
	const setHas = Object.getOwnPropertyDescriptor(Set.prototype, 'has')!;
	const setAdd = Object.getOwnPropertyDescriptor(Set.prototype, 'add')!;
	try {
		Object.defineProperty(WeakMap.prototype, 'get', {
			value() {
				throw new Error('patched WeakMap.get should not run');
			}
		});
		Object.defineProperty(WeakMap.prototype, 'has', {
			value() {
				throw new Error('patched WeakMap.has should not run');
			}
		});
		Object.defineProperty(WeakMap.prototype, 'set', {
			value() {
				throw new Error('patched WeakMap.set should not run');
			}
		});
		Object.defineProperty(WeakSet.prototype, 'add', {
			value() {
				throw new Error('patched WeakSet.add should not run');
			}
		});
		Object.defineProperty(WeakSet.prototype, 'has', {
			value() {
				throw new Error('patched WeakSet.has should not run');
			}
		});
		Object.defineProperty(WeakSet.prototype, 'delete', {
			value() {
				throw new Error('patched WeakSet.delete should not run');
			}
		});
		Object.defineProperty(Set.prototype, 'has', {
			value() {
				throw new Error('patched Set.has should not run');
			}
		});
		Object.defineProperty(Set.prototype, 'add', {
			value() {
				throw new Error('patched Set.add should not run');
			}
		});

		const nativePayload: any = { filter: { pattern: /safe/g } };
		nativePayload.self = nativePayload;
		const nativeClone = cloneNativePayload(nativePayload) as any;
		assert.equal(nativeClone.self, nativeClone);
		assert.ok(nativeClone.filter.pattern instanceof RegExp);

		const jsonPayload = { nested: { value: 1 } };
		const jsonClone = cloneJsonTransportPayload(jsonPayload) as any;
		assert.equal(jsonClone.nested.value, 1);

		const circularJson: any = {};
		circularJson.self = circularJson;
		assert.throws(() => cloneJsonTransportPayload(circularJson), /circular references/);
	} finally {
		Object.defineProperty(WeakMap.prototype, 'get', weakMapGet);
		Object.defineProperty(WeakMap.prototype, 'has', weakMapHas);
		Object.defineProperty(WeakMap.prototype, 'set', weakMapSet);
		Object.defineProperty(WeakSet.prototype, 'add', weakSetAdd);
		Object.defineProperty(WeakSet.prototype, 'has', weakSetHas);
		Object.defineProperty(WeakSet.prototype, 'delete', weakSetDelete);
		Object.defineProperty(Set.prototype, 'has', setHas);
		Object.defineProperty(Set.prototype, 'add', setAdd);
	}
});

test('native payload clones reject RegExp subclasses without invoking accessors', async () => {
	let queryCalls = 0;
	let searchCalls = 0;
	let sourceReads = 0;
	let flagReads = 0;
	const store: StoreAdapter = {
		kind: 'native-regexp-subclass-store',
		capabilities: { native: true },
		get: async () => null,
		getMany: async () => [],
		query: async () => {
			queryCalls++;
			return { list: [], more: false };
		},
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	const search: SearchAdapter = {
		kind: 'native-regexp-subclass-search',
		capabilities: { native: true },
		search: async () => {
			searchCalls++;
			return { list: [], more: false };
		},
		index: async () => undefined,
		delete: async () => undefined
	};
	const context = createActiveTs({ stores: { default: store }, search: { memory: search } });
	const Record = NativeSafetyRecord.use(context) as unknown as typeof NativeSafetyRecord;
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
	const pattern = new HostileRegExp('safe', 'gi');

	assert.throws(
		() => Record.query().native({ filter: { pattern } }),
		/native payload\.filter\.pattern must be a built-in RegExp value/
	);
	assert.throws(
		() => Record.search('safe').native({ filter: { pattern } }),
		/native payload\.filter\.pattern must be a built-in RegExp value/
	);
	assert.equal(sourceReads, 0);
	assert.equal(flagReads, 0);
	assert.equal(queryCalls, 0);
	assert.equal(searchCalls, 0);
});

test('native payload built-ins reject custom own properties before cloning', async () => {
	let queryCalls = 0;
	let searchCalls = 0;
	const store: StoreAdapter = {
		kind: 'native-custom-builtins-store',
		capabilities: { native: true },
		get: async () => null,
		getMany: async () => [],
		query: async () => {
			queryCalls++;
			return { list: [], more: false };
		},
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	const search: SearchAdapter = {
		kind: 'native-custom-builtins-search',
		capabilities: { native: true },
		search: async () => {
			searchCalls++;
			return { list: [], more: false };
		},
		index: async () => undefined,
		delete: async () => undefined
	};
	const context = createActiveTs({ stores: { default: store }, search: { memory: search } });
	const Record = NativeSafetyRecord.use(context) as unknown as typeof NativeSafetyRecord;
	const date = new Date('2026-01-01T00:00:00.000Z') as Date & { extra?: string };
	date.extra = 'dropped';
	const pattern = /safe/ as RegExp & { extra?: string };
	pattern.extra = 'dropped';
	const bytes = new Uint8Array([1, 2, 3]) as Uint8Array & { extra?: string };
	bytes.extra = 'dropped';
	const buffer = new ArrayBuffer(2);
	Object.defineProperty(buffer, Symbol('extra'), { value: true });
	const view = new DataView(new ArrayBuffer(2));
	Object.defineProperty(view, '0', { value: 'dropped' });

	assert.throws(
		() => Record.query().native({ filter: { date } }),
		/native payload\.filter\.date cannot contain custom built-in property "extra"/
	);
	assert.throws(
		() => Record.query().native({ filter: { pattern } }),
		/native payload\.filter\.pattern cannot contain custom built-in property "extra"/
	);
	assert.throws(
		() => Record.query().native({ filter: { bytes } }),
		/native payload\.filter\.bytes cannot contain custom built-in property "extra"/
	);
	assert.throws(
		() => Record.query().native({ filter: { buffer } }),
		/native payload\.filter\.buffer cannot contain symbol fields/
	);
	assert.throws(
		() => Record.query().native({ filter: { view } }),
		/native payload\.filter\.view cannot contain custom built-in property "0"/
	);
	assert.throws(
		() => Record.search('safe').native({ filter: { date } }),
		/native payload\.filter\.date cannot contain custom built-in property "extra"/
	);
	assert.equal(queryCalls, 0);
	assert.equal(searchCalls, 0);
});

test('native payload clones reject opaque object values before adapters run', async () => {
	let queryCalls = 0;
	let searchCalls = 0;
	const store: StoreAdapter = {
		kind: 'native-opaque-store',
		capabilities: { native: true },
		get: async () => null,
		getMany: async () => [],
		query: async () => {
			queryCalls++;
			return { list: [], more: false };
		},
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	const search: SearchAdapter = {
		kind: 'native-opaque-search',
		capabilities: { native: true },
		search: async () => {
			searchCalls++;
			return { list: [], more: false };
		},
		index: async () => undefined,
		delete: async () => undefined
	};
	const context = createActiveTs({ stores: { default: store }, search: { memory: search } });
	const Record = NativeSafetyRecord.use(context) as unknown as typeof NativeSafetyRecord;
	class OpaquePayload {
		constructor(readonly value: string) {}
	}

	assert.throws(
		() => Record.query().native({ filter: new Map([['title', 'safe']]) }),
		/native payload\.filter must be a plain object, array, function, or supported built-in value/
	);
	assert.throws(
		() => Record.query().native({ filter: new Set(['safe']) }),
		/native payload\.filter must be a plain object, array, function, or supported built-in value/
	);
	assert.throws(
		() => Record.search('safe').native({ filter: new OpaquePayload('safe') }),
		/native payload\.filter must be a plain object, array, function, or supported built-in value/
	);
	assert.throws(
		() => Record.search('safe').native(new WeakMap()),
		/native payload must be a plain object, array, function, or supported built-in value/
	);
	assert.equal(queryCalls, 0);
	assert.equal(searchCalls, 0);
});

test('adapter lookup rejects reserved prototype adapter names', async () => {
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory: new MemorySearchAdapter() },
		defaultSearch: 'memory'
	});
	const Record = NativeSafetyRecord.use(context) as unknown as typeof NativeSafetyRecord;

	assert.throws(
		() => Record.query().native({ text: 'select 1' }, '__proto__'),
		/native store adapter name.*not allowed/
	);
	assert.throws(
		() => Record.search('safe').using('__proto__'),
		/search adapter name.*not allowed/
	);
	assert.throws(
		() => createActiveTs({ stores: { default: new MemoryStoreAdapter() }, defaultCache: '__proto__' }).cache('__proto__'),
		/cache adapter name.*not allowed/
	);
});

test('adapter lookup rejects non-string adapter names without raw type errors', async () => {
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory: new MemorySearchAdapter() }
	});
	const Record = NativeSafetyRecord.use(context) as unknown as typeof NativeSafetyRecord;

	assert.throws(
		() => Record.query().native({ text: 'select 1' }, false as any),
		/native store adapter name must be a string/
	);
	assert.throws(
		() => Record.search('safe').using(false as any),
		/search adapter name must be a string/
	);
});

test('PostgreSQL native payloads require own plain text and values fields', async () => {
	const calls: Array<{ text: string; values: unknown[] }> = [];
	const store = await createPostgresStoreAdapter({
		pool: {
			query: async (text: string, values: unknown[]) => {
				calls.push({ text, values });
				return { rows: [] };
			}
		}
	});
	const context = createActiveTs({ stores: { default: store } });
	const Record = NativeSafetyRecord.use(context) as unknown as typeof NativeSafetyRecord;

	Object.defineProperties(Object.prototype, {
		text: { value: 'select data from native_safety_record', configurable: true },
		values: { value: ['polluted'], configurable: true }
	});
	try {
		await assert.rejects(
			() => Record.query().native({}).load(),
			/PostgreSQL native payload text must be a non-empty string/
		);
	} finally {
		delete (Object.prototype as Record<string, unknown>).text;
		delete (Object.prototype as Record<string, unknown>).values;
	}

	assert.throws(
		() => Record.query().native(Object.create({ text: 'select data from native_safety_record' })),
		/native payload must be a plain object, array, function, or supported built-in value/
	);
	assert.throws(
		() => Record.query().native({ text: 'select $1', values: Object.create([]) }),
		/native payload\.values must be a plain object, array, function, or supported built-in value/
	);
	await assert.rejects(
		() => Record.query().native({ text: 'select $1', value: [1] }).load(),
		/PostgreSQL native payload contains unknown option "value"/
	);
	assert.throws(
		() => Record.query().native({ text: 'select $1', values: new Array(1) }),
		/native payload\.values\[0\] is missing/
	);
	const meta = context.meta(NativeSafetyRecord);
	await assert.rejects(
		() =>
			store.query(meta, {
				where: [],
				or: [],
				sort: [],
				include: [],
				native: { payload: { text: 'select $1', [Symbol('text')]: 'hidden' } }
			} as any),
		/PostgreSQL query plan\.native\.payload cannot contain symbol fields/
	);
	let iteratorCalls = 0;
	const values = [1] as unknown[];
	Object.defineProperty(values, Symbol.iterator, {
		configurable: true,
		value: function* () {
			iteratorCalls++;
			yield 'polluted';
		}
	});
	await assert.rejects(
		() =>
			store.query(meta, {
				where: [],
				or: [],
				sort: [],
				include: [],
				native: { payload: { text: 'select $1', values } }
			} as any),
		/PostgreSQL query plan\.native\.payload\.values cannot contain symbol fields/
	);
	assert.equal(iteratorCalls, 0);
	await assert.rejects(
		() => Record.query().native({ text: 'select $1', values: [() => 1] }).load(),
		/PostgreSQL native payload values\[0\] must not be a function/
	);
	await assert.rejects(
		() => Record.query().native({ text: 'select $1', values: [Symbol('unsafe')] }).load(),
		/PostgreSQL native payload values\[0\] must not be a symbol/
	);
	await assert.rejects(
		() => Record.query().native({ text: 'select $1', values: [undefined] }).load(),
		/PostgreSQL native payload values\[0\] must not be undefined/
	);
	await assert.rejects(
		() => Record.query().native({ text: 'select $1', values: [{ nested: () => 1 }] }).load(),
		/PostgreSQL native payload values\[0\]\.nested must not be a function/
	);
	const cyclic: Record<string, unknown> = {};
	cyclic.self = cyclic;
	await assert.rejects(
		() => Record.query().native({ text: 'select $1', values: [cyclic] }).load(),
		/PostgreSQL native payload values\[0\]\.self must not contain circular references/
	);
	assert.deepEqual(calls, []);
});

test('PostgreSQL native SQL bind values do not expose inherited toPostgres serializers', async () => {
	const calls: Array<{ text: string; values: unknown[] }> = [];
	const store = await createPostgresStoreAdapter({
		pool: {
			query: async (text: string, values: unknown[] = []) => {
				calls.push({ text, values });
				return { rows: [{ data: { id: 1, title: 'safe' } }] };
			}
		}
	});
	const context = createActiveTs({ stores: { default: store } });
	const Record = NativeSafetyRecord.use(context) as unknown as typeof NativeSafetyRecord;
	Object.defineProperty(Object.prototype, 'toPostgres', {
		configurable: true,
		value() {
			throw new Error('inherited toPostgres should not be visible to pg');
		}
	});
	try {
		const result = await Record.query()
			.native({ text: 'select data from native_safety_record where data @> $1', values: [{ safe: true, nested: ['ok'] }] })
			.load();
		assert.deepEqual(result.list.map((item) => item.data.id), [1]);
	} finally {
		delete (Object.prototype as Record<string, unknown>).toPostgres;
	}

	const [bind] = calls[0].values;
	assert.equal(typeof bind, 'object');
	assert.ok(bind !== null);
	assert.equal('toPostgres' in (bind as object), false);
	assert.equal(Object.getPrototypeOf(bind), null);
	const nested = (bind as { nested: unknown[] }).nested;
	assert.equal(Array.isArray(nested), true);
	assert.equal('toPostgres' in nested, false);
	assert.equal(Object.getPrototypeOf(nested), null);
});

test('PostgreSQL native SQL query rows are safe-cloned before direct return', async () => {
	let row: any = { data: { id: 1, title: 'safe' } };
	const store = await createPostgresStoreAdapter({
		pool: {
			query: async () => ({ rows: [row] })
		}
	});
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(NativeSafetyRecord);
	const plan = {
		where: [],
		or: [],
		sort: [],
		include: [],
		native: { payload: { text: 'select data from native_safety_record' } }
	};

	const result = await store.query(meta, plan);
	row.data.title = 'mutated';
	assert.deepEqual(result.list, [{ id: 1, title: 'safe' }]);
	row = { data: { id: 1, title: 'unsafe', __unsafe: true } };
	await assert.rejects(() => store.query(meta, plan), /Reserved data key/);
	row = { data: { title: 'missing-id' } };
	await assert.rejects(() => store.query(meta, plan), /PostgreSQL native query result\.list\[0\] is missing id field "id"/);
});

test('PostgreSQL native SQL adapter tags reject before direct pool query', async () => {
	let queryCalls = 0;
	const store = await createPostgresStoreAdapter({
		pool: {
			query: async () => {
				queryCalls++;
				return { rows: [] };
			}
		}
	});
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(NativeSafetyRecord);

	await assert.rejects(
		() =>
			store.query(meta, {
				where: [],
				or: [],
				sort: [],
				include: [],
				native: {
					adapter: 'other_store',
					payload: { text: 'select data from native_safety_record' }
				}
			}),
		/native store plan targets store adapter "other_store" but reached store adapter "postgresql"/
	);
	assert.equal(queryCalls, 0);
});

test('store native function query results are normalized before direct return', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(NativeSafetyRecord);
	const stores: Array<[string, StoreAdapter]> = [
		[
			'PostgreSQL',
			await createPostgresStoreAdapter({
				pool: { query: async () => ({ rows: [] }) }
			})
		],
		[
			'MongoDB',
			await createMongoStoreAdapter({
				dbName: 'native_safety',
				client: { db: () => ({ collection: () => ({}) }) }
			})
		],
		[
			'Firestore',
			await createFirestoreStoreAdapter({
				client: firestoreClient()
			})
		],
		[
			'Datastore',
			await createDatastoreStoreAdapter({
				client: datastoreClient()
			})
		]
	];
	const planFor = (payload: unknown) => ({
		where: [],
		or: [],
		sort: [],
		include: [],
		native: { payload }
	});

	for (const [label, store] of stores) {
		const result = await store.query(meta, planFor(() => ({
			list: [{ id: 1, title: `${label} native` }],
			count: 999,
			total: 12
		})));
		assert.deepEqual(result, {
			list: [{ id: 1, title: `${label} native` }],
			cursor: undefined,
			more: undefined,
			count: 1,
			total: 12
		});
		const list = [{ id: 2, title: `${label} snapshot` }] as any[];
		let mapCalls = 0;
		Object.defineProperty(list, 'map', {
			value() {
				mapCalls++;
				throw new Error('custom native result list.map should not run');
			}
		});
		assert.deepEqual(
			await store.query(meta, planFor(() => ({ list }))),
			{
				list: [{ id: 2, title: `${label} snapshot` }],
				cursor: undefined,
				more: undefined,
				count: 1,
				total: undefined
			}
		);
		assert.equal(mapCalls, 0);
		await assert.rejects(
			() => store.query(meta, planFor(() => ({ list: [{ id: 1, title: 'bad', __unsafe: true }] }))),
			/Reserved data key/
		);
		await assert.rejects(
			() => store.query(meta, planFor(() => ({ list: [{ title: 'missing-id' }] }))),
			new RegExp(`${label} native function query result\\.list\\[0\\] is missing id field "id"`)
		);
		await assert.rejects(
			() => store.query(meta, planFor(() => ({ list: [{ id: {}, title: 'bad-id' }] }))),
			new RegExp(`${label} native function query result\\.list\\[0\\]\\.id`)
		);
		await assert.rejects(
			() => store.query(meta, planFor(() => ({ list: [{ id: 1, title: 'bad total' }], total: 1.5 }))),
			new RegExp(`${label} native function query result\\.total`)
		);
		const nativeCursorQuery = () =>
			store.query(meta, planFor(() => ({
				list: [{ id: 1, title: 'cursor result' }],
				more: true,
				cursor: 'backend-cursor'
			})));
		if (store.capabilities?.cursor === true) {
			assert.deepEqual(await nativeCursorQuery(), {
				list: [{ id: 1, title: 'cursor result' }],
				cursor: 'backend-cursor',
				more: true,
				count: 1,
				total: undefined
			});
		} else {
			await assert.rejects(
				nativeCursorQuery,
				new RegExp(`Store adapter "${store.kind}" does not support returning portable cursors`)
			);
		}
		let mismatchCalls = 0;
		await assert.rejects(
			() =>
				store.query(meta, {
					where: [],
					or: [],
					sort: [],
					include: [],
					native: {
						adapter: 'other_store',
						payload: () => {
							mismatchCalls++;
							return { list: [] };
						}
					}
				}),
			new RegExp(`native store plan targets store adapter "other_store" but reached store adapter "${store.kind}"`)
		);
		assert.equal(mismatchCalls, 0);
	}
});

test('direct store adapters reject non-object row payloads', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(NativeSafetyRecord);
	const memory = new MemoryStoreAdapter();
	await assert.rejects(() => memory.create(meta, 1, 'bad row' as any), /stored data must be a plain object/);

	const postgres = await createPostgresStoreAdapter({
		pool: { query: async () => ({ rows: [{ id: 'number:1', data: 'bad row' }] }) }
	});
	await assert.rejects(() => postgres.get(meta, 1), /PostgreSQL get row data must be a plain object/);

	const mongodb = await createMongoStoreAdapter({
		dbName: 'native_safety',
		client: {
			db: () => ({
				collection: () => ({
					findOne: async () => 'bad row'
				})
			})
		}
	});
	await assert.rejects(() => mongodb.get(meta, 1), /MongoDB document must be a plain object/);

	const firestore = await createFirestoreStoreAdapter({
		client: firestoreClient({
			collection: () => ({
				doc: () => ({
					get: async () => ({ exists: true, data: () => 'bad row' })
				})
			})
		})
	});
	await assert.rejects(() => firestore.get(meta, 1), /Firestore document snapshot\.data result must be a plain object/);

	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			get: async () => ['bad row']
		})
	});
	await assert.rejects(() => datastore.get(meta, 1), /Datastore entity must be a plain object/);
});

test('direct backend store adapters reject accessor result fields without invoking them', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(NativeSafetyRecord);
	let getterCalls = 0;

	const postgresResult = Object.defineProperty({}, 'rows', {
		enumerable: true,
		get() {
			getterCalls++;
			return [];
		}
	});
	const postgres = await createPostgresStoreAdapter({
		pool: { query: async () => postgresResult }
	});
	await assert.rejects(() => postgres.get(meta, 1), /rows must be a data property/);
	assert.equal(getterCalls, 0);
	const hiddenPostgresResult = Object.defineProperty({}, 'rows', {
		enumerable: false,
		value: []
	});
	const hiddenPostgres = await createPostgresStoreAdapter({
		pool: { query: async () => hiddenPostgresResult }
	});
	await assert.rejects(() => hiddenPostgres.get(meta, 1), /rows must be enumerable/);

	const mongoResult = Object.defineProperty({}, 'matchedCount', {
		enumerable: true,
		get() {
			getterCalls++;
			return 1;
		}
	});
	const mongodb = await createMongoStoreAdapter({
		dbName: 'native_safety',
		client: {
			db: () => ({
				collection: () => ({
					replaceOne: async () => mongoResult
				})
			})
		}
	});
	await assert.rejects(() => mongodb.update(meta, 1, { id: 1, title: 'mongo' }), /matchedCount must be a data property/);
	assert.equal(getterCalls, 0);
	const hiddenMongoResult = Object.defineProperty({}, 'matchedCount', {
		enumerable: false,
		value: 1
	});
	const hiddenMongodb = await createMongoStoreAdapter({
		dbName: 'native_safety',
		client: {
			db: () => ({
				collection: () => ({
					replaceOne: async () => hiddenMongoResult
				})
			})
		}
	});
	await assert.rejects(() => hiddenMongodb.update(meta, 1, { id: 1, title: 'mongo' }), /matchedCount must be enumerable/);

	const datastoreInfo = Object.defineProperty({}, 'moreResults', {
		enumerable: true,
		get() {
			getterCalls++;
			return 'NO_MORE_RESULTS';
		}
	});
	const datastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			createQuery: () => ({
				filter() {
					return this;
				}
			}),
			runQuery: async () => [[], datastoreInfo]
		})
	});
	await assert.rejects(
		() => datastore.query(meta, { where: [{ field: 'title', op: '=', value: 'one' }], or: [], sort: [], include: [] }),
		/moreResults must be a data property/
		);
	assert.equal(getterCalls, 0);
	const hiddenDatastoreInfo = Object.defineProperty({}, 'moreResults', {
		enumerable: false,
		value: 'NO_MORE_RESULTS'
	});
	const hiddenDatastore = await createDatastoreStoreAdapter({
		client: datastoreClient({
			createQuery: () => ({
				filter() {
					return this;
				}
			}),
			runQuery: async () => [[], hiddenDatastoreInfo]
		})
	});
	await assert.rejects(
		() => hiddenDatastore.query(meta, { where: [{ field: 'title', op: '=', value: 'one' }], or: [], sort: [], include: [] }),
		/moreResults must be enumerable/
	);
});

test('store native function aggregate results are normalized before direct return', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(NativeSafetyRecord);
	const stores: Array<[string, StoreAdapter]> = [
		[
			'PostgreSQL',
			await createPostgresStoreAdapter({
				pool: { query: async () => ({ rows: [] }) }
			})
		],
		[
			'MongoDB',
			await createMongoStoreAdapter({
				dbName: 'native_safety',
				client: { db: () => ({ collection: () => ({}) }) }
			})
		],
		[
			'Firestore',
			await createFirestoreStoreAdapter({
				client: firestoreClient()
			})
		]
	];
	const planFor = (payload: unknown, adapter?: string) => ({
		where: [],
		or: [],
		aggregates: [
			{ op: 'count' as const, as: 'count' },
			{ op: 'max' as const, field: 'title', as: 'maxTitle' }
		],
		native: { adapter, payload }
	});

	for (const [label, store] of stores) {
		assert.deepEqual(await store.aggregate!(meta, planFor(() => ({ count: '2', maxTitle: `${label} title` }))), {
			count: 2,
			maxTitle: `${label} title`
		});
		await assert.rejects(
			() => store.aggregate!(meta, planFor(() => ({ count: 1, maxTitle: { nested: true } }))),
			/scalar comparable values/
		);
		let mismatchCalls = 0;
		await assert.rejects(
			() =>
				store.aggregate!(meta, planFor(() => {
					mismatchCalls++;
					return { count: 0, maxTitle: null };
				}, 'other_store')),
			new RegExp(`native store plan targets store adapter "other_store" but reached store adapter "${store.kind}"`)
		);
		assert.equal(mismatchCalls, 0);
	}
});

test('unregistered model helpers and missing ids use active-ts errors', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const Record = NativeSafetyRecord.use(context) as unknown as typeof NativeSafetyRecord;
	const BadScope = BadScopeRecord.use(context) as unknown as typeof BadScopeRecord;
	const item = await Record.create({ id: 1, title: 'created' });

	assert.throws(
		() => Record.query().scope('missing'),
		(error: unknown) =>
			error instanceof ActiveTsConfigurationError &&
			/Scope "missing" is not registered/.test(error.message)
	);
	assert.throws(
		() => BadScope.query().scope('nullish'),
		/query where must be a plain object/
	);
	assert.throws(
		() => item.ref('missing'),
		(error: unknown) =>
			error instanceof ActiveTsConfigurationError &&
			/Relation "missing" is not registered/.test(error.message)
	);
	await assert.rejects(
		() => Record.query().include('missing').load(),
		(error: unknown) =>
			error instanceof ActiveTsConfigurationError &&
			/Relation "missing" is not registered/.test(error.message)
	);
	await assert.rejects(
		() => item.view('missing'),
		(error: unknown) =>
			error instanceof ActiveTsConfigurationError &&
			/View "missing" is not registered/.test(error.message)
	);
	await assert.rejects(
		() => item.can('missing'),
		(error: unknown) =>
			error instanceof ActiveTsConfigurationError &&
			/Policy "missing" is not registered/.test(error.message)
	);
	let helperNameCoercions = 0;
	const hostileHelperName = {
		toString() {
			helperNameCoercions++;
			throw new Error('helper name toString should not run');
		}
	};
	await assert.rejects(
		() => item.view(hostileHelperName as any),
		(error: unknown) =>
			error instanceof ActiveTsValidationError &&
			/view name must be a string/.test(error.message)
	);
	await assert.rejects(
		() => item.can(hostileHelperName as any),
		(error: unknown) =>
			error instanceof ActiveTsValidationError &&
			/policy name must be a string/.test(error.message)
	);
	assert.equal(helperNameCoercions, 0);
	await assert.rejects(
		() => Record.create({ title: 'missing id' } as any),
		(error: unknown) =>
			error instanceof ActiveTsValidationError &&
			/Cannot create native_safety_record without id field "id"/.test(error.message)
	);
	await assert.rejects(
		() => new NativeSafetyRecord({ title: 'missing id' } as any, context).save(),
		(error: unknown) =>
			error instanceof ActiveTsValidationError &&
			/Cannot save native_safety_record without id field "id"/.test(error.message)
	);
});

test('public model construction helpers validate runtime targets', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const item = new NativeSafetyRecord({ id: 1, title: 'local' }, context);

	assert.throws(
		() => new NativeSafetyRecord({ id: 2, title: 'bad' }, {} as any),
		(error: unknown) =>
			error instanceof ActiveTsConfigurationError &&
			/Model constructor context must be an ActiveContext/.test(error.message)
	);
	assert.throws(
		() => getRelation(null as any, { name: 'missing' } as any),
		(error: unknown) =>
			error instanceof ActiveTsConfigurationError &&
			/getRelation model must be an active-ts model instance/.test(error.message)
	);
	let relationHelperReads = 0;
	const accessorModel = Object.defineProperty({}, 'ref', {
		enumerable: true,
		get() {
			relationHelperReads++;
			return () => null;
		}
	});
	assert.throws(
		() => getRelation(accessorModel as any, { name: 'profile' } as any),
		(error: unknown) =>
			error instanceof ActiveTsConfigurationError &&
			/getRelation model\.ref must be a data property/.test(error.message)
	);
	const hiddenRefModel = Object.defineProperty({}, 'ref', {
		enumerable: false,
		value: () => {
			throw new Error('hidden ref should not run');
		}
	});
	assert.throws(
		() => getRelation(hiddenRefModel as any, { name: 'profile' } as any),
		(error: unknown) =>
			error instanceof ActiveTsConfigurationError &&
			/getRelation model\.ref must be enumerable/.test(error.message)
	);
	assert.throws(
		() => getRelation(item, null as any),
		(error: unknown) =>
			error instanceof ActiveTsConfigurationError &&
			/getRelation relation must be a relation metadata object/.test(error.message)
	);
	const accessorRelation = Object.defineProperty({}, 'name', {
		enumerable: true,
		get() {
			relationHelperReads++;
			return 'profile';
		}
	});
	assert.throws(
		() => getRelation(item, accessorRelation as any),
		(error: unknown) =>
			error instanceof ActiveTsConfigurationError &&
			/getRelation relation\.name must be a data property/.test(error.message)
	);
	const hiddenRelation = Object.defineProperty({}, 'name', {
		enumerable: false,
		value: 'profile'
	});
	assert.throws(
		() => getRelation(item, hiddenRelation as any),
		(error: unknown) =>
			error instanceof ActiveTsConfigurationError &&
			/getRelation relation\.name must be enumerable/.test(error.message)
	);
	assert.equal(relationHelperReads, 0);
	assert.throws(() => getRelation(item, { name: '__proto__' } as any), /Reserved relation name/);
	assert.throws(() => getRelation(item, { name: 'profile.team' } as any), /relation name .*must be a top-level field/);
	assert.throws(
		() => context.instantiate(NativeSafetyRecord, { id: 3, title: 'bad partial' }, { partial: 'yes' } as any),
		/instantiate options\.partial must be a boolean/
	);
	assert.throws(
		() => context.instantiate(NativeSafetyRecord, { id: 3, title: 'bad partial' }, { projection: true } as any),
		/instantiate options contains unknown option "projection"/
	);
	assert.throws(
		() => context.validateRead(context.meta(NativeSafetyRecord), { id: 4, title: 'bad options' }, null as any),
		/read validation options must be a plain object/
	);
	await assert.rejects(() => context.loadById({} as any, 1), /loadById model must be a model constructor/);
	await assert.rejects(() => context.loadById(NativeSafetyRecord, Number.NaN as any), /loadById id/);
	await assert.rejects(() => context.loadManyNow(NativeSafetyRecord, null as any), /loadManyNow ids must be an array/);
	await assert.rejects(() => context.loadManyNow(NativeSafetyRecord, [Number.NaN] as any), /loadManyNow id/);
	await assert.rejects(
		() => NativeSafetyRecord.create({ id: 11, title: 'bad context' }, {} as any),
		/Model\.create context must be an ActiveContext/
	);
	await assert.rejects(
		() => NativeSafetyRecord.update(11, { title: 'bad context' }, {} as any),
		/Model\.update context must be an ActiveContext/
	);
	await assert.rejects(
		() => NativeSafetyRecord.delete(11, {} as any),
		/Model\.delete context must be an ActiveContext/
	);
});

test('model constructor options ignore inherited persisted flags', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	Object.defineProperty(Object.prototype, 'persisted', {
		value: true,
		configurable: true
	});
	try {
		const item = new NativeSafetyRecord({ id: 7, title: 'local' }, context, {});
		assert.equal(item.id, 7);
		await assert.rejects(() => item.save(), /not loaded or created by active-ts/);
	} finally {
		delete (Object.prototype as Record<string, unknown>).persisted;
	}
	let optionReads = 0;
	const accessorOptions = Object.defineProperty({}, 'persisted', {
		enumerable: true,
		get() {
			optionReads++;
			return false;
		}
	});
	assert.throws(
		() => new NativeSafetyRecord({ id: 8, title: 'bad options' }, context, accessorOptions as any),
		(error: unknown) =>
			error instanceof ActiveTsConfigurationError &&
			/Model constructor options\.persisted must be a data property/.test(error.message)
	);
	assert.equal(optionReads, 0);
	const hiddenOptions = Object.defineProperty({}, 'persisted', {
		enumerable: false,
		value: false
	});
	assert.throws(
		() => new NativeSafetyRecord({ id: 9, title: 'hidden options' }, context, hiddenOptions as any),
		(error: unknown) =>
			error instanceof ActiveTsConfigurationError &&
			/Model constructor options\.persisted must be enumerable/.test(error.message)
	);
	assert.throws(
		() => new NativeSafetyRecord({ id: 10, title: 'unknown options' }, context, { persistd: false } as any),
		/Model constructor options contains unknown option "persistd"/
	);
	assert.throws(
		() => new NativeSafetyRecord({ id: 11, title: 'symbol options' }, context, { [Symbol('persisted')]: false } as any),
		/Model constructor options cannot contain symbol fields/
	);
	let idReads = 0;
	const accessorData = Object.defineProperty({ title: 'bad id' }, 'id', {
		enumerable: true,
		get() {
			idReads++;
			return 8;
		}
	});
	const local = new NativeSafetyRecord(accessorData as any, context);
	assert.throws(
		() => local.id,
		(error: unknown) =>
			error instanceof ActiveTsValidationError &&
			/field path "id" segment "id" must be a data property/.test(error.message)
	);
	assert.equal(idReads, 0);
});

test('static model identity accessors are rejected without invocation', () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	let functionNameReads = 0;
	class AccessorFunctionNameRecord extends Model<NativeSafetyData> {}
	Object.defineProperty(AccessorFunctionNameRecord, 'name', {
		configurable: true,
		get() {
			functionNameReads++;
			return 'AccessorFunctionNameRecord';
		}
	});
	assert.throws(
		() => AccessorFunctionNameRecord.use(context),
		/Static model name must be a data property/
	);
	assert.equal(functionNameReads, 0);

	let modelNameReads = 0;
	class AccessorModelNameRecord extends Model<NativeSafetyData> {}
	Object.defineProperty(AccessorModelNameRecord, 'modelName', {
		configurable: true,
		get() {
			modelNameReads++;
			return 'accessor_model_name_record';
		}
	});
	assert.throws(
		() => AccessorModelNameRecord.use(context),
		/Static modelName must be a data property/
	);
	assert.equal(modelNameReads, 0);

	let modelNameSetterCalls = 0;
	class MetadataModelNameRecord extends Model<NativeSafetyData> {}
	Object.defineProperty(MetadataModelNameRecord, 'modelName', {
		configurable: true,
		get() {
			throw new Error('modelName getter should not run');
		},
		set() {
			modelNameSetterCalls++;
		}
	});
	defineModel<NativeSafetyData>('metadata_model_name_record')
		.id('id')
		.validate((input) => input as NativeSafetyData)
		.attach(MetadataModelNameRecord);
	assert.equal(modelNameSetterCalls, 0);
	assert.equal((MetadataModelNameRecord as typeof MetadataModelNameRecord & { modelName?: string }).modelName, 'metadata_model_name_record');
});

test('save data replacement removes fields missing from validated own data', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const Record = ReplaceDataRecord.use(context) as unknown as typeof ReplaceDataRecord;
	const item = await Record.create({ id: 8, title: 'clean', stale: 'created' });
	(item.data as Record<string, unknown>).stale = 'local-only';

	Object.defineProperty(Object.prototype, 'stale', {
		value: 'polluted',
		configurable: true
	});
	try {
		await item.save();
		assert.equal(Object.prototype.hasOwnProperty.call(item.data, 'stale'), false);
	} finally {
		delete (Object.prototype as Record<string, unknown>).stale;
	}
});

test('save rejects immutable data targets before store writes', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = ReplaceDataRecord.use(context) as unknown as typeof ReplaceDataRecord;
	const item = await Record.create({ id: 9, title: 'clean', stale: 'created' });
	Object.defineProperty(item.data, 'stale', {
		value: 'local-only',
		enumerable: true,
		configurable: false,
		writable: true
	});

	await assert.rejects(() => item.save(), /replace_data_record model data\.stale must be configurable before save/);
	assert.equal(store.stats.update, 0);
	assert.deepEqual(await store.get(context.meta(ReplaceDataRecord), 9), { id: 9, title: 'clean' });
});

test('save rejects hook-injected hidden data fields before store writes', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({
		stores: { default: store },
		plugins: [
			{
				name: 'hidden-target-data',
				hooks: {
					beforeUpdate(payload) {
						Object.defineProperty((payload.target as ReplaceDataRecord).data, 'hidden', {
							enumerable: false,
							configurable: true,
							value: 'local-only'
						});
					}
				}
			}
		]
	});
	const Record = ReplaceDataRecord.use(context) as unknown as typeof ReplaceDataRecord;
	const item = await Record.create({ id: 10, title: 'clean', stale: 'created' });

	await assert.rejects(
		() => item.save(),
		/replace_data_record model data\.hidden must be enumerable before save/
	);
	assert.equal(store.stats.update, 0);
	assert.deepEqual(await store.get(context.meta(ReplaceDataRecord), 10), { id: 10, title: 'clean' });
});

test('save rejects hook-injected enumerable entity key metadata before store writes', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({
		stores: { default: store },
		plugins: [
			{
				name: 'enumerable-entity-key-target-data',
				hooks: {
					beforeUpdate(payload) {
						((payload.target as ReplaceDataRecord).data as any)[ACTIVE_TS_ENTITY_KEY] = 'fake-key';
					}
				}
			}
		]
	});
	const Record = ReplaceDataRecord.use(context) as unknown as typeof ReplaceDataRecord;
	const item = await Record.create({ id: 11, title: 'clean', stale: 'created' });

	await assert.rejects(
		() => item.save(),
		/replace_data_record model data\.active-ts\.entity-key must be non-enumerable before save/
	);
	assert.equal(store.stats.update, 0);
	assert.deepEqual(await store.get(context.meta(ReplaceDataRecord), 11), { id: 11, title: 'clean' });
});

test('partial marker rejects malformed targets with active-ts errors', () => {
	assert.throws(
		() => markPartialModel(null as any),
		(error: unknown) =>
			error instanceof ActiveTsConfigurationError &&
			/partial model marker target must be an object/.test(error.message)
	);
	assert.throws(
		() => markPartialModel((() => undefined) as any),
		(error: unknown) =>
			error instanceof ActiveTsConfigurationError &&
			/partial model marker target must be an object/.test(error.message)
	);
	assert.throws(
		() => markPartialModel(Object.freeze({})),
		(error: unknown) =>
			error instanceof ActiveTsConfigurationError &&
			/partial model marker target must be extensible/.test(error.message)
	);

	const item = markPartialModel({});
	assert.equal(isPartialModel(item), true);
	assert.equal(markPartialModel(item), item);
	let markerReads = 0;
	const accessorMarker = Object.defineProperty({}, PARTIAL_MODEL, {
		enumerable: false,
		get() {
			markerReads++;
			return true;
		}
	});
	assert.throws(
		() => isPartialModel(accessorMarker),
		(error: unknown) =>
			error instanceof ActiveTsConfigurationError &&
			/partial model marker must be a data property/.test(error.message)
	);
	assert.throws(
		() => markPartialModel(accessorMarker),
		(error: unknown) =>
			error instanceof ActiveTsConfigurationError &&
			/partial model marker must be a data property/.test(error.message)
	);
	assert.equal(markerReads, 0);
});

test('partial marker ignores inherited marker symbols', () => {
	Object.defineProperty(Object.prototype, PARTIAL_MODEL, {
		value: true,
		configurable: true
	});
	try {
		const item = {};
		assert.equal(isPartialModel(item), false);
		assert.equal(markPartialModel(item), item);
		assert.equal(Object.prototype.hasOwnProperty.call(item, PARTIAL_MODEL), true);
	} finally {
		delete (Object.prototype as any)[PARTIAL_MODEL];
	}
});

test('result hooks cannot forge partial markers on full query results', async () => {
	const store = new MemoryStoreAdapter();
	const plugin: ActiveTsPlugin = {
		name: 'forge-partial-marker',
		hooks: {
			afterQuery(payload) {
				forgePartialMarker((payload.result as any).list[0]);
			}
		}
	};
	const context = createActiveTs({
		stores: { default: store },
		search: { memory: new MemorySearchAdapter() },
		defaultSearch: 'memory',
		plugins: [plugin]
	});
	const Record = NativeSafetyRecord.use(context) as unknown as typeof NativeSafetyRecord;
	await store.seed('native_safety_record', [{ id: 41, title: 'full row' }]);

	await assert.rejects(
		() => Record.query().load(),
		/partial marker state/
	);
});

test('afterInstantiate hooks cannot forge partial markers on full model loads', async () => {
	const store = new MemoryStoreAdapter();
	const plugin: ActiveTsPlugin = {
		name: 'forge-after-instantiate-partial-marker',
		hooks: {
			afterInstantiate(payload) {
				forgePartialMarker(payload.target);
			}
		}
	};
	const context = createActiveTs({
		stores: { default: store },
		search: { memory: new MemorySearchAdapter() },
		defaultSearch: 'memory',
		plugins: [plugin]
	});
	const Record = NativeSafetyRecord.use(context) as unknown as typeof NativeSafetyRecord;
	await store.seed('native_safety_record', [{ id: 42, title: 'full row' }]);

	await assert.rejects(
		() => Record.find(42).load(),
		/partial marker state/
	);
});

test('write lifecycle hooks cannot forge partial markers on full model results', async () => {
	const store = new MemoryStoreAdapter();
	const plugin: ActiveTsPlugin = {
		name: 'forge-after-create-partial-marker',
		hooks: {
			afterCreate(payload) {
				forgePartialMarker(payload.target);
			}
		}
	};
	const context = createActiveTs({
		stores: { default: store },
		search: { memory: new MemorySearchAdapter() },
		defaultSearch: 'memory',
		plugins: [plugin]
	});
	const Record = NativeSafetyRecord.use(context) as unknown as typeof NativeSafetyRecord;

	await assert.rejects(
		() => Record.create({ id: 43, title: 'created row' }),
		/partial marker state/
	);
});

test('entity key marker rejects malformed targets with active-ts errors', () => {
	assert.throws(
		() => attachEntityKey(null as any, 'key'),
		(error: unknown) =>
			error instanceof ActiveTsValidationError &&
			/entity key target must be an object/.test(error.message)
	);
	assert.throws(
		() => attachEntityKey((() => undefined) as any, 'key'),
		(error: unknown) =>
			error instanceof ActiveTsValidationError &&
			/entity key target must be an object/.test(error.message)
	);
	assert.throws(
		() => attachEntityKey(Object.freeze({}), 'key'),
		(error: unknown) =>
			error instanceof ActiveTsValidationError &&
			/entity key target must be extensible/.test(error.message)
	);
	let symbolReads = 0;
	const accessorEntityKey = Object.defineProperty({}, ACTIVE_TS_ENTITY_KEY, {
		enumerable: false,
		get() {
			symbolReads++;
			return 'first';
		}
	});
	assert.throws(
		() => attachEntityKey(accessorEntityKey, 'first'),
		(error: unknown) =>
			error instanceof ActiveTsValidationError &&
			/entity key target active-ts entity key must be a data property/.test(error.message)
	);
	assert.throws(
		() => assertSafeDataKeys(accessorEntityKey),
		(error: unknown) =>
			error instanceof ActiveTsValidationError &&
			/Unsupported data accessor at "\$\[active-ts\.entity-key\]"/.test(error.message)
	);
	assert.equal(symbolReads, 0);

	const item = attachEntityKey({}, 'first');
	assert.equal((item as any)[ACTIVE_TS_ENTITY_KEY], 'first');
	assert.equal(Object.prototype.propertyIsEnumerable.call(item, ACTIVE_TS_ENTITY_KEY), false);
	assert.equal(cloneSafeData(item)[ACTIVE_TS_ENTITY_KEY], 'first');

	const nested = { child: attachEntityKey({ value: 1 }, 'nested') };
	const nestedClone = cloneSafeData(nested);
	assert.deepEqual(nestedClone, { child: { value: 1 } });
	assert.equal((nestedClone.child as any)[ACTIVE_TS_ENTITY_KEY], 'nested');
	assert.equal(Object.prototype.propertyIsEnumerable.call(nestedClone.child, ACTIVE_TS_ENTITY_KEY), false);

	const entityKey = { path: ['parent', 1, 'child', 2] };
	const entityKeySource = attachEntityKey({ id: 2 }, entityKey);
	const entityKeyClone = cloneSafeData(entityKeySource);
	entityKey.path[1] = 3;
	assert.notEqual((entityKeyClone as any)[ACTIVE_TS_ENTITY_KEY], entityKey);
	assert.deepEqual((entityKeyClone as any)[ACTIVE_TS_ENTITY_KEY], { path: ['parent', 1, 'child', 2] });

	let entityKeyPathReads = 0;
	const accessorEntityKeyValue = Object.defineProperty({}, 'path', {
		enumerable: true,
		get() {
			entityKeyPathReads++;
			return ['parent', 1, 'child', 2];
		}
	});
	assert.throws(
		() => cloneSafeData(attachEntityKey({ id: 2 }, accessorEntityKeyValue)),
		(error: unknown) =>
			error instanceof ActiveTsValidationError &&
			/active-ts entity key metadata\.path must be a data property/.test(error.message)
	);
	assert.equal(entityKeyPathReads, 0);

	const enumerableEntityKey = { [ACTIVE_TS_ENTITY_KEY]: 'first' };
	assert.throws(
		() => assertSafeDataKeys(enumerableEntityKey),
		(error: unknown) =>
			error instanceof ActiveTsValidationError &&
			/Unsupported enumerable active-ts entity key metadata/.test(error.message)
	);
	assert.throws(
		() => cloneSafeData(enumerableEntityKey),
		(error: unknown) =>
			error instanceof ActiveTsValidationError &&
			/Unsupported enumerable active-ts entity key metadata/.test(error.message)
	);

	assert.equal(attachEntityKey(item, 'first'), item);
	assert.throws(
		() => attachEntityKey(item, 'second'),
		(error: unknown) =>
			error instanceof ActiveTsValidationError &&
			/already has a different active-ts entity key/.test(error.message)
	);
});

test('optional import helper validates runtime identifiers before dynamic import', async () => {
	await assert.rejects(
		() => optionalImport(null as any, 'Adapter'),
		(error: unknown) =>
			error instanceof ActiveTsConfigurationError &&
			/optional import specifier must be a package name/.test(error.message)
	);
	await assert.rejects(
		() => optionalImport('../package.json', 'Adapter'),
		(error: unknown) =>
			error instanceof ActiveTsConfigurationError &&
			/paths, URLs, or null bytes/.test(error.message)
	);
	await assert.rejects(
		() => optionalImport('pg/lib', 'Adapter'),
		(error: unknown) =>
			error instanceof ActiveTsConfigurationError &&
			/paths, URLs, or null bytes/.test(error.message)
	);
	await assert.rejects(
		() => optionalImport('data:text/javascript,export default 1', 'Adapter'),
		(error: unknown) =>
			error instanceof ActiveTsConfigurationError &&
			/paths, URLs, or null bytes/.test(error.message)
	);
	await assert.rejects(
		() => optionalImport('pg', '' as any),
		(error: unknown) =>
			error instanceof ActiveTsConfigurationError &&
			/optional import adapter name must be a non-empty string/.test(error.message)
	);
});

test('adapter lookup rejects prototype-backed registries', () => {
	const stores = Object.create({ inherited: new MemoryStoreAdapter() }) as Record<string, MemoryStoreAdapter>;
	stores.default = new MemoryStoreAdapter();
	assert.throws(
		() => createActiveTs({ stores }),
		/store adapter name registry must be a plain object/
	);
});

test('context snapshots adapter registries at creation time', async () => {
	const first = new MemoryStoreAdapter();
	const stores = { default: first };
	const context = createActiveTs({ stores });
	const Record = NativeSafetyRecord.use(context) as unknown as typeof NativeSafetyRecord;
	await Record.create({ id: 1, title: 'from first store' });

	stores.default = new MemoryStoreAdapter();
	(stores as Record<string, MemoryStoreAdapter>).late = new MemoryStoreAdapter();

	assert.equal((await Record.find(1).load())?.data.title, 'from first store');
	assert.throws(() => context.store('late'), /Store adapter "late" is not registered/);
});

test('context config normalizers ignore inherited option keys', async () => {
	const store = new MemoryStoreAdapter();
	Object.defineProperty(Object.prototype, 'defaultStore', {
		value: 'inherited-store',
		configurable: true
	});
	Object.defineProperty(Object.prototype, 'lazyWarnings', {
		value: false,
		configurable: true
	});
	Object.defineProperty(Object.prototype, 'cacheKey', {
		value: () => {
			throw new Error('inherited cacheKey should not run');
		},
		configurable: true
	});
	try {
		const context = createActiveTs({ stores: { default: store } });
		const Record = NativeSafetyRecord.use(context) as unknown as typeof NativeSafetyRecord;
		await Record.create({ id: 1, title: 'created with own config only' });
		assert.equal((await Record.find(1).load())?.data.title, 'created with own config only');
		assert.equal(context.lazyWarningsEnabled(), true);
	} finally {
		delete (Object.prototype as Record<string, unknown>).defaultStore;
		delete (Object.prototype as Record<string, unknown>).lazyWarnings;
		delete (Object.prototype as Record<string, unknown>).cacheKey;
	}
});

test('context snapshots plugin hooks at creation time', async () => {
	const plugins: ActiveTsPlugin[] = [];
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() }, plugins });
	const Record = NativeSafetyRecord.use(context) as unknown as typeof NativeSafetyRecord;

	plugins.push({
		name: 'late-plugin',
		hooks: {
			beforeValidate: () => {
				throw new Error('late plugin should not run');
			}
		}
	});

	await Record.create({ id: 1, title: 'created before plugin mutation' });
	assert.equal((await Record.find(1).load())?.data.title, 'created before plugin mutation');
});

test('context plugin normalization ignores inherited plugin fields', async () => {
	Object.defineProperty(Object.prototype, 'name', {
		value: 'inherited-plugin',
		configurable: true
	});
	Object.defineProperty(Object.prototype, 'setup', {
		value: () => {
			throw new Error('inherited plugin setup should not run');
		},
		configurable: true
	});
	Object.defineProperty(Object.prototype, 'hooks', {
		value: {
			beforeValidate: () => {
				throw new Error('inherited plugin hook should not run');
			}
		},
		configurable: true
	});
	try {
		assert.throws(
			() => createActiveTs({ stores: { default: new MemoryStoreAdapter() }, plugins: [{} as any] }),
			/plugins\[0\]\.name must be a non-empty string/
		);
		const context = createActiveTs({
			stores: { default: new MemoryStoreAdapter() },
			plugins: [{ name: 'own-plugin' }]
		});
		const Record = NativeSafetyRecord.use(context) as unknown as typeof NativeSafetyRecord;
		await Record.create({ id: 2, title: 'own plugin only' });
		assert.equal((await Record.find(2).load())?.data.title, 'own plugin only');
	} finally {
		delete (Object.prototype as Record<string, unknown>).name;
		delete (Object.prototype as Record<string, unknown>).setup;
		delete (Object.prototype as Record<string, unknown>).hooks;
	}
});

test('context snapshots adapter capabilities at creation time', async () => {
	const store = new MemoryStoreAdapter();
	const capabilities = { ...store.capabilities, select: false };
	(store as any).capabilities = capabilities;
	const context = createActiveTs({ stores: { default: store } });
	const Record = NativeSafetyRecord.use(context) as unknown as typeof NativeSafetyRecord;

	await Record.create({ id: 1, title: 'created before capability mutation' });
	capabilities.select = true;

	await assert.rejects(
		() => Record.query().select('title').load(),
		/Store adapter "memory" does not support select/
	);
});

test('context rejects malformed adapter capabilities', () => {
	const inheritedStore = new MemoryStoreAdapter();
	(inheritedStore as any).capabilities = Object.create({ select: true });
	assert.throws(
		() => createActiveTs({ stores: { default: inheritedStore } }),
		/store adapter name "default"\.capabilities must be a plain object/
	);

	const badStore = new MemoryStoreAdapter();
	(badStore as any).capabilities = { select: 'yes' };
	assert.throws(
		() => createActiveTs({ stores: { default: badStore } }),
		/store adapter name "default"\.capabilities\.select must be a boolean/
	);

	const typoStore = new MemoryStoreAdapter();
	(typoStore as any).capabilities = { textContain: true };
	assert.throws(
		() => createActiveTs({ stores: { default: typoStore } }),
		/store adapter name "default"\.capabilities contains unknown capability "textContain"/
	);

	const hiddenCapabilityStore = new MemoryStoreAdapter();
	(hiddenCapabilityStore as any).capabilities = Object.defineProperty({}, 'select', {
		enumerable: false,
		value: true
	});
	assert.throws(
		() => createActiveTs({ stores: { default: hiddenCapabilityStore } }),
		/store adapter name "default"\.capabilities\.select must be enumerable/
	);

	const badSearch = new MemorySearchAdapter();
	(badSearch as any).capabilities = { where: true, whereOperators: { nope: true } };
	assert.throws(
		() => createActiveTs({ stores: { default: new MemoryStoreAdapter() }, search: { default: badSearch } }),
		/search adapter name "default"\.capabilities\.whereOperators contains unknown operator "nope"/
	);

	const typoSearch = new MemorySearchAdapter();
	(typoSearch as any).capabilities = { whereOperator: { textContains: true } };
	assert.throws(
		() => createActiveTs({ stores: { default: new MemoryStoreAdapter() }, search: { default: typoSearch } }),
		/search adapter name "default"\.capabilities contains unknown capability "whereOperator"/
	);
});

test('context validates adapter registry keys and defaults at creation time', () => {
	const unsafeStores = Object.create(null) as Record<string, MemoryStoreAdapter>;
	unsafeStores.__proto__ = new MemoryStoreAdapter();
	const unsafeCaches = Object.create(null) as Record<string, any>;
	unsafeCaches.__proto__ = {};
	const unsafeSearch = Object.create(null) as Record<string, any>;
	unsafeSearch.__proto__ = {};
	assert.throws(() => createActiveTs({ stores: unsafeStores }), /store adapter name.*not allowed/);
	assert.throws(() => createActiveTs({ stores: {} }), /At least one store adapter is required/);
	assert.throws(
		() => createActiveTs({ stores: { default: new MemoryStoreAdapter() }, defaultStore: '__proto__' }),
		/default store adapter name.*not allowed/
	);
	assert.throws(
		() => createActiveTs({ stores: { default: new MemoryStoreAdapter() }, defaultCache: '__proto__' }),
		/default cache adapter name.*not allowed/
	);
	assert.throws(
		() => createActiveTs({ stores: { default: new MemoryStoreAdapter() }, defaultSearch: '__proto__' }),
		/default search adapter name.*not allowed/
	);
	assert.throws(
		() => createActiveTs({ stores: { primary: new MemoryStoreAdapter() } }),
		/Default store adapter "default" is not registered/
	);
	assert.throws(
		() => createActiveTs({ stores: { default: new MemoryStoreAdapter() }, defaultStore: 'missing' }),
		/Default store adapter "missing" is not registered/
	);
	assert.throws(
		() => createActiveTs({ stores: { default: new MemoryStoreAdapter() }, defaultCache: 'missing' }),
		/Default cache adapter "missing" is not registered/
	);
	assert.throws(
		() => createActiveTs({ stores: { default: new MemoryStoreAdapter() }, defaultSearch: 'missing' }),
		/Default search adapter "missing" is not registered/
	);
	assert.throws(
		() => createActiveTs({ stores: { default: new MemoryStoreAdapter() }, caches: unsafeCaches }),
		/cache adapter name.*not allowed/
	);
	assert.throws(
		() => createActiveTs({ stores: { default: new MemoryStoreAdapter() }, search: unsafeSearch }),
		/search adapter name.*not allowed/
	);
});

test('context adapter validation ignores inherited adapter members', () => {
	const defineObjectPrototypeValue = (property: string, value: unknown) => {
		const descriptor = Object.create(null) as PropertyDescriptor;
		descriptor.value = value;
		descriptor.configurable = true;
		Object.defineProperty(Object.prototype, property, descriptor);
	};
	const plainStore: StoreAdapter = {
		kind: 'plain-store',
		get: async () => null,
		getMany: async () => [],
		query: async () => ({ list: [], more: false }),
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	const plainSearch = {
		kind: 'plain-search',
		search: async () => ({ list: [], more: false }),
		index: async () => undefined,
		delete: async () => undefined
	};
	try {
		defineObjectPrototypeValue('kind', 'polluted-adapter');
		for (const property of ['get', 'getMany', 'query', 'create', 'update', 'delete', 'setMany', 'search', 'index']) {
			defineObjectPrototypeValue(property, async () => undefined);
		}
		defineObjectPrototypeValue('capabilities', { select: true, where: true });
		defineObjectPrototypeValue('schema', {
			plan: async () => ({ adapter: 'polluted', changes: [] }),
			apply: async () => ({ adapter: 'polluted', changes: [] })
		});

		assert.throws(() => createActiveTs({ stores: { default: {} as any } }), /store adapter name "default"\.kind/);
		assert.throws(
			() => createActiveTs({ stores: { default: plainStore }, caches: { default: {} as any } }),
			/cache adapter name "default"\.kind/
		);
		assert.throws(
			() => createActiveTs({ stores: { default: plainStore }, search: { default: {} as any } }),
			/search adapter name "default"\.kind/
		);

		const context = createActiveTs({ stores: { default: plainStore }, search: { default: plainSearch as any } });
		assert.deepEqual(context.store('default').capabilities, {});
		assert.equal(context.store('default').schema, undefined);
		assert.deepEqual(context.searchAdapter('default').capabilities, {});
	} finally {
		for (const property of [
			'kind',
			'get',
			'getMany',
			'query',
			'create',
			'update',
			'delete',
			'setMany',
			'search',
			'index',
			'capabilities',
			'schema'
		]) {
			delete (Object.prototype as Record<string, unknown>)[property];
		}
	}
});

test('context validates adapter object shapes at creation time', () => {
	assert.throws(
		() => createActiveTs({ stores: { default: null as any } }),
		/store adapter name "default" must be an adapter object/
	);
	assert.throws(
		() => createActiveTs({ stores: { default: { kind: 'broken-store', get: async () => null } as any } }),
		/store adapter name "default"\.getMany must be a function/
	);
	assert.throws(
		() =>
			createActiveTs({
				stores: { default: { ...new MemoryStoreAdapter(), kind: '' } as any }
			}),
		/store adapter name "default"\.kind must be a non-empty string/
	);
	assert.throws(
		() =>
			createActiveTs({
				stores: { default: new MemoryStoreAdapter() },
				caches: { default: { kind: 'broken-cache', getMany: async () => [] } as any }
			}),
		/cache adapter name "default"\.setMany must be a function/
	);
	assert.throws(
		() =>
			createActiveTs({
				stores: { default: new MemoryStoreAdapter() },
				caches: { default: new MemoryCacheAdapter() },
				search: { default: { kind: 'broken-search', search: async () => ({ list: [] }) } as any }
			}),
		/search adapter name "default"\.index must be a function/
	);
	const hiddenStore = {
		kind: 'hidden-store',
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
		() => createActiveTs({ stores: { default: hiddenStore } }),
		/store adapter name "default"\.query must be enumerable/
	);
	const hiddenSearch = {
		kind: 'hidden-search',
		search: async () => ({ list: [], more: false }),
		delete: async () => undefined
	} as any;
	Object.defineProperty(hiddenSearch, 'index', {
		enumerable: false,
		value: async () => undefined
	});
	assert.throws(
		() => createActiveTs({ stores: { default: new MemoryStoreAdapter() }, search: { default: hiddenSearch } }),
		/search adapter name "default"\.index must be enumerable/
	);
	assert.doesNotThrow(() =>
		createActiveTs({
			stores: { default: new MemoryStoreAdapter() },
			caches: { default: new MemoryCacheAdapter() },
			search: { default: new MemorySearchAdapter() }
		})
	);
});

test('raw store rows must contain a valid model id before instantiation', async () => {
	const missingIdStore: StoreAdapter = {
		kind: 'missing-id-store',
		capabilities: {},
		get: async () => ({ title: 'missing id' }),
		getMany: async () => [{ title: 'missing id' }],
		query: async () => ({ list: [{ title: 'missing id' }], more: false, count: 1 }),
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	const context = createActiveTs({ stores: { default: missingIdStore } });
	const Record = NativeSafetyRecord.use(context) as unknown as typeof NativeSafetyRecord;

	await assert.rejects(() => Record.find(1).load(), /missing id field "id"/);
	await assert.rejects(() => Record.query().load(), /missing id field "id"/);
});
