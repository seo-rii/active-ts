import test from 'node:test';
import assert from 'node:assert/strict';
import {
	MemoryCacheAdapter,
	MemorySearchAdapter,
	MemoryStoreAdapter,
	Model,
	ACTIVE_TS_ENTITY_KEY,
	createActiveTs,
	createSearchMiddlewareAdapter,
	defineModel,
	datastoreKey,
	isPartialModel,
	type ResolvedModelMeta,
	type SchemaPlan,
	type SearchAdapter,
	type StoreAdapter
} from '../src/index.js';
import { createAlgoliaSearchAdapter } from '../src/adapters/search/algolia.js';
import { createElasticsearchSearchAdapter } from '../src/adapters/search/elasticsearch.js';
import { createNativeSearchAdapter } from '../src/adapters/search/native.js';
import {
	markSearchDocumentIdentity,
	datastoreSearchDocumentIdentity,
	searchDocumentIdentity,
	searchHitDocumentIdentity,
	withDatastoreSearchNamespace,
	withSearchIndexesForAdapter
} from '../src/core/search-utils.js';
import { markStoreTrustsDatastoreEntityKeyRows } from '../src/core/store-options.js';

type SearchParityData = {
	id: number | string;
	title: string;
	body: string;
};

type SearchIncludeAuthorData = {
	id: number;
	name: string;
};

type SearchIncludeArticleData = {
	id: number;
	authorId: number;
	title: string;
	body: string;
};
type SearchCodecData = {
	id: number;
	token: string;
};

type SearchArrayData = {
	id: number;
	tags: string[];
};

type FlatDottedSearchData = {
	id: number;
	profile: {
		bio?: string;
	};
};

type NativeSearchCodecData = {
	id: number;
	token: string;
	body: string;
};

type NativeSearchParentCodecData = {
	id: number;
	profile: {
		bio: string;
	};
};

type RemoteDatastoreSearchData = {
	id: number;
	parentId: number;
	title: string;
};

type EncodedDatastoreSearchData = {
	id: number;
	parentId: number;
	authorId: number;
	title: string;
};

type NativeDatastoreSearchData = {
	id: number;
	parentId: number;
	title: string;
};

type SchemaDatastoreSearchData = {
	id: number;
	parentId: number;
	title: string;
};

type ConstantDatastoreSearchData = {
	id: number;
	title: string;
};

class SearchParityRecord extends Model<SearchParityData> {}
class SearchIncludeAuthor extends Model<SearchIncludeAuthorData> {}
class SearchIncludeArticle extends Model<SearchIncludeArticleData> {}
class CachedSearchIncludeArticle extends Model<SearchIncludeArticleData> {}
class SearchProjectionCollisionRecord extends Model<{ id: number; profile: unknown }> {}
class SearchIdProjectionCollisionRecord extends Model<{ id: number }> {}
class SearchCodecRecord extends Model<SearchCodecData> {}
class SearchArrayRecord extends Model<SearchArrayData> {}
class FlatDottedSearchRecord extends Model<FlatDottedSearchData> {}
class NativeSearchCodecRecord extends Model<NativeSearchCodecData> {}
class NativeSearchParentCodecRecord extends Model<NativeSearchParentCodecData> {}
class NativeSearchUnsupportedCodecRecord extends Model<NativeSearchCodecData> {}
class NativeSearchBadQueryCodecRecord extends Model<NativeSearchCodecData> {}
class RemoteDatastoreSearchRecord extends Model<RemoteDatastoreSearchData> {}
class EncodedDatastoreSearchRecord extends Model<EncodedDatastoreSearchData> {}
class NativeDatastoreSearchRecord extends Model<NativeDatastoreSearchData> {}
class SchemaDatastoreSearchRecord extends Model<SchemaDatastoreSearchData> {}
class ConstantDatastoreSearchRecord extends Model<ConstantDatastoreSearchData> {}

function reverseText(value: unknown) {
	return String(value).split('').reverse().join('');
}

defineModel<SearchParityData>({ name: 'search_parity_record', search: 'memory' })
	.id('id')
	.validate((input) => input as SearchParityData)
	.search('memory', ['title'])
	.search('native', ['title'], { name: 'native_title' })
	.search('algolia', ['title'], { name: 'algolia_title' })
	.search('elasticsearch', ['title'], { name: 'elasticsearch_title' })
	.attach(SearchParityRecord);

defineModel<RemoteDatastoreSearchData>({ name: 'remote_datastore_search_record', search: 'memory' })
	.id('id')
	.validate((input) => input as RemoteDatastoreSearchData)
	.datastore({
		ancestor: ({ data }) => data === undefined ? undefined : datastoreKey('remote_datastore_search_parent', data.parentId),
		ancestorFields: ['parentId']
	})
	.search('algolia', ['title'], { name: 'algolia_title_parent' })
	.search('elasticsearch', ['title'], { name: 'elasticsearch_title_parent' })
	.attach(RemoteDatastoreSearchRecord);

defineModel<EncodedDatastoreSearchData>({ name: 'encoded_datastore_search_record', search: 'custom' })
	.id('id')
	.validate((input) => input as EncodedDatastoreSearchData)
	.fieldCodec('parentId', {
		name: 'encoded-datastore-search-parent-codec',
		encode: (value) => `parent:${value}`,
		decode: (value) => {
			const text = String(value);
			if (!text.startsWith('parent:')) throw new Error('expected stored parent id');
			return Number(text.slice('parent:'.length));
		},
		encodeQuery: (value) => `parent:${value}`
	})
	.datastore({
		ancestor: ({ data }) => data === undefined ? undefined : datastoreKey('encoded_datastore_search_parent', data.parentId),
		ancestorFields: ['parentId']
	})
	.search('memory', ['title'])
	.search('custom', ['title'])
	.ref('author', () => SearchIncludeAuthor, { localKey: 'authorId', foreignKey: 'id' })
	.attach(EncodedDatastoreSearchRecord);

defineModel<NativeDatastoreSearchData>({ name: 'native_datastore_search_record', search: 'native' })
	.id('id')
	.validate((input) => input as NativeDatastoreSearchData)
	.datastore({
		ancestor: ({ data }) => data === undefined ? undefined : datastoreKey('native_datastore_search_parent', data.parentId),
		ancestorFields: ['parentId']
	})
	.search('native', ['title'])
	.attach(NativeDatastoreSearchRecord);

defineModel<SchemaDatastoreSearchData>({ name: 'schema_datastore_search_record', search: 'schema' })
	.id('id')
	.validate((input) => input as SchemaDatastoreSearchData)
	.datastore({
		ancestor: ({ data }) => data === undefined ? undefined : datastoreKey('schema_datastore_search_parent', data.parentId),
		ancestorFields: ['parentId']
	})
	.search('schema', ['title'])
	.attach(SchemaDatastoreSearchRecord);

defineModel<ConstantDatastoreSearchData>({ name: 'constant_datastore_search_record', search: 'custom' })
	.id('id')
	.validate((input) => input as ConstantDatastoreSearchData)
	.datastore({
		ancestor: () => datastoreKey('constant_datastore_search_parent', 1),
		ancestorFields: []
	})
	.search('custom', ['title'])
	.attach(ConstantDatastoreSearchRecord);

class SearchAffinityRecord extends Model<SearchParityData> {}
class SearchRemoteAffinityRecord extends Model<SearchParityData> {}

defineModel<SearchParityData>({ name: 'search_affinity_record', search: 'memory' })
	.id('id')
	.validate((input) => input as SearchParityData)
	.search('memory', ['title'])
	.search('algolia', ['body'], { name: 'body_search' })
	.attach(SearchAffinityRecord);

defineModel<SearchParityData>({ name: 'search_remote_affinity_record', search: 'memory' })
	.id('id')
	.validate((input) => input as SearchParityData)
	.search('memory', ['title'])
	.search('algolia', ['body'], { name: 'algolia_body' })
	.search('elasticsearch', ['body'], { name: 'elastic_body' })
	.attach(SearchRemoteAffinityRecord);

class SearchAliasRecord extends Model<SearchParityData> {}

defineModel<SearchParityData>({ name: 'search_alias_record', search: 'search' })
	.id('id')
	.validate((input) => input as SearchParityData)
	.search('search', ['title'], { name: 'alias_title' })
	.attach(SearchAliasRecord);

defineModel<SearchIncludeAuthorData>('search_include_author')
	.id('id')
	.validate((input) => input as SearchIncludeAuthorData)
	.attach(SearchIncludeAuthor);

defineModel<SearchIncludeArticleData>({ name: 'search_include_article', search: 'memory' })
	.id('id')
	.validate((input) => input as SearchIncludeArticleData)
	.search('memory', ['title'])
	.ref('author', () => SearchIncludeAuthor, { localKey: 'authorId', foreignKey: 'id' })
	.attach(SearchIncludeArticle);

defineModel<SearchIncludeArticleData>({ name: 'cached_search_include_article', cache: { ttl: 60 }, search: 'memory' })
	.id('id')
	.validate((input) => input as SearchIncludeArticleData)
	.search('memory', ['title'])
	.ref('author', () => SearchIncludeAuthor, { localKey: 'authorId', foreignKey: 'id' })
	.attach(CachedSearchIncludeArticle);

defineModel<SearchCodecData>({ name: 'search_codec_record', search: 'memory' })
	.id('id')
	.validate((input) => input as SearchCodecData)
	.fieldCodec('token', {
		name: 'search-token-codec',
		encode: (value) => `stored:${value}`,
		decode: (value) => {
			const text = String(value);
			if (!text.startsWith('stored:')) throw new Error('expected stored token');
			return text.slice('stored:'.length);
		},
		encodeQuery: (value) => `stored:${value}`
	})
	.search('memory', ['token'])
	.attach(SearchCodecRecord);

defineModel<SearchArrayData>({ name: 'search_array_regression_record', search: 'memory' })
	.id('id')
	.validate((input) => input as SearchArrayData)
	.search('memory', ['tags'])
	.search('native', ['tags'])
	.attach(SearchArrayRecord);

defineModel<FlatDottedSearchData>({ name: 'flat_dotted_search_record', search: 'memory' })
	.id('id')
	.validate((input) => input as FlatDottedSearchData)
	.search('memory', ['profile.bio'])
	.attach(FlatDottedSearchRecord);

defineModel<NativeSearchCodecData>({ name: 'native_search_codec_record', search: 'native' })
	.id('id')
	.validate((input) => input as NativeSearchCodecData)
	.fieldCodec('token', {
		name: 'native-token-codec',
		encode: (value) => `stored:${reverseText(value)}`,
		decode: (value) => {
			const text = String(value);
			if (!text.startsWith('stored:')) throw new Error('expected stored token');
			return reverseText(text.slice('stored:'.length));
		},
		encodeQuery: (value) => `stored:${reverseText(value)}`,
		queryOperators: ['textContains']
	})
	.search('native', ['token'])
	.attach(NativeSearchCodecRecord);

defineModel<NativeSearchParentCodecData>({ name: 'native_search_parent_codec_record', search: 'native' })
	.id('id')
	.validate((input) => input as NativeSearchParentCodecData)
	.fieldCodec('profile', {
		name: 'native-profile-codec',
		encode: (value) => JSON.stringify(value),
		decode: (value) => JSON.parse(String(value)),
		encodeQuery: (value) => JSON.stringify(value)
	})
	.search('native', ['profile.bio'])
	.attach(NativeSearchParentCodecRecord);

defineModel<NativeSearchCodecData>({ name: 'native_search_unsupported_codec_record', search: 'native' })
	.id('id')
	.validate((input) => input as NativeSearchCodecData)
	.fieldCodec('token', {
		name: 'native-token-no-query-codec',
		encode: (value) => `stored:${reverseText(value)}`,
		decode: (value) => reverseText(String(value).slice('stored:'.length))
	})
	.search('native', ['token'])
	.attach(NativeSearchUnsupportedCodecRecord);

defineModel<NativeSearchCodecData>({ name: 'native_search_bad_query_codec_record', search: 'native' })
	.id('id')
	.validate((input) => input as NativeSearchCodecData)
	.fieldCodec('token', {
		name: 'native-token-bad-query-codec',
		encode: (value) => `stored:${reverseText(value)}`,
		decode: (value) => reverseText(String(value).slice('stored:'.length)),
		encodeQuery: () => ({ bad: true }),
		queryOperators: ['textContains']
	})
	.search('native', ['token'])
	.attach(NativeSearchBadQueryCodecRecord);

function searchMetaWithAccessor<TData>(
	meta: ResolvedModelMeta<TData>,
	property: 'name' | 'idField' | 'searchIndexes'
) {
	let calls = 0;
	const next = { ...meta };
	Object.defineProperty(next, property, {
		enumerable: true,
		configurable: true,
		get() {
			calls++;
			return meta[property];
		}
	});
	return {
		model: next as ResolvedModelMeta<TData>,
		calls: () => calls
	};
}

function searchMetaWithHidden<TData>(
	meta: ResolvedModelMeta<TData>,
	property: 'name' | 'idField' | 'searchIndexes'
) {
	const next = { ...meta };
	Object.defineProperty(next, property, {
		enumerable: false,
		configurable: true,
		value: meta[property]
	});
	return next as ResolvedModelMeta<TData>;
}

async function expectSearchModelMetadataAccessorsRejected(
	adapter: SearchAdapter,
	label: string,
	meta: ResolvedModelMeta<SearchParityData>,
	backendCalls: () => number
) {
	for (const property of ['name', 'idField', 'searchIndexes'] as const) {
		const accessor = searchMetaWithAccessor(meta, property);
		await assert.rejects(
			() => adapter.search(accessor.model, 'needle', {}),
			new RegExp(`${label} model metadata\\.${property} must be a data property`)
		);
		assert.equal(accessor.calls(), 0);
	}

	await assert.rejects(
		() => adapter.search(searchMetaWithHidden(meta, 'name'), 'needle', {}),
		new RegExp(`${label} model metadata\\.name must be enumerable`)
	);
	await assert.rejects(
		() => adapter.search(searchMetaWithHidden(meta, 'searchIndexes'), 'needle', {}),
		new RegExp(`${label} model metadata\\.searchIndexes must be enumerable`)
	);
	await assert.rejects(
		() => adapter.search({ ...meta, idField: 'profile.id' } as any, 'needle', {}),
		new RegExp(`${label} model metadata\\.idField "profile\\.id" must be a top-level field`)
	);
	await assert.rejects(
		() =>
			adapter.search({
				...meta,
				indexes: [{ name: 'by_title', fields: ['title'], uniq: true }]
			} as any, 'needle', {}),
		new RegExp(`${label} model metadata\\.indexes\\[0\\] contains unknown option "uniq"`)
	);
	await assert.rejects(
		() =>
			adapter.search({
				...meta,
				searchIndexes: [{ name: 'by_title', fields: ['title'], adaptor: label }]
			} as any, 'needle', {}),
		new RegExp(`${label} model metadata\\.searchIndexes\\[0\\] contains unknown option "adaptor"`)
	);

	if (adapter.capabilities?.index) {
		const indexAccessor = searchMetaWithAccessor(meta, 'name');
		await assert.rejects(
			() => adapter.index(indexAccessor.model, 1, { id: 1, title: 'one', body: 'body' }),
			new RegExp(`${label} model metadata\\.name must be a data property`)
		);
		assert.equal(indexAccessor.calls(), 0);

		const deleteAccessor = searchMetaWithAccessor(meta, 'name');
		await assert.rejects(
			() => adapter.delete(deleteAccessor.model, 1),
			new RegExp(`${label} model metadata\\.name must be a data property`)
		);
		assert.equal(deleteAccessor.calls(), 0);
	}
	assert.equal(backendCalls(), 0);
}

test('memory and native search only inspect declared search index fields', async () => {
	const store = new MemoryStoreAdapter();
	const memory = new MemorySearchAdapter();
	const context = createActiveTs({
		stores: { default: store },
		search: { memory },
		defaultSearch: 'memory'
	});
	const meta = context.meta(SearchParityRecord);
	await store.seed('search_parity_record', [
		{ id: 1, title: 'needle title', body: 'plain body' },
		{ id: 2, title: 'plain title', body: 'needle hidden body' }
	]);
	await memory.index(meta, 1, { id: 1, title: 'needle title', body: 'plain body' });
	await memory.index(meta, 2, { id: 2, title: 'plain title', body: 'needle hidden body' });
	await memory.index(meta, 3, { id: 3, body: 'missing title' });

	assert.deepEqual((await memory.search(meta, 'needle', {})).list.map((item) => item.id), [1]);
	assert.deepEqual((await memory.search(meta, 'hidden', {})).list, []);
	assert.deepEqual((await memory.search(meta, '', {})).list.map((item) => item.id), [1, 2]);
	assert.deepEqual(await memory.search(meta, '', { limit: 1 }), {
		list: [{ id: 1, title: 'needle title' }],
		more: true,
		count: 1,
		total: 2
	});
	await assert.rejects(() => memory.search(meta, 'needle', null as any), /memory search options must be a plain object/);
	await assert.rejects(() => memory.search(meta, 'needle', { cursor: '1' }), /does not support cursors/);
	await assert.rejects(() => memory.search(meta, 'needle', { native: {} }), /does not support native payloads/);
	await assert.rejects(
		() => memory.search({ ...meta, searchIndexes: [] }, 'needle', { where: { id: ['contains', 1] as any } }),
		/legacy contains operator is ambiguous/
	);
	await assert.rejects(() => memory.search(meta, { text: 'needle' } as any, {}), /memory search query must be a string/);
	await assert.rejects(() => memory.search(meta, 'bad\0query', {}), /memory search query must not contain null bytes/);
	await assert.rejects(() => memory.search(meta, 'x'.repeat(4097), {}), /memory search query is too long/);
	await assert.rejects(() => memory.search({ ...meta, name: '__unsafe' }, 'needle', {}), /memory search model metadata\.name/);
	await assert.rejects(
		() => memory.index({ ...meta, name: '__unsafe' }, 1, { id: 1, title: 'bad', body: 'body' }),
		/memory search model metadata\.name/
	);
	await assert.rejects(() => memory.delete({ ...meta, name: '__unsafe' }, 1), /memory search model metadata\.name/);
	assert.deepEqual(memory.snapshot('search_parity_record'), [
		{ id: 1, title: 'needle title' },
		{ id: 2, title: 'plain title' },
		{ id: 3 }
	]);

	const native = createNativeSearchAdapter(store);
	assert.deepEqual((await native.search(meta, 'needle', {})).list.map((item: SearchParityData) => item.id), [1]);
	assert.deepEqual((await native.search(meta, 'hidden', {})).list, []);
	const queryCalls = store.stats.query;
	await assert.rejects(() => native.search(meta, { text: 'needle' } as any, {}), /native search query must be a string/);
	await assert.rejects(() => native.search(meta, 'bad\0query', {}), /native search query must not contain null bytes/);
	await assert.rejects(() => native.search(meta, 'x'.repeat(4097), {}), /native search query is too long/);
	await assert.rejects(() => native.search(meta, 'needle', null as any), /native search options must be a plain object/);
	await assert.rejects(() => native.search(meta, 'needle', { where: { id: 1 } }), /does not support where filters/);
	await assert.rejects(() => native.search({ ...meta, name: '__unsafe' }, 'needle', {}), /native search model metadata\.name/);
	assert.equal(store.stats.query, queryCalls);
});

test('memory and native search share case-insensitive string-array text matching', async () => {
	const store = new MemoryStoreAdapter();
	const memory = new MemorySearchAdapter();
	const context = createActiveTs({
		stores: { default: store },
		search: { memory },
		defaultSearch: 'memory'
	});
	const meta = context.meta(SearchArrayRecord);
	const rows = [
		{ id: 1, tags: ['Alpha Team', 'beta'] },
		{ id: 2, tags: ['gamma'] },
		{ id: 3, tags: [] }
	];
	await store.seed(meta, rows);
	for (const row of rows) await memory.index(meta, row.id, row);
	const native = createNativeSearchAdapter(store);

	assert.deepEqual((await memory.search(meta, 'alpha', {})).list.map((item) => item.id), [1]);
	assert.deepEqual((await memory.search(meta, 'ALPHA', {})).list.map((item) => item.id), [1]);
	assert.deepEqual((await native.search(meta, 'ALPHA', {})).list.map((item: SearchArrayData) => item.id), [1]);
	assert.deepEqual((await native.search(meta, 'TEAM', {})).list, [{ id: 1, tags: ['Alpha Team', 'beta'] }]);
	assert.deepEqual((await memory.search(meta, 'delta', {})).list, []);
	assert.deepEqual((await native.search(meta, 'delta', {})).list, []);
});

test('native search projects declared fields and decodes field codecs', async () => {
	const store = new MemoryStoreAdapter();
	const native = createNativeSearchAdapter(store);
	const context = createActiveTs({
		stores: { default: store },
		search: { native },
		defaultSearch: 'native'
	});
	const Record = NativeSearchCodecRecord.use(context) as unknown as typeof NativeSearchCodecRecord;
	const meta = context.meta(NativeSearchCodecRecord);
	await Record.create({ id: 1, token: 'alpha', body: 'hidden body' });
	await Record.create({ id: 2, token: 'beta', body: 'other body' });

	const direct = await native.search(meta, 'alpha', {});
	assert.deepEqual(direct.list, [{ id: 1, token: 'alpha' }]);

	const result = await Record.search('alpha').load();
	assert.deepEqual(result.list.map((item) => item.data), [{ id: 1, token: 'alpha' }]);
	assert.equal(isPartialModel(result.list[0]), true);
});

test('native search derives Datastore document identity from entity key metadata on partial rows', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(NativeDatastoreSearchRecord);
	const ancestor = datastoreKey('native_datastore_search_parent', 10);
	const sdkEntityKey = Object.create({});
	Object.defineProperty(sdkEntityKey, 'path', {
		enumerable: true,
		get() {
			return ['native_datastore_search_parent', 10, 'native_datastore_search_record', 7];
		}
	});
	const row = Object.defineProperty(
		{ id: 7, title: 'native partial key-owned' },
		ACTIVE_TS_ENTITY_KEY,
		{ value: sdkEntityKey, enumerable: false }
	);
	const store: StoreAdapter = {
		kind: 'native-datastore-partial-store',
		capabilities: { textContains: true },
		get: async () => null,
		getMany: async (_model, ids) => ids.map(() => null),
		query: async () => ({ list: [row], count: 1 }),
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	markStoreTrustsDatastoreEntityKeyRows(store);
	const search = createNativeSearchAdapter(store);

	const result = await search.search(meta, 'partial', {});

	assert.deepEqual(result.list, [{ id: 7, title: 'native partial key-owned' }]);
	assert.equal(
		searchHitDocumentIdentity(result.list[0]),
		datastoreSearchDocumentIdentity(meta, 7, ancestor)
	);
});

test('native search rejects duplicate Datastore physical document identities', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(NativeDatastoreSearchRecord);
	const entityKey = datastoreKey(meta.name, 7, {
		parent: datastoreKey('native_datastore_search_parent', 10)
	});
	const left = Object.defineProperty(
		{ id: 7, title: 'native duplicate left' },
		ACTIVE_TS_ENTITY_KEY,
		{ value: entityKey, enumerable: false }
	);
	const right = Object.defineProperty(
		{ id: 7, title: 'native duplicate right' },
		ACTIVE_TS_ENTITY_KEY,
		{ value: entityKey, enumerable: false }
	);
	const store: StoreAdapter = {
		kind: 'native-datastore-duplicate-identity-store',
		capabilities: { textContains: true },
		get: async () => null,
		getMany: async (_model, ids) => ids.map(() => null),
		query: async () => ({ list: [left, right], count: 2 }),
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	markStoreTrustsDatastoreEntityKeyRows(store);
	const search = createNativeSearchAdapter(store);

	await assert.rejects(
		() => search.search(meta, 'duplicate', {}),
		/Native search store "native-datastore-duplicate-identity-store" query result contains duplicate search document identity/
	);
});

test('native search allows duplicate Datastore ids under distinct physical identities', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(NativeDatastoreSearchRecord);
	const store: StoreAdapter = {
		kind: 'native-datastore-distinct-identity-store',
		capabilities: { textContains: true },
		get: async () => null,
		getMany: async (_model, ids) => ids.map(() => null),
		query: async () => ({
			list: [
				{ id: 7, parentId: 10, title: 'native distinct left' },
				{ id: 7, parentId: 11, title: 'native distinct right' }
			],
			count: 2
		}),
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	const search = createNativeSearchAdapter(store);

	const result = await search.search(meta, 'distinct', {});

	assert.deepEqual(result.list, [
		{ id: 7, parentId: 10, title: 'native distinct left' },
		{ id: 7, parentId: 11, title: 'native distinct right' }
	]);
	assert.notEqual(
		searchHitDocumentIdentity(result.list[0]),
		searchHitDocumentIdentity(result.list[1])
	);
});

test('native search rejects untrusted Datastore entity key markers on partial rows', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(NativeDatastoreSearchRecord);
	const row = Object.defineProperty(
		{ id: 7, title: 'native forged key-owned' },
		ACTIVE_TS_ENTITY_KEY,
		{ value: datastoreKey(meta.name, 7, { parent: datastoreKey('native_datastore_search_parent', 10) }), enumerable: false }
	);
	const store: StoreAdapter = {
		kind: 'native-datastore-untrusted-partial-store',
		capabilities: { textContains: true },
		get: async () => null,
		getMany: async (_model, ids) => ids.map(() => null),
		query: async () => ({ list: [row], count: 1 }),
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	const search = createNativeSearchAdapter(store);

	await assert.rejects(
		() => search.search(meta, 'partial', {}),
		/partial Datastore search document cannot use untrusted active-ts entity key metadata/
	);
});

test('native search applies wrapped store datastore namespace to projected hit identities', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(NativeDatastoreSearchRecord);
	const ancestor = datastoreKey('native_datastore_search_parent', 10, { namespace: 'native_tenant' });
	const store: StoreAdapter = {
		kind: 'native-datastore-namespaced-store',
		datastoreNamespace: 'native_tenant',
		capabilities: { textContains: true },
		get: async () => null,
		getMany: async (_model, ids) => ids.map(() => null),
		query: async () => ({
			list: [{ id: 7, parentId: 10, title: 'native namespaced partial' }],
			count: 1
		}),
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	markStoreTrustsDatastoreEntityKeyRows(store);
	const search = createNativeSearchAdapter(store);

	const result = await search.search(meta, 'partial', {});

	assert.deepEqual(result.list, [{ id: 7, parentId: 10, title: 'native namespaced partial' }]);
	assert.equal(
		searchHitDocumentIdentity(result.list[0]),
		datastoreSearchDocumentIdentity(meta, 7, ancestor)
	);
});

test('native search rejects empty wrapped Datastore namespace aliases', () => {
	const store = new MemoryStoreAdapter();
	Object.defineProperty(store, 'datastoreNamespace', {
		value: '',
		enumerable: true,
		configurable: true
	});

	assert.throws(
		() => createNativeSearchAdapter(store),
		/Native search store\.datastoreNamespace must be a non-empty string without null bytes/
	);
});

test('native search applies wrapped store datastore namespace to namespace-less entity key identities', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(NativeDatastoreSearchRecord);
	const ancestor = datastoreKey('native_datastore_search_parent', 10, { namespace: 'native_tenant' });
	const sdkEntityKey = Object.create({});
	Object.defineProperty(sdkEntityKey, 'path', {
		enumerable: true,
		get() {
			return ['native_datastore_search_parent', 10, 'native_datastore_search_record', 7];
		}
	});
	const row = Object.defineProperty(
		{ id: 7, title: 'native namespace-less key-owned' },
		ACTIVE_TS_ENTITY_KEY,
		{ value: sdkEntityKey, enumerable: false }
	);
	const store: StoreAdapter = {
		kind: 'native-datastore-namespaced-store',
		datastoreNamespace: 'native_tenant',
		capabilities: { textContains: true },
		get: async () => null,
		getMany: async (_model, ids) => ids.map(() => null),
		query: async () => ({
			list: [row],
			count: 1
		}),
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	markStoreTrustsDatastoreEntityKeyRows(store);
	const search = createNativeSearchAdapter(store);

	const result = await search.search(meta, 'key-owned', {});

	assert.deepEqual(result.list, [{ id: 7, title: 'native namespace-less key-owned' }]);
	assert.equal(
		searchHitDocumentIdentity(result.list[0]),
		datastoreSearchDocumentIdentity(meta, 7, ancestor)
	);
});

test('native search preserves context-bound Datastore trust and namespace on entity key identities', async () => {
	const sdkEntityKey = Object.create({});
	Object.defineProperty(sdkEntityKey, 'path', {
		enumerable: true,
		get() {
			return ['native_datastore_search_parent', 10, 'native_datastore_search_record', 7];
		}
	});
	const row = Object.defineProperty(
		{ id: 7, title: 'native context key-owned' },
		ACTIVE_TS_ENTITY_KEY,
		{ value: sdkEntityKey, enumerable: false }
	);
	const store: StoreAdapter = {
		kind: 'native-context-datastore-namespaced-store',
		datastoreNamespace: 'native_tenant',
		capabilities: { textContains: true },
		get: async () => null,
		getMany: async (_model, ids) => ids.map(() => null),
		query: async () => ({
			list: [row],
			count: 1
		}),
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	markStoreTrustsDatastoreEntityKeyRows(store);
	const context = createActiveTs({ stores: { default: store } });
	const meta = context.meta(NativeDatastoreSearchRecord);
	const search = createNativeSearchAdapter(context.store('default'));
	const ancestor = datastoreKey('native_datastore_search_parent', 10, { namespace: 'native_tenant' });

	const result = await search.search(meta, 'key-owned', {});

	assert.deepEqual(result.list, [{ id: 7, title: 'native context key-owned' }]);
	assert.equal(
		searchHitDocumentIdentity(result.list[0]),
		datastoreSearchDocumentIdentity(meta, 7, ancestor)
	);
});

test('native search rejects Datastore entity key and payload ancestor mismatch', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(NativeDatastoreSearchRecord);
	const entityKey = datastoreKey('native_datastore_search_record', 7, {
		parent: datastoreKey('native_datastore_search_parent', 10)
	});
	const row = Object.defineProperty(
		{ id: 7, parentId: 11, title: 'native mismatched ancestor' },
		ACTIVE_TS_ENTITY_KEY,
		{ value: entityKey, enumerable: false }
	);
	const store: StoreAdapter = {
		kind: 'native-datastore-mismatched-key-store',
		capabilities: { textContains: true },
		get: async () => null,
		getMany: async (_model, ids) => ids.map(() => null),
		query: async () => ({ list: [row], count: 1 }),
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	markStoreTrustsDatastoreEntityKeyRows(store);
	const search = createNativeSearchAdapter(store);

	await assert.rejects(
		() => search.search(meta, 'mismatched', {}),
		/does not match its Datastore payload data/
	);
});

test('direct search indexing rejects untrusted Datastore entity key markers on partial payloads', async () => {
	const store = new MemoryStoreAdapter();
	const memory = new MemorySearchAdapter();
	const context = createActiveTs({
		stores: { default: store },
		search: { memory },
		defaultSearch: 'memory'
	});
	const meta = context.meta(RemoteDatastoreSearchRecord);
	const forgedPayload = () => Object.defineProperty(
		{ id: 6, title: 'forged partial index' },
		ACTIVE_TS_ENTITY_KEY,
		{
			value: datastoreKey(meta.name, 6, {
				parent: datastoreKey('remote_datastore_search_parent', 99)
			}),
			enumerable: false
		}
	);

	await assert.rejects(
		() => memory.index(meta, 6, forgedPayload()),
		/partial Datastore search document cannot use untrusted active-ts entity key metadata/
	);

	let customIndexCalls = 0;
	const customSearch: SearchAdapter = {
		kind: 'custom-index-trust-boundary',
		capabilities: { index: true },
		search: async () => ({ list: [] }),
		index: async () => {
			customIndexCalls++;
		},
		delete: async () => undefined
	};
	const customContext = createActiveTs({
		stores: { default: store },
		search: { custom: customSearch },
		defaultSearch: 'custom'
	});
	await assert.rejects(
		() => customContext.searchAdapter('custom').index(customContext.meta(RemoteDatastoreSearchRecord), 6, forgedPayload()),
		/partial Datastore search document cannot use untrusted active-ts entity key metadata/
	);

	const wrapped = createSearchMiddlewareAdapter(customSearch, []);
	await assert.rejects(
		() => wrapped.index(meta, 6, forgedPayload()),
		/partial Datastore search document cannot use untrusted active-ts entity key metadata/
	);
	assert.equal(customIndexCalls, 0);
});

test('direct search indexing rejects forced Datastore identities that conflict with payload ancestors', async () => {
	const store = new MemoryStoreAdapter();
	const memory = new MemorySearchAdapter();
	const customSearch: SearchAdapter = {
		kind: 'custom-forced-identity-boundary',
		capabilities: { index: true },
		search: async () => ({ list: [] }),
		index: async () => {
			throw new Error('forced Datastore identity mismatch reached wrapped search adapter');
		},
		delete: async () => undefined
	};
	const context = createActiveTs({
		stores: { default: store },
		search: { custom: customSearch },
		defaultSearch: 'custom'
	});
	const meta = context.meta(RemoteDatastoreSearchRecord);
	const forcedIdentity = datastoreSearchDocumentIdentity(
		meta,
		6,
		datastoreKey('remote_datastore_search_parent', 6)
	);
	const forcedMeta = { ...meta, searchDocumentIdentity: forcedIdentity };
	const wrongPayload = { id: 6, parentId: 99, title: 'forced wrong ancestor' };

	await assert.rejects(
		() => memory.index(forcedMeta, 6, wrongPayload),
		/does not match its Datastore payload data/
	);
	await assert.rejects(
		() => context.searchAdapter('custom').index(forcedMeta, 6, wrongPayload),
		/does not match its Datastore payload data/
	);
	const wrapped = createSearchMiddlewareAdapter(customSearch, []);
	await assert.rejects(
		() => wrapped.index(forcedMeta, 6, wrongPayload),
		/does not match its Datastore payload data/
	);
	assert.equal(memory.stats.index, 0);
});

test('direct search indexing accepts decoded field-codec Datastore ancestor fields', async () => {
	const memory = new MemorySearchAdapter();
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory },
		defaultSearch: 'memory'
	});
	const meta = context.meta(EncodedDatastoreSearchRecord);
	const parent = datastoreKey('encoded_datastore_search_parent', 10);
	const data = { id: 7, parentId: 10, authorId: 1, title: 'decoded direct index' };
	const expectedIdentity = datastoreSearchDocumentIdentity(meta, 7, parent);

	assert.equal(
		searchDocumentIdentity(meta, 7, `${meta.name} decoded search document id`, data),
		expectedIdentity
	);

	await memory.index(meta, 7, data);

	const result = await memory.search(meta, 'decoded', {});
	assert.equal(result.list.length, 1);
	assert.equal(searchHitDocumentIdentity(result.list[0]), expectedIdentity);
});

test('direct search indexing rejects forced Datastore identities on untrusted partial entity-key payloads', async () => {
	const store = new MemoryStoreAdapter();
	const memory = new MemorySearchAdapter();
	let customIndexCalls = 0;
	const customSearch: SearchAdapter = {
		kind: 'custom-forced-partial-boundary',
		capabilities: { index: true },
		search: async () => ({ list: [] }),
		index: async () => {
			customIndexCalls++;
		},
		delete: async () => undefined
	};
	const context = createActiveTs({
		stores: { default: store },
		search: { custom: customSearch },
		defaultSearch: 'custom'
	});
	const meta = context.meta(RemoteDatastoreSearchRecord);
	const forcedIdentity = datastoreSearchDocumentIdentity(
		meta,
		6,
		datastoreKey('remote_datastore_search_parent', 6)
	);
	const forcedMeta = { ...meta, searchDocumentIdentity: forcedIdentity };
	const forgedPayload = () => Object.defineProperty(
		{ id: 6, title: 'forced forged partial index' },
		ACTIVE_TS_ENTITY_KEY,
		{
			value: datastoreKey(meta.name, 6, {
				parent: datastoreKey('remote_datastore_search_parent', 99)
			}),
			enumerable: false
		}
	);

	await assert.rejects(
		() => memory.index(forcedMeta, 6, forgedPayload()),
		/partial Datastore search document cannot use untrusted active-ts entity key metadata/
	);
	await assert.rejects(
		() => context.searchAdapter('custom').index(forcedMeta, 6, forgedPayload()),
		/partial Datastore search document cannot use untrusted active-ts entity key metadata/
	);
	const wrapped = createSearchMiddlewareAdapter(customSearch, []);
	await assert.rejects(
		() => wrapped.index(forcedMeta, 6, forgedPayload()),
		/partial Datastore search document cannot use untrusted active-ts entity key metadata/
	);
	assert.equal(memory.stats.index, 0);
	assert.equal(customIndexCalls, 0);
});

test('context and middleware search indexing strip untrusted Datastore entity key markers before custom adapters', async () => {
	const store = new MemoryStoreAdapter();
	const receivedIdentities: string[] = [];
	const customSearch: SearchAdapter = {
		kind: 'custom-index-strip-boundary',
		capabilities: { index: true },
		search: async () => ({ list: [] }),
		index: async (model, id, data) => {
			assert.equal(Object.getOwnPropertyDescriptor(data, ACTIVE_TS_ENTITY_KEY), undefined);
			receivedIdentities.push(searchDocumentIdentity(model, id, 'custom search document id', data));
		},
		delete: async () => undefined
	};
	const customContext = createActiveTs({
		stores: { default: store },
		search: { custom: customSearch },
		defaultSearch: 'custom'
	});
	const meta = customContext.meta(RemoteDatastoreSearchRecord);
	const forgedPayload = () => Object.defineProperty(
		{ id: 6, parentId: 6, title: 'forged full index' },
		ACTIVE_TS_ENTITY_KEY,
		{
			value: datastoreKey(meta.name, 6, {
				parent: datastoreKey('remote_datastore_search_parent', 99)
			}),
			enumerable: false
		}
	);
	await customContext.searchAdapter('custom').index(customContext.meta(RemoteDatastoreSearchRecord), 6, forgedPayload());

	const wrapped = createSearchMiddlewareAdapter(customSearch, []);
	await wrapped.index(meta, 6, forgedPayload());

	assert.deepEqual(receivedIdentities, [
		datastoreSearchDocumentIdentity(meta, 6, datastoreKey('remote_datastore_search_parent', 6)),
		datastoreSearchDocumentIdentity(meta, 6, datastoreKey('remote_datastore_search_parent', 6))
	]);
});

test('context search indexing accepts constant Datastore ancestors with entity key metadata', async () => {
	const store = new MemoryStoreAdapter();
	const receivedIdentities: string[] = [];
	const customSearch: SearchAdapter = {
		kind: 'custom',
		capabilities: { index: true },
		search: async () => ({ list: [] }),
		index: async (model, id, data) => {
			assert.equal(Object.getOwnPropertyDescriptor(data, ACTIVE_TS_ENTITY_KEY), undefined);
			receivedIdentities.push(searchDocumentIdentity(model, id, 'custom search document id', data));
		},
		delete: async () => undefined
	};
	const context = createActiveTs({
		stores: { default: store },
		search: { custom: customSearch },
		defaultSearch: 'custom'
	});
	const meta = context.meta(ConstantDatastoreSearchRecord);
	const payload = Object.defineProperty(
		{ id: 6, title: 'constant full index' },
		ACTIVE_TS_ENTITY_KEY,
		{
			value: datastoreKey(meta.name, 6, {
				parent: datastoreKey('constant_datastore_search_parent', 99)
			}),
			enumerable: false
		}
	);

	await context.searchAdapter('custom').index(meta, 6, payload);

	assert.deepEqual(receivedIdentities, [
		datastoreSearchDocumentIdentity(meta, 6, datastoreKey('constant_datastore_search_parent', 1))
	]);
});

test('native search rejects child fields under parent field codecs before store query', async () => {
	const store = new MemoryStoreAdapter();
	const native = createNativeSearchAdapter(store);
	const context = createActiveTs({
		stores: { default: store },
		search: { native },
		defaultSearch: 'native'
	});
	const Record = NativeSearchParentCodecRecord.use(context) as unknown as typeof NativeSearchParentCodecRecord;

	await assert.rejects(
		() => Record.search('alpha').load(),
		/Field codec "native-profile-codec" on native_search_parent_codec_record\.profile overlaps query field "profile\.bio"/
	);
	assert.equal(store.stats.query, 0);
});

test('native search fails fast for search field codecs without query encoding', async () => {
	const store = new MemoryStoreAdapter();
	const native = createNativeSearchAdapter(store);
	const context = createActiveTs({
		stores: { default: store },
		search: { native },
		defaultSearch: 'native'
	});
	const Record = NativeSearchUnsupportedCodecRecord.use(context) as unknown as typeof NativeSearchUnsupportedCodecRecord;
	await Record.create({ id: 1, token: 'alpha', body: 'hidden body' });

	await assert.rejects(
		() => Record.search('alpha').load(),
		/Field codec "native-token-no-query-codec" on native_search_unsupported_codec_record\.token does not support portable query operands/
	);
});

test('native search validates store capabilities and encoded query operands before query execution', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const baseMeta = context.meta(SearchParityRecord);
	const nestedMeta: ResolvedModelMeta = {
		...baseMeta,
		searchIndexes: [{ name: 'native_profile_bio', adapter: 'native', fields: ['profile.bio'] }]
	};
	let flatQueryCalls = 0;
	const flatNative = createNativeSearchAdapter({
		kind: 'flat-native-store',
		capabilities: { textContains: true, nestedFields: false },
		query: async () => {
			flatQueryCalls++;
			throw new Error('flat native store query should not run');
		}
	} as any);

	await assert.rejects(
		() => flatNative.search(nestedMeta, 'needle', {}),
		/Store adapter "flat-native-store" does not support native nested search fields/
	);
	assert.equal(flatQueryCalls, 0);

	const nestedPlans: any[] = [];
	const nestedNative = createNativeSearchAdapter({
		kind: 'nested-native-store',
		capabilities: { textContains: true, nestedFields: true },
		query: async (_model: unknown, plan: unknown) => {
			nestedPlans.push(plan);
			return { list: [{ id: 1, profile: { bio: 'needle result' } }], more: false };
		}
	} as any);

	assert.deepEqual(await nestedNative.search(nestedMeta, 'needle', {}), {
		list: [{ id: 1, profile: { bio: 'needle result' } }],
		cursor: undefined,
		more: false,
		count: 1,
		total: undefined
	});
	assert.equal(nestedPlans[0].where[0].field, 'profile.bio');

	const codecMeta = context.meta(NativeSearchBadQueryCodecRecord);
	let codecQueryCalls = 0;
	const codecNative = createNativeSearchAdapter({
		kind: 'codec-native-store',
		capabilities: { textContains: true },
		query: async () => {
			codecQueryCalls++;
			throw new Error('bad codec native store query should not run');
		}
	} as any);

	await assert.rejects(
		() => codecNative.search(codecMeta, 'needle', {}),
		/Query operator "textContains" on "token" requires a string value/
	);
	assert.equal(codecQueryCalls, 0);
});

test('built-in search adapters reject accessor-backed model metadata before backend calls', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(SearchParityRecord);

	const memory = new MemorySearchAdapter();
	await expectSearchModelMetadataAccessorsRejected(
		memory,
		'memory search',
		meta,
		() => memory.stats.search + memory.stats.index + memory.stats.delete
	);

	const store = new MemoryStoreAdapter();
	const native = createNativeSearchAdapter(store);
	await expectSearchModelMetadataAccessorsRejected(native, 'native search', meta, () => store.stats.query);

	let algoliaCalls = 0;
	const algolia = await createAlgoliaSearchAdapter({
		client: {
			searchSingleIndex: async () => {
				algoliaCalls++;
				return { hits: [], nbHits: 0, nbPages: 0, page: 0 };
			},
			saveObject: async () => {
				algoliaCalls++;
			},
			deleteObject: async () => {
				algoliaCalls++;
			}
		}
	});
	await expectSearchModelMetadataAccessorsRejected(algolia, 'Algolia', meta, () => algoliaCalls);

	let elasticCalls = 0;
	const elastic = await createElasticsearchSearchAdapter({
		client: {
			search: async () => {
				elasticCalls++;
				return { hits: { hits: [], total: { value: 0 } } };
			},
			index: async () => {
				elasticCalls++;
			},
			delete: async () => {
				elasticCalls++;
			}
		}
	});
	await expectSearchModelMetadataAccessorsRejected(elastic, 'Elasticsearch', meta, () => elasticCalls);
});

test('built-in search adapter deletes validate runtime ids before backend calls', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(SearchParityRecord);

	const memory = new MemorySearchAdapter();
	await assert.rejects(
		() => memory.delete(meta, {} as any),
		/search_parity_record search delete id must be a string or safe integer/
	);
	assert.equal(memory.stats.delete, 0);

	let algoliaDeletes = 0;
	const algolia = await createAlgoliaSearchAdapter({
		client: {
			searchSingleIndex: async () => ({ hits: [], nbHits: 0, nbPages: 0, page: 0 }),
			saveObject: async () => undefined,
			deleteObject: async () => {
				algoliaDeletes++;
			}
		}
	});
	await assert.rejects(
		() => algolia.delete(meta, false as any),
		/search_parity_record search delete id must be a string or safe integer/
	);
	assert.equal(algoliaDeletes, 0);

	let elasticDeletes = 0;
	const elastic = await createElasticsearchSearchAdapter({
		client: {
			search: async () => ({ hits: { hits: [], total: { value: 0 } } }),
			index: async () => undefined,
			delete: async () => {
				elasticDeletes++;
			}
		}
	});
	await assert.rejects(
		() => elastic.delete(meta, Number.NaN as any),
		/search_parity_record search delete id "NaN" must be a safe integer/
	);
	assert.equal(elasticDeletes, 0);
});

test('algolia search adapter rejects reserved backend projection fields before backend calls', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(SearchParityRecord);
	let backendCalls = 0;
	const algolia = await createAlgoliaSearchAdapter({
		client: {
			searchSingleIndex: async () => {
				backendCalls++;
				return { hits: [], nbHits: 0, nbPages: 0, page: 0 };
			},
			saveObject: async () => {
				backendCalls++;
			},
			deleteObject: async () => {
				backendCalls++;
			}
		}
	});
	const reservedFields = [
		'objectID',
		'_highlightResult',
		'_snippetResult',
		'_rankingInfo',
		'_distinctSeqID',
		'_geoloc'
	];

	for (const field of reservedFields) {
		await assert.rejects(
			() => algolia.search({ ...meta, idField: field } as any, 'needle', {}),
			new RegExp(`Algolia model id field "${field}" uses reserved Algolia metadata field "${field}"`)
		);
		await assert.rejects(
			() => algolia.index({ ...meta, idField: field } as any, 1, { id: 1, title: 'one', body: 'body' }),
			new RegExp(`Algolia model id field "${field}" uses reserved Algolia metadata field "${field}"`)
		);

		const projectionMeta = {
			...meta,
			searchIndexes: [{ name: 'reserved_projection', adapter: 'algolia', fields: [field] }]
		} as any;
		await assert.rejects(
			() => algolia.search(projectionMeta, 'needle', {}),
			new RegExp(`Algolia search field "${field}" uses reserved Algolia metadata field "${field}"`)
		);
		await assert.rejects(
			() => algolia.index(projectionMeta, 1, { id: 1, title: 'one', body: 'body', [field]: 'reserved' } as any),
			new RegExp(`Algolia search field "${field}" uses reserved Algolia metadata field "${field}"`)
		);

		const ancestorProjectionMeta = {
			...meta,
			datastore: {
				ancestor: ({ data }: any) => data === undefined ? undefined : datastoreKey('algolia_reserved_parent', data.parentId),
				ancestorFields: [field]
			},
			searchIndexes: [{ name: 'reserved_ancestor_projection', adapter: 'algolia', fields: ['title'] }]
		} as any;
		await assert.rejects(
			() => algolia.search(ancestorProjectionMeta, 'needle', {}),
			new RegExp(`Algolia projection field "${field}" uses reserved Algolia metadata field "${field}"`)
		);
		await assert.rejects(
			() =>
				algolia.index(ancestorProjectionMeta, 1, {
					id: 1,
					title: 'one',
					body: 'body',
					parentId: 1,
					[field]: 'reserved'
				} as any),
			new RegExp(`Algolia projection field "${field}" uses reserved Algolia metadata field "${field}"`)
		);
	}

	assert.equal(backendCalls, 0);
});

test('elasticsearch search adapter rejects reserved backend fields and long ids before backend calls', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(SearchParityRecord);
	let backendCalls = 0;
	const elastic = await createElasticsearchSearchAdapter({
		client: {
			search: async () => {
				backendCalls++;
				return { hits: { hits: [], total: { value: 0 } } };
			},
			index: async () => {
				backendCalls++;
			},
			delete: async () => {
				backendCalls++;
			}
		}
	});
	const reservedFields = [
		'_id',
		'_source',
		'_index',
		'_score',
		'_type',
		'_routing',
		'_seq_no',
		'_primary_term',
		'_version',
		'_ignored'
	];

	for (const field of reservedFields) {
		await assert.rejects(
			() => elastic.search({ ...meta, idField: field } as any, 'needle', {}),
			new RegExp(`Elasticsearch model id field "${field}" uses reserved Elasticsearch metadata field "${field}"`)
		);
		await assert.rejects(
			() => elastic.index({ ...meta, idField: field } as any, 1, { id: 1, title: 'one', body: 'body' }),
			new RegExp(`Elasticsearch model id field "${field}" uses reserved Elasticsearch metadata field "${field}"`)
		);

		const projectionMeta = {
			...meta,
			searchIndexes: [{ name: 'reserved_projection', adapter: 'elasticsearch', fields: [field] }]
		} as any;
		await assert.rejects(
			() => elastic.search(projectionMeta, 'needle', {}),
			new RegExp(`Elasticsearch search field "${field}" uses reserved Elasticsearch metadata field "${field}"`)
		);
		await assert.rejects(
			() => elastic.index(projectionMeta, 1, { id: 1, title: 'one', body: 'body', [field]: 'reserved' } as any),
			new RegExp(`Elasticsearch search field "${field}" uses reserved Elasticsearch metadata field "${field}"`)
		);

		const ancestorProjectionMeta = {
			...meta,
			datastore: {
				ancestor: ({ data }: any) => data === undefined ? undefined : datastoreKey('elastic_reserved_parent', data.parentId),
				ancestorFields: [field]
			},
			searchIndexes: [{ name: 'reserved_ancestor_projection', adapter: 'elasticsearch', fields: ['title'] }]
		} as any;
		await assert.rejects(
			() => elastic.search(ancestorProjectionMeta, 'needle', {}),
			new RegExp(`Elasticsearch projection field "${field}" uses reserved Elasticsearch metadata field "${field}"`)
		);
		await assert.rejects(
			() =>
				elastic.index(ancestorProjectionMeta, 1, {
					id: 1,
					title: 'one',
					body: 'body',
					parentId: 1,
					[field]: 'reserved'
				} as any),
			new RegExp(`Elasticsearch projection field "${field}" uses reserved Elasticsearch metadata field "${field}"`)
		);
	}

	const tooLongEncodedId = 'x'.repeat(506);
	await assert.rejects(
		() => elastic.index(meta, tooLongEncodedId, { id: tooLongEncodedId, title: 'one', body: 'body' }),
		/search_parity_record search document id encoded Elasticsearch _id exceeds 512 bytes/
	);
	await assert.rejects(
		() => elastic.delete(meta, tooLongEncodedId),
		/search_parity_record search delete id encoded Elasticsearch _id exceeds 512 bytes/
	);

	assert.equal(backendCalls, 0);
});

test('direct search adapters reject ancestor-backed metadata without ancestorFields before backend calls', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(RemoteDatastoreSearchRecord);
	let backendCalls = 0;
	const algolia = await createAlgoliaSearchAdapter({
		client: {
			searchSingleIndex: async () => {
				backendCalls++;
				return { hits: [], nbHits: 0, nbPages: 0, page: 0 };
			},
			saveObject: async () => {
				backendCalls++;
			},
			deleteObject: async () => {
				backendCalls++;
			}
		}
	});
	const algoliaMeta = {
		...meta,
		datastore: { ancestor: meta.datastore?.ancestor },
		searchIndexes: [{ name: 'algolia_title_parent', adapter: 'algolia', fields: ['title'] }]
	} as any;
	await assert.rejects(
		() => algolia.search(algoliaMeta, 'needle', {}),
		/Datastore ancestor model search index "algolia_title_parent" must declare datastore\.ancestorFields/
	);
	await assert.rejects(
		() => algolia.index(algoliaMeta, 1, { id: 1, parentId: 2, title: 'one' }),
		/Datastore ancestor model search index "algolia_title_parent" must declare datastore\.ancestorFields/
	);

	const elastic = await createElasticsearchSearchAdapter({
		client: {
			search: async () => {
				backendCalls++;
				return { hits: { hits: [], total: { value: 0 } } };
			},
			index: async () => {
				backendCalls++;
			},
			delete: async () => {
				backendCalls++;
			}
		}
	});
	const elasticMeta = {
		...meta,
		datastore: { ancestor: meta.datastore?.ancestor },
		searchIndexes: [{ name: 'elasticsearch_title_parent', adapter: 'elasticsearch', fields: ['title'] }]
	} as any;
	await assert.rejects(
		() => elastic.search(elasticMeta, 'needle', {}),
		/Datastore ancestor model search index "elasticsearch_title_parent" must declare datastore\.ancestorFields/
	);
	await assert.rejects(
		() => elastic.index(elasticMeta, 1, { id: 1, parentId: 2, title: 'one' }),
		/Datastore ancestor model search index "elasticsearch_title_parent" must declare datastore\.ancestorFields/
	);

	assert.equal(backendCalls, 0);
});

test('memory search index validates ids and payloads before mutating state', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(SearchParityRecord);
	const memory = new MemorySearchAdapter();

	await assert.rejects(
		() => memory.index(meta, {} as any, { id: 1, title: 'unsafe id', body: 'plain' }),
		/search_parity_record search document id must be a string or safe integer|Entity id must be a string or safe integer/
	);
	await assert.rejects(
		() => memory.index(meta, 1, null as any),
		/search_parity_record search document input must be a plain object/
	);
	await assert.rejects(
		() => memory.index(meta, 2, { id: 2, title: () => 'unsafe payload', body: 'plain' } as any),
		/Unsupported data value at "\$\.title"/
	);

	assert.equal(memory.stats.index, 0);
	assert.deepEqual(memory.snapshot(), {});
});

test('search adapter model metadata snapshots nested search index arrays', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(SearchParityRecord);
	const memory = new MemorySearchAdapter();
	const fields = ['title'] as any[];
	const searchIndexes = [{ name: 'custom_fields', adapter: 'memory', fields }] as any[];
	let indexForEachCalls = 0;
	let fieldForEachCalls = 0;
	Object.defineProperty(searchIndexes, 'forEach', {
		value() {
			indexForEachCalls++;
			throw new Error('custom searchIndexes.forEach should not run');
		}
	});
	Object.defineProperty(fields, 'forEach', {
		value() {
			fieldForEachCalls++;
			throw new Error('custom search fields forEach should not run');
		}
	});

	await memory.search({ ...meta, searchIndexes }, 'needle', {});

	assert.equal(indexForEachCalls, 0);
	assert.equal(fieldForEachCalls, 0);

	const iteratorFields = ['title'] as any[];
	let iteratorCalls = 0;
	Object.defineProperty(iteratorFields, Symbol.iterator, {
		value() {
			iteratorCalls++;
			throw new Error('custom search fields iterator should not run');
		}
	});
	await assert.rejects(
		() =>
			memory.search(
				{ ...meta, searchIndexes: [{ name: 'iterator_fields', adapter: 'memory', fields: iteratorFields }] },
				'needle',
				{}
			),
		/memory search model metadata\.searchIndexes\[0\]\.fields cannot contain symbol fields/
	);
	assert.equal(iteratorCalls, 0);

	const hiddenIndex = Object.defineProperty({ adapter: 'memory', fields: ['title'] }, 'name', {
		enumerable: false,
		value: 'hidden_fields'
	});
	await assert.rejects(
		() => memory.search({ ...meta, searchIndexes: [hiddenIndex as any] }, 'needle', {}),
		/memory search model metadata\.searchIndexes\[0\]\.name must be enumerable/
	);
});

test('search option normalizers ignore inherited option keys', async () => {
	const store = new MemoryStoreAdapter();
	const memory = new MemorySearchAdapter();
	const context = createActiveTs({
		stores: { default: store },
		search: { memory },
		defaultSearch: 'memory'
	});
	const meta = context.meta(SearchParityRecord);
	await memory.index(meta, 1, { id: 1, title: 'needle title', body: 'plain body' });
	const Record = SearchParityRecord.use(context) as unknown as typeof SearchParityRecord;

	Object.defineProperty(Object.prototype, 'cursor', {
		value: '1',
		configurable: true
	});
	try {
		assert.deepEqual((await memory.search(meta, 'needle', {})).list.map((item: SearchParityData) => item.id), [1]);
		assert.deepEqual((await Record.search('needle').load()).list.map((item) => item.data.id), [1]);
		assert.throws(() => Record.search('bad\0query'), /Search query must not contain null bytes/);
		assert.throws(() => Record.search('x'.repeat(4097)), /Search query is too long/);
	} finally {
		delete (Object.prototype as Record<string, unknown>).cursor;
	}

	let getterCalls = 0;
	const accessorOptions = Object.defineProperty({}, 'limit', {
		enumerable: true,
		get() {
			getterCalls++;
			return 1;
		}
	});
	await assert.rejects(
		() => memory.search(meta, 'needle', accessorOptions as any),
		/memory search options "limit" must be a data property/
	);
	assert.equal(getterCalls, 0);

	const hiddenOptions = Object.defineProperty({}, 'limit', {
		enumerable: false,
		value: 1
	});
	await assert.rejects(
		() => memory.search(meta, 'needle', hiddenOptions as any),
		/memory search options "limit" must be enumerable/
	);

	await assert.rejects(
		() => memory.search(meta, 'needle', { [Symbol('cursor')]: '1' } as any),
		/memory search options cannot contain symbol fields/
	);
	await assert.rejects(
		() => memory.search(meta, 'needle', { limt: 1 } as any),
		/memory search options contains unknown option "limt"/
	);

	const includes = Object.getOwnPropertyDescriptor(Array.prototype, 'includes')!;
	Object.defineProperty(Array.prototype, 'includes', {
		configurable: true,
		value() {
			throw new Error('patched Array.includes');
		}
	});
	try {
		await assert.rejects(
			() => memory.search(meta, 'needle', { limt: 1 } as any),
			/memory search options contains unknown option "limt"/
		);
	} finally {
		Object.defineProperty(Array.prototype, 'includes', includes);
	}
});

test('search middleware validates malformed where options before middleware execution', async () => {
	const memory = new MemorySearchAdapter();
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory },
		defaultSearch: 'memory'
	});
	const meta = context.meta(SearchParityRecord);
	let reached = false;
	const wrapped = createSearchMiddlewareAdapter(memory, [
		async () => {
			reached = true;
			return { list: [], more: false, count: 0 };
		}
	]);

	await assert.rejects(
		() => wrapped.search(meta, 'needle', { where: null as any }),
		/search middleware options\.where must be a plain object/
	);
	assert.equal(reached, false);
});

test('search middleware snapshots where operands before wrapped adapters', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(SearchParityRecord);
	const ids = [1];
	const wrapped = createSearchMiddlewareAdapter(
		{
			kind: 'mutating-search-options',
			capabilities: {
				where: true,
				whereOperators: { in: true },
				cursor: false,
				native: false,
				index: false
			},
			search: async (_model, _query, options) => {
				((options.where as any).id[1] as number[])[0] = 99;
				return { list: [], more: false, count: 0 };
			},
			index: async () => undefined,
			delete: async () => undefined
		},
		[]
	);

	await wrapped.search(meta, 'needle', { where: { id: ['in', ids] } });

	assert.deepEqual(ids, [1]);
});

test('search middleware snapshots result arrays before returning', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(SearchParityRecord);
	let mapCalls = 0;
	const wrapped = createSearchMiddlewareAdapter(
		{
			kind: 'custom-search-result-array',
			capabilities: { where: false, cursor: false, native: false, index: false },
			search: async () => ({ list: [], more: false }),
			index: async () => undefined,
			delete: async () => undefined
		},
		[
			async () => {
				const list = [{ id: 1, title: 'mapped', body: 'body' }] as any[];
				Object.defineProperty(list, 'map', {
					value() {
						mapCalls++;
						throw new Error('custom search middleware result map should not run');
					}
				});
				return { list, more: false };
			}
		]
	);

	assert.deepEqual((await wrapped.search(meta, 'needle', {})).list, [{ id: 1, title: 'mapped', body: 'body' }]);
	assert.equal(mapCalls, 0);
});

test('search middleware preserves full index payloads for wrapped adapters', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(SearchParityRecord);
	const middlewareArgs: unknown[][] = [];
	let indexed: unknown;
	const wrapped = createSearchMiddlewareAdapter(
		{
			kind: 'custom-full-search',
			capabilities: { where: false, cursor: false, native: false, index: true },
			search: async () => ({ list: [], more: false }),
			index: async (_model, _id, data) => {
				indexed = data;
			},
			delete: async () => undefined
		},
		[
			async (ctx, next) => {
				middlewareArgs.push(ctx.args);
				return await next();
			}
		]
	);

	await wrapped.index(meta, 1, { id: 1, title: 'visible title', body: 'custom full payload' });

	assert.deepEqual(middlewareArgs[0], [1, { id: 1, title: 'visible title', body: 'custom full payload' }]);
	assert.deepEqual(indexed, { id: 1, title: 'visible title', body: 'custom full payload' });
});

test('search middleware keeps datastore ancestor identity-marked partial hits separate from store scope validation', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(RemoteDatastoreSearchRecord);
	const hit = markSearchDocumentIdentity(
		{ id: 7, title: 'middleware partial needle' },
		'remote_datastore_search_record:partial-hit'
	);
	const wrapped = createSearchMiddlewareAdapter(
		{
			kind: 'custom-search-partial-datastore-hit',
			capabilities: { where: false, cursor: false, native: false, index: false },
			search: async () => ({ list: [hit], count: 1, more: false }),
			index: async () => undefined,
			delete: async () => undefined
		},
		[]
	);

	const result = await wrapped.search(meta, 'needle', {});

	assert.deepEqual(result.list, [{ id: 7, title: 'middleware partial needle' }]);
	assert.equal(searchHitDocumentIdentity(result.list[0]), 'remote_datastore_search_record:partial-hit');
});

test('search middleware rejects datastore hit identity markers that disagree with payload ancestors', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(RemoteDatastoreSearchRecord);
	const left = datastoreKey('remote_datastore_search_parent', 10);
	const hit = markSearchDocumentIdentity(
		{ id: 7, parentId: 11, title: 'middleware stale marker' },
		datastoreSearchDocumentIdentity(meta, 7, left)
	);
	const wrapped = createSearchMiddlewareAdapter(
		{
			kind: 'custom-search-stale-datastore-marker',
			capabilities: { where: false, cursor: false, native: false, index: false },
			search: async () => ({ list: [hit], count: 1, more: false }),
			index: async () => undefined,
			delete: async () => undefined
		},
		[]
	);

	await assert.rejects(
		() => wrapped.search(meta, 'needle', {}),
		/search document identity does not match its Datastore payload data/
	);
});

test('search middleware rejects datastore hits without document identity markers', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(RemoteDatastoreSearchRecord);
	const wrapped = createSearchMiddlewareAdapter(
		{
			kind: 'custom-search-unmarked-datastore-hit',
			capabilities: { where: false, cursor: false, native: false, index: false },
			search: async () => ({
				list: [{ id: 7, parentId: 10, title: 'unmarked middleware needle' }],
				count: 1,
				more: false
			}),
			index: async () => undefined,
			delete: async () => undefined
		},
		[]
	);

	await assert.rejects(
		() => wrapped.search(meta, 'needle', {}),
		/missing search document identity/
	);
});

test('search middleware validates index payloads with wrapped searchIndexKind', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = withSearchIndexesForAdapter(
		context.meta(SearchParityRecord),
		'memory',
		'physical-search-kind'
	);
	let middlewareCalls = 0;
	let indexCalls = 0;
	const wrapped = createSearchMiddlewareAdapter(
		{
			kind: 'logical-search-kind',
			searchIndexKind: 'physical-search-kind',
			capabilities: { where: false, cursor: false, native: false, index: true },
			search: async () => ({ list: [], more: false }),
			index: async () => {
				indexCalls++;
			},
			delete: async () => undefined
		},
		[
			async (_ctx, next) => {
				middlewareCalls++;
				return await next();
			}
		]
	);

	await assert.rejects(
		() => wrapped.index(meta, 1, { id: 1, title: new Date('2026-05-24T00:00:00.000Z'), body: 'hidden' }),
		/Unsupported stored data date/
	);
	assert.equal(middlewareCalls, 0);
	assert.equal(indexCalls, 0);
});

test('search index and delete require explicit index capability', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(SearchParityRecord);
	const native = createNativeSearchAdapter(new MemoryStoreAdapter());
	await assert.rejects(
		() => native.index(meta, 1, { id: 1, title: 'native', body: 'body' }),
		/Native search adapter does not support indexing/
	);
	await assert.rejects(() => native.delete(meta, 1), /Native search adapter does not support indexing/);

	let indexed = false;
	let deleted = false;
	const wrapped = createSearchMiddlewareAdapter(
		{
			kind: 'no-index-search',
			capabilities: { where: false, cursor: false, native: false, index: false },
			search: async () => ({ list: [], more: false }),
			index: async () => {
				indexed = true;
			},
			delete: async () => {
				deleted = true;
			}
		},
		[]
	);
	await assert.rejects(
		() => wrapped.index(meta, 1, { id: 1, title: 'blocked', body: 'body' }),
		/Search adapter "no-index-search\+middleware" does not support indexing/
	);
	await assert.rejects(
		() => wrapped.delete(meta, 1),
		/Search adapter "no-index-search\+middleware" does not support indexing/
	);
	assert.equal(indexed, false);
	assert.equal(deleted, false);
});

test('native search adapter rejects malformed wrapped stores', () => {
	assert.throws(
		() => createNativeSearchAdapter(null as any),
		/Native search store must be an adapter object/
	);
	assert.throws(
		() => createNativeSearchAdapter({ kind: 'bad-native' } as any),
		/Native search store.query must be a function/
	);
	assert.throws(
		() =>
			createNativeSearchAdapter({
				kind: 'bad\0native',
				query: async () => ({ list: [] }),
				capabilities: {}
			} as any),
		/Native search store.kind must be a non-empty string/
	);
	assert.throws(
		() =>
			createNativeSearchAdapter({
				kind: 'bad-native',
				query: async () => ({ list: [] }),
				capabilities: []
			} as any),
		/Native search store.capabilities must be a plain object/
	);
	assert.throws(
		() =>
			createNativeSearchAdapter({
				kind: 'bad-native',
				query: async () => ({ list: [] }),
				capabilities: Object.create({ textContains: true })
			} as any),
		/Native search store.capabilities must be a plain object/
	);
	assert.throws(
		() =>
			createNativeSearchAdapter({
				kind: 'bad-native',
				query: async () => ({ list: [] }),
				capabilities: { textContains: 'yes' }
			} as any),
		/Native search store.capabilities.textContains must be a boolean/
	);
	assert.throws(
		() =>
			createNativeSearchAdapter({
				kind: 'typo-capability-native',
				query: async () => ({ list: [] }),
				capabilities: { textContain: true }
			} as any),
		/Native search store\.capabilities contains unknown capability "textContain"/
	);
	let accessorReads = 0;
	const accessorStore = {
		query: async () => ({ list: [] }),
		capabilities: {}
	} as any;
	Object.defineProperty(accessorStore, 'kind', {
		enumerable: true,
		get() {
			accessorReads++;
			return 'accessor-native';
		}
	});
	assert.throws(
		() => createNativeSearchAdapter(accessorStore),
		/Native search store\.kind must be a data property/
	);
	assert.equal(accessorReads, 0);
	assert.throws(
		() =>
			createNativeSearchAdapter({
				kind: 'accessor-capability-native',
				query: async () => ({ list: [] }),
				capabilities: Object.defineProperty({}, 'textContains', {
					enumerable: true,
					get() {
						accessorReads++;
						return true;
					}
				})
			} as any),
		/Native search store\.capabilities\.textContains must be a data property/
	);
	assert.equal(accessorReads, 0);
	assert.throws(
		() =>
			createNativeSearchAdapter({
				kind: 'hidden-capability-native',
				query: async () => ({ list: [] }),
				capabilities: Object.defineProperty({}, 'textContains', {
					enumerable: false,
					value: true
				})
			} as any),
		/Native search store\.capabilities\.textContains must be enumerable/
	);
	const hiddenQueryStore = {
		kind: 'hidden-query-native',
		capabilities: { textContains: true }
	} as any;
	Object.defineProperty(hiddenQueryStore, 'query', {
		enumerable: false,
		value: async () => ({ list: [] })
	});
	assert.throws(
		() => createNativeSearchAdapter(hiddenQueryStore),
		/Native search store\.query must be enumerable/
	);
	Object.defineProperty(Object.prototype, 'kind', {
		value: 'polluted-native',
		configurable: true
	});
	Object.defineProperty(Object.prototype, 'query', {
		value: async () => ({ list: [] }),
		configurable: true
	});
	Object.defineProperty(Object.prototype, 'capabilities', {
		value: { textContains: true },
		configurable: true
	});
	try {
		assert.throws(
			() => createNativeSearchAdapter({} as any),
			/Native search store.kind must be a non-empty string/
		);
	} finally {
		delete (Object.prototype as Record<string, unknown>).kind;
		delete (Object.prototype as Record<string, unknown>).query;
		delete (Object.prototype as Record<string, unknown>).capabilities;
	}
});

test('native search adapter snapshots wrapped store capabilities', async () => {
	const store = new MemoryStoreAdapter();
	const capabilities = { ...store.capabilities, native: false, textContains: false };
	(store as any).capabilities = capabilities;
	const native = createNativeSearchAdapter(store);
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(SearchParityRecord);

	capabilities.native = true;
	capabilities.textContains = true;

	assert.equal(native.capabilities?.native, false);
	await assert.rejects(
		() => native.search(meta, 'needle', {}),
		/Store adapter "memory" does not support native textContains search/
	);
});

test('native search payload bypasses portable textContains requirements', async () => {
	const plans: any[] = [];
	const native = createNativeSearchAdapter({
		kind: 'native-payload-only',
		capabilities: { native: true, textContains: false, cursor: false, or: false },
		query: async (_model: any, plan: any) => {
			plans.push(plan);
			return { list: [{ id: 1, title: 'native result' }], more: false, count: 1 };
		}
	} as any);
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(SearchParityRecord);

	assert.deepEqual(
		(await native.search(meta, 'ignored portable query', { native: { query: { match_all: {} } } })).list,
		[{ id: 1, title: 'native result' }]
	);
	assert.deepEqual(plans[0], {
		where: [],
		or: [],
		sort: [],
		include: [],
		limit: undefined,
		cursor: undefined,
		native: { payload: { query: { match_all: {} } } }
	});
});

test('native search adapter rejects accessor store results without invoking them', async () => {
	let resultReads = 0;
	const native = createNativeSearchAdapter({
		kind: 'native-accessor-result',
		capabilities: { native: true },
		query: async () =>
			Object.defineProperty({ more: false }, 'list', {
				enumerable: true,
				get() {
					resultReads++;
					return [{ id: 1, title: 'hidden' }];
				}
			}) as any
	} as any);
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(SearchParityRecord);

	await assert.rejects(
		() => native.search(meta, 'ignored', { native: { query: { match_all: {} } } }),
		/Native search store "native-accessor-result" query result\.list must be a data property/
	);
	assert.equal(resultReads, 0);

	const hiddenResultNative = createNativeSearchAdapter({
		kind: 'native-hidden-result',
		capabilities: { native: true },
		query: async () =>
			Object.defineProperty({ more: false }, 'list', {
				enumerable: false,
				value: [{ id: 1, title: 'hidden' }]
			}) as any
	} as any);
	await assert.rejects(
		() => hiddenResultNative.search(meta, 'ignored', { native: { query: { match_all: {} } } }),
		/Native search store "native-hidden-result" query result\.list must be enumerable/
	);
});

test('native search adapter snapshots wrapped store query method', async () => {
	const store = new MemoryStoreAdapter();
	await store.seed('search_parity_record', [{ id: 1, title: 'needle title', body: 'body' }]);
	const native = createNativeSearchAdapter(store);
	(store as any).query = async () => {
		throw new Error('mutated native store query should not run');
	};
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(SearchParityRecord);

	assert.deepEqual((await native.search(meta, 'needle', {})).list.map((item: SearchParityData) => item.id), [1]);
});

test('native search adapter validates wrapped query result shape', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(SearchParityRecord);
	const native = createNativeSearchAdapter({
		kind: 'bad-native-result',
		capabilities: { textContains: true },
		query: async () => ({ list: new Array(1), more: false })
	} as any);

	await assert.rejects(
		() => native.search(meta, 'needle', {}),
		/Native search store "bad-native-result" query result\.list\[0\] is missing/
	);
	const extraKeyNative = createNativeSearchAdapter({
		kind: 'extra-result-key-native',
		capabilities: { textContains: true },
		query: async () => ({ list: [{ id: 1, title: 'one' }], more: false, totla: 1 })
	} as any);
	await assert.rejects(
		() => extraKeyNative.search(meta, 'needle', {}),
		/Native search store "extra-result-key-native" query result contains unknown option "totla"/
	);
	let nativeMapCalls = 0;
	const mappedNative = createNativeSearchAdapter({
		kind: 'mapped-native-result',
		capabilities: { textContains: true },
		query: async () => {
			const list = [{ id: 1, title: 'mapped' }] as any[];
			Object.defineProperty(list, 'map', {
				value() {
					nativeMapCalls++;
					throw new Error('custom native result map should not run');
				}
			});
			return { list, more: false };
		}
	} as any);
	assert.deepEqual((await mappedNative.search(meta, 'needle', {})).list, [{ id: 1, title: 'mapped' }]);
	assert.equal(nativeMapCalls, 0);
	let patchedPlan: any;
	const patchedArrayNative = createNativeSearchAdapter({
		kind: 'patched-array-native',
		capabilities: { textContains: true },
		query: async (_model: unknown, plan: unknown) => {
			patchedPlan = plan;
			return { list: [{ id: 1, title: 'patched needle' }], more: false, count: 99, total: 99 };
		}
	} as any);
	const map = Object.getOwnPropertyDescriptor(Array.prototype, 'map')!;
	const some = Object.getOwnPropertyDescriptor(Array.prototype, 'some')!;
	let patchedResult: unknown;
	Object.defineProperty(Array.prototype, 'map', {
		configurable: true,
		value() {
			throw new Error('patched Array.map');
		}
	});
	Object.defineProperty(Array.prototype, 'some', {
		configurable: true,
		value() {
			throw new Error('patched Array.some');
		}
	});
	try {
		patchedResult = await patchedArrayNative.search(meta, 'needle', {});
	} finally {
		Object.defineProperty(Array.prototype, 'map', map);
		Object.defineProperty(Array.prototype, 'some', some);
	}
	assert.deepEqual(patchedResult, {
		list: [{ id: 1, title: 'patched needle' }],
		cursor: undefined,
		more: false,
		count: 1,
		total: 99
	});
	assert.equal(patchedPlan.where[0].field, 'title');
	assert.equal(patchedPlan.where[0].op, 'textContains');
	const missingIdNative = createNativeSearchAdapter({
		kind: 'missing-id-native',
		capabilities: { textContains: true },
		query: async () => ({ list: [{ title: 'missing id' }], more: false })
	} as any);
	await assert.rejects(
		() => missingIdNative.search(meta, 'needle', {}),
		/Native search store "missing-id-native" query result\.list\[0\] is missing id field "id"/
	);
	const badIdNative = createNativeSearchAdapter({
		kind: 'bad-id-native',
		capabilities: { textContains: true },
		query: async () => ({ list: [{ id: {}, title: 'bad id' }], more: false })
	} as any);
	await assert.rejects(
		() => badIdNative.search(meta, 'needle', {}),
		/Native search store "bad-id-native" query result\.list\[0\]\.id must be a string or safe integer/
	);
	const staleCountNative = createNativeSearchAdapter({
		kind: 'stale-count-native',
		capabilities: { textContains: true },
		query: async () => ({
			list: [
				{ id: 1, title: 'one' },
				{ id: 2, title: 'two' }
			],
			more: false,
			count: 999,
			total: 123
		})
	} as any);
	const result = await staleCountNative.search(meta, 'needle', {});
	assert.equal(result.count, 2);
	assert.equal(result.total, 123);
	const malformedCursorlessNative = createNativeSearchAdapter({
		kind: 'malformed-cursorless-native-result',
		capabilities: { textContains: true, cursor: false },
		query: async () => ({
			list: [{ id: 1, title: 'one' }],
			cursor: { native: true },
			more: true
		})
	} as any);
	await assert.rejects(
		() => malformedCursorlessNative.search(meta, 'needle', {}),
		/Native search store "malformed-cursorless-native-result" query result cursor must be a string/
	);
	const cursorlessNative = createNativeSearchAdapter({
		kind: 'cursorless-native-result',
		capabilities: { textContains: true, cursor: false },
		query: async () => ({
			list: [{ id: 1, title: 'one' }],
			cursor: 'next-page',
			more: true
		})
	} as any);
	await assert.rejects(
		() => cursorlessNative.search(meta, 'needle', {}),
		/Store adapter "cursorless-native-result" does not support returning portable cursors/
	);
	const invalidCountCursorlessNative = createNativeSearchAdapter({
		kind: 'invalid-count-cursorless-native-result',
		capabilities: { textContains: true, cursor: false },
		query: async () => ({
			list: [{ id: 1, title: 'one' }],
			count: 1.5,
			cursor: 'next-page',
			more: true
		})
	} as any);
	await assert.rejects(
		() => invalidCountCursorlessNative.search(meta, 'needle', {}),
		/Native search store "invalid-count-cursorless-native-result" query result\.count must be a non-negative safe integer/
	);
	const fractionalTotalNative = createNativeSearchAdapter({
		kind: 'fractional-total-native',
		capabilities: { textContains: true },
		query: async () => ({ list: [], more: false, total: 1.5 })
	} as any);
	await assert.rejects(
		() => fractionalTotalNative.search(meta, 'needle', {}),
		/Native search store "fractional-total-native" query result\.total must be a non-negative safe integer/
	);
	const lowTotalNative = createNativeSearchAdapter({
		kind: 'low-total-native',
		capabilities: { textContains: true },
		query: async () => ({ list: [{ id: 1, title: 'one' }], more: false, total: 0 })
	} as any);
	await assert.rejects(
		() => lowTotalNative.search(meta, 'needle', {}),
		/Native search store "low-total-native" query result\.total cannot be smaller than result\.list length/
	);
});

test('remote search adapters reject malformed factory options', async () => {
	await assert.rejects(
		() => createAlgoliaSearchAdapter(null as any),
		/Algolia adapter options must be an object/
	);
	await assert.rejects(
		() => createAlgoliaSearchAdapter(Object.assign(Object.create({}), {
			client: {
				searchSingleIndex: async () => ({ hits: [], nbHits: 0, nbPages: 0, page: 0 }),
				saveObject: async () => undefined,
				deleteObject: async () => undefined
			}
		}) as any),
		/Algolia adapter options must be a plain object/
	);
	await assert.rejects(
		() => createAlgoliaSearchAdapter({} as any),
		/Algolia adapter appId must be a non-empty string/
	);
	await assert.rejects(
		() => createAlgoliaSearchAdapter({ appId: 'app' } as any),
		/Algolia adapter apiKey must be a non-empty string/
	);
	await assert.rejects(
		() => createAlgoliaSearchAdapter({ appId: '', apiKey: 'key' } as any),
		/Algolia adapter appId must be a non-empty string/
	);
		await assert.rejects(
			() => createAlgoliaSearchAdapter({ client: {} } as any),
			/client.searchSingleIndex must be a function/
		);
		await assert.rejects(
			() =>
				createAlgoliaSearchAdapter({
					client: {
						searchSingleIndex: async () => ({ hits: [], nbHits: 0, nbPages: 0, page: 0 }),
						saveObject: async () => undefined,
						deleteObject: async () => undefined
					},
					appId: 'app',
					apiKey: 'key'
				}),
			/Algolia adapter options cannot combine client with appId or apiKey/
		);
		const hiddenAlgoliaClient = {
			saveObject: async () => undefined,
			deleteObject: async () => undefined
		} as any;
		Object.defineProperty(hiddenAlgoliaClient, 'searchSingleIndex', {
			enumerable: false,
			value: async () => ({ hits: [], nbHits: 0, nbPages: 0, page: 0 })
		});
		await assert.rejects(
			() => createAlgoliaSearchAdapter({ client: hiddenAlgoliaClient } as any),
			/Algolia adapter client\.searchSingleIndex must be enumerable/
		);
		await assert.rejects(
			() =>
				createAlgoliaSearchAdapter({
				client: {
					searchSingleIndex: async () => ({ hits: [], nbHits: 0, nbPages: 0, page: 0 }),
					saveObject: async () => undefined,
					deleteObject: async () => undefined
				},
				indexPrefix: 1 as any
			}),
		/indexPrefix must be a string/
	);
	const algoliaHiddenOptions = Object.defineProperty(
		{
			client: {
				searchSingleIndex: async () => ({ hits: [], nbHits: 0, nbPages: 0, page: 0 }),
				saveObject: async () => undefined,
				deleteObject: async () => undefined
			}
		},
		'indexPrefix',
		{ enumerable: false, value: 'hidden-prefix' }
	);
	await assert.rejects(
		() => createAlgoliaSearchAdapter(algoliaHiddenOptions as any),
		/Algolia adapter option "indexPrefix" must be enumerable/
	);
	await assert.rejects(
		() => createElasticsearchSearchAdapter(null as any),
		/Elasticsearch adapter options must be an object/
	);
	await assert.rejects(
		() => createElasticsearchSearchAdapter(Object.assign(Object.create({}), {
			client: {
				search: async () => ({ hits: { hits: [] } }),
				index: async () => undefined,
				delete: async () => undefined
			}
		}) as any),
		/Elasticsearch adapter options must be a plain object/
	);
	await assert.rejects(
		() => createElasticsearchSearchAdapter({} as any),
		/Elasticsearch adapter node must be a non-empty string/
	);
	await assert.rejects(
		() => createElasticsearchSearchAdapter({ node: '' } as any),
		/Elasticsearch adapter node must be a non-empty string/
	);
		await assert.rejects(
			() => createElasticsearchSearchAdapter({ client: { search: async () => ({ hits: { hits: [] } }) } } as any),
			/client.index must be a function/
		);
		await assert.rejects(
			() =>
				createElasticsearchSearchAdapter({
					client: {
						search: async () => ({ hits: { hits: [] } }),
						index: async () => undefined,
						delete: async () => undefined
					},
					node: 'http://localhost:9200'
				}),
			/Elasticsearch adapter options cannot combine client and node/
		);
		const hiddenElasticsearchClient = {
			index: async () => undefined,
			delete: async () => undefined
		} as any;
		Object.defineProperty(hiddenElasticsearchClient, 'search', {
			enumerable: false,
			value: async () => ({ hits: { hits: [] } })
		});
		await assert.rejects(
			() => createElasticsearchSearchAdapter({ client: hiddenElasticsearchClient } as any),
			/Elasticsearch adapter client\.search must be enumerable/
		);
		await assert.rejects(
			() =>
				createElasticsearchSearchAdapter({
				client: {
					search: async () => ({ hits: { hits: [] } }),
					index: async () => undefined,
					delete: async () => undefined
				},
				node: 1 as any
			}),
		/node must be a string/
	);
	const elasticsearchHiddenOptions = Object.defineProperty(
		{
			client: {
				search: async () => ({ hits: { hits: [] } }),
				index: async () => undefined,
				delete: async () => undefined
			}
		},
		'node',
		{ enumerable: false, value: 'http://localhost:9200' }
	);
	await assert.rejects(
		() => createElasticsearchSearchAdapter(elasticsearchHiddenOptions as any),
		/Elasticsearch adapter option "node" must be enumerable/
	);
	Object.defineProperties(Object.prototype, {
		searchSingleIndex: { value: async () => ({ hits: [], nbHits: 0, nbPages: 0, page: 0 }), configurable: true },
		saveObject: { value: async () => undefined, configurable: true },
		deleteObject: { value: async () => undefined, configurable: true },
		search: { value: async () => ({ hits: { hits: [] } }), configurable: true },
		index: { value: async () => undefined, configurable: true },
		delete: { value: async () => undefined, configurable: true }
	});
	try {
		await assert.rejects(
			() => createAlgoliaSearchAdapter({ client: {} } as any),
			/client.searchSingleIndex must be a function/
		);
		await assert.rejects(
			() => createElasticsearchSearchAdapter({ client: {} } as any),
			/client.search must be a function/
		);
	} finally {
		delete (Object.prototype as Record<string, unknown>).searchSingleIndex;
		delete (Object.prototype as Record<string, unknown>).saveObject;
		delete (Object.prototype as Record<string, unknown>).deleteObject;
		delete (Object.prototype as Record<string, unknown>).search;
		delete (Object.prototype as Record<string, unknown>).index;
		delete (Object.prototype as Record<string, unknown>).delete;
	}
});

test('remote search adapters snapshot client methods at creation', async () => {
	const meta = createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(SearchParityRecord);
	const algoliaCalls: string[] = [];
	const algoliaClient = {
		searchSingleIndex: async () => {
			algoliaCalls.push('search');
			return { hits: [], nbHits: 0, nbPages: 0, page: 0 };
		},
		saveObject: async () => {
			algoliaCalls.push('save');
		},
		deleteObject: async () => {
			algoliaCalls.push('delete');
		}
	};
	const algolia = await createAlgoliaSearchAdapter({ client: algoliaClient });
	algoliaClient.searchSingleIndex = async () => {
		throw new Error('mutated algolia search should not run');
	};
	algoliaClient.saveObject = async () => {
		throw new Error('mutated algolia save should not run');
	};
	algoliaClient.deleteObject = async () => {
		throw new Error('mutated algolia delete should not run');
	};
	await algolia.search(meta, 'safe', {});
	await algolia.index(meta, 1, { id: 1, title: 'one', body: 'body' });
	await algolia.delete(meta, 1);
	assert.deepEqual(algoliaCalls, ['search', 'save', 'delete']);

	const elasticCalls: string[] = [];
	const elasticClient = {
		search: async () => {
			elasticCalls.push('search');
			return { hits: { hits: [], total: { value: 0 } } };
		},
		index: async () => {
			elasticCalls.push('index');
		},
		delete: async () => {
			elasticCalls.push('delete');
		}
	};
	const elastic = await createElasticsearchSearchAdapter({ client: elasticClient });
	elasticClient.search = async () => {
		throw new Error('mutated elasticsearch search should not run');
	};
	elasticClient.index = async () => {
		throw new Error('mutated elasticsearch index should not run');
	};
	elasticClient.delete = async () => {
		throw new Error('mutated elasticsearch delete should not run');
	};
	await elastic.search(meta, 'safe', {});
	await elastic.index(meta, 1, { id: 1, title: 'one', body: 'body' });
	await elastic.delete(meta, 1);
	assert.deepEqual(elasticCalls, ['search', 'index', 'delete']);
});

test('search adapter metadata and allowlists use captured Set intrinsics', async () => {
	const meta = createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(SearchParityRecord);
	const algoliaRequests: any[] = [];
	const algolia = await createAlgoliaSearchAdapter({
		client: {
			searchSingleIndex: async (request: any) => {
				algoliaRequests.push(request);
				return { hits: [], nbHits: 0, nbPages: 0, page: 0 };
			},
			saveObject: async () => undefined,
			deleteObject: async () => undefined
		}
	});
	const elasticRequests: any[] = [];
	const elastic = await createElasticsearchSearchAdapter({
		client: {
			search: async (request: any) => {
				elasticRequests.push(request);
				return { hits: { hits: [], total: { value: 0 } } };
			},
			index: async () => undefined,
			delete: async () => undefined
		}
	});

	let algoliaResult: unknown;
	let elasticResult: unknown;
	let algoliaOptionError: unknown;
	let elasticOptionError: unknown;
	let nativeCapabilityError: unknown;
	let nativeResultError: unknown;
	const setHas = Object.getOwnPropertyDescriptor(Set.prototype, 'has')!;
	const setAdd = Object.getOwnPropertyDescriptor(Set.prototype, 'add')!;
	Object.defineProperties(Set.prototype, {
		has: {
			configurable: true,
			value() {
				throw new Error('patched Set.has');
			}
		},
		add: {
			configurable: true,
			value() {
				throw new Error('patched Set.add');
			}
		}
	});
	try {
		algoliaResult = await algolia.search(meta, 'safe', {});
		elasticResult = await elastic.search(meta, 'safe', {});
		try {
			await createAlgoliaSearchAdapter({ indexPrefixes: 'bad' } as any);
		} catch (error) {
			algoliaOptionError = error;
		}
		try {
			await createElasticsearchSearchAdapter({ nodes: 'bad' } as any);
		} catch (error) {
			elasticOptionError = error;
		}
		try {
			createNativeSearchAdapter({
				kind: 'set-intrinsic-capability-native',
				capabilities: { textContain: true },
				query: async () => ({ list: [], more: false })
			} as any);
		} catch (error) {
			nativeCapabilityError = error;
		}
		const native = createNativeSearchAdapter({
			kind: 'set-intrinsic-result-native',
			capabilities: { textContains: true },
			query: async () => ({ list: [{ id: 1, title: 'one' }], more: false, totla: 1 })
		} as any);
		try {
			await native.search(meta, 'safe', {});
		} catch (error) {
			nativeResultError = error;
		}
	} finally {
		Object.defineProperty(Set.prototype, 'has', setHas);
		Object.defineProperty(Set.prototype, 'add', setAdd);
	}

	assert.deepEqual(algoliaResult, { list: [], cursor: undefined, more: false, count: 0, total: 0 });
	assert.deepEqual(elasticResult, { list: [], count: 0, total: 0, more: false });
	assert.deepEqual(Array.from(algoliaRequests[0].searchParams.restrictSearchableAttributes), ['title']);
	assert.deepEqual(Array.from(algoliaRequests[0].searchParams.attributesToRetrieve), ['id', 'title']);
	assert.deepEqual(Array.from(elasticRequests[0].body.query.multi_match.fields), ['title']);
	assert.deepEqual(Array.from(elasticRequests[0].body._source), ['id', 'title']);
	assert.match((algoliaOptionError as Error).message, /Algolia adapter options contains unknown option "indexPrefixes"/);
	assert.match((elasticOptionError as Error).message, /Elasticsearch adapter options contains unknown option "nodes"/);
	assert.match(
		(nativeCapabilityError as Error).message,
		/Native search store\.capabilities contains unknown capability "textContain"/
	);
	assert.match(
		(nativeResultError as Error).message,
		/Native search store "set-intrinsic-result-native" query result contains unknown option "totla"/
	);
});

test('search indexing uses adapter-specific declared fields only', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(SearchAffinityRecord);
	const memory = new MemorySearchAdapter();

	await memory.index(meta, 1, { id: 1, title: 'visible title', body: 'algolia only body' });
	assert.deepEqual((await memory.search(meta, 'visible', {})).list, [{ id: 1, title: 'visible title' }]);
	assert.deepEqual((await memory.search(meta, 'algolia', {})).list, []);
	await assert.rejects(
		() => memory.index(meta, 1, { id: '1', title: 'mismatched id', body: 'body' }),
		/search document id must match/
	);
	await assert.rejects(
		() => memory.index(meta, 2, { id: { nested: 2 }, title: 'invalid id', body: 'body' } as any),
		/search document id/
	);
	await assert.rejects(
		() => memory.index(meta, 2, { id: 2, title: new Date('2026-05-14T00:00:00.000Z') as any, body: 'body' }),
		/Declare a date field type/
	);
	await assert.rejects(
		() => memory.index(meta, 2, { id: 2, title: new Uint8Array([1, 2, 3]) as any, body: 'body' }),
		/search document.*binary/
	);
});

test('direct remote search adapters do not inherit another default search adapter fields', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(SearchRemoteAffinityRecord);
	const algoliaCalls: any[] = [];
	const algolia = await createAlgoliaSearchAdapter({
		client: {
			searchSingleIndex: async (payload: any) => {
				algoliaCalls.push({ op: 'search', payload });
				return { hits: [], nbHits: 0, nbPages: 0, page: 0 };
			},
			saveObject: async (payload: any) => algoliaCalls.push({ op: 'index', payload }),
			deleteObject: async () => undefined
		}
	});
	const elasticCalls: any[] = [];
	const elastic = await createElasticsearchSearchAdapter({
		client: {
			search: async (payload: any) => {
				elasticCalls.push({ op: 'search', payload });
				return { hits: { hits: [], total: { value: 0 } } };
			},
			index: async (payload: any) => elasticCalls.push({ op: 'index', payload }),
			delete: async () => undefined
		}
	});

	await algolia.index(meta, 1, { id: 1, title: 'memory title', body: 'remote body' });
	await algolia.search(meta, 'remote', {});
	assert.equal(Object.getPrototypeOf(algoliaCalls[0].payload.body), null);
	assert.deepEqual({ ...algoliaCalls[0].payload.body }, {
		id: 1,
		body: 'remote body',
		objectID: 'search_remote_affinity_record:number:1'
	});
	assert.equal('title' in algoliaCalls[0].payload.body, false);
	assert.deepEqual(Array.from(algoliaCalls[1].payload.searchParams.restrictSearchableAttributes), ['body']);
	assert.deepEqual((await algolia.syncSchema!([meta])).changes, [
		{
			type: 'create-search-index',
			target: 'search_remote_affinity_record',
			name: 'algolia_body',
			fields: ['body']
		}
	]);

	await elastic.index(meta, 1, { id: 1, title: 'memory title', body: 'remote body' });
	await elastic.search(meta, 'remote', {});
	assert.equal(Object.getPrototypeOf(elasticCalls[0].payload.document), null);
	assert.deepEqual({ ...elasticCalls[0].payload.document }, { id: 1, body: 'remote body' });
	assert.equal('title' in elasticCalls[0].payload.document, false);
	assert.deepEqual(Array.from(elasticCalls[1].payload.body.query.multi_match.fields), ['body']);
	assert.deepEqual((await elastic.syncSchema!([meta])).changes, [
		{
			type: 'create-search-index',
			target: 'search_remote_affinity_record',
			name: 'elastic_body',
			fields: ['body']
		}
	]);
});

test('elasticsearch syncSchema validates physical index names', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(SearchRemoteAffinityRecord);
	const client = {
		search: async () => ({ hits: { hits: [], total: { value: 0 } } }),
		index: async () => undefined,
		delete: async () => undefined
	};
	const elastic = await createElasticsearchSearchAdapter({ client });

	await assert.rejects(
		() => elastic.syncSchema!([{ ...meta, name: 'Search_remote_affinity_record' }]),
		/Elasticsearch index name "Search_remote_affinity_record" is not allowed/
	);
	await assert.rejects(
		() => createElasticsearchSearchAdapter({ client, indexPrefix: 'Bad_' }),
		/Elasticsearch index name "Bad_active_ts_model" is not allowed/
	);
});

test('algolia syncSchema validates physical index names', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(SearchRemoteAffinityRecord);
	const client = {
		searchSingleIndex: async () => ({ hits: [] }),
		saveObject: async () => undefined,
		deleteObject: async () => undefined
	};
	const algolia = await createAlgoliaSearchAdapter({
		client,
		indexPrefix: 'a'.repeat(240)
	});

	await assert.rejects(
		() => algolia.syncSchema!([meta]),
		/Algolia index name .*too long/
	);
});

test('remote search schema apply hooks validate direct options', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(SearchRemoteAffinityRecord);
	const algolia = await createAlgoliaSearchAdapter({
		client: {
			searchSingleIndex: async () => ({ hits: [] }),
			saveObject: async () => undefined,
			deleteObject: async () => undefined
		}
	});
	const elastic = await createElasticsearchSearchAdapter({
		client: {
			search: async () => ({ hits: { hits: [], total: { value: 0 } } }),
			index: async () => undefined,
			delete: async () => undefined
		}
	});

	assert.equal((await algolia.schema!.apply([meta], { mode: 'safe' })).adapter, 'algolia');
	assert.equal((await elastic.schema!.apply([meta], { mode: 'safe' })).adapter, 'elasticsearch');
	await assert.rejects(
		() => algolia.schema!.apply([meta], { mode: 'unsafe' } as any),
		/Algolia schema apply options\.mode must be "safe"/
	);
	await assert.rejects(
		() => elastic.schema!.apply([meta], { extra: true } as any),
		/Elasticsearch schema apply options contains unknown option "extra"/
	);
});

test('search indexes tagged with registered adapter aliases project declared fields', async () => {
	const memory = new MemorySearchAdapter();
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { search: memory },
		defaultSearch: 'search'
	});
	const Record = SearchAliasRecord.use(context) as unknown as typeof SearchAliasRecord;
	const meta = context.meta(SearchAliasRecord);
	const routedMeta = withSearchIndexesForAdapter(meta, 'search', memory.kind);

	await memory.index(routedMeta, 1, { id: 1, title: 'needle title', body: 'hidden body' });

	assert.deepEqual(memory.snapshot('search_alias_record'), [{ id: 1, title: 'needle title' }]);
	assert.deepEqual((await memory.search(routedMeta, 'needle', {})).list, [{ id: 1, title: 'needle title' }]);
	assert.deepEqual((await Record.search('needle').load()).list.map((item) => item.data), [
		{ id: 1, title: 'needle title' }
	]);
});

test('registered search adapter kind is snapshotted for projection routing', async () => {
	let seenFields: string[] = [];
	const adapter: SearchAdapter = {
		kind: 'memory',
		capabilities: {},
		search: async (model) => {
			seenFields = model.searchIndexes.flatMap((index) => index.fields);
			return {
				list: [{ id: 1, title: 'needle title', body: 'needle body' }],
				more: false
			};
		},
		index: async () => undefined,
		delete: async () => undefined
	};
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory: adapter }
	});
	const Record = SearchAffinityRecord.use(context) as unknown as typeof SearchAffinityRecord;

	adapter.kind = 'algolia';
	assert.equal(adapter.kind, 'algolia');
	assert.equal(context.searchAdapter('memory').kind, 'memory');

	const result = await Record.search('needle').load();
	assert.deepEqual(seenFields, ['title']);
	assert.deepEqual(result.list.map((item) => item.data), [{ id: 1, title: 'needle title' }]);
});

test('schemaPlan includes alias-tagged built-in search indexes', async () => {
	const algolia = await createAlgoliaSearchAdapter({
		client: {
			searchSingleIndex: async () => ({ hits: [] }),
			saveObject: async () => undefined,
			deleteObject: async () => undefined
		}
	});
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { search: algolia },
		defaultSearch: 'search'
	});

	const plans = await context.schemaPlan([SearchAliasRecord]);
	const algoliaPlan = plans.find((plan) => plan.adapter === 'algolia');
	const directPlan = await context.searchAdapter('search').schema!.plan([context.meta(SearchAliasRecord)]);
	const directApply = await context.searchAdapter('search').schema!.apply([context.meta(SearchAliasRecord)], { mode: 'safe' });
	const directSync = await context.searchAdapter('search').syncSchema!([context.meta(SearchAliasRecord)]);

	const expectedPlan = {
		adapter: 'algolia',
		status: 'manual',
		note: 'Algolia search index settings must be reviewed and applied with Algolia tooling.',
		changes: [
			{
				type: 'create-search-index',
				target: 'search_alias_record',
				name: 'alias_title',
				fields: ['title']
			}
		]
	};
	assert.deepEqual(algoliaPlan, { ...expectedPlan, route: 'search' });
	assert.deepEqual(directPlan, expectedPlan);
	assert.deepEqual(directApply, expectedPlan);
	assert.deepEqual(directSync, expectedPlan);
});

test('search index metadata rejects overlapping projected fields', () => {
	assert.throws(
		() =>
			defineModel<{ id: number; profile: unknown }>({
				name: 'search_projection_collision_record',
				search: 'memory'
			})
				.id('id')
				.search('memory', ['profile', 'profile.label'])
				.attach(SearchProjectionCollisionRecord),
		/search fields cannot include both "profile" and nested field "profile\.label"/
	);

	assert.throws(
		() =>
			defineModel<{ id: number }>({
				name: 'search_id_projection_collision_record',
				search: 'memory'
			})
				.id('id')
				.search('memory', ['id.value'])
				.attach(SearchIdProjectionCollisionRecord),
		/search index "id_value" fields cannot include both "id" and nested field "id\.value"/
	);
});

test('direct search adapter metadata rejects overlapping projected fields', async () => {
	const memory = new MemorySearchAdapter();
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory },
		defaultSearch: 'memory'
	});
	const meta = context.meta(SearchParityRecord);
	const badMeta = {
		...meta,
		searchIndexes: [{ name: 'bad_projection', fields: ['title', 'title.label'] }]
	} as ResolvedModelMeta;

	await assert.rejects(
		() => memory.index(badMeta, 1, { id: 1, title: { label: 'needle' }, body: 'body' }),
		/memory search model metadata\.searchIndexes\[0\]\.fields cannot include both "title" and nested field "title\.label"/
	);
});

test('search schema plans reject Datastore ancestor field overlaps returned by adapters', async () => {
	const overlappingPlan = {
		adapter: 'schema-overlap-search',
		changes: [
			{
				type: 'create-search-index' as const,
				target: 'remote_datastore_search_record',
				name: 'bad_parent_projection',
				fields: ['parentId.child']
			}
		]
	};
	const search: SearchAdapter = {
		kind: 'schema-overlap-search',
		capabilities: { index: true },
		search: async () => ({ list: [], more: false }),
		index: async () => undefined,
		delete: async () => undefined,
		schema: {
			plan: async () => overlappingPlan,
			apply: async () => overlappingPlan
		}
	};
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { schema: search },
		defaultSearch: 'schema'
	});
	const meta = context.meta(RemoteDatastoreSearchRecord);

	await assert.rejects(
		() => context.searchAdapter('schema').schema!.plan([meta]),
		/Search adapter "schema" schema plan\.changes\[0\]\.fields cannot include both "parentId" and nested field "parentId\.child"/
	);
	await assert.rejects(
		() => context.searchAdapter('schema').schema!.apply([meta], { mode: 'safe' }),
		/Search adapter "schema" schema apply plan\.changes\[0\]\.fields cannot include both "parentId" and nested field "parentId\.child"/
	);
});

test('memory search declares and applies where operator capabilities', async () => {
	const memory = new MemorySearchAdapter();
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory },
		defaultSearch: 'memory'
	});
	const Record = SearchParityRecord.use(context) as unknown as typeof SearchParityRecord;
	const meta = context.meta(SearchParityRecord);
	await memory.index(meta, 1, { id: 1, title: 'needle one', body: 'hidden' });
	await memory.index(meta, 2, { id: 2, title: 'needle two', body: 'hidden' });

	assert.deepEqual((await Record.search('needle').where({ id: ['>=', 2] as any }).load()).list.map((item) => item.data.id), [2]);
	assert.deepEqual((await Record.search('needle').where({ title: ['startsWith', 'needle t'] as any }).load()).list.map((item) => item.data.id), [2]);
	assert.deepEqual((await Record.search('needle').where({ body: ['isNull'] as any }).load()).list.map((item) => item.data.id), [1, 2]);
	assert.deepEqual((await Record.search('needle').where({ title: ['isNotNull'] as any }).load()).list.map((item) => item.data.id), [1, 2]);
	assert.deepEqual(
		(await Record.search('needle')
			.where({ title: ['startsWith', 'needle'] as any })
			.where({ id: ['>=', 2] as any })
			.load()).list.map((item) => item.data.id),
		[2]
	);
	assert.throws(
		() => Record.search('needle').where({ id: ['>=', 1] as any }).where({ id: ['<=', 2] as any }),
		/Search where cannot merge multiple filters for field "id"/
	);
});

test('search builder returns partial models for projected search documents', async () => {
	const memory = new MemorySearchAdapter();
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory },
		defaultSearch: 'memory'
	});
	const Record = SearchParityRecord.use(context) as unknown as typeof SearchParityRecord;
	const meta = context.meta(SearchParityRecord);
	await memory.index(meta, 1, { id: 1, title: 'partial hit', body: 'not indexed' });

	const result = await Record.search('partial').load();
	assert.deepEqual(result.list[0].data, { id: 1, title: 'partial hit' });
	await assert.rejects(() => (result.list[0] as any).save(), /partial .*instance/);
});

test('search builder projects custom adapter hits to declared fields', async () => {
	const leakingSearch: SearchAdapter = {
		kind: 'custom',
		capabilities: {
			where: false,
			nestedFields: true,
			numericComparisons: false,
			nullOperators: false,
			cursor: false,
			native: false
		},
		async search() {
			return {
				list: [{ id: 1, title: 'public hit', body: 'secret body' }],
				more: false,
				count: 1
			};
		},
		async index() {},
		async delete() {}
	};
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory: leakingSearch },
		defaultSearch: 'memory'
	});
	const Record = SearchParityRecord.use(context) as unknown as typeof SearchParityRecord;

	const result = await Record.search('public').load();

	assert.deepEqual(result.list[0].data, { id: 1, title: 'public hit' });
});

test('search builder projects legacy flat dotted hit fields', async () => {
	const flatDottedSearch: SearchAdapter = {
		kind: 'custom',
		capabilities: {
			where: false,
			nestedFields: true,
			numericComparisons: false,
			nullOperators: false,
			cursor: false,
			native: false
		},
		async search() {
			return {
				list: [{ id: 1, 'profile.bio': 'flat bio', ignored: 'hidden' }],
				more: false,
				count: 1
			};
		},
		async index() {},
		async delete() {}
	};
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory: flatDottedSearch },
		defaultSearch: 'memory'
	});
	const Record = FlatDottedSearchRecord.use(context) as unknown as typeof FlatDottedSearchRecord;

	const result = await Record.search('bio').load();

	assert.deepEqual(result.list[0].data, { id: 1, profile: { bio: 'flat bio' } });
});

test('explicit search adapter selection takes precedence over query planner routes', async () => {
	const calls: string[] = [];
	const adapter = (kind: string, title: string): SearchAdapter => ({
		kind,
		capabilities: {
			where: false,
			nestedFields: true,
			numericComparisons: false,
			nullOperators: false,
			cursor: false,
			native: false
		},
		async search() {
			calls.push(kind);
			return { list: [{ id: 1, title }], more: false, count: 1 };
		},
		async index() {},
		async delete() {}
	});
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: {
			memory: adapter('memory', 'selected'),
			native: adapter('native', 'planned')
		},
		defaultSearch: 'memory',
		queryPlanner: {
			routeSearch: () => 'native'
		}
	});
	const Record = SearchParityRecord.use(context) as unknown as typeof SearchParityRecord;

	const result = await Record.search('query').using('memory').load();

	assert.deepEqual(calls, ['memory']);
	assert.deepEqual(result.list[0].data, { id: 1, title: 'selected' });
});

test('search where filters compare against projected documents instead of storage codecs', async () => {
	const memory = new MemorySearchAdapter();
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory },
		defaultSearch: 'memory'
	});
	const Record = SearchCodecRecord.use(context) as unknown as typeof SearchCodecRecord;
	const meta = context.meta(SearchCodecRecord);
	await memory.index(meta, 1, { id: 1, token: 'alpha' });

	const result = await Record.search('alpha').where({ token: 'alpha' }).load();

	assert.deepEqual(result.list.map((item) => item.data), [{ id: 1, token: 'alpha' }]);
});

test('search partial hits skip store field codec decoding', async () => {
	const memory = new MemorySearchAdapter();
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory },
		defaultSearch: 'memory'
	});
	const Record = SearchCodecRecord.use(context) as unknown as typeof SearchCodecRecord;
	const meta = context.meta(SearchCodecRecord);
	await memory.index(meta, 1, { id: 1, token: 'alpha' });

	const [hit] = (await Record.search('alpha').load()).list;
	assert.deepEqual(hit.data, { id: 1, token: 'alpha' });
	assert.throws(
		() => context.instantiate(SearchCodecRecord, { id: 2, token: 'alpha' }, { partial: true }),
		/expected stored token/
	);
	assert.deepEqual(
		context.instantiate(SearchCodecRecord, { id: 2, token: 'alpha' }, { partial: true, fieldCodecs: false })?.data,
		{ id: 2, token: 'alpha' }
	);
	assert.throws(
		() => context.validateRead(meta, { id: 3, token: 'stored:ok' }, { fieldCodecs: 'no' } as any),
		/read validation options\.fieldCodecs must be a boolean/
	);
	assert.throws(
		() => context.validateRead(meta, { id: 3, token: 'stored:ok' }, { fieldCodecs: false } as any),
		/read validation options\.fieldCodecs can only be disabled for partial projection reads/
	);
});

test('search builder rejects hits without model ids', async () => {
	const search = {
		kind: 'missing-id-search',
		capabilities: { where: false, cursor: false, native: false, index: false },
		search: async () => ({ list: [{ title: 'missing id' }], more: false, count: 1 }),
		index: async () => undefined,
		delete: async () => undefined
	};
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory: search }
	});
	const Record = SearchParityRecord.use(context) as unknown as typeof SearchParityRecord;

	await assert.rejects(() => Record.search('missing').load(), /missing id field "id"/);
});

test('search builder rejects duplicate hits without include reloads', async () => {
	const search = {
		kind: 'duplicate-id-search',
		capabilities: { where: false, cursor: false, native: false, index: false },
		search: async () => ({
			list: [
				{ id: 1, title: 'duplicate id' },
				{ id: 1, title: 'duplicate id again' }
			],
			more: false,
			count: 2
		}),
		index: async () => undefined,
		delete: async () => undefined
	};
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory: search }
	});
	const Record = SearchParityRecord.use(context) as unknown as typeof SearchParityRecord;

	await assert.rejects(
		() => Record.search('duplicate').load(),
		/Search result for search_parity_record contains duplicate id "1"/
	);
});

test('search indexing rejects non-object documents before projection', async () => {
	const memory = new MemorySearchAdapter();
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(SearchParityRecord);

	await assert.rejects(
		() => memory.index(meta, 1, null as any),
		/search_parity_record search document input must be a plain object/
	);
	await assert.rejects(
		() => memory.index(meta, 1, [] as any),
		/search_parity_record search document input must be a plain object/
	);
	assert.deepEqual(memory.snapshot('search_parity_record'), []);
});

test('search indexing snapshots projected array values without custom iterators', async () => {
	const memory = new MemorySearchAdapter();
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const meta = context.meta(SearchArrayRecord);
	let forEachCalls = 0;
	const tags = ['alpha', 'beta'] as any[];
	Object.defineProperty(tags, 'forEach', {
		value() {
			forEachCalls++;
			throw new Error('custom search document array forEach should not run');
		}
	});

	await assert.rejects(
		() => memory.index(meta, 1, { id: 1, tags }),
		/Unsupported data value at "\$\.tags" cannot contain non-index array property "forEach"/
	);

	assert.equal(forEachCalls, 0);
	assert.deepEqual(memory.snapshot('search_array_regression_record'), []);

	const hiddenDocument = { id: 2, tags: ['alpha'] };
	Object.defineProperty(hiddenDocument, 'hidden', { value: 'secret', enumerable: false });
	await assert.rejects(
		() => memory.index(meta, 2, hiddenDocument),
		/Unsupported non-enumerable data key "\$\.hidden"/
	);
	assert.deepEqual(memory.snapshot('search_array_regression_record'), []);
});

test('search builder include reloads full rows before relation preloading', async () => {
	const store = new MemoryStoreAdapter();
	const memory = new MemorySearchAdapter();
	const context = createActiveTs({
		stores: { default: store },
		search: { memory },
		defaultSearch: 'memory'
	});
	const Article = SearchIncludeArticle.use(context) as unknown as typeof SearchIncludeArticle;
	const meta = context.meta(SearchIncludeArticle);
	await store.seed(context.meta(SearchIncludeAuthor), [{ id: 10, name: 'Ada' }]);
	await store.seed(meta, [{ id: 1, authorId: 10, title: 'searchable title', body: 'full body' }]);
	await memory.index(meta, 1, { id: 1, authorId: 10, title: 'searchable title', body: 'hidden from index' });
	await memory.index(meta, 2, { id: 2, authorId: 10, title: 'searchable stale', body: 'hidden from index' });

	const originalFrom = Array.from;
	let result: any;
	Object.defineProperty(Array, 'from', {
		configurable: true,
		value() {
			throw new Error('patched Array.from');
		}
	});
	try {
		result = await Article.search('searchable').include('author').load();
	} finally {
		Object.defineProperty(Array, 'from', { configurable: true, value: originalFrom });
	}
	assert.equal(result.count, 1);
	assert.equal(result.list.length, 1);
	assert.equal(isPartialModel(result.list[0]), false);
	assert.deepEqual(result.list[0].data, { id: 1, authorId: 10, title: 'searchable title', body: 'full body' });
	const author = await (result.list[0] as SearchIncludeArticle).ref<SearchIncludeAuthor>('author');
	assert.equal((author as SearchIncludeAuthor).data.name, 'Ada');
});

test('search builder snapshots include specs and adapter route when load starts', async () => {
	const store = new MemoryStoreAdapter();
	const memory = new MemorySearchAdapter();
	const empty: SearchAdapter = {
		kind: 'empty',
		capabilities: { where: false, cursor: false, native: false, index: false },
		async search() {
			return { list: [], more: false, count: 0 };
		},
		async index() {},
		async delete() {}
	};
	const context = createActiveTs({
		stores: { default: store },
		search: { memory, empty },
		defaultSearch: 'memory'
	});
	const Article = SearchIncludeArticle.use(context) as unknown as typeof SearchIncludeArticle;
	const meta = context.meta(SearchIncludeArticle);
	await store.seed(context.meta(SearchIncludeAuthor), [{ id: 10, name: 'Ada' }]);
	await store.seed(meta, [{ id: 1, authorId: 10, title: 'searchable title', body: 'full body' }]);
	await memory.index(meta, 1, { id: 1, authorId: 10, title: 'searchable title', body: 'hidden from index' });

	const builder = Article.search('searchable').using('memory');
	const pending = builder.load();
	builder.using('empty').include('author');
	const result = await pending;

	assert.equal(result.count, 1);
	assert.equal(isPartialModel(result.list[0]), true);
	assert.deepEqual(result.list[0].data, { id: 1, title: 'searchable title' });
});

test('search builder include preserves search instantiate operation', async () => {
	class CountingStore extends MemoryStoreAdapter {
		articleGetManyCalls = 0;
		articleGetManyIds: unknown[][] = [];

		override async getMany(model: ResolvedModelMeta, ids: any[]) {
			if (model.name === 'search_include_article') {
				this.articleGetManyCalls++;
				this.articleGetManyIds.push([...ids]);
			}
			return await super.getMany(model, ids);
		}
	}
	const store = new CountingStore();
	const operations: Array<string | undefined> = [];
	const search: SearchAdapter = {
		kind: 'memory',
		capabilities: {
			where: false,
			nestedFields: true,
			numericComparisons: false,
			nullOperators: false,
			cursor: false,
			native: false
		},
		async search() {
			return {
				list: [{ id: 1, title: 'search hit' }],
				more: false,
				count: 1
			};
		},
		async index() {},
		async delete() {}
	};
	const context = createActiveTs({
		stores: { default: store },
		search: { memory: search },
		defaultSearch: 'memory',
		plugins: [
			{
				name: 'operation-observer',
				hooks: {
					afterInstantiate(payload) {
						if (payload.model?.name === 'search_include_article') operations.push(payload.operation);
					}
				}
			}
		]
	});
	const Article = SearchIncludeArticle.use(context) as unknown as typeof SearchIncludeArticle;
	await store.seed(context.meta(SearchIncludeAuthor), [{ id: 10, name: 'Ada' }]);
	await store.seed(context.meta(SearchIncludeArticle), [{ id: 1, authorId: 10, title: 'search hit', body: 'full body' }]);

	const result = await Article.search('search').include('author').load();

	assert.deepEqual(result.list.map((item) => item.data.id), [1]);
	assert.equal(store.articleGetManyCalls, 1);
	assert.deepEqual(store.articleGetManyIds, [[1]]);
	assert.deepEqual(operations, ['search']);
});

test('search builder include rejects duplicate search hits instead of hiding them', async () => {
	class CountingStore extends MemoryStoreAdapter {
		articleGetManyCalls = 0;

		override async getMany(model: ResolvedModelMeta, ids: any[]) {
			if (model.name === 'search_include_article') this.articleGetManyCalls++;
			return await super.getMany(model, ids);
		}
	}
	const store = new CountingStore();
	const search: SearchAdapter = {
		kind: 'memory',
		capabilities: {
			where: false,
			nestedFields: true,
			numericComparisons: false,
			nullOperators: false,
			cursor: false,
			native: false
		},
		async search() {
			return {
				list: [
					{ id: 1, title: 'duplicate hit' },
					{ id: 1, title: 'duplicate hit again' }
				],
				more: false,
				count: 2
			};
		},
		async index() {},
		async delete() {}
	};
	const context = createActiveTs({
		stores: { default: store },
		search: { memory: search },
		defaultSearch: 'memory'
	});
	const Article = SearchIncludeArticle.use(context) as unknown as typeof SearchIncludeArticle;
	await store.seed(context.meta(SearchIncludeAuthor), [{ id: 10, name: 'Ada' }]);
	await store.seed(context.meta(SearchIncludeArticle), [{ id: 1, authorId: 10, title: 'duplicate hit', body: 'full body' }]);

	await assert.rejects(
		() => Article.search('duplicate').include('author').load(),
		/Search result for search_include_article contains duplicate id "1"/
	);
	assert.equal(store.articleGetManyCalls, 0);
});

test('search builder include drops hits with stale document identity markers', async () => {
	class CountingStore extends MemoryStoreAdapter {
		articleGetManyCalls = 0;

		override async getMany(model: ResolvedModelMeta, ids: any[]) {
			if (model.name === 'search_include_article') this.articleGetManyCalls++;
			return await super.getMany(model, ids);
		}
	}
	const store = new CountingStore();
	let articleMeta!: ResolvedModelMeta;
	const search: SearchAdapter = {
		kind: 'stale-identity-search',
		capabilities: {
			where: false,
			nestedFields: true,
			numericComparisons: false,
			nullOperators: false,
			cursor: false,
			native: false
		},
		async search() {
			return {
				list: [
					markSearchDocumentIdentity(
						{ id: 1, title: 'stale identity hit' },
						searchDocumentIdentity(articleMeta, 2, 'search_include_article stale search hit identity')
					)
				],
				more: false,
				count: 1,
				total: 1
			};
		},
		async index() {},
		async delete() {}
	};
	const context = createActiveTs({
		stores: { default: store },
		search: { memory: search },
		defaultSearch: 'memory'
	});
	const Article = SearchIncludeArticle.use(context) as unknown as typeof SearchIncludeArticle;
	articleMeta = context.meta(SearchIncludeArticle);
	await store.seed(context.meta(SearchIncludeAuthor), [{ id: 10, name: 'Ada' }]);
	await store.seed(articleMeta, [{ id: 1, authorId: 10, title: 'stale identity hit', body: 'full body' }]);

	const result = await Article.search('stale').include('author').load();

	assert.deepEqual(result.list, []);
	assert.equal(result.count, 0);
	assert.equal(result.total, undefined);
	assert.equal(store.articleGetManyCalls, 0);
});

test('search builder include drops stale hits using fresh store reads instead of entity cache', async () => {
	const store = new MemoryStoreAdapter();
	const memory = new MemorySearchAdapter();
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: new MemoryCacheAdapter() },
		search: { memory },
		defaultSearch: 'memory'
	});
	const Article = CachedSearchIncludeArticle.use(context) as unknown as typeof CachedSearchIncludeArticle;
	const meta = context.meta(CachedSearchIncludeArticle);
	await store.seed(context.meta(SearchIncludeAuthor), [{ id: 10, name: 'Ada' }]);
	await store.seed(meta, [{ id: 1, authorId: 10, title: 'searchable title', body: 'full body' }]);
	await memory.index(meta, 1, { id: 1, authorId: 10, title: 'searchable title', body: 'hidden from index' });
	await Article.find(1).load();

	await store.delete(meta, 1);
	const result = await Article.search('searchable').include('author').load();

	assert.deepEqual(result.list, []);
	assert.equal(result.count, 0);
});

test('search builder include drops fresh rows that no longer satisfy search where filters', async () => {
	const store = new MemoryStoreAdapter();
	const search: SearchAdapter = {
		kind: 'where-capable-stale-search',
		capabilities: {
			where: true,
			whereOperators: { '=': true },
			nestedFields: true,
			numericComparisons: false,
			nullOperators: false,
			cursor: false,
			native: false
		},
		async search() {
			return {
				list: [{ id: 1, authorId: 10, title: 'searchable title', body: 'stale index body' }],
				more: false,
				count: 1,
				total: 1
			};
		},
		async index() {},
		async delete() {}
	};
	const context = createActiveTs({
		stores: { default: store },
		search: { memory: search },
		defaultSearch: 'memory'
	});
	const Article = SearchIncludeArticle.use(context) as unknown as typeof SearchIncludeArticle;
	const meta = context.meta(SearchIncludeArticle);
	await store.seed(context.meta(SearchIncludeAuthor), [
		{ id: 10, name: 'Ada' },
		{ id: 20, name: 'Grace' }
	]);
	await store.seed(meta, [{ id: 1, authorId: 20, title: 'searchable title', body: 'full body' }]);

	const result = await Article.search('searchable').where({ authorId: 10 }).include('author').load();

	assert.deepEqual(result.list, []);
	assert.equal(result.count, 0);
	assert.equal(result.total, undefined);
});

test('search builder include clears total when stale hits are pruned', async () => {
	const store = new MemoryStoreAdapter();
	const search: SearchAdapter = {
		kind: 'memory',
		capabilities: {
			where: false,
			nestedFields: true,
			numericComparisons: false,
			nullOperators: false,
			cursor: true,
			native: false
		},
		async search() {
			return {
				list: [
					{ id: 1, title: 'live hit' },
					{ id: 2, title: 'stale hit' }
				],
				more: true,
				cursor: 'next-page',
				count: 2,
				total: 2
			};
		},
		async index() {},
		async delete() {}
	};
	const context = createActiveTs({
		stores: { default: store },
		search: { memory: search },
		defaultSearch: 'memory'
	});
	const Article = SearchIncludeArticle.use(context) as unknown as typeof SearchIncludeArticle;
	const meta = context.meta(SearchIncludeArticle);
	await store.seed(context.meta(SearchIncludeAuthor), [{ id: 10, name: 'Ada' }]);
	await store.seed(meta, [{ id: 1, authorId: 10, title: 'live hit', body: 'full body' }]);

	const result = await Article.search('hit').include('author').load();

	assert.deepEqual(result.list.map((item) => item.data.id), [1]);
	assert.equal(result.count, 1);
	assert.equal(result.more, true);
	assert.equal(result.cursor, 'next-page');
	assert.equal(result.total, undefined);
});

test('algolia sdk-shaped fake covers pagination object ids deletes and search options', async () => {
	const meta = createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(SearchParityRecord);
	const calls: any[] = [];
	const indexes = new Map<string, Map<string, Record<string, unknown>>>();
	const algolia = await createAlgoliaSearchAdapter({
		client: {
			searchSingleIndex: async (payload: any) => {
				calls.push({ op: 'search', payload });
				assert.deepEqual(Object.keys(payload).sort(), ['indexName', 'searchParams']);
				assert.equal(payload.indexName, 'search_parity_record');
				assert.equal(payload.searchParams.filters, 'title:safe');
				assert.equal('offset' in payload.searchParams, false);
				assert.equal('length' in payload.searchParams, false);
				assert.deepEqual(Array.from(payload.searchParams.restrictSearchableAttributes), ['title']);
				assert.deepEqual(Array.from(payload.searchParams.attributesToRetrieve), ['id', 'title']);

				const page = payload.searchParams.page ?? 0;
				const hitsPerPage = payload.searchParams.hitsPerPage ?? 20;
				const query = String(payload.searchParams.query).toLowerCase();
				const docs = indexes.get(payload.indexName) ?? new Map<string, Record<string, unknown>>();
				const matching = Array.from(docs.values()).filter((doc) =>
					String(doc.title).toLowerCase().includes(query)
				);
				const hits = matching.slice(page * hitsPerPage, page * hitsPerPage + hitsPerPage).map((doc) => ({
					id: doc.id,
					title: doc.title,
					objectID: doc.objectID,
					_highlightResult: { title: {} }
				}));
				return {
					hits,
					nbHits: matching.length,
					nbPages: Math.ceil(matching.length / hitsPerPage),
					page,
					exhaustiveNbHits: true
				};
			},
			saveObject: async (payload: any) => {
				calls.push({ op: 'save', payload });
				assert.deepEqual(Object.keys(payload).sort(), ['body', 'indexName']);
				assert.equal(payload.indexName, 'search_parity_record');
				assert.equal(typeof payload.body.objectID, 'string');
				let docs = indexes.get(payload.indexName);
				if (!docs) {
					docs = new Map<string, Record<string, unknown>>();
					indexes.set(payload.indexName, docs);
				}
				docs.set(payload.body.objectID, { ...payload.body });
			},
			deleteObject: async (payload: any) => {
				calls.push({ op: 'delete', payload });
				assert.deepEqual(Object.keys(payload).sort(), ['indexName', 'objectID']);
				assert.equal(payload.indexName, 'search_parity_record');
				indexes.get(payload.indexName)?.delete(payload.objectID);
			}
		}
	});

	await algolia.index(meta, 1, { id: 1, title: 'safe first', body: 'hidden first' });
	await algolia.index(meta, 2, { id: 2, title: 'safe second', body: 'hidden second' });
	await algolia.index(meta, 3, { id: 3, title: 'safe third', body: 'hidden third' });

	const firstPage = await algolia.search(meta, 'safe', { limit: 2, native: { filters: 'title:safe' } });
	assert.deepEqual(firstPage, {
		list: [
			{ id: 1, title: 'safe first' },
			{ id: 2, title: 'safe second' }
		],
		cursor: '1',
		more: true,
		count: 2,
		total: 3
	});
	const secondPage = await algolia.search(meta, 'safe', {
		limit: 2,
		cursor: firstPage.cursor,
		native: { filters: 'title:safe' }
	});
	assert.deepEqual(secondPage, {
		list: [{ id: 3, title: 'safe third' }],
		cursor: undefined,
		more: false,
		count: 1,
		total: 3
	});

	await algolia.delete(meta, 2);
	assert.deepEqual(await algolia.search(meta, 'safe', { limit: 10, native: { filters: 'title:safe' } }), {
		list: [
			{ id: 1, title: 'safe first' },
			{ id: 3, title: 'safe third' }
		],
		cursor: undefined,
		more: false,
		count: 2,
		total: 2
	});

	assert.deepEqual(
		calls.filter((call) => call.op === 'save').map((call) => call.payload.body.objectID),
		['search_parity_record:number:1', 'search_parity_record:number:2', 'search_parity_record:number:3']
	);
	assert.deepEqual(
		calls.filter((call) => call.op === 'delete').map((call) => call.payload.objectID),
		['search_parity_record:number:2']
	);
	const searchCalls = calls.filter((call) => call.op === 'search');
	assert.equal(searchCalls[0].payload.searchParams.hitsPerPage, 2);
	assert.equal(searchCalls[0].payload.searchParams.page, undefined);
	assert.equal(searchCalls[1].payload.searchParams.page, 1);
	assert.equal(searchCalls[2].payload.searchParams.hitsPerPage, 10);
});

test('algolia and elasticsearch search lifecycle uses typed ids and projected documents', async () => {
	const meta = createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(SearchParityRecord);
	const algoliaCalls: any[] = [];
	const algoliaSearches: any[] = [];
	const algolia = await createAlgoliaSearchAdapter({
		client: {
			searchSingleIndex: async (payload: any) => {
				algoliaSearches.push(payload);
				return {
					hits: [
							{
								id: 1,
								title: 'one',
								body: 'remote extra body',
								objectID: 'search_parity_record:number:1',
								_highlightResult: { title: {} },
								__position: 1,
								__queryID: 'query-id'
							}
						],
					nbHits: 12,
					nbPages: 1,
					page: 0
				};
			},
			saveObject: async (payload: any) => algoliaCalls.push({ op: 'save', payload }),
			deleteObject: async (payload: any) => algoliaCalls.push({ op: 'delete', payload })
		}
	});
	await algolia.index(meta, 1, { id: 1, title: 'one', body: 'body' });
	await algolia.index(meta, '1', { id: '1', title: 'string one', body: 'body' });
	await algolia.delete(meta, 1);
	await algolia.delete(meta, '1');
	await assert.rejects(
		() => algolia.index({ ...meta, name: '__unsafe' }, 1, { id: 1, title: 'bad', body: 'body' }),
		/Algolia model metadata\.name/
	);
	await assert.rejects(() => algolia.search({ ...meta, name: '__unsafe' }, 'safe', {}), /Algolia model metadata\.name/);
	assert.deepEqual(
		algoliaCalls.map((call) => call.payload.objectID ?? call.payload.body.objectID),
		['search_parity_record:number:1', 'search_parity_record:string:1', 'search_parity_record:number:1', 'search_parity_record:string:1']
	);
	assert.equal(Object.getPrototypeOf(algoliaCalls[0].payload.body), null);
	assert.deepEqual({ ...algoliaCalls[0].payload.body }, {
		id: 1,
		title: 'one',
		objectID: 'search_parity_record:number:1'
	});
	assert.equal('body' in algoliaCalls[0].payload.body, false);
	assert.deepEqual(await algolia.search(meta, 'safe', { limit: 5, native: { filters: 'tenant:1' } }), {
		list: [{ id: 1, title: 'one' }],
		cursor: undefined,
		more: false,
		count: 1,
		total: 12
	});
	const approximateAlgolia = await createAlgoliaSearchAdapter({
		client: {
			searchSingleIndex: async () => ({
				hits: [],
				nbHits: 1000,
				exhaustiveNbHits: false,
				nbPages: 1,
				page: 0
			}),
			saveObject: async () => undefined,
			deleteObject: async () => undefined
		}
	});
	assert.deepEqual(await approximateAlgolia.search(meta, 'safe', {}), {
		list: [],
		cursor: undefined,
		more: false,
		count: 0,
		total: undefined
	});
	const nestedApproximateAlgolia = await createAlgoliaSearchAdapter({
		client: {
			searchSingleIndex: async () => ({
				hits: [],
				nbHits: 1000,
				exhaustive: { nbHits: false },
				nbPages: 1,
				page: 0
			}),
			saveObject: async () => undefined,
			deleteObject: async () => undefined
		}
	});
	assert.equal((await nestedApproximateAlgolia.search(meta, 'safe', {})).total, undefined);
	assert.equal(algoliaSearches[0].searchParams.query, 'safe');
	assert.equal(algoliaSearches[0].searchParams.hitsPerPage, 5);
	assert.equal(algoliaSearches[0].searchParams.filters, 'tenant:1');
	assert.deepEqual(Array.from(algoliaSearches[0].searchParams.restrictSearchableAttributes), ['title']);
	assert.deepEqual(Array.from(algoliaSearches[0].searchParams.attributesToRetrieve), ['id', 'title']);
	await assert.rejects(
		() => algolia.search(meta, 'safe', { native: { query: 'unsafe' } }),
		/Algolia native parameter "query" cannot be combined/
	);
	await assert.rejects(
		() => algolia.search(meta, 'safe', { native: { hitsPerPage: 100 } }),
		/Algolia native parameter "hitsPerPage" cannot be combined/
	);
	await assert.rejects(
		() => algolia.search(meta, 'safe', { native: { page: 2 } }),
		/Algolia native parameter "page" cannot be combined/
	);
	const algoliaPaginationConflictSearchCount = algoliaSearches.length;
	await assert.rejects(
		() => algolia.search(meta, 'safe', { native: { offset: 10 } }),
		/Algolia native parameter "offset" cannot be combined/
	);
	await assert.rejects(
		() => algolia.search(meta, 'safe', { native: { length: 10 } }),
		/Algolia native parameter "length" cannot be combined/
	);
	assert.equal(algoliaSearches.length, algoliaPaginationConflictSearchCount);
	await assert.rejects(
		() => algolia.search(meta, 'safe', { native: { restrictSearchableAttributes: ['body'] } }),
		/Algolia native parameter "restrictSearchableAttributes" cannot be combined/
	);
	await assert.rejects(
		() => algolia.search(meta, 'safe', { native: { attributesToRetrieve: ['body'] } }),
		/Algolia native parameter "attributesToRetrieve" cannot be combined/
	);
	const algoliaNoFieldSearchCount = algoliaSearches.length;
	assert.deepEqual(await algolia.search({ ...meta, searchIndexes: [] }, 'safe', {}), {
		list: [],
		more: false,
		count: 0
	});
	assert.equal(algoliaSearches.length, algoliaNoFieldSearchCount);
	await assert.rejects(() => algolia.search(meta, 'one', { cursor: 'not-a-page' }), /Algolia cursor/);
	await assert.rejects(() => algolia.search(meta, 'one', { cursor: '-1' }), /Algolia cursor/);
	await assert.rejects(() => algolia.search(meta, 'one', null as any), /Algolia search options must be a plain object/);
	await assert.rejects(() => algolia.search(meta, 'one', { where: { id: 1 } }), /does not support where filters/);
	await assert.rejects(() => algolia.search(meta, 'one', { native: false }), /Algolia native payload/);
	await assert.rejects(() => algolia.search(meta, 'one', { native: null }), /Algolia native payload/);
	await assert.rejects(() => algolia.search(meta, 'one', { native: [] }), /Algolia native payload/);
	let nativeGetterCalls = 0;
	const algoliaAccessorNative = Object.defineProperty({}, 'filters', {
		enumerable: true,
		get() {
			nativeGetterCalls++;
			return 'tenant:1';
		}
	});
	await assert.rejects(
		() => algolia.search(meta, 'one', { native: algoliaAccessorNative }),
		/Algolia search options\.native\.filters must be a data property/
	);
	assert.equal(nativeGetterCalls, 0);
	const algoliaSearchCount = algoliaSearches.length;
	await assert.rejects(() => algolia.search(meta, { text: 'one' } as any, {}), /Algolia search query must be a string/);
	await assert.rejects(() => algolia.search(meta, 'bad\0query', {}), /Algolia search query must not contain null bytes/);
	await assert.rejects(() => algolia.search(meta, 'x'.repeat(4097), {}), /Algolia search query is too long/);
	assert.equal(algoliaSearches.length, algoliaSearchCount);
	const malformedAlgolia = await createAlgoliaSearchAdapter({
		client: {
			searchSingleIndex: async () => ({ hits: null, nbHits: 0, nbPages: 1, page: 0 }),
			saveObject: async () => undefined,
			deleteObject: async () => undefined
		}
	});
	await assert.rejects(() => malformedAlgolia.search(meta, 'safe', {}), /Algolia search hits must be an array/);
	const missingAlgoliaHits = await createAlgoliaSearchAdapter({
		client: {
			searchSingleIndex: async () => ({ nbHits: 0, nbPages: 1, page: 0 }),
			saveObject: async () => undefined,
			deleteObject: async () => undefined
		}
	});
	await assert.rejects(() => missingAlgoliaHits.search(meta, 'safe', {}), /Algolia search response\.hits is required/);
	const sparseAlgolia = await createAlgoliaSearchAdapter({
		client: {
			searchSingleIndex: async () => ({ hits: new Array(1), nbHits: 0, nbPages: 1, page: 0 }),
			saveObject: async () => undefined,
			deleteObject: async () => undefined
		}
	});
	await assert.rejects(() => sparseAlgolia.search(meta, 'safe', {}), /Algolia search hits\[0\] is missing/);
	let algoliaMapCalls = 0;
	const mappedAlgolia = await createAlgoliaSearchAdapter({
		client: {
			searchSingleIndex: async () => {
				const hits = [{ objectID: `${meta.name}:number:1`, id: 1, title: 'mapped' }] as any[];
				Object.defineProperty(hits, 'map', {
					value() {
						algoliaMapCalls++;
						throw new Error('custom algolia hits map should not run');
					}
				});
				return { hits, nbHits: 1, nbPages: 1, page: 0 };
			},
			saveObject: async () => undefined,
			deleteObject: async () => undefined
		}
	});
	assert.deepEqual((await mappedAlgolia.search(meta, 'safe', {})).list, [{ id: 1, title: 'mapped' }]);
	assert.equal(algoliaMapCalls, 0);
	const patchedArrayAlgolia = await createAlgoliaSearchAdapter({
		client: {
			searchSingleIndex: async () => ({
				hits: [{ objectID: `${meta.name}:number:1`, id: 1, title: 'patched algolia' }],
				nbHits: 1,
				nbPages: 1,
				page: 0
			}),
			saveObject: async () => undefined,
			deleteObject: async () => undefined
		}
	});
	const malformedAlgoliaHit = await createAlgoliaSearchAdapter({
		client: {
			searchSingleIndex: async () => ({ hits: [null], nbHits: 0, nbPages: 1, page: 0 }),
			saveObject: async () => undefined,
			deleteObject: async () => undefined
		}
	});
	await assert.rejects(() => malformedAlgoliaHit.search(meta, 'safe', {}), /Algolia hit must be a plain object/);
	const unsafeAlgoliaHitId = await createAlgoliaSearchAdapter({
		client: {
			searchSingleIndex: async () => ({
				hits: [{ id: { nested: true }, title: 'bad id', objectID: 'search_parity_record:number:1' }],
				nbHits: 1,
				nbPages: 1,
				page: 0
			}),
			saveObject: async () => undefined,
			deleteObject: async () => undefined
		}
	});
	await assert.rejects(() => unsafeAlgoliaHitId.search(meta, 'safe', {}), /Algolia hit id must be a string or safe integer/);
	const mismatchedAlgoliaHitId = await createAlgoliaSearchAdapter({
		client: {
			searchSingleIndex: async () => ({
				hits: [{ id: 2, title: 'logical id wins', objectID: 'search_parity_record:number:1' }],
				nbHits: 1,
				nbPages: 1,
				page: 0
			}),
			saveObject: async () => undefined,
			deleteObject: async () => undefined
		}
	});
	assert.deepEqual(await mismatchedAlgoliaHitId.search(meta, 'safe', {}), {
		list: [{ id: 2, title: 'logical id wins' }],
		cursor: undefined,
		more: false,
		count: 1,
		total: 1
	});
	const noncanonicalAlgoliaObjectId = await createAlgoliaSearchAdapter({
		client: {
			searchSingleIndex: async () => ({
				hits: [{ title: 'bad object id', objectID: 'search_parity_record:boolean:true' }],
				nbHits: 1,
				nbPages: 1,
				page: 0
			}),
			saveObject: async () => undefined,
			deleteObject: async () => undefined
		}
	});
	await assert.rejects(
		() => noncanonicalAlgoliaObjectId.search(meta, 'safe', {}),
		/Algolia objectID "search_parity_record:boolean:true" must be a canonical active-ts entity id key/
	);
	const inheritedAlgoliaResponse = await createAlgoliaSearchAdapter({
		client: {
			searchSingleIndex: async () =>
				Object.create({
					hits: [{ id: 9, title: 'inherited', objectID: 'search_parity_record:number:9' }],
					nbHits: 1,
					nbPages: 2,
					page: 0
				}),
			saveObject: async () => undefined,
			deleteObject: async () => undefined
		}
	});
	await assert.rejects(() => inheritedAlgoliaResponse.search(meta, 'safe', {}), /Algolia search response must be a plain object/);
	const malformedAlgoliaPage = await createAlgoliaSearchAdapter({
		client: {
			searchSingleIndex: async () => ({ hits: [], nbHits: '1', nbPages: 1, page: 0 }),
			saveObject: async () => undefined,
			deleteObject: async () => undefined
		}
	});
	await assert.rejects(() => malformedAlgoliaPage.search(meta, 'safe', {}), /Algolia search response nbHits/);
	const lowTotalAlgolia = await createAlgoliaSearchAdapter({
		client: {
			searchSingleIndex: async () => ({
				hits: [{ objectID: `${meta.name}:number:1`, id: 1, title: 'one' }],
				nbHits: 0,
				nbPages: 1,
				page: 0
			}),
			saveObject: async () => undefined,
			deleteObject: async () => undefined
		}
	});
	await assert.rejects(
		() => lowTotalAlgolia.search(meta, 'safe', {}),
		/Algolia search response nbHits cannot be smaller than hits length/
	);
	const missingAlgoliaPagination = await createAlgoliaSearchAdapter({
		client: {
			searchSingleIndex: async () => ({
				hits: [{ objectID: `${meta.name}:number:1`, id: 1, title: 'one' }],
				nbHits: 2
			}),
			saveObject: async () => undefined,
			deleteObject: async () => undefined
		}
	});
	await assert.rejects(
		() => missingAlgoliaPagination.search(meta, 'safe', { limit: 1 }),
		/Algolia search response page and nbPages are required for paginated searches/
	);
	let getterCalls = 0;
	const accessorAlgoliaResponse = await createAlgoliaSearchAdapter({
		client: {
			searchSingleIndex: async () =>
				Object.defineProperty({ nbHits: 0, nbPages: 1, page: 0 }, 'hits', {
					enumerable: true,
					get() {
						getterCalls++;
						return [];
					}
				}),
			saveObject: async () => undefined,
			deleteObject: async () => undefined
		}
	});
	await assert.rejects(() => accessorAlgoliaResponse.search(meta, 'safe', {}), /hits must be a data property/);
	assert.equal(getterCalls, 0);

	const elasticCalls: any[] = [];
	const elasticSearches: any[] = [];
	const elastic = await createElasticsearchSearchAdapter({
		client: {
			search: async (payload: any) => {
				elasticSearches.push(payload);
				return { hits: { hits: [{ _id: 'number:7', _source: { title: 'elastic one', body: 'remote extra body' } }], total: { value: 9 } } };
			},
			index: async (payload: any) => elasticCalls.push({ op: 'index', payload }),
			delete: async (payload: any) => elasticCalls.push({ op: 'delete', payload })
		}
	});
	assert.deepEqual(await elastic.search(meta, 'safe', { limit: 1 }), {
		list: [{ id: 7, title: 'elastic one' }],
		more: true,
		count: 1,
		total: 9
	});
	assert.equal(elasticSearches[0].body.query.multi_match.query, 'safe');
	assert.deepEqual(Array.from(elasticSearches[0].body.query.multi_match.fields), ['title']);
	assert.deepEqual(Array.from(elasticSearches[0].body._source), ['id', 'title']);
	assert.deepEqual(
		await elastic.search(meta, 'safe', {
			native: { sort: [{ title: 'asc' }] }
		}),
		{
			list: [{ id: 7, title: 'elastic one' }],
			more: true,
			count: 1,
			total: 9
		}
	);
	assert.equal(elasticSearches[1].body.query.multi_match.query, 'safe');
	assert.deepEqual(Array.from(elasticSearches[1].body.sort, (entry: Record<string, string>) => ({ ...entry })), [{ title: 'asc' }]);
	assert.deepEqual(Array.from(elasticSearches[1].body._source), ['id', 'title']);
	const nativeOnlyMeta = { ...meta, searchIndexes: [] };
	assert.deepEqual(await elastic.search(nativeOnlyMeta, 'ignored', { native: { query: { match_all: {} }, size: 2 } }), {
		list: [{ id: 7 }],
		more: true,
		count: 1,
		total: 9
	});
	assert.deepEqual(JSON.parse(JSON.stringify(elasticSearches[2].body)), { query: { match_all: {} }, size: 2 });
	await assert.rejects(
		() => elastic.search(nativeOnlyMeta, 'ignored', { limit: 1, native: { query: { match_all: {} }, size: 2 } }),
		/Elasticsearch native parameter "size" cannot be combined/
	);
	const nativeOnlyPaginationConflictSearchCount = elasticSearches.length;
	await assert.rejects(
		() => elastic.search(nativeOnlyMeta, 'ignored', { limit: 1, native: { query: { match_all: {} }, from: 10 } }),
		/Elasticsearch native parameter "from" cannot be combined/
	);
	await assert.rejects(
		() =>
			elastic.search(nativeOnlyMeta, 'ignored', {
				limit: 1,
				native: { query: { match_all: {} }, search_after: ['cursor'] }
			}),
		/Elasticsearch native parameter "search_after" cannot be combined/
	);
	assert.equal(elasticSearches.length, nativeOnlyPaginationConflictSearchCount);
	const approximateElastic = await createElasticsearchSearchAdapter({
		client: {
			search: async () => ({ hits: { hits: [], total: { value: 10000, relation: 'gte' } } }),
			index: async () => undefined,
			delete: async () => undefined
		}
	});
	assert.deepEqual(await approximateElastic.search(meta, 'safe', {}), {
		list: [],
		more: false,
		count: 0,
		total: undefined
	});
	const approximateElasticPage = await createElasticsearchSearchAdapter({
		client: {
			search: async () => ({
				hits: {
					hits: [{ _id: 'number:8', _source: { id: 8, title: 'elastic lower bound' } }],
					total: { value: 10000, relation: 'gte' }
				}
			}),
			index: async () => undefined,
			delete: async () => undefined
		}
	});
	assert.deepEqual(await approximateElasticPage.search(meta, 'safe', { limit: 1 }), {
		list: [{ id: 8, title: 'elastic lower bound' }],
		more: true,
		count: 1,
		total: undefined
	});
	await assert.rejects(
		() => elastic.search(meta, 'safe', { native: { query: { match_all: {} } } }),
		/Elasticsearch native query cannot be combined/
	);
	await assert.rejects(
		() => elastic.search(meta, 'safe', { native: { _source: ['body'] } }),
		/Elasticsearch native _source cannot be combined/
	);
	await assert.rejects(
		() => elastic.search(meta, 'safe', { limit: 1, native: { size: 100 } }),
		/Elasticsearch native parameter "size" cannot be combined/
	);
	await assert.rejects(
		() => elastic.search(meta, 'safe', { native: { from: 50 } }),
		/Elasticsearch native parameter "from" cannot be combined/
	);
	await assert.rejects(
		() => elastic.search(meta, 'safe', { native: { search_after: ['cursor'] } }),
		/Elasticsearch native parameter "search_after" cannot be combined/
	);
	await elastic.index(meta, 1, { id: 1, title: 'one', body: 'body' });
	await elastic.index(meta, '1', { id: '1', title: 'string one', body: 'body' });
	await elastic.delete(meta, 1);
	await elastic.delete(meta, '1');
	await assert.rejects(
		() => elastic.index({ ...meta, name: '__unsafe' }, 1, { id: 1, title: 'bad', body: 'body' }),
		/Elasticsearch model metadata\.name/
	);
	await assert.rejects(() => elastic.search({ ...meta, name: '__unsafe' }, 'safe', {}), /Elasticsearch model metadata\.name/);
	assert.deepEqual(
		elasticCalls.map((call) => call.payload.id),
		['number:1', 'string:1', 'number:1', 'string:1']
	);
	assert.equal(Object.getPrototypeOf(elasticCalls[0].payload.document), null);
	assert.deepEqual({ ...elasticCalls[0].payload.document }, { id: 1, title: 'one' });
	const elasticMissingDelete = await createElasticsearchSearchAdapter({
		client: {
			search: async () => ({ hits: { hits: [], total: { value: 0 } } }),
			index: async () => undefined,
			delete: async () => {
				const error = new Error('not found') as Error & { meta?: { statusCode: number } };
				error.meta = { statusCode: 404 };
				throw error;
			}
		}
	});
	await elasticMissingDelete.delete(meta, 404);
	const elasticFailingDelete = await createElasticsearchSearchAdapter({
		client: {
			search: async () => ({ hits: { hits: [], total: { value: 0 } } }),
			index: async () => undefined,
			delete: async () => {
				const error = new Error('cluster down') as Error & { meta?: { statusCode: number } };
				error.meta = { statusCode: 503 };
				throw error;
			}
		}
	});
	await assert.rejects(() => elasticFailingDelete.delete(meta, 1), /cluster down/);
	const elasticBodyNotFoundWithFailure = await createElasticsearchSearchAdapter({
		client: {
			search: async () => ({ hits: { hits: [], total: { value: 0 } } }),
			index: async () => undefined,
			delete: async () => {
				const error = new Error('delete shard unavailable') as Error & {
					statusCode?: number;
					body?: { found: boolean };
				};
				error.statusCode = 503;
				error.body = { found: false };
				throw error;
			}
		}
	});
	await assert.rejects(() => elasticBodyNotFoundWithFailure.delete(meta, 1), /delete shard unavailable/);
	const accessorElasticResponse = await createElasticsearchSearchAdapter({
		client: {
			search: async () =>
				Object.defineProperty({}, 'hits', {
					enumerable: true,
					get() {
						getterCalls++;
						return { hits: [] };
					}
				}),
			index: async () => undefined,
			delete: async () => undefined
		}
	});
	await assert.rejects(() => accessorElasticResponse.search(meta, 'safe', {}), /hits must be a data property/);
	assert.equal(getterCalls, 0);
	const pollutedElasticDelete = await createElasticsearchSearchAdapter({
		client: {
			search: async () => ({ hits: { hits: [], total: { value: 0 } } }),
			index: async () => undefined,
			delete: async () => {
				throw new Error('polluted status should not be swallowed');
			}
		}
	});
	Object.defineProperties(Object.prototype, {
		statusCode: { value: 404, configurable: true },
		body: { value: { found: false }, configurable: true }
	});
	try {
		await assert.rejects(() => pollutedElasticDelete.delete(meta, 1), /polluted status should not be swallowed/);
	} finally {
		delete (Object.prototype as Record<string, unknown>).statusCode;
		delete (Object.prototype as Record<string, unknown>).body;
	}
	let deleteStatusGetterCalls = 0;
	const accessorElasticDelete = await createElasticsearchSearchAdapter({
		client: {
			search: async () => ({ hits: { hits: [], total: { value: 0 } } }),
			index: async () => undefined,
			delete: async () => {
				throw Object.defineProperty(new Error('accessor delete status'), 'statusCode', {
					enumerable: true,
					get() {
						deleteStatusGetterCalls++;
						return 404;
					}
				});
			}
		}
	});
	await assert.rejects(() => accessorElasticDelete.delete(meta, 1), /accessor delete status/);
	assert.equal(deleteStatusGetterCalls, 0);
	await assert.rejects(() => elastic.search(meta, 'one', { native: false }), /Elasticsearch native payload/);
	await assert.rejects(() => elastic.search(meta, 'one', { native: null }), /Elasticsearch native payload/);
	await assert.rejects(() => elastic.search(meta, 'one', { native: [] }), /Elasticsearch native payload/);
	const elasticAccessorNative = Object.defineProperty({}, 'sort', {
		enumerable: true,
		get() {
			nativeGetterCalls++;
			return [{ title: 'asc' }];
		}
	});
	await assert.rejects(
		() => elastic.search(meta, 'one', { native: elasticAccessorNative }),
		/Elasticsearch search options\.native\.sort must be a data property/
	);
	assert.equal(nativeGetterCalls, 0);
	await assert.rejects(() => elastic.search(meta, 'one', null as any), /Elasticsearch search options must be a plain object/);
	await assert.rejects(() => elastic.search(meta, 'one', { where: { id: 1 } }), /does not support where filters/);
	await assert.rejects(() => elastic.search(meta, 'one', { cursor: '1' }), /does not support cursors/);
	const elasticSearchCount = elasticSearches.length;
	await assert.rejects(() => elastic.search(meta, { text: 'one' } as any, {}), /Elasticsearch search query must be a string/);
	await assert.rejects(() => elastic.search(meta, 'bad\0query', {}), /Elasticsearch search query must not contain null bytes/);
	await assert.rejects(() => elastic.search(meta, 'x'.repeat(4097), {}), /Elasticsearch search query is too long/);
	assert.equal(elasticSearches.length, elasticSearchCount);
	const malformedElastic = await createElasticsearchSearchAdapter({
		client: {
			search: async () => ({ hits: { hits: null, total: { value: 0 } } }),
			index: async () => undefined,
			delete: async () => undefined
		}
	});
	await assert.rejects(() => malformedElastic.search(meta, 'safe', {}), /Elasticsearch search hits must be an array/);
	const missingElasticHitsContainer = await createElasticsearchSearchAdapter({
		client: {
			search: async () => ({ took: 1 }),
			index: async () => undefined,
			delete: async () => undefined
		}
	});
	await assert.rejects(
		() => missingElasticHitsContainer.search(meta, 'safe', {}),
		/Elasticsearch search response\.hits is required/
	);
	const missingElasticHitsArray = await createElasticsearchSearchAdapter({
		client: {
			search: async () => ({ hits: { total: { value: 0 } } }),
			index: async () => undefined,
			delete: async () => undefined
		}
	});
	await assert.rejects(
		() => missingElasticHitsArray.search(meta, 'safe', {}),
		/Elasticsearch search response\.hits\.hits is required/
	);
	const sparseElastic = await createElasticsearchSearchAdapter({
		client: {
			search: async () => ({ hits: { hits: new Array(1), total: { value: 0 } } }),
			index: async () => undefined,
			delete: async () => undefined
		}
	});
	await assert.rejects(() => sparseElastic.search(meta, 'safe', {}), /Elasticsearch search hits\[0\] is missing/);
	let elasticMapCalls = 0;
	const mappedElastic = await createElasticsearchSearchAdapter({
		client: {
			search: async () => {
				const hits = [{ _id: 'number:1', _source: { id: 1, title: 'mapped' } }] as any[];
				Object.defineProperty(hits, 'map', {
					value() {
						elasticMapCalls++;
						throw new Error('custom elastic hits map should not run');
					}
				});
				return { hits: { hits, total: { value: 1 } } };
			},
			index: async () => undefined,
			delete: async () => undefined
		}
	});
	assert.deepEqual((await mappedElastic.search(meta, 'safe', {})).list, [{ id: 1, title: 'mapped' }]);
	assert.equal(elasticMapCalls, 0);
	const patchedArrayElastic = await createElasticsearchSearchAdapter({
		client: {
			search: async () => ({ hits: { hits: [{ _id: 'number:1', _source: { id: 1, title: 'patched elastic' } }], total: { value: 1 } } }),
			index: async () => undefined,
			delete: async () => undefined
		}
	});
	const map = Object.getOwnPropertyDescriptor(Array.prototype, 'map')!;
	const flatMap = Object.getOwnPropertyDescriptor(Array.prototype, 'flatMap')!;
	let patchedAlgoliaResult: unknown;
	let patchedElasticResult: unknown;
	let patchedAlgoliaPlan: SchemaPlan | undefined;
	let patchedElasticPlan: SchemaPlan | undefined;
	Object.defineProperty(Array.prototype, 'map', {
		configurable: true,
		value() {
			throw new Error('patched Array.map');
		}
	});
	Object.defineProperty(Array.prototype, 'flatMap', {
		configurable: true,
		value() {
			throw new Error('patched Array.flatMap');
		}
	});
	try {
		patchedAlgoliaResult = await patchedArrayAlgolia.search(meta, 'safe', {});
		patchedElasticResult = await patchedArrayElastic.search(meta, 'safe', {});
		patchedAlgoliaPlan = await patchedArrayAlgolia.syncSchema!([meta]);
		patchedElasticPlan = await patchedArrayElastic.syncSchema!([meta]);
	} finally {
		Object.defineProperty(Array.prototype, 'map', map);
		Object.defineProperty(Array.prototype, 'flatMap', flatMap);
	}
	assert.deepEqual(patchedAlgoliaResult, {
		list: [{ id: 1, title: 'patched algolia' }],
		cursor: undefined,
		more: false,
		count: 1,
		total: 1
	});
	assert.deepEqual(patchedElasticResult, {
		list: [{ id: 1, title: 'patched elastic' }],
		more: false,
		count: 1,
		total: 1
	});
	assert.deepEqual(patchedAlgoliaPlan?.changes, [
		{ type: 'create-search-index', target: 'search_parity_record', name: 'algolia_title', fields: ['title'] }
	]);
	assert.deepEqual(patchedElasticPlan?.changes, [
		{ type: 'create-search-index', target: 'search_parity_record', name: 'elasticsearch_title', fields: ['title'] }
	]);
	const malformedElasticHit = await createElasticsearchSearchAdapter({
		client: {
			search: async () => ({ hits: { hits: [{ _id: 'number:1', _source: [] }], total: { value: 0 } } }),
			index: async () => undefined,
			delete: async () => undefined
		}
	});
	await assert.rejects(() => malformedElasticHit.search(meta, 'safe', {}), /Elasticsearch hit _source must be a plain object/);
	const nullSourceElasticHit = await createElasticsearchSearchAdapter({
		client: {
			search: async () => ({ hits: { hits: [{ _id: 'number:1', _source: null }], total: { value: 0 } } }),
			index: async () => undefined,
			delete: async () => undefined
		}
	});
	await assert.rejects(() => nullSourceElasticHit.search(meta, 'safe', {}), /Elasticsearch hit _source must be a plain object/);
	const undefinedSourceElasticHit = await createElasticsearchSearchAdapter({
		client: {
			search: async () => ({ hits: { hits: [{ _id: 'number:1', _source: undefined }], total: { value: 0 } } }),
			index: async () => undefined,
			delete: async () => undefined
		}
	});
	await assert.rejects(() => undefinedSourceElasticHit.search(meta, 'safe', {}), /Elasticsearch hit _source must be a plain object/);
	const unsafeElasticHitId = await createElasticsearchSearchAdapter({
		client: {
			search: async () => ({
				hits: { hits: [{ _id: 'number:7', _source: { id: { nested: true }, title: 'bad id' } }], total: { value: 1 } }
			}),
			index: async () => undefined,
			delete: async () => undefined
		}
	});
	await assert.rejects(() => unsafeElasticHitId.search(meta, 'safe', {}), /Elasticsearch hit id must be a string or safe integer/);
	const mismatchedElasticHitId = await createElasticsearchSearchAdapter({
		client: {
			search: async () => ({
				hits: { hits: [{ _id: 'number:7', _source: { id: 8, title: 'logical id wins' } }], total: { value: 1 } }
			}),
			index: async () => undefined,
			delete: async () => undefined
		}
	});
	assert.deepEqual(await mismatchedElasticHitId.search(meta, 'safe', {}), {
		list: [{ id: 8, title: 'logical id wins' }],
		count: 1,
		total: 1,
		more: false
	});
	const noncanonicalElasticHitId = await createElasticsearchSearchAdapter({
		client: {
			search: async () => ({
				hits: { hits: [{ _id: 'boolean:true', _source: { title: 'bad id' } }], total: { value: 1 } }
			}),
			index: async () => undefined,
			delete: async () => undefined
		}
	});
	await assert.rejects(
		() => noncanonicalElasticHitId.search(meta, 'safe', {}),
		/Elasticsearch hit _id "boolean:true" must be a canonical active-ts entity id key/
	);
	const inheritedElasticResponse = await createElasticsearchSearchAdapter({
		client: {
			search: async () =>
				Object.create({
					hits: {
						hits: [{ _id: 'number:9', _source: { title: 'inherited' } }],
						total: { value: 1 }
					}
				}),
			index: async () => undefined,
			delete: async () => undefined
		}
	});
	await assert.rejects(
		() => inheritedElasticResponse.search(meta, 'safe', {}),
		/Elasticsearch search response must be a plain object/
	);
	const inheritedElasticHitFields = await createElasticsearchSearchAdapter({
		client: {
			search: async () => ({ hits: { hits: [{ _id: 'number:7', _source: { title: 'fallback id' } }], total: { value: 1 } } }),
			index: async () => undefined,
			delete: async () => undefined
		}
	});
	Object.defineProperties(Object.prototype, {
		_id: { value: 'number:99', configurable: true },
		id: { value: 99, configurable: true }
	});
	try {
		assert.deepEqual((await inheritedElasticHitFields.search(meta, 'safe', {})).list, [{ id: 7, title: 'fallback id' }]);
	} finally {
		delete (Object.prototype as Record<string, unknown>)._id;
		delete (Object.prototype as Record<string, unknown>).id;
	}
	const malformedElasticTotal = await createElasticsearchSearchAdapter({
		client: {
			search: async () => ({ hits: { hits: [], total: { value: '1' } } }),
			index: async () => undefined,
			delete: async () => undefined
		}
	});
	await assert.rejects(() => malformedElasticTotal.search(meta, 'safe', {}), /Elasticsearch search total\.value/);
	const missingElasticTotalValue = await createElasticsearchSearchAdapter({
		client: {
			search: async () => ({ hits: { hits: [], total: { relation: 'eq' } } }),
			index: async () => undefined,
			delete: async () => undefined
		}
	});
	await assert.rejects(
		() => missingElasticTotalValue.search(meta, 'safe', {}),
		/Elasticsearch search total\.value is required/
	);
	const negativeElasticTotal = await createElasticsearchSearchAdapter({
		client: {
			search: async () => ({ hits: { hits: [], total: { value: -1 } } }),
			index: async () => undefined,
			delete: async () => undefined
		}
	});
	await assert.rejects(() => negativeElasticTotal.search(meta, 'safe', {}), /Elasticsearch search total\.value/);
	const lowElasticTotal = await createElasticsearchSearchAdapter({
		client: {
			search: async () => ({
				hits: { hits: [{ _id: 'number:1', _source: { id: 1, title: 'one' } }], total: { value: 0 } }
			}),
			index: async () => undefined,
			delete: async () => undefined
		}
	});
	await assert.rejects(
		() => lowElasticTotal.search(meta, 'safe', {}),
		/Elasticsearch search total\.value cannot be smaller than hits length/
	);
	const fractionalElasticTotal = await createElasticsearchSearchAdapter({
		client: {
			search: async () => ({ hits: { hits: [], total: { value: 1.5 } } }),
			index: async () => undefined,
			delete: async () => undefined
		}
	});
	await assert.rejects(() => fractionalElasticTotal.search(meta, 'safe', {}), /Elasticsearch search total\.value/);
});

test('remote search adapters preserve datastore ancestor document identities', async () => {
	const meta = createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(RemoteDatastoreSearchRecord);
	const left = { id: 7, parentId: 10, title: 'left ancestor needle' };
	const right = { id: 7, parentId: 20, title: 'right ancestor needle' };
	const algoliaSaved: any[] = [];
	const algoliaDeleted: any[] = [];
	const algolia = await createAlgoliaSearchAdapter({
		client: {
			searchSingleIndex: async (payload: any) => {
				assert.deepEqual(Array.from(payload.searchParams.attributesToRetrieve), ['id', 'title', 'parentId']);
				assert.deepEqual(Array.from(payload.searchParams.restrictSearchableAttributes), ['title']);
				return {
					hits: algoliaSaved.map((item) => item.body),
					nbHits: algoliaSaved.length,
					nbPages: 1,
					page: 0
				};
			},
			saveObject: async (payload: any) => algoliaSaved.push(payload),
			deleteObject: async (payload: any) => algoliaDeleted.push(payload)
		}
	});

	await algolia.index(meta, left.id, left);
	await algolia.index(meta, right.id, right);
	assert.equal(algoliaSaved[0].body.objectID.startsWith(`${meta.name}:datastore:`), true);
	assert.equal(algoliaSaved[1].body.objectID.startsWith(`${meta.name}:datastore:`), true);
	assert.notEqual(algoliaSaved[0].body.objectID, algoliaSaved[1].body.objectID);
	assert.deepEqual({ ...algoliaSaved[0].body }, { ...left, objectID: algoliaSaved[0].body.objectID });
	assert.deepEqual({ ...algoliaSaved[1].body }, { ...right, objectID: algoliaSaved[1].body.objectID });
	assert.deepEqual((await algolia.search(meta, 'needle', {})).list, [left, right]);
	await algolia.delete(
		{ ...meta, searchDocumentIdentity: algoliaSaved[0].body.objectID.slice(`${meta.name}:`.length) },
		left.id
	);
	assert.deepEqual(algoliaDeleted.map((item) => ({ ...item })), [
		{
			indexName: meta.name,
			objectID: algoliaSaved[0].body.objectID
		}
	]);

	const missingAlgoliaId = await createAlgoliaSearchAdapter({
		client: {
			searchSingleIndex: async () => ({
				hits: [{ objectID: algoliaSaved[0].body.objectID, parentId: left.parentId, title: left.title }],
				nbHits: 1,
				nbPages: 1,
				page: 0
			}),
			saveObject: async () => undefined,
			deleteObject: async () => undefined
		}
	});
	await assert.rejects(
		() => missingAlgoliaId.search(meta, 'needle', {}),
		/Algolia hit for Datastore ancestor model "remote_datastore_search_record" must include "id"/
	);

	const elasticIndexed: any[] = [];
	const elasticDeleted: any[] = [];
	const elastic = await createElasticsearchSearchAdapter({
		client: {
			search: async (payload: any) => {
				assert.deepEqual(Array.from(payload.body._source), ['id', 'title', 'parentId']);
				assert.deepEqual(Array.from(payload.body.query.multi_match.fields), ['title']);
				return {
					hits: {
						hits: elasticIndexed.map((item) => ({ _id: item.id, _source: item.document })),
						total: { value: elasticIndexed.length }
					}
				};
			},
			index: async (payload: any) => elasticIndexed.push(payload),
			delete: async (payload: any) => elasticDeleted.push(payload)
		}
	});

	await elastic.index(meta, left.id, left);
	await elastic.index(meta, right.id, right);
	assert.equal(elasticIndexed[0].id.startsWith('datastore:'), true);
	assert.equal(elasticIndexed[1].id.startsWith('datastore:'), true);
	assert.notEqual(elasticIndexed[0].id, elasticIndexed[1].id);
	assert.deepEqual({ ...elasticIndexed[0].document }, left);
	assert.deepEqual({ ...elasticIndexed[1].document }, right);
	assert.deepEqual((await elastic.search(meta, 'needle', {})).list, [left, right]);
	await elastic.delete({ ...meta, searchDocumentIdentity: elasticIndexed[1].id }, right.id);
	assert.deepEqual(elasticDeleted.map((item) => ({ ...item })), [
		{
			index: meta.name,
			id: elasticIndexed[1].id
		}
	]);

	const missingElasticId = await createElasticsearchSearchAdapter({
		client: {
			search: async () => ({
				hits: {
					hits: [{ _id: elasticIndexed[0].id, _source: { parentId: left.parentId, title: left.title } }],
					total: { value: 1 }
				}
			}),
			index: async () => undefined,
			delete: async () => undefined
		}
	});
	await assert.rejects(
		() => missingElasticId.search(meta, 'needle', {}),
		/Elasticsearch hit for Datastore ancestor model "remote_datastore_search_record" must include "id"/
	);
});

test('context search handles preserve datastore ancestor document identity markers', async () => {
	const elasticIndexed: any[] = [];
	const search = await createElasticsearchSearchAdapter({
		client: {
			search: async () => ({
				hits: {
					hits: elasticIndexed.map((item) => ({ _id: item.id, _source: item.document })),
					total: { value: elasticIndexed.length }
				}
			}),
			index: async (payload: any) => elasticIndexed.push(payload),
			delete: async () => undefined
		}
	});
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { elasticsearch: search }
	});
	const meta = context.meta(RemoteDatastoreSearchRecord);
	const left = { id: 7, parentId: 10, title: 'context left needle' };
	const right = { id: 7, parentId: 20, title: 'context right needle' };
	await context.searchAdapter('elasticsearch').index(meta, left.id, left);
	await context.searchAdapter('elasticsearch').index(meta, right.id, right);

	const result = await context.searchAdapter('elasticsearch').search(meta, 'needle', {});
	assert.equal(result.list.length, 2);
	const expected = new Map([
		[
			left.parentId,
			searchDocumentIdentity(meta, left.id, `${meta.name} left search document id`, left)
		],
		[
			right.parentId,
			searchDocumentIdentity(meta, right.id, `${meta.name} right search document id`, right)
		]
	]);
	for (const item of result.list) {
		assert.equal(searchHitDocumentIdentity(item), expected.get(item.parentId));
		expected.delete(item.parentId);
	}
	assert.equal(expected.size, 0);
});

test('context search handles keep datastore ancestor identity-marked partial hits without ancestor fields', async () => {
	const hit = markSearchDocumentIdentity(
		{ id: 7, title: 'context partial needle' },
		'remote_datastore_search_record:partial-hit'
	);
	const search: SearchAdapter = {
		kind: 'custom-context-partial-datastore-hit',
		capabilities: { where: false, cursor: false, native: false, index: false },
		search: async () => ({ list: [hit], count: 1, more: false }),
		index: async () => undefined,
		delete: async () => undefined
	};
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { custom: search },
		defaultSearch: 'custom'
	});

	const result = await context.searchAdapter('custom').search(context.meta(RemoteDatastoreSearchRecord), 'needle', {});

	assert.deepEqual(result.list, [{ id: 7, title: 'context partial needle' }]);
	assert.equal(searchHitDocumentIdentity(result.list[0]), 'remote_datastore_search_record:partial-hit');
});

test('runtime search keeps datastore ancestor identity-marked partial hits without ancestor fields', async () => {
	const hit = markSearchDocumentIdentity(
		{ id: 7, title: 'runtime partial needle' },
		'remote_datastore_search_record:runtime-partial-hit'
	);
	const search: SearchAdapter = {
		kind: 'custom-runtime-partial-datastore-hit',
		capabilities: { where: false, cursor: false, native: false, index: false },
		search: async () => ({ list: [hit], count: 1, more: false }),
		index: async () => undefined,
		delete: async () => undefined
	};
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { algolia: search },
		defaultSearch: 'algolia'
	});
	const Record = RemoteDatastoreSearchRecord.use(context) as unknown as typeof RemoteDatastoreSearchRecord;

	const result = await Record.search('needle').using('algolia').load();

	assert.deepEqual(result.list.map((item) => item.data), [
		{ id: 7, title: 'runtime partial needle' }
	]);
	assert.equal(isPartialModel(result.list[0]), true);
});

test('runtime search keeps duplicate datastore ids with distinct partial search identities', async () => {
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: {
			algolia: {
				kind: 'custom-runtime-duplicate-partial-datastore-hit',
				capabilities: { where: false, cursor: false, native: false, index: false },
				search: async (meta: ResolvedModelMeta) => ({
					list: [
						markSearchDocumentIdentity(
							{ id: 7, title: 'runtime partial left' },
							datastoreSearchDocumentIdentity(meta, 7, datastoreKey('remote_datastore_search_parent', 10))
						),
						markSearchDocumentIdentity(
							{ id: 7, title: 'runtime partial right' },
							datastoreSearchDocumentIdentity(meta, 7, datastoreKey('remote_datastore_search_parent', 20))
						)
					],
					count: 2,
					more: false
				}),
				index: async () => undefined,
				delete: async () => undefined
			}
		},
		defaultSearch: 'algolia'
	});
	const Record = RemoteDatastoreSearchRecord.use(context) as unknown as typeof RemoteDatastoreSearchRecord;

	const result = await Record.search('needle').using('algolia').load();

	assert.deepEqual(result.list.map((item) => item.data), [
		{ id: 7, title: 'runtime partial left' },
		{ id: 7, title: 'runtime partial right' }
	]);
	assert.deepEqual(result.list.map((item) => searchHitDocumentIdentity(item.data)), [
		datastoreSearchDocumentIdentity(context.meta(RemoteDatastoreSearchRecord), 7, datastoreKey('remote_datastore_search_parent', 10)),
		datastoreSearchDocumentIdentity(context.meta(RemoteDatastoreSearchRecord), 7, datastoreKey('remote_datastore_search_parent', 20))
	]);
});

test('runtime search rejects hook-added partial datastore ancestors that mismatch search identities', async () => {
	const hit = markSearchDocumentIdentity(
		{ id: 7, title: 'runtime partial mutated ancestor' },
		datastoreSearchDocumentIdentity(
			createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(RemoteDatastoreSearchRecord),
			7,
			datastoreKey('remote_datastore_search_parent', 10)
		)
	);
	const search: SearchAdapter = {
		kind: 'custom-runtime-mutated-partial-datastore-hit',
		capabilities: { where: false, cursor: false, native: false, index: false },
		search: async () => ({ list: [hit], count: 1, more: false }),
		index: async () => undefined,
		delete: async () => undefined
	};
	const createMutatingContext = (hook: 'afterInstantiate' | 'afterSearch') => createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { algolia: search },
		defaultSearch: 'algolia',
		plugins: [
			{
				name: `runtime-partial-search-${hook}-ancestor-mutation`,
				hooks: hook === 'afterInstantiate'
					? {
							afterInstantiate(payload) {
								if (payload.operation !== 'search' || payload.model?.name !== 'remote_datastore_search_record') return;
								payload.data.parentId = 20;
							}
						}
					: {
							afterSearch(payload) {
								if (payload.model?.name !== 'remote_datastore_search_record') return;
								(payload.result.list[0] as RemoteDatastoreSearchRecord).data.parentId = 20;
							}
						}
			}
		]
	});

	for (const hook of ['afterInstantiate', 'afterSearch'] as const) {
		const context = createMutatingContext(hook);
		const Record = RemoteDatastoreSearchRecord.use(context) as unknown as typeof RemoteDatastoreSearchRecord;
		await assert.rejects(
			() => Record.search('needle').using('algolia').load(),
			/Datastore search document identity does not match its payload data/
		);
	}
});

test('direct search handles accept forced datastore identities for unmarked partial hits', async () => {
	const contextHit = { id: 7, title: 'context forced partial needle' };
	const middlewareHit = { id: 7, title: 'middleware forced partial needle' };
	const wrongHit = { id: 7, parentId: 20, title: 'wrong forced full needle' };
	const contextSearch: SearchAdapter = {
		kind: 'custom-context-forced-partial-datastore-hit',
		capabilities: { where: false, cursor: false, native: false, index: false },
		search: async () => ({ list: [contextHit], count: 1, more: false }),
		index: async () => undefined,
		delete: async () => undefined
	};
	const middlewareSearch: SearchAdapter = {
		kind: 'custom-middleware-forced-partial-datastore-hit',
		capabilities: { where: false, cursor: false, native: false, index: false },
		search: async () => ({ list: [middlewareHit], count: 1, more: false }),
		index: async () => undefined,
		delete: async () => undefined
	};
	const wrongSearch: SearchAdapter = {
		kind: 'custom-context-forced-wrong-datastore-hit',
		capabilities: { where: false, cursor: false, native: false, index: false },
		search: async () => ({ list: [wrongHit], count: 1, more: false }),
		index: async () => undefined,
		delete: async () => undefined
	};
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { custom: contextSearch, wrong: wrongSearch },
		defaultSearch: 'custom'
	});
	const meta = context.meta(RemoteDatastoreSearchRecord);
	const forcedIdentity = datastoreSearchDocumentIdentity(
		meta,
		7,
		datastoreKey('remote_datastore_search_parent', 10)
	);
	const forcedMeta = { ...meta, searchDocumentIdentity: forcedIdentity };

	const contextResult = await context.searchAdapter('custom').search(forcedMeta, 'needle', {});
	assert.deepEqual(contextResult.list, [{ id: 7, title: 'context forced partial needle' }]);
	assert.equal(searchHitDocumentIdentity(contextResult.list[0]), forcedIdentity);

	const middleware = createSearchMiddlewareAdapter(middlewareSearch, []);
	const middlewareResult = await middleware.search(forcedMeta, 'needle', {});
	assert.deepEqual(middlewareResult.list, [{ id: 7, title: 'middleware forced partial needle' }]);
	assert.equal(searchHitDocumentIdentity(middlewareResult.list[0]), forcedIdentity);

	const staleMiddleware = createSearchMiddlewareAdapter({
		kind: 'custom-middleware-forced-stale-datastore-hit',
		capabilities: { where: false, cursor: false, native: false, index: false },
		search: async () => ({
			list: [
				markSearchDocumentIdentity(
					{ id: 7, title: 'middleware forced stale partial needle' },
					datastoreSearchDocumentIdentity(meta, 7, datastoreKey('remote_datastore_search_parent', 20))
				)
			],
			count: 1,
			more: false
		}),
		index: async () => undefined,
		delete: async () => undefined
	}, []);
	await assert.rejects(
		() => staleMiddleware.search(forcedMeta, 'needle', {}),
		/does not match forced Datastore search document identity/
	);

	await assert.rejects(
		() => context.searchAdapter('wrong').search(forcedMeta, 'needle', {}),
		/search document identity does not match its Datastore payload data/
	);
});

test('direct search handles strip untrusted datastore entity key metadata from hits', async () => {
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: {
			custom: {
				kind: 'custom-context-untrusted-hit-entity-key',
				capabilities: { where: false, cursor: false, native: false, index: false },
				search: async (model) => ({
					list: [
						Object.defineProperty(
							markSearchDocumentIdentity(
								{ id: 7, title: 'context untrusted key needle' },
								datastoreSearchDocumentIdentity(
									model,
									7,
									datastoreKey('remote_datastore_search_parent', 10)
								)
							),
							ACTIVE_TS_ENTITY_KEY,
							{
								value: datastoreKey(model.name, 7, {
									parent: datastoreKey('remote_datastore_search_parent', 99)
								}),
								enumerable: false
							}
						)
					],
					count: 1,
					more: false
				}),
				index: async () => undefined,
				delete: async () => undefined
			}
		},
		defaultSearch: 'custom'
	});
	const meta = context.meta(RemoteDatastoreSearchRecord);
	const expectedIdentity = datastoreSearchDocumentIdentity(
		meta,
		7,
		datastoreKey('remote_datastore_search_parent', 10)
	);
	const contextResult = await context.searchAdapter('custom').search(meta, 'needle', {});
	assert.equal(Object.getOwnPropertyDescriptor(contextResult.list[0], ACTIVE_TS_ENTITY_KEY), undefined);
	assert.equal(searchHitDocumentIdentity(contextResult.list[0]), expectedIdentity);

	const middleware = createSearchMiddlewareAdapter({
		kind: 'custom-middleware-untrusted-hit-entity-key',
		capabilities: { where: false, cursor: false, native: false, index: false },
		search: async (model) => ({
			list: [
				Object.defineProperty(
					markSearchDocumentIdentity(
						{ id: 7, title: 'middleware untrusted key needle' },
						datastoreSearchDocumentIdentity(
							model,
							7,
							datastoreKey('remote_datastore_search_parent', 10)
						)
					),
					ACTIVE_TS_ENTITY_KEY,
					{
						value: datastoreKey(model.name, 7, {
							parent: datastoreKey('remote_datastore_search_parent', 99)
						}),
						enumerable: false
					}
				)
			],
			count: 1,
			more: false
		}),
		index: async () => undefined,
		delete: async () => undefined
	}, []);
	const middlewareResult = await middleware.search(meta, 'needle', {});
	assert.equal(Object.getOwnPropertyDescriptor(middlewareResult.list[0], ACTIVE_TS_ENTITY_KEY), undefined);
	assert.equal(searchHitDocumentIdentity(middlewareResult.list[0]), expectedIdentity);
});

test('runtime search reloads decode field-codec datastore ancestor hit fields', async () => {
	const parent = datastoreKey('encoded_datastore_search_parent', 10);
	const capturedAncestors: unknown[] = [];
	const searchHit = markSearchDocumentIdentity(
		{ id: 7, parentId: 'parent:10', authorId: 1, title: 'encoded hit needle' },
		datastoreSearchDocumentIdentity({ name: 'encoded_datastore_search_record' }, 7, parent)
	);
	const store: StoreAdapter = {
		kind: 'encoded-datastore-search-store',
		capabilities: { datastoreAncestor: true },
		get: async (model, id, options) => {
			if (model.name === 'encoded_datastore_search_record') {
				capturedAncestors[capturedAncestors.length] = options?.meta?.datastoreAncestor;
				assert.deepEqual(options?.meta?.datastoreAncestor, parent);
				return {
					id,
					parentId: 'parent:10',
					authorId: 1,
					title: 'encoded full needle'
				};
			}
			if (model.name === 'search_include_author') return { id, name: 'Ada' };
			return null;
		},
		getMany: async (model, ids, options) => {
			const rows: Array<Record<string, unknown> | null> = [];
			for (let index = 0; index < ids.length; index++) {
				rows[index] = await store.get(model, ids[index], options);
			}
			return rows;
		},
		query: async (model, plan) => {
			if (model.name === 'encoded_datastore_search_record') {
				capturedAncestors[capturedAncestors.length] = plan.meta?.datastoreAncestor;
				assert.deepEqual(plan.meta?.datastoreAncestor, parent);
				return {
					list: [{
						id: 7,
						parentId: 'parent:10',
						authorId: 1,
						title: 'encoded full needle'
					}],
					more: false
				};
			}
			return { list: [], more: false };
		},
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	const search: SearchAdapter = {
		kind: 'custom',
		capabilities: { where: false, cursor: false, native: false, index: false },
		search: async () => ({ list: [searchHit], count: 1, more: false }),
		index: async () => undefined,
		delete: async () => undefined
	};
	const context = createActiveTs({
		stores: { default: store },
		search: { custom: search },
		defaultSearch: 'custom'
	});
	const Record = EncodedDatastoreSearchRecord.use(context) as unknown as typeof EncodedDatastoreSearchRecord;

	const partial = await Record.search('needle').using('custom').load();
	assert.deepEqual(partial.list.map((item) => item.data), [
		{ id: 7, title: 'encoded hit needle', parentId: 'parent:10' }
	]);

	const loaded = await Record.search('needle').using('custom').include('author').load();

	assert.deepEqual(loaded.list.map((item) => item.data), [
		{ id: 7, parentId: 10, authorId: 1, title: 'encoded full needle' }
	]);
	const author = await (loaded.list[0] as EncodedDatastoreSearchRecord).ref<SearchIncludeAuthor>('author');
	assert.equal((author as SearchIncludeAuthor).data.name, 'Ada');
	assert.deepEqual(capturedAncestors, [parent]);
});

test('runtime searches reject Datastore hits without document identity markers', async () => {
	const search: SearchAdapter = {
		kind: 'unmarked-datastore-runtime-search',
		capabilities: { where: false, cursor: false, native: false, index: false },
		search: async () => ({
			list: [{ id: 7, parentId: 10, title: 'unmarked runtime needle' }],
			count: 1,
			more: false
		}),
		index: async () => undefined,
		delete: async () => undefined
	};
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { custom: search },
		defaultSearch: 'custom'
	});
	const Record = RemoteDatastoreSearchRecord.use(context) as unknown as typeof RemoteDatastoreSearchRecord;

	await assert.rejects(
		() => context.searchAdapter('custom').search(context.meta(RemoteDatastoreSearchRecord), 'needle', {}),
		/missing search document identity/
	);
	await assert.rejects(
		() => Record.search('needle').using('custom').load(),
		/missing search document identity/
	);
});

test('search schema paths preserve datastore store namespaces in model metadata', async () => {
	const tenantStore = new MemoryStoreAdapter() as MemoryStoreAdapter & { datastoreNamespace: string };
	tenantStore.datastoreNamespace = 'schema_tenant';
	const captured: Array<{ operation: string; ancestors: unknown[] }> = [];
	const sampleData = { id: 7, parentId: 10, title: 'schema namespace' };
	const expectedAncestor = datastoreKey('schema_datastore_search_parent', 10, { namespace: 'schema_tenant' });
	const capturePlan = (operation: string, models: ResolvedModelMeta[]): SchemaPlan => {
		captured[captured.length] = {
			operation,
			ancestors: models.map((model) => model.datastore?.ancestor?.({ model, id: sampleData.id, data: sampleData }))
		};
		return { adapter: 'schema', changes: [] };
	};
	const search: SearchAdapter = {
		kind: 'schema',
		capabilities: { index: true },
		search: async () => ({ list: [] }),
		index: async () => undefined,
		delete: async () => undefined,
		schema: {
			plan: async (models) => capturePlan('direct-plan', models),
			apply: async (models) => capturePlan('direct-apply', models)
		},
		syncSchema: async (models) => capturePlan('direct-sync', models)
	};
	const context = createActiveTs({
		stores: { default: tenantStore },
		search: { schema: search },
		defaultSearch: 'schema'
	});
	const meta = context.meta(SchemaDatastoreSearchRecord);

	await context.searchAdapter('schema').schema!.plan([meta]);
	await context.searchAdapter('schema').schema!.apply([meta], { mode: 'safe' });
	await context.searchAdapter('schema').syncSchema!([meta]);
	await context.schemaPlan([SchemaDatastoreSearchRecord]);
	await context.schemaApply([SchemaDatastoreSearchRecord], { mode: 'safe' });
	const legacyContext = createActiveTs({
		stores: { default: tenantStore },
		search: {
			schema: {
				kind: 'schema',
				capabilities: { index: true },
				search: async () => ({ list: [] }),
				index: async () => undefined,
				delete: async () => undefined,
				syncSchema: async (models) => capturePlan('global-legacy-sync-apply', models)
			}
		},
		defaultSearch: 'schema'
	});
	await legacyContext.schemaApply([SchemaDatastoreSearchRecord], { mode: 'safe' });

	assert.deepEqual(captured, [
		{ operation: 'direct-plan', ancestors: [expectedAncestor] },
		{ operation: 'direct-apply', ancestors: [expectedAncestor] },
		{ operation: 'direct-sync', ancestors: [expectedAncestor] },
		{ operation: 'direct-plan', ancestors: [expectedAncestor] },
		{ operation: 'direct-apply', ancestors: [expectedAncestor] },
		{ operation: 'global-legacy-sync-apply', ancestors: [expectedAncestor] }
	]);
});

test('context search handles clear totals after datastore namespace hit pruning', async () => {
	const tenantAStore = new MemoryStoreAdapter() as MemoryStoreAdapter & { datastoreNamespace: string };
	const tenantBStore = new MemoryStoreAdapter() as MemoryStoreAdapter & { datastoreNamespace: string };
	tenantAStore.datastoreNamespace = 'tenant_a';
	tenantBStore.datastoreNamespace = 'tenant_b';
	const elasticIndexed: any[] = [];
	const elastic = await createElasticsearchSearchAdapter({
		client: {
			search: async () => ({
				hits: {
					hits: elasticIndexed.map((item) => ({ _id: item.id, _source: item.document })),
					total: { value: elasticIndexed.length }
				}
			}),
			index: async (payload: any) => elasticIndexed.push(payload),
			delete: async () => undefined
		}
	});
	const tenantAContext = createActiveTs({
		stores: { default: tenantAStore },
		search: { elasticsearch: elastic }
	});
	const tenantBContext = createActiveTs({
		stores: { default: tenantBStore },
		search: { elasticsearch: elastic }
	});
	const meta = tenantAContext.meta(RemoteDatastoreSearchRecord);
	await tenantAContext.searchAdapter('elasticsearch').index(meta, 7, {
		id: 7,
		parentId: 10,
		title: 'direct tenant a'
	});
	await tenantBContext.searchAdapter('elasticsearch').index(meta, 7, {
		id: 7,
		parentId: 10,
		title: 'direct tenant b'
	});

	const result = await tenantAContext.searchAdapter('elasticsearch').search(meta, 'direct', {});
	assert.deepEqual(result.list.map((item) => item.title), ['direct tenant a']);
	assert.equal(result.count, 1);
	assert.equal(result.total, undefined);
});

test('elasticsearch search hits keep datastore namespace document identities for public loads', async () => {
	const tenantAStore = new MemoryStoreAdapter() as MemoryStoreAdapter & { datastoreNamespace: string };
	const tenantBStore = new MemoryStoreAdapter() as MemoryStoreAdapter & { datastoreNamespace: string };
	tenantAStore.datastoreNamespace = 'tenant_a';
	tenantBStore.datastoreNamespace = 'tenant_b';
	const elasticIndexed: any[] = [];
	const elastic = await createElasticsearchSearchAdapter({
		client: {
			search: async () => ({
				hits: {
					hits: elasticIndexed.map((item) => ({ _id: item.id, _source: item.document })),
					total: { value: elasticIndexed.length }
				}
			}),
			index: async (payload: any) => elasticIndexed.push(payload),
			delete: async () => undefined
		}
	});
	const tenantAContext = createActiveTs({
		stores: { default: tenantAStore },
		search: { elasticsearch: elastic }
	});
	const tenantBContext = createActiveTs({
		stores: { default: tenantBStore },
		search: { elasticsearch: elastic }
	});
	const meta = tenantAContext.meta(RemoteDatastoreSearchRecord);
	await elastic.index(
		withDatastoreSearchNamespace(meta, 'tenant_a'),
		7,
		{ id: 7, parentId: 10, title: 'shared tenant a' }
	);
	await elastic.index(
		withDatastoreSearchNamespace(meta, 'tenant_b'),
		7,
		{ id: 7, parentId: 10, title: 'shared tenant b' }
	);
	const TenantARecord = RemoteDatastoreSearchRecord.use(tenantAContext) as unknown as typeof RemoteDatastoreSearchRecord;
	const TenantBRecord = RemoteDatastoreSearchRecord.use(tenantBContext) as unknown as typeof RemoteDatastoreSearchRecord;

	assert.deepEqual(
		(await TenantARecord.search('shared').using('elasticsearch').load()).list.map((item) => item.data.title),
		['shared tenant a']
	);
	assert.deepEqual(
		(await TenantBRecord.search('shared').using('elasticsearch').load()).list.map((item) => item.data.title),
		['shared tenant b']
	);
});

test('elasticsearch native pagination reports more from offset metadata', async () => {
	const meta = {
		...createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(SearchParityRecord),
		searchIndexes: []
	};
	const hits = (...ids: number[]) => ids.map((id) => ({ _id: `number:${id}`, _source: { id } }));
	const payloads: any[] = [];
	const elastic = await createElasticsearchSearchAdapter({
		client: {
			search: async (payload: any) => {
				payloads.push(payload);
				if (payload.body.search_after) {
					return { hits: { hits: hits(20, 21, 22), total: { value: 100 } } };
				}
				if (payload.body.from === 10) {
					return { hits: { hits: hits(10, 11, 12, 13, 14), total: { value: 15 } } };
				}
				if (payload.body.from === 12) {
					return { hits: { hits: hits(12, 13), total: { value: 15 } } };
				}
				return { hits: { hits: [], total: { value: 0 } } };
			},
			index: async () => undefined,
			delete: async () => undefined
		}
	});

	const terminalPage = await elastic.search(meta, 'ignored', {
		native: { query: { match_all: {} }, from: 10, size: 10 }
	});
	assert.deepEqual(terminalPage, {
		list: [{ id: 10 }, { id: 11 }, { id: 12 }, { id: 13 }, { id: 14 }],
		more: false,
		count: 5,
		total: 15
	});

	const middlePage = await elastic.search(meta, 'ignored', {
		native: { query: { match_all: {} }, from: 12, size: 2 }
	});
	assert.equal(middlePage.more, true);
	assert.deepEqual(middlePage.list, [{ id: 12 }, { id: 13 }]);

	const opaqueCursorPage = await elastic.search(meta, 'ignored', {
		native: { query: { match_all: {} }, search_after: ['cursor'], size: 3 }
	});
	assert.equal(Object.prototype.hasOwnProperty.call(opaqueCursorPage, 'more'), false);
	assert.equal(opaqueCursorPage.total, 100);

	const successfulSearches = payloads.length;
	await assert.rejects(
		() => elastic.search(meta, 'ignored', { native: { query: { match_all: {} }, from: 1.5 } }),
		/Elasticsearch native parameter "from" must be a non-negative safe integer/
	);
	assert.equal(payloads.length, successfulSearches);
});

test('elasticsearch portable search tolerates non-text projected fields', async () => {
	const meta = {
		...createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(SearchParityRecord),
		searchIndexes: [{ name: 'elastic_mixed_fields', adapter: 'elasticsearch', fields: ['title', 'score'] }]
	} as ResolvedModelMeta;
	const payloads: any[] = [];
	const elastic = await createElasticsearchSearchAdapter({
		client: {
			search: async (payload: any) => {
				payloads.push(payload);
				return { hits: { hits: [], total: { value: 0 } } };
			},
			index: async () => undefined,
			delete: async () => undefined
		}
	});

	await elastic.search(meta, 'shared', {});

	assert.equal(payloads.length, 1);
	assert.equal(payloads[0].body.query.multi_match.query, 'shared');
	assert.deepEqual(Array.from(payloads[0].body.query.multi_match.fields), ['title', 'score']);
	assert.equal(payloads[0].body.query.multi_match.lenient, true);
});

test('remote search adapters isolate SDK requests from inherited toJSON', async () => {
	const meta = createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(SearchParityRecord);
	let toJsonCalls = 0;
	const stringifyRequest = (payload: unknown) => {
		JSON.stringify(payload);
	};
	Object.defineProperty(Object.prototype, 'toJSON', {
		configurable: true,
		value() {
			toJsonCalls++;
			throw new Error('inherited toJSON should not run for remote search requests');
		}
	});
	try {
		const algolia = await createAlgoliaSearchAdapter({
			client: {
				searchSingleIndex: async (payload: unknown) => {
					stringifyRequest(payload);
					return { hits: [], nbHits: 0, nbPages: 1, page: 0 };
				},
				saveObject: async (payload: unknown) => {
					stringifyRequest(payload);
				},
				deleteObject: async (payload: unknown) => {
					stringifyRequest(payload);
				}
			}
		});
		await algolia.search(meta, 'safe', { native: { filters: 'tenant:1' } });
		await algolia.index(meta, 1, { id: 1, title: 'one', body: 'hidden' });
		await algolia.delete(meta, 1);

		const elastic = await createElasticsearchSearchAdapter({
			client: {
				search: async (payload: unknown) => {
					stringifyRequest(payload);
					return { hits: { hits: [], total: { value: 0 } } };
				},
				index: async (payload: unknown) => {
					stringifyRequest(payload);
				},
				delete: async (payload: unknown) => {
					stringifyRequest(payload);
				}
			}
		});
		await elastic.search(meta, 'safe', { native: { sort: [{ title: 'asc' }] } });
		await elastic.index(meta, 1, { id: 1, title: 'one', body: 'hidden' });
		await elastic.delete(meta, 1);
	} finally {
		delete (Object.prototype as Record<string, unknown>).toJSON;
	}
	assert.equal(toJsonCalls, 0);
});

test('remote search adapters reject undefined transport values before SDK calls', async () => {
	const meta = createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(SearchParityRecord);
	const algoliaPayloads: any[] = [];
	const algolia = await createAlgoliaSearchAdapter({
		client: {
			searchSingleIndex: async (payload: any) => {
				algoliaPayloads.push(payload);
				return { hits: [], nbHits: 0, nbPages: 1, page: 0 };
			},
			saveObject: async () => undefined,
			deleteObject: async () => undefined
		}
	});

	await algolia.search(meta, 'safe', {});
	assert.equal(Object.prototype.hasOwnProperty.call(algoliaPayloads[0].searchParams, 'hitsPerPage'), false);
	assert.equal(Object.prototype.hasOwnProperty.call(algoliaPayloads[0].searchParams, 'page'), false);
	await assert.rejects(
		() => algolia.search(meta, 'safe', { native: { filters: undefined } }),
		/Algolia search request\.searchParams\.filters cannot contain undefined/
	);
	assert.equal(algoliaPayloads.length, 1);

	const elasticPayloads: any[] = [];
	const elastic = await createElasticsearchSearchAdapter({
		client: {
			search: async (payload: any) => {
				elasticPayloads.push(payload);
				return { hits: { hits: [], total: { value: 0 } } };
			},
			index: async () => undefined,
			delete: async () => undefined
		}
	});

	await elastic.search(meta, 'safe', {});
	assert.equal(Object.prototype.hasOwnProperty.call(elasticPayloads[0], 'size'), false);
	await assert.rejects(
		() => elastic.search(meta, 'safe', { native: { sort: undefined } }),
		/Elasticsearch search request\.body\.sort cannot contain undefined/
	);
	assert.equal(elasticPayloads.length, 1);
});
