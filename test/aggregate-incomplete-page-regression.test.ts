import test from 'node:test';
import assert from 'node:assert/strict';
import { Model, defineModel, createActiveTs, type StoreAdapter } from '../src/index.js';
import { createDatastoreStoreAdapter } from '../src/adapters/store/datastore.js';

class PageAggregateRow extends Model<{ id: number; amount: number }> {}
defineModel('incomplete_page_aggregate').id('id')
	.fieldCodec('amount', { name: 'number_string', encode: String, decode: Number }).attach(PageAggregateRow);

test('aggregate fallback rejects a Datastore continuation before publishing an aggregate', async () => {
	let calls = 0;
	let afterAggregates = 0;
	const store = await createDatastoreStoreAdapter({ client: {
		key: (value: unknown) => value, get: async () => [undefined], save: async () => {}, delete: async () => {}, update: async () => {},
		createQuery: () => ({
			startAt: undefined as string | undefined,
			filter() { return this; }, order() { return this; }, select() { return this; }, limit() { return this; },
			start(value: string) { this.startAt = value; return this; }
		}),
		runQuery: async (query: { startAt?: string }) => {
			calls++;
			return query.startAt
				? [[{ id: 2, amount: '5' }], { moreResults: 'NO_MORE_RESULTS' }]
				: [[{ id: 1, amount: '3' }], { moreResults: 'NOT_FINISHED', endCursor: 'page-2' }];
		}
	} });
	const Row = PageAggregateRow.use(createActiveTs({
		stores: { default: store }, aggregate: { allowQueryFallback: true },
		plugins: [{ name: 'aggregate-result-counter', hooks: { afterAggregate() { afterAggregates++; } } }]
	}));
	const first = await Row.query().load();
	const second = await Row.query().cursor(first.cursor).load();
	assert.deepEqual([...first.list, ...second.list].map((row) => row.data.amount), [3, 5]);
	calls = 0;
	await assert.rejects(() => Row.sum('amount'), /Aggregate fallback requires a complete query result/);
	assert.equal(calls, 1);
	assert.equal(afterAggregates, 0);
});

test('aggregate fallback rejects incomplete results even without a continuation cursor', async () => {
	let calls = 0;
	const store: StoreAdapter = {
		kind: 'incomplete-aggregate-test', capabilities: { select: true },
		get: async () => null, getMany: async () => [], create: async () => {}, update: async () => {}, delete: async () => {},
		query: async () => { calls++; return { list: [{ id: 1, amount: '3' }], more: true }; }
	};
	const Row = PageAggregateRow.use(createActiveTs({ stores: { default: store }, aggregate: { allowQueryFallback: true } }));
	await assert.rejects(() => Row.sum('amount'), /Aggregate fallback requires a complete query result/);
	assert.equal(calls, 1);
});
