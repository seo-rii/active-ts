import test from 'node:test';
import assert from 'node:assert/strict';
import { Filter } from '@google-cloud/firestore';
import { MemoryStoreAdapter, type QueryPlan, type ResolvedModelMeta } from '../src/index.js';
import { createFirestoreStoreAdapter } from '../src/adapters/store/firestore.js';

const meta: ResolvedModelMeta = { model: class {}, name: 'firestore_null_inequality', store: 'default', idField: 'id',
	readValidation: 'off', indexes: [], searchIndexes: [], relations: new Map(), hooks: {}, views: new Map(),
	policies: new Map(), scopes: new Map(), fieldCodecs: new Map(), fieldTypes: new Map([['score', 'number']]) };

const rows = [
	{ id: 1, status: 'open', score: 4 },
	{ id: 2, status: null, score: 2 },
	{ id: 3, status: 'closed', score: 9 },
	{ id: 4, score: 1 },
	{ id: 5, status: 'open', score: null }
];

type Condition = { field: string; op: string; value: unknown } | { or: Condition[] };
const fakeFilter = {
	where: (field: string, op: string, value: unknown): Condition => ({ field, op, value }),
	or: (...filters: Condition[]): Condition => ({ or: filters })
};

// Firestore semantics: `!=` and `in` never match null or a missing field.
function matches(row: Record<string, unknown>, condition: Condition): boolean {
	if (condition instanceof Filter) return false;
	if ('or' in condition) return condition.or.some((item) => matches(row, item));
	if (!Object.hasOwn(row, condition.field)) return false;
	const value = row[condition.field];
	if (condition.op === '==') return value === condition.value;
	if (condition.op === '!=') return value !== null && value !== condition.value;
	if (condition.op === 'in') return value !== null && (condition.value as unknown[]).includes(value);
	throw new Error(`unexpected operator ${condition.op}`);
}

function firestoreClient() {
	const calls: unknown[] = [];
	const query = (state: { filters: Condition[]; order?: [string, string]; limit?: number }) => ({
		where(field: string | Condition, op?: string, value?: unknown) {
			const condition = typeof field === 'string' ? { field, op: op!, value } : field;
			calls.push(condition);
			return query({ ...state, filters: [...state.filters, condition] });
		},
		orderBy(field: string, direction: string) { return query({ ...state, order: [field, direction] }); },
		limit(limit: number) { return query({ ...state, limit }); },
		select() { return query(state); },
		run() {
			let result = rows.filter((row) => state.filters.every((condition) => matches(row, condition)));
			if (state.order) {
				const [field, direction] = state.order;
				result = result.filter((row) => Object.hasOwn(row, field));
				result.sort((left: any, right: any) => {
					const rank = (value: unknown) => (value === null ? 0 : 1);
					const order = rank(left[field]) - rank(right[field]) || left[field] - right[field];
					return direction === 'desc' ? -order : order;
				});
			}
			return result.slice(0, state.limit ?? result.length);
		},
		async get() { return { docs: this.run().map((row) => ({ data: () => ({ ...row }) })) }; },
		aggregate(spec: Record<string, unknown>) {
			const matched = this.run();
			return { get: async () => ({ data: () => Object.fromEntries(Object.keys(spec).map((alias) => [alias, matched.length])) }) };
		}
	});
	const client = {
		collection: () => query({ filters: [] }),
		getAll: async () => [],
		runTransaction: async (callback: (transaction: unknown) => Promise<unknown>) =>
			callback({
				get: async (target: { get(): Promise<unknown> }) => target.get(),
				create: () => undefined, set: () => undefined, update: () => undefined, delete: () => undefined
			})
	};
	return { client, calls };
}

const aggregateField = { count: () => ({ op: 'count' }), sum: () => ({}), average: () => ({}) };

const plans: Array<{ name: string; where: QueryPlan['where'] }> = [
	{ name: '!= value', where: [{ field: 'status', op: '!=', value: 'open' }] },
	{ name: 'in with null', where: [{ field: 'status', op: 'in', value: ['closed', null] }] },
	{ name: 'in null only', where: [{ field: 'status', op: 'in', value: [null] }] },
	{ name: '!= null', where: [{ field: 'status', op: '!=', value: null }] }
];

for (const { name, where } of plans) {
	test(`Firestore portable ${name} matches the memory store null semantics`, async () => {
		const memory = new MemoryStoreAdapter();
		for (const row of rows) await memory.create(meta, row.id, row);
		const { client } = firestoreClient();
		const firestore = await createFirestoreStoreAdapter({ client, aggregateField, filter: fakeFilter, allowAggregateScanFallback: true });
		const plan: QueryPlan = { where, or: [], sort: [], include: [] };
		const ids = (list: Array<{ id: number }>) => list.map((row) => row.id).sort();
		const expected = ids((await memory.query(meta, plan)).list);
		assert.deepEqual(ids((await firestore.query(meta, plan)).list), expected);
		assert.deepEqual(
			await firestore.aggregate!(meta, { where, or: [], aggregates: [{ op: 'count', as: 'count' }] }),
			{ count: expected.length }
		);
		const sum = { where, or: [], aggregates: [{ op: 'sum' as const, field: 'score', as: 'total' }] };
		assert.deepEqual(await firestore.aggregate!(meta, sum), await memory.aggregate(meta, sum));
		const inTransaction = await firestore.transaction!(async (tx) => ids((await tx.query(meta, plan)).list));
		assert.deepEqual(inTransaction, expected);
	});
}

test('Firestore min/max keep null-excluding filters on the aggregate field itself', async () => {
	const { client, calls } = firestoreClient();
	const firestore = await createFirestoreStoreAdapter({ client, aggregateField, filter: fakeFilter });
	assert.deepEqual(
		await firestore.aggregate!(meta, {
			where: [{ field: 'score', op: '!=', value: 4 }],
			or: [],
			aggregates: [{ op: 'min', field: 'score', as: 'min' }]
		}),
		{ min: 1 }
	);
	assert.deepEqual(calls, [{ field: 'score', op: '!=', value: 4 }]);
});

test('Firestore uses the installed SDK Filter class for injected clients', async () => {
	const { client, calls } = firestoreClient();
	const firestore = await createFirestoreStoreAdapter({ client });
	await firestore.query(meta, { where: [{ field: 'status', op: '!=', value: 'open' }], or: [], sort: [], include: [] });
	assert.equal(calls.length, 1);
	assert.ok(calls[0] instanceof Filter, 'the portable != filter is sent as an SDK Filter');
});
