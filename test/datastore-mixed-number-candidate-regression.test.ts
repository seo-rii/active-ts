import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatastoreStoreAdapter } from '../src/adapters/store/datastore.js';
import { MemoryStoreAdapter, type QueryPlan, type ResolvedModelMeta } from '../src/index.js';

// `amount` has no fieldType, so its filters select candidates for portable
// in-process filtering.
const meta: ResolvedModelMeta = { model: class {}, name: 'mixed_number_candidates', store: 'default', idField: 'id',
	readValidation: 'off', indexes: [], searchIndexes: [], relations: new Map(), hooks: {}, views: new Map(),
	policies: new Map(), scopes: new Map(), fieldCodecs: new Map(), fieldTypes: new Map() };

const amounts = [-3, -2.5, 0.5, 1, 1.5, 2, 2.5, 3, null, 'text', true];
const rows = amounts.map((amount, index) => ({ id: index + 1, amount }));

// Datastore value ordering, as both emulators apply it: null, integers,
// booleans, strings, then doubles. Integer-valued numbers are integers.
function rank(value: unknown) {
	if (value === null) return 0;
	if (typeof value === 'number') return Number.isInteger(value) ? 1 : 4;
	if (typeof value === 'boolean') return 2;
	return 3;
}
function compare(left: unknown, right: unknown) {
	if (rank(left) !== rank(right)) return rank(left) - rank(right);
	if (left === right) return 0;
	return (left as number) < (right as number) ? -1 : 1;
}
function matches(row: Record<string, unknown>, field: string, op: string, value: unknown) {
	if (!Object.hasOwn(row, field)) return false;
	const order = compare(row[field], value);
	if (op === '=') return order === 0;
	if (op === '<') return order < 0;
	if (op === '<=') return order <= 0;
	if (op === '>') return order > 0;
	if (op === '>=') return order >= 0;
	throw new Error(`unexpected operator ${op}`);
}

function orderingClient() {
	const createQuery = () => {
		const state = { filters: [] as Array<[string, string, unknown]> };
		const query = {
			state,
			filter(field: string, op: string, value: unknown) { state.filters.push([field, op, value]); return query; },
			order() { return query; },
			limit() { return query; },
			start() { return query; }
		};
		return query;
	};
	return { KEY: Symbol('key'), key: (value: unknown) => value, get: async () => [undefined], save: async () => {},
		update: async () => {}, delete: async () => {}, createQuery,
		runQuery: async (query: ReturnType<typeof createQuery>) => [
			rows
				.filter((row) => query.state.filters.every(([field, op, value]) => matches(row, field, op, value)))
				.map((row) => ({ ...row })),
			{ moreResults: 'NO_MORE_RESULTS' }
		]
	};
}

const filters: QueryPlan['where'] = [
	{ field: 'amount', op: '>', value: 1.2 },
	{ field: 'amount', op: '>=', value: -2.75 },
	{ field: 'amount', op: '>', value: 1 },
	{ field: 'amount', op: '<', value: 2 },
	{ field: 'amount', op: '<=', value: -3 },
	{ field: 'amount', op: '<', value: 2.2 },
	{ field: 'amount', op: 'between', value: 0.4, value2: 2 },
	{ field: 'amount', op: 'between', value: -3, value2: 2.5 }
];

test('Datastore portable numeric ranges match integers and fractions together', async () => {
	const memory = new MemoryStoreAdapter();
	for (const row of rows) await memory.create(meta, row.id, row);
	const datastore = await createDatastoreStoreAdapter({ client: orderingClient() });
	for (const where of filters) {
		const plan: QueryPlan = { where: [where], or: [], sort: [{ field: 'amount', direction: 'asc' }], include: [] };
		assert.deepEqual(
			(await datastore.query(meta, plan)).list,
			(await memory.query(meta, plan)).list,
			JSON.stringify(where)
		);
	}
});
