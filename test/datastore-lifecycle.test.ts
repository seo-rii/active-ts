import test from 'node:test';
import assert from 'node:assert/strict';
import {
	createDatastoreNamespaceStoreFactory,
	createDatastoreStoreAdapter
} from '../src/adapters/store/datastore-runtime.js';

const projectId = 'active-ts-lifecycle-test';
// A localhost endpoint makes the SDK use insecure channel credentials, so
// constructing and closing GAPIC clients needs neither auth nor network.
const datastoreOptions = { projectId, apiEndpoint: 'localhost:1' };

async function loadSdk(t: { skip(message: string): void }) {
	try {
		return await import('@google-cloud/datastore');
	} catch (error) {
		if ((error as { code?: string }).code !== 'ERR_MODULE_NOT_FOUND') throw error;
		t.skip('Optional Datastore SDK is not installed.');
		return undefined;
	}
}

/** An SDK loader whose Datastore class records the instances the adapter constructs. */
function recordingLoader(sdk: any) {
	const instances: any[] = [];
	class RecordingDatastore extends sdk.Datastore {
		constructor(options: Record<string, unknown>) {
			super(options);
			instances.push(this);
		}
	}
	return { instances, load: async () => ({ Datastore: RecordingDatastore }) };
}

/** A minimal caller-owned client whose SDK client cache must never be read. */
function injectedClient(keySymbol: symbol) {
	const client = {
		KEY: keySymbol,
		key: () => ({}),
		int: (value: unknown) => value,
		get: async () => [[]],
		save: async () => undefined,
		insert: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined,
		createQuery: () => ({}),
		runQuery: async () => [[]],
		createAggregationQuery: () => ({}),
		runAggregationQuery: async () => [[]]
	};
	Object.defineProperty(client, 'clients_', { get() { throw new Error('Caller-owned clients were inspected'); } });
	return client;
}

function countingGapic(fail?: (attempt: number) => unknown) {
	const gapic = {
		attempts: 0,
		async close() {
			gapic.attempts++;
			const failure = fail?.(gapic.attempts);
			if (failure !== undefined) throw failure;
		}
	};
	return gapic;
}

test('Datastore close does not inspect an injected client', async () => {
	const keySymbol = Symbol('injected-datastore-key');
	const store = await createDatastoreStoreAdapter({
		client: injectedClient(keySymbol), keySymbol, cacheScope: 'datastore-lifecycle-injected'
	});
	assert.equal(typeof store.close, 'function');
	await Promise.all([store.close!(), store.close!()]);
});

test('Datastore close shuts down the GAPIC clients of a client the adapter created', async t => {
	const sdk = await loadSdk(t);
	if (!sdk) return;
	const { instances, load } = recordingLoader(sdk);
	const store = await createDatastoreStoreAdapter({ datastoreOptions }, load);
	assert.equal(instances.length, 1);
	const datastore = instances[0];
	// The SDK creates one GAPIC client per service on first use and caches it here.
	const gapic = new sdk.v1.DatastoreClient(datastore.options);
	await gapic.initialize();
	datastore.clients_.set('DatastoreClient', gapic);

	await Promise.all([store.close!(), store.close!()]);
	await assert.rejects(gapic.lookup({ projectId, keys: [] }), /closed/);
	// The cache is kept, so the SDK reuses the closed client and fails fast
	// instead of silently opening a new channel.
	assert.equal(datastore.clients_.get('DatastoreClient'), gapic);
	await assert.rejects(datastore.get(datastore.key(['active_ts_lifecycle', 1])), /closed/);
	await store.close!();
});

test('Datastore close shares concurrent attempts and can be retried after a failure', async t => {
	const sdk = await loadSdk(t);
	if (!sdk) return;
	const { instances, load } = recordingLoader(sdk);
	const store = await createDatastoreStoreAdapter({ datastoreOptions }, load);
	const failure = new Error('Temporary channel close failure');
	const flaky = countingGapic(attempt => attempt === 1 ? failure : undefined);
	const steady = countingGapic();
	instances[0].clients_.set('DatastoreClient', flaky);
	instances[0].clients_.set('DatastoreAdminClient', steady);

	// StoreAdapter.close is typed MaybePromise<void>; the owned closer is async.
	const first = Promise.resolve(store.close!());
	const second = Promise.resolve(store.close!());
	await assert.rejects(first, error => error === failure);
	await assert.rejects(second, error => error === failure);
	assert.equal(flaky.attempts, 1);
	assert.equal(steady.attempts, 1, 'other clients still close when one fails');

	await store.close!();
	await store.close!();
	assert.equal(flaky.attempts, 2);
	assert.equal(steady.attempts, 2);
});

test('Datastore close reports every failing GAPIC client', async t => {
	const sdk = await loadSdk(t);
	if (!sdk) return;
	const { instances, load } = recordingLoader(sdk);
	const store = await createDatastoreStoreAdapter({ datastoreOptions }, load);
	const one = new Error('first'), two = new Error('second');
	instances[0].clients_.set('DatastoreClient', countingGapic(() => one));
	instances[0].clients_.set('DatastoreAdminClient', countingGapic(() => two));
	await assert.rejects(Promise.resolve(store.close!()), (error: unknown) =>
		error instanceof AggregateError && error.errors.length === 2 && error.errors.includes(one) && error.errors.includes(two));
});

test('Datastore namespace factories own their client; namespace adapters do not', async t => {
	const sdk = await loadSdk(t);
	if (!sdk) return;
	const { instances, load } = recordingLoader(sdk);
	const factory = await createDatastoreNamespaceStoreFactory({ datastoreOptions: { ...datastoreOptions } }, load);
	assert.ok(Object.isFrozen(factory));
	const tenantA = await factory.forNamespace('tenant_a');
	const tenantB = await factory.forNamespace('tenant_b');
	assert.equal(instances.length, 1, 'namespace adapters share the factory client');
	const gapic = countingGapic();
	instances[0].clients_.set('DatastoreClient', gapic);

	await tenantA.close!();
	await tenantB.close!();
	assert.equal(gapic.attempts, 0, 'a namespace adapter does not close the shared client');
	await Promise.all([factory.close(), factory.close()]);
	assert.equal(gapic.attempts, 1);
	await factory.close();
	assert.equal(gapic.attempts, 1, 'a successful close is idempotent');
});

test('Datastore namespace factory close leaves an injected client alone', async () => {
	const keySymbol = Symbol('injected-factory-key');
	const factory = await createDatastoreNamespaceStoreFactory({
		client: injectedClient(keySymbol), keySymbol, cacheScopePrefix: 'datastore-lifecycle-factory'
	});
	await factory.close();
	const store = await factory.forNamespace('tenant_a');
	await store.close!();
});
