import test from 'node:test';
import assert from 'node:assert/strict';
import {
	createActiveTs, datastoreKey, defineModel, hasMany, MemoryStoreAdapter, Model, ref, relation,
	type RelationAncestorResolver
} from '../src/index.js';
import { relationAncestorForOwner } from '../src/core/relation-ancestor.js';

type OwnerData = { id: number; childId: number; tenantId: string };
class Child extends Model<{ id: number }> {}
defineModel('decorator_ancestor_child').id('id').attach(Child);

const decorators = {
	ref: (ancestor: RelationAncestorResolver) => ref(() => Child, { localKey: 'childId', foreignKey: 'id', ancestor }),
	hasMany: (ancestor: RelationAncestorResolver) => hasMany(() => Child, { localKey: 'id', foreignKey: 'id', ancestor }),
	relation: (ancestor: RelationAncestorResolver) => relation(() => Child, { kind: 'one', localKey: 'childId', foreignKey: 'id', ancestor })
};

for (const [name, decorate] of Object.entries(decorators)) {
	test(`${name} accepts and retains the typed ancestor resolver`, () => {
		class Owner extends Model<OwnerData> {}
		defineModel(`decorator_ancestor_${name}`).id('id').attach(Owner);
		const expected = datastoreKey('Tenant', 'tenant-one');
		let calls = 0;
		const ancestor: RelationAncestorResolver<OwnerData> = ({ data, owner, targetModel, relation: resolved }) => {
			calls++;
			assert.equal(data.tenantId, 'tenant-one');
			assert.equal(owner.data, data);
			assert.equal(targetModel.name, 'decorator_ancestor_child');
			assert.equal(resolved.name, 'children');
			return datastoreKey('Tenant', data.tenantId);
		};
		decorate(ancestor)(Owner.prototype, 'children');
		const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
		const ownerMeta = context.meta(Owner);
		const relationMeta = ownerMeta.relations.get('children')!;
		assert.equal(relationMeta.ancestor, ancestor);
		const owner = new Owner({ id: 1, childId: 2, tenantId: 'tenant-one' }, context);
		assert.deepEqual(relationAncestorForOwner(context, ownerMeta, context.meta(Child), relationMeta, owner), expected);
		assert.equal(calls, 1);
	});

	test(`${name} rejects an invalid ancestor without registering a getter or relation`, () => {
		class Owner extends Model<OwnerData> {}
		defineModel(`decorator_ancestor_invalid_${name}`).id('id').attach(Owner);
		assert.throws(() => decorate(null as never)(Owner.prototype, 'children'), /ancestor must be a function/);
		assert.equal(Object.getOwnPropertyDescriptor(Owner.prototype, 'children'), undefined);
		assert.equal(createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(Owner).relations.has('children'), false);
	});
}

test('ancestor accessors are rejected without invoking application code', () => {
	let reads = 0;
	const options = { localKey: 'childId', foreignKey: 'id', get ancestor() { reads++; return () => undefined; } };
	assert.throws(() => ref(() => Child, options), /ancestor.*must be a data property/);
	assert.equal(reads, 0);
});
