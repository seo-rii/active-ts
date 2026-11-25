import test from 'node:test';
import assert from 'node:assert/strict';
import { createActiveTs, defineModel, MemorySearchAdapter, MemoryStoreAdapter, Model, runSearchSyncWorker, type OutboxAdapter } from '../src/index.js';

class RevisionOrderDoc extends Model<{ id: number; title: string }> {}
defineModel<{ id: number; title: string }>({ name: 'revision_order_doc', search: 'memory' })
	.id('id').validate(input => input as { id: number; title: string }).search('memory', ['title']).attach(RevisionOrderDoc);

test('a paused authoritative read cannot acquire a newer fence than a subsequent snapshot', async () => {
	const store = new MemoryStoreAdapter();
	const search = new MemorySearchAdapter();
	let signalRead!: () => void;
	let resume!: () => void;
	const read = new Promise<void>(resolve => { signalRead = resolve; });
	const gate = new Promise<void>(resolve => { resume = resolve; });
	const get = store.get.bind(store);
	let pause = true;
	store.get = async (...args) => {
		const snapshot = await get(...args);
		if (pause) { pause = false; signalRead(); await gate; }
		return snapshot;
	};
	const context = createActiveTs({ stores: { default: store }, search: { memory: search }, defaultSearch: 'memory' });
	const meta = context.meta(RevisionOrderDoc);
	await store.create(meta, 1, { id: 1, title: 'old' });
	let revision = 0;
	const queue = (id: string): OutboxAdapter => ({
		append: async event => event,
		lease: async () => [{ id, model: meta.name, modelId: 1, operation: 'update', reconcileFromStore: true,
			createdAt: '2026-01-01T00:00:00.000Z', leaseToken: id, leaseExpiresAt: '2999-01-01T00:00:00.000Z' }],
		reserveSearchRevision: async () => ++revision,
		isLeaseCurrent: async () => true, release: async () => {}, retry: async () => {}, ack: async () => true
	});
	const older = runSearchSyncWorker({ outbox: queue('older'), search, models: [RevisionOrderDoc], context });
	await read;
	try {
		assert.equal(revision, 1, 'reserve a fence before reading the old snapshot');
		await store.update(meta, 1, { id: 1, title: 'new' });
		await runSearchSyncWorker({ outbox: queue('newer'), search, models: [RevisionOrderDoc], context });
	} finally { resume(); }
	await older;
	assert.equal(revision, 2);
	assert.equal(search.snapshot(meta.name)[0].title, 'new');
});
