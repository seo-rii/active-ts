import test from 'node:test';
import assert from 'node:assert/strict';
import { createActiveTs, defineModel, MemoryStoreAdapter, MemorySearchAdapter, Model } from '../src/index.js';
import { mapConcurrent } from '../src/core/concurrent-map.js';

class Record extends Model<{ id: number; name: string }> {}
class Owner extends Model<{ id: number; childId: number }> {}
defineModel({ name: 'bounded_hooks_record', search: 'memory' }).id('id').search('memory', ['name']).attach(Record);
defineModel('bounded_hooks_owner').id('id')
  .ref('child', () => Record, { localKey: 'childId', foreignKey: 'id', warnOnLazy: false }).attach(Owner);

for (const concurrency of [1, 2, undefined]) {
  for (const mode of ['query', 'ids', 'include', 'search'] as const) {
    test(`afterInstantiate concurrency is configurable with stable result order (${mode}, ${concurrency})`, async () => {
      let running = 0, maximum = 0, observe = false;
      const search = new MemorySearchAdapter();
      const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() }, search: { memory: search }, batch: { concurrency }, plugins: [{
        name: 'observe-concurrency', hooks: { async afterInstantiate(payload) {
          if (!observe || payload.model?.name !== 'bounded_hooks_record') return;
          running++; maximum = Math.max(maximum, running);
          try { await new Promise<void>(resolve => setImmediate(resolve)); } finally { running--; }
        } }
      }] });
      const Bound = Record.use(context);
      const BoundOwner = Owner.use(context);
      for (let id = 1; id <= 6; id++) {
        const row = { id, name: 'needle' };
        await Bound.create(row);
        await BoundOwner.create({ id, childId: id });
        await search.index(context.meta(Bound), id, row);
      }
      observe = true;
      const ids = [1, 2, 3, 4, 5, 6];
      const rows = mode === 'query' ? (await Bound.query().load()).list
        : mode === 'ids' ? await context.loadManyNow(Bound, ids)
        : mode === 'include' ? (await BoundOwner.query().include('child').load()).list
        : (await Bound.search('needle').load()).list;
      assert.deepEqual(rows.map(row => row?.id), ids);
      assert.equal(maximum, concurrency ?? 6);
      assert.equal(running, 0);
    });
  }
}

test('bounded work drains started tasks and preserves an undefined rejection', async () => {
  const started: number[] = [];
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const result = mapConcurrent([0, 1, 2, 3], 2, async value => {
    started.push(value);
    if (value === 0) await blocked;
    else throw undefined;
  });
  let settled = false;
  void result.then(() => { settled = true; }, () => { settled = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(started, [0, 1]);
  release();
  await assert.rejects(result, error => error === undefined);
});

test('batch concurrency rejects invalid limits without evaluating accessors', () => {
  for (const concurrency of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createActiveTs({ stores: { default: new MemoryStoreAdapter() }, batch: { concurrency } }), /batch.concurrency/);
  }
  let evaluated = false;
  assert.throws(() => createActiveTs({ stores: { default: new MemoryStoreAdapter() }, batch: {
    get concurrency() { evaluated = true; return 2; }
  } }), /data property|accessor/i);
  assert.equal(evaluated, false);
});

test('unconfigured collections retain Promise.all rejection timing', { timeout: 5_000 }, async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const result = mapConcurrent([0, 1], undefined, async value => {
    if (value === 0) throw undefined;
    await blocked;
  });
  try { await assert.rejects(result, error => error === undefined); }
  finally { release(); }
});
