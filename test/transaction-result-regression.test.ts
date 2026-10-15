import test from 'node:test';
import assert from 'node:assert/strict';
import {
	ActiveTsCommittedTransactionError,
	ActiveTsConfigurationError,
	ActiveTsRolledBackTransactionError,
	ActiveTsUnknownTransactionOutcomeError,
	MemoryStoreAdapter,
	Model,
	createActiveTs,
	defineModel,
	type ActiveContext,
	type StoreAdapter,
	type StoreTransactionOptions,
	type TransactionResult
} from '../src/index.js';
import { createDatastoreStoreAdapter } from '../src/adapters/store/datastore.js';
import { createFirestoreStoreAdapter } from '../src/adapters/store/firestore.js';
import { createMongoStoreAdapter } from '../src/adapters/store/mongodb.js';

type RecordData = { id: number; value: string };
class ResultRecord extends Model<RecordData> {}
defineModel<RecordData>('transaction_result_record')
	.id('id')
	.validate((input) => input as RecordData)
	.attach(ResultRecord);

class FinalizationErrorStore extends MemoryStoreAdapter {
	constructor(private readonly failure: unknown, private readonly committed: boolean) { super(); }
	override async transaction<T>(fn: (tx: StoreAdapter) => Promise<T>, options?: StoreTransactionOptions): Promise<T> {
		const result = await super.transaction(fn, options);
		if (this.committed) throw new ActiveTsCommittedTransactionError('cleanup failed', this.failure, result);
		throw this.failure;
	}
}

function errorOf<T>(result: TransactionResult<T>): unknown {
	assert.ok('error' in result);
	return result.error;
}

test('transactionResult returns the committed callback value and persists writes', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const result = await context.transactionResult(async (tx) => {
		await ResultRecord.create({ id: 1, value: 'stored' }, tx);
		return { receipt: 'operation-1' };
	});
	assert.deepEqual(result, { outcome: 'committed', result: { receipt: 'operation-1' } });
	assert.equal((await ResultRecord.use(context).find(1).load())?.data.value, 'stored');
});

test('confirmed rollback preserves arbitrary callback errors without trusting their shape', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const failures = [
		Object.freeze(new Error('callback failed')),
		new ActiveTsCommittedTransactionError('user supplied committed error', null, 'fake result'),
		new ActiveTsUnknownTransactionOutcomeError('user supplied unknown error', 'commit', null),
		new ActiveTsRolledBackTransactionError('user supplied rollback error', null),
		{ committed: true, outcome: 'committed' },
		undefined,
		'failure'
	];
	for (const failure of failures) {
		const result = await context.transactionResult(async (tx) => {
			await ResultRecord.create({ id: 2, value: 'rolled back' }, tx);
			throw failure;
		});
		assert.equal(result.outcome, 'not_committed');
		assert.equal(errorOf(result), failure);
		assert.equal(await ResultRecord.use(context).find(2).load(), null);
	}
});

test('preflight errors have no commit and do not execute the callback', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	let calls = 0;
	const result = await context.transactionResult(async () => { calls++; }, { store: 'missing' });
	assert.equal(result.outcome, 'not_committed');
	assert.ok(errorOf(result) instanceof ActiveTsConfigurationError);
	assert.equal(calls, 0);
});

test('afterCommit failures retain the committed result and never rerun the transaction', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	let calls = 0;
	const previousWarn = console.warn;
	console.warn = () => {};
	try {
		const result = await context.transactionResult(async (tx) => {
			calls++;
			await ResultRecord.create({ id: 3, value: 'committed' }, tx);
			await tx.afterCommit(() => { throw new Error('delivery unavailable'); });
			return 'receipt-3';
		});
		assert.equal(result.outcome, 'committed');
		if (result.outcome !== 'committed') assert.fail('expected a committed result');
		assert.equal(result.result, 'receipt-3');
		assert.ok(result.error instanceof ActiveTsCommittedTransactionError);
		assert.equal(calls, 1);
		assert.equal((await ResultRecord.use(context).find(3).load())?.data.value, 'committed');
	} finally {
		console.warn = previousWarn;
	}
});

test('adapter commit evidence preserves result even when finalization rejects', async () => {
	const failure = new Error('connection release failed');
	const context = createActiveTs({ stores: { default: new FinalizationErrorStore(failure, true) } });
	const result = await context.transactionResult(async () => 42);
	assert.equal(result.outcome, 'committed');
	if (result.outcome !== 'committed') assert.fail('expected a committed result');
	assert.equal(result.result, 42);
	assert.ok(result.error instanceof ActiveTsCommittedTransactionError);
	assert.equal(result.error.cause, failure);
});

test('ordinary adapter errors and nested causes cannot establish rollback or commit', async () => {
	const failure = Object.freeze(new Error('acknowledgement lost', {
		cause: new ActiveTsCommittedTransactionError('unrelated nested error', null, 'fake')
	}));
	const context = createActiveTs({ stores: { default: new FinalizationErrorStore(failure, false) } });
	const result = await context.transactionResult(async (tx) => {
		await ResultRecord.create({ id: 4, value: 'actually committed' }, tx);
		return 4;
	});
	assert.equal(result.outcome, 'unknown');
	assert.equal(errorOf(result), failure);
	assert.equal((await ResultRecord.use(context).find(4).load())?.data.value, 'actually committed');
});

test('unconfirmed errors suppress rollback-only effects in both transaction APIs', async () => {
	for (const captureResult of [false, true]) {
		const failure = new Error('commit acknowledgement lost');
		const context = createActiveTs({ stores: { default: new FinalizationErrorStore(failure, false) } });
		const effects: string[] = [];
		const callback = async (tx: ActiveContext) => {
			await ResultRecord.create({ id: 5, value: 'committed before transport failure' }, tx);
			await tx.afterRollback(() => { effects.push('compensation'); });
			await tx.afterCommit(() => { effects.push('delivery'); });
		};
		if (captureResult) {
			const result = await context.transactionResult(callback);
			assert.equal(result.outcome, 'unknown');
			assert.equal(errorOf(result), failure);
		} else {
			await assert.rejects(context.transaction(callback), (error) => error === failure);
		}
		assert.equal((await ResultRecord.use(context).find(5).load())?.data.value, 'committed before transport failure');
		assert.deepEqual(effects, []);
	}
});

test('custom adapters can explicitly confirm rollback while preserving the original cause', async () => {
	class ExplicitRollbackStore extends MemoryStoreAdapter {
		override async transaction<T>(fn: (tx: StoreAdapter) => Promise<T>): Promise<T> {
			try {
				// The decorator deliberately uses a distinct callback, so the public
				// error contract supplies its rollback evidence to the context.
				return await super.transaction(async (tx) => fn(tx));
			} catch (cause) {
				throw new ActiveTsRolledBackTransactionError('rollback acknowledged', cause);
			}
		}
	}
	const context = createActiveTs({ stores: { default: new ExplicitRollbackStore() } });
	const failure = Object.freeze(new Error('original callback failure'));
	const effects: string[] = [];
	const result = await context.transactionResult(async (tx) => {
		await ResultRecord.create({ id: 6, value: 'rolled back' }, tx);
		await tx.afterRollback(() => { effects.push('rollback'); });
		throw failure;
	});
	assert.equal(result.outcome, 'not_committed');
	const error = errorOf(result);
	assert.ok(error instanceof ActiveTsRolledBackTransactionError);
	assert.equal(error.outcome, 'not_committed');
	assert.equal(error.cause, failure);
	assert.equal(await ResultRecord.use(context).find(6).load(), null);
	assert.deepEqual(effects, ['rollback']);
});

test('callback-thrown rollback errors cannot forge adapter outcome evidence', async () => {
	class UnconfirmedStore extends MemoryStoreAdapter {
		override async transaction<T>(fn: (tx: StoreAdapter) => Promise<T>): Promise<T> {
			return fn(this);
		}
	}
	const context = createActiveTs({ stores: { default: new UnconfirmedStore() } });
	const failure = new ActiveTsRolledBackTransactionError('untrusted callback claim', null);
	const effects: string[] = [];
	const result = await context.transactionResult(async (tx) => {
		await ResultRecord.create({ id: 7, value: 'persisted despite callback error' }, tx);
		await tx.afterRollback(() => { effects.push('rollback'); });
		throw failure;
	});
	assert.equal(result.outcome, 'unknown');
	assert.equal(errorOf(result), failure);
	assert.equal((await ResultRecord.use(context).find(7).load())?.data.value, 'persisted despite callback error');
	assert.deepEqual(effects, []);
});

test('first-party callback rollback evidence preserves rollback tasks and arbitrary thrown values', async () => {
	const firestore = await createFirestoreStoreAdapter({ client: {
		collection: () => ({}),
		getAll: async () => [],
		runTransaction: async (run: (tx: unknown) => Promise<unknown>) => run({
			get: async () => undefined,
			create: () => {},
			set: () => {},
			delete: () => {}
		})
	} });
	const mongoCalls: string[] = [];
	const mongo = await createMongoStoreAdapter({ dbName: 'test', client: {
		db: () => ({ collection: () => ({}) }),
		startSession: () => ({
			startTransaction: () => {},
			commitTransaction: async () => { mongoCalls.push('commit'); },
			abortTransaction: async () => { mongoCalls.push('abort'); },
			endSession: async () => {}
		})
	} });
	const datastore = await datastoreContext();
	for (const context of [
		createActiveTs({ stores: { default: new MemoryStoreAdapter() } }),
		createActiveTs({ stores: { default: firestore } }),
		createActiveTs({ stores: { default: mongo } }),
		datastore.context
	]) {
		for (const failure of [Object.freeze(new Error('callback rollback')), undefined, NaN]) {
			const effects: string[] = [];
			const result = await context.transactionResult(async (tx) => {
				await tx.afterRollback(() => { effects.push('rollback'); });
				await tx.afterCommit(() => { effects.push('commit'); });
				throw failure;
			});
			assert.equal(result.outcome, 'not_committed');
			assert.ok(Object.is(errorOf(result), failure));
			assert.deepEqual(effects, ['rollback']);
		}
	}
	assert.deepEqual(mongoCalls, ['abort', 'abort', 'abort']);
});

test('outcomes belong to an invocation even when concurrent operations reuse an error', async () => {
	const failure = Object.freeze(new Error('shared error'));
	const uncertain = createActiveTs({ stores: { default: new FinalizationErrorStore(failure, false) } });
	const rolledBack = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	for (let iteration = 0; iteration < 2; iteration++) {
		const results = await Promise.all([
			uncertain.transactionResult(async () => 'value'),
			rolledBack.transactionResult(async () => { throw failure; })
		]);
		assert.deepEqual(results.map((result) => result.outcome), ['unknown', 'not_committed']);
		for (const result of results) assert.equal(errorOf(result), failure);
	}
});

test('nested transactionResult rejects independent commit claims, including ambient root use', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	let callbacks = 0;
	const outer = await context.transactionResult(async (tx) => {
		for (const inner of [tx, context]) {
			const result = await inner.transactionResult(async () => { callbacks++; }, { join: 'reuse' });
			assert.equal(result.outcome, 'not_committed');
			assert.match(String(errorOf(result)), /requires a root transaction/);
		}
		return 'outer';
	});
	assert.deepEqual(outer, { outcome: 'committed', result: 'outer' });
	assert.equal(callbacks, 0);
});

async function datastoreContext(commitError?: unknown, rollbackError?: unknown) {
	const calls: string[] = [];
	const methods = {
		get: async () => [undefined],
		delete: async () => {},
		createQuery: () => ({}),
		runQuery: async () => [[], {}],
		insert: async () => {},
		update: async () => {}
	};
	const store = await createDatastoreStoreAdapter({ client: {
		...methods,
		key: (path: unknown) => ({ path }),
		transaction: () => ({
			...methods,
			run: async () => { calls.push('run'); },
			commit: async () => { calls.push('commit'); if (commitError !== undefined) throw commitError; },
			rollback: async () => { calls.push('rollback'); if (rollbackError !== undefined) throw rollbackError; }
		})
	} });
	return { context: createActiveTs({ stores: { default: store } }), calls };
}

test('Datastore confirmed rollback and definite commit rejection report not_committed', async () => {
	const failure = new Error('callback failure');
	const rolledBack = await datastoreContext();
	const result = await rolledBack.context.transactionResult(async () => { throw failure; });
	assert.equal(result.outcome, 'not_committed');
	assert.equal(errorOf(result), failure);
	assert.deepEqual(rolledBack.calls, ['run', 'rollback']);
	for (const code of [3, 10]) {
		const rejected = await datastoreContext(Object.assign(new Error('commit rejected'), { code }));
		const result = await rejected.context.transactionResult(async () => 'value');
		assert.equal(result.outcome, 'not_committed');
		assert.deepEqual(rejected.calls, ['run', 'commit']);
	}
});

test('Datastore missing commit acknowledgement or failed rollback report unknown', async () => {
	const failure = Object.assign(new Error('response lost'), { code: 4 });
	const uncertainCommit = await datastoreContext(failure);
	const committed = await uncertainCommit.context.transactionResult(async () => 'value');
	assert.equal(committed.outcome, 'unknown');
	assert.equal(errorOf(committed), failure);
	assert.deepEqual(uncertainCommit.calls, ['run', 'commit']);
	const uncertainRollback = await datastoreContext(undefined, failure);
	const aborted = await uncertainRollback.context.transactionResult(async () => { throw new Error('callback'); });
	assert.equal(aborted.outcome, 'unknown');
	assert.ok(errorOf(aborted) instanceof AggregateError);
	assert.deepEqual(uncertainRollback.calls, ['run', 'rollback']);
});

test('transaction still rejects with the original callback error', async () => {
	const failure = new Error('unchanged error contract');
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	await assert.rejects(context.transaction(async () => { throw failure; }), (error) => error === failure);
});
