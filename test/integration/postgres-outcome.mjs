import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
	ActiveTsCommittedTransactionError,
	ActiveTsUnknownTransactionOutcomeError,
	MemoryCacheAdapter,
	Model,
	createActiveTs,
	defineModel
} from '../../build/src/index.js';
import { createPostgresStoreAdapter } from '../../build/src/adapters/store/postgresql.js';

// The backend runner owns the isolated schema and pool. Faults are injected only
// AFTER the real server replies, so an independent connection can prove state.
export async function runPostgresOutcomeContract({ pool, schema }) {
	assert.match(schema, /^active_ts_smoke_[a-f0-9]+$/);
	const modelName = `postgres_outcome_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
	class Record extends Model {}
	defineModel({ name: modelName, cache: { ttl: 60 } })
		.id('id').validate(value => value).attach(Record);
	const store = await createPostgresStoreAdapter({ pool, schema });
	const setup = createActiveTs({ stores: { default: store } });
	await store.schema.apply([setup.meta(Record)], { mode: 'safe' });
	// Keep this connection checked out before any writer starts. Inspection never
	// reads ORM/cache state and cannot accidentally reuse the writer's connection.
	const inspector = await pool.connect();
	const persisted = async id => (await inspector.query(
		`select data from "${schema}"."${modelName}" where id = $1`, [`number:${id}`]
	)).rows[0]?.data ?? null;
	let cases = 0;
	try {
		async function fixture(faultAt, cache = new MemoryCacheAdapter()) {
			const fault = Object.freeze(new Error(`injected ${faultAt} acknowledgement failure`));
			const released = [];
			const adapter = await createPostgresStoreAdapter({ schema, pool: {
				query: (...args) => pool.query(...args),
				connect: async () => {
					const client = await pool.connect();
					return {
						query: async (...args) => {
							const result = await client.query(...args);
							if (args[0] === faultAt) throw fault;
							return result;
						},
						release: error => {
							released.push(error);
							client.release(error);
							if (faultAt === 'release') throw fault;
						}
					};
				}
			} });
			const context = createActiveTs({ stores: { default: adapter }, caches: { default: cache } });
			const hooks = [];
			const write = async (id, failCallback) => context.transaction(async tx => {
				await tx.afterCommit(() => { hooks.push('commit'); });
				await tx.afterRollback(() => { hooks.push('rollback'); });
				await Record.use(tx).create({ id, value: `value-${id}` });
				if (failCallback) throw failCallback;
				return { id };
			});
			return { context, fault, released, hooks, write };
		}

		const confirmed = await fixture();
		assert.deepEqual(await confirmed.write(1), { id: 1 });
		assert.deepEqual(await persisted(1), { id: 1, value: 'value-1' });
		assert.deepEqual(confirmed.hooks, ['commit']);
		cases++;

		for (const [id, reason] of [
			[2, new Error('application callback failed')],
			[3, new ActiveTsCommittedTransactionError('caller-created committed class', null, 'untrusted result')]
		]) {
			const rolledBack = await fixture();
			await assert.rejects(() => rolledBack.write(id, reason), error => error === reason);
			assert.equal(await persisted(id), null);
			assert.deepEqual(rolledBack.hooks, ['rollback']);
			cases++;
		}

		const lostCommit = await fixture('commit');
		await assert.rejects(() => lostCommit.write(4), error => {
			assert.ok(error instanceof ActiveTsUnknownTransactionOutcomeError);
			assert.equal(error.outcome, 'unknown');
			assert.equal(error.phase, 'commit');
			assert.equal(error.cause, lostCommit.fault);
			assert.equal(lostCommit.released[0], error);
			return true;
		});
		assert.deepEqual(await persisted(4), { id: 4, value: 'value-4' });
		assert.deepEqual(lostCommit.hooks, []);
		cases++;

		const lostRollback = await fixture('rollback');
		const callbackError = new Error('rollback request');
		await assert.rejects(() => lostRollback.write(5, callbackError), error => {
			assert.ok(error instanceof ActiveTsUnknownTransactionOutcomeError);
			assert.equal(error.outcome, 'unknown');
			assert.equal(error.phase, 'abort');
			assert.ok(error.cause instanceof AggregateError);
			assert.deepEqual(error.cause.errors, [callbackError, lostRollback.fault]);
			assert.equal(lostRollback.released[0], error);
			return true;
		});
		assert.equal(await persisted(5), null);
		assert.deepEqual(lostRollback.hooks, []);
		cases++;

		const releaseFailure = await fixture('release');
		await assert.rejects(() => releaseFailure.write(6), error => {
			assert.ok(error instanceof ActiveTsCommittedTransactionError);
			assert.deepEqual(error.result, { id: 6 });
			assert.equal(error.cause, releaseFailure.fault);
			return true;
		});
		assert.deepEqual(await persisted(6), { id: 6, value: 'value-6' });
		assert.deepEqual(releaseFailure.hooks, ['commit']);
		cases++;

		const afterCommit = await fixture();
		const effectError = new Error('application afterCommit failed');
		await assert.rejects(() => afterCommit.context.transaction(async tx => {
			await Record.use(tx).create({ id: 7, value: 'value-7' });
			await tx.afterCommit(() => { throw effectError; });
			await tx.afterCommit(() => { afterCommit.hooks.push('later-commit'); });
			await tx.afterRollback(() => { afterCommit.hooks.push('rollback'); });
			return { id: 7 };
		}), error => {
			assert.ok(error instanceof ActiveTsCommittedTransactionError);
			assert.deepEqual(error.result, { id: 7 });
			assert.ok(error.cause instanceof AggregateError);
			assert.ok(error.cause.errors.includes(effectError));
			return true;
		});
		assert.deepEqual(await persisted(7), { id: 7, value: 'value-7' });
		assert.deepEqual(afterCommit.hooks, ['later-commit']);
		cases++;

		const cacheError = new Error('post-commit cache invalidation failed');
		class FailingCache extends MemoryCacheAdapter {
			async deleteMany() { throw cacheError; }
		}
		const cacheFailure = await fixture(undefined, new FailingCache());
		await store.create(setup.meta(Record), 8, { id: 8, value: 'before' });
		assert.equal((await Record.use(cacheFailure.context).find(8).load()).data.value, 'before');
		await assert.rejects(() => cacheFailure.context.transaction(async tx => {
			const record = await Record.use(tx).find(8).load();
			record.data.value = 'after';
			await record.save();
			await tx.afterCommit(() => { cacheFailure.hooks.push('commit'); });
			await tx.afterRollback(() => { cacheFailure.hooks.push('rollback'); });
			return { id: 8 };
		}), error => {
			assert.ok(error instanceof ActiveTsCommittedTransactionError);
			assert.deepEqual(error.result, { id: 8 });
			assert.ok(error.cause instanceof AggregateError);
			assert.ok(error.cause.errors.includes(cacheError));
			return true;
		});
		assert.deepEqual(await persisted(8), { id: 8, value: 'after' });
		assert.deepEqual(cacheFailure.hooks, ['commit']);
		cases++;
	} finally {
		inspector.release();
	}
	assert.equal(cases, 8);
	console.log(`PostgreSQL outcome contracts passed: ${cases} cases (real server, injected acknowledgement faults).`);
}
