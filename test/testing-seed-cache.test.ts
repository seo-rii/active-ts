import test from 'node:test';
import assert from 'node:assert/strict';
import { Model, defineModel, MemoryStoreAdapter, type ResolvedModelMeta, type EntityId } from '../src/index.js';
import { createTestContext } from '../src/testing/index.js';

class SeedRecord extends Model<{ id: number; value: string }> {}
defineModel({ name: 'seed_cache_record', cache: { ttl: 60, negativeTtl: 60 } })
	.id('id').validate(data => data as { id: number; value: string }).attach(SeedRecord);

test('seed and fixture invalidate an earlier cached miss', async () => {
	const context = createTestContext();
	const Bound = SeedRecord.use(context.context);
	assert.equal(await Bound.find(1).load(), null);
	await context.seed(SeedRecord, [{ id: 1, value: 'seeded' }]);
	assert.equal((await Bound.find(1).load())?.data.value, 'seeded');
	assert.equal(await Bound.find(2).load(), null);
	await context.fixture(SeedRecord, { id: 2, value: 'fixture' });
	assert.equal((await Bound.find(2).load())?.data.value, 'fixture');
});

test('seeding fences a miss that is already being backfilled', async () => {
	class PausedStore extends MemoryStoreAdapter {
		pause = true;
		release!: () => void;
		onRead!: () => void;
		read = new Promise<void>(resolve => { this.onRead = resolve; });
		gate = new Promise<void>(resolve => { this.release = resolve; });
		override async getMany(model: ResolvedModelMeta, ids: EntityId[]) {
			const rows = await super.getMany(model, ids);
			if (this.pause) {
				this.pause = false;
				this.onRead();
				await this.gate;
			}
			return rows;
		}
	}
	const store = new PausedStore();
	const context = createTestContext({ store });
	const Bound = SeedRecord.use(context.context);
	const pending = Bound.find(1).load();
	await store.read;
	await context.seed(SeedRecord, [{ id: 1, value: 'seeded during read' }]);
	store.release();
	await pending;
	assert.equal((await Bound.find(1).load())?.data.value, 'seeded during read');
});

test('a partially failing fixture helper still invalidates attempted IDs', async () => {
	const failure = new Error('partially seeded');
	class PartialStore extends MemoryStoreAdapter {
		override async seedModel(meta: ResolvedModelMeta, rows: any[]) {
			await super.seedModel(meta, rows.slice(0, 1));
			throw failure;
		}
	}
	const context = createTestContext({ store: new PartialStore() });
	const Bound = SeedRecord.use(context.context);
	assert.equal(await Bound.find(1).load(), null);
	await assert.rejects(context.seed(SeedRecord, [{ id: 1, value: 'committed prefix' }]), error => error === failure);
	assert.equal((await Bound.find(1).load())?.data.value, 'committed prefix');
});
