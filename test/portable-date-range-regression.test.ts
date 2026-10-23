import test from 'node:test';
import assert from 'node:assert/strict';
import { Model, defineModel, createActiveTs, MemoryStoreAdapter, cursorValues } from '../src/index.js';

class PortableDateRow extends Model<{ id: number; at: Date }> {}
defineModel('portable_date_range').id('id').fieldType('at', 'date').attach(PortableDateRow);

test('typed portable dates reject extended UTC years on writes, predicates and reads', async () => {
	for (const iso of ['-000001-12-31T23:59:59.999Z', '+010000-01-01T00:00:00.000Z']) {
		const store = new MemoryStoreAdapter();
		const Row = PortableDateRow.use(createActiveTs({ stores: { default: store } }));
		for (const value of [new Date(iso), iso]) {
			await assert.rejects(() => Row.create({ id: 1, at: value as Date }), /UTC years 0000 through 9999/);
		}
		assert.throws(() => Row.query().where('at', '>', new Date(iso)), /UTC years 0000 through 9999/);
		await assert.rejects(() => Row.query().where('at', '>', iso).load(), /UTC years 0000 through 9999/);
		await store.seed('portable_date_range', [{ id: 1, at: iso }]);
		await assert.rejects(() => Row.find(1).load(), /UTC years 0000 through 9999/);
	}
});

test('supported date boundaries retain chronological range, order and aggregate behavior', async () => {
	const Row = PortableDateRow.use(createActiveTs({ stores: { default: new MemoryStoreAdapter() } }));
	const lower = new Date('0000-01-01T00:00:00.000Z');
	const upper = new Date('9999-12-31T23:59:59.999Z');
	await Row.create({ id: 1, at: lower });
	await Row.create({ id: 2, at: upper });
	assert.deepEqual((await Row.query().orderBy('at').load()).list.map((row) => row.id), [1, 2]);
	assert.deepEqual((await Row.query().where('at', '>', lower).load()).list.map((row) => row.id), [2]);
	assert.equal((await Row.min('at'))?.getTime(), lower.getTime());
	assert.equal((await Row.max('at'))?.getTime(), upper.getTime());
});

test('Date cursor helpers reject extended years instead of returning misleading text ordering', () => {
	assert.throws(
		() => cursorValues({ at: new Date('+010000-01-01T00:00:00.000Z') }, [{ field: 'at', direction: 'asc' }]),
		/UTC years 0000 through 9999/
	);
});
