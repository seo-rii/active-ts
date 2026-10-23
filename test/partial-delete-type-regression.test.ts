import test from 'node:test';
import assert from 'node:assert/strict';
import { Model, defineModel, createActiveTs, MemoryStoreAdapter } from '../src/index.js';

type RowData = { id: number; label: string; secret: string };
class PartialDeleteRow extends Model<RowData> {}
defineModel<RowData>('partial_delete_type').id('id').attach(PartialDeleteRow);

async function partialDeleteTypes() {
	const first = await PartialDeleteRow.query().select('label').first();
	if (first) {
		// @ts-expect-error partial projections cannot be deleted as full instances
		await first.delete();
	}
	const projected = await PartialDeleteRow.query().select('label').load();
	// @ts-expect-error list projections also block delete
	await projected.list[0].delete();
	const hits = await PartialDeleteRow.search('label').load();
	// @ts-expect-error partial search hits cannot be deleted as full instances
	await hits.list[0].delete();
	const full = await PartialDeleteRow.find(1).load();
	if (full) await full.delete();
}
void partialDeleteTypes;

test('partial delete rejection leaves stored data intact while full instances can delete', async () => {
	const Row = PartialDeleteRow.use(createActiveTs({ stores: { default: new MemoryStoreAdapter() } }));
	await Row.create({ id: 1, label: 'visible', secret: 'retained' });
	const partial = await Row.query().select('label').first();
	assert.ok(partial);
	await assert.rejects(() => (partial as unknown as PartialDeleteRow).delete(), /Cannot delete on partial/);
	const full = await Row.find(1).load();
	assert.equal(full?.data.secret, 'retained');
	await full!.delete();
	assert.equal(await Row.find(1).load(), null);
});
