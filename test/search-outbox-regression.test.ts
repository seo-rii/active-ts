import test from 'node:test';
import assert from 'node:assert/strict';
import {
	ACTIVE_TS_ENTITY_KEY,
	Model,
	MemoryCacheAdapter,
	MemoryOutboxAdapter,
	MemorySearchAdapter,
	MemoryStoreAdapter,
	createActiveTs,
	createOutboxPlugin,
	createSearchMiddlewareAdapter,
	createStoreMiddlewareAdapter,
	datastoreKey,
	defineModel,
	runSearchSyncWorker,
	setDefaultContext,
	applyModelMeta,
	type OutboxAdapter,
	type SearchAdapter,
	type StoreAdapter
} from '../src/index.js';
import { datastoreSearchDocumentIdentity, searchDocumentIdentity, searchHitDocumentIdentity } from '../src/core/search-utils.js';
import { markStoreTrustsDatastoreEntityKeyRows } from '../src/core/store-options.js';

type OutboxSearchData = {
	id: number;
	title: string;
	body?: string;
};

type AncestorOutboxSearchData = {
	id: number;
	parentId: number;
	title: string;
};

type OptionalAncestorOutboxSearchData = {
	id: number;
	parentId?: number;
	title: string;
};
type NestedEncodedAncestorOutboxSearchData = {
	id: number;
	profile: {
		parentId: number;
		label: string;
	};
	title: string;
};

function sdkDatastoreEntityKey(path: Array<string | number>) {
	class SdkDatastoreEntityKey {}
	const key = new SdkDatastoreEntityKey() as { path: Array<string | number> };
	Object.defineProperty(key, 'path', {
		enumerable: true,
		get() {
			return path;
		}
	});
	return key;
}

class OutboxSearchDoc extends Model<OutboxSearchData> {}

defineModel<OutboxSearchData>({ name: 'outbox_search_regression_doc', search: 'memory' })
	.id('id')
	.validate((input) => input as OutboxSearchData)
	.search('memory', ['title'])
	.attach(OutboxSearchDoc);

class CachedOutboxSearchDoc extends Model<OutboxSearchData> {}

defineModel<OutboxSearchData>({ name: 'cached_outbox_search_regression_doc', cache: { ttl: 60 }, search: 'memory' })
	.id('id')
	.validate((input) => input as OutboxSearchData)
	.search('memory', ['title'])
	.attach(CachedOutboxSearchDoc);

class AncestorOutboxSearchDoc extends Model<AncestorOutboxSearchData> {}

defineModel<AncestorOutboxSearchData>({ name: 'ancestor_outbox_search_regression_doc', search: 'memory' })
	.id('id')
	.validate((input) => input as AncestorOutboxSearchData)
	.datastore({
		ancestor: ({ data }) => data ? datastoreKey('ancestor_outbox_parent', data.parentId) : undefined,
		ancestorFields: ['parentId']
	})
	.search('memory', ['title', 'parentId'])
	.attach(AncestorOutboxSearchDoc);

class OptionalAncestorOutboxSearchDoc extends Model<OptionalAncestorOutboxSearchData> {}

defineModel<OptionalAncestorOutboxSearchData>({ name: 'optional_ancestor_outbox_search_regression_doc', search: 'memory' })
	.id('id')
	.validate((input) => input as OptionalAncestorOutboxSearchData)
	.datastore({
		ancestor: ({ data }) => data?.parentId === undefined ? undefined : datastoreKey('ancestor_outbox_parent', data.parentId),
		ancestorFields: ['parentId']
	})
	.search('memory', ['title', 'parentId'])
	.attach(OptionalAncestorOutboxSearchDoc);

class NestedEncodedAncestorOutboxSearchDoc extends Model<NestedEncodedAncestorOutboxSearchData> {}

defineModel<NestedEncodedAncestorOutboxSearchData>({
	name: 'nested_encoded_ancestor_outbox_search_regression_doc',
	search: 'memory'
})
	.id('id')
	.validate((input) => input as NestedEncodedAncestorOutboxSearchData)
	.fieldCodec('profile', {
		name: 'nested-outbox-profile',
		encode: (value) => JSON.stringify(value),
		decode: (value) => JSON.parse(String(value))
	})
	.datastore({
		ancestor: ({ data }) => {
			const profile = data?.profile;
			return profile && typeof profile === 'object'
				? datastoreKey('nested_outbox_parent', profile.parentId)
				: undefined;
		},
		ancestorFields: ['profile.parentId']
	})
	.search('memory', ['title'])
	.attach(NestedEncodedAncestorOutboxSearchDoc);

class AliasOutboxSearchDoc extends Model<OutboxSearchData> {}

defineModel<OutboxSearchData>({ name: 'alias_outbox_search_regression_doc', search: 'search' })
	.id('id')
	.validate((input) => input as OutboxSearchData)
	.search('search', ['title'])
	.attach(AliasOutboxSearchDoc);

class PlannerOutboxSearchDoc extends Model<OutboxSearchData> {}
class RouteDependentOutboxSearchDoc extends Model<OutboxSearchData> {}
class MixedRouteOutboxSearchDoc extends Model<OutboxSearchData> {}
class PhysicalAliasOutboxSearchDoc extends Model<OutboxSearchData> {}

defineModel<OutboxSearchData>({ name: 'planner_outbox_search_regression_doc' })
	.id('id')
	.validate((input) => input as OutboxSearchData)
	.search('routed', ['title'])
	.attach(PlannerOutboxSearchDoc);

defineModel<OutboxSearchData>('route_dependent_outbox_search_regression_doc')
	.id('id')
	.validate((input) => input as OutboxSearchData)
	.attach(RouteDependentOutboxSearchDoc);

applyModelMeta(RouteDependentOutboxSearchDoc, {
	searchIndexes: [{ name: 'route_dependent_outbox_title', fields: ['title'] }]
});

defineModel<OutboxSearchData>('mixed_route_outbox_search_regression_doc')
	.id('id')
	.validate((input) => input as OutboxSearchData)
	.attach(MixedRouteOutboxSearchDoc);

applyModelMeta(MixedRouteOutboxSearchDoc, {
	searchIndexes: [
		{ name: 'mixed_route_outbox_title', fields: ['title'] },
		{ name: 'mixed_route_outbox_body', adapter: 'explicit', fields: ['body'] }
	]
});

defineModel<OutboxSearchData>('physical_alias_outbox_search_regression_doc')
	.id('id')
	.validate((input) => input as OutboxSearchData)
	.attach(PhysicalAliasOutboxSearchDoc);

applyModelMeta(PhysicalAliasOutboxSearchDoc, {
	searchIndexes: [
		{ name: 'physical_alias_outbox_title', adapter: 'algolia', fields: ['title'] }
	]
});

test('outbox plugin option allowlist ignores patched Array includes', () => {
	const includes = Object.getOwnPropertyDescriptor(Array.prototype, 'includes')!;
	Object.defineProperty(Array.prototype, 'includes', {
		configurable: true,
		value() {
			throw new Error('patched Array.includes');
		}
	});
	try {
		assert.doesNotThrow(() => createOutboxPlugin({ outbox: new MemoryOutboxAdapter(), includeData: true }));
	} finally {
		Object.defineProperty(Array.prototype, 'includes', includes);
	}
});

test('outbox adapters and search sync worker ignore patched Array map and filter', async () => {
	const map = Object.getOwnPropertyDescriptor(Array.prototype, 'map')!;
	const filter = Object.getOwnPropertyDescriptor(Array.prototype, 'filter')!;
	const { context, search } = setupOutboxSearch();
	const leasedEvent = {
		id: 'lease-event-1',
		model: 'outbox_search_regression_doc',
		modelId: 11,
		operation: 'create' as const,
		data: { id: 11, title: 'leased' },
		createdAt: '2026-05-13T00:00:00.000Z',
		leaseToken: 'lease-token',
		leaseExpiresAt: '2026-05-13T00:05:00.000Z'
	};
	const acked: string[] = [];
	const released: string[] = [];
	const leaseOutbox: OutboxAdapter = {
		lease: async () => [leasedEvent],
		ack: async (events) => {
			for (const event of events) acked.push(event.id);
		},
		isLeaseCurrent: async () => true,
		release: async (events) => {
			for (const event of events) released.push(event.id);
		},
		append: async () => undefined,
		drain: async () => [],
		requeue: async () => undefined,
		list: async () => []
	};
	let memoryListLength;
	let memoryDrainedLength;
	let workerCount;
	Object.defineProperty(Array.prototype, 'map', {
		configurable: true,
		value() {
			throw new Error('patched Array.map');
		}
	});
	Object.defineProperty(Array.prototype, 'filter', {
		configurable: true,
		value() {
			throw new Error('patched Array.filter');
		}
	});
	try {
		const outbox = new MemoryOutboxAdapter();
		await outbox.append({
			id: 'memory-event-1',
			model: 'outbox_search_regression_doc',
			modelId: 1,
			operation: 'create',
			data: { id: 1, title: 'memory' },
			createdAt: '2026-05-13T00:00:00.000Z'
		});
		memoryListLength = (await outbox.list()).length;
		const drained = await outbox.drain();
		memoryDrainedLength = drained.length;
		await outbox.requeue(drained);
		workerCount = await runSearchSyncWorker({
			outbox: leaseOutbox,
			search,
			models: [OutboxSearchDoc],
			context
		});
	} finally {
		Object.defineProperty(Array.prototype, 'map', map);
		Object.defineProperty(Array.prototype, 'filter', filter);
	}
	assert.equal(memoryListLength, 1);
	assert.equal(memoryDrainedLength, 1);
	assert.equal(workerCount, 1);
	assert.deepEqual(acked, ['lease-event-1']);
	assert.deepEqual(released, []);
	assert.deepEqual((await search.search(context.meta(OutboxSearchDoc), 'leased', {})).list.map((item) => item.id), [11]);
});

test('outbox validation boundaries use captured Object inspection intrinsics', async () => {
	const originals = {
		getOwnPropertyDescriptor: Object.getOwnPropertyDescriptor(Object, 'getOwnPropertyDescriptor')!,
		getOwnPropertyNames: Object.getOwnPropertyDescriptor(Object, 'getOwnPropertyNames')!,
		getOwnPropertySymbols: Object.getOwnPropertyDescriptor(Object, 'getOwnPropertySymbols')!,
		getPrototypeOf: Object.getOwnPropertyDescriptor(Object, 'getPrototypeOf')!
	};
	const outbox = new MemoryOutboxAdapter();
	const indexed: Array<{ model: string; id: number; data: OutboxSearchData }> = [];
	const search = {
		kind: 'outbox-captured-object-search',
		capabilities: { where: false, cursor: false, native: false, index: true },
		search: async () => ({ list: [], more: false }),
		index: async (model, id, data) => {
			indexed.push({ model: model.name, id: id as number, data: data as OutboxSearchData });
		},
		delete: async () => undefined
	} satisfies {
		kind: string;
		capabilities: { where: false; cursor: false; native: false; index: true };
		search: () => Promise<{ list: never[]; more: false }>;
		index: (model: { name: string }, id: unknown, data: unknown) => Promise<void>;
		delete: () => Promise<void>;
	};
	await outbox.append({
		id: 'object-intrinsic-event-1',
		model: 'outbox_search_regression_doc',
		modelId: 21,
		operation: 'create',
		data: { id: 21, title: 'object intrinsic indexed' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});
	let processed = 0;
	Object.defineProperties(Object, {
		getOwnPropertyDescriptor: {
			configurable: true,
			value() {
				throw new Error('patched Object.getOwnPropertyDescriptor');
			}
		},
		getOwnPropertyNames: {
			configurable: true,
			value() {
				throw new Error('patched Object.getOwnPropertyNames');
			}
		},
		getOwnPropertySymbols: {
			configurable: true,
			value() {
				throw new Error('patched Object.getOwnPropertySymbols');
			}
		},
		getPrototypeOf: {
			configurable: true,
			value() {
				throw new Error('patched Object.getPrototypeOf');
			}
		}
	});
	try {
		assert.doesNotThrow(() => createOutboxPlugin({ outbox, includeData: true }));
		processed = await runSearchSyncWorker({ outbox, search, models: [OutboxSearchDoc] });
	} finally {
		Object.defineProperties(Object, originals);
	}
	assert.equal(processed, 1);
	assert.deepEqual(indexed, [{
		model: 'outbox_search_regression_doc',
		id: 21,
		data: { id: 21, title: 'object intrinsic indexed' }
	}]);
});

class ValidatedOutboxSearchDoc extends Model<OutboxSearchData> {}

defineModel<OutboxSearchData>({ name: 'validated_outbox_search_regression_doc', search: 'memory' })
	.id('id')
	.validate((input) => {
		const data = input as OutboxSearchData;
		if (!data || typeof data.id !== 'number' || typeof data.title !== 'string') {
			throw new Error('invalid validated outbox search doc');
		}
		return { id: data.id, title: data.title, body: data.body };
	})
	.readValidation('error')
	.search('memory', ['title'])
	.attach(ValidatedOutboxSearchDoc);

class DuplicateOutboxSearchDoc extends Model<OutboxSearchData> {}

defineModel<OutboxSearchData>({ name: 'outbox_search_regression_doc', search: 'memory' })
	.id('id')
	.validate((input) => input as OutboxSearchData)
	.search('memory', ['title'])
	.attach(DuplicateOutboxSearchDoc);

function setupOutboxSearch() {
	const outbox = new MemoryOutboxAdapter();
	const search = new MemorySearchAdapter();
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory: search },
		defaultSearch: 'memory'
	});
	setDefaultContext(context);
	return { context, outbox, search };
}

test('search sync requeues failed and later events while keeping delivered events', async () => {
	const { context, outbox, search } = setupOutboxSearch();
	await outbox.append({
		id: 'event-1',
		model: 'outbox_search_regression_doc',
		modelId: 1,
		operation: 'create',
		data: { id: 1, title: 'delivered' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});
	await outbox.append({
		id: 'event-2',
		model: 'outbox_search_regression_doc',
		modelId: 2,
		operation: 'create',
		data: { id: 2, title: 'retry me' },
		createdAt: '2026-05-13T00:00:01.000Z'
	});
	await outbox.append({
		id: 'event-3',
		model: 'outbox_search_regression_doc',
		modelId: 3,
		operation: 'create',
		data: { id: 3, title: 'also retry' },
		createdAt: '2026-05-13T00:00:02.000Z'
	});

	const flakySearch = createSearchMiddlewareAdapter(search, [
		async (payload, next) => {
			if (payload.operation === 'index' && payload.args[0] === 2) throw new Error('index down');
			return await next();
		}
	]);
	const flakyContext = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory: flakySearch },
		defaultSearch: 'memory'
	});

	await assert.rejects(
		() => runSearchSyncWorker({ outbox, search: flakySearch, models: [OutboxSearchDoc], context: flakyContext }),
		/index down/
	);
	assert.deepEqual(
		(await search.search(context.meta(OutboxSearchDoc), 'delivered', {})).list.map((item) => item.id),
		[1]
	);
	assert.deepEqual(
		(await outbox.list()).map((event) => event.id),
		['event-2', 'event-3']
	);

	assert.equal(await runSearchSyncWorker({ outbox, search, models: [OutboxSearchDoc], context }), 2);
	assert.deepEqual(await outbox.list(), []);
	assert.deepEqual(
		(await search.search(context.meta(OutboxSearchDoc), 'retry', {})).list.map((item) => item.id),
		[2, 3]
	);
});

test('search sync requeues failed events ahead of newly appended events', async () => {
	const { context, outbox, search } = setupOutboxSearch();
	await outbox.append({
		id: 'retry-1',
		model: 'outbox_search_regression_doc',
		modelId: 1,
		operation: 'create',
		data: { id: 1, title: 'retry first' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});
	await outbox.append({
		id: 'retry-2',
		model: 'outbox_search_regression_doc',
		modelId: 2,
		operation: 'create',
		data: { id: 2, title: 'retry second' },
		createdAt: '2026-05-13T00:00:01.000Z'
	});

	const failingSearch = createSearchMiddlewareAdapter(search, [
		async (payload, next) => {
			if (payload.operation === 'index') {
				await outbox.append({
					id: 'new-event',
					model: 'outbox_search_regression_doc',
					modelId: 3,
					operation: 'create',
					data: { id: 3, title: 'new third' },
					createdAt: '2026-05-13T00:00:02.000Z'
				});
				throw new Error('index down');
			}
			return await next();
		}
	]);
	const failingContext = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory: failingSearch },
		defaultSearch: 'memory'
	});

	await assert.rejects(
		() => runSearchSyncWorker({ outbox, search: failingSearch, models: [OutboxSearchDoc], context: failingContext }),
		/index down/
	);
	assert.deepEqual(
		(await outbox.list()).map((event) => event.id),
		['retry-1', 'retry-2', 'new-event']
	);
});

test('search sync requeues sanitized event snapshots after failures', async () => {
	const { context, search } = setupOutboxSearch();
	const drained = [{
		id: 'event-snapshot',
		model: 'outbox_search_regression_doc',
		modelId: 1,
		operation: 'create' as const,
		data: { id: 1, title: 'retry original' },
		createdAt: '2026-05-13T00:00:00.000Z'
	}];
	const requeued: any[] = [];
	const outbox = {
		append: async () => undefined,
		requeue: async (events: any[]) => {
			requeued.push(...events);
			events[0].data.title = 'mutated by requeue';
		},
		drain: async () => drained
	};
	const failingSearch = createSearchMiddlewareAdapter(search, [
		async () => {
			throw new Error('index down');
		}
	]);
	const failingContext = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory: failingSearch },
		defaultSearch: 'memory'
	});

	await assert.rejects(
		() => runSearchSyncWorker({ outbox, search: failingSearch, models: [OutboxSearchDoc], context: failingContext }),
		/index down/
	);

	assert.equal(requeued.length, 1);
	assert.equal(requeued[0].data.title, 'mutated by requeue');
	assert.equal(drained[0].data.title, 'retry original');
});

test('search sync requeue rejects non-plain malformed event snapshots', async () => {
	const { context, search } = setupOutboxSearch();
	class NonPlainId {
		value = 1;
	}
	const modelId = new NonPlainId();
	let requeueCalls = 0;
	const outbox = {
		events: [{
			id: 'nonplain-model-id',
			model: 'outbox_search_regression_doc',
			modelId,
			operation: 'create' as const,
			data: { id: 1, title: 'retry original' },
			createdAt: '2026-05-13T00:00:00.000Z'
		}],
		append: async (event: any) => {
			throw new Error(`append fallback should not run for ${event.id}`);
		},
		requeue: async (events: any[]) => {
			requeueCalls++;
			events[0].modelId.value = 2;
			outbox.events.push(...events);
		},
		drain: async () => {
			const events = outbox.events;
			outbox.events = [];
			return events;
		}
	};

	await assert.rejects(
		() => runSearchSyncWorker({ outbox: outbox as any, search, models: [OutboxSearchDoc], context }),
		/Outbox search sync failed and requeue failed/
	);

	assert.equal(requeueCalls, 0);
	assert.equal(modelId.value, 1);
});

test('search sync requeue rejects unsafe primitive malformed event snapshots', async () => {
	const { context, search } = setupOutboxSearch();
	let requeueCalls = 0;
	const unsafeTitle = () => 'unsafe';
	const outbox = {
		events: [{
			id: 'unsafe-requeue-data',
			model: 'outbox_search_regression_doc',
			modelId: 1,
			operation: 'create' as const,
			data: { id: 1, title: unsafeTitle },
			createdAt: '2026-05-13T00:00:00.000Z'
		}],
		append: async (event: any) => {
			throw new Error(`append fallback should not run for ${event.id}`);
		},
		requeue: async (events: any[]) => {
			requeueCalls++;
			outbox.events.push(...events);
		},
		drain: async () => {
			const events = outbox.events;
			outbox.events = [];
			return events;
		}
	};

	await assert.rejects(
		() => runSearchSyncWorker({ outbox: outbox as any, search, models: [OutboxSearchDoc], context }),
		(error: unknown) => {
			assert.ok(error instanceof AggregateError);
			assert.match(error.message, /Outbox search sync failed and requeue failed/);
			assert.match((error.errors[0] as Error).message, /plain JSON-like data/);
			assert.match((error.errors[1] as Error).message, /plain data for requeue snapshotting/);
			return true;
		}
	);

	assert.equal(requeueCalls, 0);
	assert.deepEqual(outbox.events, []);
	assert.equal(unsafeTitle(), 'unsafe');
});

test('search sync delete events remove typed ids from memory search index', async () => {
	const { context, outbox, search } = setupOutboxSearch();
	const meta = context.meta(OutboxSearchDoc);
	await search.index(meta, 10, { id: 10, title: 'stale indexed row' });
	await outbox.append({
		id: 'delete-1',
		model: 'outbox_search_regression_doc',
		modelId: 10,
		operation: 'delete',
		createdAt: '2026-05-13T00:00:00.000Z'
	});

	assert.equal(await runSearchSyncWorker({ outbox, search, models: [OutboxSearchDoc], context }), 1);
	assert.deepEqual((await search.search(meta, 'stale', {})).list, []);
});

test('search sync keeps datastore ancestor documents with the same logical id distinct', async () => {
	const { context, outbox, search } = setupOutboxSearch();
	const meta = context.meta(AncestorOutboxSearchDoc);
	const left = datastoreKey('ancestor_outbox_parent', 10);
	const right = datastoreKey('ancestor_outbox_parent', 11);
	await outbox.append({
		id: 'ancestor-left-create',
		model: 'ancestor_outbox_search_regression_doc',
		modelId: 1,
		modelIdentity: datastoreSearchDocumentIdentity(meta, 1, left),
		modelDatastoreAncestor: left,
		operation: 'create',
		data: { id: 1, parentId: 10, title: 'shared child left' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});
	await outbox.append({
		id: 'ancestor-right-create',
		model: 'ancestor_outbox_search_regression_doc',
		modelId: 1,
		modelIdentity: datastoreSearchDocumentIdentity(meta, 1, right),
		modelDatastoreAncestor: right,
		operation: 'create',
		data: { id: 1, parentId: 11, title: 'shared child right' },
		createdAt: '2026-05-13T00:00:01.000Z'
	});

	assert.equal(await runSearchSyncWorker({ outbox, search, models: [AncestorOutboxSearchDoc], context }), 2);
	assert.deepEqual(
		(await search.search(meta, 'shared', {})).list.map((item) => item.parentId),
		[10, 11]
	);

	await outbox.append({
		id: 'ancestor-left-delete',
		model: 'ancestor_outbox_search_regression_doc',
		modelId: 1,
		modelIdentity: datastoreSearchDocumentIdentity(meta, 1, left),
		modelDatastoreAncestor: left,
		operation: 'delete',
		createdAt: '2026-05-13T00:00:02.000Z'
	});

	assert.equal(await runSearchSyncWorker({ outbox, search, models: [AncestorOutboxSearchDoc], context }), 1);
	assert.deepEqual(await outbox.list(), []);
	assert.deepEqual(
		(await search.search(meta, 'shared', {})).list.map((item) => item.parentId),
		[11]
	);
});

test('search sync beforeIndex hooks cannot redirect Datastore outbox search identities', async () => {
	const outbox = new MemoryOutboxAdapter();
	const search = new MemorySearchAdapter();
	let forgedIdentity = '';
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory: search },
		defaultSearch: 'memory',
		plugins: [
			{
				name: 'search-identity-mutator',
				hooks: {
					beforeIndex(payload) {
						(payload.model as any).searchDocumentIdentity = forgedIdentity;
					}
				}
			}
		]
	});
	const meta = context.meta(AncestorOutboxSearchDoc);
	const left = datastoreKey('ancestor_outbox_parent', 10);
	const right = datastoreKey('ancestor_outbox_parent', 11);
	forgedIdentity = datastoreSearchDocumentIdentity(meta, 1, right);
	await search.index(meta, 1, { id: 1, parentId: 10, title: 'shared child left' });
	await search.index(meta, 1, { id: 1, parentId: 11, title: 'shared child right' });
	await outbox.append({
		id: 'ancestor-left-delete-mutated-hook',
		model: 'ancestor_outbox_search_regression_doc',
		modelId: 1,
		modelIdentity: datastoreSearchDocumentIdentity(meta, 1, left),
		modelDatastoreAncestor: left,
		operation: 'delete',
		createdAt: '2026-05-13T00:00:02.000Z'
	});

	assert.equal(await runSearchSyncWorker({ outbox, search, models: [AncestorOutboxSearchDoc], context }), 1);
	assert.deepEqual(
		(await search.search(meta, 'shared', {})).list.map((item) => item.parentId),
		[11]
	);
});

test('search sync keeps datastore adapter namespaces distinct for the same ancestor identity', async () => {
	const search = new MemorySearchAdapter();
	const tenantAOutbox = new MemoryOutboxAdapter();
	const tenantBOutbox = new MemoryOutboxAdapter();
	const tenantABackingStore = new MemoryStoreAdapter();
	const tenantBBackingStore = new MemoryStoreAdapter();
	const tenantAStore: StoreAdapter = {
		kind: tenantABackingStore.kind,
		capabilities: { ...tenantABackingStore.capabilities, transaction: false, datastoreAncestor: true },
		datastoreNamespace: 'tenant_a',
		get: (...args) => tenantABackingStore.get(...args),
		getMany: (...args) => tenantABackingStore.getMany(...args),
		query: (model, plan, options) => {
			const meta = plan.meta ? { ...plan.meta } : undefined;
			if (meta) delete meta.datastoreAncestor;
			return tenantABackingStore.query(model, { ...plan, meta }, options);
		},
		aggregate: (...args) => tenantABackingStore.aggregate(...args),
		create: (model, id, data, options) => tenantABackingStore.create(model, id, data, { expectedVersion: options?.expectedVersion }),
		update: (model, id, data, options) => tenantABackingStore.update(model, id, data, { expectedVersion: options?.expectedVersion }),
		delete: (model, id, options) => tenantABackingStore.delete(model, id, { expectedVersion: options?.expectedVersion }),
		schema: tenantABackingStore.schema
	};
	const tenantBStore: StoreAdapter = {
		kind: tenantBBackingStore.kind,
		capabilities: { ...tenantBBackingStore.capabilities, transaction: false, datastoreAncestor: true },
		datastoreNamespace: 'tenant_b',
		get: (...args) => tenantBBackingStore.get(...args),
		getMany: (...args) => tenantBBackingStore.getMany(...args),
		query: (model, plan, options) => {
			const meta = plan.meta ? { ...plan.meta } : undefined;
			if (meta) delete meta.datastoreAncestor;
			return tenantBBackingStore.query(model, { ...plan, meta }, options);
		},
		aggregate: (...args) => tenantBBackingStore.aggregate(...args),
		create: (model, id, data, options) => tenantBBackingStore.create(model, id, data, { expectedVersion: options?.expectedVersion }),
		update: (model, id, data, options) => tenantBBackingStore.update(model, id, data, { expectedVersion: options?.expectedVersion }),
		delete: (model, id, options) => tenantBBackingStore.delete(model, id, { expectedVersion: options?.expectedVersion }),
		schema: tenantBBackingStore.schema
	};
	const tenantAContext = createActiveTs({
		stores: { default: tenantAStore },
		search: { memory: search },
		defaultSearch: 'memory',
		plugins: [createOutboxPlugin({ outbox: tenantAOutbox })]
	});
	const tenantBContext = createActiveTs({
		stores: { default: tenantBStore },
		search: { memory: search },
		defaultSearch: 'memory',
		plugins: [createOutboxPlugin({ outbox: tenantBOutbox })]
	});
	const TenantADoc = AncestorOutboxSearchDoc.use(tenantAContext) as unknown as typeof AncestorOutboxSearchDoc;
	const TenantBDoc = AncestorOutboxSearchDoc.use(tenantBContext) as unknown as typeof AncestorOutboxSearchDoc;

	const tenantAItem = await TenantADoc.create({ id: 1, parentId: 10, title: 'shared tenant a' });
	await TenantBDoc.create({ id: 1, parentId: 10, title: 'shared tenant b' });
	assert.equal(await runSearchSyncWorker({ outbox: tenantAOutbox, search, models: [AncestorOutboxSearchDoc], context: tenantAContext }), 1);
	assert.equal(await runSearchSyncWorker({ outbox: tenantBOutbox, search, models: [AncestorOutboxSearchDoc], context: tenantBContext }), 1);
	assert.deepEqual(
		(await search.search(tenantAContext.meta(AncestorOutboxSearchDoc), 'shared', {})).list.map((item) => item.title).sort(),
		['shared tenant a', 'shared tenant b']
	);
	assert.deepEqual(
		(await tenantAContext.searchAdapter('memory').search(tenantAContext.meta(AncestorOutboxSearchDoc), 'shared', {})).list.map((item) => item.title),
		['shared tenant a']
	);
	assert.deepEqual(
		(await TenantADoc.search('shared').load()).list.map((item) => item.data.title),
		['shared tenant a']
	);
	assert.deepEqual(
		(await TenantBDoc.search('shared').load()).list.map((item) => item.data.title),
		['shared tenant b']
	);

	await tenantAItem.delete();
	assert.equal(await runSearchSyncWorker({ outbox: tenantAOutbox, search, models: [AncestorOutboxSearchDoc], context: tenantAContext }), 1);
	assert.deepEqual(
		(await search.search(tenantBContext.meta(AncestorOutboxSearchDoc), 'shared', {})).list.map((item) => item.title),
		['shared tenant b']
	);
	assert.deepEqual((await TenantADoc.search('shared').load()).list, []);
	assert.deepEqual(
		(await TenantBDoc.search('shared').load()).list.map((item) => item.data.title),
		['shared tenant b']
	);
});

test('search sync passes namespaced Datastore metadata to search adapters', async () => {
	const capturedAncestors: unknown[] = [];
	const capturedIdentities: string[] = [];
	const search: SearchAdapter = {
		kind: 'memory',
		capabilities: { index: true },
		search: async () => ({ list: [] }),
		index: async (model, id, data) => {
			capturedAncestors[capturedAncestors.length] = model.datastore?.ancestor?.({ model, id, data });
			capturedIdentities[capturedIdentities.length] = searchDocumentIdentity(
				model,
				id,
				`${model.name} outbox sync search document identity`,
				data
			);
		},
		delete: async () => undefined
	};
	const backingStore = new MemoryStoreAdapter();
	const store: StoreAdapter = {
		kind: backingStore.kind,
		capabilities: { ...backingStore.capabilities, transaction: false, datastoreAncestor: true },
		datastoreNamespace: 'sync_tenant',
		get: (...args) => backingStore.get(...args),
		getMany: (...args) => backingStore.getMany(...args),
		query: (...args) => backingStore.query(...args),
		aggregate: (...args) => backingStore.aggregate(...args),
		create: (...args) => backingStore.create(...args),
		update: (...args) => backingStore.update(...args),
		delete: (...args) => backingStore.delete(...args),
		schema: backingStore.schema
	};
	const outbox = new MemoryOutboxAdapter();
	const context = createActiveTs({
		stores: { default: store },
		search: { memory: search },
		defaultSearch: 'memory'
	});
	const expectedAncestor = datastoreKey('ancestor_outbox_parent', 10, { namespace: 'sync_tenant' });
	await outbox.append({
		id: 'ancestor-namespaced-metadata-create',
		model: 'ancestor_outbox_search_regression_doc',
		modelId: 1,
		modelIdentity: datastoreSearchDocumentIdentity(context.meta(AncestorOutboxSearchDoc), 1, expectedAncestor),
		modelDatastoreAncestor: expectedAncestor,
		operation: 'create',
		data: { id: 1, parentId: 10, title: 'namespaced metadata' },
		createdAt: '2026-05-13T00:00:03.000Z'
	});

	assert.equal(await runSearchSyncWorker({ outbox, search, models: [AncestorOutboxSearchDoc], context }), 1);
	assert.deepEqual(capturedAncestors, [expectedAncestor]);
	assert.deepEqual(capturedIdentities, [
		datastoreSearchDocumentIdentity(context.meta(AncestorOutboxSearchDoc), 1, expectedAncestor)
	]);
});

test('store middleware preserves datastore namespace for search outbox identity', async () => {
	const events: any[] = [];
	const outbox: OutboxAdapter = { append: async (event) => { events.push(event); } };
	const backingStore = new MemoryStoreAdapter();
	const baseStore: StoreAdapter = {
		kind: backingStore.kind,
		capabilities: { ...backingStore.capabilities, transaction: false, datastoreAncestor: true },
		datastoreNamespace: 'middleware_tenant',
		get: (...args) => backingStore.get(...args),
		getMany: (...args) => backingStore.getMany(...args),
		query: (model, plan, options) => {
			const meta = plan.meta ? { ...plan.meta } : undefined;
			if (meta) delete meta.datastoreAncestor;
			return backingStore.query(model, { ...plan, meta }, options);
		},
		aggregate: (...args) => backingStore.aggregate(...args),
		create: (model, id, data, options) => backingStore.create(model, id, data, { expectedVersion: options?.expectedVersion }),
		update: (model, id, data, options) => backingStore.update(model, id, data, { expectedVersion: options?.expectedVersion }),
		delete: (model, id, options) => backingStore.delete(model, id, { expectedVersion: options?.expectedVersion }),
		schema: backingStore.schema
	};
	const context = createActiveTs({
		stores: { default: createStoreMiddlewareAdapter(baseStore, []) },
		search: { memory: new MemorySearchAdapter() },
		defaultSearch: 'memory',
		plugins: [createOutboxPlugin({ outbox })]
	});
	await AncestorOutboxSearchDoc.create({ id: 9, parentId: 90, title: 'middleware tenant' }, context);

	const expectedAncestor = datastoreKey('ancestor_outbox_parent', 90, { namespace: 'middleware_tenant' });
	assert.equal(events.length, 1);
	assert.deepEqual(events[0].modelDatastoreAncestor, expectedAncestor);
	assert.equal(
		events[0].modelIdentity,
		datastoreSearchDocumentIdentity(context.meta(AncestorOutboxSearchDoc), 9, expectedAncestor)
	);
});

test('transaction outbox identity preserves source datastore namespace when tx store omits it', async () => {
	const events: any[] = [];
	const outbox: OutboxAdapter = { append: async (event) => { events.push(event); } };
	const rows = new Map<number, any>();
	const store: StoreAdapter = {
		kind: 'namespaced-transaction-store',
		capabilities: { datastoreAncestor: true, transaction: true },
		datastoreNamespace: 'transaction_tenant',
		get: async (_model, id) => rows.get(id as number) ?? null,
		getMany: async (_model, ids) => ids.map((id) => rows.get(id as number) ?? null),
		query: async () => ({ list: [...rows.values()], more: false, count: rows.size }),
		create: async (_model, id, data) => { rows.set(id as number, data); },
		update: async (_model, id, data) => { rows.set(id as number, data); },
		delete: async (_model, id) => { rows.delete(id as number); },
		transaction: async (fn) => {
			const txStore: StoreAdapter = {
				kind: 'namespaced-transaction-store-tx',
				capabilities: { datastoreAncestor: true },
				get: store.get,
				getMany: store.getMany,
				query: store.query,
				create: store.create,
				update: store.update,
				delete: store.delete
			};
			return await fn(txStore);
		}
	};
	const context = createActiveTs({
		stores: { default: store },
		search: { memory: new MemorySearchAdapter() },
		defaultSearch: 'memory',
		plugins: [createOutboxPlugin({ outbox })]
	});
	await context.transaction(async (tx) => {
		await AncestorOutboxSearchDoc.create({ id: 10, parentId: 100, title: 'transaction tenant' }, tx);
	});

	const expectedAncestor = datastoreKey('ancestor_outbox_parent', 100, { namespace: 'transaction_tenant' });
	assert.equal(events.length, 1);
	assert.deepEqual(events[0].modelDatastoreAncestor, expectedAncestor);
	assert.equal(
		events[0].modelIdentity,
		datastoreSearchDocumentIdentity(context.meta(AncestorOutboxSearchDoc), 10, expectedAncestor)
	);
});

test('search sync derives datastore identity from dataful ancestor delete events', async () => {
	const { context, outbox, search } = setupOutboxSearch();
	const meta = context.meta(AncestorOutboxSearchDoc);
	await outbox.append({
		id: 'ancestor-dataful-delete-left-create',
		model: 'ancestor_outbox_search_regression_doc',
		modelId: 1,
		operation: 'create',
		data: { id: 1, parentId: 10, title: 'dataful delete left' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});
	await outbox.append({
		id: 'ancestor-dataful-delete-right-create',
		model: 'ancestor_outbox_search_regression_doc',
		modelId: 1,
		operation: 'create',
		data: { id: 1, parentId: 11, title: 'dataful delete right' },
		createdAt: '2026-05-13T00:00:01.000Z'
	});

	assert.equal(await runSearchSyncWorker({ outbox, search, models: [AncestorOutboxSearchDoc], context }), 2);
	await outbox.append({
		id: 'ancestor-dataful-delete',
		model: 'ancestor_outbox_search_regression_doc',
		modelId: 1,
		operation: 'delete',
		data: { id: 1, parentId: 10, title: 'dataful delete left' },
		createdAt: '2026-05-13T00:00:02.000Z'
	});

	assert.equal(await runSearchSyncWorker({ outbox, search, models: [AncestorOutboxSearchDoc], context }), 1);
	assert.deepEqual(
		(await search.search(meta, 'dataful', {})).list.map((item) => item.parentId),
		[11]
	);
});

test('search sync dataful deletes fall back to stored datastore identity metadata', async () => {
	const { context, outbox, search } = setupOutboxSearch();
	const meta = context.meta(AncestorOutboxSearchDoc);
	const left = datastoreKey('ancestor_outbox_parent', 10);
	await outbox.append({
		id: 'ancestor-metadata-delete-create',
		model: 'ancestor_outbox_search_regression_doc',
		modelId: 1,
		operation: 'create',
		data: { id: 1, parentId: 10, title: 'dataful delete metadata' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});

	assert.equal(await runSearchSyncWorker({ outbox, search, models: [AncestorOutboxSearchDoc], context }), 1);
	await outbox.append({
		id: 'ancestor-metadata-delete',
		model: 'ancestor_outbox_search_regression_doc',
		modelId: 1,
		modelIdentity: datastoreSearchDocumentIdentity(meta, 1, left),
		modelDatastoreAncestor: left,
		operation: 'delete',
		data: { id: 1, title: 'dataful delete metadata' },
		createdAt: '2026-05-13T00:00:02.000Z'
	});

	assert.equal(await runSearchSyncWorker({ outbox, search, models: [AncestorOutboxSearchDoc], context }), 1);
	assert.deepEqual((await search.search(meta, 'dataful', {})).list, []);
});

test('search sync rejects datastore index payloads missing ancestor fields even with stored metadata', async () => {
	const { context, outbox, search } = setupOutboxSearch();
	const meta = context.meta(AncestorOutboxSearchDoc);
	const parent = datastoreKey('ancestor_outbox_parent', 10);
	await outbox.append({
		id: 'ancestor-index-missing-ancestor-field',
		model: 'ancestor_outbox_search_regression_doc',
		modelId: 1,
		modelIdentity: datastoreSearchDocumentIdentity(meta, 1, parent),
		modelDatastoreAncestor: parent,
		operation: 'create',
		data: { id: 1, title: 'stored metadata without parent' },
		createdAt: '2026-05-13T00:00:03.000Z'
	});

	await assert.rejects(
		() => runSearchSyncWorker({ outbox, search, models: [AncestorOutboxSearchDoc], context }),
		/missing Datastore ancestor metadata field "parentId"/
	);
	assert.deepEqual((await search.search(meta, 'stored', {})).list, []);
});

test('search sync dataful deletes can derive datastore identity from preserved entity keys', async () => {
	const { context, search } = setupOutboxSearch();
	const meta = context.meta(AncestorOutboxSearchDoc);
	const right = datastoreKey('ancestor_outbox_parent', 11);
	const rightDeleteData = Object.defineProperty(
		{ id: 1, title: 'dataful delete entity key' },
		ACTIVE_TS_ENTITY_KEY,
		{
			value: sdkDatastoreEntityKey(['ancestor_outbox_parent', 11, 'ancestor_outbox_search_regression_doc', 1]),
			enumerable: false
		}
	);
	const event = {
		id: 'ancestor-entity-key-delete',
		model: 'ancestor_outbox_search_regression_doc',
		modelId: 1,
		modelIdentity: datastoreSearchDocumentIdentity(meta, 1, right),
		operation: 'delete' as const,
		data: rightDeleteData,
		createdAt: '2026-05-13T00:00:03.000Z'
	};
	const outbox: OutboxAdapter = {
		append: async () => undefined,
		lease: async () => [event],
		isLeaseCurrent: async () => true,
		release: async () => undefined,
		ack: async () => undefined
	};
	await context.searchAdapter('memory').index(meta, 1, { id: 1, parentId: 11, title: 'dataful delete entity key' });

	assert.equal(await runSearchSyncWorker({ outbox, search, models: [AncestorOutboxSearchDoc], context }), 1);
	assert.deepEqual((await search.search(meta, 'dataful', {})).list, []);
});

test('search sync rejects stale delete identity from encoded nested ancestor payloads', async () => {
	const backingSearch = new MemorySearchAdapter();
	let deleteCalls = 0;
	const search = createSearchMiddlewareAdapter(backingSearch, [
		async (operation, next) => {
			if (operation.operation === 'delete') deleteCalls++;
			return await next();
		}
	]);
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory: search },
		defaultSearch: 'memory'
	});
	const meta = context.meta(NestedEncodedAncestorOutboxSearchDoc);
	const staleParent = datastoreKey('nested_outbox_parent', 10);
	const staleIdentity = datastoreSearchDocumentIdentity(meta, 7, staleParent);
	const outbox: OutboxAdapter = {
		append: async () => undefined,
		drain: async () => [
			{
				id: 'nested-encoded-delete-stale-identity',
				model: 'nested_encoded_ancestor_outbox_search_regression_doc',
				modelId: 7,
				modelIdentity: staleIdentity,
				operation: 'delete',
				data: {
					id: 7,
					profile: JSON.stringify({ parentId: 11, label: 'wrong' }),
					title: 'encoded nested delete'
				},
				createdAt: '2026-05-13T00:00:04.000Z'
			}
		],
		requeue: async () => undefined
	};

	await assert.rejects(
		() => runSearchSyncWorker({
			outbox,
			search,
			models: [NestedEncodedAncestorOutboxSearchDoc],
			context
		}),
		/Datastore ancestor does not match its payload data|modelIdentity does not match its Datastore ancestor/
	);
	assert.equal(deleteCalls, 0);
});

test('search sync rejects stored field-codec payloads whose entity key differs from decoded ancestor', async () => {
	const backingSearch = new MemorySearchAdapter();
	let indexCalls = 0;
	const search = createSearchMiddlewareAdapter(backingSearch, [
		async (operation, next) => {
			if (operation.operation === 'index') indexCalls++;
			return await next();
		}
	]);
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory: search },
		defaultSearch: 'memory'
	});
	const meta = context.meta(NestedEncodedAncestorOutboxSearchDoc);
	const parent = datastoreKey('nested_outbox_parent', 10);
	const storedData = Object.defineProperty(
		{
			id: 7,
			profile: JSON.stringify({ parentId: 10, label: 'stored' }),
			title: 'stored nested index'
		},
		ACTIVE_TS_ENTITY_KEY,
		{
			value: sdkDatastoreEntityKey(['nested_outbox_parent', 11, 'nested_encoded_ancestor_outbox_search_regression_doc', 7]),
			enumerable: false
		}
	);
	const outbox: OutboxAdapter = {
		append: async () => undefined,
		drain: async () => [
			{
				id: 'nested-stored-entity-key-mismatch',
				model: 'nested_encoded_ancestor_outbox_search_regression_doc',
				modelId: 7,
				modelIdentity: datastoreSearchDocumentIdentity(meta, 7, parent),
				operation: 'update',
				data: storedData,
				dataEncoding: 'stored',
				createdAt: '2026-05-13T00:00:04.500Z'
			}
		],
		requeue: async () => undefined
	};

	await assert.rejects(
		() => runSearchSyncWorker({
			outbox,
			search,
			models: [NestedEncodedAncestorOutboxSearchDoc],
			context
		}),
		/Datastore ancestor does not match its payload data/
	);
	assert.equal(indexCalls, 0);
});

test('search sync indexes public decoded field-codec ancestor payloads', async () => {
	const search = new MemorySearchAdapter();
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory: search },
		defaultSearch: 'memory'
	});
	const meta = context.meta(NestedEncodedAncestorOutboxSearchDoc);
	const parent = datastoreKey('nested_outbox_parent', 10);
	const outbox: OutboxAdapter = {
		append: async () => undefined,
		drain: async () => [
			{
				id: 'nested-public-decoded-index',
				model: 'nested_encoded_ancestor_outbox_search_regression_doc',
				modelId: 7,
				operation: 'update',
				data: {
					id: 7,
					profile: { parentId: 10, label: 'decoded' },
					title: 'public decoded nested index'
				},
				dataEncoding: 'public',
				createdAt: '2026-05-13T00:00:05.000Z'
			}
		],
		requeue: async () => undefined
	};

	assert.equal(await runSearchSyncWorker({
		outbox,
		search,
		models: [NestedEncodedAncestorOutboxSearchDoc],
		context
	}), 1);

	const result = await search.search(meta, 'public', {});
	assert.equal(result.list.length, 1);
	assert.equal(searchHitDocumentIdentity(result.list[0]), datastoreSearchDocumentIdentity(meta, 7, parent));
});

test('search sync rejects datastore payloads whose preserved entity key differs from payload ancestor', async () => {
	const { context, outbox, search } = setupOutboxSearch();
	const badData = Object.defineProperty(
		{ id: 1, parentId: 10, title: 'wrong entity key parent' },
		ACTIVE_TS_ENTITY_KEY,
		{
			value: sdkDatastoreEntityKey(['ancestor_outbox_parent', 11, 'ancestor_outbox_search_regression_doc', 1]),
			enumerable: false
		}
	);
	await outbox.append({
		id: 'ancestor-bad-entity-key-payload',
		model: 'ancestor_outbox_search_regression_doc',
		modelId: 1,
		operation: 'create',
		data: badData,
		createdAt: '2026-05-13T00:00:04.000Z'
	});

	await assert.rejects(
		() => runSearchSyncWorker({ outbox, search, models: [AncestorOutboxSearchDoc], context }),
		/Datastore ancestor does not match its payload data/
	);
});

test('search sync rejects inconsistent datastore outbox identity metadata', async () => {
	const { context, outbox, search } = setupOutboxSearch();
	const meta = context.meta(AncestorOutboxSearchDoc);
	const left = datastoreKey('ancestor_outbox_parent', 10);
	const right = datastoreKey('ancestor_outbox_parent', 11);
	await outbox.append({
		id: 'ancestor-bad-identity',
		model: 'ancestor_outbox_search_regression_doc',
		modelId: 1,
		modelIdentity: datastoreSearchDocumentIdentity(meta, 1, left),
		modelDatastoreAncestor: right,
		operation: 'delete',
		createdAt: '2026-05-13T00:00:00.000Z'
	});

	await assert.rejects(
		() => runSearchSyncWorker({ outbox, search, models: [AncestorOutboxSearchDoc], context }),
		/modelIdentity does not match its Datastore ancestor/
	);
});

test('search sync rejects datastore payloads whose ancestor differs from event metadata', async () => {
	const { context, outbox, search } = setupOutboxSearch();
	const meta = context.meta(AncestorOutboxSearchDoc);
	const left = datastoreKey('ancestor_outbox_parent', 10);
	await outbox.append({
		id: 'ancestor-bad-payload',
		model: 'ancestor_outbox_search_regression_doc',
		modelId: 1,
		modelIdentity: datastoreSearchDocumentIdentity(meta, 1, left),
		modelDatastoreAncestor: left,
		operation: 'update',
		data: { id: 1, parentId: 11, title: 'wrong ancestor' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});

	await assert.rejects(
		() => runSearchSyncWorker({ outbox, search, models: [AncestorOutboxSearchDoc], context }),
		/Datastore ancestor does not match its payload data/
	);
});

test('search sync derives datastore identity from dataful ancestor events', async () => {
	const { context, outbox, search } = setupOutboxSearch();
	const meta = context.meta(AncestorOutboxSearchDoc);
	await outbox.append({
		id: 'ancestor-legacy-payload',
		model: 'ancestor_outbox_search_regression_doc',
		modelId: 4,
		operation: 'create',
		data: { id: 4, parentId: 12, title: 'legacy payload child' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});

	assert.equal(await runSearchSyncWorker({ outbox, search, models: [AncestorOutboxSearchDoc], context }), 1);
	assert.deepEqual(
		(await search.search(meta, 'legacy', {})).list.map((item) => item.parentId),
		[12]
	);
});

test('search sync rejects datastore payloads without derivable ancestor metadata', async () => {
	const { context, outbox, search } = setupOutboxSearch();
	await outbox.append({
		id: 'ancestor-missing-payload-metadata',
		model: 'optional_ancestor_outbox_search_regression_doc',
		modelId: 5,
		operation: 'create',
		data: { id: 5, title: 'missing parent' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});

	await assert.rejects(
		() => runSearchSyncWorker({ outbox, search, models: [OptionalAncestorOutboxSearchDoc], context }),
		/missing Datastore ancestor metadata/
	);
});

test('direct search indexing rejects datastore documents without derivable ancestor metadata', async () => {
	const { context, search } = setupOutboxSearch();
	const meta = context.meta(OptionalAncestorOutboxSearchDoc);

	await assert.rejects(
		() => search.index(meta, 6, { id: 6, title: 'missing parent' }),
		/requires ancestor metadata/
	);
});

test('outbox plugin captures datastore ancestor identity for data-less delete events', async () => {
	const events: any[] = [];
	const outbox: OutboxAdapter = {
		append: async (event) => {
			events.push(event);
		}
	};
	const rows = new Map<number, any>();
	const store: StoreAdapter = {
		kind: 'metadata-write-test',
		create: async (_model, id, data) => {
			rows.set(id as number, data);
		},
		update: async (_model, id, data) => {
			rows.set(id as number, data);
		},
		delete: async (_model, id) => {
			rows.delete(id as number);
		},
		get: async (_model, id) => rows.get(id as number) ?? null,
		getMany: async (_model, ids) => ids.map((id) => rows.get(id as number) ?? null),
		query: async () => ({ list: [...rows.values()], more: false, count: rows.size })
	};
	const context = createActiveTs({
		stores: { default: store },
		search: { memory: new MemorySearchAdapter() },
		defaultSearch: 'memory',
		plugins: [createOutboxPlugin({ outbox })]
	});
	const parent = datastoreKey('ancestor_outbox_parent', 20);
	const item = await AncestorOutboxSearchDoc.create({ id: 2, parentId: 20, title: 'plugin child' }, context);
	await item.delete();

	assert.equal(events.length, 2);
	assert.equal(events[0].operation, 'create');
	assert.equal(events[1].operation, 'delete');
	assert.equal(events[1].data, undefined);
	assert.equal(events[1].modelId, 2);
	assert.equal(events[1].modelIdentity, datastoreSearchDocumentIdentity(context.meta(AncestorOutboxSearchDoc), 2, parent));
	assert.deepEqual(events[1].modelDatastoreAncestor, parent);
});

test('search sync reloads data-less datastore ancestor events through ancestor queries', async () => {
	const outbox = new MemoryOutboxAdapter();
	const search = new MemorySearchAdapter();
	const parent = datastoreKey('ancestor_outbox_parent', 30);
	const row = { id: 3, parentId: 30, title: 'query loaded child' };
	const stats = { get: 0, query: 0 };
	const store: StoreAdapter = {
		kind: 'ancestor-query-only',
		capabilities: { datastoreAncestor: true },
		get: async () => {
			stats.get++;
			throw new Error('direct get must not be used for ancestor search sync');
		},
		getMany: async () => {
			throw new Error('getMany must not be used for ancestor search sync');
		},
		query: async (_model, plan) => {
			stats.query++;
			assert.deepEqual(plan.meta?.datastoreAncestor, parent);
			assert.deepEqual(plan.where, [{ field: 'id', op: '=', value: 3 }]);
			return { list: [row], more: false, count: 1 };
		},
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	const context = createActiveTs({
		stores: { default: store },
		search: { memory: search },
		defaultSearch: 'memory'
	});
	const meta = context.meta(AncestorOutboxSearchDoc);
	await outbox.append({
		id: 'ancestor-data-less-update',
		model: 'ancestor_outbox_search_regression_doc',
		modelId: 3,
		modelIdentity: datastoreSearchDocumentIdentity(meta, 3, parent),
		modelDatastoreAncestor: parent,
		operation: 'update',
		createdAt: '2026-05-13T00:00:00.000Z'
	});

	assert.equal(await runSearchSyncWorker({ outbox, search, models: [AncestorOutboxSearchDoc], context }), 1);
	assert.equal(stats.get, 0);
	assert.equal(stats.query, 1);
	assert.deepEqual((await search.search(meta, 'query loaded', {})).list, [row]);
});

test('search sync reloads data-less datastore events with SDK entity key metadata', async () => {
	const outbox = new MemoryOutboxAdapter();
	const search = new MemorySearchAdapter();
	const parent = datastoreKey('ancestor_outbox_parent', 30);
	const sdkEntityKey = sdkDatastoreEntityKey(['ancestor_outbox_parent', 30, 'ancestor_outbox_search_regression_doc', 3]);
	const row = Object.defineProperty(
		{ id: 3, parentId: 30, title: 'sdk query loaded child' },
		ACTIVE_TS_ENTITY_KEY,
		{ value: sdkEntityKey, enumerable: false }
	);
	const store: StoreAdapter = {
		kind: 'datastore',
		capabilities: { datastoreAncestor: true },
		get: async () => {
			throw new Error('direct get must not be used for ancestor search sync');
		},
		getMany: async () => {
			throw new Error('getMany must not be used for ancestor search sync');
		},
		query: async (_model, plan) => {
			assert.deepEqual(plan.meta?.datastoreAncestor, parent);
			return { list: [row], more: false, count: 1 };
		},
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	markStoreTrustsDatastoreEntityKeyRows(store);
	const context = createActiveTs({
		stores: { default: store },
		search: { memory: search },
		defaultSearch: 'memory'
	});
	const meta = context.meta(AncestorOutboxSearchDoc);
	await outbox.append({
		id: 'ancestor-sdk-key-update',
		model: 'ancestor_outbox_search_regression_doc',
		modelId: 3,
		modelIdentity: datastoreSearchDocumentIdentity(meta, 3, parent),
		modelDatastoreAncestor: parent,
		operation: 'update',
		createdAt: '2026-05-13T00:00:00.000Z'
	});

	assert.equal(await runSearchSyncWorker({ outbox, search, models: [AncestorOutboxSearchDoc], context }), 1);
	assert.deepEqual((await search.search(meta, 'sdk query', {})).list, [
		{ id: 3, parentId: 30, title: 'sdk query loaded child' }
	]);
});

test('search sync indexes alias-tagged search fields', async () => {
	const outbox = new MemoryOutboxAdapter();
	const search = new MemorySearchAdapter();
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { search },
		defaultSearch: 'search'
	});
	await outbox.append({
		id: 'alias-event-1',
		model: 'alias_outbox_search_regression_doc',
		modelId: 1,
		operation: 'create',
		data: { id: 1, title: 'alias indexed', body: 'hidden body' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});

	assert.equal(
		await runSearchSyncWorker({ outbox, search, models: [AliasOutboxSearchDoc], context, adapter: 'search' }),
		1
	);
	assert.deepEqual(search.snapshot('alias_outbox_search_regression_doc'), [{ id: 1, title: 'alias indexed' }]);
});

test('search sync follows query planner route when no adapter override is provided', async () => {
	const outbox = new MemoryOutboxAdapter();
	const routed = new MemorySearchAdapter();
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { routed },
		queryPlanner: {
			routeSearch: () => 'routed'
		}
	});
	await outbox.append({
		id: 'planner-routed-event-1',
		model: 'planner_outbox_search_regression_doc',
		modelId: 1,
		operation: 'create',
		data: { id: 1, title: 'planner indexed', body: 'hidden body' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});

	assert.equal(await runSearchSyncWorker({ outbox, search: routed, models: [PlannerOutboxSearchDoc], context }), 1);
	assert.deepEqual(routed.snapshot('planner_outbox_search_regression_doc'), [{ id: 1, title: 'planner indexed' }]);
	const RoutedDoc = PlannerOutboxSearchDoc.use(context) as unknown as typeof PlannerOutboxSearchDoc;
	assert.deepEqual(
		(await RoutedDoc.search('planner').load()).list.map((item) => item.data.id),
		[1]
	);
});

test('search sync indexes every route-dependent search backend before acking events', async () => {
	const outbox = new MemoryOutboxAdapter();
	const short = new MemorySearchAdapter();
	const long = new MemorySearchAdapter();
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { short, long },
		queryPlanner: {
			routeSearch: ({ query }) => query.length < 3 ? 'short' : 'long'
		}
	});
	await outbox.append({
		id: 'route-dependent-event-1',
		model: 'route_dependent_outbox_search_regression_doc',
		modelId: 1,
		operation: 'create',
		data: { id: 1, title: 'abcdef' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});

	assert.equal(await runSearchSyncWorker({ outbox, search: short, models: [RouteDependentOutboxSearchDoc], context }), 1);
	assert.deepEqual(short.snapshot('route_dependent_outbox_search_regression_doc'), [{ id: 1, title: 'abcdef' }]);
	assert.deepEqual(long.snapshot('route_dependent_outbox_search_regression_doc'), [{ id: 1, title: 'abcdef' }]);
});

test('search sync includes explicit adapter-tagged indexes with route-dependent backends', async () => {
	const outbox = new MemoryOutboxAdapter();
	const short = new MemorySearchAdapter();
	const long = new MemorySearchAdapter();
	const explicit = new MemorySearchAdapter();
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { short, long, explicit },
		queryPlanner: {
			schemaSearchAdapters: ['short', 'long'],
			routeSearch: ({ query }) => query.length < 3 ? 'short' : 'long'
		}
	});
	await outbox.append({
		id: 'route-dependent-explicit-event-1',
		model: 'mixed_route_outbox_search_regression_doc',
		modelId: 1,
		operation: 'create',
		data: { id: 1, title: 'abcdef', body: 'explicit body' },
		createdAt: '2026-05-13T00:00:00.500Z'
	});

	assert.equal(await runSearchSyncWorker({ outbox, search: short, models: [MixedRouteOutboxSearchDoc], context }), 1);
	assert.deepEqual(short.snapshot('mixed_route_outbox_search_regression_doc'), [{ id: 1, title: 'abcdef' }]);
	assert.deepEqual(long.snapshot('mixed_route_outbox_search_regression_doc'), [{ id: 1, title: 'abcdef' }]);
	assert.deepEqual(explicit.snapshot('mixed_route_outbox_search_regression_doc'), [
		{ id: 1, title: 'abcdef', body: 'explicit body' }
	]);
	assert.deepEqual(await outbox.list(), []);
});

test('search sync routes physical search index kinds through registered aliases', async () => {
	const outbox = new MemoryOutboxAdapter();
	const indexed: Array<{ indexes: Array<[string, string | undefined]>; data: Record<string, unknown> }> = [];
	const primary: SearchAdapter = {
		kind: 'wrapped-algolia',
		searchIndexKind: 'algolia',
		capabilities: { index: true },
		search: async () => ({ list: [], more: false }),
		index: async (model, _id, data) => {
			indexed[indexed.length] = {
				indexes: model.searchIndexes.map((index) => [index.name, index.adapter]),
				data: { ...data }
			};
		},
		delete: async () => undefined
	};
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { primary },
		defaultSearch: 'primary',
		queryPlanner: {
			schemaSearchAdapters: ['primary']
		}
	});
	await outbox.append({
		id: 'physical-alias-event-1',
		model: 'physical_alias_outbox_search_regression_doc',
		modelId: 1,
		operation: 'create',
		data: { id: 1, title: 'abcdef' },
		createdAt: '2026-05-13T00:00:00.750Z'
	});

	assert.equal(await runSearchSyncWorker({ outbox, search: primary, models: [PhysicalAliasOutboxSearchDoc], context }), 1);
	assert.deepEqual(indexed, [
		{
			indexes: [['physical_alias_outbox_title', 'algolia']],
			data: { id: 1, title: 'abcdef' }
		}
	]);
	assert.deepEqual(await outbox.list(), []);
});

test('search sync no-context datastore deletes derive identity from event ancestor metadata', async () => {
	const outbox = new MemoryOutboxAdapter();
	const parent = datastoreKey('ancestor_outbox_parent', 44);
	const deletes: Array<{ id: number | string; identity?: string }> = [];
	const primary: SearchAdapter = {
		kind: 'wrapped-algolia',
		searchIndexKind: 'algolia',
		capabilities: { index: true },
		search: async () => ({ list: [], more: false }),
		index: async () => undefined,
		delete: async (model, id) => {
			deletes[deletes.length] = { id, identity: model.searchDocumentIdentity };
		}
	};
	await outbox.append({
		id: 'no-context-ancestor-delete-event-1',
		model: 'ancestor_outbox_search_regression_doc',
		modelId: 1,
		modelDatastoreAncestor: parent,
		operation: 'delete',
		data: { id: 1, parentId: 44, title: 'deleted' },
		createdAt: '2026-05-13T00:00:00.800Z'
	});

	assert.equal(
		await runSearchSyncWorker({
			outbox,
			search: primary,
			models: [AncestorOutboxSearchDoc],
			adapter: 'algolia'
		}),
		1
	);
	assert.deepEqual(deletes, [
		{
			id: 1,
			identity: datastoreSearchDocumentIdentity({ name: 'ancestor_outbox_search_regression_doc' }, 1, parent)
		}
	]);
	assert.deepEqual(await outbox.list(), []);
});

test('search sync rejects identity-only datastore deletes without unsafe opt-in', async () => {
	const outbox = new MemoryOutboxAdapter();
	const parent = datastoreKey('ancestor_outbox_parent', 46);
	const identity = datastoreSearchDocumentIdentity({ name: 'ancestor_outbox_search_regression_doc' }, 1, parent);
	let deleted = false;
	const search: SearchAdapter = {
		kind: 'memory',
		capabilities: { index: true },
		search: async () => ({ list: [], more: false }),
		index: async () => undefined,
		delete: async () => {
			deleted = true;
		}
	};
	await outbox.append({
		id: 'no-context-ancestor-identity-delete-event-reject',
		model: 'ancestor_outbox_search_regression_doc',
		modelId: 999,
		modelIdentity: identity,
		operation: 'delete',
		createdAt: '2026-05-13T00:00:00.825Z'
	});

	await assert.rejects(
		() => runSearchSyncWorker({ outbox, search, models: [AncestorOutboxSearchDoc] }),
		/Outbox event "no-context-ancestor-identity-delete-event-reject" for Datastore model "ancestor_outbox_search_regression_doc" is missing Datastore ancestor metadata/
	);
	assert.equal(deleted, false);
	assert.deepEqual((await outbox.list()).map((event) => event.id), ['no-context-ancestor-identity-delete-event-reject']);
});

test('search sync no-context datastore deletes preserve identity-only events with unsafe opt-in', async () => {
	const outbox = new MemoryOutboxAdapter();
	const parent = datastoreKey('ancestor_outbox_parent', 45);
	const identity = datastoreSearchDocumentIdentity({ name: 'ancestor_outbox_search_regression_doc' }, 1, parent);
	const deletes: Array<{ id: number | string; identity?: string }> = [];
	const search: SearchAdapter = {
		kind: 'memory',
		capabilities: { index: true },
		search: async () => ({ list: [], more: false }),
		index: async () => undefined,
		delete: async (model, id) => {
			deletes[deletes.length] = { id, identity: model.searchDocumentIdentity };
		}
	};
	await outbox.append({
		id: 'no-context-ancestor-identity-delete-event-1',
		model: 'ancestor_outbox_search_regression_doc',
		modelId: 1,
		modelIdentity: identity,
		operation: 'delete',
		createdAt: '2026-05-13T00:00:00.850Z'
	});

	assert.equal(
		await runSearchSyncWorker({
			outbox,
			search,
			models: [AncestorOutboxSearchDoc],
			allowUnsafeIdentityOnlyDatastoreDelete: true
		}),
		1
	);
	assert.deepEqual(deletes, [{ id: 1, identity }]);
	assert.deepEqual(await outbox.list(), []);
});

test('search sync no-context datastore indexes reject payload ancestor mismatches', async () => {
	const outbox = new MemoryOutboxAdapter();
	const parent = datastoreKey('ancestor_outbox_parent', 10);
	const indexed: Array<{ id: number | string; data: Record<string, unknown> }> = [];
	const search: SearchAdapter = {
		kind: 'memory',
		capabilities: { index: true },
		search: async () => ({ list: [], more: false }),
		index: async (_model, id, data) => {
			indexed[indexed.length] = { id, data };
		},
		delete: async () => undefined
	};
	await outbox.append({
		id: 'no-context-ancestor-bad-index-event-1',
		model: 'ancestor_outbox_search_regression_doc',
		modelId: 1,
		modelDatastoreAncestor: parent,
		operation: 'update',
		data: { id: 1, parentId: 11, title: 'wrong ancestor' },
		createdAt: '2026-05-13T00:00:00.900Z'
	});

	await assert.rejects(
		() => runSearchSyncWorker({ outbox, search, models: [AncestorOutboxSearchDoc] }),
		/Datastore ancestor does not match its payload data/
	);
	assert.deepEqual(indexed, []);
});

test('search sync discovers physical search index aliases outside schema route candidates', async () => {
	const outbox = new MemoryOutboxAdapter();
	const indexed: Array<{ indexes: Array<[string, string | undefined]>; data: Record<string, unknown> }> = [];
	const short = new MemorySearchAdapter();
	const long = new MemorySearchAdapter();
	const primary: SearchAdapter = {
		kind: 'wrapped-algolia',
		searchIndexKind: 'algolia',
		capabilities: { index: true },
		search: async () => ({ list: [], more: false }),
		index: async (model, _id, data) => {
			indexed[indexed.length] = {
				indexes: model.searchIndexes.map((index) => [index.name, index.adapter]),
				data: { ...data }
			};
		},
		delete: async () => undefined
	};
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { short, long, primary },
		defaultSearch: 'short',
		queryPlanner: {
			schemaSearchAdapters: ['short', 'long'],
			routeSearch: ({ query }) => query.length < 3 ? 'short' : 'long'
		}
	});
	await outbox.append({
		id: 'physical-alias-outside-candidates-event-1',
		model: 'physical_alias_outbox_search_regression_doc',
		modelId: 2,
		operation: 'create',
		data: { id: 2, title: 'abcdef' },
		createdAt: '2026-05-13T00:00:00.875Z'
	});

	assert.equal(await runSearchSyncWorker({ outbox, search: primary, models: [PhysicalAliasOutboxSearchDoc], context }), 1);
	assert.deepEqual(indexed, [
		{
			indexes: [['physical_alias_outbox_title', 'algolia']],
			data: { id: 2, title: 'abcdef' }
		}
	]);
	assert.deepEqual(await outbox.list(), []);
});

test('search sync explicit physical adapter overrides must match registered alias sources', async () => {
	const outbox = new MemoryOutboxAdapter();
	let spoofDeletes = 0;
	const primary: SearchAdapter = {
		kind: 'wrapped-algolia',
		searchIndexKind: 'algolia',
		capabilities: { index: true },
		search: async () => ({ list: [], more: false }),
		index: async () => undefined,
		delete: async () => undefined
	};
	const spoofed: SearchAdapter = {
		kind: 'spoofed-algolia',
		searchIndexKind: 'algolia',
		capabilities: { index: true },
		search: async () => ({ list: [], more: false }),
		index: async () => undefined,
		delete: async () => {
			spoofDeletes++;
		}
	};
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { primary },
		defaultSearch: 'primary'
	});
	await outbox.append({
		id: 'physical-alias-spoofed-delete',
		model: 'physical_alias_outbox_search_regression_doc',
		modelId: 3,
		operation: 'delete',
		createdAt: '2026-05-13T00:00:00.900Z'
	});

	await assert.rejects(
		() =>
			runSearchSyncWorker({
				outbox,
				search: spoofed,
				models: [PhysicalAliasOutboxSearchDoc],
				context,
				adapter: 'algolia'
			}),
		/Outbox search sync adapter "algolia" does not match the registered search adapter/
	);
	assert.equal(spoofDeletes, 0);
});

test('search sync route candidates exclude unrelated registered adapters', async () => {
	const outbox = new MemoryOutboxAdapter();
	const short = new MemorySearchAdapter();
	const long = new MemorySearchAdapter();
	let unusedIndexes = 0;
	const unused: SearchAdapter = {
		kind: 'unused',
		capabilities: { index: true },
		search: async () => ({ list: [], more: false }),
		index: async () => {
			unusedIndexes++;
			throw new Error('unused search adapter should not be indexed');
		},
		delete: async () => undefined
	};
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { short, long, unused },
		queryPlanner: {
			schemaSearchAdapters: ['short', 'long'],
			routeSearch: ({ query }) => query.length < 3 ? 'short' : 'long'
		}
	});
	await outbox.append({
		id: 'route-dependent-event-with-unused-adapter',
		model: 'route_dependent_outbox_search_regression_doc',
		modelId: 2,
		operation: 'create',
		data: { id: 2, title: 'abcdef' },
		createdAt: '2026-05-13T00:00:01.000Z'
	});

	assert.equal(await runSearchSyncWorker({ outbox, search: short, models: [RouteDependentOutboxSearchDoc], context }), 1);
	assert.equal(unusedIndexes, 0);
	assert.deepEqual(await outbox.list(), []);
	assert.deepEqual(short.snapshot('route_dependent_outbox_search_regression_doc'), [{ id: 2, title: 'abcdef' }]);
	assert.deepEqual(long.snapshot('route_dependent_outbox_search_regression_doc'), [{ id: 2, title: 'abcdef' }]);
});

test('search sync explicit adapter overrides reject routes without model indexes', async () => {
	const outbox = new MemoryOutboxAdapter();
	const primary = new MemorySearchAdapter();
	let unusedIndexes = 0;
	const unused: SearchAdapter = {
		kind: 'unused',
		capabilities: { index: true },
		search: async () => ({ list: [], more: false }),
		index: async () => {
			unusedIndexes++;
			throw new Error('unused search adapter should not be indexed');
		},
		delete: async () => undefined
	};
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { primary, unused },
		defaultSearch: 'primary'
	});
	await outbox.append({
		id: 'explicit-unused-route-event-1',
		model: 'outbox_search_regression_doc',
		modelId: 1,
		operation: 'create',
		data: { id: 1, title: 'should stay queued' },
		createdAt: '2026-05-13T00:00:01.250Z'
	});

	await assert.rejects(
		() =>
			runSearchSyncWorker({
				outbox,
				search: unused,
				models: [OutboxSearchDoc],
				context,
				adapter: 'unused'
			}),
		/Outbox search sync adapter "unused" has no search indexes for model "outbox_search_regression_doc"/
	);
	assert.equal(unusedIndexes, 0);
	assert.deepEqual(await outbox.list(), [
		{
			id: 'explicit-unused-route-event-1',
			model: 'outbox_search_regression_doc',
			modelId: 1,
			operation: 'create',
			data: { id: 1, title: 'should stay queued' },
			createdAt: '2026-05-13T00:00:01.250Z'
		}
	]);
	assert.deepEqual(primary.snapshot('outbox_search_regression_doc'), []);
});

test('search sync accepts context-bound search handles', async () => {
	const outbox = new MemoryOutboxAdapter();
	const search = new MemorySearchAdapter();
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory: search },
		defaultSearch: 'memory'
	});
	await outbox.append({
		id: 'context-bound-search-handle-event-1',
		model: 'outbox_search_regression_doc',
		modelId: 1,
		operation: 'create',
		data: { id: 1, title: 'context handle' },
		createdAt: '2026-05-13T00:00:01.500Z'
	});

	assert.equal(
		await runSearchSyncWorker({
			outbox,
			search: context.searchAdapter('memory'),
			models: [OutboxSearchDoc],
			context
		}),
		1
	);
	assert.deepEqual(await outbox.list(), []);
	assert.deepEqual(search.snapshot('outbox_search_regression_doc'), [{ id: 1, title: 'context handle' }]);
});

test('search sync preserves adapter index kind through search middleware', async () => {
	const outbox = new MemoryOutboxAdapter();
	const search = new MemorySearchAdapter();
	const wrappedSearch = createSearchMiddlewareAdapter(search, []);
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { search: wrappedSearch },
		defaultSearch: 'search'
	});
	await outbox.append({
		id: 'middleware-alias-event-1',
		model: 'alias_outbox_search_regression_doc',
		modelId: 1,
		operation: 'create',
		data: { id: 1, title: 'alias indexed', body: 'hidden body' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});

	assert.equal(
		await runSearchSyncWorker({ outbox, search: wrappedSearch, models: [AliasOutboxSearchDoc], context, adapter: 'search' }),
		1
	);
	assert.deepEqual(search.snapshot('alias_outbox_search_regression_doc'), [{ id: 1, title: 'alias indexed' }]);
});

test('search sync uses registered search middleware when provided the source adapter', async () => {
	const outbox = new MemoryOutboxAdapter();
	const search = new MemorySearchAdapter();
	let indexCalls = 0;
	const wrappedSearch = createSearchMiddlewareAdapter(search, [
		async (operation, next) => {
			if (operation.operation === 'index') indexCalls++;
			return next();
		}
	]);
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { search: wrappedSearch },
		defaultSearch: 'search'
	});
	await outbox.append({
		id: 'middleware-source-event-1',
		model: 'alias_outbox_search_regression_doc',
		modelId: 1,
		operation: 'create',
		data: { id: 1, title: 'middleware indexed', body: 'hidden body' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});

	assert.equal(
		await runSearchSyncWorker({ outbox, search, models: [AliasOutboxSearchDoc], context, adapter: 'search' }),
		1
	);
	assert.equal(indexCalls, 1);
	assert.deepEqual(search.snapshot('alias_outbox_search_regression_doc'), [{ id: 1, title: 'middleware indexed' }]);
});

test('search sync uses registered middleware when provided an alternate wrapper source', async () => {
	const outbox = new MemoryOutboxAdapter();
	const search = new MemorySearchAdapter();
	let registeredCalls = 0;
	let providedCalls = 0;
	const registeredSearch = createSearchMiddlewareAdapter(search, [
		async (operation) => {
			if (operation.operation !== 'index') return;
			registeredCalls++;
			const id = operation.args[0] as number;
			const data = operation.args[1] as OutboxSearchData;
			await search.index(operation.model, id, { ...data, title: 'registered redacted' });
		}
	]);
	const providedSearch = createSearchMiddlewareAdapter(search, [
		async (_operation, next) => {
			providedCalls++;
			return await next();
		}
	]);
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { search: registeredSearch },
		defaultSearch: 'search'
	});
	await outbox.append({
		id: 'middleware-alternate-source-event-1',
		model: 'alias_outbox_search_regression_doc',
		modelId: 1,
		operation: 'create',
		data: { id: 1, title: 'unredacted title', body: 'hidden body' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});

	assert.equal(
		await runSearchSyncWorker({ outbox, search: providedSearch, models: [AliasOutboxSearchDoc], context, adapter: 'search' }),
		1
	);
	assert.equal(registeredCalls, 1);
	assert.equal(providedCalls, 0);
	assert.deepEqual(search.snapshot('alias_outbox_search_regression_doc'), [{ id: 1, title: 'registered redacted' }]);
});

test('search sync executes registered raw adapter instead of unregistered wrapper source', async () => {
	const outbox = new MemoryOutboxAdapter();
	const search = new MemorySearchAdapter();
	let providedCalls = 0;
	const providedSearch = createSearchMiddlewareAdapter(search, [
		async (operation) => {
			if (operation.operation === 'index') providedCalls++;
		}
	]);
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { search },
		defaultSearch: 'search'
	});
	await outbox.append({
		id: 'middleware-unregistered-wrapper-source-event-1',
		model: 'alias_outbox_search_regression_doc',
		modelId: 1,
		operation: 'create',
		data: { id: 1, title: 'raw indexed', body: 'hidden body' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});

	assert.equal(
		await runSearchSyncWorker({ outbox, search: providedSearch, models: [AliasOutboxSearchDoc], context, adapter: 'search' }),
		1
	);
	assert.equal(providedCalls, 0);
	assert.deepEqual(search.snapshot('alias_outbox_search_regression_doc'), [{ id: 1, title: 'raw indexed' }]);
});

test('search sync default route executes registered raw adapter instead of unregistered wrapper source', async () => {
	const outbox = new MemoryOutboxAdapter();
	const search = new MemorySearchAdapter();
	let providedCalls = 0;
	const providedSearch = createSearchMiddlewareAdapter(search, [
		async (operation) => {
			if (operation.operation === 'index') providedCalls++;
		}
	]);
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { search },
		defaultSearch: 'search'
	});
	await outbox.append({
		id: 'middleware-unregistered-default-wrapper-source-event-1',
		model: 'alias_outbox_search_regression_doc',
		modelId: 1,
		operation: 'create',
		data: { id: 1, title: 'raw default indexed', body: 'hidden body' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});

	assert.equal(
		await runSearchSyncWorker({ outbox, search: providedSearch, models: [AliasOutboxSearchDoc], context }),
		1
	);
	assert.equal(providedCalls, 0);
	assert.deepEqual(search.snapshot('alias_outbox_search_regression_doc'), [{ id: 1, title: 'raw default indexed' }]);
});

test('search sync rejects adapter route and search adapter mismatches', async () => {
	const outbox = new MemoryOutboxAdapter();
	const memory = new MemorySearchAdapter();
	let wrongIndexCalls = 0;
	const algoliaLike = {
		kind: 'algolia',
		capabilities: {
			where: false,
			nestedFields: true,
			numericComparisons: false,
			nullOperators: false,
			cursor: false,
			native: false,
			index: true
		},
		search: async () => ({ list: [], more: false }),
		index: async () => {
			wrongIndexCalls++;
		},
		delete: async () => undefined
	};
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory, algolia: algoliaLike },
		defaultSearch: 'memory'
	});
	await outbox.append({
		id: 'adapter-mismatch-event-1',
		model: 'outbox_search_regression_doc',
		modelId: 1,
		operation: 'create',
		data: { id: 1, title: 'mismatch' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});

	await assert.rejects(
		() => runSearchSyncWorker({ outbox, search: memory, models: [OutboxSearchDoc], context, adapter: 'algolia' }),
		/Outbox search sync adapter "algolia" does not match/
	);
	assert.equal(wrongIndexCalls, 0);
});

test('search sync adapter source matching uses captured Set intrinsics', async () => {
	const memory = new MemorySearchAdapter();
	let wrongIndexCalls = 0;
	let releaseCalls = 0;
	const event = {
		id: 'adapter-mismatch-set-pollution-event',
		model: 'outbox_search_regression_doc',
		modelId: 1,
		operation: 'create' as const,
		data: { id: 1, title: 'mismatch set pollution' },
		createdAt: '2026-05-13T00:00:00.000Z',
		leaseToken: 'set-pollution-lease',
		leaseExpiresAt: '2999-01-01T00:00:00.000Z'
	};
	const outbox = {
		append: async () => undefined,
		lease: async () => [event],
		isLeaseCurrent: async () => true,
		release: async () => {
			releaseCalls++;
		},
		ack: async () => undefined
	};
	const algoliaLike = {
		kind: 'algolia',
		capabilities: { index: true },
		search: async () => ({ list: [], more: false }),
		index: async () => {
			wrongIndexCalls++;
		},
		delete: async () => undefined
	};
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory, algolia: algoliaLike },
		defaultSearch: 'memory'
	});
	context.meta(OutboxSearchDoc);

	const originals = {
		add: Set.prototype.add,
		has: Set.prototype.has
	};
	const calls = { add: 0, has: 0 };
	Object.defineProperties(Set.prototype, {
		add: {
			value() {
				calls.add++;
				throw new Error('polluted Set.add');
			},
			configurable: true
		},
		has: {
			value() {
				calls.has++;
				throw new Error('polluted Set.has');
			},
			configurable: true
		}
	});
	try {
		await assert.rejects(
			() => runSearchSyncWorker({ outbox, search: memory, models: [OutboxSearchDoc], context, adapter: 'algolia' }),
			/Outbox search sync adapter "algolia" does not match/
		);
		assert.deepEqual(calls, { add: 0, has: 0 });
		assert.equal(wrongIndexCalls, 0);
		assert.equal(releaseCalls, 1);
	} finally {
		Object.defineProperties(Set.prototype, {
			add: { value: originals.add, configurable: true, writable: true },
			has: { value: originals.has, configurable: true, writable: true }
		});
	}
});

test('search sync worker model lookup uses captured Map get intrinsic', async () => {
	const { context, outbox, search } = setupOutboxSearch();
	await outbox.append({
		id: 'captured-map-get',
		model: 'outbox_search_regression_doc',
		modelId: 1,
		operation: 'create',
		data: { id: 1, title: 'captured map get' },
		createdAt: new Date().toISOString()
	});

	const originalMapGet = Map.prototype.get;
	let mapGetCalls = 0;
	Object.defineProperty(Map.prototype, 'get', {
		configurable: true,
		value() {
			mapGetCalls++;
			throw new Error('patched Map.get');
		}
	});
	try {
		assert.equal(await runSearchSyncWorker({ outbox, search, models: [OutboxSearchDoc], context }), 1);
		assert.equal(mapGetCalls, 0);
	} finally {
		Object.defineProperty(Map.prototype, 'get', {
			configurable: true,
			writable: true,
			value: originalMapGet
		});
	}
	assert.deepEqual((await search.search(context.meta(OutboxSearchDoc), 'captured', {})).list, [
		{ id: 1, title: 'captured map get' }
	]);
});

test('search sync rejects adapters spoofing a registered route index kind', async () => {
	const outbox = new MemoryOutboxAdapter();
	const algoliaLike = {
		kind: 'algolia',
		capabilities: {
			where: false,
			nestedFields: true,
			numericComparisons: false,
			nullOperators: false,
			cursor: false,
			native: false,
			index: true
		},
		search: async () => ({ list: [], more: false }),
		index: async () => undefined,
		delete: async () => undefined
	};
	let spoofIndexCalls = 0;
	const spoofedMemory = {
		kind: 'memory',
		searchIndexKind: 'algolia',
		capabilities: { index: true },
		search: async () => ({ list: [], more: false }),
		index: async () => {
			spoofIndexCalls++;
		},
		delete: async () => undefined
	};
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { algolia: algoliaLike },
		defaultSearch: 'algolia'
	});
	await outbox.append({
		id: 'spoofed-route-event-1',
		model: 'outbox_search_regression_doc',
		modelId: 1,
		operation: 'create',
		data: { id: 1, title: 'spoofed route' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});

	await assert.rejects(
		() =>
			runSearchSyncWorker({
				outbox,
				search: spoofedMemory as any,
				models: [OutboxSearchDoc],
				context,
				adapter: 'algolia'
			}),
		/Outbox search sync adapter "algolia" does not match the registered search adapter/
	);
	assert.equal(spoofIndexCalls, 0);
});

test('search sync is idempotent for duplicate index events and tolerant of missing deletes', async () => {
	const { context, outbox, search } = setupOutboxSearch();
	const meta = context.meta(OutboxSearchDoc);
	for (const id of ['index-1', 'index-1-retry']) {
		await outbox.append({
			id,
			model: 'outbox_search_regression_doc',
			modelId: 20,
			operation: 'create',
			data: { id: 20, title: 'idempotent index' },
			createdAt: '2026-05-13T00:00:00.000Z'
		});
	}
	await outbox.append({
		id: 'missing-delete',
		model: 'outbox_search_regression_doc',
		modelId: 999,
		operation: 'delete',
		createdAt: '2026-05-13T00:00:01.000Z'
	});

	assert.equal(await runSearchSyncWorker({ outbox, search, models: [OutboxSearchDoc], context }), 3);
	assert.deepEqual((await search.search(meta, 'idempotent', {})).list.map((item) => item.id), [20]);
	assert.deepEqual(await outbox.list(), []);
});

test('search sync batchSize limits memory outbox work and leaves later events queued', async () => {
	const { context, outbox, search } = setupOutboxSearch();
	const meta = context.meta(OutboxSearchDoc);
	for (const id of [101, 102, 103]) {
		await outbox.append({
			id: `batch-memory-${id}`,
			model: 'outbox_search_regression_doc',
			modelId: id,
			operation: 'create',
			data: { id, title: `batch document ${id}` },
			createdAt: `2026-05-13T00:00:0${id - 101}.000Z`
		});
	}

	assert.equal(await runSearchSyncWorker({ outbox, search, models: [OutboxSearchDoc], context, batchSize: 2 }), 2);
	assert.deepEqual((await outbox.list()).map((event) => event.id), ['batch-memory-103']);
	assert.deepEqual((await search.search(meta, 'batch', {})).list.map((item) => item.id), [101, 102]);

	assert.equal(await runSearchSyncWorker({ outbox, search, models: [OutboxSearchDoc], context, batchSize: 2 }), 1);
	assert.deepEqual(await outbox.list(), []);
	assert.deepEqual((await search.search(meta, 'batch', {})).list.map((item) => item.id), [101, 102, 103]);
});

test('search sync batchSize recovers overflow when custom drain adapters ignore limits', async () => {
	const { context, search } = setupOutboxSearch();
	const meta = context.meta(OutboxSearchDoc);
	const drainOptions: unknown[] = [];
	const requeued: string[][] = [];
	const events = [201, 202, 203].map((id, index) => ({
		id: `batch-drain-${id}`,
		model: 'outbox_search_regression_doc',
		modelId: id,
		operation: 'create' as const,
		data: { id, title: `drain batch ${id}` },
		createdAt: `2026-05-13T00:00:0${index}.000Z`
	}));
	const outbox = {
		append: async () => undefined,
		drain: async (options?: unknown) => {
			drainOptions.push(options);
			return events;
		},
		requeue: async (batch: any[]) => {
			requeued.push(batch.map((event) => event.id));
		}
	};

	const originalSlice = Array.prototype.slice;
	const originalReverse = Array.prototype.reverse;
	let processed: number | undefined;
	Object.defineProperty(Array.prototype, 'slice', {
		configurable: true,
		value() {
			throw new Error('patched Array.slice');
		}
	});
	Object.defineProperty(Array.prototype, 'reverse', {
		configurable: true,
		value() {
			throw new Error('patched Array.reverse');
		}
	});
	try {
		processed = await runSearchSyncWorker({ outbox, search, models: [OutboxSearchDoc], context, batchSize: 1 });
	} finally {
		Object.defineProperty(Array.prototype, 'slice', { configurable: true, value: originalSlice });
		Object.defineProperty(Array.prototype, 'reverse', { configurable: true, value: originalReverse });
	}
	assert.equal(processed, 1);
	assert.deepEqual(drainOptions, [{ limit: 1 }]);
	assert.deepEqual(requeued, [['batch-drain-202', 'batch-drain-203']]);
	assert.deepEqual((await search.search(meta, 'drain', {})).list.map((item) => item.id), [201]);
});

test('search sync batchSize recovers the unprocessed head when overflow requeue fails', async () => {
	const { context, search } = setupOutboxSearch();
	const meta = context.meta(OutboxSearchDoc);
	const titles = ['oldest', 'middle', 'newest'];
	const events = titles.map((title, index) => ({
		id: `batch-requeue-failure-${title}`,
		model: 'outbox_search_regression_doc',
		modelId: 401,
		operation: 'update' as const,
		data: { id: 401, title: `failed overflow ${title}` },
		createdAt: `2026-05-13T00:00:0${index}.000Z`
	}));
	let requeueCalls = 0;
	const outbox = {
		append: async (event: any) => {
			events.push(structuredClone(event));
		},
		list: async () => structuredClone(events),
		drain: async () => events.splice(0, events.length),
		requeue: async (batch: any[]) => {
			requeueCalls++;
			if (requeueCalls === 1) {
				events.unshift(structuredClone(batch[0]));
				throw new Error('overflow requeue failed after partial write');
			}
			events.unshift(...structuredClone(batch));
		}
	};

	await assert.rejects(
		() => runSearchSyncWorker({ outbox, search, models: [OutboxSearchDoc], context, batchSize: 1 }),
		/failed for events beyond batchSize; drained events were recovered/
	);
	assert.equal(requeueCalls, 2);
	assert.deepEqual(
		events.map((event) => event.id),
		['batch-requeue-failure-oldest', 'batch-requeue-failure-middle', 'batch-requeue-failure-newest']
	);
	assert.deepEqual((await search.search(meta, 'failed overflow', {})).list, []);

	assert.equal(await runSearchSyncWorker({ outbox, search, models: [OutboxSearchDoc], context, batchSize: 10 }), 3);
	assert.deepEqual((await search.search(meta, 'failed overflow newest', {})).list.map((item) => item.id), [401]);
	assert.deepEqual((await search.search(meta, 'failed overflow oldest', {})).list, []);
});

test('search sync batchSize releases overflow when custom lease adapters ignore limits', async () => {
	const { context, search } = setupOutboxSearch();
	const meta = context.meta(OutboxSearchDoc);
	const leaseOptions: unknown[] = [];
	const released: string[][] = [];
	const acked: string[][] = [];
	const events = [301, 302, 303].map((id, index) => ({
		id: `batch-lease-${id}`,
		model: 'outbox_search_regression_doc',
		modelId: id,
		operation: 'create' as const,
		data: { id, title: `lease batch ${id}` },
		createdAt: `2026-05-13T00:00:0${index}.000Z`,
		leaseToken: `lease-token-${id}`,
		leaseExpiresAt: '2999-01-01T00:00:00.000Z'
	}));
	const outbox = {
		append: async () => undefined,
		lease: async (options?: unknown) => {
			leaseOptions.push(options);
			return events;
		},
		isLeaseCurrent: async () => true,
		release: async (batch: any[]) => {
			released.push(batch.map((event) => event.id));
		},
		ack: async (batch: any[]) => {
			acked.push(batch.map((event) => event.id));
		}
	};

	assert.equal(await runSearchSyncWorker({ outbox, search, models: [OutboxSearchDoc], context, batchSize: 1 }), 1);
	assert.deepEqual(leaseOptions, [{ limit: 1 }]);
	assert.deepEqual(released, [['batch-lease-302', 'batch-lease-303']]);
	assert.deepEqual(acked, [['batch-lease-301']]);
	assert.deepEqual((await search.search(meta, 'lease', {})).list.map((item) => item.id), [301]);
});

test('search sync reloads current rows when outbox events omit data', async () => {
	const outbox = new MemoryOutboxAdapter();
	const search = new MemorySearchAdapter();
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory: search },
		defaultSearch: 'memory',
		plugins: [createOutboxPlugin({ outbox, id: () => 'without-data' })]
	});
	setDefaultContext(context);

	await OutboxSearchDoc.create({ id: 30, title: 'reload me' });
	assert.deepEqual((await outbox.list())[0].data, undefined);

	assert.equal(await runSearchSyncWorker({ outbox, search, models: [OutboxSearchDoc], context }), 1);
	assert.deepEqual((await search.search(context.meta(OutboxSearchDoc), 'reload', {})).list.map((item) => item.id), [30]);
	assert.deepEqual(await outbox.list(), []);
});

test('search sync reloads payload-free events from store instead of stale cache', async () => {
	const outbox = new MemoryOutboxAdapter();
	const search = new MemorySearchAdapter();
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: new MemoryCacheAdapter() },
		search: { memory: search },
		defaultSearch: 'memory',
		plugins: [createOutboxPlugin({ outbox, id: () => 'without-data-cache' })]
	});
	setDefaultContext(context);
	const Record = CachedOutboxSearchDoc.use(context) as unknown as typeof CachedOutboxSearchDoc;
	const meta = context.meta(CachedOutboxSearchDoc);

	await Record.create({ id: 50, title: 'cached stale' });
	await Record.find(50).load();
	await store.update(meta, 50, { id: 50, title: 'store current' });
	await outbox.drain?.();
	await outbox.append({
		id: 'payload-free-update',
		model: 'cached_outbox_search_regression_doc',
		modelId: 50,
		operation: 'update',
		createdAt: '2026-05-13T00:00:00.000Z'
	});

	assert.equal(await runSearchSyncWorker({ outbox, search, models: [CachedOutboxSearchDoc], context }), 1);
	assert.deepEqual((await search.search(meta, 'current', {})).list.map((item) => item.id), [50]);
	assert.deepEqual((await search.search(meta, 'stale', {})).list, []);
});

test('search sync deletes stale search docs when data is omitted and row is gone', async () => {
	const { context, outbox, search } = setupOutboxSearch();
	const meta = context.meta(OutboxSearchDoc);
	await search.index(meta, 40, { id: 40, title: 'stale row' });
	await outbox.append({
		id: 'missing-row-index',
		model: 'outbox_search_regression_doc',
		modelId: 40,
		operation: 'update',
		createdAt: '2026-05-13T00:00:00.000Z'
	});

	assert.equal(await runSearchSyncWorker({ outbox, search, models: [OutboxSearchDoc], context }), 1);
	assert.deepEqual((await search.search(meta, 'stale', {})).list, []);
});

test('search sync rejects payload ids that differ from the outbox modelId', async () => {
	let indexed = false;
	const search = {
		kind: 'custom-search',
		searchIndexKind: 'memory',
		capabilities: { index: true },
		search: async () => ({ list: [], more: false }),
		index: async () => {
			indexed = true;
		},
		delete: async () => undefined
	};
	const outbox = new MemoryOutboxAdapter();
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory: search },
		defaultSearch: 'memory'
	});
	await outbox.append({
		id: 'mismatched-index-id',
		model: 'outbox_search_regression_doc',
		modelId: 1,
		operation: 'update',
		data: { id: 2, title: 'wrong id' },
		createdAt: '2026-05-13T00:00:07.000Z'
	});

	await assert.rejects(
		() => runSearchSyncWorker({ outbox, search, models: [OutboxSearchDoc], context }),
		/Outbox event "mismatched-index-id" data id does not match modelId/
	);
	assert.equal(indexed, false);
	assert.deepEqual((await outbox.list()).map((event) => event.id), ['mismatched-index-id']);
});

test('search sync rejects plain model events with Datastore ancestors before indexing', async () => {
	let indexed = false;
	let deleted = false;
	const search = {
		kind: 'custom-search',
		searchIndexKind: 'memory',
		capabilities: { index: true },
		search: async () => ({ list: [], more: false }),
		index: async () => {
			indexed = true;
		},
		delete: async () => {
			deleted = true;
		}
	};
	const outbox = new MemoryOutboxAdapter();
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory: search },
		defaultSearch: 'memory'
	});
	await outbox.append({
		id: 'plain-model-bogus-ancestor',
		model: 'outbox_search_regression_doc',
		modelId: 1,
		operation: 'update',
		data: { id: 1, title: 'bogus ancestor' },
		modelDatastoreAncestor: datastoreKey('plain_outbox_parent', 10),
		createdAt: '2026-05-13T00:00:07.500Z'
	});

	await assert.rejects(
		() => runSearchSyncWorker({ outbox, search, models: [OutboxSearchDoc], context }),
		/Outbox event "plain-model-bogus-ancestor" for non-Datastore model "outbox_search_regression_doc" cannot include Datastore ancestor metadata/
	);
	assert.equal(indexed, false);
	assert.equal(deleted, false);
	assert.deepEqual((await outbox.list()).map((event) => event.id), ['plain-model-bogus-ancestor']);
});

test('search sync rejects plain model events with modelIdentity before indexing', async () => {
	let indexed = false;
	let deleted = false;
	const search = {
		kind: 'custom-search',
		searchIndexKind: 'memory',
		capabilities: { index: true },
		search: async () => ({ list: [], more: false }),
		index: async () => {
			indexed = true;
		},
		delete: async () => {
			deleted = true;
		}
	};
	const outbox = new MemoryOutboxAdapter();
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory: search },
		defaultSearch: 'memory'
	});
	await outbox.append({
		id: 'plain-model-bogus-identity',
		model: 'outbox_search_regression_doc',
		modelId: 1,
		operation: 'update',
		data: { id: 1, title: 'bogus identity' },
		modelIdentity: 'number:2',
		createdAt: '2026-05-13T00:00:07.750Z'
	});

	await assert.rejects(
		() => runSearchSyncWorker({ outbox, search, models: [OutboxSearchDoc], context }),
		/Outbox event "plain-model-bogus-identity" for non-Datastore model "outbox_search_regression_doc" cannot include model identity metadata/
	);
	assert.equal(indexed, false);
	assert.equal(deleted, false);
	assert.deepEqual((await outbox.list()).map((event) => event.id), ['plain-model-bogus-identity']);
});

test('search sync rejects provided payloads that omit the model id', async () => {
	let indexed = false;
	const search = {
		kind: 'custom-search',
		searchIndexKind: 'memory',
		capabilities: { index: true },
		search: async () => ({ list: [], more: false }),
		index: async () => {
			indexed = true;
		},
		delete: async () => undefined
	};
	const outbox = new MemoryOutboxAdapter();
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory: search },
		defaultSearch: 'memory'
	});
	await outbox.append({
		id: 'missing-index-id',
		model: 'outbox_search_regression_doc',
		modelId: 1,
		operation: 'update',
		data: { title: 'missing id' },
		createdAt: '2026-05-13T00:00:08.000Z'
	});

	await assert.rejects(
		() => runSearchSyncWorker({ outbox, search, models: [OutboxSearchDoc], context }),
		/Outbox event "missing-index-id" data is missing id field "id"/
	);
	assert.equal(indexed, false);
	assert.deepEqual((await outbox.list()).map((event) => event.id), ['missing-index-id']);
});

test('search sync validates public outbox payloads before indexing', async () => {
	let indexed = false;
	const search = {
		kind: 'custom-search',
		searchIndexKind: 'memory',
		capabilities: { index: true },
		search: async () => ({ list: [], more: false }),
		index: async () => {
			indexed = true;
		},
		delete: async () => undefined
	};
	const outbox = new MemoryOutboxAdapter();
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory: search },
		defaultSearch: 'memory'
	});
	await outbox.append({
		id: 'invalid-public-payload',
		model: 'validated_outbox_search_regression_doc',
		modelId: 1,
		operation: 'update',
		data: { id: 1, title: 42 } as any,
		createdAt: '2026-05-13T00:00:09.000Z'
	});

	await assert.rejects(
		() => runSearchSyncWorker({ outbox, search, models: [ValidatedOutboxSearchDoc], context }),
		/Read validation failed for validated_outbox_search_regression_doc/
	);
	assert.equal(indexed, false);
	assert.deepEqual((await outbox.list()).map((event) => event.id), ['invalid-public-payload']);
});

test('search sync validates stored outbox payloads before indexing', async () => {
	let indexed = false;
	const search = {
		kind: 'custom-search',
		searchIndexKind: 'memory',
		capabilities: { index: true },
		search: async () => ({ list: [], more: false }),
		index: async () => {
			indexed = true;
		},
		delete: async () => undefined
	};
	const outbox = new MemoryOutboxAdapter();
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory: search },
		defaultSearch: 'memory'
	});
	await outbox.append({
		id: 'invalid-stored-payload',
		model: 'validated_outbox_search_regression_doc',
		modelId: 1,
		operation: 'update',
		data: { id: 1, title: 42 } as any,
		dataEncoding: 'stored',
		createdAt: '2026-05-13T00:00:10.000Z'
	});

	await assert.rejects(
		() => runSearchSyncWorker({ outbox, search, models: [ValidatedOutboxSearchDoc], context }),
		/Read validation failed for validated_outbox_search_regression_doc/
	);
	assert.equal(indexed, false);
	assert.deepEqual((await outbox.list()).map((event) => event.id), ['invalid-stored-payload']);
});

test('search sync rejects duplicate model names before draining events', async () => {
	const { context, outbox, search } = setupOutboxSearch();
	await outbox.append({
		id: 'duplicate-model-name',
		model: 'outbox_search_regression_doc',
		modelId: 60,
		operation: 'create',
		data: { id: 60, title: 'kept queued' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});

	await assert.rejects(
		() =>
			runSearchSyncWorker({
				outbox,
				search,
				models: [OutboxSearchDoc, DuplicateOutboxSearchDoc],
				context
			}),
		/duplicate model name "outbox_search_regression_doc"/
	);
	assert.deepEqual((await outbox.list()).map((event) => event.id), ['duplicate-model-name']);
});

test('search sync validates outbox drain result shape', async () => {
	const { context, search } = setupOutboxSearch();
	await assert.rejects(
		() =>
				runSearchSyncWorker({
					outbox: {
						append: async () => undefined,
						requeue: async () => undefined,
						drain: async () => ({ id: 'not-an-array' }) as any
					},
				search,
				models: [OutboxSearchDoc],
				context
			}),
		/Outbox drain result must be an array/
	);
	await assert.rejects(
		() =>
				runSearchSyncWorker({
					outbox: {
						append: async () => undefined,
						requeue: async () => undefined,
						drain: async () => new Array(1) as any
					},
				search,
				models: [OutboxSearchDoc],
				context
			}),
		/Outbox drain result\[0\] is missing/
	);
	const events = [] as any[];
	let iteratorCalls = 0;
	Object.defineProperty(events, Symbol.iterator, {
		value() {
			iteratorCalls++;
			throw new Error('custom outbox drain iterator should not run');
		}
	});
	await assert.rejects(
		() =>
				runSearchSyncWorker({
					outbox: {
						append: async () => undefined,
						requeue: async () => undefined,
						drain: async () => events
					},
				search,
				models: [OutboxSearchDoc],
				context
			}),
		/Outbox drain result cannot contain symbol fields/
	);
	assert.equal(iteratorCalls, 0);
});

test('search sync recovers listed events when destructive drain returns a malformed result', async () => {
	const { context, search } = setupOutboxSearch();
	const event = {
		id: 'malformed-drain-result-recovered',
		model: 'outbox_search_regression_doc',
		modelId: 62,
		operation: 'create' as const,
		data: { id: 62, title: 'recover malformed result' },
		createdAt: '2026-05-13T00:00:00.000Z'
	};
	const events = [event];
	let requeueCalls = 0;
	const outbox = {
		append: async (next: any) => {
			events.push(next);
		},
		list: async () => structuredClone(events),
		drain: async () => {
			events.splice(0, events.length);
			return { id: 'not-an-array' } as any;
		},
		requeue: async (next: any[]) => {
			requeueCalls++;
			events.unshift(...structuredClone(next));
		}
	};

	await assert.rejects(
		() => runSearchSyncWorker({ outbox, search, models: [OutboxSearchDoc], context }),
		/Outbox drain result must be an array/
	);
	assert.equal(requeueCalls, 1);
	assert.deepEqual(events.map((queued) => queued.id), ['malformed-drain-result-recovered']);
});

test('search sync releases leased events from malformed lease arrays', async () => {
	const { context, search } = setupOutboxSearch();
	const leasedEvent = {
		id: 'malformed-lease-array',
		model: 'outbox_search_regression_doc',
		modelId: 61,
		operation: 'create' as const,
		data: { id: 61, title: 'leased' },
		createdAt: '2026-05-13T00:00:00.000Z',
		leaseToken: 'lease-token',
		leaseExpiresAt: '2999-01-01T00:00:00.000Z'
	};
	const leased = [leasedEvent] as any[];
	Object.defineProperty(leased, Symbol('lease'), {
		enumerable: true,
		value: true
	});
	let released: unknown[] | undefined;

	await assert.rejects(
		() =>
			runSearchSyncWorker({
				outbox: {
					append: async () => undefined,
					lease: async () => leased,
					isLeaseCurrent: async () => true,
					ack: async () => undefined,
					release: async (events) => {
						released = events;
					}
				},
				search,
				models: [OutboxSearchDoc],
				context
			}),
		/Outbox drain result cannot contain symbol fields/
	);
	assert.deepEqual(released, [leasedEvent]);
});

test('search sync propagates stale lease release failures', async () => {
	const { context } = setupOutboxSearch();
	const leasedEvent = {
		id: 'stale-lease-release-failure',
		model: 'outbox_search_regression_doc',
		modelId: 62,
		operation: 'create' as const,
		data: { id: 62, title: 'stale lease' },
		createdAt: '2026-05-13T00:00:00.000Z',
		leaseToken: 'lease-token',
		leaseExpiresAt: '2999-01-01T00:00:00.000Z'
	};
	const calls: string[] = [];
	const search = {
		kind: 'stale-lease-search',
		capabilities: { where: false, cursor: false, native: false, index: true },
		search: async () => ({ list: [], more: false }),
		index: async () => {
			calls.push('index');
		},
		delete: async () => {
			calls.push('delete');
		}
	};

	await assert.rejects(
		() =>
			runSearchSyncWorker({
				outbox: {
					append: async () => undefined,
					lease: async () => [leasedEvent],
					isLeaseCurrent: async () => false,
					ack: async () => {
						calls.push('ack');
					},
					release: async (events) => {
						calls.push(`release:${events.map((event) => event.id).join(',')}`);
						throw new Error('release backend down');
					}
				},
				search,
				models: [OutboxSearchDoc],
				context
			}),
		(error: unknown) => {
			assert.ok(error instanceof AggregateError);
			assert.match(error.message, /stale lease release failed/);
			assert.deepEqual(
				error.errors.map((item: Error) => item.message),
				['release backend down']
			);
			return true;
		}
	);
	assert.deepEqual(calls, ['release:stale-lease-release-failure']);
});

test('search sync releases later valid leases when a leased event is invalid', async () => {
	const { context, search } = setupOutboxSearch();
	const invalidEvent = {
		id: 'invalid-leased-event',
		model: 'outbox_search_regression_doc',
		modelId: 62,
		operation: 'publish',
		data: { id: 62, title: 'bad op' },
		createdAt: '2026-05-13T00:00:00.000Z',
		leaseToken: 'lease-token-a',
		leaseExpiresAt: '2999-01-01T00:00:00.000Z'
	};
	const validEvent = {
		id: 'valid-leased-event-after-invalid',
		model: 'outbox_search_regression_doc',
		modelId: 63,
		operation: 'create' as const,
		data: { id: 63, title: 'release me' },
		createdAt: '2026-05-13T00:00:00.000Z',
		leaseToken: 'lease-token-b',
		leaseExpiresAt: '2999-01-01T00:00:00.000Z'
	};
	let released: unknown[] | undefined;

	await assert.rejects(
		() =>
			runSearchSyncWorker({
				outbox: {
					append: async () => undefined,
					lease: async () => [invalidEvent as any, validEvent],
					isLeaseCurrent: async () => true,
					ack: async () => undefined,
					release: async (events) => {
						released = events;
					}
				},
				search,
				models: [OutboxSearchDoc],
				context
			}),
		/Outbox search sync failed and release failed/
	);
	assert.deepEqual(released, [validEvent]);
});

test('search sync requeues valid entries from malformed drain arrays', async () => {
	const { context, search } = setupOutboxSearch();
	const event = {
		id: 'malformed-drain-requeue',
		model: 'outbox_search_regression_doc',
		modelId: 70,
		operation: 'create' as const,
		data: { id: 70, title: 'requeue me' },
		createdAt: '2026-05-13T00:00:00.000Z'
	};
	const events = [event];
	const outbox = {
		append: async () => undefined,
		requeue: async (next: any[]) => {
			events.unshift(...structuredClone(next));
		},
		list: async () => structuredClone(events),
		drain: async () => {
			const drained = events.splice(0, events.length) as any[];
			Object.defineProperty(drained, Symbol('unsafe-drain'), {
				value: true
			});
			return drained;
		}
	};

	await assert.rejects(
		() => runSearchSyncWorker({ outbox, search, models: [OutboxSearchDoc], context }),
		/Outbox drain result cannot contain symbol fields/
	);
	assert.deepEqual(events.map((queued) => queued.id), ['malformed-drain-requeue']);
});

test('search sync recovers listed events when drain removes then rejects', async () => {
	const { context, search } = setupOutboxSearch();
	const event = {
		id: 'failed-drain-recovered',
		model: 'outbox_search_regression_doc',
		modelId: 80,
		operation: 'create' as const,
		data: { id: 80, title: 'recover me' },
		createdAt: '2026-05-13T00:00:00.000Z'
	};
	const events = [event];
	let requeueCalls = 0;
	const outbox = {
		append: async (next: any) => {
			events.push(next);
		},
		list: async () => structuredClone(events),
		drain: async () => {
			events.splice(0, events.length);
			throw new Error('drain lost lease');
		},
		requeue: async (next: any[]) => {
			requeueCalls++;
			events.unshift(...structuredClone(next));
		}
	};

	await assert.rejects(
		() => runSearchSyncWorker({ outbox, search, models: [OutboxSearchDoc], context }),
		/drain lost lease/
	);
	assert.equal(requeueCalls, 1);
	assert.deepEqual(events.map((queued) => queued.id), ['failed-drain-recovered']);
});

test('search sync does not duplicate listed events when drain rejects without removing them', async () => {
	const { context, search } = setupOutboxSearch();
	const event = {
		id: 'failed-drain-still-queued',
		model: 'outbox_search_regression_doc',
		modelId: 81,
		operation: 'create' as const,
		data: { id: 81, title: 'still queued' },
		createdAt: '2026-05-13T00:00:00.000Z'
	};
	const events = [event];
	let requeueCalls = 0;
	const outbox = {
		append: async (next: any) => {
			events.push(next);
		},
		list: async () => structuredClone(events),
		drain: async () => {
			throw new Error('drain unavailable');
		},
		requeue: async (next: any[]) => {
			requeueCalls++;
			events.unshift(...structuredClone(next));
		}
	};

	await assert.rejects(
		() => runSearchSyncWorker({ outbox, search, models: [OutboxSearchDoc], context }),
		/drain unavailable/
	);
	assert.equal(requeueCalls, 0);
	assert.deepEqual(events.map((queued) => queued.id), ['failed-drain-still-queued']);
});
