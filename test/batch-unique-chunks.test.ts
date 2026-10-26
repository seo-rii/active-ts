import test from 'node:test';
import assert from 'node:assert/strict';
import { createActiveTs, defineModel, MemoryStoreAdapter, Model } from '../src/index.js';

class Record extends Model<{ id: number; value: string }> {}
defineModel('unique_chunk_record').id('id').attach(Record);
class TrackedStore extends MemoryStoreAdapter {
  calls: Array<Array<string | number>> = [];
  override async getMany(...args: Parameters<MemoryStoreAdapter['getMany']>) {
    this.calls.push([...args[1]]);
    return super.getMany(...args);
  }
}

for (const direct of [false, true]) {
  test(`duplicate reads share unique-id chunks while preserving models (direct=${direct})`, async () => {
    const store = new TrackedStore();
    const context = createActiveTs({ stores: { default: store }, batch: { maxSize: 2 } });
    const Bound = Record.use(context);
    for (let id = 1; id <= 3; id++) await Bound.create({ id, value: String(id) });
    const ids = [1, 2, 1, 3, 2, 1, 3];
    const rows = direct
      ? await context.loadManyNow(Bound, ids)
      : await Promise.all(ids.map(id => Bound.find(id).load()));
    assert.deepEqual(rows.map(row => row?.id), ids);
    assert.equal(new Set(rows).size, ids.length);
    assert.deepEqual(store.calls, [[1, 2], [3]]);
    rows[0]!.data.value = 'local';
    assert.equal(rows[2]!.data.value, '1');
  });
}
