import assert from 'node:assert/strict';
import { createFirestoreStoreAdapter } from '../../build/src/adapters/store/firestore.js';

// The runner supplies an isolated, empty model with idField "id" and owns the
// backend client. These probes delete only the rows they successfully create.
async function withAggregateRows(adapter, meta, run) {
	assert.equal(meta.idField, 'id');
	const createdIds = [];
	let probeError;
	try {
		await run(async (row) => {
			await adapter.create(meta, row.id, row);
			createdIds.push(row.id);
		});
	} catch (error) {
		probeError = error;
	}
	const cleanup = await Promise.allSettled(createdIds.map((id) => adapter.delete(meta, id)));
	const failures = cleanup.filter((result) => result.status === 'rejected').map((result) => result.reason);
	if (probeError) failures.unshift(probeError);
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) throw new AggregateError(failures, 'Aggregate parity probe and cleanup failed.');
}

export async function runMongoAggregateParity({ adapter, meta }) {
	await withAggregateRows(adapter, meta, async (create) => {
		await create({ id: 1, score: 10 });
		await create({ id: 2, score: 30 });
		for (const [op, value, empty] of [['count', 2, 0], ['sum', 40, 0], ['avg', 20, null]]) {
			const aggregates = [
				op === 'count' ? { op, as: '_id' } : { op, field: 'score', as: '_id' },
				{ op: 'count', as: '_activeTsResult_id' },
				{ op: 'count', as: 'count' }
			];
			assert.deepEqual(
				await adapter.aggregate(meta, { where: [], or: [], aggregates }),
				{ _id: value, _activeTsResult_id: 2, count: 2 },
				`MongoDB ${op} keeps the public _id alias separate from the backend group key`
			);
			assert.deepEqual(
				await adapter.aggregate(meta, { where: [{ field: 'id', op: '=', value: -1 }], or: [], aggregates }),
				{ _id: empty, _activeTsResult_id: 0, count: 0 },
				`MongoDB ${op} preserves empty-result defaults for the public _id alias`
			);
		}
	});
	console.log('MongoDB aggregate parity passed: count/sum/avg public _id aliases, populated and empty results.');
}

export async function runFirestoreAggregateParity({ adapter, client, aggregateField, meta }) {
	// Observe reads on the actual SDK query objects, without inventing backend
	// responses. Merely constructing a collection/query is not a database read.
	const reads = { query: 0, aggregate: 0 };
	function observeQuery(query) {
		return {
			where: (...args) => observeQuery(query.where(...args)),
			select: (...args) => observeQuery(query.select(...args)),
			get: () => {
				reads.query++;
				return query.get();
			},
			aggregate: (specs) => {
				const aggregate = query.aggregate(specs);
				return { get: () => {
					reads.aggregate++;
					return aggregate.get();
				} };
			}
		};
	}
	const withoutScanAdapter = await createFirestoreStoreAdapter({
		client: {
			collection: (...args) => observeQuery(client.collection(...args)),
			getAll: (...args) => client.getAll(...args),
			runTransaction: (...args) => client.runTransaction(...args)
		},
		aggregateField
	});
	const combined = {
		where: [], or: [], aggregates: [
			{ op: 'count', as: 'count' },
			{ op: 'sum', field: 'a', as: 'sumA' },
			{ op: 'sum', field: 'b', as: 'sumB' }
		]
	};
	await withAggregateRows(adapter, meta, async (create) => {
		await create({ id: 1, a: 10 });
		await create({ id: 2, b: 20 });
		assert.deepEqual(await adapter.aggregate(meta, combined), { count: 2, sumA: 10, sumB: 20 },
			'Firestore aggregates use all matching rows, not the intersection of aggregate fields');
		await assert.rejects(() => withoutScanAdapter.aggregate(meta, combined), /allowAggregateScanFallback/);
		await create({ id: 3, a: 30, b: 40 });
		await create({ id: 4, a: null, b: null });
		await create({ id: 5 });
		assert.deepEqual(await adapter.aggregate(meta, {
			...combined,
			aggregates: [...combined.aggregates, { op: 'avg', field: 'a', as: 'avgA' }, { op: 'avg', field: 'b', as: 'avgB' }]
		}), { count: 5, sumA: 40, sumB: 60, avgA: 20, avgB: 30 },
		'Firestore averages exclude null/missing values from their denominator');
		await create({ id: 6, a: 'not-a-number' });
		for (const op of ['sum', 'avg']) {
			const plan = { where: [], or: [], aggregates: [{ op, field: 'a', as: 'result' }] };
			await assert.rejects(() => adapter.aggregate(meta, plan), /number|numeric/,
				`Firestore ${op} rejects a stored nonnumeric value instead of silently ignoring it`);
			await assert.rejects(() => withoutScanAdapter.aggregate(meta, plan), /allowAggregateScanFallback/);
		}
		assert.deepEqual(reads, { query: 0, aggregate: 0 },
			'Firestore sum/avg must reject before any SDK read without scan opt-in');
		assert.deepEqual(await withoutScanAdapter.aggregate(meta, {
			where: [], or: [], aggregates: [{ op: 'count', as: 'count' }]
		}), { count: 6 }, 'Firestore count remains available without aggregate scan opt-in');
		assert.deepEqual(reads, { query: 0, aggregate: 1 }, 'Firestore count uses a real SDK aggregate read');
	});
	console.log('Firestore aggregate parity passed: sparse fields, null/missing averages, numeric validation, explicit scan opt-in and native count.');
}
