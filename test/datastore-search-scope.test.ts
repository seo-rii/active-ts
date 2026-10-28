import test from 'node:test';
import { createNativeSearchAdapter } from '../src/adapters/search/native.js';
import { createCloseGuardedStoreAdapter } from '../src/core/store-options.js';
import assert from 'node:assert/strict';
import { createActiveTs, createOutboxPlugin, createSearchMiddlewareAdapter, createStoreMiddlewareAdapter, datastoreKey, defineModel, MemoryOutboxAdapter, MemorySearchAdapter, MemoryStoreAdapter, Model, normalizeOutboxEvent, runSearchSyncWorker, setDefaultContext } from '../src/index.js';
import { datastoreSearchDocumentIdentity, searchDocumentIdentity, withDatastoreSearchNamespace, withSearchDocumentIdentity } from '../src/core/search-utils.js';
import { datastoreSearchScopeForStore, normalizeDatastoreSearchScope } from '../src/core/datastore-search-scope.js';

type Row = { id: number; title: string; parentId: number };
class ScopeRoot extends Model<Row> {}
class ScopeChild extends Model<Row> {}
class ScopeParent extends Model<{ id: number; name: string }> {}
defineModel<{ id: number; name: string }>('scope_parent').id('id').validate(value => value as { id: number; name: string }).attach(ScopeParent);
defineModel<Row>({ name: 'scope_root', search: 'memory' }).id('id').validate(value => value as Row).search('memory', ['title'])
	.ref('parent', () => ScopeParent, { localKey: 'parentId', foreignKey: 'id' }).attach(ScopeRoot);
defineModel<Row>({ name: 'scope_child', search: 'memory' }).id('id').validate(value => value as Row)
	.datastore({ ancestor: ({ data }) => data ? datastoreKey('parent', data.parentId) : undefined, ancestorFields: ['parentId'] })
	.search('memory', ['title', 'parentId'])
	.ref('parent', () => ScopeParent, { localKey: 'parentId', foreignKey: 'id' }).attach(ScopeChild);

const physical = { kind: 'datastore', datastoreProjectId: 'project-a', datastoreDatabaseId: null, datastoreNamespace: 'tenant-a', datastoreKeyEncoding: 'active-ts' as const };
function scopedStore(extra: object = {}) { return Object.assign(new MemoryStoreAdapter(), physical, extra); }

for (const model of [ScopeRoot, ScopeChild]) {
	test(`${model.name} public search preserves physical scope for projected and included results`, async () => {
		const store = scopedStore();
		Object.assign(store.capabilities, { datastoreAncestor: true });
		const search = new MemorySearchAdapter();
		const stored = { id: 1, title: 'stored needle', parentId: 10 };
		const query = store.query.bind(store);
		const loadedAncestors: unknown[] = [];
		store.query = async (queryMeta, plan, options) => {
			if (queryMeta.name !== 'scope_child') return query(queryMeta, plan, options);
			loadedAncestors.push(plan.meta?.datastoreAncestor);
			assert.deepEqual(plan.meta?.datastoreAncestor, datastoreKey('parent', 10, { namespace: 'tenant-a' }));
			return { list: [stored], more: false, count: 1 };
		};
		const context = createActiveTs({ stores: { default: store }, search: { memory: search }, defaultSearch: 'memory' });
		const Record = model.use(context);
		const meta = context.meta(model);
		await store.seed(meta, [stored]);
		await store.seed(context.meta(ScopeParent), [{ id: 10, name: 'parent' }]);
		await context.searchAdapter('memory').index(meta, 1, { ...stored, title: 'indexed needle' });

		const projected = await Record.search('needle').load();
		assert.equal(projected.count, 1);
		assert.deepEqual(projected.list.map(item => item.data.title), ['indexed needle']);
		const included = await Record.search('needle').include('parent').load();
		assert.equal(included.count, 1);
		assert.deepEqual(included.list.map(item => item.data), [stored]);
		const parent = await included.list[0].ref<ScopeParent>('parent');
		assert.equal((parent as ScopeParent).data.name, 'parent');
		assert.equal(loadedAncestors.length, model === ScopeChild ? 1 : 0);
	});
}

test('root and ancestor search identities include project, database, namespace, and key encoding', async () => {
	const variants = [{}, { datastoreProjectId: 'project-b' }, { datastoreDatabaseId: 'other' }, { datastoreNamespace: 'tenant-b' }, { datastoreNamespace: undefined }, { datastoreKeyEncoding: 'native' }, { cacheScope: 'production-endpoint' }, { cacheScope: 'emulator-endpoint' }];
	for (const model of [ScopeRoot, ScopeChild]) {
		const search = new MemorySearchAdapter();
		const identities = new Set<string>();
		for (let index = 0; index < variants.length; index++) {
			const store = scopedStore(variants[index]);
			const context = createActiveTs({ stores: { default: store }, search: { memory: search }, defaultSearch: 'memory' });
			const meta = context.meta(model);
			const scoped = withDatastoreSearchNamespace(meta, store.datastoreNamespace, datastoreSearchScopeForStore(store));
			const row = { id: 1, parentId: 10, title: `scope-${index}` };
			identities.add(searchDocumentIdentity(scoped, 1, 'test', row));
			const handle = createSearchMiddlewareAdapter(context.searchAdapter('memory'), []);
			await handle.index(meta, 1, row);
		}
		assert.equal(identities.size, variants.length);
		assert.equal(search.snapshot(model === ScopeRoot ? 'scope_root' : 'scope_child').length, variants.length);
		const store = scopedStore();
		const context = createActiveTs({ stores: { default: store }, search: { memory: search }, defaultSearch: 'memory' });
		const meta = withDatastoreSearchNamespace(context.meta(model), store.datastoreNamespace, datastoreSearchScopeForStore(store));
		const identity = searchDocumentIdentity(meta, 1, 'test', { id: 1, parentId: 10, title: 'scope-0' });
		await context.searchAdapter('memory').delete(withSearchDocumentIdentity(meta, identity), 1);
		assert.equal(search.snapshot(meta.name).length, variants.length - 1);
		assert.equal(search.snapshot(meta.name).some(row => row.title === 'scope-0'), false);
	}
});

test('outbox preserves physical scope and rejects missing or different delivery contexts', async () => {
	const store = scopedStore();
	const outbox = new MemoryOutboxAdapter();
	const search = new MemorySearchAdapter();
	const context = createActiveTs({ stores: { default: store }, search: { memory: search }, defaultSearch: 'memory', plugins: [createOutboxPlugin({ outbox })] });
	setDefaultContext(context);
	await ScopeRoot.create({ id: 1, title: 'scoped event', parentId: 10 });
	const event = (await outbox.list())[0];
	assert.equal(event.modelDatastoreScope, datastoreSearchScopeForStore(store));
	assert.equal(normalizeOutboxEvent(event).modelDatastoreScope, event.modelDatastoreScope);
	assert.equal(event.modelIdentity, datastoreSearchDocumentIdentity({ ...context.meta(ScopeRoot), datastoreSearchScope: event.modelDatastoreScope }, 1, undefined));
	const other = createActiveTs({ stores: { default: scopedStore({ datastoreDatabaseId: 'other' }) }, search: { memory: search }, defaultSearch: 'memory' });
	await assert.rejects(runSearchSyncWorker({ outbox, search, models: [ScopeRoot], context: other }), /Datastore scope/);
	assert.equal(search.snapshot('scope_root').length, 0);
	assert.equal(await runSearchSyncWorker({ outbox, search, models: [ScopeRoot], context }), 1);
	assert.equal(search.snapshot('scope_root')[0].title, 'scoped event');
	const legacy = { ...event, id: 'legacy' }; delete legacy.modelDatastoreScope;
	await outbox.append(legacy);
	await assert.rejects(runSearchSyncWorker({ outbox, search, models: [ScopeRoot], context }), /Datastore scope/);
});

test('unknown Datastore physical identity fails closed; unscoped direct adapters remain compatible', async () => {
	const search = new MemorySearchAdapter();
	const store = Object.assign(new MemoryStoreAdapter(), { kind: 'datastore' });
	const context = createActiveTs({ stores: { default: store }, search: { memory: search } });
	await assert.rejects(context.searchAdapter('memory').index(context.meta(ScopeRoot), 1, { id: 1, title: 'unknown' }), /Datastore search requires known/);
	assert.equal(search.stats.index, 0);
	assert.equal(searchDocumentIdentity(context.meta(ScopeRoot), 1, 'direct'), 'number:1');
	const malformed = { ...context.meta(ScopeRoot), datastoreSearchScope: 'invalid' };
	await assert.rejects(search.index(malformed, 1, { id: 1, title: 'invalid' }), /scope must be canonical/);
	assert.equal(search.stats.index, 0);
});

test('physical identity uses captured JSON intrinsics and ignores inherited serialization hooks', () => {
	const scope = datastoreSearchScopeForStore(physical)!;
	const model = { name: 'scope_hardened', datastoreSearchScope: scope };
	const first = datastoreSearchDocumentIdentity(model, 1, undefined);
	const second = datastoreSearchDocumentIdentity(model, 2, undefined);
	assert.notEqual(first, second);
	const stringify = JSON.stringify, parse = JSON.parse;
	try {
		JSON.stringify = () => scope;
		JSON.parse = () => ['wrong-project', null, null, 'native', null];
		assert.equal(datastoreSearchScopeForStore(physical), scope);
		assert.equal(normalizeDatastoreSearchScope(scope), scope);
		assert.equal(datastoreSearchDocumentIdentity(model, 1, undefined), first);
		assert.equal(datastoreSearchDocumentIdentity(model, 2, undefined), second);
	} finally { JSON.stringify = stringify; JSON.parse = parse; }
	let calls = 0;
	for (const prototype of [Array.prototype, Object.prototype]) {
		const descriptor = Object.getOwnPropertyDescriptor(prototype, 'toJSON');
		Object.defineProperty(prototype, 'toJSON', { configurable: true, value: () => { calls++; return 'collision'; } });
		try {
			assert.equal(datastoreSearchScopeForStore(physical), scope);
			assert.equal(datastoreSearchDocumentIdentity(model, 1, undefined), first);
			assert.equal(datastoreSearchDocumentIdentity(model, 2, undefined), second);
		} finally {
			if (descriptor) Object.defineProperty(prototype, 'toJSON', descriptor);
			else delete (prototype as any).toJSON;
		}
	}
	assert.equal(calls, 0);
});


test('client-local cache scopes fail before durable search and outbox effects', async () => {
	for (const wrap of ['direct', 'middleware', 'guarded']) {
		const source = scopedStore({ cacheScope: 'client-local-token', datastoreCacheScopeStability: 'client' });
		const store = wrap === 'middleware' ? createStoreMiddlewareAdapter(source, [])
			: wrap === 'guarded' ? createCloseGuardedStoreAdapter(source, () => undefined, 'test store').adapter
			: source;
		const search = new MemorySearchAdapter();
		const outbox = new MemoryOutboxAdapter();
		const context = createActiveTs({ stores: { default: store }, search: { memory: search }, defaultSearch: 'memory', plugins: [createOutboxPlugin({ outbox })] });
		const meta = context.meta(ScopeRoot);
		assert.throws(() => datastoreSearchScopeForStore(store), /stable cacheScope/);
		assert.equal(context.store('default').datastoreCacheScopeStability, 'client');
		await assert.rejects(context.searchAdapter('memory').index(meta, 1, { id: 1, title: 'must not index' }), /stable cacheScope/);
		await assert.rejects(context.searchAdapter('memory').delete(meta, 1), /stable cacheScope/);
		await assert.rejects(ScopeRoot.use(context).search('must not search').load(), /stable cacheScope/);
		await assert.rejects(createNativeSearchAdapter(store).search(meta, 'must not search', {}), /stable cacheScope/);
		await assert.rejects(context.runHooks('afterUpdate', { model: meta, id: 1, operation: 'update', data: { id: 1, title: 'must not enqueue' } }), /stable cacheScope/);
		await context.transaction(async tx => {
			assert.equal(tx.store('default').datastoreCacheScopeStability, 'client');
			assert.throws(() => datastoreSearchScopeForStore(tx.store('default')), /stable cacheScope/);
		});
		assert.deepEqual(await outbox.list(), []);
		assert.deepEqual(search.stats, { search: 0, index: 0, delete: 0 });
	}
});

test('stable physical scopes survive independent clients and outbox delivery', async () => {
	const firstStore = scopedStore({ cacheScope: 'shared-physical-endpoint', datastoreCacheScopeStability: 'stable' });
	const secondStore = scopedStore({ cacheScope: 'shared-physical-endpoint', datastoreCacheScopeStability: 'stable' });
	const search = new MemorySearchAdapter();
	const outbox = new MemoryOutboxAdapter();
	const first = createActiveTs({ stores: { default: firstStore }, search: { memory: search }, defaultSearch: 'memory', plugins: [createOutboxPlugin({ outbox })] });
	const second = createActiveTs({ stores: { default: secondStore }, search: { memory: search }, defaultSearch: 'memory' });
	await secondStore.seed(second.meta(ScopeRoot), [{ id: 1, title: 'authoritative current row', parentId: 10 }]);
	await first.searchAdapter('memory').index(first.meta(ScopeRoot), 1, { id: 1, title: 'first client', parentId: 10 });
	await second.searchAdapter('memory').index(second.meta(ScopeRoot), 1, { id: 1, title: 'second client', parentId: 10 });
	assert.equal(search.snapshot('scope_root').length, 1);
	await first.runHooks('afterUpdate', { model: first.meta(ScopeRoot), id: 1, operation: 'update', data: { id: 1, title: 'event', parentId: 10 } });
	assert.equal(await runSearchSyncWorker({ outbox, search, models: [ScopeRoot], context: second }), 1);
	assert.equal(search.snapshot('scope_root')[0].title, 'authoritative current row');
	assert.deepEqual(await outbox.list(), []);
	assert.notEqual(datastoreSearchScopeForStore(firstStore), datastoreSearchScopeForStore(scopedStore({ cacheScope: 'another-endpoint', datastoreCacheScopeStability: 'stable' })));
});


test('cache scope stability metadata is validated and snapshotted without accessors', async () => {
	const invalid = scopedStore({ datastoreCacheScopeStability: 'invalid' });
	assert.throws(() => createActiveTs({ stores: { default: invalid } }), /datastoreCacheScopeStability/);
	assert.throws(() => createStoreMiddlewareAdapter(invalid, []), /datastoreCacheScopeStability/);
	let reads = 0;
	const accessor = scopedStore();
	Object.defineProperty(accessor, 'datastoreCacheScopeStability', { enumerable: true, get() { reads++; return 'stable'; } });
	assert.throws(() => createActiveTs({ stores: { default: accessor } }), /data property/);
	assert.throws(() => createStoreMiddlewareAdapter(accessor, []), /data property/);
	assert.equal(reads, 0);
	const mutable = scopedStore({ datastoreCacheScopeStability: 'client' });
	const search = new MemorySearchAdapter();
	const context = createActiveTs({ stores: { default: mutable }, search: { memory: search } });
	Object.assign(mutable, { datastoreCacheScopeStability: 'stable' });
	await assert.rejects(context.searchAdapter('memory').index(context.meta(ScopeRoot), 1, { id: 1, title: 'must remain rejected' }), /stable cacheScope/);
	assert.equal(search.stats.index, 0);
});
