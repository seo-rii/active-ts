import test from 'node:test';
import assert from 'node:assert/strict';
import { datastoreKey, type QueryPlan, type QueryResult, type ResolvedModelMeta } from '../src/index.js';
import { createDatastoreStoreAdapter } from '../src/adapters/store/datastore.js';

// Every other built-in store adapter returns `count: list.length` from query();
// direct adapter callers and the store differential contract compare it.
const meta: ResolvedModelMeta = { model: class {}, name: 'datastore_query_count', store: 'default', idField: 'id',
	readValidation: 'off', indexes: [], searchIndexes: [], relations: new Map(), hooks: {}, views: new Map(),
	policies: new Map(), scopes: new Map(), fieldCodecs: new Map(), fieldTypes: new Map([['handle', 'string']]) };
const ancestorMeta: ResolvedModelMeta = { ...meta, name: 'datastore_query_count_child',
	datastore: { ancestor: ({ data }) => data ? datastoreKey('datastore_query_count_parent', data.parentId) : undefined } };

const rows = [
	{ id: 1, parentId: 10, handle: 'a', note: 'keep' },
	{ id: 2, parentId: 10, handle: 'b', note: 'drop' },
	{ id: 3, parentId: 10, handle: 'c', note: 'keep' }
];

function countingClient() {
	const keySymbol = Symbol('datastore-query-count-key');
	const createQuery = () => {
		const state = { keysOnly: false, filters: [] as Array<[string, string, unknown]>, limit: undefined as number | undefined };
		const query = {
			state,
			hasAncestor() { return query; },
			filter(field: string, op: string, value: unknown) { state.filters.push([field, op, value]); return query; },
			order() { return query; },
			offset() { return query; },
			start() { return query; },
			limit(value: number) { state.limit = value; return query; },
			select(field: unknown) { state.keysOnly = field === '__key__'; return query; }
		};
		return query;
	};
	type FakeQuery = ReturnType<typeof createQuery>;
	const runQuery = async (query: FakeQuery) => {
		let matched = rows.filter((row) => query.state.filters.every(([field, op, value]) =>
			op === '=' && (row as Record<string, unknown>)[field] === value));
		const more = query.state.limit !== undefined && matched.length > query.state.limit;
		if (query.state.limit !== undefined) matched = matched.slice(0, query.state.limit);
		const entities = matched.map((row) => query.state.keysOnly
			? Object.defineProperty({}, keySymbol, { value: { name: `number:${row.id}` }, enumerable: false })
			: { ...row });
		return [entities, more ? { moreResults: 'MORE_RESULTS_AFTER_LIMIT', endCursor: 'page-1' } : { moreResults: 'NO_MORE_RESULTS' }];
	};
	const transaction = () => ({ run: async () => undefined, commit: async () => undefined, rollback: async () => undefined,
		get: async () => [undefined], runQuery, insert: async () => undefined, update: async () => undefined,
		upsert: async () => undefined, save: async () => undefined, delete: async () => undefined });
	return { KEY: keySymbol, key: (input: unknown) => input, get: async () => [undefined], save: async () => undefined,
		insert: async () => undefined, update: async () => undefined, upsert: async () => undefined,
		delete: async () => undefined, createQuery, runQuery, transaction };
}

function plan(overrides: Partial<QueryPlan> = {}): QueryPlan {
	return { where: [], or: [], sort: [], include: [], ...overrides };
}

function assertCounted(result: QueryResult, ids: unknown[], more: boolean, label: string) {
	assert.equal(Object.hasOwn(result, 'count'), true, `${label} returns an own count`);
	assert.deepEqual(
		{ ids: result.list.map((row) => row.id), count: result.count, more: result.more },
		{ ids, count: ids.length, more },
		label
	);
}

test('Datastore query results report count for every query path', async () => {
	const store = await createDatastoreStoreAdapter({ client: countingClient(), allowQueryScanFallback: true });
	assertCounted(await store.query(meta, plan()), [1, 2, 3], false, 'native query');
	assertCounted(await store.query(meta, plan({ where: [{ field: 'handle', op: '=', value: 'b' }] })), [2], false,
		'native typed filter');
	assertCounted(await store.query(meta, plan({ limit: 2 })), [1, 2], true, 'native page with more');
	assertCounted(await store.query(meta, plan({ where: [{ field: 'handle', op: '=', value: 'none' }] })), [], false,
		'native empty result');
	assertCounted(await store.query(meta, plan({ select: ['id'] })), [1, 2, 3], false, 'key-only projection');
	assertCounted(
		await store.query(ancestorMeta, plan({ meta: { datastoreAncestor: datastoreKey('datastore_query_count_parent', 10) } })),
		[1, 2, 3], false, 'ancestor query'
	);
	assertCounted(await store.query(meta, plan({ where: [{ field: 'note', op: '=', value: 'keep' }], limit: 1 })), [1], true,
		'portable candidate filter');
	assertCounted(await store.query(meta, plan({ where: [{ field: 'note', op: '!=', value: 'keep' }] })), [2], false,
		'scan fallback');
	assertCounted(
		await store.query(meta, plan({ native: { payload: async () => ({ list: [{ id: 9, handle: 'native' }], more: false }) } })),
		[9], false, 'native function query'
	);
	await store.transaction!(async (tx) => {
		await tx.create(meta, 4, { id: 4, handle: 'd', note: 'keep' });
		assertCounted(await tx.query(meta, plan({ where: [{ field: 'note', op: '=', value: 'keep' }] })), [1, 3, 4], false,
			'transaction overlay');
		assertCounted(await tx.query(meta, plan({ limit: 2 })), [1, 2], true, 'transaction overlay page');
	});
});
