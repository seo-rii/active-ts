import test from 'node:test';
import assert from 'node:assert/strict';
import { createActiveTs, MemoryStoreAdapter, StoreOutboxAdapter, type OutboxEvent, type StoreAdapter } from '../src/index.js';

class PagedStore extends MemoryStoreAdapter {
	override async query(...[model, plan, options]: Parameters<MemoryStoreAdapter['query']>) {
		return super.query(model, { ...plan, limit: Math.min(plan.limit ?? 1, 1) }, options);
	}
}

async function fixture() {
	const store = new PagedStore();
	const adapter: StoreAdapter = {
		kind: 'paged-outbox', capabilities: { ...store.capabilities, transaction: false, savepoint: false, aggregate: false },
		get: (...args) => store.get(...args), getMany: (...args) => store.getMany(...args),
		query: (...args) => store.query(...args), create: (...args) => store.create(...args),
		update: (...args) => store.update(...args), delete: (...args) => store.delete(...args)
	};
	const context = createActiveTs({ stores: { default: adapter } });
	const outbox = new StoreOutboxAdapter({ context });
	for (let id = 1; id <= 4; id++) await outbox.append({
		id: String(id), model: 'record', modelId: id, operation: 'create', data: { id },
		createdAt: `2026-01-0${id}T00:00:00.000Z`,
		...(id === 1 || id === 4 ? { deadLetteredAt: '2026-01-10T00:00:00.000Z' } : {})
	});
	return { store, outbox };
}

test('store outbox lists pending and dead-letter events beyond default page size', async () => {
	const { outbox } = await fixture();
	assert.deepEqual((await outbox.list()).map(event => event.id), ['2', '3']);
	assert.deepEqual((await outbox.listDeadLetters()).map(event => event.id), ['1', '4']);
});

test('unbounded store outbox lease reaches live events after a dead-letter page', async () => {
	const { outbox } = await fixture();
	assert.deepEqual((await outbox.lease()).map(event => event.id), ['2', '3']);
});

test('unbounded store outbox drain visits all pages and preserves dead letters', async () => {
	const { store, outbox } = await fixture();
	assert.deepEqual((await outbox.drain()).map(event => event.id), ['2', '3']);
	assert.deepEqual(store.dump('active_ts_outbox_event').map((event: OutboxEvent) => event.id), ['1', '4']);
});

test('store outbox rejects a repeated continuation cursor rather than looping', async () => {
	class StalledStore extends MemoryStoreAdapter {
		override async query(...args: Parameters<MemoryStoreAdapter['query']>) {
			const result = await super.query(args[0], { ...args[1], cursor: undefined }, args[2]);
			return { ...result, cursor: 'stalled', more: true };
		}
	}
	const context = createActiveTs({ stores: { default: new StalledStore() } });
	const outbox = new StoreOutboxAdapter({ context });
	await assert.rejects(outbox.list(), /advancing cursor/);
});
