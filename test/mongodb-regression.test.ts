import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoError, ReadConcern, ReadPreference, WriteConcern } from 'mongodb';
import type { ResolvedModelMeta } from '../src/index.js';
import {
	ActiveTsCommittedTransactionError,
	ActiveTsConflictError,
	ActiveTsNotFoundError,
	ActiveTsUnknownTransactionOutcomeError,
	Model,
	createActiveTs,
	defineModel
} from '../src/index.js';
import { createMongoStoreAdapter } from '../src/adapters/store/mongodb.js';

type MongoRegressionData = {
	id: number;
	handle: string;
	score?: number;
	version?: number;
};

const meta: ResolvedModelMeta<MongoRegressionData> = {
	model: class {},
	name: 'mongo_regression_record',
	store: 'default',
	idField: 'id',
	readValidation: 'off',
	indexes: [{ name: 'handle_idx', fields: ['handle'] }],
	searchIndexes: [],
	relations: new Map(),
	hooks: {},
	views: new Map(),
	policies: new Map(),
	scopes: new Map(),
	fieldCodecs: new Map(),
	fieldTypes: new Map()
};

function mongoAdapter(
	collection: Record<string, any>,
	collections: unknown[] = [{ name: meta.name }],
	extraOptions: Record<string, unknown> = {}
) {
	return createMongoStoreAdapter({
		dbName: 'test',
		...extraOptions,
		client: {
			db: () => ({
				collection: () => collection,
				createCollection: async () => undefined,
				listCollections: () => ({
					toArray: async () => collections,
					map: (fn: (item: unknown) => unknown) => ({
						toArray: async () => {
							const result: unknown[] = [];
							for (let index = 0; index < collections.length; index++) result[index] = fn(collections[index]);
							return result;
						}
					})
				})
			})
		}
	});
}

function mongoField(field: string, condition: unknown) {
	return { [field]: condition };
}

function mongoScalarField(field: string, condition: unknown) {
	return {
		$and: [
			mongoField(field, { $exists: true }),
			mongoField(field, { $not: { $type: 'array' } }),
			mongoField(field, condition)
		]
	};
}

test('MongoDB transactions bind every portable operation to one session and close retained handles', async () => {
	const calls: Array<{ operation: string; options?: Record<string, unknown> }> = [];
	const rows = new Map<string, Record<string, unknown>>();
	const session = {
		startTransaction: async (options?: Record<string, unknown>) => {
			calls.push({ operation: 'startTransaction', options });
		},
		commitTransaction: async (options?: Record<string, unknown>) => {
			calls.push({ operation: 'commitTransaction', options });
		},
		abortTransaction: async (options?: Record<string, unknown>) => {
			calls.push({ operation: 'abortTransaction', options });
		},
		endSession: async () => {
			calls.push({ operation: 'endSession' });
		}
	};
	const collection = {
		findOne: async (filter: { _id: string }, options?: Record<string, unknown>) => {
			calls.push({ operation: 'findOne', options });
			return rows.get(filter._id) ?? null;
		},
		find: (_filter: unknown, options?: Record<string, unknown>) => {
			calls.push({ operation: 'find', options });
			return { toArray: async () => [...rows.values()] };
		},
		aggregate: (_pipeline: unknown, options?: Record<string, unknown>) => {
			calls.push({ operation: 'aggregate', options });
			return { toArray: async () => [] };
		},
		insertOne: async (document: Record<string, unknown>, options?: Record<string, unknown>) => {
			calls.push({ operation: 'insertOne', options });
			rows.set(document._id as string, document);
		},
		replaceOne: async (filter: { _id: string }, document: Record<string, unknown>, options?: Record<string, unknown>) => {
			calls.push({ operation: 'replaceOne', options });
			if (!rows.has(filter._id)) return { matchedCount: 0 };
			rows.set(filter._id, document);
			return { matchedCount: 1 };
		},
		deleteOne: async (filter: { _id: string }, options?: Record<string, unknown>) => {
			calls.push({ operation: 'deleteOne', options });
			return { deletedCount: rows.delete(filter._id) ? 1 : 0 };
		}
	};
	let startSessionOptions: unknown;
	const adapter = await createMongoStoreAdapter({
		dbName: 'test',
		cacheScope: 'mongodb|cluster=integration|db=test',
		client: {
			db: () => ({ collection: () => collection }),
			startSession: (options?: unknown) => {
				startSessionOptions = options;
				return session;
			}
		}
	});
	assert.equal(adapter.cacheScope, 'mongodb|cluster=integration|db=test');
	let retained: typeof adapter | undefined;
	const result = await adapter.transaction!(async (tx) => {
		retained = tx;
		assert.equal(tx.cacheScope, adapter.cacheScope);
		assert.equal(tx.capabilities?.transaction, false);
		assert.equal(tx.capabilities?.native, false);
		assert.equal(Object.isFrozen(tx.capabilities), true);
		assert.equal(tx.transaction, undefined);
		assert.equal(tx.schema, undefined);
		await tx.create(meta, 1, { id: 1, handle: 'one' });
		assert.equal((await tx.get(meta, 1))?.handle, 'one');
		await tx.getMany(meta, [1]);
		await tx.query(meta, { where: [], or: [], sort: [], include: [] });
		await tx.aggregate!(meta, { where: [], or: [], aggregates: [{ op: 'count', as: 'count' }] });
		await tx.update(meta, 1, { id: 1, handle: 'next' });
		await tx.delete(meta, 1);
		return 'committed';
	}, {
		timeoutMs: 50,
		native: {
			readConcern: { level: 'snapshot' },
			writeConcern: { w: 'majority' },
			readPreference: 'primary',
			maxCommitTimeMS: 40
		}
	});

	assert.equal(result, 'committed');
	assert.deepEqual(startSessionOptions, { defaultTimeoutMS: 50 });
	assert.deepEqual(calls[0], {
		operation: 'startTransaction',
		options: {
			readConcern: { level: 'snapshot' },
			writeConcern: { w: 'majority' },
			readPreference: 'primary',
			maxCommitTimeMS: 40
		}
	});
	for (const call of calls.filter(({ operation }) =>
		['findOne', 'find', 'aggregate', 'insertOne', 'replaceOne', 'deleteOne'].includes(operation)
	)) {
		assert.equal(call.options?.session, session, `${call.operation} must use the transaction session`);
	}
	assert.deepEqual(calls.slice(-2), [
		{ operation: 'commitTransaction', options: { timeoutMS: 50 } },
		{ operation: 'endSession' }
	]);
	await assert.rejects(() => retained!.get(meta, 1), /closed MongoDB store transaction adapter after commit/);
});

test('MongoDB transactions expose only labeled unknown outcomes and preserve definitive rollback errors', async () => {
	let commitError: unknown;
	let abortError: unknown;
	let endError: unknown;
	let abortCalls = 0;
	let endCalls = 0;
	const session = {
		startTransaction: async () => undefined,
		commitTransaction: async () => {
			if (commitError !== undefined) throw commitError;
		},
		abortTransaction: async () => {
			abortCalls++;
			if (abortError !== undefined) throw abortError;
		},
		endSession: async () => {
			endCalls++;
			if (endError !== undefined) throw endError;
		}
	};
	const adapter = await createMongoStoreAdapter({
		dbName: 'test',
		client: {
			db: () => ({ collection: () => ({}) }),
			startSession: () => session
		}
	});
	const callbackError = new Error('callback failed');
	await assert.rejects(
		() => adapter.transaction!(async () => { throw callbackError; }),
		(error) => error === callbackError
	);
	assert.equal(abortCalls, 1);
	assert.equal(endCalls, 1);

	const plainCommitError = new Error('unlabeled commit failure');
	commitError = plainCommitError;
	await assert.rejects(
		() => adapter.transaction!(async () => 'definitive rollback'),
		(error) => error === plainCommitError
	);
	assert.equal(abortCalls, 1, 'a commit response must not be followed by abort');

	const transientCommitError = new Error('transient transaction failure');
	Object.defineProperty(transientCommitError, 'errorLabelSet', {
		value: new Set(['TransientTransactionError']),
		enumerable: true
	});
	commitError = transientCommitError;
	await assert.rejects(
		() => adapter.transaction!(async () => 'definitive transient rollback'),
		(error) =>
			error instanceof ActiveTsConflictError &&
			(error as ActiveTsConflictError & { cause?: unknown }).cause === transientCommitError
	);

	const unknownCommitCause = new Error('commit response lost');
	Object.defineProperty(unknownCommitCause, 'errorLabels', {
		value: ['UnknownTransactionCommitResult'],
		enumerable: true
	});
	commitError = unknownCommitCause;
	await assert.rejects(
		() => adapter.transaction!(async () => 'unknown'),
		(error) =>
			error instanceof ActiveTsUnknownTransactionOutcomeError &&
			error.outcome === 'unknown' &&
			error.phase === 'commit' &&
			error.cause === unknownCommitCause
	);
	assert.equal(abortCalls, 1, 'an unknown commit outcome must not issue abort');

	let labelAccessorCalls = 0;
	let codeAccessorCalls = 0;
	const accessorCommitError = new Error('hostile commit error');
	Object.defineProperties(accessorCommitError, {
		errorLabels: {
			get() {
				labelAccessorCalls++;
				return ['UnknownTransactionCommitResult'];
			},
			enumerable: true
		},
		code: {
			get() {
				codeAccessorCalls++;
				return 251;
			},
			enumerable: true
		}
	});
	commitError = accessorCommitError;
	await assert.rejects(
		() => adapter.transaction!(async () => 'accessor rollback'),
		(error) => error === accessorCommitError
	);
	assert.equal(labelAccessorCalls, 0);
	assert.equal(codeAccessorCalls, 0);

	const dualLabelCommitError = new MongoError('transaction commit response was lost');
	dualLabelCommitError.addErrorLabel('TransientTransactionError');
	dualLabelCommitError.addErrorLabel('UnknownTransactionCommitResult');
	commitError = dualLabelCommitError;
	await assert.rejects(
		() => adapter.transaction!(async () => 'possibly committed'),
		(error) =>
			error instanceof ActiveTsUnknownTransactionOutcomeError &&
			error.phase === 'commit' &&
			error.cause === dualLabelCommitError
	);

	commitError = undefined;
	abortError = new Error('abort transport failed');
	await assert.rejects(
		() => adapter.transaction!(async () => { throw callbackError; }),
		(error) => {
			if (!(error instanceof ActiveTsUnknownTransactionOutcomeError)) return false;
			assert.equal(error.outcome, 'unknown');
			assert.equal(error.phase, 'abort');
			assert.ok(error.cause instanceof AggregateError);
			assert.deepEqual(error.cause.errors, [callbackError, abortError]);
			return true;
		}
	);

	abortError = undefined;
	endError = new Error('end session failed');
	await assert.rejects(
		() => adapter.transaction!(async () => 'committed-result'),
		(error) =>
			error instanceof ActiveTsCommittedTransactionError &&
			error.committed === true &&
			error.result === 'committed-result'
	);
});

test('MongoDB transactions preserve undefined rejection reasons across every phase', async () => {
	for (const phase of ['start', 'callback', 'commit'] as const) {
		const session = {
			startTransaction: async () => {
				if (phase === 'start') return Promise.reject(undefined);
			},
			commitTransaction: async () => {
				if (phase === 'commit') return Promise.reject(undefined);
			},
			abortTransaction: async () => undefined,
			endSession: async () => undefined
		};
		const adapter = await createMongoStoreAdapter({
			dbName: 'test',
			client: {
				db: () => ({ collection: () => ({}) }),
				startSession: () => session
			}
		});
		let rejected = false;
		let rejection: unknown = Symbol('not rejected');
		try {
			await adapter.transaction!(async () => {
				if (phase === 'callback') return Promise.reject(undefined);
				return 'result';
			});
		} catch (error) {
			rejected = true;
			rejection = error;
		}
		assert.equal(rejected, true, `${phase} must reject`);
		assert.equal(rejection, undefined, `${phase} must retain the original rejection reason`);
	}
});

test('MongoDB transactions snapshot supported driver option instances', async () => {
	let capturedOptions: unknown;
	const adapter = await createMongoStoreAdapter({
		dbName: 'test',
		client: {
			db: () => ({ collection: () => ({}) }),
			startSession: () => ({
				startTransaction: async (options?: unknown) => {
					capturedOptions = options;
				},
				commitTransaction: async () => undefined,
				abortTransaction: async () => undefined,
				endSession: async () => undefined
			})
		}
	});

	await adapter.transaction!(async () => undefined, {
		native: {
			readConcern: new ReadConcern('snapshot'),
			writeConcern: new WriteConcern('majority', 250, true),
			readPreference: new ReadPreference('secondary', [{ region: 'east' }], {
				maxStalenessSeconds: 120
			})
		}
	});

	assert.deepEqual(capturedOptions, {
		readConcern: { level: 'snapshot' },
		writeConcern: {
			w: 'majority',
			wtimeoutMS: 250,
			wtimeout: 250,
			journal: true,
			j: true
		},
		readPreference: {
			mode: 'secondary',
			tags: [{ region: 'east' }],
			maxStalenessSeconds: 120
		}
	});
});

test('MongoDB ends a session when session contract normalization fails', async () => {
	let endCalls = 0;
	const adapter = await createMongoStoreAdapter({
		dbName: 'test',
		client: {
			db: () => ({ collection: () => ({}) }),
			startSession: () => ({
				startTransaction: async () => undefined,
				commitTransaction: async () => undefined,
				endSession: async () => {
					endCalls++;
				}
			})
		}
	});

	await assert.rejects(
		() => adapter.transaction!(async () => undefined),
		/MongoDB session\.abortTransaction must be a function/
	);
	assert.equal(endCalls, 1);
});

test('MongoDB validates explicit physical cache scopes', async () => {
	const client = { db: () => ({ collection: () => ({}) }) };
	for (const cacheScope of ['', 'cluster\0database', 123]) {
		await assert.rejects(
			() => createMongoStoreAdapter({ dbName: 'test', client, cacheScope } as never),
			/MongoDB adapter cacheScope must be a non-empty string without null bytes/
		);
	}

	const adapter = await createMongoStoreAdapter({
		dbName: 'test',
		client,
		cacheScope: 'mongodb|cluster=primary|db=test'
	});
	assert.equal(adapter.cacheScope, 'mongodb|cluster=primary|db=test');
});

test('MongoDB transactions reject unsupported options and read-only or native writes before dispatch', async () => {
	let startSessionCalls = 0;
	let abortCalls = 0;
	let insertCalls = 0;
	let nativeCalls = 0;
	const session = {
		startTransaction: async () => undefined,
		commitTransaction: async () => undefined,
		abortTransaction: async () => {
			abortCalls++;
		},
		endSession: async () => undefined
	};
	const adapter = await createMongoStoreAdapter({
		dbName: 'test',
		client: {
			db: () => ({
				collection: () => ({
					insertOne: async () => {
						insertCalls++;
					}
				})
			}),
			startSession: () => {
				startSessionCalls++;
				return session;
			}
		}
	});

	await assert.rejects(
		() => adapter.transaction!(async () => undefined, { isolation: 'serializable' } as never),
		/isolation is not supported/
	);
	await assert.rejects(
		() => adapter.transaction!(async () => undefined, { native: { retryWrites: true } } as never),
		/unknown option "retryWrites"/
	);
	assert.equal(startSessionCalls, 0);
	await assert.rejects(
		() => adapter.transaction!(async (tx) => tx.create(meta, 1, { id: 1, handle: 'one' }), { readOnly: true }),
		/read-only MongoDB transaction/
	);
	assert.equal(insertCalls, 0);
	assert.equal(abortCalls, 1);
	await assert.rejects(
		() => adapter.transaction!(async (tx) => {
			try {
				(tx.capabilities as any).native = true;
			} catch {
				// Frozen capabilities reject mutation in strict runtimes.
			}
			assert.equal(tx.capabilities?.native, false);
			return tx.query(meta, {
				where: [],
				or: [],
				sort: [],
				include: [],
				native: {
					payload: async () => {
						nativeCalls++;
						return { list: [] };
					}
				}
			});
		}),
		/native/
	);
	assert.equal(abortCalls, 2);
	assert.equal(nativeCalls, 0);
});

test('MongoDB sessions make non-empty model bulk writes atomic', async () => {
	type BulkData = { id: number; handle: string };
	class MongoBulkRecord extends Model<BulkData> {}
	defineModel<BulkData>('mongo_bulk_transaction_record')
		.id('id')
		.validate((input) => input as BulkData)
		.attach(MongoBulkRecord);

	let committedRows = new Map<string, Record<string, unknown>>();
	const rowsFor = (options?: Record<string, any>) =>
		(options?.session?.rows as Map<string, Record<string, unknown>> | undefined) ?? committedRows;
	const collection = {
		findOne: async (filter: { _id: string }, options?: Record<string, any>) =>
			rowsFor(options).get(filter._id) ?? null,
		find: (filter: { _id?: { $in?: string[] } }, options?: Record<string, any>) => ({
			toArray: async () => {
				const rows = rowsFor(options);
				const ids = filter._id?.$in;
				return ids ? ids.flatMap((id) => rows.has(id) ? [rows.get(id)!] : []) : [...rows.values()];
			}
		}),
		aggregate: () => ({ toArray: async () => [] }),
		insertOne: async (document: Record<string, unknown>, options?: Record<string, any>) => {
			const rows = rowsFor(options);
			const id = document._id as string;
			if (rows.has(id)) throw Object.assign(new Error('duplicate'), { code: 11000 });
			rows.set(id, document);
		},
		replaceOne: async (filter: { _id: string }, document: Record<string, unknown>, options?: Record<string, any>) => {
			const rows = rowsFor(options);
			if (!rows.has(filter._id)) return { matchedCount: 0 };
			rows.set(filter._id, document);
			return { matchedCount: 1 };
		},
		deleteOne: async (filter: { _id: string }, options?: Record<string, any>) => ({
			deletedCount: rowsFor(options).delete(filter._id) ? 1 : 0
		})
	};
	const adapter = await createMongoStoreAdapter({
		dbName: 'test',
		client: {
			db: () => ({ collection: () => collection }),
			startSession: () => {
				const session: Record<string, any> = {
					rows: new Map<string, Record<string, unknown>>(),
					startTransaction: async () => {
						session.rows = new Map(committedRows);
					},
					commitTransaction: async () => {
						committedRows = new Map(session.rows);
					},
					abortTransaction: async () => undefined,
					endSession: async () => undefined
				};
				return session;
			}
		}
	});
	const context = createActiveTs({ stores: { default: adapter } });
	const Record = MongoBulkRecord.use(context) as typeof MongoBulkRecord;

	const created = await Record.createMany([
		{ id: 1, handle: 'one' },
		{ id: 2, handle: 'two' }
	]);
	assert.deepEqual(created.map(({ data }) => data.handle), ['one', 'two']);
	const upserted = await Record.upsertMany([
		{ id: 1, handle: 'updated' },
		{ id: 3, handle: 'three' }
	]);
	assert.deepEqual(upserted.map(({ operation }) => operation), ['update', 'create']);
	await Record.deleteMany([2, 3]);
	assert.deepEqual(await adapter.getMany(context.meta(Record), [1, 2, 3]), [
		{ id: 1, handle: 'updated' },
		null,
		null
	]);
	await assert.rejects(
		() => Record.transaction(async (tx) => {
			await Record.createMany([
				{ id: 4, handle: 'rolled-back-a' },
				{ id: 5, handle: 'rolled-back-b' }
			], tx);
			throw new Error('bulk rollback');
		}),
		/bulk rollback/
	);
	assert.deepEqual(await adapter.getMany(context.meta(Record), [4, 5]), [null, null]);
});

test('MongoDB adapter rejects missing own write result counters', async () => {
	const plainError = new Error('plain insert failure');
	let replaceResult: unknown = {};
	let deleteResult: unknown = {};
	const adapter = await mongoAdapter({
		insertOne: async () => {
			throw plainError;
		},
		replaceOne: async () => replaceResult,
		find: () => ({ toArray: async () => [] }),
		findOne: async () => null,
		aggregate: () => ({ toArray: async () => [] }),
		deleteOne: async () => deleteResult,
		indexes: async () => [],
		createIndex: async () => undefined
	});

	Object.defineProperties(Object.prototype, {
		code: { value: 11000, configurable: true },
		matchedCount: { value: 1, configurable: true },
		deletedCount: { value: 1, configurable: true }
	});
	try {
		await assert.rejects(() => adapter.create(meta, 1, { id: 1, handle: 'one' }), /plain insert failure/);
		await assert.rejects(() => adapter.update(meta, 1, { id: 1, handle: 'missing' }), /MongoDB replaceOne\.matchedCount is required/);
		await assert.rejects(() => adapter.delete(meta, 1), /MongoDB deleteOne\.deletedCount is required/);
		replaceResult = Object.create({ matchedCount: 1 });
		deleteResult = Object.create({ deletedCount: 1 });
		await assert.rejects(() => adapter.update(meta, 1, { id: 1, handle: 'missing' }), /MongoDB replaceOne\.matchedCount is required/);
		await assert.rejects(() => adapter.delete(meta, 1), /MongoDB deleteOne\.deletedCount is required/);
	} finally {
		delete (Object.prototype as Record<string, unknown>).code;
		delete (Object.prototype as Record<string, unknown>).matchedCount;
		delete (Object.prototype as Record<string, unknown>).deletedCount;
	}

	replaceResult = { matchedCount: '1' };
	await assert.rejects(() => adapter.update(meta, 1, { id: 1, handle: 'bad' }), /MongoDB replaceOne\.matchedCount/);
	deleteResult = { deletedCount: '1' };
	await assert.rejects(() => adapter.delete(meta, 1), /MongoDB deleteOne\.deletedCount/);

	const duplicate = Object.assign(new Error('duplicate'), { code: 11000 });
	const conflictAdapter = await mongoAdapter({
		insertOne: async () => {
			throw duplicate;
		},
		replaceOne: async () => ({ matchedCount: 1 }),
		find: () => ({ toArray: async () => [] }),
		findOne: async () => null,
		aggregate: () => ({ toArray: async () => [] }),
		deleteOne: async () => undefined,
		indexes: async () => [],
		createIndex: async () => undefined
	});
	await assert.rejects(() => conflictAdapter.create(meta, 1, { id: 1, handle: 'one' }), ActiveTsConflictError);
});

test('MongoDB optimistic lock filters require scalar version values', async () => {
	let updateFilter: unknown;
	const adapter = await mongoAdapter({
		insertOne: async () => undefined,
		replaceOne: async (filter: unknown) => {
			updateFilter = filter;
			return { matchedCount: 1 };
		},
		find: () => ({ toArray: async () => [] }),
		findOne: async () => null,
		aggregate: () => ({ toArray: async () => [] }),
		deleteOne: async () => undefined,
		indexes: async () => [],
		createIndex: async () => undefined
	});

	await adapter.update(meta, 1, { id: 1, handle: 'one', version: 2 }, { expectedVersion: 1 });

	assert.deepEqual(updateFilter, {
		$and: [
			{ _id: 'number:1' },
			{
				$and: [
					{ version: { $exists: true } },
					{ version: { $not: { $type: 'array' } } },
					{ version: { $eq: 1 } }
				]
			}
		]
	});
});

test('MongoDB versioned missing writes report not found separately from stale conflicts', async () => {
	let exists = false;
	const adapter = await mongoAdapter({
		insertOne: async () => undefined,
		replaceOne: async () => ({ matchedCount: 0 }),
		find: () => ({ toArray: async () => [] }),
		findOne: async () => exists ? { _id: 'number:1', id: 1, handle: 'one', version: 2 } : null,
		aggregate: () => ({ toArray: async () => [] }),
		deleteOne: async () => ({ deletedCount: 0 }),
		indexes: async () => [],
		createIndex: async () => undefined
	});

	await assert.rejects(
		() => adapter.update(meta, 1, { id: 1, handle: 'missing', version: 2 }, { expectedVersion: 1 }),
		ActiveTsNotFoundError
	);
	await assert.rejects(
		() => adapter.delete(meta, 1, { expectedVersion: 1 }),
		ActiveTsNotFoundError
	);
	exists = true;
	await assert.rejects(
		() => adapter.update(meta, 1, { id: 1, handle: 'stale', version: 2 }, { expectedVersion: 1 }),
		ActiveTsConflictError
	);
	await assert.rejects(
		() => adapter.delete(meta, 1, { expectedVersion: 1 }),
		ActiveTsConflictError
	);
});

test('MongoDB not-equal filters require field existence', async () => {
	let findFilter: unknown;
	const adapter = await mongoAdapter({
		insertOne: async () => undefined,
		replaceOne: async () => ({ matchedCount: 1 }),
		find: (filter: unknown) => {
			findFilter = filter;
			return { toArray: async () => [] };
		},
		findOne: async () => null,
		aggregate: () => ({ toArray: async () => [] }),
		deleteOne: async () => undefined,
		indexes: async () => [],
		createIndex: async () => undefined
	});

	await adapter.query(meta, {
		where: [{ field: 'handle', op: '!=', value: 'one' }],
		or: [],
		sort: [],
		include: []
	});

	assert.deepEqual(findFilter, {
		$or: [
			mongoField('handle', { $type: 'array' }),
			mongoScalarField('handle', { $ne: 'one' })
		]
	});
});

test('MongoDB adapter rejects dollar-prefixed and dotted payload keys before writes', async () => {
	let insertCalls = 0;
	let updateCalls = 0;
	const adapter = await mongoAdapter({
		insertOne: async () => {
			insertCalls++;
		},
		replaceOne: async () => {
			updateCalls++;
			return { matchedCount: 1 };
		},
		find: () => ({ toArray: async () => [] }),
		findOne: async () => null,
		aggregate: () => ({ toArray: async () => [] }),
		deleteOne: async () => undefined,
		indexes: async () => [],
		createIndex: async () => undefined
	});

	await assert.rejects(
		() => adapter.create(meta, 1, { id: 1, handle: 'one', $bad: 'value' } as any),
		/cannot contain MongoDB field "\$bad"/
	);
	await assert.rejects(
		() => adapter.update(meta, 1, { id: 1, handle: 'one', nested: { 'dot.key': 'value' } } as any),
		/cannot contain MongoDB field "dot\.key"/
	);
	assert.equal(insertCalls, 0);
	assert.equal(updateCalls, 0);
});

test('MongoDB data key validation uses captured WeakSet intrinsics', async () => {
	const inserted: unknown[] = [];
	const adapter = await mongoAdapter({
		insertOne: async (document: unknown) => {
			inserted.push(document);
		},
		replaceOne: async () => ({ matchedCount: 1 }),
		find: () => ({ toArray: async () => [] }),
		findOne: async () => null,
		aggregate: () => ({ toArray: async () => [] }),
		deleteOne: async () => ({ deletedCount: 1 }),
		indexes: async () => [],
		createIndex: async () => undefined
	});
	const weakSetHas = WeakSet.prototype.has;
	const weakSetAdd = WeakSet.prototype.add;
	const weakSetDelete = WeakSet.prototype.delete;
	let unsafeError: unknown;
	WeakSet.prototype.has = function () {
		throw new Error('patched WeakSet.has');
	};
	WeakSet.prototype.add = function () {
		throw new Error('patched WeakSet.add');
	};
	WeakSet.prototype.delete = function () {
		throw new Error('patched WeakSet.delete');
	};
	try {
		await adapter.create(meta, 1, { id: 1, handle: 'safe', profile: { name: 'ok' } } as any);
		try {
			await adapter.create(meta, 2, { id: 2, handle: 'unsafe', profile: { $bad: true } } as any);
		} catch (error) {
			unsafeError = error;
		}
	} finally {
		WeakSet.prototype.has = weakSetHas;
		WeakSet.prototype.add = weakSetAdd;
		WeakSet.prototype.delete = weakSetDelete;
	}
	assert.equal(inserted.length, 1);
	assert.deepEqual(inserted[0], { _id: 'number:1', id: 1, handle: 'safe', profile: { name: 'ok' } });
	assert.match(String((unsafeError as Error | undefined)?.message), /cannot contain MongoDB field "\$bad"/);
});

test('MongoDB factory option allowlists use captured Set intrinsics', async () => {
	const setHas = Set.prototype.has;
	let optionError: unknown;
	Set.prototype.has = function () {
		throw new Error('patched Set.has');
	};
	try {
		try {
			await createMongoStoreAdapter({ dbName: 'test', databaseName: 'wrong' } as any);
		} catch (error) {
			optionError = error;
		}
	} finally {
		Set.prototype.has = setHas;
	}
	assert.match(String((optionError as Error | undefined)?.message), /MongoDB adapter options contains unknown option "databaseName"/);
});

test('MongoDB adapter requires own document and schema name fields', async () => {
	let findRows: unknown[] = [];
	let indexRows: unknown[] = [];
	const adapter = await mongoAdapter({
		insertOne: async () => undefined,
		replaceOne: async () => ({ matchedCount: 1 }),
		find: () => ({ toArray: async () => findRows }),
		findOne: async () => null,
		aggregate: () => ({ toArray: async () => [] }),
		deleteOne: async () => undefined,
		indexes: async () => indexRows,
		createIndex: async () => undefined
	});

	findRows = [Object.create({ _id: 'number:1', id: 1, handle: 'inherited' })];
	await assert.rejects(() => adapter.getMany(meta, [1]), /MongoDB getMany document\._id is required/);
	await assert.rejects(() => adapter.getMany(meta, new Array(1) as any), /MongoDB store ids\[0\] is missing/);
	await assert.rejects(
		() =>
			adapter.query(meta, {
				where: [],
				or: [],
				sort: [],
				include: []
			}),
		/MongoDB query document\._id is required/
	);

	const inheritedCollectionAdapter = await mongoAdapter({
		insertOne: async () => undefined,
		replaceOne: async () => ({ matchedCount: 1 }),
		find: () => ({ toArray: async () => [] }),
		findOne: async () => null,
		aggregate: () => ({ toArray: async () => [] }),
		deleteOne: async () => undefined,
		indexes: async () => [],
		createIndex: async () => undefined
	}, [Object.create({ name: meta.name })]);
	await assert.rejects(() => inheritedCollectionAdapter.schema!.plan([meta]), /MongoDB collection\.name must be a string/);

	indexRows = [Object.create({ name: 'handle_idx' })];
	const inheritedIndexPlan = await adapter.schema!.plan([meta]);
	assert.deepEqual(inheritedIndexPlan.changes.map((change) => change.type), ['create-index']);
});

test('MongoDB adapter validates direct document data before returning it', async () => {
	let findOneRow: unknown = null;
	let findRows: unknown[] = [];
	const adapter = await mongoAdapter({
		insertOne: async () => undefined,
		replaceOne: async () => ({ matchedCount: 1 }),
		find: () => ({ toArray: async () => findRows }),
		findOne: async () => findOneRow,
		aggregate: () => ({ toArray: async () => [] }),
		deleteOne: async () => undefined,
		indexes: async () => [],
		createIndex: async () => undefined
	});

	findOneRow = { _id: 'number:1', id: 1, handle: 'unsafe', __unsafe: true };
	await assert.rejects(() => adapter.get(meta, 1), /Reserved data key/);

	findRows = [{ _id: 'number:1', id: 1, handle: 'unsafe', __unsafe: true }];
	await assert.rejects(() => adapter.getMany(meta, [1]), /Reserved data key/);

	findOneRow = { _id: 'number:1', id: 2, handle: 'wrong-id' };
	await assert.rejects(() => adapter.get(meta, 1), /MongoDB document id field "id" must match/);

	findOneRow = { _id: 'number:2', id: 2, handle: 'wrong-storage-id' };
	await assert.rejects(() => adapter.get(meta, 1), /MongoDB document\._id must match the requested id/);

	findRows = [{ _id: 'number:2', id: 2, handle: 'unexpected' }];
	await assert.rejects(() => adapter.getMany(meta, [1]), /MongoDB getMany document id was not requested/);

	findRows = [{ _id: 'number:1', id: 2, handle: 'wrong-id' }];
	await assert.rejects(() => adapter.getMany(meta, [1]), /MongoDB getMany document id field "id" must match/);

	findRows = [
		{ _id: 'number:1', id: 1, handle: 'one' },
		{ _id: 'number:1', id: 1, handle: 'again' }
	];
	await assert.rejects(() => adapter.getMany(meta, [1]), /MongoDB getMany returned duplicate document ids/);

	findRows = [{ _id: 'number:1', id: 1, handle: 'one' }];
	const duplicateRows = await adapter.getMany(meta, [1, 1]);
	assert.deepEqual(duplicateRows, [
		{ id: 1, handle: 'one' },
		{ id: 1, handle: 'one' }
	]);
	assert.notEqual(duplicateRows[0], duplicateRows[1]);

	findRows = [{ _id: 'number:1', id: 1, handle: 'unsafe', __unsafe: true }];
	await assert.rejects(
		() =>
			adapter.query(meta, {
				where: [],
				or: [],
				sort: [],
				include: []
			}),
		/Reserved data key/
	);

	findRows = [{ _id: 'number:1', id: 2, handle: 'wrong-id' }];
	await assert.rejects(
		() =>
			adapter.query(meta, {
				where: [],
				or: [],
				sort: [],
				include: []
			}),
		/MongoDB query document id field "id" must match/
	);

	findRows = [{ _id: 'boolean:true', id: 'boolean:true', handle: 'noncanonical' }];
	await assert.rejects(
		() =>
			adapter.query(meta, {
				where: [],
				or: [],
				sort: [],
				include: []
			}),
		/MongoDB query document\._id must be a canonical active-ts entity id key/
	);

	findRows = [{ _id: 'number:1', id: 1, handle: 'safe' }];
	let mapCalls = 0;
	Object.defineProperty(findRows, 'map', {
		value() {
			mapCalls++;
			throw new Error('custom MongoDB cursor rows.map should not run');
		}
	});
	assert.deepEqual(
		await adapter.query(meta, {
			where: [],
			or: [],
			sort: [],
			include: []
		}),
		{ list: [{ id: 1, handle: 'safe' }], more: false, count: 1 }
	);
	assert.equal(mapCalls, 0);
});

test('MongoDB adapter direct array paths ignore patched Array transforms', async () => {
	let findFilter: unknown;
	let queryFindOptions: unknown;
	let fallbackFindOptions: unknown;
	let sortSpec: unknown;
	let aggregatePipeline: unknown;
	let createIndexSpec: unknown;
	let getManyResult: unknown;
	let queryResult: unknown;
	let fallbackAggregateResult: unknown;
	let pipelineAggregateResult: unknown;
	let schemaPlan: unknown;
	const typedMeta: ResolvedModelMeta<MongoRegressionData> = {
		...meta,
		fieldTypes: new Map([['score', 'number']])
	};
	const adapter = await mongoAdapter({
		insertOne: async () => undefined,
		replaceOne: async () => ({ matchedCount: 1 }),
		find: (filter: unknown, options: unknown) => {
			findFilter = filter;
			if ((options as any)?.projection?.handle) queryFindOptions = options;
			if ((options as any)?.projection?.score) fallbackFindOptions = options;
			return {
				sort(value: unknown) {
					sortSpec = value;
					return this;
				},
				limit() {
					return this;
				},
				toArray: async () => [
					{ _id: 'number:1', id: 1, handle: 'one', score: 3 },
					{ _id: 'number:2', id: 2, handle: 'two', score: 7 }
				]
			};
		},
		findOne: async () => null,
		aggregate: (pipeline: unknown) => {
			aggregatePipeline = pipeline;
			return { toArray: async () => [{ _id: null, total: 10, __activeTsInvalid_total: 0 }] };
		},
		deleteOne: async () => undefined,
		indexes: async () => [{ name: 'handle_idx', key: { handle: 1 } }],
		createIndex: async (spec: unknown) => {
			createIndexSpec = spec;
		}
	}, [{ name: meta.name }], { allowAggregateScanFallback: true });
	const descriptors = {
		map: Object.getOwnPropertyDescriptor(Array.prototype, 'map'),
		filter: Object.getOwnPropertyDescriptor(Array.prototype, 'filter'),
		flatMap: Object.getOwnPropertyDescriptor(Array.prototype, 'flatMap'),
		some: Object.getOwnPropertyDescriptor(Array.prototype, 'some')
	};
	for (const name of Object.keys(descriptors) as Array<keyof typeof descriptors>) {
		Object.defineProperty(Array.prototype, name, {
			configurable: true,
			value() {
				throw new Error(`patched Array.${name}`);
			}
		});
	}
	try {
		getManyResult = await adapter.getMany(meta, [1, 2]);
		queryResult = await adapter.query(typedMeta, {
			where: [{ field: 'score', op: '>=', value: 3 }],
			or: [{ where: [{ field: 'handle', op: 'startsWith', value: 't' }], or: [], sort: [], include: [] }],
			sort: [{ field: 'score', direction: 'desc' }],
			select: ['handle'],
			include: [],
			limit: 2
		});
		fallbackAggregateResult = await adapter.aggregate!(typedMeta, {
			where: [],
			or: [],
			aggregates: [{ op: 'max', field: 'score', as: 'top' }]
		});
		pipelineAggregateResult = await adapter.aggregate!(typedMeta, {
			where: [],
			or: [],
			aggregates: [{ op: 'sum', field: 'score', as: 'total' }]
		});
		schemaPlan = await adapter.schema!.plan([meta]);
		await adapter.schema!.apply([meta], { mode: 'safe' });
	} finally {
		for (const name of Object.keys(descriptors) as Array<keyof typeof descriptors>) {
			const descriptor = descriptors[name];
			if (descriptor) Object.defineProperty(Array.prototype, name, descriptor);
			else delete (Array.prototype as any)[name];
		}
	}

	assert.deepEqual(getManyResult, [
		{ id: 1, handle: 'one', score: 3 },
		{ id: 2, handle: 'two', score: 7 }
	]);
	assert.deepEqual((queryResult as any).list, [
		{ id: 1, handle: 'one', score: 3 },
		{ id: 2, handle: 'two', score: 7 }
	]);
	assert.equal((queryResult as any).count, 2);
	assert.deepEqual(sortSpec, { score: -1, id: 1 });
	assert.deepEqual(queryFindOptions, { projection: { id: 1, handle: 1, _id: 1 } });
	assert.deepEqual(fallbackFindOptions, { projection: { id: 1, score: 1, _id: 1 } });
	assert.deepEqual(fallbackAggregateResult, { top: 7 });
	assert.deepEqual(pipelineAggregateResult, { total: 10 });
	assert.deepEqual((aggregatePipeline as any[])[1].$group.total, { $sum: '$score' });
	assert.deepEqual((schemaPlan as any).changes, []);
	assert.deepEqual(createIndexSpec, { handle: 1 });
	assert.deepEqual(findFilter, {});
});

test('MongoDB schema indexes preserve descending directions', async () => {
	const createIndexCalls: Array<{ keys: unknown; options: unknown }> = [];
	const directionalMeta: ResolvedModelMeta<MongoRegressionData> = {
		...meta,
		indexes: [{ name: 'handle_score_direction', fields: ['handle', 'score'], directions: ['asc', 'desc'] }]
	};
	const adapter = await mongoAdapter({
		indexes: async () => [],
		createIndex: async (keys: unknown, options: unknown) => {
			createIndexCalls.push({ keys, options });
		}
	}, [{ name: meta.name }]);

	assert.deepEqual((await adapter.schema!.plan([directionalMeta])).changes, [
		{
			type: 'create-index',
			target: 'mongo_regression_record',
			name: 'handle_score_direction',
			fields: ['handle', 'score'],
			directions: ['asc', 'desc'],
			unique: undefined
		}
	]);
	await adapter.schema!.apply([directionalMeta], { mode: 'safe' });
	assert.deepEqual(createIndexCalls, [
		{ keys: { handle: 1, score: -1 }, options: { name: 'handle_score_direction' } }
	]);
});

test('MongoDB limited direct queries report more with lookahead rows without cursor support', async () => {
	const calls: string[] = [];
	const cursor = {
		limit(value: number) {
			calls.push(`limit:${value}`);
			return this;
		},
		toArray: async () => [
			{ _id: 'number:1', id: 1, handle: 'one' },
			{ _id: 'number:2', id: 2, handle: 'two' }
		]
	};
	const adapter = await mongoAdapter({
		insertOne: async () => undefined,
		replaceOne: async () => ({ matchedCount: 1 }),
		find: () => cursor,
		findOne: async () => null,
		aggregate: () => ({ toArray: async () => [] }),
		deleteOne: async () => undefined,
		indexes: async () => [],
		createIndex: async () => undefined
	});

	const result = await adapter.query(meta, {
		where: [],
		or: [],
		sort: [],
		include: [],
		limit: 1
	});
	assert.deepEqual(result.list, [{ id: 1, handle: 'one' }]);
	assert.equal(result.count, 1);
	assert.equal(result.more, true);
	assert.equal(result.cursor, undefined);
	assert.deepEqual(calls, ['limit:2']);
});

test('MongoDB offset queries map to cursor skip before limit lookahead', async () => {
	const calls: string[] = [];
	const cursor = {
		skip(value: number) {
			calls.push(`skip:${value}`);
			return this;
		},
		limit(value: number) {
			calls.push(`limit:${value}`);
			return this;
		},
		toArray: async () => [
			{ _id: 'number:3', id: 3, handle: 'three' },
			{ _id: 'number:4', id: 4, handle: 'four' }
		]
	};
	const adapter = await mongoAdapter({
		insertOne: async () => undefined,
		replaceOne: async () => ({ matchedCount: 1 }),
		find: () => cursor,
		findOne: async () => null,
		aggregate: () => ({ toArray: async () => [] }),
		deleteOne: async () => undefined,
		indexes: async () => [],
		createIndex: async () => undefined
	});

	const result = await adapter.query(meta, {
		where: [],
		or: [],
		sort: [],
		include: [],
		offset: 2,
		limit: 1
	});
	assert.equal(adapter.capabilities?.offset, true);
	assert.deepEqual(result.list, [{ id: 3, handle: 'three' }]);
	assert.equal(result.more, true);
	assert.deepEqual(calls, ['skip:2', 'limit:2']);
});

test('MongoDB direct queries reject typed field operand mismatches before collection access', async () => {
	let collectionCalls = 0;
	const adapter = await createMongoStoreAdapter({
		dbName: 'test',
		client: {
			db: () => ({
				collection: () => {
					collectionCalls++;
					return {
						find: () => ({ toArray: async () => [] }),
						aggregate: () => ({ toArray: async () => [] })
					};
				}
			})
		}
	});
	const typedMeta: ResolvedModelMeta = {
		...meta,
		fieldTypes: new Map([['score', 'number']])
	};

	await assert.rejects(
		() => adapter.query(typedMeta, { where: [{ field: 'score', op: '=', value: '1' }], or: [], sort: [], include: [] }),
		/score.*number field type/
	);
	await assert.rejects(
		() => adapter.aggregate!(typedMeta, { where: [{ field: 'score', op: '=', value: '1' }], or: [], aggregates: [{ op: 'count', as: 'count' }] }),
		/score.*number field type/
	);
	assert.equal(collectionCalls, 0);
});

test('MongoDB portable sorts require declared field types before collection access', async () => {
	let collectionCalls = 0;
	const adapter = await createMongoStoreAdapter({
		dbName: 'test',
		client: {
			db: () => ({
				collection: () => {
					collectionCalls++;
					return {
						find: () => ({ sort: () => ({ toArray: async () => [] }), toArray: async () => [] })
					};
				}
			})
		}
	});

	await assert.rejects(
		() =>
			adapter.query(meta, {
				where: [],
				or: [],
				sort: [{ field: 'handle', direction: 'asc' }],
				include: []
			}),
		/MongoDB adapter requires fieldType metadata for portable sort\("handle"\)/
	);
	assert.equal(collectionCalls, 0);
});

test('MongoDB portable sorts on declared field types reach the native cursor sort', async () => {
	let sortSpec: unknown;
	const adapter = await mongoAdapter({
		insertOne: async () => undefined,
		replaceOne: async () => ({ matchedCount: 1 }),
		find: () => ({
			sort(value: unknown) {
				sortSpec = value;
				return this;
			},
			limit() {
				return this;
			},
			toArray: async () => []
		}),
		findOne: async () => null,
		aggregate: () => ({ toArray: async () => [] }),
		deleteOne: async () => undefined,
		indexes: async () => [],
		createIndex: async () => undefined
	});
	const typedMeta: ResolvedModelMeta<MongoRegressionData> = {
		...meta,
		fieldTypes: new Map([['score', 'number']])
	};

	await adapter.query(typedMeta, {
		where: [],
		or: [],
		sort: [{ field: 'score', direction: 'desc' }],
		include: [],
		limit: 2
	});
	assert.deepEqual(sortSpec, { score: -1, id: 1 });
});

test('MongoDB arrayContains only targets array elements', async () => {
	const filters: unknown[] = [];
	const adapter = await mongoAdapter({
		insertOne: async () => undefined,
		replaceOne: async () => ({ matchedCount: 1 }),
		find: (filter: unknown) => {
			filters.push(filter);
			return { toArray: async () => [] };
		},
		findOne: async () => null,
		aggregate: () => ({ toArray: async () => [] }),
		deleteOne: async () => undefined,
		indexes: async () => [],
		createIndex: async () => undefined
	});

	await adapter.query(meta, {
		where: [{ field: 'tags', op: 'arrayContains', value: 'cat' }],
		or: [],
		sort: [],
		include: []
	});

	assert.deepEqual(filters, [{ tags: { $elemMatch: { $eq: 'cat' } } }]);
});

test('MongoDB min and max aggregate fallback ignores null fields with core semantics', async () => {
	let capturedFindFilter: unknown;
	let capturedFindOptions: unknown;
	let aggregateCalls = 0;
	const adapter = await mongoAdapter({
		insertOne: async () => undefined,
		replaceOne: async () => ({ matchedCount: 1 }),
		find: (filter: unknown, options: unknown) => {
			capturedFindFilter = filter;
			capturedFindOptions = options;
			return {
				toArray: async () => [
					{ _id: 'number:1', id: 1, score: null },
					{ _id: 'number:2', id: 2 },
					{ _id: 'number:3', id: 3, score: 5 },
					{ _id: 'number:4', id: 4, score: 8 }
				]
			};
		},
		findOne: async () => null,
		aggregate: () => {
			aggregateCalls++;
			return { toArray: async () => [{ count: 4, lowest: null, highest: 8 }] };
		},
		deleteOne: async () => undefined,
		indexes: async () => [],
		createIndex: async () => undefined
	}, [{ name: meta.name }], { allowAggregateScanFallback: true });

	assert.deepEqual(
		await adapter.aggregate!(meta, {
			where: [],
			or: [],
			aggregates: [
				{ op: 'count', as: 'count' },
				{ op: 'min', field: 'score', as: 'lowest' },
				{ op: 'max', field: 'score', as: 'highest' }
			]
		}),
		{ count: 4, lowest: 5, highest: 8 }
	);
	assert.deepEqual(capturedFindFilter, {});
	assert.deepEqual(capturedFindOptions, { projection: { id: 1, score: 1, _id: 1 } });
	assert.equal(aggregateCalls, 0);
});

test('MongoDB aggregate scan fallback is disabled unless explicitly opted in', async () => {
	let findCalls = 0;
	const adapter = await mongoAdapter({
		insertOne: async () => undefined,
		replaceOne: async () => ({ matchedCount: 1 }),
		find: () => {
			findCalls++;
			return { toArray: async () => [] };
		},
		findOne: async () => null,
		aggregate: () => ({ toArray: async () => [{ highest: 8 }] }),
		deleteOne: async () => undefined,
		indexes: async () => [],
		createIndex: async () => undefined
	});

	await assert.rejects(
		() =>
			adapter.aggregate!(meta, {
				where: [],
				or: [],
				aggregates: [{ op: 'max', field: 'score', as: 'highest' }]
			}),
		/MongoDB aggregate scan fallback requires allowAggregateScanFallback: true/
	);
	assert.equal(findCalls, 0);
});

test('MongoDB numeric aggregate pipelines reject corrupted numeric row values', async () => {
	let pipeline: unknown;
	const adapter = await mongoAdapter({
		insertOne: async () => undefined,
		replaceOne: async () => ({ matchedCount: 1 }),
		find: () => ({ toArray: async () => [] }),
		findOne: async () => null,
		aggregate: (value: unknown) => {
			pipeline = value;
			return {
				toArray: async () => [{ _id: null, total: 3, __activeTsInvalid_total: 1 }]
			};
		},
		deleteOne: async () => undefined,
		indexes: async () => [],
		createIndex: async () => undefined
	});
	const typedMeta: ResolvedModelMeta<MongoRegressionData> = {
		...meta,
		fieldTypes: new Map([['score', 'number']])
	};

	await assert.rejects(
		() =>
			adapter.aggregate!(typedMeta, {
				where: [],
				or: [],
				aggregates: [{ op: 'sum', field: 'score', as: 'total' }]
			}),
		/Aggregate "total" expected numeric values in field "score"/
	);
	assert.deepEqual(
		(pipeline as any[])[1].$group.__activeTsInvalid_total,
		{
			$sum: {
				$cond: [
					{
						$and: [
							{ $ne: ['$score', null] },
							{ $not: [{ $isNumber: '$score' }] }
						]
					},
					1,
					0
				]
			}
		}
	);
});

test('MongoDB adapter rejects _id as a model id field', async () => {
	let insertCalls = 0;
	const adapter = await mongoAdapter({
		insertOne: async () => {
			insertCalls++;
		},
		replaceOne: async () => ({ matchedCount: 1 }),
		find: () => ({ toArray: async () => [] }),
		findOne: async () => null,
		aggregate: () => ({ toArray: async () => [] }),
		deleteOne: async () => undefined,
		indexes: async () => [],
		createIndex: async () => undefined
	});
	const reservedIdMeta: ResolvedModelMeta = { ...meta, idField: '_id' };

	await assert.rejects(
		() => adapter.create(reservedIdMeta, 1, { _id: 1, handle: 'reserved' }),
		/MongoDB model id field "_id" is reserved/
	);
	assert.equal(insertCalls, 0);
});

test('MongoDB adapter rejects top-level _id model fields before storage key collisions', async () => {
	let insertCalls = 0;
	let findCalls = 0;
	let createIndexCalls = 0;
	const adapter = await mongoAdapter({
		insertOne: async () => {
			insertCalls++;
		},
		replaceOne: async () => ({ matchedCount: 1 }),
		find: () => {
			findCalls++;
			return { toArray: async () => [] };
		},
		findOne: async () => null,
		aggregate: () => ({ toArray: async () => [] }),
		deleteOne: async () => undefined,
		indexes: async () => [],
		createIndex: async () => {
			createIndexCalls++;
		}
	});

	await assert.rejects(
		() => adapter.create(meta, 1, { id: 1, handle: 'one', _id: 'caller-owned' } as any),
		/stored data cannot contain MongoDB storage field "_id"/
	);
	assert.equal(insertCalls, 0);

	await assert.rejects(
		() =>
			adapter.query(meta, {
				where: [{ field: '_id', op: '=', value: 'caller-owned' }],
				or: [],
				sort: [],
				include: []
			}),
		/MongoDB field "_id" is reserved/
	);
	assert.equal(findCalls, 0);

	await assert.rejects(
		() => adapter.schema!.apply([{ ...meta, indexes: [{ name: 'bad_storage_id', fields: ['_id'] }] }] as any, { mode: 'safe' }),
		/MongoDB field "_id" is reserved/
	);
	assert.equal(createIndexCalls, 0);
});

test('MongoDB adapter validates cursor and schema array results', async () => {
	let findRows: unknown = {};
	let aggregateRows: unknown = {};
	let collectionRows: unknown = [];
	let indexRows: unknown = [];
	const collection = {
		insertOne: async () => undefined,
		replaceOne: async () => ({ matchedCount: 1 }),
		find: () => ({ toArray: async () => findRows }),
		findOne: async () => null,
		aggregate: () => ({ toArray: async () => aggregateRows }),
		deleteOne: async () => undefined,
		indexes: async () => indexRows,
		createIndex: async () => undefined
	};
	const adapter = await createMongoStoreAdapter({
		dbName: 'test',
		client: {
			db: () => ({
				collection: () => collection,
				createCollection: async () => undefined,
				listCollections: () => ({
					toArray: async () => collectionRows,
					map: () => ({
						toArray: async () => collectionRows
					})
				})
			})
		}
	});

	await assert.rejects(() => adapter.getMany(meta, [1]), /MongoDB find cursor\.toArray result must be an array/);
	findRows = new Array(1);
	await assert.rejects(() => adapter.getMany(meta, [1]), /MongoDB find cursor\.toArray result\[0\] is missing/);
	findRows = null;
	await assert.rejects(
		() =>
			adapter.query(meta, {
				where: [],
				or: [],
				sort: [],
				include: []
			}),
		/MongoDB find cursor\.toArray result must be an array/
	);
	await assert.rejects(
		() =>
			adapter.aggregate!(meta, {
				where: [],
				or: [],
				aggregates: [{ op: 'count', as: 'count' }]
		}),
		/MongoDB aggregate cursor\.toArray result must be an array/
	);
	aggregateRows = [null];
	await assert.rejects(
		() =>
			adapter.aggregate!(meta, {
				where: [],
				or: [],
				aggregates: [{ op: 'count', as: 'count' }]
			}),
		/MongoDB aggregate result must be a plain object/
	);
	collectionRows = {};
	await assert.rejects(() => adapter.schema!.plan([meta]), /MongoDB listCollections cursor\.toArray result must be an array/);
	collectionRows = [{ name: meta.name }];
	indexRows = {};
	await assert.rejects(() => adapter.schema!.plan([meta]), /MongoDB collection\.indexes result must be an array/);
});

test('MongoDB aggregate returns active-ts defaults when backend group is empty', async () => {
	const adapter = await mongoAdapter({
		find: () => ({ toArray: async () => [] }),
		aggregate: () => ({ toArray: async () => [] })
	});

	assert.deepEqual(
		await adapter.aggregate!(meta, {
			where: [],
			or: [],
			aggregates: [
				{ op: 'count', as: 'count' },
				{ op: 'sum', field: 'score', as: 'sumScore' },
				{ op: 'avg', field: 'score', as: 'avgScore' }
			]
		}),
		{ count: 0, sumScore: 0, avgScore: null }
	);
});

test('MongoDB schema index discovery rejects non-string names without coercion', async () => {
	let coerced = 0;
	const hostileName = {
		toString() {
			coerced++;
			throw new Error('index name coercion should not run');
		}
	};
	const adapter = await mongoAdapter({
		insertOne: async () => undefined,
		replaceOne: async () => ({ matchedCount: 1 }),
		find: () => ({ toArray: async () => [] }),
		findOne: async () => null,
		aggregate: () => ({ toArray: async () => [] }),
		deleteOne: async () => undefined,
		indexes: async () => [{ name: hostileName }],
		createIndex: async () => undefined
	});

	await assert.rejects(() => adapter.schema!.plan([meta]), /MongoDB index\.name must be a string/);
	assert.equal(coerced, 0);
});

test('MongoDB schema planning rejects same-name index drift', async () => {
	let indexRows: unknown[] = [{ name: 'handle_idx', key: { handle: 1 }, unique: true }];
	const adapter = await mongoAdapter({
		insertOne: async () => undefined,
		replaceOne: async () => ({ matchedCount: 1 }),
		find: () => ({ toArray: async () => [] }),
		findOne: async () => null,
		aggregate: () => ({ toArray: async () => [] }),
		deleteOne: async () => undefined,
		indexes: async () => indexRows,
		createIndex: async () => undefined
	});
	const declared = { ...meta, indexes: [{ name: 'handle_idx', fields: ['handle'], unique: true }] };

	assert.deepEqual((await adapter.schema!.plan([declared])).changes, []);

	indexRows = [{ name: 'handle_idx', key: { other: 1 }, unique: true }];
	await assert.rejects(
		() => adapter.schema!.plan([declared]),
		/MongoDB index "handle_idx" on "mongo_regression_record" does not match declared fields or uniqueness/
	);

	indexRows = [{ name: 'handle_idx', key: { handle: 1 }, unique: false }];
	await assert.rejects(
		() => adapter.schema!.plan([declared]),
		/MongoDB index "handle_idx" on "mongo_regression_record" does not match declared fields or uniqueness/
	);

	indexRows = [{ name: 'handle_idx', key: { handle: 1 }, unique: true, partialFilterExpression: { handle: { $exists: true } } }];
	await assert.rejects(
		() => adapter.schema!.plan([declared]),
		/MongoDB index "handle_idx" on "mongo_regression_record" does not match declared fields or uniqueness/
	);

	indexRows = [{ name: 'handle_idx', key: { handle: 1 }, unique: true, sparse: true }];
	await assert.rejects(
		() => adapter.schema!.plan([declared]),
		/MongoDB index "handle_idx" on "mongo_regression_record" does not match declared fields or uniqueness/
	);

	indexRows = [{ name: 'handle_idx', unique: true }];
	await assert.rejects(
		() => adapter.schema!.plan([declared]),
		/MongoDB index "handle_idx" on "mongo_regression_record" is missing key metadata/
	);
});

test('MongoDB schema planning ignores unrelated backend index definitions', async () => {
	const adapter = await mongoAdapter({
		insertOne: async () => undefined,
		replaceOne: async () => ({ matchedCount: 1 }),
		find: () => ({ toArray: async () => [] }),
		findOne: async () => null,
		aggregate: () => ({ toArray: async () => [] }),
		deleteOne: async () => undefined,
		indexes: async () => [
			{ name: '_id_', key: { _id: 1 } },
			{ name: 'body_text', key: { body: 'text' } },
			{ name: 'handle_idx', key: { handle: 1 } }
		],
		createIndex: async () => undefined
	});

	assert.deepEqual((await adapter.schema!.plan([meta])).changes, []);
});

test('MongoDB schema apply omits non-unique createIndex options', async () => {
	const createIndexCalls: Array<{ keys: unknown; options: unknown }> = [];
	const adapter = await mongoAdapter({
		insertOne: async () => undefined,
		replaceOne: async () => ({ matchedCount: 1 }),
		find: () => ({ toArray: async () => [] }),
		findOne: async () => null,
		aggregate: () => ({ toArray: async () => [] }),
		deleteOne: async () => undefined,
		indexes: async () => [],
		createIndex: async (keys: unknown, options: unknown) => {
			createIndexCalls.push({ keys, options });
		}
	});
	const declared = {
		...meta,
		indexes: [
			{ name: 'handle_idx', fields: ['handle'] },
			{ name: 'score_idx', fields: ['score'], unique: false },
			{ name: 'unique_handle_score', fields: ['handle', 'score'], unique: true }
		]
	};

	await adapter.schema!.apply([declared], { mode: 'safe' });

	assert.deepEqual(createIndexCalls, [
		{ keys: { handle: 1 }, options: { name: 'handle_idx' } },
		{ keys: { score: 1 }, options: { name: 'score_idx' } },
		{ keys: { handle: 1, score: 1 }, options: { name: 'unique_handle_score', unique: true } }
	]);
});

test('MongoDB schema planning rejects same-name collection views', async () => {
	let indexesCalls = 0;
	const adapter = await mongoAdapter(
		{
			insertOne: async () => undefined,
			replaceOne: async () => ({ matchedCount: 1 }),
			find: () => ({ toArray: async () => [] }),
			findOne: async () => null,
			aggregate: () => ({ toArray: async () => [] }),
			deleteOne: async () => undefined,
			indexes: async () => {
				indexesCalls++;
				return [{ name: 'handle_idx', key: { handle: 1 } }];
			},
			createIndex: async () => undefined
		},
		[{ name: meta.name, type: 'view' }]
	);

	await assert.rejects(
		() => adapter.schema!.plan([meta]),
		/MongoDB collection "mongo_regression_record" exists as view; expected collection/
	);
	await assert.rejects(
		() => adapter.schema!.apply([meta], { mode: 'safe' }),
		/MongoDB collection "mongo_regression_record" exists as view; expected collection/
	);
	assert.equal(indexesCalls, 0);
});

test('MongoDB schema apply only ignores namespace-exists collection errors', async () => {
	let createError: unknown = Object.assign(new Error('already exists'), { code: 48 });
	let createIndexCalls = 0;
	const adapter = await createMongoStoreAdapter({
		dbName: 'test',
		client: {
			db: () => ({
				collection: () => ({
					indexes: async () => [],
					createIndex: async () => {
						createIndexCalls++;
					}
				}),
				createCollection: async () => {
					if (createError) throw createError;
				},
				listCollections: () => ({
					toArray: async () => [],
					map: () => ({
						toArray: async () => []
					})
				})
			})
		}
	});

	await adapter.schema!.apply([meta], { mode: 'safe' });
	assert.equal(createIndexCalls, 1);

	createError = new Error('permission denied');
	await assert.rejects(() => adapter.schema!.apply([meta], { mode: 'safe' }), /permission denied/);

	createError = Object.assign(new Error('named namespace exists'), { codeName: 'NamespaceExists' });
	await adapter.schema!.apply([meta], { mode: 'safe' });
	assert.equal(createIndexCalls, 2);

	let codeNameGetterCalls = 0;
	createError = Object.defineProperty(new Error('accessor namespace failure'), 'codeName', {
		enumerable: true,
		get() {
			codeNameGetterCalls++;
			return 'NamespaceExists';
		}
	});
	await assert.rejects(() => adapter.schema!.apply([meta], { mode: 'safe' }), /accessor namespace failure/);
	assert.equal(codeNameGetterCalls, 0);
});

test('MongoDB adapter rejects inherited client, db, collection, and cursor methods', async () => {
	const hiddenClient = Object.defineProperty({}, 'db', {
		enumerable: false,
		value: () => ({ collection: () => ({}) })
	});
	await assert.rejects(
		() => createMongoStoreAdapter({ client: hiddenClient, dbName: 'test' } as any),
		/MongoDB adapter client\.db must be enumerable/
	);

	Object.defineProperties(Object.prototype, {
		db: { value: () => ({}), configurable: true },
		collection: { value: () => ({}), configurable: true },
		findOne: { value: async () => null, configurable: true },
		toArray: { value: async () => [], configurable: true }
	});
	try {
		await assert.rejects(
			() => createMongoStoreAdapter({ client: {}, dbName: 'test' } as any),
			/MongoDB adapter client\.db must be a function/
		);
		await assert.rejects(
			() => createMongoStoreAdapter({ client: { db: () => ({}) }, dbName: 'test' } as any),
			/MongoDB adapter db\.collection must be a function/
		);
		const adapter = await createMongoStoreAdapter({
			dbName: 'test',
			client: {
				db: () => ({
					collection: () => ({})
				})
			}
		});
		await assert.rejects(() => adapter.get(meta, 1), /MongoDB collection\.findOne must be a function/);
		const cursorAdapter = await mongoAdapter({
			find: () => ({}),
			findOne: async () => null,
			insertOne: async () => undefined,
			replaceOne: async () => ({ matchedCount: 1 }),
			aggregate: () => ({ toArray: async () => [] }),
			deleteOne: async () => undefined,
			indexes: async () => [],
			createIndex: async () => undefined
		});
		await assert.rejects(() => cursorAdapter.getMany(meta, [1]), /MongoDB find cursor\.toArray must be a function/);
	} finally {
		delete (Object.prototype as Record<string, unknown>).db;
		delete (Object.prototype as Record<string, unknown>).collection;
		delete (Object.prototype as Record<string, unknown>).findOne;
		delete (Object.prototype as Record<string, unknown>).toArray;
	}
});

test('MongoDB adapter omits schema hooks for CRUD-only injected db objects', async () => {
	let findOneCalls = 0;
	const adapter = await createMongoStoreAdapter({
		dbName: 'test',
		client: {
			db: () => ({
				collection: () => ({
					findOne: async () => {
						findOneCalls++;
						return null;
					}
				})
			})
		}
	});

	assert.equal(adapter.schema, undefined);
	assert.equal(await adapter.get(meta, 1), null);
	assert.equal(findOneCalls, 1);
});

test('MongoDB adapter snapshots client and db methods at creation', async () => {
	const calls: string[] = [];
	const collection = {
		findOne: async () => {
			calls.push('findOne');
			return null;
		}
	};
	const db = {
		collection: (name: string) => {
			calls.push(`collection:${name}`);
			return collection;
		}
	};
	const client = {
		db: (name: string) => {
			calls.push(`db:${name}`);
			return db;
		}
	};
	const adapter = await createMongoStoreAdapter({ client, dbName: 'test' });
	client.db = () => {
		throw new Error('mutated mongodb client db should not run');
	};
	db.collection = () => {
		throw new Error('mutated mongodb db collection should not run');
	};

	assert.equal(await adapter.get(meta, 1), null);
	assert.deepEqual(calls, ['db:test', 'collection:mongo_regression_record', 'findOne']);
});

test('MongoDB query filters shadow inherited field names', async () => {
	let capturedFilter: Record<string, unknown> | undefined;
	const adapter = await mongoAdapter({
		insertOne: async () => undefined,
		replaceOne: async () => ({ matchedCount: 1 }),
		find: (filter: Record<string, unknown>) => {
			capturedFilter = filter;
			return { toArray: async () => [] };
		},
		findOne: async () => null,
		aggregate: () => ({ toArray: async () => [] }),
		deleteOne: async () => undefined,
		indexes: async () => [],
		createIndex: async () => undefined
	});

	Object.defineProperty(Object.prototype, 'handle', {
		value: 'polluted',
		writable: false,
		configurable: true
	});
	try {
		await adapter.query(meta, {
			where: [{ field: 'handle', op: '=', value: 'own' }],
			or: [],
			sort: [],
			include: []
		});
		assert.deepEqual(capturedFilter, mongoScalarField('handle', { $eq: 'own' }));
		const equalityBranch = (capturedFilter?.$and as Array<Record<string, unknown>>)?.[2];
		assert.equal(Object.prototype.hasOwnProperty.call(equalityBranch, 'handle'), true);
	} finally {
		delete (Object.prototype as Record<string, unknown>).handle;
	}
});

test('MongoDB query filters preserve null and same-field portable semantics', async () => {
	let capturedFilter: Record<string, any> | undefined;
	const adapter = await mongoAdapter({
		insertOne: async () => undefined,
		replaceOne: async () => ({ matchedCount: 1 }),
		find: (filter: Record<string, any>) => {
			capturedFilter = filter;
			return { toArray: async () => [] };
		},
		findOne: async () => null,
		aggregate: () => ({ toArray: async () => [] }),
		deleteOne: async () => undefined,
		indexes: async () => [],
		createIndex: async () => undefined
	});

	await adapter.query(meta, {
		where: [{ field: 'deletedAt', op: 'isNotNull', value: undefined }],
		or: [],
		sort: [],
		include: []
	});
	assert.deepEqual(capturedFilter, {
		$or: [mongoField('deletedAt', { $type: 'array' }), mongoScalarField('deletedAt', { $ne: null })]
	});

	await adapter.query(meta, {
		where: [{ field: 'deletedAt', op: 'isNull', value: undefined }],
		or: [],
		sort: [],
		include: []
	});
	assert.deepEqual(capturedFilter, {
		$or: [mongoField('deletedAt', { $exists: false }), mongoScalarField('deletedAt', { $eq: null })]
	});

	await adapter.query(meta, {
		where: [{ field: 'handle', op: 'in', value: ['exact', null] }],
		or: [],
		sort: [],
		include: []
	});
	assert.deepEqual(capturedFilter, mongoScalarField('handle', { $in: ['exact', null] }));

	await adapter.query(meta, {
		where: [
			{ field: 'handle', op: '=', value: 'exact' },
			{ field: 'handle', op: 'startsWith', value: 'ex' }
		],
		or: [],
		sort: [],
		include: []
	});
	assert.deepEqual(capturedFilter, {
		$and: [
			mongoScalarField('handle', { $eq: 'exact' }),
			mongoScalarField('handle', { $type: 'string', $regex: /^ex/ })
		]
	});
});
