import test from 'node:test';
import assert from 'node:assert/strict';
import { MemorySearchAdapter } from '../src/adapters/search/memory.js';
import type { ResolvedModelMeta } from '../src/core/types.js';

test('memory search rejects explicit invalid model scopes without clearing data or revisions', async () => {
	const model = { model: class {}, name: 'scope_one', store: 'memory', idField: 'id', readValidation: 'off', indexes: [],
		searchIndexes: [{ name: 'text', fields: ['title'] }], relations: new Map(), hooks: {}, views: new Map(),
		policies: new Map(), scopes: new Map(), fieldCodecs: new Map(), fieldTypes: new Map() } as ResolvedModelMeta;
	const second = { ...model, name: 'scope_two' };
	const search = new MemorySearchAdapter();
	await search.index(model, 1, { id: 1, title: 'one' }, { revision: 5 });
	await search.index(second, 2, { id: 2, title: 'two' });
	for (const name of ['', null, false, 0]) {
		assert.throws(() => search.clear(name as string));
		assert.throws(() => search.snapshot(name as string));
	}
	await search.index(model, 1, { id: 1, title: 'stale' }, { revision: 4 });
	assert.deepEqual(search.snapshot(model.name), [{ id: 1, title: 'one' }]);
	assert.deepEqual(Object.keys(search.snapshot()), ['scope_one', 'scope_two']);
	search.clear(model.name);
	assert.deepEqual(search.snapshot(model.name), []);
	assert.deepEqual(search.snapshot(second.name), [{ id: 2, title: 'two' }]);
	search.clear(undefined);
	assert.deepEqual(search.snapshot(), {});
});
