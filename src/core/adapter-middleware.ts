import type {
	AggregatePlan,
	AggregateResult,
	CacheAdapter,
	CacheWriteOptions,
	EntityId,
	Operator,
	QueryPlan,
	QueryResult,
	ResolvedModelMeta,
	SearchAdapter,
	SearchCapabilities,
	SearchOptions,
	StoreCapabilities,
	StoreAdapter,
	StoreReadOptions,
	StoreWriteOptions
} from './types.js';
import { ActiveTsConfigurationError, ActiveTsValidationError } from './errors.js';
import { normalizeAggregateRow } from './aggregate.js';
import { searchCapability, storeCapability } from './capabilities.js';
import {
	assertStoreDataHasModelId,
	assertStoreDataMatchesId,
	assertStorePlanSupported,
	createCloseGuardedStoreAdapter,
	datastorePayloadCanResolveAncestor,
	datastoreWritePayloadMatchesScopedAncestor,
	inheritAdapterTransactionOperationCarrier,
	inheritStoreTransactionOperationTracker,
	normalizeStoreAggregatePlan,
	normalizeStoreQueryResultForModel,
	normalizeStoreQueryPlan,
	normalizeStoreReadOptions,
	normalizeStoreTransactionOptions,
	normalizeStoreWriteOptions,
	markStoreTrustsDatastoreEntityKeyRows,
	storeTrustsDatastoreEntityKeyRows,
	trackAdapterTransactionOperation,
	trackStoreTransactionOperation,
	validateStoreQueryReadOptions
} from './store-options.js';
import { normalizeStoreSchemaApplyOptions } from './schema-options.js';
import { normalizeSchemaModels, normalizeSchemaPlan } from './schema-utils.js';
import {
	assertSafeSearchQuery,
	assertSearchOptionsSupported,
	contextBoundSearchDatastoreNamespace,
	datastoreSearchHitDocumentIdentityOrForced,
	markNativeSearchAdapter,
	markSearchDocumentIdentity,
	markSearchAdapterSource,
	nativeSearchSourceStore,
	normalizeSearchAdapterOptions,
	projectSearchDocument,
	rebindNativeSearchAdapter,
	searchDocumentIdentity,
	searchHitDocumentIdentity,
	searchIndexAdapterKind,
	withDatastoreSearchNamespace
} from './search-utils.js';
import { snapshotAdapterModel, snapshotSearchAdapterModel } from './adapter-model.js';
import {
	copyFieldCodecQueryOperandMarker,
	FIELD_CODEC_QUERY_OPERANDS_ENCODED,
	hasFieldCodecQueryOperandsEncoded
} from './field-codecs.js';
import {
	assertDenseArrayItems,
	assertCacheableValue,
	assertPlainDataObject,
	assertSafeCacheKey,
	assertSafeCursor,
	assertSafeEntityId,
	assertSafeEntityIdArray,
	assertSafeResultCount,
	assertSafeSchemaIdentifier,
	assertSafeTtl,
	ACTIVE_TS_ENTITY_KEY,
	clonePortableData,
	cloneSafeData,
	cloneSafeDataObjectWithoutActiveEntityKey
} from './safe-keys.js';
import { snapshotArrayInput } from './array-input.js';
import { cloneDate } from './date-intrinsics.js';
import { markCacheAdapterSource } from './cache-utils.js';
import { markStoreAdapterSource } from './store-utils.js';
import { entityIdKey } from './query-utils.js';
import { SET_ADD, SET_HAS, WEAKMAP_GET, WEAKMAP_HAS, WEAKMAP_SET, WEAKSET_ADD, WEAKSET_HAS } from './collection-intrinsics.js';
import { datastoreScopedAncestorMatches, normalizeDatastoreKey } from './datastore-key.js';
import {
	isContextBoundSearchAdapter,
	isContextBoundStoreAdapter
} from './context.js';

export type StoreOperation =
	| 'get'
	| 'getMany'
	| 'query'
	| 'aggregate'
	| 'create'
	| 'update'
	| 'delete';

export type StoreMiddlewareContext = {
	operation: StoreOperation;
	model: ResolvedModelMeta;
	args: unknown[];
};

export type StoreMiddleware = (
	context: StoreMiddlewareContext,
	next: () => Promise<any>
) => Promise<any>;

export type CacheMiddlewareContext = {
	operation: 'getMany' | 'setMany' | 'deleteMany';
	keys: string[];
	args: unknown[];
};

export type CacheMiddleware = (
	context: CacheMiddlewareContext,
	next: () => Promise<any>
) => Promise<any>;

export type SearchMiddlewareContext = {
	operation: 'search' | 'index' | 'delete';
	model: ResolvedModelMeta;
	args: unknown[];
};

export type SearchMiddleware = (
	context: SearchMiddlewareContext,
	next: () => Promise<any>
) => Promise<any>;

const SUPPORTED_OPERATORS = stringSet([
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

export function createStoreMiddlewareAdapter(
	adapter: StoreAdapter,
	middleware: StoreMiddleware[],
	kind?: string
): StoreAdapter {
	return createStoreMiddlewareAdapterWithSource(adapter, middleware, kind);
}

function createStoreMiddlewareAdapterWithSource(
	adapter: StoreAdapter,
	middleware: StoreMiddleware[],
	kind?: string,
	sourceAdapter?: StoreAdapter
): StoreAdapter {
	const wrapped = normalizeStoreAdapter(adapter, 'store middleware adapter');
	const adapterKind = normalizeAdapterKind(kind ?? `${wrapped.kind}+middleware`, 'store middleware adapter kind');
	const layers = normalizeMiddleware(middleware, 'store middleware');
	const cacheScope = wrapped.cacheScope ?? sourceAdapter?.cacheScope;
	const datastoreNamespace = wrapped.datastoreNamespace ?? sourceAdapter?.datastoreNamespace;
	const datastoreProjectId = wrapped.datastoreProjectId ?? sourceAdapter?.datastoreProjectId;
	const datastoreDatabaseId = wrapped.datastoreDatabaseId === undefined
		? sourceAdapter?.datastoreDatabaseId
		: wrapped.datastoreDatabaseId;
	const datastoreKeyEncoding = wrapped.datastoreKeyEncoding ?? sourceAdapter?.datastoreKeyEncoding;
	const trustsDatastoreEntityKeyRows =
		storeTrustsDatastoreEntityKeyRows(adapter) ||
		(sourceAdapter ? storeTrustsDatastoreEntityKeyRows(sourceAdapter) : false);
	const run = (context: StoreMiddlewareContext, leaf: () => Promise<any>) =>
		runMiddlewareLayers(layers, context, leaf);
	const runWrite = (context: StoreMiddlewareContext, leaf: () => Promise<any>) =>
		runRequiredStoreWriteMiddleware(layers, context, leaf, adapterKind);
	const track = <T>(operation: () => Promise<T>) => trackStoreTransactionOperation(adapter, operation);
	const middlewareAdapter: StoreAdapter = {
		kind: adapterKind,
		cacheScope,
		datastoreNamespace,
		datastoreProjectId,
		datastoreDatabaseId,
		datastoreKeyEncoding,
		capabilities: wrapped.capabilities,
		schema: wrapStoreMiddlewareSchema(wrapped.schema, adapterKind, track),
		get: (model: ResolvedModelMeta, id: EntityId, options?: StoreReadOptions) => track(async () => {
			model = snapshotAdapterModel(model, 'store middleware model metadata');
			const safeId = normalizeMiddlewareEntityId(id, 'store middleware get id');
			const readOptions = normalizeStoreReadOptions(options, 'store middleware get options');
			assertMiddlewareStoreReadOptionsSupported(adapterKind, wrapped.capabilities, readOptions, 'store middleware get options');
			assertMiddlewareDatastoreDirectReadAllowed(model, readOptions, `store middleware adapter "${adapterKind}" get`);
			const trust = middlewareReadTrust(trustsDatastoreEntityKeyRows, layers.length > 0);
			const row = normalizeMiddlewareRow(
				await runStoreReadMiddleware(
					run,
					{ operation: 'get', model, args: snapshotMiddlewareArgs([safeId, readOptions]) },
					trust.sourceRows,
					() => wrapped.get(model, safeId, readOptions)
				),
				`store middleware adapter "${adapterKind}" get result`,
				trust.sourceRows,
				trust.trustedRows
			);
			validateMiddlewareStoreReadRow(
				model,
				row,
				readOptions,
				adapterKind,
				`store middleware adapter "${adapterKind}" get result`,
				datastoreNamespace,
				trust.trustedRows
			);
			if (row) assertStoreDataMatchesId(model, safeId, row, `store middleware adapter "${adapterKind}" get result`);
			return row;
		}),
		getMany: (model: ResolvedModelMeta, ids: EntityId[], options?: StoreReadOptions) => track(async () => {
			model = snapshotAdapterModel(model, 'store middleware model metadata');
			const safeIds = assertSafeEntityIdArray(ids, 'store middleware getMany ids');
			const readOptions = normalizeStoreReadOptions(options, 'store middleware getMany options');
			assertMiddlewareStoreReadOptionsSupported(adapterKind, wrapped.capabilities, readOptions, 'store middleware getMany options');
			assertMiddlewareDatastoreDirectReadAllowed(model, readOptions, `store middleware adapter "${adapterKind}" getMany`);
			const trust = middlewareReadTrust(trustsDatastoreEntityKeyRows, layers.length > 0);
			const rows = normalizeMiddlewareReadResult(
				await runStoreReadMiddleware(
					run,
					{ operation: 'getMany', model, args: snapshotMiddlewareArgs([safeIds, readOptions]) },
					trust.sourceRows,
					() => wrapped.getMany(model, safeIds, readOptions)
				),
				safeIds.length,
				`store middleware adapter "${adapterKind}" getMany result`,
				trust.sourceRows,
				trust.trustedRows
			);
			for (let index = 0; index < rows.length; index++) {
				const row = rows[index];
				validateMiddlewareStoreReadRow(
					model,
					row,
					readOptions,
					adapterKind,
					`store middleware adapter "${adapterKind}" getMany result[${index}]`,
					datastoreNamespace,
					trust.trustedRows
				);
				if (row) assertStoreDataMatchesId(model, safeIds[index], row, `store middleware adapter "${adapterKind}" getMany result[${index}]`);
			}
			return rows;
		}),
		query: (model: ResolvedModelMeta, plan: QueryPlan, options?: StoreReadOptions) => track(async () => {
			model = snapshotAdapterModel(model, 'store middleware model metadata');
			const queryPlan = normalizeStoreQueryPlan(plan, model.idField, 'store middleware query plan');
			assertStorePlanSupported(adapterKind, wrapped.capabilities, queryPlan);
			const readOptions = validateStoreQueryReadOptions(options, queryPlan, 'store middleware query options');
			const trust = middlewareReadTrust(trustsDatastoreEntityKeyRows, layers.length > 0);
			return normalizeMiddlewareQueryResult(
				model,
				await runStoreReadMiddleware(
					run,
					{ operation: 'query', model, args: snapshotMiddlewareArgs([queryPlan, readOptions]) },
					trust.sourceRows,
					() => wrapped.query(model, queryPlan, readOptions)
				),
				`store middleware adapter "${adapterKind}" query`,
				{
					cursor: storeCapability(wrapped.capabilities, 'cursor'),
					adapterKind,
					adapterType: 'Store',
					datastoreAncestor: queryPlan.meta?.datastoreAncestor,
					datastoreNamespace,
					trustedDatastoreEntityKeys: trust.trustedRows,
					trustedDatastoreEntityKeySourceRows: trust.sourceRows
				}
			);
		}),
		aggregate: wrapped.aggregate
			? (model: ResolvedModelMeta, plan: AggregatePlan) => track(async () => {
					model = snapshotAdapterModel(model, 'store middleware model metadata');
					const aggregatePlan = normalizeStoreAggregatePlan(plan, 'store middleware aggregate plan');
					assertStorePlanSupported(adapterKind, wrapped.capabilities, aggregatePlan);
					return normalizeMiddlewareAggregateResult(
						await run({ operation: 'aggregate', model, args: snapshotMiddlewareArgs([aggregatePlan]) }, () =>
							wrapped.aggregate!(model, aggregatePlan)
						),
						aggregatePlan.aggregates,
						`store middleware adapter "${adapterKind}" aggregate`
					) as AggregateResult;
				})
			: undefined,
		create: (model: ResolvedModelMeta, id: EntityId, data: any, options?: StoreWriteOptions) => track(async () => {
			model = snapshotAdapterModel(model, 'store middleware model metadata');
			const safeId = normalizeMiddlewareEntityId(id, 'store middleware create id');
			const safeData = normalizeMiddlewareStoreWriteData(data, 'store middleware create data');
			assertStoreDataMatchesId(model, safeId, safeData, 'store middleware create data');
			const writeOptions = normalizeStoreWriteOptions(options, 'store middleware create options');
			assertMiddlewareDatastoreWriteScope(model, safeId, safeData, writeOptions, 'store middleware create options');
			await runWrite({ operation: 'create', model, args: snapshotMiddlewareArgs([safeId, safeData, writeOptions]) }, () =>
				wrapped.create(model, safeId, safeData, writeOptions)
			);
		}),
		update: (model: ResolvedModelMeta, id: EntityId, data: any, options?: StoreWriteOptions) => track(async () => {
			model = snapshotAdapterModel(model, 'store middleware model metadata');
			const safeId = normalizeMiddlewareEntityId(id, 'store middleware update id');
			const safeData = normalizeMiddlewareStoreWriteData(data, 'store middleware update data');
			assertStoreDataMatchesId(model, safeId, safeData, 'store middleware update data');
			const writeOptions = normalizeStoreWriteOptions(options, 'store middleware update options');
			assertMiddlewareDatastoreWriteScope(model, safeId, safeData, writeOptions, 'store middleware update options');
			await runWrite({ operation: 'update', model, args: snapshotMiddlewareArgs([safeId, safeData, writeOptions]) }, () =>
				wrapped.update(model, safeId, safeData, writeOptions)
			);
		}),
		delete: (model: ResolvedModelMeta, id: EntityId, options?: StoreWriteOptions) => track(async () => {
			model = snapshotAdapterModel(model, 'store middleware model metadata');
			const safeId = normalizeMiddlewareEntityId(id, 'store middleware delete id');
			const writeOptions = normalizeStoreWriteOptions(options, 'store middleware delete options');
			assertMiddlewareDatastoreDirectWriteAllowed(model, writeOptions, `store middleware adapter "${adapterKind}" delete`);
			await runWrite({ operation: 'delete', model, args: snapshotMiddlewareArgs([safeId, writeOptions]) }, () =>
				wrapped.delete(model, safeId, writeOptions)
			);
		}),
		transaction: undefined,
		savepoint: undefined
	};
	const readTransaction = storeTransactionReader(wrapped);
	if (readTransaction) {
		const transaction = createStoreMiddlewareTransaction(readTransaction, layers, adapterKind, middlewareAdapter);
		defineStoreTransactionReader(middlewareAdapter, () => readTransaction() ? transaction : undefined);
	} else if (wrapped.transaction) {
		middlewareAdapter.transaction = createStoreMiddlewareTransaction(
			() => wrapped.transaction,
			layers,
			adapterKind,
			middlewareAdapter
		);
	}
	const readSavepoint = storeSavepointReader(wrapped);
	if (readSavepoint) {
		const savepoint = createStoreMiddlewareSavepoint(readSavepoint, layers, adapterKind, middlewareAdapter);
		defineStoreSavepointReader(middlewareAdapter, () => readSavepoint() ? savepoint : undefined);
	} else if (wrapped.savepoint) {
		middlewareAdapter.savepoint = createStoreMiddlewareSavepoint(
			() => wrapped.savepoint,
			layers,
			adapterKind,
			middlewareAdapter
		);
	}
	const readCapabilities = storeCapabilityReader(wrapped);
	if (readCapabilities) defineStoreCapabilityReader(middlewareAdapter, readCapabilities);
	markStoreAdapterSource(middlewareAdapter, adapter);
	inheritStoreTransactionOperationTracker(middlewareAdapter, adapter);
	return trustsDatastoreEntityKeyRows
		? markStoreTrustsDatastoreEntityKeyRows(middlewareAdapter)
		: middlewareAdapter;
}

function createStoreMiddlewareSavepoint(
	readSavepoint: () => StoreAdapter['savepoint'],
	layers: StoreMiddleware[],
	adapterKind: string,
	sourceAdapter: StoreAdapter
): NonNullable<StoreAdapter['savepoint']> {
	return (fn) => trackStoreTransactionOperation(sourceAdapter, async () => {
		assertTransactionCallback(fn, 'store middleware savepoint callback');
		const savepoint = readSavepoint();
		if (!savepoint) {
			throw new ActiveTsConfigurationError(
				`Store adapter "${adapterKind}" does not expose savepoints in this context.`
			);
		}
		return await savepoint((tx) =>
			fn(createStoreMiddlewareAdapterWithSource(tx, layers, adapterKind, sourceAdapter))
		);
	});
}

function createStoreMiddlewareTransaction(
	readTransaction: () => StoreAdapter['transaction'],
	layers: StoreMiddleware[],
	adapterKind: string,
	sourceAdapter: StoreAdapter
): NonNullable<StoreAdapter['transaction']> {
	return (fn, options) => trackAdapterTransactionOperation(sourceAdapter, async () => {
		assertTransactionCallback(fn, 'store middleware transaction callback');
		const transaction = readTransaction();
		if (!transaction) {
			throw new ActiveTsConfigurationError(
				`Store adapter "${adapterKind}" does not expose transactions in this context.`
			);
		}
		const transactionOptions = normalizeStoreTransactionOptions(options, 'store middleware transaction options');
		return await transaction(
			async (tx) => {
				let closed: string | undefined;
				const middlewareTx = createStoreMiddlewareAdapterWithSource(tx, layers, adapterKind, sourceAdapter);
				const guardedTx = createCloseGuardedStoreAdapter(
					middlewareTx,
					() => closed,
					`store middleware adapter "${adapterKind}"`
				);
				markStoreAdapterSource(guardedTx.adapter, middlewareTx);
				try {
					const result = await fn(guardedTx.adapter);
					closed = 'callback finished';
					await guardedTx.waitForPendingOperations();
					return result;
				} catch (error) {
					closed = 'rollback';
					try {
						await guardedTx.waitForPendingOperations();
					} catch {
						// Preserve the callback or operation error that triggered rollback.
					}
					throw error;
				}
			},
			transactionOptions
		);
	});
}

export function createCacheMiddlewareAdapter(
	adapter: CacheAdapter,
	middleware: CacheMiddleware[],
	kind?: string
): CacheAdapter {
	const wrapped = normalizeCacheAdapter(adapter, 'cache middleware adapter');
	const adapterKind = normalizeAdapterKind(kind ?? `${wrapped.kind}+middleware`, 'cache middleware adapter kind');
	const layers = normalizeMiddleware(middleware, 'cache middleware');
	const run = (context: CacheMiddlewareContext, leaf: () => Promise<any>) =>
		runMiddlewareLayers(layers, context, leaf);
	const runMutation = (context: CacheMiddlewareContext, leaf: () => Promise<any>) =>
		runRequiredCacheMutationMiddleware(layers, context, leaf, adapterKind);
	const track = <T>(operation: () => Promise<T>) => trackAdapterTransactionOperation(adapter, operation);
	const middlewareAdapter: CacheAdapter = {
		kind: adapterKind,
		codecKey: wrapped.codecKey,
		getMany: (keys: string[]) => track(async () => {
			const safeKeys = normalizeCacheMiddlewareKeys(keys, 'cache middleware getMany keys');
			return normalizeCacheMiddlewareGetManyResult(
				await run({ operation: 'getMany', keys: safeKeys, args: snapshotMiddlewareArgs([safeKeys]) }, () => wrapped.getMany(safeKeys)),
				safeKeys.length,
				`cache middleware adapter "${adapterKind}" getMany`
			);
		}),
		setMany: (entries: Array<[string, any]>, options?: CacheWriteOptions) => track(async () => {
			const normalizedEntries = normalizeCacheMiddlewareEntries(entries, 'cache middleware setMany entries');
			const keys: string[] = [];
			for (let index = 0; index < normalizedEntries.length; index++) {
				keys[index] = normalizedEntries[index][0];
			}
			const writeOptions = normalizeCacheMiddlewareWriteOptions(options, 'cache middleware setMany options');
			if (!normalizedEntries.length) return;
			return await runMutation(
				{ operation: 'setMany', keys, args: snapshotMiddlewareArgs([normalizedEntries, writeOptions]) },
				() => wrapped.setMany(normalizedEntries, writeOptions)
			);
		}),
		deleteMany: (keys: string[]) => track(async () => {
			const safeKeys = normalizeCacheMiddlewareKeys(keys, 'cache middleware deleteMany keys');
			if (!safeKeys.length) return;
			return await runMutation({ operation: 'deleteMany', keys: safeKeys, args: snapshotMiddlewareArgs([safeKeys]) }, () => wrapped.deleteMany(safeKeys));
		})
	};
	markCacheAdapterSource(middlewareAdapter, adapter);
	return inheritAdapterTransactionOperationCarrier(middlewareAdapter, adapter);
}

export function createSearchMiddlewareAdapter(
	adapter: SearchAdapter,
	middleware: SearchMiddleware[],
	kind?: string
): SearchAdapter {
	const nativeSource = nativeSearchSourceStore(adapter);
	const wrapped = normalizeSearchAdapter(adapter, 'search middleware adapter');
	const adapterKind = normalizeAdapterKind(kind ?? `${wrapped.kind}+middleware`, 'search middleware adapter kind');
	const indexAdapterKind = searchIndexAdapterKind(wrapped, adapterKind);
	const layers = normalizeMiddleware(middleware, 'search middleware');
	const run = (context: SearchMiddlewareContext, leaf: () => Promise<any>) =>
		runMiddlewareLayers(layers, context, leaf);
	const track = <T>(operation: () => Promise<T>) => trackAdapterTransactionOperation(
		adapter,
		() => nativeSource ? trackStoreTransactionOperation(nativeSource, operation) : operation()
	);
	const middlewareAdapter: SearchAdapter = {
		kind: adapterKind,
		searchIndexKind: wrapped.searchIndexKind ?? safeSearchIndexKind(wrapped.kind),
		capabilities: wrapped.capabilities,
		schema: wrapSearchMiddlewareSchema(wrapped.schema, adapterKind, track),
		syncSchema: wrapSearchMiddlewareSyncSchema(wrapped.syncSchema, adapterKind, track),
		search: (model: ResolvedModelMeta, query: string, options: SearchOptions) => track(async () => {
			model = snapshotSearchAdapterModel(model, 'search middleware model metadata', indexAdapterKind);
			const safeQuery = assertSafeSearchQuery(query, 'search middleware query');
			const searchOptions = normalizeSearchAdapterOptions(options, 'search middleware options');
			assertSearchOptionsSupported({ kind: adapterKind, capabilities: wrapped.capabilities }, searchOptions);
			const resultModel = withDatastoreSearchNamespace(
				model,
				contextBoundSearchDatastoreNamespace(adapter, model)
			);
			return normalizeMiddlewareQueryResult(
				resultModel,
				await run({ operation: 'search', model: resultModel, args: snapshotMiddlewareArgs([safeQuery, searchOptions]) }, () =>
					wrapped.search(model, safeQuery, searchOptions)
				),
				`search middleware adapter "${adapterKind}" search`,
				{
					cursor: searchCapability(wrapped.capabilities, 'cursor'),
					adapterKind,
					adapterType: 'Search'
				}
			);
		}),
		index: (model: ResolvedModelMeta, id: EntityId, data: any) => track(async () => {
			model = snapshotSearchAdapterModel(model, 'search middleware model metadata', indexAdapterKind);
			const safeId = normalizeMiddlewareEntityId(id, 'search middleware index id');
			const safeData = normalizeMiddlewareWriteData(data, 'search middleware index data');
			const indexModel = withDatastoreSearchNamespace(
				model,
				contextBoundSearchDatastoreNamespace(adapter, model)
			);
			projectSearchDocument(indexModel, indexAdapterKind, safeId, safeData, {
				trustDatastoreEntityKey: false
			});
			const adapterData = cloneSafeDataObjectWithoutActiveEntityKey(safeData, 'search middleware index data');
			assertSearchIndexSupported(adapterKind, wrapped.capabilities);
			await run({ operation: 'index', model: indexModel, args: snapshotMiddlewareArgs([safeId, adapterData]) }, () => wrapped.index(model, safeId, adapterData));
		}),
		delete: (model: ResolvedModelMeta, id: EntityId) => track(async () => {
			model = snapshotSearchAdapterModel(model, 'search middleware model metadata', indexAdapterKind);
			const safeId = normalizeMiddlewareEntityId(id, 'search middleware delete id');
			assertSearchIndexSupported(adapterKind, wrapped.capabilities);
			searchDocumentIdentity(model, safeId, 'search middleware delete id');
			await run({ operation: 'delete', model, args: snapshotMiddlewareArgs([safeId]) }, () => wrapped.delete(model, safeId));
		})
	};
	const readCapabilities = searchCapabilityReader(wrapped);
	if (readCapabilities) defineSearchCapabilityReader(middlewareAdapter, readCapabilities);
	markSearchAdapterSource(middlewareAdapter, adapter);
	inheritAdapterTransactionOperationCarrier(middlewareAdapter, adapter);
	if (nativeSource) inheritAdapterTransactionOperationCarrier(middlewareAdapter, nativeSource);
	if (!nativeSource) return middlewareAdapter;
	return markNativeSearchAdapter(middlewareAdapter, nativeSource, (store) => {
		const rebound = rebindNativeSearchAdapter(adapter, store);
		if (!rebound) {
			throw new ActiveTsConfigurationError(`Search adapter "${wrapped.kind}" cannot be rebound for transaction-scoped native search.`);
		}
		return createSearchMiddlewareAdapter(rebound, layers, adapterKind);
	});
}

function wrapStoreMiddlewareSchema(
	schema: StoreAdapter['schema'],
	adapterKind: string,
	track: <T>(operation: () => Promise<T>) => Promise<T>
): StoreAdapter['schema'] {
	if (!schema) return undefined;
	return {
		plan: (models) => track(async () => {
			const safeModels = normalizeSchemaModels(models, 'store middleware schema models');
			return normalizeSchemaPlan(
				await schema.plan(safeModels),
				`store middleware adapter "${adapterKind}" schema plan`
			);
		}),
		apply: (models, options) => track(async () => {
			const safeModels = normalizeSchemaModels(models, 'store middleware schema models');
			const safeOptions = normalizeStoreSchemaApplyOptions(options, 'store middleware schema apply options');
			return normalizeSchemaPlan(
				await schema.apply(safeModels, safeOptions),
				`store middleware adapter "${adapterKind}" schema apply plan`
			);
		})
	};
}

function wrapSearchMiddlewareSchema(
	schema: SearchAdapter['schema'],
	adapterKind: string,
	track: <T>(operation: () => Promise<T>) => Promise<T>
): SearchAdapter['schema'] {
	if (!schema) return undefined;
	return {
		plan: (models) => track(async () => {
			const safeModels = normalizeSchemaModels(models, 'search middleware schema models');
			return normalizeSchemaPlan(
				await schema.plan(safeModels),
				`search middleware adapter "${adapterKind}" schema plan`
			);
		}),
		apply: (models, options) => track(async () => {
			const safeModels = normalizeSchemaModels(models, 'search middleware schema models');
			const safeOptions = normalizeStoreSchemaApplyOptions(options, 'search middleware schema apply options');
			return normalizeSchemaPlan(
				await schema.apply(safeModels, safeOptions),
				`search middleware adapter "${adapterKind}" schema apply plan`
			);
		})
	};
}

function wrapSearchMiddlewareSyncSchema(
	syncSchema: SearchAdapter['syncSchema'],
	adapterKind: string,
	track: <T>(operation: () => Promise<T>) => Promise<T>
): SearchAdapter['syncSchema'] {
	if (!syncSchema) return undefined;
	return (models) => track(async () => {
		const safeModels = normalizeSchemaModels(models, 'search middleware syncSchema models');
		return normalizeSchemaPlan(
			await syncSchema(safeModels),
			`search middleware adapter "${adapterKind}" schema plan`
		);
	});
}

function assertSearchIndexSupported(kind: string, capabilities: SearchCapabilities | undefined) {
	if (!searchCapability(capabilities, 'index')) {
		throw new ActiveTsConfigurationError(`Search adapter "${kind}" does not support indexing.`);
	}
}

function normalizeAdapterKind(kind: unknown, context: string) {
	if (typeof kind !== 'string' || !kind || kind.includes('\0')) {
		throw new ActiveTsConfigurationError(`${context} must be a non-empty string without null bytes.`);
	}
	return kind;
}

function normalizeStoreAdapter(adapter: unknown, context: string): StoreAdapter {
	const kind = normalizeAdapterObject(adapter, context);
	const record = adapter as StoreAdapter;
	const allowContextAccessors = isContextBoundStoreAdapter(adapter);
	const aggregate = optionalAdapterFunction(record, 'aggregate', context);
	const readSavepoint = () => optionalAdapterFunction(record, 'savepoint', context, {
		requireEnumerableOwn: true,
		allowOwnAccessor: allowContextAccessors
	});
	const savepoint = readSavepoint();
	const readTransaction = () => optionalAdapterFunction(record, 'transaction', context, {
		requireEnumerableOwn: true,
		allowOwnAccessor: allowContextAccessors
	});
	const transaction = readTransaction();
	const schema = normalizeOptionalStoreSchema(record, context);
	const cacheScope = adapterMember(record, 'cacheScope', context, { requireEnumerableOwn: false });
	if (cacheScope !== undefined && (typeof cacheScope !== 'string' || !cacheScope || cacheScope.includes('\0'))) {
		throw new ActiveTsConfigurationError(`${context}.cacheScope must be a non-empty string without null bytes.`);
	}
	const datastoreNamespace = normalizeOptionalStoreDatastoreNamespace(
		adapterMember(record, 'datastoreNamespace', context, { requireEnumerableOwn: false }),
		`${context}.datastoreNamespace`
	);
	const datastoreProjectId = normalizeOptionalStoreDatastoreProjectId(
		adapterMember(record, 'datastoreProjectId', context, { requireEnumerableOwn: false }),
		`${context}.datastoreProjectId`
	);
	const datastoreDatabaseId = normalizeOptionalStoreDatastoreDatabaseId(
		adapterMember(record, 'datastoreDatabaseId', context, { requireEnumerableOwn: false }),
		`${context}.datastoreDatabaseId`
	);
	const datastoreKeyEncoding = normalizeOptionalStoreDatastoreKeyEncoding(
		adapterMember(record, 'datastoreKeyEncoding', context, { requireEnumerableOwn: false }),
		`${context}.datastoreKeyEncoding`
	);
	const readCapabilities = () =>
		normalizeStoreCapabilities(
			adapterMember(record, 'capabilities', context, {
				requireEnumerableOwn: true,
				allowOwnAccessor: allowContextAccessors
			}),
			`${context}.capabilities`
		);
	const capabilities = readCapabilities();
	assertStoreCapabilityMethods(kind, capabilities, aggregate, transaction, savepoint, context);
	const normalized = {
		kind,
		get: requiredAdapterFunction(record, 'get', context),
		getMany: requiredAdapterFunction(record, 'getMany', context),
		query: requiredAdapterFunction(record, 'query', context),
		create: requiredAdapterFunction(record, 'create', context),
		update: requiredAdapterFunction(record, 'update', context),
		delete: requiredAdapterFunction(record, 'delete', context),
		aggregate,
		transaction,
		savepoint,
		cacheScope: cacheScope as string | undefined,
		datastoreNamespace,
		datastoreProjectId,
		datastoreDatabaseId,
		datastoreKeyEncoding,
		capabilities,
		schema
	};
	if (allowContextAccessors) {
		defineStoreCapabilityReader(normalized, readCapabilities);
		defineStoreTransactionReader(normalized, readTransaction);
		defineStoreSavepointReader(normalized, readSavepoint);
	}
	return normalized;
}

function normalizeOptionalStoreDatastoreNamespace(value: unknown, context: string) {
	if (value === undefined) return undefined;
	if (typeof value !== 'string' || !value || value.includes('\0')) {
		throw new ActiveTsConfigurationError(`${context} must be a non-empty string without null bytes.`);
	}
	return value;
}

function normalizeOptionalStoreDatastoreProjectId(value: unknown, context: string) {
	if (value === undefined) return undefined;
	if (typeof value !== 'string' || !value || value.includes('\0')) {
		throw new ActiveTsConfigurationError(
			`${context} must be a non-empty string without null bytes, or undefined when unknown.`
		);
	}
	return value;
}

function normalizeOptionalStoreDatastoreDatabaseId(value: unknown, context: string) {
	if (value === undefined || value === null) return value;
	if (typeof value !== 'string' || !value || value.includes('\0')) {
		throw new ActiveTsConfigurationError(
			`${context} must be a non-empty string without null bytes, null for the default database, or undefined when unknown.`
		);
	}
	return value;
}

function normalizeOptionalStoreDatastoreKeyEncoding(
	value: unknown,
	context: string
): StoreAdapter['datastoreKeyEncoding'] {
	if (value === undefined || value === 'active-ts' || value === 'native') return value;
	throw new ActiveTsConfigurationError(`${context} must be "active-ts", "native", or undefined when unknown.`);
}

function assertStoreCapabilityMethods(
	kind: string,
	capabilities: StoreCapabilities,
	aggregate: StoreAdapter['aggregate'],
	transaction: StoreAdapter['transaction'],
	savepoint: StoreAdapter['savepoint'],
	context: string
) {
	if (capabilities.aggregate === true && typeof aggregate !== 'function') {
		throw new ActiveTsConfigurationError(
			`${context} "${kind}" advertises aggregate support but does not expose aggregate().`
		);
	}
	if (capabilities.transaction === true && typeof transaction !== 'function') {
		throw new ActiveTsConfigurationError(
			`${context} "${kind}" advertises transaction support but does not expose transaction().`
		);
	}
	if (capabilities.savepoint === true && typeof savepoint !== 'function') {
		throw new ActiveTsConfigurationError(
			`${context} "${kind}" advertises savepoint support but does not expose savepoint().`
		);
	}
}

function normalizeCacheAdapter(adapter: unknown, context: string): CacheAdapter {
	const kind = normalizeAdapterObject(adapter, context);
	const record = adapter as CacheAdapter;
	return {
		kind,
		getMany: requiredAdapterFunction(record, 'getMany', context),
		setMany: requiredAdapterFunction(record, 'setMany', context),
		deleteMany: requiredAdapterFunction(record, 'deleteMany', context),
		codecKey: optionalAdapterFunction(record, 'codecKey', context, { requireEnumerableOwn: false })
	};
}

function normalizeSearchAdapter(adapter: unknown, context: string): SearchAdapter {
	const kind = normalizeAdapterObject(adapter, context);
	const record = adapter as SearchAdapter;
	const allowContextAccessors = isContextBoundSearchAdapter(adapter);
	const syncSchema = optionalAdapterFunction(record, 'syncSchema', context, { requireEnumerableOwn: false });
	const readCapabilities = () =>
		normalizeSearchCapabilities(
			adapterMember(record, 'capabilities', context, {
				requireEnumerableOwn: true,
				allowOwnAccessor: allowContextAccessors
			}),
			`${context}.capabilities`
		);
	const normalized = {
		kind,
		searchIndexKind: optionalSearchIndexKind(record, 'searchIndexKind', context),
		search: requiredAdapterFunction(record, 'search', context),
		index: requiredAdapterFunction(record, 'index', context),
		delete: requiredAdapterFunction(record, 'delete', context),
		capabilities: readCapabilities(),
		schema: normalizeOptionalSearchSchema(record, context),
		syncSchema
	};
	if (allowContextAccessors) defineSearchCapabilityReader(normalized, readCapabilities);
	return normalized;
}

function optionalSearchIndexKind(adapter: object, property: string, context: string) {
	const value = adapterMember(adapter, property, context, { requireEnumerableOwn: true });
	if (value === undefined) return undefined;
	return assertSafeSchemaIdentifier(value, `${context}.${property}`);
}

function safeSearchIndexKind(kind: string) {
	try {
		return assertSafeSchemaIdentifier(kind, 'search adapter kind');
	} catch {
		return undefined;
	}
}

function normalizeOptionalStoreSchema(adapter: object, context: string): StoreAdapter['schema'] {
	const value = adapterMember(adapter, 'schema', context);
	if (value === undefined) return undefined;
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ActiveTsConfigurationError(`${context}.schema must be an object.`);
	}
	return {
		plan: requiredAdapterFunction(value, 'plan', `${context}.schema`),
		apply: requiredAdapterFunction(value, 'apply', `${context}.schema`)
	};
}

function normalizeOptionalSearchSchema(adapter: object, context: string): SearchAdapter['schema'] {
	const value = adapterMember(adapter, 'schema', context);
	if (value === undefined) return undefined;
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ActiveTsConfigurationError(`${context}.schema must be an object.`);
	}
	return {
		plan: requiredAdapterFunction(value, 'plan', `${context}.schema`),
		apply: requiredAdapterFunction(value, 'apply', `${context}.schema`)
	};
}

const STORE_CAPABILITY_KEYS = [
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
] as const;

const SEARCH_CAPABILITY_KEYS = [
	'where',
	'nestedFields',
	'numericComparisons',
	'nullOperators',
	'cursor',
	'native',
	'index'
] as const;
const STORE_CAPABILITY_READERS = new WeakMap<object, () => StoreCapabilities>();
const SEARCH_CAPABILITY_READERS = new WeakMap<object, () => SearchCapabilities>();
const STORE_TRANSACTION_READERS = new WeakMap<object, () => StoreAdapter['transaction']>();
const STORE_SAVEPOINT_READERS = new WeakMap<object, () => StoreAdapter['savepoint']>();
const CACHE_WRITE_OPTION_KEYS = ['ttl'] as const;
const MIDDLEWARE_QUERY_RESULT_KEYS = ['list', 'cursor', 'more', 'count', 'total'] as const;

type MiddlewareQueryResultOptions = {
	cursor?: boolean;
	adapterKind: string;
	adapterType: 'Search' | 'Store';
	datastoreAncestor?: unknown;
	datastoreNamespace?: string;
	trustedDatastoreEntityKeys?: boolean | WeakSet<object>;
	trustedDatastoreEntityKeySourceRows?: TrustedDatastoreEntityKeySourceRows;
};

type TrustedDatastoreEntityKeySourceRows = WeakMap<object, TrustedDatastoreEntityKeySourceRow>;

type TrustedDatastoreEntityKeySourceRow = {
	hasEntityKey: boolean;
	entityKey?: unknown;
};

function normalizeStoreCapabilities(value: unknown, context: string): StoreCapabilities {
	if (value === undefined) return Object.freeze({});
	const record = assertPlainCapabilityObject(value, context);
	assertKnownCapabilityKeys(record, STORE_CAPABILITY_KEYS, context);
	const normalized: StoreCapabilities = {};
	for (const key of STORE_CAPABILITY_KEYS) {
		const capability = ownCapabilityValue(record, key, context);
		if (capability === undefined) continue;
		if (typeof capability !== 'boolean') {
			throw new ActiveTsConfigurationError(`${context}.${key} must be a boolean.`);
		}
		normalized[key] = capability;
	}
	return Object.freeze(normalized);
}

function normalizeSearchCapabilities(value: unknown, context: string): SearchCapabilities {
	if (value === undefined) return Object.freeze({});
	const record = assertPlainCapabilityObject(value, context);
	assertKnownCapabilityKeys(record, [...SEARCH_CAPABILITY_KEYS, 'whereOperators'], context);
	const normalized: SearchCapabilities = {};
	for (const key of SEARCH_CAPABILITY_KEYS) {
		const capability = ownCapabilityValue(record, key, context);
		if (capability === undefined) continue;
		if (typeof capability !== 'boolean') {
			throw new ActiveTsConfigurationError(`${context}.${key} must be a boolean.`);
		}
		normalized[key] = capability;
	}
	const whereOperators = ownCapabilityValue(record, 'whereOperators', context);
	if (whereOperators !== undefined) {
		const operators = assertPlainCapabilityObject(whereOperators, `${context}.whereOperators`);
		const normalizedOperators: NonNullable<SearchCapabilities['whereOperators']> = {};
		for (const operator of Object.keys(operators)) {
			const enabled = ownCapabilityValue(operators, operator, `${context}.whereOperators`);
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
	const allowedKeys = stringSet(allowed);
	for (const property of Object.keys(record)) {
		if (!SET_HAS.call(allowedKeys, property)) {
			throw new ActiveTsConfigurationError(`${context} contains unknown capability "${property}".`);
		}
	}
}

function isSupportedOperatorName(value: string): value is Operator {
	return SET_HAS.call(SUPPORTED_OPERATORS, value);
}

function normalizeAdapterObject(adapter: unknown, context: string) {
	if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) {
		throw new ActiveTsConfigurationError(`${context} must be an adapter object.`);
	}
	return normalizeAdapterKind(
		adapterMember(adapter, 'kind', context, { requireEnumerableOwn: true }),
		`${context}.kind`
	);
}

function requiredAdapterFunction<T extends (...args: any[]) => any>(
	adapter: object,
	property: string,
	context: string
): T {
	const value = adapterMember(adapter, property, context, { requireEnumerableOwn: true });
	if (typeof value !== 'function') {
		throw new ActiveTsConfigurationError(`${context}.${property} must be a function.`);
	}
	return value.bind(adapter) as T;
}

function optionalAdapterFunction<T extends (...args: any[]) => any>(
	adapter: object,
	property: string,
	context: string,
	options: { requireEnumerableOwn?: boolean; allowOwnAccessor?: boolean } = { requireEnumerableOwn: true }
): T | undefined {
	const value = adapterMember(adapter, property, context, options);
	if (value === undefined) return undefined;
	if (typeof value !== 'function') {
		throw new ActiveTsConfigurationError(`${context}.${property} must be a function.`);
	}
	return value.bind(adapter) as T;
}

function adapterMember(
	adapter: object,
	property: string,
	context: string,
	options: { requireEnumerableOwn?: boolean; allowOwnAccessor?: boolean } = {}
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
					if (options.requireEnumerableOwn && !descriptor.enumerable) {
						throw new ActiveTsConfigurationError(`${context}.${property} must be enumerable.`);
					}
					return descriptor.get.call(adapter);
				}
				throw new ActiveTsConfigurationError(`${context}.${property} must be a data property.`);
			}
			if (options.requireEnumerableOwn && current === adapter && !descriptor.enumerable && descriptor.value !== undefined) {
				throw new ActiveTsConfigurationError(`${context}.${property} must be enumerable.`);
			}
			return descriptor.value;
		}
		current = Object.getPrototypeOf(current);
	}
	return undefined;
}

function defineStoreCapabilityReader<TAdapter extends StoreAdapter>(
	adapter: TAdapter,
	readCapabilities: () => StoreCapabilities
): TAdapter {
	defineCapabilityReader(adapter, readCapabilities);
	WEAKMAP_SET.call(STORE_CAPABILITY_READERS, adapter, readCapabilities);
	return adapter;
}

function defineStoreTransactionReader<TAdapter extends StoreAdapter>(
	adapter: TAdapter,
	readTransaction: () => StoreAdapter['transaction']
): TAdapter {
	const descriptor = Object.create(null) as PropertyDescriptor;
	descriptor.get = readTransaction;
	descriptor.enumerable = true;
	descriptor.configurable = true;
	Object.defineProperty(adapter, 'transaction', descriptor);
	WEAKMAP_SET.call(STORE_TRANSACTION_READERS, adapter, readTransaction);
	return adapter;
}

function defineStoreSavepointReader<TAdapter extends StoreAdapter>(
	adapter: TAdapter,
	readSavepoint: () => StoreAdapter['savepoint']
): TAdapter {
	const descriptor = Object.create(null) as PropertyDescriptor;
	descriptor.get = readSavepoint;
	descriptor.enumerable = true;
	descriptor.configurable = true;
	Object.defineProperty(adapter, 'savepoint', descriptor);
	WEAKMAP_SET.call(STORE_SAVEPOINT_READERS, adapter, readSavepoint);
	return adapter;
}

function defineSearchCapabilityReader<TAdapter extends SearchAdapter>(
	adapter: TAdapter,
	readCapabilities: () => SearchCapabilities
): TAdapter {
	defineCapabilityReader(adapter, readCapabilities);
	WEAKMAP_SET.call(SEARCH_CAPABILITY_READERS, adapter, readCapabilities);
	return adapter;
}

function defineCapabilityReader(adapter: object, readCapabilities: () => StoreCapabilities | SearchCapabilities) {
	const descriptor = Object.create(null) as PropertyDescriptor;
	descriptor.get = readCapabilities;
	descriptor.enumerable = true;
	descriptor.configurable = true;
	Object.defineProperty(adapter, 'capabilities', descriptor);
}

function storeCapabilityReader(adapter: StoreAdapter) {
	return WEAKMAP_GET.call(STORE_CAPABILITY_READERS, adapter) as (() => StoreCapabilities) | undefined;
}

function storeTransactionReader(adapter: StoreAdapter) {
	return WEAKMAP_GET.call(STORE_TRANSACTION_READERS, adapter) as (() => StoreAdapter['transaction']) | undefined;
}

function storeSavepointReader(adapter: StoreAdapter) {
	return WEAKMAP_GET.call(STORE_SAVEPOINT_READERS, adapter) as (() => StoreAdapter['savepoint']) | undefined;
}

function searchCapabilityReader(adapter: SearchAdapter) {
	return WEAKMAP_GET.call(SEARCH_CAPABILITY_READERS, adapter) as (() => SearchCapabilities) | undefined;
}

function normalizeMiddleware<T>(middleware: T[], context: string): T[] {
	if (!Array.isArray(middleware)) throw new ActiveTsConfigurationError(`${context} must be an array.`);
	const layers = snapshotArrayInput<T>(middleware, context);
	for (let index = 0; index < layers.length; index++) {
		const layer = layers[index];
		if (typeof layer !== 'function') {
			throw new ActiveTsConfigurationError(`${context}[${index}] must be a function.`);
		}
	}
	return Object.freeze(layers) as T[];
}

function runMiddlewareLayers<TContext>(
	layers: ReadonlyArray<(context: TContext, next: () => Promise<any>) => Promise<any>>,
	context: TContext,
	leaf: () => Promise<any>
) {
	let next = leaf;
	for (let index = layers.length - 1; index >= 0; index--) {
		const layer = layers[index];
		const previous = next;
		next = () => layer(context, previous);
	}
	return next();
}

function middlewareReadTrust(trustedDatastoreEntityKeyRows: boolean, hasMiddlewareLayers: boolean) {
	if (!trustedDatastoreEntityKeyRows) return { trustedRows: false as const, sourceRows: undefined };
	if (!hasMiddlewareLayers) return { trustedRows: true as const, sourceRows: undefined };
	const sourceRows: TrustedDatastoreEntityKeySourceRows = new WeakMap();
	return { trustedRows: new WeakSet<object>(), sourceRows };
}

async function runStoreReadMiddleware(
	run: (context: StoreMiddlewareContext, leaf: () => Promise<any>) => Promise<any>,
	context: StoreMiddlewareContext,
	trustedSourceRows: TrustedDatastoreEntityKeySourceRows | undefined,
	leaf: () => Promise<any>
) {
	return await run(context, async () => {
		const value = await leaf();
		collectTrustedSourceRows(context.operation, value, trustedSourceRows);
		return value;
	});
}

function collectTrustedSourceRows(
	operation: StoreOperation,
	value: unknown,
	trustedSourceRows: TrustedDatastoreEntityKeySourceRows | undefined
) {
	if (!trustedSourceRows) return;
	if (operation === 'get') {
		addTrustedSourceRow(value, trustedSourceRows);
		return;
	}
	if (operation === 'getMany') {
		collectTrustedSourceRowArray(value, trustedSourceRows);
		return;
	}
	if (operation !== 'query') return;
	if (!value || typeof value !== 'object' || Array.isArray(value)) return;
	const descriptor = Object.getOwnPropertyDescriptor(value, 'list');
	if (!descriptor || !('value' in descriptor)) return;
	collectTrustedSourceRowArray(descriptor.value, trustedSourceRows);
}

function collectTrustedSourceRowArray(value: unknown, trustedSourceRows: TrustedDatastoreEntityKeySourceRows) {
	if (!Array.isArray(value)) return;
	for (let index = 0; index < value.length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (descriptor && 'value' in descriptor) addTrustedSourceRow(descriptor.value, trustedSourceRows);
	}
}

function addTrustedSourceRow(value: unknown, trustedSourceRows: TrustedDatastoreEntityKeySourceRows) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return;
	WEAKMAP_SET.call(trustedSourceRows, value, snapshotTrustedDatastoreEntityKeySourceRow(value));
}

function snapshotTrustedDatastoreEntityKeySourceRow(value: object): TrustedDatastoreEntityKeySourceRow {
	const descriptor = Object.getOwnPropertyDescriptor(value, ACTIVE_TS_ENTITY_KEY);
	if (descriptor === undefined) return { hasEntityKey: false };
	if (!('value' in descriptor) || descriptor.enumerable) return { hasEntityKey: false };
	return { hasEntityKey: true, entityKey: descriptor.value };
}

async function runRequiredStoreWriteMiddleware(
	layers: ReadonlyArray<StoreMiddleware>,
	context: StoreMiddlewareContext,
	leaf: () => Promise<any>,
	adapterKind: string
) {
	let leafCalls = 0;
	let successfulLeafWrites = 0;
	const result = await runMiddlewareLayers(layers, context, async () => {
		if (leafCalls >= 1) {
			throw new ActiveTsConfigurationError(
				`Store middleware adapter "${adapterKind}" ${context.operation} middleware must call next() exactly once for write operations.`
			);
		}
		leafCalls++;
		const value = await leaf();
		successfulLeafWrites++;
		return value;
	});
	if (successfulLeafWrites < 1) {
		throw new ActiveTsConfigurationError(
			`Store middleware adapter "${adapterKind}" ${context.operation} middleware must call next() for write operations.`
		);
	}
	return result;
}

async function runRequiredCacheMutationMiddleware(
	layers: ReadonlyArray<CacheMiddleware>,
	context: CacheMiddlewareContext,
	leaf: () => Promise<any>,
	adapterKind: string
) {
	let leafCalls = 0;
	let successfulLeafMutations = 0;
	const result = await runMiddlewareLayers(layers, context, async () => {
		if (leafCalls >= 1) {
			throw new ActiveTsConfigurationError(
				`Cache middleware adapter "${adapterKind}" ${context.operation} middleware must call next() exactly once for cache mutations.`
			);
		}
		leafCalls++;
		const value = await leaf();
		successfulLeafMutations++;
		return value;
	});
	if (successfulLeafMutations < 1) {
		throw new ActiveTsConfigurationError(
			`Cache middleware adapter "${adapterKind}" ${context.operation} middleware must call next() for cache mutations.`
		);
	}
	return result;
}

function normalizeCacheMiddlewareKeys(keys: unknown, context: string) {
	const safeInput = snapshotArrayInput(keys, context);
	const safeKeys: string[] = [];
	for (let index = 0; index < safeInput.length; index++) {
		safeKeys[index] = assertSafeCacheKey(safeInput[index], `${context}[${index}]`);
	}
	return safeKeys;
}

function normalizeCacheMiddlewareGetManyResult(value: unknown, expected: number, context: string) {
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
		result[index] = structuredClone(item);
	}
	return result;
}

function normalizeCacheMiddlewareEntries(entries: unknown, context: string): Array<[string, any]> {
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
		assertCacheableValue(value);
		normalized[index] = [key, structuredClone(value)];
	}
	return normalized;
}

function normalizeCacheMiddlewareWriteOptions(options: unknown, context: string): CacheWriteOptions {
	if (options === undefined) return { ttl: undefined };
	if (!options || typeof options !== 'object' || Array.isArray(options)) {
		throw new ActiveTsValidationError(`${context} must be a plain object.`);
	}
	const prototype = Object.getPrototypeOf(options);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsValidationError(`${context} must be a plain object.`);
	}
	if (Object.getOwnPropertySymbols(options).length) {
		throw new ActiveTsValidationError(`${context} cannot contain symbol fields.`);
	}
	assertKnownInputKeys(options as Record<string, unknown>, CACHE_WRITE_OPTION_KEYS, context);
	const ttl = ownInputValue(options as Record<string, unknown>, 'ttl', context);
	return { ttl: assertSafeTtl(ttl, `${context}.ttl`) };
}

function normalizeMiddlewareQueryResult(
	model: ResolvedModelMeta,
	value: unknown,
	context: string,
	options: MiddlewareQueryResultOptions
): QueryResult {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ActiveTsValidationError(`${context} result must be a plain object.`);
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsValidationError(`${context} result must be a plain object.`);
	}
	const record = value as Record<string, unknown>;
	assertKnownInputKeys(record, MIDDLEWARE_QUERY_RESULT_KEYS, `${context} result`);
	const list = ownResultValue(record, 'list', context);
	if (!Array.isArray(list)) throw new ActiveTsValidationError(`${context} result.list must be an array.`);
	const safeInput = snapshotArrayInput(list, `${context} result.list`);
	const safeList: any[] = [];
	const ids = new Set<string>();
	for (let index = 0; index < safeInput.length; index++) {
		const item = safeInput[index];
		assertPlainDataObject(item, `${context} result.list[${index}]`);
		const searchIdentity = options.adapterType === 'Search'
			? datastoreSearchHitDocumentIdentityOrForced(model, item, `${context} result.list[${index}]`)
			: searchHitDocumentIdentity(item);
		const row = options.adapterType === 'Search'
			? cloneSafeDataObjectWithoutActiveEntityKey(item, `${context} result.list[${index}]`)
			: cloneSafeData(item);
		markTrustedMiddlewareRow(
			item,
			row,
			options.trustedDatastoreEntityKeySourceRows,
			options.trustedDatastoreEntityKeys,
			`${context} result.list[${index}]`
		);
		const id = assertStoreDataHasModelId(model, row, `${context} result.list[${index}]`);
		if (searchIdentity !== undefined) markSearchDocumentIdentity(row, searchIdentity);
		const key = middlewareResultIdentityKey(model, id, searchIdentity, row, `${context} result.list[${index}]`);
		if (SET_HAS.call(ids, key)) {
			throw new ActiveTsValidationError(`${context} result contains duplicate id "${String(id)}".`);
		}
		SET_ADD.call(ids, key);
		safeList[index] = row;
	}
	if (options.adapterType === 'Store') {
		validateMiddlewareStoreReadRows(model, safeList, options.adapterKind, context, {
			datastoreAncestor: options.datastoreAncestor,
			datastoreNamespace: options.datastoreNamespace,
			trustedDatastoreEntityKeys: options.trustedDatastoreEntityKeys
		});
	}
	const cursor = assertSafeCursor(ownResultValue(record, 'cursor', context), `${context} result cursor`);
	const more = ownResultValue(record, 'more', context);
	assertSafeResultCount(ownResultValue(record, 'count', context), `${context} result.count`);
	const total = assertSafeResultCount(ownResultValue(record, 'total', context), `${context} result.total`);
	if (more !== undefined && typeof more !== 'boolean') {
		throw new ActiveTsValidationError(`${context} result.more must be a boolean.`);
	}
	if (cursor !== undefined && options.cursor === false) {
		throw new ActiveTsConfigurationError(
			`${options.adapterType} adapter "${options.adapterKind}" does not support returning portable cursors.`
		);
	}
	if (total !== undefined && total < safeList.length) {
		throw new ActiveTsValidationError(`${context} result.total cannot be smaller than result.list length.`);
	}
	return { list: safeList, cursor, more, count: safeList.length, total };
}

function middlewareResultIdentityKey(
	model: ResolvedModelMeta,
	id: EntityId,
	searchIdentity: string | undefined,
	row: any,
	context: string
) {
	if (!model.datastore?.ancestor) return entityIdKey(id);
	if (searchIdentity !== undefined) {
		if (model.searchDocumentIdentity !== undefined && searchIdentity !== model.searchDocumentIdentity) {
			throw new ActiveTsValidationError(`${context} search document identity does not match forced Datastore search document identity.`);
		}
		if (
			datastorePayloadCanResolveAncestor(model, id, row, context) &&
			searchIdentity !== searchDocumentIdentity(
				{ ...model, searchDocumentIdentity: undefined },
				id,
				`${context} Datastore search document identity`,
				row
			)
		) {
			throw new ActiveTsValidationError(`${context} search document identity does not match its Datastore payload data.`);
		}
		return `search:${searchIdentity}`;
	}
	return `datastore:${searchDocumentIdentity(
		model,
		id,
		`${context} Datastore search document identity`,
		row,
		{ validatePayloadAncestor: false }
	)}`;
}

function assertMiddlewareStoreReadOptionsSupported(
	adapterKind: string,
	capabilities: StoreCapabilities | undefined,
	options: StoreReadOptions,
	context: string
) {
	if (
		options.meta !== undefined &&
		Object.prototype.hasOwnProperty.call(options.meta, 'datastoreAncestor') &&
		!storeCapability(capabilities, 'datastoreAncestor')
	) {
		throw new ActiveTsConfigurationError(`${context} does not support Datastore ancestor read metadata.`);
	}
	if (
		options.meta !== undefined &&
		Object.prototype.hasOwnProperty.call(options.meta, 'datastoreRead') &&
		!storeCapability(capabilities, 'datastoreReadPolicy')
	) {
		throw new ActiveTsConfigurationError(`${context} does not support Datastore read policies.`);
	}
}

function assertMiddlewareDatastoreDirectReadAllowed(model: ResolvedModelMeta, options: StoreReadOptions, context: string) {
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

function assertMiddlewareDatastoreDirectWriteAllowed(model: ResolvedModelMeta, options: StoreWriteOptions, context: string) {
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

function assertMiddlewareDatastoreWriteScope(
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

function validateMiddlewareStoreReadRow(
	model: ResolvedModelMeta,
	row: Record<string, any> | null,
	options: StoreReadOptions,
	adapterKind: string,
	context: string,
	datastoreNamespace: string | undefined,
	trustedDatastoreEntityKeys: boolean | WeakSet<object>
) {
	if (row === null) return;
	validateMiddlewareStoreReadRows(model, [row], adapterKind, context, {
		datastoreAncestor: options.meta?.datastoreAncestor,
		datastoreNamespace,
		trustedDatastoreEntityKeys
	});
}

function validateMiddlewareStoreReadRows(
	model: ResolvedModelMeta,
	rows: Array<Record<string, any>>,
	adapterKind: string,
	context: string,
	options: { datastoreAncestor?: unknown; datastoreNamespace?: string; trustedDatastoreEntityKeys?: boolean | WeakSet<object> }
) {
	normalizeStoreQueryResultForModel(model, { list: rows }, context, {
		adapterKind,
		datastoreAncestor: options.datastoreAncestor,
		datastoreNamespace: options.datastoreNamespace,
		trustedDatastoreEntityKeys: options.trustedDatastoreEntityKeys
	});
}

function normalizeMiddlewareAggregateResult(value: unknown, specs: AggregatePlan['aggregates'], context: string) {
	return normalizeAggregateRow(value, specs, context);
}

function ownCapabilityValue(record: Record<string, unknown>, key: string, context: string) {
	if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(record, key);
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsConfigurationError(`${context}.${key} must be a data property.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsConfigurationError(`${context}.${key} must be enumerable.`);
	}
	return descriptor.value;
}

function ownResultValue(record: Record<string, unknown>, key: string, context: string) {
	if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(record, key);
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsValidationError(`${context} result.${key} must be a data property.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsValidationError(`${context} result.${key} must be enumerable.`);
	}
	return descriptor.value;
}

function ownInputValue(record: Record<string, unknown>, key: string, context: string) {
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

function assertKnownInputKeys(record: Record<string, unknown>, allowed: readonly string[], context: string) {
	const allowedKeys = stringSet(allowed);
	for (const property of Object.getOwnPropertyNames(record)) {
		if (!SET_HAS.call(allowedKeys, property)) {
			throw new ActiveTsValidationError(`${context} contains unknown option "${property}".`);
		}
	}
}

function stringSet(values: readonly string[]) {
	const set = new Set<string>();
	for (const value of values) SET_ADD.call(set, value);
	return set;
}

function snapshotMiddlewareArgs(args: unknown[]) {
	const snapshots: unknown[] = [];
	for (let index = 0; index < args.length; index++) {
		snapshots[index] = snapshotMiddlewareArg(args[index], new WeakMap(), `adapter middleware args[${index}]`);
	}
	return snapshots;
}

function snapshotMiddlewareArg<T>(value: T, seen = new WeakMap<object, any>(), context = 'adapter middleware argument'): T {
	if (!value || typeof value !== 'object') return value;
	const builtInClone = cloneMiddlewareBuiltIn(value, context);
	if (builtInClone.cloned) return builtInClone.value as T;
	const seenValue = WEAKMAP_GET.call(seen, value);
	if (seenValue !== undefined) return seenValue;
	if (Array.isArray(value)) {
		if (Object.getOwnPropertySymbols(value).length) {
			throw new ActiveTsValidationError(`${context} cannot contain symbol fields.`);
		}
		assertDenseArrayItems(value, context);
		for (const property of Object.getOwnPropertyNames(value)) {
			if (property === 'length') continue;
			if (!isArrayIndexProperty(property, value.length)) {
				throw new ActiveTsValidationError(`${context} cannot contain non-index array property "${property}".`);
			}
			const descriptor = Object.getOwnPropertyDescriptor(value, property);
			if (!descriptor || !('value' in descriptor)) {
				throw new ActiveTsValidationError(`${context}[${property}] must be a data property.`);
			}
			if (!descriptor.enumerable) {
				throw new ActiveTsValidationError(`${context}[${property}] must be enumerable.`);
			}
		}
		const copy: unknown[] = [];
		WEAKMAP_SET.call(seen, value, copy);
		for (let index = 0; index < value.length; index++) {
			const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
			copy[index] = snapshotMiddlewareArg(descriptor!.value, seen, `${context}[${index}]`);
		}
		return copy as T;
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return value;
	assertAllowedMiddlewareArgSymbols(value, context);
	const copy = Object.create(prototype) as Record<string, unknown>;
	WEAKMAP_SET.call(seen, value, copy);
	for (const key of Object.getOwnPropertyNames(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsValidationError(`${context}.${key} must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsValidationError(`${context}.${key} must be enumerable.`);
		}
		Object.defineProperty(copy, key, {
			value: snapshotMiddlewareArg(descriptor.value, seen, `${context}.${key}`),
			enumerable: true,
			configurable: true,
			writable: true
		});
	}
	return copyFieldCodecQueryOperandMarker(value, copy) as T;
}

function assertAllowedMiddlewareArgSymbols(value: object, context: string) {
	for (const symbol of Object.getOwnPropertySymbols(value)) {
		if (symbol !== FIELD_CODEC_QUERY_OPERANDS_ENCODED) {
			throw new ActiveTsValidationError(`${context} cannot contain symbol fields.`);
		}
		hasFieldCodecQueryOperandsEncoded(value);
	}
}

function cloneMiddlewareBuiltIn(value: object, context: string): { cloned: true; value: unknown } | { cloned: false } {
	if (value instanceof Date) return { cloned: true, value: cloneDate(value) };
	if (value instanceof RegExp) {
		if (Object.getPrototypeOf(value) !== RegExp.prototype) {
			throw new ActiveTsValidationError(`${context} must be a built-in RegExp value.`);
		}
		const clone = new RegExp(value.source, value.flags);
		clone.lastIndex = value.lastIndex;
		return { cloned: true, value: clone };
	}
	if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
		return { cloned: true, value: structuredClone(value) };
	}
	return { cloned: false };
}

function isArrayIndexProperty(property: string, length: number) {
	if (!/^(0|[1-9]\d*)$/.test(property)) return false;
	const index = Number(property);
	return Number.isSafeInteger(index) && index >= 0 && index < length;
}

function assertTransactionCallback(value: unknown, context: string): asserts value is (tx: StoreAdapter) => Promise<unknown> {
	if (typeof value !== 'function') {
		throw new ActiveTsConfigurationError(`${context} must be a function.`);
	}
}

function normalizeMiddlewareReadResult(
	value: unknown,
	expected: number,
	context: string,
	trustedSourceRows?: TrustedDatastoreEntityKeySourceRows,
	trustedRows?: boolean | WeakSet<object>
) {
	if (!Array.isArray(value) || value.length !== expected) {
		throw new ActiveTsValidationError(`${context} must be an array with ${expected} entries.`);
	}
	const safeInput = snapshotArrayInput(value, context);
	const normalized: Array<Record<string, any> | null> = [];
	for (let index = 0; index < safeInput.length; index++) {
		normalized[index] = normalizeMiddlewareRow(safeInput[index], `${context}[${index}]`, trustedSourceRows, trustedRows);
	}
	return normalized;
}

function normalizeMiddlewareRow(
	value: unknown,
	context: string,
	trustedSourceRows?: TrustedDatastoreEntityKeySourceRows,
	trustedRows?: boolean | WeakSet<object>
) {
	if (value === null) return null;
	assertPlainDataObject(value, context);
	const row = cloneSafeData(value);
	markTrustedMiddlewareRow(value, row, trustedSourceRows, trustedRows, context);
	return row;
}

function markTrustedMiddlewareRow(
	source: unknown,
	row: Record<string, unknown>,
	trustedSourceRows?: TrustedDatastoreEntityKeySourceRows,
	trustedRows?: boolean | WeakSet<object>,
	context = 'store middleware row'
) {
	if (!trustedSourceRows || !trustedRows || trustedRows === true) return;
	if (!source || typeof source !== 'object' || Array.isArray(source)) return;
	if (!WEAKMAP_HAS.call(trustedSourceRows, source)) return;
	const snapshot = WEAKMAP_GET.call(trustedSourceRows, source)!;
	assertTrustedDatastoreEntityKeySourceRowUnchanged(source, snapshot, context);
	WEAKSET_ADD.call(trustedRows, row);
}

function assertTrustedDatastoreEntityKeySourceRowUnchanged(
	source: object,
	snapshot: TrustedDatastoreEntityKeySourceRow,
	context: string
) {
	const descriptor = Object.getOwnPropertyDescriptor(source, ACTIVE_TS_ENTITY_KEY);
	if (!snapshot.hasEntityKey) {
		if (descriptor !== undefined) {
			throw new ActiveTsValidationError(`${context} active-ts entity key changed after store middleware next().`);
		}
		return;
	}
	if (!descriptor || !('value' in descriptor) || descriptor.enumerable || descriptor.value !== snapshot.entityKey) {
		throw new ActiveTsValidationError(`${context} active-ts entity key changed after store middleware next().`);
	}
}

function normalizeMiddlewareEntityId(value: unknown, context: string) {
	assertSafeEntityId(value, context);
	return value;
}

function normalizeMiddlewareWriteData(value: unknown, context: string) {
	assertPlainDataObject(value, context);
	return cloneSafeData(value);
}

function normalizeMiddlewareStoreWriteData(value: unknown, context: string) {
	assertPlainDataObject(value, context);
	return clonePortableData(value);
}
