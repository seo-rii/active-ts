import test from 'node:test';
import assert from 'node:assert/strict';
import { createActiveTs, defineModel, MemoryStoreAdapter, Model } from '../src/index.js';
import { createElasticsearchSearchAdapter } from '../src/adapters/search/elasticsearch.js';
import { createOpenSearchSearchAdapter } from '../src/adapters/search/opensearch.js';

class Row extends Model<{ id: number }> {}
defineModel('search_completeness_row').id('id').attach(Row);
const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
const meta = context.meta(Row);

for (const backend of ['elasticsearch', 'opensearch'] as const) {
	test(`${backend} refuses partial search results and requests complete responses`, async () => {
		let response: any;
		const requests: any[] = [];
		const client = {
			async search(request: any) {
				requests.push(request);
				return backend === 'opensearch' ? { body: response } : response;
			},
			async index() {},
			async delete() {}
		};
		const adapter = backend === 'elasticsearch'
			? await createElasticsearchSearchAdapter({ client })
			: await createOpenSearchSearchAdapter({ client });
		const search = () => adapter.search(meta, '', { native: { query: { match_all: {} } } });
		for (const health of [
			{ timed_out: true },
			{ timed_out: false, _shards: { failed: 1, total: 2, successful: 1 } },
			{ timed_out: 'false' },
			{ _shards: { failed: -1 } },
			{ _shards: {} }
		]) {
			response = { ...health, hits: { hits: [], total: 0 } };
			await assert.rejects(search, /timed out|failed shards|must be/);
			assert.equal(requests.at(-1).allow_partial_search_results, false);
		}
		response = { timed_out: false, _shards: { failed: 0, total: 2, successful: 2 }, hits: { hits: [], total: 0 } };
		assert.deepEqual((await search()).list, []);
		let getterCalls = 0;
		response._shards = { get failed() { getterCalls++; return 0; } };
		await assert.rejects(search, /must be a data property/);
		assert.equal(getterCalls, 0);
	});
}
