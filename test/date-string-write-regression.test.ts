import test from 'node:test';
import assert from 'node:assert/strict';
import { ActiveTsCommittedWriteError, createActiveTs, defineModel, MemoryStoreAdapter, Model } from '../src/index.js';

type EventData = { id: number; at: Date | string; label?: string };
function setup(mutateAfterCreate = false) {
	class Event extends Model<EventData> {}
	defineModel<EventData>('date_string_write').fieldType('at', 'date').hooks({
		afterCreate({ target }) {
			if (mutateAfterCreate) (target as Event).data.label = 'changed';
		}
	}).attach(Event);
	const store = new MemoryStoreAdapter();
	const context = createActiveTs({ stores: { default: store } });
	return { Events: Event.use(context), store };
}

for (const at of ['2026-01-01', '2026-01-01T00:00:00.000Z']) {
	test(`create accepts date string ${at} and returns a hydrated model`, async () => {
		const { Events, store } = setup();
		const item = await Events.create({ id: 1, at });
		assert.ok(item.data.at instanceof Date);
		assert.equal(item.data.at.toISOString(), '2026-01-01T00:00:00.000Z');
		assert.deepEqual(store.dump('date_string_write'), [{ id: 1, at: '2026-01-01T00:00:00.000Z' }]);
	});
}

test('save and static update accept date strings after loading Date instances', async () => {
	const { Events, store } = setup();
	const item = await Events.create({ id: 1, at: new Date('2026-01-01') });
	item.data.at = '2026-02-01';
	await item.save();
	const savedAt: unknown = item.data.at;
	assert.ok(savedAt instanceof Date);
	assert.equal(savedAt.toISOString(), '2026-02-01T00:00:00.000Z');
	const updated = await Events.update(1, { at: '2026-03-01T00:00:00.000Z' });
	assert.ok(updated?.data.at instanceof Date);
	assert.equal(updated.data.at.toISOString(), '2026-03-01T00:00:00.000Z');
	assert.deepEqual(store.dump('date_string_write'), [{ id: 1, at: '2026-03-01T00:00:00.000Z' }]);
});

test('normalizing a date snapshot still rejects afterCreate changes to other committed fields', async () => {
	const { Events, store } = setup(true);
	await assert.rejects(() => Events.create({ id: 1, at: '2026-01-01', label: 'original' }), ActiveTsCommittedWriteError);
	assert.deepEqual(store.dump('date_string_write'), [{ id: 1, at: '2026-01-01T00:00:00.000Z', label: 'original' }]);
});
