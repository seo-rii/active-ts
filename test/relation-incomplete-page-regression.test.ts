import test from 'node:test';
import assert from 'node:assert/strict';
import { Model, defineModel, createActiveTs, MemoryStoreAdapter, type StoreAdapter } from '../src/index.js';
import { createDatastoreStoreAdapter } from '../src/adapters/store/datastore.js';

class PageParent extends Model<{ id: number }> {}
class PageChild extends Model<{ id: number; ownerId: number }> {}
defineModel({ name: 'incomplete_relation_child', store: 'children' }).id('id').fieldType('ownerId', 'number').attach(PageChild);
defineModel('incomplete_relation_parent').id('id')
	.hasMany('children', () => PageChild, { localKey: 'id', foreignKey: 'ownerId' }).attach(PageParent);

for (const mode of ['lazy', 'instance include', 'query include'] as const) {
	test(`${mode} rejects incomplete Datastore relation results and permits a later retry`, async () => {
		let calls = 0;
		let complete = false;
		let afterRelations = 0;
		const children = await createDatastoreStoreAdapter({ client: {
			key: (value: unknown) => value, get: async () => [undefined], save: async () => {}, delete: async () => {}, update: async () => {},
			createQuery: () => ({ filter() { return this; }, order() { return this; }, select() { return this; }, limit() { return this; }, start() { return this; } }),
			runQuery: async () => {
				calls++;
				return complete
					? [[{ id: 10, ownerId: 1 }, { id: 11, ownerId: 1 }], { moreResults: 'NO_MORE_RESULTS' }]
					: [[{ id: 10, ownerId: 1 }], { moreResults: 'NOT_FINISHED', endCursor: 'page-2' }];
			}
		} });
		const owners = new MemoryStoreAdapter();
		await owners.seed('incomplete_relation_parent', [{ id: 1 }]);
		const Parent = PageParent.use(createActiveTs({
			stores: { default: owners, children }, lazyWarnings: false,
			plugins: [{ name: 'relation-result-counter', hooks: { afterRelationLoad() { afterRelations++; } } }]
		}));
		const owner = (await Parent.find(1).load())!;
		const load = async () => {
			if (mode === 'query include') return (await Parent.query().include('children').load()).list[0].ref<PageChild>('children').load();
			if (mode === 'instance include') await owner.include('children');
			return owner.ref<PageChild>('children').load();
		};
		await assert.rejects(load, /Relation loading requires a complete query result/);
		assert.equal(calls, 1);
		assert.equal(afterRelations, 0);
		complete = true;
		const result = await load();
		assert.ok(Array.isArray(result));
		assert.deepEqual(result.map((row) => row.data.id), [10, 11]);
		assert.equal(calls, 2);
	});
}

test('relations reject an incomplete adapter response without a cursor', async () => {
	let calls = 0;
	const children: StoreAdapter = {
		kind: 'incomplete-relation-test', capabilities: {},
		get: async () => null, getMany: async () => [], create: async () => {}, update: async () => {}, delete: async () => {},
		query: async () => { calls++; return { list: [{ id: 10, ownerId: 1 }], more: true }; }
	};
	const owners = new MemoryStoreAdapter();
	await owners.seed('incomplete_relation_parent', [{ id: 1 }]);
	const Parent = PageParent.use(createActiveTs({ stores: { default: owners, children }, lazyWarnings: false }));
	const owner = (await Parent.find(1).load())!;
	await assert.rejects(() => owner.ref('children').load(), /Relation loading requires a complete query result/);
	assert.equal(calls, 1);
});
