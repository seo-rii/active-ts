import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreStoreAdapter } from '../src/adapters/store/firestore.js';
import type { ResolvedModelMeta } from '../src/index.js';

const meta: ResolvedModelMeta = { model: class {}, name: 'stable_index', store: 'default', idField: 'key',
 readValidation: 'off', indexes: [{ name: 'by_score', fields: ['score'], directions: ['desc'] }], searchIndexes: [],
 relations: new Map(), hooks: {}, views: new Map(), policies: new Map(), scopes: new Map(), fieldCodecs: new Map(),
 fieldTypes: new Map([['score', 'number']]) };

test('Firestore plans preserve declared ordering and cover the runtime ID tie breaker', async () => {
 const sorts: Array<[string, string]> = [];
 const query = { orderBy(field: string, direction: string) { sorts.push([field, direction]); return this; },
  limit() { return this; }, async get() { return { docs: [] }; } };
 const store = await createFirestoreStoreAdapter({ client: { collection: () => query, getAll: async () => [], runTransaction: async () => {} } });
 await store.query(meta, { where: [], or: [], sort: [{ field: 'score', direction: 'desc' }], limit: 5 });
 const plan = await store.schema!.plan([meta]);
 assert.equal(plan.status, 'manual');
 assert.deepEqual(plan.changes, [
  { type: 'create-index', target: meta.name, name: 'by_score', fields: ['score'], directions: ['desc'], unique: undefined },
  { type: 'create-index', target: meta.name, name: 'by_score_stable_id', fields: ['score', 'key'], directions: ['desc', 'asc'], unique: undefined }
 ]);
 const stable = plan.changes[1];
 assert.equal(stable.type, 'create-index');
 if (stable.type === 'create-index') assert.deepEqual(stable.fields.map((field, i) => [field, stable.directions![i]]), sorts);
});

test('Firestore index variants reuse declared shapes and avoid generated name collisions', async () => {
 const store = await createFirestoreStoreAdapter({ client: { collection() {}, getAll: async () => [], runTransaction: async () => {} } });
 const existing = { name: 'explicit_id', fields: ['score', 'key'], directions: ['desc', 'asc'] as Array<'asc' | 'desc'> };
 const plan = await store.schema!.plan([{ ...meta, indexes: [...meta.indexes, existing] }]);
 assert.equal(plan.changes.length, 2);
 assert.deepEqual(plan.changes.map(change => change.type === 'create-index' ? change.name : ''), ['by_score', 'explicit_id']);
 const collision = await store.schema!.plan([{ ...meta, indexes: [...meta.indexes, { name: 'by_score_stable_id', fields: ['key'], directions: ['desc'] }] }]);
 assert.deepEqual(collision.changes.map(change => change.type === 'create-index' ? change.name : ''), ['by_score', 'by_score_stable_id_2', 'by_score_stable_id']);
 assert.deepEqual(collision.changes[2], { type: 'create-index', target: meta.name, name: 'by_score_stable_id', fields: ['key'], directions: ['desc'], unique: undefined });
});
