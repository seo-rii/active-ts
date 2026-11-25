import test from 'node:test';
import assert from 'node:assert/strict';
import { createActiveTs, datastoreKey, defineModel, MemorySearchAdapter, MemoryStoreAdapter, Model } from '../src/index.js';

type ChildData = { id: number; parentGroup: number; tenant: number; namespace: string; label: string };
type OwnerData = { id: number; group: number; tenant: number; namespace: string; title: string };
type Mutation = 'id' | 'ancestor' | 'namespace' | undefined;

async function setupSharedChildren(mutation?: Mutation) {
	let constructions = 0;
	class Child extends Model<ChildData> {
		constructor(data: ChildData, context?: any, options?: any) {
			super(data, context, options);
			this.data.label += '!';
			if (++constructions !== 2) return;
			if (mutation === 'id') this.data.id = 999;
			if (mutation === 'ancestor') this.data.tenant = 2;
			if (mutation === 'namespace') this.data.namespace = 'tenant_b';
		}
	}
	class Owner extends Model<OwnerData> {}
	defineModel<ChildData>('shared_constructor_child').id('id')
		.datastore({
			ancestorFields: ['tenant', 'namespace'],
			ancestor: ({ data }) => data ? datastoreKey('Tenant', data.tenant, { namespace: data.namespace }) : undefined
		}).attach(Child);
	defineModel<OwnerData>({ name: 'shared_constructor_owner', search: 'memory' }).id('id')
		.search('memory', ['title'])
		.hasMany('children', () => Child, {
			localKey: 'group', foreignKey: 'parentGroup'
		}).attach(Owner);
	const store = Object.assign(new MemoryStoreAdapter(), { datastoreNamespace: 'tenant_a' });
	Object.assign(store.capabilities, { datastoreAncestor: true });
	const memory = new MemorySearchAdapter();
	const context = createActiveTs({ stores: { default: store }, search: { memory }, defaultSearch: 'memory' });
	const owners = [1, 2].map(id => ({ id, group: 1, tenant: 1, namespace: 'tenant_a', title: 'needle' }));
	const children = [{ id: 10, parentGroup: 1, tenant: 1, namespace: 'tenant_a', label: 'child' }];
	await store.seed(context.meta(Owner), owners);
	await store.seed(context.meta(Child), children);
	for (const row of owners) await memory.index(context.meta(Owner), row.id, row);
	return { Bound: Owner.use(context), store, children, constructions: () => constructions };
}

for (const source of ['query', 'search'] as const) {
	for (const mutation of ['id', 'ancestor', 'namespace'] as const) {
		test(`grouped ${source} shared relation copies reject constructor ${mutation} changes`, async () => {
			const { Bound, store, children, constructions } = await setupSharedChildren(mutation);
			await assert.rejects(
				() => (source === 'query' ? Bound.query() : Bound.search('needle')).include('children').load(),
				mutation === 'id' ? /constructor result.*must match the requested id/ : /cannot (?:change the Datastore ancestor|move .*outside the scoped Datastore ancestor)/
			);
			assert.equal(constructions(), 2);
			assert.deepEqual(store.dump('shared_constructor_child'), children);
		});
	}

	test(`grouped ${source} shared relation copies preserve distinct instances and scoped data`, async () => {
		const { Bound, store, children, constructions } = await setupSharedChildren();
		const result = await (source === 'query' ? Bound.query() : Bound.search('needle')).include('children').load();
		const related = await Promise.all(result.list.map(async owner => await owner.ref<Model<ChildData>>('children').load() as Model<ChildData>[]));
		assert.equal(constructions(), 2);
		assert.equal(related.length, 2);
		assert.notEqual(related[0][0], related[1][0]);
		for (const list of related) assert.deepEqual(list.map(child => child.data), [{ ...children[0], label: 'child!' }]);
		assert.deepEqual(store.dump('shared_constructor_child'), children);
	});
}
