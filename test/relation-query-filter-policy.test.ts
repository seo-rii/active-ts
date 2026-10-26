import test from 'node:test';
import assert from 'node:assert/strict';
import { createActiveTs, createSoftDeletePlugin, defineModel, MemoryStoreAdapter, Model } from '../src/index.js';

class Child extends Model<{ id: number; name: string; deletedAt?: string | null }> {}
class Owner extends Model<{ id: number; childId: number }> {}
defineModel('relation_filter_child').id('id').attach(Child);
defineModel('relation_filter_owner').id('id')
  .ref('full', () => Child, { localKey: 'childId', foreignKey: 'id', warnOnLazy: false })
  .ref('projected', () => Child, { localKey: 'childId', foreignKey: 'id', preload: ['name'], warnOnLazy: false }).attach(Owner);

for (const deletedAt of [null, '2026-01-01T00:00:00.000Z']) {
  test(`relation membership does not depend on projection (deleted=${deletedAt !== null})`, async () => {
    const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() },
      plugins: [createSoftDeletePlugin({ models: ['relation_filter_child'] })] });
    const BoundChild = Child.use(context), BoundOwner = Owner.use(context);
    await BoundChild.create({ id: 1, name: 'child', deletedAt });
    await BoundOwner.create({ id: 2, childId: 1 });
    const lazy = (await BoundOwner.find(2).load())!;
    const included = (await BoundOwner.query().include('full', 'projected').first())!;
    for (const owner of [lazy, included]) {
      const full = await owner.ref<Child>('full');
      const projected = await owner.ref<Child>('projected');
      if (deletedAt !== null) {
        assert.equal(full, null); assert.equal(projected, null);
      } else {
        assert.ok(full && !Array.isArray(full)); assert.ok(projected && !Array.isArray(projected));
        assert.equal(full.id, 1); assert.equal(projected.id, 1);
      }
    }
  });
}

test('one/id relation loads run configured query hooks even without a projection', async () => {
  let observed = 0;
  const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() }, plugins: [{
    name: 'query-membership', hooks: { afterQuery(payload) {
      if (payload.model?.name !== 'relation_filter_child') return;
      observed++;
      return { result: { ...(payload.result as object), list: [], count: 0 } };
    } }
  }] });
  const BoundChild = Child.use(context), BoundOwner = Owner.use(context);
  await BoundChild.create({ id: 1, name: 'filtered' });
  const owner = await BoundOwner.create({ id: 2, childId: 1 });
  assert.equal(await owner.ref('full'), null);
  assert.equal(observed, 1);
});
