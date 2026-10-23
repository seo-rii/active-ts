import test from 'node:test';
import assert from 'node:assert/strict';
import { Model, defineModel, createActiveTs, MemoryStoreAdapter } from '../src/index.js';

type RowData = { id: number; value: string; details: { label: string } };
class SnapshotRow extends Model<RowData> {}
defineModel<RowData>('query_find_patch_snapshot').id('id').validate((value) => value as RowData).attach(SnapshotRow);

test('query find update snapshots nested patch data before asynchronous query hooks', async () => {
	let release!: () => void;
	let entered!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const ready = new Promise<void>((resolve) => { entered = resolve; });
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({
		stores: { default: store },
		plugins: [{ name: 'patch-snapshot-gate', hooks: { async beforeQuery() { entered(); await gate; } } }]
	});
	const Row = SnapshotRow.use(context);
	await Row.create({ id: 1, value: 'before', details: { label: 'before' } });
	const patch = { value: 'intended', details: { label: 'intended nested value' } };
	const pending = Row.query().find(1).update(patch);
	await ready;
	patch.value = 'changed after call';
	patch.details.label = 'changed after call';
	release();
	const updated = await pending;
	assert.equal(updated?.data.value, 'intended');
	assert.equal(updated?.data.details.label, 'intended nested value');
	assert.deepEqual((await Row.find(1).load())?.data, {
		id: 1, value: 'intended', details: { label: 'intended nested value' }
	});
});
