import test from 'node:test';
import assert from 'node:assert/strict';
import {
	createActiveTs, datastoreKey, defineModel, MemorySearchAdapter, MemoryStoreAdapter, Model
} from '../src/index.js';
import { datastoreSearchScopeForStore } from '../src/core/datastore-search-scope.js';
import {
	searchDocumentIdentity, withDatastoreSearchNamespace, withSearchDocumentIdentity
} from '../src/core/search-utils.js';

type Row = { id: number; title: string; parentId: number };
class ScopedRoot extends Model<Row> {}
class ScopedChild extends Model<Row> {}
defineModel<Row>({ name: 'memory_scope_root', search: 'memory' }).id('id')
	.search('memory', ['title']).attach(ScopedRoot);
defineModel<Row>({ name: 'memory_scope_child', search: 'memory' }).id('id')
	.datastore({
		ancestor: ({ data }) => data?.parentId === undefined ? undefined : datastoreKey('memory_scope_parent', data.parentId),
		ancestorFields: ['parentId']
	})
	.search('memory', ['title', 'parentId']).attach(ScopedChild);

const physical = {
	kind: 'datastore', datastoreProjectId: 'project-a', datastoreDatabaseId: null,
	datastoreNamespace: 'tenant-a', datastoreKeyEncoding: 'active-ts' as const
};

function contextFor(search: MemorySearchAdapter, variant?: object) {
	const store = variant === undefined ? new MemoryStoreAdapter() : Object.assign(new MemoryStoreAdapter(), physical, variant);
	return { store, context: createActiveTs({ stores: { default: store }, search: { memory: search }, defaultSearch: 'memory' }) };
}

for (const model of [ScopedRoot, ScopedChild]) {
	test(`${model.name} applies physical scope before search limit and totals`, async () => {
		const search = new MemorySearchAdapter();
		const variants = [
			{}, { datastoreProjectId: 'project-b' }, { datastoreDatabaseId: 'other' },
			{ datastoreNamespace: 'tenant-b' }, { datastoreNamespace: undefined },
			{ datastoreKeyEncoding: 'native' }, { cacheScope: 'separate-endpoint' }
		];
		const contexts = variants.map(variant => contextFor(search, variant).context);
		for (let index = 0; index < contexts.length; index++) {
			const context = contexts[index];
			await context.searchAdapter('memory').index(context.meta(model), 1, {
				id: 1, parentId: 10, title: `needle scope ${index}`
			});
		}
		assert.equal(search.snapshot(contexts[0].meta(model).name).length, variants.length);
		for (let index = 0; index < contexts.length; index++) {
			const Record = model.use(contexts[index]);
			const result = await Record.search('needle').limit(1).load();
			assert.deepEqual(result.list.map(item => item.data.title), [`needle scope ${index}`]);
			assert.equal(result.count, 1);
			assert.equal(result.total, 1);
			assert.equal(result.more, false);
		}
	});

	test(`${model.name} keeps unscoped documents separate from physically scoped searches`, async () => {
		const search = new MemorySearchAdapter();
		const scoped = contextFor(search, {}).context;
		const unscoped = contextFor(search).context;
		await scoped.searchAdapter('memory').index(scoped.meta(model), 1, { id: 1, title: 'needle scoped', parentId: 10 });
		await unscoped.searchAdapter('memory').index(unscoped.meta(model), 1, { id: 1, title: 'needle legacy', parentId: 10 });
		for (const [context, title] of [[scoped, 'needle scoped'], [unscoped, 'needle legacy']] as const) {
			const result = await model.use(context).search('needle').limit(1).load();
			assert.deepEqual(result.list.map(item => item.data.title), [title]);
			assert.equal(result.total, 1);
			assert.equal(result.more, false);
		}
	});

	test(`${model.name} applies forced document identity before search pagination`, async () => {
		const search = new MemorySearchAdapter();
		const { context, store } = contextFor(search, {});
		const row = { id: 2, title: 'needle second', parentId: 10 };
		const meta = context.meta(model);
		// Ancestor siblings may share the logical id; the forced identity must
		// select the physical document rather than merely matching that id.
		const first = { ...row, id: model === ScopedChild ? row.id : 1,
			parentId: model === ScopedChild ? 20 : row.parentId, title: 'needle first' };
		await context.searchAdapter('memory').index(meta, first.id, first);
		await context.searchAdapter('memory').index(meta, row.id, row);
		const all = await model.use(context).search('needle').limit(2).load();
		assert.deepEqual(all.list.map(item => item.data.title), ['needle first', 'needle second']);
		assert.equal(all.total, 2);
		const scopedMeta = withDatastoreSearchNamespace(meta, store.datastoreNamespace, datastoreSearchScopeForStore(store));
		const forced = withSearchDocumentIdentity(meta, searchDocumentIdentity(scopedMeta, row.id, 'test identity', row));
		const result = await context.searchAdapter('memory').search(forced, 'needle', { limit: 1 });
		assert.deepEqual(result.list.map(item => item.id), [2]);
		assert.deepEqual(result.list.map(item => item.title), ['needle second']);
		assert.equal(result.total, 1);
		assert.equal(result.more, false);
	});

	test(`${model.name} preserves scoped revisions, deletes, and model-wide cleanup`, async () => {
		const search = new MemorySearchAdapter();
		const a = contextFor(search, {});
		const b = contextFor(search, { datastoreNamespace: 'tenant-b' });
		for (const [selected, title] of [[a, 'needle A'], [b, 'needle B']] as const) {
			await selected.context.searchAdapter('memory').index(selected.context.meta(model), 1, {
				id: 1, parentId: 10, title
			}, { revision: 5 });
		}
		const meta = a.context.meta(model);
		await a.context.searchAdapter('memory').index(meta, 1, { id: 1, parentId: 10, title: 'stale A' }, { revision: 4 });
		assert.deepEqual((await model.use(a.context).search('needle').limit(1).load()).list.map(item => item.data.title), ['needle A']);
		const scopedMeta = withDatastoreSearchNamespace(meta, a.store.datastoreNamespace, datastoreSearchScopeForStore(a.store));
		const identity = searchDocumentIdentity(scopedMeta, 1, 'test identity', { id: 1, parentId: 10 });
		const forced = withSearchDocumentIdentity(meta, identity);
		await a.context.searchAdapter('memory').delete(forced, 1, { revision: 4 });
		assert.equal((await model.use(a.context).search('needle').load()).count, 1);
		await a.context.searchAdapter('memory').delete(forced, 1, { revision: 6 });
		assert.equal((await model.use(a.context).search('needle').load()).count, 0);
		assert.deepEqual((await model.use(b.context).search('needle').limit(1).load()).list.map(item => item.data.title), ['needle B']);
		assert.equal(search.snapshot(meta.name).length, 1);
		search.clear(meta.name);
		assert.deepEqual(search.snapshot(meta.name), []);
		await a.context.searchAdapter('memory').index(meta, 1, { id: 1, parentId: 10, title: 'needle reset' }, { revision: 1 });
		assert.equal((await model.use(a.context).search('needle').load()).count, 1);
		search.clear(undefined);
		assert.deepEqual(search.snapshot(), {});
	});
}
