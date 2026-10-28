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

test('Differential cleanup awaits every deletion after a synchronous failure', async () => {
	const candidate = new MemoryStoreAdapter();
	const reference = new MemoryStoreAdapter();
	const remove = candidate.delete.bind(candidate);
	let attempts = 0;
	let release!: () => void;
	let started!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	const cleanupStarted = new Promise<void>(resolve => { started = resolve; });
	candidate.delete = (...args) => {
		attempts++;
		if (attempts === 1) { started(); throw undefined; }
		return gate.then(() => remove(...args));
	};
	let settled = false;
	const pending = runStoreAdapterDifferentialContract(candidate, { modelName: 'parity_sync_cleanup', reference })
		.then(() => ({ rejected: false, error: undefined }), error => ({ rejected: true, error }))
		.finally(() => { settled = true; });
	try {
		await cleanupStarted;
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(attempts, candidate.stats.create);
		assert.equal(settled, false, 'Other cleanup work must finish before rejection.');
	} finally { release(); }
	const outcome = await pending;
	assert.equal(outcome.rejected, true);
	assert.ok(outcome.error instanceof AggregateError);
	assert.deepEqual(outcome.error.errors, [undefined]);
	assert.equal(reference.dump('parity_sync_cleanup').length, 0);
	assert.equal(candidate.dump('parity_sync_cleanup').length, 1);
});

test('Differential cleanup preserves primary and falsy synchronous cleanup failures', async () => {
	const candidate = new MemoryStoreAdapter();
	const reference = new MemoryStoreAdapter();
	const primary = new Error('primary parity failure');
	candidate.query = async () => { throw primary; };
	const remove = candidate.delete.bind(candidate);
	let attempts = 0;
	candidate.delete = (...args) => {
		attempts++;
		if (attempts === 1) throw false;
		return remove(...args);
	};
	await assert.rejects(runStoreAdapterDifferentialContract(candidate, { modelName: 'parity_primary_cleanup', reference }), error => {
		assert.ok(error instanceof AggregateError);
		assert.equal(error.errors.length, 2);
		assert.equal(error.errors[0].cause, primary);
		assert.equal(error.errors[1], false);
		return true;
	});
	assert.equal(attempts, candidate.stats.create);
	assert.equal(reference.dump('parity_primary_cleanup').length, 0);
	assert.equal(candidate.dump('parity_primary_cleanup').length, 1);
});
