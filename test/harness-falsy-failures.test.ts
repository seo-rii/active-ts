import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStoreAdapter } from '../src/index.js';
import { createIntegrationHarness } from '../src/testing/index.js';

const reasons = [undefined, null, false, 0, ''];
const contractMethods = ['runStoreContract', 'runCacheContract', 'runSearchContract'] as const;

async function rejection(promise: Promise<unknown>) {
	return await promise.then(
		() => ({ failed: false, reason: undefined as unknown }),
		(reason: unknown) => ({ failed: true, reason })
	);
}

test('integration contexts preserve every falsy callback rejection', async () => {
	for (const reason of reasons) {
		let stops = 0;
		const harness = createIntegrationHarness({
			name: 'falsy-callback',
			createStore: () => new MemoryStoreAdapter(),
			stop: () => { stops++; }
		});
		const outcome = await rejection(harness.withContext(async () => { throw reason; }, { install: false }));
		assert.equal(outcome.failed, true);
		assert.equal(outcome.reason, reason);
		assert.equal(stops, 1);
	}
});

test('integration contracts fail when startup rejects with a falsy value', async () => {
	for (const method of contractMethods) {
		for (const reason of reasons) {
			let factories = 0;
			let stops = 0;
			const harness = createIntegrationHarness({
				name: 'falsy-startup',
				start: () => { throw reason; },
				createStore: () => { factories++; return new MemoryStoreAdapter(); },
				stop: () => { stops++; }
			});
			const outcome = await rejection(harness[method]());
			assert.equal(outcome.failed, true, method);
			assert.equal(outcome.reason, reason);
			assert.equal(factories, 0);
			assert.equal(stops, 1);
		}
	}
});

test('context cleanup preserves a falsy primary failure alongside cleanup failure', async () => {
	for (const reason of reasons) {
		const cleanup = new Error('cleanup failed');
		const harness = createIntegrationHarness({
			name: 'falsy-and-cleanup',
			createStore: () => new MemoryStoreAdapter(),
			stop: () => { throw cleanup; }
		});
		const outcome = await rejection(harness.withContext(async () => { throw reason; }, { install: false }));
		assert.ok(outcome.reason instanceof AggregateError);
		assert.deepEqual(outcome.reason.errors, [reason, cleanup]);
	}
});

test('contract cleanup preserves falsy failures alongside the primary failure', async () => {
	for (const method of contractMethods) {
		for (const reason of reasons) {
			const primary = new Error('startup failed');
			const harness = createIntegrationHarness({
				name: 'contract-and-falsy-cleanup',
				start: () => { throw primary; },
				createStore: () => new MemoryStoreAdapter(),
				stop: () => { throw reason; }
			});
			const outcome = await rejection(harness[method]());
			assert.ok(outcome.reason instanceof AggregateError);
			assert.deepEqual(outcome.reason.errors, [primary, reason]);
		}
	}
});
