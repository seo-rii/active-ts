import test from 'node:test';
import assert from 'node:assert/strict';
import { Model, defineModel, createActiveTs, MemoryStoreAdapter } from '../src/index.js';
import { createMongoStoreAdapter } from '../src/adapters/store/mongodb.js';

class CollationRecord extends Model<{ id: string; value: string }> {}
defineModel('portable_collation_record').id('id').attach(CollationRecord);
const metadata = createActiveTs({ stores: { default: new MemoryStoreAdapter() } }).meta(CollationRecord);

function fixture(collation?: unknown) {
	const calls: Array<{ name: string; options: any }> = [];
	const cursor = { sort() { return this; }, limit() { return this; }, toArray: async () => [] };
	const collection = {
		findOne: async (_filter: unknown, options: unknown) => { calls.push({ name: 'findOne', options }); return null; },
		find: (_filter: unknown, options: unknown) => { calls.push({ name: 'find', options }); return cursor; },
		aggregate: (_pipeline: unknown, options: unknown) => { calls.push({ name: 'aggregate', options }); return { toArray: async () => [{ count: 0 }] }; },
		replaceOne: async (_filter: unknown, _data: unknown, options: unknown) => { calls.push({ name: 'replaceOne', options }); return { matchedCount: 1 }; },
		deleteOne: async (_filter: unknown, options: unknown) => { calls.push({ name: 'deleteOne', options }); return { deletedCount: 1 }; },
		insertOne: async (_data: unknown, options: unknown) => { calls.push({ name: 'insertOne', options }); return {}; },
		indexes: async () => []
	};
	const db = {
		collection: () => collection,
		listCollections: () => ({ toArray: async () => [{ name: metadata.name, type: 'collection', options: collation === undefined ? {} : { collation } }] }),
		createCollection: async () => undefined
	};
	return { calls, client: { db: () => db } };
}

test('all portable MongoDB matching operations use simple collation', async () => {
	const { calls, client } = fixture({ locale: 'en', strength: 2 });
	const store = await createMongoStoreAdapter({ client, dbName: 'audit' });
	await store.get(metadata, 'case');
	await store.getMany(metadata, ['case']);
	await store.query(metadata, { where: [], or: [], sort: [], include: [] });
	await store.aggregate!(metadata, { where: [], or: [], aggregates: [{ op: 'count', as: 'count' }] });
	await store.update(metadata, 'case', { id: 'case', value: 'updated' });
	await store.delete(metadata, 'case');
	await store.create(metadata, 'case', { id: 'case', value: 'created' });
	assert.deepEqual(calls.map(call => call.name), ['findOne', 'find', 'find', 'aggregate', 'replaceOne', 'deleteOne', 'insertOne']);
	for (const call of calls.filter(call => call.name !== 'insertOne')) {
		assert.deepEqual(call.options.collation, { locale: 'simple' });
	}
	assert.equal(calls.at(-1)?.options?.collation, undefined, 'inserts do not support the collation option');
});

test('MongoDB schema rejects locale-sensitive collection defaults before accepting indexes', async () => {
	const { client } = fixture({ locale: 'en', strength: 2 });
	const store = await createMongoStoreAdapter({ client, dbName: 'audit' });
	await assert.rejects(() => store.schema!.plan([metadata]), /requires simple collation/);
	await assert.rejects(() => store.schema!.apply([metadata], { mode: 'safe' }), /requires simple collation/);
});

test('MongoDB schema accepts implicit and explicit simple collation', async () => {
	for (const collation of [undefined, { locale: 'simple' }]) {
		const { client } = fixture(collation);
		const store = await createMongoStoreAdapter({ client, dbName: 'audit' });
		assert.deepEqual((await store.schema!.plan([metadata])).changes, []);
	}
});
