import test from 'node:test';
import assert from 'node:assert/strict';
import { getCurrentDefaultContext } from '../src/index.js';
import { ActiveTestContext, createTestContext, getCurrentTestContext, withTestContext } from '../src/testing/index.js';

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}

test('independent callbacks cannot overlap a global installation of the same context', async () => {
	const context = createTestContext();
	const previous = getCurrentDefaultContext(), warn = console.warn;
	const entered = deferred(), release = deferred();
	const first = withTestContext(context, async () => { entered.resolve(); await release.promise; });
	await entered.promise;
	let secondRan = false;
	try {
		await assert.rejects(withTestContext(context, async () => { secondRan = true; }), /cannot overlap/);
		assert.equal(secondRan, false);
		assert.equal(getCurrentDefaultContext(), context.context);
		assert.equal(ActiveTestContext.hasInstalledContext(context), true);
		console.warn('first remains installed');
	} finally {
		release.resolve();
		await first;
	}
	assert.deepEqual(context.warnings, ['first remains installed']);
	assert.equal(getCurrentDefaultContext(), previous);
	assert.equal(console.warn, warn);
	assert.equal(ActiveTestContext.hasInstalledContext(), false);
});

test('an install:false helper context cannot impersonate the active installation owner', async () => {
	const context = createTestContext({ lazyLoadWarnings: 'off' });
	const entered = deferred(), release = deferred();
	const first = withTestContext(context, async () => { entered.resolve(); await release.promise; });
	await entered.promise;
	try {
		await withTestContext(context, async () => {
			assert.equal(getCurrentTestContext(), context);
			await assert.rejects(withTestContext(context, async () => {}), /cannot overlap/);
		}, { install: false });
		assert.equal(getCurrentDefaultContext(), context.context);
	} finally {
		release.resolve();
		await first;
	}
});

test('nested callbacks keep their shared global installation until the last callback finishes', async () => {
	const context = createTestContext();
	const previous = getCurrentDefaultContext(), warn = console.warn;
	const entered = deferred(), release = deferred();
	let nested: Promise<void> | undefined;
	try {
		await withTestContext(context, async () => {
			nested = withTestContext(context, async () => {
				entered.resolve();
				await release.promise;
				assert.equal(getCurrentDefaultContext(), context.context);
				console.warn('nested remains installed');
			});
			await entered.promise;
		});
		assert.equal(getCurrentDefaultContext(), context.context);
		assert.equal(ActiveTestContext.hasInstalledContext(context), true);
	} finally {
		release.resolve();
		await nested;
	}
	assert.deepEqual(context.warnings, ['nested remains installed']);
	assert.equal(getCurrentDefaultContext(), previous);
	assert.equal(console.warn, warn);
	assert.equal(ActiveTestContext.hasInstalledContext(), false);
});

test('independent install:false callbacks may still share the same helper context', async () => {
	const context = createTestContext();
	const previous = getCurrentDefaultContext(), warn = console.warn;
	const entered = deferred(), release = deferred();
	const first = withTestContext(context, async () => {
		entered.resolve(); await release.promise;
		assert.equal(getCurrentTestContext(), context);
	}, { install: false });
	await entered.promise;
	try {
		await withTestContext(context, async () => {
			assert.equal(getCurrentTestContext(), context);
			assert.equal(getCurrentDefaultContext(), previous);
		}, { install: false });
	} finally {
		release.resolve();
		await first;
	}
	assert.equal(getCurrentDefaultContext(), previous);
	assert.equal(console.warn, warn);
});
