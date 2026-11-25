import test from 'node:test';
import assert from 'node:assert/strict';
import { Model, defineModel, createActiveTs, MemoryStoreAdapter } from '../src/index.js';
import { createSqliteStoreAdapter } from '../src/adapters/store/sqlite.js';

class UnicodeRecord extends Model<{ id: string; value: string }> {}
defineModel('unicode_entity_record').id('id').attach(UnicodeRecord);

test('entity APIs reject unpaired surrogates before reading or writing', async () => {
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	const Record = UnicodeRecord.use(context);
	for (const id of ['\ud800', '\ud801', '\udfff', 'prefix\ud800suffix']) {
		await assert.rejects(() => Record.find(id).load(), /well-formed Unicode/);
		await assert.rejects(() => Record.create({ id, value: 'invalid' }), /well-formed Unicode/);
	}
	assert.equal(store.stats.getMany, 0);
});

test('SQLite malformed IDs cannot alias or delete the replacement-character row', async (t) => {
	const store = await createSqliteStoreAdapter();
	t.after(() => store.close());
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(UnicodeRecord);
	await store.schema!.apply([meta], { mode: 'safe' });
	await store.create(meta, '\ufffd', { id: '\ufffd', value: 'replacement' });
	for (const id of ['\ud800', '\ud801', '\udfff']) {
		await assert.rejects(() => store.delete(meta, id), /well-formed Unicode/);
		await assert.rejects(() => store.create(meta, id, { id, value: 'invalid' }), /well-formed Unicode/);
		await assert.rejects(() => store.get(meta, id), /well-formed Unicode/);
	}
	assert.equal((await store.get(meta, '\ufffd'))?.value, 'replacement');
	await store.create(meta, '\ud800\udc00', { id: '\ud800\udc00', value: 'valid pair' });
	assert.equal((await store.get(meta, '\ud800\udc00'))?.value, 'valid pair');
});
