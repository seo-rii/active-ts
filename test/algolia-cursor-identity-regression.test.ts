import test from 'node:test';
import assert from 'node:assert/strict';
import { createActiveTs, defineModel, MemoryStoreAdapter, Model } from '../src/index.js';
import { createAlgoliaSearchAdapter } from '../src/adapters/search/algolia.js';

class Row extends Model<{ id: number; title: string }> {}
defineModel('algolia_cursor_row').id('id').search('algolia', ['title']).attach(Row);
const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
const meta = context.meta(Row);

test('Algolia cursor follows the same search and rejects changed query identity before transport', async () => {
	const requests: any[] = [];
	const client = {
		async searchSingleIndex(request: any) {
			requests.push(request);
			const page = request.searchParams.page ?? 0;
			return { hits: [], page, nbPages: 3, nbHits: 0 };
		},
		async saveObject() {},
		async deleteObject() {}
	};
	const adapter = await createAlgoliaSearchAdapter({ client });
	const options = { limit: 2, native: { filters: 'published:true', optionalFilters: ['tag:a', 'tag:b'] } };
	const first = await adapter.search(meta, 'first', options);
	assert.equal(typeof first.cursor, 'string');
	assert.notEqual(first.cursor, '1');
	const second = await adapter.search(meta, 'first', {
		...options, cursor: first.cursor,
		native: { optionalFilters: ['tag:a', 'tag:b'], filters: 'published:true' }
	});
	assert.equal(requests[1].searchParams.page, 1);
	assert.notEqual(second.cursor, first.cursor);
	const count = requests.length;
	for (const [query, changed] of [
		['second', options],
		['first', { ...options, limit: 3 }],
		['first', { ...options, native: { filters: 'published:false' } }],
		['first', { ...options, native: { filters: 'published:true', optionalFilters: ['tag:b', 'tag:a'] } }]
	] as const) {
		await assert.rejects(adapter.search(meta, query, { ...changed, cursor: first.cursor }), /Algolia cursor/);
	}
	await assert.rejects(adapter.search({ ...meta, name: 'another_model' }, 'first', { ...options, cursor: first.cursor }), /Algolia cursor/);
	await assert.rejects(adapter.search({ ...meta, idField: 'otherId' }, 'first', { ...options, cursor: first.cursor }), /Algolia cursor/);
	const otherIndex = await createAlgoliaSearchAdapter({ client, indexPrefix: 'other_' });
	await assert.rejects(otherIndex.search(meta, 'first', { ...options, cursor: first.cursor }), /Algolia cursor/);
	for (const cursor of ['1', '-1', 'bad!', Buffer.from('{"v":1}').toString('base64url')]) {
		await assert.rejects(adapter.search(meta, 'first', { ...options, cursor }), /Algolia cursor/);
	}
	assert.equal(requests.length, count);
});
