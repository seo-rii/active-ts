import test from 'node:test';
import assert from 'node:assert/strict';
import type { ResolvedModelMeta } from '../src/index.js';
import {
	createDatastoreNamespaceStoreFactory,
	createDatastoreStoreAdapter,
	type DatastoreBulkUpsertEntry
} from '../src/adapters/store/datastore.js';

type BulkRow = {
	id: string | number;
	parentId?: number;
	value: string;
};

const rootMeta: ResolvedModelMeta<BulkRow> = {
	model: class {},
	name: 'bulk_record',
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
	datastore: { unindexed: ['value'] }
};

const ancestorMeta: ResolvedModelMeta<BulkRow> = {
	...rootMeta,
	name: 'bulk_child',
	datastore: {
		ancestorFields: ['parentId'],
		unindexed: ['value'],
		ancestor: ({ data }) => data?.parentId === undefined
			? undefined
			: { path: [{ kind: 'bulk_parent', id: data.parentId }] }
	}
};

function queryBuilder() {
	return {
		filter() { return this; },
		order() { return this; },
		limit() { return this; },
		offset() { return this; },
		start() { return this; },
		select() { return this; },
		hasAncestor() { return this; }
	};
}

function datastoreClient(overrides: Record<string, unknown> = {}) {
	return {
		key: (input: { path: Array<string | number>; namespace?: string }) => ({
			path: [...input.path],
			namespace: input.namespace
		}),
		get: async () => [undefined],
		insert: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined,
		createQuery: () => queryBuilder(),
		runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }],
		...overrides
	};
}

test('Datastore bulk upsert snapshots rows, preserves native ids, and applies model unindexed fields', async () => {
	const calls: any[][] = [];
	const client = datastoreClient({
		save: async (entities: any[]) => { calls[calls.length] = entities; }
	});
	const store = await createDatastoreStoreAdapter({ client, keyEncoding: 'native' });
	const first = { id: 1, value: 'one' };
	const entries: DatastoreBulkUpsertEntry[] = [
		{ id: 1, data: first },
		{ id: '1', data: { id: '1', value: 'string-one' } },
		{ id: 2, data: { id: 2, value: 'two' } }
	];

	await store.bulk.upsertMany(rootMeta, entries, { chunkSize: 2 });
	first.value = 'mutated';
	entries[0] = { id: 99, data: { id: 99, value: 'replacement' } };

	assert.equal(Object.isFrozen(store.bulk), true);
	assert.deepEqual(calls.map((batch) => batch.length), [2, 1]);
	assert.deepEqual(calls[0][0], {
		key: { path: ['bulk_record', 1], namespace: undefined },
		data: { id: 1, value: 'one' },
		excludeFromIndexes: ['value']
	});
	assert.deepEqual(calls[0][1].key.path, ['bulk_record', '1']);
});

test('Datastore bulk delete accepts plain ids and independently scoped ancestor entries', async () => {
	const calls: any[][] = [];
	const client = datastoreClient({
		delete: async (keys: any[]) => { calls[calls.length] = keys; },
		save: async () => undefined
	});
	const store = await createDatastoreStoreAdapter({
		client,
		keyEncoding: 'native',
		namespace: 'tenant'
	});

	await store.bulk.deleteMany(rootMeta, [1, '1'], { chunkSize: 1 });
	await store.bulk.deleteMany(ancestorMeta, [
		{
			id: 7,
			options: { meta: { datastoreAncestor: { path: [{ kind: 'bulk_parent', id: 10 }] } } }
		},
		{
			id: 7,
			options: { meta: { datastoreAncestor: { path: [{ kind: 'bulk_parent', id: 11 }] } } }
		}
	]);

	assert.deepEqual(calls[0][0], { path: ['bulk_record', 1], namespace: 'tenant' });
	assert.deepEqual(calls[1][0], { path: ['bulk_record', '1'], namespace: 'tenant' });
	assert.deepEqual(calls[2].map((key) => key.path), [
		['bulk_parent', 10, 'bulk_child', 7],
		['bulk_parent', 11, 'bulk_child', 7]
	]);
	assert.deepEqual(calls[2].map((key) => key.namespace), ['tenant', 'tenant']);
});

test('Datastore bulk mutations use one native transaction in atomic mode', async () => {
	const events: string[] = [];
	const transaction = datastoreClient({
		run: async () => { events[events.length] = 'run'; },
		commit: async () => { events[events.length] = 'commit'; },
		rollback: async () => { events[events.length] = 'rollback'; },
		upsert: async (entities: any[]) => { events[events.length] = `upsert:${entities.length}`; },
		delete: async (keys: any[]) => { events[events.length] = `delete:${keys.length}`; }
	});
	const client = datastoreClient({
		transaction: () => transaction,
		save: async () => { events[events.length] = 'root-upsert'; }
	});
	const store = await createDatastoreStoreAdapter({ client, keyEncoding: 'native' });

	await store.bulk.upsertMany(rootMeta, [
		{ id: 1, data: { id: 1, value: 'one' } },
		{ id: 2, data: { id: 2, value: 'two' } }
	], { atomic: true });
	await store.bulk.deleteMany(rootMeta, [1, 2], { atomic: true });

	assert.deepEqual(events, ['run', 'upsert:2', 'commit', 'run', 'delete:2', 'commit']);
});

test('Datastore atomic bulk mutation rolls back enqueue failures but not uncertain commit failures', async () => {
	const enqueueEvents: string[] = [];
	const enqueueTransaction = datastoreClient({
		run: async () => { enqueueEvents[enqueueEvents.length] = 'run'; },
		commit: async () => { enqueueEvents[enqueueEvents.length] = 'commit'; },
		rollback: async () => { enqueueEvents[enqueueEvents.length] = 'rollback'; },
		upsert: async () => {
			enqueueEvents[enqueueEvents.length] = 'upsert';
			throw new Error('enqueue failed');
		}
	});
	const enqueueStore = await createDatastoreStoreAdapter({
		client: datastoreClient({ transaction: () => enqueueTransaction, save: async () => undefined })
	});
	await assert.rejects(
		() => enqueueStore.bulk.upsertMany(rootMeta, [{ id: 1, data: { id: 1, value: 'one' } }], { atomic: true }),
		/enqueue failed/
	);
	assert.deepEqual(enqueueEvents, ['run', 'upsert', 'rollback']);

	const commitEvents: string[] = [];
	const commitTransaction = datastoreClient({
		run: async () => { commitEvents[commitEvents.length] = 'run'; },
		commit: async () => {
			commitEvents[commitEvents.length] = 'commit';
			throw new Error('commit uncertain');
		},
		rollback: async () => { commitEvents[commitEvents.length] = 'rollback'; },
		upsert: async () => { commitEvents[commitEvents.length] = 'upsert'; }
	});
	const commitStore = await createDatastoreStoreAdapter({
		client: datastoreClient({ transaction: () => commitTransaction, save: async () => undefined })
	});
	await assert.rejects(
		() => commitStore.bulk.upsertMany(rootMeta, [{ id: 1, data: { id: 1, value: 'one' } }], { atomic: true }),
		/commit uncertain/
	);
	assert.deepEqual(commitEvents, ['run', 'upsert', 'commit']);
});

test('Datastore bulk mutations reject ambiguous keys and invalid options before SDK calls', async () => {
	let writes = 0;
	const store = await createDatastoreStoreAdapter({
		client: datastoreClient({
			save: async () => { writes++; },
			delete: async () => { writes++; }
		})
	});

	await assert.rejects(
		() => store.bulk.upsertMany(rootMeta, [
			{ id: 1, data: { id: 1, value: 'one' } },
			{ id: 1, data: { id: 1, value: 'duplicate' } }
		]),
		/same Datastore key/
	);
	await assert.rejects(
		() => store.bulk.deleteMany(rootMeta, [1, 1]),
		/same Datastore key/
	);
	await assert.rejects(
		() => store.bulk.deleteMany(ancestorMeta, [1]),
		/ancestor-aware query/
	);
	await assert.rejects(
		() => store.bulk.upsertMany(rootMeta, [{ id: 1, data: { id: 1, value: 'one' } }], {
			atomic: true,
			chunkSize: 1
		}),
		/cannot combine atomic with chunkSize/
	);
	await assert.rejects(
		() => store.bulk.upsertMany(rootMeta, [{
			id: 1,
			data: { id: 1, value: 'one' },
			options: { expectedVersion: 1 }
		}]),
		/does not support expectedVersion/
	);
	await assert.rejects(
		() => store.bulk.upsertMany(rootMeta, [{ id: 1, data: { id: 1, value: 'one' } }], { atomic: true }),
		/requires Datastore transaction support/
	);
	assert.equal(writes, 0);
});

test('Datastore bulk input accessors are rejected without evaluation', async () => {
	let accessorCalls = 0;
	let writes = 0;
	const entry = Object.create(null) as Record<string, unknown>;
	Object.defineProperty(entry, 'id', {
		enumerable: true,
		get() {
			accessorCalls++;
			return 1;
		}
	});
	Object.defineProperty(entry, 'data', {
		enumerable: true,
		value: { id: 1, value: 'one' }
	});
	const store = await createDatastoreStoreAdapter({
		client: datastoreClient({ save: async () => { writes++; } })
	});

	await assert.rejects(
		() => store.bulk.upsertMany(rootMeta, [entry as any]),
		/must be a data property/
	);
	assert.equal(accessorCalls, 0);
	assert.equal(writes, 0);
});

test('Datastore namespace stores expose bulk writes through one shared client', async () => {
	const namespaces: Array<string | undefined> = [];
	const client = datastoreClient({
		save: async (entities: any[]) => {
			for (let index = 0; index < entities.length; index++) {
				namespaces[namespaces.length] = entities[index].key.namespace;
			}
		}
	});
	const factory = await createDatastoreNamespaceStoreFactory({ client, keyEncoding: 'native' });
	const alpha = await factory.forNamespace('alpha');
	const beta = await factory.forNamespace('beta');

	await alpha.bulk.upsertMany(rootMeta, [{ id: 1, data: { id: 1, value: 'alpha' } }]);
	await beta.bulk.upsertMany(rootMeta, [{ id: 1, data: { id: 1, value: 'beta' } }]);

	assert.deepEqual(namespaces, ['alpha', 'beta']);
});
