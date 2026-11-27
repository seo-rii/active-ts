import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreStoreAdapter } from '../src/adapters/store/firestore.js';
import { createActiveTs, defineModel, Model } from '../src/index.js';

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
		// StoreAdapter.close is typed MaybePromise<void> on main; the owned closer is async.
		const first = Promise.resolve(store.close!());
		const second = Promise.resolve(store.close!());
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

test('Firestore rejects operations after closing an owned client instead of leaving reads pending', async t => {
	let sdk: any;
	try { sdk = await import('@google-cloud/firestore'); }
	catch (error) {
		if ((error as { code?: string }).code !== 'ERR_MODULE_NOT_FOUND') throw error;
		t.skip('Optional Firestore SDK is not installed.');
		return;
	}
	const prototype = sdk.Firestore.prototype;
	const original = Object.getOwnPropertyDescriptor(prototype, 'terminate');
	Object.defineProperty(prototype, 'terminate', { configurable: true, writable: true, value: async () => {} });
	try {
		const store = await createFirestoreStoreAdapter({ firestoreOptions: { projectId: 'active-ts-lifecycle-test' } });
		class ClosedRecord extends Model<{ id: number }> {}
		defineModel('firestore_closed_record').id('id').attach(ClosedRecord);
		const context = createActiveTs({ stores: { default: store } });
		const meta = context.meta(ClosedRecord);
		await Promise.resolve(store.close!());
		const closed = /Firestore store \w+ cannot run after close\(\)/;
		await assert.rejects(store.get(meta, 1), closed);
		await assert.rejects(store.getMany(meta, [1, 2]), closed);
		await assert.rejects(store.query(meta, { where: [], or: [], sort: [], include: [] }), closed);
		await assert.rejects(store.create(meta, 1, { id: 1 }), closed);
		await assert.rejects(store.update(meta, 1, { id: 1 }), closed);
		await assert.rejects(store.delete(meta, 1), closed);
		await assert.rejects(store.transaction!(async () => undefined), closed);
	} finally {
		if (original) Object.defineProperty(prototype, 'terminate', original);
		else Reflect.deleteProperty(prototype, 'terminate');
	}
});

test('Firestore close of an injected client leaves the adapter usable', async () => {
	let gets = 0;
	const snapshot = { exists: false, id: '1', data: () => undefined };
	const client = {
		collection: () => ({ doc: () => ({ get: async () => { gets++; return snapshot; } }) }),
		getAll: async (...refs: unknown[]) => { gets++; return refs.map(() => snapshot); },
		runTransaction: async () => undefined
	};
	const store = await createFirestoreStoreAdapter({ client });
	class InjectedRecord extends Model<{ id: number }> {}
	defineModel('firestore_injected_close_record').id('id').attach(InjectedRecord);
	const context = createActiveTs({ stores: { default: store } });
	await Promise.resolve(store.close!());
	await store.getMany(context.meta(InjectedRecord), [1]).catch(() => undefined);
	assert.ok(gets > 0, 'the caller-owned client still receives reads after a no-op close');
});
