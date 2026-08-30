import { BatchLoader } from './batch-loader.js';
import {
	ActiveTsCommittedTransactionError,
	ActiveTsConfigurationError,
	ActiveTsValidationError,
	safeErrorMessage
} from './errors.js';
import {
	markSavepointRollbackUnconfirmed,
	savepointRollbackUnconfirmed,
	transactionRollbackSkipped
} from './error-classification.js';
import { runHookList, sanitizeHooks, toHookList } from './hooks.js';
import { assertModelConstructor, getModelMetaVersion, resolveModelMeta } from './metadata.js';
import { applyFieldCodecs, encodeAggregatePlanFieldCodecs, encodeQueryPlanFieldCodecs } from './field-codecs.js';
import {
	assertCacheableValue,
	assertDefinedCacheValue,
	assertPlainDataObject,
	assertPortableStoredData,
	assertSafeCacheKey,
	assertSafeCursor,
	assertSafeEntityId,
	assertSafeEntityIdArray,
	assertSafeFieldPath,
	assertSafeResultCount,
	assertSafeSchemaIdentifier,
	assertSafeTtl,
	cloneSafeData,
	cloneSafeDataObject,
	cloneSafeDataObjectWithoutActiveEntityKey,
	clonePortableDataObject,
	defineDataProperty
} from './safe-keys.js';
import { assertNoOverlappingFieldPaths, entityIdKey, valueFor } from './query-utils.js';
import { isPartialModel, markPartialModel } from './partial-model.js';
import { applyFieldTypeTransforms, normalizeAggregatePlanFieldTypes, normalizeQueryPlanFieldTypes } from './field-types.js';
import {
	ACTIVE_TS_MODEL_INSTANCE,
	markDatastoreHistoricalModel,
	MODEL_DATASTORE_WRITE_ANCESTOR,
	MODEL_PERSISTED_TOKEN,
	setTransactionModelTracker
} from './model-internal.js';
import { SOURCE_MODEL, staticMarkerValue } from './model-markers.js';
import {
	datastoreKeyIdentity,
	datastoreScopedAncestorMatches,
	normalizeDatastoreKey,
	normalizeDatastoreReadPolicy
} from './datastore-key.js';
import { searchCapability, storeCapability } from './capabilities.js';
import { isSoftDeletePlanGuardHook } from './soft-delete-guard.js';
import { datastoreSchemaAncestorModes, normalizeSchemaModels, normalizeSchemaPlan } from './schema-utils.js';
import { normalizeStoreSchemaApplyOptions } from './schema-options.js';
import {
	assertSafeSearchQuery,
	assertSearchOptionsSupported,
	assertSearchWriteOptionsSupported,
	CONTEXT_BOUND_SEARCH_DATASTORE_NAMESPACE,
	datastoreSearchHitDocumentIdentityOrForced,
	markSearchAdapterSource,
	markSearchDocumentIdentity,
	nativeSearchSourceStore,
	normalizeSearchAdapterOptions,
	normalizeSearchWriteOptions,
	projectSearchDocument,
	rebindNativeSearchAdapter,
	searchDocumentIdentity,
	searchAdapterSourceChain,
	searchIndexAdapterKind,
	withDatastoreSearchNamespace,
	withSearchIndexesForAdapter
} from './search-utils.js';
import { snapshotArrayInput } from './array-input.js';
import { cloneNativePayload } from './native-payload.js';
import { clonePlanMeta } from './plan-meta.js';
import { dateIsoString } from './date-intrinsics.js';
import {
	iterableToArray,
	MAP_CLEAR,
	MAP_DELETE,
	MAP_FOR_EACH,
	MAP_GET,
	MAP_HAS,
	MAP_KEYS,
	MAP_SET,
	MAP_SIZE,
	MAP_VALUES,
	SET_ADD,
	SET_CLEAR,
	SET_DELETE,
	SET_FOR_EACH,
	SET_HAS,
	SET_SIZE,
	WEAKMAP_DELETE,
	WEAKMAP_GET,
	WEAKMAP_SET,
	WEAKSET_ADD,
	WEAKSET_HAS
} from './collection-intrinsics.js';
import { cacheAdapterSource, cacheAdapterSourceChain, markCacheAdapterSource } from './cache-utils.js';
import {
	cacheSupportsVersioning,
	normalizeCacheVersionedEntries,
	normalizeCacheVersionedSetResult,
	normalizeCacheVersionedValues
} from './cache-versioning.js';
import { markStoreAdapterSource, storeAdapterSource, storeAdapterSourceChain } from './store-utils.js';
import {
	assertStoreNativeAdapterTag,
	assertStoreDataMatchesId,
	assertStoreDataHasModelId,
	createCloseGuardedStoreAdapter,
	createTransactionOperationTracker,
	datastorePayloadCanResolveAncestor,
	datastorePayloadResolvedAncestor,
	datastoreWritePayloadMatchesScopedAncestor,
	normalizeStoreAggregatePlan,
	normalizeStoreAggregateResult,
	normalizeStoreQueryPlan,
	normalizeStoreQueryResultForModel,
	normalizeStoreReadOptions,
	normalizeStoreTransactionOptions,
	normalizeStoreWriteOptions,
	markStoreTrustsDatastoreEntityKeyRows,
	markAdapterTransactionOperationCarrier,
	observeAdapterTransactionPromiseSettlement,
	storeTrustsDatastoreEntityKeyRows,
	stripStoreNativeAdapterTag,
	validateStoreQueryReadOptions
} from './store-options.js';
import { snapshotAdapterModel } from './adapter-model.js';
import { OBJECT_ENTRIES, OBJECT_GET_OWN_PROPERTY_DESCRIPTOR } from './object-intrinsics.js';
import {
	ACTIVE_CONTEXT_INTERNALS,
	transactionContextStorage,
	type ActiveContextInternalAccess
} from './context-internal.js';
import {
	type ActiveTsConfig,
	type ActiveTsHook,
	type ActiveTsPlugin,
	type AggregatePlan,
	type ActiveTsHookName,
	type ActiveTsHookPayload,
	type CacheAdapter,
	type CacheWriteOptions,
	type DatastoreKey,
	type EntityId,
	type ModelConstructor,
	type QueryPlan,
	type QueryResult,
	type ResolvedModelMeta,
	type SchemaChange,
	type SchemaPlan,
	type SchemaSyncMode,
	type SearchCapabilities,
	type SearchAdapter,
	type SearchOptions,
	type SortDirection,
	type StoreCapabilities,
	type StoreAdapter,
	type StoreReadOptions,
	type StoreTransactionOptions,
	type StoreWriteOptions,
	type TransactionOptions
} from './types.js';

type ReadOptions = {
	partial?: boolean;
	fieldCodecs?: boolean;
};

type DeferredTask = () => Promise<void> | void;
type TransactionOperationTracker = ReturnType<typeof createTransactionOperationTracker>;
type TransactionState = {
	root: ActiveContext;
	parent?: TransactionState;
	storeName: string;
	context?: ActiveContext;
	internalAfterCommit: DeferredTask[];
	afterCommit: DeferredTask[];
	afterRollback: DeferredTask[];
	modelInstances: Set<object>;
	dirtyCacheKeys: Set<string>;
	cacheInvalidations: Map<string, { meta: ResolvedModelMeta; id: EntityId; task: DeferredTask }>;
	cacheKeyOwners: Map<string, string>;
	entityCacheKeys: Map<string, string>;
	callbackOperationState: { closed?: string };
	callbackOperations: TransactionOperationTracker;
	isolation?: StoreTransactionOptions['isolation'];
	readOnly: boolean;
	rollbackOnlyError?: unknown;
	closed?: 'committed' | 'released' | 'rolled back' | 'failed';
};

async function waitForContextOperations(state: TransactionState) {
	do {
		await state.callbackOperations.waitForPendingOperations();
	} while (state.callbackOperations.hasPendingOperations());
}
const CONTEXT_BOUND_STORE_SOURCE = Symbol('active-ts.context-bound-store-source');
const CONTEXT_BOUND_CACHE_SOURCE = Symbol('active-ts.context-bound-cache-source');
const CONTEXT_BOUND_SEARCH_SOURCE = Symbol('active-ts.context-bound-search-source');
const TRANSACTION_READ_ONLY_STORE = Symbol('active-ts.transaction-read-only-store');
const TRANSACTION_SCOPED_SEARCH_ADAPTER = Symbol('active-ts.transaction-scoped-search-adapter');
const TRANSACTION_NATIVE_SEARCH_STORE_ROUTE = Symbol('active-ts.transaction-native-search-store-route');
const UNBOUND_TRANSACTION_NATIVE_SEARCH_ADAPTER = Symbol('active-ts.unbound-transaction-native-search-adapter');
const STORE_CAPABILITY_KEYS: Array<keyof StoreCapabilities> = [
	'or',
	'contains',
	'arrayContains',
	'textContains',
	'jsonContains',
	'startsWith',
	'cursor',
	'offset',
	'select',
	'nestedFields',
	'numericComparisons',
	'aggregate',
	'transaction',
	'transactionConflictDetection',
	'savepoint',
	'uniqueIndex',
	'optimisticLock',
	'nullOperators',
	'missingFieldNulls',
	'native',
	'datastoreAncestor',
	'datastoreReadPolicy'
];
const SEARCH_CAPABILITY_KEYS: Array<Exclude<keyof SearchCapabilities, 'whereOperators'>> = [
	'where',
	'nestedFields',
	'numericComparisons',
	'nullOperators',
	'cursor',
	'native',
	'index',
	'revisionWrites'
];
const HOOK_PAYLOAD_INPUT_KEYS = capturedSet<keyof ActiveTsHookPayload>([
	'context',
	'model',
	'target',
	'id',
	'ids',
	'data',
	'patch',
	'plan',
	'query',
	'options',
	'result',
	'error',
	'operation',
	'meta'
]);
const ACTIVE_TS_CONFIG_KEYS = [
	'defaultStore',
	'defaultCache',
	'defaultSearch',
	'lazyWarnings',
	'schema',
	'batch',
	'aggregate',
	'stores',
	'caches',
	'search',
	'plugins',
	'queryPlanner',
	'cacheKey'
] as const;
const ACTIVE_CONTEXT_OPTION_KEYS = ['skipPluginSetup'] as const;
const SCHEMA_CONFIG_KEYS = ['autoSync'] as const;
const BATCH_CONFIG_KEYS = ['maxSize'] as const;
const AGGREGATE_CONFIG_KEYS = ['allowQueryFallback'] as const;
const QUERY_PLANNER_KEYS = ['routeQuery', 'routeAggregate', 'routeSearch', 'schemaSearchAdapters'] as const;
const SCHEMA_APPLY_OPTION_KEYS = ['mode'] as const;
const TRANSACTION_OPTION_KEYS = ['store', 'isolation', 'readOnly', 'timeoutMs', 'join', 'native'] as const;
const READ_OPTION_KEYS = ['partial', 'fieldCodecs'] as const;
const CACHE_WRITE_OPTION_KEYS = ['ttl'] as const;
const CONTEXT_QUERY_RESULT_KEYS = ['list', 'cursor', 'more', 'count', 'total'] as const;
const PLUGIN_OPTION_KEYS = ['name', 'setup', 'hooks'] as const;
const SUPPORTED_SEARCH_WHERE_OPERATORS = capturedSet<keyof NonNullable<SearchCapabilities['whereOperators']>>([
	'=',
	'!=',
	'>',
	'>=',
	'<',
	'<=',
	'in',
	'between',
	'isNull',
	'isNotNull',
	'contains',
	'arrayContains',
	'textContains',
	'jsonContains',
	'startsWith'
]);
const SAFE_PROMISE_RESOLVE = Promise.resolve.bind(Promise);
const SAFE_PROMISE_REJECT = Promise.reject.bind(Promise);
const PROMISE_THEN = Promise.prototype.then;
const NOOP_REJECTION_OBSERVER = () => undefined;
const SHARED_CACHE_INVALIDATION_EPOCH_LIMIT = 4096;
const SHARED_CACHE_INVALIDATION_FAILURE_LIMIT = 4096;
const adapterRegistrationSources = new WeakMap<object, object>();
const sharedCacheInvalidationEpochs = new WeakMap<object, {
	epochs: Map<string, number>;
	defaultEpoch: number;
}>();
const sharedCacheInvalidationFailures = new WeakMap<object, {
	failures: Set<string>;
	poisonGeneration: number;
	recovered: Map<string, number>;
}>();
const sharedCachePrimaryStores = new WeakMap<object, WeakSet<object>>();
const localStoreCacheScopes = new WeakMap<object, string>();
let nextLocalStoreCacheScope = 0;

function contextOperationPromise<T>(run: () => Promise<T>): Promise<T> {
	try {
		return run();
	} catch (error) {
		return SAFE_PROMISE_REJECT(error);
	}
}

function capturedSet<T>(values: readonly T[]) {
	const set = new Set<T>();
	for (const value of values) SET_ADD.call(set, value);
	return set;
}

function mapGet<TKey, TValue>(map: Map<TKey, TValue>, key: TKey) {
	return MAP_GET.call(map, key) as TValue | undefined;
}

function mapHas<TKey, TValue>(map: Map<TKey, TValue>, key: TKey) {
	return MAP_HAS.call(map, key) as boolean;
}

function mapSet<TKey, TValue>(map: Map<TKey, TValue>, key: TKey, value: TValue) {
	MAP_SET.call(map, key, value);
}

export function assertOutsideActiveTransaction(operation: string) {
	const ambient = transactionContextStorage.getStore();
	if (ambient) ambient.assertOutsideTransaction(operation);
}

function assertDirectIdReadAllowed(meta: ResolvedModelMeta) {
	if (!meta.datastore?.ancestor) return;
	throw new ActiveTsConfigurationError(
		`Datastore model "${meta.name}" declares an ancestor resolver, so direct id reads require an ancestor-aware query.`
	);
}

function normalizeAdapterRegistry<T>(
	registry: Record<string, T> | undefined,
	context: string,
	validate: (adapter: unknown, context: string) => asserts adapter is T,
	markSource: (adapter: T, source: T) => T
) {
	if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
		throw new ActiveTsConfigurationError(`${context} registry must be an object.`);
	}
	const prototype = Object.getPrototypeOf(registry);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsConfigurationError(`${context} registry must be a plain object.`);
	}
	if (Object.getOwnPropertySymbols(registry).length) {
		throw new ActiveTsConfigurationError(`${context} registry cannot contain symbol adapter names.`);
	}
	const normalized = Object.create(null) as Record<string, T>;
	for (const name of Object.getOwnPropertyNames(registry)) {
		const safeName = assertSafeSchemaIdentifier(name, context);
		const source = ownValue(registry, name, `${context} registry`);
		const adapter = snapshotAdapterRegistrationObject(source, `${context} "${safeName}"`);
		markSource(adapter as T, source as T);
		validate(adapter, `${context} "${safeName}"`);
		defineDataProperty(normalized, safeName, adapter, { enumerable: true, configurable: true, writable: true });
	}
	return Object.freeze(normalized);
}

function normalizeStoreAdapterRegistry(registry: Record<string, StoreAdapter> | undefined) {
	return normalizeAdapterRegistry(
		registry,
		'store adapter name',
		assertStoreAdapter,
		(adapter, source) => {
			const sourced = markStoreAdapterSource(adapter, source);
			return storeTrustsDatastoreEntityKeyRows(source)
				? markStoreTrustsDatastoreEntityKeyRows(sourced)
				: sourced;
		}
	);
}

function snapshotAdapterRegistrationObject(value: unknown, context: string): object {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ActiveTsConfigurationError(`${context} must be an adapter object.`);
	}
	const source = value as object;
	const snapshot = Object.create(Object.getPrototypeOf(source)) as object;
	WEAKMAP_SET.call(adapterRegistrationSources, snapshot, source);
	const properties: Array<string | symbol> = [];
	for (const property of Object.getOwnPropertyNames(source)) properties[properties.length] = property;
	for (const property of Object.getOwnPropertySymbols(source)) properties[properties.length] = property;
	for (const property of properties) {
		const sourceDescriptor = Object.getOwnPropertyDescriptor(source, property);
		if (!sourceDescriptor) continue;
		const descriptor = Object.create(null) as PropertyDescriptor;
		descriptor.enumerable = sourceDescriptor.enumerable;
		descriptor.configurable = true;
		if ('value' in sourceDescriptor) {
			descriptor.value = sourceDescriptor.value;
			descriptor.writable = true;
		} else {
			descriptor.get = sourceDescriptor.get?.bind(source);
			descriptor.set = sourceDescriptor.set?.bind(source);
		}
		Object.defineProperty(snapshot, property, descriptor);
	}
	return snapshot;
}

function adapterRegistrationSource(adapter: object) {
	return (WEAKMAP_GET.call(adapterRegistrationSources, adapter) as object | undefined) ?? adapter;
}

function assertRegisteredDefaultAdapter<T>(
	registry: Record<string, T> | undefined,
	name: string,
	kind: 'store' | 'cache' | 'search'
) {
	if (!registry || !ownValue(registry, name)) {
		throw new ActiveTsConfigurationError(`Default ${kind} adapter "${name}" is not registered.`);
	}
}

function assertAdapterObject(adapter: unknown, context: string): asserts adapter is { kind: unknown } {
	if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) {
		throw new ActiveTsConfigurationError(`${context} must be an adapter object.`);
	}
	const kind = adapterMember(adapter, 'kind', context);
	if (
		typeof kind !== 'string' ||
		!kind ||
		kind.includes('\0')
	) {
		throw new ActiveTsConfigurationError(`${context}.kind must be a non-empty string without null bytes.`);
	}
	try {
		defineAdapterProperty(adapter, 'kind', kind, true);
	} catch (error) {
		throw new ActiveTsConfigurationError(
			`${context}.kind could not be snapshotted: ${safeErrorMessage(error)}`
		);
	}
}

function functionProperty(adapter: object, property: string, context: string) {
	const value = adapterMember(adapter, property, context);
	if (typeof value !== 'function') {
		throw new ActiveTsConfigurationError(`${context}.${property} must be a function.`);
	}
	return value.bind(adapterRegistrationSource(adapter));
}

function snapshotFunctionProperty(adapter: object, property: string, context: string) {
	try {
		defineAdapterProperty(adapter, property, functionProperty(adapter, property, context), true);
	} catch (error) {
		throw new ActiveTsConfigurationError(
			`${context}.${property} could not be snapshotted: ${safeErrorMessage(error)}`
		);
	}
}

function snapshotOptionalFunctionProperty(
	adapter: object,
	property: string,
	context: string,
	options: { allowOwnAccessor?: boolean } = {}
) {
	const value = adapterMember(adapter, property, context, options);
	if (value !== undefined && typeof value !== 'function') {
		throw new ActiveTsConfigurationError(`${context}.${property} must be a function.`);
	}
	if (value === undefined) shadowAdapterProperty(adapter, property, context);
	else {
		try {
			defineAdapterProperty(adapter, property, value.bind(adapterRegistrationSource(adapter)), true);
		} catch (error) {
			throw new ActiveTsConfigurationError(
				`${context}.${property} could not be snapshotted: ${safeErrorMessage(error)}`
			);
		}
	}
}

function snapshotOptionalSchemaIdentifierProperty(adapter: object, property: string, context: string) {
	const value = adapterMember(adapter, property, context);
	if (value === undefined) {
		shadowAdapterProperty(adapter, property, context);
		return;
	}
	const safeValue = assertSafeSchemaIdentifier(value, `${context}.${property}`);
	try {
		defineAdapterProperty(adapter, property, safeValue, true);
	} catch (error) {
		throw new ActiveTsConfigurationError(
			`${context}.${property} could not be snapshotted: ${safeErrorMessage(error)}`
		);
	}
}

function assertStoreAdapter(adapter: unknown, context: string): asserts adapter is StoreAdapter {
	assertAdapterObject(adapter, context);
	const record = adapter as Record<string, unknown>;
	const allowContextAccessors = isContextBoundStoreAdapter(adapter);
	const cacheScope = adapterMember(record, 'cacheScope', context);
	if (cacheScope !== undefined && (typeof cacheScope !== 'string' || !cacheScope || cacheScope.includes('\0'))) {
		throw new ActiveTsConfigurationError(`${context}.cacheScope must be a non-empty string without null bytes.`);
	}
	try {
		defineAdapterProperty(record, 'cacheScope', cacheScope, cacheScope !== undefined);
	} catch (error) {
		throw new ActiveTsConfigurationError(
			`${context}.cacheScope could not be snapshotted: ${safeErrorMessage(error)}`
		);
	}
	const datastoreNamespace = adapterMember(record, 'datastoreNamespace', context);
	if (
		datastoreNamespace !== undefined &&
		(typeof datastoreNamespace !== 'string' || !datastoreNamespace || datastoreNamespace.includes('\0'))
	) {
		throw new ActiveTsConfigurationError(
			`${context}.datastoreNamespace must be a non-empty string without null bytes, or undefined for the default namespace.`
		);
	}
	try {
		defineAdapterProperty(
			record,
			'datastoreNamespace',
			datastoreNamespace,
			datastoreNamespace !== undefined
		);
	} catch (error) {
		throw new ActiveTsConfigurationError(
			`${context}.datastoreNamespace could not be snapshotted: ${safeErrorMessage(error)}`
		);
	}
	const datastoreProjectId = adapterMember(record, 'datastoreProjectId', context);
	if (
		datastoreProjectId !== undefined &&
		(typeof datastoreProjectId !== 'string' || !datastoreProjectId || datastoreProjectId.includes('\0'))
	) {
		throw new ActiveTsConfigurationError(
			`${context}.datastoreProjectId must be a non-empty string without null bytes, or undefined when unknown.`
		);
	}
	try {
		defineAdapterProperty(
			record,
			'datastoreProjectId',
			datastoreProjectId,
			datastoreProjectId !== undefined
		);
	} catch (error) {
		throw new ActiveTsConfigurationError(
			`${context}.datastoreProjectId could not be snapshotted: ${safeErrorMessage(error)}`
		);
	}
	const datastoreDatabaseId = adapterMember(record, 'datastoreDatabaseId', context);
	if (
		datastoreDatabaseId !== undefined &&
		datastoreDatabaseId !== null &&
		(typeof datastoreDatabaseId !== 'string' || !datastoreDatabaseId || datastoreDatabaseId.includes('\0'))
	) {
		throw new ActiveTsConfigurationError(
			`${context}.datastoreDatabaseId must be a non-empty string without null bytes, null for the default database, or undefined when unknown.`
		);
	}
	try {
		defineAdapterProperty(
			record,
			'datastoreDatabaseId',
			datastoreDatabaseId,
			datastoreDatabaseId !== undefined
		);
	} catch (error) {
		throw new ActiveTsConfigurationError(
			`${context}.datastoreDatabaseId could not be snapshotted: ${safeErrorMessage(error)}`
		);
	}
	const datastoreKeyEncoding = adapterMember(record, 'datastoreKeyEncoding', context);
	if (
		datastoreKeyEncoding !== undefined &&
		datastoreKeyEncoding !== 'active-ts' &&
		datastoreKeyEncoding !== 'native'
	) {
		throw new ActiveTsConfigurationError(
			`${context}.datastoreKeyEncoding must be "active-ts", "native", or undefined when unknown.`
		);
	}
	try {
		defineAdapterProperty(
			record,
			'datastoreKeyEncoding',
			datastoreKeyEncoding,
			datastoreKeyEncoding !== undefined
		);
	} catch (error) {
		throw new ActiveTsConfigurationError(
			`${context}.datastoreKeyEncoding could not be snapshotted: ${safeErrorMessage(error)}`
		);
	}
	for (const property of ['get', 'getMany', 'query', 'create', 'update', 'delete']) {
		snapshotFunctionProperty(record, property, context);
	}
	snapshotOptionalFunctionProperty(record, 'aggregate', context);
	snapshotOptionalFunctionProperty(record, 'transaction', context, { allowOwnAccessor: allowContextAccessors });
	snapshotOptionalFunctionProperty(record, 'savepoint', context, { allowOwnAccessor: allowContextAccessors });
	const schema = adapterMember(record, 'schema', context);
	if (schema !== undefined) {
		if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
			throw new ActiveTsConfigurationError(`${context}.schema must be an object.`);
		}
		const schemaSnapshot = snapshotAdapterRegistrationObject(schema, `${context}.schema`);
		snapshotFunctionProperty(schemaSnapshot, 'plan', `${context}.schema`);
		snapshotFunctionProperty(schemaSnapshot, 'apply', `${context}.schema`);
		try {
			defineAdapterProperty(record, 'schema', schemaSnapshot, true);
		} catch (error) {
			throw new ActiveTsConfigurationError(
				`${context}.schema could not be snapshotted: ${safeErrorMessage(error)}`
			);
		}
	} else {
		shadowAdapterProperty(record, 'schema', context);
	}
	const capabilities = normalizeStoreCapabilities(
		adapterMember(record, 'capabilities', context, { allowOwnAccessor: allowContextAccessors }),
		`${context}.capabilities`
	) ?? Object.freeze({});
	assertStoreCapabilityMethods(record as StoreAdapter, capabilities, context);
	replaceAdapterCapabilities(adapter, capabilities, context);
}

function assertCacheAdapter(adapter: unknown, context: string): asserts adapter is CacheAdapter {
	assertAdapterObject(adapter, context);
	const record = adapter as Record<string, unknown>;
	for (const property of ['getMany', 'setMany', 'deleteMany']) {
		snapshotFunctionProperty(record, property, context);
	}
	for (const property of ['getManyVersioned', 'setManyVersioned', 'invalidateMany']) {
		snapshotOptionalFunctionProperty(record, property, context);
	}
	let versionedMethodCount = 0;
	for (const method of [record.getManyVersioned, record.setManyVersioned, record.invalidateMany]) {
		if (method !== undefined) versionedMethodCount++;
	}
	if (versionedMethodCount !== 0 && versionedMethodCount !== 3) {
		throw new ActiveTsConfigurationError(
			`${context} must provide getManyVersioned(), setManyVersioned(), and invalidateMany() together.`
		);
	}
	snapshotOptionalFunctionProperty(record, 'codecKey', context);
}

function assertSearchAdapter(adapter: unknown, context: string): asserts adapter is SearchAdapter {
	assertAdapterObject(adapter, context);
	const record = adapter as Record<string, unknown>;
	const allowContextAccessors = isContextBoundSearchAdapter(adapter);
	for (const property of ['search', 'index', 'delete']) {
		snapshotFunctionProperty(record, property, context);
	}
	snapshotOptionalSchemaIdentifierProperty(record, 'searchIndexKind', context);
	const schema = adapterMember(record, 'schema', context);
	if (schema !== undefined) {
		if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
			throw new ActiveTsConfigurationError(`${context}.schema must be an object.`);
		}
		const schemaSnapshot = snapshotAdapterRegistrationObject(schema, `${context}.schema`);
		snapshotFunctionProperty(schemaSnapshot, 'plan', `${context}.schema`);
		snapshotFunctionProperty(schemaSnapshot, 'apply', `${context}.schema`);
		try {
			defineAdapterProperty(record, 'schema', schemaSnapshot, true);
		} catch (error) {
			throw new ActiveTsConfigurationError(
				`${context}.schema could not be snapshotted: ${safeErrorMessage(error)}`
			);
		}
	} else {
		shadowAdapterProperty(record, 'schema', context);
	}
	snapshotOptionalFunctionProperty(record, 'syncSchema', context);
	replaceAdapterCapabilities(
		adapter,
		normalizeSearchCapabilities(
			adapterMember(record, 'capabilities', context, { allowOwnAccessor: allowContextAccessors }),
			`${context}.capabilities`
		) ?? Object.freeze({}),
		context
	);
}

function normalizeStoreCapabilities(value: unknown, context: string): StoreCapabilities | undefined {
	if (value === undefined) return undefined;
	const record = assertPlainCapabilityObject(value, context);
	assertKnownCapabilityKeys(record, STORE_CAPABILITY_KEYS, context);
	const normalized: StoreCapabilities = {};
	for (const key of STORE_CAPABILITY_KEYS) {
		const capability = ownValue(record, key, context);
		if (capability === undefined) continue;
		if (typeof capability !== 'boolean') {
			throw new ActiveTsConfigurationError(`${context}.${key} must be a boolean.`);
		}
		normalized[key] = capability;
	}
	return Object.freeze(normalized);
}

function assertStoreCapabilityMethods(adapter: StoreAdapter, capabilities: StoreCapabilities, context: string) {
	if (capabilities.aggregate === true && typeof adapter.aggregate !== 'function') {
		throw new ActiveTsConfigurationError(
			`${context} advertises aggregate support but does not expose aggregate().`
		);
	}
	if (capabilities.transaction === true && typeof adapter.transaction !== 'function') {
		throw new ActiveTsConfigurationError(
			`${context} advertises transaction support but does not expose transaction().`
		);
	}
	if (capabilities.savepoint === true && typeof adapter.savepoint !== 'function') {
		throw new ActiveTsConfigurationError(
			`${context} advertises savepoint support but does not expose savepoint().`
		);
	}
}

function normalizeSearchCapabilities(value: unknown, context: string): SearchCapabilities | undefined {
	if (value === undefined) return undefined;
	const record = assertPlainCapabilityObject(value, context);
	assertKnownCapabilityKeys(record, [...SEARCH_CAPABILITY_KEYS, 'whereOperators'], context);
	const normalized: SearchCapabilities = {};
	for (const key of SEARCH_CAPABILITY_KEYS) {
		const capability = ownValue(record, key, context);
		if (capability === undefined) continue;
		if (typeof capability !== 'boolean') {
			throw new ActiveTsConfigurationError(`${context}.${key} must be a boolean.`);
		}
		normalized[key] = capability;
	}
	const whereOperators = ownValue(record, 'whereOperators', context);
	if (whereOperators !== undefined) {
		const operators = assertPlainCapabilityObject(whereOperators, `${context}.whereOperators`);
		const normalizedOperators: NonNullable<SearchCapabilities['whereOperators']> = {};
		for (const operator of Object.keys(operators)) {
			const enabled = ownValue(operators, operator, `${context}.whereOperators`);
			if (!isSupportedOperatorName(operator)) {
				throw new ActiveTsConfigurationError(`${context}.whereOperators contains unknown operator "${operator}".`);
			}
			if (typeof enabled !== 'boolean') {
				throw new ActiveTsConfigurationError(`${context}.whereOperators.${operator} must be a boolean.`);
			}
			normalizedOperators[operator] = enabled;
		}
		normalized.whereOperators = Object.freeze(normalizedOperators);
	}
	return Object.freeze(normalized);
}

function assertPlainCapabilityObject(value: unknown, context: string): Record<string, unknown> {
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
	for (const property of Object.getOwnPropertyNames(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, property);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsConfigurationError(`${context}.${property} must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsConfigurationError(`${context}.${property} must be enumerable.`);
		}
	}
	return value as Record<string, unknown>;
}

function assertKnownCapabilityKeys(record: Record<string, unknown>, allowed: readonly string[], context: string) {
	const allowedKeys = capturedSet(allowed);
	for (const property of Object.keys(record)) {
		if (!SET_HAS.call(allowedKeys, property)) {
			throw new ActiveTsConfigurationError(`${context} contains unknown capability "${property}".`);
		}
	}
}

function isSupportedOperatorName(value: string): value is keyof NonNullable<SearchCapabilities['whereOperators']> {
	return SET_HAS.call(SUPPORTED_SEARCH_WHERE_OPERATORS, value as keyof NonNullable<SearchCapabilities['whereOperators']>);
}

function replaceAdapterCapabilities(
	adapter: unknown,
	capabilities: StoreCapabilities | SearchCapabilities,
	context: string
) {
	try {
		defineAdapterProperty(adapter as object, 'capabilities', capabilities, true);
	} catch (error) {
		throw new ActiveTsConfigurationError(
			`${context}.capabilities could not be snapshotted: ${safeErrorMessage(error)}`
		);
	}
}

function shadowAdapterProperty(adapter: object, property: string, context: string) {
	try {
		defineAdapterProperty(adapter, property, undefined, false);
	} catch (error) {
		throw new ActiveTsConfigurationError(
			`${context}.${property} could not be shadowed: ${safeErrorMessage(error)}`
		);
	}
}

function defineAdapterProperty(adapter: object, property: string, value: unknown, enumerable: boolean) {
	const descriptor = Object.create(null) as PropertyDescriptor;
	descriptor.value = value;
	descriptor.enumerable = enumerable;
	descriptor.configurable = true;
	descriptor.writable = false;
	Object.defineProperty(adapter, property, descriptor);
}

function defineScopedCapabilities<TCapabilities>(adapter: object, capabilities: () => TCapabilities | undefined) {
	const descriptor = Object.create(null) as PropertyDescriptor;
	descriptor.get = capabilities;
	descriptor.enumerable = true;
	descriptor.configurable = true;
	Object.defineProperty(adapter, 'capabilities', descriptor);
}

function defineScopedOptionalFunction<TFunction extends (...args: any[]) => unknown>(
	adapter: object,
	property: string,
	value: () => TFunction | undefined
) {
	const descriptor = Object.create(null) as PropertyDescriptor;
	descriptor.get = value;
	descriptor.enumerable = true;
	descriptor.configurable = true;
	Object.defineProperty(adapter, property, descriptor);
}

function adapterMember(
	adapter: object,
	property: string,
	context: string,
	options: { allowOwnAccessor?: boolean } = {}
) {
	let current: object | null = adapter;
	while (current && current !== Object.prototype) {
		if (Object.prototype.hasOwnProperty.call(current, property)) {
			const descriptor = Object.getOwnPropertyDescriptor(current, property);
			if (!descriptor || !('value' in descriptor)) {
				if (
					options.allowOwnAccessor &&
					current === adapter &&
					descriptor &&
					typeof descriptor.get === 'function'
				) {
					if (!descriptor.enumerable) {
						throw new ActiveTsConfigurationError(`${context}.${property} must be enumerable.`);
					}
					return descriptor.get.call(adapter);
				}
				throw new ActiveTsConfigurationError(`${context}.${property} must be a data property.`);
			}
			if (current === adapter && !descriptor.enumerable && descriptor.value !== undefined) {
				throw new ActiveTsConfigurationError(`${context}.${property} must be enumerable.`);
			}
			return descriptor.value;
		}
		current = Object.getPrototypeOf(current);
	}
	return undefined;
}

function normalizePlugins(plugins: ActiveTsPlugin[] | undefined): ActiveTsPlugin[] | undefined {
	if (plugins === undefined) return undefined;
	if (!Array.isArray(plugins)) throw new ActiveTsConfigurationError('plugins must be an array.');
	const safePlugins = snapshotArrayInput<ActiveTsPlugin>(plugins, 'plugins');
	const normalizedPlugins: ActiveTsPlugin[] = [];
	for (let index = 0; index < safePlugins.length; index++) {
		const plugin = safePlugins[index];
		assertPlainOptionObject(plugin, `plugins[${index}]`);
		assertKnownOptionKeys(plugin, PLUGIN_OPTION_KEYS, `plugins[${index}]`);
		const record = plugin as Record<string, unknown>;
		const name = ownValue(record, 'name', `plugins[${index}]`);
		const setup = ownValue(record, 'setup', `plugins[${index}]`);
		const hooks = ownValue(record, 'hooks', `plugins[${index}]`);
		if (typeof name !== 'string' || !name) {
			throw new ActiveTsConfigurationError(`plugins[${index}].name must be a non-empty string.`);
		}
		if (setup !== undefined && typeof setup !== 'function') {
			throw new ActiveTsConfigurationError(`plugins[${index}].setup must be a function.`);
		}
		const normalizedHooks = hooks !== undefined
			? sanitizeHooks(hooks as NonNullable<ActiveTsPlugin['hooks']>, `plugin "${name}" hooks`)
			: undefined;
		const normalized: ActiveTsPlugin = { name };
		if (normalizedHooks !== undefined) normalized.hooks = normalizedHooks;
		if (setup !== undefined) normalized.setup = setup as ActiveTsPlugin['setup'];
		normalizedPlugins[index] = Object.freeze(normalized);
	}
	return Object.freeze(normalizedPlugins) as ActiveTsPlugin[];
}

function isOutboxWriteHook(name: ActiveTsHookName, pluginName: string | undefined) {
	return pluginName === 'outbox' && (name === 'afterCreate' || name === 'afterUpdate' || name === 'afterDelete');
}

function normalizeHookPayloadInput(payload: unknown, context: ActiveContext): ActiveTsHookPayload {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
		throw new ActiveTsValidationError('Hook payload must be a plain object.');
	}
	const prototype = Object.getPrototypeOf(payload);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsValidationError('Hook payload must be a plain object.');
	}
	if (Object.getOwnPropertySymbols(payload).length) {
		throw new ActiveTsValidationError('Hook payload cannot contain symbol keys.');
	}
	const normalized = Object.create(null) as ActiveTsHookPayload;
	defineDataProperty(normalized, 'context', context, { enumerable: true, configurable: true, writable: true });
	for (const rawKey of Object.getOwnPropertyNames(payload)) {
		if (rawKey === '__proto__' || rawKey === 'constructor' || rawKey === 'prototype') {
			throw new ActiveTsValidationError(`Hook payload key "${rawKey}" is not allowed.`);
		}
		if (!SET_HAS.call(HOOK_PAYLOAD_INPUT_KEYS, rawKey as keyof ActiveTsHookPayload)) {
			throw new ActiveTsValidationError(`Hook payload key "${rawKey}" is not recognized.`);
		}
		const descriptor = Object.getOwnPropertyDescriptor(payload, rawKey);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsValidationError(`Hook payload key "${rawKey}" must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsValidationError(`Hook payload key "${rawKey}" must be enumerable.`);
		}
		if (rawKey !== 'context') {
			defineDataProperty(normalized, rawKey, descriptor.value, { enumerable: true, configurable: true, writable: true });
		}
	}
	return normalized;
}

export class ActiveContext {
	private readonly loaders = new WeakMap<ModelConstructor, BatchLoader<any>>();
	private readonly metaCache = new WeakMap<ModelConstructor, { version: number; meta: ResolvedModelMeta }>();
	private readonly setupPromises: Promise<void>[] = [];
	private readonly storeHandles = new Map<string, StoreAdapter>();
	private readonly cacheHandles = new Map<string, CacheAdapter>();
	private readonly searchHandles = new Map<string, SearchAdapter>();
	private cacheKeyOwners = new Map<string, string>();
	private entityCacheKeys = new Map<string, string>();
	private readonly config: Required<Pick<ActiveTsConfig, 'defaultStore' | 'defaultCache' | 'defaultSearch'>> &
		ActiveTsConfig;
	private readonly maxBatchSize: number;
	private transactionState?: TransactionState;

	constructor(config: ActiveTsConfig, options: { skipPluginSetup?: boolean } = {}) {
		const contextOptions = normalizeActiveContextOptions(options);
		assertActiveTsConfig(config);
		setTransactionModelTracker(this, (item) => this.#trackTransactionModelInstance(item));
		const configRecord = config as ActiveTsConfig & Record<string, unknown>;
		const stores = normalizeStoreAdapterRegistry(
			ownValue(configRecord, 'stores') as ActiveTsConfig['stores']
		);
		if (!Object.keys(stores).length) {
			throw new ActiveTsConfigurationError('At least one store adapter is required.');
		}
		const rawCaches = ownValue(configRecord, 'caches') as ActiveTsConfig['caches'];
		const rawSearch = ownValue(configRecord, 'search') as ActiveTsConfig['search'];
		const caches = rawCaches !== undefined
			? normalizeAdapterRegistry(rawCaches, 'cache adapter name', assertCacheAdapter, markCacheAdapterSource)
			: undefined;
		const search = rawSearch !== undefined
			? normalizeAdapterRegistry(rawSearch, 'search adapter name', assertSearchAdapter, markSearchAdapterSource)
			: undefined;
		const plugins = ownValue(configRecord, 'plugins') as ActiveTsConfig['plugins'];
		const schema = ownValue(configRecord, 'schema') as ActiveTsConfig['schema'];
		const batch = ownValue(configRecord, 'batch') as ActiveTsConfig['batch'];
		const aggregate = ownValue(configRecord, 'aggregate') as ActiveTsConfig['aggregate'];
		const queryPlanner = ownValue(configRecord, 'queryPlanner') as ActiveTsConfig['queryPlanner'];
		const cacheKey = ownValue(configRecord, 'cacheKey') as ActiveTsConfig['cacheKey'];
		const lazyWarnings = ownValue(configRecord, 'lazyWarnings') as ActiveTsConfig['lazyWarnings'];
		const defaultStore = assertSafeSchemaIdentifier(ownValue(configRecord, 'defaultStore') ?? 'default', 'default store adapter name');
		const defaultCache = assertSafeSchemaIdentifier(ownValue(configRecord, 'defaultCache') ?? 'default', 'default cache adapter name');
		const defaultSearch = assertSafeSchemaIdentifier(ownValue(configRecord, 'defaultSearch') ?? 'default', 'default search adapter name');
		assertRegisteredDefaultAdapter(stores, defaultStore, 'store');
		if (ownValue(configRecord, 'defaultCache') !== undefined) {
			assertRegisteredDefaultAdapter(caches, defaultCache, 'cache');
		}
		if (ownValue(configRecord, 'defaultSearch') !== undefined) {
			assertRegisteredDefaultAdapter(search, defaultSearch, 'search');
		}
		this.config = {
			defaultStore,
			defaultCache,
			defaultSearch,
			stores,
			caches,
			search,
			plugins: normalizePlugins(plugins),
			schema: normalizeSchemaConfig(schema),
			batch: normalizeBatchConfig(batch),
			aggregate: normalizeAggregateConfig(aggregate),
			queryPlanner: normalizeQueryPlanner(queryPlanner),
			cacheKey,
			lazyWarnings
		};
		this.maxBatchSize = normalizeMaxBatchSize(this.config.batch?.maxSize);
		if (contextOptions.skipPluginSetup) return;
		for (const plugin of this.config.plugins ?? []) {
			const pluginRecord = plugin as unknown as Record<string, unknown>;
			const pluginName = ownValue(pluginRecord, 'name') as string;
			const setup = ownValue(pluginRecord, 'setup') as ActiveTsPlugin['setup'] | undefined;
			let result: void | Promise<void> | undefined;
			try {
				result = setup?.(this);
			} catch (error) {
				throw new ActiveTsConfigurationError(
					`Plugin "${pluginName}" setup failed: ${safeErrorMessage(error)}`
				);
			}
			const ready = pluginSetupPromise(result, pluginName);
			if (ready) {
				void ready.catch((error) => {
					console.warn(`active-ts ${safeErrorMessage(error)}`);
				});
				this.setupPromises.push(ready);
			}
		}
	}

	async ready() {
		await Promise.all(this.setupPromises);
		return this;
	}

	allowsAggregateFallback() {
		return this.config.aggregate?.allowQueryFallback === true;
	}

	isTransactionContext() {
		return this.transactionScopedContext('inspect transaction context') !== this || this.transactionState !== undefined;
	}

	meta(model: ModelConstructor): ResolvedModelMeta {
		this.assertTransactionOpen('resolve model metadata');
		const source = staticMarkerValue(model, SOURCE_MODEL);
		if (source !== undefined && typeof source !== 'function') {
			throw new ActiveTsConfigurationError('Model source marker must be a model constructor.');
		}
		const sourceModel = (source ?? model) as ModelConstructor;
		const version = getModelMetaVersion(sourceModel);
		let cached = WEAKMAP_GET.call(this.metaCache, sourceModel) as
			| { version: number; meta: ResolvedModelMeta }
			| undefined;
		if (!cached || cached.version !== version) {
			cached = {
				version,
				meta: resolveModelMeta(sourceModel, {
					store: this.config.defaultStore,
					cache: this.config.defaultCache,
					search: this.config.defaultSearch
				})
			};
			WEAKMAP_SET.call(this.metaCache, sourceModel, cached);
		}
		const meta = cached.meta;
		if (meta.cache?.consistency === 'distributed') {
			const cache = this.internalCache(meta.cache.adapter);
			if (!cache) {
				throw new ActiveTsConfigurationError(
					`Model "${meta.name}" uses distributed cache consistency, but cache adapter "${meta.cache.adapter}" is not registered.`
				);
			}
			this.assertDistributedCache(meta, cache);
		}
		return meta;
	}

	store(name: string): StoreAdapter {
		const scoped = this.transactionScopedContext('access store adapters');
		if (scoped !== this) return scoped.store(name);
		this.assertTransactionOpen('access store adapters');
		const safeName = assertSafeSchemaIdentifier(name, 'store adapter name');
		const existing = mapGet(this.storeHandles, safeName);
		if (existing) return existing;
		const adapter = this.rawStore(safeName);
		const handle = this.createStoreHandle(safeName, adapter);
		mapSet(this.storeHandles, safeName, handle);
		return handle;
	}

	cache(name: string): CacheAdapter | undefined {
		const scoped = this.transactionScopedContext('access cache adapters');
		if (scoped !== this) return scoped.cache(name);
		this.assertTransactionOpen('access cache adapters');
		const safeName = assertSafeSchemaIdentifier(name, 'cache adapter name');
		const existing = mapGet(this.cacheHandles, safeName);
		if (existing) return existing;
		const adapter = this.rawCache(safeName);
		if (!adapter) return undefined;
		const handle = this.createCacheHandle(safeName, adapter);
		mapSet(this.cacheHandles, safeName, handle);
		return handle;
	}

	searchAdapter(name: string): SearchAdapter {
		const scoped = this.transactionScopedContext('access search adapters');
		if (scoped !== this) return scoped.searchAdapter(name);
		this.assertTransactionOpen('access search adapters');
		const safeName = assertSafeSchemaIdentifier(name, 'search adapter name');
		const existing = mapGet(this.searchHandles, safeName);
		if (existing) return existing;
		const adapter = this.rawSearch(safeName);
		const handle = this.createSearchHandle(safeName, adapter);
		mapSet(this.searchHandles, safeName, handle);
		return handle;
	}

	private internalStore(name: string): StoreAdapter {
		const scoped = this.transactionScopedContext('access internal store adapters');
		if (scoped !== this) return scoped.internalStore(name);
		this.assertTransactionOpen('access internal store adapters');
		return this.rawStore(assertSafeSchemaIdentifier(name, 'store adapter name'));
	}

	private internalCache(name: string): CacheAdapter | undefined {
		const scoped = this.transactionScopedContext('access internal cache adapters');
		if (scoped !== this) return scoped.internalCache(name);
		this.assertTransactionOpen('access internal cache adapters');
		return this.rawCache(assertSafeSchemaIdentifier(name, 'cache adapter name'));
	}

	private internalSearchAdapter(name: string): SearchAdapter {
		const scoped = this.transactionScopedContext('access internal search adapters');
		if (scoped !== this) return scoped.internalSearchAdapter(name);
		this.assertTransactionOpen('access internal search adapters');
		return this.rawSearch(assertSafeSchemaIdentifier(name, 'search adapter name'));
	}

	private trackOperation<T>(run: () => Promise<T>): Promise<T> {
		try {
			const scoped = this.transactionScopedContext('run context operations');
			if (scoped !== this) return scoped.trackOperation(run);
			this.assertTransactionOpen('run context operations');
			const state = this.transactionState;
			if (!state) return run();
			return state.callbackOperations.track(async () => {
				this.assertTransactionOpen('run context operations');
				return await run();
			}, (closed) => new ActiveTsConfigurationError(
				`Cannot start context operations after the transaction callback ${closed}.`
			));
		} catch (error) {
			return SAFE_PROMISE_REJECT(error);
		}
	}

	private runTrackedScopedOperation<T>(
		operation: string,
		route: (scoped: ActiveContext) => Promise<T>,
		run: () => Promise<T>
	): Promise<T> {
		try {
			const scoped = this.transactionScopedContext(operation);
			if (scoped !== this) return route(scoped);
			return this.trackOperation(run);
		} catch (error) {
			return SAFE_PROMISE_REJECT(error);
		}
	}

	private [ACTIVE_CONTEXT_INTERNALS](): ActiveContextInternalAccess {
		return {
			store: (name) => this.internalStore(name),
			cache: (name) => this.internalCache(name),
			searchAdapter: (name) => this.internalSearchAdapter(name),
			assertWritable: (operation) => this.assertTransactionWritable(operation),
			markRollbackOnly: (error) => this.markTransactionRollbackOnly(error),
			trackOperation: (run) => this.trackOperation(run)
		};
	}

	storeForQuery(meta: ResolvedModelMeta, plan: QueryPlan): StoreAdapter {
		const scoped = this.transactionScopedContext('route queries');
		if (scoped !== this) return scoped.storeForQuery(meta, plan);
		const safePlan = encodeQueryPlanFieldCodecs(
			meta,
			normalizeQueryPlanFieldTypes(meta, normalizeStoreQueryPlan(plan, meta.idField, 'store route query plan'))
		);
		const routed =
			assertSafeSchemaIdentifier(
				safePlan.native?.adapter ??
					this.config.queryPlanner?.routeQuery?.({ context: this, model: meta, plan: clonePlannerQueryPlan(safePlan) }) ??
					meta.store,
				'store route adapter name'
			);
		this.assertTransactionStoreRoute(meta.store, routed, 'queries');
		const store = this.internalStore(routed);
		assertStoreSupports(store, safePlan);
		return store;
	}

	storeForAggregate(meta: ResolvedModelMeta, plan: AggregatePlan): StoreAdapter {
		const scoped = this.transactionScopedContext('route aggregate queries');
		if (scoped !== this) return scoped.storeForAggregate(meta, plan);
		const safePlan = encodeAggregatePlanFieldCodecs(
			meta,
			normalizeAggregatePlanFieldTypes(meta, normalizeStoreAggregatePlan(plan, 'store route aggregate plan'))
		);
		const routed =
			assertSafeSchemaIdentifier(
				safePlan.native?.adapter ??
					this.config.queryPlanner?.routeAggregate?.({ context: this, model: meta, plan: clonePlannerAggregatePlan(safePlan) }) ??
					meta.store,
				'store route adapter name'
			);
		this.assertTransactionStoreRoute(meta.store, routed, 'aggregate queries');
		const store = this.internalStore(routed);
		assertStoreSupports(store, safePlan);
		return store;
	}

	searchAdapterFor(meta: ResolvedModelMeta, query: string, options: SearchOptions, requested?: string) {
		return this.searchAdapterRouteFor(meta, query, options, requested).adapter;
	}

	searchAdapterRouteFor(
		meta: ResolvedModelMeta,
		query: string,
		options: SearchOptions,
		requested?: string
	): { name: string; adapter: SearchAdapter; indexKind: string } {
		const scoped = this.transactionScopedContext('route searches');
		if (scoped !== this) return scoped.searchAdapterRouteFor(meta, query, options, requested);
		const safeQuery = assertSafeSearchQuery(query, 'search route query');
		const safeOptions = normalizeSearchAdapterOptions(options, 'search route options');
		const routed =
			requested ??
			this.config.queryPlanner?.routeSearch?.({
				context: this,
				model: meta,
				query: safeQuery,
				options: clonePlannerSearchOptions(safeOptions),
				requested
			}) ??
			meta.search ??
			this.config.defaultSearch;
		const adapter = this.internalSearchAdapter(routed);
		assertSearchOptionsSupported(adapter, safeOptions);
		return { name: routed, adapter, indexKind: searchIndexAdapterKind(adapter, routed) };
	}

	searchAdapterSchemaRoutesFor(meta: ResolvedModelMeta): Array<{ name: string; adapter: SearchAdapter; indexKind: string }> {
		const scoped = this.transactionScopedContext('route search schema adapters');
		if (scoped !== this) return scoped.searchAdapterSchemaRoutesFor(meta);
		const routes: Array<{ name: string; adapter: SearchAdapter; indexKind: string }> = [];
		for (const name of this.searchSchemaAdapterNamesForModel(meta)) {
			const adapter = this.internalSearchAdapter(name);
			routes[routes.length] = { name, adapter, indexKind: searchIndexAdapterKind(adapter, name) };
		}
		return routes;
	}

	private rawStore(name: string): StoreAdapter {
		const adapter = ownValue(this.config.stores, name);
		if (!adapter) throw new ActiveTsConfigurationError(`Store adapter "${name}" is not registered.`);
		return adapter;
	}

	private rawCache(name: string): CacheAdapter | undefined {
		if (!this.config.caches) return undefined;
		const adapter = ownValue(this.config.caches, name);
		if (!adapter) throw new ActiveTsConfigurationError(`Cache adapter "${name}" is not registered.`);
		return adapter;
	}

	private rawSearch(name: string): SearchAdapter {
		const adapter = this.config.search ? ownValue(this.config.search, name) : undefined;
		if (!adapter) throw new ActiveTsConfigurationError(`Search adapter "${name}" is not registered.`);
		return adapter;
	}

	private storeForRetainedHandle(name: string) {
		return this.transactionScopedContext('use retained store adapter').rawStore(name);
	}

	private cacheForRetainedHandle(name: string) {
		const adapter = this.transactionScopedContext('use retained cache adapter').rawCache(name);
		if (!adapter) throw new ActiveTsConfigurationError(`Cache adapter "${name}" is not registered.`);
		return adapter;
	}

	private searchForRetainedHandle(name: string) {
		return this.transactionScopedContext('use retained search adapter').rawSearch(name);
	}

	private createStoreHandle(name: string, adapter: StoreAdapter): StoreAdapter {
		const handle: StoreAdapter = {
			kind: adapter.kind,
			cacheScope: adapter.cacheScope,
			datastoreNamespace: adapter.datastoreNamespace,
			datastoreProjectId: adapter.datastoreProjectId,
			datastoreDatabaseId: adapter.datastoreDatabaseId,
			datastoreKeyEncoding: adapter.datastoreKeyEncoding,
			get: (model, id, options) => this.trackOperation(async () => {
				const safeModel = snapshotAdapterModel(model, 'context store get model metadata');
				assertSafeEntityId(id, 'context store get id');
				const safeOptions = normalizeStoreReadOptions(options, 'context store get options');
				const retained = this.storeForRetainedHandle(name);
				assertContextStoreReadOptionsSupported(retained, safeOptions, 'context store get options');
				assertContextDatastoreDirectReadAllowed(safeModel, safeOptions, 'context store get');
				const row = await retained.get(safeModel, id, safeOptions);
				return normalizeContextStoreGetRow(safeModel, id, row, 'context store get', {
					datastoreAncestor: safeOptions.meta?.datastoreAncestor,
					datastoreNamespace: retained.datastoreNamespace,
					trustedDatastoreEntityKeys: storeTrustsDatastoreEntityKeyRows(retained)
				});
			}),
			getMany: (model, ids, options) => this.trackOperation(async () => {
				const safeModel = snapshotAdapterModel(model, 'context store getMany model metadata');
				const safeIds = assertSafeEntityIdArray(ids, 'context store getMany ids');
				const safeOptions = normalizeStoreReadOptions(options, 'context store getMany options');
				const retained = this.storeForRetainedHandle(name);
				assertContextStoreReadOptionsSupported(retained, safeOptions, 'context store getMany options');
				assertContextDatastoreDirectReadAllowed(safeModel, safeOptions, 'context store getMany');
				const rows = await retained.getMany(safeModel, safeIds, safeOptions);
				return normalizeContextStoreGetManyRows(safeModel, safeIds, rows, 'context store getMany', {
					datastoreAncestor: safeOptions.meta?.datastoreAncestor,
					datastoreNamespace: retained.datastoreNamespace,
					trustedDatastoreEntityKeys: storeTrustsDatastoreEntityKeyRows(retained)
				});
			}),
			query: (model, plan, options) => this.trackOperation(async () => {
				const safeModel = snapshotAdapterModel(model, 'context store query model metadata');
				const safePlan = normalizeStoreQueryPlan(plan, safeModel.idField, 'context store query plan');
				assertStoreNativeAdapterTag(name, safePlan, 'context store query plan');
				const safeOptions = validateStoreQueryReadOptions(options, safePlan, 'context store query options');
				const retained = this.storeForRetainedHandle(name);
				if (!isTransactionReadOnlyStore(retained)) assertStoreSupports(retained, safePlan);
				const result = await retained.query(safeModel, stripStoreNativeAdapterTag(safePlan), safeOptions);
				return normalizeStoreQueryResultForModel(safeModel, result, 'context store query', {
					cursor: storeCapability(retained.capabilities, 'cursor'),
					adapterKind: retained.kind,
					datastoreAncestor: safePlan.meta?.datastoreAncestor,
					datastoreNamespace: retained.datastoreNamespace,
					trustedDatastoreEntityKeys: storeTrustsDatastoreEntityKeyRows(retained)
				});
			}),
			aggregate: adapter.aggregate
				? (model, plan) => this.trackOperation(async () => {
						const safeModel = snapshotAdapterModel(model, 'context store aggregate model metadata');
						const safePlan = normalizeStoreAggregatePlan(plan, 'context store aggregate plan');
						assertStoreNativeAdapterTag(name, safePlan, 'context store aggregate plan');
						const retained = this.storeForRetainedHandle(name);
						if (!isTransactionReadOnlyStore(retained)) {
							assertStoreSupports(retained, safePlan);
							assertStoreDirectAggregateSupported(retained);
						}
						const result = await retained.aggregate!(safeModel, stripStoreNativeAdapterTag(safePlan));
						return normalizeStoreAggregateResult(result, safePlan.aggregates, 'context store aggregate');
					})
				: undefined,
			create: (model, id, data, options) => this.trackOperation(async () => {
				const safeModel = snapshotAdapterModel(model, 'context store create model metadata');
				assertSafeEntityId(id, 'context store create id');
				const safeData = clonePortableDataObject(data, 'context store create data');
				assertStoreDataMatchesId(safeModel, id, safeData, 'context store create data');
				const safeOptions = normalizeStoreWriteOptions(options, 'context store create options');
				const retained = this.storeForRetainedHandle(name);
				assertContextStoreWriteOptionsSupported(retained, safeOptions, 'context store create options', { expectedVersion: false });
				assertContextStoreDatastoreWriteScope(safeModel, id, safeData, safeOptions, 'context store create options');
				return await retained.create(safeModel, id, safeData, safeOptions);
			}),
			update: (model, id, data, options) => this.trackOperation(async () => {
				const safeModel = snapshotAdapterModel(model, 'context store update model metadata');
				assertSafeEntityId(id, 'context store update id');
				const safeData = clonePortableDataObject(data, 'context store update data');
				assertStoreDataMatchesId(safeModel, id, safeData, 'context store update data');
				const safeOptions = normalizeStoreWriteOptions(options, 'context store update options');
				const retained = this.storeForRetainedHandle(name);
				assertContextStoreWriteOptionsSupported(retained, safeOptions, 'context store update options', { expectedVersion: true });
				assertContextStoreDatastoreWriteScope(safeModel, id, safeData, safeOptions, 'context store update options');
				return await retained.update(safeModel, id, safeData, safeOptions);
			}),
			delete: (model, id, options) => this.trackOperation(async () => {
				const safeModel = snapshotAdapterModel(model, 'context store delete model metadata');
				assertSafeEntityId(id, 'context store delete id');
				const safeOptions = normalizeStoreWriteOptions(options, 'context store delete options');
				const retained = this.storeForRetainedHandle(name);
				assertContextStoreWriteOptionsSupported(retained, safeOptions, 'context store delete options', { expectedVersion: true });
				assertContextDatastoreDirectWriteAllowed(safeModel, safeOptions, 'context store delete');
				return await retained.delete(safeModel, id, safeOptions);
			}),
			schema: adapter.schema
				? {
						plan: (models) => this.trackOperation(async () => {
							const retained = this.storeForRetainedHandle(name);
							const schema = retained.schema;
							if (!schema) throw new ActiveTsConfigurationError(`Store adapter "${name}" does not expose schema planning in this context.`);
							const safeModels = normalizeSchemaModels(models, `Store adapter "${name}" schema models`);
							const plan = normalizeSchemaPlan(await schema.plan(safeModels), `Store adapter "${name}" schema plan`);
							assertStoreSchemaPlanSupported(retained, plan);
							return plan;
						}),
						apply: (models, options) => this.trackOperation(async () => {
							const retained = this.storeForRetainedHandle(name);
							const schema = retained.schema;
							if (!schema) throw new ActiveTsConfigurationError(`Store adapter "${name}" does not expose schema apply in this context.`);
							const safeModels = normalizeSchemaModels(models, `Store adapter "${name}" schema models`);
							const safeOptions = normalizeStoreSchemaApplyOptions(options, `Store adapter "${name}" schema apply options`);
							const plan = normalizeSchemaPlan(await schema.apply(safeModels, safeOptions), `Store adapter "${name}" schema apply plan`);
							assertStoreSchemaPlanSupported(retained, plan);
							return plan;
						})
					}
				: undefined
		};
		defineScopedCapabilities<StoreCapabilities>(handle, () => this.storeForRetainedHandle(name).capabilities);
		if (adapter.transaction) {
			defineScopedOptionalFunction(
				handle,
				'transaction',
				() => {
					const transaction = this.storeForRetainedHandle(name).transaction;
					if (!transaction) return undefined;
					const scopedTransaction: NonNullable<StoreAdapter['transaction']> = (fn, options) => this.trackOperation(async () => {
						if (typeof fn !== 'function') {
							throw new ActiveTsConfigurationError('context store transaction callback must be a function.');
						}
						const safeOptions = normalizeStoreTransactionOptions(options, 'context store transaction options');
						const retained = this.storeForRetainedHandle(name);
						const current = retained.transaction;
						if (!current) {
							throw new ActiveTsConfigurationError(
								`Store adapter "${name}" does not expose transactions in this context.`
							);
						}
						return await (current.call(
							retained,
							async (txStore: StoreAdapter) => {
								let closed: string | undefined;
								const bound = createContextBoundTransactionStore(txStore, handle, name);
								const guarded = createCloseGuardedStoreAdapter(
									bound,
									() => closed,
									`context store adapter "${name}"`
								);
								markStoreAdapterSource(guarded.adapter, bound);
								try {
									const result = await fn(guarded.adapter);
									closed = 'callback finished';
									await guarded.waitForPendingOperations();
									return result;
								} catch (error) {
									closed = 'rollback';
									try {
										await guarded.waitForPendingOperations();
									} catch {
										// Preserve the callback or operation error that triggered rollback.
									}
									throw error;
								}
							},
							safeOptions
						) as Promise<Awaited<ReturnType<typeof fn>>>);
					});
					return scopedTransaction;
				}
			);
		}
		defineScopedOptionalFunction(
			handle,
			'savepoint',
			() => {
				const scopedContext = this.transactionScopedContext('access store savepoints');
				const savepoint = scopedContext.rawStore(name).savepoint;
				if (!savepoint) return undefined;
				const scopedSavepoint: NonNullable<StoreAdapter['savepoint']> = (fn) => {
					if (typeof fn !== 'function') {
						return SAFE_PROMISE_REJECT(
							new ActiveTsConfigurationError('context store savepoint callback must be a function.')
						);
					}
					return scopedContext.transaction(
						async (childContext) => fn(childContext.store(name)),
						{ store: name, join: 'savepoint' }
					);
				};
				return scopedSavepoint;
			}
		);
		defineDataProperty(handle, CONTEXT_BOUND_STORE_SOURCE, adapter, { enumerable: false, configurable: false });
		markStoreAdapterSource(handle, adapter);
		markAdapterTransactionOperationCarrier(handle, (run) => this.trackOperation(run));
		return storeTrustsDatastoreEntityKeyRows(adapter)
			? markStoreTrustsDatastoreEntityKeyRows(handle)
			: handle;
	}

	private createCacheHandle(name: string, adapter: CacheAdapter): CacheAdapter {
		const handle: CacheAdapter = {
			kind: adapter.kind,
			getMany: (keys) => this.trackOperation(async () => {
				const safeKeys = normalizeContextCacheKeys(keys, 'context cache getMany keys');
				const result = await this.cacheForRetainedHandle(name).getMany(safeKeys);
				return normalizeContextCacheGetManyResult(result, safeKeys.length, 'context cache getMany');
			}),
			setMany: (entries, options) => this.trackOperation(async () => {
				const safeEntries = normalizeContextCacheEntries(entries, 'context cache setMany entries');
				const safeOptions = normalizeContextCacheWriteOptions(options, 'context cache setMany options');
				await this.cacheForRetainedHandle(name).setMany(safeEntries, safeOptions);
			}),
			deleteMany: (keys) => this.trackOperation(async () => {
				const safeKeys = normalizeContextCacheKeys(keys, 'context cache deleteMany keys');
				await this.cacheForRetainedHandle(name).deleteMany(safeKeys);
			}),
			codecKey: adapter.codecKey
				? (key) => {
						const safeKey = assertSafeCacheKey(key, 'context cache codecKey key');
						return assertSafeCacheKey(
							this.cacheForRetainedHandle(name).codecKey!(safeKey),
							'context cache codecKey result'
						);
					}
				: undefined
		};
		if (cacheSupportsVersioning(adapter)) {
			handle.getManyVersioned = (keys) => this.trackOperation(async () => {
				const safeKeys = normalizeContextCacheKeys(keys, 'context cache getManyVersioned keys');
				const retained = this.cacheForRetainedHandle(name);
				if (!retained || !cacheSupportsVersioning(retained)) {
					throw new ActiveTsConfigurationError(`Cache adapter "${name}" no longer supports versioned reads.`);
				}
				return normalizeCacheVersionedValues(
					await retained.getManyVersioned(safeKeys),
					safeKeys.length,
					'context cache getManyVersioned result'
				);
			});
			handle.setManyVersioned = (entries, options) => this.trackOperation(async () => {
				const safeEntries = normalizeCacheVersionedEntries(entries, 'context cache setManyVersioned entries');
				const safeOptions = normalizeContextCacheWriteOptions(options, 'context cache setManyVersioned options');
				const retained = this.cacheForRetainedHandle(name);
				if (!retained || !cacheSupportsVersioning(retained)) {
					throw new ActiveTsConfigurationError(`Cache adapter "${name}" no longer supports versioned writes.`);
				}
				return normalizeCacheVersionedSetResult(
					await retained.setManyVersioned(safeEntries, safeOptions),
					safeEntries.length,
					'context cache setManyVersioned result'
				);
			});
			handle.invalidateMany = (keys) => this.trackOperation(async () => {
				const safeKeys = normalizeContextCacheKeys(keys, 'context cache invalidateMany keys');
				const retained = this.cacheForRetainedHandle(name);
				if (!retained || !cacheSupportsVersioning(retained)) {
					throw new ActiveTsConfigurationError(`Cache adapter "${name}" no longer supports atomic invalidation.`);
				}
				await retained.invalidateMany(safeKeys);
			});
		}
		defineDataProperty(handle, CONTEXT_BOUND_CACHE_SOURCE, adapter, { enumerable: false, configurable: false });
		markAdapterTransactionOperationCarrier(handle, (run) => this.trackOperation(run));
		return markCacheAdapterSource(handle, adapter);
	}

	private createSearchHandle(name: string, adapter: SearchAdapter): SearchAdapter {
		const handle: SearchAdapter = {
			kind: adapter.kind,
			searchIndexKind: adapter.searchIndexKind,
			search: (model, query, options) => this.trackOperation(async () => {
				const safeModel = snapshotAdapterModel(model, 'context search model metadata');
				const safeQuery = assertSafeSearchQuery(query, 'context search query');
				const safeOptions = normalizeSearchAdapterOptions(options, 'context search options');
				const retained = this.searchForRetainedHandle(name);
				assertSearchOptionsSupported(retained, safeOptions);
				const indexKind = searchIndexAdapterKind(retained, name);
				const adapterMeta = withDatastoreSearchNamespace(
					withSearchIndexesForAdapter(safeModel, name, indexKind),
					this.store(safeModel.store).datastoreNamespace
				);
				const result = await retained.search(adapterMeta, safeQuery, safeOptions);
				return normalizeContextSearchResult(
					adapterMeta,
					result,
					retained,
					'context search'
				);
			}),
			index: (model, id, data, options) => this.trackOperation(async () => {
				const retained = this.searchForRetainedHandle(name);
				const safeModel = snapshotAdapterModel(model, 'context search index model metadata');
				const safeId = normalizeContextEntityId(id, 'context search index id');
				const safeOptions = normalizeSearchWriteOptions(options, 'context search index options');
				const indexKind = searchIndexAdapterKind(retained, name);
				const adapterMeta = withDatastoreSearchNamespace(
					withSearchIndexesForAdapter(safeModel, name, indexKind),
					this.store(safeModel.store).datastoreNamespace
				);
				const safeData = cloneSafeDataObject(data, 'context search index data');
				projectSearchDocument(adapterMeta, indexKind, safeId, safeData, {
					trustDatastoreEntityKey: false
				});
				const adapterData = cloneSafeDataObjectWithoutActiveEntityKey(safeData, 'context search index data');
				if (!isTransactionScopedSearchAdapter(retained)) assertContextSearchIndexSupported(retained);
				assertSearchWriteOptionsSupported(retained, safeOptions);
				await retained.index(adapterMeta, safeId, adapterData, safeOptions);
			}),
			delete: (model, id, options) => this.trackOperation(async () => {
				const retained = this.searchForRetainedHandle(name);
				const safeModel = snapshotAdapterModel(model, 'context search delete model metadata');
				const safeId = normalizeContextEntityId(id, 'context search delete id');
				const safeOptions = normalizeSearchWriteOptions(options, 'context search delete options');
				const indexKind = searchIndexAdapterKind(retained, name);
				const adapterMeta = withDatastoreSearchNamespace(
					withSearchIndexesForAdapter(safeModel, name, indexKind),
					this.store(safeModel.store).datastoreNamespace
				);
				if (!isTransactionScopedSearchAdapter(retained)) assertContextSearchIndexSupported(retained);
				assertSearchWriteOptionsSupported(retained, safeOptions);
				searchDocumentIdentity(adapterMeta, safeId, 'context search delete id');
				await retained.delete(adapterMeta, safeId, safeOptions);
			}),
			schema: adapter.schema
				? {
						plan: (models) => this.trackOperation(async () => {
							const retained = this.searchForRetainedHandle(name);
							const schema = retained.schema;
							if (!schema) throw new ActiveTsConfigurationError(`Search adapter "${name}" does not expose schema planning in this context.`);
							const safeModels = this.searchSchemaModelsForRetainedHandle(
								name,
								retained,
								models,
								`Search adapter "${name}" schema models`
							);
							const plan = normalizeSchemaPlan(await schema.plan(safeModels), `Search adapter "${name}" schema plan`);
							assertSearchSchemaPlanSupported(retained, plan);
							assertSearchSchemaPlanModelInvariants(plan, safeModels, `Search adapter "${name}" schema plan`);
							return plan;
						}),
						apply: (models, options) => this.trackOperation(async () => {
							const retained = this.searchForRetainedHandle(name);
							const schema = retained.schema;
							if (!schema) throw new ActiveTsConfigurationError(`Search adapter "${name}" does not expose schema apply in this context.`);
							const safeModels = this.searchSchemaModelsForRetainedHandle(
								name,
								retained,
								models,
								`Search adapter "${name}" schema models`
							);
							const safeOptions = normalizeStoreSchemaApplyOptions(options, `Search adapter "${name}" schema apply options`);
							const plan = normalizeSchemaPlan(await schema.apply(safeModels, safeOptions), `Search adapter "${name}" schema apply plan`);
							assertSearchSchemaPlanSupported(retained, plan);
							assertSearchSchemaPlanModelInvariants(plan, safeModels, `Search adapter "${name}" schema apply plan`);
							return plan;
						})
					}
				: undefined,
			syncSchema: adapter.syncSchema
				? (models) => this.trackOperation(async () => {
						const retained = this.searchForRetainedHandle(name);
						if (!retained.syncSchema) throw new ActiveTsConfigurationError(`Search adapter "${name}" does not expose legacy schema sync in this context.`);
						const safeModels = this.searchSchemaModelsForRetainedHandle(
							name,
							retained,
							models,
							`Search adapter "${name}" syncSchema models`
						);
						const plan = normalizeSchemaPlan(await retained.syncSchema(safeModels), `Search adapter "${name}" syncSchema plan`);
						assertSearchSchemaPlanSupported(retained, plan);
						assertSearchSchemaPlanModelInvariants(plan, safeModels, `Search adapter "${name}" syncSchema plan`);
						return plan;
					})
				: undefined
		};
		defineScopedCapabilities<SearchCapabilities>(handle, () => this.searchForRetainedHandle(name).capabilities);
		defineDataProperty(handle, CONTEXT_BOUND_SEARCH_SOURCE, adapter, { enumerable: false, configurable: false });
		defineDataProperty(
			handle,
			CONTEXT_BOUND_SEARCH_DATASTORE_NAMESPACE,
			(model: ResolvedModelMeta) => this.store(model.store).datastoreNamespace,
			{ enumerable: false, configurable: false }
		);
		markAdapterTransactionOperationCarrier(handle, (run) => this.trackOperation(run));
		return markSearchAdapterSource(handle, adapter);
	}

	private searchSchemaModelsForRetainedHandle(
		name: string,
		retained: SearchAdapter,
		models: unknown,
		context: string
	) {
		const safeModels = normalizeSchemaModels(models, context);
		const indexKind = searchIndexAdapterKind(retained, name);
		const adapterModels: ResolvedModelMeta[] = [];
		for (let index = 0; index < safeModels.length; index++) {
			const adapterMeta = withSearchIndexesForAdapter(safeModels[index], name, indexKind);
			adapterModels[index] = withDatastoreSearchNamespace(
				adapterMeta,
				adapterMeta.datastore?.ancestor
					? this.internalStore(adapterMeta.store).datastoreNamespace
					: undefined
			);
		}
		return adapterModels;
	}

	lazyWarningsEnabled() {
		return this.config.lazyWarnings ?? true;
	}

	runHooks(
		name: ActiveTsHookName,
		payload: Omit<ActiveTsHookPayload, 'context'> & { context?: unknown }
	): Promise<ActiveTsHookPayload> {
		return contextOperationPromise(() => this.runTrackedScopedOperation(
			`run ${name} hooks`,
			(scoped) => scoped.runHooks(name, payload),
			async () => {
				this.assertTransactionOpen(`run ${name} hooks`);
				const normalized = normalizeHookPayloadInput(payload, this);
				const pluginHooks: Array<{ pluginName: string | undefined; hook: ActiveTsHook }> = [];
				const plugins = this.config.plugins ?? [];
				for (let pluginIndex = 0; pluginIndex < plugins.length; pluginIndex++) {
					const plugin = plugins[pluginIndex];
					const pluginName = ownValue(plugin as unknown as Record<string, unknown>, 'name') as string | undefined;
					const hooks = ownValue(plugin as unknown as Record<string, unknown>, 'hooks') as ActiveTsPlugin['hooks'] | undefined;
					const hooksForName = toHookList(hooks ? ownValue(hooks, name) : undefined);
					for (let hookIndex = 0; hookIndex < hooksForName.length; hookIndex++) {
						pluginHooks[pluginHooks.length] = { pluginName, hook: hooksForName[hookIndex] };
					}
				}
				const outboxWriteHooks: ActiveTsHook[] = [];
				const regularPluginHooks: ActiveTsHook[] = [];
				const planGuardHooks: ActiveTsHook[] = [];
				for (let index = 0; index < pluginHooks.length; index++) {
					const entry = pluginHooks[index];
					if (isOutboxWriteHook(name, entry.pluginName)) {
						outboxWriteHooks[outboxWriteHooks.length] = entry.hook;
					} else if (isSoftDeletePlanGuardHook(name, entry.hook)) {
						planGuardHooks[planGuardHooks.length] = entry.hook;
					} else {
						regularPluginHooks[regularPluginHooks.length] = entry.hook;
					}
				}
				const modelHookMap = normalized.model
					? ownValue(normalized.model as unknown as Record<string, unknown>, 'hooks', 'Hook payload model')
					: undefined;
				const modelHook = modelHookMap && typeof modelHookMap === 'object'
					? ownValue(modelHookMap as Record<string, ActiveTsHook | ActiveTsHook[]>, name, 'Hook payload model.hooks')
					: undefined;
				const modelHooks = toHookList(modelHook, `Hook payload model.hooks.${name}`);
				const hooks: ActiveTsHook[] = [];
				appendHooks(hooks, outboxWriteHooks);
				appendHooks(hooks, regularPluginHooks);
				appendHooks(hooks, modelHooks);
				appendHooks(hooks, planGuardHooks);
				return name === 'afterStoreWrite'
					? await runHookList(hooks, normalized, { independent: true })
					: await runHookList(hooks, normalized);
			}
		));
	}

	loadById<TModel>(model: ModelConstructor<TModel>, id: EntityId): Promise<TModel | null> {
		return contextOperationPromise(() => this.runTrackedScopedOperation(
			'load by id',
			(scoped) => scoped.loadById(model, id),
			async () => {
				this.assertTransactionOpen('load by id');
				assertModelConstructor(model, 'loadById model');
				assertSafeEntityId(id, 'loadById id');
				assertDirectIdReadAllowed(this.meta(model));
				let loader = WEAKMAP_GET.call(this.loaders, model) as BatchLoader<any> | undefined;
				if (!loader) {
					loader = new BatchLoader<any>((ids) => this.loadManyNow(model, ids), this.maxBatchSize);
					WEAKMAP_SET.call(this.loaders, model, loader);
				}
				return (await loader.load(id)) as TModel | null;
			}
		));
	}

	loadByIdFresh<TModel>(
		model: ModelConstructor<TModel>,
		id: EntityId,
		operation?: ActiveTsHookPayload['operation'],
		options?: StoreReadOptions
	): Promise<TModel | null> {
		return contextOperationPromise(() => this.runTrackedScopedOperation(
			'load by id from store',
			(scoped) => scoped.loadByIdFresh(model, id, operation, options),
			async () => {
				this.assertTransactionOpen('load by id from store');
				assertModelConstructor(model, 'loadByIdFresh model');
				assertSafeEntityId(id, 'loadByIdFresh id');
				const meta = this.meta(model);
				assertDirectIdReadAllowed(meta);
				const store = this.internalStore(meta.store);
				const safeOptions = options === undefined
					? undefined
					: normalizeStoreReadOptions(options, 'loadByIdFresh store read options');
				if (safeOptions !== undefined) {
					assertContextStoreReadOptionsSupported(store, safeOptions, 'loadByIdFresh store read options');
				}
				const readPolicy = safeOptions?.meta !== undefined &&
					Object.prototype.hasOwnProperty.call(safeOptions.meta, 'datastoreRead')
					? normalizeDatastoreReadPolicy(
							safeOptions.meta.datastoreRead,
							'loadByIdFresh store read options.meta.datastoreRead'
						)
					: undefined;
				await this.runHooks('beforeRead', { model: meta, ids: [id], operation: 'read' });
				let loaded = sanitizeReadResult(
					await store.getMany(meta, [id], safeOptions),
					[id],
					meta.idField,
					`Store adapter "${store.kind}" getMany`
				);
				const afterRead = await this.runHooks('afterRead', {
					model: meta,
					ids: [id],
					result: loaded,
					operation: 'read'
				});
				loaded = sanitizeReadResult(afterRead.result, [id], meta.idField, 'afterRead');
				const item = this.instantiate(model, loaded[0] ?? null);
				if (item) {
					if (readPolicy?.readTime !== undefined) markDatastoreHistoricalModel(item as object, readPolicy.readTime);
					await this.runAfterInstantiateHooks(meta, item as any, operation);
				}
				return item as TModel | null;
			}
		));
	}

	loadManyNow<TModel>(model: ModelConstructor<TModel>, ids: EntityId[]): Promise<Array<TModel | null>> {
		return contextOperationPromise(() => this.runTrackedScopedOperation(
			'load models',
			(scoped) => scoped.loadManyNow(model, ids),
			async () => {
				this.assertTransactionOpen('load models');
				assertModelConstructor(model, 'loadManyNow model');
				ids = assertSafeEntityIdArray(ids, 'loadManyNow ids');
				if (!ids.length) return [];
				const meta = this.meta(model);
				assertDirectIdReadAllowed(meta);
				if (ids.length > this.maxBatchSize) {
					const results: Array<TModel | null> = [];
					const chunks = chunkItems(ids, this.maxBatchSize);
					for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
						const chunkResults = await this.loadManyNow(model, chunks[chunkIndex]);
						for (let resultIndex = 0; resultIndex < chunkResults.length; resultIndex++) {
							results[results.length] = chunkResults[resultIndex];
						}
					}
					return results;
				}
				const store = this.internalStore(meta.store);
				const idsByKey = new Map<string, EntityId>();
				for (const id of ids) mapSet(idsByKey, entityIdKey(id), id);
				const uniqueIds = iterableToArray(MAP_VALUES.call(idsByKey) as Iterable<EntityId>);
				const cache = meta.cache && !this.transactionState ? this.internalCache(meta.cache.adapter) : undefined;
				const distributedCache = cache && meta.cache?.consistency === 'distributed'
					? this.assertDistributedCache(meta, cache)
					: undefined;
				const cacheKeys: string[] = [];
				if (cache) {
					for (let index = 0; index < uniqueIds.length; index++) {
						cacheKeys[index] = this.cacheKey(meta, uniqueIds[index]);
					}
				}
				const cacheEpochs = cache ? new Map<string, number>() : undefined;
				const cacheVersions = distributedCache ? new Map<string, string>() : undefined;
				if (cache && cacheEpochs) {
					for (let index = 0; index < cacheKeys.length; index++) {
						const key = cacheKeys[index];
						mapSet(cacheEpochs, key, this.cacheEpoch(cache, key));
					}
				}
					const dirtyKeys = this.transactionState?.dirtyCacheKeys;
					const cacheReadableIndexes: number[] = [];
					const failedDistributedCacheIndexes: number[] = [];
					if (cache) {
						for (let index = 0; index < cacheKeys.length; index++) {
							const key = cacheKeys[index];
							if (dirtyKeys && SET_HAS.call(dirtyKeys, key)) continue;
							if (this.hasCacheInvalidationFailure(cache, key)) {
								if (distributedCache) failedDistributedCacheIndexes[failedDistributedCacheIndexes.length] = index;
								continue;
							}
							cacheReadableIndexes[cacheReadableIndexes.length] = index;
						}
				}
				const cached = new Array(uniqueIds.length) as any[];
				for (let index = 0; index < uniqueIds.length; index++) cached[index] = undefined;
				if (cache && cacheReadableIndexes.length) {
					const readableIds: EntityId[] = [];
					const readableKeys: string[] = [];
					for (let index = 0; index < cacheReadableIndexes.length; index++) {
						const sourceIndex = cacheReadableIndexes[index];
						readableIds[index] = uniqueIds[sourceIndex];
						readableKeys[index] = cacheKeys[sourceIndex];
					}
					await this.runHooks('beforeCacheGet', {
						model: meta,
						ids: cloneArray(readableIds),
						operation: 'read',
						meta: { keys: cloneArray(readableKeys) }
					});
					let readableCached: any[];
					if (distributedCache && cacheVersions) {
						const snapshots = normalizeCacheVersionedValues(
							await distributedCache.getManyVersioned(readableKeys),
							readableKeys.length,
							`Cache adapter "${cache.kind}" getManyVersioned`
						);
						const values: any[] = [];
						for (let index = 0; index < snapshots.length; index++) {
							values[index] = snapshots[index].value;
							mapSet(cacheVersions, readableKeys[index], snapshots[index].version);
						}
						readableCached = sanitizeCacheGetResult(
							values,
							readableIds,
							meta.idField,
							`Cache adapter "${cache.kind}" getManyVersioned values`
						);
					} else {
						readableCached = sanitizeCacheGetResult(
							await cache.getMany(readableKeys),
							readableIds,
							meta.idField,
							`Cache adapter "${cache.kind}" getMany`
						);
					}
					readableCached = applyNegativeCachePolicy(readableCached, meta);
					const afterCacheGet = await this.runHooks('afterCacheGet', {
						model: meta,
						ids: cloneArray(readableIds),
						result: readableCached,
						operation: 'read',
						meta: { keys: cloneArray(readableKeys) }
					});
					readableCached = sanitizeCacheGetResult(afterCacheGet.result, readableIds, meta.idField, 'afterCacheGet');
					readableCached = applyNegativeCachePolicy(readableCached, meta);
					for (let index = 0; index < readableCached.length; index++) {
						const value = readableCached[index];
						const sourceIndex = cacheReadableIndexes[index];
						const key = cacheKeys[sourceIndex];
						if (
							(!dirtyKeys || !SET_HAS.call(dirtyKeys, key)) &&
							!this.hasCacheInvalidationFailure(cache, key) &&
							this.cacheEpochUnchanged(cache, key, cacheEpochs)
						) {
							cached[sourceIndex] = value;
						}
						}
					}
					if (distributedCache && cacheVersions && failedDistributedCacheIndexes.length) {
						const failedKeys: string[] = [];
						for (let index = 0; index < failedDistributedCacheIndexes.length; index++) {
							failedKeys[index] = cacheKeys[failedDistributedCacheIndexes[index]];
						}
						try {
							const snapshots = normalizeCacheVersionedValues(
								await distributedCache.getManyVersioned(failedKeys),
								failedKeys.length,
								`Cache adapter "${distributedCache.kind}" invalidation recovery getManyVersioned`
							);
							for (let index = 0; index < snapshots.length; index++) {
								mapSet(cacheVersions, failedKeys[index], snapshots[index].version);
							}
						} catch {
							// Keep serving authoritative store reads while the cache remains unavailable.
						}
					}
					const missingIds: EntityId[] = [];
				for (let index = 0; index < uniqueIds.length; index++) {
					if (cached[index] === undefined) missingIds[missingIds.length] = uniqueIds[index];
				}
				let loaded: Array<any | null> = [];
				if (missingIds.length) {
					await this.runHooks('beforeRead', { model: meta, ids: cloneArray(missingIds), operation: 'read' });
					loaded = sanitizeReadResult(
						await store.getMany(meta, missingIds),
						missingIds,
						meta.idField,
						`Store adapter "${store.kind}" getMany`
					);
					const afterRead = await this.runHooks('afterRead', {
						model: meta,
						ids: cloneArray(missingIds),
						result: loaded,
						operation: 'read'
					});
					loaded = sanitizeReadResult(afterRead.result, missingIds, meta.idField, 'afterRead');
				}
				const loadedById = new Map<string, any | null>();
				for (let index = 0; index < missingIds.length; index++) {
					mapSet(loadedById, entityIdKey(missingIds[index]), loaded[index] ?? null);
				}
				if (cache && missingIds.length && !this.transactionState) {
					const cacheableMissingIds: EntityId[] = [];
					for (let index = 0; index < missingIds.length; index++) {
						const id = missingIds[index];
						const key = this.cacheKey(meta, id);
						if (
							(!dirtyKeys || !SET_HAS.call(dirtyKeys, key)) &&
							this.cacheEpochUnchanged(cache, key, cacheEpochs) &&
							(!distributedCache || (cacheVersions !== undefined && mapHas(cacheVersions, key)))
						) {
							cacheableMissingIds[cacheableMissingIds.length] = id;
						}
					}
					const positiveIds: EntityId[] = [];
					const negativeIds: EntityId[] = [];
					for (let index = 0; index < cacheableMissingIds.length; index++) {
						const id = cacheableMissingIds[index];
						const loadedValue = mapGet(loadedById, entityIdKey(id));
						if (loadedValue !== null) {
							positiveIds[positiveIds.length] = id;
						} else if (meta.cache?.negativeTtl !== undefined) {
							negativeIds[negativeIds.length] = id;
						}
					}
					const positives: Array<[string, any]> = [];
					for (let index = 0; index < positiveIds.length; index++) {
						const id = positiveIds[index];
						positives[index] = [this.cacheKey(meta, id), mapGet(loadedById, entityIdKey(id))];
					}
					const negatives: Array<[string, any]> = [];
					for (let index = 0; index < negativeIds.length; index++) {
						negatives[index] = [this.cacheKey(meta, negativeIds[index]), null];
					}
					await this.writeCacheEntries(
						cache,
						meta,
						positiveIds,
						positives,
						meta.cache?.ttl,
						'positive',
						cacheEpochs,
						cacheVersions
					);
					await this.writeCacheEntries(
						cache,
						meta,
						negativeIds,
						negatives,
						meta.cache?.negativeTtl,
						'negative',
						cacheEpochs,
						cacheVersions
					);
				}
				const rawById = new Map<string, any | null>();
				for (let index = 0; index < uniqueIds.length; index++) {
					const id = uniqueIds[index];
					const value = cached[index] !== undefined ? cached[index] : mapGet(loadedById, entityIdKey(id));
					mapSet(rawById, entityIdKey(id), value ?? null);
				}
				const list: Array<TModel | null> = [];
				const afterInstantiateTasks: Array<Promise<unknown>> = [];
				for (let index = 0; index < ids.length; index++) {
					const item = this.instantiate(model, mapGet(rawById, entityIdKey(ids[index]))) as TModel | null;
					list[index] = item;
					if (item) afterInstantiateTasks[afterInstantiateTasks.length] = this.runAfterInstantiateHooks(meta, item as any);
				}
				await Promise.all(afterInstantiateTasks);
				return list;
			}
		));
	}

	runAfterInstantiateHooks(
		meta: ResolvedModelMeta,
		item: { data: Record<string, any> },
		operation?: ActiveTsHookPayload['operation']
	): Promise<void> {
		return contextOperationPromise(() => this.runTrackedScopedOperation(
			'run afterInstantiate hooks',
			(scoped) => scoped.runAfterInstantiateHooks(meta, item, operation),
			async () => {
				this.assertTransactionOpen('run afterInstantiate hooks');
				const expectedPartial = isPartialModel(item);
				const beforeData = modelDataValue(item, 'afterInstantiate target');
				const beforeId = valueFor(beforeData, meta.idField);
				assertSafeEntityId(beforeId, `${meta.name}.${meta.idField}`);
				const scopedDatastoreAncestor = (item as any)[MODEL_DATASTORE_WRITE_ANCESTOR] as DatastoreKey | undefined;
				const expectedDatastoreAncestor = scopedDatastoreAncestor ?? (
					meta.datastore?.ancestor
						? datastorePayloadResolvedAncestor(meta, beforeId, beforeData, 'afterInstantiate target') ??
							(expectedPartial ? undefined : meta.datastore.ancestor({ model: meta, id: beforeId, data: beforeData }))
						: undefined
				);
				const payload = operation === undefined
					? { model: meta, target: item as any, data: beforeData }
					: { model: meta, target: item as any, data: beforeData, operation };
				const after = await this.runHooks('afterInstantiate', payload);
				const currentData = modelDataValue(item, 'afterInstantiate target');
				const candidate = after.data !== beforeData ? after.data : currentData;
				if (isPartialModel(item) !== expectedPartial) {
					throw new ActiveTsValidationError('afterInstantiate hook cannot change model partial marker state.');
				}
				const clean = this.validateDecodedRead(meta, candidate, { partial: expectedPartial });
				const afterId = valueFor(clean, meta.idField);
				assertSafeEntityId(afterId, `${meta.name}.${meta.idField}`);
				if (entityIdKey(afterId) !== entityIdKey(beforeId)) {
					throw new ActiveTsValidationError(
						`afterInstantiate hook cannot change ${meta.name}.${meta.idField}.`
					);
				}
				if (expectedDatastoreAncestor !== undefined && meta.datastore?.ancestor) {
					const retainedDatastoreAncestor = (item as any)[MODEL_DATASTORE_WRITE_ANCESTOR] as DatastoreKey | undefined;
					let canResolveDatastoreAncestor = true;
					if (expectedPartial && retainedDatastoreAncestor !== undefined) {
						canResolveDatastoreAncestor = datastorePayloadCanResolveAncestor(
							meta,
							afterId,
							clean,
							'afterInstantiate hook'
						);
					}
					const actualDatastoreAncestor = canResolveDatastoreAncestor
						? datastorePayloadResolvedAncestor(meta, afterId, clean, 'afterInstantiate hook') ??
							meta.datastore.ancestor({ model: meta, id: afterId, data: clean })
						: retainedDatastoreAncestor;
					if (!datastoreScopedAncestorMatches(actualDatastoreAncestor, expectedDatastoreAncestor)) {
						throw new ActiveTsValidationError(
							`afterInstantiate hook cannot move ${meta.name}:${String(beforeId)} outside the scoped Datastore ancestor.`
						);
					}
				}
				replaceModelData(item, currentData, clean);
			}
		));
	}

	validateModelInstance(
		meta: ResolvedModelMeta,
		item: { data: Record<string, any> },
		context: string,
		options: { expectedId?: EntityId; expectedDatastoreAncestor?: DatastoreKey; partial?: boolean } = {}
	) {
		this.assertTransactionOpen('validate model instances');
		const currentData = modelDataValue(item, context);
		if (options.partial !== undefined && isPartialModel(item) !== options.partial) {
			throw new ActiveTsValidationError(`${context} cannot change model partial marker state.`);
		}
		const clean = this.validateDecodedRead(meta, currentData, {
			partial: options.partial ?? isPartialModel(item)
		});
		const id = valueFor(clean, meta.idField);
		if (id === undefined || id === null) {
			throw new ActiveTsValidationError(`${context} is missing id field "${meta.idField}".`);
		}
		assertSafeEntityId(id, `${meta.name}.${meta.idField}`);
		if (options.expectedId !== undefined && entityIdKey(id) !== entityIdKey(options.expectedId)) {
			throw new ActiveTsValidationError(`${context} cannot change ${meta.name}.${meta.idField}.`);
		}
		if (options.expectedDatastoreAncestor !== undefined && meta.datastore?.ancestor) {
			const actualDatastoreAncestor = datastorePayloadResolvedAncestor(meta, id, clean, context) ??
				meta.datastore.ancestor({ model: meta, id, data: clean });
			if (!datastoreScopedAncestorMatches(actualDatastoreAncestor, options.expectedDatastoreAncestor)) {
				const expectedId = options.expectedId ?? id;
				throw new ActiveTsValidationError(
					`${context} cannot move ${meta.name}:${String(expectedId)} outside the scoped Datastore ancestor.`
				);
			}
		}
		replaceModelData(item, currentData, clean);
		return clean;
	}

	instantiate<TModel>(
		model: ModelConstructor<TModel>,
		raw: any | null | undefined,
		options: ReadOptions = {},
		captureConstructorData?: (data: Record<string, any>) => void
	) {
		this.assertTransactionOpen('instantiate models');
		options = normalizeReadOptions(options, 'instantiate options');
		if (raw === null || raw === undefined) return null;
		const meta = this.meta(model);
		const data = this.validateRead(meta, raw, options);
		const id = valueFor(data, meta.idField);
		if (id === undefined || id === null) {
			throw new ActiveTsValidationError(`${meta.name} read data is missing id field "${meta.idField}".`);
		}
		assertSafeEntityId(id, `${meta.name}.${meta.idField}`);
		if (captureConstructorData !== undefined) {
			if (typeof captureConstructorData !== 'function') {
				throw new ActiveTsConfigurationError('instantiate constructor data capture must be a function.');
			}
			captureConstructorData(cloneSafeDataObject(data, `${meta.name} constructor data`));
		}
		const item = new model(data, this, { persisted: true, [MODEL_PERSISTED_TOKEN]: true });
		return options.partial ? markPartialModel(item as object) as TModel : item;
	}

	#trackTransactionModelInstance(item: object): void {
		const scoped = this.transactionScopedContext('track transaction model instances');
		if (scoped !== this) return scoped.#trackTransactionModelInstance(item);
		if (!this.transactionState || this.transactionState.closed) return;
		SET_ADD.call(this.transactionState.modelInstances, item);
	}

	validateWrite(meta: ResolvedModelMeta, data: any) {
		this.assertTransactionOpen('validate writes');
		const input = cloneSafeDataObject(data, `${meta.name} write data`);
		if (!meta.validator) {
			return input;
		}
		try {
			const clean = cloneSafeData(meta.validator(input));
			assertPlainDataObject(clean, `${meta.name} write data`);
			return clean;
		} catch (error) {
			throw new ActiveTsValidationError(
				`Write validation failed for ${meta.name}: ${safeErrorMessage(error)}`
			);
		}
	}

	prepareWrite(
		meta: ResolvedModelMeta,
		data: any,
		operation: 'create' | 'update',
		target?: unknown
	): Promise<any> {
		return contextOperationPromise(() => this.runTrackedScopedOperation(
			'prepare writes',
			(scoped) => scoped.prepareWrite(meta, data, operation, target),
			async () => {
				this.assertTransactionOpen('prepare writes');
				const input = cloneSafeDataObject(data, `${meta.name} ${operation} data`);
				const before = await this.runHooks('beforeValidate', { model: meta, data: input, target, operation });
				const clean = this.validateWrite(meta, before.data);
				const after = await this.runHooks('afterValidate', {
					model: meta,
					data: clean,
					target,
					operation
				});
				return this.validateWrite(meta, after.data);
			}
		));
	}

	encodeWrite(meta: ResolvedModelMeta, data: any) {
		this.assertTransactionOpen('encode writes');
		const encoded = applyFieldCodecs(meta, applyFieldTypeTransforms(meta, data, 'write'), 'write');
		assertPortableStoredData(encoded, `${meta.name} stored data`);
		return encoded;
	}

	validateRead(meta: ResolvedModelMeta, data: any, options: ReadOptions = {}) {
		this.assertTransactionOpen('validate reads');
		options = normalizeReadOptions(options, 'read validation options');
		const codecDecoded = options.fieldCodecs === false ? cloneSafeData(data) : applyFieldCodecs(meta, data, 'read');
		return this.validateDecodedRead(meta, codecDecoded, { partial: options.partial });
	}

	validateDecodedRead(meta: ResolvedModelMeta, data: any, options: { partial?: boolean } = {}) {
		this.assertTransactionOpen('validate decoded reads');
		const decoded = applyFieldTypeTransforms(meta, cloneSafeData(data), 'read');
		assertPlainDataObject(decoded, `${meta.name} read data`);
		if (options.partial) return decoded;
		if (!meta.validator || meta.readValidation === 'off') return decoded;
		let validated: any;
		try {
			validated = meta.validator(decoded);
			const clean = cloneSafeDataObject(validated, `${meta.name} read data`);
			assertReadValidatorPreservesId(meta, decoded, clean);
			return clean;
		} catch (error) {
			const message = `Read validation failed for ${meta.name}: ${safeErrorMessage(error)}`;
			if (meta.readValidation === 'error') throw new ActiveTsValidationError(message);
			console.warn(message);
			return decoded;
		}
	}

	invalidate(meta: ResolvedModelMeta, id: EntityId): Promise<void> {
		return contextOperationPromise(() => this.runTrackedScopedOperation(
			'invalidate cache entries',
			(scoped) => scoped.invalidate(meta, id),
			async () => {
				this.assertTransactionOpen('invalidate cache entries');
				if (!meta.cache) return;
				const cache = this.internalCache(meta.cache.adapter);
				if (!cache) return;
				if (meta.cache.consistency === 'distributed') this.assertDistributedCache(meta, cache);
				if (this.transactionState) {
					this.assertTransactionWritable('invalidate cache entries');
					const txState = this.transactionState;
					const key = this.cacheKey(meta, id);
					SET_ADD.call(txState.dirtyCacheKeys, key);
					if (!mapHas(txState.cacheInvalidations, key)) {
						const task = () => txState.root.performInvalidate(meta, id);
						mapSet(txState.cacheInvalidations, key, { meta, id, task });
						txState.internalAfterCommit.push(task);
					}
					return;
				}
				await this.performInvalidate(meta, id);
			}
		));
	}

	invalidateModel(model: ModelConstructor, id: EntityId): Promise<void> {
		return contextOperationPromise(() => this.runTrackedScopedOperation(
			'invalidate model cache entries',
			(scoped) => scoped.invalidateModel(model, id),
			async () => {
				this.assertTransactionOpen('invalidate model cache entries');
				assertModelConstructor(model, 'invalidateModel model');
				assertSafeEntityId(id, 'invalidateModel id');
				await this.invalidate(this.meta(model), id);
			}
		));
	}

	invalidateModelExternal(model: ModelConstructor, id: EntityId): Promise<void> {
		return contextOperationPromise(() => transactionContextStorage.exit(() => {
			this.assertTransactionOpen('invalidate model cache entries for an external commit');
			assertModelConstructor(model, 'invalidateModelExternal model');
			assertSafeEntityId(id, 'invalidateModelExternal id');
			const root = this.rootContext();
			root.assertTransactionOpen('invalidate model cache entries for an external commit');
			return root.invalidateModel(model, id);
		}));
	}

	private async performInvalidate(meta: ResolvedModelMeta, id: EntityId) {
		if (!meta.cache) return;
		const cache = this.internalCache(meta.cache.adapter);
		if (!cache) return;
		const distributedCache = meta.cache.consistency === 'distributed'
			? this.assertDistributedCache(meta, cache)
			: undefined;
		const key = this.cacheKey(meta, id);
		this.bumpCacheEpoch(cache, key);
		try {
			await this.runHooks('beforeCacheInvalidate', {
				model: meta,
				id,
				operation: 'cache',
				meta: { keys: [key] }
			});
			if (distributedCache) await distributedCache.invalidateMany([key]);
			else await cache.deleteMany([key]);
			this.bumpCacheEpoch(cache, key);
		} catch (error) {
			this.markCacheInvalidationFailure(cache, key);
			throw error;
		}
		this.clearCacheInvalidationFailure(cache, key);
		await this.runHooks('afterCacheInvalidate', {
			model: meta,
			id,
			operation: 'cache',
			meta: { keys: [key] }
		});
	}

	schemaPlan(models: ModelConstructor[]): Promise<SchemaPlan[]> {
		return contextOperationPromise(() => this.runTrackedScopedOperation(
			'plan schema changes',
			(scoped) => scoped.schemaPlan(models),
			async () => {
				this.assertTransactionOpen('plan schema changes');
				this.assertNotInTransaction('plan schema changes');
				const safeModels = normalizeModelList(models, 'schemaPlan models');
				const grouped = this.groupModelsByStore(safeModels);
				const plans: SchemaPlan[] = [];
				for (const [storeName, metas] of grouped) {
					const store = this.internalStore(storeName);
					assertStoreSchemaModelsSupported(store, metas);
					const schema = store.schema;
					if (schema) {
						const plan = routeSchemaPlan(
							normalizeSchemaPlan(await schema.plan(metas), `Store adapter "${storeName}" schema plan`),
							storeName
						);
						assertStoreSchemaPlanSupported(store, plan);
						plans.push(plan);
					} else {
						const plan = manualStoreSchemaPlan(storeName, store, metas);
						if (plan.changes.length) plans.push(plan);
					}
				}
				for (const [searchName, metas] of this.groupModelsBySearch(safeModels)) {
					const adapter = this.internalSearchAdapter(searchName);
					const schema = adapter.schema;
					if (schema) {
						const plan = routeSchemaPlan(
							normalizeSchemaPlan(await schema.plan(metas), `Search adapter "${searchName}" schema plan`),
							searchName
						);
						assertSearchSchemaPlanSupported(adapter, plan);
						assertSearchSchemaPlanModelInvariants(plan, metas, `Search adapter "${searchName}" schema plan`);
						plans.push(plan);
					} else {
						const plan = manualSearchSchemaPlan(searchName, adapter, metas);
						if (plan.changes.length) plans.push(plan);
					}
				}
				return plans;
			}
		));
	}

	schemaApply(models: ModelConstructor[], options: { mode?: SchemaSyncMode } = {}): Promise<SchemaPlan[]> {
		return contextOperationPromise(() => this.runTrackedScopedOperation(
			'apply schema changes',
			(scoped) => scoped.schemaApply(models, options),
			async () => {
				this.assertTransactionOpen('apply schema changes');
				this.assertNotInTransaction('apply schema changes');
				const safeModels = normalizeModelList(models, 'schemaApply models');
				const applyOptions = normalizeSchemaApplyOptions(options);
				const mode = applyOptions.mode ?? this.config.schema?.autoSync;
				if (!mode || mode === 'off') return [];
				const grouped = this.groupModelsByStore(safeModels);
				const plans: SchemaPlan[] = [];
				for (const [storeName, metas] of grouped) {
					const store = this.internalStore(storeName);
					assertStoreSchemaModelsSupported(store, metas);
					const schema = store.schema;
					if (schema) {
						const plan = routeSchemaPlan(
							normalizeSchemaPlan(await schema.apply(metas, { mode }), `Store adapter "${storeName}" schema apply plan`),
							storeName
						);
						assertStoreSchemaPlanSupported(store, plan);
						plans.push(plan);
					} else {
						const plan = manualStoreSchemaPlan(storeName, store, metas);
						if (plan.changes.length) plans.push(plan);
					}
				}
				for (const [searchName, metas] of this.groupModelsBySearch(safeModels)) {
					const adapter = this.internalSearchAdapter(searchName);
					const schema = adapter.schema;
					if (schema) {
						const plan = routeSchemaPlan(
							normalizeSchemaPlan(await schema.apply(metas, { mode }), `Search adapter "${searchName}" schema apply plan`),
							searchName
						);
						assertSearchSchemaPlanSupported(adapter, plan);
						assertSearchSchemaPlanModelInvariants(plan, metas, `Search adapter "${searchName}" schema apply plan`);
						plans.push(plan);
					} else if (adapter.syncSchema) {
						const plan = routeSchemaPlan(
							normalizeSchemaPlan(await adapter.syncSchema(metas), `Search adapter "${searchName}" legacy schema apply plan`),
							searchName
						);
						assertSearchSchemaPlanSupported(adapter, plan);
						assertSearchSchemaPlanModelInvariants(plan, metas, `Search adapter "${searchName}" legacy schema apply plan`);
						plans.push(plan);
					} else {
						const plan = manualSearchSchemaPlan(searchName, adapter, metas);
						if (plan.changes.length) plans.push(plan);
					}
				}
				return plans;
			}
		));
	}

	schemaMigration(models: ModelConstructor[], name: string): Promise<{
		name: string;
		createdAt: string;
		plans: SchemaPlan[];
		changes: Array<SchemaChange & { adapter: string }>;
		empty: boolean;
		summary: string[];
	}> {
		return contextOperationPromise(() => this.runTrackedScopedOperation(
			'create schema migrations',
			(scoped) => scoped.schemaMigration(models, name),
			async () => {
				this.assertTransactionOpen('create schema migrations');
				this.assertNotInTransaction('create schema migrations');
				const safeModels = normalizeModelList(models, 'schemaMigration models');
				const safeName = assertSafeSchemaIdentifier(name, 'migration name');
				const plans = await this.schemaPlan(safeModels);
				const changes: Array<SchemaChange & { adapter: string }> = [];
				for (let planIndex = 0; planIndex < plans.length; planIndex++) {
					const plan = plans[planIndex];
					const adapter = plan.route ?? plan.adapter;
					for (let changeIndex = 0; changeIndex < plan.changes.length; changeIndex++) {
						changes[changes.length] = { adapter, ...plan.changes[changeIndex] };
					}
				}
				const summary: string[] = [];
				for (let index = 0; index < changes.length; index++) {
					const change = changes[index];
					summary[index] = `${change.adapter}:${change.type}:${change.target}`;
				}
				return {
					name: safeName,
					createdAt: dateIsoString(new Date()),
					plans,
					changes,
					empty: changes.length === 0,
					summary
				};
			}
		));
	}

	transaction<T>(
		fn: (context: ActiveContext) => Promise<T>,
		options: TransactionOptions = {}
	): Promise<T> {
		try {
			if (typeof fn !== 'function') {
				throw new ActiveTsConfigurationError('transaction callback must be a function.');
			}
			const txOptions = normalizeTransactionOptions(options);
			const scoped = this.transactionScopedContext('start transactions');
			if (scoped !== this) return scoped.transaction(fn, txOptions);
			if (this.transactionState) {
				const storeName = txOptions.store ?? this.transactionState.storeName;
				if (storeName !== this.transactionState.storeName) {
					throw new ActiveTsConfigurationError(
						`Cannot start nested transaction for store "${storeName}" inside transaction scoped to store "${this.transactionState.storeName}".`
					);
				}
				const join = txOptions.join ?? 'error';
				if (join === 'error') {
					throw new ActiveTsConfigurationError('Cannot start transactions inside a transaction.');
				}
				if (txOptions.isolation !== undefined && txOptions.isolation !== this.transactionState.isolation) {
					throw new ActiveTsConfigurationError(
						'Cannot change transaction isolation inside an active transaction.'
					);
				}
				if (txOptions.readOnly !== undefined && txOptions.readOnly !== this.transactionState.readOnly) {
					throw new ActiveTsConfigurationError(
						'Cannot change transaction readOnly mode inside an active transaction.'
					);
				}
				if (txOptions.timeoutMs !== undefined || txOptions.native !== undefined) {
					throw new ActiveTsConfigurationError(
						'Cannot apply timeoutMs or native transaction options inside an active transaction.'
					);
				}
				if (join === 'reuse') {
					return this.trackOperation(() => transactionContextStorage.run(this, () => fn(this)));
				}
				const parentState = this.transactionState;
				const store = this.internalStore(storeName);
				if (store.capabilities?.savepoint !== true || typeof store.savepoint !== 'function') {
					throw new ActiveTsConfigurationError(
						`Store adapter "${store.kind}" does not support transaction savepoints.`
					);
				}
				return this.trackOperation(async () => {
					let state: TransactionState | undefined;
					let callbackStarted = false;
					let callbackCompletion: Promise<T> | undefined;
					let callbackSettled = false;
					let callbackRejected = false;
					let callbackError: unknown;
					let callbackProtocolError: ActiveTsConfigurationError | undefined;
					let callbackAdmissionOpen = true;
					let callbackStartAllowed = false;
					let callbackStart: (() => void) | undefined;
					const queueCallbackStart = () => {
						if (!callbackStartAllowed || !callbackStart) return;
						const start = callbackStart;
						callbackStart = undefined;
						const scheduled = PROMISE_THEN.call(
							SAFE_PROMISE_RESOLVE(undefined),
							start
						) as Promise<void>;
						void PROMISE_THEN.call(scheduled, undefined, NOOP_REJECTION_OBSERVER);
					};
					try {
						let savepointRejected = false;
						let savepointError: unknown;
						let result!: T;
						let savepointCompletion: Promise<T> | undefined;
						try {
							const pendingSavepointCompletion = store.savepoint!((txStore) => {
								if (!callbackAdmissionOpen || callbackStarted) {
									const protocolError = markSavepointRollbackUnconfirmed(
										new ActiveTsConfigurationError(
											!callbackAdmissionOpen
												? `Store adapter "${store.kind}" ran a savepoint callback after the savepoint settled.`
												: `Store adapter "${store.kind}" ran a savepoint callback more than once.`
										)
									);
									callbackProtocolError ??= protocolError;
									let current: TransactionState | undefined = parentState;
									while (current) {
										current.rollbackOnlyError ??= protocolError;
										current = current.parent;
									}
									const rejection = SAFE_PROMISE_REJECT(protocolError);
									void PROMISE_THEN.call(rejection, undefined, NOOP_REJECTION_OBSERVER);
									return rejection;
								}
								callbackStarted = true;
								let releaseCallbackStart!: () => void;
								let rejectCallbackStart!: (error: unknown) => void;
								const callbackStartBarrier = new Promise<void>((resolve, reject) => {
									releaseCallbackStart = resolve;
									rejectCallbackStart = reject;
								});
								callbackStart = () => {
									if (callbackAdmissionOpen) {
										releaseCallbackStart();
										return;
									}
									const protocolError = markSavepointRollbackUnconfirmed(
										new ActiveTsConfigurationError(
											`Store adapter "${store.kind}" ran a savepoint callback after the savepoint settled.`
										)
									);
									callbackProtocolError ??= protocolError;
									let current: TransactionState | undefined = parentState;
									while (current) {
										current.rollbackOnlyError ??= protocolError;
										current = current.parent;
									}
									rejectCallbackStart(protocolError);
								};
								const execution = (async () => {
									await callbackStartBarrier;
									const callbackOperationState: { closed?: string } = {};
									const dirtyCacheKeys = new Set<string>();
									SET_FOR_EACH.call(parentState.dirtyCacheKeys, (key: string) => {
										SET_ADD.call(dirtyCacheKeys, key);
									});
									const cacheKeyOwners = new Map<string, string>();
									MAP_FOR_EACH.call(parentState.cacheKeyOwners, (owner: string, key: string) => {
										mapSet(cacheKeyOwners, key, owner);
									});
									const entityCacheKeys = new Map<string, string>();
									MAP_FOR_EACH.call(parentState.entityCacheKeys, (key: string, owner: string) => {
										mapSet(entityCacheKeys, owner, key);
									});
									state = {
										root: parentState.root,
										parent: parentState,
										storeName,
										isolation: parentState.isolation,
										readOnly: parentState.readOnly,
										internalAfterCommit: [],
										afterCommit: [],
										afterRollback: [],
										modelInstances: new Set(),
										dirtyCacheKeys,
										cacheInvalidations: new Map(),
										cacheKeyOwners,
										entityCacheKeys,
										callbackOperationState,
										callbackOperations: createTransactionOperationTracker(
											() => callbackOperationState.closed,
											'active-ts savepoint context'
										)
									};
									const stores = Object.create(null) as Record<string, StoreAdapter>;
									const storeNames = Object.keys(this.config.stores);
									for (let storeIndex = 0; storeIndex < storeNames.length; storeIndex++) {
										const name = storeNames[storeIndex];
										stores[name] =
											name === storeName
												? createTransactionScopedStore(txStore, this.config.stores[name])
												: this.config.stores[name];
									}
									const txContext = this.fork({ stores }, state);
									state.context = txContext;
									try {
										const callbackResult = await transactionContextStorage.run(txContext, () =>
											fn(txContext)
										);
										state.callbackOperationState.closed = 'finished';
										await waitForContextOperations(state);
										if (state.rollbackOnlyError !== undefined) throw state.rollbackOnlyError;
										for (const [key, owner] of state.cacheKeyOwners) {
											this.assertStableEntityCacheKeyMaps(
												parentState.cacheKeyOwners,
												parentState.entityCacheKeys,
												owner,
												key
											);
										}
										return callbackResult;
									} catch (error) {
										state.callbackOperationState.closed = 'rolled back';
										try {
											await waitForContextOperations(state);
										} catch {
											// Preserve the callback or operation error that triggered rollback.
										}
										throw error;
									}
								})();
								const completion = PROMISE_THEN.call(
									execution,
									(value: T) => {
										callbackSettled = true;
										return value;
									},
									(error: unknown) => {
										callbackSettled = true;
										callbackRejected = true;
										callbackError = error;
										throw error;
									}
								) as Promise<T>;
								callbackCompletion = completion;
								void PROMISE_THEN.call(completion, undefined, NOOP_REJECTION_OBSERVER);
								queueCallbackStart();
								return completion;
							});
							savepointCompletion = observeAdapterTransactionPromiseSettlement(
								pendingSavepointCompletion,
								() => {
									callbackAdmissionOpen = false;
								}
							);
						} catch (error) {
							callbackAdmissionOpen = false;
							savepointRejected = true;
							savepointError = error;
						}
						callbackStartAllowed = true;
						queueCallbackStart();
						if (savepointCompletion) {
							try {
								result = await savepointCompletion;
							} catch (error) {
								savepointRejected = true;
								savepointError = error;
							}
						}
						if (savepointRejected) {
							if (callbackCompletion && !callbackSettled) {
								let callbackFailed = false;
								let callbackFailure: unknown;
								try {
									await callbackCompletion;
								} catch (error) {
									callbackFailed = true;
									callbackFailure = error;
								}
								if (callbackProtocolError) throw callbackProtocolError;
								const malformed = new ActiveTsConfigurationError(
									`Store adapter "${store.kind}" rejected a savepoint before its callback settled.`
								);
								const causes = callbackFailed
									? [savepointError, callbackFailure]
									: [savepointError];
								defineDataProperty(
									malformed,
									'cause',
									causes.length === 1
										? causes[0]
										: new AggregateError(causes, 'Savepoint adapter and callback failed.'),
									{ enumerable: false, configurable: true }
								);
								let current: TransactionState | undefined = parentState;
								while (current) {
									current.rollbackOnlyError ??= malformed;
									current = current.parent;
								}
								throw markSavepointRollbackUnconfirmed(malformed);
							}
							if (callbackProtocolError) throw callbackProtocolError;
							throw savepointError;
						}
						if (callbackProtocolError) throw callbackProtocolError;
						if (!state) {
							throw new ActiveTsConfigurationError(
								`Store adapter "${store.kind}" completed a savepoint without running the callback.`
							);
						}
						if (!callbackCompletion) {
							throw new ActiveTsConfigurationError(
								`Store adapter "${store.kind}" completed a savepoint without returning its callback Promise.`
							);
						}
						if (!callbackSettled) {
							let callbackError: unknown;
							try {
								await callbackCompletion;
							} catch (error) {
								callbackError = error;
							}
							if (callbackProtocolError) throw callbackProtocolError;
							const malformed = new ActiveTsConfigurationError(
								`Store adapter "${store.kind}" completed a savepoint before its callback settled.`
							);
							if (callbackError !== undefined) {
								defineDataProperty(malformed, 'cause', callbackError, {
									enumerable: false,
									configurable: true
								});
							}
							let current: TransactionState | undefined = parentState;
							while (current) {
								current.rollbackOnlyError ??= malformed;
								current = current.parent;
							}
							throw markSavepointRollbackUnconfirmed(malformed);
						}
						if (callbackRejected) {
							const malformed = new ActiveTsConfigurationError(
								`Store adapter "${store.kind}" completed a savepoint after its callback failed.`
							);
							defineDataProperty(malformed, 'cause', callbackError, {
								enumerable: false,
								configurable: true
							});
							let current: TransactionState | undefined = parentState;
							while (current) {
								current.rollbackOnlyError ??= malformed;
								current = current.parent;
							}
							throw markSavepointRollbackUnconfirmed(malformed);
						}
						const childInvalidationTasks = new Set<DeferredTask>();
						const acceptedInvalidationTasks = new Set<DeferredTask>();
						MAP_FOR_EACH.call(
							state.cacheInvalidations,
							(
								invalidation: { meta: ResolvedModelMeta; id: EntityId; task: DeferredTask },
								key: string
							) => {
								SET_ADD.call(childInvalidationTasks, invalidation.task);
								if (mapHas(parentState.cacheInvalidations, key)) return;
								mapSet(parentState.cacheInvalidations, key, invalidation);
								SET_ADD.call(acceptedInvalidationTasks, invalidation.task);
							}
						);
						for (let index = 0; index < state.internalAfterCommit.length; index++) {
							const task = state.internalAfterCommit[index];
							if (
								!SET_HAS.call(childInvalidationTasks, task) ||
								SET_HAS.call(acceptedInvalidationTasks, task)
							)
								parentState.internalAfterCommit.push(task);
						}
						for (let index = 0; index < state.afterCommit.length; index++) {
							parentState.afterCommit.push(state.afterCommit[index]);
						}
						for (let index = 0; index < state.afterRollback.length; index++) {
							parentState.afterRollback.push(state.afterRollback[index]);
						}
						SET_FOR_EACH.call(state.modelInstances, (value: object) => {
							SET_ADD.call(parentState.modelInstances, value);
						});
						SET_FOR_EACH.call(state.dirtyCacheKeys, (key: string) => {
							SET_ADD.call(parentState.dirtyCacheKeys, key);
						});
						for (const [key, owner] of state.cacheKeyOwners)
							mapSet(parentState.cacheKeyOwners, key, owner);
						for (const [owner, key] of state.entityCacheKeys)
							mapSet(parentState.entityCacheKeys, owner, key);
						state.closed = 'released';
						rebindTransactionModels(result, state, this);
						return result;
					} catch (error) {
						if (state && !state.closed) {
							if (savepointRollbackUnconfirmed(error)) {
								state.closed = 'failed';
								for (let index = 0; index < state.afterRollback.length; index++) {
									parentState.afterRollback.push(state.afterRollback[index]);
								}
								SET_FOR_EACH.call(state.modelInstances, (value: object) => {
									SET_ADD.call(parentState.modelInstances, value);
								});
							} else {
								state.closed = 'rolled back';
								markRolledBackTransactionModelInstances(state);
								attachRollbackTaskErrors(
									error,
									await runDeferredTasks('afterRollback', state.afterRollback, {
										throwOnError: false
									})
								);
							}
						}
						throw error;
					}
				});
			}
			return (async () => {
				this.assertNotInTransaction('start transactions');
				const storeName = txOptions.store ?? this.config.defaultStore;
				const store = this.internalStore(storeName);
				if (!store.transaction || store.capabilities?.transaction !== true) {
					throw new ActiveTsConfigurationError(`Store adapter "${store.kind}" does not support transactions.`);
				}
				const storeOptions: StoreTransactionOptions = {};
				if (txOptions.isolation !== undefined) storeOptions.isolation = txOptions.isolation;
				if (txOptions.readOnly !== undefined) storeOptions.readOnly = txOptions.readOnly;
				if (txOptions.timeoutMs !== undefined) storeOptions.timeoutMs = txOptions.timeoutMs;
				if (txOptions.native !== undefined) {
					storeOptions.native = cloneNativePayload(txOptions.native, 'store transaction options.native');
				}
				const createState = (): TransactionState => {
					const callbackOperationState: { closed?: string } = {};
					const state: TransactionState = {
						root: this,
						storeName,
						isolation: txOptions.isolation,
						readOnly: txOptions.readOnly === true,
						internalAfterCommit: [],
						afterCommit: [],
						afterRollback: [],
						modelInstances: new Set(),
						dirtyCacheKeys: new Set(),
						cacheInvalidations: new Map(),
						cacheKeyOwners: new Map(),
						entityCacheKeys: new Map(),
						callbackOperationState,
						callbackOperations: createTransactionOperationTracker(
							() => callbackOperationState.closed,
							'active-ts context'
						)
					};
					state.internalAfterCommit.push(() => this.mergeTransactionCacheKeyOwnership(state));
					return state;
				};
				const rollbackAttempt = async (state: TransactionState, options: { staleTrackedModels: boolean }) => {
					if (state.closed) return [];
					state.closed = 'rolled back';
					if (options.staleTrackedModels) markRolledBackTransactionModelInstances(state);
					return await runDeferredTasks('afterRollback', state.afterRollback, { throwOnError: false });
				};
				let attemptState: TransactionState | undefined;
				const callbackErrors = new WeakSet<object>();
				const run = async (txStore: StoreAdapter) => {
					if (attemptState && !attemptState.closed) await rollbackAttempt(attemptState, { staleTrackedModels: false });
					const state = createState();
					attemptState = state;
					const stores = Object.create(null) as Record<string, StoreAdapter>;
					const storeNames = Object.keys(this.config.stores);
					for (let storeIndex = 0; storeIndex < storeNames.length; storeIndex++) {
						const name = storeNames[storeIndex];
						const adapter = this.config.stores[name];
						if (name !== storeName) {
							stores[name] = createTransactionReadOnlyStore(adapter, name, storeName);
							continue;
						}
						if (txOptions.readOnly !== true) {
							stores[name] = createTransactionScopedStore(txStore, adapter);
							continue;
						}
						stores[name] = createTransactionReadOnlyScopedStore(txStore, adapter, name);
					}
					const txContext = this.fork({ stores }, state);
					state.context = txContext;
					try {
						const result = await transactionContextStorage.run(txContext, () => fn(txContext));
						state.callbackOperationState.closed = 'finished';
						await waitForContextOperations(state);
						if (state.rollbackOnlyError !== undefined) throw state.rollbackOnlyError;
						return result;
					} catch (error) {
						state.callbackOperationState.closed = 'rolled back';
						try {
							await waitForContextOperations(state);
						} catch {
							// Preserve the callback or operation error that triggered rollback.
						}
						if (error && (typeof error === 'object' || typeof error === 'function')) {
							WEAKSET_ADD.call(callbackErrors, error);
						}
						throw error;
					}
				};
				let result: T;
				try {
					result = await store.transaction((tx) => run(tx), storeOptions);
				} catch (error) {
					if (error instanceof ActiveTsCommittedTransactionError && !WEAKSET_HAS.call(callbackErrors, error)) {
						if (!attemptState) throw error;
						attemptState.closed = 'committed';
						rebindTransactionModels(error.result, attemptState, attemptState.root);
						try {
							await runAfterCommitTasks(attemptState);
						} catch (afterCommitError) {
							throw combineCommittedTransactionError(error, afterCommitError);
						}
						throw error;
					}
					if (attemptState) {
						if (transactionRollbackSkipped(error)) {
							if (!attemptState.closed) attemptState.closed = 'failed';
							throw error;
						}
						attachRollbackTaskErrors(error, await rollbackAttempt(attemptState, { staleTrackedModels: true }));
					}
					throw error;
				}
				if (!attemptState) {
					throw new ActiveTsConfigurationError(`Store adapter "${store.kind}" completed transaction without running the callback.`);
				}
					attemptState.closed = 'committed';
					rebindTransactionModels(result, attemptState, attemptState.root);
					try {
						await runAfterCommitTasks(attemptState);
					} catch (afterCommitError) {
						const cause = afterCommitError instanceof AggregateError
							? afterCommitError
							: new AggregateError(
									[afterCommitError],
									'active-ts afterCommit task failed after transaction commit.'
								);
						throw new ActiveTsCommittedTransactionError(
							`Transaction committed but ${safeErrorMessage(cause)}`,
							cause,
							result
						);
					}
					return result;
			})();
		} catch (error) {
			return SAFE_PROMISE_REJECT(error);
		}
	}

	track<T>(run: () => Promise<T>): Promise<T> {
		return contextOperationPromise(() => {
			if (typeof run !== 'function') {
				throw new ActiveTsConfigurationError('Transaction work must be a function.');
			}
			const scoped = this.transactionScopedContext('track transaction work');
			if (scoped !== this) return scoped.track(run);
			this.assertTransactionOpen('track transaction work');
			const state = this.transactionState;
			if (!state) {
				throw new ActiveTsConfigurationError('Cannot track work outside a transaction.');
			}
			return state.callbackOperations.track(
				run,
				(closed) => new ActiveTsConfigurationError(
					`Cannot track work after the transaction callback ${closed}.`
				)
			);
		});
	}

	afterCommit(task: DeferredTask): Promise<void> {
		return contextOperationPromise(() => this.runTrackedScopedOperation(
			'register afterCommit tasks',
			(scoped) => scoped.afterCommit(task),
			async () => {
				this.assertTransactionOpen('register afterCommit tasks');
				assertDeferredTask(task, 'afterCommit task');
				if (!this.transactionState) {
					throw new ActiveTsConfigurationError('Cannot register afterCommit tasks outside a transaction.');
				}
				this.transactionState.afterCommit.push(task);
			}
		));
	}

	afterCommitInternal(task: DeferredTask): Promise<void> {
		return contextOperationPromise(() => this.runTrackedScopedOperation(
			'register internal afterCommit tasks',
			(scoped) => scoped.afterCommitInternal(task),
			async () => {
				this.assertTransactionOpen('register internal afterCommit tasks');
				assertDeferredTask(task, 'internal afterCommit task');
				if (!this.transactionState) {
					throw new ActiveTsConfigurationError('Cannot register internal afterCommit tasks outside a transaction.');
				}
				this.transactionState.internalAfterCommit.push(task);
			}
		));
	}

	afterRollback(task: DeferredTask): Promise<void> {
		return contextOperationPromise(() => this.runTrackedScopedOperation(
			'register afterRollback tasks',
			(scoped) => scoped.afterRollback(task),
			async () => {
				this.assertTransactionOpen('register afterRollback tasks');
				assertDeferredTask(task, 'afterRollback task');
				if (!this.transactionState) {
					throw new ActiveTsConfigurationError('Cannot register afterRollback tasks outside a transaction.');
				}
				this.transactionState.afterRollback.push(task);
			}
		));
	}

	private assertTransactionWritable(operation: string): void {
		const scoped = this.transactionScopedContext(operation);
		if (scoped !== this) return scoped.assertTransactionWritable(operation);
		this.assertTransactionOpen(operation);
		if (this.transactionState?.readOnly) {
			throw new ActiveTsConfigurationError(`Cannot ${operation} in a read-only transaction.`);
		}
	}

	private markTransactionRollbackOnly(error: unknown): void {
		const scoped = this.transactionScopedContext('mark transaction rollback-only');
		if (scoped !== this) return scoped.markTransactionRollbackOnly(error);
		this.assertTransactionOpen('mark transaction rollback-only');
		if (!this.transactionState) {
			throw new ActiveTsConfigurationError('Cannot mark a context rollback-only outside a transaction.');
		}
		const reason = error === undefined
			? new ActiveTsConfigurationError('A transaction-scoped operation rejected with undefined.')
			: error;
		if (this.transactionState.rollbackOnlyError === undefined) {
			this.transactionState.rollbackOnlyError = reason;
		}
	}

	assertOutsideTransaction(operation: string) {
		this.assertTransactionOpen(operation);
		this.assertNotInTransaction(operation);
	}

	isInTransaction() {
		return this.transactionScopedContext('inspect transaction state') !== this || !!this.transactionState;
	}

	rootContext() {
		const scoped = this.transactionScopedContext('resolve root context');
		return scoped.transactionState?.root ?? scoped;
	}

	cacheForDeferredTask(name: string): CacheAdapter | undefined {
		const root = this.rootContext();
		root.assertTransactionOpen('resolve deferred cache adapter');
		return root.rawCache(assertSafeSchemaIdentifier(name, 'cache adapter name'));
	}

	transactionScopedContext(operation: string) {
		const ambient = transactionContextStorage.getStore();
		if (!ambient) {
			this.assertTransactionOpen(operation);
			return this;
		}
		ambient.assertTransactionOpen(operation);
		if (this === ambient) return this;
		if (ambient.transactionState?.root === this) return ambient;
		let ancestor = ambient.transactionState?.parent;
		while (ancestor) {
			if (ancestor.context === this) return ambient;
			ancestor = ancestor.parent;
		}
		this.assertTransactionOpen(operation);
		throw new ActiveTsConfigurationError(
			`Cannot ${operation} with a different active-ts context while a transaction is active. Use the transaction context passed to transaction().`
		);
	}

	private assertTransactionOpen(operation: string) {
		if (!this.transactionState?.closed) return;
		throw new ActiveTsConfigurationError(
			`Cannot ${operation} on a closed transaction context after it ${this.transactionState.closed}.`
		);
	}

	private assertNotInTransaction(operation: string) {
		const ambient = transactionContextStorage.getStore();
		if (ambient) {
			ambient.assertTransactionOpen(operation);
			if (this === ambient || ambient.transactionState?.root === this) {
				throw new ActiveTsConfigurationError(`Cannot ${operation} inside a transaction.`);
			}
		}
		if (!this.transactionState) return;
		throw new ActiveTsConfigurationError(`Cannot ${operation} inside a transaction.`);
	}

	private assertTransactionStoreRoute(modelStore: string, routedStore: string, operation: string) {
		if (!this.transactionState || modelStore === routedStore) return;
		throw new ActiveTsConfigurationError(
			`Cannot route transaction ${operation} for store "${modelStore}" to store "${routedStore}". Transaction reads must use the model store.`
		);
	}

	private cacheKey(meta: ResolvedModelMeta, id: EntityId) {
		const entityKey = `${meta.name}:${entityIdKey(id)}`;
		const store = this.internalStore(meta.store);
		const explicitCacheScope = store.cacheScope;
		const localCacheScope = explicitCacheScope === undefined ? this.localCacheScope(meta, store) : undefined;
		const physicalPrefix = explicitCacheScope !== undefined
			? `store:${meta.store.length}:${meta.store}:scope:${explicitCacheScope.length}:${explicitCacheScope}`
			: localCacheScope !== undefined
				? `store:${meta.store.length}:${meta.store}:local-scope:${localCacheScope.length}:${localCacheScope}`
				: meta.store === this.config.defaultStore
					? undefined
					: `store:${meta.store.length}:${meta.store}`;
		const owner = physicalPrefix === undefined ? entityKey : `${physicalPrefix}:${entityKey}`;
		const customCacheKey = this.config.cacheKey;
		const resolvedKey = assertSafeCacheKey(customCacheKey?.({ model: meta, id, baseKey: owner }) ?? owner, 'cache key');
		const key = customCacheKey !== undefined && resolvedKey !== owner
			? assertSafeCacheKey(
				physicalPrefix === undefined
					? resolvedKey
					: `${physicalPrefix}:custom:${resolvedKey.length}:${resolvedKey}`,
				'scoped cache key'
			)
			: resolvedKey;
		this.assertStableEntityCacheKey(owner, key);
		return key;
	}

	private localCacheScope(meta: ResolvedModelMeta, store: StoreAdapter) {
		if (!meta.cache) return undefined;
		const cache = this.internalCache(meta.cache.adapter);
		if (!cache) return undefined;
		const cacheSource = cacheAdapterSource(cache);
		const storeSource = storeAdapterSource(store);
		let primaryStores = WEAKMAP_GET.call(sharedCachePrimaryStores, cacheSource) as WeakSet<object> | undefined;
		if (primaryStores === undefined) {
			primaryStores = new WeakSet<object>();
			WEAKSET_ADD.call(primaryStores, storeSource);
			WEAKMAP_SET.call(sharedCachePrimaryStores, cacheSource, primaryStores);
			return undefined;
		}
		if (WEAKSET_HAS.call(primaryStores, storeSource)) return undefined;
		let scope = WEAKMAP_GET.call(localStoreCacheScopes, storeSource) as string | undefined;
		if (scope === undefined) {
			nextLocalStoreCacheScope++;
			if (!Number.isSafeInteger(nextLocalStoreCacheScope)) {
				throw new ActiveTsConfigurationError('Local store cache scope counter exceeded the safe integer range.');
			}
			scope = `local-${nextLocalStoreCacheScope}`;
			WEAKMAP_SET.call(localStoreCacheScopes, storeSource, scope);
		}
		return scope;
	}

	private assertDistributedCache(meta: ResolvedModelMeta, cache: CacheAdapter) {
		const store = this.internalStore(meta.store);
		if (store.cacheScope === undefined) {
			throw new ActiveTsConfigurationError(
				`Model "${meta.name}" uses distributed cache consistency, so store "${meta.store}" must expose an explicit cacheScope.`
			);
		}
		if (!cacheSupportsVersioning(cache)) {
			throw new ActiveTsConfigurationError(
				`Model "${meta.name}" uses distributed cache consistency, but cache adapter "${cache.kind}" does not support versioned reads, conditional writes, and atomic invalidation.`
			);
		}
		return cache;
	}

	private assertStableEntityCacheKey(owner: string, key: string) {
		if (this.transactionState) {
			const state = this.transactionState;
			this.assertStableEntityCacheKeyMaps(state.root.cacheKeyOwners, state.root.entityCacheKeys, owner, key);
			this.assertStableEntityCacheKeyMaps(state.cacheKeyOwners, state.entityCacheKeys, owner, key);
			if (!mapHas(state.root.cacheKeyOwners, key)) mapSet(state.cacheKeyOwners, key, owner);
			if (!mapHas(state.root.entityCacheKeys, owner)) mapSet(state.entityCacheKeys, owner, key);
			return;
		}
		this.assertStableEntityCacheKeyMaps(this.cacheKeyOwners, this.entityCacheKeys, owner, key);
		mapSet(this.cacheKeyOwners, key, owner);
		mapSet(this.entityCacheKeys, owner, key);
	}

	private assertStableEntityCacheKeyMaps(
		cacheKeyOwners: Map<string, string>,
		entityCacheKeys: Map<string, string>,
		owner: string,
		key: string
	) {
		const existingOwner = mapGet(cacheKeyOwners, key);
		if (existingOwner !== undefined && existingOwner !== owner) {
			throw new ActiveTsConfigurationError(
				`Entity cache key "${key}" is already associated with "${existingOwner}" and cannot be reused for "${owner}".`
			);
		}
		const existingKey = mapGet(entityCacheKeys, owner);
		if (existingKey !== undefined && existingKey !== key) {
			throw new ActiveTsConfigurationError(
				`Entity cache key for "${owner}" changed from "${existingKey}" to "${key}". Cache key resolvers must be deterministic.`
			);
		}
		const ownerForKey = mapGet(cacheKeyOwners, key);
		if (ownerForKey !== undefined && ownerForKey !== owner) {
			throw new ActiveTsConfigurationError(
				`Entity cache key "${key}" is already associated with "${ownerForKey}" and cannot be reused for "${owner}".`
			);
		}
	}

	private mergeTransactionCacheKeyOwnership(state: TransactionState) {
		for (const [key, owner] of state.cacheKeyOwners) {
			this.assertStableEntityCacheKeyMaps(this.cacheKeyOwners, this.entityCacheKeys, owner, key);
		}
		for (const [owner, key] of state.entityCacheKeys) {
			this.assertStableEntityCacheKeyMaps(this.cacheKeyOwners, this.entityCacheKeys, owner, key);
		}
		for (const [key, owner] of state.cacheKeyOwners) mapSet(this.cacheKeyOwners, key, owner);
		for (const [owner, key] of state.entityCacheKeys) mapSet(this.entityCacheKeys, owner, key);
	}

	private cacheEpochState(cache: CacheAdapter) {
		const source = cacheAdapterSource(cache);
		let state = WEAKMAP_GET.call(sharedCacheInvalidationEpochs, source) as {
			epochs: Map<string, number>;
			defaultEpoch: number;
		} | undefined;
		if (!state) {
			state = { epochs: new Map<string, number>(), defaultEpoch: 0 };
			WEAKMAP_SET.call(sharedCacheInvalidationEpochs, source, state);
		}
		return state;
	}

	private cacheEpoch(cache: CacheAdapter, key: string) {
		const state = this.cacheEpochState(cache);
		return mapGet(state.epochs, key) ?? state.defaultEpoch;
	}

	private bumpCacheEpoch(cache: CacheAdapter, key: string) {
		const state = this.cacheEpochState(cache);
		const current = mapGet(state.epochs, key) ?? state.defaultEpoch;
		if (!Number.isSafeInteger(current) || current < 0 || current >= Number.MAX_SAFE_INTEGER - 1) {
			throw new ActiveTsConfigurationError('Cache invalidation epoch counter is exhausted.');
		}
		MAP_DELETE.call(state.epochs, key);
		mapSet(state.epochs, key, current + 1);
		while (MAP_SIZE.call(state.epochs) > SHARED_CACHE_INVALIDATION_EPOCH_LIMIT) {
			const oldest = (MAP_KEYS.call(state.epochs) as IterableIterator<string>).next();
			if (oldest.done) break;
			const evictedEpoch = mapGet(state.epochs, oldest.value) ?? state.defaultEpoch;
			MAP_DELETE.call(state.epochs, oldest.value);
			state.defaultEpoch = Math.max(state.defaultEpoch, evictedEpoch + 1);
		}
	}

	private cacheEpochUnchanged(cache: CacheAdapter, key: string, expectedEpochs: Map<string, number> | undefined) {
		if (!expectedEpochs) return true;
		return mapGet(expectedEpochs, key) === this.cacheEpoch(cache, key);
	}

	private hasCacheInvalidationFailure(cache: CacheAdapter, key: string) {
		const state = WEAKMAP_GET.call(sharedCacheInvalidationFailures, cacheAdapterSource(cache)) as {
			failures: Set<string>;
			poisonGeneration: number;
			recovered: Map<string, number>;
		} | undefined;
		if (!state) return false;
		if (SET_HAS.call(state.failures, key)) return true;
		return state.poisonGeneration > 0 && mapGet(state.recovered, key) !== state.poisonGeneration;
	}

	private markCacheInvalidationFailure(cache: CacheAdapter, key: string) {
		const source = cacheAdapterSource(cache);
		let state = WEAKMAP_GET.call(sharedCacheInvalidationFailures, source) as {
			failures: Set<string>;
			poisonGeneration: number;
			recovered: Map<string, number>;
		} | undefined;
		if (!state) {
			state = { failures: new Set<string>(), poisonGeneration: 0, recovered: new Map<string, number>() };
			WEAKMAP_SET.call(sharedCacheInvalidationFailures, source, state);
		}
		SET_ADD.call(state.failures, key);
		MAP_DELETE.call(state.recovered, key);
		if (SET_SIZE.call(state.failures) <= SHARED_CACHE_INVALIDATION_FAILURE_LIMIT) return;
		if (!Number.isSafeInteger(state.poisonGeneration) || state.poisonGeneration >= Number.MAX_SAFE_INTEGER) {
			throw new ActiveTsConfigurationError('Cache invalidation failure generation is exhausted.');
		}
		state.poisonGeneration++;
		SET_CLEAR.call(state.failures);
		MAP_CLEAR.call(state.recovered);
	}

	private clearCacheInvalidationFailure(cache: CacheAdapter, key: string) {
		const source = cacheAdapterSource(cache);
		const state = WEAKMAP_GET.call(sharedCacheInvalidationFailures, source) as {
			failures: Set<string>;
			poisonGeneration: number;
			recovered: Map<string, number>;
		} | undefined;
		if (!state) return;
		SET_DELETE.call(state.failures, key);
		if (state.poisonGeneration > 0) {
			MAP_DELETE.call(state.recovered, key);
			mapSet(state.recovered, key, state.poisonGeneration);
			while (MAP_SIZE.call(state.recovered) > SHARED_CACHE_INVALIDATION_FAILURE_LIMIT) {
				const oldest = (MAP_KEYS.call(state.recovered) as IterableIterator<string>).next();
				if (oldest.done) break;
				MAP_DELETE.call(state.recovered, oldest.value);
			}
			return;
		}
		if (!SET_SIZE.call(state.failures)) WEAKMAP_DELETE.call(sharedCacheInvalidationFailures, source);
	}

	private async writeCacheEntries(
		cache: CacheAdapter,
		meta: ResolvedModelMeta,
		ids: EntityId[],
		entries: Array<[string, any]>,
		ttl: number | undefined,
		mode: 'positive' | 'negative',
		expectedEpochs?: Map<string, number>,
		expectedVersions?: Map<string, string>
	) {
		if (!entries.length) return;
		const pending: Array<{ id: EntityId; entry: [string, any] }> = [];
		for (let index = 0; index < entries.length; index++) {
			const entry = entries[index];
			if (this.cacheEpochUnchanged(cache, entry[0], expectedEpochs)) {
				pending[pending.length] = { id: ids[index], entry };
			}
		}
		if (!pending.length) return;
		const expectedIds: EntityId[] = [];
		const pendingEntries: Array<[string, any]> = [];
		for (let index = 0; index < pending.length; index++) {
			expectedIds[index] = pending[index].id;
			pendingEntries[index] = pending[index].entry;
		}
		const hookEntries = cloneCacheSetEntries(pendingEntries);
		const expectedEntryKeys = cacheEntryKeys(pendingEntries);
		const before = await this.runHooks('beforeCacheSet', {
			model: meta,
			ids: cloneArray(expectedIds),
			data: hookEntries,
			operation: 'read',
			meta: { keys: cloneArray(expectedEntryKeys) }
		});
		const nextEntries = sanitizeCacheSetEntries(before.data, 'beforeCacheSet', expectedEntryKeys);
		assertCacheSetEntryValues(nextEntries, expectedIds, meta.idField, mode, 'beforeCacheSet');
		const writable: Array<{ id: EntityId; entry: [string, any] }> = [];
		for (let index = 0; index < nextEntries.length; index++) {
			const entry = nextEntries[index];
			if (this.cacheEpochUnchanged(cache, entry[0], expectedEpochs)) {
				writable[writable.length] = { id: expectedIds[index], entry };
			}
		}
		if (!writable.length) return;
		const writeIds: EntityId[] = [];
		const writeEntries: Array<[string, any]> = [];
		for (let index = 0; index < writable.length; index++) {
			writeIds[index] = writable[index].id;
			writeEntries[index] = writable[index].entry;
		}
		let committedEntries = writeEntries;
		let committedIds = writeIds;
		if (expectedVersions) {
			if (!cacheSupportsVersioning(cache)) {
				throw new ActiveTsConfigurationError(
					`Cache adapter "${cache.kind}" lost distributed versioning support during a cache write.`
				);
			}
			const versionedEntries = [] as Array<[string, any, string]>;
			for (let index = 0; index < writeEntries.length; index++) {
				const [key, value] = writeEntries[index];
				const version = mapGet(expectedVersions, key);
				if (version === undefined) continue;
				versionedEntries[versionedEntries.length] = [key, value, version];
			}
			const results = normalizeCacheVersionedSetResult(
				await cache.setManyVersioned(versionedEntries, { ttl }),
				versionedEntries.length,
				`Cache adapter "${cache.kind}" setManyVersioned result`
			);
			committedEntries = [];
			committedIds = [];
			let versionedIndex = 0;
			for (let index = 0; index < writeEntries.length; index++) {
				const key = writeEntries[index][0];
				if (!mapHas(expectedVersions, key)) continue;
				if (results[versionedIndex]) {
					committedEntries[committedEntries.length] = writeEntries[index];
					committedIds[committedIds.length] = writeIds[index];
				}
				versionedIndex++;
			}
		} else {
			await cache.setMany(writeEntries, { ttl });
		}
		const staleKeys: string[] = [];
		if (expectedEpochs) {
			for (let index = 0; index < committedEntries.length; index++) {
				const key = committedEntries[index][0];
				if (!this.cacheEpochUnchanged(cache, key, expectedEpochs)) staleKeys[staleKeys.length] = key;
			}
		}
		if (staleKeys.length) {
			try {
				if (expectedVersions && cacheSupportsVersioning(cache)) await cache.invalidateMany(staleKeys);
				else await cache.deleteMany(staleKeys);
			} catch (error) {
				for (const key of staleKeys) this.markCacheInvalidationFailure(cache, key);
				throw error;
			}
		}
		const stableEntries: Array<[string, any]> = [];
		const stableIds: EntityId[] = [];
		for (let index = 0; index < committedEntries.length; index++) {
			const entry = committedEntries[index];
			if (this.cacheEpochUnchanged(cache, entry[0], expectedEpochs)) {
				stableEntries[stableEntries.length] = entry;
				stableIds[stableIds.length] = committedIds[index];
			}
		}
		if (!stableEntries.length) return;
		for (const [key] of stableEntries) this.clearCacheInvalidationFailure(cache, key);
		try {
			await this.runHooks('afterCacheSet', {
				model: meta,
				ids: stableIds,
				data: cloneCacheSetEntries(stableEntries),
				operation: 'read',
				meta: { keys: cacheEntryKeys(stableEntries) }
			});
		} catch (error) {
			await this.poisonCommittedCacheSet(cache, meta, stableEntries, error);
			throw error;
		}
	}

	private async poisonCommittedCacheSet(
		cache: CacheAdapter,
		meta: ResolvedModelMeta,
		entries: Array<[string, any]>,
		cause: unknown
	) {
		const keys = cacheEntryKeys(entries);
		for (const key of keys) this.bumpCacheEpoch(cache, key);
		try {
			if (meta.cache?.consistency === 'distributed' && cacheSupportsVersioning(cache)) {
				await cache.invalidateMany(keys);
			} else {
				await cache.deleteMany(keys);
			}
			for (const key of keys) this.clearCacheInvalidationFailure(cache, key);
		} catch (error) {
			for (const key of keys) this.markCacheInvalidationFailure(cache, key);
			throw new AggregateError([cause, error], 'Entity cache set hook failed and cleanup failed.');
		}
	}

	private fork(config: Partial<ActiveTsConfig>, transactionState?: TransactionState) {
		const override = snapshotPartialActiveTsConfig(config, 'fork config');
		const overrideStores =
			override.stores !== undefined
				? normalizeStoreAdapterRegistry(override.stores)
				: undefined;
		const overrideCaches =
			override.caches !== undefined
				? normalizeAdapterRegistry(override.caches, 'cache adapter name', assertCacheAdapter, markCacheAdapterSource)
				: undefined;
		const overrideSearch =
			override.search !== undefined
				? normalizeAdapterRegistry(override.search, 'search adapter name', assertSearchAdapter, markSearchAdapterSource)
				: undefined;
		const stores = { ...this.config.stores, ...(overrideStores ?? {}) };
		const caches =
			this.config.caches || overrideCaches
				? { ...(this.config.caches ?? {}), ...(overrideCaches ?? {}) }
				: undefined;
		const search =
			this.config.search || overrideSearch
				? { ...(this.config.search ?? {}), ...(overrideSearch ?? {}) }
				: undefined;
		const scopedSearch = search
			? rebindNativeSearchAdaptersForStores(search, this.config.stores, stores, transactionState !== undefined)
			: undefined;
		const transactionSearch = scopedSearch && transactionState
			? createTransactionScopedSearchAdapters(scopedSearch)
			: scopedSearch;
		const transactionCaches = caches && transactionState
			? createTransactionScopedCacheAdapters(caches)
			: caches;
		const childConfig: ActiveTsConfig = {
			...this.config,
			...override,
			stores,
			caches: transactionCaches,
			search: transactionSearch
		};
		if (
			(!transactionCaches || !Object.prototype.hasOwnProperty.call(transactionCaches, this.config.defaultCache)) &&
			!Object.prototype.hasOwnProperty.call(override, 'defaultCache')
		) {
			delete childConfig.defaultCache;
		}
		if (
			(!transactionSearch || !Object.prototype.hasOwnProperty.call(transactionSearch, this.config.defaultSearch)) &&
			!Object.prototype.hasOwnProperty.call(override, 'defaultSearch')
		) {
			delete childConfig.defaultSearch;
		}
		const child = new ActiveContext(childConfig, { skipPluginSetup: true });
		child.cacheKeyOwners = this.cacheKeyOwners;
		child.entityCacheKeys = this.entityCacheKeys;
		child.transactionState = transactionState;
		return child;
	}

	private groupModelsByStore(models: ModelConstructor[]) {
		const grouped = new Map<string, ResolvedModelMeta[]>();
		for (const model of models) {
			const meta = this.meta(model);
			const list = mapGet(grouped, meta.store) ?? [];
			list.push(meta);
			mapSet(grouped, meta.store, list);
		}
		return grouped;
	}

	private groupModelsBySearch(models: ModelConstructor[]) {
		const grouped = new Map<string, ResolvedModelMeta[]>();
		for (const model of models) {
			const meta = this.meta(model);
			if (!meta.searchIndexes.length) continue;
			for (const name of this.searchSchemaAdapterNamesForModel(meta)) {
				const safeName = assertSafeSchemaIdentifier(name, 'search adapter name');
				const adapter = this.config.search ? ownValue(this.config.search, safeName) : undefined;
				if (!adapter) throw new ActiveTsConfigurationError(`Search adapter "${safeName}" is not registered.`);
				const routedMeta = withDatastoreSearchNamespace(
					withSearchIndexesForAdapter(meta, safeName, searchIndexAdapterKind(adapter, safeName)),
					meta.datastore?.ancestor
						? this.internalStore(meta.store).datastoreNamespace
						: undefined
				);
				if (!routedMeta.searchIndexes.length) continue;
				const list = mapGet(grouped, safeName) ?? [];
				list.push(routedMeta);
				mapSet(grouped, safeName, list);
			}
		}
		return grouped;
	}

	private searchSchemaAdapterNamesForModel(meta: ResolvedModelMeta) {
		const names: string[] = [];
		const seen = new Set<string>();
		if (!meta.searchIndexes.length) {
			for (const name of this.schemaSearchAdapterNames(meta)) {
				this.appendSearchSchemaAdapterName(names, seen, name);
			}
			return names;
		}
		if (hasUntaggedSearchIndex(meta.searchIndexes)) {
			for (const name of this.schemaSearchAdapterNames(meta)) {
				this.appendSearchSchemaAdapterName(names, seen, name);
			}
		}
		for (let index = 0; index < meta.searchIndexes.length; index++) {
			const adapterName = meta.searchIndexes[index].adapter;
			if (adapterName === undefined) continue;
			this.appendSearchSchemaAdapterRouteForIndex(meta, names, seen, adapterName);
		}
		return names;
	}

	private appendSearchSchemaAdapterName(names: string[], seen: Set<string>, name: string) {
		const safeName = assertSafeSchemaIdentifier(name, 'search adapter name');
		if (SET_HAS.call(seen, safeName)) return false;
		SET_ADD.call(seen, safeName);
		names[names.length] = safeName;
		return true;
	}

	private appendSearchSchemaAdapterRouteForIndex(
		meta: ResolvedModelMeta,
		names: string[],
		seen: Set<string>,
		adapterName: string
	) {
		const safeName = assertSafeSchemaIdentifier(adapterName, 'search adapter name');
		const literalAdapter = this.config.search ? ownValue(this.config.search, safeName) : undefined;
		if (literalAdapter) {
			this.appendSearchSchemaAdapterName(names, seen, safeName);
			return;
		}
		let matchedRoute = this.appendSearchSchemaAdapterRoutesForKind(
			names,
			seen,
			safeName,
			this.schemaSearchAdapterNames(meta)
		);
		if (this.config.search) {
			matchedRoute = this.appendSearchSchemaAdapterRoutesForKind(
				names,
				seen,
				safeName,
				Object.keys(this.config.search)
			) || matchedRoute;
		}
		if (!matchedRoute) this.appendSearchSchemaAdapterName(names, seen, safeName);
	}

	private appendSearchSchemaAdapterRoutesForKind(
		names: string[],
		seen: Set<string>,
		indexKind: string,
		candidates: readonly string[]
	) {
		let matchedRoute = false;
		for (const candidate of candidates) {
			const safeCandidate = assertSafeSchemaIdentifier(candidate, 'search adapter name');
			const adapter = this.config.search ? ownValue(this.config.search, safeCandidate) : undefined;
			if (!adapter) throw new ActiveTsConfigurationError(`Search adapter "${safeCandidate}" is not registered.`);
			if (searchIndexAdapterKind(adapter, safeCandidate) !== indexKind) continue;
			this.appendSearchSchemaAdapterName(names, seen, safeCandidate);
			matchedRoute = true;
		}
		return matchedRoute;
	}

	private schemaSearchAdapterNames(meta: ResolvedModelMeta) {
		const configured = this.config.queryPlanner?.schemaSearchAdapters;
		if (configured !== undefined) {
			const candidates = typeof configured === 'function'
				? configured({ context: this, model: meta })
				: configured;
			return normalizeSchemaSearchAdapterNames(candidates, 'queryPlanner.schemaSearchAdapters');
		}
		const searchNames = Object.keys(this.config.search ?? {});
		if (this.config.queryPlanner?.routeSearch && searchNames.length) return searchNames;
		return [this.searchAdapterRouteFor(meta, '', {}, undefined).name];
	}
}

function assertActiveTsConfig(config: unknown): asserts config is ActiveTsConfig {
	if (!config || typeof config !== 'object' || Array.isArray(config)) {
		throw new ActiveTsConfigurationError('active-ts config must be a plain object.');
	}
	const prototype = Object.getPrototypeOf(config);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsConfigurationError('active-ts config must be a plain object.');
	}
	assertNoSymbolOrAccessorFields(config, 'active-ts config');
	assertKnownOptionKeys(config, ACTIVE_TS_CONFIG_KEYS, 'active-ts config');
	const value = config as Partial<ActiveTsConfig> & Record<string, unknown>;
	const lazyWarnings = ownValue(value, 'lazyWarnings', 'active-ts config');
	if (lazyWarnings !== undefined && typeof lazyWarnings !== 'boolean') {
		throw new ActiveTsConfigurationError('lazyWarnings must be a boolean.');
	}
	const schema = ownValue(value, 'schema', 'active-ts config') as ActiveTsConfig['schema'];
	if (schema !== undefined) {
		assertPlainOptionObject(schema, 'schema');
		assertKnownOptionKeys(schema, SCHEMA_CONFIG_KEYS, 'schema');
		const autoSync = ownValue(schema as Record<string, unknown>, 'autoSync', 'schema');
		if (autoSync !== undefined && autoSync !== 'off' && autoSync !== 'safe') {
			throw new ActiveTsConfigurationError('schema.autoSync must be "off" or "safe".');
		}
	}
	const batch = ownValue(value, 'batch', 'active-ts config') as ActiveTsConfig['batch'];
	if (batch !== undefined) {
		assertPlainOptionObject(batch, 'batch');
		assertKnownOptionKeys(batch, BATCH_CONFIG_KEYS, 'batch');
	}
	const aggregate = ownValue(value, 'aggregate', 'active-ts config') as ActiveTsConfig['aggregate'];
	if (aggregate !== undefined) {
		assertPlainOptionObject(aggregate, 'aggregate');
		assertKnownOptionKeys(aggregate, AGGREGATE_CONFIG_KEYS, 'aggregate');
		const allowQueryFallback = ownValue(aggregate as Record<string, unknown>, 'allowQueryFallback', 'aggregate');
		if (
			allowQueryFallback !== undefined &&
			typeof allowQueryFallback !== 'boolean'
		) {
			throw new ActiveTsConfigurationError('aggregate.allowQueryFallback must be a boolean.');
		}
	}
	const queryPlanner = ownValue(value, 'queryPlanner', 'active-ts config') as ActiveTsConfig['queryPlanner'];
	normalizeQueryPlanner(queryPlanner);
	const cacheKey = ownValue(value, 'cacheKey', 'active-ts config');
	if (cacheKey !== undefined && typeof cacheKey !== 'function') {
		throw new ActiveTsConfigurationError('cacheKey must be a function.');
	}
}

function snapshotPartialActiveTsConfig(config: unknown, context: string): Partial<ActiveTsConfig> {
	assertPlainOptionObject(config, context);
	assertKnownOptionKeys(config, ACTIVE_TS_CONFIG_KEYS, context);
	const record = config as Record<string, unknown>;
	const snapshot: Partial<ActiveTsConfig> = {};
	for (const key of ACTIVE_TS_CONFIG_KEYS) {
		if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
		(snapshot as Record<string, unknown>)[key] = ownValue(record, key, context);
	}
	return snapshot;
}

function normalizeQueryPlanner(queryPlanner: ActiveTsConfig['queryPlanner']) {
	if (queryPlanner === undefined) return undefined;
	assertPlainOptionObject(queryPlanner, 'queryPlanner');
	assertKnownOptionKeys(queryPlanner, QUERY_PLANNER_KEYS, 'queryPlanner');
	const planner = queryPlanner as Record<string, unknown>;
	const routeQuery = ownValue(planner, 'routeQuery', 'queryPlanner');
	const routeAggregate = ownValue(planner, 'routeAggregate', 'queryPlanner');
	const routeSearch = ownValue(planner, 'routeSearch', 'queryPlanner');
	const schemaSearchAdapters = ownValue(planner, 'schemaSearchAdapters', 'queryPlanner');
	assertQueryPlannerRouteFunction('routeQuery', routeQuery);
	assertQueryPlannerRouteFunction('routeAggregate', routeAggregate);
	assertQueryPlannerRouteFunction('routeSearch', routeSearch);
	if (
		schemaSearchAdapters !== undefined &&
		typeof schemaSearchAdapters !== 'function' &&
		!Array.isArray(schemaSearchAdapters)
	) {
		throw new ActiveTsConfigurationError('queryPlanner.schemaSearchAdapters must be an array or a function.');
	}
	const normalized = Object.create(null) as NonNullable<ActiveTsConfig['queryPlanner']>;
	if (routeQuery !== undefined) normalized.routeQuery = routeQuery as NonNullable<ActiveTsConfig['queryPlanner']>['routeQuery'];
	if (routeAggregate !== undefined) normalized.routeAggregate = routeAggregate as NonNullable<ActiveTsConfig['queryPlanner']>['routeAggregate'];
	if (routeSearch !== undefined) normalized.routeSearch = routeSearch as NonNullable<ActiveTsConfig['queryPlanner']>['routeSearch'];
	if (schemaSearchAdapters !== undefined) {
		normalized.schemaSearchAdapters = typeof schemaSearchAdapters === 'function'
			? schemaSearchAdapters as NonNullable<ActiveTsConfig['queryPlanner']>['schemaSearchAdapters']
			: normalizeSchemaSearchAdapterNames(
					schemaSearchAdapters,
					'queryPlanner.schemaSearchAdapters'
				) as NonNullable<ActiveTsConfig['queryPlanner']>['schemaSearchAdapters'];
	}
	return Object.freeze(normalized);
}

function assertQueryPlannerRouteFunction(property: keyof NonNullable<ActiveTsConfig['queryPlanner']>, route: unknown) {
	if (route !== undefined && typeof route !== 'function') {
		throw new ActiveTsConfigurationError(`queryPlanner.${property} must be a function.`);
	}
}

function normalizeSchemaSearchAdapterNames(value: unknown, context: string): readonly string[] {
	if (!Array.isArray(value)) {
		throw new ActiveTsConfigurationError(`${context} must return an array of search adapter names.`);
	}
	const names = snapshotArrayInput<unknown>(value, context);
	const seen = new Set<string>();
	const normalized: string[] = [];
	for (let index = 0; index < names.length; index++) {
		const name = assertSafeSchemaIdentifier(names[index], `${context}[${index}]`);
		if (SET_HAS.call(seen, name)) {
			throw new ActiveTsConfigurationError(`${context} contains duplicate search adapter "${name}".`);
		}
		SET_ADD.call(seen, name);
		normalized[normalized.length] = name;
	}
	return Object.freeze(normalized);
}

function normalizeSchemaConfig(schema: ActiveTsConfig['schema']) {
	if (schema === undefined) return undefined;
	assertKnownOptionKeys(schema, SCHEMA_CONFIG_KEYS, 'schema');
	const autoSync = ownValue(schema as Record<string, unknown>, 'autoSync', 'schema');
	const normalized = Object.create(null) as NonNullable<ActiveTsConfig['schema']>;
	if (autoSync !== undefined) normalized.autoSync = autoSync as SchemaSyncMode;
	return Object.freeze(normalized);
}

function normalizeBatchConfig(batch: ActiveTsConfig['batch']) {
	if (batch === undefined) return undefined;
	assertKnownOptionKeys(batch, BATCH_CONFIG_KEYS, 'batch');
	const maxSize = ownValue(batch as Record<string, unknown>, 'maxSize', 'batch');
	const normalized = Object.create(null) as NonNullable<ActiveTsConfig['batch']>;
	if (maxSize !== undefined) normalized.maxSize = maxSize as number;
	return Object.freeze(normalized);
}

function normalizeAggregateConfig(aggregate: ActiveTsConfig['aggregate']) {
	if (aggregate === undefined) return undefined;
	assertKnownOptionKeys(aggregate, AGGREGATE_CONFIG_KEYS, 'aggregate');
	const allowQueryFallback = ownValue(aggregate as Record<string, unknown>, 'allowQueryFallback', 'aggregate');
	const normalized = Object.create(null) as NonNullable<ActiveTsConfig['aggregate']>;
	if (allowQueryFallback !== undefined) normalized.allowQueryFallback = allowQueryFallback as boolean;
	return Object.freeze(normalized);
}

function assertPlainOptionObject(value: unknown, context: string): asserts value is Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ActiveTsConfigurationError(`${context} must be a plain object.`);
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsConfigurationError(`${context} must be a plain object.`);
	}
	assertNoSymbolOrAccessorFields(value, context);
}

function assertNoSymbolOrAccessorFields(value: object, context: string) {
	if (Object.getOwnPropertySymbols(value).length) {
		throw new ActiveTsConfigurationError(`${context} cannot contain symbol fields.`);
	}
	for (const property of Object.getOwnPropertyNames(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, property);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsConfigurationError(`${context}.${property} must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsConfigurationError(`${context}.${property} must be enumerable.`);
		}
	}
}

function assertKnownOptionKeys(value: object, allowed: readonly string[], context: string) {
	const allowedSet = capturedSet(allowed);
	for (const property of Object.getOwnPropertyNames(value)) {
		if (!SET_HAS.call(allowedSet, property)) {
			throw new ActiveTsConfigurationError(`${context} contains unknown option "${property}".`);
		}
	}
}

function normalizeActiveContextOptions(options: unknown): { skipPluginSetup?: boolean } {
	assertPlainOptionObject(options, 'ActiveContext options');
	assertKnownOptionKeys(options, ACTIVE_CONTEXT_OPTION_KEYS, 'ActiveContext options');
	const skipPluginSetup = ownValue(options as Record<string, unknown>, 'skipPluginSetup', 'ActiveContext options');
	if (skipPluginSetup !== undefined && typeof skipPluginSetup !== 'boolean') {
		throw new ActiveTsConfigurationError('ActiveContext options.skipPluginSetup must be a boolean.');
	}
	return { skipPluginSetup };
}

function normalizeModelList(models: unknown, context: string): ModelConstructor[] {
	if (!Array.isArray(models)) {
		throw new ActiveTsConfigurationError(`${context} must be an array.`);
	}
	const safeModels = snapshotArrayInput<ModelConstructor>(models, context);
	for (let index = 0; index < safeModels.length; index++) {
		assertModelConstructor(safeModels[index], `${context}[${index}]`);
	}
	return safeModels;
}

function normalizeSchemaApplyOptions(options: unknown): { mode?: Exclude<SchemaSyncMode, 'off'> | 'off' } {
	assertPlainOptionObject(options, 'schemaApply options');
	assertKnownOptionKeys(options, SCHEMA_APPLY_OPTION_KEYS, 'schemaApply options');
	const mode = ownValue(options as Record<string, unknown>, 'mode', 'schemaApply options');
	if (mode !== undefined && mode !== 'safe' && mode !== 'off') {
		throw new ActiveTsConfigurationError('schemaApply options.mode must be "safe" or "off".');
	}
	return { mode };
}

function normalizeTransactionOptions(options: unknown): TransactionOptions {
	assertPlainOptionObject(options, 'transaction options');
	assertKnownOptionKeys(options, TRANSACTION_OPTION_KEYS, 'transaction options');
	const record = options as Record<string, unknown>;
	const store = ownValue(record, 'store', 'transaction options');
	const isolation = ownValue(record, 'isolation', 'transaction options');
	if (
		isolation !== undefined &&
		isolation !== 'readCommitted' &&
		isolation !== 'repeatableRead' &&
		isolation !== 'serializable'
	) {
		throw new ActiveTsConfigurationError(
			'transaction options.isolation must be "readCommitted", "repeatableRead", or "serializable".'
		);
	}
	const readOnly = ownValue(record, 'readOnly', 'transaction options');
	if (readOnly !== undefined && typeof readOnly !== 'boolean') {
		throw new ActiveTsConfigurationError('transaction options.readOnly must be a boolean.');
	}
	const timeoutMs = ownValue(record, 'timeoutMs', 'transaction options');
	if (
		timeoutMs !== undefined &&
		(typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
	) {
		throw new ActiveTsConfigurationError('transaction options.timeoutMs must be a positive safe integer.');
	}
	const join = ownValue(record, 'join', 'transaction options');
	if (join !== undefined && join !== 'error' && join !== 'reuse' && join !== 'savepoint') {
		throw new ActiveTsConfigurationError('transaction options.join must be "error", "reuse", or "savepoint".');
	}
	const native = ownValue(record, 'native', 'transaction options');
	return {
		store: store === undefined ? undefined : assertSafeSchemaIdentifier(store, 'transaction store'),
		isolation: isolation as TransactionOptions['isolation'],
		readOnly: readOnly as TransactionOptions['readOnly'],
		timeoutMs: timeoutMs as TransactionOptions['timeoutMs'],
		join: join as TransactionOptions['join'],
		native: native === undefined ? undefined : cloneNativePayload(native, 'transaction options.native')
	};
}

function normalizeReadOptions(options: unknown, context: string): ReadOptions {
	assertPlainOptionObject(options, context);
	assertKnownOptionKeys(options, READ_OPTION_KEYS, context);
	const partial = ownValue(options as Record<string, unknown>, 'partial', context);
	if (partial !== undefined && typeof partial !== 'boolean') {
		throw new ActiveTsConfigurationError(`${context}.partial must be a boolean.`);
	}
	const fieldCodecs = ownValue(options as Record<string, unknown>, 'fieldCodecs', context);
	if (fieldCodecs !== undefined && typeof fieldCodecs !== 'boolean') {
		throw new ActiveTsConfigurationError(`${context}.fieldCodecs must be a boolean.`);
	}
	if (fieldCodecs === false && partial !== true) {
		throw new ActiveTsConfigurationError(`${context}.fieldCodecs can only be disabled for partial projection reads.`);
	}
	return { partial, fieldCodecs };
}

function createTransactionReadOnlyStore(
	adapter: StoreAdapter,
	storeName: string,
	transactionStoreName: string
): StoreAdapter {
	const capabilities = Object.freeze({ ...(adapter.capabilities ?? {}), transaction: false, native: false });
	const rejectWrite = () => {
		throw new ActiveTsConfigurationError(
			`Transaction is scoped to store "${transactionStoreName}"; writes to store "${storeName}" are not atomic.`
		);
	};
	const rejectNative = () => {
		throw new ActiveTsConfigurationError(
			`Transaction is scoped to store "${transactionStoreName}"; native operations on store "${storeName}" are not atomic.`
		);
	};
	const rejectNativeReadOptions = (options: unknown, context: string) => {
		const safeOptions = normalizeStoreReadOptions(options, context);
		if (safeOptions.native !== undefined) rejectNative();
		return safeOptions;
	};
	const rejectNativePlan = (plan: { native?: unknown }) => {
		if (plan.native !== undefined) rejectNative();
	};
	const readOnlyStore: StoreAdapter = {
		kind: adapter.kind,
		cacheScope: adapter.cacheScope,
		datastoreNamespace: adapter.datastoreNamespace,
		datastoreProjectId: adapter.datastoreProjectId,
		datastoreDatabaseId: adapter.datastoreDatabaseId,
		datastoreKeyEncoding: adapter.datastoreKeyEncoding,
		capabilities,
		get: (model, id, options) => {
			const safeModel = snapshotAdapterModel(model, 'transaction read-only store model metadata');
			assertSafeEntityId(id, 'transaction read-only store get id');
			const safeOptions = rejectNativeReadOptions(options, 'transaction read-only store get options');
			return adapter.get(safeModel, id, safeOptions);
		},
		getMany: (model, ids, options) => {
			const safeModel = snapshotAdapterModel(model, 'transaction read-only store model metadata');
			const safeIds = assertSafeEntityIdArray(ids, 'transaction read-only store getMany ids');
			const safeOptions = rejectNativeReadOptions(options, 'transaction read-only store getMany options');
			return adapter.getMany(safeModel, safeIds, safeOptions);
		},
		query: (model, plan, options) => {
			const safeModel = snapshotAdapterModel(model, 'transaction read-only store model metadata');
			const safePlan = normalizeStoreQueryPlan(plan, safeModel.idField, 'transaction read-only store query plan');
			const safeOptions = validateStoreQueryReadOptions(options, safePlan, 'transaction read-only store query options');
			rejectNativePlan(safePlan);
			if (safeOptions.native !== undefined) rejectNative();
			assertStoreSupports(readOnlyStore, safePlan);
			return adapter.query(safeModel, safePlan, safeOptions);
		},
		aggregate: adapter.aggregate
			? (model, plan) => {
					const safeModel = snapshotAdapterModel(model, 'transaction read-only store model metadata');
					const safePlan = normalizeStoreAggregatePlan(plan, 'transaction read-only store aggregate plan');
					rejectNativePlan(safePlan);
					assertStoreDirectAggregateSupported(readOnlyStore);
					assertStoreSupports(readOnlyStore, safePlan);
					return adapter.aggregate!(safeModel, safePlan);
				}
			: undefined,
		create: async () => rejectWrite(),
		update: async () => rejectWrite(),
		delete: async () => rejectWrite()
	};
	defineDataProperty(readOnlyStore, TRANSACTION_READ_ONLY_STORE, true, {
		enumerable: false,
		configurable: false
	});
	const sourced = markStoreAdapterSource(readOnlyStore, adapter);
	return storeTrustsDatastoreEntityKeyRows(adapter)
		? markStoreTrustsDatastoreEntityKeyRows(sourced)
		: sourced;
}

function createTransactionScopedStore(adapter: StoreAdapter, source?: StoreAdapter): StoreAdapter {
	const transactionSource = adapter;
	const snapshot = snapshotAdapterRegistrationObject(adapter, 'transaction callback store adapter') as StoreAdapter;
	markStoreAdapterSource(snapshot, transactionSource);
	assertStoreAdapter(snapshot, 'transaction callback store adapter');
	adapter = snapshot;
	let scoped!: StoreAdapter;
	scoped = {
		kind: adapter.kind,
		cacheScope: adapter.cacheScope ?? source?.cacheScope,
		datastoreNamespace: adapter.datastoreNamespace ?? source?.datastoreNamespace,
		datastoreProjectId: adapter.datastoreProjectId ?? source?.datastoreProjectId,
		datastoreDatabaseId: adapter.datastoreDatabaseId === undefined
			? source?.datastoreDatabaseId
			: adapter.datastoreDatabaseId,
		datastoreKeyEncoding: adapter.datastoreKeyEncoding ?? source?.datastoreKeyEncoding,
		capabilities: Object.freeze({ ...(adapter.capabilities ?? {}), transaction: false }),
		get: (...args) => adapter.get(...args),
		getMany: (...args) => adapter.getMany(...args),
		query: (...args) => adapter.query(...args),
		aggregate: adapter.aggregate ? (...args) => adapter.aggregate!(...args) : undefined,
		create: (...args) => adapter.create(...args),
		update: (...args) => adapter.update(...args),
		delete: (...args) => adapter.delete(...args),
		savepoint: adapter.savepoint
			? (fn) => adapter.savepoint!((nested) => fn(createTransactionScopedStore(nested, source ?? adapter)))
			: undefined
	};
	const sourced = source ? markStoreAdapterSource(scoped, source) : scoped;
	return storeTrustsDatastoreEntityKeyRows(adapter) || (source ? storeTrustsDatastoreEntityKeyRows(source) : false)
		? markStoreTrustsDatastoreEntityKeyRows(sourced)
		: sourced;
}

function createTransactionReadOnlyScopedStore(
	adapter: StoreAdapter,
	source: StoreAdapter,
	storeName: string
): StoreAdapter {
	assertStoreAdapter(adapter, `transaction callback store adapter "${storeName}"`);
	const rejectWrite = async () => {
		throw new ActiveTsConfigurationError(`Transaction for store "${storeName}" is read-only.`);
	};
	const readOnlyStore: StoreAdapter = {
		kind: adapter.kind,
		cacheScope: adapter.cacheScope ?? source.cacheScope,
		datastoreNamespace: adapter.datastoreNamespace ?? source.datastoreNamespace,
		datastoreProjectId: adapter.datastoreProjectId ?? source.datastoreProjectId,
		datastoreDatabaseId: adapter.datastoreDatabaseId === undefined
			? source.datastoreDatabaseId
			: adapter.datastoreDatabaseId,
		datastoreKeyEncoding: adapter.datastoreKeyEncoding ?? source.datastoreKeyEncoding,
		capabilities: Object.freeze({ ...(adapter.capabilities ?? {}), transaction: false, native: false }),
		get: (model, id, options) => {
			const safeModel = snapshotAdapterModel(model, 'transaction read-only scoped store model metadata');
			assertSafeEntityId(id, 'transaction read-only scoped store get id');
			const safeOptions = normalizeStoreReadOptions(options, 'transaction read-only scoped store get options');
			if (safeOptions.native !== undefined) {
				throw new ActiveTsConfigurationError(
					`Transaction for store "${storeName}" is read-only and cannot run native store reads.`
				);
			}
			return adapter.get(safeModel, id, safeOptions);
		},
		getMany: (model, ids, options) => {
			const safeModel = snapshotAdapterModel(model, 'transaction read-only scoped store model metadata');
			const safeIds = assertSafeEntityIdArray(ids, 'transaction read-only scoped store getMany ids');
			const safeOptions = normalizeStoreReadOptions(options, 'transaction read-only scoped store getMany options');
			if (safeOptions.native !== undefined) {
				throw new ActiveTsConfigurationError(
					`Transaction for store "${storeName}" is read-only and cannot run native store reads.`
				);
			}
			return adapter.getMany(safeModel, safeIds, safeOptions);
		},
		query: (model, plan, options) => {
			const safeModel = snapshotAdapterModel(model, 'transaction read-only scoped store model metadata');
			const safePlan = normalizeStoreQueryPlan(plan, safeModel.idField, 'transaction read-only scoped store query plan');
			if (safePlan.native !== undefined) {
				throw new ActiveTsConfigurationError(
					`Transaction for store "${storeName}" is read-only and cannot run native store queries.`
				);
			}
			const safeOptions = validateStoreQueryReadOptions(
				options,
				safePlan,
				'transaction read-only scoped store query options'
			);
			if (safeOptions.native !== undefined) {
				throw new ActiveTsConfigurationError(
					`Transaction for store "${storeName}" is read-only and cannot run native store queries.`
				);
			}
			assertStoreSupports(adapter, safePlan);
			return adapter.query(safeModel, safePlan, safeOptions);
		},
		aggregate: adapter.aggregate
			? (model, plan) => {
					const safeModel = snapshotAdapterModel(model, 'transaction read-only scoped store model metadata');
					const safePlan = normalizeStoreAggregatePlan(plan, 'transaction read-only scoped store aggregate plan');
					if (safePlan.native !== undefined) {
						throw new ActiveTsConfigurationError(
							`Transaction for store "${storeName}" is read-only and cannot run native store aggregate queries.`
						);
					}
					assertStoreDirectAggregateSupported(adapter);
					assertStoreSupports(adapter, safePlan);
					return adapter.aggregate!(safeModel, safePlan);
				}
			: undefined,
		create: rejectWrite,
		update: rejectWrite,
		delete: rejectWrite,
		savepoint: adapter.savepoint
			? (fn) => {
				if (typeof fn !== 'function') {
					return SAFE_PROMISE_REJECT(
						new ActiveTsConfigurationError('read-only transaction savepoint callback must be a function.')
					);
				}
				return adapter.savepoint!((nested) =>
					fn(createTransactionReadOnlyScopedStore(nested, source, storeName))
				);
			}
			: undefined
	};
	return storeTrustsDatastoreEntityKeyRows(adapter) || storeTrustsDatastoreEntityKeyRows(source)
		? markStoreTrustsDatastoreEntityKeyRows(readOnlyStore)
		: readOnlyStore;
}

function createContextBoundTransactionStore(adapter: StoreAdapter, source: StoreAdapter, nativeAdapterName: string): StoreAdapter {
	assertStoreAdapter(adapter, `context store transaction callback adapter "${nativeAdapterName}"`);
	const datastoreNamespace = adapter.datastoreNamespace ?? source.datastoreNamespace;
	const datastoreProjectId = adapter.datastoreProjectId ?? source.datastoreProjectId;
	const datastoreDatabaseId = adapter.datastoreDatabaseId === undefined
		? source.datastoreDatabaseId
		: adapter.datastoreDatabaseId;
	const datastoreKeyEncoding = adapter.datastoreKeyEncoding ?? source.datastoreKeyEncoding;
	const cacheScope = adapter.cacheScope ?? source.cacheScope;
	const trustedDatastoreEntityKeys = storeTrustsDatastoreEntityKeyRows(adapter) || storeTrustsDatastoreEntityKeyRows(source);
	const handle: StoreAdapter = {
		kind: adapter.kind,
		cacheScope,
		datastoreNamespace,
		datastoreProjectId,
		datastoreDatabaseId,
		datastoreKeyEncoding,
		capabilities: Object.freeze({ ...(adapter.capabilities ?? {}), transaction: false }),
		get: async (model, id, options) => {
			const safeModel = snapshotAdapterModel(model, 'context store transaction get model metadata');
			assertSafeEntityId(id, 'context store transaction get id');
			const safeOptions = normalizeStoreReadOptions(options, 'context store transaction get options');
			assertContextStoreReadOptionsSupported(adapter, safeOptions, 'context store transaction get options');
			assertContextDatastoreDirectReadAllowed(safeModel, safeOptions, 'context store transaction get');
			const row = await adapter.get(safeModel, id, safeOptions);
			return normalizeContextStoreGetRow(safeModel, id, row, 'context store transaction get', {
				datastoreAncestor: safeOptions.meta?.datastoreAncestor,
				datastoreNamespace,
				trustedDatastoreEntityKeys
			});
		},
		getMany: async (model, ids, options) => {
			const safeModel = snapshotAdapterModel(model, 'context store transaction getMany model metadata');
			const safeIds = assertSafeEntityIdArray(ids, 'context store transaction getMany ids');
			const safeOptions = normalizeStoreReadOptions(options, 'context store transaction getMany options');
			assertContextStoreReadOptionsSupported(adapter, safeOptions, 'context store transaction getMany options');
			assertContextDatastoreDirectReadAllowed(safeModel, safeOptions, 'context store transaction getMany');
			const rows = await adapter.getMany(safeModel, safeIds, safeOptions);
			return normalizeContextStoreGetManyRows(safeModel, safeIds, rows, 'context store transaction getMany', {
				datastoreAncestor: safeOptions.meta?.datastoreAncestor,
				datastoreNamespace,
				trustedDatastoreEntityKeys
			});
		},
		query: async (model, plan, options) => {
			const safeModel = snapshotAdapterModel(model, 'context store transaction query model metadata');
			const safePlan = normalizeStoreQueryPlan(plan, safeModel.idField, 'context store transaction query plan');
			assertStoreNativeAdapterTag(nativeAdapterName, safePlan, 'context store transaction query plan');
			const safeOptions = validateStoreQueryReadOptions(options, safePlan, 'context store transaction query options');
			assertStoreSupports(adapter, safePlan);
			const result = await adapter.query(safeModel, stripStoreNativeAdapterTag(safePlan), safeOptions);
			return normalizeStoreQueryResultForModel(safeModel, result, 'context store transaction query', {
				cursor: storeCapability(adapter.capabilities, 'cursor'),
				adapterKind: adapter.kind,
				datastoreAncestor: safePlan.meta?.datastoreAncestor,
				datastoreNamespace,
				trustedDatastoreEntityKeys
			});
		},
		aggregate: adapter.aggregate
			? async (model, plan) => {
					const safeModel = snapshotAdapterModel(model, 'context store transaction aggregate model metadata');
					const safePlan = normalizeStoreAggregatePlan(plan, 'context store transaction aggregate plan');
					assertStoreNativeAdapterTag(nativeAdapterName, safePlan, 'context store transaction aggregate plan');
					assertStoreSupports(adapter, safePlan);
					assertStoreDirectAggregateSupported(adapter);
					const result = await adapter.aggregate!(safeModel, stripStoreNativeAdapterTag(safePlan));
					return normalizeStoreAggregateResult(result, safePlan.aggregates, 'context store transaction aggregate');
				}
			: undefined,
		create: async (model, id, data, options) => {
			const safeModel = snapshotAdapterModel(model, 'context store transaction create model metadata');
			assertSafeEntityId(id, 'context store transaction create id');
			const safeData = clonePortableDataObject(data, 'context store transaction create data');
			assertStoreDataMatchesId(safeModel, id, safeData, 'context store transaction create data');
			const safeOptions = normalizeStoreWriteOptions(options, 'context store transaction create options');
			assertContextStoreWriteOptionsSupported(adapter, safeOptions, 'context store transaction create options', {
				expectedVersion: false
			});
			assertContextStoreDatastoreWriteScope(safeModel, id, safeData, safeOptions, 'context store transaction create options');
			return await adapter.create(safeModel, id, safeData, safeOptions);
		},
		update: async (model, id, data, options) => {
			const safeModel = snapshotAdapterModel(model, 'context store transaction update model metadata');
			assertSafeEntityId(id, 'context store transaction update id');
			const safeData = clonePortableDataObject(data, 'context store transaction update data');
			assertStoreDataMatchesId(safeModel, id, safeData, 'context store transaction update data');
			const safeOptions = normalizeStoreWriteOptions(options, 'context store transaction update options');
			assertContextStoreWriteOptionsSupported(adapter, safeOptions, 'context store transaction update options', {
				expectedVersion: true
			});
			assertContextStoreDatastoreWriteScope(safeModel, id, safeData, safeOptions, 'context store transaction update options');
			return await adapter.update(safeModel, id, safeData, safeOptions);
		},
		delete: async (model, id, options) => {
			const safeModel = snapshotAdapterModel(model, 'context store transaction delete model metadata');
			assertSafeEntityId(id, 'context store transaction delete id');
			const safeOptions = normalizeStoreWriteOptions(options, 'context store transaction delete options');
			assertContextStoreWriteOptionsSupported(adapter, safeOptions, 'context store transaction delete options', {
				expectedVersion: true
			});
			assertContextDatastoreDirectWriteAllowed(safeModel, safeOptions, 'context store transaction delete');
			return await adapter.delete(safeModel, id, safeOptions);
		},
		transaction: undefined,
		savepoint: adapter.savepoint
			? (fn) => {
				if (typeof fn !== 'function') {
					return SAFE_PROMISE_REJECT(
						new ActiveTsConfigurationError('context store savepoint callback must be a function.')
					);
				}
				return adapter.savepoint!((nested) =>
					fn(createContextBoundTransactionStore(nested, source, nativeAdapterName))
				);
			}
			: undefined
	};
	markStoreAdapterSource(handle, source);
	return trustedDatastoreEntityKeys
		? markStoreTrustsDatastoreEntityKeyRows(handle)
		: handle;
}

export function isContextBoundStoreAdapter(adapter: unknown): adapter is StoreAdapter {
	try {
		return contextBoundStoreSourceInChain(adapter, false) !== undefined;
	} catch {
		return false;
	}
}

export function isContextBoundCacheAdapter(adapter: unknown): adapter is CacheAdapter {
	try {
		return contextBoundCacheSourceInChain(adapter, false) !== undefined;
	} catch {
		return false;
	}
}

export function isContextBoundSearchAdapter(adapter: unknown): adapter is SearchAdapter {
	try {
		return contextBoundSearchSourceInChain(adapter, false) !== undefined;
	} catch {
		return false;
	}
}

export function assertContextBoundStoreAdapter(adapter: unknown, context = 'store adapter'): StoreAdapter {
	if (contextBoundStoreSourceInChain(adapter, true) !== undefined) return adapter as StoreAdapter;
	throw new ActiveTsConfigurationError(
		`${context} must be a context-bound store adapter returned by ActiveContext.store(). Raw store adapters do not follow ambient transaction guards.`
	);
}

export function assertContextBoundCacheAdapter(adapter: unknown, context = 'cache adapter'): CacheAdapter {
	if (contextBoundCacheSourceInChain(adapter, true) !== undefined) return adapter as CacheAdapter;
	throw new ActiveTsConfigurationError(
		`${context} must be a context-bound cache adapter returned by ActiveContext.cache(). Raw cache adapters do not follow ambient transaction guards.`
	);
}

export function assertContextBoundSearchAdapter(adapter: unknown, context = 'search adapter'): SearchAdapter {
	if (contextBoundSearchSourceInChain(adapter, true) !== undefined) return adapter as SearchAdapter;
	throw new ActiveTsConfigurationError(
		`${context} must be a context-bound search adapter returned by ActiveContext.searchAdapter(). Raw search adapters do not follow ambient transaction guards.`
	);
}

function contextBoundStoreSource(adapter: StoreAdapter | undefined): StoreAdapter | undefined {
	return contextBoundAdapterSource(adapter, CONTEXT_BOUND_STORE_SOURCE, 'store', true) as StoreAdapter | undefined;
}

function contextBoundStoreSourceInChain(adapter: unknown, throwOnMalformed: boolean): StoreAdapter | undefined {
	if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) return undefined;
	for (const source of storeAdapterSourceChain(adapter as StoreAdapter)) {
		const boundSource = contextBoundAdapterSource(source, CONTEXT_BOUND_STORE_SOURCE, 'store', throwOnMalformed);
		if (boundSource) return boundSource as StoreAdapter;
	}
	return undefined;
}

function contextBoundCacheSourceInChain(adapter: unknown, throwOnMalformed: boolean): CacheAdapter | undefined {
	if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) return undefined;
	for (const source of cacheAdapterSourceChain(adapter as CacheAdapter)) {
		const boundSource = contextBoundAdapterSource(source, CONTEXT_BOUND_CACHE_SOURCE, 'cache', throwOnMalformed);
		if (boundSource) return boundSource as CacheAdapter;
	}
	return undefined;
}

function contextBoundSearchSourceInChain(adapter: unknown, throwOnMalformed: boolean): SearchAdapter | undefined {
	if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) return undefined;
	for (const source of searchAdapterSourceChain(adapter as SearchAdapter)) {
		const boundSource = contextBoundAdapterSource(source, CONTEXT_BOUND_SEARCH_SOURCE, 'search', throwOnMalformed);
		if (boundSource) return boundSource as SearchAdapter;
	}
	return undefined;
}

function contextBoundAdapterSource(
	adapter: object | undefined,
	marker: symbol,
	label: string,
	throwOnMalformed: boolean
): object | undefined {
	if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) return undefined;
	const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(adapter, marker);
	if (!descriptor) return undefined;
	if (!('value' in descriptor)) {
		if (!throwOnMalformed) return undefined;
		throw new ActiveTsConfigurationError(`Context-bound ${label} source must be a data property.`);
	}
	const value = descriptor.value;
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		if (!throwOnMalformed) return undefined;
		throw new ActiveTsConfigurationError(`Context-bound ${label} source must be an adapter object.`);
	}
	return value;
}

function isTransactionReadOnlyStore(adapter: StoreAdapter | undefined): boolean {
	if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) return false;
	const descriptor = Object.getOwnPropertyDescriptor(adapter, TRANSACTION_READ_ONLY_STORE);
	if (!descriptor) return false;
	return 'value' in descriptor && descriptor.value === true;
}

function normalizeContextStoreGetRow(
	model: ResolvedModelMeta,
	id: EntityId,
	row: unknown,
	context: string,
	options: { datastoreAncestor?: unknown; datastoreNamespace?: string; trustedDatastoreEntityKeys?: boolean } = {}
) {
	if (row === null) return null;
	if (row === undefined) {
		throw new ActiveTsValidationError(`${context} result must be a plain object or null.`);
	}
	const result = normalizeStoreQueryResultForModel(model, { list: [row] }, context, {
		adapterKind: context,
		datastoreAncestor: options.datastoreAncestor,
		datastoreNamespace: options.datastoreNamespace,
		trustedDatastoreEntityKeys: options.trustedDatastoreEntityKeys
	});
	const clean = result.list[0];
	assertStoreDataMatchesId(model, id, clean, `${context} result`);
	return clean;
}

function normalizeContextStoreGetManyRows(
	model: ResolvedModelMeta,
	ids: EntityId[],
	rows: unknown,
	context: string,
	options: { datastoreAncestor?: unknown; datastoreNamespace?: string; trustedDatastoreEntityKeys?: boolean } = {}
) {
	if (!Array.isArray(rows)) {
		throw new ActiveTsValidationError(`${context} result must be an array.`);
	}
	const safeRows = snapshotArrayInput<unknown>(rows, `${context} result`);
	if (safeRows.length !== ids.length) {
		throw new ActiveTsValidationError(`${context} result must contain ${ids.length} entries.`);
	}
	const normalized: Array<Record<string, any> | null> = [];
	for (let index = 0; index < safeRows.length; index++) {
		const row = safeRows[index];
		if (row === null) {
			normalized[index] = null;
			continue;
		}
		if (row === undefined) {
			throw new ActiveTsValidationError(`${context} result[${index}] must be a plain object or null.`);
		}
		const result = normalizeStoreQueryResultForModel(model, { list: [row] }, `${context} result[${index}]`, {
			adapterKind: context,
			datastoreAncestor: options.datastoreAncestor,
			datastoreNamespace: options.datastoreNamespace,
			trustedDatastoreEntityKeys: options.trustedDatastoreEntityKeys
		});
		const clean = result.list[0];
		assertStoreDataMatchesId(model, ids[index], clean, `${context} result[${index}]`);
		normalized[index] = clean;
	}
	return normalized;
}

function normalizeContextEntityId(id: unknown, context: string): EntityId {
	assertSafeEntityId(id, context);
	return id;
}

function normalizeContextCacheKeys(keys: unknown, context: string) {
	const safeInput = snapshotArrayInput(keys, context);
	const safeKeys: string[] = [];
	for (let index = 0; index < safeInput.length; index++) {
		safeKeys[index] = assertSafeCacheKey(safeInput[index], `${context}[${index}]`);
	}
	return safeKeys;
}

function normalizeContextCacheGetManyResult(value: unknown, expected: number, context: string) {
	if (!Array.isArray(value) || value.length !== expected) {
		throw new ActiveTsValidationError(`${context} result must be an array with ${expected} entries.`);
	}
	const safeInput = snapshotArrayInput(value, `${context} result`);
	const result: unknown[] = [];
	for (let index = 0; index < safeInput.length; index++) {
		const item = safeInput[index];
		if (item === undefined) {
			result[index] = undefined;
			continue;
		}
		assertCacheableValue(item, `${context} result[${index}]`);
		result[index] = cloneSafeData(item);
	}
	return result;
}

function normalizeContextCacheEntries(entries: unknown, context: string): Array<[string, any]> {
	const safeInput = snapshotArrayInput(entries, context);
	const normalized: Array<[string, any]> = [];
	const keys = new Set<string>();
	for (let index = 0; index < safeInput.length; index++) {
		const entry = safeInput[index];
		if (!Array.isArray(entry) || entry.length !== 2) {
			throw new ActiveTsValidationError(`${context}[${index}] must be a [key, value] tuple.`);
		}
		const tuple = snapshotArrayInput(entry, `${context}[${index}]`);
		const key = assertSafeCacheKey(tuple[0], `${context}[${index}] key`);
		if (SET_HAS.call(keys, key)) {
			throw new ActiveTsValidationError(`${context} contains duplicate key "${key}".`);
		}
		SET_ADD.call(keys, key);
		const value = tuple[1];
		assertCacheableValue(value, `${context}[${index}] value`);
		normalized[index] = [key, cloneSafeData(value)];
	}
	return normalized;
}

function normalizeContextCacheWriteOptions(options: unknown, context: string): CacheWriteOptions {
	if (options === undefined) return { ttl: undefined };
	const record = assertContextPlainInputObject(options, context);
	assertContextKnownInputKeys(record, CACHE_WRITE_OPTION_KEYS, context);
	const ttl = ownContextInputValue(record, 'ttl', context);
	return { ttl: assertSafeTtl(ttl, `${context}.ttl`) };
}

function normalizeContextSearchResult(
	model: ResolvedModelMeta,
	value: unknown,
	adapter: Pick<SearchAdapter, 'kind' | 'capabilities'>,
	context: string
): QueryResult {
	const record = assertContextPlainInputObject(value, `${context} result`);
	assertContextKnownInputKeys(record, CONTEXT_QUERY_RESULT_KEYS, `${context} result`);
	const list = ownContextInputValue(record, 'list', `${context} result`);
	if (!Array.isArray(list)) throw new ActiveTsValidationError(`${context} result.list must be an array.`);
	const safeInput = snapshotArrayInput(list, `${context} result.list`);
	const safeList: any[] = [];
	const ids = new Set<string>();
	let staleHits = 0;
	for (let index = 0; index < safeInput.length; index++) {
		const item = safeInput[index];
		assertPlainDataObject(item, `${context} result.list[${index}]`);
		const row = cloneSafeDataObjectWithoutActiveEntityKey(item, `${context} result.list[${index}]`);
		const id = assertStoreDataHasModelId(model, row, `${context} result.list[${index}]`);
		const documentIdentity = datastoreSearchHitDocumentIdentityOrForced(model, item, `${context} result.list[${index}]`);
		const forcedDatastoreIdentity = model.searchDocumentIdentity !== undefined && model.datastore?.ancestor !== undefined;
		if (
			documentIdentity !== undefined &&
			forcedDatastoreIdentity
		) {
			if (documentIdentity !== model.searchDocumentIdentity) {
				staleHits++;
				continue;
			}
			const key = `search:${documentIdentity}`;
			if (SET_HAS.call(ids, key)) {
				throw new ActiveTsValidationError(`${context} result contains duplicate search document identity.`);
			}
			const payloadModel = { ...model, searchDocumentIdentity: undefined };
			if (
				contextSearchCanValidateDatastorePayloadIdentity(
					payloadModel,
					id,
					row,
					`${context} result.list[${index}]`
				) &&
				documentIdentity !== searchDocumentIdentity(
					payloadModel,
					id,
					`${context} result.list[${index}] search document identity`,
					row
				)
			) {
				throw new ActiveTsValidationError(`${context} result.list[${index}] search document identity does not match its Datastore payload data.`);
			}
		} else if (
			documentIdentity !== undefined &&
			contextSearchCanValidateDatastorePayloadIdentity(
				model,
				id,
				row,
				`${context} result.list[${index}]`
			) &&
			documentIdentity !== searchDocumentIdentity(model, id, `${context} result.list[${index}] search document identity`, row)
		) {
			staleHits++;
			continue;
		}
		if (documentIdentity !== undefined) markSearchDocumentIdentity(row, documentIdentity);
		let key = documentIdentity === undefined ? entityIdKey(id) : `search:${documentIdentity}`;
		if (documentIdentity === undefined && model.datastore?.ancestor) {
			const ancestor = datastorePayloadResolvedAncestor(
				model,
				id,
				row,
				`${context} result.list[${index}]`
			);
			if (ancestor === undefined) {
				throw new ActiveTsConfigurationError(
					`${context} result.list[${index}] for Datastore model "${model.name}" cannot be identified without ancestor metadata.`
				);
			}
			key = `${datastoreKeyIdentity(
				normalizeDatastoreKey(ancestor, `${context} result.list[${index}] datastore ancestor`)
			)}:${key}`;
		}
		if (SET_HAS.call(ids, key)) {
			if (documentIdentity !== undefined) {
				throw new ActiveTsValidationError(`${context} result contains duplicate search document identity.`);
			}
			throw new ActiveTsValidationError(`${context} result contains duplicate id "${String(id)}".`);
		}
		SET_ADD.call(ids, key);
		safeList[safeList.length] = row;
	}
	const cursor = assertSafeCursor(ownContextInputValue(record, 'cursor', `${context} result`), `${context} result cursor`);
	const more = ownContextInputValue(record, 'more', `${context} result`);
	const count = assertSafeResultCount(ownContextInputValue(record, 'count', `${context} result`), `${context} result.count`);
	const total = assertSafeResultCount(ownContextInputValue(record, 'total', `${context} result`), `${context} result.total`);
	if (more !== undefined && typeof more !== 'boolean') {
		throw new ActiveTsValidationError(`${context} result.more must be a boolean.`);
	}
	if (cursor !== undefined && !searchCapability(adapter.capabilities, 'cursor')) {
		throw new ActiveTsConfigurationError(
			`Search adapter "${adapter.kind}" does not support returning portable cursors.`
		);
	}
	if (total !== undefined && total < safeList.length) {
		throw new ActiveTsValidationError(`${context} result.total cannot be smaller than result.list length.`);
	}
	return { list: safeList, cursor, more, count: count === undefined ? undefined : safeList.length, total: staleHits ? undefined : total };
}

function contextSearchCanValidateDatastorePayloadIdentity(
	model: ResolvedModelMeta,
	id: EntityId,
	row: Record<string, unknown>,
	context: string
) {
	if (!model.datastore?.ancestor) return true;
	return datastorePayloadCanResolveAncestor(model, id, row, context);
}

function assertContextSearchIndexSupported(adapter: Pick<SearchAdapter, 'kind' | 'capabilities'>) {
	if (!searchCapability(adapter.capabilities, 'index')) {
		throw new ActiveTsConfigurationError(`Search adapter "${adapter.kind}" does not support indexing.`);
	}
}

function assertContextPlainInputObject(value: unknown, context: string): Record<string, unknown> {
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
	for (const property of Object.getOwnPropertyNames(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, property);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsValidationError(`${context}.${property} must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsValidationError(`${context}.${property} must be enumerable.`);
		}
	}
	return value as Record<string, unknown>;
}

function assertContextKnownInputKeys(value: object, allowed: readonly string[], context: string) {
	const allowedSet = capturedSet(allowed);
	for (const property of Object.getOwnPropertyNames(value)) {
		if (!SET_HAS.call(allowedSet, property)) {
			throw new ActiveTsValidationError(`${context} contains unknown option "${property}".`);
		}
	}
}

function ownContextInputValue(record: Record<string, unknown>, key: string, context: string) {
	if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(record, key);
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsValidationError(`${context}.${key} must be a data property.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsValidationError(`${context}.${key} must be enumerable.`);
	}
	return descriptor.value;
}

function rebindNativeSearchAdaptersForStores(
	search: Record<string, SearchAdapter>,
	sourceStores: Record<string, StoreAdapter>,
	targetStores: Record<string, StoreAdapter>,
	requireBoundStore: boolean
) {
	let changed = false;
	const rebound: Record<string, SearchAdapter> = { ...search };
	for (const [name, adapter] of OBJECT_ENTRIES(search)) {
		const rawSourceStore = nativeSearchSourceStore(adapter);
		if (!rawSourceStore) continue;
		const sourceMatch = findNativeSearchSourceStoreRoute(rawSourceStore, sourceStores);
		if (!sourceMatch) {
			if (requireBoundStore) {
				rebound[name] = createUnboundTransactionNativeSearchAdapter(adapter, name);
				changed = true;
			}
			continue;
		}
		const targetStore = targetStores[sourceMatch.storeName];
		if (!targetStore || targetStore === sourceMatch.sourceStore) continue;
		const next = rebindNativeSearchAdapter(adapter, targetStore);
		if (!next) {
			if (!requireBoundStore) continue;
			rebound[name] = createUnboundTransactionNativeSearchAdapter(adapter, name);
		} else {
			rebound[name] = markTransactionNativeSearchStoreRoute(next, sourceMatch.storeName);
		}
		changed = true;
	}
	return changed ? rebound : search;
}

function findNativeSearchSourceStoreRoute(sourceStore: StoreAdapter, sourceStores: Record<string, StoreAdapter>) {
	const sourceChain = nativeSearchSourceStoreChain(sourceStore);
	for (let sourceIndex = 0; sourceIndex < sourceChain.length; sourceIndex++) {
		const source = sourceChain[sourceIndex];
		for (const [storeName, store] of OBJECT_ENTRIES(sourceStores)) {
			for (const registeredSource of storeAdapterSourceChain(store)) {
				if (source !== registeredSource) continue;
				return { storeName, sourceStore: store };
			}
		}
	}
	return undefined;
}

function nativeSearchSourceStoreChain(sourceStore: StoreAdapter) {
	const chain = storeAdapterSourceChain(sourceStore);
	const boundSource = contextBoundStoreSource(sourceStore);
	if (boundSource === undefined) return chain;
	for (let index = 0; index < chain.length; index++) {
		if (chain[index] === boundSource) return chain;
	}
	chain[chain.length] = boundSource;
	return chain;
}

function createTransactionScopedSearchAdapters(search: Record<string, SearchAdapter>) {
	const scoped = Object.create(null) as Record<string, SearchAdapter>;
	for (const [name, adapter] of OBJECT_ENTRIES(search)) {
		defineDataProperty(scoped, name, createTransactionScopedSearchAdapter(adapter, name), {
			enumerable: true,
			configurable: true,
			writable: true
		});
	}
	return scoped;
}

function createTransactionScopedCacheAdapters(caches: Record<string, CacheAdapter>) {
	const scoped = Object.create(null) as Record<string, CacheAdapter>;
	for (const [name, adapter] of OBJECT_ENTRIES(caches)) {
		defineDataProperty(scoped, name, createTransactionScopedCacheAdapter(adapter, name), {
			enumerable: true,
			configurable: true,
			writable: true
		});
	}
	return scoped;
}

function createTransactionScopedCacheAdapter(adapter: CacheAdapter, routeName: string): CacheAdapter {
	const rejectMutation = async () => {
		throw new ActiveTsConfigurationError(
			`Cache adapter "${routeName}" cannot be mutated directly inside a transaction. Use context.invalidate() so cache changes are deferred until commit.`
		);
	};
	const scoped: CacheAdapter = {
		kind: adapter.kind,
		getMany: (...args) => adapter.getMany(...args),
		setMany: rejectMutation,
		deleteMany: rejectMutation,
		codecKey: adapter.codecKey ? (...args) => adapter.codecKey!(...args) : undefined
	};
	if (cacheSupportsVersioning(adapter)) {
		scoped.getManyVersioned = (...args) => adapter.getManyVersioned(...args);
		scoped.setManyVersioned = rejectMutation;
		scoped.invalidateMany = rejectMutation;
	}
	return markCacheAdapterSource(scoped, adapter);
}

function createTransactionScopedSearchAdapter(adapter: SearchAdapter, routeName: string): SearchAdapter {
	const allowSearch = nativeSearchSourceStore(adapter) !== undefined || isUnboundTransactionNativeSearchAdapter(adapter);
	const nativeStoreRoute = transactionNativeSearchStoreRoute(adapter);
	const rejectSearchRead = async () => {
		throw new ActiveTsConfigurationError(
			`Search adapter "${routeName}" cannot be read inside a transaction. Use native search or run search after commit.`
		);
	};
	const rejectIndexSideEffect = async () => {
		throw new ActiveTsConfigurationError(
			`Search adapter "${routeName}" cannot index or delete documents inside a transaction. Use an outbox search sync after commit.`
		);
	};
	const rejectSchemaSideEffect = async () => {
		throw new ActiveTsConfigurationError(
			`Search adapter "${routeName}" cannot sync schemas inside a transaction.`
		);
	};
	const capabilities = Object.freeze(
		allowSearch
			? { ...(adapter.capabilities ?? {}), index: false, revisionWrites: false }
			: {
					...(adapter.capabilities ?? {}),
					where: false,
					whereOperators: {},
					nestedFields: false,
					numericComparisons: false,
					nullOperators: false,
					cursor: false,
					native: false,
					index: false,
					revisionWrites: false
				}
	);
	const scopedSearch: SearchAdapter = {
		kind: adapter.kind,
		searchIndexKind: adapter.searchIndexKind,
		capabilities,
		search: allowSearch
			? (model, query, options) => {
					const safeModel = nativeStoreRoute === undefined
						? model
						: snapshotAdapterModel(model, 'transaction native search model metadata');
					if (nativeStoreRoute !== undefined && safeModel.store !== nativeStoreRoute) {
						throw new ActiveTsConfigurationError(
							`Cannot route transaction native searches for store "${safeModel.store}" to store "${nativeStoreRoute}".`
						);
					}
					return adapter.search(safeModel, query, options);
				}
			: rejectSearchRead,
		index: rejectIndexSideEffect,
		delete: rejectIndexSideEffect,
		schema: adapter.schema
			? {
					plan: rejectSchemaSideEffect,
					apply: rejectSchemaSideEffect
				}
			: undefined,
		syncSchema: adapter.syncSchema ? rejectSchemaSideEffect : undefined
	};
	defineDataProperty(scopedSearch, TRANSACTION_SCOPED_SEARCH_ADAPTER, true, {
		enumerable: false,
		configurable: false
	});
	return scopedSearch;
}

function markTransactionNativeSearchStoreRoute<T extends SearchAdapter>(adapter: T, routeName: string): T {
	defineDataProperty(adapter, TRANSACTION_NATIVE_SEARCH_STORE_ROUTE, routeName, {
		enumerable: false,
		configurable: false
	});
	return adapter;
}

function transactionNativeSearchStoreRoute(adapter: SearchAdapter) {
	const descriptor = Object.getOwnPropertyDescriptor(adapter, TRANSACTION_NATIVE_SEARCH_STORE_ROUTE);
	if (!descriptor) return undefined;
	if (!('value' in descriptor) || typeof descriptor.value !== 'string') {
		throw new ActiveTsConfigurationError('Transaction native search store route marker must be a string data property.');
	}
	return descriptor.value;
}

function isTransactionScopedSearchAdapter(adapter: SearchAdapter | undefined): boolean {
	if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) return false;
	const descriptor = Object.getOwnPropertyDescriptor(adapter, TRANSACTION_SCOPED_SEARCH_ADAPTER);
	if (!descriptor) return false;
	return 'value' in descriptor && descriptor.value === true;
}

function isUnboundTransactionNativeSearchAdapter(adapter: SearchAdapter | undefined): boolean {
	if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) return false;
	const descriptor = Object.getOwnPropertyDescriptor(adapter, UNBOUND_TRANSACTION_NATIVE_SEARCH_ADAPTER);
	if (!descriptor) return false;
	return 'value' in descriptor && descriptor.value === true;
}

function createUnboundTransactionNativeSearchAdapter(adapter: SearchAdapter, routeName: string): SearchAdapter {
	const reject = async () => {
		throw new ActiveTsConfigurationError(
			`Native search adapter "${routeName}" is bound to a store that is not registered in this transaction context.`
		);
	};
	const unbound: SearchAdapter = {
		kind: adapter.kind,
		searchIndexKind: adapter.searchIndexKind,
		capabilities: adapter.capabilities,
		search: reject,
		index: (...args) => adapter.index(...args),
		delete: (...args) => adapter.delete(...args),
		schema: adapter.schema
			? {
					plan: (...args) => adapter.schema!.plan(...args),
					apply: (...args) => adapter.schema!.apply(...args)
				}
			: undefined,
		syncSchema: adapter.syncSchema ? (...args) => adapter.syncSchema!(...args) : undefined
	};
	defineDataProperty(unbound, UNBOUND_TRANSACTION_NATIVE_SEARCH_ADAPTER, true, {
		enumerable: false,
		configurable: false
	});
	return unbound;
}

function clonePlannerQueryPlan(plan: QueryPlan): QueryPlan {
	const or: QueryPlan['or'] = [];
	for (let index = 0; index < plan.or.length; index++) or[index] = clonePlannerQueryPlan(plan.or[index]);
	const sort: QueryPlan['sort'] = [];
	for (let index = 0; index < plan.sort.length; index++) {
		sort[index] = { field: plan.sort[index].field, direction: plan.sort[index].direction };
	}
	return {
		where: clonePlannerWhereEntries(plan.where),
		or,
		sort,
		include: [...plan.include],
		limit: plan.limit,
		offset: plan.offset,
		cursor: plan.cursor,
		select: plan.select ? [...plan.select] : undefined,
		native: plan.native
			? { adapter: plan.native.adapter, payload: cloneNativePayload(plan.native.payload, 'query planner native payload') }
			: undefined,
		meta: clonePlanMeta(plan.meta, 'query planner meta')
	};
}

function clonePlannerAggregatePlan(plan: AggregatePlan): AggregatePlan {
	const or: AggregatePlan['or'] = [];
	for (let index = 0; index < plan.or.length; index++) or[index] = clonePlannerQueryPlan(plan.or[index]);
	const aggregates: AggregatePlan['aggregates'] = [];
	for (let index = 0; index < plan.aggregates.length; index++) aggregates[index] = { ...plan.aggregates[index] };
	return {
		where: clonePlannerWhereEntries(plan.where),
		or,
		aggregates,
		native: plan.native
			? { adapter: plan.native.adapter, payload: cloneNativePayload(plan.native.payload, 'aggregate planner native payload') }
			: undefined,
		meta: clonePlanMeta(plan.meta, 'aggregate planner meta')
	};
}

function clonePlannerSearchOptions(options: SearchOptions): SearchOptions {
	let where: SearchOptions['where'];
	if (options.where) {
		where = {};
		for (const [field, value] of OBJECT_ENTRIES(options.where)) {
			defineDataProperty(where, field, structuredClone(value), { enumerable: true, configurable: true, writable: true });
		}
	}
	return {
		where,
		limit: options.limit,
		cursor: options.cursor,
		native: cloneNativePayload(options.native, 'search planner native payload')
	};
}

function clonePlannerWhereEntries(entries: QueryPlan['where']): QueryPlan['where'] {
	const cloned: QueryPlan['where'] = [];
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		cloned[index] = entry.value2 === undefined
			? { field: entry.field, op: entry.op, value: structuredClone(entry.value) }
			: { field: entry.field, op: entry.op, value: structuredClone(entry.value), value2: structuredClone(entry.value2) };
	}
	return cloned;
}

function assertStoreSupports(
	store: StoreAdapter,
	plan: Pick<QueryPlan, 'where' | 'or' | 'native'> &
		Partial<Pick<QueryPlan, 'select' | 'cursor' | 'sort'>> &
		Partial<Pick<AggregatePlan, 'aggregates'>> &
		Partial<Pick<QueryPlan, 'meta'>>
) {
	const wheres = collectWhereEntries(plan);
	for (const where of wheres) {
		if (where.op === 'contains') {
			throw new ActiveTsConfigurationError(
				'The legacy contains operator is ambiguous. Use arrayContains, textContains, or jsonContains.'
			);
		}
	}
	if (hasOrBranches(plan) && !storeCapability(store.capabilities, 'or'))
		throw new ActiveTsConfigurationError(`Store adapter "${store.kind}" does not support orWhere().`);
	if (plan.cursor !== undefined && !storeCapability(store.capabilities, 'cursor'))
		throw new ActiveTsConfigurationError(`Store adapter "${store.kind}" does not support cursor pagination.`);
	if (plan.select?.length && !storeCapability(store.capabilities, 'select'))
		throw new ActiveTsConfigurationError(`Store adapter "${store.kind}" does not support select().`);
	if (plan.native !== undefined && !storeCapability(store.capabilities, 'native'))
		throw new ActiveTsConfigurationError(`Store adapter "${store.kind}" does not support native queries.`);
	if (plan.meta?.requiresMissingFieldNulls && !storeCapability(store.capabilities, 'missingFieldNulls')) {
		throw new ActiveTsConfigurationError(
			`Store adapter "${store.kind}" does not support matching missing fields as null. Materialize soft-delete null fields before enabling this query.`
		);
	}
	if (plan.meta?.datastoreAncestor !== undefined && !storeCapability(store.capabilities, 'datastoreAncestor')) {
		throw new ActiveTsConfigurationError(`Store adapter "${store.kind}" does not support Datastore ancestor query metadata.`);
	}
	if (
		plan.meta !== undefined &&
		Object.prototype.hasOwnProperty.call(plan.meta, 'datastoreRead') &&
		!storeCapability(store.capabilities, 'datastoreReadPolicy')
	) {
		throw new ActiveTsConfigurationError(`Store adapter "${store.kind}" does not support Datastore read policies.`);
	}
	for (const where of wheres) {
		if ((where.op === 'isNull' || where.op === 'isNotNull') && !storeCapability(store.capabilities, 'nullOperators'))
			throw new ActiveTsConfigurationError(`Store adapter "${store.kind}" does not support null operators.`);
		if (where.op === 'isNull' && !storeCapability(store.capabilities, 'missingFieldNulls')) {
			throw new ActiveTsConfigurationError(
				`Store adapter "${store.kind}" does not support matching missing fields as null. Use equality with null for explicit-null queries.`
			);
		}
		if (where.op === 'arrayContains' && !storeCapability(store.capabilities, 'arrayContains'))
			throw new ActiveTsConfigurationError(`Store adapter "${store.kind}" does not support arrayContains queries.`);
		if (where.op === 'textContains' && !storeCapability(store.capabilities, 'textContains'))
			throw new ActiveTsConfigurationError(`Store adapter "${store.kind}" does not support textContains queries.`);
		if (where.op === 'jsonContains' && !storeCapability(store.capabilities, 'jsonContains'))
			throw new ActiveTsConfigurationError(`Store adapter "${store.kind}" does not support jsonContains queries.`);
		if (where.op === 'startsWith' && !storeCapability(store.capabilities, 'startsWith'))
			throw new ActiveTsConfigurationError(`Store adapter "${store.kind}" does not support startsWith queries.`);
		if (isRangeOperator(where.op) && !storeCapability(store.capabilities, 'numericComparisons'))
			throw new ActiveTsConfigurationError(
				`Store adapter "${store.kind}" does not support safe range comparisons without typed fields.`
			);
		if (where.field.includes('.') && !storeCapability(store.capabilities, 'nestedFields'))
			throw new ActiveTsConfigurationError(`Store adapter "${store.kind}" does not support nested field queries.`);
	}
	const fieldSpecs: Array<{ field: string; context: string }> = [];
	const sort = plan.sort ?? [];
	for (let index = 0; index < sort.length; index++) {
		fieldSpecs[fieldSpecs.length] = { field: sort[index].field, context: 'nested field sorting' };
	}
	const select = plan.select ?? [];
	for (let index = 0; index < select.length; index++) {
		fieldSpecs[fieldSpecs.length] = { field: select[index], context: 'nested field selection' };
	}
	const aggregates = plan.aggregates ?? [];
	for (let index = 0; index < aggregates.length; index++) {
		const field = aggregates[index].field;
		if (field) fieldSpecs[fieldSpecs.length] = { field, context: 'nested field aggregation' };
	}
	for (const spec of fieldSpecs) {
		if (spec.field.includes('.') && !storeCapability(store.capabilities, 'nestedFields')) {
			throw new ActiveTsConfigurationError(`Store adapter "${store.kind}" does not support ${spec.context}.`);
		}
	}
}

function assertStoreDirectAggregateSupported(store: StoreAdapter) {
	if (!storeCapability(store.capabilities, 'aggregate')) {
		throw new ActiveTsConfigurationError(`Store adapter "${store.kind}" does not support aggregate().`);
	}
}

function assertContextStoreWriteOptionsSupported(
	store: StoreAdapter,
	options: StoreWriteOptions,
	context: string,
	supports: { expectedVersion: boolean }
) {
	if (
		options.expectedVersion !== undefined &&
		(!supports.expectedVersion || !storeCapability(store.capabilities, 'optimisticLock'))
	) {
		throw new ActiveTsConfigurationError(`${context} does not support expectedVersion.`);
	}
	if (
		options.meta !== undefined &&
		Object.prototype.hasOwnProperty.call(options.meta, 'datastoreAncestor') &&
		!storeCapability(store.capabilities, 'datastoreAncestor')
	) {
		throw new ActiveTsConfigurationError(`${context} does not support Datastore ancestor write metadata.`);
	}
}

function assertContextStoreDatastoreWriteScope(
	model: ResolvedModelMeta,
	id: EntityId,
	data: Record<string, unknown>,
	options: StoreWriteOptions,
	context: string
) {
	if (!model.datastore?.ancestor || !options.meta || !Object.prototype.hasOwnProperty.call(options.meta, 'datastoreAncestor')) {
		return;
	}
	const expectedAncestor = options.meta.datastoreAncestor === undefined
		? undefined
		: normalizeDatastoreKey(options.meta.datastoreAncestor, `${context}.meta.datastoreAncestor`);
	if (datastoreWritePayloadMatchesScopedAncestor(model, id, data, expectedAncestor, context)) return;
	throw new ActiveTsValidationError(`${context} Datastore ancestor does not match its payload data.`);
}

function assertContextStoreReadOptionsSupported(store: StoreAdapter, options: StoreReadOptions, context: string) {
	if (
		options.meta !== undefined &&
		Object.prototype.hasOwnProperty.call(options.meta, 'datastoreAncestor') &&
		!storeCapability(store.capabilities, 'datastoreAncestor')
	) {
		throw new ActiveTsConfigurationError(`${context} does not support Datastore ancestor read metadata.`);
	}
	if (
		options.meta !== undefined &&
		Object.prototype.hasOwnProperty.call(options.meta, 'datastoreRead') &&
		!storeCapability(store.capabilities, 'datastoreReadPolicy')
	) {
		throw new ActiveTsConfigurationError(`${context} does not support Datastore read policies.`);
	}
}

function assertContextDatastoreDirectReadAllowed(model: ResolvedModelMeta, options: StoreReadOptions, context: string) {
	if (!model.datastore?.ancestor) return;
	if (
		options.meta !== undefined &&
		Object.prototype.hasOwnProperty.call(options.meta, 'datastoreAncestor') &&
		options.meta.datastoreAncestor !== undefined
	) return;
	throw new ActiveTsConfigurationError(
		`${context} for Datastore model "${model.name}" requires ancestor-aware query metadata.`
	);
}

function assertContextDatastoreDirectWriteAllowed(model: ResolvedModelMeta, options: StoreWriteOptions, context: string) {
	if (!model.datastore?.ancestor) return;
	if (
		options.meta !== undefined &&
		Object.prototype.hasOwnProperty.call(options.meta, 'datastoreAncestor') &&
		options.meta.datastoreAncestor !== undefined
	) return;
	throw new ActiveTsConfigurationError(
		`${context} for Datastore model "${model.name}" requires ancestor-aware query metadata.`
	);
}

function assertStoreSchemaPlanSupported(store: StoreAdapter, plan: SchemaPlan) {
	if (storeCapability(store.capabilities, 'uniqueIndex')) return;
	for (const change of plan.changes) {
		if (change.type !== 'create-index' || change.unique !== true) continue;
		throw new ActiveTsConfigurationError(
			`Store adapter "${store.kind}" does not support unique indexes in schema plans. Unsupported index "${change.name}" on "${change.target}".`
		);
	}
}

function assertStoreSchemaModelsSupported(store: StoreAdapter, models: ResolvedModelMeta[]) {
	const unique = firstUniqueIndexModel(models);
	if (!unique) return;
	if (!storeCapability(store.capabilities, 'uniqueIndex')) {
		throw new ActiveTsConfigurationError(
			`Store adapter "${store.kind}" does not support unique indexes in schema plans. Unsupported index "${unique.index.name}" on "${unique.model.name}".`
		);
	}
	if (!store.schema) {
		throw new ActiveTsConfigurationError(
			`Store adapter "${store.kind}" advertises unique indexes but does not expose schema planning. Unsupported index "${unique.index.name}" on "${unique.model.name}".`
		);
	}
}

function manualStoreSchemaPlan(route: string, store: StoreAdapter, models: ResolvedModelMeta[]): SchemaPlan {
	const changes: SchemaPlan['changes'] = [];
	const datastoreIndexes = storeCapability(store.capabilities, 'datastoreAncestor');
	for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
		const model = models[modelIndex];
		const ancestorModes: readonly (boolean | undefined)[] = datastoreIndexes
			? datastoreSchemaAncestorModes(model.datastore?.ancestor !== undefined)
			: [undefined];
		for (let modeIndex = 0; modeIndex < ancestorModes.length; modeIndex++) {
			const ancestor = ancestorModes[modeIndex];
			for (let indexIndex = 0; indexIndex < model.indexes.length; indexIndex++) {
				const index = model.indexes[indexIndex];
				const runtimeIndex = datastoreIndexes
					? datastoreRuntimeSchemaIndex(model, index.fields, index.directions)
					: { fields: index.fields, directions: index.directions };
				changes[changes.length] = {
					type: 'create-index' as const,
					target: model.name,
					name: index.name,
					fields: runtimeIndex.fields,
					...(runtimeIndex.directions === undefined ? {} : { directions: runtimeIndex.directions }),
					...(ancestor === undefined ? {} : { ancestor }),
					unique: index.unique
				};
			}
		}
	}
	return routeSchemaPlan(
		normalizeSchemaPlan(
			{
				adapter: store.kind,
				status: 'manual',
				note: `Store adapter "${route}" does not expose schema planning. Apply declared indexes manually or use an adapter with schema hooks.`,
				changes
			},
			`Store adapter "${route}" manual schema plan`
		),
		route
	);
}

function datastoreRuntimeSchemaIndex(
	model: ResolvedModelMeta,
	rawFields: readonly string[],
	rawDirections: readonly SortDirection[] | undefined
) {
	const fields: string[] = [];
	for (let index = 0; index < rawFields.length; index++) {
		fields[index] = assertSafeDatastoreSchemaField(rawFields[index], 'Datastore schema index field');
	}
	const directions = schemaIndexDirections(rawDirections, fields.length);
	let hasIdField = false;
	for (let index = 0; index < fields.length; index++) {
		if (fields[index] !== model.idField) continue;
		hasIdField = true;
		break;
	}
	if (!hasIdField) {
		fields[fields.length] = assertSafeDatastoreSchemaField(model.idField, 'Datastore schema index field');
		directions[directions.length] = 'asc';
	}
	return { fields, directions };
}

function assertSafeDatastoreSchemaField(field: unknown, context: string) {
	const safeField = assertSafeFieldPath(field, context);
	if (safeField.includes('/')) throw new ActiveTsValidationError(`${context} "${safeField}" cannot contain "/".`);
	return safeField;
}

function schemaIndexDirections(directions: readonly SortDirection[] | undefined, fieldCount: number) {
	const safeDirections: SortDirection[] = [];
	for (let index = 0; index < fieldCount; index++) safeDirections[index] = directions?.[index] ?? 'asc';
	return safeDirections;
}

function manualSearchSchemaPlan(route: string, adapter: SearchAdapter, models: ResolvedModelMeta[]): SchemaPlan {
	const changes: SchemaPlan['changes'] = [];
	for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
		const model = models[modelIndex];
		for (let indexIndex = 0; indexIndex < model.searchIndexes.length; indexIndex++) {
			const index = model.searchIndexes[indexIndex];
			changes[changes.length] = {
				type: 'create-search-index' as const,
				target: model.name,
				name: index.name,
				fields: index.fields
			};
		}
	}
	assertSearchSchemaIndexingSupported(adapter, changes, route);
	return routeSchemaPlan(
		normalizeSchemaPlan(
			{
				adapter: adapter.kind,
				status: 'manual',
				note: `Search adapter "${route}" does not expose schema planning. Apply declared search indexes manually or use an adapter with schema hooks.`,
				changes
			},
			`Search adapter "${route}" manual schema plan`
		),
		route
	);
}

function firstUniqueIndexModel(models: ResolvedModelMeta[]) {
	for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
		const model = models[modelIndex];
		for (let indexIndex = 0; indexIndex < model.indexes.length; indexIndex++) {
			const index = model.indexes[indexIndex];
			if (index.unique === true) return { model, index };
		}
	}
	return undefined;
}

function assertSearchSchemaPlanSupported(adapter: SearchAdapter, plan: SchemaPlan) {
	assertSearchSchemaIndexingSupported(adapter, plan.changes, plan.route ?? adapter.kind);
}

function assertSearchSchemaPlanModelInvariants(plan: SchemaPlan, models: ResolvedModelMeta[], context: string) {
	for (let index = 0; index < plan.changes.length; index++) {
		const change = plan.changes[index];
		if (change.type !== 'create-search-index') continue;
		const model = schemaPlanTargetModel(models, change.target);
		if (!model) continue;
		assertNoOverlappingFieldPaths(
			[model.idField, ...change.fields, ...(model.datastore?.ancestorFields ?? [])],
			`${context}.changes[${index}].fields`
		);
	}
}

function schemaPlanTargetModel(models: ResolvedModelMeta[], target: string) {
	for (let index = 0; index < models.length; index++) {
		if (models[index].name === target) return models[index];
	}
	return undefined;
}

function assertSearchSchemaIndexingSupported(
	adapter: SearchAdapter,
	changes: SchemaPlan['changes'],
	route: string
) {
	if (!hasCreateSearchIndexChange(changes)) return;
	if (searchCapability(adapter.capabilities, 'index')) return;
	throw new ActiveTsConfigurationError(
		`Search adapter "${route}" does not support indexing and cannot plan search indexes.`
	);
}

function collectWhereEntries(plan: Pick<QueryPlan, 'where' | 'or'>): QueryPlan['where'] {
	const entries: QueryPlan['where'] = [];
	for (let index = 0; index < plan.where.length; index++) entries[index] = plan.where[index];
	for (let index = 0; index < plan.or.length; index++) {
		const nested = collectWhereEntries(plan.or[index]);
		for (let nestedIndex = 0; nestedIndex < nested.length; nestedIndex++) {
			entries[entries.length] = nested[nestedIndex];
		}
	}
	return entries;
}

function hasOrBranches(plan: Pick<QueryPlan, 'or'>): boolean {
	if (plan.or.length > 0) return true;
	for (let index = 0; index < plan.or.length; index++) {
		if (hasOrBranches(plan.or[index])) return true;
	}
	return false;
}

function hasUntaggedSearchIndex(indexes: ResolvedModelMeta['searchIndexes']) {
	for (let index = 0; index < indexes.length; index++) {
		if (!indexes[index].adapter) return true;
	}
	return false;
}

function hasCreateSearchIndexChange(changes: SchemaPlan['changes']) {
	for (let index = 0; index < changes.length; index++) {
		if (changes[index].type === 'create-search-index') return true;
	}
	return false;
}

function isRangeOperator(op: QueryPlan['where'][number]['op']) {
	return op === '>' || op === '>=' || op === '<' || op === '<=' || op === 'between';
}

function normalizeMaxBatchSize(value: number | undefined) {
	if (value === undefined) return 500;
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
		throw new ActiveTsValidationError('batch.maxSize must be a positive safe integer.');
	}
	return value;
}

function routeSchemaPlan(plan: SchemaPlan, route: string): SchemaPlan {
	return {
		...plan,
		route: assertSafeSchemaIdentifier(route, 'schema adapter route')
	};
}

function chunkItems<T>(items: T[], size: number) {
	const chunks: T[][] = [];
	for (let index = 0; index < items.length; index += size) {
		const chunk: T[] = [];
		const end = Math.min(index + size, items.length);
		for (let itemIndex = index; itemIndex < end; itemIndex++) {
			chunk[chunk.length] = items[itemIndex];
		}
		chunks[chunks.length] = chunk;
	}
	return chunks;
}

function cloneArray<T>(items: readonly T[]): T[] {
	const clone: T[] = [];
	for (let index = 0; index < items.length; index++) {
		clone[index] = items[index];
	}
	return clone;
}

function cacheEntryKeys(entries: readonly [string, any][]) {
	const keys: string[] = [];
	for (let index = 0; index < entries.length; index++) {
		keys[index] = entries[index][0];
	}
	return keys;
}

function appendHooks(target: ActiveTsHook[], source: readonly ActiveTsHook[]) {
	for (let index = 0; index < source.length; index++) {
		target[target.length] = source[index];
	}
}

function assertDeferredTask(task: unknown, context: string): asserts task is DeferredTask {
	if (typeof task !== 'function') {
		throw new ActiveTsConfigurationError(`${context} must be a function.`);
	}
}

function modelDataValue(item: unknown, context: string): Record<string, any> {
	if (!item || typeof item !== 'object' || Array.isArray(item)) {
		throw new ActiveTsValidationError(`${context} must be a model instance.`);
	}
	const descriptor = Object.getOwnPropertyDescriptor(item, 'data');
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsValidationError(`${context}.data must be a data property.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsValidationError(`${context}.data must be enumerable.`);
	}
	return descriptor.value as Record<string, any>;
}

function replaceModelData(
	item: { data: Record<string, any> },
	currentData: Record<string, any>,
	clean: Record<string, any>
) {
	if (currentData && typeof currentData === 'object' && !Array.isArray(currentData)) {
		for (const key of Object.keys(currentData)) {
			if (!Object.prototype.hasOwnProperty.call(clean, key)) delete currentData[key];
		}
		for (const key of Object.keys(clean)) {
			defineDataProperty(currentData, key, clean[key], { enumerable: true, configurable: true, writable: true });
		}
		return;
	}
	defineDataProperty(item, 'data', clean, { enumerable: true, configurable: true, writable: true });
}

function ownValue<T>(record: Record<string, T>, key: string, context?: string): T | undefined {
	if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(record, key);
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsConfigurationError(`${context ? `${context}.${key}` : `property "${key}"`} must be a data property.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsConfigurationError(`${context ? `${context}.${key}` : `property "${key}"`} must be enumerable.`);
	}
	return descriptor.value as T;
}

function pluginSetupPromise(result: unknown, pluginName: string) {
	if (result === undefined || result === null) return undefined;
	const resultType = typeof result;
	if (resultType !== 'object' && resultType !== 'function') return undefined;
	let then: unknown;
	try {
		then = (result as PromiseLike<void>).then;
	} catch (error) {
		throw new ActiveTsConfigurationError(`Plugin "${pluginName}" setup failed: ${safeErrorMessage(error)}`);
	}
	if (typeof then !== 'function') return undefined;
	return new Promise<void>((resolve, reject) => {
		try {
			then.call(result, resolve, reject);
		} catch (error) {
			reject(error);
		}
	}).catch((error) => {
		throw new ActiveTsConfigurationError(`Plugin "${pluginName}" setup failed: ${safeErrorMessage(error)}`);
	});
}

function sanitizeReadResult(value: unknown, expectedIds: readonly EntityId[], idField: string, context: string) {
	const expectedLength = expectedIds.length;
	if (!Array.isArray(value) || value.length !== expectedLength) {
		throw new ActiveTsValidationError(`${context} result must be an array with ${expectedLength} entries.`);
	}
	const items = snapshotArrayInput<Record<string, unknown> | null | undefined>(value, `${context} result`);
	const result: Array<Record<string, unknown> | null> = [];
	for (let index = 0; index < items.length; index++) {
		const item = items[index];
		if (item === undefined || item === null) {
			result[index] = null;
			continue;
		}
		assertPlainDataObject(item, `${context} result[${index}]`);
		assertResultMatchesId(item, expectedIds[index], idField, `${context} result[${index}]`);
		result[index] = item;
	}
	return result;
}

function sanitizeCacheGetResult(value: unknown, expectedIds: readonly EntityId[], idField: string, context: string) {
	const expectedLength = expectedIds.length;
	if (!Array.isArray(value) || value.length !== expectedLength) {
		throw new ActiveTsValidationError(`${context} result must be an array with ${expectedLength} entries.`);
	}
	const items = snapshotArrayInput<Record<string, unknown> | null | undefined>(value, `${context} result`);
	for (let index = 0; index < items.length; index++) {
		const item = items[index];
		if (item === undefined || item === null) continue;
		assertPlainDataObject(item, `${context} result[${index}]`);
		assertResultMatchesId(item, expectedIds[index], idField, `${context} result[${index}]`);
	}
	return items;
}

function applyNegativeCachePolicy<T>(items: Array<T | null | undefined>, meta: ResolvedModelMeta) {
	if (meta.cache?.negativeTtl !== undefined) return items;
	const result: Array<T | undefined> = [];
	for (let index = 0; index < items.length; index++) {
		const item = items[index];
		result[index] = item === null ? undefined : item;
	}
	return result;
}

function assertResultMatchesId(row: Record<string, unknown>, expectedId: EntityId, idField: string, context: string) {
	const id = valueFor(row, idField);
	if (id === undefined || id === null) {
		throw new ActiveTsValidationError(`${context} is missing id field "${idField}".`);
	}
	assertSafeEntityId(id, `${context}.${idField}`);
	if (entityIdKey(id) !== entityIdKey(expectedId)) {
		throw new ActiveTsValidationError(`${context} id field "${idField}" must match the requested id.`);
	}
}

function assertReadValidatorPreservesId(meta: ResolvedModelMeta, before: Record<string, unknown>, after: Record<string, unknown>) {
	const beforeId = valueFor(before, meta.idField);
	const afterId = valueFor(after, meta.idField);
	if (beforeId === undefined || beforeId === null || afterId === undefined || afterId === null) {
		throw new ActiveTsValidationError(`${meta.name} read validator must preserve id field "${meta.idField}".`);
	}
	assertSafeEntityId(beforeId, `${meta.name}.${meta.idField}`);
	assertSafeEntityId(afterId, `${meta.name}.${meta.idField}`);
	if (entityIdKey(beforeId) !== entityIdKey(afterId)) {
		throw new ActiveTsValidationError(`${meta.name} read validator cannot change id field "${meta.idField}".`);
	}
}

function sanitizeCacheSetEntries(value: unknown, context: string, expectedKeys?: string[]) {
	if (!Array.isArray(value)) throw new ActiveTsValidationError(`${context} data must be cache entries.`);
	const items = snapshotArrayInput(value, `${context} data`);
	if (expectedKeys && items.length !== expectedKeys.length) {
		throw new ActiveTsValidationError(`${context} data must preserve cache entry count.`);
	}
	const result: Array<[string, any]> = [];
	for (let index = 0; index < items.length; index++) {
		const entry = items[index];
		if (!Array.isArray(entry) || entry.length !== 2) {
			throw new ActiveTsValidationError(`${context} data must contain [key, value] cache entries.`);
		}
		const tuple = snapshotArrayInput(entry, `${context} data[${index}]`);
		const key = assertSafeCacheKey(tuple[0], `${context} cache key`);
		if (expectedKeys && key !== expectedKeys[index]) {
			throw new ActiveTsValidationError(`${context} data cannot change cache entry keys.`);
		}
		assertCacheableValue(tuple[1]);
		result[index] = [key, cloneSafeData(tuple[1])];
	}
	return result;
}

function cloneCacheSetEntries(entries: Array<[string, any]>): Array<[string, any]> {
	const clone: Array<[string, any]> = [];
	for (let index = 0; index < entries.length; index++) {
		const [key, value] = entries[index];
		assertCacheableValue(value);
		clone[index] = [key, cloneSafeData(value)];
	}
	return clone;
}

function assertCacheSetEntryValues(
	entries: Array<[string, any]>,
	expectedIds: readonly EntityId[],
	idField: string,
	mode: 'positive' | 'negative',
	context: string
) {
	for (let index = 0; index < entries.length; index++) {
		const value = entries[index][1];
		if (mode === 'negative') {
			if (value !== null) {
				throw new ActiveTsValidationError(`${context} data[${index}] negative cache value must be null.`);
			}
			continue;
		}
		if (value === null || value === undefined) {
			throw new ActiveTsValidationError(`${context} data[${index}] positive cache value must be a row object.`);
		}
		assertPlainDataObject(value, `${context} data[${index}] value`);
		assertResultMatchesId(value, expectedIds[index], idField, `${context} data[${index}] value`);
	}
}

async function runDeferredTasks(
	kind: 'afterCommit' | 'afterRollback',
	tasks: DeferredTask[],
	options: { throwOnError: boolean }
) {
	const errors: unknown[] = [];
	for (const task of tasks) {
		try {
			await task();
		} catch (error) {
			errors.push(error);
			warnDeferredTaskFailure(kind, error);
		}
	}
	if (options.throwOnError && errors.length) {
		throw new AggregateError(errors, `active-ts ${kind} task failed after transaction commit.`);
	}
	return errors;
}

function warnDeferredTaskFailure(kind: 'afterCommit' | 'afterRollback', error: unknown) {
	try {
		console.warn(
			`active-ts ${kind} task failed after transaction ${kind === 'afterCommit' ? 'commit' : 'rollback'}: ${
				safeErrorMessage(error)
			}`
		);
	} catch {
		// Logging hooks must not alter transaction side-effect ordering or error reporting.
	}
}

async function runAfterCommitTasks(state: TransactionState) {
	const errors = [
		...await runDeferredTasks('afterCommit', state.internalAfterCommit, { throwOnError: false }),
		...await runDeferredTasks('afterCommit', state.afterCommit, { throwOnError: false })
	];
	if (errors.length) {
		throw new AggregateError(errors, 'active-ts afterCommit task failed after transaction commit.');
	}
}

function attachRollbackTaskErrors(primaryError: unknown, rollbackErrors: unknown[]) {
	if (!rollbackErrors.length) return;
	if (!primaryError || (typeof primaryError !== 'object' && typeof primaryError !== 'function')) {
		return;
	}
	try {
		const combined: unknown[] = [];
		const previous = Object.getOwnPropertyDescriptor(primaryError, 'afterRollbackError');
		if (previous && 'value' in previous && previous.value !== undefined) {
			const previousErrors = previous.value instanceof AggregateError
				? Object.getOwnPropertyDescriptor(previous.value, 'errors')
				: undefined;
			if (previousErrors && 'value' in previousErrors && Array.isArray(previousErrors.value)) {
				const snapshot = snapshotArrayInput<unknown>(previousErrors.value, 'afterRollback errors');
				for (let index = 0; index < snapshot.length; index++) combined.push(snapshot[index]);
			} else {
				combined.push(previous.value);
			}
		}
		for (let index = 0; index < rollbackErrors.length; index++) combined.push(rollbackErrors[index]);
		const aggregate = new AggregateError(
			combined,
			'active-ts afterRollback task failed after transaction rollback.'
		);
		defineDataProperty(primaryError, 'afterRollbackError', aggregate, {
			enumerable: false,
			configurable: true
		});
	} catch {
		// Preserve the original rollback reason even when the thrown value is not extensible.
	}
}

function markRolledBackTransactionModelInstances(state: TransactionState) {
	const txContext = state.context;
	if (!txContext) return;
	SET_FOR_EACH.call(state.modelInstances, (value: object) => {
		try {
			if (!isAncestorBoundModelInstance(value, state, txContext)) return;
			defineDataProperty(value, 'context', txContext, { enumerable: true, configurable: true, writable: true });
			clearModelRelationState(value);
		} catch {
			// A rollback reason must remain authoritative even if stale marking cannot touch an unusual object.
		}
	});
}

function combineCommittedTransactionError<T>(
	error: ActiveTsCommittedTransactionError<T>,
	afterCommitError: unknown
) {
	return new ActiveTsCommittedTransactionError(
		`${error.message}; afterCommit tasks also failed: ${safeErrorMessage(afterCommitError)}`,
		new AggregateError([error, afterCommitError], 'active-ts committed transaction cleanup and afterCommit tasks failed.'),
		error.result
	);
}

function rebindTransactionModels(result: unknown, state: TransactionState, targetContext: ActiveContext) {
	const txContext = state.context;
	if (!txContext) return;
	const seen = new WeakSet<object>();
	const visit = (value: unknown) => {
		if (!value || (typeof value !== 'object' && typeof value !== 'function')) return;
		const object = value as object;
		if (WEAKSET_HAS.call(seen, object)) return;
		WEAKSET_ADD.call(seen, object);
		try {
			if (isTransactionBoundModelInstance(object, txContext)) {
				defineDataProperty(object, 'context', targetContext, { enumerable: true, configurable: true, writable: true });
				clearModelRelationState(object);
				return;
			}
			if (object instanceof ActiveContext) return;
			if (object instanceof Map) {
				MAP_FOR_EACH.call(object, (value: unknown, key: unknown) => {
					visit(key);
					visit(value);
				});
			}
			if (object instanceof Set) {
				SET_FOR_EACH.call(object, (value: unknown) => {
					visit(value);
				});
			}
			for (const key of Object.getOwnPropertyNames(object)) {
				const descriptor = Object.getOwnPropertyDescriptor(object, key);
				if (descriptor && 'value' in descriptor) visit(descriptor.value);
			}
			for (const key of Object.getOwnPropertySymbols(object)) {
				const descriptor = Object.getOwnPropertyDescriptor(object, key);
				if (descriptor && 'value' in descriptor) visit(descriptor.value);
			}
		} catch {
			// Rebinding returned models is best-effort and must not change committed transaction results.
		}
	};
	SET_FOR_EACH.call(state.modelInstances, (value: object) => visit(value));
	visit(result);
}

function isTransactionBoundModelInstance(value: object, txContext: ActiveContext) {
	const marker = Object.getOwnPropertyDescriptor(value, ACTIVE_TS_MODEL_INSTANCE);
	if (!marker || !('value' in marker) || marker.value !== true) return false;
	const context = Object.getOwnPropertyDescriptor(value, 'context');
	return !!context && 'value' in context && context.value === txContext;
}

function isAncestorBoundModelInstance(value: object, state: TransactionState, txContext: ActiveContext) {
	const marker = Object.getOwnPropertyDescriptor(value, ACTIVE_TS_MODEL_INSTANCE);
	if (!marker || !('value' in marker) || marker.value !== true) return false;
	const context = Object.getOwnPropertyDescriptor(value, 'context');
	if (!context || !('value' in context) || context.value === txContext) return false;
	if (context.value === state.root) return true;
	let ancestor = state.parent;
	while (ancestor) {
		if (context.value === ancestor.context) return true;
		ancestor = ancestor.parent;
	}
	return false;
}

function clearModelRelationState(value: object) {
	const relationCache = Object.getOwnPropertyDescriptor(value, 'relationCache');
	if (relationCache && 'value' in relationCache && relationCache.value instanceof Map) {
		MAP_CLEAR.call(relationCache.value);
	}
	const plannedRelations = Object.getOwnPropertyDescriptor(value, 'plannedRelations');
	if (plannedRelations && 'value' in plannedRelations && plannedRelations.value instanceof Set) {
		SET_CLEAR.call(plannedRelations.value);
	}
}

let defaultContext: ActiveContext | undefined;

export function createActiveTs(config: ActiveTsConfig) {
	return new ActiveContext(config);
}

export async function createActiveTsAsync(config: ActiveTsConfig) {
	return await new ActiveContext(config).ready();
}

export function setDefaultContext(context: ActiveContext) {
	if (!(context instanceof ActiveContext)) {
		throw new ActiveTsConfigurationError('Default active-ts context must be an ActiveContext.');
	}
	defaultContext = context;
}

export function getCurrentDefaultContext() {
	return defaultContext;
}

export function clearDefaultContext() {
	defaultContext = undefined;
}

export function getDefaultContext() {
	const transactionContext = transactionContextStorage.getStore();
	if (transactionContext) return transactionContext;
	if (!defaultContext)
		throw new ActiveTsConfigurationError('No default active-ts context is configured.');
	return defaultContext;
}
