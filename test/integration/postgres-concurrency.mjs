import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
	ActiveTsConflictError,
	ActiveTsUnknownTransactionOutcomeError,
	MemoryCacheAdapter,
	Model,
	createActiveTs,
	defineModel
} from '../../build/src/index.js';
import { createPostgresStoreAdapter } from '../../build/src/adapters/store/postgresql.js';

function barrier() {
	let release;
	const promise = new Promise(resolve => { release = resolve; });
	return { promise, release };
}

function settle(promise) {
	return promise.then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }));
}

async function reached(gate, task) {
	await Promise.race([gate.promise, task.then(outcome => {
		if (outcome.status === 'rejected') throw outcome.reason;
		throw new Error('Transaction settled before reaching its test barrier.');
	})]);
}

export async function runPostgresConcurrencyContract({ pool, schema }) {
	assert.match(schema, /^active_ts_smoke_[a-f0-9]+$/);
	const modelName = `postgres_concurrency_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
	class Record extends Model {}
	defineModel({ name: modelName, cache: { ttl: 60 } })
		.id('id').validate(value => value).attach(Record);
	const cacheScope = targetSchema => `postgres-concurrency:${targetSchema}`;
	const store = await createPostgresStoreAdapter({ pool, schema, cacheScope: cacheScope(schema) });
	const setup = createActiveTs({ stores: { default: store } });
	const meta = setup.meta(Record);
	await store.schema.apply([meta], { mode: 'safe' });
	const inspector = await pool.connect();
	const persisted = async (id, targetSchema = schema) => (await inspector.query(
		`select data from "${targetSchema}"."${modelName}" where id = $1`, [`number:${id}`]
	)).rows[0]?.data ?? null;
	let tenantSchema;
	let tenantSchemaCreated = false;
	let cases = 0;
	try {
		async function context({ cache = new MemoryCacheAdapter(), targetSchema = schema, targetPool = pool } = {}) {
			const adapter = await createPostgresStoreAdapter({
				pool: targetPool, schema: targetSchema, cacheScope: cacheScope(targetSchema)
			});
			return createActiveTs({ stores: { default: adapter }, caches: { default: cache } });
		}

		// Both callbacks read 0. The second writer commits before the first applies
		// its old value; barriers make this schedule independent of machine speed.
		for (const [id, isolation, versioned] of [
			[1, 'readCommitted', false],
			[2, 'readCommitted', true],
			[3, 'repeatableRead', false],
			[4, 'serializable', false]
		]) {
			await store.create(meta, id, { id, score: 0, ...(versioned ? { version: 0 } : {}) });
			const firstContext = await context(), secondContext = await context();
			const read = barrier(), resume = barrier();
			let firstCalls = 0, secondCalls = 0;
			const first = settle(firstContext.transaction(async tx => {
				firstCalls++;
				const record = await Record.use(tx).find(id).load();
				assert.equal(record.data.score, 0);
				read.release();
				await resume.promise;
				record.data.score++;
				await record.save();
			}, { isolation, timeoutMs: 5_000 }));
			try {
				await reached(read, first);
				await secondContext.transaction(async tx => {
					secondCalls++;
					const record = await Record.use(tx).find(id).load();
					assert.equal(record.data.score, 0);
					record.data.score++;
					await record.save();
				}, { isolation, timeoutMs: 5_000 });
			} finally {
				resume.release();
				await first;
			}
			const outcome = await first;
			assert.equal(firstCalls, 1, 'the adapter must not replay application callbacks');
			assert.equal(secondCalls, 1);
			if (versioned) {
				assert.equal(outcome.status, 'rejected');
				assert.ok(outcome.reason instanceof ActiveTsConflictError);
				assert.equal((await persisted(id)).version, 1);
			} else if (isolation === 'readCommitted') {
				assert.equal(store.capabilities.transactionConflictDetection, false);
				assert.equal(outcome.status, 'fulfilled', 'unversioned READ COMMITTED permits stale overwrites');
			} else {
				assert.equal(outcome.status, 'rejected');
				assert.equal(outcome.reason.code, '40001', 'PostgreSQL serialization failure must reach the caller');
			}
			assert.equal((await persisted(id)).score, 1);
			cases++;
		}

		// A fresh statement can see another connection's commit in READ COMMITTED;
		// REPEATABLE READ keeps its initial snapshot. ORM caches must not replace it.
		for (const [id, isolation, expected] of [
			[101, 'readCommitted', 1], [102, 'repeatableRead', 0]
		]) {
			await store.create(meta, id, { id, score: 0 });
			const root = await context(), read = barrier(), resume = barrier();
			const reader = settle(root.transaction(async tx => {
				assert.equal((await Record.use(tx).find(id).load()).data.score, 0);
				read.release();
				await resume.promise;
				assert.equal((await Record.use(tx).find(id).load()).data.score, expected);
			}, { isolation, readOnly: true, timeoutMs: 5_000 }));
			try {
				await reached(read, reader);
				await store.update(meta, id, { id, score: 1 });
			} finally {
				resume.release();
				await reader;
			}
			const outcome = await reader;
			if (outcome.status === 'rejected') throw outcome.reason;
			assert.equal((await persisted(id)).score, 1);
			cases++;
		}

		const lockId = 103;
		await store.create(meta, lockId, { id: lockId, score: 0 });
		const lockOwner = await context(), waiter = await context();
		const locked = barrier(), unlock = barrier();
		const lockingPlan = {
			where: [], or: [], sort: [], include: [],
			native: { payload: {
				text: `select data from "${schema}"."${modelName}" where id = $1 for update`,
				values: [`number:${lockId}`]
			} }
		};
		const owner = settle(lockOwner.transaction(async tx => {
			assert.equal((await tx.store('default').query(meta, lockingPlan)).list.length, 1);
			locked.release();
			await unlock.promise;
		}, { timeoutMs: 5_000 }));
		try {
			await reached(locked, owner);
			await assert.rejects(() => waiter.transaction(
				async tx => { await tx.store('default').query(meta, lockingPlan); },
				{ timeoutMs: 100 }
			), error => error.code === '57014');
		} finally {
			unlock.release();
			await owner;
		}
		const ownerOutcome = await owner;
		if (ownerOutcome.status === 'rejected') throw ownerOutcome.reason;
		assert.equal((await persisted(lockId)).score, 0);
		cases++;

		const lifetime = await context(), written = barrier(), commit = barrier();
		let retained;
		const writing = settle(lifetime.transaction(async tx => {
			retained = tx;
			const record = await Record.use(tx).create({ id: 201, score: 1 });
			written.release();
			await commit.promise;
			return record;
		}));
		try {
			await reached(written, writing);
			assert.equal(await persisted(201), null, 'another connection cannot read uncommitted data');
		} finally {
			commit.release();
			await writing;
		}
		const committed = await writing;
		if (committed.status === 'rejected') throw committed.reason;
		assert.equal((await persisted(201)).score, 1);
		assert.throws(() => retained.store('default'), /closed transaction context after it committed/);
		committed.value.data.score = 2;
		await committed.value.save();
		assert.equal((await persisted(201)).score, 2, 'returned model is rebound to the root context');
		cases++;

		let rolledBackModel, rollbackContext;
		const reason = new Error('intentional lifetime rollback');
		await assert.rejects(() => lifetime.transaction(async tx => {
			rollbackContext = tx;
			rolledBackModel = await Record.use(tx).create({ id: 202, score: 1 });
			throw reason;
		}), error => error === reason);
		assert.throws(() => rollbackContext.store('default'), /closed transaction context after it rolled back/);
		await assert.rejects(() => rolledBackModel.save(), /closed transaction context after it rolled back/);
		assert.equal(await persisted(202), null);
		cases++;

		const unknown = await context({ targetPool: {
			query: (...args) => pool.query(...args),
			connect: async () => {
				const client = await pool.connect();
				return {
					query: async (...args) => {
						const result = await client.query(...args);
						if (args[0] === 'commit') throw new Error('injected lost commit acknowledgement');
						return result;
					},
					release: error => client.release(error)
				};
			}
		} });
		let unknownModel, unknownContext;
		await assert.rejects(() => unknown.transaction(async tx => {
			unknownContext = tx;
			unknownModel = await Record.use(tx).create({ id: 203, score: 1 });
		}), error => error instanceof ActiveTsUnknownTransactionOutcomeError && error.phase === 'commit');
		assert.throws(() => unknownContext.store('default'), /closed transaction context after it failed/);
		unknownModel.data.score = 999;
		await assert.rejects(() => unknownModel.save(), /closed transaction context after it failed/);
		assert.equal((await persisted(203)).score, 1);
		cases++;

		const cache = new MemoryCacheAdapter();
		const firstContext = await context({ cache }), secondContext = await context({ cache });
		await store.create(meta, 301, { id: 301, score: 0 });
		assert.equal((await Record.use(secondContext).find(301).load()).data.score, 0);
		await firstContext.transaction(async tx => {
			const record = await Record.use(tx).find(301).load();
			record.data.score = 1;
			await record.save();
		});
		assert.equal((await Record.use(secondContext).find(301).load()).data.score, 1);
		assert.equal((await persisted(301)).score, 1);
		// Raw external writes bypass ORM invalidation. Explicit invalidation is
		// required; a separate context alone is not a cross-process cache protocol.
		await store.update(meta, 301, { id: 301, score: 2 });
		assert.equal((await Record.use(secondContext).find(301).load()).data.score, 1);
		await secondContext.invalidateModelExternal(Record, 301);
		assert.equal((await Record.use(secondContext).find(301).load()).data.score, 2);
		cases++;

		tenantSchema = `active_ts_smoke_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
		await pool.query(`create schema "${tenantSchema}"`);
		tenantSchemaCreated = true;
		const otherTenant = await context({ cache, targetSchema: tenantSchema });
		await otherTenant.store('default').schema.apply([otherTenant.meta(Record)], { mode: 'safe' });
		await store.create(meta, 401, { id: 401, score: 1 });
		await otherTenant.store('default').create(otherTenant.meta(Record), 401, { id: 401, score: 9 });
		const [left, right] = await Promise.all([
			Record.use(firstContext).find(401).load(), Record.use(otherTenant).find(401).load()
		]);
		assert.equal(left.data.score, 1);
		assert.equal(right.data.score, 9);
		assert.equal((await persisted(401)).score, 1);
		assert.equal((await persisted(401, tenantSchema)).score, 9);
		cases++;
	} finally {
		inspector.release();
		if (tenantSchemaCreated) await pool.query(`drop schema "${tenantSchema}" cascade`);
	}
	assert.equal(cases, 12);
	console.log(`PostgreSQL concurrency contracts passed: ${cases} cases (independent connections, explicit barriers).`);
}
