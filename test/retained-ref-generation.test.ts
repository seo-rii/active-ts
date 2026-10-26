import test from 'node:test';
import assert from 'node:assert/strict';
import { createActiveTs, defineModel, MemoryStoreAdapter, Model } from '../src/index.js';

class Child extends Model<{ id: number; name: string }> {}
class Owner extends Model<{ id: number; childId: number }> {}
defineModel('retained_generation_child').id('id').attach(Child);
defineModel('retained_generation_owner').id('id')
  .ref('child', () => Child, { localKey: 'childId', foreignKey: 'id', preload: ['name'], warnOnLazy: false }).attach(Owner);

test('retained partial and full relation handles follow owner keys across repeated saves', async () => {
  const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
  const BoundChild = Child.use(context), BoundOwner = Owner.use(context);
  for (let id = 1; id <= 3; id++) await BoundChild.create({ id, name: String(id) });
  const owner = await BoundOwner.create({ id: 9, childId: 1 });
  const retained = owner.ref<Child>('child');
  const childId = (value: Child | Child[] | null) => {
    assert.ok(value && !Array.isArray(value)); return value.id;
  };
  assert.equal(childId(await retained.load()), 1);
  assert.equal(childId(await retained.load({ full: true })), 1);
  for (const nextId of [2, 3]) {
    owner.data.childId = nextId;
    await owner.save();
    assert.equal(childId(await retained.load()), nextId);
    assert.equal(childId(await retained.load({ full: true })), nextId);
    assert.equal(childId(await owner.ref<Child>('child')), nextId);
  }
});
