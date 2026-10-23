import test from 'node:test';
import assert from 'node:assert/strict';
import { createActiveTs, defineModel, MemoryStoreAdapter, Model } from '../src/index.js';

class Versioned extends Model<{ id: number; value: string; version?: number }> {}
defineModel('persisted_version_record').id('id').attach(Versioned);

for (const operation of ['save', 'delete'] as const) {
	for (const mutation of ['removed', undefined, null, '2', 2]) {
		test(`${operation} preserves loaded version provenance after ${String(mutation)}`, async () => {
			const store = new MemoryStoreAdapter();
			const context = createActiveTs({ stores: { default: store } });
			const Record = Versioned.use(context);
			const winner = await Record.create({ id: 1, value: 'original', version: 1 });
			const stale = (await Record.find(1).load())!;
			winner.data.value = 'winner';
			await winner.save();
			if (mutation === 'removed') delete stale.data.version;
			else (stale.data as Record<string, unknown>).version = mutation;
			stale.data.value = 'stale';
			await assert.rejects(() => stale[operation](), /Cannot change persisted version field/);
			assert.deepEqual(store.dump('persisted_version_record'), [{ id: 1, value: 'winner', version: 2 }]);
		});
	}
}

test('successful saves advance the remembered version and stale unchanged versions still conflict', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const Record = Versioned.use(context);
	const row = await Record.create({ id: 1, value: 'original', version: 1 });
	const stale = (await Record.find(1).load())!;
	await row.save();
	await row.save();
	assert.equal(row.data.version, 3);
	await assert.rejects(() => stale.save(), /Optimistic lock failed/);
	await row.delete();
	assert.equal(await Record.find(1).load(), null);
});

test('static updates cannot remove the version and unversioned models remain writable', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const Record = Versioned.use(context);
	await Record.create({ id: 1, value: 'versioned', version: 1 });
	await Record.update(1, { version: undefined }); // Undefined patch fields are intentionally omitted.
	assert.equal((await Record.find(1).load())!.data.version, 2);
	await assert.rejects(() => Record.update(1, { version: null as any }), /Cannot change persisted version field/);
	assert.equal((await Record.find(1).load())!.data.version, 2);
	const ordinary = await Record.create({ id: 2, value: 'ordinary' });
	ordinary.data.value = 'updated';
	await ordinary.save();
	await ordinary.delete();
});

test('transaction saves retain version provenance when models are rebound after commit', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const Record = Versioned.use(context);
	await Record.create({ id: 1, value: 'original', version: 1 });
	const committed = await context.transaction(async tx => {
		const row = (await Versioned.use(tx).find(1).load())!;
		await row.save();
		await row.save();
		return row;
	});
	await committed.save();
	assert.equal(committed.data.version, 4);
	delete committed.data.version;
	await assert.rejects(() => committed.delete(), /Cannot change persisted version field/);
});
