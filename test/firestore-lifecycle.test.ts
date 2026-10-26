import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreStoreAdapter } from '../src/adapters/store/firestore.js';

test('Firestore close does not inspect or terminate an injected client', async () => {
	const client = {
		collection: () => ({}),
		getAll: async () => [],
		runTransaction: async () => undefined
	};
	Object.defineProperty(client, 'terminate', { get() { throw new Error('Caller-owned terminate was inspected'); } });
	const store = await createFirestoreStoreAdapter({ client });
	assert.equal(typeof store.close, 'function');
	await Promise.all([store.close!(), store.close!()]);
});

test('Firestore factory shares close attempts and allows retry after termination failure', async t => {
	let sdk: any;
	try { sdk = await import('@google-cloud/firestore'); }
	catch (error) {
		if ((error as { code?: string }).code !== 'ERR_MODULE_NOT_FOUND') throw error;
		t.skip('Optional Firestore SDK is not installed.');
		return;
	}
	const prototype = sdk.Firestore.prototype;
	const original = Object.getOwnPropertyDescriptor(prototype, 'terminate');
	let attempts = 0;
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	const failure = new Error('Temporary termination failure');
	Object.defineProperty(prototype, 'terminate', { configurable: true, writable: true, value: async function () {
		assert.ok(this instanceof sdk.Firestore);
		attempts++;
		if (attempts === 1) { await gate; throw failure; }
	} });
	try {
		// Construction and the stubbed terminate method perform no network calls.
		const store = await createFirestoreStoreAdapter({ firestoreOptions: { projectId: 'active-ts-lifecycle-test' } });
		const first = store.close!();
		const second = store.close!();
		release();
		await assert.rejects(first, error => error === failure);
		await assert.rejects(second, error => error === failure);
		assert.equal(attempts, 1);
		await Promise.all([store.close!(), store.close!()]);
		await store.close!();
		assert.equal(attempts, 2);
	} finally {
		if (original) Object.defineProperty(prototype, 'terminate', original);
		else Reflect.deleteProperty(prototype, 'terminate');
	}
});
