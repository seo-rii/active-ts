import test from 'node:test';
import assert from 'node:assert/strict';
import {
	ACTIVE_TS_ENTITY_KEY,
	ActiveTsCommittedTransactionError,
	Model,
	MemoryOutboxAdapter,
	MemorySearchAdapter,
	MemoryStoreAdapter,
	createActiveTs,
	datastoreKey,
	datastoreSearchDocumentIdentity,
	createOutboxPlugin,
	createSearchMiddlewareAdapter,
	createStoreMiddlewareAdapter,
	defineModel,
	normalizeOutboxEvent,
	runSearchSyncWorker,
	setDefaultContext,
	StoreOutboxAdapter,
	type EntityId,
	type OutboxEvent,
	type ResolvedModelMeta,
	type SearchAdapter,
	type StoreAdapter,
	type StoreReadOptions
} from '../src/index.js';

type OutboxAccountData = {
	id: number;
	handle: string;
};

type OutboxSecretData = {
	id: number;
	secret: string;
};

type OutboxDatastoreAccountData = {
	id: number;
	parentId: number;
	handle: string;
};

class OutboxAccount extends Model<OutboxAccountData> {}
class OutboxSecretAccount extends Model<OutboxSecretData> {}
class OutboxDatastoreAccount extends Model<OutboxDatastoreAccountData> {}

class ProjectMemoryStore extends MemoryStoreAdapter {
	override readonly datastoreProjectId: string;

	constructor(projectId: string) {
		super();
		this.datastoreProjectId = projectId;
	}
}

class MissingCommittedCodecReadStore extends MemoryStoreAdapter {
	override async get(model: ResolvedModelMeta, id: EntityId, options?: StoreReadOptions) {
		if (model.name === 'outbox_secret_account') return null;
		return await super.get(model, id, options);
	}
}

function createKindMemoryStore(kind: string, capabilityOverrides: Record<string, boolean> = {}): StoreAdapter {
	const store = new MemoryStoreAdapter();
	return {
		kind,
		cacheScope: store.cacheScope,
		datastoreNamespace: store.datastoreNamespace,
		datastoreProjectId: store.datastoreProjectId,
		datastoreDatabaseId: store.datastoreDatabaseId,
		datastoreKeyEncoding: store.datastoreKeyEncoding,
		capabilities: Object.freeze({ ...store.capabilities, ...capabilityOverrides }),
		get: (model, id, options) => store.get(model, id, options),
		getMany: (model, ids, options) => store.getMany(model, ids, options),
		query: (model, plan, options) => store.query(model, plan, options),
		aggregate: (model, plan) => store.aggregate!(model, plan),
		create: (model, id, data, options) => store.create(model, id, data, options),
		update: (model, id, data, options) => store.update(model, id, data, options),
		delete: (model, id, options) => store.delete(model, id, options),
		transaction: (fn, options) => store.transaction!(fn, options)
	};
}

function createDatastoreKindMemoryStore(): StoreAdapter {
	return createKindMemoryStore('datastore', { datastoreAncestor: true, optimisticLock: false });
}

function createFirestoreKindMemoryStore(): StoreAdapter {
	return createKindMemoryStore('firestore');
}

defineModel<OutboxAccountData>({ name: 'outbox_transaction_account', search: 'memory' })
	.id('id')
	.validate((input) => input as OutboxAccountData)
	.search('memory', ['handle'])
	.attach(OutboxAccount);

defineModel<OutboxSecretData>({ name: 'outbox_secret_account', search: 'memory' })
	.id('id')
	.validate((input) => input as OutboxSecretData)
	.fieldCodec('secret', {
		name: 'outbox-secret-codec',
		encode: (value) => `encoded:${String(value)}`,
		decode: (value) => {
			const text = String(value);
			if (!text.startsWith('encoded:')) throw new Error('expected encoded secret');
			return text.slice('encoded:'.length);
		}
	})
	.search('memory', ['secret'])
	.attach(OutboxSecretAccount);

defineModel<OutboxDatastoreAccountData>({ name: 'outbox_datastore_account', search: 'memory' })
	.id('id')
	.validate((input) => input as OutboxDatastoreAccountData)
	.datastore({
		ancestor: ({ data }) => data === undefined ? undefined : datastoreKey('outbox_datastore_parent', data.parentId),
		ancestorFields: ['parentId']
	})
	.search('memory', ['handle'])
	.attach(OutboxDatastoreAccount);

test('transaction afterCommit failures are surfaced after committed writes', async () => {
	const warnings: string[] = [];
	const originalWarn = console.warn;
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const afterCommitEvents: string[] = [];
	setDefaultContext(context);
	console.warn = (message?: unknown) => warnings.push(String(message));
	try {
		await assert.rejects(
			() =>
				context.transaction(async (tx) => {
					await OutboxAccount.create({ id: 702, handle: 'committed' }, tx);
					await tx.afterCommit(() => {
						throw new Error('dispatch unavailable');
					});
					await tx.afterCommit(() => {
						afterCommitEvents.push('later-task-ran');
					});
					return 'ok';
				}),
			(error: unknown) => {
				assert.ok(error instanceof ActiveTsCommittedTransactionError);
				assert.equal(error.result, 'ok');
				assert.ok(error.cause instanceof AggregateError);
				assert.match(error.message, /afterCommit task failed/);
				assert.match((error.cause.errors[0] as Error).message, /dispatch unavailable/);
				return true;
			}
		);

		assert.equal((await OutboxAccount.find(702).load())?.data.handle, 'committed');
		assert.match(warnings[0], /afterCommit task failed.*dispatch unavailable/);
		assert.deepEqual(afterCommitEvents, ['later-task-ran']);
	} finally {
		console.warn = originalWarn;
	}
});

test('transaction afterRollback failures are reported without hiding the rollback reason', async () => {
	const warnings: string[] = [];
	const rollbackEvents: string[] = [];
	const originalWarn = console.warn;
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	setDefaultContext(context);
	console.warn = (message?: unknown) => warnings.push(String(message));
	try {
		await assert.rejects(
			() =>
				context.transaction(async (tx) => {
					await OutboxAccount.create({ id: 703, handle: 'rolled-back' }, tx);
					await tx.afterRollback(() => {
						throw new Error('rollback observer down');
					});
					await tx.afterRollback(() => {
						rollbackEvents.push('later-rollback-task-ran');
					});
					throw new Error('work failed');
				}),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /work failed/);
				const afterRollbackError = (error as any).afterRollbackError;
				assert.ok(afterRollbackError instanceof AggregateError);
				assert.match(afterRollbackError.message, /afterRollback task failed/);
				assert.match((afterRollbackError.errors[0] as Error).message, /rollback observer down/);
				return true;
			}
		);

		assert.equal(await OutboxAccount.find(703).load(), null);
		assert.match(warnings[0], /afterRollback task failed.*rollback observer down/);
		assert.deepEqual(rollbackEvents, ['later-rollback-task-ran']);
	} finally {
		console.warn = originalWarn;
	}
});

test('transaction deferred task logging failures do not mask original task errors', async () => {
	const originalWarn = console.warn;
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	setDefaultContext(context);
	const events: string[] = [];
	console.warn = () => {
		throw new Error('warning sink failed');
	};
	try {
		await assert.rejects(
			() =>
				context.transaction(async (tx) => {
					await OutboxAccount.create({ id: 706, handle: 'committed-warning-failure' }, tx);
					await tx.afterCommit(() => {
						events.push('afterCommit:first');
						throw new Error('afterCommit original failure');
					});
					await tx.afterCommit(() => {
						events.push('afterCommit:second');
					});
				}),
			(error: unknown) => {
				assert.ok(error instanceof ActiveTsCommittedTransactionError);
				assert.ok(error.cause instanceof AggregateError);
				assert.match(error.message, /afterCommit task failed/);
				assert.match((error.cause.errors[0] as Error).message, /afterCommit original failure/);
				assert.doesNotMatch((error.cause.errors[0] as Error).message, /warning sink failed/);
				return true;
			}
		);
		await assert.rejects(
			() =>
				context.transaction(async (tx) => {
					await OutboxAccount.create({ id: 707, handle: 'rollback-warning-failure' }, tx);
					await tx.afterRollback(() => {
						events.push('afterRollback:first');
						throw new Error('afterRollback original failure');
					});
					await tx.afterRollback(() => {
						events.push('afterRollback:second');
					});
					throw new Error('rollback primary failure');
				}),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /rollback primary failure/);
				const afterRollbackError = (error as any).afterRollbackError;
				assert.ok(afterRollbackError instanceof AggregateError);
				assert.match((afterRollbackError.errors[0] as Error).message, /afterRollback original failure/);
				assert.doesNotMatch((afterRollbackError.errors[0] as Error).message, /warning sink failed/);
				return true;
			}
		);
	} finally {
		console.warn = originalWarn;
	}

	assert.deepEqual(events, [
		'afterCommit:first',
		'afterCommit:second',
		'afterRollback:first',
		'afterRollback:second'
	]);
});

test('transaction deferred error formatting does not invoke thrown value coercion', async () => {
	const warnings: string[] = [];
	const originalWarn = console.warn;
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	setDefaultContext(context);
	let toStringCalls = 0;
	const thrown = {
		toString() {
			toStringCalls++;
			throw new Error('deferred toString should not run');
		}
	};
	console.warn = (message?: unknown) => warnings.push(String(message));
	try {
		await assert.rejects(
			() =>
				context.transaction(async (tx) => {
					await OutboxAccount.create({ id: 704, handle: 'committed-with-bad-error' }, tx);
					await tx.afterCommit(() => {
						throw thrown;
					});
				}),
			(error: unknown) => {
				assert.ok(error instanceof ActiveTsCommittedTransactionError);
				assert.ok(error.cause instanceof AggregateError);
				assert.equal(error.cause.errors[0], thrown);
				assert.match(error.message, /afterCommit task failed/);
				return true;
			}
		);
		await assert.rejects(
			() =>
				context.transaction(async (tx) => {
					await OutboxAccount.create({ id: 705, handle: 'rolled-back-with-bad-error' }, tx);
					await tx.afterRollback(() => {
						throw thrown;
					});
					throw new Error('rollback work failed');
				}),
			/rollback work failed/
		);
	} finally {
		console.warn = originalWarn;
	}

	assert.equal(toStringCalls, 0);
	assert.match(warnings[0], /afterCommit task failed/);
	assert.match(warnings[1], /afterRollback task failed/);
});

test('outbox plugin preserves event order for multiple writes after transaction commit', async () => {
	const outbox = new MemoryOutboxAdapter();
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		plugins: [createOutboxPlugin({ outbox, includeData: true, id: () => `event-${Date.now()}-${Math.random()}` })]
	});
	setDefaultContext(context);

	await context.transaction(async (tx) => {
		await OutboxAccount.create({ id: 801, handle: 'first' }, tx);
		await OutboxAccount.create({ id: 802, handle: 'second' }, tx);
	});

	assert.deepEqual(
		(await outbox.list()).map((event) => [event.modelId, event.operation]),
		[
			[801, 'create'],
			[802, 'create']
		]
	);
});

test('outbox plugin binds events to the model store Datastore project', async () => {
	const outbox = new MemoryOutboxAdapter();
	const search = new MemorySearchAdapter();
	const context = createActiveTs({
		stores: { default: new ProjectMemoryStore('project-a') },
		search: { memory: search },
		defaultSearch: 'memory',
		plugins: [createOutboxPlugin({ outbox, includeData: true, id: () => 'project-bound-event' })]
	});
	const Account = OutboxAccount.use(context) as unknown as typeof OutboxAccount;

	await Account.create({ id: 811, handle: 'project-bound' });

	const [event] = await outbox.list();
	assert.equal(event.modelDatastoreProjectId, 'project-a');
	assert.equal(await runSearchSyncWorker({ outbox, search, models: [OutboxAccount], context }), 1);
	assert.deepEqual(
		(await search.search(context.meta(OutboxAccount), 'project-bound', {})).list.map((row) => row.id),
		[811]
	);
});

test('search sync rejects project-bound events before search side effects', async () => {
	const outbox = new MemoryOutboxAdapter();
	let indexCalls = 0;
	let deleteCalls = 0;
	const search: SearchAdapter = {
		kind: 'memory',
		capabilities: { index: true },
		search: async () => ({ list: [], more: false }),
		index: async () => { indexCalls++; },
		delete: async () => { deleteCalls++; }
	};
	const context = createActiveTs({ stores: { default: new ProjectMemoryStore('project-b') } });
	await outbox.append({
		id: 'wrong-project-event',
		model: 'outbox_transaction_account',
		modelId: 812,
		modelDatastoreProjectId: 'project-a',
		operation: 'create',
		data: { id: 812, handle: 'wrong-project' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});

	await assert.rejects(
		() => runSearchSyncWorker({ outbox, search, models: [OutboxAccount], context }),
		/targets Datastore project "project-a".*uses project "project-b"/
	);
	assert.equal(indexCalls, 0);
	assert.equal(deleteCalls, 0);
	assert.deepEqual((await outbox.list()).map((event) => event.id), ['wrong-project-event']);
});

test('search sync requires a verifiable context for project-bound events', async () => {
	const outbox = new MemoryOutboxAdapter();
	let indexCalls = 0;
	const search: SearchAdapter = {
		kind: 'memory',
		capabilities: { index: true },
		search: async () => ({ list: [], more: false }),
		index: async () => { indexCalls++; },
		delete: async () => undefined
	};
	await outbox.append({
		id: 'unverifiable-project-event',
		model: 'outbox_transaction_account',
		modelId: 813,
		modelDatastoreProjectId: 'project-a',
		operation: 'create',
		data: { id: 813, handle: 'unverifiable-project' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});

	await assert.rejects(
		() => runSearchSyncWorker({ outbox, search, models: [OutboxAccount] }),
		/declares a Datastore project and requires a context/
	);
	const unknownContext = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	await assert.rejects(
		() => runSearchSyncWorker({ outbox, search, models: [OutboxAccount], context: unknownContext }),
		/cannot verify store "default" because it does not expose datastoreProjectId/
	);
	assert.equal(indexCalls, 0);
	assert.deepEqual((await outbox.list()).map((event) => event.id), ['unverifiable-project-event']);
});

test('outbox event normalization rejects malformed Datastore project identities', () => {
	for (const modelDatastoreProjectId of ['', 'project\0a', 1]) {
		assert.throws(
			() => normalizeOutboxEvent({
				id: 'bad-project-event',
				model: 'outbox_transaction_account',
				modelId: 1,
				modelDatastoreProjectId,
				operation: 'create',
				createdAt: '2026-05-13T00:00:00.000Z'
			}),
			/modelDatastoreProjectId must be a non-empty string without null bytes/
		);
	}
});

test('outbox plugin rejects unsafe deferred appends inside Datastore transactions', async () => {
	const outbox = new MemoryOutboxAdapter();
	const context = createActiveTs({
		stores: { default: createDatastoreKindMemoryStore() },
		plugins: [createOutboxPlugin({ outbox, includeData: true, id: () => 'unsafe-datastore-deferred' })]
	});
	const Account = OutboxAccount.use(context) as unknown as typeof OutboxAccount;

	await assert.rejects(
		() => context.transaction((tx) => Account.create({ id: 813, handle: 'unsafe-deferred' }, tx)),
		/allowUnsafeTransactionDeferredAppend: true/
	);

	assert.deepEqual(await outbox.list(), []);
	assert.equal(await Account.find(813).load(), null);
});

test('outbox plugin rejects unsafe deferred appends through Datastore store middleware', async () => {
	const outbox = new MemoryOutboxAdapter();
	const context = createActiveTs({
		stores: { default: createStoreMiddlewareAdapter(createDatastoreKindMemoryStore(), [], 'wrapped-datastore') },
		plugins: [createOutboxPlugin({ outbox, includeData: true, id: () => 'unsafe-wrapped-datastore-deferred' })]
	});
	const Account = OutboxAccount.use(context) as unknown as typeof OutboxAccount;

	await assert.rejects(
		() => context.transaction((tx) => Account.create({ id: 815, handle: 'unsafe-wrapped-deferred' }, tx)),
		/allowUnsafeTransactionDeferredAppend: true/
	);

	assert.deepEqual(await outbox.list(), []);
	assert.equal(await Account.find(815).load(), null);
});

test('outbox plugin rejects unsafe deferred appends inside Firestore transactions', async () => {
	const outbox = new MemoryOutboxAdapter();
	const context = createActiveTs({
		stores: { default: createFirestoreKindMemoryStore() },
		plugins: [createOutboxPlugin({ outbox, includeData: true, id: () => 'unsafe-firestore-deferred' })]
	});
	const Account = OutboxAccount.use(context) as unknown as typeof OutboxAccount;

	await assert.rejects(
		() => context.transaction((tx) => Account.create({ id: 817, handle: 'unsafe-firestore-deferred' }, tx)),
		/Firestore transaction commit.*allowUnsafeTransactionDeferredAppend: true/
	);

	assert.deepEqual(await outbox.list(), []);
	assert.equal(await Account.find(817).load(), null);
});

test('outbox plugin allows StoreOutboxAdapter inside Datastore transactions', async () => {
	const outbox = new StoreOutboxAdapter({ store: 'default' });
	const context = createActiveTs({
		stores: { default: createDatastoreKindMemoryStore() },
		plugins: [createOutboxPlugin({ outbox, includeData: true, id: () => 'safe-datastore-store-outbox' })]
	});
	const Account = OutboxAccount.use(context) as unknown as typeof OutboxAccount;

	await context.transaction((tx) => Account.create({ id: 816, handle: 'safe-store-outbox' }, tx));

	assert.deepEqual(
		(await outbox.list()).map((event) => [event.id, event.modelId, event.operation]),
		[['safe-datastore-store-outbox', 816, 'create']]
	);
});

test('outbox plugin allows explicit unsafe deferred appends inside Datastore transactions', async () => {
	const outbox = new MemoryOutboxAdapter();
	const context = createActiveTs({
		stores: { default: createDatastoreKindMemoryStore() },
		plugins: [
			createOutboxPlugin({
				outbox,
				includeData: true,
				id: () => 'unsafe-datastore-deferred-opt-in',
				allowUnsafeTransactionDeferredAppend: true
			})
		]
	});
	const Account = OutboxAccount.use(context) as unknown as typeof OutboxAccount;

	await context.transaction((tx) => Account.create({ id: 814, handle: 'unsafe-opt-in' }, tx));

	assert.deepEqual(
		(await outbox.list()).map((event) => [event.id, event.modelId, event.operation]),
		[['unsafe-datastore-deferred-opt-in', 814, 'create']]
	);
});

test('outbox plugin records outer writes before nested lifecycle writes', async () => {
	const outbox = new MemoryOutboxAdapter();
	let nextEvent = 0;
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		plugins: [
			{
				name: 'nested-delete-after-create',
				hooks: {
					afterCreate: async (payload) => {
						if (payload.model?.name !== 'outbox_transaction_account') return;
						await OutboxAccount.delete(payload.id as number, payload.context as any);
					}
				}
			},
			createOutboxPlugin({
				outbox,
				includeData: true,
				id: () => `nested-order-${++nextEvent}`
			})
		]
	});
	const Account = OutboxAccount.use(context) as unknown as typeof OutboxAccount;

	await Account.create({ id: 812, handle: 'create-then-delete' });

	assert.deepEqual(
		(await outbox.list()).map((event) => [event.modelId, event.operation]),
		[
			[812, 'create'],
			[812, 'delete']
		]
	);
	assert.equal(await Account.find(812).load(), null);
});

test('outbox plugin default event ids do not depend on Math.random', async () => {
	const outbox = new MemoryOutboxAdapter();
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		plugins: [createOutboxPlugin({ outbox, includeData: true })]
	});
	const Account = OutboxAccount.use(context) as unknown as typeof OutboxAccount;
	const originalRandom = Math.random;
	Math.random = () => {
		throw new Error('Math.random should not generate outbox event ids');
	};
	try {
		await Account.create({ id: 803, handle: 'default-id' });
	} finally {
		Math.random = originalRandom;
	}
	const [event] = await outbox.list();
	assert.match(event.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test('store outbox persists codec payloads in stored form and decodes for search sync', async () => {
	const store = new MemoryStoreAdapter();
	const outbox = new StoreOutboxAdapter({ store: 'default' });
	const search = new MemorySearchAdapter();
	const context = createActiveTs({
		stores: { default: store },
		search: { memory: search },
		defaultSearch: 'memory',
		plugins: [createOutboxPlugin({ outbox, includeData: true, id: () => 'secret-outbox-event' })]
	});
	const Account = OutboxSecretAccount.use(context) as unknown as typeof OutboxSecretAccount;

	await Account.create({ id: 1, secret: 'visible-token' });

	assert.deepEqual(store.dump('outbox_secret_account'), [{ id: 1, secret: 'encoded:visible-token' }]);
	const [storedEvent] = store.dump('active_ts_outbox_event');
	assert.equal(storedEvent.data.secret, 'encoded:visible-token');
	assert.equal(storedEvent.dataEncoding, 'stored');

	assert.equal(await runSearchSyncWorker({ outbox, search, models: [OutboxSecretAccount], context }), 1);
	assert.deepEqual(
		(await search.search(context.meta(OutboxSecretAccount), 'visible-token', {})).list.map((row) => row.id),
		[1]
	);
	assert.deepEqual(
		(await search.search(context.meta(OutboxSecretAccount), 'encoded', {})).list,
		[]
	);
});

test('store outbox search sync uses transaction-backed leases without optimistic locking', async () => {
	const backing = new MemoryStoreAdapter();
	let transactionCalls = 0;
	let leaseChecks = 0;
	let leaseCalls = 0;
	const store: StoreAdapter = {
		kind: 'transactional-no-lock-outbox-store',
		capabilities: { ...backing.capabilities, optimisticLock: false },
		get: (model, id, options) => backing.get(model, id, options),
		getMany: (model, ids, options) => backing.getMany(model, ids, options),
		query: (model, plan, options) => backing.query(model, plan, options),
		aggregate: (model, plan) => backing.aggregate(model, plan),
		create: (model, id, data, options) => backing.create(model, id, data, options),
		update: (model, id, data, options) => backing.update(model, id, data, options),
		delete: (model, id, options) => backing.delete(model, id, options),
		transaction: async (fn, options) => {
			transactionCalls++;
			return await backing.transaction(fn, options);
		}
	};
	class ObservedStoreOutboxAdapter extends StoreOutboxAdapter {
		override supportsExclusiveLease() {
			leaseChecks++;
			return super.supportsExclusiveLease();
		}

		override async lease(options?: { limit?: number }) {
			leaseCalls++;
			return await super.lease(options);
		}
	}
	const context = createActiveTs({ stores: { default: store } });
	const outbox = new ObservedStoreOutboxAdapter({ context });
	const search = new MemorySearchAdapter();
	await outbox.append({
		id: 'drain-no-exclusive-lease',
		model: 'outbox_transaction_account',
		modelId: 31,
		operation: 'create',
		data: { id: 31, handle: 'drained' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});

	assert.equal(await runSearchSyncWorker({
		outbox,
		search,
		models: [OutboxAccount],
		context
	}), 1);

	assert.equal(leaseChecks, 1);
	assert.equal(leaseCalls, 1);
	assert.equal(transactionCalls, 3);
	assert.deepEqual(await outbox.list(), []);
	assert.deepEqual(
		(await search.search(context.meta(OutboxAccount), 'drained', {})).list.map((row) => row.id),
		[31]
	);
});

test('store outbox rejects transactions without read-write conflict detection for leases', async () => {
	const backing = new MemoryStoreAdapter();
	let transactionCalls = 0;
	const lostUpdateStore: StoreAdapter = {
		kind: 'lost-update-transaction-store',
		capabilities: {
			...backing.capabilities,
			optimisticLock: false,
			transaction: true,
			transactionConflictDetection: false
		},
		get: (model, id, options) => backing.get(model, id, options),
		getMany: (model, ids, options) => backing.getMany(model, ids, options),
		query: (model, plan, options) => backing.query(model, plan, options),
		aggregate: (model, plan) => backing.aggregate(model, plan),
		create: (model, id, data, options) => backing.create(model, id, data, options),
		update: (model, id, data, options) => backing.update(model, id, data, options),
		delete: (model, id, options) => backing.delete(model, id, options),
		transaction: async (callback) => {
			transactionCalls++;
			return await callback(lostUpdateStore);
		}
	};
	const context = createActiveTs({ stores: { default: lostUpdateStore } });
	const outbox = new StoreOutboxAdapter({ context });
	await outbox.append({
		id: 'lost-update-lease',
		model: 'outbox_transaction_account',
		modelId: 32,
		operation: 'create',
		createdAt: '2026-05-13T00:00:00.000Z'
	});

	assert.equal(outbox.supportsExclusiveLease(), false);
	await assert.rejects(() => outbox.lease!(), /conflict-detecting transactions/);
	assert.equal(transactionCalls, 0);
});

test('outbox includeData encodes codec payload fallback when committed row cannot be reread', async () => {
	const outbox = new MemoryOutboxAdapter();
	const context = createActiveTs({
		stores: { default: new MissingCommittedCodecReadStore() },
		plugins: [createOutboxPlugin({ outbox, includeData: true, id: () => 'encoded-fallback-event' })]
	});
	const Account = OutboxSecretAccount.use(context) as unknown as typeof OutboxSecretAccount;

	await Account.create({ id: 22, secret: 'fallback-token' });

	const [event] = await outbox.list();
	assert.equal(event.dataEncoding, 'stored');
	assert.deepEqual(event.data, { id: 22, secret: 'encoded:fallback-token' });
});

test('outbox includeData keeps simple model events usable without worker context', async () => {
	const outbox = new MemoryOutboxAdapter();
	let indexed: any;
	const search = {
		kind: 'memory',
		capabilities: { index: true },
		search: async () => ({ list: [], more: false }),
		index: async (_model: unknown, _id: unknown, data: unknown) => {
			indexed = data;
		},
		delete: async () => undefined
	} satisfies SearchAdapter;
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		plugins: [createOutboxPlugin({ outbox, includeData: true, id: () => 'legacy-public-event' })]
	});
	const Account = OutboxAccount.use(context) as unknown as typeof OutboxAccount;

	await Account.create({ id: 21, handle: 'legacy-public' });

	const [event] = await outbox.list();
	assert.equal(event.dataEncoding, 'public');
	assert.equal(await runSearchSyncWorker({ outbox, search, models: [OutboxAccount] }), 1);
	assert.deepEqual(indexed, { id: 21, handle: 'legacy-public' });
});

test('outbox search sync requires context for projecting search adapters', async () => {
	const outbox = new MemoryOutboxAdapter();
	await outbox.append({
		id: 'projecting-no-context',
		model: 'outbox_transaction_account',
		modelId: 24,
		operation: 'create',
		createdAt: '2026-05-13T00:00:01.000Z',
		data: { id: 24, handle: 'projecting' },
		dataEncoding: 'public'
	});
	const search = new MemorySearchAdapter();

	await assert.rejects(
		() => runSearchSyncWorker({ outbox, search, models: [OutboxAccount] }),
		/requires a context for search indexing with a projecting search adapter/
	);
	assert.equal(search.stats.index, 0);
	assert.deepEqual(
		(await outbox.list()).map((event) => event.id),
		['projecting-no-context']
	);
});

test('outbox search sync detects projecting search adapters through middleware wrappers', async () => {
	const outbox = new MemoryOutboxAdapter();
	await outbox.append({
		id: 'projecting-middleware-no-context',
		model: 'outbox_transaction_account',
		modelId: 25,
		operation: 'update',
		createdAt: '2026-05-13T00:00:02.000Z',
		data: { id: 25, handle: 'projecting' },
		dataEncoding: 'public'
	});
	const base = new MemorySearchAdapter();
	const search = createSearchMiddlewareAdapter(base, [
		async (_operation, next) => await next()
	]);

	await assert.rejects(
		() => runSearchSyncWorker({ outbox, search, models: [OutboxAccount] }),
		/requires a context for search indexing with a projecting search adapter/
	);
	assert.equal(base.stats.index, 0);
	assert.deepEqual(
		(await outbox.list()).map((event) => event.id),
		['projecting-middleware-no-context']
	);
});

test('store outbox reconciles current state when event creation and commit order differ', async () => {
	const store = new MemoryStoreAdapter();
	const outbox = new StoreOutboxAdapter({ store: 'default' });
	const search = new MemorySearchAdapter();
	const context = createActiveTs({
		stores: { default: store },
		search: { memory: search },
		defaultSearch: 'memory'
	});
	outbox.setup!(context);
	const Account = OutboxAccount.use(context) as unknown as typeof OutboxAccount;
	const timestamp = '2026-05-13T00:00:00.000Z';
	await Account.create({ id: 1, handle: 'A-final-store' });

	await outbox.append({
		id: 'a-created-first-commits-last',
		model: 'outbox_transaction_account',
		modelId: 1,
		operation: 'update',
		data: { id: 1, handle: 'A-final-store' },
		reconcileFromStore: true,
		createdAt: timestamp
	});
	await outbox.append({
		id: 'b-created-last-commits-first',
		model: 'outbox_transaction_account',
		modelId: 1,
		operation: 'update',
		data: { id: 1, handle: 'B-commits-first' },
		reconcileFromStore: true,
		createdAt: timestamp
	});

	assert.deepEqual(
		(await outbox.list()).map((event) => event.id),
		['a-created-first-commits-last', 'b-created-last-commits-first']
	);
	assert.equal(await runSearchSyncWorker({ outbox, search, models: [OutboxAccount], context }), 1);
	assert.deepEqual(
		(await search.search(context.meta(OutboxAccount), 'A-final-store', {})).list.map((row) => row.id),
		[1]
	);

	assert.equal(await runSearchSyncWorker({ outbox, search, models: [OutboxAccount], context }), 1);
	assert.deepEqual(
		(await search.search(context.meta(OutboxAccount), 'A-final-store', {})).list.map((row) => row.id),
		[1]
	);
	assert.deepEqual((await search.search(context.meta(OutboxAccount), 'B-commits-first', {})).list, []);
});

test('store outbox schema index matches sequence-based list ordering', async () => {
	const backing = new MemoryStoreAdapter();
	let observedIndexFields: string[] | undefined;
	let observedSortFields: string[] | undefined;
	const store: StoreAdapter = {
		kind: 'outbox-index-observer',
		capabilities: backing.capabilities,
		get: (model, id, options) => backing.get(model, id, options),
		getMany: (model, ids, options) => backing.getMany(model, ids, options),
		query: async (model: any, plan: any, options) => {
			if (model.name === 'active_ts_outbox_event') {
				observedIndexFields = model.indexes[0]?.fields;
				observedSortFields = plan.sort.map((sort: any) => sort.field);
			}
			return await backing.query(model, plan, options);
		},
		aggregate: (model, plan) => backing.aggregate(model, plan),
		create: (model, id, data) => backing.create(model, id, data),
		update: (model, id, data, options) => backing.update(model, id, data, options),
		delete: (model, id) => backing.delete(model, id),
		transaction: (fn) => backing.transaction(fn)
	};
	const context = createActiveTs({ stores: { default: store } });
	const outbox = new StoreOutboxAdapter({ context });

	await outbox.list();

	assert.deepEqual(observedSortFields, ['createdAt', 'sequence', 'id']);
	assert.deepEqual(observedIndexFields, observedSortFields);
});

test('store outbox batch operations push limits into paged store queries', async () => {
	const setup = () => {
		const backing = new MemoryStoreAdapter();
		const queryLimits: Array<number | undefined> = [];
		const store: StoreAdapter = {
			kind: 'outbox-limit-observer',
			capabilities: { ...backing.capabilities, transaction: false },
			get: (model, id, options) => backing.get(model, id, options),
			getMany: (model, ids, options) => backing.getMany(model, ids, options),
			query: async (model: any, plan: any, options) => {
				if (model.name === 'active_ts_outbox_event') queryLimits.push(plan.limit);
				return await backing.query(model, plan, options);
			},
			aggregate: (model, plan) => backing.aggregate(model, plan),
			create: (model, id, data) => backing.create(model, id, data),
			update: (model, id, data, options) => backing.update(model, id, data, options),
			delete: (model, id, options) => backing.delete(model, id, options)
		};
		const context = createActiveTs({ stores: { default: store } });
		return { outbox: new StoreOutboxAdapter({ context }), queryLimits };
	};
	const event = (id: string, offset: number) => ({
		id,
		model: 'outbox_transaction_account',
		modelId: offset,
		operation: 'create' as const,
		data: { id: offset, handle: id },
		createdAt: `2026-05-13T00:00:0${offset}.000Z`
	});

	const drain = setup();
	await drain.outbox.append(event('limited-drain-1', 1));
	await drain.outbox.append(event('limited-drain-2', 2));
	await drain.outbox.append(event('limited-drain-3', 3));

	assert.deepEqual((await drain.outbox.drain!({ limit: 2 })).map((item: OutboxEvent) => item.id), [
		'limited-drain-1',
		'limited-drain-2'
	]);
	assert.deepEqual(drain.queryLimits, [2]);

	const lease = setup();
	await lease.outbox.append(event('limited-lease-1', 1));
	await lease.outbox.append(event('limited-lease-2', 2));
	await lease.outbox.append(event('limited-lease-3', 3));

	assert.deepEqual((await lease.outbox.lease!({ limit: 1 })).map((item: OutboxEvent) => item.id), ['limited-lease-1']);
	lease.queryLimits.length = 0;
	assert.deepEqual((await lease.outbox.lease!({ limit: 1 })).map((item: OutboxEvent) => item.id), ['limited-lease-2']);
	assert.deepEqual(lease.queryLimits, [1, 1]);
});

test('store outbox normalizes malformed query results before list operations', async () => {
	let queryResult: unknown = { list: [], more: false, count: 0 };
	let listReads = 0;
	const store: StoreAdapter = {
		kind: 'outbox-malformed-query-store',
		capabilities: { transaction: false, optimisticLock: true, cursor: true },
		get: async () => null,
		getMany: async (model, ids) => ids.map(() => null),
		query: async () => queryResult as any,
		create: async () => undefined,
		update: async () => undefined,
		delete: async () => undefined
	};
	const context = createActiveTs({ stores: { default: store } });
	const outbox = new StoreOutboxAdapter({ context });

	queryResult = Object.defineProperty({ more: false, count: 0 }, 'list', {
		enumerable: true,
		get() {
			listReads++;
			return [];
		}
	});
	await assert.rejects(() => outbox.list(), /Store outbox query result\.list must be a data property/);
	assert.equal(listReads, 0);

	queryResult = { list: [], more: 'yes', count: 0 };
	await assert.rejects(() => outbox.lease({ limit: 1 }), /Store outbox query result\.more must be a boolean/);

	queryResult = { list: [], more: false, count: 0, totla: 0 };
	await assert.rejects(() => outbox.drain({ limit: 1 }), /Store outbox query result contains unknown option "totla"/);
});

test('store outbox declares field types for portable list ordering', async () => {
	const backing = new MemoryStoreAdapter();
	const seenSortTypes: Array<[string, unknown]> = [];
	const store: StoreAdapter = {
		kind: 'sort-typed-outbox-store',
		capabilities: { ...backing.capabilities },
		get: (model, id, options) => backing.get(model, id, options),
		getMany: (model, ids, options) => backing.getMany(model, ids, options),
		query: async (model, plan, options) => {
			for (const sort of plan.sort) {
				if (sort.field === model.idField) continue;
				seenSortTypes.push([sort.field, model.fieldTypes.get(sort.field)]);
			}
			return await backing.query(model, plan, options);
		},
		aggregate: (model, plan) => backing.aggregate(model, plan),
		create: (model, id, data) => backing.create(model, id, data),
		update: (model, id, data, options) => backing.update(model, id, data, options),
		delete: (model, id, options) => backing.delete(model, id, options),
		transaction: (callback, options) => backing.transaction!(callback, options),
		schema: backing.schema
	};
	const context = createActiveTs({ stores: { default: store } });
	const outbox = new StoreOutboxAdapter({ context });
	await outbox.append({
		id: 'typed-sort-event',
		model: 'outbox_transaction_account',
		modelId: 1,
		operation: 'create',
		data: { id: 1, handle: 'typed-sort' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});

	assert.deepEqual((await outbox.list()).map((event) => event.id), ['typed-sort-event']);
	assert.deepEqual(seenSortTypes, [
		['createdAt', 'string'],
		['sequence', 'string']
	]);
});

test('store outbox ignores datastore entity-key markers on persisted event rows', async () => {
	const backing = new MemoryStoreAdapter();
	const markEntityKey = (row: any) => {
		if (row === null || row === undefined) return row;
		const clone = { ...row };
		Object.defineProperty(clone, ACTIVE_TS_ENTITY_KEY, {
			value: { path: ['active_ts_outbox_event', row.id] },
			enumerable: false
		});
		return clone;
	};
	const store: StoreAdapter = {
		kind: 'entity-key-marked-outbox-store',
		capabilities: { ...backing.capabilities, optimisticLock: false, transaction: false },
		get: async (model, id, options) => markEntityKey(await backing.get(model, id, options)),
		getMany: async (model, ids, options) => (await backing.getMany(model, ids, options)).map(markEntityKey),
		query: async (model, plan, options) => {
			const result = await backing.query(model, plan, options);
			return { ...result, list: result.list.map(markEntityKey) };
		},
		aggregate: (model, plan) => backing.aggregate(model, plan),
		create: (model, id, data) => backing.create(model, id, data),
		update: (model, id, data, options) => backing.update(model, id, data, options),
		delete: (model, id, options) => backing.delete(model, id, options),
		schema: backing.schema
	};
	const context = createActiveTs({ stores: { default: store } });
	const outbox = new StoreOutboxAdapter({ context });
	await outbox.append({
		id: 'entity-key-marked-event',
		model: 'outbox_transaction_account',
		modelId: 1,
		operation: 'create',
		data: { id: 1, handle: 'entity-key-marked' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});

	const listed = await outbox.list();
	assert.deepEqual(listed.map((event) => event.id), ['entity-key-marked-event']);
	await outbox.ack!([listed[0]]);

	assert.deepEqual(await outbox.list(), []);
});

test('store outbox uses Datastore transactions for leases while keeping drain management outside them', async () => {
	const backing = new MemoryStoreAdapter();
	let transactionCalls = 0;
	const store: StoreAdapter = {
		kind: 'datastore',
		capabilities: { ...backing.capabilities, optimisticLock: false, transaction: true },
		get: (model, id, options) => backing.get(model, id, options),
		getMany: (model, ids, options) => backing.getMany(model, ids, options),
		query: (model, plan, options) => backing.query(model, plan, options),
		aggregate: (model, plan) => backing.aggregate(model, plan),
		create: (model, id, data) => backing.create(model, id, data),
		update: (model, id, data, options) => backing.update(model, id, data, options),
		delete: (model, id, options) => backing.delete(model, id, options),
		transaction: async (callback, options) => {
			transactionCalls++;
			return await backing.transaction(callback, options);
		},
		schema: backing.schema
	};
	const context = createActiveTs({ stores: { default: store } });
	const outbox = new StoreOutboxAdapter({ context });
	const event = {
		model: 'outbox_transaction_account',
		modelId: 1,
		operation: 'create' as const,
		data: { id: 1, handle: 'datastore-outbox' },
		createdAt: '2026-05-13T00:00:00.000Z'
	};
	await outbox.append({ ...event, id: 'datastore-outbox-ack' });
	assert.equal(outbox.supportsExclusiveLease(), true);
	const leased = await outbox.lease!({ limit: 1 });
	assert.deepEqual(leased.map((item) => item.id), ['datastore-outbox-ack']);
	await outbox.ack!(leased);
	await outbox.requeue([{ ...event, id: 'datastore-outbox-drain' }]);

	assert.deepEqual((await outbox.drain()).map((item) => item.id), ['datastore-outbox-drain']);
	assert.equal(transactionCalls, 2);
});

test('store outbox treats Datastore transaction aborts as lost lease races', async () => {
	const backing = new MemoryStoreAdapter();
	let abortClaim = true;
	const store: StoreAdapter = {
		kind: 'datastore',
		capabilities: { ...backing.capabilities, optimisticLock: false, transaction: true },
		get: (model, id, options) => backing.get(model, id, options),
		getMany: (model, ids, options) => backing.getMany(model, ids, options),
		query: (model, plan, options) => backing.query(model, plan, options),
		aggregate: (model, plan) => backing.aggregate(model, plan),
		create: (model, id, data, options) => backing.create(model, id, data, options),
		update: (model, id, data, options) => backing.update(model, id, data, options),
		delete: (model, id, options) => backing.delete(model, id, options),
		transaction: async (callback, options) => backing.transaction(async (tx) => {
			const result = await callback(tx);
			if (abortClaim) {
				throw Object.assign(new Error('Datastore transaction aborted'), { code: 10 });
			}
			return result;
		}, options),
		schema: backing.schema
	};
	const context = createActiveTs({ stores: { default: store } });
	const outbox = new StoreOutboxAdapter({ context });
	await outbox.append({
		id: 'datastore-aborted-lease',
		model: 'outbox_transaction_account',
		modelId: 1,
		operation: 'create',
		data: { id: 1, handle: 'aborted' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});

	assert.deepEqual(await outbox.lease!({ limit: 1 }), []);
	assert.equal((await outbox.list())[0].leaseToken, undefined);

	abortClaim = false;
	const leased = await outbox.lease!({ limit: 1 });
	assert.deepEqual(leased.map((event) => event.id), ['datastore-aborted-lease']);
});

test('store outbox isolates transaction-backed release and ack operations per event', async () => {
	const backing = new MemoryStoreAdapter();
	const transactionWriteCounts: number[] = [];
	const store: StoreAdapter = {
		kind: 'datastore',
		capabilities: { ...backing.capabilities, optimisticLock: false, transaction: true },
		get: (model, id, options) => backing.get(model, id, options),
		getMany: (model, ids, options) => backing.getMany(model, ids, options),
		query: (model, plan, options) => backing.query(model, plan, options),
		aggregate: (model, plan) => backing.aggregate(model, plan),
		create: (model, id, data, options) => backing.create(model, id, data, options),
		update: (model, id, data, options) => backing.update(model, id, data, options),
		delete: (model, id, options) => backing.delete(model, id, options),
		transaction: async (callback, options) => backing.transaction(async (tx) => {
			let writes = 0;
			const observedTx: StoreAdapter = {
				kind: tx.kind,
				cacheScope: tx.cacheScope,
				datastoreNamespace: tx.datastoreNamespace,
				datastoreProjectId: tx.datastoreProjectId,
				datastoreDatabaseId: tx.datastoreDatabaseId,
				datastoreKeyEncoding: tx.datastoreKeyEncoding,
				capabilities: { ...tx.capabilities, transaction: false, savepoint: false },
				get: (...args) => tx.get(...args),
				getMany: (...args) => tx.getMany(...args),
				query: (...args) => tx.query(...args),
				aggregate: tx.aggregate ? (...args) => tx.aggregate!(...args) : undefined,
				create: (...args) => tx.create(...args),
				update: async (...args) => {
					writes++;
					return await tx.update(...args);
				},
				delete: async (...args) => {
					writes++;
					return await tx.delete(...args);
				}
			};
			try {
				return await callback(observedTx);
			} finally {
				transactionWriteCounts[transactionWriteCounts.length] = writes;
			}
		}, options),
		schema: backing.schema
	};
	const context = createActiveTs({ stores: { default: store } });
	const outbox = new StoreOutboxAdapter({ context });
	const event = {
		model: 'outbox_transaction_account',
		operation: 'create' as const,
		createdAt: '2026-05-13T00:00:00.000Z'
	};
	await outbox.append({ ...event, id: 'isolated-release-1', modelId: 1 });
	await outbox.append({ ...event, id: 'isolated-release-2', modelId: 2 });

	const firstLease = await outbox.lease!();
	await outbox.release!(firstLease);
	const secondLease = await outbox.lease!();
	await outbox.ack!(secondLease);

	assert.deepEqual(transactionWriteCounts, [1, 1, 1, 1, 1, 1, 1, 1]);
	assert.deepEqual(await outbox.list(), []);
});

test('store outbox transaction ack preserves later repair after source ownership loss', async () => {
	const context = createActiveTs({ stores: { default: createDatastoreKindMemoryStore() } });
	const outbox = new StoreOutboxAdapter({ context });
	await outbox.append({
		id: 'lost-source-before-repair-ack',
		model: 'outbox_transaction_account',
		modelId: 81,
		operation: 'update',
		data: { id: 81, handle: 'possibly applied' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});
	const [leased] = await outbox.lease!({ limit: 1 });
	const repair = await outbox.append({
		id: 'repair-after-lost-source',
		model: 'outbox_transaction_account',
		modelId: 81,
		operation: 'update',
		reconcileFromStore: true,
		createdAt: '2026-05-13T00:00:00.000Z'
	});
	await outbox.release!([leased]);

	assert.equal(await outbox.ack!([leased, repair!]), false);
	assert.deepEqual(
		(await outbox.list()).map((event) => event.id),
		['lost-source-before-repair-ack', 'repair-after-lost-source']
	);
});

test('store outbox lease keeps events visible until ack', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const outbox = new StoreOutboxAdapter({ context });
	await outbox.append({
		id: 'leased-event',
		model: 'outbox_transaction_account',
		modelId: 1,
		operation: 'create',
		data: { id: 1, handle: 'leased' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});

	const leased = await outbox.lease!();

	assert.deepEqual(leased.map((event) => event.id), ['leased-event']);
	assert.deepEqual((await outbox.list()).map((event) => event.id), ['leased-event']);

	await outbox.ack!([leased[0]]);

	assert.deepEqual(await outbox.list(), []);
});

test('store outbox renews an owned lease without accepting the stale snapshot', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const outbox = new StoreOutboxAdapter({ context });
	await outbox.append({
		id: 'renewed-lease-event',
		model: 'outbox_transaction_account',
		modelId: 1,
		operation: 'create',
		data: { id: 1, handle: 'renewed' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});

	const [leased] = await outbox.lease!();
	await new Promise((resolve) => setTimeout(resolve, 2));
	const renewed = await outbox.renewLease!(leased);

	assert.ok(renewed);
	assert.equal(renewed.leaseToken, leased.leaseToken);
	assert.equal(renewed.version, (leased.version ?? 0) + 1);
	assert.ok(Date.parse(renewed.leaseExpiresAt!) > Date.parse(leased.leaseExpiresAt!));
	assert.equal(await outbox.isLeaseCurrent!(leased), false);
	assert.equal(await outbox.isLeaseCurrent!(renewed), true);
	await outbox.ack!([renewed]);
	assert.deepEqual(await outbox.list(), []);
});

test('store outbox ack does not pass expectedVersion to stores without optimistic locks', async () => {
	const backing = new MemoryStoreAdapter();
	const store: StoreAdapter = {
		kind: 'non-optimistic-outbox-ack-store',
		capabilities: { ...backing.capabilities, optimisticLock: false },
		get: (model, id, options) => backing.get(model, id, options),
		getMany: (model, ids, options) => backing.getMany(model, ids, options),
		query: (model, plan, options) => backing.query(model, plan, options),
		aggregate: (model, plan) => backing.aggregate(model, plan),
		create: (model, id, data) => backing.create(model, id, data),
		update: (model, id, data, options) => backing.update(model, id, data, options),
		delete: async (model, id, options) => {
			if (options && 'expectedVersion' in options) {
				throw new Error('non-optimistic store received expectedVersion');
			}
			await backing.delete(model, id, options);
		},
		transaction: (callback, options) => backing.transaction!(callback, options)
	};
	const context = createActiveTs({ stores: { default: store } });
	const outbox = new StoreOutboxAdapter({ context });
	await outbox.append({
		id: 'non-optimistic-ack-event',
		model: 'outbox_transaction_account',
		modelId: 1,
		operation: 'create',
		data: { id: 1, handle: 'acked' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});

	await outbox.ack!(await outbox.list());

	assert.deepEqual(await outbox.list(), []);
});

test('store outbox leases are exclusive until release or ack', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const outbox = new StoreOutboxAdapter({ context });
	await outbox.append({
		id: 'exclusive-first-event',
		model: 'outbox_transaction_account',
		modelId: 1,
		operation: 'create',
		data: { id: 1, handle: 'first' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});
	await outbox.append({
		id: 'exclusive-second-event',
		model: 'outbox_transaction_account',
		modelId: 2,
		operation: 'create',
		data: { id: 2, handle: 'second' },
		createdAt: '2026-05-13T00:00:01.000Z'
	});

	const firstLease = await outbox.lease!();

	assert.deepEqual(firstLease.map((event) => event.id), ['exclusive-first-event', 'exclusive-second-event']);
	assert.deepEqual(await outbox.lease!(), []);

	await outbox.release!(firstLease);
	const secondLease = await outbox.lease!();

	assert.deepEqual(secondLease.map((event) => event.id), ['exclusive-first-event', 'exclusive-second-event']);
	await outbox.ack!(secondLease);
	assert.deepEqual(await outbox.list(), []);
});

test('store outbox lease preserves per-entity order while earlier event is leased', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const outbox = new StoreOutboxAdapter({ context });
	await outbox.append({
		id: 'entity-order-old-event',
		model: 'outbox_transaction_account',
		modelId: 1,
		operation: 'update',
		data: { id: 1, handle: 'old' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});
	await outbox.append({
		id: 'entity-order-new-event',
		model: 'outbox_transaction_account',
		modelId: 1,
		operation: 'update',
		data: { id: 1, handle: 'new' },
		createdAt: '2026-05-13T00:00:01.000Z'
	});
	await outbox.append({
		id: 'entity-order-other-event',
		model: 'outbox_transaction_account',
		modelId: 2,
		operation: 'update',
		data: { id: 2, handle: 'other' },
		createdAt: '2026-05-13T00:00:02.000Z'
	});

	const [firstLease] = await outbox.lease!({ limit: 1 });
	assert.equal(firstLease.id, 'entity-order-old-event');

	const secondLease = await outbox.lease!({ limit: 10 });
	assert.deepEqual(secondLease.map((event) => event.id), ['entity-order-other-event']);

	await outbox.ack!([firstLease]);
	const thirdLease = await outbox.lease!({ limit: 10 });
	assert.deepEqual(thirdLease.map((event) => event.id), ['entity-order-new-event']);
});

test('store outbox drain preserves per-entity order while earlier event is leased', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const outbox = new StoreOutboxAdapter({ context });
	await outbox.append({
		id: 'drain-order-old-event',
		model: 'outbox_transaction_account',
		modelId: 1,
		operation: 'update',
		data: { id: 1, handle: 'old' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});
	await outbox.append({
		id: 'drain-order-new-event',
		model: 'outbox_transaction_account',
		modelId: 1,
		operation: 'update',
		data: { id: 1, handle: 'new' },
		createdAt: '2026-05-13T00:00:01.000Z'
	});
	await outbox.append({
		id: 'drain-order-other-event',
		model: 'outbox_transaction_account',
		modelId: 2,
		operation: 'update',
		data: { id: 2, handle: 'other' },
		createdAt: '2026-05-13T00:00:02.000Z'
	});

	const [firstLease] = await outbox.lease!({ limit: 1 });
	assert.equal(firstLease.id, 'drain-order-old-event');

	const drainedWhileLeased = await outbox.drain!({ limit: 10 });
	assert.deepEqual(drainedWhileLeased.map((event) => event.id), ['drain-order-other-event']);

	await outbox.ack!([firstLease]);
	const drainedAfterAck = await outbox.drain!({ limit: 10 });
	assert.deepEqual(drainedAfterAck.map((event) => event.id), ['drain-order-new-event']);
});

test('store outbox lease scopes entity ordering by Datastore ancestor without modelIdentity', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const outbox = new StoreOutboxAdapter({ context });
	const left = datastoreKey('outbox_transaction_parent', 10);
	const right = datastoreKey('outbox_transaction_parent', 11);
	await outbox.append({
		id: 'datastore-order-left-old-event',
		model: 'outbox_transaction_account',
		modelId: 1,
		modelDatastoreAncestor: left,
		operation: 'update',
		createdAt: '2026-05-13T00:00:00.000Z'
	});
	await outbox.append({
		id: 'datastore-order-left-new-event',
		model: 'outbox_transaction_account',
		modelId: 1,
		modelDatastoreAncestor: left,
		operation: 'update',
		createdAt: '2026-05-13T00:00:01.000Z'
	});
	await outbox.append({
		id: 'datastore-order-right-event',
		model: 'outbox_transaction_account',
		modelId: 1,
		modelDatastoreAncestor: right,
		operation: 'update',
		createdAt: '2026-05-13T00:00:02.000Z'
	});

	const [firstLease] = await outbox.lease!({ limit: 1 });
	assert.equal(firstLease.id, 'datastore-order-left-old-event');

	const secondLease = await outbox.lease!({ limit: 10 });
	assert.deepEqual(secondLease.map((event) => event.id), ['datastore-order-right-event']);

	await outbox.ack!([firstLease]);
	const thirdLease = await outbox.lease!({ limit: 10 });
	assert.deepEqual(thirdLease.map((event) => event.id), ['datastore-order-left-new-event']);
});

test('store outbox drain scopes entity ordering by Datastore ancestor without modelIdentity', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const outbox = new StoreOutboxAdapter({ context });
	const left = datastoreKey('outbox_transaction_parent', 10);
	const right = datastoreKey('outbox_transaction_parent', 11);
	await outbox.append({
		id: 'datastore-drain-left-old-event',
		model: 'outbox_transaction_account',
		modelId: 1,
		modelDatastoreAncestor: left,
		operation: 'update',
		createdAt: '2026-05-13T00:00:00.000Z'
	});
	await outbox.append({
		id: 'datastore-drain-left-new-event',
		model: 'outbox_transaction_account',
		modelId: 1,
		modelDatastoreAncestor: left,
		operation: 'update',
		createdAt: '2026-05-13T00:00:01.000Z'
	});
	await outbox.append({
		id: 'datastore-drain-right-event',
		model: 'outbox_transaction_account',
		modelId: 1,
		modelDatastoreAncestor: right,
		operation: 'update',
		createdAt: '2026-05-13T00:00:02.000Z'
	});

	const [firstLease] = await outbox.lease!({ limit: 1 });
	assert.equal(firstLease.id, 'datastore-drain-left-old-event');

	const drainedWhileLeased = await outbox.drain!({ limit: 10 });
	assert.deepEqual(drainedWhileLeased.map((event) => event.id), ['datastore-drain-right-event']);

	await outbox.ack!([firstLease]);
	const drainedAfterAck = await outbox.drain!({ limit: 10 });
	assert.deepEqual(drainedAfterAck.map((event) => event.id), ['datastore-drain-left-new-event']);
});

test('store outbox lease scopes mixed Datastore modelIdentity and ancestor ordering together', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const outbox = new StoreOutboxAdapter({ context });
	const left = datastoreKey('outbox_transaction_parent', 10);
	const right = datastoreKey('outbox_transaction_parent', 11);
	await outbox.append({
		id: 'datastore-mixed-left-legacy-event',
		model: 'outbox_transaction_account',
		modelId: 1,
		modelDatastoreAncestor: left,
		operation: 'update',
		createdAt: '2026-05-13T00:00:00.000Z'
	});
	await outbox.append({
		id: 'datastore-mixed-left-current-event',
		model: 'outbox_transaction_account',
		modelId: 1,
		modelIdentity: 'datastore-current-left',
		modelDatastoreAncestor: left,
		operation: 'update',
		createdAt: '2026-05-13T00:00:01.000Z'
	});
	await outbox.append({
		id: 'datastore-mixed-right-event',
		model: 'outbox_transaction_account',
		modelId: 1,
		modelIdentity: 'datastore-current-right',
		modelDatastoreAncestor: right,
		operation: 'update',
		createdAt: '2026-05-13T00:00:02.000Z'
	});

	const [firstLease] = await outbox.lease!({ limit: 1 });
	assert.equal(firstLease.id, 'datastore-mixed-left-legacy-event');

	const secondLease = await outbox.lease!({ limit: 10 });
	assert.deepEqual(secondLease.map((event) => event.id), ['datastore-mixed-right-event']);

	await outbox.ack!([firstLease]);
	const thirdLease = await outbox.lease!({ limit: 10 });
	assert.deepEqual(thirdLease.map((event) => event.id), ['datastore-mixed-left-current-event']);
});

test('store outbox lease keeps ancestor ordering for Datastore-prefixed custom identities', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const outbox = new StoreOutboxAdapter({ context });
	const left = datastoreKey('outbox_transaction_parent', 10);
	const right = datastoreKey('outbox_transaction_parent', 11);
	await outbox.append({
		id: 'datastore-custom-identity-left-old-event',
		model: 'outbox_transaction_account',
		modelId: 1,
		modelDatastoreAncestor: left,
		operation: 'update',
		createdAt: '2026-05-13T00:00:00.000Z'
	});
	await outbox.append({
		id: 'datastore-custom-identity-left-current-event',
		model: 'outbox_transaction_account',
		modelId: 1,
		modelIdentity: 'datastore:foo',
		modelDatastoreAncestor: left,
		operation: 'update',
		createdAt: '2026-05-13T00:00:01.000Z'
	});
	await outbox.append({
		id: 'datastore-custom-identity-right-event',
		model: 'outbox_transaction_account',
		modelId: 1,
		modelDatastoreAncestor: right,
		operation: 'update',
		createdAt: '2026-05-13T00:00:02.000Z'
	});

	const [firstLease] = await outbox.lease!({ limit: 1 });
	assert.equal(firstLease.id, 'datastore-custom-identity-left-old-event');

	const secondLease = await outbox.lease!({ limit: 10 });
	assert.deepEqual(secondLease.map((event) => event.id), ['datastore-custom-identity-right-event']);

	await outbox.ack!([firstLease]);
	const thirdLease = await outbox.lease!({ limit: 10 });
	assert.deepEqual(thirdLease.map((event) => event.id), ['datastore-custom-identity-left-current-event']);
});

test('store outbox lease uses model Datastore namespaces instead of the outbox store namespace', async () => {
	const modelStore = new MemoryStoreAdapter() as MemoryStoreAdapter & { datastoreNamespace: string };
	modelStore.datastoreNamespace = 'model_tenant';
	const outboxStore = new MemoryStoreAdapter() as MemoryStoreAdapter & { datastoreNamespace: string };
	outboxStore.datastoreNamespace = 'outbox_tenant';
	const context = createActiveTs({
		defaultStore: 'model',
		stores: { model: modelStore, outbox: outboxStore }
	});
	const outbox = new StoreOutboxAdapter({ context, store: 'outbox' });
	const modelLeft = datastoreKey('outbox_transaction_parent', 10, { namespace: 'model_tenant' });
	const modelRight = datastoreKey('outbox_transaction_parent', 11, { namespace: 'model_tenant' });
	await outbox.append({
		id: 'datastore-canonical-identity-old-event',
		model: 'outbox_transaction_account',
		modelId: 1,
		modelIdentity: datastoreSearchDocumentIdentity({ name: 'outbox_transaction_account' }, 1, modelLeft),
		operation: 'update',
		createdAt: '2026-05-13T00:00:00.000Z'
	});
	await outbox.append({
		id: 'datastore-canonical-model-ancestor-event',
		model: 'outbox_transaction_account',
		modelId: 1,
		modelDatastoreAncestor: modelLeft,
		operation: 'update',
		createdAt: '2026-05-13T00:00:01.000Z'
	});
	await outbox.append({
		id: 'datastore-canonical-right-event',
		model: 'outbox_transaction_account',
		modelId: 1,
		modelDatastoreAncestor: modelRight,
		operation: 'update',
		createdAt: '2026-05-13T00:00:02.000Z'
	});

	const [firstLease] = await outbox.lease!({ limit: 1 });
	assert.equal(firstLease.id, 'datastore-canonical-identity-old-event');

	const secondLease = await outbox.lease!({ limit: 10 });
	assert.deepEqual(secondLease.map((event) => event.id), ['datastore-canonical-right-event']);

	await outbox.ack!([firstLease]);
	const thirdLease = await outbox.lease!({ limit: 10 });
	assert.deepEqual(thirdLease.map((event) => event.id), ['datastore-canonical-model-ancestor-event']);
});

test('store outbox lease prefers modelIdentity over namespace-less Datastore ancestors for ordering', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const outbox = new StoreOutboxAdapter({ context });
	const model = { name: 'outbox_transaction_account' };
	const namespaceLessLeft = datastoreKey('outbox_transaction_parent', 10);
	const namespacedLeft = datastoreKey('outbox_transaction_parent', 10, { namespace: 'model_tenant' });
	const namespacedRight = datastoreKey('outbox_transaction_parent', 11, { namespace: 'model_tenant' });

	await outbox.append({
		id: 'datastore-alias-identity-old-event',
		model: model.name,
		modelId: 1,
		modelIdentity: datastoreSearchDocumentIdentity(model, 1, namespacedLeft),
		modelDatastoreAncestor: namespaceLessLeft,
		operation: 'update',
		createdAt: '2026-05-13T00:00:00.000Z'
	});
	await outbox.append({
		id: 'datastore-alias-ancestor-current-event',
		model: model.name,
		modelId: 1,
		modelDatastoreAncestor: namespacedLeft,
		operation: 'update',
		createdAt: '2026-05-13T00:00:01.000Z'
	});
	await outbox.append({
		id: 'datastore-alias-right-event',
		model: model.name,
		modelId: 1,
		modelDatastoreAncestor: namespacedRight,
		operation: 'update',
		createdAt: '2026-05-13T00:00:02.000Z'
	});

	const [firstLease] = await outbox.lease!({ limit: 1 });
	assert.equal(firstLease.id, 'datastore-alias-identity-old-event');

	const secondLease = await outbox.lease!({ limit: 10 });
	assert.deepEqual(secondLease.map((event) => event.id), ['datastore-alias-right-event']);

	await outbox.ack!([firstLease]);
	const thirdLease = await outbox.lease!({ limit: 10 });
	assert.deepEqual(thirdLease.map((event) => event.id), ['datastore-alias-ancestor-current-event']);
});

test('store outbox lease blocks namespace-less Datastore ancestors behind identity-only events', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const outbox = new StoreOutboxAdapter({ context });
	const model = { name: 'outbox_transaction_account' };
	const namespaceLessLeft = datastoreKey('outbox_transaction_parent', 10);
	const namespacedLeft = datastoreKey('outbox_transaction_parent', 10, { namespace: 'model_tenant' });

	await outbox.append({
		id: 'datastore-identity-only-old-event',
		model: model.name,
		modelId: 1,
		modelIdentity: datastoreSearchDocumentIdentity(model, 1, namespacedLeft),
		operation: 'delete',
		createdAt: '2026-05-13T00:00:00.000Z'
	});
	await outbox.append({
		id: 'datastore-namespace-less-ancestor-current-event',
		model: model.name,
		modelId: 1,
		modelDatastoreAncestor: namespaceLessLeft,
		operation: 'update',
		createdAt: '2026-05-13T00:00:01.000Z'
	});

	const [firstLease] = await outbox.lease!({ limit: 1 });
	assert.equal(firstLease.id, 'datastore-identity-only-old-event');

	const secondLease = await outbox.lease!({ limit: 10 });
	assert.deepEqual(secondLease.map((event) => event.id), []);

	await outbox.ack!([firstLease]);
	const thirdLease = await outbox.lease!({ limit: 10 });
	assert.deepEqual(thirdLease.map((event) => event.id), ['datastore-namespace-less-ancestor-current-event']);
});

test('store outbox lease blocks identity-only Datastore events behind namespace-less ancestors', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const outbox = new StoreOutboxAdapter({ context });
	const model = { name: 'outbox_transaction_account' };
	const namespaceLessLeft = datastoreKey('outbox_transaction_parent', 10);
	const namespacedLeft = datastoreKey('outbox_transaction_parent', 10, { namespace: 'model_tenant' });

	await outbox.append({
		id: 'datastore-namespace-less-ancestor-old-event',
		model: model.name,
		modelId: 1,
		modelDatastoreAncestor: namespaceLessLeft,
		operation: 'update',
		createdAt: '2026-05-13T00:00:00.000Z'
	});
	await outbox.append({
		id: 'datastore-identity-only-current-event',
		model: model.name,
		modelId: 1,
		modelIdentity: datastoreSearchDocumentIdentity(model, 1, namespacedLeft),
		operation: 'delete',
		createdAt: '2026-05-13T00:00:01.000Z'
	});

	const [firstLease] = await outbox.lease!({ limit: 1 });
	assert.equal(firstLease.id, 'datastore-namespace-less-ancestor-old-event');

	const secondLease = await outbox.lease!({ limit: 10 });
	assert.deepEqual(secondLease.map((event) => event.id), []);

	await outbox.ack!([firstLease]);
	const thirdLease = await outbox.lease!({ limit: 10 });
	assert.deepEqual(thirdLease.map((event) => event.id), ['datastore-identity-only-current-event']);
});

test('store outbox drain blocks identity-only Datastore events behind leased namespace-less ancestors', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const outbox = new StoreOutboxAdapter({ context });
	const model = { name: 'outbox_transaction_account' };
	const namespaceLessLeft = datastoreKey('outbox_transaction_parent', 10);
	const namespacedLeft = datastoreKey('outbox_transaction_parent', 10, { namespace: 'model_tenant' });

	await outbox.append({
		id: 'datastore-drain-namespace-less-ancestor-old-event',
		model: model.name,
		modelId: 1,
		modelDatastoreAncestor: namespaceLessLeft,
		operation: 'update',
		createdAt: '2026-05-13T00:00:00.000Z'
	});
	await outbox.append({
		id: 'datastore-drain-identity-only-current-event',
		model: model.name,
		modelId: 1,
		modelIdentity: datastoreSearchDocumentIdentity(model, 1, namespacedLeft),
		operation: 'delete',
		createdAt: '2026-05-13T00:00:01.000Z'
	});

	const [firstLease] = await outbox.lease!({ limit: 1 });
	assert.equal(firstLease.id, 'datastore-drain-namespace-less-ancestor-old-event');

	const drainedWhileLeased = await outbox.drain!({ limit: 10 });
	assert.deepEqual(drainedWhileLeased.map((event) => event.id), []);

	await outbox.ack!([firstLease]);
	const drainedAfterAck = await outbox.drain!({ limit: 10 });
	assert.deepEqual(drainedAfterAck.map((event) => event.id), ['datastore-drain-identity-only-current-event']);
});

test('store outbox lease propagates blocked Datastore identity aliases', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const outbox = new StoreOutboxAdapter({ context });
	const model = { name: 'outbox_transaction_account' };
	const namespaceLessLeft = datastoreKey('outbox_transaction_parent', 10);
	const namespacedLeft = datastoreKey('outbox_transaction_parent', 10, { namespace: 'model_tenant' });
	const namespacedRight = datastoreKey('outbox_transaction_parent', 11, { namespace: 'model_tenant' });
	const leftIdentity = datastoreSearchDocumentIdentity(model, 1, namespacedLeft);

	await outbox.append({
		id: 'datastore-alias-active-identity-event',
		model: model.name,
		modelId: 1,
		modelIdentity: leftIdentity,
		operation: 'update',
		createdAt: '2026-05-13T00:00:00.000Z'
	});
	await outbox.append({
		id: 'datastore-alias-bridge-event',
		model: model.name,
		modelId: 1,
		modelIdentity: leftIdentity,
		modelDatastoreAncestor: namespaceLessLeft,
		operation: 'update',
		createdAt: '2026-05-13T00:00:01.000Z'
	});
	await outbox.append({
		id: 'datastore-alias-ancestor-only-event',
		model: model.name,
		modelId: 1,
		modelDatastoreAncestor: namespaceLessLeft,
		operation: 'update',
		createdAt: '2026-05-13T00:00:02.000Z'
	});
	await outbox.append({
		id: 'datastore-alias-propagation-right-event',
		model: model.name,
		modelId: 1,
		modelDatastoreAncestor: namespacedRight,
		operation: 'update',
		createdAt: '2026-05-13T00:00:03.000Z'
	});

	const [firstLease] = await outbox.lease!({ limit: 1 });
	assert.equal(firstLease.id, 'datastore-alias-active-identity-event');

	const secondLease = await outbox.lease!({ limit: 10 });
	assert.deepEqual(secondLease.map((event) => event.id), ['datastore-alias-propagation-right-event']);

	await outbox.ack!([firstLease]);
	const thirdLease = await outbox.lease!({ limit: 10 });
	assert.deepEqual(thirdLease.map((event) => event.id), ['datastore-alias-bridge-event']);
});

test('store outbox timestamp validation and lease checks ignore patched Date.parse', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const outbox = new StoreOutboxAdapter({ context });
	const originalParse = Date.parse;
	Date.parse = () => {
		throw new Error('patched Date.parse should not run');
	};
	try {
		await outbox.append({
			id: 'date-parse-intrinsic-event',
			model: 'outbox_transaction_account',
			modelId: 1,
			operation: 'create',
			data: { id: 1, handle: 'date-parse' },
			createdAt: '2026-05-13T00:00:00.000Z'
		});
		const [leased] = await outbox.lease!({ limit: 1 });

		assert.equal(await outbox.isLeaseCurrent!(leased), true);
		assert.deepEqual(await outbox.lease!({ limit: 1 }), []);
	} finally {
		Date.parse = originalParse;
	}
});

test('store outbox ack does not delete rows whose lease changed after verification', async () => {
	const backing = new MemoryStoreAdapter();
	let mutatedLease = false;
	const store: StoreAdapter = {
		kind: 'outbox-ack-conditional-delete-store',
		capabilities: { ...backing.capabilities, transaction: false },
		get: (model, id, options) => backing.get(model, id, options),
		getMany: (model, ids, options) => backing.getMany(model, ids, options),
		query: (model, plan, options) => backing.query(model, plan, options),
		aggregate: (model, plan) => backing.aggregate(model, plan),
		create: (model, id, data) => backing.create(model, id, data),
		update: (model, id, data, options) => backing.update(model, id, data, options),
		delete: async (model, id, options) => {
			if (!mutatedLease && model.name === 'active_ts_outbox_event') {
				const current = await backing.get(model, id);
				if (current) {
					mutatedLease = true;
					await backing.update(
						model,
						id,
						{
							...current,
							version: current.version + 1,
							leaseToken: 'fresh-worker',
							leaseExpiresAt: '2999-01-01T00:00:00.000Z'
						},
						{ expectedVersion: current.version }
					);
				}
			}
			await backing.delete(model, id, options);
		}
	};
	const context = createActiveTs({ stores: { default: store } });
	const outbox = new StoreOutboxAdapter({ context });
	await outbox.append({
		id: 'ack-raced-lease-event',
		model: 'outbox_transaction_account',
		modelId: 1,
		operation: 'create',
		data: { id: 1, handle: 'raced' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});
	const leased = await outbox.lease!();

	await outbox.ack!(leased);

	const remaining = await outbox.list();
	assert.equal(mutatedLease, true);
	assert.equal(remaining.length, 1);
	assert.equal(remaining[0].id, 'ack-raced-lease-event');
	assert.equal(remaining[0].leaseToken, 'fresh-worker');
});

test('store outbox rejects fetched rows with mismatched event ids before ack or release', async () => {
	const wrongEvent = {
		id: 'wrong-outbox-event',
		model: 'outbox_transaction_account',
		modelId: 1,
		operation: 'update' as const,
		data: { id: 1, handle: 'wrong' },
		createdAt: '2026-05-13T00:00:00.000Z'
	};
	const calls = { update: 0, delete: 0 };
	const store: StoreAdapter = {
		kind: 'outbox-wrong-id-store',
		capabilities: { transaction: false, optimisticLock: true },
		get: async () => wrongEvent,
		getMany: async (model, ids) => ids.map(() => wrongEvent),
		query: async () => ({ list: [], more: false, count: 0 }),
		create: async () => undefined,
		update: async () => {
			calls.update++;
		},
		delete: async () => {
			calls.delete++;
		}
	};
	const context = createActiveTs({ stores: { default: store } });
	const outbox = new StoreOutboxAdapter({ context });
	const expectedEvent = {
		id: 'expected-outbox-event',
		model: 'outbox_transaction_account',
		modelId: 1,
		operation: 'update' as const,
		data: { id: 1, handle: 'expected' },
		createdAt: '2026-05-13T00:00:00.000Z'
	};
	const leasedEvent = {
		...expectedEvent,
		leaseToken: 'lease-token',
		leaseExpiresAt: '2999-01-01T00:00:00.000Z'
	};

	await assert.rejects(
		() => outbox.isLeaseCurrent(expectedEvent),
		/Store outbox get result id "wrong-outbox-event" does not match requested id "expected-outbox-event"/
	);
	await assert.rejects(
		() => outbox.release([leasedEvent]),
		/Store outbox get result id "wrong-outbox-event" does not match requested id "expected-outbox-event"/
	);
	await assert.rejects(
		() => outbox.ack([expectedEvent]),
		/Store outbox get result id "wrong-outbox-event" does not match requested id "expected-outbox-event"/
	);
	assert.deepEqual(calls, { update: 0, delete: 0 });
});

test('store outbox tokenless ack does not delete same-id replacements with matching versions', async () => {
	const backing = new MemoryStoreAdapter();
	const store: StoreAdapter = {
		kind: 'non-optimistic-outbox-ack-replacement-store',
		capabilities: { ...backing.capabilities, optimisticLock: false, transaction: false },
		get: (model, id, options) => backing.get(model, id, options),
		getMany: (model, ids, options) => backing.getMany(model, ids, options),
		query: (model, plan, options) => backing.query(model, plan, options),
		aggregate: (model, plan) => backing.aggregate(model, plan),
		create: (model, id, data, options) => backing.create(model, id, data, options),
		update: (model, id, data, options) => backing.update(model, id, data, options),
		delete: (model, id, options) => backing.delete(model, id, options)
	};
	const context = createActiveTs({ stores: { default: store } });
	const outbox = new StoreOutboxAdapter({ context });
	await outbox.append({
		id: 'ack-same-id-replacement',
		model: 'outbox_transaction_account',
		modelId: 1,
		operation: 'create',
		data: { id: 1, handle: 'stale' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});
	const [stale] = await outbox.list();
	const replacement = {
		...stale,
		modelId: 2,
		data: { id: 2, handle: 'replacement' },
		createdAt: '2026-05-13T00:00:01.000Z'
	};
	backing.reset('active_ts_outbox_event');
	await backing.seed('active_ts_outbox_event', [replacement]);

	await outbox.ack!([stale]);

	const remaining = await outbox.list();
	assert.equal(remaining.length, 1);
	assert.equal(remaining[0].id, 'ack-same-id-replacement');
	assert.equal(remaining[0].modelId, 2);
	assert.deepEqual(remaining[0].data, { id: 2, handle: 'replacement' });
});

test('store outbox drain does not delete same-id replacements after stale query pages', async () => {
	const backing = new MemoryStoreAdapter();
	let swapped = false;
	const store: StoreAdapter = {
		kind: 'non-optimistic-outbox-drain-replacement-store',
		capabilities: { ...backing.capabilities, optimisticLock: false, transaction: false },
		get: (model, id, options) => backing.get(model, id, options),
		getMany: (model, ids, options) => backing.getMany(model, ids, options),
		query: async (model, plan, options) => {
			const result = await backing.query(model, plan, options);
			if (!swapped && model.name === 'active_ts_outbox_event' && result.list.length) {
				swapped = true;
				const stale = result.list[0] as OutboxEvent;
				backing.reset('active_ts_outbox_event');
				await backing.seed('active_ts_outbox_event', [{
					...stale,
					modelId: 2,
					data: { id: 2, handle: 'replacement' },
					createdAt: '2026-05-13T00:00:01.000Z'
				}]);
			}
			return result;
		},
		aggregate: (model, plan) => backing.aggregate(model, plan),
		create: (model, id, data, options) => backing.create(model, id, data, options),
		update: (model, id, data, options) => backing.update(model, id, data, options),
		delete: (model, id, options) => backing.delete(model, id, options)
	};
	const context = createActiveTs({ stores: { default: store } });
	const outbox = new StoreOutboxAdapter({ context });
	await outbox.append({
		id: 'drain-same-id-replacement',
		model: 'outbox_transaction_account',
		modelId: 1,
		operation: 'create',
		data: { id: 1, handle: 'stale' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});

	const drained = await outbox.drain!();

	assert.deepEqual(drained, []);
	const remaining = await outbox.list();
	assert.equal(swapped, true);
	assert.equal(remaining.length, 1);
	assert.equal(remaining[0].id, 'drain-same-id-replacement');
	assert.equal(remaining[0].modelId, 2);
	assert.deepEqual(remaining[0].data, { id: 2, handle: 'replacement' });
});

test('store outbox drain blocks replacement entity order after stale query pages', async () => {
	const backing = new MemoryStoreAdapter();
	let swapped = false;
	const store: StoreAdapter = {
		kind: 'non-optimistic-outbox-drain-replacement-order-store',
		capabilities: { ...backing.capabilities, optimisticLock: false, transaction: false },
		get: (model, id, options) => backing.get(model, id, options),
		getMany: (model, ids, options) => backing.getMany(model, ids, options),
		query: async (model, plan, options) => {
			const result = await backing.query(model, plan, options);
			if (!swapped && model.name === 'active_ts_outbox_event' && result.list.length) {
				swapped = true;
				const stale = result.list[0] as OutboxEvent;
				const later = result.list[1] as OutboxEvent;
				backing.reset('active_ts_outbox_event');
				await backing.seed('active_ts_outbox_event', [
					{
						...stale,
						modelId: 2,
						data: { id: 2, handle: 'replacement' },
						createdAt: '2026-05-13T00:00:01.500Z'
					},
					later
				]);
			}
			return result;
		},
		aggregate: (model, plan) => backing.aggregate(model, plan),
		create: (model, id, data, options) => backing.create(model, id, data, options),
		update: (model, id, data, options) => backing.update(model, id, data, options),
		delete: (model, id, options) => backing.delete(model, id, options)
	};
	const context = createActiveTs({ stores: { default: store } });
	const outbox = new StoreOutboxAdapter({ context });
	await outbox.append({
		id: 'drain-replacement-order-old',
		model: 'outbox_transaction_account',
		modelId: 1,
		operation: 'create',
		data: { id: 1, handle: 'stale' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});
	await outbox.append({
		id: 'drain-replacement-order-later',
		model: 'outbox_transaction_account',
		modelId: 2,
		operation: 'update',
		data: { id: 2, handle: 'later' },
		createdAt: '2026-05-13T00:00:02.000Z'
	});

	const drained = await outbox.drain!();

	assert.deepEqual(drained, []);
	assert.equal(swapped, true);
	assert.deepEqual(
		(await outbox.list()).map((event) => [event.id, event.modelId, event.data?.handle]),
		[
			['drain-replacement-order-old', 2, 'replacement'],
			['drain-replacement-order-later', 2, 'later']
		]
	);
});

test('store outbox lease does not overwrite same-id replacements after stale query pages', async () => {
	const backing = new MemoryStoreAdapter();
	let swapped = false;
	const store: StoreAdapter = {
		kind: 'optimistic-outbox-lease-replacement-store',
		capabilities: { ...backing.capabilities, transaction: false },
		get: (model, id, options) => backing.get(model, id, options),
		getMany: (model, ids, options) => backing.getMany(model, ids, options),
		query: async (model, plan, options) => {
			const result = await backing.query(model, plan, options);
			if (!swapped && model.name === 'active_ts_outbox_event' && result.list.length) {
				swapped = true;
				const stale = result.list[0] as OutboxEvent;
				const later = result.list[1] as OutboxEvent;
				backing.reset('active_ts_outbox_event');
				await backing.seed('active_ts_outbox_event', [
					{
						...stale,
						modelId: 2,
						data: { id: 2, handle: 'replacement' },
						createdAt: '2026-05-13T00:00:01.000Z'
					},
					later
				]);
			}
			return result;
		},
		aggregate: (model, plan) => backing.aggregate(model, plan),
		create: (model, id, data, options) => backing.create(model, id, data, options),
		update: (model, id, data, options) => backing.update(model, id, data, options),
		delete: (model, id, options) => backing.delete(model, id, options)
	};
	const context = createActiveTs({ stores: { default: store } });
	const outbox = new StoreOutboxAdapter({ context });
	await outbox.append({
		id: 'lease-same-id-replacement',
		model: 'outbox_transaction_account',
		modelId: 1,
		operation: 'create',
		data: { id: 1, handle: 'stale' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});
	await outbox.append({
		id: 'lease-replacement-later',
		model: 'outbox_transaction_account',
		modelId: 2,
		operation: 'update',
		data: { id: 2, handle: 'later' },
		createdAt: '2026-05-13T00:00:02.000Z'
	});

	const leased = await outbox.lease!();

	assert.deepEqual(leased, []);
	assert.equal(swapped, true);
	assert.deepEqual(
		(await outbox.list()).map((event) => [event.id, event.modelId, event.data?.handle, event.leaseToken]),
		[
			['lease-same-id-replacement', 2, 'replacement', undefined],
			['lease-replacement-later', 2, 'later', undefined]
		]
	);
});

test('store outbox tokenless ack cannot delete actively leased rows', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const outbox = new StoreOutboxAdapter({ context });
	await outbox.append({
		id: 'tokenless-ack-leased-event',
		model: 'outbox_transaction_account',
		modelId: 1,
		operation: 'create',
		data: { id: 1, handle: 'leased' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});
	const [tokenless] = await outbox.list();
	const [leased] = await outbox.lease!();

	assert.equal(await outbox.isLeaseCurrent!(tokenless), false);
	await outbox.ack!([tokenless]);

	const [remaining] = await outbox.list();
	assert.equal(remaining.id, 'tokenless-ack-leased-event');
	assert.equal(remaining.leaseToken, leased.leaseToken);
});

test('store outbox tokenless ack cannot delete rows after lease release', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const outbox = new StoreOutboxAdapter({ context });
	await outbox.append({
		id: 'tokenless-ack-released-event',
		model: 'outbox_transaction_account',
		modelId: 1,
		operation: 'create',
		data: { id: 1, handle: 'released' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});
	const [stale] = await outbox.list();
	const leased = await outbox.lease!();
	await outbox.release!(leased);

	assert.equal(await outbox.isLeaseCurrent!(stale), false);
	await outbox.ack!([stale]);

	const [remaining] = await outbox.list();
	assert.equal(remaining.id, 'tokenless-ack-released-event');
	assert.equal(remaining.leaseToken, undefined);
	assert.notEqual(remaining.version, stale.version);
});

test('non-transactional store outbox tokenless ack cannot delete actively leased rows', async () => {
	const backing = new MemoryStoreAdapter();
	const store: StoreAdapter = {
		kind: 'non-transactional-tokenless-ack-store',
		capabilities: { ...backing.capabilities, transaction: false },
		get: (model, id, options) => backing.get(model, id, options),
		getMany: (model, ids, options) => backing.getMany(model, ids, options),
		query: (model, plan, options) => backing.query(model, plan, options),
		aggregate: (model, plan) => backing.aggregate(model, plan),
		create: (model, id, data) => backing.create(model, id, data),
		update: (model, id, data, options) => backing.update(model, id, data, options),
		delete: (model, id, options) => backing.delete(model, id, options),
		transaction: async () => {
			throw new Error('tokenless ack fallback should not use transaction');
		}
	};
	const context = createActiveTs({ stores: { default: store } });
	const outbox = new StoreOutboxAdapter({ context });
	await outbox.append({
		id: 'non-tx-tokenless-ack-leased-event',
		model: 'outbox_transaction_account',
		modelId: 1,
		operation: 'create',
		data: { id: 1, handle: 'leased' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});
	const [tokenless] = await outbox.list();
	const [leased] = await outbox.lease!();

	assert.equal(await outbox.isLeaseCurrent!(tokenless), false);
	await outbox.ack!([tokenless]);

	const [remaining] = await outbox.list();
	assert.equal(remaining.id, 'non-tx-tokenless-ack-leased-event');
	assert.equal(remaining.leaseToken, leased.leaseToken);
});

test('store outbox drain skips actively leased rows', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const outbox = new StoreOutboxAdapter({ context });
	await outbox.append({
		id: 'drain-skips-leased-event',
		model: 'outbox_transaction_account',
		modelId: 1,
		operation: 'create',
		data: { id: 1, handle: 'leased' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});
	const [leased] = await outbox.lease!();
	await outbox.append({
		id: 'drain-keeps-unleased-event',
		model: 'outbox_transaction_account',
		modelId: 2,
		operation: 'create',
		data: { id: 2, handle: 'fresh' },
		createdAt: '2026-05-13T00:00:01.000Z'
	});

	const drained = await outbox.drain!();

	assert.deepEqual(drained.map((event: OutboxEvent) => event.id), ['drain-keeps-unleased-event']);
	const remaining = await outbox.list();
	assert.deepEqual(remaining.map((event: OutboxEvent) => event.id), ['drain-skips-leased-event']);
	assert.equal(remaining[0].leaseToken, leased.leaseToken);
});

test('store outbox drain does not delete rows leased after listing', async () => {
	const backing = new MemoryStoreAdapter();
	let mutatedLease = false;
	const store: StoreAdapter = {
		kind: 'non-transactional-drain-conditional-delete-store',
		capabilities: { ...backing.capabilities, transaction: false },
		get: (model, id, options) => backing.get(model, id, options),
		getMany: (model, ids, options) => backing.getMany(model, ids, options),
		query: (model, plan, options) => backing.query(model, plan, options),
		aggregate: (model, plan) => backing.aggregate(model, plan),
		create: (model, id, data) => backing.create(model, id, data),
		update: (model, id, data, options) => backing.update(model, id, data, options),
		delete: async (model, id, options) => {
			if (!mutatedLease && model.name === 'active_ts_outbox_event') {
				const current = await backing.get(model, id);
				if (current) {
					mutatedLease = true;
					await backing.update(
						model,
						id,
						{
							...current,
							version: current.version + 1,
							leaseToken: 'fresh-drain-worker',
							leaseExpiresAt: '2999-01-01T00:00:00.000Z'
						},
						{ expectedVersion: current.version }
					);
				}
			}
			await backing.delete(model, id, options);
		}
	};
	const context = createActiveTs({ stores: { default: store } });
	const outbox = new StoreOutboxAdapter({ context });
	await outbox.append({
		id: 'drain-raced-lease-event',
		model: 'outbox_transaction_account',
		modelId: 1,
		operation: 'create',
		data: { id: 1, handle: 'raced' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});

	const drained = await outbox.drain!();

	assert.deepEqual(drained, []);
	const remaining = await outbox.list();
	assert.equal(mutatedLease, true);
	assert.equal(remaining.length, 1);
	assert.equal(remaining[0].id, 'drain-raced-lease-event');
	assert.equal(remaining[0].leaseToken, 'fresh-drain-worker');
});

test('store outbox lease releases already claimed rows when a later claim fails', async () => {
	const backing = new MemoryStoreAdapter();
	const store: StoreAdapter = {
		kind: 'partial-lease-claim-failure-store',
		capabilities: { ...backing.capabilities, transaction: false },
		get: (model, id, options) => backing.get(model, id, options),
		getMany: (model, ids, options) => backing.getMany(model, ids, options),
		query: (model, plan, options) => backing.query(model, plan, options),
		aggregate: (model, plan) => backing.aggregate(model, plan),
		create: (model, id, data) => backing.create(model, id, data),
		update: async (model, id, data, options) => {
			if (model.name === 'active_ts_outbox_event' && id === 'lease-second-claim-fails' && data.leaseToken !== undefined) {
				throw new Error('lease update lost');
			}
			await backing.update(model, id, data, options);
		},
		delete: (model, id, options) => backing.delete(model, id, options),
		transaction: async () => {
			throw new Error('lease fallback should not use transaction');
		}
	};
	const context = createActiveTs({ stores: { default: store } });
	const outbox = new StoreOutboxAdapter({ context });
	await outbox.append({
		id: 'lease-first-claimed-event',
		model: 'outbox_transaction_account',
		modelId: 1,
		operation: 'create',
		data: { id: 1, handle: 'first' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});
	await outbox.append({
		id: 'lease-second-claim-fails',
		model: 'outbox_transaction_account',
		modelId: 2,
		operation: 'create',
		data: { id: 2, handle: 'second' },
		createdAt: '2026-05-13T00:00:01.000Z'
	});

	await assert.rejects(
		() => outbox.lease!(),
		/lease update lost/
	);

	const remaining = await outbox.list();
	assert.deepEqual(
		remaining.map((event) => [event.id, event.leaseToken]),
		[
			['lease-first-claimed-event', undefined],
			['lease-second-claim-fails', undefined]
		]
	);
});

test('non-transactional store outbox ack restores deleted events on failure', async () => {
	const backing = new MemoryStoreAdapter();
	const store: StoreAdapter = {
		kind: 'non-transactional-outbox-ack-store',
		capabilities: { ...backing.capabilities, transaction: false },
		get: (model, id, options) => backing.get(model, id, options),
		getMany: (model, ids, options) => backing.getMany(model, ids, options),
		query: (model, plan, options) => backing.query(model, plan, options),
		aggregate: (model, plan) => backing.aggregate(model, plan),
		create: (model, id, data) => backing.create(model, id, data),
		update: (model, id, data, options) => backing.update(model, id, data, options),
		delete: async (model, id) => {
			await backing.delete(model, id);
			if (id === 'ack-second-event') throw new Error('ack delete lost');
		},
		transaction: async () => {
			throw new Error('ack fallback should not use transaction');
		}
	};
	const context = createActiveTs({ stores: { default: store } });
	const outbox = new StoreOutboxAdapter({ context });
	await outbox.append({
		id: 'ack-first-event',
		model: 'outbox_transaction_account',
		modelId: 1,
		operation: 'create',
		data: { id: 1, handle: 'first' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});
	await outbox.append({
		id: 'ack-second-event',
		model: 'outbox_transaction_account',
		modelId: 2,
		operation: 'create',
		data: { id: 2, handle: 'second' },
		createdAt: '2026-05-13T00:00:01.000Z'
	});
	const leased = await outbox.lease!();

	await assert.rejects(
		() => outbox.ack!(leased),
		/ack delete lost/
	);

	assert.deepEqual((await outbox.list()).map((event) => event.id), ['ack-first-event', 'ack-second-event']);
});

test('store outbox search sync preserves repair after an index applies then rejects', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const outbox = new StoreOutboxAdapter({ context });
	const indexed: string[] = [];
	let repairVisibleAfterRemoteWrite = false;
	const search = {
		kind: 'memory',
		capabilities: { index: true },
		search: async () => ({ list: [], more: false }),
		index: async (_model: unknown, _id: unknown, data: any) => {
			indexed.push(data.handle);
			if (data.handle === 'second') {
				repairVisibleAfterRemoteWrite = (await outbox.list()).some((event) =>
					event.modelId === 2 && event.reconcileFromStore === true
				);
				throw new Error('index unavailable');
			}
		},
		delete: async () => undefined
	} satisfies SearchAdapter;
	await outbox.append({
		id: 'leased-first-event',
		model: 'outbox_transaction_account',
		modelId: 1,
		operation: 'create',
		data: { id: 1, handle: 'first' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});
	await outbox.append({
		id: 'leased-second-event',
		model: 'outbox_transaction_account',
		modelId: 2,
		operation: 'create',
		data: { id: 2, handle: 'second' },
		createdAt: '2026-05-13T00:00:01.000Z'
	});

	await assert.rejects(
		() => runSearchSyncWorker({ outbox, search, models: [OutboxAccount], context }),
		/index unavailable/
	);

	assert.deepEqual(indexed, ['first', 'second']);
	assert.equal(repairVisibleAfterRemoteWrite, true);
	const failedPending = await outbox.list();
	assert.equal(failedPending.length, 2);
	assert.equal(failedPending[0].id, 'leased-second-event');
	assert.equal(failedPending[0].deliveryAttempts, 1);
	assert.equal(failedPending[1].modelId, 2);
	assert.equal(failedPending[1].reconcileFromStore, true);
	assert.equal(failedPending[1].data, undefined);

	const recoveredSearch = {
		kind: 'memory',
		capabilities: { index: true },
		search: async () => ({ list: [], more: false }),
		index: async (_model: unknown, _id: unknown, data: any) => {
			indexed.push(data.handle);
		},
		delete: async () => undefined
	} satisfies SearchAdapter;

	assert.equal(await runSearchSyncWorker({ outbox, search: recoveredSearch, models: [OutboxAccount], context }), 1);
	assert.deepEqual(indexed, ['first', 'second', 'second']);
	const [durableRepair] = await outbox.list();
	assert.equal(durableRepair.reconcileFromStore, true);
	assert.equal(durableRepair.modelId, 2);
	assert.equal(await runSearchSyncWorker({ outbox, search: recoveredSearch, models: [OutboxAccount], context }), 1);
	assert.deepEqual(await outbox.list(), []);
});

test('store outbox search sync preserves repair after a delete applies then rejects', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const Account = OutboxAccount.use(context) as unknown as typeof OutboxAccount;
	const outbox = new StoreOutboxAdapter({ context });
	let indexedHandle: string | undefined = 'stale document';
	let rejectDelete = true;
	const search = {
		kind: 'memory',
		capabilities: { index: true },
		search: async () => ({ list: [], more: false }),
		index: async (_model: unknown, _id: unknown, data: OutboxAccountData) => {
			indexedHandle = data.handle;
		},
		delete: async () => {
			indexedHandle = undefined;
			if (rejectDelete) {
				rejectDelete = false;
				throw new Error('delete response lost');
			}
		}
	} satisfies SearchAdapter;

	await Account.create({ id: 52, handle: 'authoritative' });
	await outbox.append({
		id: 'delete-applied-before-reject',
		model: 'outbox_transaction_account',
		modelId: 52,
		operation: 'delete',
		createdAt: '2026-05-13T00:00:02.000Z'
	});

	await assert.rejects(
		() => runSearchSyncWorker({ outbox, search, models: [OutboxAccount], context }),
		/delete response lost/
	);
	assert.equal(indexedHandle, undefined);
	const failedPending = await outbox.list();
	assert.equal(failedPending.length, 2);
	assert.equal(failedPending[0].id, 'delete-applied-before-reject');
	assert.equal(failedPending[1].reconcileFromStore, true);

	assert.equal(await runSearchSyncWorker({ outbox, search, models: [OutboxAccount], context }), 1);
	assert.equal(indexedHandle, undefined);
	assert.equal((await outbox.list())[0].reconcileFromStore, true);
	assert.equal(await runSearchSyncWorker({ outbox, search, models: [OutboxAccount], context }), 1);
	assert.equal(indexedHandle, 'authoritative');
	assert.deepEqual(await outbox.list(), []);
});

test('store outbox search sync skips stale leased events before indexing', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const outbox = new StoreOutboxAdapter({ context });
	let indexed = 0;
	const search = {
		kind: 'memory',
		capabilities: { index: true },
		search: async () => ({ list: [], more: false }),
		index: async () => {
			indexed++;
		},
		delete: async () => undefined
	} satisfies SearchAdapter;
	await outbox.append({
		id: 'stale-lease-event',
		model: 'outbox_transaction_account',
		modelId: 1,
		operation: 'create',
		data: { id: 1, handle: 'stale' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});

	const staleLease = await outbox.lease!();
	await outbox.release!(staleLease);
	const freshLease = await outbox.lease!();
	await outbox.ack!(freshLease);
	const staleOutbox = {
		append: (event: any) => outbox.append(event),
		lease: async () => staleLease,
		isLeaseCurrent: (event: any) => outbox.isLeaseCurrent!(event),
		release: (events: any) => outbox.release!(events),
		retry: (failures: any) => outbox.retry!(failures),
		ack: (events: any) => outbox.ack!(events)
	};

	assert.equal(await runSearchSyncWorker({ outbox: staleOutbox, search, models: [OutboxAccount], context }), 0);
	assert.equal(indexed, 0);
});

test('store outbox search sync rechecks leased events immediately before indexing', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const outbox = new StoreOutboxAdapter({ context });
	let leaseChecks = 0;
	let indexed = 0;
	const search = {
		kind: 'memory',
		capabilities: { index: true },
		search: async () => ({ list: [], more: false }),
		index: async () => {
			indexed++;
		},
		delete: async () => undefined
	} satisfies SearchAdapter;
	await outbox.append({
		id: 'lease-stale-before-index',
		model: 'outbox_transaction_account',
		modelId: 1,
		operation: 'create',
		data: { id: 1, handle: 'stale-before-index' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});
	const leased = await outbox.lease!();
	const racingOutbox = {
		append: (event: any) => outbox.append(event),
		lease: async () => leased,
		isLeaseCurrent: async () => ++leaseChecks === 1,
		release: (events: any) => outbox.release!(events),
		retry: (failures: any) => outbox.retry!(failures),
		ack: (events: any) => outbox.ack!(events)
	};

	assert.equal(await runSearchSyncWorker({ outbox: racingOutbox, search, models: [OutboxAccount], context }), 0);
	assert.equal(indexed, 0);
	const [remaining] = await outbox.list();
	assert.equal(remaining.id, 'lease-stale-before-index');
	assert.equal(remaining.leaseToken, undefined);
});

test('store outbox search sync rechecks leases before index hooks', async () => {
	const outboxContext = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const outbox = new StoreOutboxAdapter({ context: outboxContext });
	const hookEvents: string[] = [];
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		plugins: [{
			name: 'leased-index-hook-observer',
			hooks: {
				beforeIndex: () => {
					hookEvents.push('beforeIndex');
				},
				afterIndex: () => {
					hookEvents.push('afterIndex');
				}
			}
		}]
	});
	let leaseChecks = 0;
	let indexed = 0;
	const search = {
		kind: 'memory',
		capabilities: { index: true },
		search: async () => ({ list: [], more: false }),
		index: async () => {
			indexed++;
		},
		delete: async () => undefined
	} satisfies SearchAdapter;
	await outbox.append({
		id: 'lease-stale-before-index-hook',
		model: 'outbox_transaction_account',
		modelId: 1,
		operation: 'create',
		data: { id: 1, handle: 'stale-before-hook' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});
	const leased = await outbox.lease!();
	const racingOutbox = {
		append: (event: any) => outbox.append(event),
		lease: async () => leased,
		isLeaseCurrent: async () => ++leaseChecks === 1,
		release: (events: any) => outbox.release!(events),
		retry: (failures: any) => outbox.retry!(failures),
		ack: (events: any) => outbox.ack!(events)
	};

	assert.equal(await runSearchSyncWorker({ outbox: racingOutbox, search, models: [OutboxAccount], context }), 0);
	assert.deepEqual(hookEvents, []);
	assert.equal(indexed, 0);
	const [remaining] = await outbox.list();
	assert.equal(remaining.id, 'lease-stale-before-index-hook');
	assert.equal(remaining.leaseToken, undefined);
});

test('store outbox search sync rechecks leased events after indexing before hooks and ack', async () => {
	const outboxContext = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const outbox = new StoreOutboxAdapter({ context: outboxContext });
	const hookEvents: string[] = [];
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		plugins: [{
			name: 'leased-after-index-hook-observer',
			hooks: {
				beforeIndex: () => {
					hookEvents.push('beforeIndex');
				},
				afterIndex: () => {
					hookEvents.push('afterIndex');
				}
			}
		}]
	});
	let leaseChecks = 0;
	let indexed = 0;
	let acked = 0;
	const search = {
		kind: 'memory',
		capabilities: { index: true },
		search: async () => ({ list: [], more: false }),
		index: async () => {
			indexed++;
		},
		delete: async () => undefined
	} satisfies SearchAdapter;
	await outbox.append({
		id: 'lease-stale-after-index',
		model: 'outbox_transaction_account',
		modelId: 1,
		operation: 'create',
		data: { id: 1, handle: 'stale-after-index' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});
	const leased = await outbox.lease!();
	const racingOutbox = {
		append: (event: any) => outbox.append(event),
		lease: async () => leased,
		isLeaseCurrent: async () => ++leaseChecks <= 3,
		release: (events: any) => outbox.release!(events),
		retry: (failures: any) => outbox.retry!(failures),
		ack: async (events: any) => {
			acked += events.length;
			await outbox.ack!(events);
		}
	};

	assert.equal(await runSearchSyncWorker({ outbox: racingOutbox, search, models: [OutboxAccount], context }), 0);
	assert.equal(indexed, 1);
	assert.equal(acked, 0);
	assert.deepEqual(hookEvents, ['beforeIndex']);
	const [remaining] = await outbox.list();
	assert.equal(remaining.id, 'lease-stale-after-index');
	assert.equal(remaining.leaseToken, undefined);
});

test('search sync repairs a delayed stale write after another worker indexes newer state', async () => {
	let releaseOldIndex!: () => void;
	let markOldIndexStarted!: () => void;
	const oldIndexStarted = new Promise<void>((resolve) => {
		markOldIndexStarted = resolve;
	});
	const oldIndexRelease = new Promise<void>((resolve) => {
		releaseOldIndex = resolve;
	});
	let indexedHandle: string | undefined;
	let oldIndexBlocked = false;
	const search = {
		kind: 'memory',
		capabilities: { index: true },
		search: async () => ({ list: [], more: false }),
		index: async (_model: ResolvedModelMeta, _id: EntityId, data: OutboxAccountData) => {
			if (data.handle === 'old-before-lease-expiry' && !oldIndexBlocked) {
				oldIndexBlocked = true;
				markOldIndexStarted();
				await oldIndexRelease;
			}
			indexedHandle = data.handle;
		},
		delete: async () => {
			indexedHandle = undefined;
		}
	} satisfies SearchAdapter;
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory: search },
		defaultSearch: 'memory'
	});
	const Account = OutboxAccount.use(context) as unknown as typeof OutboxAccount;
	await Account.create({ id: 91, handle: 'old-before-lease-expiry' });

	const oldExpiresAt = new Date(Date.now() + 250).toISOString();
	const oldEvent: OutboxEvent = {
		id: 'delayed-old-lease',
		model: 'outbox_transaction_account',
		modelId: 91,
		operation: 'update',
		data: { id: 91, handle: 'old-before-lease-expiry' },
		reconcileFromStore: true,
		createdAt: '2026-05-13T00:00:00.000Z',
		leaseToken: 'old-lease-token',
		leaseExpiresAt: oldExpiresAt
	};
	const newEvent: OutboxEvent = {
		id: 'new-worker-lease',
		model: 'outbox_transaction_account',
		modelId: 91,
		operation: 'update',
		data: { id: 91, handle: 'new-final-store' },
		reconcileFromStore: true,
		createdAt: '2026-05-13T00:00:01.000Z',
		leaseToken: 'new-lease-token',
		leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
	};
	let leaseCalls = 0;
	let activeLeaseToken: string | undefined = oldEvent.leaseToken;
	const repairEvents: OutboxEvent[] = [];
	const pendingRepairIds = new Set<string>();
	const outbox = {
		transactionStore: 'default',
		append: async (event: OutboxEvent) => {
			repairEvents.push(event);
			pendingRepairIds.add(event.id);
			return event;
		},
		lease: async () => ++leaseCalls === 1 ? [oldEvent] : [newEvent],
		isLeaseCurrent: async (event: OutboxEvent) =>
			event.leaseToken === activeLeaseToken && Date.parse(event.leaseExpiresAt!) > Date.now(),
		release: async () => undefined,
		retry: async () => undefined,
		ack: async (events: OutboxEvent[]) => {
			if (events[0]?.leaseToken === activeLeaseToken) activeLeaseToken = undefined;
			for (const event of events) {
				if (event.leaseToken === undefined) pendingRepairIds.delete(event.id);
			}
		}
	};

	const oldWorker = runSearchSyncWorker({ outbox, search, models: [OutboxAccount], context });
	await oldIndexStarted;
	await Account.update(91, { handle: 'new-final-store' });
	await new Promise((resolve) => setTimeout(resolve, Math.max(0, Date.parse(oldExpiresAt) - Date.now() + 5)));
	activeLeaseToken = newEvent.leaseToken;

	assert.equal(await runSearchSyncWorker({ outbox, search, models: [OutboxAccount], context }), 1);
	assert.equal(indexedHandle, 'new-final-store');
	releaseOldIndex();
	assert.equal(await oldWorker, 0);

	assert.equal(indexedHandle, 'new-final-store');
	assert.equal(repairEvents.length, 2);
	for (const repair of repairEvents) {
		assert.equal(repair.model, 'outbox_transaction_account');
		assert.equal(repair.modelId, 91);
		assert.equal(repair.data, undefined);
	}
	assert.deepEqual([...pendingRepairIds], [repairEvents[0].id]);
});

test('store outbox search sync rechecks leased events immediately before deletes', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const outbox = new StoreOutboxAdapter({ context });
	let leaseChecks = 0;
	let deleted = 0;
	const search = {
		kind: 'memory',
		capabilities: { index: true },
		search: async () => ({ list: [], more: false }),
		index: async () => undefined,
		delete: async () => {
			deleted++;
		}
	} satisfies SearchAdapter;
	await outbox.append({
		id: 'lease-stale-before-delete',
		model: 'outbox_transaction_account',
		modelId: 1,
		operation: 'delete',
		createdAt: '2026-05-13T00:00:00.000Z'
	});
	const leased = await outbox.lease!();
	const racingOutbox = {
		append: (event: any) => outbox.append(event),
		lease: async () => leased,
		isLeaseCurrent: async () => ++leaseChecks === 1,
		release: (events: any) => outbox.release!(events),
		retry: (failures: any) => outbox.retry!(failures),
		ack: (events: any) => outbox.ack!(events)
	};

	assert.equal(await runSearchSyncWorker({ outbox: racingOutbox, search, models: [OutboxAccount], context }), 0);
	assert.equal(deleted, 0);
	const [remaining] = await outbox.list();
	assert.equal(remaining.id, 'lease-stale-before-delete');
	assert.equal(remaining.leaseToken, undefined);
});

test('store outbox search sync rechecks leases before delete hooks', async () => {
	const outboxContext = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const outbox = new StoreOutboxAdapter({ context: outboxContext });
	const hookEvents: string[] = [];
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		plugins: [{
			name: 'leased-delete-hook-observer',
			hooks: {
				beforeIndex: () => {
					hookEvents.push('beforeIndex');
				},
				afterIndex: () => {
					hookEvents.push('afterIndex');
				}
			}
		}]
	});
	let leaseChecks = 0;
	let deleted = 0;
	const search = {
		kind: 'memory',
		capabilities: { index: true },
		search: async () => ({ list: [], more: false }),
		index: async () => undefined,
		delete: async () => {
			deleted++;
		}
	} satisfies SearchAdapter;
	await outbox.append({
		id: 'lease-stale-before-delete-hook',
		model: 'outbox_transaction_account',
		modelId: 1,
		operation: 'delete',
		createdAt: '2026-05-13T00:00:00.000Z'
	});
	const leased = await outbox.lease!();
	const racingOutbox = {
		append: (event: any) => outbox.append(event),
		lease: async () => leased,
		isLeaseCurrent: async () => ++leaseChecks === 1,
		release: (events: any) => outbox.release!(events),
		retry: (failures: any) => outbox.retry!(failures),
		ack: (events: any) => outbox.ack!(events)
	};

	assert.equal(await runSearchSyncWorker({ outbox: racingOutbox, search, models: [OutboxAccount], context }), 0);
	assert.deepEqual(hookEvents, []);
	assert.equal(deleted, 0);
	const [remaining] = await outbox.list();
	assert.equal(remaining.id, 'lease-stale-before-delete-hook');
	assert.equal(remaining.leaseToken, undefined);
});

test('store outbox search sync rechecks leased delete events after deletion before hooks and ack', async () => {
	const outboxContext = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const outbox = new StoreOutboxAdapter({ context: outboxContext });
	const hookEvents: string[] = [];
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		plugins: [{
			name: 'leased-after-delete-hook-observer',
			hooks: {
				beforeIndex: () => {
					hookEvents.push('beforeIndex');
				},
				afterIndex: () => {
					hookEvents.push('afterIndex');
				}
			}
		}]
	});
	let leaseChecks = 0;
	let deleted = 0;
	let acked = 0;
	const search = {
		kind: 'memory',
		capabilities: { index: true },
		search: async () => ({ list: [], more: false }),
		index: async () => undefined,
		delete: async () => {
			deleted++;
		}
	} satisfies SearchAdapter;
	await outbox.append({
		id: 'lease-stale-after-delete',
		model: 'outbox_transaction_account',
		modelId: 1,
		operation: 'delete',
		createdAt: '2026-05-13T00:00:00.000Z'
	});
	const leased = await outbox.lease!();
	const racingOutbox = {
		append: (event: any) => outbox.append(event),
		lease: async () => leased,
		isLeaseCurrent: async () => ++leaseChecks <= 3,
		release: (events: any) => outbox.release!(events),
		retry: (failures: any) => outbox.retry!(failures),
		ack: async (events: any) => {
			acked += events.length;
			await outbox.ack!(events);
		}
	};

	assert.equal(await runSearchSyncWorker({ outbox: racingOutbox, search, models: [OutboxAccount], context }), 0);
	assert.equal(deleted, 2);
	assert.equal(acked, 0);
	assert.deepEqual(hookEvents, ['beforeIndex']);
	const [remaining, repair] = await outbox.list();
	assert.equal(remaining.id, 'lease-stale-after-delete');
	assert.equal(remaining.leaseToken, undefined);
	assert.equal(repair.reconcileFromStore, true);
});

test('store outbox search sync rechecks payload-free stale updates after search deletion', async () => {
	const outboxContext = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const outbox = new StoreOutboxAdapter({ context: outboxContext });
	const hookEvents: string[] = [];
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		plugins: [{
			name: 'leased-payload-free-delete-observer',
			hooks: {
				beforeIndex: () => {
					hookEvents.push('beforeIndex');
				},
				afterIndex: () => {
					hookEvents.push('afterIndex');
				}
			}
		}]
	});
	let leaseChecks = 0;
	let deleted = 0;
	let acked = 0;
	const search = {
		kind: 'memory',
		capabilities: { index: true },
		search: async () => ({ list: [], more: false }),
		index: async () => undefined,
		delete: async () => {
			deleted++;
		}
	} satisfies SearchAdapter;
	await outbox.append({
		id: 'payload-free-stale-after-delete',
		model: 'outbox_transaction_account',
		modelId: 1,
		operation: 'update',
		createdAt: '2026-05-13T00:00:00.000Z'
	});
	const leased = await outbox.lease!();
	const racingOutbox = {
		append: (event: any) => outbox.append(event),
		lease: async () => leased,
		isLeaseCurrent: async () => ++leaseChecks <= 3,
		release: (events: any) => outbox.release!(events),
		retry: (failures: any) => outbox.retry!(failures),
		ack: async (events: any) => {
			acked += events.length;
			await outbox.ack!(events);
		}
	};

	assert.equal(await runSearchSyncWorker({ outbox: racingOutbox, search, models: [OutboxAccount], context }), 0);
	assert.equal(deleted, 2);
	assert.equal(acked, 0);
	assert.deepEqual(hookEvents, ['beforeIndex']);
	const [remaining, repair] = await outbox.list();
	assert.equal(remaining.id, 'payload-free-stale-after-delete');
	assert.equal(remaining.leaseToken, undefined);
	assert.equal(repair.reconcileFromStore, true);
});

test('store outbox treats expired leases as no longer current', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const outbox = new StoreOutboxAdapter({ context });
	const expiredEvent = {
		id: 'expired-lease-event',
		model: 'outbox_transaction_account',
		modelId: 1,
		operation: 'create' as const,
		data: { id: 1, handle: 'expired' },
		createdAt: '2026-05-13T00:00:00.000Z',
		leaseToken: 'expired-token',
		leaseExpiresAt: '2000-01-01T00:00:00.000Z'
	};

	await outbox.append(expiredEvent);

	assert.equal(await outbox.isLeaseCurrent!(expiredEvent), false);
	await outbox.ack!([expiredEvent]);
	assert.deepEqual((await outbox.list()).map((event) => event.id), ['expired-lease-event']);
});

test('non-transactional store outbox drain restores deleted events on failure', async () => {
	const backing = new MemoryStoreAdapter();
	const lateEvent = {
		id: 'late-event',
		model: 'outbox_transaction_account',
		modelId: 2,
		operation: 'create' as const,
		data: { id: 2, handle: 'late' },
		createdAt: '2026-05-13T00:00:01.000Z'
	};
	const store: StoreAdapter = {
		kind: 'non-transactional-outbox-store',
		capabilities: { ...backing.capabilities, transaction: false },
		get: (model, id, options) => backing.get(model, id, options),
		getMany: (model, ids, options) => backing.getMany(model, ids, options),
		query: (model, plan, options) => backing.query(model, plan, options),
		aggregate: (model, plan) => backing.aggregate(model, plan),
		create: (model, id, data) => backing.create(model, id, data),
		update: (model, id, data, options) => backing.update(model, id, data, options),
		delete: async (model, id) => {
			await backing.delete(model, id);
			if (id === 'late-event') throw new Error('delete acknowledgement lost');
		},
		transaction: async () => {
			throw new Error('drain fallback should not use transaction');
		}
	};
	const context = createActiveTs({ stores: { default: store } });
	const outbox = new StoreOutboxAdapter({ context });
	await outbox.append({
		id: 'initial-event',
		model: 'outbox_transaction_account',
		modelId: 1,
		operation: 'create',
		data: { id: 1, handle: 'initial' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});
	await outbox.append(lateEvent);

	await assert.rejects(
		() => outbox.drain(),
		/delete acknowledgement lost/
	);
	assert.deepEqual((await outbox.list()).map((event) => event.id), ['initial-event', 'late-event']);
});

test('store outbox requeue ignores transaction methods without transaction capability', async () => {
	const backing = new MemoryStoreAdapter();
	let transactionCalls = 0;
	const store: StoreAdapter = {
		kind: 'non-transactional-outbox-requeue-store',
		capabilities: { ...backing.capabilities, transaction: false },
		get: (model, id, options) => backing.get(model, id, options),
		getMany: (model, ids, options) => backing.getMany(model, ids, options),
		query: (model, plan, options) => backing.query(model, plan, options),
		aggregate: (model, plan) => backing.aggregate(model, plan),
		create: (model, id, data) => backing.create(model, id, data),
		update: (model, id, data, options) => backing.update(model, id, data, options),
		delete: (model, id) => backing.delete(model, id),
		transaction: async () => {
			transactionCalls++;
			throw new Error('requeue fallback should not use transaction');
		}
	};
	const context = createActiveTs({ stores: { default: store } });
	const outbox = new StoreOutboxAdapter({ context });

	await outbox.requeue!([
		{
			id: 'requeue-without-capability',
			model: 'outbox_transaction_account',
			modelId: 1,
			operation: 'create',
			data: { id: 1, handle: 'requeued' },
			createdAt: '2026-05-13T00:00:00.000Z'
		}
	]);

	assert.equal(transactionCalls, 0);
	assert.deepEqual((await outbox.list()).map((event) => event.id), ['requeue-without-capability']);
});

test('non-transactional store outbox requeue cleanup omits optimistic lock options when unsupported', async () => {
	const backing = new MemoryStoreAdapter();
	const store: StoreAdapter = {
		kind: 'non-optimistic-requeue-cleanup-store',
		capabilities: { ...backing.capabilities, optimisticLock: false, transaction: false },
		get: (model, id, options) => backing.get(model, id, options),
		getMany: (model, ids, options) => backing.getMany(model, ids, options),
		query: (model, plan, options) => backing.query(model, plan, options),
		aggregate: (model, plan) => backing.aggregate(model, plan),
		create: async (model, id, data, options) => {
			if (id === 'requeue-cleanup-second') throw new Error('second insert failed');
			return await backing.create(model, id, data, options);
		},
		update: (model, id, data, options) => backing.update(model, id, data, options),
		delete: async (model, id, options) => {
			assert.equal(options, undefined);
			await backing.delete(model, id);
		},
		transaction: async () => {
			throw new Error('requeue cleanup fallback should not use transaction');
		}
	};
	const context = createActiveTs({ stores: { default: store } });
	const outbox = new StoreOutboxAdapter({ context });

	await assert.rejects(
		() =>
			outbox.requeue!([
				{
					id: 'requeue-cleanup-first',
					model: 'outbox_transaction_account',
					modelId: 1,
					operation: 'create',
					data: { id: 1, handle: 'first' },
					createdAt: '2026-05-13T00:00:00.000Z'
				},
				{
					id: 'requeue-cleanup-second',
					model: 'outbox_transaction_account',
					modelId: 2,
					operation: 'create',
					data: { id: 2, handle: 'second' },
					createdAt: '2026-05-13T00:00:01.000Z'
				}
			]),
		/second insert failed/
	);
	assert.deepEqual(await outbox.list(), []);
});

test('store outbox appendTransactional requires matching active transaction context', async () => {
	const storeA = new MemoryStoreAdapter();
	const storeB = new MemoryStoreAdapter();
	const contextA = createActiveTs({ stores: { default: storeA } });
	const contextB = createActiveTs({ stores: { default: storeB } });
	const outbox = new StoreOutboxAdapter({ context: contextA });
	const event = {
		id: 'direct-transactional-append',
		model: 'outbox_transaction_account',
		modelId: 1,
		operation: 'create' as const,
		data: { id: 1, handle: 'transactional' },
		createdAt: '2026-05-13T00:00:00.000Z'
	};

	await assert.rejects(
		() => outbox.appendTransactional!(contextA, event),
		/requires an active transaction context/
	);
	await assert.rejects(
		() => contextB.transaction((tx) => outbox.appendTransactional!(tx, event)),
		/bound to a different ActiveContext/
	);
	assert.deepEqual(await outbox.list(), []);
	assert.deepEqual(storeB.dump('active_ts_outbox_event'), []);

	await contextA.transaction((tx) => outbox.appendTransactional!(tx, event));

	assert.deepEqual((await outbox.list()).map((row) => row.id), ['direct-transactional-append']);
});

test('hard delete skips lifecycle and outbox events when the row is missing', async () => {
	const outbox = new MemoryOutboxAdapter();
	const hookEvents: string[] = [];
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		plugins: [
			{
				name: 'delete-observer',
				hooks: {
					beforeDelete(payload) {
						hookEvents.push(`before:${payload.id}`);
					},
					afterDelete(payload) {
						hookEvents.push(`after:${payload.id}`);
					}
				}
			},
			createOutboxPlugin({ outbox, includeData: true, id: () => 'missing-delete-event' })
		]
	});
	const Account = OutboxAccount.use(context) as unknown as typeof OutboxAccount;

	await Account.delete(804);

	assert.deepEqual(hookEvents, []);
	assert.deepEqual(await outbox.list(), []);
});

test('search sync worker rejects transaction contexts before draining outbox events', async () => {
	let drains = 0;
	const outbox = {
		append: async () => undefined,
		requeue: async () => undefined,
		drain: async () => {
			drains++;
			return [];
		}
	};
	const search = new MemorySearchAdapter();
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });

	await context.transaction(async (tx) => {
		await assert.rejects(
			() => runSearchSyncWorker({ outbox, search, models: [OutboxAccount], context: tx }),
			/Cannot run search sync workers inside a transaction/
		);
	});

	assert.equal(drains, 0);

	await context.transaction(async () => {
		await assert.rejects(
			() => runSearchSyncWorker({ outbox, search, models: [OutboxAccount], context }),
			/Cannot run search sync workers inside a transaction/
		);
	});

	assert.equal(drains, 0);

	await context.transaction(async () => {
		await assert.rejects(
			() => runSearchSyncWorker({ outbox, search, models: [OutboxAccount] }),
			/Cannot run search sync workers inside a transaction/
		);
	});

	assert.equal(drains, 0);
});

test('hook result cannot replace transaction context before outbox afterCommit registration', async () => {
	const outbox = new MemoryOutboxAdapter();
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		plugins: [
			{
				name: 'replace-context',
				hooks: {
					afterCreate() {
						return { context: {} } as any;
					}
				}
			},
			createOutboxPlugin({ outbox, includeData: true, id: () => 'context-replacement-event' })
		]
	});
	const Account = OutboxAccount.use(context) as unknown as typeof OutboxAccount;

	await assert.rejects(
		() =>
			context.transaction(async (tx) => {
				await Account.create({ id: 810, handle: 'rolled-back' }, tx);
			}),
		/Hook result key "context" cannot replace immutable payload metadata/
	);
	assert.deepEqual(await outbox.list(), []);
	assert.equal(await Account.find(810).load(), null);
});

test('outbox search sync emits index hooks without consuming payload mutations', async () => {
	const outbox = new MemoryOutboxAdapter();
	const search = new MemorySearchAdapter();
	const hookEvents: string[] = [];
	let eventId = 0;
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		plugins: [
			createOutboxPlugin({ outbox, includeData: true, id: () => `index-hook-${++eventId}` }),
			{
				name: 'index-observer',
				hooks: {
					beforeIndex(payload) {
						hookEvents.push(`before:${payload.operation}:${payload.id}:${payload.data?.handle ?? ''}`);
						if (payload.data) payload.data.handle = 'mutated-by-hook';
					},
					afterIndex(payload) {
						hookEvents.push(`after:${payload.operation}:${payload.id}:${payload.data?.handle ?? ''}`);
					}
				}
			}
		]
	});
	const Account = OutboxAccount.use(context) as unknown as typeof OutboxAccount;

	await Account.create({ id: 805, handle: 'original' });
	assert.equal(await runSearchSyncWorker({ outbox, search, models: [OutboxAccount], context }), 1);
	assert.equal((await search.search(context.meta(OutboxAccount), 'original', {})).list.length, 1);
	assert.equal((await search.search(context.meta(OutboxAccount), 'mutated-by-hook', {})).list.length, 0);

	await Account.delete(805);
	assert.equal(await runSearchSyncWorker({ outbox, search, models: [OutboxAccount], context }), 1);
	assert.equal((await search.search(context.meta(OutboxAccount), 'original', {})).list.length, 0);
	assert.deepEqual(hookEvents, [
		'before:index:805:original',
		'after:index:805:original',
		'before:index-delete:805:',
		'after:index-delete:805:'
	]);
});

test('outbox search sync rejects marker-only Datastore delete payload identities', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const data = { id: 5, handle: 'marker-only-delete' };
	Object.defineProperty(data, ACTIVE_TS_ENTITY_KEY, {
		value: { path: ['outbox_datastore_parent', 12, 'outbox_datastore_account', 5] },
		enumerable: false
	});
	const event: OutboxEvent = {
		id: 'marker-only-delete',
		model: 'outbox_datastore_account',
		modelId: 5,
		operation: 'delete',
		data,
		createdAt: '2026-05-13T00:00:00.000Z'
	};
	const requeued: OutboxEvent[] = [];
	const outbox = {
		append: async () => undefined,
		drain: async () => [event],
		requeue: async (events: OutboxEvent[]) => {
			requeued.push(...events);
		}
	};
	let deleteCalls = 0;
	const search = {
		kind: 'memory',
		capabilities: { index: true },
		search: async () => ({ list: [], more: false }),
		index: async () => undefined,
		delete: async () => {
			deleteCalls++;
		}
	} satisfies SearchAdapter;

	await assert.rejects(
		() => runSearchSyncWorker({ outbox, search, models: [OutboxDatastoreAccount], context }),
		/Outbox event "marker-only-delete" for Datastore model "outbox_datastore_account" is missing Datastore ancestor metadata/
	);
	assert.equal(deleteCalls, 0);
	assert.deepEqual(requeued.map((item) => item.id), ['marker-only-delete']);
});

test('outbox search sync uses explicit Datastore delete metadata over marker-only payloads', async () => {
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const ancestor = datastoreKey('outbox_datastore_parent', 12);
	const data = { id: 5, handle: 'marker-only-delete' };
	Object.defineProperty(data, ACTIVE_TS_ENTITY_KEY, {
		value: { path: ['outbox_datastore_parent', 99, 'outbox_datastore_account', 5] },
		enumerable: false
	});
	const event: OutboxEvent = {
		id: 'explicit-delete-ancestor',
		model: 'outbox_datastore_account',
		modelId: 5,
		modelDatastoreAncestor: ancestor,
		operation: 'delete',
		data,
		createdAt: '2026-05-13T00:00:00.000Z'
	};
	const requeued: OutboxEvent[] = [];
	const outbox = {
		append: async () => undefined,
		drain: async () => [event],
		requeue: async (events: OutboxEvent[]) => {
			requeued.push(...events);
		}
	};
	const expectedIdentity = datastoreSearchDocumentIdentity(context.meta(OutboxDatastoreAccount), 5, ancestor);
	const deleted: Array<string | undefined> = [];
	const search = {
		kind: 'memory',
		capabilities: { index: true },
		search: async () => ({ list: [], more: false }),
		index: async () => undefined,
		delete: async (model: ResolvedModelMeta, id: EntityId) => {
			assert.equal(id, 5);
			deleted.push(model.searchDocumentIdentity);
		}
	} satisfies SearchAdapter;

	assert.equal(await runSearchSyncWorker({ outbox, search, models: [OutboxDatastoreAccount], context }), 1);
	assert.deepEqual(deleted, [expectedIdentity]);
	assert.deepEqual(requeued, []);
});

test('outbox search sync strips Datastore entity-key markers before index adapters', async () => {
	const hookDescriptors: Array<PropertyDescriptor | undefined> = [];
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		plugins: [{
			name: 'outbox-index-marker-observer',
			hooks: {
				beforeIndex(payload) {
					hookDescriptors.push(Object.getOwnPropertyDescriptor(payload.data, ACTIVE_TS_ENTITY_KEY));
				},
				afterIndex(payload) {
					hookDescriptors.push(Object.getOwnPropertyDescriptor(payload.data, ACTIVE_TS_ENTITY_KEY));
				}
			}
		}]
	});
	const data = { id: 6, parentId: 12, handle: 'indexed-marker' };
	Object.defineProperty(data, ACTIVE_TS_ENTITY_KEY, {
		value: { path: ['outbox_datastore_parent', 12, 'outbox_datastore_account', 6] },
		enumerable: false
	});
	const event: OutboxEvent = {
		id: 'strip-index-marker',
		model: 'outbox_datastore_account',
		modelId: 6,
		operation: 'create',
		data,
		createdAt: '2026-05-13T00:00:00.000Z'
	};
	const outbox = {
		append: async () => undefined,
		drain: async () => [event],
		requeue: async () => undefined
	};
	const descriptors: Array<PropertyDescriptor | undefined> = [];
	const search = {
		kind: 'memory',
		capabilities: { index: true },
		search: async () => ({ list: [], more: false }),
		index: async (_model: ResolvedModelMeta, _id: EntityId, payload: any) => {
			descriptors.push(Object.getOwnPropertyDescriptor(payload, ACTIVE_TS_ENTITY_KEY));
		},
		delete: async () => undefined
	} satisfies SearchAdapter;

	assert.equal(await runSearchSyncWorker({ outbox, search, models: [OutboxDatastoreAccount], context }), 1);
	assert.deepEqual(descriptors, [undefined]);
	assert.deepEqual(hookDescriptors, [undefined, undefined]);
	assert.equal(Object.getOwnPropertyDescriptor(event.data, ACTIVE_TS_ENTITY_KEY)?.enumerable, false);
});

test('outbox plugin snapshots included data before rejecting later post-write mutations', async () => {
	const events: any[] = [];
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		plugins: [
			createOutboxPlugin({
				outbox: {
					append: async (event) => {
						events.push(event);
					}
				},
				includeData: true,
				id: () => 'snapshot-event'
			}),
			{
				name: 'mutate-after-outbox',
				hooks: {
					afterCreate(payload) {
						payload.data.handle = 'mutated-after-outbox';
					}
				}
			}
		]
	});
	const Account = OutboxAccount.use(context) as unknown as typeof OutboxAccount;

	await assert.rejects(
		() => Account.create({ id: 803, handle: 'original' }),
		/afterCreate target cannot change committed outbox_transaction_account data/
	);

	assert.equal(events.length, 1);
	assert.equal(events[0].data.handle, 'original');
	assert.equal((await Account.find(803).load())?.data.handle, 'original');
});

test('outbox plugin snapshots committed data after earlier hooks mutate payloads', async () => {
	const events: any[] = [];
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		plugins: [
			{
				name: 'mutate-before-outbox',
				hooks: {
					beforeCreate(payload) {
						payload.data.handle = 'mutated-before-outbox-create';
					},
					beforeUpdate(payload) {
						payload.data.handle = 'mutated-before-outbox-update';
					}
				}
			},
			createOutboxPlugin({
				outbox: {
					append: async (event) => {
						events.push(event);
					}
				},
				includeData: true,
				id: () => `committed-snapshot-${events.length + 1}`
			})
		]
	});
	const Account = OutboxAccount.use(context) as unknown as typeof OutboxAccount;

	const created = await Account.create({ id: 806, handle: 'created' });
	assert.equal(created.data.handle, 'mutated-before-outbox-create');
	created.data.handle = 'updated';
	await created.save();

	assert.deepEqual(events.map((event) => event.data.handle), [
		'mutated-before-outbox-create',
		'mutated-before-outbox-update'
	]);
	assert.equal((await Account.find(806).load())?.data.handle, 'mutated-before-outbox-update');
});

test('outbox plugin rejects hook model name accessors without invoking them', async () => {
	const outbox = new MemoryOutboxAdapter();
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		plugins: [createOutboxPlugin({ outbox, includeData: true, id: () => 'accessor-model-event' })]
	});
	let modelReads = 0;
	const accessorModel = Object.defineProperty({ hooks: {} }, 'name', {
		enumerable: true,
		get() {
			modelReads++;
			return 'outbox_transaction_account';
		}
	});

	await assert.rejects(
		() => context.runHooks('afterCreate', {
			model: accessorModel as any,
			id: 900,
			data: { id: 900, handle: 'accessor' },
			operation: 'create'
		}),
		/Outbox hook model "name" must be a data property/
	);
	assert.equal(modelReads, 0);
	assert.deepEqual(await outbox.list(), []);
});

test('outbox plugin rejects resolved hook metadata accessors without invoking them', async () => {
	const outbox = new MemoryOutboxAdapter();
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		plugins: [createOutboxPlugin({ outbox, includeData: true, id: () => 'accessor-meta-event' })]
	});
	let codecReads = 0;
	const accessorModel = Object.defineProperty(
		{
			name: 'outbox_transaction_account',
			store: 'default',
			idField: 'id',
			fieldTypes: new Map(),
			hooks: {}
		},
		'fieldCodecs',
		{
			enumerable: true,
			get() {
				codecReads++;
				return new Map();
			}
		}
	);

	await assert.rejects(
		() => context.runHooks('afterCreate', {
			model: accessorModel as any,
			id: 901,
			data: { id: 901, handle: 'accessor-meta' },
			operation: 'create'
		}),
		/Outbox hook model "fieldCodecs" must be a data property/
	);
	assert.equal(codecReads, 0);
	assert.deepEqual(await outbox.list(), []);
});

test('outbox plugin uses captured Map size for resolved hook metadata', async () => {
	const outbox = new MemoryOutboxAdapter();
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		plugins: [createOutboxPlugin({ outbox, includeData: true, id: () => 'map-size-meta-event' })]
	});
	let sizeReads = 0;
	class SizeTrapMap<K, V> extends Map<K, V> {
		override get size(): number {
			sizeReads++;
			throw new Error('outbox metadata size getter should not run');
		}
	}
	const meta = context.meta(OutboxAccount);
	const model = {
		...meta,
		fieldCodecs: new SizeTrapMap(),
		fieldTypes: new SizeTrapMap()
	};

	await context.runHooks('afterCreate', {
		model: model as any,
		id: 902,
		data: { id: 902, handle: 'map-size' },
		operation: 'create'
	});

	assert.equal(sizeReads, 0);
	const events = await outbox.list();
	assert.deepEqual(events, [
		{
			id: 'map-size-meta-event',
			model: 'outbox_transaction_account',
			modelId: 902,
			operation: 'create',
			data: { id: 902, handle: 'map-size' },
			dataEncoding: 'public',
			reconcileFromStore: true,
			createdAt: events[0].createdAt
		}
	]);
});

test('memory outbox validates event data before storing fixtures', async () => {
	const outbox = new MemoryOutboxAdapter();

	await assert.rejects(
		() =>
			outbox.append({
				id: 'unsafe-data',
				model: 'outbox_transaction_account',
				modelId: 1,
				operation: 'create',
				data: { id: 1, __unsafe: true },
				createdAt: '2026-05-13T00:00:00.000Z'
			}),
		/Reserved data key/
	);
	await assert.rejects(
		() =>
			outbox.append({
				id: 'function-data',
				model: 'outbox_transaction_account',
				modelId: 1,
				operation: 'create',
				data: { id: 1, run: () => undefined },
				createdAt: '2026-05-13T00:00:00.000Z'
			}),
		/Unsupported data value/
	);
	assert.deepEqual(await outbox.list(), []);

	await assert.rejects(
		() =>
			outbox.append({
				id: 'typoed-encoding-event',
				model: 'outbox_secret_account',
				modelId: 1,
				operation: 'create',
				data: { id: 1, secret: 'encoded:visible-token' },
				dataEncodng: 'stored',
				createdAt: '2026-05-13T00:00:00.000Z'
			} as any),
		/Outbox event contains unknown option "dataEncodng"/
	);
	assert.deepEqual(await outbox.list(), []);

	const eventWithExtras = Object.assign(JSON.parse('{"__proto__":{"polluted":true}}'), {
		id: 'safe-extra-event',
		model: 'outbox_transaction_account',
		modelId: 2,
		operation: 'delete',
		extra: () => undefined,
		createdAt: '2026-05-13T00:00:00.000Z'
	});
	await assert.rejects(
		() => outbox.append(eventWithExtras),
		/Outbox event contains unknown option "__proto__"/
	);
	assert.deepEqual(await outbox.list(), []);
	assert.equal(({} as any).polluted, undefined);
});

test('memory outbox drain preserves events appended while draining', async () => {
	const outbox = new MemoryOutboxAdapter();
	await outbox.append({
		id: 'early-event',
		model: 'outbox_transaction_account',
		modelId: 1,
		operation: 'create',
		data: { id: 1, handle: 'early' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});

	const draining = outbox.drain();
	await outbox.append({
		id: 'late-event',
		model: 'outbox_transaction_account',
		modelId: 2,
		operation: 'create',
		data: { id: 2, handle: 'late' },
		createdAt: '2026-05-13T00:00:01.000Z'
	});

	assert.deepEqual((await draining).map((event) => event.id), ['early-event']);
	assert.deepEqual((await outbox.list()).map((event) => event.id), ['late-event']);
});

test('outbox options and events ignore inherited fields', async () => {
	Object.defineProperty(Object.prototype, 'outbox', {
		value: new MemoryOutboxAdapter(),
		configurable: true
	});
	try {
		assert.throws(() => createOutboxPlugin({} as any), /Outbox plugin outbox must be an adapter object/);
	} finally {
		delete (Object.prototype as Record<string, unknown>).outbox;
	}

	const outbox = new MemoryOutboxAdapter();
	Object.defineProperty(Object.prototype, 'includeData', {
		value: true,
		configurable: true
	});
	try {
		const context = createActiveTs({
			stores: { default: new MemoryStoreAdapter() },
			plugins: [createOutboxPlugin({ outbox })]
		});
		const Account = OutboxAccount.use(context) as unknown as typeof OutboxAccount;
		await Account.create({ id: 804, handle: 'no inherited include' });
	} finally {
		delete (Object.prototype as Record<string, unknown>).includeData;
	}
	const [event] = await outbox.list();
	assert.equal(event.data, undefined);

	const inheritedEvent = Object.create({
		id: 'inherited-event',
		model: 'outbox_transaction_account',
		modelId: 1,
		operation: 'delete',
		createdAt: '2026-05-13T00:00:00.000Z'
	});
	await assert.rejects(() => outbox.append(inheritedEvent), /Outbox event must be a plain object/);
	let getterCalls = 0;
	const accessorEvent = Object.defineProperty(
		{
			model: 'outbox_transaction_account',
			modelId: 1,
			operation: 'delete',
			createdAt: '2026-05-13T00:00:00.000Z'
		},
		'id',
		{
			enumerable: true,
			get() {
				getterCalls++;
				return 'accessor-event';
			}
		}
	);
	await assert.rejects(() => outbox.append(accessorEvent as any), /Outbox event "id" must be a data property/);
	assert.equal(getterCalls, 0);
	const hiddenEvent = Object.defineProperty(
		{
			model: 'outbox_transaction_account',
			modelId: 1,
			operation: 'delete',
			createdAt: '2026-05-13T00:00:00.000Z'
		},
		'id',
		{
			enumerable: false,
			value: 'hidden-event'
		}
	);
	await assert.rejects(() => outbox.append(hiddenEvent as any), /Outbox event "id" must be enumerable/);
	await assert.rejects(
		() =>
			outbox.append({
				id: 'symbol-event',
				model: 'outbox_transaction_account',
				modelId: 1,
				operation: 'delete',
				createdAt: '2026-05-13T00:00:00.000Z',
				[Symbol('event')]: true
			} as any),
		/Outbox event cannot contain symbol fields/
	);

	let operationCoercions = 0;
	const hostileOperation = {
		toString() {
			operationCoercions++;
			throw new Error('outbox operation coercion should not run');
		}
	};
	await assert.rejects(
		() =>
			outbox.append({
				id: 'hostile-operation-event',
				model: 'outbox_transaction_account',
				modelId: 1,
				operation: hostileOperation as any,
				createdAt: '2026-05-13T00:00:00.000Z'
			}),
		/Outbox event "hostile-operation-event" has unsupported operation/
	);
	assert.equal(operationCoercions, 0);

	const search = new MemorySearchAdapter();
	Object.defineProperty(Object.prototype, 'append', {
		value: async () => undefined,
		configurable: true
	});
	Object.defineProperty(Object.prototype, 'drain', {
		value: async () => [],
		configurable: true
	});
	Object.defineProperty(Object.prototype, 'index', {
		value: async () => undefined,
		configurable: true
	});
	Object.defineProperty(Object.prototype, 'delete', {
		value: async () => undefined,
		configurable: true
	});
	try {
		assert.throws(() => createOutboxPlugin({ outbox: {} as any }), /Outbox plugin outbox\.append/);
		await assert.rejects(
			() => runSearchSyncWorker({ outbox: {} as any, search: {} as any, models: [OutboxAccount] }),
			/Outbox search sync outbox\.append/
		);
	} finally {
		delete (Object.prototype as Record<string, unknown>).append;
		delete (Object.prototype as Record<string, unknown>).drain;
		delete (Object.prototype as Record<string, unknown>).index;
		delete (Object.prototype as Record<string, unknown>).delete;
	}

	Object.defineProperty(Object.prototype, 'models', {
		value: [OutboxAccount],
		configurable: true
	});
	try {
		await assert.rejects(
			() => runSearchSyncWorker({ outbox, search } as any),
			/Outbox search sync models must be an array/
		);
	} finally {
		delete (Object.prototype as Record<string, unknown>).models;
	}
});

test('outbox search sync worker requeues malformed events instead of dropping them', async () => {
	const outbox = new MemoryOutboxAdapter();
	const search = new MemorySearchAdapter();
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });

	await outbox.append({
		id: 'unknown-model',
		model: 'missing_model',
		modelId: 1,
		operation: 'create',
		data: { id: 1, handle: 'lost' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});

	await assert.rejects(
		() => runSearchSyncWorker({ outbox, search, models: [OutboxAccount], context }),
		/unregistered model "missing_model"/
	);
	assert.deepEqual(
		(await outbox.list()).map((event) => event.id),
		['unknown-model']
	);

	const cleanOutbox = new MemoryOutboxAdapter();
	await cleanOutbox.append({
		id: 'missing-data',
		model: 'outbox_transaction_account',
		modelId: 2,
		operation: 'update',
		createdAt: '2026-05-13T00:00:01.000Z'
	});
	await assert.rejects(
		() => runSearchSyncWorker({ outbox: cleanOutbox, search, models: [OutboxAccount] }),
		/missing data/
	);
	assert.deepEqual(
		(await cleanOutbox.list()).map((event) => event.id),
		['missing-data']
	);

	const missingIdOutbox = new MemoryOutboxAdapter();
	await missingIdOutbox.append({
		id: 'missing-model-id',
		model: 'outbox_transaction_account',
		operation: 'delete',
		createdAt: '2026-05-13T00:00:02.000Z'
	});
	await assert.rejects(
		() => runSearchSyncWorker({ outbox: missingIdOutbox, search, models: [OutboxAccount], context }),
		/missing modelId/
	);
	assert.deepEqual(
		(await missingIdOutbox.list()).map((event) => event.id),
		['missing-model-id']
	);

	const malformedOutbox = {
		events: [
			{
				id: 'bad-model-id',
				model: 'outbox_transaction_account',
				modelId: { id: 1 } as any,
				operation: 'create' as const,
				data: { id: 1, handle: 'bad' },
				createdAt: '2026-05-13T00:00:03.000Z'
			}
		],
		async append(event: any) {
			this.events.push(event);
		},
		async requeue(events: any[]) {
			this.events.unshift(...events);
		},
		async drain() {
			const events = this.events;
			this.events = [];
			return events;
		}
	};
	await assert.rejects(
		() => runSearchSyncWorker({ outbox: malformedOutbox, search, models: [OutboxAccount], context }),
		/modelId must be a string or safe integer/
	);
	assert.deepEqual(malformedOutbox.events.map((event) => event.id), ['bad-model-id']);

	const customDate = new Date('2026-05-13T00:00:04.000Z') as Date & { extra?: string };
	customDate.extra = 'dropped';
	const customDateOutbox = {
		events: [
			{
				id: 'bad-custom-date',
				model: 'outbox_transaction_account',
				modelId: { id: 1 } as any,
				operation: 'create' as const,
				data: { id: 1, handle: 'bad', seenAt: customDate },
				createdAt: '2026-05-13T00:00:04.000Z'
			}
		],
		async append(event: any) {
			this.events.push(event);
		},
		async requeue(events: any[]) {
			this.events.unshift(...events);
		},
		async drain() {
			const events = this.events;
			this.events = [];
			return events;
		}
	};
	await assert.rejects(
		() => runSearchSyncWorker({ outbox: customDateOutbox, search, models: [OutboxAccount], context }),
		(error: unknown) => {
			assert.ok(error instanceof AggregateError);
			assert.match(error.message, /Outbox search sync failed and requeue failed/);
			assert.match((error.errors[0] as Error).message, /modelId must be a string or safe integer/);
			assert.match((error.errors[1] as Error).message, /custom built-in property "extra"/);
			return true;
		}
	);
	assert.deepEqual(customDateOutbox.events, []);
});

test('outbox search sync isolates poison entities while processing unrelated events', async () => {
	const outbox = new MemoryOutboxAdapter();
	const search = new MemorySearchAdapter();
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const Account = OutboxAccount.use(context) as unknown as typeof OutboxAccount;
	await Account.create({ id: 93, handle: 'unrelated-event-processed' });

	await outbox.append({
		id: 'poison-entity-first',
		model: 'permanently_missing_model',
		modelId: 1,
		operation: 'update',
		data: { id: 1, handle: 'poison-first' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});
	await outbox.append({
		id: 'poison-entity-successor',
		model: 'permanently_missing_model',
		modelId: 1,
		operation: 'update',
		data: { id: 1, handle: 'poison-successor' },
		createdAt: '2026-05-13T00:00:01.000Z'
	});
	await outbox.append({
		id: 'unrelated-valid-event',
		model: 'outbox_transaction_account',
		modelId: 93,
		operation: 'update',
		data: { id: 93, handle: 'payload-is-only-a-trigger' },
		reconcileFromStore: true,
		createdAt: '2026-05-13T00:00:02.000Z'
	});

	await assert.rejects(
		() => runSearchSyncWorker({ outbox, search, models: [OutboxAccount], context }),
		/unregistered model "permanently_missing_model"/
	);
	assert.deepEqual(
		(await outbox.list()).map((event) => event.id),
		['poison-entity-first', 'poison-entity-successor']
	);
	assert.deepEqual(
		(await search.search(context.meta(OutboxAccount), 'unrelated-event-processed', {})).list.map((row) => row.id),
		[93]
	);
});

test('outbox search sync dead-letters a batchSize one poison before advancing unrelated work', async () => {
	const outbox = new MemoryOutboxAdapter();
	const search = new MemorySearchAdapter();
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	const retryAttempts: number[] = [];
	await outbox.append({
		id: 'batch-one-poison',
		model: 'permanently_missing_batch_model',
		modelId: 1,
		operation: 'update',
		data: { id: 1, handle: 'poison' },
		createdAt: '2026-05-13T00:00:00.000Z'
	});
	await outbox.append({
		id: 'batch-one-unrelated',
		model: 'outbox_transaction_account',
		modelId: 94,
		operation: 'create',
		data: { id: 94, handle: 'after-dead-letter' },
		createdAt: '2026-05-13T00:00:01.000Z'
	});
	const workerOptions = {
		outbox,
		search,
		models: [OutboxAccount],
		context,
		batchSize: 1,
		retryDelayMs: (attempt: number) => {
			retryAttempts.push(attempt);
			return 0;
		}
	};

	for (let attempt = 1; attempt < 5; attempt++) {
		await assert.rejects(
			() => runSearchSyncWorker(workerOptions),
			/unregistered model "permanently_missing_batch_model"/
		);
		const [retry, waiting] = await outbox.list();
		assert.equal(retry.id, 'batch-one-poison');
		assert.equal(retry.deliveryAttempts, attempt);
		assert.equal(retry.version, attempt);
		assert.equal(waiting.id, 'batch-one-unrelated');
		assert.deepEqual(retryAttempts, Array.from({ length: attempt }, (_value, index) => index + 1));
	}
	await assert.rejects(
		() => runSearchSyncWorker(workerOptions),
		/unregistered model "permanently_missing_batch_model"/
	);
	assert.deepEqual((await outbox.list()).map((event) => event.id), ['batch-one-unrelated']);
	const [deadLetter] = await outbox.listDeadLetters();
	assert.equal(deadLetter.id, 'batch-one-poison');
	assert.equal(deadLetter.deliveryAttempts, 5);
	assert.equal(deadLetter.version, 5);
	assert.deepEqual(retryAttempts, [1, 2, 3, 4]);
	assert.equal(new Date(deadLetter.deadLetteredAt!).toISOString(), deadLetter.deadLetteredAt);
	assert.match(deadLetter.lastDeliveryError!, /permanently_missing_batch_model/);

	assert.equal(await runSearchSyncWorker(workerOptions), 1);
	assert.deepEqual(await outbox.list(), []);
	assert.deepEqual(
		(await search.search(context.meta(OutboxAccount), 'after-dead-letter', {})).list.map((row) => row.id),
		[94]
	);
});

test('outbox plugin and memory adapter validate event identifiers', async () => {
	const outbox = new MemoryOutboxAdapter();
	await assert.rejects(
		() =>
			outbox.append({
				id: 'bad\0event',
				model: 'outbox_transaction_account',
				modelId: 1,
				operation: 'create',
				data: { id: 1, handle: 'bad' },
				createdAt: '2026-05-13T00:00:00.000Z'
			}),
		/outbox event id/
	);
	await assert.rejects(
		() =>
			outbox.append({
				id: 'bad-created-at',
				model: 'outbox_transaction_account',
				modelId: 1,
				operation: 'create',
				data: { id: 1, handle: 'bad-time' },
				createdAt: 'May 13, 2026'
			}),
		/canonical ISO timestamp/
	);
	await outbox.append({
		id: 'duplicate-id',
		model: 'outbox_transaction_account',
		modelId: 1,
		operation: 'create',
		data: { id: 1, handle: 'first' },
		createdAt: '2026-05-13T00:00:01.000Z'
	});
	await assert.rejects(
		() =>
			outbox.append({
				id: 'duplicate-id',
				model: 'outbox_transaction_account',
				modelId: 2,
				operation: 'update',
				data: { id: 2, handle: 'second' },
				createdAt: '2026-05-13T00:00:02.000Z'
			}),
		/Memory outbox event id "duplicate-id" already exists/
	);
	await assert.rejects(
		() =>
			outbox.requeue([
				{
					id: 'duplicate-id',
					model: 'outbox_transaction_account',
					modelId: 3,
					operation: 'delete',
					createdAt: '2026-05-13T00:00:03.000Z'
				}
			]),
		/Memory outbox event id "duplicate-id" already exists/
	);
	await assert.rejects(
		() =>
			outbox.requeue([
				{
					id: 'duplicate-requeue',
					model: 'outbox_transaction_account',
					modelId: 4,
					operation: 'delete',
					createdAt: '2026-05-13T00:00:04.000Z'
				},
				{
					id: 'duplicate-requeue',
					model: 'outbox_transaction_account',
					modelId: 5,
					operation: 'delete',
					createdAt: '2026-05-13T00:00:05.000Z'
				}
			]),
		/memory outbox requeue events contains duplicate event id "duplicate-requeue"/
	);

	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		plugins: [createOutboxPlugin({ outbox, includeData: true, id: (() => ({ id: 'bad' })) as any })]
	});
	const Account = OutboxAccount.use(context) as unknown as typeof OutboxAccount;

	await assert.rejects(() => Account.create({ id: 901, handle: 'bad-event-id' }), /outbox event id must be a string/);
});

test('outbox duplicate and requeue tracking use captured collection intrinsics', async () => {
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		search: { memory: new MemorySearchAdapter() },
		defaultSearch: 'memory'
	});
	context.meta(OutboxAccount);
	const outbox = new MemoryOutboxAdapter();
	const originals = {
		setAdd: Object.getOwnPropertyDescriptor(Set.prototype, 'add')!,
		setHas: Object.getOwnPropertyDescriptor(Set.prototype, 'has')!,
		mapHas: Object.getOwnPropertyDescriptor(Map.prototype, 'has')!,
		mapSet: Object.getOwnPropertyDescriptor(Map.prototype, 'set')!,
		weakMapGet: Object.getOwnPropertyDescriptor(WeakMap.prototype, 'get')!,
		weakMapHas: Object.getOwnPropertyDescriptor(WeakMap.prototype, 'has')!,
		weakMapSet: Object.getOwnPropertyDescriptor(WeakMap.prototype, 'set')!
	};
	Object.defineProperties(Set.prototype, {
		add: {
			configurable: true,
			value() {
				throw new Error('patched Set.add');
			}
		},
		has: {
			configurable: true,
			value() {
				throw new Error('patched Set.has');
			}
		}
	});
	Object.defineProperties(Map.prototype, {
		has: {
			configurable: true,
			value() {
				throw new Error('patched Map.has');
			}
		},
		set: {
			configurable: true,
			value() {
				throw new Error('patched Map.set');
			}
		}
	});
	Object.defineProperties(WeakMap.prototype, {
		get: {
			configurable: true,
			value() {
				throw new Error('patched WeakMap.get');
			}
		},
		has: {
			configurable: true,
			value() {
				throw new Error('patched WeakMap.has');
			}
		},
		set: {
			configurable: true,
			value() {
				throw new Error('patched WeakMap.set');
			}
		}
	});
	try {
		await outbox.append({
			id: 'collection-intrinsic-1',
			model: 'outbox_transaction_account',
			modelId: 1,
			operation: 'create',
			data: { id: 1, handle: 'first' },
			createdAt: '2026-05-13T00:00:01.000Z'
		});
		await assert.rejects(
			() =>
				outbox.append({
					id: 'collection-intrinsic-1',
					model: 'outbox_transaction_account',
					modelId: 2,
					operation: 'update',
					data: { id: 2, handle: 'second' },
					createdAt: '2026-05-13T00:00:02.000Z'
				}),
			/Memory outbox event id "collection-intrinsic-1" already exists/
		);
		await assert.rejects(
			() =>
				outbox.requeue([
					{
						id: 'collection-intrinsic-requeue',
						model: 'outbox_transaction_account',
						modelId: 3,
						operation: 'delete',
						createdAt: '2026-05-13T00:00:03.000Z'
					},
					{
						id: 'collection-intrinsic-requeue',
						model: 'outbox_transaction_account',
						modelId: 4,
						operation: 'delete',
						createdAt: '2026-05-13T00:00:04.000Z'
					}
				]),
			/memory outbox requeue events contains duplicate event id "collection-intrinsic-requeue"/
		);
		await assert.rejects(
			() =>
				runSearchSyncWorker({
					outbox,
					search: new MemorySearchAdapter(),
					models: [OutboxAccount, OutboxAccount]
				}),
			/duplicate model name "outbox_transaction_account"/
		);

		const failingOutbox = new MemoryOutboxAdapter();
		await failingOutbox.append({
			id: 'collection-intrinsic-recover',
			model: 'outbox_transaction_account',
			modelId: 5,
			operation: 'create',
			data: { id: 5, handle: 'recover' },
			createdAt: '2026-05-13T00:00:05.000Z'
		});
		const failingSearch: SearchAdapter = {
			kind: 'failing-search',
			capabilities: { index: true },
			search: async () => ({ list: [], more: false }),
			index: async () => {
				throw new Error('index down');
			},
			delete: async () => undefined
		};
		await assert.rejects(
			() => runSearchSyncWorker({ outbox: failingOutbox, search: failingSearch, models: [OutboxAccount] }),
			/index down/
		);
		assert.deepEqual((await failingOutbox.list()).map((event) => event.id), ['collection-intrinsic-recover']);
	} finally {
		Object.defineProperty(Set.prototype, 'add', originals.setAdd);
		Object.defineProperty(Set.prototype, 'has', originals.setHas);
		Object.defineProperty(Map.prototype, 'has', originals.mapHas);
		Object.defineProperty(Map.prototype, 'set', originals.mapSet);
		Object.defineProperty(WeakMap.prototype, 'get', originals.weakMapGet);
		Object.defineProperty(WeakMap.prototype, 'has', originals.weakMapHas);
		Object.defineProperty(WeakMap.prototype, 'set', originals.weakMapSet);
	}
});

test('memory outbox drain and requeue ignore patched Array queue mutators', async () => {
	const outbox = new MemoryOutboxAdapter();
	await outbox.append({
		id: 'queue-mutator-a',
		model: 'outbox_transaction_account',
		modelId: 1,
		operation: 'create',
		data: { id: 1, handle: 'a' },
		createdAt: '2026-05-13T00:00:01.000Z'
	});
	await outbox.append({
		id: 'queue-mutator-b',
		model: 'outbox_transaction_account',
		modelId: 2,
		operation: 'update',
		data: { id: 2, handle: 'b' },
		createdAt: '2026-05-13T00:00:02.000Z'
	});
	await outbox.append({
		id: 'queue-mutator-c',
		model: 'outbox_transaction_account',
		modelId: 3,
		operation: 'delete',
		createdAt: '2026-05-13T00:00:03.000Z'
	});

	const originalSplice = Array.prototype.splice;
	const originalUnshift = Array.prototype.unshift;
	Object.defineProperty(Array.prototype, 'splice', {
		configurable: true,
		value() {
			throw new Error('patched Array.splice');
		}
	});
	Object.defineProperty(Array.prototype, 'unshift', {
		configurable: true,
		value() {
			throw new Error('patched Array.unshift');
		}
	});
	try {
		const drained = await outbox.drain({ limit: 2 });
		assert.deepEqual(drained.map((event) => event.id), ['queue-mutator-a', 'queue-mutator-b']);
		assert.deepEqual((await outbox.list()).map((event) => event.id), ['queue-mutator-c']);
		await outbox.requeue(drained);
		assert.deepEqual((await outbox.list()).map((event) => event.id), [
			'queue-mutator-a',
			'queue-mutator-b',
			'queue-mutator-c'
		]);
	} finally {
		Object.defineProperty(Array.prototype, 'splice', { configurable: true, value: originalSplice });
		Object.defineProperty(Array.prototype, 'unshift', { configurable: true, value: originalUnshift });
	}
});

test('outbox plugin rejects malformed options up front', () => {
	assert.throws(() => createOutboxPlugin(null as any), /Outbox plugin options must be an object/);
	assert.throws(
		() => createOutboxPlugin(Object.assign(Object.create({}), { outbox: new MemoryOutboxAdapter() }) as any),
		/Outbox plugin options must be a plain object/
	);
	let adapterGetterCalls = 0;
	const accessorOutbox = Object.defineProperty({}, 'append', {
		enumerable: true,
		get() {
			adapterGetterCalls++;
			return async () => undefined;
		}
	});
	assert.throws(
		() => createOutboxPlugin({ outbox: accessorOutbox as any }),
		/Outbox adapter member "append" must be a data property/
	);
	assert.equal(adapterGetterCalls, 0);
	const hiddenOutbox = Object.defineProperty({}, 'append', {
		enumerable: false,
		value: async () => undefined
	});
	assert.throws(
		() => createOutboxPlugin({ outbox: hiddenOutbox as any }),
		/Outbox adapter member "append" must be enumerable/
	);

	let getterCalls = 0;
	const accessorOptions = Object.defineProperty({ outbox: new MemoryOutboxAdapter() }, 'includeData', {
		enumerable: true,
		get() {
			getterCalls++;
			return true;
		}
	});
	assert.throws(
		() => createOutboxPlugin(accessorOptions as any),
		/Outbox plugin options "includeData" must be a data property/
	);
	assert.equal(getterCalls, 0);
	const hiddenOptions = Object.defineProperty({ outbox: new MemoryOutboxAdapter() }, 'includeData', {
		enumerable: false,
		value: true
	});
	assert.throws(
		() => createOutboxPlugin(hiddenOptions as any),
		/Outbox plugin options "includeData" must be enumerable/
	);
	assert.throws(
		() => createOutboxPlugin({ outbox: new MemoryOutboxAdapter(), [Symbol('outbox')]: true } as any),
		/Outbox plugin options cannot contain symbol fields/
	);
	assert.throws(
		() => createOutboxPlugin({ outbox: new MemoryOutboxAdapter(), includeDate: true } as any),
		/Outbox plugin options contains unknown option "includeDate"/
	);
	const hiddenUnknownOptions = Object.defineProperty({ outbox: new MemoryOutboxAdapter() }, 'includeDate', {
		enumerable: false,
		value: true
	});
	assert.throws(
		() => createOutboxPlugin(hiddenUnknownOptions as any),
		/Outbox plugin options contains unknown option "includeDate"/
	);
	assert.throws(
		() => createOutboxPlugin({ outbox: {} } as any),
		/outbox.append must be a function/
	);
	assert.throws(
		() => createOutboxPlugin({ outbox: new MemoryOutboxAdapter(), includeData: 'yes' as any }),
		/includeData must be a boolean/
	);
	assert.throws(
		() => createOutboxPlugin({
			outbox: new MemoryOutboxAdapter(),
			allowUnsafeTransactionDeferredAppend: 'yes'
		} as any),
		/allowUnsafeTransactionDeferredAppend must be a boolean/
	);
	assert.throws(
		() => createOutboxPlugin({ outbox: new MemoryOutboxAdapter(), id: 'event-id' as any }),
		/Outbox plugin id must be a function/
	);
});

test('outbox search sync validates options before draining', async () => {
	let drainCalls = 0;
	const outbox = {
		append: async () => undefined,
		requeue: async () => undefined,
		drain: async () => {
			drainCalls++;
			return [];
		}
	};
	const search = {
		kind: 'test-search',
		capabilities: { index: true },
		async search() {
			return { list: [], more: false };
		},
		async index() {},
		async delete() {}
	};

	await assert.rejects(
		() => runSearchSyncWorker(null as any),
		/Outbox search sync options must be an object/
	);
	await assert.rejects(
		() => runSearchSyncWorker(Object.assign(Object.create({}), { outbox, search, models: [OutboxAccount] }) as any),
		/Outbox search sync options must be a plain object/
	);
	let getterCalls = 0;
	const accessorOptions = Object.defineProperty({ outbox, search }, 'models', {
		enumerable: true,
		get() {
			getterCalls++;
			return [OutboxAccount];
		}
	});
	await assert.rejects(
		() => runSearchSyncWorker(accessorOptions as any),
		/Outbox search sync options "models" must be a data property/
	);
	assert.equal(getterCalls, 0);
	const hiddenOptions = Object.defineProperty({ outbox, search }, 'models', {
		enumerable: false,
		value: [OutboxAccount]
	});
	await assert.rejects(
		() => runSearchSyncWorker(hiddenOptions as any),
		/Outbox search sync options "models" must be enumerable/
	);
	await assert.rejects(
		() => runSearchSyncWorker({ outbox, search, models: [OutboxAccount], [Symbol('models')]: true } as any),
		/Outbox search sync options cannot contain symbol fields/
	);
	await assert.rejects(
		() => runSearchSyncWorker({ outbox, search, model: [OutboxAccount] } as any),
		/Outbox search sync options contains unknown option "model"/
	);
	await assert.rejects(
		() => runSearchSyncWorker({ outbox, search, models: [OutboxAccount], batchSize: 0 }),
		/Outbox search sync batchSize must be a positive safe integer/
	);
	await assert.rejects(
		() => runSearchSyncWorker({ outbox, search, models: [OutboxAccount], batchSize: 1.5 }),
		/Outbox search sync batchSize must be a positive safe integer/
	);
	await assert.rejects(
		() => runSearchSyncWorker({
			outbox,
			search,
			models: [OutboxAccount],
			allowUnsafeDrainFallback: 'yes'
		} as any),
		/Outbox search sync allowUnsafeDrainFallback must be a boolean/
	);
	await assert.rejects(
		() => runSearchSyncWorker({
			outbox,
			search,
			models: [OutboxAccount],
			allowUnsafeIdentityOnlyDatastoreDelete: 'yes'
		} as any),
		/Outbox search sync allowUnsafeIdentityOnlyDatastoreDelete must be a boolean/
	);
	const hiddenBatchSizeOptions = Object.defineProperty({ outbox, search, models: [OutboxAccount] }, 'batchSize', {
		enumerable: false,
		value: 1
	});
	await assert.rejects(
		() => runSearchSyncWorker(hiddenBatchSizeOptions as any),
		/Outbox search sync options "batchSize" must be enumerable/
	);
	const hiddenUnknownOptions = Object.defineProperty({ outbox, search, models: [OutboxAccount] }, 'model', {
		enumerable: false,
		value: [OutboxAccount]
	});
	await assert.rejects(
		() => runSearchSyncWorker(hiddenUnknownOptions as any),
		/Outbox search sync options contains unknown option "model"/
	);
	let adapterGetterCalls = 0;
	const accessorOutbox = Object.defineProperty({ append: async () => undefined }, 'drain', {
		enumerable: true,
		get() {
			adapterGetterCalls++;
			return async () => [];
		}
	});
	await assert.rejects(
		() => runSearchSyncWorker({ outbox: accessorOutbox as any, search, models: [OutboxAccount] }),
		/Outbox adapter member "drain" must be a data property/
	);
	assert.equal(adapterGetterCalls, 0);
	const accessorSearch = Object.defineProperty(
		{
			kind: 'accessor-search',
			capabilities: { index: true },
			search: async () => ({ list: [], more: false }),
			delete: async () => undefined
		},
		'index',
		{
			enumerable: true,
			get() {
				adapterGetterCalls++;
				return async () => undefined;
			}
		}
	);
	await assert.rejects(
		() => runSearchSyncWorker({ outbox, search: accessorSearch as any, models: [OutboxAccount] }),
		/Outbox adapter member "index" must be a data property/
	);
	assert.equal(adapterGetterCalls, 0);
	const hiddenSearch = Object.defineProperty(
		{
			kind: 'hidden-search',
			capabilities: { index: true },
			search: async () => ({ list: [], more: false }),
			delete: async () => undefined
		},
		'index',
		{
			enumerable: false,
			value: async () => undefined
		}
	);
	await assert.rejects(
		() => runSearchSyncWorker({ outbox, search: hiddenSearch as any, models: [OutboxAccount] }),
		/Outbox adapter member "index" must be enumerable/
	);
	const accessorCapabilities = Object.defineProperty({}, 'index', {
		enumerable: true,
		get() {
			getterCalls++;
			return true;
		}
	});
	await assert.rejects(
		() =>
			runSearchSyncWorker({
				outbox,
				search: { ...search, capabilities: accessorCapabilities },
				models: [OutboxAccount]
			} as any),
		/Outbox search sync search capabilities "index" must be a data property/
	);
	assert.equal(getterCalls, 0);
	await assert.rejects(
		() =>
			runSearchSyncWorker({
				outbox,
				search: { ...search, capabilities: { index: true, textContain: true } },
				models: [OutboxAccount]
			} as any),
		/Outbox search sync search capabilities contains unknown capability "textContain"/
	);
	await assert.rejects(
		() =>
			runSearchSyncWorker({
				outbox,
				search: { ...search, capabilities: { index: true, cursor: 'yes' } },
				models: [OutboxAccount]
			} as any),
		/Outbox search sync search capabilities\.cursor must be a boolean/
	);
	await assert.rejects(
		() =>
			runSearchSyncWorker({
				outbox,
				search: { ...search, capabilities: { index: true, whereOperators: { textContain: true } } },
				models: [OutboxAccount]
			} as any),
		/Outbox search sync search capabilities\.whereOperators contains unknown operator "textContain"/
	);
	await assert.rejects(
		() => runSearchSyncWorker({ outbox: {}, search, models: [OutboxAccount] } as any),
		/outbox.append must be a function/
	);
	await assert.rejects(
		() => runSearchSyncWorker({ outbox: { append: async () => undefined }, search, models: [OutboxAccount] } as any),
		/does not support drain/
	);
	await assert.rejects(
		() =>
			runSearchSyncWorker({
				outbox: { append: async () => undefined, drain: async () => [] },
				search,
				models: [OutboxAccount]
			} as any),
		/drain requires Outbox search sync outbox\.requeue/
	);
	let leaseCalls = 0;
	const leaseWithoutCurrent = {
		append: async () => undefined,
		lease: async () => {
			leaseCalls++;
			return [];
		},
		retry: async () => undefined,
		ack: async () => undefined
	};
	await assert.rejects(
		() => runSearchSyncWorker({ outbox: leaseWithoutCurrent, search, models: [OutboxAccount] } as any),
		/must be configured together for search sync/
	);
	assert.equal(leaseCalls, 0);
	const leaseWithoutRelease = {
		append: async () => undefined,
		lease: async () => {
			leaseCalls++;
			return [];
		},
		isLeaseCurrent: async () => true,
		retry: async () => undefined,
		ack: async () => undefined
	};
	await assert.rejects(
		() => runSearchSyncWorker({ outbox: leaseWithoutRelease, search, models: [OutboxAccount] } as any),
		/must be configured together for search sync/
	);
	assert.equal(leaseCalls, 0);
	const leaseWithoutRetry = {
		append: async () => undefined,
		lease: async () => {
			leaseCalls++;
			return [];
		},
		isLeaseCurrent: async () => true,
		release: async () => undefined,
		ack: async () => undefined
	};
	const leaseContext = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });
	await assert.rejects(
		() => runSearchSyncWorker({
			outbox: leaseWithoutRetry,
			search,
			models: [OutboxAccount],
			context: leaseContext,
			batchSize: 1
		}),
		/Outbox search sync outbox\.retry must be configured together for search sync/
	);
	assert.equal(leaseCalls, 0);
	await assert.rejects(
		() => runSearchSyncWorker({ outbox, search: { delete: async () => undefined }, models: [OutboxAccount] } as any),
		/search.index must be a function/
	);
	await assert.rejects(
		() =>
			runSearchSyncWorker({
				outbox,
				search: { ...search, kind: 'bad\0kind' },
				models: [OutboxAccount]
			}),
		/Outbox search sync search\.kind/
	);
	await assert.rejects(
		() => runSearchSyncWorker({ outbox, search, models: 'outbox_transaction_account' as any }),
		/models must be an array/
	);
	await assert.rejects(
		() => runSearchSyncWorker({ outbox, search, models: [null] as any }),
		/models\[0\] must be a model constructor/
	);
	const originalArrayEntries = Array.prototype.entries;
	Object.defineProperty(Array.prototype, 'entries', {
		configurable: true,
		value() {
			throw new Error('patched Array.entries');
		}
	});
	try {
		await assert.rejects(
			() => runSearchSyncWorker({ outbox, search, models: [null] as any }),
			/models\[0\] must be a model constructor/
		);
	} finally {
		Object.defineProperty(Array.prototype, 'entries', { configurable: true, value: originalArrayEntries });
	}
	await assert.rejects(
		() => runSearchSyncWorker({ outbox, search, models: new Array(1) as any }),
		/models\[0\] is missing/
	);
	const iteratorModels = [OutboxAccount] as any[];
	let modelIteratorCalls = 0;
	Object.defineProperty(iteratorModels, Symbol.iterator, {
		value() {
			modelIteratorCalls++;
			throw new Error('custom outbox model iterator should not run');
		}
	});
	await assert.rejects(
		() => runSearchSyncWorker({ outbox, search, models: iteratorModels }),
		/Outbox search sync models cannot contain symbol fields/
	);
	assert.equal(modelIteratorCalls, 0);
	await assert.rejects(
		() => runSearchSyncWorker({ outbox, search, models: [OutboxAccount], context: {} as any }),
		/context must be an ActiveContext/
	);
	await assert.rejects(
		() =>
			runSearchSyncWorker({
				outbox,
				search: {
					kind: 'non-indexing-search',
					capabilities: { index: false },
					search: async () => ({ list: [], more: false }),
					index: async () => undefined,
					delete: async () => undefined
				},
				models: [OutboxAccount]
			}),
		/does not support indexing/
	);
	await assert.rejects(
		() =>
			runSearchSyncWorker({
				outbox,
				search,
				models: [OutboxAccount],
				context: {
					meta: () => ({}),
					store: () => ({}),
					instantiate: () => ({})
				} as any
			}),
		/context must be an ActiveContext/
	);
	assert.equal(drainCalls, 0);
});

test('outbox search sync allows explicit drain fallback when exclusive leases are disabled', async () => {
	const attempts: string[] = [];
	const events = [
		{
			id: 'fallback-drain-lease-disabled',
			model: 'outbox_transaction_account',
			modelId: 1,
			operation: 'create' as const,
			data: { id: 1, handle: 'fallback' },
			createdAt: '2026-05-13T00:00:00.000Z'
		}
	];
	const outbox = {
		async append() {
			throw new Error('append fallback should not run');
		},
		async lease() {
			attempts.push('lease');
			throw new Error('lease should not run');
		},
		async ack() {
			attempts.push('ack');
		},
		supportsExclusiveLease() {
			attempts.push('supports-exclusive-lease');
			return false;
		},
		async requeue(events: any[]) {
			for (const event of events) attempts.push(`requeue:${event.id}`);
		},
		async drain() {
			attempts.push('drain');
			return events;
		}
	};
	const search = new MemorySearchAdapter();
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });

	assert.equal(await runSearchSyncWorker({
		outbox,
		search,
		models: [OutboxAccount],
		context,
		allowUnsafeDrainFallback: true
	}), 1);
	assert.deepEqual(attempts, ['supports-exclusive-lease', 'drain']);
	assert.deepEqual((await search.search(context.meta(OutboxAccount), 'fallback', {})).list, [
		{ id: 1, handle: 'fallback' }
	]);
});

test('outbox search sync requeues failed drain batches and preserves original failures', async () => {
	const attempts: string[] = [];
	const events = [
		{
			id: 'failed-1',
			model: 'outbox_transaction_account',
			modelId: 1,
			operation: 'create' as const,
			data: { id: 1, handle: 'first' },
			createdAt: '2026-05-13T00:00:00.000Z'
		},
		{
			id: 'failed-2',
			model: 'outbox_transaction_account',
			modelId: 2,
			operation: 'create' as const,
			data: { id: 2, handle: 'second' },
			createdAt: '2026-05-13T00:00:01.000Z'
		}
	];
	const outbox = {
		async append() {
			throw new Error('append fallback should not run');
		},
		async requeue(events: any[]) {
			for (const event of events) attempts.push(event.id);
			throw new Error('requeue down');
		},
		async drain() {
			return events;
		}
	};
	const search = {
		kind: 'failing-search',
		searchIndexKind: 'memory',
		capabilities: { index: true },
		async search() {
			return { list: [] };
		},
		async index() {
			throw new Error('index down');
		},
		async delete() {}
	};
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });

	await assert.rejects(
		() => runSearchSyncWorker({ outbox, search, models: [OutboxAccount], context }),
		(error: unknown) => {
			assert.ok(error instanceof AggregateError);
			assert.match(error.message, /index down/);
			assert.deepEqual(
				error.errors.map((item: Error) => item.message),
				['index down', 'index down', 'requeue down']
			);
			return true;
		}
	);
	assert.deepEqual(attempts, ['failed-1', 'failed-2']);
});

test('outbox search sync rejects drain adapters without ordered requeue', async () => {
	const attempts: string[] = [];
	const events = [
		{
			id: 'drain-only-1',
			model: 'outbox_transaction_account',
			modelId: 1,
			operation: 'create' as const,
			data: { id: 1, handle: 'first' },
			createdAt: '2026-05-13T00:00:00.000Z'
		}
	];
	const outbox = {
		async append(event: any) {
			attempts.push(event.id);
		},
		async drain() {
			attempts.push('drain');
			return events;
		}
	};
	const search = {
		kind: 'failing-search',
		searchIndexKind: 'memory',
		capabilities: { index: true },
		async search() {
			return { list: [] };
		},
		async index() {
			throw new Error('index down');
		},
		async delete() {}
	};
	const context = createActiveTs({ stores: { default: new MemoryStoreAdapter() } });

	await assert.rejects(
		() => runSearchSyncWorker({ outbox, search, models: [OutboxAccount], context }),
		/drain requires Outbox search sync outbox\.requeue/
	);
	assert.deepEqual(attempts, []);
});

test('outbox search sync rejects static modelName accessors without invocation', async () => {
	let modelNameReads = 0;
	class AccessorOutboxModel extends Model<OutboxAccountData> {}
	Object.defineProperty(AccessorOutboxModel, 'modelName', {
		configurable: true,
		get() {
			modelNameReads++;
			return 'outbox_transaction_account';
		}
	});

	await assert.rejects(
		() =>
			runSearchSyncWorker({
				outbox: new MemoryOutboxAdapter(),
				search: new MemorySearchAdapter(),
				models: [AccessorOutboxModel]
			}),
		/Outbox search sync model modelName must be a data property/
	);
	assert.equal(modelNameReads, 0);
});
