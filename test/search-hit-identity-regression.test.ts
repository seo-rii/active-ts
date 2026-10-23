import test from 'node:test';
import assert from 'node:assert/strict';
import { createActiveTs, defineModel, MemoryStoreAdapter, Model } from '../src/index.js';
import { createAlgoliaSearchAdapter } from '../src/adapters/search/algolia.js';
import { createElasticsearchSearchAdapter } from '../src/adapters/search/elasticsearch.js';
import { createOpenSearchSearchAdapter } from '../src/adapters/search/opensearch.js';

class Row extends Model<{ id: number | string }> {}
defineModel('hit_identity_row').id('id').attach(Row);
const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
const meta = context.meta(Row);

for (const backend of ['algolia', 'elasticsearch', 'opensearch'] as const) {
	test(`${backend} validates the canonical physical identity even when the payload includes its id`, async () => {
		let hit: any;
		const adapter = backend === 'algolia'
			? await createAlgoliaSearchAdapter({ client: {
				async searchSingleIndex() { return { hits: [hit], page: 0, nbPages: 1, nbHits: 1 }; },
				async saveObject() {}, async deleteObject() {}
			} })
			: await (backend === 'elasticsearch' ? createElasticsearchSearchAdapter : createOpenSearchSearchAdapter)({ client: {
				async search() {
					const response = { hits: { hits: [hit], total: 1 } };
					return backend === 'opensearch' ? { body: response } : response;
				}, async index() {}, async delete() {}
			} });
		const setHit = (key: unknown, id: unknown) => {
			const row = id === undefined ? {} : { id };
			hit = backend === 'algolia' ? { ...row, objectID: key } : { _source: row, _id: key };
		};
		const key = (value: string) => backend === 'algolia' ? `hit_identity_row:${value}` : value;
		const search = () => adapter.search(meta, '', { native: backend === 'algolia' ? {} : { query: { match_all: {} } } });
		for (const physical of [key('number:2'), key('string:1'), key('number:01'), undefined, 'foreign:number:1']) {
			setHit(physical, 1);
			await assert.rejects(search());
		}
		for (const [physical, id] of [[key('number:1'), 1], [key('string:1'), '1'], [key('number:1'), undefined]] as const) {
			setHit(physical, id);
			assert.deepEqual((await search()).list, [{ id: id ?? 1 }]);
		}
	});
}
