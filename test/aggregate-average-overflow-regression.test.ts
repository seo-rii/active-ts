import test from 'node:test';
import assert from 'node:assert/strict';
import { Model, defineModel, createActiveTs, MemoryStoreAdapter, aggregateRows } from '../src/index.js';

type RowData = { id: number; value: number | null };
class AverageRow extends Model<RowData> {}
defineModel<RowData>('finite_average_overflow').id('id').fieldType('value', 'number').attach(AverageRow);

test('public averages remain finite when summing finite values would overflow', async () => {
	const Row = AverageRow.use(createActiveTs({ stores: { default: new MemoryStoreAdapter() } }));
	await Row.create({ id: 1, value: 1e308 });
	await Row.create({ id: 2, value: 1e308 });
	await Row.create({ id: 3, value: null });
	assert.equal(await Row.avg('value'), 1e308);
});

test('portable averages handle both signs, extreme differences, tiny values and empty inputs', () => {
	for (const [values, expected] of [
		[[1e308, 1e308], 1e308],
		[[-1e308, -1e308], -1e308],
		[[Number.MAX_VALUE, Number.MAX_VALUE], Number.MAX_VALUE],
		[Array(10_000).fill(Number.MAX_VALUE), Number.MAX_VALUE],
		[Array(10_000).fill(-Number.MAX_VALUE), -Number.MAX_VALUE],
		[[Number.MAX_VALUE, -Number.MAX_VALUE], 0],
		[[Number.MAX_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE, -Number.MAX_VALUE], 0],
		[[Number.MIN_VALUE, Number.MIN_VALUE], Number.MIN_VALUE],
		[[0, 0], 0],
		[[1, 2, 3], 2],
		[[20, 30], 25],
		[[1, 49], 25],
		[[], null]
	] as Array<[number[], number | null]>) {
		assert.equal(aggregateRows(values.map((value) => ({ value })), [{ op: 'avg', field: 'value', as: 'avg' }]).avg, expected);
	}
});
