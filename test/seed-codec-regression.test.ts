import test from 'node:test';
import assert from 'node:assert/strict';
import { Model, defineModel, MemoryStoreAdapter } from '../src/index.js';
import { createTestContext } from '../src/testing/index.js';

type Data = { id: number; profile: { name: string }; seenAt: Date };
class SeedRecord extends Model<Data> {}
defineModel<Data>('seed_encoded_record').id('id').fieldType('seenAt', 'date')
	.fieldCodec('profile', { name: 'json', encode: (value) => JSON.stringify(value), decode: (value) => JSON.parse(value as string) })
	.attach(SeedRecord);

for (const path of ['seedModel', 'seed', 'create'] as const) {
	test(`test seed encodes model fields through the ${path} adapter path`, async () => {
		const store = new MemoryStoreAdapter();
		if (path !== 'seedModel') Object.defineProperty(store, 'seedModel', { value: undefined, enumerable: true });
		if (path === 'create') Object.defineProperty(store, 'seed', { value: undefined, enumerable: true });
		const ctx = createTestContext({ store });
		const Record = SeedRecord.use(ctx.context);
		const input: Data = { id: 1, profile: { name: 'alice' }, seenAt: new Date('2026-01-01T00:00:00.000Z') };
		const [seeded] = await ctx.seed(Record, [input]);
		assert.deepEqual(seeded, input);
		assert.deepEqual(input.profile, { name: 'alice' });
		const stored = await store.get(ctx.context.meta(Record), 1);
		assert.equal(stored?.profile, '{"name":"alice"}');
		assert.equal(stored?.seenAt, '2026-01-01T00:00:00.000Z');
		const loaded = await Record.find(1).load();
		assert.deepEqual(loaded?.data.profile, { name: 'alice' });
		assert.deepEqual(loaded?.data.seenAt, input.seenAt);
	});
}

test('seed prepares all codecs before any row is persisted', async () => {
	class InvalidRecord extends Model<{ id: number; value: string }> {}
	defineModel('seed_invalid_codec').id('id').fieldCodec('value', {
		name: 'checked', encode: (value) => { if (value === 'bad') throw new Error('bad value'); return value; },
		decode: (value) => value
	}).attach(InvalidRecord);
	const ctx = createTestContext();
	await assert.rejects(() => ctx.seed(InvalidRecord, [{ id: 1, value: 'good' }, { id: 2, value: 'bad' }]), /bad value/);
	assert.deepEqual(ctx.snapshotStore(InvalidRecord), []);
});
