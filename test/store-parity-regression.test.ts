import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStoreAdapter } from '../src/index.js';
import { createSqliteStoreAdapter } from '../src/adapters/store/sqlite.js';
import { createStoreParityFixture, runStoreAdapterDifferentialContract } from '../src/testing/index.js';

test('Store parity fixtures are reproducible across seeds and retain boundary coverage', () => {
	assert.deepEqual(createStoreParityFixture(17), createStoreParityFixture(17));
	assert.notDeepEqual(createStoreParityFixture(17).rows.map((row) => row.id), createStoreParityFixture(29).rows.map((row) => row.id));
	assert.throws(() => createStoreParityFixture(-1), /unsigned 32-bit/);
});

for (const seed of [17, 29]) {
	test(`Shared boundary differential contract: real SQLite versus Memory, seed ${seed}`, async (t) => {
		const store = await createSqliteStoreAdapter(); t.after(() => store.close());
		const result = await runStoreAdapterDifferentialContract(store, { seed });
		assert.equal(result.queries, 29);
		assert.equal(result.aggregates, 6);
		assert.equal(result.pages, 3);
		assert.equal(result.rejections, 4);
		assert.equal(result.skipped, 0);
	});
}

test('Shared boundary differential contract also exercises two cursor-capable stores', async () => {
	const result = await runStoreAdapterDifferentialContract(new MemoryStoreAdapter(), { seed: 41 });
	assert.equal(result.pages, 6);
});

test('Differential failures include the reproducible case and clean inserted records', async () => {
	const candidate = new MemoryStoreAdapter();
	const reference = new MemoryStoreAdapter();
	const query = candidate.query.bind(candidate);
	candidate.query = async (...args) => { const result = await query(...args); return { ...result, count: (result.count ?? 0) + 1 }; };
	await assert.rejects(runStoreAdapterDifferentialContract(candidate, { seed: 17, modelName: 'parity_failure', reference }), /seed=17 case=label-asc/);
	assert.equal(candidate.stats.create, candidate.stats.delete);
	assert.equal(reference.stats.create, reference.stats.delete);
});
