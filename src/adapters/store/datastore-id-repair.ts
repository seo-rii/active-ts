import { createHash } from 'node:crypto';
import {
	ActiveTsCommittedTransactionError,
	ActiveTsConfigurationError,
	ActiveTsConflictError,
	ActiveTsValidationError,
	safeErrorMessage
} from '../../core/errors.js';
import {
	markTransactionRollbackSkipped,
	transactionRollbackSkipped
} from '../../core/error-classification.js';
import {
	assertSafeEntityId,
	assertSafeFieldPath,
	assertSafePhysicalIdentifierLength,
	assertSafeSchemaIdentifier,
	assertSafeTopLevelField,
	defineDataProperty
} from '../../core/safe-keys.js';
import { snapshotArrayInput } from '../../core/array-input.js';
import { JSON_STRINGIFY } from '../../core/json-intrinsics.js';
import {
	MAP_GET,
	MAP_SET,
	SET_ADD,
	SET_HAS
} from '../../core/collection-intrinsics.js';
import {
	assertNativeDatastoreEntityId,
	datastoreKeyIdentity,
	normalizeDatastoreKey
} from '../../core/datastore-key.js';
import type { DatastoreKey, EntityId } from '../../core/types.js';
import type {
	DatastoreIdInventoryIssue,
	DatastoreIdInventoryKey,
	DatastoreIdInventoryKeyPart,
	DatastoreIdInventoryPayload,
	DatastoreIdInventoryReport,
	DatastoreTransactionNativeOptions
} from './datastore.js';

export type DatastoreIdRepairPolicy = 'key-wins' | 'payload-wins';
export type DatastoreIdRepairDescendantPolicy = 'verified-none' | 'migrated-separately';
export type DatastoreIdRepairPayload = Extract<
	DatastoreIdInventoryPayload,
	{ readonly type: 'string' | 'number' }
>;
export type DatastoreIdRepairOperation = {
	readonly issueIndex: number;
	readonly source: DatastoreIdInventoryKey;
	readonly target: DatastoreIdInventoryKey;
	readonly expectedPayload: DatastoreIdRepairPayload;
	readonly replacementId: EntityId;
};
export type DatastoreIdRepairInventorySummary = {
	readonly inventoryId: string;
	readonly issueDigest: string;
	readonly scanned: number;
	readonly pages: number;
	readonly matched: number;
	readonly typeMismatches: number;
};
export type DatastoreIdRepairManifest = {
	readonly format: 'active-ts/datastore-id-repair';
	readonly version: 1;
	readonly kind: string;
	readonly idField: string;
	readonly target: string;
	readonly namespace?: string;
	readonly policy: DatastoreIdRepairPolicy;
	readonly allowKeyMoves: boolean;
	readonly descendantPolicy?: DatastoreIdRepairDescendantPolicy;
	readonly excludeFromIndexes: readonly string[];
	readonly inventory: DatastoreIdRepairInventorySummary;
	readonly operations: readonly DatastoreIdRepairOperation[];
	readonly digest: string;
};
export type DatastoreIdRepairPlanOptions = {
	report: DatastoreIdInventoryReport;
	issues: readonly DatastoreIdInventoryIssue[];
	target: string;
	policy: DatastoreIdRepairPolicy;
	excludeFromIndexes: readonly string[];
	allowKeyMoves?: true;
	descendantPolicy?: DatastoreIdRepairDescendantPolicy;
};
export type DatastoreIdRepairApplyOptions = {
	client: unknown;
	manifest: DatastoreIdRepairManifest;
	target: string;
	confirm: string;
	transaction?: DatastoreTransactionNativeOptions;
};
export type DatastoreIdRepairApplyReport = {
	readonly total: number;
	readonly processed: number;
	readonly repaired: number;
	readonly alreadyRepaired: number;
	readonly indeterminate: number;
};

const MANIFEST_FORMAT = 'active-ts/datastore-id-repair' as const;
const PLAN_OPTION_KEYS = [
	'report',
	'issues',
	'target',
	'policy',
	'excludeFromIndexes',
	'allowKeyMoves',
	'descendantPolicy'
] as const;
const APPLY_OPTION_KEYS = ['client', 'manifest', 'target', 'confirm', 'transaction'] as const;
const REPORT_KEYS = [
	'inventoryId',
	'issueDigest',
	'kind',
	'idField',
	'namespace',
	'scanned',
	'pages',
	'counts'
] as const;
const INVENTORY_COUNT_KEYS = [
	'match',
	'type-mismatch',
	'value-mismatch',
	'missing-payload-id',
	'invalid-payload-id',
	'unsupported-key'
] as const;
const ISSUE_KEYS = ['inventoryId', 'issueIndex', 'classification', 'key', 'payload', 'reason'] as const;
const INVENTORY_KEY_KEYS = ['path', 'namespace'] as const;
const INVENTORY_KEY_PART_KEYS = ['kind', 'storage', 'value'] as const;
const PAYLOAD_KEYS = ['type', 'value'] as const;
const MANIFEST_KEYS = [
	'format',
	'version',
	'kind',
	'idField',
	'target',
	'namespace',
	'policy',
	'allowKeyMoves',
	'descendantPolicy',
	'excludeFromIndexes',
	'inventory',
	'operations',
	'digest'
] as const;
const INVENTORY_SUMMARY_KEYS = [
	'inventoryId',
	'issueDigest',
	'scanned',
	'pages',
	'matched',
	'typeMismatches'
] as const;
const OPERATION_KEYS = ['issueIndex', 'source', 'target', 'expectedPayload', 'replacementId'] as const;
const TRANSACTION_OPTION_KEYS = ['gaxOptions', 'commitGaxOptions', 'rollbackGaxOptions'] as const;

class DatastoreIdRepairIndeterminateCommitError extends Error {
	constructor(readonly cause: unknown) {
		super(`Datastore ID repair commit outcome is indeterminate: ${safeErrorMessage(cause)}`);
	}
}

export function createDatastoreIdRepairManifest(
	options: DatastoreIdRepairPlanOptions
): DatastoreIdRepairManifest {
	const record = configurationRecord(options, 'Datastore ID repair plan options');
	assertKnownKeys(record, PLAN_OPTION_KEYS, 'Datastore ID repair plan options', ActiveTsConfigurationError);
	const report = normalizeInventoryReport(
		ownDataValue(record, 'report', 'Datastore ID repair plan options', ActiveTsConfigurationError)
	);
	const target = normalizeTarget(
		ownDataValue(record, 'target', 'Datastore ID repair plan options', ActiveTsConfigurationError),
		'Datastore ID repair plan options.target',
		ActiveTsConfigurationError
	);
	const policy = normalizePolicy(
		ownDataValue(record, 'policy', 'Datastore ID repair plan options', ActiveTsConfigurationError),
		'Datastore ID repair plan options.policy',
		ActiveTsConfigurationError
	);
	const allowKeyMoves = ownDataValue(
		record,
		'allowKeyMoves',
		'Datastore ID repair plan options',
		ActiveTsConfigurationError
	);
	if (policy === 'payload-wins' && allowKeyMoves !== true) {
		throw new ActiveTsConfigurationError(
			'Datastore ID repair payload-wins policy requires allowKeyMoves: true because it changes physical keys.'
		);
	}
	if (policy === 'key-wins' && allowKeyMoves !== undefined) {
		throw new ActiveTsConfigurationError(
			'Datastore ID repair key-wins policy does not support allowKeyMoves.'
		);
	}
	const descendantPolicy = ownDataValue(
		record,
		'descendantPolicy',
		'Datastore ID repair plan options',
		ActiveTsConfigurationError
	);
	if (
		policy === 'payload-wins' &&
		descendantPolicy !== 'verified-none' &&
		descendantPolicy !== 'migrated-separately'
	) {
		throw new ActiveTsConfigurationError(
			'Datastore ID repair payload-wins policy requires descendantPolicy: "verified-none" or "migrated-separately".'
		);
	}
	if (policy === 'key-wins' && descendantPolicy !== undefined) {
		throw new ActiveTsConfigurationError(
			'Datastore ID repair key-wins policy does not support descendantPolicy.'
		);
	}
	const excludeFromIndexes = normalizeExcludeFromIndexes(
		ownRequiredDataValue(
			record,
			'excludeFromIndexes',
			'Datastore ID repair plan options',
			ActiveTsConfigurationError
		),
		report.idField,
		'Datastore ID repair plan options.excludeFromIndexes',
		ActiveTsConfigurationError
	);
	assertInventoryOnlyContainsTypeDrift(report);
	const rawIssues = snapshotArrayInput<unknown>(
		ownDataValue(record, 'issues', 'Datastore ID repair plan options', ActiveTsConfigurationError),
		'Datastore ID repair plan issues'
	);
	if (rawIssues.length !== report.counts['type-mismatch']) {
		throw new ActiveTsValidationError(
			`Datastore ID repair plan requires exactly ${report.counts['type-mismatch']} type-mismatch issues from its inventory report; received ${rawIssues.length}.`
		);
	}
	const operations: DatastoreIdRepairOperation[] = [];
	const normalizedIssues: DatastoreIdInventoryIssue[] = [];
	for (let index = 0; index < rawIssues.length; index++) {
		const issue = normalizeTypeMismatchIssue(
			rawIssues[index],
			report.inventoryId,
			index,
			report.kind,
			report.namespace,
			`Datastore ID repair plan issues[${index}]`
		);
		normalizedIssues[index] = issue;
		operations[index] = buildRepairOperation(index, issue.key, issue.payload, policy);
	}
	if (inventoryIssueDigest(normalizedIssues) !== report.issueDigest) {
		throw new ActiveTsValidationError(
			'Datastore ID repair issues do not match the inventory report issueDigest.'
		);
	}
	assertRepairOperationSet(operations, policy, 'Datastore ID repair plan operations');
	const inventory = Object.freeze({
		inventoryId: report.inventoryId,
		issueDigest: report.issueDigest,
		scanned: report.scanned,
		pages: report.pages,
		matched: report.counts.match,
		typeMismatches: report.counts['type-mismatch']
	});
	Object.freeze(operations);
	const manifest = {
		format: MANIFEST_FORMAT,
		version: 1,
		kind: report.kind,
		idField: report.idField,
		target,
		...(report.namespace === undefined ? {} : { namespace: report.namespace }),
		policy,
		allowKeyMoves: policy === 'payload-wins',
		...(descendantPolicy === undefined ? {} : { descendantPolicy }),
		excludeFromIndexes,
		inventory,
		operations
	} satisfies Omit<DatastoreIdRepairManifest, 'digest'>;
	return Object.freeze({
		...manifest,
		digest: repairManifestDigest(manifest)
	});
}

export async function applyDatastoreIdRepairManifest(
	options: DatastoreIdRepairApplyOptions
): Promise<DatastoreIdRepairApplyReport> {
	const record = configurationRecord(options, 'Datastore ID repair apply options');
	assertKnownKeys(record, APPLY_OPTION_KEYS, 'Datastore ID repair apply options', ActiveTsConfigurationError);
	const confirm = ownDataValue(
		record,
		'confirm',
		'Datastore ID repair apply options',
		ActiveTsConfigurationError
	);
	if (typeof confirm !== 'string') {
		throw new ActiveTsConfigurationError(
			'Datastore ID repair apply options.confirm must be the approved manifest digest.'
		);
	}
	const target = normalizeTarget(
		ownDataValue(record, 'target', 'Datastore ID repair apply options', ActiveTsConfigurationError),
		'Datastore ID repair apply options.target',
		ActiveTsConfigurationError
	);
	const manifest = normalizeRepairManifest(
		ownDataValue(record, 'manifest', 'Datastore ID repair apply options', ActiveTsConfigurationError)
	);
	if (target !== manifest.target) {
		throw new ActiveTsConfigurationError(
			`Datastore ID repair apply target "${target}" does not match manifest target "${manifest.target}".`
		);
	}
	if (confirm !== manifest.digest) {
		throw new ActiveTsConfigurationError(
			'Datastore ID repair apply confirmation does not match the manifest digest.'
		);
	}
	const rawClient = ownDataValue(
		record,
		'client',
		'Datastore ID repair apply options',
		ActiveTsConfigurationError
	);
	if (!rawClient || typeof rawClient !== 'object' || Array.isArray(rawClient)) {
		throw new ActiveTsConfigurationError('Datastore ID repair apply options.client must be an object.');
	}
	const clientNamespace = normalizeNamespace(
		optionalDataMember(rawClient, 'namespace', 'Datastore ID repair client.namespace'),
		'Datastore ID repair client.namespace',
		ActiveTsConfigurationError
	);
	if (clientNamespace !== undefined && clientNamespace !== manifest.namespace) {
		throw new ActiveTsConfigurationError(
			'Datastore ID repair client namespace must match the manifest namespace.'
		);
	}
	const key = requiredMethod(rawClient, 'key', 'Datastore ID repair client.key');
	const get = requiredMethod(rawClient, 'get', 'Datastore ID repair client.get');
	const transactionFactory = requiredMethod(
		rawClient,
		'transaction',
		'Datastore ID repair client.transaction'
	);
	const transactionOptions = normalizeTransactionOptions(
		ownDataValue(record, 'transaction', 'Datastore ID repair apply options', ActiveTsConfigurationError)
	);
	let repaired = 0;
	let alreadyRepaired = 0;
	await preflightRepairManifest(manifest, key, get);
	for (let index = 0; index < manifest.operations.length; index++) {
		try {
			const result = await applyRepairOperation(
				manifest,
				manifest.operations[index],
				index,
				key,
				transactionFactory,
				transactionOptions
			);
			if (result === 'repaired') repaired++;
			else alreadyRepaired++;
		} catch (error) {
			if (
				error instanceof DatastoreIdRepairIndeterminateCommitError ||
				transactionRollbackSkipped(error)
			) {
				const cause = error instanceof DatastoreIdRepairIndeterminateCommitError
					? error.cause
					: error;
				const progress = repairApplyReport(
					manifest.operations.length,
					repaired + alreadyRepaired,
					repaired,
					alreadyRepaired,
					1
				);
				throw new ActiveTsCommittedTransactionError(
					`Datastore ID repair operation ${index} has an indeterminate commit outcome; rerun inventory before continuing: ${safeErrorMessage(cause)}`,
					cause,
					progress
				);
			}
			if (repaired > 0) {
				const progress = repairApplyReport(
					manifest.operations.length,
					repaired + alreadyRepaired,
					repaired,
					alreadyRepaired,
					0
				);
				throw new ActiveTsCommittedTransactionError(
					`Datastore ID repair stopped at operation ${index} after ${repaired} repair(s) committed: ${safeErrorMessage(error)}`,
					error,
					progress
				);
			}
			throw error;
		}
	}
	return repairApplyReport(
		manifest.operations.length,
		manifest.operations.length,
		repaired,
		alreadyRepaired,
		0
	);
}

function normalizeInventoryReport(value: unknown) {
	const record = validationRecord(value, 'Datastore ID repair inventory report');
	assertKnownKeys(record, REPORT_KEYS, 'Datastore ID repair inventory report', ActiveTsValidationError);
	const inventoryId = normalizeInventoryId(
		ownDataValue(record, 'inventoryId', 'Datastore ID repair inventory report', ActiveTsValidationError),
		'Datastore ID repair inventory report.inventoryId'
	);
	const issueDigest = normalizeManifestDigest(
		ownDataValue(record, 'issueDigest', 'Datastore ID repair inventory report', ActiveTsValidationError),
		'Datastore ID repair inventory report.issueDigest'
	);
	const kind = assertSafePhysicalIdentifierLength(
		assertSafeSchemaIdentifier(
			ownDataValue(record, 'kind', 'Datastore ID repair inventory report', ActiveTsValidationError),
			'Datastore ID repair inventory report.kind'
		),
		'Datastore ID repair inventory report.kind'
	);
	const idField = assertSafeTopLevelField(
		ownDataValue(record, 'idField', 'Datastore ID repair inventory report', ActiveTsValidationError),
		'Datastore ID repair inventory report.idField'
	);
	const namespace = normalizeNamespace(
		ownDataValue(record, 'namespace', 'Datastore ID repair inventory report', ActiveTsValidationError),
		'Datastore ID repair inventory report.namespace',
		ActiveTsValidationError
	);
	const scanned = nonNegativeSafeInteger(
		ownDataValue(record, 'scanned', 'Datastore ID repair inventory report', ActiveTsValidationError),
		'Datastore ID repair inventory report.scanned'
	);
	const pages = positiveSafeInteger(
		ownDataValue(record, 'pages', 'Datastore ID repair inventory report', ActiveTsValidationError),
		'Datastore ID repair inventory report.pages'
	);
	const rawCounts = validationRecord(
		ownDataValue(record, 'counts', 'Datastore ID repair inventory report', ActiveTsValidationError),
		'Datastore ID repair inventory report.counts'
	);
	assertKnownKeys(
		rawCounts,
		INVENTORY_COUNT_KEYS,
		'Datastore ID repair inventory report.counts',
		ActiveTsValidationError
	);
	const counts = Object.create(null) as Record<(typeof INVENTORY_COUNT_KEYS)[number], number>;
	let total = 0;
	for (let index = 0; index < INVENTORY_COUNT_KEYS.length; index++) {
		const classification = INVENTORY_COUNT_KEYS[index];
		const count = nonNegativeSafeInteger(
			ownRequiredDataValue(
				rawCounts,
				classification,
				'Datastore ID repair inventory report.counts',
				ActiveTsValidationError
			),
			`Datastore ID repair inventory report.counts.${classification}`
		);
		counts[classification] = count;
		total += count;
		if (!Number.isSafeInteger(total)) {
			throw new ActiveTsValidationError('Datastore ID repair inventory report counts exceed the safe integer range.');
		}
	}
	if (total !== scanned) {
		throw new ActiveTsValidationError(
			`Datastore ID repair inventory report counts must sum to scanned (${total} !== ${scanned}).`
		);
	}
	Object.freeze(counts);
	return Object.freeze({ inventoryId, issueDigest, kind, idField, namespace, scanned, pages, counts });
}

function assertInventoryOnlyContainsTypeDrift(
	report: ReturnType<typeof normalizeInventoryReport>
) {
	for (let index = 0; index < INVENTORY_COUNT_KEYS.length; index++) {
		const classification = INVENTORY_COUNT_KEYS[index];
		if (classification === 'match' || classification === 'type-mismatch') continue;
		if (report.counts[classification] === 0) continue;
		throw new ActiveTsValidationError(
			`Datastore ID repair cannot automate ${classification} rows; resolve them manually and rerun inventory.`
		);
	}
}

function normalizeTypeMismatchIssue(
	value: unknown,
	expectedInventoryId: string,
	expectedIssueIndex: number,
	kind: string,
	namespace: string | undefined,
	context: string
) {
	const record = validationRecord(value, context);
	assertKnownKeys(record, ISSUE_KEYS, context, ActiveTsValidationError);
	const inventoryId = normalizeInventoryId(
		ownDataValue(record, 'inventoryId', context, ActiveTsValidationError),
		`${context}.inventoryId`
	);
	if (inventoryId !== expectedInventoryId) {
		throw new ActiveTsValidationError(`${context}.inventoryId must match its inventory report.`);
	}
	const issueIndex = nonNegativeSafeInteger(
		ownDataValue(record, 'issueIndex', context, ActiveTsValidationError),
		`${context}.issueIndex`
	);
	if (issueIndex !== expectedIssueIndex) {
		throw new ActiveTsValidationError(`${context}.issueIndex must be ${expectedIssueIndex}.`);
	}
	if (ownDataValue(record, 'classification', context, ActiveTsValidationError) !== 'type-mismatch') {
		throw new ActiveTsValidationError(`${context}.classification must be "type-mismatch".`);
	}
	const reason = ownDataValue(record, 'reason', context, ActiveTsValidationError);
	if (typeof reason !== 'string') {
		throw new ActiveTsValidationError(`${context}.reason must be a string.`);
	}
	const key = normalizeInventoryKey(
		ownDataValue(record, 'key', context, ActiveTsValidationError),
		kind,
		namespace,
		`${context}.key`
	);
	const payload = normalizeRepairPayload(
		ownDataValue(record, 'payload', context, ActiveTsValidationError),
		`${context}.payload`
	);
	assertTypeMismatch(key, payload, context);
	return Object.freeze({
		inventoryId,
		issueIndex,
		classification: 'type-mismatch' as const,
		key,
		payload,
		reason
	});
}

function normalizeInventoryKey(
	value: unknown,
	expectedKind: string,
	expectedNamespace: string | undefined,
	context: string
): DatastoreIdInventoryKey {
	const record = validationRecord(value, context);
	assertKnownKeys(record, INVENTORY_KEY_KEYS, context, ActiveTsValidationError);
	const namespace = normalizeNamespace(
		ownDataValue(record, 'namespace', context, ActiveTsValidationError),
		`${context}.namespace`,
		ActiveTsValidationError
	);
	if (namespace !== expectedNamespace) {
		throw new ActiveTsValidationError(`${context}.namespace must match the inventory report namespace.`);
	}
	const rawPath = snapshotArrayInput<unknown>(
		ownDataValue(record, 'path', context, ActiveTsValidationError),
		`${context}.path`
	);
	if (!rawPath.length) throw new ActiveTsValidationError(`${context}.path must be non-empty.`);
	const path: DatastoreIdInventoryKeyPart[] = [];
	for (let index = 0; index < rawPath.length; index++) {
		const partContext = `${context}.path[${index}]`;
		const partRecord = validationRecord(rawPath[index], partContext);
		assertKnownKeys(partRecord, INVENTORY_KEY_PART_KEYS, partContext, ActiveTsValidationError);
		const kind = assertSafePhysicalIdentifierLength(
			assertSafeSchemaIdentifier(
				ownDataValue(partRecord, 'kind', partContext, ActiveTsValidationError),
				`${partContext}.kind`
			),
			`${partContext}.kind`
		);
		const storage = ownDataValue(partRecord, 'storage', partContext, ActiveTsValidationError);
		const rawPartValue = ownDataValue(partRecord, 'value', partContext, ActiveTsValidationError);
		if (storage !== 'id' && storage !== 'name') {
			throw new ActiveTsValidationError(`${partContext}.storage must be "id" or "name".`);
		}
		if (typeof rawPartValue !== 'string') {
			throw new ActiveTsValidationError(`${partContext}.value must be a string.`);
		}
		if (storage === 'id') {
			if (!/^[1-9]\d*$/.test(rawPartValue)) {
				throw new ActiveTsValidationError(`${partContext}.value must be a canonical positive numeric ID.`);
			}
			const numericId = Number(rawPartValue);
			assertNativeDatastoreEntityId(numericId, `${partContext}.value`);
			if (String(numericId) !== rawPartValue) {
				throw new ActiveTsValidationError(`${partContext}.value exceeds the active-ts safe integer range.`);
			}
		} else {
			assertNativeDatastoreEntityId(rawPartValue, `${partContext}.value`);
		}
		path[index] = Object.freeze({ kind, storage, value: rawPartValue });
	}
	if (path[path.length - 1].kind !== expectedKind) {
		throw new ActiveTsValidationError(`${context} leaf kind must be "${expectedKind}".`);
	}
	Object.freeze(path);
	return Object.freeze({
		path,
		...(namespace === undefined ? {} : { namespace })
	});
}

function normalizeRepairPayload(value: unknown, context: string): DatastoreIdRepairPayload {
	const record = validationRecord(value, context);
	assertKnownKeys(record, PAYLOAD_KEYS, context, ActiveTsValidationError);
	const type = ownDataValue(record, 'type', context, ActiveTsValidationError);
	const payloadValue = ownDataValue(record, 'value', context, ActiveTsValidationError);
	if (type !== 'string' && type !== 'number') {
		throw new ActiveTsValidationError(`${context}.type must be "string" or "number".`);
	}
	if (typeof payloadValue !== type) {
		throw new ActiveTsValidationError(`${context}.value must match payload type "${type}".`);
	}
	assertSafeEntityId(payloadValue, `${context}.value`);
	return Object.freeze({ type, value: payloadValue }) as DatastoreIdRepairPayload;
}

function assertTypeMismatch(
	key: DatastoreIdInventoryKey,
	payload: DatastoreIdRepairPayload,
	context: string
) {
	const leaf = key.path[key.path.length - 1];
	const keyType = leaf.storage === 'id' ? 'number' : 'string';
	if (payload.type === keyType || String(payload.value) !== leaf.value) {
		throw new ActiveTsValidationError(
			`${context} must describe matching ID text with different physical-key and payload types.`
		);
	}
}

function buildRepairOperation(
	issueIndex: number,
	source: DatastoreIdInventoryKey,
	payload: DatastoreIdRepairPayload,
	policy: DatastoreIdRepairPolicy
): DatastoreIdRepairOperation {
	const leaf = source.path[source.path.length - 1];
	const replacementId = policy === 'key-wins'
		? leaf.storage === 'id' ? Number(leaf.value) : leaf.value
		: payload.value;
	assertSafeEntityId(replacementId, 'Datastore ID repair replacementId');
	if (policy === 'payload-wins') {
		if (typeof replacementId === 'number' && replacementId <= 0) {
			throw new ActiveTsValidationError('Datastore ID repair target key ID must be a positive integer.');
		}
		assertNativeDatastoreEntityId(replacementId, 'Datastore ID repair target key ID');
	}
	const target = policy === 'key-wins'
		? cloneInventoryKey(source)
		: replaceInventoryKeyLeaf(source, replacementId);
	return Object.freeze({
		issueIndex,
		source: cloneInventoryKey(source),
		target,
		expectedPayload: Object.freeze({ ...payload }) as DatastoreIdRepairPayload,
		replacementId
	});
}

function cloneInventoryKey(key: DatastoreIdInventoryKey): DatastoreIdInventoryKey {
	const path: DatastoreIdInventoryKeyPart[] = [];
	for (let index = 0; index < key.path.length; index++) {
		path[index] = Object.freeze({ ...key.path[index] });
	}
	Object.freeze(path);
	return Object.freeze({
		path,
		...(key.namespace === undefined ? {} : { namespace: key.namespace })
	});
}

function replaceInventoryKeyLeaf(
	key: DatastoreIdInventoryKey,
	id: EntityId
): DatastoreIdInventoryKey {
	const target = cloneInventoryKey(key);
	const path: DatastoreIdInventoryKeyPart[] = [];
	for (let index = 0; index < target.path.length; index++) path[index] = target.path[index];
	const leaf = path[path.length - 1];
	path[path.length - 1] = Object.freeze({
		kind: leaf.kind,
		storage: typeof id === 'number' ? 'id' : 'name',
		value: String(id)
	});
	Object.freeze(path);
	return Object.freeze({
		path,
		...(target.namespace === undefined ? {} : { namespace: target.namespace })
	});
}

function assertRepairOperationSet(
	operations: readonly DatastoreIdRepairOperation[],
	policy: DatastoreIdRepairPolicy,
	context: string
) {
	const sources = new Map<string, number>();
	const targets = new Map<string, number>();
	for (let index = 0; index < operations.length; index++) {
		const sourceIdentity = inventoryKeyIdentity(operations[index].source);
		const targetIdentity = inventoryKeyIdentity(operations[index].target);
		const duplicateSource = MAP_GET.call(sources, sourceIdentity) as number | undefined;
		if (duplicateSource !== undefined) {
			throw new ActiveTsValidationError(
				`${context}[${index}].source duplicates operations[${duplicateSource}].source.`
			);
		}
		const duplicateTarget = MAP_GET.call(targets, targetIdentity) as number | undefined;
		if (duplicateTarget !== undefined) {
			throw new ActiveTsValidationError(
				`${context}[${index}].target duplicates operations[${duplicateTarget}].target.`
			);
		}
		MAP_SET.call(sources, sourceIdentity, index);
		MAP_SET.call(targets, targetIdentity, index);
	}
	if (policy !== 'payload-wins') return;
	for (let index = 0; index < operations.length; index++) {
		const sourceIndex = MAP_GET.call(
			sources,
			inventoryKeyIdentity(operations[index].target)
		) as number | undefined;
		if (sourceIndex === undefined) continue;
		throw new ActiveTsValidationError(
			`${context}[${index}].target is operations[${sourceIndex}].source; key-move chains and swaps require manual migration.`
		);
	}
}

function inventoryKeyIdentity(key: DatastoreIdInventoryKey) {
	return datastoreKeyIdentity(inventoryKeyToLogicalKey(key));
}

function inventoryKeyToLogicalKey(key: DatastoreIdInventoryKey): DatastoreKey {
	const path: DatastoreKey['path'] = [];
	for (let index = 0; index < key.path.length; index++) {
		const part = key.path[index];
		path[index] = {
			kind: part.kind,
			id: part.storage === 'id' ? Number(part.value) : part.value
		};
	}
	return normalizeDatastoreKey({
		path,
		...(key.namespace === undefined ? {} : { namespace: key.namespace })
	});
}

function normalizeRepairManifest(value: unknown): DatastoreIdRepairManifest {
	const record = validationRecord(value, 'Datastore ID repair manifest');
	assertKnownKeys(record, MANIFEST_KEYS, 'Datastore ID repair manifest', ActiveTsValidationError);
	if (ownDataValue(record, 'format', 'Datastore ID repair manifest', ActiveTsValidationError) !== MANIFEST_FORMAT) {
		throw new ActiveTsValidationError(`Datastore ID repair manifest.format must be "${MANIFEST_FORMAT}".`);
	}
	if (ownDataValue(record, 'version', 'Datastore ID repair manifest', ActiveTsValidationError) !== 1) {
		throw new ActiveTsValidationError('Datastore ID repair manifest.version must be 1.');
	}
	const digest = normalizeManifestDigest(
		ownDataValue(record, 'digest', 'Datastore ID repair manifest', ActiveTsValidationError),
		'Datastore ID repair manifest.digest'
	);
	const kind = assertSafePhysicalIdentifierLength(
		assertSafeSchemaIdentifier(
			ownDataValue(record, 'kind', 'Datastore ID repair manifest', ActiveTsValidationError),
			'Datastore ID repair manifest.kind'
		),
		'Datastore ID repair manifest.kind'
	);
	const idField = assertSafeTopLevelField(
		ownDataValue(record, 'idField', 'Datastore ID repair manifest', ActiveTsValidationError),
		'Datastore ID repair manifest.idField'
	);
	const target = normalizeTarget(
		ownDataValue(record, 'target', 'Datastore ID repair manifest', ActiveTsValidationError),
		'Datastore ID repair manifest.target',
		ActiveTsValidationError
	);
	const namespace = normalizeNamespace(
		ownDataValue(record, 'namespace', 'Datastore ID repair manifest', ActiveTsValidationError),
		'Datastore ID repair manifest.namespace',
		ActiveTsValidationError
	);
	const policy = normalizePolicy(
		ownDataValue(record, 'policy', 'Datastore ID repair manifest', ActiveTsValidationError),
		'Datastore ID repair manifest.policy',
		ActiveTsValidationError
	);
	const allowKeyMoves = ownDataValue(
		record,
		'allowKeyMoves',
		'Datastore ID repair manifest',
		ActiveTsValidationError
	);
	if (typeof allowKeyMoves !== 'boolean' || allowKeyMoves !== (policy === 'payload-wins')) {
		throw new ActiveTsValidationError(
			'Datastore ID repair manifest.allowKeyMoves must be true exactly for payload-wins manifests.'
		);
	}
	const descendantPolicy = ownDataValue(
		record,
		'descendantPolicy',
		'Datastore ID repair manifest',
		ActiveTsValidationError
	);
	if (
		policy === 'payload-wins' &&
		descendantPolicy !== 'verified-none' &&
		descendantPolicy !== 'migrated-separately'
	) {
		throw new ActiveTsValidationError(
			'Datastore ID repair payload-wins manifest requires a valid descendantPolicy.'
		);
	}
	if (policy === 'key-wins' && descendantPolicy !== undefined) {
		throw new ActiveTsValidationError(
			'Datastore ID repair key-wins manifest cannot declare descendantPolicy.'
		);
	}
	const excludeFromIndexes = normalizeExcludeFromIndexes(
		ownRequiredDataValue(
			record,
			'excludeFromIndexes',
			'Datastore ID repair manifest',
			ActiveTsValidationError
		),
		idField,
		'Datastore ID repair manifest.excludeFromIndexes',
		ActiveTsValidationError
	);
	const rawInventory = validationRecord(
		ownDataValue(record, 'inventory', 'Datastore ID repair manifest', ActiveTsValidationError),
		'Datastore ID repair manifest.inventory'
	);
	assertKnownKeys(
		rawInventory,
		INVENTORY_SUMMARY_KEYS,
		'Datastore ID repair manifest.inventory',
		ActiveTsValidationError
	);
	const inventory = Object.freeze({
		inventoryId: normalizeInventoryId(
			ownRequiredDataValue(
				rawInventory,
				'inventoryId',
				'Datastore ID repair manifest.inventory',
				ActiveTsValidationError
			),
			'Datastore ID repair manifest.inventory.inventoryId'
		),
		issueDigest: normalizeManifestDigest(
			ownRequiredDataValue(
				rawInventory,
				'issueDigest',
				'Datastore ID repair manifest.inventory',
				ActiveTsValidationError
			),
			'Datastore ID repair manifest.inventory.issueDigest'
		),
		scanned: nonNegativeSafeInteger(
			ownRequiredDataValue(rawInventory, 'scanned', 'Datastore ID repair manifest.inventory', ActiveTsValidationError),
			'Datastore ID repair manifest.inventory.scanned'
		),
		pages: positiveSafeInteger(
			ownRequiredDataValue(rawInventory, 'pages', 'Datastore ID repair manifest.inventory', ActiveTsValidationError),
			'Datastore ID repair manifest.inventory.pages'
		),
		matched: nonNegativeSafeInteger(
			ownRequiredDataValue(rawInventory, 'matched', 'Datastore ID repair manifest.inventory', ActiveTsValidationError),
			'Datastore ID repair manifest.inventory.matched'
		),
		typeMismatches: nonNegativeSafeInteger(
			ownRequiredDataValue(
				rawInventory,
				'typeMismatches',
				'Datastore ID repair manifest.inventory',
				ActiveTsValidationError
			),
			'Datastore ID repair manifest.inventory.typeMismatches'
		)
	});
	if (inventory.matched + inventory.typeMismatches !== inventory.scanned) {
		throw new ActiveTsValidationError(
			'Datastore ID repair manifest inventory matched and typeMismatches must sum to scanned.'
		);
	}
	const rawOperations = snapshotArrayInput<unknown>(
		ownDataValue(record, 'operations', 'Datastore ID repair manifest', ActiveTsValidationError),
		'Datastore ID repair manifest.operations'
	);
	if (rawOperations.length !== inventory.typeMismatches) {
		throw new ActiveTsValidationError(
			'Datastore ID repair manifest operation count must match inventory.typeMismatches.'
		);
	}
	const operations: DatastoreIdRepairOperation[] = [];
	for (let index = 0; index < rawOperations.length; index++) {
		const context = `Datastore ID repair manifest.operations[${index}]`;
		const operationRecord = validationRecord(rawOperations[index], context);
		assertKnownKeys(operationRecord, OPERATION_KEYS, context, ActiveTsValidationError);
		const issueIndex = nonNegativeSafeInteger(
			ownDataValue(operationRecord, 'issueIndex', context, ActiveTsValidationError),
			`${context}.issueIndex`
		);
		if (issueIndex !== index) {
			throw new ActiveTsValidationError(`${context}.issueIndex must be ${index}.`);
		}
		const source = normalizeInventoryKey(
			ownDataValue(operationRecord, 'source', context, ActiveTsValidationError),
			kind,
			namespace,
			`${context}.source`
		);
		const expectedPayload = normalizeRepairPayload(
			ownDataValue(operationRecord, 'expectedPayload', context, ActiveTsValidationError),
			`${context}.expectedPayload`
		);
		assertTypeMismatch(source, expectedPayload, context);
		const expectedOperation = buildRepairOperation(issueIndex, source, expectedPayload, policy);
		const target = normalizeInventoryKey(
			ownDataValue(operationRecord, 'target', context, ActiveTsValidationError),
			kind,
			namespace,
			`${context}.target`
		);
		if (inventoryKeyIdentity(target) !== inventoryKeyIdentity(expectedOperation.target)) {
			throw new ActiveTsValidationError(`${context}.target does not match its policy-derived key.`);
		}
		const replacementId = ownDataValue(
			operationRecord,
			'replacementId',
			context,
			ActiveTsValidationError
		);
		assertSafeEntityId(replacementId, `${context}.replacementId`);
		if (typeof replacementId !== typeof expectedOperation.replacementId || replacementId !== expectedOperation.replacementId) {
			throw new ActiveTsValidationError(`${context}.replacementId does not match its policy-derived ID.`);
		}
		operations[index] = Object.freeze({
			issueIndex,
			source,
			target,
			expectedPayload,
			replacementId
		});
	}
	assertRepairOperationSet(operations, policy, 'Datastore ID repair manifest.operations');
	Object.freeze(operations);
	const manifest = {
		format: MANIFEST_FORMAT,
		version: 1,
		kind,
		idField,
		target,
		...(namespace === undefined ? {} : { namespace }),
		policy,
		allowKeyMoves,
		...(descendantPolicy === undefined ? {} : { descendantPolicy }),
		excludeFromIndexes,
		inventory,
		operations
	} satisfies Omit<DatastoreIdRepairManifest, 'digest'>;
	const expectedDigest = repairManifestDigest(manifest);
	if (digest !== expectedDigest) {
		throw new ActiveTsValidationError('Datastore ID repair manifest digest does not match its contents.');
	}
	return Object.freeze({ ...manifest, digest });
}

async function preflightRepairManifest(
	manifest: DatastoreIdRepairManifest,
	keyFactory: (...args: any[]) => any,
	get: (...args: any[]) => any
) {
	for (let index = 0; index < manifest.operations.length; index++) {
		const operation = manifest.operations[index];
		const sourceKey = keyFactory(inventoryKeyToSdkOptions(operation.source));
		const source = await transactionGet(get, sourceKey, `Datastore ID repair preflight ${index} source read`);
		if (source === undefined) {
			throw new ActiveTsConflictError(`Datastore ID repair preflight ${index} source no longer exists.`);
		}
		const currentPayload = payloadFromEntity(
			source,
			manifest.idField,
			`Datastore ID repair preflight ${index} source`
		);
		const alreadyRepaired =
			manifest.policy === 'key-wins' &&
			currentPayload.type === typeof operation.replacementId &&
			currentPayload.value === operation.replacementId;
		if (!alreadyRepaired && !sameRepairPayload(currentPayload, operation.expectedPayload)) {
			throw new ActiveTsConflictError(
				`Datastore ID repair preflight ${index} payload changed after inventory.`
			);
		}
		if (manifest.policy !== 'payload-wins') continue;
		const targetKey = keyFactory(inventoryKeyToSdkOptions(operation.target));
		const target = await transactionGet(get, targetKey, `Datastore ID repair preflight ${index} target read`);
		if (target !== undefined) {
			throw new ActiveTsConflictError(`Datastore ID repair preflight ${index} target already exists.`);
		}
	}
}

async function applyRepairOperation(
	manifest: DatastoreIdRepairManifest,
	operation: DatastoreIdRepairOperation,
	index: number,
	keyFactory: (...args: any[]) => any,
	transactionFactory: (...args: any[]) => any,
	transactionOptions: ReturnType<typeof normalizeTransactionOptions>
): Promise<'repaired' | 'already-repaired'> {
	const rawTransaction = transactionFactory({ readOnly: false });
	if (!rawTransaction || typeof rawTransaction !== 'object' || Array.isArray(rawTransaction)) {
		throw new ActiveTsConfigurationError('Datastore ID repair client.transaction() must return an object.');
	}
	const run = requiredMethod(rawTransaction, 'run', 'Datastore ID repair transaction.run');
	const commit = requiredMethod(rawTransaction, 'commit', 'Datastore ID repair transaction.commit');
	const rollback = requiredMethod(rawTransaction, 'rollback', 'Datastore ID repair transaction.rollback');
	const get = requiredMethod(rawTransaction, 'get', 'Datastore ID repair transaction.get');
	const update = requiredMethod(rawTransaction, 'update', 'Datastore ID repair transaction.update');
	const insert = manifest.policy === 'payload-wins'
		? requiredMethod(rawTransaction, 'insert', 'Datastore ID repair transaction.insert')
		: undefined;
	const deleteEntity = manifest.policy === 'payload-wins'
		? requiredMethod(rawTransaction, 'delete', 'Datastore ID repair transaction.delete')
		: undefined;
	let started = false;
	let committing = false;
	try {
		const runOptions = transactionOptions.gaxOptions === undefined
			? undefined
			: { gaxOptions: transactionOptions.gaxOptions };
		await run(runOptions);
		started = true;
		const sourceKey = keyFactory(inventoryKeyToSdkOptions(operation.source));
		const source = await transactionGet(get, sourceKey, `Datastore ID repair operation ${index} source read`);
		if (source === undefined) {
			throw new ActiveTsConflictError(`Datastore ID repair operation ${index} source no longer exists.`);
		}
		const currentPayload = payloadFromEntity(source, manifest.idField, `Datastore ID repair operation ${index} source`);
		if (
			manifest.policy === 'key-wins' &&
			currentPayload.type === typeof operation.replacementId &&
			currentPayload.value === operation.replacementId
		) {
			committing = true;
			await commit(transactionOptions.commitGaxOptions);
			return 'already-repaired';
		}
		if (!sameRepairPayload(currentPayload, operation.expectedPayload)) {
			throw new ActiveTsConflictError(
				`Datastore ID repair operation ${index} payload changed after inventory.`
			);
		}
		const data = snapshotEntityForWrite(source, `Datastore ID repair operation ${index} source`);
		defineDataProperty(data, manifest.idField, operation.replacementId, {
			enumerable: true,
			configurable: true,
			writable: true
		});
		const excludeFromIndexes: string[] = [];
		for (let fieldIndex = 0; fieldIndex < manifest.excludeFromIndexes.length; fieldIndex++) {
			excludeFromIndexes[fieldIndex] = manifest.excludeFromIndexes[fieldIndex];
		}
		if (manifest.policy === 'key-wins') {
			await update({ key: sourceKey, data, excludeFromIndexes });
		} else {
			const targetKey = keyFactory(inventoryKeyToSdkOptions(operation.target));
			const target = await transactionGet(get, targetKey, `Datastore ID repair operation ${index} target read`);
			if (target !== undefined) {
				throw new ActiveTsConflictError(`Datastore ID repair operation ${index} target already exists.`);
			}
			await insert!({ key: targetKey, data, excludeFromIndexes });
			await deleteEntity!(sourceKey);
		}
		committing = true;
		await commit(transactionOptions.commitGaxOptions);
		return 'repaired';
	} catch (error) {
		if (!started) throw error;
		if (committing) {
			throw new DatastoreIdRepairIndeterminateCommitError(markTransactionRollbackSkipped(error));
		}
		try {
			await rollback(transactionOptions.rollbackGaxOptions);
		} catch (rollbackError) {
			throw new AggregateError(
				[error, rollbackError],
				`Datastore ID repair operation ${index} failed and rollback failed: ${safeErrorMessage(error)}`
			);
		}
		throw error;
	}
}

function inventoryKeyToSdkOptions(key: DatastoreIdInventoryKey) {
	const path: Array<string | number> = [];
	for (let index = 0; index < key.path.length; index++) {
		const part = key.path[index];
		path[path.length] = part.kind;
		path[path.length] = part.storage === 'id' ? Number(part.value) : part.value;
	}
	return key.namespace === undefined ? { path } : { namespace: key.namespace, path };
}

async function transactionGet(
	get: (...args: any[]) => any,
	key: unknown,
	context: string
) {
	const result = snapshotArrayInput<unknown>(await get(key), `${context} result`);
	if (!Object.prototype.hasOwnProperty.call(result, 0)) {
		throw new ActiveTsValidationError(`${context} result[0] is required.`);
	}
	const entity = result[0];
	if (entity !== undefined && (!entity || typeof entity !== 'object' || Array.isArray(entity))) {
		throw new ActiveTsValidationError(`${context} result[0] must be an entity object or undefined.`);
	}
	return entity as Record<string, unknown> | undefined;
}

function payloadFromEntity(entity: Record<string, unknown>, idField: string, context: string) {
	if (!Object.prototype.hasOwnProperty.call(entity, idField)) return { type: 'missing' as const };
	const descriptor = Object.getOwnPropertyDescriptor(entity, idField);
	if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
		return { type: 'invalid' as const };
	}
	const value = descriptor.value;
	if (typeof value !== 'string' && typeof value !== 'number') return { type: 'invalid' as const };
	try {
		assertSafeEntityId(value, `${context}.${idField}`);
	} catch {
		return { type: 'invalid' as const };
	}
	return { type: typeof value, value } as DatastoreIdRepairPayload;
}

function sameRepairPayload(
	actual: DatastoreIdRepairPayload | { type: 'missing' | 'invalid' },
	expected: DatastoreIdRepairPayload
) {
	return actual.type === expected.type && 'value' in actual && actual.value === expected.value;
}

function snapshotEntityForWrite(entity: Record<string, unknown>, context: string) {
	const prototype = Object.getPrototypeOf(entity);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsValidationError(`${context} must be a plain entity object.`);
	}
	const snapshot = Object.create(null) as Record<string, unknown>;
	const entityProperties = Object.getOwnPropertyNames(entity);
	for (let index = 0; index < entityProperties.length; index++) {
		const property = entityProperties[index];
		const descriptor = Object.getOwnPropertyDescriptor(entity, property);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsValidationError(`${context}.${property} must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsValidationError(`${context}.${property} must be enumerable.`);
		}
		defineDataProperty(snapshot, property, descriptor.value, {
			enumerable: true,
			configurable: true,
			writable: true
		});
	}
	// SDK key metadata is a symbol field and is not part of the persisted payload.
	return snapshot;
}

function normalizeExcludeFromIndexes(
	value: unknown,
	idField: string,
	context: string,
	ErrorType: typeof ActiveTsConfigurationError | typeof ActiveTsValidationError
) {
	if (!Array.isArray(value)) throw new ErrorType(`${context} must be an array.`);
	if (Object.getOwnPropertySymbols(value).length) {
		throw new ErrorType(`${context} cannot contain symbol fields.`);
	}
	const fields = snapshotArrayInput<unknown>(value, context);
	const normalized: string[] = [];
	const seen = new Set<string>();
	for (let index = 0; index < fields.length; index++) {
		let field: string;
		try {
			field = assertSafeFieldPath(fields[index], `${context}[${index}]`);
		} catch (error) {
			throw new ErrorType(safeErrorMessage(error));
		}
		if (field.includes('/')) throw new ErrorType(`${context}[${index}] "${field}" cannot contain "/".`);
		if (field === idField || field.startsWith(`${idField}.`) || idField.startsWith(`${field}.`)) {
			throw new ErrorType(`${context}[${index}] cannot overlap ID field "${idField}".`);
		}
		if (SET_HAS.call(seen, field)) throw new ErrorType(`${context}[${index}] duplicates "${field}".`);
		SET_ADD.call(seen, field);
		normalized[index] = field;
	}
	return Object.freeze(normalized);
}

function normalizeTransactionOptions(value: unknown) {
	if (value === undefined) {
		return Object.freeze({
			gaxOptions: undefined,
			commitGaxOptions: undefined,
			rollbackGaxOptions: undefined
		});
	}
	const record = configurationRecord(value, 'Datastore ID repair transaction options');
	assertKnownKeys(
		record,
		TRANSACTION_OPTION_KEYS,
		'Datastore ID repair transaction options',
		ActiveTsConfigurationError
	);
	return Object.freeze({
		gaxOptions: snapshotSdkOptions(
			ownDataValue(record, 'gaxOptions', 'Datastore ID repair transaction options', ActiveTsConfigurationError),
			'Datastore ID repair transaction options.gaxOptions'
		),
		commitGaxOptions: snapshotSdkOptions(
			ownDataValue(
				record,
				'commitGaxOptions',
				'Datastore ID repair transaction options',
				ActiveTsConfigurationError
			),
			'Datastore ID repair transaction options.commitGaxOptions'
		),
		rollbackGaxOptions: snapshotSdkOptions(
			ownDataValue(
				record,
				'rollbackGaxOptions',
				'Datastore ID repair transaction options',
				ActiveTsConfigurationError
			),
			'Datastore ID repair transaction options.rollbackGaxOptions'
		)
	});
}

function snapshotSdkOptions(value: unknown, context: string) {
	if (value === undefined) return undefined;
	const record = configurationRecord(value, context);
	const snapshot = Object.create(null) as Record<string, unknown>;
	const properties = Object.getOwnPropertyNames(record);
	for (let index = 0; index < properties.length; index++) {
		const property = properties[index];
		defineDataProperty(
			snapshot,
			property,
			ownRequiredDataValue(record, property, context, ActiveTsConfigurationError),
			{ enumerable: true, configurable: true, writable: true }
		);
	}
	return snapshot;
}

function normalizePolicy(
	value: unknown,
	context: string,
	ErrorType: typeof ActiveTsConfigurationError | typeof ActiveTsValidationError
): DatastoreIdRepairPolicy {
	if (value !== 'key-wins' && value !== 'payload-wins') {
		throw new ErrorType(`${context} must be "key-wins" or "payload-wins".`);
	}
	return value;
}

function normalizeInventoryId(value: unknown, context: string) {
	if (
		typeof value !== 'string' ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
	) {
		throw new ActiveTsValidationError(`${context} must be a lowercase UUIDv4 string.`);
	}
	return value;
}

function repairManifestDigest(manifest: Omit<DatastoreIdRepairManifest, 'digest'>) {
	return `sha256:${createHash('sha256').update(JSON_STRINGIFY(manifest)).digest('hex')}`;
}

function inventoryIssueDigest(issues: readonly DatastoreIdInventoryIssue[]) {
	const hash = createHash('sha256');
	for (let index = 0; index < issues.length; index++) {
		hash.update(JSON_STRINGIFY(issues[index]));
		hash.update('\n');
	}
	return `sha256:${hash.digest('hex')}`;
}

function normalizeManifestDigest(value: unknown, context: string) {
	if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
		throw new ActiveTsValidationError(`${context} must be a lowercase SHA-256 digest.`);
	}
	return value;
}

function normalizeTarget(
	value: unknown,
	context: string,
	ErrorType: typeof ActiveTsConfigurationError | typeof ActiveTsValidationError
) {
	if (typeof value !== 'string') throw new ErrorType(`${context} must be a string.`);
	try {
		assertSafeEntityId(value, context);
	} catch (error) {
		throw new ErrorType(safeErrorMessage(error));
	}
	return value;
}

function normalizeNamespace(
	value: unknown,
	context: string,
	ErrorType: typeof ActiveTsConfigurationError | typeof ActiveTsValidationError
) {
	if (value !== undefined && (typeof value !== 'string' || !value || value.includes('\0'))) {
		throw new ErrorType(
			`${context} must be a non-empty string without null bytes, or undefined for the default namespace.`
		);
	}
	return value as string | undefined;
}

function nonNegativeSafeInteger(value: unknown, context: string) {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
		throw new ActiveTsValidationError(`${context} must be a non-negative safe integer.`);
	}
	return value;
}

function positiveSafeInteger(value: unknown, context: string) {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
		throw new ActiveTsValidationError(`${context} must be a positive safe integer.`);
	}
	return value;
}

function repairApplyReport(
	total: number,
	processed: number,
	repaired: number,
	alreadyRepaired: number,
	indeterminate: number
): DatastoreIdRepairApplyReport {
	return Object.freeze({ total, processed, repaired, alreadyRepaired, indeterminate });
}

function configurationRecord(value: unknown, context: string) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ActiveTsConfigurationError(`${context} must be a plain object.`);
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsConfigurationError(`${context} must be a plain object.`);
	}
	if (Object.getOwnPropertySymbols(value).length) {
		throw new ActiveTsConfigurationError(`${context} cannot contain symbol fields.`);
	}
	return value as Record<string, unknown>;
}

function validationRecord(value: unknown, context: string) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ActiveTsValidationError(`${context} must be a plain object.`);
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsValidationError(`${context} must be a plain object.`);
	}
	if (Object.getOwnPropertySymbols(value).length) {
		throw new ActiveTsValidationError(`${context} cannot contain symbol fields.`);
	}
	return value as Record<string, unknown>;
}

function assertKnownKeys(
	record: Record<string, unknown>,
	allowed: readonly string[],
	context: string,
	ErrorType: typeof ActiveTsConfigurationError | typeof ActiveTsValidationError
) {
	const allowedSet = new Set<string>();
	for (let index = 0; index < allowed.length; index++) SET_ADD.call(allowedSet, allowed[index]);
	const properties = Object.getOwnPropertyNames(record);
	for (let index = 0; index < properties.length; index++) {
		const property = properties[index];
		if (!SET_HAS.call(allowedSet, property)) {
			throw new ErrorType(`${context} contains unknown field "${property}".`);
		}
	}
}

function ownDataValue(
	record: Record<string, unknown>,
	property: string,
	context: string,
	ErrorType: typeof ActiveTsConfigurationError | typeof ActiveTsValidationError
) {
	if (!Object.prototype.hasOwnProperty.call(record, property)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(record, property);
	if (!descriptor || !('value' in descriptor)) {
		throw new ErrorType(`${context}.${property} must be a data property.`);
	}
	if (!descriptor.enumerable) throw new ErrorType(`${context}.${property} must be enumerable.`);
	return descriptor.value;
}

function ownRequiredDataValue(
	record: Record<string, unknown>,
	property: string,
	context: string,
	ErrorType: typeof ActiveTsConfigurationError | typeof ActiveTsValidationError
) {
	if (!Object.prototype.hasOwnProperty.call(record, property)) {
		throw new ErrorType(`${context}.${property} is required.`);
	}
	return ownDataValue(record, property, context, ErrorType);
}

function optionalDataMember(target: object, property: string, context: string) {
	let current: object | null = target;
	while (current && current !== Object.prototype) {
		if (Object.prototype.hasOwnProperty.call(current, property)) {
			const descriptor = Object.getOwnPropertyDescriptor(current, property);
			if (!descriptor || !('value' in descriptor)) {
				throw new ActiveTsConfigurationError(`${context} must be a data property.`);
			}
			return descriptor.value;
		}
		current = Object.getPrototypeOf(current);
	}
	return undefined;
}

function requiredMethod(target: object, property: string, context: string) {
	const value = optionalDataMember(target, property, context);
	if (typeof value === 'function') return value.bind(target);
	throw new ActiveTsConfigurationError(`${context} must be a function.`);
}
