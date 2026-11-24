import test from 'node:test';
import assert from 'node:assert/strict';
import {
	ActiveTsConflictError,
	ActiveTsNotFoundError,
	Model,
	createActiveTs,
	defineModel,
	type ResolvedModelMeta
} from '../src/index.js';
import { createDatastoreStoreAdapter } from '../src/adapters/store/datastore.js';

type LockedData = { id: number; title: string; version: number };

class LockedNote extends Model<LockedData> {}

defineModel<LockedData>('datastore_optimistic_note')
	.id('id')
	.validate((input) => input as LockedData)
	.attach(LockedNote);

const meta: ResolvedModelMeta<LockedData> = {
	model: class {},
	name: 'datastore_optimistic_note',
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
	fieldTypes: new Map()
};

const keyId = (key: unknown) => JSON.stringify((key as { path: unknown }).path);
const clone = <T>(value: T): T => (value === undefined ? value : structuredClone(value));

// A small serializable Datastore: a transaction commit aborts when any entity it
// read changed after that read, as an optimistic Datastore transaction does.
function fakeDatastore({ transactions = true } = {}) {
	const rows = new Map<string, Record<string, unknown>>();
	const calls: string[] = [];
	let beforeCommit: (() => void) | undefined;
	const write = (operation: string, entity: { key: unknown; data: Record<string, unknown> }) => {
		const key = keyId(entity.key);
		if (operation === 'insert' && rows.has(key)) throw Object.assign(new Error('already exists'), { code: 6 });
		if (operation === 'update' && !rows.has(key)) throw Object.assign(new Error('not found'), { code: 5 });
		rows.set(key, clone(entity.data));
	};
	const client: Record<string, unknown> = {
		KEY: Symbol('fake-datastore-key'),
		key: (input: unknown) => input,
		get: async (key: unknown) => {
			calls.push('get');
			// The SDK returns only found entities for a key list.
			if (Array.isArray(key)) return [key.map((item) => clone(rows.get(keyId(item)))).filter(Boolean)];
			return [clone(rows.get(keyId(key)))];
		},
		insert: async (entity: { key: unknown; data: Record<string, unknown> }) => {
			calls.push('insert');
			write('insert', entity);
		},
		update: async (entity: { key: unknown; data: Record<string, unknown> }) => {
			calls.push('update');
			write('update', entity);
		},
		save: async () => {
			throw new Error('save is not used by these writes');
		},
		delete: async (key: unknown) => {
			calls.push('delete');
			rows.delete(keyId(key));
		},
		createQuery: () => ({}),
		runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }]
	};
	if (transactions) {
		client.transaction = () => {
			const reads = new Map<string, string>();
			const writes: Array<() => void> = [];
			return {
				run: async () => {
					calls.push('tx.run');
				},
				get: async (key: unknown) => {
					calls.push('tx.get');
					const read = (item: unknown) => {
						const row = rows.get(keyId(item));
						reads.set(keyId(item), JSON.stringify(row ?? null));
						return clone(row);
					};
					return Array.isArray(key) ? [key.map(read).filter(Boolean)] : [read(key)];
				},
				runQuery: async () => [[], { moreResults: 'NO_MORE_RESULTS' }],
				insert: (entity: { key: unknown; data: Record<string, unknown> }) => {
					writes.push(() => write('insert', entity));
				},
				update: (entity: { key: unknown; data: Record<string, unknown> }) => {
					writes.push(() => write('update', entity));
				},
				delete: (key: unknown) => {
					writes.push(() => rows.delete(keyId(key)));
				},
				commit: async () => {
					calls.push('tx.commit');
					const hook = beforeCommit;
					beforeCommit = undefined;
					hook?.();
					for (const [key, snapshot] of reads) {
						if (JSON.stringify(rows.get(key) ?? null) !== snapshot) {
							throw Object.assign(new Error('transaction aborted by a concurrent write'), { code: 10 });
						}
					}
					for (const apply of writes) apply();
				},
				rollback: async () => {
					calls.push('tx.rollback');
				}
			};
		};
	}
	return {
		client,
		rows,
		calls,
		row: (id: number) => rows.get(JSON.stringify([meta.name, `number:${id}`])),
		concurrentlyBeforeCommit(change: () => void) {
			beforeCommit = change;
		}
	};
}

test('Datastore advertises atomic optimistic locking only with transactions', async () => {
	const withTransactions = await createDatastoreStoreAdapter({ client: fakeDatastore().client });
	const withoutTransactions = await createDatastoreStoreAdapter({ client: fakeDatastore({ transactions: false }).client });
	assert.equal(withTransactions.capabilities?.optimisticLock, true);
	assert.equal(withoutTransactions.capabilities?.optimisticLock, false);
	await assert.rejects(
		() => withoutTransactions.update(meta, 1, { id: 1, title: 'x', version: 2 }, { expectedVersion: 1 }),
		/does not support expectedVersion without client\.transaction\(\)/
	);
});

test('Datastore version-checked writes outside a transaction read and write in one transaction', async () => {
	const fake = fakeDatastore();
	const store = await createDatastoreStoreAdapter({ client: fake.client });
	await store.create(meta, 1, { id: 1, title: 'first', version: 1 });
	fake.calls.length = 0;

	await store.update(meta, 1, { id: 1, title: 'second', version: 2 }, { expectedVersion: 1 });
	assert.deepEqual(fake.row(1), { id: 1, title: 'second', version: 2 });
	assert.deepEqual(fake.calls, ['tx.run', 'tx.get', 'tx.commit']);

	fake.calls.length = 0;
	await assert.rejects(
		() => store.update(meta, 1, { id: 1, title: 'stale', version: 2 }, { expectedVersion: 1 }),
		(error: unknown) => error instanceof ActiveTsConflictError && /Expected version 1/.test(error.message)
	);
	assert.deepEqual(fake.row(1), { id: 1, title: 'second', version: 2 });
	assert.deepEqual(fake.calls, ['tx.run', 'tx.get', 'tx.rollback']);

	await assert.rejects(
		() => store.update(meta, 404, { id: 404, title: 'missing', version: 2 }, { expectedVersion: 1 }),
		ActiveTsNotFoundError
	);
	await assert.rejects(() => store.delete(meta, 404, { expectedVersion: 1 }), ActiveTsNotFoundError);
	await assert.rejects(() => store.delete(meta, 1, { expectedVersion: 1 }), ActiveTsConflictError);
	assert.ok(fake.row(1));
	await store.delete(meta, 1, { expectedVersion: 2 });
	assert.equal(fake.row(1), undefined);
});

test('Datastore reports a concurrent write between the version read and commit as a conflict', async () => {
	const fake = fakeDatastore();
	const store = await createDatastoreStoreAdapter({ client: fake.client });
	await store.create(meta, 1, { id: 1, title: 'first', version: 1 });
	fake.concurrentlyBeforeCommit(() => {
		fake.rows.set(JSON.stringify([meta.name, 'number:1']), { id: 1, title: 'other writer', version: 2 });
	});
	await assert.rejects(
		() => store.update(meta, 1, { id: 1, title: 'mine', version: 2 }, { expectedVersion: 1 }),
		ActiveTsConflictError
	);
	assert.deepEqual(fake.row(1), { id: 1, title: 'other writer', version: 2 });
});

test('Datastore transactions compare versions against their own reads and buffered writes', async () => {
	const fake = fakeDatastore();
	const store = await createDatastoreStoreAdapter({ client: fake.client });
	await store.create(meta, 1, { id: 1, title: 'first', version: 1 });
	await store.create(meta, 2, { id: 2, title: 'second', version: 1 });

	await store.transaction!(async (tx) => {
		assert.equal(tx.capabilities?.optimisticLock, true);
		await tx.update(meta, 1, { id: 1, title: 'one', version: 2 }, { expectedVersion: 1 });
		await tx.update(meta, 1, { id: 1, title: 'two', version: 3 }, { expectedVersion: 2 });
		await tx.delete(meta, 2, { expectedVersion: 1 });
	});
	assert.deepEqual(fake.row(1), { id: 1, title: 'two', version: 3 });
	assert.equal(fake.row(2), undefined);

	await assert.rejects(
		() => store.transaction!(async (tx) => {
			await tx.update(meta, 1, { id: 1, title: 'four', version: 4 }, { expectedVersion: 3 });
			await tx.update(meta, 1, { id: 1, title: 'stale', version: 4 }, { expectedVersion: 3 });
		}),
		ActiveTsConflictError
	);
	await assert.rejects(
		() => store.transaction!(async (tx) => {
			await tx.delete(meta, 1, { expectedVersion: 3 });
			await tx.delete(meta, 1, { expectedVersion: 3 });
		}),
		ActiveTsNotFoundError
	);
	assert.deepEqual(fake.row(1), { id: 1, title: 'two', version: 3 }, 'failed transactions leave the row unchanged');
});

test('Datastore models with a version field save and delete atomically', async () => {
	const fake = fakeDatastore();
	const context = createActiveTs({ stores: { default: await createDatastoreStoreAdapter({ client: fake.client }) } });
	const Note = LockedNote.use(context);
	await Note.create({ id: 7, title: 'draft', version: 1 });

	const first = (await Note.find(7).load())!;
	const second = (await Note.find(7).load())!;
	first.data.title = 'published';
	await first.save();
	assert.equal(first.data.version, 2);
	assert.deepEqual(fake.row(7), { id: 7, title: 'published', version: 2 });

	second.data.title = 'lost update';
	await assert.rejects(() => second.save(), ActiveTsConflictError);
	assert.deepEqual(fake.row(7), { id: 7, title: 'published', version: 2 });

	await context.transaction(async (tx) => {
		const inside = (await LockedNote.use(tx).find(7).load())!;
		inside.data.title = 'edited in transaction';
		await inside.save();
	});
	assert.deepEqual(fake.row(7), { id: 7, title: 'edited in transaction', version: 3 });

	await assert.rejects(() => first.delete(), ActiveTsConflictError);
	const current = (await Note.find(7).load())!;
	await current.delete();
	assert.equal(fake.row(7), undefined);
});
