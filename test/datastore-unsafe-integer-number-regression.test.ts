import test from 'node:test';
import assert from 'node:assert/strict';
import { Datastore } from '@google-cloud/datastore';
import { ActiveTsValidationError, type ResolvedModelMeta } from '../src/index.js';
import { createDatastoreStoreAdapter } from '../src/adapters/store/datastore.js';

const meta: ResolvedModelMeta = { model: class {}, name: 'unsafe_integer_numbers', store: 'default', idField: 'id',
	readValidation: 'off', indexes: [], searchIndexes: [], relations: new Map(), hooks: {}, views: new Map(),
	policies: new Map(), scopes: new Map(), fieldCodecs: new Map(), fieldTypes: new Map([['score', 'number']]) };

const sdkEntityModule = '@google-cloud/datastore/build/src/entity.js';
const { entity: sdkEntity } = await import(sdkEntityModule);

// Integer-valued doubles the SDK would otherwise send as integerValue "1e+21"
// (stored as 1), a rounded 64-bit integer, or an unreadable out-of-range value.
const unsafe = [1e21, 6.02e23, 2 ** 60, -(2 ** 60), 2 ** 53, Number.MAX_VALUE];

function writeClient(overrides: Record<string, unknown> = {}) {
	const saved: any[] = [];
	const record = async (entity: unknown) => { saved.push(...(Array.isArray(entity) ? entity : [entity])); };
	const client = { KEY: Symbol('key'), key: (input: unknown) => input, get: async () => [undefined],
		insert: record, update: record, upsert: record, save: record, delete: async () => undefined,
		createQuery: () => ({}), runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }],
		double: (value: number) => Datastore.double(value), ...overrides };
	return { client, saved };
}

function encodedProperties(entity: { data: unknown }) {
	return sdkEntity.entityToEntityProto({ data: entity.data }).properties;
}

test('Datastore writes integer-valued unsafe numbers as exact doubles', async () => {
	const { client, saved } = writeClient();
	const store = await createDatastoreStoreAdapter({ client }) as Awaited<ReturnType<typeof createDatastoreStoreAdapter>>;
	const data = (id: number, value: number) => ({ id, score: value, nested: { values: [1, value] }, safe: 9_007_199_254_740_991 });
	for (const [index, value] of unsafe.entries()) await store.create(meta, index + 1, data(index + 1, value));
	await store.update(meta, 1, data(1, unsafe[1]));
	await store.bulk.upsertMany(meta, [{ id: 2, data: data(2, unsafe[2]) }]);
	const expected = [...unsafe, unsafe[1], unsafe[2]];
	assert.equal(saved.length, expected.length);
	for (const [index, entity] of saved.entries()) {
		const properties = encodedProperties(entity);
		assert.deepEqual(properties.score, { doubleValue: expected[index] });
		assert.deepEqual(properties.nested.entityValue.properties.values.arrayValue.values, [
			{ integerValue: '1' },
			{ doubleValue: expected[index] }
		]);
		assert.deepEqual(properties.safe, { integerValue: '9007199254740991' });
		assert.deepEqual(properties.id, { integerValue: String(entity.data.id) });
	}
	const input = data(9, 1e21);
	await store.create(meta, 9, input);
	assert.equal(input.score, 1e21, 'caller data is not replaced by SDK wrappers');
});

test('Datastore buffered transaction writes encode unsafe integer-valued numbers', async () => {
	const { client: transaction, saved } = writeClient({
		run: async () => undefined,
		commit: async () => undefined,
		rollback: async () => undefined
	});
	const { client } = writeClient({ transaction: () => transaction });
	const store = await createDatastoreStoreAdapter({ client });
	await store.transaction!(async (scoped) => {
		await scoped.create(meta, 1, { id: 1, score: 1e21 });
	});
	assert.equal(saved.length, 1);
	assert.deepEqual(encodedProperties(saved[0]).score, { doubleValue: 1e21 });
});

test('Datastore rejects unsafe integer-valued numbers without client.double()', async () => {
	const { client, saved } = writeClient({ double: undefined });
	const store = await createDatastoreStoreAdapter({ client });
	await assert.rejects(store.create(meta, 1, { id: 1, score: 1e21 }), ActiveTsValidationError);
	await store.create(meta, 2, { id: 2, score: 2 ** 53 - 1, ratio: 0.5 });
	assert.deepEqual(saved.map((entity) => entity.data.id), [2]);
});
