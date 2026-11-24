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
import { createFirestoreStoreAdapter } from '../src/adapters/store/firestore.js';

type LockedData = { id: number; title: string; version: number };

class LockedNote extends Model<LockedData> {}

defineModel<LockedData>('firestore_optimistic_note')
	.id('id')
	.validate((input) => input as LockedData)
	.attach(LockedNote);

const meta: ResolvedModelMeta<LockedData> = {
	model: class {},
	name: 'firestore_optimistic_note',
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

const clone = <T>(value: T): T => (value === undefined ? value : structuredClone(value));

// A small Firestore: a transaction commit aborts and the SDK retries the
// callback when a document it read changed after that read.
function fakeFirestore() {
	const rows = new Map<string, Record<string, unknown>>();
	const revisions = new Map<string, number>();
	const calls: string[] = [];
	let revision = 0;
	let beforeCommit: (() => void) | undefined;
	// Apply the next commit, then lose its reply with a code the SDK retries.
	let loseNextCommitReply: (() => void) | undefined;
	const put = (path: string, data: Record<string, unknown> | undefined) => {
		if (data === undefined) rows.delete(path);
		else rows.set(path, clone(data));
		revisions.set(path, ++revision);
	};
	const snapshot = (path: string) => {
		const id = path.slice(path.indexOf('/') + 1);
		const row = rows.get(path);
		return row ? { exists: true, id, data: () => clone(row) } : { exists: false, id };
	};
	const ref = (collection: string, id: string) => {
		const path = `${collection}/${id}`;
		return {
			path,
			get: async () => {
				calls.push('get');
				return snapshot(path);
			},
			create: async (data: Record<string, unknown>) => {
				calls.push('create');
				if (rows.has(path)) throw Object.assign(new Error('already exists'), { code: 6 });
				put(path, data);
			},
			delete: async () => {
				calls.push('delete');
				put(path, undefined);
			}
		};
	};
	type Ref = ReturnType<typeof ref>;
	const client = {
		collection: (name: string) => ({ doc: (id: string) => ref(name, id) }),
		getAll: async (...refs: Ref[]) => refs.map((item) => snapshot(item.path)),
		runTransaction: async (callback: (transaction: unknown) => Promise<unknown>) => {
			for (let attempt = 0; attempt < 3; attempt++) {
				const reads = new Map<string, number | undefined>();
				const writes: Array<() => void> = [];
				const transaction = {
					get: async (item: Ref) => {
						calls.push('tx.get');
						reads.set(item.path, revisions.get(item.path));
						return snapshot(item.path);
					},
					set: (item: Ref, data: Record<string, unknown>) => {
						writes.push(() => put(item.path, data));
						return transaction;
					},
					create: (item: Ref, data: Record<string, unknown>) => {
						writes.push(() => {
							if (rows.has(item.path)) throw Object.assign(new Error('already exists'), { code: 6 });
							put(item.path, data);
						});
						return transaction;
					},
					delete: (item: Ref) => {
						writes.push(() => put(item.path, undefined));
						return transaction;
					}
				};
				const result = await callback(transaction);
				const hook = beforeCommit;
				beforeCommit = undefined;
				hook?.();
				let aborted = false;
				for (const [path, seen] of reads) if (revisions.get(path) !== seen) aborted = true;
				if (aborted) {
					calls.push('tx.abort');
					continue;
				}
				for (const apply of writes) apply();
				calls.push('tx.commit');
				if (loseNextCommitReply !== undefined) {
					const beforeRetry = loseNextCommitReply;
					loseNextCommitReply = undefined;
					calls.push('tx.reply-lost');
					beforeRetry();
					// The SDK retries ambiguous commit failures such as UNAVAILABLE.
					continue;
				}
				return result;
			}
			throw Object.assign(new Error('transaction aborted too many times'), { code: 10 });
		}
	};
	const path = (id: number) => `${meta.name}/number:${id}`;
	return {
		client,
		calls,
		row: (id: number) => rows.get(path(id)),
		write: (id: number, data: Record<string, unknown>) => put(path(id), data),
		concurrentlyBeforeCommit(change: () => void) {
			beforeCommit = change;
		},
		/** Apply the next commit, lose its reply, then run `beforeRetry` before the SDK retries. */
		loseNextCommitReply(beforeRetry: () => void = () => {}) {
			loseNextCommitReply = beforeRetry;
		}
	};
}

test('Firestore advertises atomic optimistic locking and still rejects write metadata', async () => {
	const store = await createFirestoreStoreAdapter({ client: fakeFirestore().client });
	assert.equal(store.capabilities?.optimisticLock, true);
	await assert.rejects(
		() => store.update(meta, 1, { id: 1, title: 'x', version: 2 }, { meta: { tag: 'x' } }),
		/does not support metadata write options/
	);
	await assert.rejects(
		() => store.update(meta, 1, { id: 1, title: 'x', version: 2 }, { expectedVersion: -1 }),
		/expectedVersion must be a non-negative safe integer/
	);
});

test('Firestore version-checked writes outside a transaction read and write in one transaction', async () => {
	const fake = fakeFirestore();
	const store = await createFirestoreStoreAdapter({ client: fake.client });
	await store.create(meta, 1, { id: 1, title: 'first', version: 1 });
	fake.calls.length = 0;

	await store.update(meta, 1, { id: 1, title: 'second', version: 2 }, { expectedVersion: 1 });
	assert.deepEqual(fake.row(1), { id: 1, title: 'second', version: 2 });
	assert.deepEqual(fake.calls, ['tx.get', 'tx.commit']);

	await assert.rejects(
		() => store.update(meta, 1, { id: 1, title: 'stale', version: 2 }, { expectedVersion: 1 }),
		(error: unknown) => error instanceof ActiveTsConflictError && /Expected version 1/.test(error.message)
	);
	assert.deepEqual(fake.row(1), { id: 1, title: 'second', version: 2 });

	await assert.rejects(
		() => store.update(meta, 404, { id: 404, title: 'missing', version: 2 }, { expectedVersion: 1 }),
		ActiveTsNotFoundError
	);
	await assert.rejects(() => store.delete(meta, 404, { expectedVersion: 1 }), ActiveTsNotFoundError);
	await assert.rejects(() => store.delete(meta, 1, { expectedVersion: 1 }), ActiveTsConflictError);
	assert.ok(fake.row(1));

	fake.calls.length = 0;
	await store.delete(meta, 1, { expectedVersion: 2 });
	assert.equal(fake.row(1), undefined);
	assert.deepEqual(fake.calls, ['tx.get', 'tx.commit']);

	await store.create(meta, 2, { id: 2, title: 'unversioned delete', version: 1 });
	fake.calls.length = 0;
	await store.delete(meta, 2);
	assert.deepEqual(fake.calls, ['delete'], 'deletes without expectedVersion stay a single write');
});

test('Firestore rechecks the version when a concurrent write aborts the transaction', async () => {
	const fake = fakeFirestore();
	const store = await createFirestoreStoreAdapter({ client: fake.client });
	await store.create(meta, 1, { id: 1, title: 'first', version: 1 });
	fake.concurrentlyBeforeCommit(() => fake.write(1, { id: 1, title: 'other writer', version: 2 }));
	fake.calls.length = 0;
	await assert.rejects(
		() => store.update(meta, 1, { id: 1, title: 'mine', version: 2 }, { expectedVersion: 1 }),
		ActiveTsConflictError
	);
	assert.deepEqual(fake.row(1), { id: 1, title: 'other writer', version: 2 });
	assert.deepEqual(fake.calls, ['tx.get', 'tx.abort', 'tx.get'], 'the retry sees the new version and stops');

	fake.concurrentlyBeforeCommit(() => fake.write(1, { id: 1, title: 'third writer', version: 3 }));
	await assert.rejects(() => store.delete(meta, 1, { expectedVersion: 2 }), ActiveTsConflictError);
	assert.deepEqual(fake.row(1), { id: 1, title: 'third writer', version: 3 });
});

test('Firestore transactions compare versions against their own reads and buffered writes', async () => {
	const fake = fakeFirestore();
	const store = await createFirestoreStoreAdapter({ client: fake.client });
	await store.create(meta, 1, { id: 1, title: 'first', version: 1 });
	await store.create(meta, 2, { id: 2, title: 'second', version: 1 });

	await store.transaction!(async (tx) => {
		assert.equal(tx.capabilities?.optimisticLock, true);
		// Firestore transactions read before they write, so read row 2 up front.
		await tx.get(meta, 2);
		await tx.update(meta, 1, { id: 1, title: 'one', version: 2 }, { expectedVersion: 1 });
		await tx.update(meta, 1, { id: 1, title: 'two', version: 3 }, { expectedVersion: 2 });
		await tx.delete(meta, 2, { expectedVersion: 1 });
	});
	assert.deepEqual(fake.row(1), { id: 1, title: 'two', version: 3 });
	assert.equal(fake.row(2), undefined);

	await store.create(meta, 3, { id: 3, title: 'third', version: 1 });
	await assert.rejects(
		() => store.transaction!(async (tx) => {
			await tx.update(meta, 1, { id: 1, title: 'write first', version: 4 }, { expectedVersion: 3 });
			await tx.delete(meta, 3, { expectedVersion: 1 });
		}),
		/cannot read unbuffered documents after writes/
	);
	assert.ok(fake.row(3));

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
	await assert.rejects(
		() => store.transaction!(async (tx) => {
			assert.deepEqual(await tx.get(meta, 1), { id: 1, title: 'two', version: 3 });
			await tx.delete(meta, 1, { expectedVersion: 2 });
		}),
		ActiveTsConflictError
	);
	assert.deepEqual(fake.row(1), { id: 1, title: 'two', version: 3 }, 'failed transactions leave the row unchanged');
});

test('Firestore models with a version field save and delete atomically', async () => {
	const fake = fakeFirestore();
	const context = createActiveTs({ stores: { default: await createFirestoreStoreAdapter({ client: fake.client }) } });
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

test('Firestore reports success when a retried attempt finds its own lost commit', async () => {
	const fake = fakeFirestore();
	const store = await createFirestoreStoreAdapter({ client: fake.client });
	await store.create(meta, 1, { id: 1, title: 'first', version: 1 });
	fake.calls.length = 0;
	fake.loseNextCommitReply();
	await store.update(meta, 1, { id: 1, title: 'second', version: 2 }, { expectedVersion: 1 });
	assert.deepEqual(fake.row(1), { id: 1, title: 'second', version: 2 });
	assert.deepEqual(fake.calls, ['tx.get', 'tx.commit', 'tx.reply-lost', 'tx.get', 'tx.commit']);

	// A retry that finds another writer's value after the lost reply is still a conflict.
	fake.loseNextCommitReply(() => fake.write(1, { id: 1, title: 'other writer', version: 3 }));
	await assert.rejects(
		() => store.update(meta, 1, { id: 1, title: 'third', version: 3 }, { expectedVersion: 2 }),
		ActiveTsConflictError
	);
	assert.deepEqual(fake.row(1), { id: 1, title: 'other writer', version: 3 });

	fake.loseNextCommitReply();
	await store.delete(meta, 1, { expectedVersion: 3 });
	assert.equal(fake.row(1), undefined, 'a retried delete that finds the row gone succeeded');
	// A first attempt that finds no row is still NotFound.
	await assert.rejects(() => store.delete(meta, 1, { expectedVersion: 3 }), ActiveTsNotFoundError);
});
