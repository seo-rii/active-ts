import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
	ActiveTsCommittedTransactionError,
	ActiveTsConfigurationError,
	ActiveTsConflictError,
	ActiveTsValidationError
} from '../src/index.js';
import {
	applyDatastoreIdRepairManifest,
	createDatastoreIdRepairManifest,
	type DatastoreIdInventoryIssue,
	type DatastoreIdInventoryReport,
	type DatastoreIdRepairManifest
} from '../src/adapters/store/datastore.js';

const INVENTORY_ID = '123e4567-e89b-42d3-a456-426614174000';
const REPAIR_TARGET = 'gcp:active-ts-test/(default)';

function issueDigest(issues: readonly DatastoreIdInventoryIssue[]) {
	const hash = createHash('sha256');
	for (let index = 0; index < issues.length; index++) {
		hash.update(JSON.stringify(issues[index]));
		hash.update('\n');
	}
	return `sha256:${hash.digest('hex')}`;
}

const inventoryCounts = (
	overrides: Partial<DatastoreIdInventoryReport['counts']> = {}
): DatastoreIdInventoryReport['counts'] => ({
	match: 2,
	'type-mismatch': 2,
	'value-mismatch': 0,
	'missing-payload-id': 0,
	'invalid-payload-id': 0,
	'unsupported-key': 0,
	...overrides
});

function inventoryReport(
	overrides: Partial<DatastoreIdInventoryReport> = {},
	issues: readonly DatastoreIdInventoryIssue[] = [numericIssue(), namedIssue()]
): DatastoreIdInventoryReport {
	const counts = overrides.counts ?? inventoryCounts();
	return {
		inventoryId: INVENTORY_ID,
		issueDigest: issueDigest(issues),
		kind: 'repair_record',
		idField: 'id',
		namespace: 'tenant',
		scanned: Object.values(counts).reduce((sum, count) => sum + count, 0),
		pages: 1,
		...overrides,
		counts
	};
}

const numericIssue = (
	id = 17,
	payload: string = String(id),
	issueIndex = 0
): DatastoreIdInventoryIssue => ({
	inventoryId: INVENTORY_ID,
	issueIndex,
	classification: 'type-mismatch',
	key: {
		path: [
			{ kind: 'repair_parent', storage: 'id', value: '9' },
			{ kind: 'repair_record', storage: 'id', value: String(id) }
		],
		namespace: 'tenant'
	},
	payload: { type: 'string', value: payload },
	reason: 'Physical key and payload have matching text but different ID types.'
});

const namedIssue = (
	name = '18',
	payload: number = Number(name),
	issueIndex = 1
): DatastoreIdInventoryIssue => ({
	inventoryId: INVENTORY_ID,
	issueIndex,
	classification: 'type-mismatch',
	key: {
		path: [{ kind: 'repair_record', storage: 'name', value: name }],
		namespace: 'tenant'
	},
	payload: { type: 'number', value: payload },
	reason: 'Physical key and payload have matching text but different ID types.'
});

function keyWinsManifest(issues = [numericIssue(), namedIssue()]) {
	return createDatastoreIdRepairManifest({
		report: inventoryReport({
			counts: inventoryCounts({ match: 0, 'type-mismatch': issues.length })
		}, issues),
		issues,
		target: REPAIR_TARGET,
		policy: 'key-wins',
		excludeFromIndexes: ['body', 'details[].note']
	});
}

test('Datastore ID repair manifests preserve reviewed inventory and derive policy operations', () => {
	const keyWins = createDatastoreIdRepairManifest({
		report: inventoryReport(),
		issues: [numericIssue(), namedIssue()],
		target: REPAIR_TARGET,
		policy: 'key-wins',
		excludeFromIndexes: ['body']
	});
	assert.deepEqual(keyWins, {
		format: 'active-ts/datastore-id-repair',
		version: 1,
		kind: 'repair_record',
		idField: 'id',
		target: REPAIR_TARGET,
		namespace: 'tenant',
		policy: 'key-wins',
		allowKeyMoves: false,
		excludeFromIndexes: ['body'],
		inventory: {
			inventoryId: INVENTORY_ID,
			issueDigest: issueDigest([numericIssue(), namedIssue()]),
			scanned: 4,
			pages: 1,
			matched: 2,
			typeMismatches: 2
		},
		operations: [
			{
				issueIndex: 0,
				source: numericIssue().key,
				target: numericIssue().key,
				expectedPayload: { type: 'string', value: '17' },
				replacementId: 17
			},
			{
				issueIndex: 1,
				source: namedIssue().key,
				target: namedIssue().key,
				expectedPayload: { type: 'number', value: 18 },
				replacementId: '18'
			}
		],
		digest: keyWins.digest
	});
	assert.match(keyWins.digest, /^sha256:[0-9a-f]{64}$/);
	assert.equal(Object.isFrozen(keyWins), true);
	assert.equal(Object.isFrozen(keyWins.inventory), true);
	assert.equal(Object.isFrozen(keyWins.excludeFromIndexes), true);
	assert.equal(Object.isFrozen(keyWins.operations), true);
	assert.equal(Object.isFrozen(keyWins.operations[0]), true);
	assert.equal(Object.isFrozen(keyWins.operations[0].source.path), true);

	const payloadWins = createDatastoreIdRepairManifest({
		report: inventoryReport(),
		issues: [numericIssue(), namedIssue()],
		target: REPAIR_TARGET,
		policy: 'payload-wins',
		allowKeyMoves: true,
		descendantPolicy: 'verified-none',
		excludeFromIndexes: []
	});
	assert.equal(payloadWins.allowKeyMoves, true);
	assert.equal(payloadWins.descendantPolicy, 'verified-none');
	assert.deepEqual(payloadWins.operations.map((operation) => operation.target.path.at(-1)), [
		{ kind: 'repair_record', storage: 'name', value: '17' },
		{ kind: 'repair_record', storage: 'id', value: '18' }
	]);
	assert.deepEqual(payloadWins.operations.map((operation) => operation.replacementId), ['17', 18]);
	assert.deepEqual(JSON.parse(JSON.stringify(payloadWins)), payloadWins);
});

test('Datastore ID repair planning fails closed on incomplete, ambiguous, and colliding manifests', () => {
	const duplicateSourceIssues = [numericIssue(), numericIssue(17, '17', 1)];
	const negativeTargetIssues = [namedIssue('-1', -1, 0)];
	const reviewedInventoryIdIssues = [numericIssue()];
	const emptyNamespaceIssue = {
		...numericIssue(),
		key: { ...numericIssue().key, namespace: '' }
	};
	assert.throws(
		() => createDatastoreIdRepairManifest({
			report: inventoryReport({ namespace: '' }),
			issues: [numericIssue(), namedIssue()],
			target: REPAIR_TARGET,
			policy: 'key-wins',
			excludeFromIndexes: []
		}),
		/inventory report\.namespace must be a non-empty string/
	);
	assert.throws(
		() => createDatastoreIdRepairManifest({
			report: inventoryReport(
				{ namespace: undefined, counts: inventoryCounts({ match: 0, 'type-mismatch': 1 }) },
				[emptyNamespaceIssue]
			),
			issues: [emptyNamespaceIssue],
			target: REPAIR_TARGET,
			policy: 'key-wins',
			excludeFromIndexes: []
		}),
		/issues\[0\]\.key\.namespace must be a non-empty string/
	);
	assert.throws(
		() => createDatastoreIdRepairManifest({
			report: inventoryReport(),
			issues: [numericIssue()],
			target: REPAIR_TARGET,
			policy: 'key-wins',
			excludeFromIndexes: []
		}),
		/exactly 2 type-mismatch issues/
	);
	assert.throws(
		() => createDatastoreIdRepairManifest({
			report: inventoryReport({
				counts: inventoryCounts({ match: 1, 'type-mismatch': 2, 'value-mismatch': 1 })
			}),
			issues: [numericIssue(), namedIssue()],
			target: REPAIR_TARGET,
			policy: 'key-wins',
			excludeFromIndexes: []
		}),
		/cannot automate value-mismatch/
	);
	assert.throws(
		() => createDatastoreIdRepairManifest({
			report: inventoryReport(),
			issues: [numericIssue(), namedIssue()],
			target: REPAIR_TARGET,
			policy: 'payload-wins',
			excludeFromIndexes: []
		}),
		/allowKeyMoves: true/
	);
	assert.throws(
		() => createDatastoreIdRepairManifest({
			report: inventoryReport(),
			issues: [numericIssue(), namedIssue()],
			target: REPAIR_TARGET,
			policy: 'payload-wins',
			allowKeyMoves: true,
			excludeFromIndexes: []
		}),
		/requires descendantPolicy/
	);
	assert.throws(
		() => createDatastoreIdRepairManifest({
			report: inventoryReport(),
			issues: [numericIssue(), namedIssue()],
			target: REPAIR_TARGET,
			policy: 'key-wins',
			excludeFromIndexes: ['id']
		}),
		/cannot overlap ID field/
	);
	assert.throws(
		() => createDatastoreIdRepairManifest({
			report: inventoryReport({ counts: inventoryCounts({ match: 0 }) }, duplicateSourceIssues),
			issues: duplicateSourceIssues,
			target: REPAIR_TARGET,
			policy: 'key-wins',
			excludeFromIndexes: []
		}),
		/duplicates operations\[0\]\.source/
	);
	assert.throws(
		() => {
			const rootNumeric: DatastoreIdInventoryIssue = {
				...numericIssue(17),
				key: {
					path: [{ kind: 'repair_record', storage: 'id', value: '17' }],
					namespace: 'tenant'
				}
			};
			const swapIssues = [rootNumeric, namedIssue('17')];
			return createDatastoreIdRepairManifest({
				report: inventoryReport({ counts: inventoryCounts({ match: 0 }) }, swapIssues),
				issues: swapIssues,
				target: REPAIR_TARGET,
				policy: 'payload-wins',
				allowKeyMoves: true,
				descendantPolicy: 'verified-none',
				excludeFromIndexes: []
			});
		},
		/key-move chains and swaps require manual migration/
	);
	assert.throws(
		() => createDatastoreIdRepairManifest({
			report: inventoryReport(
				{ counts: inventoryCounts({ match: 0, 'type-mismatch': 1 }) },
				negativeTargetIssues
			),
			issues: negativeTargetIssues,
			target: REPAIR_TARGET,
			policy: 'payload-wins',
			allowKeyMoves: true,
			descendantPolicy: 'verified-none',
			excludeFromIndexes: []
		}),
		/target key ID must be a positive integer/
	);
	assert.throws(
		() => createDatastoreIdRepairManifest({
			report: inventoryReport(
				{ counts: inventoryCounts({ match: 0, 'type-mismatch': 1 }) },
				reviewedInventoryIdIssues
			),
			issues: [{ ...numericIssue(), inventoryId: '123e4567-e89b-42d3-a456-426614174001' }],
			target: REPAIR_TARGET,
			policy: 'key-wins',
			excludeFromIndexes: []
		}),
		/inventoryId must match/
	);
	assert.throws(
		() => createDatastoreIdRepairManifest({
			report: inventoryReport(
				{ counts: inventoryCounts({ match: 0, 'type-mismatch': 1 }) },
				reviewedInventoryIdIssues
			),
			issues: [{ ...numericIssue(), reason: 'changed after inventory review' }],
			target: REPAIR_TARGET,
			policy: 'key-wins',
			excludeFromIndexes: []
		}),
		/issues do not match the inventory report issueDigest/
	);
});

type TransactionLog = {
	run: unknown[];
	commit: unknown[];
	rollback: unknown[];
	get: unknown[];
	update: any[];
	insert: any[];
	delete: unknown[];
};

function repairClient(
	entityFor: (transactionIndex: number, key: any, getIndex: number) => unknown,
	logs: TransactionLog[],
	preflightEntityFor: (key: any, getIndex: number) => unknown,
	commitErrorFor: (transactionIndex: number) => unknown = () => undefined
) {
	let transactionIndex = 0;
	let preflightGetIndex = 0;
	return {
		key: (input: { path: Array<string | number>; namespace?: string }) => ({
			path: [...input.path],
			...(input.namespace === undefined ? {} : { namespace: input.namespace })
		}),
		get: async (key: unknown) => [preflightEntityFor(key, preflightGetIndex++)],
		transaction: (options: unknown) => {
			const index = transactionIndex++;
			const log: TransactionLog = {
				run: [options],
				commit: [],
				rollback: [],
				get: [],
				update: [],
				insert: [],
				delete: []
			};
			logs[index] = log;
			return {
				run: async (runOptions: unknown) => { log.run.push(runOptions); },
				get: async (key: unknown) => {
					const getIndex = log.get.length;
					log.get.push(key);
					return [entityFor(index, key, getIndex)];
				},
				update: (entity: unknown) => { log.update.push(entity); },
				insert: (entity: unknown) => { log.insert.push(entity); },
				delete: (key: unknown) => { log.delete.push(key); },
				commit: async (options: unknown) => {
					log.commit.push(options);
					const error = commitErrorFor(index);
					if (error !== undefined) throw error;
				},
				rollback: async (options: unknown) => { log.rollback.push(options); }
			};
		}
	};
}

test('Datastore ID repair apply rechecks payloads and preserves explicit index exclusions', async () => {
	const logs: TransactionLog[] = [];
	const manifest = keyWinsManifest();
	const sdkKey = Symbol('datastore-key');
	const firstEntity = Object.defineProperty(
		{ id: '17', body: 'first', nested: { value: 1 } },
		sdkKey,
		{ value: { kind: 'repair_record', id: 17 }, enumerable: true }
	);
	const client = repairClient(
		(transactionIndex) => transactionIndex === 0
			? firstEntity
			: { id: '18', body: 'already repaired' },
		logs,
		(key) => typeof key.path.at(-1) === 'number'
			? firstEntity
			: { id: '18', body: 'already repaired' }
	);
	const report = await applyDatastoreIdRepairManifest({
		client,
		manifest: JSON.parse(JSON.stringify(manifest)) as DatastoreIdRepairManifest,
		target: REPAIR_TARGET,
		confirm: manifest.digest,
		transaction: {
			gaxOptions: { timeout: 1000 },
			commitGaxOptions: { timeout: 2000 },
			rollbackGaxOptions: { timeout: 3000 }
		}
	});

	assert.deepEqual(report, {
		total: 2,
		processed: 2,
		repaired: 1,
		alreadyRepaired: 1,
		indeterminate: 0
	});
	assert.equal(Object.isFrozen(report), true);
	assert.deepEqual(logs.map((log) => log.run.map((entry: any) =>
		entry?.gaxOptions ? { gaxOptions: { ...entry.gaxOptions } } : entry)), [
		[{ readOnly: false }, { gaxOptions: { timeout: 1000 } }],
		[{ readOnly: false }, { gaxOptions: { timeout: 1000 } }]
	]);
	assert.deepEqual(logs.map((log) => log.commit.map((entry: any) => ({ ...entry }))), [
		[{ timeout: 2000 }],
		[{ timeout: 2000 }]
	]);
	assert.deepEqual(logs.map((log) => log.rollback), [[], []]);
	assert.equal(logs[0].update.length, 1);
	assert.deepEqual({
		...logs[0].update[0],
		data: { ...logs[0].update[0].data }
	}, {
		key: {
			path: ['repair_parent', 9, 'repair_record', 17],
			namespace: 'tenant'
		},
		data: { id: 17, body: 'first', nested: { value: 1 } },
		excludeFromIndexes: ['body', 'details[].note']
	});
	assert.equal(Object.getPrototypeOf(logs[0].update[0].data), null);
	assert.deepEqual(Object.getOwnPropertySymbols(logs[0].update[0].data), []);
	assert.equal(logs[1].update.length, 0);
});

test('Datastore payload-wins repair moves a key transactionally and rejects target collisions', async () => {
	const issues = [numericIssue(31)];
	const manifest = createDatastoreIdRepairManifest({
		report: inventoryReport({
			counts: inventoryCounts({ match: 0, 'type-mismatch': 1 })
		}, issues),
		issues,
		target: REPAIR_TARGET,
		policy: 'payload-wins',
		allowKeyMoves: true,
		descendantPolicy: 'verified-none',
		excludeFromIndexes: ['body']
	});
	const logs: TransactionLog[] = [];
	const client = repairClient((_transactionIndex, _key, getIndex) =>
		getIndex === 0 ? { id: '31', body: 'move me' } : undefined, logs, (key) =>
			typeof key.path.at(-1) === 'number' ? { id: '31', body: 'move me' } : undefined);
	assert.deepEqual(await applyDatastoreIdRepairManifest({
		client,
		manifest,
		target: REPAIR_TARGET,
		confirm: manifest.digest
	}), {
		total: 1,
		processed: 1,
		repaired: 1,
		alreadyRepaired: 0,
		indeterminate: 0
	});
	assert.deepEqual(logs[0].get, [
		{ path: ['repair_parent', 9, 'repair_record', 31], namespace: 'tenant' },
		{ path: ['repair_parent', 9, 'repair_record', '31'], namespace: 'tenant' }
	]);
	assert.deepEqual({
		...logs[0].insert[0],
		data: { ...logs[0].insert[0].data }
	}, {
		key: { path: ['repair_parent', 9, 'repair_record', '31'], namespace: 'tenant' },
		data: { id: '31', body: 'move me' },
		excludeFromIndexes: ['body']
	});
	assert.deepEqual(logs[0].delete, [
		{ path: ['repair_parent', 9, 'repair_record', 31], namespace: 'tenant' }
	]);

	const collisionLogs: TransactionLog[] = [];
	const collisionClient = repairClient((_transactionIndex, _key, getIndex) =>
		getIndex === 0 ? { id: '31', body: 'source' } : { id: '31', body: 'target' }, collisionLogs,
		(key) => typeof key.path.at(-1) === 'number'
			? { id: '31', body: 'source' }
			: { id: '31', body: 'target' });
	await assert.rejects(
		() => applyDatastoreIdRepairManifest({
			client: collisionClient,
			manifest,
			target: REPAIR_TARGET,
			confirm: manifest.digest
		}),
		(error: unknown) => {
			assert.ok(error instanceof ActiveTsConflictError);
			assert.match(error.message, /target already exists/);
			return true;
		}
	);
	assert.deepEqual(collisionLogs, []);

	const laterCollisionManifest = createDatastoreIdRepairManifest({
		report: inventoryReport(),
		issues: [numericIssue(), namedIssue()],
		target: REPAIR_TARGET,
		policy: 'payload-wins',
		allowKeyMoves: true,
		descendantPolicy: 'verified-none',
		excludeFromIndexes: []
	});
	const laterCollisionLogs: TransactionLog[] = [];
	const laterCollisionClient = repairClient(
		() => assert.fail('preflight collision must fail before starting a transaction'),
		laterCollisionLogs,
		(key) => {
			const leaf = key.path.at(-1);
			if (leaf === 17) return { id: '17' };
			if (leaf === '17') return undefined;
			if (leaf === '18') return { id: 18 };
			return { id: 18, handle: 'existing second target' };
		}
	);
	await assert.rejects(
		() => applyDatastoreIdRepairManifest({
			client: laterCollisionClient,
			manifest: laterCollisionManifest,
			target: REPAIR_TARGET,
			confirm: laterCollisionManifest.digest
		}),
		/preflight 1 target already exists/
	);
	assert.deepEqual(laterCollisionLogs, []);
});

test('Datastore ID repair reports an indeterminate commit before manifest replay', async () => {
	const issues = [numericIssue(41)];
	const manifest = createDatastoreIdRepairManifest({
		report: inventoryReport(
			{ counts: inventoryCounts({ match: 0, 'type-mismatch': 1 }) },
			issues
		),
		issues,
		target: REPAIR_TARGET,
		policy: 'payload-wins',
		allowKeyMoves: true,
		descendantPolicy: 'verified-none',
		excludeFromIndexes: []
	});
	const logs: TransactionLog[] = [];
	const commitError = new Error('commit response lost');
	const client = repairClient(
		(_transactionIndex, _key, getIndex) => getIndex === 0 ? { id: '41' } : undefined,
		logs,
		(key) => typeof key.path.at(-1) === 'number' ? { id: '41' } : undefined,
		() => commitError
	);
	await assert.rejects(
		() => applyDatastoreIdRepairManifest({
			client,
			manifest,
			target: REPAIR_TARGET,
			confirm: manifest.digest
		}),
		(error: unknown) => {
			assert.ok(error instanceof ActiveTsCommittedTransactionError);
			assert.equal(error.cause, commitError);
			assert.match(error.message, /indeterminate commit outcome/);
			assert.deepEqual(error.result, {
				total: 1,
				processed: 0,
				repaired: 0,
				alreadyRepaired: 0,
				indeterminate: 1
			});
			return true;
		}
	);
	assert.equal(logs[0].insert.length, 1);
	assert.equal(logs[0].delete.length, 1);
	assert.deepEqual(logs[0].rollback, []);
});

test('Datastore ID repair reports partial commits and rejects stale or unconfirmed apply attempts', async () => {
	const manifest = keyWinsManifest();
	await assert.rejects(
		() => applyDatastoreIdRepairManifest({
			client: { namespace: '' },
			manifest,
			target: REPAIR_TARGET,
			confirm: manifest.digest
		}),
		(error: unknown) =>
			error instanceof ActiveTsConfigurationError &&
			/repair client\.namespace must be a non-empty string/.test(error.message)
	);
	await assert.rejects(
		() => applyDatastoreIdRepairManifest({
			client: { namespace: 'other-tenant' },
			manifest,
			target: REPAIR_TARGET,
			confirm: manifest.digest
		}),
		(error: unknown) =>
			error instanceof ActiveTsConfigurationError &&
			/repair client namespace must match the manifest namespace/.test(error.message)
	);
	const emptyManifestNamespace = JSON.parse(JSON.stringify(manifest));
	emptyManifestNamespace.namespace = '';
	await assert.rejects(
		() => applyDatastoreIdRepairManifest({
			client: {},
			manifest: emptyManifestNamespace,
			target: REPAIR_TARGET,
			confirm: manifest.digest
		}),
		(error: unknown) =>
			error instanceof ActiveTsValidationError &&
			/manifest\.namespace must be a non-empty string/.test(error.message)
	);
	const emptySourceNamespace = JSON.parse(JSON.stringify(manifest));
	emptySourceNamespace.operations[0].source.namespace = '';
	await assert.rejects(
		() => applyDatastoreIdRepairManifest({
			client: {},
			manifest: emptySourceNamespace,
			target: REPAIR_TARGET,
			confirm: manifest.digest
		}),
		(error: unknown) =>
			error instanceof ActiveTsValidationError &&
			/operations\[0\]\.source\.namespace must be a non-empty string/.test(error.message)
	);
	await assert.rejects(
		() => applyDatastoreIdRepairManifest({
			client: {},
			manifest,
			target: 'gcp:wrong-project/(default)',
			confirm: manifest.digest
		}),
		(error: unknown) => error instanceof ActiveTsConfigurationError && /does not match manifest target/.test(error.message)
	);
	await assert.rejects(
		() => applyDatastoreIdRepairManifest({
			client: repairClient(() => ({ id: '17' }), [], () => ({ id: '17' })),
			manifest,
			target: REPAIR_TARGET,
			confirm: false as unknown as string
		}),
		(error: unknown) => error instanceof ActiveTsConfigurationError && /approved manifest digest/.test(error.message)
	);

	const logs: TransactionLog[] = [];
	const client = repairClient(
		(transactionIndex) => transactionIndex === 0 ? { id: '17' } : { id: 999 },
		logs,
		(key) => typeof key.path.at(-1) === 'number' ? { id: '17' } : { id: 18 }
	);
	await assert.rejects(
		() => applyDatastoreIdRepairManifest({
			client,
			manifest,
			target: REPAIR_TARGET,
			confirm: manifest.digest
		}),
		(error: unknown) => {
			assert.ok(error instanceof ActiveTsCommittedTransactionError);
			assert.ok(error.cause instanceof ActiveTsConflictError);
			assert.deepEqual(error.result, {
				total: 2,
				processed: 1,
				repaired: 1,
				alreadyRepaired: 0,
				indeterminate: 0
			});
			return true;
		}
	);
	assert.equal(logs[0].commit.length, 1);
	assert.deepEqual(logs[1].rollback, [undefined]);

	const malformed = JSON.parse(JSON.stringify(manifest));
	malformed.excludeFromIndexes = ['changed-after-review'];
	await assert.rejects(
		() => applyDatastoreIdRepairManifest({
			client: repairClient(() => ({ id: '17' }), [], () => ({ id: '17' })),
			manifest: malformed,
			target: REPAIR_TARGET,
			confirm: manifest.digest
		}),
		(error: unknown) => error instanceof ActiveTsValidationError && /digest does not match/.test(error.message)
	);
	const coherentlyChanged = createDatastoreIdRepairManifest({
		report: inventoryReport({ counts: inventoryCounts({ match: 0 }) }),
		issues: [numericIssue(), namedIssue()],
		target: REPAIR_TARGET,
		policy: 'key-wins',
		excludeFromIndexes: ['changed-after-review']
	});
	await assert.rejects(
		() => applyDatastoreIdRepairManifest({
			client: {},
			manifest: coherentlyChanged,
			target: REPAIR_TARGET,
			confirm: manifest.digest
		}),
		(error: unknown) => error instanceof ActiveTsConfigurationError && /confirmation does not match/.test(error.message)
	);
});
