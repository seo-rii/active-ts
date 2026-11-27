import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatastoreStoreAdapter } from '../src/adapters/store/datastore.js';
import { MemoryStoreAdapter, type QueryPlan, type ResolvedModelMeta } from '../src/index.js';

// `group` and `rank` have no fieldType, so filters on them use portable
// candidate filtering and sorting in process.
const meta: ResolvedModelMeta = { model: class {}, name: 'portable_candidate_sort', store: 'default', idField: 'id',
	readValidation: 'off', indexes: [], searchIndexes: [], relations: new Map(), hooks: {}, views: new Map(),
	policies: new Map(), scopes: new Map(), fieldCodecs: new Map(), fieldTypes: new Map() };

const rows = [
	{ id: 1, group: 'a', rank: 'b' },
	{ id: 2, group: 'a' },
	{ id: 3, group: 'a', rank: null },
	{ id: 4, group: 'b', rank: 'a' },
	{ id: 5, group: 'a', rank: 'a' }
];

// Datastore drops entities without the ordered property from the result.
function orderingClient() {
	const orders: string[] = [];
	const createQuery = () => {
		const state = { filters: [] as Array<[string, unknown]>, order: [] as string[] };
		const query = {
			state,
			filter(field: string, op: string, value: unknown) {
				if (op !== '=') throw new Error(`unexpected operator ${op}`);
				state.filters.push([field, value]);
				return query;
			},
			order(field: string) { state.order.push(field); orders.push(field); return query; },
			limit() { return query; },
			start() { return query; }
		};
		return query;
	};
	const client = { KEY: Symbol('key'), key: (value: unknown) => value, get: async () => [undefined], save: async () => {},
		update: async () => {}, delete: async () => {}, createQuery,
		runQuery: async (query: ReturnType<typeof createQuery>) => [
			rows
				.filter((row: Record<string, unknown>) => query.state.filters.every(([field, value]) => row[field] === value))
				.filter((row) => query.state.order.every((field) => Object.hasOwn(row, field)))
				.map((row) => ({ ...row })),
			{ moreResults: 'NO_MORE_RESULTS' }
		]
	};
	return { client, orders };
}

test('Datastore portable candidate queries keep rows missing an untyped sort field', async () => {
	const memory = new MemoryStoreAdapter();
	for (const row of rows) await memory.create(meta, row.id, row);
	const { client, orders } = orderingClient();
	const datastore = await createDatastoreStoreAdapter({ client });
	for (const direction of ['asc', 'desc'] as const) {
		for (const extra of [{}, { limit: 2 }, { offset: 1 }]) {
			const plan: QueryPlan = {
				where: [{ field: 'group', op: '=', value: 'a' }],
				or: [],
				sort: [{ field: 'rank', direction }],
				include: [],
				...extra
			};
			assert.deepEqual(
				(await datastore.query(meta, plan)).list,
				(await memory.query(meta, plan)).list,
				`${direction} ${JSON.stringify(extra)}`
			);
		}
	}
	assert.deepEqual(orders, [], 'portable candidate queries sort in process');
});
