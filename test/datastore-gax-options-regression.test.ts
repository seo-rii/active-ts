import test from 'node:test';
import assert from 'node:assert/strict';
import { ActiveTsConfigurationError, createActiveTs, type ResolvedModelMeta } from '../src/index.js';
import {
	createDatastoreNamespaceStoreFactory,
	createDatastoreStoreAdapter,
	type DatastoreRpcOperation
} from '../src/adapters/store/datastore.js';

type Row = { id: number; title: string };

const meta: ResolvedModelMeta<Row> = {
	model: class {},
	name: 'datastore_gax_options_note',
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
	fieldTypes: new Map([['title', 'string']])
};

// A class instance, as a transport's cancellation parent is: it must reach the
// SDK by identity, not as a copy.
class CallScope {
	constructor(readonly operation: DatastoreRpcOperation) {}
}

type Recorded = { method: string; args: unknown[] };

function recordingDatastore() {
	const calls: Recorded[] = [];
	const record = (method: string) => async (...args: unknown[]) => {
		calls.push({ method, args });
		if (method === 'get') return Array.isArray(args[0]) ? [[]] : [undefined];
		if (method === 'runQuery') return [[], { moreResults: 'NO_MORE_RESULTS' }];
		if (method === 'runAggregationQuery') return [[{ count: 0 }]];
		return undefined;
	};
	const query: Record<string, unknown> = {};
	for (const name of ['hasAncestor', 'filter', 'order', 'limit', 'select', 'offset', 'start']) query[name] = () => query;
	const aggregation: Record<string, unknown> = { count: () => aggregation, sum: () => aggregation, average: () => aggregation };
	const client = {
		KEY: Symbol('recording-key'),
		key: (input: unknown) => input,
		get: record('get'),
		insert: record('insert'),
		update: record('update'),
		upsert: record('upsert'),
		save: record('save'),
		delete: record('delete'),
		createQuery: () => query,
		runQuery: record('runQuery'),
		createAggregationQuery: () => aggregation,
		runAggregationQuery: record('runAggregationQuery'),
		transaction: () => ({
			run: record('tx.run'),
			get: async (...args: unknown[]) => {
				calls.push({ method: 'tx.get', args });
				return [{ id: 1, title: 'stored' }];
			},
			runQuery: record('tx.runQuery'),
			insert: record('tx.insert'),
			update: record('tx.update'),
			upsert: record('tx.upsert'),
			delete: record('tx.delete'),
			commit: record('tx.commit'),
			rollback: record('tx.rollback')
		})
	};
	return { client, calls };
}

const gaxOf = (call: Recorded | undefined) => {
	const options = call?.args.find((arg) => arg && typeof arg === 'object' && 'gaxOptions' in arg) as
		| { gaxOptions?: unknown }
		| undefined;
	return options?.gaxOptions;
};

test('Datastore passes provider gaxOptions to every read RPC by identity', async () => {
	const { client, calls } = recordingDatastore();
	const provided: DatastoreRpcOperation[] = [];
	const store = await createDatastoreStoreAdapter({
		client,
		gaxOptions: ({ operation }) => {
			provided.push(operation);
			return new CallScope(operation) as unknown as Record<string, unknown>;
		}
	});
	await store.get(meta, 1);
	await store.getMany(meta, [1, 2]);
	await store.query(meta, { where: [{ field: 'title', op: '=', value: 'x' }], or: [], sort: [], include: [] });
	await store.aggregate!(meta, { where: [], or: [], aggregates: [{ op: 'count', as: 'count' }] });
	assert.deepEqual(provided, ['lookup', 'lookup', 'runQuery', 'runAggregationQuery']);
	assert.deepEqual(calls.map((call) => call.method), ['get', 'get', 'runQuery', 'runAggregationQuery']);
	for (const [index, call] of calls.entries()) {
		const gax = gaxOf(call);
		assert.ok(gax instanceof CallScope, call.method);
		assert.equal((gax as CallScope).operation, provided[index]);
	}
});

test('Datastore writes carry provider gaxOptions through save() and delete()', async () => {
	const { client, calls } = recordingDatastore();
	const store = await createDatastoreStoreAdapter({ client, gaxOptions: ({ operation }) => ({ operation, timeout: 1234 }) });
	await store.create(meta, 1, { id: 1, title: 'a' });
	await store.update(meta, 1, { id: 1, title: 'b' });
	await store.delete(meta, 1);
	await store.bulk!.upsertMany(meta, [{ id: 2, data: { id: 2, title: 'c' } }]);
	await store.bulk!.deleteMany(meta, [2]);
	assert.deepEqual(calls.map((call) => call.method), ['save', 'save', 'delete', 'save', 'delete']);
	const [create, update, remove, upsert, bulkDelete] = calls;
	assert.equal((create.args[0] as { method?: string }).method, 'insert');
	assert.equal((update.args[0] as { method?: string }).method, 'update');
	assert.ok(Array.isArray(upsert.args[0]) && (upsert.args[0] as Array<{ method?: string }>)[0].method === undefined);
	for (const call of [create, update, remove, upsert, bulkDelete]) {
		assert.deepEqual(call.args[1], { operation: 'commit', timeout: 1234 }, call.method);
	}
});

test('Datastore transactions merge provider options under explicit native options', async () => {
	const { client, calls } = recordingDatastore();
	const store = await createDatastoreStoreAdapter({
		client,
		gaxOptions: ({ operation }) => ({ operation, timeout: 50 })
	});
	await store.transaction!(async (tx) => {
		await tx.update(meta, 1, { id: 1, title: 'changed' });
	}, { native: { commitGaxOptions: { timeout: 999 } } } as never);
	await assert.rejects(() => store.transaction!(async (tx) => {
		await tx.get(meta, 1);
		throw new Error('roll back');
	}), /roll back/);
	const byMethod = (method: string) => calls.filter((call) => call.method === method);
	assert.deepEqual(byMethod('tx.run').map((call) => call.args[0]), [
		{ gaxOptions: { operation: 'beginTransaction', timeout: 50 } },
		{ gaxOptions: { operation: 'beginTransaction', timeout: 50 } }
	]);
	assert.deepEqual(byMethod('tx.get').map(gaxOf), [
		{ operation: 'lookup', timeout: 50 },
		{ operation: 'lookup', timeout: 50 }
	]);
	assert.deepEqual(byMethod('tx.commit').map((call) => call.args[0]), [{ operation: 'commit', timeout: 999 }]);
	assert.deepEqual(byMethod('tx.rollback').map((call) => call.args[0]), [{ operation: 'rollback', timeout: 50 }]);
	assert.deepEqual(byMethod('tx.update').map((call) => call.args.length), [1], 'buffered writes take no call options');
});

test('Datastore keeps the original SDK calls when the provider returns undefined', async () => {
	const { client, calls } = recordingDatastore();
	const store = await createDatastoreStoreAdapter({ client, gaxOptions: () => undefined });
	await store.get(meta, 1);
	await store.create(meta, 1, { id: 1, title: 'a' });
	await store.update(meta, 1, { id: 1, title: 'b' });
	await store.delete(meta, 1);
	assert.deepEqual(calls.map((call) => [call.method, call.args.length]), [
		['get', 1], ['insert', 1], ['update', 1], ['delete', 1]
	]);
});

test('Datastore rejects invalid gaxOptions providers and results', async () => {
	await assert.rejects(
		() => createDatastoreStoreAdapter({ client: recordingDatastore().client, gaxOptions: {} as never }),
		/gaxOptions must be a function/
	);
	for (const value of [null, 'timeout', [1]]) {
		const store = await createDatastoreStoreAdapter({
			client: recordingDatastore().client,
			gaxOptions: () => value as never
		});
		await assert.rejects(() => store.get(meta, 1), (error: unknown) =>
			error instanceof ActiveTsConfigurationError && /must return an object or undefined for lookup/.test(error.message));
	}
});

test('Datastore namespace factories and contexts evaluate the provider per call', async () => {
	const { client, calls } = recordingDatastore();
	let current = 'first-request';
	const factory = await createDatastoreNamespaceStoreFactory({
		client,
		gaxOptions: () => ({ request: current })
	});
	const store = await factory.forNamespace('tenant-a');
	const context = createActiveTs({ stores: { default: store } });
	await context.store('default').get(meta, 1);
	current = 'second-request';
	await context.store('default').get(meta, 2);
	assert.deepEqual(calls.map(gaxOf), [{ request: 'first-request' }, { request: 'second-request' }]);
});

test('Datastore treats a provider failure at commit as a failed transaction, not an unknown commit', async () => {
	const { client, calls } = recordingDatastore();
	const failure = new Error('request aborted before commit');
	const store = await createDatastoreStoreAdapter({
		client,
		gaxOptions: ({ operation }) => {
			if (operation === 'commit') throw failure;
			return undefined;
		}
	});
	await assert.rejects(
		() => store.transaction!(async (tx) => { await tx.update(meta, 1, { id: 1, title: 'next' }); }),
		(error: unknown) => error === failure
	);
	assert.ok(!calls.some((call) => call.method === 'tx.commit'), 'Commit never started');
	assert.ok(calls.some((call) => call.method === 'tx.rollback'), 'the transaction is rolled back');
});

test('Datastore atomic bulk mutations pass provider options to begin, commit and rollback', async () => {
	const { client, calls } = recordingDatastore();
	const provided: DatastoreRpcOperation[] = [];
	const scopes = new Map<DatastoreRpcOperation, CallScope>();
	const store = await createDatastoreStoreAdapter({
		client,
		gaxOptions: ({ operation }) => {
			provided.push(operation);
			const scope = new CallScope(operation);
			scopes.set(operation, scope);
			return scope;
		}
	});
	await store.bulk!.upsertMany(meta, [{ id: 2, data: { id: 2, title: 'c' } }], { atomic: true });
	assert.deepEqual(provided, ['beginTransaction', 'commit']);
	assert.equal(gaxOf(calls.find((call) => call.method === 'tx.run')), scopes.get('beginTransaction'));
	assert.equal(calls.find((call) => call.method === 'tx.commit')?.args[0], scopes.get('commit'));

	const failing = recordingDatastore();
	const failingTransaction = failing.client.transaction;
	failing.client.transaction = () => ({ ...failingTransaction(), upsert: async () => { throw new Error('mutation failed'); } });
	const rollbackScopes: unknown[] = [];
	const failingStore = await createDatastoreStoreAdapter({
		client: failing.client,
		gaxOptions: ({ operation }) => {
			const scope = new CallScope(operation);
			if (operation === 'rollback') rollbackScopes.push(scope);
			return scope;
		}
	});
	await assert.rejects(() => failingStore.bulk!.deleteMany(meta, [2], { atomic: true }).then(() =>
		failingStore.bulk!.upsertMany(meta, [{ id: 3, data: { id: 3, title: 'd' } }], { atomic: true })), /mutation failed/);
	assert.equal(failing.calls.find((call) => call.method === 'tx.rollback')?.args[0], rollbackScopes[0]);
});

test('Datastore reads an upsert-capable client save() only when a write needs it', async () => {
	const { client } = recordingDatastore();
	const lazy = { ...client } as Record<string, unknown>;
	delete lazy.save;
	let saveReads = 0;
	Object.defineProperty(lazy, 'save', { enumerable: true, get() { saveReads++; throw new Error('save is not available'); } });
	const store = await createDatastoreStoreAdapter({ client: lazy as typeof client });
	assert.equal(saveReads, 0, 'construction does not read save()');
	await store.create(meta, 1, { id: 1, title: 'a' });
	await store.bulk!.upsertMany(meta, [{ id: 2, data: { id: 2, title: 'b' } }]);
	assert.equal(saveReads, 0, 'writes without a provider use insert() and upsert()');
});

// The SDK's CallOptions is an interface without an index signature.
interface CallOptionsLike { timeout?: number; retry?: { retryCodes?: number[] } }
const typedProvider: Parameters<typeof createDatastoreStoreAdapter>[0] extends infer Options
	? Options extends { gaxOptions?: infer Provider } ? Provider : never : never = (): CallOptionsLike => ({ timeout: 1 });
void typedProvider;
