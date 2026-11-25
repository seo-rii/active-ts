import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ActiveTsCommittedWriteError, createActiveTs, defineModel, MemoryCacheAdapter,
  MemoryStoreAdapter, Model
} from '../src/index.js';

class Record extends Model<{ id: number; version: number; value: string }> {}
defineModel({ name: 'local_copy_boundary_record', cache: { ttl: 60 } }).id('id').attach(Record);

for (const failHook of [false, true]) {
  test(`a post-write local copy failure invalidates cache and retains committed outcome (hook failure=${failHook})`, async () => {
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    class PausingStore extends MemoryStoreAdapter {
      override async update(...args: Parameters<MemoryStoreAdapter['update']>) {
        await super.update(...args);
        entered();
        await blocked;
      }
    }
    let afterWrites = 0;
    const store = new PausingStore();
    const context = createActiveTs({ stores: { default: store }, caches: { default: new MemoryCacheAdapter() },
      plugins: [{ name: 'observe-boundary', hooks: { afterStoreWrite(payload) {
        if (payload.operation !== 'update') return;
        afterWrites++;
        if (failHook) throw new Error('boundary hook failed');
      } } }]
    });
    const Bound = Record.use(context);
    await Bound.create({ id: 1, version: 1, value: 'old' });
    const row = (await Bound.find(1).load())!;
    row.data.value = 'new';
    const saving = row.save();
    await reached;
    Object.freeze(row.data);
    release();
    await assert.rejects(saving, error => {
      assert.ok(error instanceof ActiveTsCommittedWriteError);
      assert.equal(error.committed, true);
      if (failHook) assert.ok(error.cause instanceof AggregateError);
      else assert.ok(error.cause instanceof TypeError);
      return true;
    });
    assert.equal(afterWrites, 1);
    assert.deepEqual((await Bound.find(1).load())?.data, { id: 1, version: 2, value: 'new' });
  });
}

test('bulk afterUpdate hooks still observe all updated model versions', async () => {
  const targets: Array<{ data: { version: number } }> = [];
  const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() }, plugins: [{
    name: 'bulk-observation', hooks: {
      beforeUpdate(payload) { targets.push(payload.target as { data: { version: number } }); },
      afterUpdate() { assert.deepEqual(targets.map(target => target.data.version), [2, 2]); }
    }
  }] });
  const Bound = Record.use(context);
  await Bound.create({ id: 1, version: 1, value: 'old' });
  await Bound.create({ id: 2, version: 1, value: 'old' });
  await Bound.upsertMany([{ id: 1, version: 1, value: 'first' }, { id: 2, version: 1, value: 'second' }]);
});
