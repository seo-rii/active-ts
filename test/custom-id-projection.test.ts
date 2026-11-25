import test from 'node:test';
import assert from 'node:assert/strict';
import { createActiveTs, defineModel, MemoryStoreAdapter, Model } from '../src/index.js';

class Record extends Model<{ slug: string; id: number; name: string }> {}
defineModel('custom_projection_record').id('slug').attach(Record);

async function typeContract() {
  const row = await Record.query().select('name').first();
  if (row) {
    const name: string = row.data.name;
    const optionalId: number | undefined = row.data.id;
    // @ts-expect-error The ordinary id field was not selected and is not the model key.
    const requiredId: number = row.data.id;
    void [name, optionalId, requiredId];
  }
  const explicit = await Record.query().select('id').first();
  if (explicit) { const id: number = explicit.data.id; void id; }
}
void typeContract;

test('projection retains the configured key without claiming an unselected ordinary id field', async () => {
  const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
  const Bound = Record.use(context);
  await Bound.create({ slug: 'key', id: 42, name: 'Alice' });
  const row = await Bound.query().select('name').first();
  assert.deepEqual(row?.data, { slug: 'key', name: 'Alice' });
  assert.equal(row?.id, 'key');
  const explicit = await Bound.query().select('id').first();
  assert.deepEqual(explicit?.data, { slug: 'key', id: 42 });
});
