import test from 'node:test';
import assert from 'node:assert/strict';
import { captureLazyLoadWarnings, expectNoLazyLoadWarnings, createTestContext } from '../src/testing/index.js';

const lazy = 'active-ts lazy relation "record:child" was loaded without include(). Add include("child") to batch it explicitly.';

test('lazy-load capture forwards unrelated warnings with their original arguments', async () => {
	const original = console.warn;
	const forwarded: unknown[][] = [];
	console.warn = (...args: unknown[]) => { forwarded.push(args); };
	try {
		const detail = { app: 'warning' };
		const captured = await captureLazyLoadWarnings(() => {
			console.warn('application warning', detail);
			console.warn(lazy);
			return 42;
		});
		assert.equal(captured.result, 42);
		assert.deepEqual(captured.warnings, [lazy]);
		assert.deepEqual(forwarded, [['application warning', detail]]);
		assert.equal(forwarded[0][1], detail);
		await expectNoLazyLoadWarnings(() => console.warn('another application warning'));
		await assert.rejects(() => expectNoLazyLoadWarnings(() => console.warn(lazy)), assert.AssertionError);
	} finally { console.warn = original; }
});

for (const mode of ['capture', 'throw'] as const) {
	test(`test context ${mode} mode applies only to lazy-load warnings`, () => {
		const original = console.warn;
		const forwarded: unknown[][] = [];
		console.warn = (...args: unknown[]) => { forwarded.push(args); };
		const context = createTestContext({ lazyLoadWarnings: mode });
		try {
			context.install();
			assert.doesNotThrow(() => console.warn('application warning', 42));
			assert.deepEqual(context.warnings, []);
			assert.deepEqual(forwarded, [['application warning', 42]]);
			if (mode === 'throw') assert.throws(() => console.warn(lazy), /lazy relation/);
			else console.warn(lazy);
			assert.deepEqual(context.warnings, [lazy]);
		} finally { context.restore(); console.warn = original; }
	});
}
