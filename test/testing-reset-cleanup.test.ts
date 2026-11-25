import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext } from '../src/testing/index.js';

test('failed reset waits for pending cleanup before settling', async () => {
	const context = createTestContext();
	const failure = new Error('reset failed');
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	let cleared = false;
	(context.store as any).reset = async () => { throw failure; };
	(context.cache as any).clear = async () => { await gate; cleared = true; };
	let settled = false;
	const pending = context.reset();
	void pending.then(() => { settled = true; }, () => { settled = true; });
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(settled, false);
	release();
	await assert.rejects(pending, error => error === failure);
	assert.equal(cleared, true);
});

test('synchronous cleanup failure does not skip other adapters', async () => {
	const context = createTestContext();
	const failure = new Error('sync reset failed');
	const events: string[] = [];
	(context.store as any).reset = () => { events.push('store'); throw failure; };
	(context.cache as any).clear = () => { events.push('cache'); };
	(context.search as any).clear = () => { events.push('search'); };
	const pending = context.reset();
	assert.deepEqual(events, ['store', 'cache', 'search']);
	await assert.rejects(pending, error => error === failure);
});

test('reset aggregates every cleanup failure including undefined', async () => {
	const context = createTestContext();
	const cacheFailure = new Error('cache failed');
	(context.store as any).reset = async () => { throw undefined; };
	(context.cache as any).clear = () => { throw cacheFailure; };
	(context.search as any).clear = async () => { throw 0; };
	await assert.rejects(context.reset(), (error: unknown) => {
		assert.ok(error instanceof AggregateError);
		assert.deepEqual(error.errors, [undefined, cacheFailure, 0]);
		return true;
	});
});
