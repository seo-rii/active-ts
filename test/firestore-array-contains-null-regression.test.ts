import test from 'node:test';
import assert from 'node:assert/strict';
import { Firestore } from '@google-cloud/firestore';
import { ActiveTsConfigurationError, type ResolvedModelMeta } from '../src/index.js';
import { createFirestoreStoreAdapter } from '../src/adapters/store/firestore.js';

const meta: ResolvedModelMeta = { model: class {}, name: 'firestore_array_contains_null', store: 'default', idField: 'id',
	readValidation: 'off', indexes: [], searchIndexes: [], relations: new Map(), hooks: {}, views: new Map(),
	policies: new Map(), scopes: new Map(), fieldCodecs: new Map(), fieldTypes: new Map() };

test('Firestore rejects arrayContains null before the SDK query builder', async () => {
	// The SDK validates operators locally, so no backend is contacted.
	const sdk = new Firestore({ projectId: 'active-ts-array-contains-null' });
	assert.throws(() => sdk.collection('items').where('tags', 'array-contains', null), /comparisons on Null/);
	let queries = 0;
	const client = {
		collection: (name: string) => { queries++; return sdk.collection(name); },
		getAll: async () => [],
		runTransaction: async (callback: (transaction: unknown) => Promise<unknown>) =>
			callback({ get: async () => ({ docs: [] }), create: () => undefined, set: () => undefined, update: () => undefined, delete: () => undefined })
	};
	const firestore = await createFirestoreStoreAdapter({ client });
	const where = [{ field: 'tags', op: 'arrayContains' as const, value: null }];
	await assert.rejects(firestore.query(meta, { where, or: [], sort: [], include: [] }), ActiveTsConfigurationError);
	await assert.rejects(
		firestore.aggregate!(meta, { where, or: [], aggregates: [{ op: 'count', as: 'count' }] }),
		ActiveTsConfigurationError
	);
	await assert.rejects(
		firestore.transaction!((tx) => tx.query(meta, { where, or: [], sort: [], include: [] })),
		ActiveTsConfigurationError
	);
	assert.equal(queries, 0);
	await sdk.terminate();
});
