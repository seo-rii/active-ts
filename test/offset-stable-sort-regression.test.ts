import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatastoreStoreAdapter } from '../src/adapters/store/datastore.js';
import { createFirestoreStoreAdapter } from '../src/adapters/store/firestore.js';
import { MemoryStoreAdapter, type QueryPlan, type ResolvedModelMeta } from '../src/index.js';

const meta: ResolvedModelMeta = { model: class {}, name: 'offset_stable_sort', store: 'default', idField: 'id',
	readValidation: 'off', indexes: [], searchIndexes: [], relations: new Map(), hooks: {}, views: new Map(),
	policies: new Map(), scopes: new Map(), fieldCodecs: new Map(), fieldTypes: new Map([['score', 'number']]) };

// Datastore and Firestore break ties by key, and active-ts keys such as
// "number:10" sort before "number:2".
const rows = [{ id: 2, score: 5 }, { id: 10, score: 5 }, { id: 3, score: 1 }, { id: 30, score: 9 }];
const keyName = (row: Record<string, any>) => `number:${row.id}`;
function sorted(order: Array<[string, boolean]>) {
	return [...rows].sort((left: Record<string, any>, right: Record<string, any>) => {
		for (const [field, descending] of order) {
			const value = left[field] < right[field] ? -1 : left[field] > right[field] ? 1 : 0;
			if (value) return descending ? -value : value;
		}
		return keyName(left) < keyName(right) ? -1 : 1;
	});
}

function datastoreClient() {
	const orders: Array<Array<[string, boolean]>> = [];
	const createQuery = () => {
		const state = { order: [] as Array<[string, boolean]>, offset: 0 };
		orders.push(state.order);
		const query = {
			state,
			order(field: string, options: { descending: boolean }) { state.order.push([field, options.descending]); return query; },
			offset(offset: number) { state.offset = offset; return query; },
			limit() { return query; }
		};
		return query;
	};
	const client = { KEY: Symbol('key'), key: (value: unknown) => value, get: async () => [undefined], save: async () => {},
		update: async () => {}, delete: async () => {}, createQuery,
		runQuery: async (query: ReturnType<typeof createQuery>) => [
			sorted(query.state.order).slice(query.state.offset).map((row) => ({ ...row })),
			{ moreResults: 'NO_MORE_RESULTS' }
		]
	};
	return { client, orders };
}

function firestoreClient() {
	const orders: Array<Array<[string, boolean]>> = [];
	const query = (state: { order: Array<[string, boolean]>; offset: number }) => ({
		orderBy(field: string, direction: string) { return query({ ...state, order: [...state.order, [field, direction === 'desc']] }); },
		offset(offset: number) { return query({ ...state, offset }); },
		async get() {
			orders.push(state.order);
			return { docs: sorted(state.order).slice(state.offset).map((row) => ({ data: () => ({ ...row }) })) };
		}
	});
	return { client: { collection: () => query({ order: [], offset: 0 }), getAll: async () => [], runTransaction: async () => undefined }, orders };
}

test('sorted offset pages break ties by id on Datastore and Firestore', async () => {
	const memory = new MemoryStoreAdapter();
	for (const row of rows) await memory.create(meta, row.id, row);
	const datastore = datastoreClient();
	const firestore = firestoreClient();
	const stores = [
		await createDatastoreStoreAdapter({ client: datastore.client }),
		await createFirestoreStoreAdapter({ client: firestore.client })
	];
	for (const direction of ['asc', 'desc'] as const) {
		const plan: QueryPlan = { where: [], or: [], sort: [{ field: 'score', direction }], include: [], offset: 1 };
		const expected = (await memory.query(meta, plan)).list;
		for (const store of stores) assert.deepEqual((await store.query(meta, plan)).list, expected, `${store.kind} ${direction}`);
	}
	for (const orders of [datastore.orders, firestore.orders]) {
		assert.deepEqual(orders.at(-1), [['score', true], ['id', false]]);
	}
});
