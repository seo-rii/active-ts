import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStoreAdapter, type QueryPlan, type ResolvedModelMeta } from '../src/index.js';
import { createSqliteStoreAdapter } from '../src/adapters/store/sqlite.js';

const model: ResolvedModelMeta = {
	model: class {}, name: 'lossless_sqlite_prefix', store: 'default', idField: 'id', readValidation: 'off',
	indexes: [], searchIndexes: [], relations: new Map(), hooks: {}, views: new Map(),
	policies: new Map(), scopes: new Map(), fieldCodecs: new Map(), fieldTypes: new Map()
};

test('SQLite prefixes preserve UTF-16 strings across the native text boundary', async (t) => {
	const sqlite = await createSqliteStoreAdapter();
	t.after(() => sqlite.close());
	const memory = new MemoryStoreAdapter();
	await sqlite.schema!.apply([model], { mode: 'safe' });
	const values = ['\ud800', '\ud801', '\udc00', '\ufffd', '\u{10000}', 'a\0z', 'a', '', '한글', 'a"\\z', null, 1, ['a'], {}];
	for (const [index, value] of values.entries()) {
		const row = { id: index + 1, value, nested: { value } };
		await sqlite.create(model, row.id, row);
		await memory.create(model, row.id, row);
		assert.deepEqual(await sqlite.get(model, row.id), row);
	}
	await sqlite.create(model, 99, { id: 99 });
	await memory.create(model, 99, { id: 99 });
	for (const field of ['value', 'nested.value']) {
		for (const prefix of ['\ud800', '\ud801', '\udc00', '\ufffd', '\u{10000}', 'a\0', 'a', '', '한', 'a"\\']) {
			const plan: QueryPlan = {
				where: [{ field, op: 'startsWith', value: prefix }], or: [],
				sort: [{ field: 'id', direction: 'asc' }], include: []
			};
			const actual = await sqlite.query(model, plan);
			const expected = await memory.query(model, plan);
			assert.deepEqual(actual.list, expected.list, JSON.stringify({ field, prefix }));
			assert.equal(actual.count, expected.count);
			assert.equal(actual.more, expected.more);
		}
	}
});
