import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createAdapterCloser } from '../src/core/adapter-lifecycle.js';
import { createPostgresStoreAdapter } from '../src/adapters/store/postgresql.js';
import { createMongoStoreAdapter } from '../src/adapters/store/mongodb.js';
import { createRedisValkeyCacheAdapter } from '../src/adapters/cache/redis-valkey.js';

async function optionalSdk(name: string, t: TestContext): Promise<any> {
	try { return await import(name); }
	catch (error) {
		if ((error as { code?: string }).code !== 'ERR_MODULE_NOT_FOUND') throw error;
		t.skip(`Optional ${name} SDK is not installed.`);
	}
}

function replaceMethod(target: object, name: string, value: (...args: any[]) => any) {
	const descriptor = Object.getOwnPropertyDescriptor(target, name);
	Object.defineProperty(target, name, { value, configurable: true, writable: true });
	return () => {
		if (descriptor) Object.defineProperty(target, name, descriptor);
		else Reflect.deleteProperty(target, name);
	};
}

test('owned close shares concurrent attempts and retries after failure', async () => {
	let attempts = 0;
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	const failure = new Error('close failed');
	const close = createAdapterCloser(async () => {
		attempts++;
		if (attempts === 1) { await gate; throw failure; }
	});
	const first = close();
	const second = close();
	release();
	await assert.rejects(first, error => error === failure);
	await assert.rejects(second, error => error === failure);
	assert.equal(attempts, 1);
	await Promise.all([close(), close()]);
	await close();
	assert.equal(attempts, 2);
});

test('adapter close leaves injected clients and pools caller-owned', async () => {
	const cannotClose = () => { throw new Error('Injected close must not be inspected.'); };
	const pool = { query: async () => ({ rows: [] }) };
	const mongo = { db: () => ({ collection: () => ({}) }) };
	const redis = { mGet: async () => [], mSet: async () => 'OK', multi: () => ({}), del: async () => 0 };
	for (const client of [pool, mongo, redis]) {
		Object.defineProperty(client, 'close', { get: cannotClose });
		Object.defineProperty(client, 'end', { get: cannotClose });
		Object.defineProperty(client, 'quit', { get: cannotClose });
	}
	const adapters = [
		await createPostgresStoreAdapter({ pool }),
		await createMongoStoreAdapter({ client: mongo, dbName: 'owned_lifecycle' }),
		await createRedisValkeyCacheAdapter({ client: redis })
	];
	for (const adapter of adapters) {
		assert.equal(typeof adapter.close, 'function');
		await Promise.all([adapter.close!(), adapter.close!()]);
	}
});

test('PostgreSQL factory closes its internally created pool once', async t => {
	const sdk = await optionalSdk('pg', t);
	if (!sdk) return;
	let calls = 0;
	const restore = replaceMethod(sdk.Pool.prototype, 'end', async () => { calls++; });
	try {
		const adapter = await createPostgresStoreAdapter({});
		await Promise.all([adapter.close!(), adapter.close!()]);
		assert.equal(calls, 1);
	} finally { restore(); }
});

test('MongoDB factory closes its internally created client once', async t => {
	const sdk = await optionalSdk('mongodb', t);
	if (!sdk) return;
	let calls = 0;
	const restoreConnect = replaceMethod(sdk.MongoClient.prototype, 'connect', async function(this: unknown) { return this; });
	const restoreClose = replaceMethod(sdk.MongoClient.prototype, 'close', async () => { calls++; });
	try {
		const adapter = await createMongoStoreAdapter({ dbName: 'owned_lifecycle' });
		await Promise.all([adapter.close!(), adapter.close!()]);
		assert.equal(calls, 1);
	} finally { restoreClose(); restoreConnect(); }
});

test('Redis factory closes its internally created client once', async t => {
	const sdk = await optionalSdk('redis', t);
	if (!sdk) return;
	const probe = sdk.createClient();
	let prototype = Object.getPrototypeOf(probe);
	while (prototype && !Object.prototype.hasOwnProperty.call(prototype, 'close')) prototype = Object.getPrototypeOf(prototype);
	assert.ok(prototype);
	let calls = 0;
	const restoreConnect = replaceMethod(prototype, 'connect', async function(this: unknown) { return this; });
	const restoreClose = replaceMethod(prototype, 'close', async () => { calls++; });
	try {
		const adapter = await createRedisValkeyCacheAdapter();
		await Promise.all([adapter.close!(), adapter.close!()]);
		assert.equal(calls, 1);
	} finally { restoreClose(); restoreConnect(); }
});
