import test from 'node:test';
import assert from 'node:assert/strict';
import { createMeilisearchSearchAdapter } from '../src/adapters/search/meilisearch.js';
import type { ResolvedModelMeta } from '../src/core/types.js';

test('Meilisearch cursor binds index, query, limit and native options before transport', async () => {
	const model = { model: class {}, name: 'cursor_doc', store: 'memory', idField: 'id', readValidation: 'off', indexes: [],
		searchIndexes: [{ name: 'text', fields: ['title'] }], relations: new Map(), hooks: {}, views: new Map(),
		policies: new Map(), scopes: new Map(), fieldCodecs: new Map(), fieldTypes: new Map() } as ResolvedModelMeta;
	let calls = 0;
	const client = { async getRawIndex() { throw new Error('unused'); }, index() { return {
		async addDocuments() {}, async deleteDocument() {}, async search(_query: string, options: any) {
			calls++;
			const start = (options.page - 1) * options.hitsPerPage;
			return { page: options.page, hitsPerPage: options.hitsPerPage, totalPages: 10,
				hits: Array.from({ length: options.hitsPerPage }, (_, index) => ({ id: start + index, title: 'match',
					active_ts_id: Buffer.from(JSON.stringify([model.name, `number:${start + index}`])).toString('base64url') })) };
		}
	}; } };
	const adapter = await createMeilisearchSearchAdapter({ client });
	const first = await adapter.search(model, 'match', { limit: 2, native: { filter: 'active = true' } });
	const options = { limit: 2, cursor: first.cursor, native: { filter: 'active = true' } };
	assert.deepEqual((await adapter.search(model, 'match', options)).list.map(row => row.id), [2, 3]);
	for (const [nextModel, query, nextOptions] of [
		[model, 'match', { ...options, limit: 10 }], [model, 'different', options],
		[{ ...model, name: 'other' }, 'match', options], [model, 'match', { ...options, native: { filter: 'active = false' } }]
	] as const) await assert.rejects(adapter.search(nextModel, query, nextOptions), /different search/);
	assert.equal(calls, 2);
});
