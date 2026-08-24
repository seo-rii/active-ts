import { createHash, randomUUID } from 'node:crypto';
import { optionalImport } from '../../core/optional-import.js';
import {
	ActiveTsConfigurationError,
	ActiveTsConflictError,
	ActiveTsNotFoundError,
	ActiveTsValidationError,
	safeErrorMessage
} from '../../core/errors.js';
import { markTransactionRollbackSkipped, ownErrorValue } from '../../core/error-classification.js';
import {
	ACTIVE_TS_ENTITY_KEY,
	assertSafeCursor,
	assertSafeEntityId,
	assertSafeEntityIdArray,
	assertSafeFieldPath,
	assertSafeLimit,
	assertSafeOffset,
	assertSafePhysicalIdentifierLength,
	assertSafeSchemaIdentifier,
	assertSafeTopLevelField,
	attachEntityKey,
	clonePortableDataObject,
	cloneSafeDataObject,
	cloneSafeDataObjectWithoutActiveEntityKey,
	defineDataProperty
} from '../../core/safe-keys.js';
import { snapshotArrayInput } from '../../core/array-input.js';
import { aggregateRows, assertAggregateSpecsCompatibleWithModel, normalizeAggregateRow } from '../../core/aggregate.js';
import { compareRowsBySort, sortWithStableId } from '../../core/cursor.js';
import { entityIdFromCanonicalKey, entityIdFromKey, entityIdKey, filterRows, pickFields, valueFor } from '../../core/query-utils.js';
import { snapshotAdapterModel } from '../../core/adapter-model.js';
import {
	assertStoreDataMatchesId,
	assertStorePlanSupported,
	createCloseGuardedStoreAdapter,
	datastorePayloadCanResolveAncestor,
	datastorePayloadHasAncestorFields,
	datastorePayloadResolvedAncestor,
	datastoreWritePayloadAncestorCandidates,
	inheritAdapterTransactionOperationCarrier,
	markStoreTrustsDatastoreEntityKeyRows,
	normalizeStoreAggregatePlan,
	normalizeStoreAggregateResult,
	normalizeStoreQueryResultForModel,
	normalizeStoreQueryPlan,
	normalizeStoreReadOptions,
	normalizeStoreTransactionOptions,
	normalizeStoreWriteOptions,
	trackAdapterTransactionOperation,
	validateStoreQueryReadOptions
} from '../../core/store-options.js';
import {
	assertNativeDatastoreEntityId,
	datastoreAncestorFromEntityKey,
	datastoreEntityKeyNamespace,
	datastoreKeyIdentity,
	datastoreKeyPathValues,
	datastoreKeyWithNamespace,
	normalizeDatastoreKey,
	normalizeDatastoreReadPolicy,
	type DatastoreReadPolicy,
	type DatastoreKeyEncoding
} from '../../core/datastore-key.js';
import { datastoreSchemaAncestorModes, normalizeSchemaModels } from '../../core/schema-utils.js';
import { normalizeStoreSchemaApplyOptions } from '../../core/schema-options.js';
import { normalizeAggregatePlanFieldTypes, normalizeQueryPlanFieldTypes } from '../../core/field-types.js';
import {
	assertNoAggregateFieldCodecSpecs,
	copyFieldCodecQueryOperandMarker,
	encodeAggregatePlanFieldCodecs,
	encodeQueryPlanFieldCodecs,
	stripFieldCodecQueryOperandMarker
} from '../../core/field-codecs.js';
import { JSON_PARSE, JSON_STRINGIFY } from '../../core/json-intrinsics.js';
import { validateDatastoreUnindexedMetadata } from '../../core/model-metadata-invariants.js';
import {
	assertDatastoreQueryLimits,
	assertGoogleMinMaxInequalityOrder,
	assertGoogleInequalitySortOrder,
	assertGoogleSortableFieldsDeclared
} from './google-query-constraints.js';
import {
	iterableToArray,
	MAP_DELETE,
	MAP_GET,
	MAP_HAS,
	MAP_SET,
	MAP_VALUES,
	SET_ADD,
	SET_HAS,
	WEAKMAP_GET,
	WEAKMAP_SET,
	WEAKSET_ADD,
	WEAKSET_HAS
} from '../../core/collection-intrinsics.js';
import type {
	AggregatePlan,
	EntityId,
	DatastoreKey,
	FieldType,
	QueryPlan,
	QueryResult,
	ResolvedModelMeta,
	SchemaPlan,
	SortDirection,
	TransactionOptions,
	ModelTransactionOptions,
	StoreAdapter,
	StoreReadOptions,
	StoreTransactionOptions,
	StoreWriteOptions
} from '../../core/types.js';

export type DatastoreStoreOptions = {
	client?: any;
	datastoreOptions?: Record<string, any>;
	namespace?: string;
	cacheScope?: string;
	keyEncoding?: DatastoreKeyEncoding;
	keySymbol?: symbol;
	allowAggregateScanFallback?: boolean;
	allowQueryScanFallback?: boolean;
	requireAncestorTransactionQueries?: boolean;
};
export type DatastoreNamespaceStoreFactoryOptions = {
	client?: any;
	datastoreOptions?: Record<string, any>;
	cacheScopePrefix?: string;
	keyEncoding?: DatastoreKeyEncoding;
	keySymbol?: symbol;
	allowAggregateScanFallback?: boolean;
	allowQueryScanFallback?: boolean;
	requireAncestorTransactionQueries?: boolean;
	namespace?: never;
	cacheScope?: never;
};
export type DatastoreNamespaceStoreFactory = {
	readonly forNamespace: (namespace?: string) => Promise<DatastoreStoreAdapter>;
};
export type DatastoreBulkMutationOptions = {
	atomic?: boolean;
	chunkSize?: number;
};
export type DatastoreBulkUpsertEntry = {
	readonly id: EntityId;
	readonly data: Record<string, unknown>;
	readonly options?: StoreWriteOptions;
};
export type DatastoreBulkDeleteEntry = EntityId | {
	readonly id: EntityId;
	readonly options?: StoreWriteOptions;
};
export type DatastoreBulkOperations = {
	readonly upsertMany: (
		model: ResolvedModelMeta,
		entries: readonly DatastoreBulkUpsertEntry[],
		options?: DatastoreBulkMutationOptions
	) => Promise<void>;
	readonly deleteMany: (
		model: ResolvedModelMeta,
		entries: readonly DatastoreBulkDeleteEntry[],
		options?: DatastoreBulkMutationOptions
	) => Promise<void>;
};
export type DatastoreStoreAdapter = StoreAdapter & {
	readonly bulk: DatastoreBulkOperations;
};
export type { DatastoreKeyEncoding } from '../../core/datastore-key.js';
export type DatastoreIdInventoryClassification =
	| 'match'
	| 'type-mismatch'
	| 'value-mismatch'
	| 'missing-payload-id'
	| 'invalid-payload-id'
	| 'unsupported-key';
export type DatastoreIdInventoryKeyPart = {
	readonly kind: string;
	readonly storage: 'id' | 'name';
	readonly value: string;
};
export type DatastoreIdInventoryKey = {
	readonly path: readonly DatastoreIdInventoryKeyPart[];
	readonly namespace?: string;
};
export type DatastoreIdInventoryPayload =
	| { readonly type: 'missing' }
	| { readonly type: 'invalid'; readonly actualType: string }
	| { readonly type: 'string'; readonly value: string }
	| { readonly type: 'number'; readonly value: number };
export type DatastoreIdInventoryIssue = {
	readonly inventoryId: string;
	readonly issueIndex: number;
	readonly classification: Exclude<DatastoreIdInventoryClassification, 'match'>;
	readonly key: DatastoreIdInventoryKey;
	readonly payload: DatastoreIdInventoryPayload;
	readonly reason: string;
};
export type DatastoreIdInventoryOptions = {
	client: unknown;
	kind: string;
	idField?: string;
	namespace?: string;
	keySymbol?: symbol;
	pageSize?: number;
	onIssue?: (issue: DatastoreIdInventoryIssue) => void | Promise<void>;
};
export type DatastoreIdInventoryReport = {
	readonly inventoryId: string;
	readonly issueDigest: string;
	readonly kind: string;
	readonly idField: string;
	readonly namespace?: string;
	readonly scanned: number;
	readonly pages: number;
	readonly counts: Readonly<Record<DatastoreIdInventoryClassification, number>>;
};
export {
	applyDatastoreIdRepairManifest,
	createDatastoreIdRepairManifest
} from './datastore-id-repair.js';
export type {
	DatastoreIdRepairApplyOptions,
	DatastoreIdRepairApplyReport,
	DatastoreIdRepairDescendantPolicy,
	DatastoreIdRepairInventorySummary,
	DatastoreIdRepairManifest,
	DatastoreIdRepairOperation,
	DatastoreIdRepairPayload,
	DatastoreIdRepairPlanOptions,
	DatastoreIdRepairPolicy
} from './datastore-id-repair.js';
export type DatastoreTransactionNativeOptions = {
	gaxOptions?: Record<string, unknown>;
	commitGaxOptions?: Record<string, unknown>;
	rollbackGaxOptions?: Record<string, unknown>;
};
export type DatastoreStoreTransactionOptions = Omit<StoreTransactionOptions, 'native'> & {
	native?: DatastoreTransactionNativeOptions;
};
export type DatastoreTransactionOptions = Omit<TransactionOptions, 'native'> & {
	native?: DatastoreTransactionNativeOptions;
};
export type DatastoreModelTransactionOptions = Omit<ModelTransactionOptions, 'native'> & {
	native?: DatastoreTransactionNativeOptions;
};

export function datastoreStoreTransactionOptions(
	options: DatastoreStoreTransactionOptions
): DatastoreStoreTransactionOptions {
	return options;
}

export function datastoreTransactionOptions(options: DatastoreTransactionOptions): DatastoreTransactionOptions {
	return options;
}

export function datastoreModelTransactionOptions(
	options: DatastoreModelTransactionOptions
): DatastoreModelTransactionOptions {
	return options;
}

export async function inventoryDatastoreIds(
	options: DatastoreIdInventoryOptions
): Promise<DatastoreIdInventoryReport> {
	const safeOptions = normalizeDatastoreIdInventoryOptions(options);
	const inventoryId = randomUUID();
	const issueHash = createHash('sha256');
	const createQuery = datastoreMethod(
		safeOptions.client,
		'createQuery',
		'Datastore ID inventory client.createQuery'
	);
	const runQuery = datastoreMethod(
		safeOptions.client,
		'runQuery',
		'Datastore ID inventory client.runQuery'
	);
	let keySymbol = safeOptions.keySymbol;
	if (keySymbol === undefined) {
		const clientKeySymbol = datastoreMember(
			safeOptions.client,
			'KEY',
			'Datastore ID inventory client.KEY'
		);
		if (clientKeySymbol !== undefined && typeof clientKeySymbol !== 'symbol') {
			throw new ActiveTsConfigurationError('Datastore ID inventory client.KEY must be a symbol.');
		}
		keySymbol = typeof clientKeySymbol === 'symbol' ? clientKeySymbol : await resolveDatastoreKeySymbol();
	}
	let query = normalizeDatastoreQuery(
		safeOptions.namespace === undefined
			? createQuery(safeOptions.kind)
			: createQuery(safeOptions.namespace, safeOptions.kind),
		'Datastore ID inventory query'
	);
	query = normalizeDatastoreQuery(
		datastoreMethod(query, 'limit', 'Datastore ID inventory query.limit')(safeOptions.pageSize),
		'Datastore ID inventory query'
	);
	const counts: Record<DatastoreIdInventoryClassification, number> = {
		match: 0,
		'type-mismatch': 0,
		'value-mismatch': 0,
		'missing-payload-id': 0,
		'invalid-payload-id': 0,
		'unsupported-key': 0
	};
	const seenCursors = new Set<string>();
	let scanned = 0;
	let pages = 0;
	let issueIndex = 0;
	while (true) {
		const result = datastoreResultTuple(
			await runQuery(query),
			'Datastore ID inventory runQuery'
		);
		if (!Object.prototype.hasOwnProperty.call(result, 0)) {
			throw new ActiveTsValidationError('Datastore ID inventory runQuery result[0] is required.');
		}
		if (!Object.prototype.hasOwnProperty.call(result, 1)) {
			throw new ActiveTsValidationError('Datastore ID inventory runQuery result[1] is required.');
		}
		const entities = datastoreQueryEntities(result[0]);
		const pageInfo = datastoreIdInventoryPageInfo(result[1]);
		pages++;
		if (pageInfo.more && SET_HAS.call(seenCursors, pageInfo.cursor!)) {
			// The emulator repeats its terminal cursor with an empty page.
			if (entities.length === 0) break;
			throw new ActiveTsValidationError('Datastore ID inventory query returned a repeated non-empty page cursor.');
		}
		for (let index = 0; index < entities.length; index++) {
			const parsedKey = datastoreIdInventoryKey(
				entities[index],
				keySymbol,
				safeOptions.kind,
				safeOptions.namespace,
				`Datastore ID inventory entity[${index}]`
			);
			const payload = datastoreIdInventoryPayload(
				entities[index],
				safeOptions.idField,
				`Datastore ID inventory entity[${index}]`
			);
			const classified = classifyDatastoreIdInventory(parsedKey, payload, safeOptions.idField);
			counts[classified.classification]++;
			scanned++;
			if (classified.classification !== 'match') {
				const issue = Object.freeze({
					inventoryId,
					issueIndex,
					classification: classified.classification,
					key: parsedKey.key,
					payload,
					reason: classified.reason
				});
				issueHash.update(JSON_STRINGIFY(issue));
				issueHash.update('\n');
				if (safeOptions.onIssue !== undefined) await safeOptions.onIssue(issue);
				issueIndex++;
			}
		}
		if (!pageInfo.more) break;
		const cursor = pageInfo.cursor!;
		SET_ADD.call(seenCursors, cursor);
		query = normalizeDatastoreQuery(
			datastoreMethod(query, 'start', 'Datastore ID inventory query.start')(cursor),
			'Datastore ID inventory query'
		);
	}
	return Object.freeze({
		inventoryId,
		issueDigest: `sha256:${issueHash.digest('hex')}`,
		kind: safeOptions.kind,
		idField: safeOptions.idField,
		namespace: safeOptions.namespace,
		scanned,
		pages,
		counts: Object.freeze({ ...counts })
	});
}

type NormalizedDatastoreClient = ReturnType<typeof normalizeDatastoreClient>;
type DatastoreTransactionFactory = (options?: { readOnly?: boolean }) => unknown;
type DatastoreTransactionMutation =
	| { operation: 'create' | 'update'; model: ResolvedModelMeta; id: EntityId; data: any; options: StoreWriteOptions }
	| { operation: 'delete'; model: ResolvedModelMeta; id: EntityId; options: StoreWriteOptions; existed: boolean };
const DATASTORE_OPTION_KEYS = [
	'client',
	'datastoreOptions',
	'namespace',
	'cacheScope',
	'keyEncoding',
	'keySymbol',
	'allowAggregateScanFallback',
	'allowQueryScanFallback',
	'requireAncestorTransactionQueries'
] as const;
const DATASTORE_NAMESPACE_FACTORY_OPTION_KEYS = [
	'client',
	'datastoreOptions',
	'cacheScopePrefix',
	'keyEncoding',
	'keySymbol',
	'allowAggregateScanFallback',
	'allowQueryScanFallback',
	'requireAncestorTransactionQueries'
] as const;
const DATASTORE_TRANSACTION_NATIVE_OPTION_KEYS = ['gaxOptions', 'commitGaxOptions', 'rollbackGaxOptions'] as const;
const DATASTORE_BULK_MUTATION_OPTION_KEYS = ['atomic', 'chunkSize'] as const;
const DATASTORE_BULK_UPSERT_ENTRY_KEYS = ['id', 'data', 'options'] as const;
const DATASTORE_BULK_DELETE_ENTRY_KEYS = ['id', 'options'] as const;
const DATASTORE_ID_INVENTORY_OPTION_KEYS = [
	'client',
	'kind',
	'idField',
	'namespace',
	'keySymbol',
	'pageSize',
	'onIssue'
] as const;
const DATASTORE_SCAN_FALLBACK_PAGE_SIZE = 500;
const DATASTORE_SCAN_FALLBACK_INCOMPLETE_RESULTS = new WeakSet<object>();
const DATASTORE_CLIENT_CACHE_SCOPE_IDS = new WeakMap<object, string>();

export function createDatastoreIndexYaml(models: ResolvedModelMeta | ResolvedModelMeta[]): string {
	const modelList = Array.isArray(models) ? models : [models];
	const safeModels = normalizeSchemaModels(modelList, 'Datastore index.yaml models');
	assertDatastoreSchemaModelsSupported(safeModels);
	const entries: Array<{ kind: string; ancestor: boolean; fields: string[]; directions: SortDirection[] }> = [];
	const seen = new Set<string>();
	for (let modelIndex = 0; modelIndex < safeModels.length; modelIndex++) {
		const model = safeModels[modelIndex];
		const kind = kindForIndexYaml(model);
		const ancestorModes = datastoreSchemaAncestorModes(
			datastoreSchemaHasAncestor(model, 'Datastore index.yaml model')
		);
		for (let modeIndex = 0; modeIndex < ancestorModes.length; modeIndex++) {
			const ancestor = ancestorModes[modeIndex];
			for (let indexIndex = 0; indexIndex < model.indexes.length; indexIndex++) {
				const index = model.indexes[indexIndex];
				const { fields, directions } = datastoreRuntimeIndex(
					model,
					index.fields,
					index.directions,
					'Datastore index.yaml field'
				);
				const identity = datastoreIndexDedupeIdentity(kind, ancestor, fields, directions);
				if (SET_HAS.call(seen, identity)) continue;
				SET_ADD.call(seen, identity);
				entries[entries.length] = { kind, ancestor, fields, directions };
			}
		}
	}
	if (!entries.length) return 'indexes: []\n';
	const lines = ['indexes:'];
	for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
		const entry = entries[entryIndex];
		lines[lines.length] = `- kind: ${datastoreYamlString(entry.kind)}`;
		lines[lines.length] = `  ancestor: ${entry.ancestor ? 'yes' : 'no'}`;
		lines[lines.length] = '  properties:';
		for (let fieldIndex = 0; fieldIndex < entry.fields.length; fieldIndex++) {
			lines[lines.length] = `  - name: ${datastoreYamlString(entry.fields[fieldIndex])}`;
			lines[lines.length] = `    direction: ${entry.directions[fieldIndex]}`;
		}
	}
	return `${lines.join('\n')}\n`;
}

function indexDirections(directions: readonly SortDirection[] | undefined, fieldCount: number) {
	const safeDirections: SortDirection[] = [];
	for (let index = 0; index < fieldCount; index++) safeDirections[index] = directions?.[index] ?? 'asc';
	return safeDirections;
}

function datastoreRuntimeIndex(
	model: ResolvedModelMeta,
	rawFields: readonly string[],
	rawDirections: readonly SortDirection[] | undefined,
	context: string
) {
	const fields = datastoreFieldList(rawFields, context);
	const directions = indexDirections(rawDirections, fields.length);
	let hasIdField = false;
	for (let index = 0; index < fields.length; index++) {
		if (fields[index] !== model.idField) continue;
		hasIdField = true;
		break;
	}
	if (!hasIdField) {
		fields[fields.length] = assertSafeDatastoreField(model.idField, context);
		directions[directions.length] = 'asc';
	}
	return { fields, directions };
}

function datastoreYamlString(value: string) {
	return JSON_STRINGIFY(value);
}

function uniqueStrings(values: readonly string[]) {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		if (SET_HAS.call(seen, value)) continue;
		SET_ADD.call(seen, value);
		result.push(value);
	}
	return result;
}

function keyId(entity: any, keySymbol: symbol, keyEncoding: DatastoreKeyEncoding) {
	const key = datastoreEntityKey(entity, keySymbol);
	if (key === undefined) return undefined;
	const name = datastoreKeyProperty(key, 'name');
	const id = datastoreKeyProperty(key, 'id');
	if (name !== undefined && id !== undefined) {
		throw new ActiveTsValidationError('Datastore entity key cannot contain both name and id.');
	}
	if (name !== undefined) {
		if (typeof name !== 'string') {
			throw new ActiveTsValidationError('Datastore entity key name must be a string.');
		}
		if (keyEncoding === 'native') {
			assertSafeEntityId(name, 'Datastore entity key name');
			return name;
		}
		return entityIdFromCanonicalKey(name, 'Datastore entity key name');
	}
	if (id === undefined) return undefined;
	if (typeof id === 'number') {
		if (keyEncoding === 'native') return assertNativeDatastoreEntityId(id, 'Datastore entity key id');
		assertSafeEntityId(id, 'Datastore entity key id');
		return id;
	}
	if (typeof id === 'string') {
		if (!/^-?(0|[1-9]\d*)$/.test(id)) {
			throw new ActiveTsValidationError('Datastore entity key id must be a canonical integer string.');
		}
		const parsed = Number(id);
		if (keyEncoding === 'native') assertNativeDatastoreEntityId(parsed, 'Datastore entity key id');
		else assertSafeEntityId(parsed, 'Datastore entity key id');
		if (String(parsed) !== id) {
			throw new ActiveTsValidationError('Datastore entity key id must be canonical.');
		}
		return parsed;
	}
	throw new ActiveTsValidationError('Datastore entity key id must be a number or numeric string.');
}

function assertSafeDatastoreField(field: unknown, context = 'Datastore field') {
	const safeField = assertSafeFieldPath(field, context);
	if (safeField.includes('/')) throw new ActiveTsValidationError(`${context} "${safeField}" cannot contain "/".`);
	return safeField;
}

function datastoreFieldList(fields: readonly string[], context: string) {
	const safeFields: string[] = [];
	for (let index = 0; index < fields.length; index++) {
		safeFields[index] = assertSafeDatastoreField(fields[index], context);
	}
	return safeFields;
}

function datastoreProjectionFields(
	fields: readonly string[],
	where: QueryPlan['where'],
	context: string
) {
	const safeFields = datastoreFieldList(uniqueStrings(fields), context);
	for (let fieldIndex = 0; fieldIndex < safeFields.length; fieldIndex++) {
		const field = safeFields[fieldIndex];
		for (let whereIndex = 0; whereIndex < where.length; whereIndex++) {
			const condition = where[whereIndex];
			if (condition.field !== field) continue;
			if (condition.op === '=' || condition.op === 'in' || condition.op === 'isNull') return undefined;
		}
	}
	return safeFields;
}

function kindForIndexYaml(model: ResolvedModelMeta) {
	return assertSafePhysicalIdentifierLength(
		assertSafeSchemaIdentifier(model.name, 'Datastore index.yaml kind name'),
		'Datastore index.yaml kind name'
	);
}

function datastoreKindName(model: ResolvedModelMeta) {
	return assertSafePhysicalIdentifierLength(
		assertSafeSchemaIdentifier(model.name, 'Datastore kind name'),
		'Datastore kind name'
	);
}

function applyDatastoreWhere(query: any, where: QueryPlan['where'][number]) {
	const field = assertSafeDatastoreField(where.field, 'Datastore query field');
	if (where.op === 'in') return datastoreMethod(query, 'filter', 'Datastore query.filter')(field, 'IN', where.value);
	if (where.op === 'between')
		return datastoreMethod(
			normalizeDatastoreQuery(
				datastoreMethod(query, 'filter', 'Datastore query.filter')(field, '>=', where.value),
				'Datastore query'
			),
			'filter',
			'Datastore query.filter'
		)(field, '<=', where.value2);
	if (where.op === 'isNull') return datastoreMethod(query, 'filter', 'Datastore query.filter')(field, '=', null);
	if (where.op === 'isNotNull') return datastoreMethod(query, 'filter', 'Datastore query.filter')(field, '!=', null);
	if (where.op === 'contains')
		throw new ActiveTsConfigurationError('Datastore adapter does not support contains queries.');
	if (where.op === 'arrayContains' || where.op === 'textContains' || where.op === 'jsonContains')
		throw new ActiveTsConfigurationError(`Datastore adapter does not support ${where.op} queries.`);
	if (where.op === 'startsWith')
		throw new ActiveTsConfigurationError('Datastore adapter does not support safe startsWith queries.');
	return datastoreMethod(query, 'filter', 'Datastore query.filter')(field, where.op, where.value);
}

function normalizeDatastoreEntity(entity: any, keySymbol: symbol) {
	if (!entity) return null;
	if (typeof entity !== 'object' || Array.isArray(entity)) {
		throw new ActiveTsValidationError('Datastore entity must be a plain object.');
	}
	const sourceData = datastoreEntityData(entity, keySymbol);
	return cloneSafeDataObject(sourceData, 'Datastore entity data');
}

function cloneDatastoreEntityKeyMetadata(key: unknown) {
	try {
		return structuredClone(key);
	} catch {
		throw new ActiveTsValidationError('Datastore entity key must be structured-cloneable.');
	}
}

function datastoreEntityKeyMetadata(
	key: unknown,
	keyEncoding: DatastoreKeyEncoding,
	model: ResolvedModelMeta,
	id: EntityId,
	ancestor: DatastoreKey | undefined,
	context: string
) {
	if (keyEncoding === 'active-ts') return cloneDatastoreEntityKeyMetadata(key);
	const path: DatastoreKey['path'] = [];
	if (ancestor !== undefined) {
		for (let index = 0; index < ancestor.path.length; index++) {
			path[index] = ancestor.path[index];
		}
	}
	path[path.length] = { kind: datastoreKindName(model), id };
	return normalizeDatastoreKey({
		path,
		namespace: ancestor?.namespace ?? datastoreEntityKeyNamespace(key, context)
	}, `${context} logical key`);
}

function normalizeDatastoreEntityForExpectedId(
	entity: any,
	model: ResolvedModelMeta,
	expectedId: EntityId,
	keySymbol: symbol,
	context: string,
	expectedAncestor?: DatastoreKey,
	expectedNamespace?: string,
	validatePayloadAncestor = false,
	keyEncoding: DatastoreKeyEncoding = 'active-ts'
) {
	const data = normalizeDatastoreEntity(entity, keySymbol);
	if (data === null) return null;
	const sourceKey = datastoreEntityKey(entity, keySymbol);
	let actualAncestor: DatastoreKey | undefined;
	if (sourceKey !== undefined) {
		actualAncestor = datastoreAncestorFromEntityKey(
			sourceKey,
			datastoreKindName(model),
			expectedId,
			'Datastore entity key',
			keyEncoding
		);
		const ancestorMismatch =
			expectedAncestor !== undefined &&
			(actualAncestor === undefined || datastoreKeyIdentity(actualAncestor) !== datastoreKeyIdentity(expectedAncestor));
		if (ancestorMismatch) {
			const actualIdentity = actualAncestor === undefined ? 'undefined' : datastoreKeyIdentity(actualAncestor);
			throw new ActiveTsValidationError(
				`${context} entity key must match the requested Datastore ancestor (${actualIdentity} !== ${datastoreKeyIdentity(expectedAncestor)}).`
			);
		}
		assertDatastoreReturnedEntityKeyScope(
			model,
			sourceKey,
			actualAncestor,
			expectedAncestor,
			expectedNamespace,
			context
		);
	}
	const storageId = keyId(entity, keySymbol, keyEncoding);
	if (storageId !== undefined) {
		assertSafeEntityId(storageId, `${context} entity key id`);
		if (entityIdKey(storageId) !== entityIdKey(expectedId)) {
			throw new ActiveTsValidationError(`${context} entity key must match the requested id.`);
		}
	}
	assertStoreDataMatchesId(model, expectedId, data, context);
	if (validatePayloadAncestor) {
		assertDatastorePayloadWithinScopedAncestor(
			model,
			expectedId,
			data,
			expectedAncestor,
			context,
			expectedNamespace
		);
	}
	if (sourceKey !== undefined) {
		attachEntityKey(
			data,
			datastoreEntityKeyMetadata(
				sourceKey,
				keyEncoding,
				model,
				expectedId,
				actualAncestor,
				`${context} entity key`
			)
		);
	}
	return data;
}

function normalizeDatastoreEntityForResult(
	entity: any,
	model: ResolvedModelMeta,
	keySymbol: symbol,
	context: string,
	expectedAncestor?: DatastoreKey,
	allowDescendantAncestor = false,
	expectedNamespace?: string,
	validatePayloadAncestor = false,
	keyEncoding: DatastoreKeyEncoding = 'active-ts',
	deriveMissingIdFromEntityKey = false
) {
	const data = normalizeDatastoreEntity(entity, keySymbol);
	if (data === null) {
		throw new ActiveTsValidationError(`${context} must be an entity object.`);
	}
	const storageId = keyId(entity, keySymbol, keyEncoding);
	let rowId = valueFor(data, model.idField);
	if (deriveMissingIdFromEntityKey && storageId !== undefined && (rowId === undefined || rowId === null)) {
		assertSafeEntityId(storageId, `${context} entity key id`);
		defineDataProperty(data, model.idField, storageId, {
			enumerable: true,
			configurable: true,
			writable: true
		});
		rowId = storageId;
	}
	const sourceKey = datastoreEntityKey(entity, keySymbol);
	let actualAncestor: DatastoreKey | undefined;
	if (sourceKey !== undefined && rowId !== undefined && rowId !== null) {
		actualAncestor = datastoreAncestorFromEntityKey(
			sourceKey,
			datastoreKindName(model),
			rowId as EntityId,
			'Datastore entity key',
			keyEncoding
		);
		const ancestorMismatch =
			expectedAncestor !== undefined &&
			(actualAncestor === undefined ||
				(allowDescendantAncestor
					? !datastoreTransactionOverlayAncestorMatches(actualAncestor, expectedAncestor, undefined)
					: datastoreKeyIdentity(actualAncestor) !== datastoreKeyIdentity(expectedAncestor)));
		if (ancestorMismatch) {
			const actualIdentity = actualAncestor === undefined ? 'undefined' : datastoreKeyIdentity(actualAncestor);
			throw new ActiveTsValidationError(
				`${context} entity key must match the requested Datastore ancestor (${actualIdentity} !== ${datastoreKeyIdentity(expectedAncestor)}).`
			);
		}
		assertDatastoreReturnedEntityKeyScope(
			model,
			sourceKey,
			actualAncestor,
			expectedAncestor,
			expectedNamespace,
			context
		);
	}
	if (storageId !== undefined) {
		assertSafeEntityId(storageId, `${context} entity key id`);
		assertStoreDataMatchesId(model, storageId, data, context);
		if (validatePayloadAncestor) {
			assertDatastorePayloadWithinScopedAncestor(
				model,
				storageId,
				data,
				expectedAncestor,
				context,
				expectedNamespace
			);
		}
		if (sourceKey !== undefined) {
			attachEntityKey(
				data,
				datastoreEntityKeyMetadata(
					sourceKey,
					keyEncoding,
					model,
					storageId,
					actualAncestor,
					`${context} entity key`
				)
			);
		}
		return { id: storageId, data };
	}
	if (rowId === undefined || rowId === null) {
		throw new ActiveTsValidationError(`${context} is missing id field "${model.idField}".`);
	}
	assertSafeEntityId(rowId, `${context}.${model.idField}`);
	if (validatePayloadAncestor) {
		assertDatastorePayloadWithinScopedAncestor(
			model,
			rowId,
			data,
			expectedAncestor,
			context,
			expectedNamespace
		);
	}
	if (sourceKey !== undefined) {
		attachEntityKey(
			data,
			datastoreEntityKeyMetadata(
				sourceKey,
				keyEncoding,
				model,
				rowId,
				actualAncestor,
				`${context} entity key`
			)
		);
	}
	return { id: rowId, data };
}

function assertDatastoreReturnedEntityKeyScope(
	model: ResolvedModelMeta,
	sourceKey: unknown,
	actualAncestor: DatastoreKey | undefined,
	expectedAncestor: DatastoreKey | undefined,
	expectedNamespace: string | undefined,
	context: string
) {
	if (expectedAncestor === undefined && actualAncestor !== undefined && model.datastore?.ancestor === undefined) {
		throw new ActiveTsValidationError(`${context} entity key must not contain a Datastore ancestor.`);
	}
	const actualNamespace = datastoreEntityKeyNamespace(sourceKey, 'Datastore entity key');
	const requestedNamespace = expectedAncestor?.namespace ?? expectedNamespace;
	if (actualNamespace !== undefined && actualNamespace !== requestedNamespace) {
		throw new ActiveTsValidationError(
			`${context} entity key namespace must match the requested Datastore namespace.`
		);
	}
}

function datastoreEntityKey(entity: unknown, keySymbol: symbol) {
	if (!entity || typeof entity !== 'object') return undefined;
	if (!Object.prototype.hasOwnProperty.call(entity, keySymbol)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(entity, keySymbol);
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsValidationError('Datastore entity key must be a data property.');
	}
	return descriptor.value;
}

function datastoreKeyProperty(key: unknown, property: 'name' | 'id') {
	if (!key || typeof key !== 'object' || Array.isArray(key)) {
		throw new ActiveTsValidationError('Datastore entity key must be an object.');
	}
	if (!Object.prototype.hasOwnProperty.call(key, property)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(key, property);
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsValidationError(`Datastore entity key ${property} must be a data property.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsValidationError(`Datastore entity key ${property} must be enumerable.`);
	}
	return descriptor.value;
}

function datastoreEntityData(entity: object, keySymbol: symbol) {
	const data: Record<string, unknown> = {};
	for (const key of Object.getOwnPropertyNames(entity)) {
		const descriptor = Object.getOwnPropertyDescriptor(entity, key);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsValidationError(`Datastore entity data "${key}" must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsValidationError(`Datastore entity data "${key}" must be enumerable.`);
		}
		data[key] = descriptor.value;
	}
	for (const symbol of Object.getOwnPropertySymbols(entity)) {
		if (symbol === keySymbol || !Object.prototype.propertyIsEnumerable.call(entity, symbol)) continue;
		throw new ActiveTsValidationError('Datastore entity data cannot contain symbol fields.');
	}
	return data;
}

function assertDatastoreNativeFunction(plan: QueryPlan | AggregatePlan) {
	if (plan.native === undefined) return undefined;
	if (typeof plan.native.payload === 'function') return plan.native.payload;
	throw new ActiveTsConfigurationError('Datastore native payload must be a function.');
}

function datastoreAncestorFromPlan(plan: QueryPlan | AggregatePlan): DatastoreKey | undefined {
	const ancestor = plan.meta?.datastoreAncestor;
	return ancestor === undefined
		? undefined
		: normalizeDatastoreKey(ancestor, 'Datastore query meta.datastoreAncestor');
}

function requireDatastoreTransactionAncestor(plan: QueryPlan | AggregatePlan, context: string) {
	const ancestor = datastoreAncestorFromPlan(plan);
	if (ancestor !== undefined) return ancestor;
	throw new ActiveTsConfigurationError(
		`${context} requires meta.datastoreAncestor because Datastore queries inside transactions must be ancestor queries.`
	);
}

type DatastoreAncestorOverride = {
	provided: boolean;
	ancestor?: DatastoreKey;
};

function datastoreAncestorForWrite(
	model: ResolvedModelMeta,
	id: EntityId,
	data: any | undefined,
	ancestorOverride?: DatastoreAncestorOverride
): DatastoreKey | undefined {
	if (ancestorOverride?.provided) return ancestorOverride.ancestor;
	const resolver = model.datastore?.ancestor;
	if (!resolver) return undefined;
	if (data === undefined) {
		throw new ActiveTsConfigurationError(
			`Datastore model "${model.name}" declares an ancestor resolver, so direct id reads require an ancestor-aware query.`
		);
	}
	const ancestor = resolver({ model, id, data });
	return ancestor === undefined
		? undefined
		: normalizeDatastoreKey(ancestor, `Datastore model "${model.name}" ancestor`);
}

function datastoreAncestorForReadPayload(
	model: ResolvedModelMeta,
	id: EntityId,
	data: any | undefined
): DatastoreKey | undefined {
	const resolver = model.datastore?.ancestor;
	if (!resolver) return undefined;
	if (data === undefined) {
		throw new ActiveTsConfigurationError(
			`Datastore model "${model.name}" declares an ancestor resolver, so direct id reads require an ancestor-aware query.`
		);
	}
	return datastorePayloadResolvedAncestor(model, id, data, `Datastore model "${model.name}" ancestor`);
}

function datastoreAncestorFromWriteOptions(options: StoreWriteOptions): DatastoreAncestorOverride {
	const meta = options.meta;
	if (!meta) return { provided: false };
	assertDatastoreDirectMetadataKeys(meta, 'Datastore write options.meta');
	if (!Object.prototype.hasOwnProperty.call(meta, 'datastoreAncestor')) return { provided: false };
	const ancestor = meta.datastoreAncestor;
	return ancestor === undefined
		? { provided: true }
		: {
				provided: true,
				ancestor: normalizeDatastoreKey(ancestor, 'Datastore write options.meta.datastoreAncestor')
			};
}

function normalizeDatastoreBulkMutationOptions(
	options: DatastoreBulkMutationOptions | undefined,
	context: string
) {
	if (options === undefined) return Object.freeze({ atomic: false, chunkSize: undefined });
	if (!options || typeof options !== 'object' || Array.isArray(options)) {
		throw new ActiveTsConfigurationError(`${context} must be an object.`);
	}
	assertPlainFactoryOptions(options, context);
	const record = options as Record<string, unknown>;
	assertNoSymbolOptions(record, context);
	assertKnownOptions(record, DATASTORE_BULK_MUTATION_OPTION_KEYS, context);
	const atomic = ownFactoryOptionValue(record, 'atomic', context);
	if (atomic !== undefined && typeof atomic !== 'boolean') {
		throw new ActiveTsConfigurationError(`${context}.atomic must be a boolean.`);
	}
	const chunkSize = ownFactoryOptionValue(record, 'chunkSize', context);
	if (chunkSize !== undefined && (typeof chunkSize !== 'number' || !Number.isSafeInteger(chunkSize) || chunkSize <= 0)) {
		throw new ActiveTsConfigurationError(`${context}.chunkSize must be a positive safe integer.`);
	}
	if (atomic === true && chunkSize !== undefined) {
		throw new ActiveTsConfigurationError(`${context} cannot combine atomic with chunkSize.`);
	}
	return Object.freeze({
		atomic: atomic === true,
		chunkSize: chunkSize as number | undefined
	});
}

function normalizeDatastoreReadOptions(options: unknown, context: string): StoreReadOptions {
	const normalized = normalizeStoreReadOptions(options, context);
	if (normalized.select !== undefined) {
		throw new ActiveTsConfigurationError(`${context} does not support select read options.`);
	}
	if (normalized.native !== undefined) {
		throw new ActiveTsConfigurationError(`${context} does not support native read options.`);
	}
	return normalized;
}

type DatastoreSdkReadOptions = {
	consistency?: 'strong' | 'eventual';
	readTime?: number;
};

function datastoreReadPolicyFromMeta(
	meta: Record<string, unknown> | undefined,
	context: string
): DatastoreReadPolicy | undefined {
	if (!meta || !Object.prototype.hasOwnProperty.call(meta, 'datastoreRead')) return undefined;
	return normalizeDatastoreReadPolicy(meta.datastoreRead, context);
}

function datastoreSdkReadOptions(
	meta: Record<string, unknown> | undefined,
	context: string
): DatastoreSdkReadOptions | undefined {
	const policy = datastoreReadPolicyFromMeta(meta, context);
	if (policy === undefined) return undefined;
	return policy.readTime === undefined
		? { consistency: policy.consistency }
		: { readTime: policy.readTime };
}

function rejectDatastoreTransactionReadPolicy(options: StoreReadOptions, context: string) {
	if (datastoreReadPolicyFromMeta(options.meta, `${context}.meta.datastoreRead`) === undefined) return;
	throw new ActiveTsConfigurationError(`${context} cannot use Datastore readTime or consistency inside a transaction.`);
}

function runDatastoreRead(
	method: (input: any, options?: DatastoreSdkReadOptions) => any,
	input: any,
	options: DatastoreSdkReadOptions | undefined
) {
	return options === undefined ? method(input) : method(input, options);
}

function datastoreAncestorFromReadOptions(options: StoreReadOptions): DatastoreAncestorOverride {
	const meta = options.meta;
	if (!meta) return { provided: false };
	assertDatastoreDirectMetadataKeys(meta, 'Datastore read options.meta', true);
	if (!Object.prototype.hasOwnProperty.call(meta, 'datastoreAncestor')) return { provided: false };
	const ancestor = meta.datastoreAncestor;
	return ancestor === undefined
		? { provided: true }
		: {
				provided: true,
				ancestor: normalizeDatastoreKey(ancestor, 'Datastore read options.meta.datastoreAncestor')
			};
}

function assertDatastoreDirectIdReadAllowed(model: ResolvedModelMeta, ancestorOverride: DatastoreAncestorOverride) {
	if (!model.datastore?.ancestor) return;
	if (ancestorOverride.provided && ancestorOverride.ancestor !== undefined) return;
	throw new ActiveTsConfigurationError(
		`Datastore model "${model.name}" declares an ancestor resolver, so direct id reads require an ancestor-aware query.`
	);
}

function assertDatastoreWriteAncestorOverrideAllowed(
	model: ResolvedModelMeta,
	ancestorOverride: DatastoreAncestorOverride
) {
	if (!model.datastore?.ancestor) return;
	if (!ancestorOverride.provided || ancestorOverride.ancestor !== undefined) return;
	throw new ActiveTsConfigurationError(
		`Datastore model "${model.name}" declares an ancestor resolver, so write metadata cannot set datastoreAncestor to undefined.`
	);
}

function assertDatastoreWriteAncestorMatchesPayload(
	model: ResolvedModelMeta,
	id: EntityId,
	data: any,
	ancestorOverride: DatastoreAncestorOverride,
	adapterNamespace: string | undefined,
	context: string
) {
	if (!model.datastore?.ancestor || !ancestorOverride.provided || ancestorOverride.ancestor === undefined) return;
	const metadataAncestor = datastoreKeyWithNamespace(
		ancestorOverride.ancestor,
		adapterNamespace,
		`${context} metadata datastoreAncestor`
	);
	const payloadAncestors = datastoreWritePayloadAncestorCandidates(model, id, data);
	for (let index = 0; index < payloadAncestors.length; index++) {
		if (datastoreWriteAncestorMatchesMetadata(
			metadataAncestor,
			payloadAncestors[index],
			adapterNamespace,
			`${context} payload Datastore ancestor`
		)) return;
	}
	const expectedPayloadAncestor = payloadAncestors[payloadAncestors.length - 1];
	const expectedAncestor = expectedPayloadAncestor === undefined
		? undefined
		: datastoreKeyWithNamespace(expectedPayloadAncestor, adapterNamespace, `${context} payload Datastore ancestor`);
	const expectedIdentity = expectedAncestor === undefined ? 'undefined' : datastoreKeyIdentity(expectedAncestor);
	const metadataIdentity = datastoreKeyIdentity(metadataAncestor);
	throw new ActiveTsConfigurationError(
		`${context} write metadata datastoreAncestor must match payload Datastore ancestor (${metadataIdentity} !== ${expectedIdentity}).`
	);
}

function datastoreWriteAncestorMatchesMetadata(
	metadataAncestor: DatastoreKey,
	payloadAncestor: DatastoreKey | undefined,
	adapterNamespace: string | undefined,
	context: string
) {
	if (payloadAncestor === undefined) return false;
	const expectedAncestor = datastoreKeyWithNamespace(payloadAncestor, adapterNamespace, context);
	return (
		datastoreAncestorPathsEqual(metadataAncestor, expectedAncestor) &&
		datastoreWriteAncestorNamespacesCompatible(metadataAncestor, payloadAncestor, adapterNamespace)
	);
}

function datastoreAncestorPathsEqual(actual: DatastoreKey, expected: DatastoreKey) {
	if (actual.path.length !== expected.path.length) return false;
	for (let index = 0; index < actual.path.length; index++) {
		const actualPart = actual.path[index];
		const expectedPart = expected.path[index];
		if (actualPart.kind !== expectedPart.kind) return false;
		if (entityIdKey(actualPart.id) !== entityIdKey(expectedPart.id)) return false;
	}
	return true;
}

function datastoreWriteAncestorNamespacesCompatible(
	actual: DatastoreKey,
	expectedFromPayload: DatastoreKey,
	adapterNamespace: string | undefined
) {
	if (expectedFromPayload.namespace === undefined && adapterNamespace === undefined) return true;
	const actualNamespace = actual.namespace ?? adapterNamespace;
	const expectedNamespace = expectedFromPayload.namespace ?? adapterNamespace;
	return actualNamespace === expectedNamespace;
}

function assertDatastoreDirectMetadataKeys(
	meta: Record<string, unknown>,
	context: string,
	allowReadPolicy = false
) {
	for (const key of Object.keys(meta)) {
		if (key === 'datastoreAncestor') continue;
		if (allowReadPolicy && key === 'datastoreRead') continue;
		throw new ActiveTsConfigurationError(`${context} contains unsupported metadata "${key}".`);
	}
}

function datastoreExcludeFromIndexes(model: ResolvedModelMeta): string[] | undefined {
	validateDatastoreUnindexedMetadata(model.name, model.idField, model.indexes, model.datastore);
	const fields = model.datastore?.unindexed;
	if (!fields?.length) return undefined;
	const safeFields: string[] = [];
	for (let index = 0; index < fields.length; index++) {
		safeFields[index] = assertSafeDatastoreField(fields[index], 'Datastore unindexed field');
	}
	return safeFields;
}

export async function createDatastoreStoreAdapter(options: DatastoreStoreOptions = {}): Promise<DatastoreStoreAdapter> {
	options = validateDatastoreOptions(options);
	const keyEncoding = options.keyEncoding ?? 'active-ts';
	options = { ...options, keyEncoding };
	const injectedClient = options.client !== undefined;
	let rawClient = options.client;
	let keySymbol = options.keySymbol;
	if (!rawClient) {
		const mod = await optionalImport('@google-cloud/datastore', 'DatastoreStoreAdapter');
		const Datastore = mod.Datastore;
		rawClient = new Datastore(options.datastoreOptions ?? {});
		keySymbol ??= Datastore.KEY;
	}
	const clientNamespace = normalizeOptionalDatastoreNamespaceOption(
		injectedClient
			? datastoreMember(rawClient, 'namespace', 'Datastore adapter client.namespace')
			: options.datastoreOptions
				? ownFactoryOptionValue(options.datastoreOptions, 'namespace', 'Datastore adapter datastoreOptions')
				: undefined,
		injectedClient ? 'Datastore adapter client namespace' : 'Datastore adapter datastoreOptions namespace'
	);
	if (options.namespace === undefined && clientNamespace !== undefined) {
		options = { ...options, namespace: clientNamespace };
	}
	const clientKeySymbol = datastoreMember(rawClient, 'KEY', 'Datastore adapter client.KEY');
	const client = normalizeDatastoreClient(rawClient);
	const configuredKeySymbol = keySymbol ?? (typeof clientKeySymbol === 'symbol' ? clientKeySymbol : undefined);
	const datastoreKeySymbol = configuredKeySymbol ?? await resolveDatastoreKeySymbol();
	const supportsKeyOnlyProjection = configuredKeySymbol !== undefined;
	const transactionFactory = datastoreOptionalMethod(rawClient, 'transaction', 'Datastore adapter client.transaction');
	const datastoreProjectId = readDatastoreProjectId(rawClient);
	const datastoreDatabaseId = readDatastoreDatabaseId(rawClient);
	if (options.cacheScope === undefined) {
		const projectId = !injectedClient && options.datastoreOptions
			? ownFactoryOptionValue(options.datastoreOptions, 'projectId', 'Datastore adapter datastoreOptions')
			: undefined;
		const databaseId = !injectedClient && options.datastoreOptions
			? ownFactoryOptionValue(options.datastoreOptions, 'databaseId', 'Datastore adapter datastoreOptions')
			: undefined;
		if (projectId !== undefined && (typeof projectId !== 'string' || !projectId || projectId.includes('\0'))) {
			throw new ActiveTsConfigurationError('Datastore adapter projectId must be a non-empty string without null bytes.');
		}
		if (databaseId !== undefined && (typeof databaseId !== 'string' || !databaseId || databaseId.includes('\0'))) {
			throw new ActiveTsConfigurationError('Datastore adapter databaseId must be a non-empty string without null bytes.');
		}
		let clientIdentity: string | undefined;
		if (injectedClient || projectId === undefined) {
			clientIdentity = WEAKMAP_GET.call(DATASTORE_CLIENT_CACHE_SCOPE_IDS, rawClient) as string | undefined;
			if (clientIdentity === undefined) {
				clientIdentity = randomUUID();
				WEAKMAP_SET.call(DATASTORE_CLIENT_CACHE_SCOPE_IDS, rawClient, clientIdentity);
			}
		}
		const projectPart = projectId === undefined ? '-' : `${projectId.length}:${projectId}`;
		const databasePart = databaseId === undefined ? '-' : `${databaseId.length}:${databaseId}`;
		const namespacePart = options.namespace === undefined ? '-' : `${options.namespace.length}:${options.namespace}`;
		const clientPart = clientIdentity === undefined ? '-' : `${clientIdentity.length}:${clientIdentity}`;
		const keyEncodingPart = keyEncoding === 'native' ? '|keyEncoding=6:native' : '';
		options = {
			...options,
			cacheScope: `datastore|project=${projectPart}|database=${databasePart}|namespace=${namespacePart}|client=${clientPart}${keyEncodingPart}`
		};
	}

	return createDatastoreAdapter(
		client,
		client,
		options,
		datastoreProjectId,
		datastoreDatabaseId,
		datastoreKeySymbol,
		supportsKeyOnlyProjection,
		transactionFactory
	) as DatastoreStoreAdapter;
}

export async function createDatastoreNamespaceStoreFactory(
	factoryOptions: DatastoreNamespaceStoreFactoryOptions = {}
): Promise<DatastoreNamespaceStoreFactory> {
	if (!factoryOptions || typeof factoryOptions !== 'object' || Array.isArray(factoryOptions)) {
		throw new ActiveTsConfigurationError('Datastore namespace store factory options must be an object.');
	}
	assertPlainFactoryOptions(factoryOptions, 'Datastore namespace store factory options');
	const record = factoryOptions as Record<string, unknown>;
	assertNoSymbolOptions(record, 'Datastore namespace store factory options');
	assertKnownOptions(record, DATASTORE_NAMESPACE_FACTORY_OPTION_KEYS, 'Datastore namespace store factory options');
	const rawClientOption = ownFactoryOptionValue(record, 'client', 'Datastore namespace store factory option');
	const rawDatastoreOptions = ownFactoryOptionValue(
		record,
		'datastoreOptions',
		'Datastore namespace store factory option'
	);
	if (rawClientOption !== undefined && rawDatastoreOptions !== undefined) {
		throw new ActiveTsConfigurationError(
			'Datastore namespace store factory options cannot combine client with datastoreOptions.'
		);
	}
	const cacheScopePrefix = ownFactoryOptionValue(
		record,
		'cacheScopePrefix',
		'Datastore namespace store factory option'
	);
	if (
		cacheScopePrefix !== undefined &&
		(typeof cacheScopePrefix !== 'string' || !cacheScopePrefix || cacheScopePrefix.includes('\0'))
	) {
		throw new ActiveTsConfigurationError(
			'Datastore namespace store factory cacheScopePrefix must be a non-empty string without null bytes.'
		);
	}
	const options = validateDatastoreOptions({
		client: rawClientOption,
		datastoreOptions: rawDatastoreOptions as Record<string, any> | undefined,
		keyEncoding: ownFactoryOptionValue(record, 'keyEncoding', 'Datastore namespace store factory option') as
			| DatastoreKeyEncoding
			| undefined,
		keySymbol: ownFactoryOptionValue(record, 'keySymbol', 'Datastore namespace store factory option') as symbol | undefined,
		allowAggregateScanFallback: ownFactoryOptionValue(
			record,
			'allowAggregateScanFallback',
			'Datastore namespace store factory option'
		) as boolean | undefined,
		allowQueryScanFallback: ownFactoryOptionValue(
			record,
			'allowQueryScanFallback',
			'Datastore namespace store factory option'
		) as boolean | undefined,
		requireAncestorTransactionQueries: ownFactoryOptionValue(
			record,
			'requireAncestorTransactionQueries',
			'Datastore namespace store factory option'
		) as boolean | undefined
	});
	if (
		options.datastoreOptions !== undefined &&
		Object.prototype.hasOwnProperty.call(options.datastoreOptions, 'namespace') &&
		ownFactoryOptionValue(
			options.datastoreOptions,
			'namespace',
			'Datastore namespace store factory datastoreOptions'
		) !== undefined
	) {
		throw new ActiveTsConfigurationError(
			'Datastore namespace store factory datastoreOptions cannot set namespace; use forNamespace() instead.'
		);
	}
	let rawClient = options.client;
	let keySymbol = options.keySymbol;
	if (rawClient === undefined) {
		const mod = await optionalImport('@google-cloud/datastore', 'DatastoreNamespaceStoreFactory');
		const Datastore = mod.Datastore;
		rawClient = new Datastore(options.datastoreOptions ?? {});
		keySymbol ??= Datastore.KEY;
	}
	const clientNamespace = datastoreMember(
		rawClient,
		'namespace',
		'Datastore namespace store factory client.namespace'
	);
	if (clientNamespace !== undefined) {
		if (typeof clientNamespace !== 'string' || !clientNamespace || clientNamespace.includes('\0')) {
			throw new ActiveTsConfigurationError(
				'Datastore namespace store factory client.namespace must be a non-empty string without null bytes, or undefined for the default namespace.'
			);
		}
		throw new ActiveTsConfigurationError(
			'Datastore namespace store factory requires a namespace-neutral client; use forNamespace() instead of a client namespace.'
		);
	}
	const baseOptions: DatastoreStoreOptions = {
		client: rawClient,
		keyEncoding: options.keyEncoding ?? 'active-ts',
		keySymbol,
		allowAggregateScanFallback: options.allowAggregateScanFallback,
		allowQueryScanFallback: options.allowQueryScanFallback,
		requireAncestorTransactionQueries: options.requireAncestorTransactionQueries
	};
	const factory: DatastoreNamespaceStoreFactory = {
		forNamespace: async (namespace?: string) => {
			if (namespace !== undefined && (typeof namespace !== 'string' || !namespace || namespace.includes('\0'))) {
				throw new ActiveTsConfigurationError(
					'Datastore namespace store factory namespace must be a non-empty string without null bytes, or undefined for the default namespace.'
				);
			}
			const keyEncoding = baseOptions.keyEncoding ?? 'active-ts';
			const cacheScope = cacheScopePrefix === undefined
				? undefined
				: `datastore|scope=${cacheScopePrefix.length}:${cacheScopePrefix}|keyEncoding=${
						keyEncoding.length
					}:${keyEncoding}|namespace=${
						namespace === undefined ? '-' : `${namespace.length}:${namespace}`
					}`;
			return createDatastoreStoreAdapter({ ...baseOptions, namespace, cacheScope });
		}
	};
	return Object.freeze(factory);
}

function createDatastoreAdapter(
	client: NormalizedDatastoreClient,
	rootClient: NormalizedDatastoreClient,
	options: DatastoreStoreOptions,
	datastoreProjectId: string | undefined,
	datastoreDatabaseId: string | null | undefined,
	datastoreKeySymbol: symbol,
	supportsKeyOnlyProjection: boolean,
	transactionFactory?: DatastoreTransactionFactory,
	scopedTransaction = false,
	deferScopedQueryPayloadValidation = false
): StoreAdapter {
	const kindName = datastoreKindName;
	const keyEncoding = options.keyEncoding ?? 'active-ts';
	const namespacedKey = (path: Array<string | number>, namespace: string | undefined) => {
		if (namespace !== undefined && options.namespace !== undefined && namespace !== options.namespace) {
			throw new ActiveTsConfigurationError('Datastore key namespace must match adapter namespace.');
		}
		return rootClient.key({ path, namespace: namespace ?? options.namespace });
	};
	const assertAncestorNamespace = (ancestor: DatastoreKey | undefined) => {
		if (ancestor?.namespace !== undefined && options.namespace !== undefined && ancestor.namespace !== options.namespace) {
			throw new ActiveTsConfigurationError('Datastore key namespace must match adapter namespace.');
		}
	};
	const entityKeyPath = (model: ResolvedModelMeta, id: EntityId, ancestor: DatastoreKey | undefined) => {
		const path = ancestor ? datastoreKeyPathValues(ancestor, keyEncoding) : [];
		path[path.length] = kindName(model);
		path[path.length] = keyEncoding === 'native'
			? assertNativeDatastoreEntityId(id, `${model.name} store id`)
			: entityIdKey(id);
		return path;
	};
	const makeEntityKeyFromAncestor = (
		model: ResolvedModelMeta,
		id: EntityId,
		ancestor: DatastoreKey | undefined
	) => {
		assertSafeEntityId(id, `${model.name} store id`);
		return namespacedKey(entityKeyPath(model, id, ancestor), ancestor?.namespace);
	};
	const logicalEntityKeyFromAncestor = (
		model: ResolvedModelMeta,
		id: EntityId,
		ancestor: DatastoreKey | undefined,
		context: string
	) => {
		assertSafeEntityId(id, `${model.name} store id`);
		assertAncestorNamespace(ancestor);
		const path: DatastoreKey['path'] = [];
		if (ancestor) {
			for (let index = 0; index < ancestor.path.length; index++) path[index] = ancestor.path[index];
		}
		path[path.length] = { kind: kindName(model), id };
		return normalizeDatastoreKey({ path, namespace: ancestor?.namespace ?? options.namespace }, context);
	};
	const makeEntityKey = (
		model: ResolvedModelMeta,
		id: EntityId,
		data?: any,
		ancestorOverride?: DatastoreAncestorOverride
	) => {
		const ancestor = datastoreAncestorForWrite(model, id, data, ancestorOverride);
		return makeEntityKeyFromAncestor(model, id, ancestor);
	};
	const entityPayloadFromAncestor = (
		model: ResolvedModelMeta,
		id: EntityId,
		data: any,
		ancestor: DatastoreKey | undefined
	) => {
		const excludeFromIndexes = datastoreExcludeFromIndexes(model);
		const entity: { key: unknown; data: any; excludeFromIndexes?: string[] } = {
			key: makeEntityKeyFromAncestor(model, id, ancestor),
			data
		};
		if (excludeFromIndexes) entity.excludeFromIndexes = excludeFromIndexes;
		return entity;
	};
	const entityPayload = (
		model: ResolvedModelMeta,
		id: EntityId,
		data: any,
		ancestorOverride?: DatastoreAncestorOverride
	) => entityPayloadFromAncestor(model, id, data, datastoreAncestorForWrite(model, id, data, ancestorOverride));
	const allowAggregateScanFallback = options.allowAggregateScanFallback === true;
	const allowQueryScanFallback = options.allowQueryScanFallback === true;
	const requireAncestorTransactionQueries = options.requireAncestorTransactionQueries === true;
	const supportsAggregate =
		allowAggregateScanFallback || (client.createAggregationQuery !== undefined && client.runAggregationQuery !== undefined);
	const pickDatastoreResultFields = (row: any, fields: string[] | undefined, idField: string, context: string) => {
		if (!fields?.length) return row;
		const picked = pickFields(row, fields, idField);
		const descriptor = Object.getOwnPropertyDescriptor(row, ACTIVE_TS_ENTITY_KEY);
		if (descriptor !== undefined) {
			if (!('value' in descriptor)) {
				throw new ActiveTsValidationError(`${context} active-ts entity key must be a data property.`);
			}
			if (descriptor.enumerable) {
				throw new ActiveTsValidationError(`${context} active-ts entity key must be non-enumerable.`);
			}
			attachEntityKey(picked, descriptor.value);
		}
		return picked;
	};
	const offsetDatastoreRows = (rows: any[], offset: number | undefined) => {
		if (offset === undefined) return rows;
		const safeOffset = assertSafeOffset(offset, 'Datastore offset') as number;
		const result: any[] = [];
		for (let index = safeOffset; index < rows.length; index++) result[result.length] = rows[index];
		return result;
	};
	const scanDatastoreRows = async (
		model: ResolvedModelMeta,
		ancestor: DatastoreKey | undefined,
		kind: string,
		queryNamespace: string | undefined,
		context: string,
		readOptions?: DatastoreSdkReadOptions
	) => {
		assertAncestorNamespace(ancestor);
		let scanQuery = normalizeDatastoreQuery(
			queryNamespace
				? datastoreMethod(rootClient, 'createQuery', 'Datastore client.createQuery')(queryNamespace, kind)
				: datastoreMethod(rootClient, 'createQuery', 'Datastore client.createQuery')(kind),
			context
		);
		if (ancestor) {
			scanQuery = normalizeDatastoreQuery(
				datastoreMethod(scanQuery, 'hasAncestor', 'Datastore query.hasAncestor')(
					namespacedKey(datastoreKeyPathValues(ancestor, keyEncoding), ancestor.namespace)
				),
				context
			);
		}
		scanQuery = normalizeDatastoreQuery(
			datastoreMethod(scanQuery, 'limit', 'Datastore query.limit')(DATASTORE_SCAN_FALLBACK_PAGE_SIZE),
			context
		);
		const scannedRows: any[] = [];
		const seenCursors = new Set<string>();
		let incomplete = false;
		const expectedAncestor = ancestor === undefined
			? undefined
			: datastoreKeyWithNamespace(ancestor, adapterNamespace, `${context} meta.datastoreAncestor`);
		while (true) {
			const scanResult = datastoreResultTuple(
				await runDatastoreRead(
					datastoreMethod(client, 'runQuery', 'Datastore client.runQuery'),
					scanQuery,
					readOptions
				),
				context
			);
			const scanList = datastoreRequiredResultSlot(scanResult, context, 0);
			const scanEntities = datastoreQueryEntities(scanList);
			const info = scanResult[1];
			const hasMore = datastoreQueryHasMore(info);
			let endCursor = '';
			if (hasMore) {
				if (!info || typeof info !== 'object' || Array.isArray(info)) {
					throw new ActiveTsValidationError('Datastore query info must be an object.');
				}
				const rawEndCursor = ownOptionValue(info as Record<string, unknown>, 'endCursor');
				if (typeof rawEndCursor !== 'string' || !rawEndCursor) {
					throw new ActiveTsValidationError(
						'Datastore query info.endCursor must be a non-empty string when more results are available.'
					);
				}
				if (SET_HAS.call(seenCursors, rawEndCursor)) {
					// The emulator can repeat a cursor while still reporting more results.
					if (scanEntities.length === 0) break;
					incomplete = true;
					break;
				}
				endCursor = rawEndCursor;
			}
			for (let entityIndex = 0; entityIndex < scanEntities.length; entityIndex++) {
				scannedRows[scannedRows.length] = normalizeDatastoreEntityForResult(
					scanEntities[entityIndex],
					model,
					datastoreKeySymbol,
					`${context} entity[${entityIndex}]`,
					expectedAncestor,
					true,
					adapterNamespace,
					true,
					keyEncoding
				).data;
			}
			if (!hasMore) break;
			SET_ADD.call(seenCursors, endCursor);
			scanQuery = normalizeDatastoreQuery(
				datastoreMethod(scanQuery, 'start', 'Datastore query.start')(endCursor),
				context
			);
		}
		return { rows: scannedRows, incomplete };
	};

	const adapterNamespace = options.namespace;
	const adapter: StoreAdapter = {
		kind: 'datastore',
		cacheScope: options.cacheScope,
		datastoreNamespace: adapterNamespace,
		datastoreProjectId,
		datastoreDatabaseId,
		datastoreKeyEncoding: keyEncoding,
		capabilities: {
			or: false,
			contains: false,
			arrayContains: false,
			textContains: false,
			jsonContains: false,
			startsWith: false,
			cursor: !scopedTransaction,
			offset: true,
			select: true,
			nestedFields: true,
			numericComparisons: true,
			aggregate: supportsAggregate,
			transaction: transactionFactory !== undefined,
			transactionConflictDetection: transactionFactory !== undefined,
			savepoint: false,
			uniqueIndex: false,
			optimisticLock: false,
			nullOperators: true,
			missingFieldNulls: false,
			native: true,
			datastoreAncestor: true,
			datastoreReadPolicy: !scopedTransaction
		},
		transaction: transactionFactory
			? async (fn, transactionOptions?: StoreTransactionOptions) => {
					if (typeof fn !== 'function') {
						throw new ActiveTsConfigurationError('Datastore transaction callback must be a function.');
					}
					const txOptions = normalizeStoreTransactionOptions(transactionOptions, 'Datastore transaction options');
					if (txOptions.isolation !== undefined) {
						throw new ActiveTsConfigurationError('Datastore transaction options.isolation is not supported.');
					}
					if (txOptions.timeoutMs !== undefined) {
						throw new ActiveTsConfigurationError('Datastore transaction options.timeoutMs is not supported.');
					}
					let nativeGaxOptions: Record<string, unknown> | undefined;
					let nativeCommitGaxOptions: Record<string, unknown> | undefined;
					let nativeRollbackGaxOptions: Record<string, unknown> | undefined;
					if (txOptions.native !== undefined) {
						if (!txOptions.native || typeof txOptions.native !== 'object' || Array.isArray(txOptions.native)) {
							throw new ActiveTsConfigurationError('Datastore transaction options.native must be a plain object.');
						}
						assertPlainFactoryOptions(txOptions.native, 'Datastore transaction options.native');
						const nativeRecord = txOptions.native as Record<string, unknown>;
						assertNoSymbolOptions(nativeRecord, 'Datastore transaction options.native');
						assertKnownOptions(
							nativeRecord,
							DATASTORE_TRANSACTION_NATIVE_OPTION_KEYS,
							'Datastore transaction options.native'
						);
						const gaxOptions = ownFactoryOptionValue(nativeRecord, 'gaxOptions', 'Datastore transaction native option');
						const commitGaxOptions = ownFactoryOptionValue(
							nativeRecord,
							'commitGaxOptions',
							'Datastore transaction native option'
						);
						const rollbackGaxOptions = ownFactoryOptionValue(
							nativeRecord,
							'rollbackGaxOptions',
							'Datastore transaction native option'
						);
						nativeGaxOptions = gaxOptions === undefined
							? undefined
							: snapshotSdkOptions(gaxOptions, 'Datastore transaction options.native.gaxOptions');
						nativeCommitGaxOptions = commitGaxOptions === undefined
							? undefined
							: snapshotSdkOptions(commitGaxOptions, 'Datastore transaction options.native.commitGaxOptions');
						nativeRollbackGaxOptions = rollbackGaxOptions === undefined
							? undefined
							: snapshotSdkOptions(rollbackGaxOptions, 'Datastore transaction options.native.rollbackGaxOptions');
					}
					const readOnlyOptions = txOptions.readOnly === true ? { readOnly: true } : undefined;
					let runOptions: { readOnly?: boolean; gaxOptions?: Record<string, unknown> } | undefined;
					if (readOnlyOptions !== undefined || nativeGaxOptions !== undefined) {
						runOptions = {};
						if (readOnlyOptions !== undefined) runOptions.readOnly = true;
						if (nativeGaxOptions !== undefined) runOptions.gaxOptions = nativeGaxOptions;
					}
					const rawTransaction = transactionFactory(readOnlyOptions);
					const transaction = normalizeDatastoreTransaction(rawTransaction, rootClient);
					let started = false;
					let committing = false;
					let result: Awaited<ReturnType<typeof fn>>;
					try {
						await transaction.run(runOptions);
						started = true;
						let closed: string | undefined;
						const txStore = createDatastoreAdapter(
							transaction.client,
							rootClient,
							options,
							datastoreProjectId,
							datastoreDatabaseId,
							datastoreKeySymbol,
							supportsKeyOnlyProjection,
							undefined,
							true
						);
						const txNativeReadClient = createDatastoreTransactionNativeReadClient(transaction.client);
						const txNativeReadStore = createDatastoreAdapter(
							txNativeReadClient,
							rootClient,
							options,
							datastoreProjectId,
							datastoreDatabaseId,
							datastoreKeySymbol,
							supportsKeyOnlyProjection,
							undefined,
							true
						);
						const txOverlayReadStore = createDatastoreAdapter(
							transaction.client,
							rootClient,
							options,
							datastoreProjectId,
							datastoreDatabaseId,
							datastoreKeySymbol,
							supportsKeyOnlyProjection,
							undefined,
							true,
							true
						);
						const bufferedMutations = new Map<string, DatastoreTransactionMutation>();
						const bufferedMutationTails = new Map<string, Promise<void>>();
						const serializeBufferedMutation = async (
							key: string,
							operation: () => Promise<void>
						): Promise<void> => {
							const previous = MAP_GET.call(bufferedMutationTails, key) as Promise<void> | undefined;
							let release!: () => void;
							const tail = new Promise<void>((resolve) => {
								release = resolve;
							});
							MAP_SET.call(bufferedMutationTails, key, tail);
							if (previous !== undefined) await previous;
							try {
								await operation();
							} finally {
								release();
								if (MAP_GET.call(bufferedMutationTails, key) === tail) {
									MAP_DELETE.call(bufferedMutationTails, key);
								}
							}
						};
						const waitForBufferedMutations = async (keys?: readonly string[]): Promise<void> => {
							const pending: Promise<void>[] = [];
							if (keys === undefined) {
								for (const tail of MAP_VALUES.call(bufferedMutationTails) as Iterable<Promise<void>>) {
									pending[pending.length] = tail;
								}
							} else {
								for (let index = 0; index < keys.length; index++) {
									const tail = MAP_GET.call(bufferedMutationTails, keys[index]) as Promise<void> | undefined;
									if (tail !== undefined) pending[pending.length] = tail;
								}
							}
							for (let index = 0; index < pending.length; index++) await pending[index];
						};
						const rejectDirtyNativeRead = () => {
							if (bufferedMutations.size === 0) return;
							throw new ActiveTsConfigurationError(
								'Datastore transaction native store reads cannot run after buffered writes.'
							);
						};
						const transactionMutationKey = (
							model: ResolvedModelMeta,
							id: EntityId,
							data: any,
							ancestorOverride: DatastoreAncestorOverride
						) => {
							assertSafeEntityId(id, `${model.name} store id`);
							const ancestor = datastoreAncestorForWrite(model, id, data, ancestorOverride);
							if (ancestor?.namespace !== undefined && options.namespace !== undefined && ancestor.namespace !== options.namespace) {
								throw new ActiveTsConfigurationError('Datastore key namespace must match adapter namespace.');
							}
							const path: DatastoreKey['path'] = [];
							if (ancestor) {
								for (let index = 0; index < ancestor.path.length; index++) path[index] = ancestor.path[index];
							}
							path[path.length] = { kind: kindName(model), id };
							return datastoreKeyIdentity({ path, namespace: ancestor?.namespace ?? options.namespace });
						};
						const transactionEntityExists = async (
							model: ResolvedModelMeta,
							id: EntityId,
							data: any,
							ancestorOverride: DatastoreAncestorOverride,
							context: string
						) => {
							const resolvedAncestor = datastoreAncestorForWrite(model, id, data, ancestorOverride);
							const expectedAncestor = resolvedAncestor === undefined
								? undefined
								: datastoreKeyWithNamespace(
										resolvedAncestor,
										adapterNamespace,
										'Datastore transaction existence read ancestor'
									);
							const entityKeyAncestorOverride =
								resolvedAncestor === undefined && !ancestorOverride.provided
									? ancestorOverride
									: { provided: true, ancestor: resolvedAncestor };
							const entity = datastoreRequiredResultSlot(
								await transaction.client.get(makeEntityKey(model, id, data, entityKeyAncestorOverride)),
								context,
								0
							);
							return normalizeDatastoreEntityForExpectedId(
								entity,
								model,
								id,
								datastoreKeySymbol,
								context,
								expectedAncestor,
								adapterNamespace,
								data !== undefined,
								keyEncoding
							) !== null;
						};
						const transactionBufferedRow = (
							mutation: DatastoreTransactionMutation | undefined,
							context: string
						) => {
							if (!mutation) return undefined;
							if (mutation.operation === 'delete') return null;
							return transactionMutationReadRow(mutation, context);
						};
						const transactionMutationReadRow = (
							mutation: Exclude<DatastoreTransactionMutation, { operation: 'delete' }>,
							context: string
						) => {
							const row = cloneSafeDataObjectWithoutActiveEntityKey(mutation.data, context);
							if (mutation.model.datastore?.ancestor !== undefined) {
								const ancestor = datastoreAncestorForWrite(
									mutation.model,
									mutation.id,
									mutation.data,
									datastoreAncestorFromWriteOptions(mutation.options)
								);
								attachEntityKey(
									row,
									keyEncoding === 'native'
										? logicalEntityKeyFromAncestor(
												mutation.model,
												mutation.id,
												ancestor,
												`${context} active-ts entity key`
											)
										: makeEntityKeyFromAncestor(mutation.model, mutation.id, ancestor)
								);
							}
							return row;
						};
						const transactionRowEntityIdentity = (
							model: ResolvedModelMeta,
							id: EntityId,
							data: any | undefined,
							ancestorOverride: DatastoreAncestorOverride | undefined,
							scopedAncestor: DatastoreKey | undefined,
							allowFieldCodecResolverFallback: boolean,
							context: string,
							validatePayloadScope = true,
							validateEntityKeyPayload = true
						) => {
							let ancestor: DatastoreKey | undefined;
							let resolvedPhysicalAncestor = false;
							if (ancestorOverride?.provided) {
								ancestor = datastoreAncestorForWrite(model, id, data, ancestorOverride);
								resolvedPhysicalAncestor = true;
							}
							if (data && typeof data === 'object') {
								const descriptor = Object.getOwnPropertyDescriptor(data, ACTIVE_TS_ENTITY_KEY);
								if (!resolvedPhysicalAncestor && descriptor) {
									if (!('value' in descriptor)) {
										throw new ActiveTsValidationError(`${context} active-ts entity key must be a data property.`);
									}
									if (descriptor.enumerable) {
										throw new ActiveTsValidationError(`${context} active-ts entity key must be non-enumerable.`);
									}
									ancestor = datastoreAncestorFromEntityKey(
										descriptor.value,
										kindName(model),
										id,
										`${context} active-ts entity key`
									);
									if (
										model.datastore?.ancestor !== undefined &&
										validateEntityKeyPayload &&
										(
											allowFieldCodecResolverFallback ||
											model.fieldCodecs.size === 0 ||
											datastorePayloadCanResolveAncestor(model, id, data, context)
										)
									) {
										if (validatePayloadScope && scopedAncestor !== undefined) {
											assertDatastorePayloadWithinScopedAncestor(
												model,
												id,
												cloneSafeDataObjectWithoutActiveEntityKey(data, `${context} payload data`),
												scopedAncestor,
												context,
												options.namespace
											);
										}
										const entityKeyIdentity = ancestor === undefined
											? 'undefined'
											: datastoreKeyIdentity(
												datastoreKeyWithNamespace(
													ancestor,
													options.namespace,
													`${context} active-ts entity key`
												)
											);
										let payloadIdentity = 'undefined';
										let matchedPayloadAncestor = false;
										const payloadAncestors = allowFieldCodecResolverFallback
											? [datastoreAncestorForWrite(model, id, data)]
											: datastoreWritePayloadAncestorCandidates(model, id, data);
										for (let candidateIndex = 0; candidateIndex < payloadAncestors.length; candidateIndex++) {
											const payloadAncestor = payloadAncestors[candidateIndex];
											payloadIdentity = payloadAncestor === undefined
												? 'undefined'
												: datastoreKeyIdentity(
													datastoreKeyWithNamespace(
														payloadAncestor,
														options.namespace,
														`${context} payload Datastore ancestor`
													)
												);
											if (payloadIdentity === entityKeyIdentity) {
												matchedPayloadAncestor = true;
												break;
											}
										}
										if (!matchedPayloadAncestor) {
											throw new ActiveTsValidationError(
												`${context} payload Datastore ancestor does not match active-ts entity key (${payloadIdentity} !== ${entityKeyIdentity}).`
											);
										}
									}
									resolvedPhysicalAncestor = true;
								}
							}
							if (!resolvedPhysicalAncestor && model.datastore?.ancestor !== undefined) {
								if (
									!allowFieldCodecResolverFallback &&
									model.fieldCodecs.size > 0 &&
									!datastorePayloadHasAncestorFields(model, data)
								) {
									throw new ActiveTsValidationError(
										`Datastore transaction query row for model "${model.name}" requires Datastore entity key metadata because the model combines an ancestor resolver with field codecs.`
									);
								}
								const resolvedAncestor = allowFieldCodecResolverFallback
									? datastoreAncestorForWrite(model, id, data)
									: datastoreAncestorForReadPayload(model, id, data);
								if (
									!allowFieldCodecResolverFallback &&
									resolvedAncestor === undefined &&
									model.datastore.ancestorFields !== undefined &&
									!datastorePayloadHasAncestorFields(model, data)
								) {
									let missing: string | undefined;
									const ancestorFields = model.datastore.ancestorFields;
									for (let index = 0; index < ancestorFields.length; index++) {
										const field = ancestorFields[index];
										if (data && typeof data === 'object' && valueFor(data, field) !== undefined) continue;
										missing = field;
										break;
									}
									throw new ActiveTsValidationError(
										missing === undefined
											? `${context} is missing Datastore ancestor metadata.`
											: `${context} is missing Datastore ancestor metadata field "${missing}".`
									);
								}
								if (
									!allowFieldCodecResolverFallback &&
									scopedAncestor === undefined &&
									resolvedAncestor === undefined
								) {
									throw new ActiveTsValidationError(`${context} is missing Datastore ancestor metadata.`);
								}
								const resolvedAncestorMatchesScope =
									scopedAncestor === undefined ||
									datastoreTransactionOverlayAncestorMatches(resolvedAncestor, scopedAncestor, options.namespace);
								if (
									resolvedAncestor !== undefined &&
									scopedAncestor !== undefined &&
									validatePayloadScope &&
									!resolvedAncestorMatchesScope &&
									(
										datastoreTransactionOverlayAncestorsShareShape(resolvedAncestor, scopedAncestor) ||
										datastorePayloadCanResolveAncestor(model, id, data, context)
									)
								) {
									const actual = datastoreKeyWithNamespace(
										resolvedAncestor,
										options.namespace,
										`${context} payload Datastore ancestor`
									);
									const expected = datastoreKeyWithNamespace(
										scopedAncestor,
										options.namespace,
										`${context} scoped Datastore ancestor`
									);
									throw new ActiveTsValidationError(
										`${context} payload Datastore ancestor resolved outside the scoped Datastore ancestor (${datastoreKeyIdentity(actual)} !== ${datastoreKeyIdentity(expected)}).`
									);
								}
								ancestor = resolvedAncestorMatchesScope ? resolvedAncestor ?? scopedAncestor : scopedAncestor;
								resolvedPhysicalAncestor = resolvedAncestor !== undefined && resolvedAncestorMatchesScope;
							}
							if (!resolvedPhysicalAncestor) ancestor = scopedAncestor;
							const path: DatastoreKey['path'] = [];
							if (ancestor) {
								for (let index = 0; index < ancestor.path.length; index++) path[index] = ancestor.path[index];
							}
							path[path.length] = { kind: kindName(model), id };
							return datastoreKeyIdentity({ path, namespace: ancestor?.namespace ?? options.namespace });
						};
						const txBufferedStore: StoreAdapter = {
							kind: txStore.kind,
							cacheScope: txStore.cacheScope ?? adapter.cacheScope,
							datastoreNamespace: txStore.datastoreNamespace ?? adapter.datastoreNamespace,
							datastoreProjectId: txStore.datastoreProjectId ?? adapter.datastoreProjectId,
							datastoreDatabaseId: txStore.datastoreDatabaseId === undefined
								? adapter.datastoreDatabaseId
								: txStore.datastoreDatabaseId,
							datastoreKeyEncoding: txStore.datastoreKeyEncoding ?? adapter.datastoreKeyEncoding,
							capabilities: { ...txStore.capabilities, transaction: false },
							get: async (model, id, readOptions) => {
								model = snapshotAdapterModel(model, 'Datastore model metadata');
								const safeReadOptions = normalizeDatastoreReadOptions(readOptions, 'Datastore store read options');
								const ancestorOverride = datastoreAncestorFromReadOptions(safeReadOptions);
								rejectDatastoreTransactionReadPolicy(safeReadOptions, 'Datastore transaction read options');
								assertDatastoreDirectIdReadAllowed(model, ancestorOverride);
								const key = transactionMutationKey(model, id, undefined, ancestorOverride);
								await waitForBufferedMutations([key]);
								const buffered = transactionBufferedRow(
									MAP_GET.call(bufferedMutations, key) as DatastoreTransactionMutation | undefined,
									`${model.name} datastore transaction row`
								);
								return buffered === undefined ? txStore.get(model, id, safeReadOptions) : buffered;
							},
							getMany: async (model, ids, readOptions) => {
								model = snapshotAdapterModel(model, 'Datastore model metadata');
								const safeReadOptions = normalizeDatastoreReadOptions(readOptions, 'Datastore store read options');
								const ancestorOverride = datastoreAncestorFromReadOptions(safeReadOptions);
								rejectDatastoreTransactionReadPolicy(safeReadOptions, 'Datastore transaction read options');
								assertDatastoreDirectIdReadAllowed(model, ancestorOverride);
								ids = assertSafeEntityIdArray(ids, 'Datastore store ids');
								const keys: string[] = [];
								for (let index = 0; index < ids.length; index++) {
									keys[index] = transactionMutationKey(model, ids[index], undefined, ancestorOverride);
								}
								await waitForBufferedMutations(keys);
								const rows = new Array(ids.length) as Array<Record<string, unknown> | null>;
								const backendIds: EntityId[] = [];
								const backendIndexes: number[] = [];
								for (let index = 0; index < ids.length; index++) {
									const buffered = transactionBufferedRow(
										MAP_GET.call(bufferedMutations, keys[index]) as DatastoreTransactionMutation | undefined,
										`${model.name} datastore transaction row`
									);
									if (buffered !== undefined) {
										rows[index] = buffered;
									} else {
										backendIds[backendIds.length] = ids[index];
										backendIndexes[backendIndexes.length] = index;
									}
								}
								if (backendIds.length) {
									const backendRows = await txStore.getMany(model, backendIds, safeReadOptions);
									for (let index = 0; index < backendRows.length; index++) {
										rows[backendIndexes[index]] = backendRows[index];
									}
								}
								return rows;
							},
							query: async (model, plan, readOptions) => {
								model = snapshotAdapterModel(model, 'Datastore model metadata');
								const safePlan = normalizeStoreQueryPlan(plan, model.idField, 'Datastore transaction query plan', {
									limit: 'Datastore limit',
									offset: 'Datastore offset',
									whereField: 'Datastore query field',
									selectField: 'Datastore select field',
									sortField: 'Datastore sort field'
								});
								const typedPlan = normalizeQueryPlanFieldTypes(model, safePlan);
								const encodedPlan = encodeQueryPlanFieldCodecs(model, typedPlan);
								assertStorePlanSupported(txStore.kind, txStore.capabilities, encodedPlan);
								const safeReadOptions = validateStoreQueryReadOptions(
									readOptions,
									encodedPlan,
									'Datastore transaction query read options'
								);
								await waitForBufferedMutations();
								if (encodedPlan.native !== undefined) {
									if (requireAncestorTransactionQueries) {
										requireDatastoreTransactionAncestor(encodedPlan, 'Datastore transaction query');
									}
									rejectDirtyNativeRead();
									return txNativeReadStore.query(model, typedPlan, safeReadOptions);
								}
								assertDatastoreQueryLimits(encodedPlan);
								let needsScanFallback = false;
								for (let whereIndex = 0; whereIndex < encodedPlan.where.length; whereIndex++) {
									const op = encodedPlan.where[whereIndex].op;
									if (op === '!=' || op === 'in' || op === 'isNotNull') {
										needsScanFallback = true;
										break;
									}
								}
								if (!allowQueryScanFallback || !needsScanFallback) {
									assertGoogleInequalitySortOrder('Datastore', encodedPlan, 'order');
									assertGoogleSortableFieldsDeclared('Datastore', model, encodedPlan, 'order');
								}
								const planAncestor = requireAncestorTransactionQueries
									? requireDatastoreTransactionAncestor(typedPlan, 'Datastore transaction query')
									: datastoreAncestorFromPlan(typedPlan);
								const scanPlan = copyFieldCodecQueryOperandMarker(typedPlan, {
									...typedPlan,
									limit: undefined,
									offset: undefined,
									cursor: undefined,
									select: undefined
								});
								const base = await txOverlayReadStore.query(model, scanPlan);
								const rowsByIdentity = new Map<string, any>();
								const deletedIdentities = new Set<string>();
								for (const mutation of MAP_VALUES.call(bufferedMutations) as Iterable<DatastoreTransactionMutation>) {
									if (mutation.model.name !== model.name || mutation.operation !== 'delete') continue;
									const ancestorOverride = datastoreAncestorFromWriteOptions(mutation.options);
									const mutationAncestor = datastoreAncestorForWrite(
										mutation.model,
										mutation.id,
										undefined,
										ancestorOverride
									);
									if (planAncestor !== undefined) {
										if (!datastoreTransactionOverlayAncestorMatches(mutationAncestor, planAncestor, options.namespace)) {
											continue;
										}
									} else if (mutationAncestor !== undefined && mutation.model.datastore?.ancestor === undefined) {
										continue;
									}
									SET_ADD.call(deletedIdentities, transactionRowEntityIdentity(
										mutation.model,
										mutation.id,
										undefined,
										ancestorOverride,
										planAncestor,
										true,
										`${mutation.model.name} datastore transaction delete row`,
										false
									));
								}
								for (let index = 0; index < base.list.length; index++) {
									const row = cloneSafeDataObject(base.list[index], `${model.name} datastore transaction query row`);
									const id = valueFor(row, model.idField);
									if (id === undefined || id === null) {
										throw new ActiveTsValidationError(`Datastore transaction query row is missing id field "${model.idField}".`);
									}
									assertSafeEntityId(id, `Datastore transaction query row.${model.idField}`);
									if (deletedIdentities.size) {
										const deleteIdentity = transactionRowEntityIdentity(
											model,
											id,
											row,
											undefined,
											planAncestor,
											false,
											`${model.name} datastore transaction query row`,
											false,
											false
										);
										if (SET_HAS.call(deletedIdentities, deleteIdentity)) continue;
									}
									const identity = transactionRowEntityIdentity(
										model,
										id,
										row,
										undefined,
										planAncestor,
										false,
										`${model.name} datastore transaction query row`
									);
									if (MAP_HAS.call(rowsByIdentity, identity)) {
										throw new ActiveTsValidationError(
											`Datastore transaction query row contains duplicate Datastore identity "${String(id)}".`
										);
									}
									MAP_SET.call(rowsByIdentity, identity, row);
								}
								for (const mutation of MAP_VALUES.call(bufferedMutations) as Iterable<DatastoreTransactionMutation>) {
									if (mutation.model.name !== model.name) continue;
									const mutationData = mutation.operation === 'delete' ? undefined : mutation.data;
									const ancestorOverride = datastoreAncestorFromWriteOptions(mutation.options);
									const mutationAncestor = datastoreAncestorForWrite(
										mutation.model,
										mutation.id,
										mutationData,
										ancestorOverride
									);
									if (planAncestor !== undefined) {
										if (!datastoreTransactionOverlayAncestorMatches(mutationAncestor, planAncestor, options.namespace)) {
											continue;
										}
									} else if (mutationAncestor !== undefined && mutation.model.datastore?.ancestor === undefined) {
										continue;
									}
									const key = transactionRowEntityIdentity(
										mutation.model,
										mutation.id,
										mutationData,
										ancestorOverride,
										planAncestor,
										true,
										`${mutation.model.name} datastore transaction mutation row`
									);
									if (mutation.operation === 'delete') {
										MAP_DELETE.call(rowsByIdentity, key);
									} else {
										const mutationRowContext = `${model.name} datastore transaction mutation row`;
										MAP_SET.call(
											rowsByIdentity,
											key,
											transactionMutationReadRow(mutation, mutationRowContext)
										);
									}
								}
								let filteredRows = filterRows(
									iterableToArray(MAP_VALUES.call(rowsByIdentity) as Iterable<any>),
									stripFieldCodecQueryOperandMarker(encodedPlan),
									model.idField
								);
								const sort = sortWithStableId(encodedPlan, model.idField);
								const sortedRows: any[] = [];
								for (let rowIndex = 0; rowIndex < filteredRows.length; rowIndex++) {
									const row = filteredRows[rowIndex];
									let insertAt = sortedRows.length;
									for (let sortedIndex = 0; sortedIndex < sortedRows.length; sortedIndex++) {
										if (compareRowsBySort(row, sortedRows[sortedIndex], sort) < 0) {
											insertAt = sortedIndex;
											break;
										}
									}
									for (let shift = sortedRows.length; shift > insertAt; shift--) {
										sortedRows[shift] = sortedRows[shift - 1];
									}
									sortedRows[insertAt] = row;
								}
								filteredRows = sortedRows;
								filteredRows = offsetDatastoreRows(filteredRows, encodedPlan.offset);
								let more =
									base.more === true ||
									WEAKSET_HAS.call(DATASTORE_SCAN_FALLBACK_INCOMPLETE_RESULTS, base);
								if (encodedPlan.limit !== undefined) {
									const safeLimit = assertSafeLimit(encodedPlan.limit, 'Datastore limit') as number;
									more = more || filteredRows.length > safeLimit;
									const limitedRows: any[] = [];
									const length = filteredRows.length > safeLimit ? safeLimit : filteredRows.length;
									for (let index = 0; index < length; index++) limitedRows[index] = filteredRows[index];
									filteredRows = limitedRows;
								}
								const rows: any[] = [];
								for (let index = 0; index < filteredRows.length; index++) {
									const row = filteredRows[index];
									rows[index] = pickDatastoreResultFields(
										row,
										encodedPlan.select,
										model.idField,
										`${model.name} datastore transaction query row`
									);
								}
								const result: QueryResult = { list: rows, more };
								if (WEAKSET_HAS.call(DATASTORE_SCAN_FALLBACK_INCOMPLETE_RESULTS, base)) {
									WEAKSET_ADD.call(DATASTORE_SCAN_FALLBACK_INCOMPLETE_RESULTS, result);
								}
								return result;
							},
							aggregate: txStore.aggregate
								? async (model, plan) => {
										model = snapshotAdapterModel(model, 'Datastore model metadata');
										const safePlan = normalizeStoreAggregatePlan(plan, 'Datastore transaction aggregate plan');
										const typedPlan = normalizeAggregatePlanFieldTypes(model, safePlan);
										const encodedPlan = encodeAggregatePlanFieldCodecs(model, typedPlan);
										assertStorePlanSupported(txStore.kind, txStore.capabilities, encodedPlan);
										const specs = assertAggregateSpecsCompatibleWithModel(
											model,
											encodedPlan.aggregates,
											'Datastore transaction aggregate'
										);
										assertNoAggregateFieldCodecSpecs(model, specs, 'Datastore transaction aggregate');
										await waitForBufferedMutations();
										if (encodedPlan.native !== undefined) {
											if (requireAncestorTransactionQueries) {
												requireDatastoreTransactionAncestor(encodedPlan, 'Datastore transaction aggregate');
											}
											rejectDirtyNativeRead();
											return txNativeReadStore.aggregate!(model, typedPlan);
										}
										if (encodedPlan.or.length) {
											throw new ActiveTsConfigurationError('Datastore adapter does not support orWhere().');
										}
										if (requireAncestorTransactionQueries) {
											requireDatastoreTransactionAncestor(encodedPlan, 'Datastore transaction aggregate');
										}
										assertDatastoreQueryLimits(encodedPlan);
										if (!allowAggregateScanFallback) {
											for (let index = 0; index < specs.length; index++) {
												const spec = specs[index];
												if (spec.op !== 'min' && spec.op !== 'max') continue;
												const type = MAP_GET.call(model.fieldTypes, spec.field!) as FieldType | undefined;
												if (type !== 'number' && type !== 'string' && type !== 'date') {
													throw new ActiveTsConfigurationError(
														`Datastore aggregate "${spec.as}" requires fieldType metadata for ${spec.op}("${spec.field}").`
													);
												}
												assertGoogleMinMaxInequalityOrder('Datastore', encodedPlan, spec);
												for (let whereIndex = 0; whereIndex < encodedPlan.where.length; whereIndex++) {
													const where = encodedPlan.where[whereIndex];
													if (where.field !== spec.field || where.op !== 'in' || !Array.isArray(where.value)) continue;
													let hasNull = false;
													let hasNonNull = false;
													for (let valueIndex = 0; valueIndex < where.value.length; valueIndex++) {
														if (where.value[valueIndex] === null) hasNull = true;
														else hasNonNull = true;
													}
													if (hasNull && hasNonNull) {
														throw new ActiveTsConfigurationError(
															`Datastore aggregate "${spec.as}" cannot optimize mixed null and non-null filters on "${spec.field}".`
														);
													}
												}
											}
										}
										const queryPlan = copyFieldCodecQueryOperandMarker(typedPlan, {
											where: typedPlan.where,
											or: [],
											sort: [],
											include: [],
											limit: undefined,
											offset: undefined,
											cursor: undefined,
											select: undefined,
											native: undefined,
											meta: typedPlan.meta
										});
										const result = await txBufferedStore.query(model, queryPlan);
										if (
											result.more === true ||
											WEAKSET_HAS.call(DATASTORE_SCAN_FALLBACK_INCOMPLETE_RESULTS, result)
										) {
											throw new ActiveTsConfigurationError(
												'Datastore transaction aggregate cannot aggregate a paginated query result.'
											);
										}
										return aggregateRows(result.list, specs);
									}
								: undefined,
							create: async (model, id, data, writeOptions = {}) => {
								model = snapshotAdapterModel(model, 'Datastore model metadata');
								const safeOptions = normalizeStoreWriteOptions(writeOptions, 'Datastore store create options');
								if (safeOptions.expectedVersion !== undefined) {
									throw new ActiveTsConfigurationError('Datastore store create options does not support expectedVersion.');
								}
								const clean = clonePortableDataObject(data, `${model.name} stored data`);
								assertStoreDataMatchesId(model, id, clean);
								const ancestor = datastoreAncestorFromWriteOptions(safeOptions);
								assertDatastoreWriteAncestorOverrideAllowed(model, ancestor);
								assertDatastoreWriteAncestorMatchesPayload(
									model,
									id,
									clean,
									ancestor,
									adapterNamespace,
									'Datastore transaction create options'
								);
								const key = transactionMutationKey(model, id, clean, ancestor);
								return serializeBufferedMutation(key, async () => {
									const current = MAP_GET.call(bufferedMutations, key) as DatastoreTransactionMutation | undefined;
									if (current?.operation === 'create' || current?.operation === 'update') {
										throw new ActiveTsConflictError(`Cannot create ${model.name}:${String(id)} because it already exists.`);
									}
									if (!current) {
										const existing = await transactionEntityExists(
											model,
											id,
											clean,
											ancestor,
											`Datastore transaction create ${model.name}:${String(id)}`
										);
										if (existing) {
											throw new ActiveTsConflictError(`Cannot create ${model.name}:${String(id)} because it already exists.`);
										}
									}
									const bufferedData = cloneSafeDataObjectWithoutActiveEntityKey(clean, `${model.name} stored data`);
									MAP_SET.call(bufferedMutations, key, {
										operation: current?.operation === 'delete' && current.existed ? 'update' : 'create',
										model,
										id,
										data: bufferedData,
										options: safeOptions
									});
								});
							},
							update: async (model, id, data, writeOptions = {}) => {
								model = snapshotAdapterModel(model, 'Datastore model metadata');
								const safeOptions = normalizeStoreWriteOptions(writeOptions, 'Datastore store write options');
								if (safeOptions.expectedVersion !== undefined) {
									throw new ActiveTsConfigurationError('Datastore store write options does not support expectedVersion.');
								}
								const clean = clonePortableDataObject(data, `${model.name} stored data`);
								assertStoreDataMatchesId(model, id, clean);
								const ancestor = datastoreAncestorFromWriteOptions(safeOptions);
								assertDatastoreWriteAncestorOverrideAllowed(model, ancestor);
								assertDatastoreWriteAncestorMatchesPayload(
									model,
									id,
									clean,
									ancestor,
									adapterNamespace,
									'Datastore transaction write options'
								);
								const key = transactionMutationKey(model, id, clean, ancestor);
								return serializeBufferedMutation(key, async () => {
									const current = MAP_GET.call(bufferedMutations, key) as DatastoreTransactionMutation | undefined;
									if (current?.operation === 'delete') {
										throw new ActiveTsNotFoundError(`Cannot update ${model.name}:${String(id)} because it does not exist.`);
									}
									if (!current) {
										const existing = await transactionEntityExists(
											model,
											id,
											clean,
											ancestor,
											`Datastore transaction update ${model.name}:${String(id)}`
										);
										if (!existing) {
											throw new ActiveTsNotFoundError(`Cannot update ${model.name}:${String(id)} because it does not exist.`);
										}
									}
									const bufferedData = cloneSafeDataObjectWithoutActiveEntityKey(clean, `${model.name} stored data`);
									MAP_SET.call(bufferedMutations, key, {
										operation: current?.operation === 'create' ? 'create' : 'update',
										model,
										id,
										data: bufferedData,
										options: safeOptions
									});
								});
							},
							delete: async (model, id, writeOptions = {}) => {
								model = snapshotAdapterModel(model, 'Datastore model metadata');
								const safeOptions = normalizeStoreWriteOptions(writeOptions, 'Datastore store delete options');
								if (safeOptions.expectedVersion !== undefined) {
									throw new ActiveTsConfigurationError('Datastore store delete options does not support expectedVersion.');
								}
								const ancestor = datastoreAncestorFromWriteOptions(safeOptions);
								assertDatastoreDirectIdReadAllowed(model, ancestor);
								const key = transactionMutationKey(model, id, undefined, ancestor);
								return serializeBufferedMutation(key, async () => {
									const current = MAP_GET.call(bufferedMutations, key) as DatastoreTransactionMutation | undefined;
									if (current?.operation === 'create') {
										MAP_DELETE.call(bufferedMutations, key);
										return;
									}
									if (current?.operation === 'delete') return;
									let existed = true;
									if (!current) {
										existed = await transactionEntityExists(
											model,
											id,
											undefined,
											ancestor,
											`Datastore transaction delete ${model.name}:${String(id)}`
										);
									}
									if (!current && !existed) return;
									MAP_SET.call(bufferedMutations, key, {
										operation: 'delete',
										model,
										id,
										options: safeOptions,
										existed
									});
								});
							}
						};
						markStoreTrustsDatastoreEntityKeyRows(txBufferedStore);
						const scopedTx = txOptions.readOnly === true
							? createReadOnlyDatastoreTransactionStore(txStore, requireAncestorTransactionQueries)
							: txBufferedStore;
						const guardedTx = createCloseGuardedStoreAdapter(scopedTx, () => closed, 'Datastore store');
						inheritAdapterTransactionOperationCarrier(txNativeReadClient, guardedTx.adapter);
						try {
							result = await fn(guardedTx.adapter);
						} catch (error) {
							closed = 'rollback';
							try {
								await guardedTx.waitForPendingOperations();
							} catch {
								// Preserve the callback error that triggered rollback.
							}
							throw error;
						}
						closed = 'callback finished';
						try {
							await guardedTx.waitForPendingOperations();
						} catch (error) {
							closed = 'rollback';
							throw error;
						}
						if (txOptions.readOnly !== true) {
							for (const mutation of MAP_VALUES.call(bufferedMutations) as Iterable<DatastoreTransactionMutation>) {
								if (mutation.operation === 'create') {
									await txStore.create(mutation.model, mutation.id, mutation.data, mutation.options);
								} else if (mutation.operation === 'update') {
									await txStore.update(mutation.model, mutation.id, mutation.data, mutation.options);
								} else {
									await txStore.delete(mutation.model, mutation.id, mutation.options);
								}
							}
						}
						committing = true;
						await transaction.commit(nativeCommitGaxOptions);
						return result;
					} catch (error) {
						if (!started) throw error;
						if (committing) throw markTransactionRollbackSkipped(error);
						try {
							await transaction.rollback(nativeRollbackGaxOptions);
						} catch (rollbackError) {
							throw new AggregateError(
								[error, rollbackError],
								`Datastore transaction failed and rollback failed: ${safeErrorMessage(error)}`
							);
						}
						throw error;
					}
				}
			: undefined,
		async get(model, id, options) {
			model = snapshotAdapterModel(model, 'Datastore model metadata');
			const safeOptions = normalizeDatastoreReadOptions(options, 'Datastore store read options');
			const ancestorOverride = datastoreAncestorFromReadOptions(safeOptions);
			if (scopedTransaction) {
				rejectDatastoreTransactionReadPolicy(safeOptions, 'Datastore transaction read options');
			}
			const sdkReadOptions = datastoreSdkReadOptions(
				safeOptions.meta,
				'Datastore store read options.meta.datastoreRead'
			);
			assertDatastoreDirectIdReadAllowed(model, ancestorOverride);
			const expectedAncestor = ancestorOverride.ancestor === undefined
				? undefined
				: datastoreKeyWithNamespace(
						ancestorOverride.ancestor,
						adapterNamespace,
						'Datastore read options.meta.datastoreAncestor'
					);
			const key = makeEntityKey(model, id, undefined, ancestorOverride);
			const entity = datastoreRequiredResultSlot(
				await runDatastoreRead(
					datastoreMethod(client, 'get', 'Datastore client.get'),
					key,
					sdkReadOptions
				),
				'Datastore get',
				0
			);
			return normalizeDatastoreEntityForExpectedId(
				entity,
				model,
				id,
				datastoreKeySymbol,
				'Datastore get entity',
				expectedAncestor,
				adapterNamespace,
				true,
				keyEncoding
			);
		},
		async getMany(model, ids, options) {
			model = snapshotAdapterModel(model, 'Datastore model metadata');
			const safeOptions = normalizeDatastoreReadOptions(options, 'Datastore store read options');
			const ancestorOverride = datastoreAncestorFromReadOptions(safeOptions);
			if (scopedTransaction) {
				rejectDatastoreTransactionReadPolicy(safeOptions, 'Datastore transaction read options');
			}
			const sdkReadOptions = datastoreSdkReadOptions(
				safeOptions.meta,
				'Datastore store read options.meta.datastoreRead'
			);
			assertDatastoreDirectIdReadAllowed(model, ancestorOverride);
			const expectedAncestor = ancestorOverride.ancestor === undefined
				? undefined
				: datastoreKeyWithNamespace(
						ancestorOverride.ancestor,
						adapterNamespace,
						'Datastore read options.meta.datastoreAncestor'
					);
			ids = assertSafeEntityIdArray(ids, 'Datastore store ids');
			if (!ids.length) return [];
			const uniqueIds: EntityId[] = [];
			const requested = new Set<string>();
			for (const id of ids) {
				const encoded = entityIdKey(id);
				if (SET_HAS.call(requested, encoded)) continue;
				SET_ADD.call(requested, encoded);
				uniqueIds.push(id);
			}
			const entityKeys: any[] = [];
			for (let index = 0; index < uniqueIds.length; index++) {
				entityKeys[index] = makeEntityKey(model, uniqueIds[index], undefined, ancestorOverride);
			}
			const entities = datastoreRequiredResultSlot(
				await runDatastoreRead(
					datastoreMethod(client, 'get', 'Datastore client.get'),
					entityKeys,
					sdkReadOptions
				),
				'Datastore getMany',
				0
			);
			if (!Array.isArray(entities)) throw new ActiveTsValidationError('Datastore getMany result must be an array.');
			const safeEntities = snapshotArrayInput<any>(entities, 'Datastore getMany result');
			const byId = new Map<string, any>();
			for (const entity of safeEntities) {
				const { id, data } = normalizeDatastoreEntityForResult(
					entity,
					model,
					datastoreKeySymbol,
					'Datastore getMany entity',
					expectedAncestor,
					false,
					adapterNamespace,
					true,
					keyEncoding
				);
				const key = entityIdKey(id);
				if (!SET_HAS.call(requested, key)) {
					throw new ActiveTsValidationError('Datastore getMany entity id was not requested.');
				}
				if (MAP_HAS.call(byId, key)) {
					throw new ActiveTsValidationError('Datastore getMany returned duplicate entity ids.');
				}
				MAP_SET.call(byId, key, data);
			}
			const result: Array<any | null> = [];
			for (let index = 0; index < ids.length; index++) {
				const id = ids[index];
				const row = MAP_GET.call(byId, entityIdKey(id));
				result[index] = row === undefined ? null : cloneSafeDataObject(row, 'Datastore getMany entity');
			}
			return result;
		},
		async query(model, plan, readOptions): Promise<QueryResult> {
			model = snapshotAdapterModel(model, 'Datastore model metadata');
			plan = normalizeStoreQueryPlan(plan, model.idField, 'Datastore query plan', {
				limit: 'Datastore limit',
				offset: 'Datastore offset',
				whereField: 'Datastore query field',
				selectField: 'Datastore select field',
				sortField: 'Datastore sort field'
			});
			plan = normalizeQueryPlanFieldTypes(model, plan);
			plan = encodeQueryPlanFieldCodecs(model, plan);
			assertStorePlanSupported(adapter.kind, adapter.capabilities, plan);
			validateStoreQueryReadOptions(readOptions, plan, 'Datastore store read options');
			const sdkReadOptions = datastoreSdkReadOptions(
				plan.meta,
				'Datastore query plan.meta.datastoreRead'
			);
			const ancestor = datastoreAncestorFromPlan(plan);
			assertAncestorNamespace(ancestor);
			const native = assertDatastoreNativeFunction(plan);
			if (native && sdkReadOptions !== undefined) {
				throw new ActiveTsConfigurationError(
					'Datastore native function queries cannot be combined with readAt() or readConsistency(); apply SDK read options inside the native callback instead.'
				);
			}
			if (native) return normalizeStoreQueryResultForModel(
					model,
					await native({ client, model, plan }),
					'Datastore native function query',
					{
						cursor: adapter.capabilities?.cursor,
						adapterKind: adapter.kind,
						datastoreAncestor: plan.meta?.datastoreAncestor,
						datastoreNamespace: adapterNamespace,
						trustedDatastoreEntityKeys: false
					}
				);
			if (plan.or.length) throw new ActiveTsConfigurationError('Datastore adapter does not support orWhere().');
			assertDatastoreQueryLimits(plan);
			let needsScanFallback = false;
			for (let whereIndex = 0; whereIndex < plan.where.length; whereIndex++) {
				const op = plan.where[whereIndex].op;
				if (op === '!=' || op === 'in' || op === 'isNotNull') {
					needsScanFallback = true;
					break;
				}
			}
			const kind = kindName(model);
			const queryNamespace = ancestor?.namespace ?? options.namespace;
			if (allowQueryScanFallback && needsScanFallback) {
				if (plan.cursor) {
					throw new ActiveTsConfigurationError(
						'Datastore continuation cursors are not supported with query scan fallback.'
					);
				}
				const scanResult = await scanDatastoreRows(
					model,
					ancestor,
					kind,
					queryNamespace,
					'Datastore query scan fallback',
					sdkReadOptions
				);
				let filteredRows = filterRows(scanResult.rows, stripFieldCodecQueryOperandMarker(plan), model.idField);
				const sort = sortWithStableId(plan, model.idField);
				const sortedRows: any[] = [];
				for (let rowIndex = 0; rowIndex < filteredRows.length; rowIndex++) {
					const row = filteredRows[rowIndex];
					let insertAt = sortedRows.length;
					for (let sortedIndex = 0; sortedIndex < sortedRows.length; sortedIndex++) {
						if (compareRowsBySort(row, sortedRows[sortedIndex], sort) < 0) {
							insertAt = sortedIndex;
							break;
						}
					}
					for (let shift = sortedRows.length; shift > insertAt; shift--) {
						sortedRows[shift] = sortedRows[shift - 1];
					}
					sortedRows[insertAt] = row;
				}
				filteredRows = sortedRows;
				filteredRows = offsetDatastoreRows(filteredRows, plan.offset);
				let more = scanResult.incomplete;
				if (plan.limit !== undefined) {
					const safeLimit = assertSafeLimit(plan.limit, 'Datastore limit') as number;
					more = more || filteredRows.length > safeLimit;
					const limitedRows: any[] = [];
					const length = filteredRows.length > safeLimit ? safeLimit : filteredRows.length;
					for (let index = 0; index < length; index++) limitedRows[index] = filteredRows[index];
					filteredRows = limitedRows;
				}
				const rows: any[] = [];
				for (let index = 0; index < filteredRows.length; index++) {
					const row = filteredRows[index];
					rows[index] = pickDatastoreResultFields(
						row,
						plan.select,
						model.idField,
						'Datastore query scan fallback row'
					);
				}
				const result: QueryResult = {
					list: rows,
					more
				};
				if (scanResult.incomplete) {
					WEAKSET_ADD.call(DATASTORE_SCAN_FALLBACK_INCOMPLETE_RESULTS, result);
				}
				return result;
			}
			assertGoogleInequalitySortOrder('Datastore', plan, 'order');
			assertGoogleSortableFieldsDeclared('Datastore', model, plan, 'order');
			const startCursor = plan.cursor === undefined ? undefined : decodeDatastoreContinuationCursor(plan.cursor);
			const keyOnlyProjection =
				supportsKeyOnlyProjection && plan.select?.length === 1 && plan.select[0] === model.idField;
			let query = normalizeDatastoreQuery(
				queryNamespace
					? datastoreMethod(rootClient, 'createQuery', 'Datastore client.createQuery')(queryNamespace, kind)
					: datastoreMethod(rootClient, 'createQuery', 'Datastore client.createQuery')(kind),
				'Datastore query'
			);
			if (ancestor) {
				query = normalizeDatastoreQuery(
					datastoreMethod(query, 'hasAncestor', 'Datastore query.hasAncestor')(
						namespacedKey(datastoreKeyPathValues(ancestor, keyEncoding), ancestor.namespace)
					),
					'Datastore query'
				);
			}
			for (const where of plan.where)
				query = normalizeDatastoreQuery(applyDatastoreWhere(query, where), 'Datastore query');
			for (const sort of plan.sort)
				query = normalizeDatastoreQuery(
					datastoreMethod(query, 'order', 'Datastore query.order')(
						assertSafeDatastoreField(sort.field, 'Datastore sort field'),
						{ descending: sort.direction === 'desc' }
					),
					'Datastore query'
				);
			if (keyOnlyProjection)
				query = normalizeDatastoreQuery(
					datastoreMethod(query, 'select', 'Datastore query.select')('__key__'),
					'Datastore query'
				);
			if (plan.offset !== undefined)
				query = normalizeDatastoreQuery(
					datastoreMethod(query, 'offset', 'Datastore query.offset')(
						assertSafeOffset(plan.offset, 'Datastore offset')
					),
					'Datastore query'
				);
			if (plan.limit !== undefined)
				query = normalizeDatastoreQuery(
					datastoreMethod(query, 'limit', 'Datastore query.limit')(assertSafeLimit(plan.limit, 'Datastore limit')),
					'Datastore query'
				);
			if (startCursor !== undefined)
				query = normalizeDatastoreQuery(
					datastoreMethod(query, 'start', 'Datastore query.start')(startCursor),
					'Datastore query'
				);
			const result = datastoreResultTuple(
				await runDatastoreRead(
					datastoreMethod(client, 'runQuery', 'Datastore client.runQuery'),
					query,
					sdkReadOptions
				),
				'Datastore runQuery'
			);
			const list = datastoreRequiredResultSlot(result, 'Datastore runQuery', 0);
			const info = result[1];
			const entities = datastoreQueryEntities(list);
			const page = scopedTransaction
				? { more: datastoreQueryHasMore(info) }
				: datastoreDirectQueryPageInfo(info, startCursor, entities.length);
			const rows: any[] = [];
			const expectedAncestor = ancestor === undefined
				? undefined
				: datastoreKeyWithNamespace(ancestor, adapterNamespace, 'Datastore query meta.datastoreAncestor');
			for (let index = 0; index < entities.length; index++) {
				const normalized = normalizeDatastoreEntityForResult(
					entities[index],
					model,
					datastoreKeySymbol,
					`Datastore query entity[${index}]`,
					expectedAncestor,
					true,
					adapterNamespace,
					!deferScopedQueryPayloadValidation && !plan.select?.length,
					keyEncoding,
					keyOnlyProjection
				);
				const row = normalized.data;
				if (
					!deferScopedQueryPayloadValidation &&
					plan.select?.length &&
					datastorePayloadCanResolveAncestor(
						model,
						normalized.id,
						row,
						`Datastore query entity[${index}]`
					)
				) {
					assertDatastorePayloadWithinScopedAncestor(
						model,
						normalized.id,
						row,
						expectedAncestor,
						`Datastore query entity[${index}]`,
						adapterNamespace
					);
				}
				rows[index] = pickDatastoreResultFields(row, plan.select, model.idField, `Datastore query entity[${index}]`);
			}
			return {
				list: rows,
				...('cursor' in page && page.cursor !== undefined ? { cursor: page.cursor } : {}),
				more: page.more
			};
			},
		aggregate: supportsAggregate
			? async (model, plan: AggregatePlan) => {
					model = snapshotAdapterModel(model, 'Datastore model metadata');
					plan = normalizeStoreAggregatePlan(plan, 'Datastore aggregate plan');
					plan = normalizeAggregatePlanFieldTypes(model, plan);
					plan = encodeAggregatePlanFieldCodecs(model, plan);
					assertStorePlanSupported(adapter.kind, adapter.capabilities, plan);
					const sdkReadOptions = datastoreSdkReadOptions(
						plan.meta,
						'Datastore aggregate plan.meta.datastoreRead'
					);
					const specs = assertAggregateSpecsCompatibleWithModel(model, plan.aggregates, 'Datastore aggregate');
					assertNoAggregateFieldCodecSpecs(model, specs, 'Datastore aggregate');
					const ancestor = datastoreAncestorFromPlan(plan);
					assertAncestorNamespace(ancestor);
					const native = assertDatastoreNativeFunction(plan);
					if (native && sdkReadOptions !== undefined) {
						throw new ActiveTsConfigurationError(
							'Datastore native function aggregates cannot be combined with readAt() or readConsistency(); apply SDK read options inside the native callback instead.'
						);
					}
					if (native) return normalizeStoreAggregateResult(
						await native({ client, model, plan }),
						specs,
						'Datastore native function aggregate'
					);
					if (plan.or.length) throw new ActiveTsConfigurationError('Datastore adapter does not support orWhere().');
					assertDatastoreQueryLimits(plan);
					if (allowAggregateScanFallback) {
						const kind = kindName(model);
						const queryNamespace = ancestor?.namespace ?? options.namespace;
						const scanResult = await scanDatastoreRows(
							model,
							ancestor,
							kind,
							queryNamespace,
							'Datastore aggregate scan fallback',
							sdkReadOptions
						);
						if (scanResult.incomplete) {
							throw new ActiveTsConfigurationError(
								'Datastore aggregate scan fallback cannot aggregate a paginated query result.'
							);
						}
						return aggregateRows(
							filterRows(scanResult.rows, stripFieldCodecQueryOperandMarker(plan), model.idField),
							specs
						);
					}

					const aggregateResult: Record<string, unknown> = {};
					const minMaxQueryOptions = new Map<
						string,
						{ field: string; onlyNull: boolean; alreadyExcludesNull: boolean }
					>();
					for (let index = 0; index < specs.length; index++) {
						const spec = specs[index];
						if (spec.op !== 'min' && spec.op !== 'max') continue;
						const type = MAP_GET.call(model.fieldTypes, spec.field!) as FieldType | undefined;
						if (type !== 'number' && type !== 'string' && type !== 'date') {
							throw new ActiveTsConfigurationError(
								`Datastore aggregate "${spec.as}" requires fieldType metadata for ${spec.op}("${spec.field}").`
							);
						}
						assertGoogleMinMaxInequalityOrder('Datastore', plan, spec);
						const field = assertSafeDatastoreField(spec.field, `Datastore ${spec.op} aggregate field`);
						let onlyNull = false;
						let alreadyExcludesNull = false;
						for (let whereIndex = 0; whereIndex < plan.where.length; whereIndex++) {
							const where = plan.where[whereIndex];
							if (where.field !== spec.field) continue;
							if (where.op === 'isNull' || (where.op === '=' && where.value === null)) onlyNull = true;
							if (where.op === 'in' && Array.isArray(where.value)) {
								let hasNull = false;
								let hasNonNull = false;
								for (let valueIndex = 0; valueIndex < where.value.length; valueIndex++) {
									if (where.value[valueIndex] === null) hasNull = true;
									else hasNonNull = true;
								}
								if (hasNull && hasNonNull) {
									throw new ActiveTsConfigurationError(
										`Datastore aggregate "${spec.as}" cannot optimize mixed null and non-null filters on "${spec.field}".`
									);
								}
								if (hasNull) onlyNull = true;
								if (hasNonNull) alreadyExcludesNull = true;
							}
							if (
								where.op === 'isNotNull' ||
								(where.op === '=' && where.value !== null) ||
								where.op === '>' ||
								where.op === '>=' ||
								where.op === '<' ||
								where.op === '<=' ||
								where.op === 'between'
							) alreadyExcludesNull = true;
						}
						MAP_SET.call(minMaxQueryOptions, spec.as, { field, onlyNull, alreadyExcludesNull });
					}
					const sdkSpecs: AggregatePlan['aggregates'] = [];
					for (let index = 0; index < specs.length; index++) {
						const spec = specs[index];
						if (spec.op === 'count' || spec.op === 'sum' || spec.op === 'avg') {
							sdkSpecs[sdkSpecs.length] = spec;
						}
					}
					if (sdkSpecs.length) {
						const kind = kindName(model);
						const queryNamespace = ancestor?.namespace ?? options.namespace;
						let query = normalizeDatastoreQuery(
							queryNamespace
								? datastoreMethod(rootClient, 'createQuery', 'Datastore client.createQuery')(queryNamespace, kind)
								: datastoreMethod(rootClient, 'createQuery', 'Datastore client.createQuery')(kind),
							'Datastore aggregate query'
						);
						if (ancestor) {
							query = normalizeDatastoreQuery(
								datastoreMethod(query, 'hasAncestor', 'Datastore query.hasAncestor')(
									namespacedKey(datastoreKeyPathValues(ancestor, keyEncoding), ancestor.namespace)
								),
								'Datastore aggregate query'
							);
						}
						for (const where of plan.where)
							query = normalizeDatastoreQuery(applyDatastoreWhere(query, where), 'Datastore aggregate query');
						let aggregateQuery = normalizeDatastoreQuery(
							client.createAggregationQuery!(query),
							'Datastore aggregate query'
						);
						for (let index = 0; index < sdkSpecs.length; index++) {
							const spec = sdkSpecs[index];
							if (spec.op === 'count') {
								aggregateQuery = normalizeDatastoreQuery(
									datastoreMethod(aggregateQuery, 'count', 'Datastore aggregate query.count')(spec.as),
									'Datastore aggregate query'
								);
								continue;
							}
							const field = assertSafeDatastoreField(spec.field, `Datastore ${spec.op} aggregate field`);
							if (spec.op === 'sum') {
								aggregateQuery = normalizeDatastoreQuery(
									datastoreMethod(aggregateQuery, 'sum', 'Datastore aggregate query.sum')(field, spec.as),
									'Datastore aggregate query'
								);
							} else {
								aggregateQuery = normalizeDatastoreQuery(
									datastoreMethod(aggregateQuery, 'average', 'Datastore aggregate query.average')(field, spec.as),
									'Datastore aggregate query'
								);
							}
						}
						const result = datastoreResultTuple(
							await runDatastoreRead(
								datastoreMethod(
									client,
									'runAggregationQuery',
									'Datastore client.runAggregationQuery'
								),
								aggregateQuery,
								sdkReadOptions
							),
							'Datastore runAggregationQuery'
						);
						const list = datastoreRequiredResultSlot(result, 'Datastore runAggregationQuery', 0);
						if (!Array.isArray(list)) {
							throw new ActiveTsValidationError('Datastore aggregate result list must be an array.');
						}
						const rows = snapshotArrayInput<Record<string, unknown>>(list, 'Datastore aggregate result list');
						if (rows.length > 1) {
							throw new ActiveTsValidationError('Datastore aggregate result list must contain at most one row.');
						}
						const row = normalizeAggregateRow(rows[0], sdkSpecs, 'Datastore aggregate');
						for (let index = 0; index < sdkSpecs.length; index++) {
							const spec = sdkSpecs[index];
							aggregateResult[spec.as] = row[spec.as];
						}
					}

					for (let index = 0; index < specs.length; index++) {
						const spec = specs[index];
						if (spec.op !== 'min' && spec.op !== 'max') continue;
						const minMaxOptions = MAP_GET.call(minMaxQueryOptions, spec.as) as
							| { field: string; onlyNull: boolean; alreadyExcludesNull: boolean }
							| undefined;
						if (minMaxOptions === undefined) {
							throw new ActiveTsValidationError('Datastore aggregate min/max validation state is missing.');
						}
						if (minMaxOptions.onlyNull) {
							aggregateResult[spec.as] = null;
							continue;
						}
						const kind = kindName(model);
						const queryNamespace = ancestor?.namespace ?? options.namespace;
						const expectedAncestor = ancestor === undefined
							? undefined
							: datastoreKeyWithNamespace(ancestor, adapterNamespace, 'Datastore aggregate meta.datastoreAncestor');
						let query = normalizeDatastoreQuery(
							queryNamespace
								? datastoreMethod(rootClient, 'createQuery', 'Datastore client.createQuery')(queryNamespace, kind)
								: datastoreMethod(rootClient, 'createQuery', 'Datastore client.createQuery')(kind),
							'Datastore aggregate min/max query'
						);
						if (ancestor) {
							query = normalizeDatastoreQuery(
								datastoreMethod(query, 'hasAncestor', 'Datastore query.hasAncestor')(
									namespacedKey(datastoreKeyPathValues(ancestor, keyEncoding), ancestor.namespace)
								),
								'Datastore aggregate min/max query'
							);
						}
						for (const where of plan.where)
							query = normalizeDatastoreQuery(applyDatastoreWhere(query, where), 'Datastore aggregate min/max query');
						const field = minMaxOptions.field;
						if (!minMaxOptions.alreadyExcludesNull) {
							query = normalizeDatastoreQuery(
								datastoreMethod(query, 'filter', 'Datastore query.filter')(field, '!=', null),
								'Datastore aggregate min/max query'
							);
						}
						query = normalizeDatastoreQuery(
							datastoreMethod(query, 'order', 'Datastore query.order')(field, { descending: spec.op === 'max' }),
							'Datastore aggregate min/max query'
						);
						query = normalizeDatastoreQuery(
							datastoreMethod(query, 'limit', 'Datastore query.limit')(1),
							'Datastore aggregate min/max query'
						);
						const projection = datastoreProjectionFields(
							[model.idField, field],
							plan.where,
							'Datastore aggregate field'
						);
						if (projection)
							query = normalizeDatastoreQuery(
								datastoreMethod(query, 'select', 'Datastore query.select')(projection),
								'Datastore aggregate min/max query'
							);
						const result = datastoreResultTuple(
							await runDatastoreRead(
								datastoreMethod(client, 'runQuery', 'Datastore client.runQuery'),
								query,
								sdkReadOptions
							),
							'Datastore aggregate min/max runQuery'
						);
						const list = datastoreRequiredResultSlot(result, 'Datastore aggregate min/max runQuery', 0);
						const entities = datastoreQueryEntities(list);
						if (entities.length > 1) {
							throw new ActiveTsValidationError('Datastore aggregate min/max query returned more than one row.');
						}
						if (!entities.length) {
							aggregateResult[spec.as] = null;
							continue;
						}
						const normalized = normalizeDatastoreEntityForResult(
							entities[0],
							model,
							datastoreKeySymbol,
							'Datastore aggregate min/max entity',
							expectedAncestor,
							true,
							adapterNamespace,
							false,
							keyEncoding
						);
						const row = normalized.data;
						if (
							datastoreEntityKey(entities[0], datastoreKeySymbol) === undefined ||
							datastorePayloadCanResolveAncestor(
								model,
								normalized.id,
								row,
								'Datastore aggregate min/max entity'
							)
						) {
							assertDatastorePayloadWithinScopedAncestor(
								model,
								normalized.id,
								row,
								expectedAncestor,
								'Datastore aggregate min/max entity',
								adapterNamespace
							);
						}
						aggregateResult[spec.as] = valueFor(row, spec.field!) ?? null;
					}
					return normalizeAggregateRow(aggregateResult, specs, 'Datastore aggregate');
				}
			: undefined,
		async create(model, id, data, options = {}) {
			model = snapshotAdapterModel(model, 'Datastore model metadata');
			const safeOptions = normalizeStoreWriteOptions(options, 'Datastore store create options');
			if (safeOptions.expectedVersion !== undefined) {
				throw new ActiveTsConfigurationError('Datastore store create options does not support expectedVersion.');
			}
			assertSafeEntityId(id, `${model.name} store id`);
			const clean = clonePortableDataObject(data, `${model.name} stored data`);
			assertStoreDataMatchesId(model, id, clean);
			const ancestor = datastoreAncestorFromWriteOptions(safeOptions);
			assertDatastoreWriteAncestorOverrideAllowed(model, ancestor);
			assertDatastoreWriteAncestorMatchesPayload(
				model,
				id,
				clean,
				ancestor,
				adapterNamespace,
				'Datastore store create options'
			);
			const entity = entityPayload(model, id, clean, ancestor);
			if (!client.insert) {
				throw new ActiveTsConfigurationError('Datastore adapter client.insert is required for atomic create().');
			}
			try {
				await client.insert(entity);
			} catch (error) {
				if (isDatastoreAlreadyExistsError(error)) {
					throw new ActiveTsConflictError(`Cannot create ${model.name}:${String(id)} because it already exists.`);
				}
				throw error;
			}
		},
		async update(model, id, data, options = {}) {
			model = snapshotAdapterModel(model, 'Datastore model metadata');
			const safeOptions = normalizeStoreWriteOptions(options, 'Datastore store write options');
			if (safeOptions.expectedVersion !== undefined) {
				throw new ActiveTsConfigurationError('Datastore store write options does not support expectedVersion.');
			}
			assertSafeEntityId(id, `${model.name} store id`);
			const clean = clonePortableDataObject(data, `${model.name} stored data`);
			assertStoreDataMatchesId(model, id, clean);
			const ancestor = datastoreAncestorFromWriteOptions(safeOptions);
			assertDatastoreWriteAncestorOverrideAllowed(model, ancestor);
			assertDatastoreWriteAncestorMatchesPayload(
				model,
				id,
				clean,
				ancestor,
				adapterNamespace,
				'Datastore store write options'
			);
			const entity = entityPayload(model, id, clean, ancestor);
			if (!client.update) {
				throw new ActiveTsConfigurationError('Datastore adapter client.update is required for update().');
			}
			try {
				await client.update(entity);
			} catch (error) {
				if (isDatastoreNotFoundError(error)) {
					throw new ActiveTsNotFoundError(`Cannot update ${model.name}:${String(id)} because it does not exist.`);
				}
				throw error;
			}
		},
		async delete(model, id, options = {}) {
			model = snapshotAdapterModel(model, 'Datastore model metadata');
			const safeOptions = normalizeStoreWriteOptions(options, 'Datastore store delete options');
			if (safeOptions.expectedVersion !== undefined) {
				throw new ActiveTsConfigurationError('Datastore store delete options does not support expectedVersion.');
			}
			const ancestor = datastoreAncestorFromWriteOptions(safeOptions);
			assertDatastoreDirectIdReadAllowed(model, ancestor);
			const key = makeEntityKey(model, id, undefined, ancestor);
			await datastoreMethod(client, 'delete', 'Datastore client.delete')(key);
		},
		schema: scopedTransaction
			? undefined
			: {
					async plan(models): Promise<SchemaPlan> {
						models = normalizeSchemaModels(models, 'Datastore schema models');
						assertDatastoreSchemaModelsSupported(models);
						return {
							adapter: 'datastore',
							status: 'manual',
							note: 'Datastore index plans are declarative intent; compare and deploy the generated Google Cloud index configuration outside the adapter.',
							changes: datastoreSchemaChanges(models)
						};
					},
					async apply(models, applyOptions): Promise<SchemaPlan> {
						normalizeStoreSchemaApplyOptions(applyOptions, 'Datastore schema apply options');
						const safeModels = normalizeSchemaModels(models, 'Datastore schema models');
						const plan = await adapter.schema!.plan(safeModels);
						return {
							...plan,
							status: 'manual',
							note: 'Datastore composite indexes are reported as deployment intent and must be applied with the Google Cloud index configuration workflow.'
						};
					}
				}
	};
	if (!scopedTransaction) {
		const runBulkMutation = async <T>(
			items: T[],
			mutationOptions: ReturnType<typeof normalizeDatastoreBulkMutationOptions>,
			mutate: (target: NormalizedDatastoreClient, batch: T[]) => Promise<void>,
			context: string
		) => {
			if (!items.length) return;
			if (mutationOptions.atomic) {
				if (!transactionFactory) {
					throw new ActiveTsConfigurationError(
						`${context} atomic mode requires Datastore transaction support.`
					);
				}
				const transaction = normalizeDatastoreTransaction(
					transactionFactory({ readOnly: false }),
					rootClient
				);
				let started = false;
				let committing = false;
				try {
					await transaction.run();
					started = true;
					await mutate(transaction.client, items);
					committing = true;
					await transaction.commit();
				} catch (error) {
					if (!started) throw error;
					if (committing) throw markTransactionRollbackSkipped(error);
					try {
						await transaction.rollback();
					} catch (rollbackError) {
						throw new AggregateError(
							[error, rollbackError],
							`${context} failed and rollback failed: ${safeErrorMessage(error)}`
						);
					}
					throw error;
				}
				return;
			}
			const chunkSize = mutationOptions.chunkSize ?? items.length;
			for (let offset = 0; offset < items.length; offset += chunkSize) {
				const batch: T[] = [];
				const end = Math.min(offset + chunkSize, items.length);
				for (let index = offset; index < end; index++) batch[batch.length] = items[index];
				await mutate(client, batch);
			}
		};
		const bulk: DatastoreBulkOperations = {
			upsertMany: async (model, entries, mutationOptions) => {
				model = snapshotAdapterModel(model, 'Datastore bulk upsert model metadata');
				const rawEntries = snapshotArrayInput<unknown>(entries, 'Datastore bulk upsert entries');
				const safeMutationOptions = normalizeDatastoreBulkMutationOptions(
					mutationOptions,
					'Datastore bulk upsert options'
				);
				const entities: Array<{ key: unknown; data: any; excludeFromIndexes?: string[] }> = [];
				const seenKeys = new Map<string, number>();
				for (let index = 0; index < rawEntries.length; index++) {
					const rawEntry = rawEntries[index];
					const entryContext = `Datastore bulk upsert entries[${index}]`;
					if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
						throw new ActiveTsValidationError(`${entryContext} must be an object.`);
					}
					assertPlainFactoryOptions(rawEntry, entryContext);
					const entry = rawEntry as Record<string, unknown>;
					assertNoSymbolOptions(entry, entryContext);
					assertKnownOptions(entry, DATASTORE_BULK_UPSERT_ENTRY_KEYS, entryContext);
					const id = ownFactoryOptionValue(entry, 'id', entryContext) as EntityId;
					assertSafeEntityId(id, `${entryContext}.id`);
					const clean = clonePortableDataObject(
						ownFactoryOptionValue(entry, 'data', entryContext),
						`${entryContext}.data`
					);
					assertStoreDataMatchesId(model, id, clean, `${entryContext}.data`);
					const writeOptions = normalizeStoreWriteOptions(
						ownFactoryOptionValue(entry, 'options', entryContext),
						`${entryContext}.options`
					);
					if (writeOptions.expectedVersion !== undefined) {
						throw new ActiveTsConfigurationError(`${entryContext}.options does not support expectedVersion.`);
					}
					const ancestorOverride = datastoreAncestorFromWriteOptions(writeOptions);
					assertDatastoreWriteAncestorOverrideAllowed(model, ancestorOverride);
					assertDatastoreWriteAncestorMatchesPayload(
						model,
						id,
						clean,
						ancestorOverride,
						adapterNamespace,
						`${entryContext}.options`
					);
					const ancestor = datastoreAncestorForWrite(model, id, clean, ancestorOverride);
					const identity = datastoreKeyIdentity(
						logicalEntityKeyFromAncestor(model, id, ancestor, `${entryContext}.id`)
					);
					const duplicateIndex = MAP_GET.call(seenKeys, identity) as number | undefined;
					if (duplicateIndex !== undefined) {
						throw new ActiveTsValidationError(
							`${entryContext} resolves to the same Datastore key as entries[${duplicateIndex}].`
						);
					}
					MAP_SET.call(seenKeys, identity, index);
					entities[entities.length] = entityPayloadFromAncestor(model, id, clean, ancestor);
				}
				await runBulkMutation(
					entities,
					safeMutationOptions,
					async (target, batch) => {
						if (!target.upsert) {
							throw new ActiveTsConfigurationError(
								'Datastore bulk upsert requires client.upsert() or client.save().'
							);
						}
						await target.upsert(batch);
					},
					'Datastore bulk upsert'
				);
			},
			deleteMany: async (model, entries, mutationOptions) => {
				model = snapshotAdapterModel(model, 'Datastore bulk delete model metadata');
				const rawEntries = snapshotArrayInput<unknown>(entries, 'Datastore bulk delete entries');
				const safeMutationOptions = normalizeDatastoreBulkMutationOptions(
					mutationOptions,
					'Datastore bulk delete options'
				);
				const keys: unknown[] = [];
				const seenKeys = new Map<string, number>();
				for (let index = 0; index < rawEntries.length; index++) {
					const rawEntry = rawEntries[index];
					const entryContext = `Datastore bulk delete entries[${index}]`;
					let id: EntityId;
					let rawWriteOptions: unknown;
					if (typeof rawEntry === 'string' || typeof rawEntry === 'number') {
						id = rawEntry;
					} else {
						if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
							throw new ActiveTsValidationError(`${entryContext} must be an entity id or object.`);
						}
						assertPlainFactoryOptions(rawEntry, entryContext);
						const entry = rawEntry as Record<string, unknown>;
						assertNoSymbolOptions(entry, entryContext);
						assertKnownOptions(entry, DATASTORE_BULK_DELETE_ENTRY_KEYS, entryContext);
						id = ownFactoryOptionValue(entry, 'id', entryContext) as EntityId;
						rawWriteOptions = ownFactoryOptionValue(entry, 'options', entryContext);
					}
					assertSafeEntityId(id, `${entryContext}.id`);
					const writeOptions = normalizeStoreWriteOptions(rawWriteOptions, `${entryContext}.options`);
					if (writeOptions.expectedVersion !== undefined) {
						throw new ActiveTsConfigurationError(`${entryContext}.options does not support expectedVersion.`);
					}
					const ancestorOverride = datastoreAncestorFromWriteOptions(writeOptions);
					assertDatastoreDirectIdReadAllowed(model, ancestorOverride);
					const ancestor = datastoreAncestorForWrite(model, id, undefined, ancestorOverride);
					const identity = datastoreKeyIdentity(
						logicalEntityKeyFromAncestor(model, id, ancestor, `${entryContext}.id`)
					);
					const duplicateIndex = MAP_GET.call(seenKeys, identity) as number | undefined;
					if (duplicateIndex !== undefined) {
						throw new ActiveTsValidationError(
							`${entryContext} resolves to the same Datastore key as entries[${duplicateIndex}].`
						);
					}
					MAP_SET.call(seenKeys, identity, index);
					keys[keys.length] = makeEntityKeyFromAncestor(model, id, ancestor);
				}
				await runBulkMutation(
					keys,
					safeMutationOptions,
					async (target, batch) => {
						await target.delete(batch);
					},
					'Datastore bulk delete'
				);
			}
		};
		defineDataProperty(adapter, 'bulk', Object.freeze(bulk), {
			enumerable: true,
			configurable: false,
			writable: false
		});
	}
	return markStoreTrustsDatastoreEntityKeyRows(adapter);
}

function createReadOnlyDatastoreTransactionStore(
	txStore: StoreAdapter,
	requireAncestorTransactionQueries: boolean
): StoreAdapter {
	const rejectReadOnlyWrite = async () => {
		throw new ActiveTsConfigurationError('Datastore transaction is read-only.');
	};
	const normalizeReadOnlyReadOptions = (options: unknown, context: string) => {
		const safeOptions = normalizeStoreReadOptions(options, context);
		if (safeOptions.native !== undefined) {
			throw new ActiveTsConfigurationError('Datastore transaction is read-only and cannot run native store reads.');
		}
		return safeOptions;
	};
	return markStoreTrustsDatastoreEntityKeyRows({
		kind: txStore.kind,
		cacheScope: txStore.cacheScope,
		datastoreNamespace: txStore.datastoreNamespace,
		datastoreProjectId: txStore.datastoreProjectId,
		datastoreDatabaseId: txStore.datastoreDatabaseId,
		datastoreKeyEncoding: txStore.datastoreKeyEncoding,
		capabilities: Object.freeze({ ...(txStore.capabilities ?? {}), transaction: false, native: false }),
		get: (model, id, options) =>
			txStore.get(model, id, normalizeReadOnlyReadOptions(options, 'Datastore read-only transaction get options')),
		getMany: (model, ids, options) =>
			txStore.getMany(model, ids, normalizeReadOnlyReadOptions(options, 'Datastore read-only transaction getMany options')),
		query: (model, plan, options) => {
			const safeModel = snapshotAdapterModel(model, 'Datastore read-only transaction model metadata');
			const safePlan = normalizeStoreQueryPlan(plan, safeModel.idField, 'Datastore read-only transaction query plan', {
				limit: 'Datastore limit',
				offset: 'Datastore offset',
				whereField: 'Datastore query field',
				selectField: 'Datastore select field',
				sortField: 'Datastore sort field'
			});
			const safeOptions = validateStoreQueryReadOptions(
				options,
				safePlan,
				'Datastore read-only transaction query options'
			);
			if (safePlan.native !== undefined || safeOptions.native !== undefined) {
				throw new ActiveTsConfigurationError('Datastore transaction is read-only and cannot run native store reads.');
			}
			if (requireAncestorTransactionQueries) requireDatastoreTransactionAncestor(safePlan, 'Datastore read-only transaction query');
			return txStore.query(safeModel, safePlan, safeOptions);
		},
		aggregate: txStore.aggregate
			? (model, plan) => {
					const safeModel = snapshotAdapterModel(model, 'Datastore read-only transaction model metadata');
					const safePlan = normalizeStoreAggregatePlan(plan, 'Datastore read-only transaction aggregate plan');
					if (safePlan.native !== undefined) {
						throw new ActiveTsConfigurationError(
							'Datastore transaction is read-only and cannot run native store reads.'
						);
					}
					if (requireAncestorTransactionQueries) {
						requireDatastoreTransactionAncestor(safePlan, 'Datastore read-only transaction aggregate');
					}
					return txStore.aggregate!(safeModel, safePlan);
				}
			: undefined,
		create: rejectReadOnlyWrite,
		update: rejectReadOnlyWrite,
		delete: rejectReadOnlyWrite
	});
}

function datastoreSchemaChanges(models: ResolvedModelMeta[]) {
	const changes: SchemaPlan['changes'] = [];
	const seen = new Set<string>();
	for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
		const model = models[modelIndex];
		const ancestorModes = datastoreSchemaAncestorModes(
			datastoreSchemaHasAncestor(model, 'Datastore schema model')
		);
		for (let modeIndex = 0; modeIndex < ancestorModes.length; modeIndex++) {
			const ancestor = ancestorModes[modeIndex];
			for (let indexIndex = 0; indexIndex < model.indexes.length; indexIndex++) {
				const index = model.indexes[indexIndex];
				const { fields, directions } = datastoreRuntimeIndex(
					model,
					index.fields,
					index.directions,
					'Datastore schema index field'
				);
				const identity = datastoreIndexDedupeIdentity(model.name, ancestor, fields, directions);
				if (SET_HAS.call(seen, identity)) continue;
				SET_ADD.call(seen, identity);
				changes[changes.length] = {
					type: 'create-index' as const,
					target: model.name,
					name: index.name,
					fields,
					directions,
					unique: index.unique,
					ancestor
				};
			}
		}
	}
	return changes;
}

function datastoreIndexDedupeIdentity(
	kind: string,
	ancestor: boolean,
	fields: readonly string[],
	directions: readonly SortDirection[]
) {
	return [
		datastoreIndexDedupePart(kind),
		ancestor ? 'ancestor:1' : 'ancestor:0',
		datastoreIndexDedupeList(fields),
		datastoreIndexDedupeList(directions)
	].join('|');
}

function datastoreIndexDedupeList(values: readonly string[]) {
	let identity = `${values.length}:`;
	for (let index = 0; index < values.length; index++) {
		identity += datastoreIndexDedupePart(values[index]);
	}
	return identity;
}

function datastoreIndexDedupePart(value: string) {
	return `${value.length}:${value}`;
}

function assertDatastoreSchemaModelsSupported(models: ResolvedModelMeta[]) {
	for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
		const model = models[modelIndex];
		datastoreSchemaHasAncestor(model, 'Datastore schema model');
		validateDatastoreUnindexedMetadata(model.name, model.idField, model.indexes, model.datastore);
		for (let indexIndex = 0; indexIndex < model.indexes.length; indexIndex++) {
			const index = model.indexes[indexIndex];
			if (index.unique !== true) continue;
			throw new ActiveTsConfigurationError(
				`Datastore adapter does not support unique indexes. Unsupported index "${index.name}" on "${model.name}".`
			);
		}
	}
}

function datastoreSchemaHasAncestor(model: ResolvedModelMeta, context: string) {
	const datastore = model.datastore;
	if (datastore === undefined) return false;
	if (!datastore || typeof datastore !== 'object' || Array.isArray(datastore)) {
		throw new ActiveTsConfigurationError(`Datastore metadata for ${model.name} must be an object.`);
	}
	const descriptor = Object.getOwnPropertyDescriptor(datastore, 'ancestor');
	if (!descriptor) {
		if ('ancestor' in datastore) {
			throw new ActiveTsConfigurationError(`${context} "${model.name}".datastore.ancestor must be an own data property.`);
		}
		return false;
	}
	if (!('value' in descriptor)) {
		throw new ActiveTsConfigurationError(`${context} "${model.name}".datastore.ancestor must be a data property.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsConfigurationError(`${context} "${model.name}".datastore.ancestor must be enumerable.`);
	}
	return descriptor.value !== undefined;
}

function normalizeOptionalDatastoreNamespaceOption(value: unknown, context: string) {
	if (value !== undefined && (typeof value !== 'string' || !value || value.includes('\0'))) {
		throw new ActiveTsConfigurationError(
			`${context} must be a non-empty string without null bytes, or undefined for the default namespace.`
		);
	}
	return value as string | undefined;
}

function validateDatastoreOptions(options: DatastoreStoreOptions) {
	if (!options || typeof options !== 'object' || Array.isArray(options)) {
		throw new ActiveTsConfigurationError('Datastore adapter options must be an object.');
	}
	assertPlainFactoryOptions(options, 'Datastore adapter options');
	const record = options as Record<string, unknown>;
	assertNoSymbolOptions(record, 'Datastore adapter options');
	assertKnownOptions(record, DATASTORE_OPTION_KEYS, 'Datastore adapter options');
	const datastoreOptions = ownFactoryOptionValue(record, 'datastoreOptions', 'Datastore adapter option');
	const namespace = ownFactoryOptionValue(record, 'namespace', 'Datastore adapter option');
	const cacheScope = ownFactoryOptionValue(record, 'cacheScope', 'Datastore adapter option');
	const keyEncoding = ownFactoryOptionValue(record, 'keyEncoding', 'Datastore adapter option');
	const keySymbol = ownFactoryOptionValue(record, 'keySymbol', 'Datastore adapter option');
	const client = ownFactoryOptionValue(record, 'client', 'Datastore adapter option');
	const allowAggregateScanFallback = ownFactoryOptionValue(
		record,
		'allowAggregateScanFallback',
		'Datastore adapter option'
	);
	const allowQueryScanFallback = ownFactoryOptionValue(
		record,
		'allowQueryScanFallback',
		'Datastore adapter option'
	);
	const requireAncestorTransactionQueries = ownFactoryOptionValue(
		record,
		'requireAncestorTransactionQueries',
		'Datastore adapter option'
	);
	const safeDatastoreOptions =
		datastoreOptions === undefined
			? undefined
			: snapshotSdkOptions(datastoreOptions, 'Datastore adapter datastoreOptions');
	const safeNamespace = normalizeOptionalDatastoreNamespaceOption(namespace, 'Datastore adapter namespace');
	if (safeDatastoreOptions !== undefined) {
		normalizeOptionalDatastoreNamespaceOption(
			ownFactoryOptionValue(safeDatastoreOptions, 'namespace', 'Datastore adapter datastoreOptions'),
			'Datastore adapter datastoreOptions namespace'
		);
	}
	if (cacheScope !== undefined && (typeof cacheScope !== 'string' || !cacheScope || cacheScope.includes('\0'))) {
		throw new ActiveTsConfigurationError(
			'Datastore adapter cacheScope must be a non-empty string without null bytes.'
		);
	}
	if (keyEncoding !== undefined && keyEncoding !== 'active-ts' && keyEncoding !== 'native') {
		throw new ActiveTsConfigurationError(
			'Datastore adapter keyEncoding must be "active-ts" or "native".'
		);
	}
	if (keySymbol !== undefined && typeof keySymbol !== 'symbol') {
		throw new ActiveTsConfigurationError('Datastore adapter keySymbol must be a symbol.');
	}
	if (client !== undefined) {
		normalizeDatastoreClient(client);
	}
	if (allowAggregateScanFallback !== undefined && typeof allowAggregateScanFallback !== 'boolean') {
		throw new ActiveTsConfigurationError('Datastore adapter allowAggregateScanFallback must be a boolean.');
	}
	if (allowQueryScanFallback !== undefined && typeof allowQueryScanFallback !== 'boolean') {
		throw new ActiveTsConfigurationError('Datastore adapter allowQueryScanFallback must be a boolean.');
	}
	if (requireAncestorTransactionQueries !== undefined && typeof requireAncestorTransactionQueries !== 'boolean') {
		throw new ActiveTsConfigurationError('Datastore adapter requireAncestorTransactionQueries must be a boolean.');
	}
	return {
		datastoreOptions: safeDatastoreOptions,
		namespace: safeNamespace,
		cacheScope,
		keyEncoding,
		keySymbol,
		client,
		allowAggregateScanFallback,
		allowQueryScanFallback,
		requireAncestorTransactionQueries
	} as DatastoreStoreOptions;
}

function datastoreTransactionOverlayAncestorMatches(
	actual: DatastoreKey | undefined,
	expected: DatastoreKey | undefined,
	adapterNamespace: string | undefined
) {
	if (expected === undefined) return true;
	if (actual === undefined) return false;
	const safeActual = normalizeDatastoreKey(actual);
	const safeExpected = normalizeDatastoreKey(expected);
	const actualNamespace = safeActual.namespace ?? adapterNamespace;
	const expectedNamespace = safeExpected.namespace ?? adapterNamespace;
	if (actualNamespace !== expectedNamespace) return false;
	if (safeActual.path.length < safeExpected.path.length) return false;
	for (let index = 0; index < safeExpected.path.length; index++) {
		const actualPart = safeActual.path[index];
		const expectedPart = safeExpected.path[index];
		if (actualPart.kind !== expectedPart.kind) return false;
		if (entityIdKey(actualPart.id) !== entityIdKey(expectedPart.id)) return false;
	}
	return true;
}

function datastoreTransactionOverlayAncestorsShareShape(
	actual: DatastoreKey | undefined,
	expected: DatastoreKey | undefined
) {
	if (actual === undefined || expected === undefined) return false;
	const safeActual = normalizeDatastoreKey(actual);
	const safeExpected = normalizeDatastoreKey(expected);
	const length = Math.min(safeActual.path.length, safeExpected.path.length);
	for (let index = 0; index < length; index++) {
		if (safeActual.path[index].kind !== safeExpected.path[index].kind) return false;
	}
	return length > 0 || safeActual.path.length === safeExpected.path.length;
}

function datastorePayloadAncestorMatchesScope(
	actual: DatastoreKey | undefined,
	expected: DatastoreKey | undefined,
	adapterNamespace: string | undefined
) {
	if (expected === undefined) return true;
	if (actual === undefined) return false;
	const safeActual = normalizeDatastoreKey(actual);
	const safeExpected = normalizeDatastoreKey(expected);
	const expectedNamespace = safeExpected.namespace ?? adapterNamespace;
	if (safeActual.namespace !== undefined && safeActual.namespace !== expectedNamespace) return false;
	if (safeActual.path.length < safeExpected.path.length) return false;
	for (let index = 0; index < safeExpected.path.length; index++) {
		const actualPart = safeActual.path[index];
		const expectedPart = safeExpected.path[index];
		if (actualPart.kind !== expectedPart.kind) return false;
		if (entityIdKey(actualPart.id) !== entityIdKey(expectedPart.id)) return false;
	}
	return true;
}

function assertDatastorePayloadWithinScopedAncestor(
	model: ResolvedModelMeta,
	id: EntityId,
	data: Record<string, unknown>,
	expectedAncestor: DatastoreKey | undefined,
	context: string,
	adapterNamespace: string | undefined
) {
	if (expectedAncestor === undefined || !model.datastore?.ancestor) return;
	const candidates = datastoreWritePayloadAncestorCandidates(model, id, data);
	let mismatchedAncestor: DatastoreKey | undefined;
	for (let index = 0; index < candidates.length; index++) {
		const candidate = candidates[index];
		const actualAncestor = candidate === undefined
			? undefined
			: normalizeDatastoreKey(candidate, `${context} payload Datastore ancestor`);
		if (datastorePayloadAncestorMatchesScope(actualAncestor, expectedAncestor, adapterNamespace)) return;
		if (actualAncestor === undefined) continue;
		if (
			datastoreTransactionOverlayAncestorsShareShape(actualAncestor, expectedAncestor) ||
			datastorePayloadCanResolveAncestor(model, id, data, context)
		) {
			mismatchedAncestor = actualAncestor;
		}
	}
	if (mismatchedAncestor === undefined) return;
	const scopedNamespace = expectedAncestor.namespace ?? adapterNamespace;
	const actualIdentity = datastoreKeyIdentity(
		mismatchedAncestor.namespace === undefined
			? datastoreKeyWithNamespace(
					mismatchedAncestor,
					scopedNamespace,
					`${context} payload Datastore ancestor`
				)
			: mismatchedAncestor
	);
	const expectedIdentity = datastoreKeyIdentity(
		datastoreKeyWithNamespace(
			expectedAncestor,
			adapterNamespace,
			`${context} scoped Datastore ancestor`
		)
	);
	throw new ActiveTsValidationError(
		`${context} payload Datastore ancestor resolved outside the scoped Datastore ancestor (${actualIdentity} !== ${expectedIdentity}).`
	);
}

type ParsedDatastoreIdInventoryKey = {
	key: DatastoreIdInventoryKey;
	leaf: DatastoreIdInventoryKeyPart;
	activeTsCompatible: boolean;
	unsupportedReason?: string;
};
type DatastoreIdInventoryClassificationResult =
	| { classification: 'match'; reason: '' }
	| {
			classification: Exclude<DatastoreIdInventoryClassification, 'match'>;
			reason: string;
	  };
const DATASTORE_MAX_NUMERIC_ID = 9223372036854775807n;
const ACTIVE_TS_MAX_NUMERIC_ID = BigInt(Number.MAX_SAFE_INTEGER);

function normalizeDatastoreIdInventoryOptions(options: unknown) {
	if (!options || typeof options !== 'object' || Array.isArray(options)) {
		throw new ActiveTsConfigurationError('Datastore ID inventory options must be a plain object.');
	}
	assertPlainFactoryOptions(options, 'Datastore ID inventory options');
	const record = options as Record<string, unknown>;
	assertNoSymbolOptions(record, 'Datastore ID inventory options');
	assertKnownOptions(record, DATASTORE_ID_INVENTORY_OPTION_KEYS, 'Datastore ID inventory options');
	const client = ownFactoryOptionValue(record, 'client', 'Datastore ID inventory option');
	if (!client || typeof client !== 'object' || Array.isArray(client)) {
		throw new ActiveTsConfigurationError('Datastore ID inventory client must be an object.');
	}
	const kind = assertSafePhysicalIdentifierLength(
		assertSafeSchemaIdentifier(
			ownFactoryOptionValue(record, 'kind', 'Datastore ID inventory option'),
			'Datastore ID inventory kind'
		),
		'Datastore ID inventory kind'
	);
	const rawIdField = ownFactoryOptionValue(record, 'idField', 'Datastore ID inventory option');
	const idField = assertSafeTopLevelField(rawIdField ?? 'id', 'Datastore ID inventory idField');
	const explicitNamespace = normalizeOptionalDatastoreNamespaceOption(
		ownFactoryOptionValue(record, 'namespace', 'Datastore ID inventory option'),
		'Datastore ID inventory namespace'
	);
	const clientNamespace = normalizeOptionalDatastoreNamespaceOption(
		datastoreMember(client, 'namespace', 'Datastore ID inventory client.namespace'),
		'Datastore ID inventory namespace'
	);
	const namespace = explicitNamespace ?? clientNamespace;
	const rawPageSize = ownFactoryOptionValue(record, 'pageSize', 'Datastore ID inventory option');
	const pageSize = assertSafeLimit(rawPageSize === undefined ? 500 : rawPageSize as number, 'Datastore ID inventory pageSize')!;
	if (pageSize > 1000) {
		throw new ActiveTsConfigurationError('Datastore ID inventory pageSize must not exceed 1000.');
	}
	const keySymbol = ownFactoryOptionValue(record, 'keySymbol', 'Datastore ID inventory option');
	if (keySymbol !== undefined && typeof keySymbol !== 'symbol') {
		throw new ActiveTsConfigurationError('Datastore ID inventory keySymbol must be a symbol.');
	}
	const onIssue = ownFactoryOptionValue(record, 'onIssue', 'Datastore ID inventory option');
	if (onIssue !== undefined && typeof onIssue !== 'function') {
		throw new ActiveTsConfigurationError('Datastore ID inventory onIssue must be a function.');
	}
	return {
		client,
		kind,
		idField,
		namespace: namespace as string | undefined,
		keySymbol: keySymbol as symbol | undefined,
		pageSize,
		onIssue: onIssue as DatastoreIdInventoryOptions['onIssue']
	};
}

function datastoreIdInventoryKey(
	entity: unknown,
	keySymbol: symbol,
	expectedKind: string,
	expectedNamespace: string | undefined,
	context: string
): ParsedDatastoreIdInventoryKey {
	const sourceKey = datastoreEntityKey(entity, keySymbol);
	if (sourceKey === undefined) {
		throw new ActiveTsValidationError(`${context} is missing SDK key metadata.`);
	}
	const reversed: DatastoreIdInventoryKeyPart[] = [];
	const seen = new WeakSet<object>();
	let cursor: unknown = sourceKey;
	let activeTsCompatible = true;
	let unsupportedReason: string | undefined;
	while (cursor !== undefined) {
		if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) {
			throw new ActiveTsValidationError(`${context} SDK key parent must be an object.`);
		}
		if (WEAKSET_HAS.call(seen, cursor as object)) {
			throw new ActiveTsValidationError(`${context} SDK key parent cannot contain a cycle.`);
		}
		WEAKSET_ADD.call(seen, cursor as object);
		const partContext = `${context} SDK key part[${reversed.length}]`;
		const rawKind = datastoreIdInventoryKeyProperty(cursor, 'kind', partContext);
		if (typeof rawKind !== 'string' || !rawKind || rawKind.includes('\0')) {
			throw new ActiveTsValidationError(`${partContext}.kind must be a non-empty string without null bytes.`);
		}
		try {
			assertSafePhysicalIdentifierLength(
				assertSafeSchemaIdentifier(rawKind, `${partContext}.kind`),
				`${partContext}.kind`
			);
		} catch (error) {
			activeTsCompatible = false;
			unsupportedReason ??= safeErrorMessage(error);
		}
		const rawName = datastoreIdInventoryKeyProperty(cursor, 'name', partContext);
		const rawId = datastoreIdInventoryKeyProperty(cursor, 'id', partContext);
		if (rawName !== undefined && rawId !== undefined) {
			throw new ActiveTsValidationError(`${partContext} cannot contain both name and id.`);
		}
		let part: DatastoreIdInventoryKeyPart;
		if (rawName !== undefined) {
			if (typeof rawName !== 'string' || !rawName || rawName.includes('\0')) {
				throw new ActiveTsValidationError(`${partContext}.name must be a non-empty string without null bytes.`);
			}
			try {
				assertNativeDatastoreEntityId(rawName, `${partContext}.name`);
			} catch (error) {
				activeTsCompatible = false;
				unsupportedReason ??= safeErrorMessage(error);
			}
			part = Object.freeze({ kind: rawKind, storage: 'name', value: rawName });
		} else if (rawId !== undefined) {
			let value: string;
			if (typeof rawId === 'number') {
				if (!Number.isSafeInteger(rawId) || rawId <= 0) {
					throw new ActiveTsValidationError(
						`${partContext}.id must be a positive safe integer when represented as a number.`
					);
				}
				value = String(rawId);
			} else if (typeof rawId === 'string') {
				if (!/^[1-9]\d*$/.test(rawId) || rawId.length > 19) {
					throw new ActiveTsValidationError(`${partContext}.id must be a canonical positive Datastore integer string.`);
				}
				const integer = BigInt(rawId);
				if (integer > DATASTORE_MAX_NUMERIC_ID) {
					throw new ActiveTsValidationError(`${partContext}.id exceeds the Datastore numeric ID range.`);
				}
				if (integer > ACTIVE_TS_MAX_NUMERIC_ID) {
					activeTsCompatible = false;
					unsupportedReason ??= `${partContext}.id exceeds the active-ts safe integer range.`;
				}
				value = rawId;
			} else {
				throw new ActiveTsValidationError(`${partContext}.id must be a number or numeric string.`);
			}
			part = Object.freeze({ kind: rawKind, storage: 'id', value });
		} else {
			throw new ActiveTsValidationError(`${partContext} must contain a complete name or id.`);
		}
		reversed[reversed.length] = part;
		cursor = datastoreIdInventoryKeyProperty(cursor, 'parent', partContext);
	}
	const path: DatastoreIdInventoryKeyPart[] = [];
	for (let index = reversed.length - 1; index >= 0; index--) {
		path[path.length] = reversed[index];
	}
	const leaf = path[path.length - 1];
	if (!leaf || leaf.kind !== expectedKind) {
		throw new ActiveTsValidationError(`${context} SDK key leaf kind must be "${expectedKind}".`);
	}
	const rawNamespace = datastoreIdInventoryKeyProperty(sourceKey, 'namespace', `${context} SDK key`);
	if (
		rawNamespace !== undefined &&
		(typeof rawNamespace !== 'string' || !rawNamespace || rawNamespace.includes('\0'))
	) {
		throw new ActiveTsValidationError(
			`${context} SDK key namespace must be a non-empty string without null bytes, or undefined for the default namespace.`
		);
	}
	const namespace = rawNamespace as string | undefined;
	if (namespace !== expectedNamespace) {
		throw new ActiveTsValidationError(`${context} SDK key namespace must match the inventory namespace.`);
	}
	Object.freeze(path);
	const key = Object.freeze({
		path,
		...(namespace === undefined ? {} : { namespace })
	});
	return { key, leaf, activeTsCompatible, unsupportedReason };
}

function datastoreIdInventoryKeyProperty(key: unknown, property: string, context: string) {
	if (!key || typeof key !== 'object' || Array.isArray(key)) {
		throw new ActiveTsValidationError(`${context} must be an SDK key object.`);
	}
	if (!Object.prototype.hasOwnProperty.call(key, property)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(key, property);
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsValidationError(`${context}.${property} must be a data property.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsValidationError(`${context}.${property} must be enumerable.`);
	}
	return descriptor.value;
}

function datastoreIdInventoryPayload(
	entity: unknown,
	idField: string,
	context: string
): DatastoreIdInventoryPayload {
	if (!entity || typeof entity !== 'object' || Array.isArray(entity)) {
		throw new ActiveTsValidationError(`${context} must be an entity object.`);
	}
	if (!Object.prototype.hasOwnProperty.call(entity, idField)) return Object.freeze({ type: 'missing' });
	const descriptor = Object.getOwnPropertyDescriptor(entity, idField);
	if (!descriptor || !('value' in descriptor)) {
		return Object.freeze({ type: 'invalid', actualType: 'accessor' });
	}
	if (!descriptor.enumerable) {
		return Object.freeze({ type: 'invalid', actualType: 'non-enumerable' });
	}
	const value = descriptor.value;
	if (typeof value !== 'string' && typeof value !== 'number') {
		return Object.freeze({
			type: 'invalid',
			actualType: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
		});
	}
	try {
		assertSafeEntityId(value, `${context}.${idField}`);
	} catch {
		return Object.freeze({ type: 'invalid', actualType: typeof value });
	}
	return Object.freeze({ type: typeof value, value }) as DatastoreIdInventoryPayload;
}

function classifyDatastoreIdInventory(
	parsedKey: ParsedDatastoreIdInventoryKey,
	payload: DatastoreIdInventoryPayload,
	idField: string
): DatastoreIdInventoryClassificationResult {
	if (!parsedKey.activeTsCompatible) {
		return {
			classification: 'unsupported-key',
			reason: parsedKey.unsupportedReason ?? 'Datastore key cannot be represented by active-ts.'
		};
	}
	if (payload.type === 'missing') {
		return { classification: 'missing-payload-id', reason: `Payload field "${idField}" is missing.` };
	}
	if (payload.type === 'invalid') {
		return {
			classification: 'invalid-payload-id',
			reason: `Payload field "${idField}" is not a valid string or safe-integer entity ID.`
		};
	}
	const expectedType = parsedKey.leaf.storage === 'id' ? 'number' : 'string';
	const payloadText = String(payload.value);
	if (payloadText !== parsedKey.leaf.value) {
		return {
			classification: 'value-mismatch',
			reason: `Physical key and payload field "${idField}" have different values.`
		};
	}
	if (payload.type !== expectedType) {
		return {
			classification: 'type-mismatch',
			reason: `Physical key and payload field "${idField}" have matching text but different ID types.`
		};
	}
	return { classification: 'match', reason: '' };
}

function datastoreIdInventoryPageInfo(info: unknown): { more: boolean; cursor?: string } {
	if (!info || typeof info !== 'object' || Array.isArray(info)) {
		throw new ActiveTsValidationError('Datastore ID inventory query info must be an object.');
	}
	const record = info as Record<string, unknown>;
	const moreResults = ownOptionValue(record, 'moreResults');
	if (typeof moreResults !== 'string') {
		throw new ActiveTsValidationError('Datastore ID inventory query info.moreResults must be a string.');
	}
	if (moreResults === 'NO_MORE_RESULTS') return { more: false };
	if (
		moreResults !== 'NOT_FINISHED' &&
		moreResults !== 'MORE_RESULTS_AFTER_LIMIT' &&
		moreResults !== 'MORE_RESULTS_AFTER_CURSOR'
	) {
		throw new ActiveTsValidationError(
			`Datastore ID inventory query info.moreResults "${moreResults}" is not supported.`
		);
	}
	const rawCursor = ownOptionValue(record, 'endCursor');
	const cursor = assertSafeCursor(rawCursor, 'Datastore ID inventory query info.endCursor');
	if (!cursor) {
		throw new ActiveTsValidationError(
			'Datastore ID inventory query info.endCursor must be a non-empty string when more results are available.'
		);
	}
	return { more: true, cursor };
}

function assertPlainFactoryOptions(options: object, context: string) {
	const prototype = Object.getPrototypeOf(options);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsConfigurationError(`${context} must be a plain object.`);
	}
}

function assertNoSymbolOptions(record: Record<string, unknown>, context: string) {
	if (Object.getOwnPropertySymbols(record).length) {
		throw new ActiveTsConfigurationError(`${context} cannot contain symbol fields.`);
	}
}

function assertKnownOptions(record: Record<string, unknown>, allowedKeys: readonly string[], context: string) {
	const allowed = new Set<string>();
	for (const key of allowedKeys) SET_ADD.call(allowed, key);
	for (const property of Object.getOwnPropertyNames(record)) {
		if (!SET_HAS.call(allowed, property)) {
			throw new ActiveTsConfigurationError(`${context} contains unknown option "${property}".`);
		}
	}
}

function snapshotSdkOptions(value: unknown, context: string) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ActiveTsConfigurationError(`${context} must be a plain object.`);
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsConfigurationError(`${context} must be a plain object.`);
	}
	const record = value as Record<string, unknown>;
	assertNoSymbolOptions(record, context);
	const snapshot = Object.create(null) as Record<string, unknown>;
	for (const key of Object.getOwnPropertyNames(record)) {
		const descriptor = Object.getOwnPropertyDescriptor(record, key);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsConfigurationError(`${context}.${key} must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsConfigurationError(`${context}.${key} must be enumerable.`);
		}
		defineDataProperty(snapshot, key, descriptor.value, { enumerable: true, configurable: true, writable: true });
	}
	return snapshot;
}

function ownFactoryOptionValue(record: Record<string, unknown>, key: string, context: string) {
	if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(record, key);
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsConfigurationError(`${context} "${key}" must be a data property.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsConfigurationError(`${context} "${key}" must be enumerable.`);
	}
	return descriptor.value;
}

function normalizeDatastoreClient(client: unknown) {
	if (!client || typeof client !== 'object' || Array.isArray(client)) {
		throw new ActiveTsConfigurationError('Datastore adapter client must be an object.');
	}
	const key = datastoreMethod(client, 'key', 'Datastore adapter client.key');
	const get = datastoreMethod(client, 'get', 'Datastore adapter client.get');
	const deleteEntity = datastoreMethod(client, 'delete', 'Datastore adapter client.delete');
	const createQuery = datastoreMethod(client, 'createQuery', 'Datastore adapter client.createQuery');
	const runQuery = datastoreMethod(client, 'runQuery', 'Datastore adapter client.runQuery');
	const createAggregationQuery = datastoreOptionalMethod(
		client,
		'createAggregationQuery',
		'Datastore adapter client.createAggregationQuery'
	);
	const runAggregationQuery = datastoreOptionalMethod(
		client,
		'runAggregationQuery',
		'Datastore adapter client.runAggregationQuery'
	);
	const insert = datastoreOptionalMethod(client, 'insert', 'Datastore adapter client.insert');
	const update = datastoreMethod(client, 'update', 'Datastore adapter client.update');
	const upsert = datastoreOptionalMethod(client, 'upsert', 'Datastore adapter client.upsert')
		?? datastoreOptionalMethod(client, 'save', 'Datastore adapter client.save');
	return Object.freeze({
		key,
		get,
		delete: deleteEntity,
		createQuery,
		runQuery,
		createAggregationQuery,
		runAggregationQuery,
		insert,
		update,
		upsert
	});
}

function normalizeDatastoreTransaction(transaction: unknown, rootClient: NormalizedDatastoreClient) {
	if (!transaction || typeof transaction !== 'object' || Array.isArray(transaction)) {
		throw new ActiveTsConfigurationError('Datastore transaction must be an object.');
	}
	const run = datastoreMethod(transaction, 'run', 'Datastore transaction.run');
	const commit = datastoreMethod(transaction, 'commit', 'Datastore transaction.commit');
	const rollback = datastoreMethod(transaction, 'rollback', 'Datastore transaction.rollback');
	const get = datastoreMethod(transaction, 'get', 'Datastore transaction.get');
	const deleteEntity = datastoreMethod(transaction, 'delete', 'Datastore transaction.delete');
	const createQuery = datastoreOptionalMethod(transaction, 'createQuery', 'Datastore transaction.createQuery');
	const runQuery = datastoreMethod(transaction, 'runQuery', 'Datastore transaction.runQuery');
	const createAggregationQuery = datastoreOptionalMethod(
		transaction,
		'createAggregationQuery',
		'Datastore transaction.createAggregationQuery'
	);
	const runAggregationQuery = datastoreOptionalMethod(
		transaction,
		'runAggregationQuery',
		'Datastore transaction.runAggregationQuery'
	);
	const insert = datastoreOptionalMethod(transaction, 'insert', 'Datastore transaction.insert');
	const update = datastoreMethod(transaction, 'update', 'Datastore transaction.update');
	const upsert = datastoreOptionalMethod(transaction, 'upsert', 'Datastore transaction.upsert')
		?? datastoreOptionalMethod(transaction, 'save', 'Datastore transaction.save');
	return Object.freeze({
		run,
		commit,
		rollback,
		client: normalizeDatastoreClient({
			key: rootClient.key,
			get,
			delete: deleteEntity,
			createQuery: createQuery ?? rootClient.createQuery,
			runQuery,
			createAggregationQuery,
			runAggregationQuery,
			insert,
			update,
			upsert
		})
	});
}

function createDatastoreTransactionNativeReadClient(client: NormalizedDatastoreClient): NormalizedDatastoreClient {
	let guarded!: NormalizedDatastoreClient;
	const nativeBuilderTargets = new WeakMap<object, object>();
	const unwrapBuilder = (value: any) => {
		if (!value || (typeof value !== 'object' && typeof value !== 'function')) return value;
		return WEAKMAP_GET.call(nativeBuilderTargets, value) ?? value;
	};
	const unwrapFirstBuilderArg = (args: any[]) => {
		const unwrapped = new Array(args.length);
		for (let index = 0; index < args.length; index++) {
			unwrapped[index] = index === 0 ? unwrapBuilder(args[index]) : args[index];
		}
		return unwrapped;
	};
	const trackRead = (
		operation: string,
		method: (...args: any[]) => any,
		args: any[]
	) => trackAdapterTransactionOperation(guarded, async () => {
		for (let index = 0; index < args.length; index++) {
			if (typeof args[index] !== 'function') continue;
			throw new ActiveTsConfigurationError(
				`Datastore transaction native client.${operation} does not support callback overloads. Use the returned Promise.`
			);
		}
		const invocationArgs = operation === 'runQuery' || operation === 'runAggregationQuery'
			? unwrapFirstBuilderArg(args)
			: args;
		return await method(...invocationArgs);
	});
	const rejectWrite = () => trackAdapterTransactionOperation(guarded, async () => {
		throw new ActiveTsConfigurationError(
			'Datastore transaction native store reads cannot perform SDK writes. Use active-ts transaction write methods.'
		);
	});
	// SDK builders retain their raw scope, so execution must route back through the guarded client.
	const guardBuilder = (
		builder: any,
		kind: 'query' | 'aggregation',
		sourceQuery?: any
	) => {
		if (!builder || typeof builder !== 'object' || Array.isArray(builder)) {
			throw new ActiveTsConfigurationError(`Datastore transaction native ${kind} builder must be an object.`);
		}
		let proxy!: object;
		proxy = new Proxy(Object.create(null), {
			get(_target, property) {
				if (kind === 'query' && property === 'scope') return guarded;
				if (kind === 'aggregation' && property === 'query' && sourceQuery !== undefined) return sourceQuery;
				if (property === 'constructor' || property === '__proto__') return undefined;
				if (property === 'run') {
					return (...args: any[]) => kind === 'query'
						? guarded.runQuery(proxy, ...args)
						: guarded.runAggregationQuery!(proxy, ...args);
				}
				if (property === 'runStream') {
					return () => {
						throw new ActiveTsConfigurationError(
							`Datastore transaction native ${kind} builder.runStream is not supported. Use the Promise-returning run() method.`
						);
					};
				}
				const value = Reflect.get(builder, property, builder);
				if (typeof value !== 'function') return value;
				return (...args: any[]) => {
					const result = Reflect.apply(value, builder, args);
					return result === builder ? proxy : result;
				};
			}
		});
		WEAKMAP_SET.call(nativeBuilderTargets, proxy, builder);
		return proxy;
	};
	const createAggregationQuery = client.createAggregationQuery;
	const runAggregationQuery = client.runAggregationQuery;
	guarded = Object.freeze({
		key: (...args: any[]) => client.key(...args),
		get: (...args: any[]) => trackRead('get', client.get, args),
		delete: rejectWrite,
		createQuery: (...args: any[]) => guardBuilder(client.createQuery(...args), 'query'),
		runQuery: (...args: any[]) => trackRead('runQuery', client.runQuery, args),
		createAggregationQuery: createAggregationQuery
			? (...args: any[]) => guardBuilder(
					createAggregationQuery(...unwrapFirstBuilderArg(args)),
					'aggregation',
					args[0]
				)
			: undefined,
		runAggregationQuery: runAggregationQuery
			? (...args: any[]) => trackRead('runAggregationQuery', runAggregationQuery, args)
			: undefined,
		insert: client.insert ? rejectWrite : undefined,
		update: rejectWrite,
		upsert: client.upsert ? rejectWrite : undefined
	});
	return guarded;
}

function normalizeDatastoreQuery(query: unknown, context: string) {
	if (!query || typeof query !== 'object' || Array.isArray(query)) {
		throw new ActiveTsConfigurationError(`${context} must be an object.`);
	}
	return query;
}

function datastoreQueryHasMore(info: unknown) {
	if (info === undefined || info === null) return false;
	if (typeof info !== 'object' || Array.isArray(info)) {
		throw new ActiveTsValidationError('Datastore query info must be an object.');
	}
	const moreResults = ownOptionValue(info as Record<string, unknown>, 'moreResults');
	if (moreResults === undefined) return false;
	if (typeof moreResults !== 'string') {
		throw new ActiveTsValidationError('Datastore query info.moreResults must be a string.');
	}
	if (moreResults === 'NO_MORE_RESULTS') return false;
	if (
		moreResults === 'NOT_FINISHED' ||
		moreResults === 'MORE_RESULTS_AFTER_LIMIT' ||
		moreResults === 'MORE_RESULTS_AFTER_CURSOR'
	) return true;
	throw new ActiveTsValidationError(`Datastore query info.moreResults "${moreResults}" is not supported.`);
}

function encodeDatastoreContinuationCursor(cursor: unknown) {
	const safeCursor = assertSafeCursor(cursor, 'Datastore SDK cursor');
	if (!safeCursor) {
		throw new ActiveTsValidationError('Datastore SDK cursor must be a non-empty string.');
	}
	const payload = Object.create(null);
	defineDataProperty(payload, 'v', 1, { enumerable: true, configurable: true, writable: true });
	defineDataProperty(payload, 'kind', 'datastore', { enumerable: true, configurable: true, writable: true });
	defineDataProperty(payload, 'cursor', safeCursor, { enumerable: true, configurable: true, writable: true });
	const encoded = Buffer.from(JSON_STRINGIFY(payload), 'utf8').toString('base64url');
	return assertSafeCursor(encoded, 'Datastore continuation cursor')!;
}

function decodeDatastoreContinuationCursor(cursor: string) {
	const invalid = () => new ActiveTsConfigurationError('Invalid Datastore continuation cursor.');
	let decoded: unknown;
	try {
		decoded = JSON_PARSE(Buffer.from(cursor, 'base64url').toString('utf8'));
	} catch {
		throw invalid();
	}
	if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw invalid();
	if (Object.getPrototypeOf(decoded) !== Object.prototype) throw invalid();
	if (Object.getOwnPropertySymbols(decoded).length) throw invalid();
	const properties = Object.getOwnPropertyNames(decoded);
	if (properties.length !== 3) throw invalid();
	for (let index = 0; index < properties.length; index++) {
		const property = properties[index];
		if (property !== 'v' && property !== 'kind' && property !== 'cursor') throw invalid();
	}
	const record = decoded as Record<string, unknown>;
	let version: unknown;
	let kind: unknown;
	let rawCursor: unknown;
	try {
		version = ownOptionValue(record, 'v');
		kind = ownOptionValue(record, 'kind');
		rawCursor = ownOptionValue(record, 'cursor');
	} catch {
		throw invalid();
	}
	if (version !== 1 || kind !== 'datastore') throw invalid();
	try {
		const safeCursor = assertSafeCursor(rawCursor, 'Datastore SDK cursor');
		if (!safeCursor) throw invalid();
		return safeCursor;
	} catch {
		throw invalid();
	}
}

function datastoreDirectQueryPageInfo(
	info: unknown,
	startCursor: string | undefined,
	rowCount: number
): { more: boolean; cursor?: string } {
	if (!datastoreQueryHasMore(info)) return { more: false };
	if (!info || typeof info !== 'object' || Array.isArray(info)) {
		throw new ActiveTsValidationError('Datastore query info must be an object.');
	}
	const rawEndCursor = ownOptionValue(info as Record<string, unknown>, 'endCursor');
	const endCursor = assertSafeCursor(rawEndCursor, 'Datastore query info.endCursor');
	if (!endCursor) {
		throw new ActiveTsValidationError(
			'Datastore query info.endCursor must be a non-empty string when more results are available.'
		);
	}
	if (startCursor === endCursor) {
		// The emulator repeats its terminal cursor with an empty page.
		if (rowCount === 0) return { more: false };
		throw new ActiveTsValidationError('Datastore query returned a repeated non-empty page cursor.');
	}
	return { more: true, cursor: encodeDatastoreContinuationCursor(endCursor) };
}

function datastoreQueryEntities(list: unknown) {
	if (!Array.isArray(list)) throw new ActiveTsValidationError('Datastore query result list must be an array.');
	return snapshotArrayInput(list, 'Datastore query result list');
}

function datastoreResultTuple(value: unknown, context: string) {
	return snapshotArrayInput(value, `${context} result`);
}

function datastoreRequiredResultSlot(value: unknown, context: string, index: number) {
	const tuple = datastoreResultTuple(value, context);
	if (!Object.prototype.hasOwnProperty.call(tuple, index)) {
		throw new ActiveTsValidationError(`${context} result[${index}] is required.`);
	}
	return tuple[index];
}

function isDatastoreAlreadyExistsError(error: unknown) {
	const code = ownErrorValue(error, 'code');
	return code === 6 || code === 'already-exists' || code === 'ALREADY_EXISTS';
}

function isDatastoreNotFoundError(error: unknown) {
	const code = ownErrorValue(error, 'code');
	return code === 5 || code === 'not-found' || code === 'NOT_FOUND';
}

function datastoreOptionalMethod(target: object, method: string, context: string) {
	const value = datastoreMember(target, method, context, { requireEnumerableOwn: true });
	if (value === undefined) return undefined;
	if (typeof value !== 'function') {
		throw new ActiveTsConfigurationError(`${context} must be a function.`);
	}
	return value.bind(target);
}

function readDatastoreProjectId(client: object): string | undefined {
	const descriptor = Object.getOwnPropertyDescriptor(client, 'options');
	if (!descriptor) return undefined;
	if (!('value' in descriptor)) {
		throw new ActiveTsConfigurationError('Datastore adapter client.options must be a data property.');
	}
	if (!descriptor.enumerable && descriptor.value !== undefined) {
		throw new ActiveTsConfigurationError('Datastore adapter client.options must be enumerable.');
	}
	const options = descriptor.value;
	if (options === undefined) return undefined;
	if (!options || typeof options !== 'object' || Array.isArray(options)) {
		throw new ActiveTsConfigurationError('Datastore adapter client.options must be an object.');
	}
	const projectId = ownFactoryOptionValue(
		options as Record<string, unknown>,
		'projectId',
		'Datastore adapter client.options'
	);
	if (projectId === undefined) return undefined;
	if (typeof projectId !== 'string' || !projectId || projectId.includes('\0')) {
		throw new ActiveTsConfigurationError(
			'Datastore adapter client.options.projectId must be a non-empty string without null bytes.'
		);
	}
	return projectId;
}

function readDatastoreDatabaseId(client: object): string | null | undefined {
	const getDatabaseId = datastoreOptionalMethod(
		client,
		'getDatabaseId',
		'Datastore adapter client.getDatabaseId'
	);
	if (!getDatabaseId) return undefined;
	let databaseId: unknown;
	try {
		databaseId = getDatabaseId();
	} catch (error) {
		throw new ActiveTsConfigurationError(
			`Datastore adapter client.getDatabaseId failed: ${safeErrorMessage(error)}`
		);
	}
	if (databaseId === undefined) return null;
	if (typeof databaseId !== 'string' || !databaseId || databaseId.includes('\0')) {
		throw new ActiveTsConfigurationError(
			'Datastore adapter client.getDatabaseId must return a non-empty string without null bytes, or undefined for the default database.'
		);
	}
	return databaseId;
}

function datastoreMethod(target: object, method: string, context: string) {
	const value = datastoreMember(target, method, context, { requireEnumerableOwn: true });
	if (typeof value !== 'function') {
		throw new ActiveTsConfigurationError(`${context} must be a function.`);
	}
	return value.bind(target);
}

function datastoreMember(
	target: object,
	property: string,
	context: string,
	options: { requireEnumerableOwn?: boolean } = {}
) {
	let current: object | null = target;
	while (current && current !== Object.prototype) {
		if (Object.prototype.hasOwnProperty.call(current, property)) {
			const descriptor = Object.getOwnPropertyDescriptor(current, property);
			if (!descriptor || !('value' in descriptor)) {
				throw new ActiveTsConfigurationError(`${context} must be a data property.`);
			}
			if (options.requireEnumerableOwn && current === target && !descriptor.enumerable && descriptor.value !== undefined) {
				throw new ActiveTsConfigurationError(`${context} must be enumerable.`);
			}
			return descriptor.value;
		}
		current = Object.getPrototypeOf(current);
	}
	return undefined;
}

function ownOptionValue(record: Record<string, unknown>, key: string) {
	if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(record, key);
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsValidationError(`${key} must be a data property.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsValidationError(`${key} must be enumerable.`);
	}
	return descriptor.value;
}

async function resolveDatastoreKeySymbol() {
	try {
		const mod = await optionalImport('@google-cloud/datastore', 'DatastoreStoreAdapter');
		const key = mod.Datastore?.KEY;
		if (typeof key === 'symbol') return key;
	} catch {
		// Injected clients can still work without the optional peer when rows include the model id field.
	}
	return Symbol.for('active-ts.datastore.key');
}
