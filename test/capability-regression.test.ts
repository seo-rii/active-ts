import test from 'node:test';
import assert from 'node:assert/strict';
import {
	Model,
	MemoryStoreAdapter,
	createActiveTs,
	datastoreKey,
	defineModel,
	type AggregatePlan,
	type AggregateResult,
	type EntityId,
	type QueryPlan,
	type QueryResult,
	type ResolvedModelMeta,
	type SearchAdapter,
	type StoreAdapter,
	type StoreReadOptions
} from '../src/index.js';
import { createNativeSearchAdapter } from '../src/adapters/search/native.js';

type CapabilityData = {
	id: number;
	label: string;
	score: number;
	version?: number;
	profile?: { city: string };
	tags?: string[];
};

class CapabilityRecord extends Model<CapabilityData> {}

type CodecAggregateData = {
	id: number;
	label: string;
	score: number;
};

class CodecAggregateRecord extends Model<CodecAggregateData> {}

type DatastoreAggregateFallbackData = {
	id: number;
	parentId: number;
	label: string;
	score: number;
};

class DatastoreAggregateFallbackRecord extends Model<DatastoreAggregateFallbackData> {}

type DatastoreDescendantAggregateFallbackData = {
	id: number;
	rootId: number;
	parentId: number;
	label: string;
	score: number;
};

class DatastoreDescendantAggregateFallbackRecord extends Model<DatastoreDescendantAggregateFallbackData> {}

defineModel<CapabilityData>('capability_regression_record')
	.id('id')
	.validate((input) => input as CapabilityData)
	.fieldType('score', 'number')
	.search('native', ['label', 'profile.city'])
	.attach(CapabilityRecord);

defineModel<CodecAggregateData>('codec_aggregate_regression_record')
	.id('id')
	.validate((input) => input as CodecAggregateData)
	.fieldType('score', 'number')
	.fieldCodec('score', {
		name: 'aggregate-score-codec',
		encode: (value) => `score:${String(value)}`,
		decode: (value) => Number(String(value).replace(/^score:/, ''))
	})
	.attach(CodecAggregateRecord);

defineModel<DatastoreAggregateFallbackData>('datastore_aggregate_fallback_regression_record')
	.id('id')
	.validate((input) => input as DatastoreAggregateFallbackData)
	.fieldType('score', 'number')
	.datastore({
		ancestor: ({ data }) => data?.parentId === undefined ? undefined : datastoreKey('aggregate_parent', data.parentId),
		ancestorFields: ['parentId']
	})
	.attach(DatastoreAggregateFallbackRecord);

defineModel<DatastoreDescendantAggregateFallbackData>('datastore_descendant_aggregate_fallback_regression_record')
	.id('id')
	.validate((input) => input as DatastoreDescendantAggregateFallbackData)
	.fieldType('score', 'number')
	.datastore({
		ancestor: ({ data }) => data
			? datastoreKey('aggregate_child', data.parentId, {
					parent: datastoreKey('aggregate_root', data.rootId)
				})
			: undefined,
		ancestorFields: ['rootId', 'parentId']
	})
	.attach(DatastoreDescendantAggregateFallbackRecord);

test('unsupported query capabilities fail before adapter query execution', async () => {
	const store = new ThrowingCapabilityStore({
		or: false,
		cursor: false,
		select: false,
		nestedFields: false,
		arrayContains: false,
		textContains: false,
		jsonContains: false,
		startsWith: false,
		numericComparisons: false,
		nullOperators: false,
		native: false
	});
	const context = createActiveTs({ stores: { default: store } });
	const Record = CapabilityRecord.use(context) as unknown as typeof CapabilityRecord;

	await assert.rejects(() => Record.query().whereAny({ label: 'a' }, { label: 'b' }).load(), /orWhere/);
	await assert.rejects(() => Record.query().cursor('cursor').load(), /cursor pagination/);
	await assert.rejects(() => Record.query().select('label').load(), /select/);
	await assert.rejects(() => Record.where({ 'profile.city': 'Seoul' } as any).load(), /nested field/);
	await assert.rejects(() => Record.where({ tags: ['arrayContains', 'red'] as any }).load(), /arrayContains/);
	await assert.rejects(() => Record.where({ label: ['textContains', 'a'] as any }).load(), /textContains/);
	await assert.rejects(() => Record.where({ profile: ['jsonContains', { city: 'Seoul' }] as any }).load(), /jsonContains/);
	await assert.rejects(() => Record.where({ label: ['startsWith', 'a'] as any }).load(), /startsWith/);
	await assert.rejects(() => Record.where({ score: ['>=', 1] as any }).load(), /range comparisons/);
	await assert.rejects(() => Record.where({ label: ['isNull'] as any }).load(), /null operators/);
	await assert.rejects(() => Record.query().native({ anything: true }).load(), /native queries/);
	assert.equal(store.queryCalls, 0);
});

test('missing store capabilities default-deny optional query features', async () => {
	const store = new ThrowingCapabilityStore({});
	(store as any).capabilities = undefined;
	const context = createActiveTs({ stores: { default: store } });
	const Record = CapabilityRecord.use(context) as unknown as typeof CapabilityRecord;

	await Record.where({ label: 'plain equality' }).load();
	assert.equal(store.queryCalls, 1);

	await assert.rejects(() => Record.query().whereAny({ label: 'a' }, { label: 'b' }).load(), /orWhere/);
	await assert.rejects(() => Record.query().cursor('cursor').load(), /cursor pagination/);
	await assert.rejects(() => Record.query().select('label').load(), /select/);
	await assert.rejects(() => Record.where({ 'profile.city': 'Seoul' } as any).load(), /nested field/);
	await assert.rejects(() => Record.where({ tags: ['arrayContains', 'red'] as any }).load(), /arrayContains/);
	await assert.rejects(() => Record.where({ label: ['textContains', 'a'] as any }).load(), /textContains/);
	await assert.rejects(() => Record.where({ profile: ['jsonContains', { city: 'Seoul' }] as any }).load(), /jsonContains/);
	await assert.rejects(() => Record.where({ label: ['startsWith', 'a'] as any }).load(), /startsWith/);
	await assert.rejects(() => Record.where({ score: ['>=', 1] as any }).load(), /range comparisons/);
	await assert.rejects(() => Record.where({ label: ['isNull'] as any }).load(), /null operators/);
	await assert.rejects(() => Record.query().native({ anything: true }).load(), /native queries/);
	assert.equal(store.queryCalls, 1);
});

test('stores without missing-field null support reject portable isNull but allow explicit null equality', async () => {
	const store = new ThrowingCapabilityStore({ missingFieldNulls: false, nullOperators: true });
	const context = createActiveTs({ stores: { default: store } });
	const Record = CapabilityRecord.use(context) as unknown as typeof CapabilityRecord;

	await assert.rejects(
		() => Record.where({ label: ['isNull'] as any }).load(),
		/matching missing fields as null/
	);
	assert.equal(store.queryCalls, 0);

	await Record.where({ label: null }).load();
	assert.equal(store.queryCalls, 1);
	assert.deepEqual(store.lastQuery?.where, [{ field: 'label', op: '=', value: null }]);
});

test('direct store plan validation rejects legacy contains before adapter execution', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(CapabilityRecord);

	await assert.rejects(
		() =>
			store.query(meta, {
				where: [{ field: 'tags', op: 'contains', value: 'red' }],
				or: [],
				sort: [],
				include: []
			}),
		/legacy contains operator is ambiguous/
	);
	assert.equal(store.stats.query, 0);
});

test('nested field capability applies to sort, select, and aggregates', async () => {
	const store = new ThrowingCapabilityStore({ nestedFields: false, select: true, aggregate: true });
	const context = createActiveTs({ stores: { default: store } });
	const Record = CapabilityRecord.use(context) as unknown as typeof CapabilityRecord;

	await assert.rejects(() => Record.query().orderBy('profile.city').load(), /nested field sorting/);
	await assert.rejects(() => Record.query().select('profile.city').load(), /nested field selection/);
	await assert.rejects(
		() => Record.query().aggregate({ city: { op: 'max', field: 'profile.city' } }),
		/nested field aggregation/
	);
	assert.equal(store.queryCalls, 0);
	assert.equal(store.aggregateCalls, 0);
});

test('search capabilities default-deny optional filters, cursors, and native payloads', async () => {
	let searchCalls = 0;
	const search: SearchAdapter = {
		kind: 'search-no-capabilities',
		search: async () => {
			searchCalls++;
			return { list: [], more: false };
		},
		index: async () => undefined,
		delete: async () => undefined
	};
	const context = createActiveTs({ stores: { default: new ThrowingCapabilityStore({}) }, search: { default: search } });
	const Record = CapabilityRecord.use(context) as unknown as typeof CapabilityRecord;

	await Record.search('plain').load();
	assert.equal(searchCalls, 1);
	await assert.rejects(() => Record.search('plain').where({ label: 'a' }).load(), /where\(\) filters/);
	await assert.rejects(() => Record.search('plain').cursor('cursor').load(), /cursor pagination/);
	await assert.rejects(() => Record.search('plain').native({ any: true }).load(), /native search options/);
	assert.equal(searchCalls, 1);
});

test('query result count is normalized to returned model page size', async () => {
	const store = new ThrowingCapabilityStore({});
	store.queryResult = [
		{ id: 1, label: 'one', score: 1 },
		{ id: 2, label: 'two', score: 2 }
	];
	store.queryCount = 999;
	const context = createActiveTs({ stores: { default: store } });
	const Record = CapabilityRecord.use(context) as unknown as typeof CapabilityRecord;

	const result = await Record.query().orderBy('id').load();
	assert.equal(result.count, 2);
	assert.equal(result.list.length, 2);
});

test('query result totals must be safe integers before model instantiation', async () => {
	const store = new ThrowingCapabilityStore({});
	store.query = async () => {
		store.queryCalls++;
		return {
			list: [{ id: 1, label: 'one', score: 1 }],
			more: false,
			count: 1,
			total: 1.5
		};
	};
	const context = createActiveTs({ stores: { default: store } });
	const Record = CapabilityRecord.use(context) as unknown as typeof CapabilityRecord;

	await assert.rejects(
		() => Record.query().load(),
		/Store adapter "capability-test" query result\.total must be a non-negative safe integer/
	);
	assert.equal(store.queryCalls, 1);
});

test('model query rejects cursor leaks from cursorless stores', async () => {
	const store = new ThrowingCapabilityStore({ cursor: false });
	store.query = async () => {
		store.queryCalls++;
		return {
			list: [{ id: 1, label: 'one', score: 1 }],
			more: false,
			count: 1,
			cursor: 'native-cursor'
		};
	};
	const context = createActiveTs({ stores: { default: store } });
	const Record = CapabilityRecord.use(context) as unknown as typeof CapabilityRecord;

	await assert.rejects(
		() => Record.query().load(),
		/Store adapter "capability-test" does not support returning portable cursors/
	);
	assert.equal(store.queryCalls, 1);
});

test('model query validates malformed result counts before cursor leak policy', async () => {
	const store = new ThrowingCapabilityStore({ cursor: false });
	store.query = async () => {
		store.queryCalls++;
		return {
			list: [{ id: 1, label: 'one', score: 1 }],
			more: false,
			count: 1.5,
			cursor: 'native-cursor'
		};
	};
	const context = createActiveTs({ stores: { default: store } });
	const Record = CapabilityRecord.use(context) as unknown as typeof CapabilityRecord;

	await assert.rejects(
		() => Record.query().load(),
		/Store adapter "capability-test" query result\.count must be a non-negative safe integer/
	);
	assert.equal(store.queryCalls, 1);
});

test('search where capability requires explicit operator support', async () => {
	let searchCalls = 0;
	const search: SearchAdapter = {
		kind: 'search-where-without-operators',
		capabilities: { where: true, cursor: false, native: false, index: false },
		search: async () => {
			searchCalls++;
			return { list: [], more: false };
		},
		index: async () => undefined,
		delete: async () => undefined
	};
	const context = createActiveTs({ stores: { default: new ThrowingCapabilityStore({}) }, search: { default: search } });
	const Record = CapabilityRecord.use(context) as unknown as typeof CapabilityRecord;

	await assert.rejects(() => Record.search('plain').where({ label: 'a' }).load(), /= where filters/);
	await assert.rejects(() => Record.search('plain').where({ score: ['>=', 1] as any }).load(), />= where filters/);
	assert.equal(searchCalls, 0);
});

test('model search rejects cursor leaks from cursorless search adapters', async () => {
	let searchCalls = 0;
	const search: SearchAdapter = {
		kind: 'search-cursor-leak',
		capabilities: { where: false, cursor: false, native: false, index: false },
		search: async () => {
			searchCalls++;
			return {
				list: [{ id: 1, label: 'one', score: 1 }],
				more: false,
				count: 1,
				cursor: 'native-cursor'
			};
		},
		index: async () => undefined,
		delete: async () => undefined
	};
	const context = createActiveTs({ stores: { default: new ThrowingCapabilityStore({}) }, search: { default: search } });
	const Record = CapabilityRecord.use(context) as unknown as typeof CapabilityRecord;

	await assert.rejects(
		() => Record.search('one').load(),
		/Search adapter "search-cursor-leak" does not support returning portable cursors/
	);
	assert.equal(searchCalls, 1);
});

test('capability checks ignore inherited store and search capability fields', async () => {
	const store = new ThrowingCapabilityStore({});
	(store as any).capabilities = {};
	let searchCalls = 0;
	const search: SearchAdapter = {
		kind: 'search-inherited-capability',
		capabilities: { where: true, whereOperators: {} },
		search: async () => {
			searchCalls++;
			return { list: [], more: false };
		},
		index: async () => undefined,
		delete: async () => undefined
	};
	const context = createActiveTs({ stores: { default: store }, search: { default: search } });
	const Record = CapabilityRecord.use(context) as unknown as typeof CapabilityRecord;
	Object.defineProperty(Object.prototype, 'select', { value: true, configurable: true, writable: true });
	try {
		await assert.rejects(() => Record.query().select('label').load(), /select/);
		assert.equal(store.queryCalls, 0);
	} finally {
		delete (Object.prototype as Record<string, unknown>).select;
	}
	Object.defineProperty(Object.prototype, 'textContains', { value: true, configurable: true, writable: true });
	try {
		await assert.rejects(() => Record.where({ label: ['textContains', 'a'] as any }).load(), /textContains/);
		await assert.rejects(() => Record.search('plain').where({ label: ['textContains', 'a'] as any }).load(), /textContains/);
		assert.equal(store.queryCalls, 0);
		assert.equal(searchCalls, 0);
	} finally {
		delete (Object.prototype as Record<string, unknown>).textContains;
	}
});

test('query builder plans ignore inherited optional plan fields', async () => {
	const store = new ThrowingCapabilityStore({});
	store.queryResult = [{ id: 1, label: 'plain', score: 1 }];
	const context = createActiveTs({ stores: { default: store } });
	const Record = CapabilityRecord.use(context) as unknown as typeof CapabilityRecord;
	Object.defineProperty(Object.prototype, 'select', { value: ['label'], configurable: true, writable: true });
	Object.defineProperty(Object.prototype, 'native', { value: { payload: true }, configurable: true, writable: true });
	Object.defineProperty(Object.prototype, 'cursor', { value: 'polluted-cursor', configurable: true, writable: true });
	Object.defineProperty(Object.prototype, 'limit', { value: 1, configurable: true, writable: true });
	Object.defineProperty(Object.prototype, 'meta', { value: { softDelete: 'only' }, configurable: true, writable: true });
	try {
		const result = await Record.where({ label: 'plain' }).load();
		assert.equal(result.count, 1);
		assert.equal(store.queryCalls, 1);
		assert.equal(store.lastQuery?.select, undefined);
		assert.equal(store.lastQuery?.native, undefined);
		assert.equal(store.lastQuery?.cursor, undefined);
		assert.equal(store.lastQuery?.limit, undefined);
		assert.equal(store.lastQuery?.meta, undefined);
	} finally {
		delete (Object.prototype as Record<string, unknown>).select;
		delete (Object.prototype as Record<string, unknown>).native;
		delete (Object.prototype as Record<string, unknown>).cursor;
		delete (Object.prototype as Record<string, unknown>).limit;
		delete (Object.prototype as Record<string, unknown>).meta;
	}
});

test('native search requires explicit underlying store cursor and OR support', async () => {
	const store = new ThrowingCapabilityStore({ textContains: true, cursor: undefined, or: undefined });
	const native = createNativeSearchAdapter(store);
	const context = createActiveTs({
		stores: { default: store },
		search: { default: native }
	});
	const Record = CapabilityRecord.use(context) as unknown as typeof CapabilityRecord;
	const meta = context.meta(Record);

	await assert.rejects(() => native.search(meta, 'a', { cursor: 'cursor' }), /native search cursors/);
	await assert.rejects(() => native.search(meta, 'a', {}), /native multi-field search/);
	assert.equal(store.queryCalls, 0);
});

test('native search requires explicit underlying store native payload support', async () => {
	const store = new ThrowingCapabilityStore({ textContains: true, native: false });
	const native = createNativeSearchAdapter(store);
	const context = createActiveTs({
		stores: { default: store },
		search: { default: native }
	});
	const Record = CapabilityRecord.use(context) as unknown as typeof CapabilityRecord;
	const meta = context.meta(Record);

	await assert.rejects(() => Record.search('a').native({ payload: true }).load(), /native search options/);
	await assert.rejects(() => native.search(meta, 'a', { native: { payload: true } }), /native search payloads/);
	assert.equal(store.queryCalls, 0);
});

test('native search rejects cursor leaks from cursorless stores', async () => {
	const store = new ThrowingCapabilityStore({ textContains: true, cursor: false });
	store.query = async () => {
		store.queryCalls++;
		return {
			list: [{ id: 1, label: 'one', score: 1 }],
			more: false,
			count: 1,
			cursor: 'native-cursor'
		};
	};
	const native = createNativeSearchAdapter(store);
	const context = createActiveTs({
		stores: { default: store },
		search: { default: native }
	});
	const Record = CapabilityRecord.use(context) as unknown as typeof CapabilityRecord;

	await assert.rejects(
		() => Record.search('one').load(),
		/Store adapter "capability-test" does not support returning portable cursors/
	);
	assert.equal(store.queryCalls, 1);
});

test('native search can route native-only payloads without declared search fields', async () => {
	const store = new ThrowingCapabilityStore({ textContains: false, native: true });
	const native = createNativeSearchAdapter(store);
	const context = createActiveTs({ stores: { default: store } });
	const meta = {
		...context.meta(CapabilityRecord),
		searchIndexes: []
	};

	await native.search(meta, 'ignored', { native: { payload: true } });
	assert.equal(store.queryCalls, 1);
	assert.deepEqual(store.lastQuery?.native?.payload, { payload: true });
	assert.deepEqual(store.lastQueryOptions?.native, { payload: true });

	await native.search(meta, 'ignored', { native: false });
	assert.equal(store.queryCalls, 2);
	assert.equal(store.lastQuery?.native?.payload, false);
	assert.equal(store.lastQueryOptions?.native, false);
});

test('aggregate optimization is opt-in through adapter capabilities', async () => {
	const store = new ThrowingCapabilityStore({});
	(store as any).capabilities = undefined;
	store.queryResult = [{ id: 1, label: 'a', score: 4 }];
	const context = createActiveTs({ stores: { default: store } });
	const Record = CapabilityRecord.use(context) as unknown as typeof CapabilityRecord;

	await assert.rejects(() => Record.query().aggregate({ count: 'count' }), /allowQueryFallback/);
	assert.equal(store.queryCalls, 0);
	assert.equal(store.aggregateCalls, 0);
	assert.equal(store.lastQuery?.select, undefined);
});

test('aggregate query fallback requires explicit context opt-in', async () => {
	const store = new ThrowingCapabilityStore({ aggregate: false, select: true });
	store.queryResult = [{ id: 1, label: 'a', score: 4 }, { id: 2, label: 'b', score: 6 }];
	const context = createActiveTs({
		stores: { default: store },
		aggregate: { allowQueryFallback: true }
	});
	const Record = CapabilityRecord.use(context) as unknown as typeof CapabilityRecord;

	const result = await Record.query().aggregate({
		count: 'count',
		total: { op: 'sum', field: 'score' },
		highest: { op: 'max', field: 'score' }
	});

	assert.deepEqual(result, { count: 2, total: 10, highest: 6 });
	assert.equal(store.queryCalls, 1);
	assert.equal(store.aggregateCalls, 0);
	assert.deepEqual(store.lastQuery?.select, ['id', 'score']);
	assert.deepEqual(store.lastQueryOptions?.select, ['id', 'score']);
	assert.equal(store.lastQueryOptions?.native, undefined);
});

test('aggregate query fallback preserves plan metadata for wrapped query adapters', async () => {
	const store = new ThrowingCapabilityStore({ aggregate: false, select: true });
	store.queryResult = [{ id: 1, label: 'a', score: 4 }];
	const context = createActiveTs({
		stores: { default: store },
		aggregate: { allowQueryFallback: true }
	});
	const Record = CapabilityRecord.use(context) as unknown as typeof CapabilityRecord;

	const result = await Record.withDeleted().aggregate({ count: 'count' });

	assert.deepEqual(result, { count: 1 });
	assert.equal(store.queryCalls, 1);
	assert.deepEqual(store.lastQuery?.meta, { softDelete: 'with' });
	assert.equal(store.lastQuery?.limit, undefined);
	assert.equal(store.lastQuery?.cursor, undefined);
});

test('aggregate query fallback forwards native read options to query adapters', async () => {
	const store = new ThrowingCapabilityStore({ aggregate: false, select: true, native: true });
	store.queryResult = [{ id: 1, label: 'a', score: 4 }];
	const context = createActiveTs({
		stores: { default: store },
		aggregate: { allowQueryFallback: true }
	});
	const Record = CapabilityRecord.use(context) as unknown as typeof CapabilityRecord;

	const result = await Record.query().native({ route: 'fallback' }).aggregate({
		total: { op: 'sum', field: 'score' }
	});

	assert.deepEqual(result, { total: 4 });
	assert.deepEqual(store.lastQuery?.select, ['id', 'score']);
	assert.deepEqual(store.lastQuery?.native?.payload, { route: 'fallback' });
	assert.deepEqual(store.lastQueryOptions, {
		select: ['id', 'score'],
		native: { route: 'fallback' }
	});
});

test('aggregate query fallback sanitizes adapter query results', async () => {
	const store = new ThrowingCapabilityStore({ aggregate: false, select: true });
	store.query = async () => {
		store.queryCalls++;
		return { list: null as any, more: false };
	};
	const context = createActiveTs({
		stores: { default: store },
		aggregate: { allowQueryFallback: true }
	});
	const Record = CapabilityRecord.use(context) as unknown as typeof CapabilityRecord;

	await assert.rejects(
		() => Record.query().aggregate({ count: 'count' }),
		/aggregate fallback query result\.list/
	);
	assert.equal(store.queryCalls, 1);
	assert.equal(store.aggregateCalls, 0);
});

test('aggregate query fallback rejects cursor leaks from cursorless stores', async () => {
	const store = new ThrowingCapabilityStore({ aggregate: false, cursor: false, select: true });
	store.query = async () => {
		store.queryCalls++;
		return {
			list: [{ id: 1, label: 'one', score: 1 }],
			more: false,
			count: 1,
			cursor: 'native-cursor'
		};
	};
	const context = createActiveTs({
		stores: { default: store },
		aggregate: { allowQueryFallback: true }
	});
	const Record = CapabilityRecord.use(context) as unknown as typeof CapabilityRecord;

	await assert.rejects(
		() => Record.count(),
		/Store adapter "capability-test" does not support returning portable cursors/
	);
	assert.equal(store.queryCalls, 1);
	assert.equal(store.aggregateCalls, 0);
});

test('aggregate query fallback rejects datastore rows outside the scoped ancestor', async () => {
	const store = new ThrowingCapabilityStore({ aggregate: false, datastoreAncestor: true, select: true });
	const badRow = { id: 1, parentId: 20, label: 'wrong ancestor', score: 4 };
	store.query = async (_model, plan, options) => {
		store.queryCalls++;
		store.lastQuery = plan;
		store.lastQueryOptions = options;
		assert.deepEqual(options?.select, ['id', 'score', 'parentId']);
		return {
			list: [
				{
					id: badRow.id,
					score: badRow.score,
					parentId: badRow.parentId
				}
			],
			more: false,
			count: 1
		};
	};
	const context = createActiveTs({
		stores: { default: store },
		aggregate: { allowQueryFallback: true }
	});
	const Record = DatastoreAggregateFallbackRecord.use(context) as unknown as typeof DatastoreAggregateFallbackRecord;

	await assert.rejects(
		() => Record.ancestor(datastoreKey('aggregate_parent', 10)).aggregate({ total: { op: 'sum', field: 'score' } }),
		/resolved outside the scoped Datastore ancestor/
	);
	assert.equal(store.queryCalls, 1);
	assert.equal(store.aggregateCalls, 0);
});

test('aggregate query fallback accepts datastore descendant rows inside the scoped ancestor', async () => {
	const store = new ThrowingCapabilityStore({ aggregate: false, datastoreAncestor: true, select: true });
	store.query = async (_model, plan, options) => {
		store.queryCalls++;
		store.lastQuery = plan;
		store.lastQueryOptions = options;
		assert.deepEqual(options?.select, ['id', 'score', 'rootId', 'parentId']);
		return {
			list: [
				{ id: 7, score: 4, rootId: 1, parentId: 10 },
				{ id: 7, score: 6, rootId: 1, parentId: 20 }
			],
			more: false,
			count: 2
		};
	};
	const context = createActiveTs({
		stores: { default: store },
		aggregate: { allowQueryFallback: true }
	});
	const Record = DatastoreDescendantAggregateFallbackRecord.use(context) as unknown as typeof DatastoreDescendantAggregateFallbackRecord;

	assert.deepEqual(
		await Record.ancestor(datastoreKey('aggregate_root', 1)).aggregate({ total: { op: 'sum', field: 'score' } }),
		{ total: 10 }
	);
	assert.equal(store.queryCalls, 1);
	assert.equal(store.aggregateCalls, 0);
});

test('model query rejects datastore rows outside the scoped ancestor', async () => {
	const store = new ThrowingCapabilityStore({ datastoreAncestor: true });
	store.queryResult = [{ id: 1, parentId: 20, label: 'wrong ancestor', score: 4 }];
	const context = createActiveTs({ stores: { default: store } });
	const Record = DatastoreAggregateFallbackRecord.use(context) as unknown as typeof DatastoreAggregateFallbackRecord;

	await assert.rejects(
		() => Record.ancestor(datastoreKey('aggregate_parent', 10)).load(),
		/resolved outside the scoped Datastore ancestor/
	);
	assert.equal(store.queryCalls, 1);
});

test('context store direct reads validate datastore scoped ancestors', async () => {
	const parent = datastoreKey('aggregate_parent', 10);
	const store = new ThrowingCapabilityStore({ datastoreAncestor: true, transaction: true });
	store.rows.set('number:1', { id: 1, parentId: 20, label: 'wrong ancestor', score: 4 });
	(store as StoreAdapter).transaction = async (fn) => await fn(store);
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(DatastoreAggregateFallbackRecord);

	await assert.rejects(
		() => context.store('default').get(meta, 1, { meta: { datastoreAncestor: parent } }),
		/resolved outside the scoped Datastore ancestor/
	);
	await assert.rejects(
		() => context.store('default').getMany(meta, [1], { meta: { datastoreAncestor: parent } }),
		/resolved outside the scoped Datastore ancestor/
	);
	await assert.rejects(
		() => context.transaction(async (tx) =>
			tx.store('default').get(meta, 1, { meta: { datastoreAncestor: parent } })
		),
		/resolved outside the scoped Datastore ancestor/
	);
});

test('context store direct reads require datastore ancestor capability for read metadata', async () => {
	const parent = datastoreKey('aggregate_parent', 10);
	const store = new ThrowingCapabilityStore({ datastoreAncestor: false });
	store.rows.set('number:1', { id: 1, parentId: 10, label: 'one', score: 4 });
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(DatastoreAggregateFallbackRecord);

	await assert.rejects(
		() => context.store('default').get(meta, 1, { meta: { datastoreAncestor: parent } }),
		/does not support Datastore ancestor read metadata/
	);
});

test('field-codec aggregate fields use decoded query fallback instead of native storage values', async () => {
	const nativeStore = new ThrowingCapabilityStore({ aggregate: true, select: true });
	nativeStore.queryResult = [
		{ id: 1, label: 'one', score: 'score:4' },
		{ id: 2, label: 'two', score: 'score:6' }
	];
	const fallbackContext = createActiveTs({
		stores: { default: nativeStore },
		aggregate: { allowQueryFallback: true }
	});
	const FallbackRecord = CodecAggregateRecord.use(fallbackContext) as unknown as typeof CodecAggregateRecord;

	assert.deepEqual(await FallbackRecord.query().aggregate({ total: { op: 'sum', field: 'score' } }), { total: 10 });
	assert.equal(nativeStore.queryCalls, 1);
	assert.equal(nativeStore.aggregateCalls, 0);
	assert.deepEqual(nativeStore.lastQuery?.select, ['id', 'score']);

	const strictStore = new ThrowingCapabilityStore({ aggregate: true, select: true });
	const strictContext = createActiveTs({ stores: { default: strictStore } });
	const StrictRecord = CodecAggregateRecord.use(strictContext) as unknown as typeof CodecAggregateRecord;
	await assert.rejects(
		() => StrictRecord.query().aggregate({ total: { op: 'sum', field: 'score' } }),
		/field-codec fields require aggregate\.allowQueryFallback/
	);
	assert.equal(strictStore.queryCalls, 0);
	assert.equal(strictStore.aggregateCalls, 0);
});

test('store aggregate results are sanitized before normalization', async () => {
	const store = new MalformedAggregateStore({ aggregate: true });
	const context = createActiveTs({ stores: { default: store } });
	const Record = CapabilityRecord.use(context) as unknown as typeof CapabilityRecord;

	await assert.rejects(
		() => Record.count(),
		/Store adapter "capability-test" aggregate result must be a plain object/
	);
	assert.equal(store.aggregateCalls, 1);
});

test('store aggregate numeric results reject ambiguous coercions', async () => {
	const invalidNumeric = new LiteralAggregateStore({ aggregate: true }, { total: 'not-a-number' });
	const invalidCount = new LiteralAggregateStore({ aggregate: true }, { count: -1 });
	const context = createActiveTs({ stores: { default: invalidNumeric } });
	const CountRecord = CapabilityRecord.use(createActiveTs({ stores: { default: invalidCount } })) as unknown as typeof CapabilityRecord;
	const Record = CapabilityRecord.use(context) as unknown as typeof CapabilityRecord;

	await assert.rejects(
		() => Record.query().aggregate({ total: { op: 'sum', field: 'score' } }),
		/aggregate "total" expected a numeric result/
	);
	await assert.rejects(
		() => CountRecord.count(),
		/aggregate "count" expected a non-negative safe integer count/
	);
});

test('model aggregate sanitizers reject unknown result aliases', async () => {
	const store = new LiteralAggregateStore({ aggregate: true }, { count: 1, extra: 1 });
	const StoreRecord = CapabilityRecord.use(createActiveTs({ stores: { default: store } })) as unknown as typeof CapabilityRecord;

	await assert.rejects(
		() => StoreRecord.count(),
		/Store adapter "capability-test" aggregate result contains unknown option "extra"/
	);

	const hookStore = new LiteralAggregateStore({ aggregate: true }, { count: 1 });
	const HookRecord = CapabilityRecord.use(createActiveTs({
		stores: { default: hookStore },
		plugins: [
			{
				name: 'extra-aggregate-result',
				hooks: {
					afterAggregate(payload) {
						return { result: { ...(payload.result as AggregateResult), extra: 1 } };
					}
				}
			}
		]
	})) as unknown as typeof CapabilityRecord;

	await assert.rejects(
		() => HookRecord.count(),
		/afterAggregate result contains unknown option "extra"/
	);
});

test('optimistic locking capability fails before adapter update execution', async () => {
	const store = new ThrowingCapabilityStore({ optimisticLock: false });
	store.rows.set('number:1', { id: 1, label: 'locked', score: 1, version: 1 });
	const context = createActiveTs({ stores: { default: store } });
	const Record = CapabilityRecord.use(context) as unknown as typeof CapabilityRecord;

	const loaded = await Record.find(1).load();
	loaded!.data.label = 'blocked';
	await assert.rejects(() => loaded!.save(), /atomic optimistic locking/);
	assert.equal(store.updateCalls, 0);
	await assert.rejects(() => Record.delete(1), /atomic optimistic locking/);
	assert.equal(store.deleteCalls, 0);
});

class ThrowingCapabilityStore implements StoreAdapter {
	readonly kind = 'capability-test';
	readonly rows = new Map<string, any>();
	readonly capabilities: StoreAdapter['capabilities'];
	queryCalls = 0;
	updateCalls = 0;
	deleteCalls = 0;
	aggregateCalls = 0;
	queryResult: any[] = [];
	queryCount?: number;
	lastQuery: QueryPlan | undefined;
	lastQueryOptions: StoreReadOptions | undefined;

	constructor(capabilities: Partial<NonNullable<StoreAdapter['capabilities']>>) {
		this.capabilities = {
			or: true,
			contains: false,
			arrayContains: true,
			textContains: true,
			jsonContains: true,
			startsWith: true,
			cursor: true,
			select: true,
			nestedFields: true,
			numericComparisons: true,
			aggregate: true,
			transaction: false,
			uniqueIndex: false,
			optimisticLock: true,
			nullOperators: true,
			missingFieldNulls: true,
			native: true,
			...capabilities
		};
	}

	async get(_model: ResolvedModelMeta, id: EntityId) {
		return this.rows.get(`number:${String(id)}`) ?? null;
	}

	async getMany(_model: ResolvedModelMeta, ids: EntityId[]) {
		return ids.map((id) => this.rows.get(`number:${String(id)}`) ?? null);
	}

	async query(_model: ResolvedModelMeta, plan: QueryPlan, options?: StoreReadOptions): Promise<QueryResult> {
		this.queryCalls++;
		this.lastQuery = plan;
		this.lastQueryOptions = options;
		return { list: this.queryResult, more: false, count: this.queryCount ?? this.queryResult.length };
	}

	async aggregate(): Promise<AggregateResult> {
		this.aggregateCalls++;
		throw new Error('aggregate should not be called');
	}

	async create() {}

	async update() {
		this.updateCalls++;
		throw new Error('update should not be called');
	}

	async delete() {
		this.deleteCalls++;
		throw new Error('delete should not be called');
	}
}

class MalformedAggregateStore extends ThrowingCapabilityStore {
	override async aggregate(): Promise<AggregateResult> {
		this.aggregateCalls++;
		return null as any;
	}
}

class LiteralAggregateStore extends ThrowingCapabilityStore {
	constructor(
		capabilities: Partial<NonNullable<StoreAdapter['capabilities']>>,
		private readonly result: AggregateResult
	) {
		super(capabilities);
	}

	override async aggregate(): Promise<AggregateResult> {
		this.aggregateCalls++;
		return this.result;
	}
}
