import test from 'node:test';
import assert from 'node:assert/strict';
import { Model, defineModel, type ResolvedModelMeta } from '../src/index.js';
import { createDatastoreIndexYaml, createDatastoreStoreAdapter } from '../src/adapters/store/datastore.js';

const keySymbol = Symbol('datastore-key');
const exclusions = ['body', 'details[].note', 'tags[]', 'private.*'];
const meta: ResolvedModelMeta = {
	model: class {},
	name: 'storage_record',
	store: 'default',
	idField: 'id',
	readValidation: 'off',
	indexes: [],
	searchIndexes: [],
	relations: new Map(),
	hooks: {},
	views: new Map(),
	policies: new Map(),
	scopes: new Map(),
	fieldCodecs: new Map(),
	fieldTypes: new Map(),
	datastore: { unindexed: exclusions }
};

function datastoreClient(overrides: Record<string, unknown> = {}) {
	return {
		key: (input: unknown) => input,
		get: async () => [undefined],
		insert: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined,
		createQuery: () => ({}),
		runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }],
		...overrides
	};
}

test('Datastore exclusion paths reject malformed traversal and disguised reserved properties', () => {
	const invalid = [
		'details[0].note', 'details[]note', 'details[][]', 'details.*.note',
		'details.*[]', 'details[].constructor[]', 'constructor[]', 'details/toString',
		'details[].private.*'
	];
	for (const field of invalid) {
		class InvalidRecord extends Model<{ id: number }> {}
		assert.throws(
			() => defineModel<{ id: number }>('invalid_exclusion')
				.id('id').datastore({ unindexed: [field] }).attach(InvalidRecord),
			/Reserved|must use dotted fields|cannot contain|recursive wildcard below an array child/,
			field
		);
	}
});

test('Datastore array and recursive exclusions cannot bypass identity and index guards', async () => {
	let ioCalls = 0;
	const store = await createDatastoreStoreAdapter({
		keySymbol,
		client: datastoreClient({
			key: () => { ioCalls++; throw new Error('Unexpected key allocation'); },
			insert: async () => { ioCalls++; },
			save: async () => { ioCalls++; }
		})
	});
	const invalid = [
		{ field: 'id[]', indexes: [] },
		{ field: 'id.*', indexes: [] },
		{ field: 'details[].note', indexes: [{ name: 'by_note', fields: ['details.note'] }] },
		{ field: 'details[]', indexes: [{ name: 'by_note', fields: ['details.note'] }] },
		{ field: 'private.*', indexes: [{ name: 'by_email', fields: ['private.email'] }] }
	];
	for (const { field, indexes } of invalid) {
		const invalidMeta = { ...meta, indexes, datastore: { unindexed: [field] } };
		assert.throws(() => createDatastoreIndexYaml(invalidMeta), /overlap/, field);
		await assert.rejects(() => store.schema!.plan([invalidMeta]), /overlap/, field);
		await assert.rejects(() => store.create(invalidMeta, 17, { id: 17 }), /overlap/, field);
		await assert.rejects(() => store.bulk.upsertMany(invalidMeta, [{ id: 17, data: { id: 17 } }]), /overlap/, field);
	}
	const unsupported = { ...meta, datastore: { unindexed: ['details[].private.*'] } };
	await assert.rejects(() => store.create(unsupported, 17, { id: 17 }), /recursive wildcard below an array child/);
	assert.equal(ioCalls, 0);
});

test('Datastore read-save and bulk preserve configured exclusions and other writers fields', async () => {
	const data = {
		id: 17,
		body: 'large content',
		details: [{ note: 'first', flag: true }],
		tags: ['one', 'two'],
		private: { email: 'private@example.test', nested: { enabled: true } },
		legacy: { writerVersion: 3, explicitNull: null }
	};
	const saved: any[] = [];
	const store = await createDatastoreStoreAdapter({
		keySymbol,
		keyEncoding: 'native',
		namespace: 'tenant',
		client: datastoreClient({
			get: async () => [{
				...data,
				[keySymbol]: { kind: 'storage_record', id: '17', path: ['storage_record', 17], namespace: 'tenant' }
			}],
			insert: async (entity: any) => { saved.push(entity); },
			update: async (entity: any) => { saved.push(entity); },
			save: async (entities: any[]) => { saved.push(...entities); }
		})
	});
	const row = await store.get(meta, 17);
	await store.update(meta, 17, row);
	await store.create(meta, '17', { ...data, id: '17' });
	await store.bulk.upsertMany(meta, [{ id: 17, data: row }]);
	for (const entity of saved) {
		assert.deepEqual(entity.excludeFromIndexes, exclusions);
		assert.deepEqual(entity.data.legacy, data.legacy);
		assert.equal(entity.key.namespace, 'tenant');
	}
	assert.deepEqual(saved.map((entity) => entity.key.path), [
		['storage_record', 17], ['storage_record', '17'], ['storage_record', 17]
	]);
});

test('Datastore buffered transaction writes retain the configured exclusion policy', async () => {
	const saved: any[] = [];
	const transaction = datastoreClient({
		run: async () => undefined,
		commit: async () => undefined,
		rollback: async () => undefined,
		insert: async (entity: any) => { saved.push(entity); }
	});
	const store = await createDatastoreStoreAdapter({
		keySymbol,
		keyEncoding: 'native',
		client: datastoreClient({ transaction: () => transaction })
	});
	await store.transaction!(async (scoped) => {
		await scoped.create(meta, 18, { id: 18, details: [{ note: 'private' }], legacy: { extra: true } });
	});
	assert.equal(saved.length, 1);
	assert.deepEqual(saved[0].excludeFromIndexes, exclusions);
	assert.deepEqual(saved[0].data.legacy, { extra: true });
});

test('Datastore supported exclusion paths match the SDK protobuf encoding', async () => {
	// Exercise the optional peer itself without a network service or credentials.
	const sdkEntityModule = '@google-cloud/datastore/build/src/entity.js';
	const { entity } = await import(sdkEntityModule);
	const encoded = entity.entityToEntityProto({
		data: {
			id: 17,
			body: 'text',
			details: [{ note: 'private', flag: true }],
			tags: ['a', 'b'],
			private: { email: 'private@example.test', nested: { enabled: true } }
		},
		excludeFromIndexes: exclusions
	});
	assert.equal(encoded.properties.id.excludeFromIndexes, undefined);
	assert.equal(encoded.properties.body.excludeFromIndexes, true);
	const detail = encoded.properties.details.arrayValue.values[0].entityValue.properties;
	assert.equal(detail.note.excludeFromIndexes, true);
	assert.equal(detail.flag.excludeFromIndexes, undefined);
	for (const value of encoded.properties.tags.arrayValue.values) assert.equal(value.excludeFromIndexes, true);
	const privateFields = encoded.properties.private.entityValue.properties;
	assert.equal(privateFields.email.excludeFromIndexes, true);
	assert.equal(privateFields.nested.entityValue.properties.enabled.excludeFromIndexes, true);
});
