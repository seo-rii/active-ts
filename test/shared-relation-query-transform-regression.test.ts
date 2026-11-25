import test from 'node:test';
import assert from 'node:assert/strict';
import { createActiveTs, defineModel, MemoryStoreAdapter, Model } from '../src/index.js';

type ChildData = { id: number; group: string; secret?: string; label: string; nested: { value: string } };
type OwnerData = { id: number; group: string };

for (const relationKind of ['one', 'many'] as const) {
	test(`shared ${relationKind} relations retain afterQuery changes while isolating owner hooks`, async () => {
		let constructions = 0;
		let queryCalls = 0;
		let instantiateCalls = 0;
		class Child extends Model<ChildData> {
			constructor(data: ChildData, context?: any, options?: any) {
				super(data, context, options);
				constructions++;
				this.data.label += ':constructor';
			}
		}
		class Owner extends Model<OwnerData> {}
		defineModel<ChildData>(`shared_transform_child_${relationKind}`).hooks({
			afterInstantiate({ target }) {
				instantiateCalls++;
				(target as Child).data.label += ':instantiate';
			},
			afterQuery({ result }) {
				queryCalls++;
				for (const item of result.list as Child[]) {
					delete item.data.secret;
					item.data.label += ':query';
					item.data.nested.value = 'redacted';
				}
			}
		}).attach(Child);
		const owner = defineModel<OwnerData>(`shared_transform_owner_${relationKind}`);
		if (relationKind === 'one') owner.ref('children', () => Child, { localKey: 'group', foreignKey: 'group' });
		else owner.hasMany('children', () => Child, { localKey: 'group', foreignKey: 'group' });
		owner.hooks({
			afterRelationLoad({ target, result }) {
				const child = (Array.isArray(result) ? result[0] : result) as Child;
				assert.equal(child.data.secret, undefined);
				assert.equal(child.data.label, 'child:constructor:instantiate:query');
				assert.equal(child.data.nested.value, 'redacted');
				child.data.nested.value += `:${(target as Owner).data.id}`;
			}
		}).attach(Owner);
		const store = new MemoryStoreAdapter();
		const context = createActiveTs({ stores: { default: store }, lazyWarnings: false });
		await store.seed(context.meta(Child), [{ id: 10, group: 'A', secret: 'private', label: 'child', nested: { value: 'private' } }]);
		await store.seed(context.meta(Owner), [{ id: 1, group: 'A' }, { id: 2, group: 'A' }]);
		const owners = (await Owner.use(context).query().orderBy('id').include('children').load()).list;
		const children = await Promise.all(owners.map(async item => {
			const result = await item.ref<Child>('children').load();
			return (Array.isArray(result) ? result[0] : result) as Child;
		}));
		assert.equal(constructions, 2);
		assert.equal(instantiateCalls, 2);
		assert.equal(queryCalls, 1);
		assert.notEqual(children[0], children[1]);
		assert.notEqual(children[0].data.nested, children[1].data.nested);
		assert.deepEqual(children.map(child => child.data.nested.value), ['redacted:1', 'redacted:2']);
		assert.deepEqual(children.map(child => child.data.secret), [undefined, undefined]);
	});
}
