import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import {
	ActiveTsConfigurationError,
	ActiveTsExecutionBudgetError,
	ActiveTsUnknownTransactionOutcomeError,
	assertContextBoundStoreAdapter,
	createActiveTs,
	createExecutionBudget,
	createStoreExecutionBudgetAdapter,
	defineModel,
	MemoryStoreAdapter,
	Model,
	type StoreAdapter
} from '../src/index.js';

type BudgetData = { id: number; value: string };
class BudgetRecord extends Model<BudgetData> {}
defineModel<BudgetData>('execution_budget_record')
	.id('id')
	.validate((input) => input as BudgetData)
	.attach(BudgetRecord);

function metadata() {
	return createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(BudgetRecord);
}

function aborted(error: unknown): boolean {
	assert.ok(error instanceof ActiveTsExecutionBudgetError);
	assert.equal(error.reason, 'aborted');
	return true;
}

test('execution budgets validate options without invoking accessors', () => {
	assert.throws(() => createExecutionBudget({ deadline: NaN }), ActiveTsConfigurationError);
	assert.throws(() => createExecutionBudget({ deadline: Number.MAX_SAFE_INTEGER + 1 }), ActiveTsConfigurationError);
	assert.throws(() => createExecutionBudget({ signal: {} as AbortSignal }), ActiveTsConfigurationError);
	let accessed = false;
	assert.throws(() => createExecutionBudget({ get deadline() { accessed = true; return 1; } }), ActiveTsConfigurationError);
	assert.equal(accessed, false);
});

test('run exposes the original signal and remaining absolute budget to a provider bridge', async () => {
	const controller = new AbortController();
	const deadline = Date.now() + 60_000;
	const budget = createExecutionBudget({ signal: controller.signal, deadline });
	assert.equal(await budget.run(async (state) => {
		assert.equal(state.signal, controller.signal);
		assert.equal(state.deadline, deadline);
		assert.ok(state.remainingMs! > 0 && state.remainingMs! <= 60_000);
		assert.equal(Object.isFrozen(state), true);
		return 'provider result';
	}), 'provider result');
});

test('expired budgets reject dispatch and an excessive backoff never starts another attempt', async () => {
	let attempts = 0;
	await assert.rejects(() => createExecutionBudget({ deadline: Date.now() - 1 }).run(async () => ++attempts), {
		reason: 'deadline', phase: 'before-dispatch'
	});
	const budget = createExecutionBudget({ deadline: Date.now() + 60_000 });
	await assert.rejects(async () => {
		await budget.backoff(60_001);
		await budget.run(async () => ++attempts);
	}, { reason: 'deadline', phase: 'backoff' });
	assert.equal(attempts, 0);
	await assert.rejects(() => budget.backoff(-1), ActiveTsConfigurationError);
});

test('abort interrupts backoff and removes its listener', async () => {
	const controller = new AbortController();
	const budget = createExecutionBudget({ signal: controller.signal });
	const reason = new Error('request cancelled');
	const waiting = budget.backoff(60_000);
	assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
	controller.abort(reason);
	await assert.rejects(() => waiting, (error: unknown) => {
		aborted(error);
		assert.equal((error as ActiveTsExecutionBudgetError).phase, 'backoff');
		assert.equal((error as ActiveTsExecutionBudgetError).cause, reason);
		return true;
	});
	assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
	await assert.rejects(() => budget.run(async () => assert.fail('cannot retry')), aborted);
});

test('store budget rejects writes before the required middleware leaf is dispatched', async () => {
	const source = new MemoryStoreAdapter({ cacheScope: 'budget-isolation' });
	const controller = new AbortController();
	const store = createStoreExecutionBudgetAdapter(source, createExecutionBudget({ signal: controller.signal }));
	const meta = metadata();
	assert.equal(store.cacheScope, source.cacheScope);
	assert.deepEqual(store.capabilities, source.capabilities);
	await store.create(meta, 1, { id: 1, value: 'original' });
	controller.abort();
	await assert.rejects(() => store.create(meta, 2, { id: 2, value: 'blocked' }), aborted);
	await assert.rejects(() => store.update(meta, 1, { id: 1, value: 'blocked' }), aborted);
	await assert.rejects(() => store.delete(meta, 1), aborted);
	await assert.rejects(() => store.get(meta, 1), aborted);
	assert.deepEqual(await source.get(meta, 1), { id: 1, value: 'original' });
	assert.equal(await source.get(meta, 2), null);
});

test('budget integration prevents model writes through a request-local context', async () => {
	const controller = new AbortController();
	const source = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: {
		default: createStoreExecutionBudgetAdapter(source, createExecutionBudget({ signal: controller.signal }))
	} });
	const Record = BudgetRecord.use(context);
	controller.abort();
	await assert.rejects(() => Record.create({ id: 1, value: 'blocked' }), aborted);
	assert.equal(await source.get(context.meta(BudgetRecord), 1), null);
});

test('an abort during an in-flight write preserves confirmed success and rejects subsequent dispatches', async () => {
	const source = new MemoryStoreAdapter();
	const controller = new AbortController();
	const create = source.create.bind(source);
	source.create = async (...args) => {
		controller.abort();
		await create(...args);
	};
	const store = createStoreExecutionBudgetAdapter(source, createExecutionBudget({ signal: controller.signal }));
	const meta = metadata();
	await store.create(meta, 1, { id: 1, value: 'committed' });
	assert.deepEqual(await source.get(meta, 1), { id: 1, value: 'committed' });
	await assert.rejects(() => store.get(meta, 1), aborted);
});

test('provider commit uncertainty is preserved even if the request aborts', async () => {
	const source = new MemoryStoreAdapter();
	const controller = new AbortController();
	const unknown = new ActiveTsUnknownTransactionOutcomeError('lost commit response', 'commit', new Error('transport'));
	source.transaction = async () => {
		controller.abort();
		throw unknown;
	};
	const store = createStoreExecutionBudgetAdapter(source, createExecutionBudget({ signal: controller.signal }));
	await assert.rejects(() => store.transaction!(async () => undefined), (error) => error === unknown);
});

test('aborting a transaction callback prevents commit and keeps a retained transaction closed', async () => {
	const source = new MemoryStoreAdapter();
	const controller = new AbortController();
	const store = createStoreExecutionBudgetAdapter(source, createExecutionBudget({ signal: controller.signal }));
	const meta = metadata();
	let retained: StoreAdapter | undefined;
	await assert.rejects(() => store.transaction!(async (tx) => {
		retained = tx;
		await tx.create(meta, 1, { id: 1, value: 'must rollback' });
		controller.abort();
		return 'never committed';
	}), aborted);
	assert.equal(await source.get(meta, 1), null);
	await assert.rejects(() => retained!.get(meta, 1), /closed/);
});

test('every provider transaction callback attempt checks the same request budget', async () => {
	const source = new MemoryStoreAdapter();
	const controller = new AbortController();
	let callbacks = 0;
	source.transaction = async (fn) => {
		await fn(source);
		controller.abort();
		return await fn(source);
	};
	const store = createStoreExecutionBudgetAdapter(source, createExecutionBudget({ signal: controller.signal }));
	await assert.rejects(() => store.transaction!(async () => { callbacks++; }), aborted);
	assert.equal(callbacks, 1);
});

test('commit that succeeds after callback completion is not replaced with a budget error', async () => {
	const source = new MemoryStoreAdapter();
	const controller = new AbortController();
	const transaction = source.transaction.bind(source);
	source.transaction = async (fn, options) => {
		const result = await transaction(fn, options);
		controller.abort();
		return result;
	};
	const store = createStoreExecutionBudgetAdapter(source, createExecutionBudget({ signal: controller.signal }));
	const meta = metadata();
	assert.equal(await store.transaction!(async (tx) => {
		await tx.create(meta, 1, { id: 1, value: 'committed' });
		return 'receipt';
	}), 'receipt');
	assert.deepEqual(await source.get(meta, 1), { id: 1, value: 'committed' });
});

test('budget wrappers preserve context-bound capabilities and transaction scope', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const store = createStoreExecutionBudgetAdapter(context.store('default'), createExecutionBudget());
	assert.equal(assertContextBoundStoreAdapter(store), store);
	assert.equal(store.capabilities?.transaction, true);
	await context.transaction(async () => {
		assert.equal(store.capabilities?.transaction, false);
		assert.equal(store.transaction, undefined);
	});
	assert.equal(store.capabilities?.transaction, true);
});

test('savepoint handles inherit the budget and abort rolls back their pending writes', async () => {
	const source = new MemoryStoreAdapter();
	const controller = new AbortController();
	const store = createStoreExecutionBudgetAdapter(source, createExecutionBudget({ signal: controller.signal }));
	const meta = metadata();
	await assert.rejects(() => store.transaction!(async (tx) => {
		await tx.savepoint!(async (nested) => {
			await nested.create(meta, 1, { id: 1, value: 'rolled back' });
			controller.abort();
		});
	}), aborted);
	assert.equal(await source.get(meta, 1), null);
});

test('completed backoff removes its abort listener', async () => {
	const controller = new AbortController();
	const budget = createExecutionBudget({ signal: controller.signal });
	await budget.backoff(1);
	assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
	assert.equal(await budget.run(async () => 'next attempt'), 'next attempt');
});
