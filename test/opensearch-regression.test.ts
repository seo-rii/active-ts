import test from 'node:test';
import assert from 'node:assert/strict';
import {
	ActiveTsConfigurationError,
	ActiveTsValidationError,
	datastoreKey,
	type ResolvedModelMeta
} from '../src/index.js';
import { createOpenSearchSearchAdapter } from '../src/adapters/search/opensearch.js';
import { createElasticsearchSearchAdapter } from '../src/adapters/search/elasticsearch.js';
import { searchHitDocumentIdentity } from '../src/core/search-utils.js';

function metadata(overrides: Partial<ResolvedModelMeta> = {}): ResolvedModelMeta {
	return {
		model: class {}, name: 'opensearch_record', store: 'default', idField: 'slug', readValidation: 'off',
		indexes: [], searchIndexes: [
			{ name: 'open_title', adapter: 'opensearch', fields: ['title', 'profile.name'] },
			{ name: 'elastic_secret', adapter: 'elasticsearch', fields: ['elasticOnly'] }
		],
		relations: new Map(), hooks: {}, views: new Map(), policies: new Map(), scopes: new Map(),
		fieldCodecs: new Map(), fieldTypes: new Map(), ...overrides
	};
}

function transportJson(value: unknown) {
	return JSON.parse(JSON.stringify(value));
}

function client(overrides: Record<string, any> = {}) {
	return {
		search: async (_request: any): Promise<any> => ({ body: { hits: { hits: [], total: { value: 0, relation: 'eq' } } } }),
		index: async (_request: any): Promise<any> => ({ body: { result: 'created' } }),
		delete: async (_request: any): Promise<any> => ({ body: { result: 'deleted' } }),
		...overrides
	};
}

test('OpenSearch uses its SDK body request and response shapes and selects its own declared fields', async () => {
	const requests: any[] = [];
	const adapter = await createOpenSearchSearchAdapter({ indexPrefix: 'test_', client: client({
		index: async (request: any) => { requests.push(transportJson(request)); return { body: { result: 'created' } }; },
		search: async (request: any) => {
			requests.push(transportJson(request));
			return { body: { hits: { total: { value: 1, relation: 'eq' }, hits: [{
				_id: 'number:1', _source: { slug: 1, title: 'needle', profile: { name: 'Ada', private: true }, elasticOnly: 'secret' }
			}] } }, statusCode: 200, headers: {}, meta: {} };
		}
	}) });
	assert.equal(adapter.kind, 'opensearch');
	assert.equal(adapter.searchIndexKind, 'opensearch');
	assert.equal(adapter.capabilities?.revisionWrites, true);
	await adapter.index(metadata(), 1, { slug: 1, title: 'needle', profile: { name: 'Ada', private: true }, elasticOnly: 'secret' });
	assert.deepEqual(requests[0], { index: 'test_opensearch_record', id: 'number:1', body: { slug: 1, title: 'needle', profile: { name: 'Ada' } } });
	const result = await adapter.search(metadata(), 'needle', { limit: 2 });
	assert.equal(requests[1].size, 2);
	assert.deepEqual(requests[1].body.query.multi_match.fields, ['title', 'profile.name']);
	assert.deepEqual(requests[1].body._source, ['slug', 'title', 'profile.name']);
	assert.deepEqual(result, { list: [{ slug: 1, title: 'needle', profile: { name: 'Ada' } }], count: 1, total: 1, more: false });
});

test('OpenSearch and Elasticsearch retain distinct SDK transports when factories share their implementation', async () => {
	const calls: any[] = [];
	const elastic = await createElasticsearchSearchAdapter({ client: client({
		index: async (request: any) => { calls.push(transportJson(request)); },
		search: async () => ({ hits: { hits: [], total: 0 } })
	}) });
	await elastic.index(metadata(), 1, { slug: 1, title: 'hidden', elasticOnly: 'elastic' });
	assert.equal(elastic.kind, 'elasticsearch');
	assert.deepEqual(calls, [{ index: 'opensearch_record', id: 'number:1', document: { slug: 1, elasticOnly: 'elastic' } }]);
	assert.equal((await elastic.search(metadata(), 'elastic', {})).count, 0);
});

test('OpenSearch body remapping preserves serialization isolation from inherited toJSON', async () => {
	const serialized: string[] = [];
	const adapter = await createOpenSearchSearchAdapter({ client: client({ index: async (request: any) => {
		serialized.push(JSON.stringify(request));
	} }) });
	const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
	let calls = 0;
	Object.defineProperty(Object.prototype, 'toJSON', { configurable: true, value() { calls++; throw new Error('inherited serializer'); } });
	try {
		await adapter.index(metadata(), 1, { slug: 1, title: 'needle', profile: { name: 'Ada' } }, { revision: 1 });
		await adapter.delete(metadata(), 1, { revision: 2 });
	} finally {
		if (previous) Object.defineProperty(Object.prototype, 'toJSON', previous);
		else delete (Object.prototype as any).toJSON;
	}
	assert.equal(calls, 0);
	assert.equal(serialized.length, 2);
	assert.deepEqual(JSON.parse(serialized[1]).body, { active_ts_deleted: true });
});

test('OpenSearch typed IDs remain distinct and missing source IDs decode from canonical document IDs', async () => {
	const indexed: any[] = [];
	const adapter = await createOpenSearchSearchAdapter({ client: client({
		index: async (request: any) => { indexed.push(transportJson(request)); },
		search: async () => ({ body: { hits: { hits: [
			{ _id: 'number:1', _source: { title: 'number' } },
			{ _id: 'string:1', _source: { title: 'string' } }
		], total: 2 } } })
	}) });
	await adapter.index(metadata(), 1, { slug: 1, title: 'number' });
	await adapter.index(metadata(), '1', { slug: '1', title: 'string' });
	assert.deepEqual(indexed.map((request) => request.id), ['number:1', 'string:1']);
	assert.deepEqual((await adapter.search(metadata(), 'one', {})).list, [{ slug: 1, title: 'number' }, { slug: '1', title: 'string' }]);
});

test('OpenSearch manual schema plans include only matching declarations and keep the backend identity', async () => {
	const adapter = await createOpenSearchSearchAdapter({ client: client({
		index: async () => assert.fail('manual schema planning cannot write'),
		search: async () => assert.fail('manual schema planning cannot search')
	}) });
	const plan = await adapter.schema!.plan([metadata()]);
	assert.equal(plan.adapter, 'opensearch');
	assert.equal(plan.status, 'manual');
	assert.match(plan.note!, /OpenSearch/);
	assert.deepEqual(plan.changes, [{ type: 'create-search-index', target: 'opensearch_record', name: 'open_title', fields: ['title', 'profile.name'] }]);
	assert.deepEqual(await adapter.schema!.apply([metadata()], { mode: 'safe' }), plan);
	assert.deepEqual(await adapter.syncSchema!([metadata()]), plan);
});

test('OpenSearch revision writes use external versions and delete tombstones instead of physical deletion', async () => {
	const calls: any[] = [];
	const adapter = await createOpenSearchSearchAdapter({ client: client({
		index: async (request: any) => { calls.push(transportJson(request)); },
		delete: async () => assert.fail('revision deletes must retain their fence')
	}) });
	await adapter.index(metadata(), 1, { slug: 1, title: 'current' }, { revision: 10 });
	await adapter.delete(metadata(), 1, { revision: 11 });
	assert.deepEqual(calls, [
		{ index: 'opensearch_record', id: 'number:1', version: 10, version_type: 'external', body: { slug: 1, title: 'current' } },
		{ index: 'opensearch_record', id: 'number:1', version: 11, version_type: 'external', body: { active_ts_deleted: true } }
	]);
});

test('OpenSearch ignores only authentic stale-version conflicts on revision writes', async () => {
	for (const type of ['version_conflict_engine_exception', 'unrelated_conflict_exception']) {
		const failure = Object.assign(new Error(type), { meta: { statusCode: 409, body: { error: { type } } } });
		const adapter = await createOpenSearchSearchAdapter({ client: client({ index: async () => { throw failure; } }) });
		for (const write of [
			() => adapter.index(metadata(), 1, { slug: 1, title: 'old' }, { revision: 1 }),
			() => adapter.delete(metadata(), 1, { revision: 1 })
		]) {
			if (type === 'version_conflict_engine_exception') await write();
			else await assert.rejects(write, (error) => error === failure);
		}
		await assert.rejects(() => adapter.index(metadata(), 1, { slug: 1, title: 'unfenced' }), (error) => error === failure);
	}
});

test('OpenSearch revision-only mode rejects omitted and invalid revisions before SDK calls', async () => {
	const adapter = await createOpenSearchSearchAdapter({ requireRevisionWrites: true, client: client({
		index: async () => assert.fail('invalid revisions must not be submitted'),
		delete: async () => assert.fail('unfenced deletes must not be submitted')
	}) });
	await assert.rejects(() => adapter.index(metadata(), 1, { slug: 1, title: 'unfenced' }), /requires a revision/);
	await assert.rejects(() => adapter.delete(metadata(), 1), /requires a revision/);
	for (const revision of [-1, 0, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, '1']) {
		await assert.rejects(() => adapter.index(metadata(), 1, { slug: 1, title: 'bad' }, { revision } as any));
		await assert.rejects(() => adapter.delete(metadata(), 1, { revision } as any));
	}
});

test('OpenSearch physical deletion preserves typed IDs and ignores only missing-document responses', async () => {
	const calls: any[] = [];
	let failure: any = { meta: { statusCode: 404 } };
	const adapter = await createOpenSearchSearchAdapter({ client: client({ delete: async (request: any) => { calls.push(transportJson(request)); throw failure; } }) });
	await adapter.delete(metadata(), '1');
	assert.deepEqual(calls, [{ index: 'opensearch_record', id: 'string:1' }]);
	failure = { meta: { statusCode: 503 } };
	await assert.rejects(() => adapter.delete(metadata(), '1'), (error) => error === failure);
});

test('OpenSearch native post-filters retain the tombstone exclusion and correct offset pagination', async () => {
	const requests: any[] = [];
	const adapter = await createOpenSearchSearchAdapter({ client: client({ search: async (request: any) => {
		requests.push(transportJson(request));
		return { body: { hits: { hits: [{ _id: 'number:3', _source: { slug: 3 } }], total: { value: 3, relation: 'eq' } } } };
	} }) });
	const model = metadata({ searchIndexes: [] });
	const native = { query: { match_all: {} }, from: 2, size: 1, post_filter: { term: { category: 'public' } } };
	const result = await adapter.search(model, '', { native });
	assert.equal(result.more, false);
	assert.deepEqual(requests[0].body.post_filter, { bool: {
		filter: [{ term: { category: 'public' } }], must_not: [{ term: { active_ts_deleted: true } }]
	} });
	assert.deepEqual(native.post_filter, { term: { category: 'public' } });
	assert.equal(requests[0].body.from, 2);
});

test('OpenSearch approximate totals avoid claiming exact counts', async () => {
	const adapter = await createOpenSearchSearchAdapter({ client: client({ search: async () => ({
		body: { hits: { hits: [{ _id: 'number:1', _source: { title: 'needle' } }], total: { value: 10000, relation: 'gte' } } }
	}) }) });
	assert.deepEqual(await adapter.search(metadata(), 'needle', {}), { list: [{ slug: 1, title: 'needle' }], count: 1, total: undefined, more: true });
});

test('OpenSearch rejects unsupported portable options and conflicting native controls before search', async () => {
	const adapter = await createOpenSearchSearchAdapter({ client: client({ search: async () => assert.fail('invalid options cannot reach SDK') }) });
	for (const options of [
		{ cursor: 'opaque' }, { where: { title: 'needle' } },
		{ native: { query: { match_all: {} } } }, { native: { _source: false } },
		{ native: { size: 1 } }, { native: { from: 1 } }, { native: { search_after: [1] } }
	]) await assert.rejects(() => adapter.search(metadata(), 'needle', options as any));
	await assert.rejects(() => adapter.search(metadata({ searchIndexes: [] }), '', { limit: 1, native: { size: 1 } }));
});

test('OpenSearch requires a body envelope and rejects malformed body, hit and total shapes', async () => {
	const sparse = new Array(1);
	for (const response of [
		{ hits: { hits: [] } }, { body: undefined }, { body: null }, { body: [] },
		{ body: {} }, { body: { hits: {} } }, { body: { hits: { hits: sparse } } },
		{ body: { hits: { hits: [null] } } }, { body: { hits: { hits: [{ _source: null }] } } },
		{ body: { hits: { hits: [], total: { value: -1 } } } },
		{ body: { hits: { hits: [], total: { value: 1, relation: 'unknown' } } } },
		{ body: { hits: { hits: [{ _id: 'number:1', _source: { slug: 1 } }], total: 0 } } }
	]) {
		const adapter = await createOpenSearchSearchAdapter({ client: client({ search: async () => response }) });
		await assert.rejects(() => adapter.search(metadata(), 'needle', {}), ActiveTsValidationError);
	}
});

test('OpenSearch response envelope accessors and inherited bodies cannot execute or bypass validation', async () => {
	let reads = 0;
	for (const response of [
		Object.defineProperty({}, 'body', { enumerable: true, get() { reads++; return { hits: { hits: [] } }; } }),
		Object.defineProperty({}, 'body', { value: { hits: { hits: [] } } }),
		Object.create({ body: { hits: { hits: [] } } }),
		{ body: { hits: { hits: [] } }, [Symbol('extra')]: true }
	]) {
		const adapter = await createOpenSearchSearchAdapter({ client: client({ search: async () => response }) });
		await assert.rejects(() => adapter.search(metadata(), 'needle', {}), ActiveTsValidationError);
	}
	assert.equal(reads, 0);
});

test('OpenSearch accepts the official SDK warnings accessor without evaluating transport metadata', async () => {
	let reads = 0;
	const response = Object.defineProperty({ body: { hits: { hits: [], total: 0 } }, statusCode: 200 }, 'warnings', {
		get() { reads++; throw new Error('unused SDK metadata'); }
	});
	const adapter = await createOpenSearchSearchAdapter({ client: client({ search: async () => response }) });
	assert.deepEqual(await adapter.search(metadata(), 'needle', {}), { list: [], count: 0, total: 0, more: false });
	assert.equal(reads, 0);
});

test('OpenSearch snapshots prototype SDK methods and factory options', async () => {
	let calls = 0;
	class SDK {
		async search() { assert.equal(this instanceof SDK, true); calls++; return { body: { hits: { hits: [] } } }; }
		async index() {}
		async delete() {}
	}
	const sdk = new SDK();
	const options = { client: sdk, indexPrefix: 'stable_' };
	const adapter = await createOpenSearchSearchAdapter(options);
	options.indexPrefix = 'Invalid_';
	SDK.prototype.search = async () => { throw new Error('mutated SDK method'); };
	await adapter.search(metadata(), 'needle', {});
	assert.equal(calls, 1);
});

test('OpenSearch factory rejects malformed options and client methods without running getters', async () => {
	let reads = 0;
	const accessorClient = client();
	Object.defineProperty(accessorClient, 'search', { enumerable: true, get() { reads++; return async () => ({}); } });
	for (const options of [
		null, [], {}, { node: '' }, { client: client(), node: 'http://localhost:9200' },
		{ client: client(), indexPrefix: 'Bad_' }, { client: client(), indexPrefix: '../' },
		{ client: client(), requireRevisionWrites: 'yes' }, { client: client(), unsupported: true },
		{ client: {} }, { client: accessorClient },
		Object.defineProperty({}, 'client', { enumerable: true, get() { reads++; return client(); } })
	]) await assert.rejects(() => createOpenSearchSearchAdapter(options as any));
	assert.equal(reads, 0);
});

test('OpenSearch rejects reserved projections, oversized IDs and unsafe field paths before writing', async () => {
	const adapter = await createOpenSearchSearchAdapter({ client: client({ index: async () => assert.fail('invalid input cannot reach SDK') }) });
	for (const field of ['_source', '_id', 'active_ts_deleted', '__proto__.title']) {
		const model = metadata({ searchIndexes: [{ name: 'bad', adapter: 'opensearch', fields: [field] }] });
		await assert.rejects(() => adapter.index(model, 1, { slug: 1, title: 'needle' }));
	}
	const id = 'a'.repeat(513);
	await assert.rejects(() => adapter.index(metadata(), id, { slug: id, title: 'needle' }), ActiveTsValidationError);
	await assert.rejects(() => adapter.index(metadata(), 1, { slug: 2, title: 'mismatch' }), ActiveTsValidationError);
});

test('OpenSearch preserves Datastore ancestor identity and required ancestor projections', async () => {
	const calls: any[] = [];
	const model = metadata({ datastore: {
		ancestor: ({ data }) => data === undefined ? undefined : datastoreKey('parent', data.parentId),
		ancestorFields: ['parentId']
	} });
	const adapter = await createOpenSearchSearchAdapter({ client: client({
		index: async (request: any) => { calls.push(transportJson(request)); },
		search: async () => ({ body: { hits: { hits: calls.map((request) => ({ _id: request.id, _source: request.body })), total: calls.length } } })
	}) });
	await adapter.index(model, 1, { slug: 1, parentId: 10, title: 'left' });
	await adapter.index(model, 1, { slug: 1, parentId: 20, title: 'right' });
	assert.notEqual(calls[0].id, calls[1].id);
	assert.equal(calls[0].body.parentId, 10);
	const result = await adapter.search(model, 'needle', {});
	assert.deepEqual(result.list.map((row) => row.parentId), [10, 20]);
	assert.deepEqual(result.list.map(searchHitDocumentIdentity), calls.map((request) => request.id));
	const unsafe = metadata({ datastore: { ancestor: model.datastore!.ancestor } });
	await assert.rejects(() => adapter.index(unsafe, 1, { slug: 1, title: 'missing ancestor fields' }), ActiveTsConfigurationError);
});
