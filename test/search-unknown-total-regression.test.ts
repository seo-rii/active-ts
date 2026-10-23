import test from 'node:test';
import assert from 'node:assert/strict';
import { createActiveTs, defineModel, MemoryStoreAdapter, Model } from '../src/index.js';
import { createElasticsearchSearchAdapter } from '../src/adapters/search/elasticsearch.js';
import { createOpenSearchSearchAdapter } from '../src/adapters/search/opensearch.js';

class Row extends Model<{ id: number }> {}
defineModel('unknown_total_row').id('id').attach(Row);
const meta = createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(Row);

for (const backend of ['elasticsearch', 'opensearch'] as const) {
	test(`${backend} keeps continuation unknown when total tracking is disabled`, async () => {
		let hits: any[] = [{ _id: 'number:1', _source: { id: 1 } }];
		const client = {
			async search() {
				const body = { hits: { hits } };
				return backend === 'opensearch' ? { body } : body;
			},
			async index() {},
			async delete() {}
		};
		const adapter = backend === 'elasticsearch'
			? await createElasticsearchSearchAdapter({ client })
			: await createOpenSearchSearchAdapter({ client });
		for (const pagination of [{}, { from: 20 }, { search_after: [1] }]) {
			const options = { native: { query: { match_all: {} }, track_total_hits: false, ...pagination } };
			hits = [{ _id: 'number:1', _source: { id: 1 } }];
			const result = await adapter.search(meta, '', options);
			assert.equal(result.count, 1);
			assert.equal(result.total, undefined);
			assert.equal(Object.hasOwn(result, 'more'), false);
			hits = [];
			assert.equal((await adapter.search(meta, '', options)).more, false);
		}
	});
}
