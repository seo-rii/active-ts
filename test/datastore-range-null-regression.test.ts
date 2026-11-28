import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatastoreStoreAdapter } from '../src/adapters/store/datastore.js';
import type { QueryPlan, ResolvedModelMeta } from '../src/index.js';

const meta: ResolvedModelMeta = { model: class {}, name: 'range_nulls', store: 'default', idField: 'id',
	readValidation: 'off', indexes: [], searchIndexes: [], relations: new Map(), hooks: {}, views: new Map(),
	policies: new Map(), scopes: new Map(), fieldCodecs: new Map(),
	fieldTypes: new Map([['score', 'number'], ['label', 'string']]) };

// Datastore value ordering: null sorts below numbers and strings, and an
// inequality filter is not restricted to the operand's type.
function rank(value: unknown) {
	return value === null ? 0 : typeof value === 'number' ? 1 : 2;
}
function compare(left: unknown, right: unknown) {
	if (rank(left) !== rank(right)) return rank(left) - rank(right);
	if (left === right || left === null) return 0;
	return (left as number | string) < (right as number | string) ? -1 : 1;
}
function matches(row: Record<string, unknown>, field: string, op: string, value: unknown) {
	if (!Object.hasOwn(row, field)) return false;
	const order = compare(row[field], value);
	if (op === '=') return order === 0;
	if (op === '!=') return order !== 0;
	if (op === '<') return order < 0;
	if (op === '<=') return order <= 0;
	if (op === '>') return order > 0;
	if (op === '>=') return order >= 0;
	throw new Error(`unexpected operator ${op}`);
}

function orderingClient(rows: Array<Record<string, unknown>>) {
	const filters: Array<[string, string, unknown]> = [];
	const createQuery = () => {
		const state = { filters: [] as Array<[string, string, unknown]>, order: [] as Array<[string, boolean]>, limit: Infinity };
		const query = {
			state,
			filter(field: string, op: string, value: unknown) {
				state.filters.push([field, op, value]);
				filters.push([field, op, value]);
				return query;
			},
			order(field: string, options: { descending: boolean }) { state.order.push([field, options.descending]); return query; },
			limit(limit: number) { state.limit = limit; return query; },
			select() { return query; }
		};
		return query;
	};
	type Query = ReturnType<typeof createQuery>;
	const run = (query: Query) => {
		let result = rows.filter((row) => query.state.filters.every(([field, op, value]) => matches(row, field, op, value)));
		for (const [field] of query.state.order) result = result.filter((row) => Object.hasOwn(row, field));
		result = [...result].sort((left, right) => {
			for (const [field, descending] of query.state.order) {
				const order = compare(left[field], right[field]);
				if (order) return descending ? -order : order;
			}
			return 0;
		});
		return result.slice(0, query.state.limit);
	};
	const client = { KEY: Symbol('key'), key: (value: unknown) => value, get: async () => [undefined], save: async () => {},
		update: async () => {}, delete: async () => {}, createQuery,
		runQuery: async (query: Query) => [run(query).map((row) => ({ ...row })), { moreResults: 'NO_MORE_RESULTS' }],
		createAggregationQuery: (query: Query) => {
			const specs: Array<[string, string | undefined, string]> = [];
			const aggregate = {
				query,
				specs,
				count(alias: string) { specs.push(['count', undefined, alias]); return aggregate; },
				sum(field: string, alias: string) { specs.push(['sum', field, alias]); return aggregate; },
				average(field: string, alias: string) { specs.push(['avg', field, alias]); return aggregate; }
			};
			return aggregate;
		},
		runAggregationQuery: async (aggregate: { query: Query; specs: Array<[string, string | undefined, string]> }) => {
			const matched = run(aggregate.query);
			const row: Record<string, number | null> = {};
			for (const [op, field, alias] of aggregate.specs) {
				const values = field === undefined ? [] : matched.map((entity) => entity[field]).filter((value) => typeof value === 'number') as number[];
				row[alias] = op === 'count'
					? matched.length
					: op === 'sum'
						? values.reduce((total, value) => total + value, 0)
						: values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
			}
			return [[row]];
		}
	};
	return { client, filters };
}

const rows = [
	{ id: 1, score: 5, label: 'b' },
	{ id: 2, score: null, label: null },
	{ id: 3, score: 20, label: 'x' },
	{ id: 4, score: 8, label: 'a' }
];

for (const op of ['<', '<='] as const) {
	test(`Datastore typed ${op} filters exclude null values`, async () => {
		const { client } = orderingClient(rows);
		const datastore = await createDatastoreStoreAdapter({ client });
		const scoreRange: QueryPlan['where'] = [{ field: 'score', op, value: 10 }];
		const ids = async (where: QueryPlan['where'], sort = 'score') =>
			(await datastore.query(meta, { where, or: [], sort: [{ field: sort, direction: 'asc' }], include: [] })).list.map((row) => row.id);
		assert.deepEqual(await ids(scoreRange), [1, 4]);
		assert.deepEqual(await ids([{ field: 'label', op, value: 'c' }], 'label'), [4, 1]);
		assert.deepEqual(
			await datastore.aggregate!(meta, { where: scoreRange, or: [], aggregates: [{ op: 'count', as: 'count' }] }),
			{ count: 2 }
		);
		assert.deepEqual(
			await datastore.aggregate!(meta, { where: scoreRange, or: [], aggregates: [{ op: 'min', field: 'score', as: 'min' }] }),
			{ min: 5 }
		);
	});
}

test('Datastore lower-bounded ranges keep their native filters', async () => {
	const { client, filters } = orderingClient(rows);
	const datastore = await createDatastoreStoreAdapter({ client });
	const result = await datastore.query(meta, {
		where: [{ field: 'score', op: 'between', value: 0, value2: 10 }],
		or: [],
		sort: [{ field: 'score', direction: 'asc' }],
		include: []
	});
	assert.deepEqual(result.list.map((row) => row.id), [1, 4]);
	assert.deepEqual(filters, [['score', '>=', 0], ['score', '<=', 10]]);
});
