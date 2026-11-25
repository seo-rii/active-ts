import test from 'node:test';
import assert from 'node:assert/strict';
import { Datastore } from '@google-cloud/datastore';
import { Model, defineModel, createActiveTs, MemoryCacheAdapter } from '../src/index.js';
import { createDatastoreNamespaceStoreFactory, createDatastoreStoreAdapter } from '../src/adapters/store/datastore-injected.js';

function client(endpoint?: string, port?: number) {
	return {
		options: { projectId: 'shared-project', ...(endpoint ? { apiEndpoint: endpoint } : {}), ...(port ? { port } : {}) },
		KEY: Symbol('key'), getDatabaseId: () => undefined, key: (input: unknown) => input,
		get: async (_input: unknown): Promise<any[]> => [undefined], save: async () => {}, update: async () => {}, delete: async () => {},
		createQuery: () => ({}), runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }]
	};
}

test('Datastore derived scopes isolate endpoints, ports, and unidentified injected clients', async () => {
	const scope = async (raw: object) => (await createDatastoreStoreAdapter({ client: raw })).cacheScope;
	assert.equal(await scope(client('datastore.googleapis.com')), await scope(client('datastore.googleapis.com')));
	assert.notEqual(await scope(client('datastore.googleapis.com')), await scope(client('localhost:8081')));
	assert.notEqual(await scope(client('localhost', 8081)), await scope(client('localhost', 8082)));
	const unknown = client();
	assert.equal(await scope(unknown), await scope(unknown));
	assert.notEqual(await scope(unknown), await scope(client()));
	assert.equal((await createDatastoreStoreAdapter({ client: unknown, cacheScope: 'explicit' })).cacheScope, 'explicit');
});

test('Datastore scope stability distinguishes physical identities from client-local isolation', async () => {
	for (const [endpoint, explicit, expected] of [
		[undefined, undefined, 'client'],
		['datastore.googleapis.com', undefined, 'stable'],
		[undefined, 'verified-physical-backend', 'stable']
	] as const) {
		const raw = client(endpoint);
		const transactional = Object.assign(raw, { transaction: () => ({
			...raw, run: async () => {}, commit: async () => {}, rollback: async () => {}
		}) });
		const store = await createDatastoreStoreAdapter({ client: transactional, cacheScope: explicit });
		assert.equal(store.datastoreCacheScopeStability, expected);
		await store.transaction!(async tx => { assert.equal(tx.datastoreCacheScopeStability, expected); });
		await store.transaction!(async tx => { assert.equal(tx.datastoreCacheScopeStability, expected); }, { readOnly: true });
	}
	const unknown = client();
	const automatic = await createDatastoreNamespaceStoreFactory({ client: unknown });
	assert.equal((await automatic.forNamespace('tenant')).datastoreCacheScopeStability, 'client');
	const explicit = await createDatastoreNamespaceStoreFactory({ client: unknown, cacheScopePrefix: 'verified-backend' });
	assert.equal((await explicit.forNamespace('tenant')).datastoreCacheScopeStability, 'stable');
});

test('Datastore endpoint isolation prevents shared cache reads from another backend', async () => {
	class Row extends Model<{ id: number; label: string }> {}
	defineModel({ name: 'datastore_endpoint_record', cache: { ttl: 60 } }).id('id').attach(Row);
	const cache = new MemoryCacheAdapter();
	const calls: string[] = [];
	async function records(label: string, endpoint: string) {
		const raw = client(endpoint);
		raw.get = async (keys: unknown) => {
			calls.push(label);
			const row = { id: 1, label };
			return [Array.isArray(keys) ? keys.map(() => row) : row];
		};
		const store = await createDatastoreStoreAdapter({ client: raw });
		return Row.use(createActiveTs({ stores: { default: store }, caches: { default: cache } }));
	}
	const production = await records('production', 'datastore.googleapis.com');
	const emulator = await records('emulator', 'localhost:8081');
	assert.equal((await production.find(1).load())!.data.label, 'production');
	assert.equal((await emulator.find(1).load())!.data.label, 'emulator');
	assert.deepEqual(calls, ['production', 'emulator']);
});

test('Datastore snapshots the SDK-resolved emulator endpoint without network I/O', async () => {
	const previous = process.env.DATASTORE_EMULATOR_HOST;
	try {
		delete process.env.DATASTORE_EMULATOR_HOST;
		const production = new Datastore({ projectId: 'endpoint-fixture' });
		process.env.DATASTORE_EMULATOR_HOST = 'localhost:8087';
		const emulator = new Datastore({ projectId: 'endpoint-fixture' });
		delete process.env.DATASTORE_EMULATOR_HOST;
		const left = await createDatastoreStoreAdapter({ client: production, keySymbol: Datastore.KEY });
		const right = await createDatastoreStoreAdapter({ client: emulator, keySymbol: Datastore.KEY });
		assert.notEqual(left.cacheScope, right.cacheScope);
		assert.match(right.cacheScope!, /localhost/);
		assert.match(right.cacheScope!, /8087/);
		assert.equal((await createDatastoreStoreAdapter({ client: emulator, keySymbol: Datastore.KEY })).cacheScope, right.cacheScope);
	} finally {
		if (previous === undefined) delete process.env.DATASTORE_EMULATOR_HOST;
		else process.env.DATASTORE_EMULATOR_HOST = previous;
	}
});

test('Datastore rejects endpoint accessors without invoking them', async () => {
	const raw = client();
	let reads = 0;
	Object.defineProperty(raw.options, 'apiEndpoint', { enumerable: true, get() { reads++; return 'localhost'; } });
	await assert.rejects(createDatastoreStoreAdapter({ client: raw }), /data property/);
	assert.equal(reads, 0);
});
