import test from 'node:test';
import assert from 'node:assert/strict';
import { getCurrentDefaultContext } from '../src/index.js';
import { createTestContext, withTestContext, ActiveTestContext } from '../src/testing/index.js';

test('nested use of the same testing context keeps outer globals installed', async () => {
	const context = createTestContext();
	const previous = getCurrentDefaultContext();
	const originalWarn = console.warn;
	await withTestContext(context, async () => {
		await withTestContext(context, async () => {
			assert.equal(getCurrentDefaultContext(), context.context);
		});
		assert.equal(getCurrentDefaultContext(), context.context);
		assert.equal(ActiveTestContext.hasInstalledContext(context), true);
		console.warn('outer warning after nested context');
		await assert.rejects(withTestContext(context, async () => { throw new Error('nested failure'); }), /nested failure/);
		assert.equal(getCurrentDefaultContext(), context.context);
		console.warn('outer warning after nested failure');
	});
	assert.deepEqual(context.warnings, ['outer warning after nested context', 'outer warning after nested failure']);
	assert.equal(getCurrentDefaultContext(), previous);
	assert.equal(console.warn, originalWarn);
	assert.equal(ActiveTestContext.hasInstalledContext(), false);
});

test('withTestContext preserves a caller-owned manual installation', async () => {
	const context = createTestContext().install();
	try {
		await withTestContext(context, async () => {});
		assert.equal(getCurrentDefaultContext(), context.context);
		assert.equal(ActiveTestContext.hasInstalledContext(context), true);
	} finally {
		context.restore();
	}
});
