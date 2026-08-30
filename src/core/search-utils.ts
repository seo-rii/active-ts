import { createHash } from 'node:crypto';
import type { DatastoreKey, QueryPlan, ResolvedModelMeta, SearchAdapter, SearchIndexMeta, SearchOptions, SearchWriteOptions, StoreAdapter, WhereValue } from './types.js';
import { ActiveTsConfigurationError, ActiveTsValidationError } from './errors.js';
import {
	assertSafeCacheKey,
	assertPlainDataObject,
	assertPortableStoredData,
	assertSafeCursor,
	assertSafeEntityId,
	assertSafeLimit,
	assertSafeSchemaIdentifier,
	assertSafeTopLevelField,
	ACTIVE_TS_ENTITY_KEY,
	cloneSafeData,
	defineDataProperty
} from './safe-keys.js';
import { assertPlainWhereShape, entityIdKey, setPath, valueFor, whereShapeToPlan } from './query-utils.js';
import { applyFieldTypeTransforms } from './field-types.js';
import { searchCapability, searchWhereOperatorCapability } from './capabilities.js';
import { cloneNativePayload } from './native-payload.js';
import {
	datastoreAncestorFromEntityKey,
	datastoreKeyIdentity,
	datastoreKeyWithNamespace,
	normalizeDatastoreKey
} from './datastore-key.js';
import {
	datastorePayloadCanResolveAncestor,
	datastoreWritePayloadAncestorCandidates
} from './store-options.js';
import { SET_ADD, SET_HAS, WEAKMAP_GET, WEAKMAP_SET } from './collection-intrinsics.js';
import {
	OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
	OBJECT_GET_OWN_PROPERTY_NAMES,
	OBJECT_GET_OWN_PROPERTY_SYMBOLS,
	OBJECT_GET_PROTOTYPE_OF,
	OBJECT_HAS_OWN
} from './object-intrinsics.js';

const MAX_SEARCH_QUERY_LENGTH = 4096;
const SEARCH_OPTION_KEYS = ['where', 'native', 'limit', 'cursor'] as const;
const SEARCH_OPTION_KEY_SET = stringSet(SEARCH_OPTION_KEYS);
const SEARCH_WRITE_OPTION_KEY_SET = stringSet(['revision']);
const NATIVE_SEARCH_SOURCE_STORE = Symbol('active-ts.native-search.source-store');
const NATIVE_SEARCH_REBIND = Symbol('active-ts.native-search.rebind');
const SEARCH_ADAPTER_SOURCE = Symbol('active-ts.search-adapter.source');
export const CONTEXT_BOUND_SEARCH_DATASTORE_NAMESPACE = Symbol('active-ts.context-bound-search-datastore-namespace');
const PROJECTING_SEARCH_ADAPTER = Symbol('active-ts.search-adapter.projecting');
const SEARCH_DOCUMENT_IDENTITIES = new WeakMap<object, string>();
const DATASTORE_SEARCH_NAMESPACES = new WeakMap<Function, string>();

function stringSet(values: readonly string[]) {
	const set = new Set<string>();
	for (const value of values) SET_ADD.call(set, value);
	return set;
}

export function searchIndexesForAdapter(model: ResolvedModelMeta, adapter: string | undefined): SearchIndexMeta[] {
	const indexes: SearchIndexMeta[] = [];
	for (let index = 0; index < model.searchIndexes.length; index++) {
		const searchIndex = model.searchIndexes[index];
		if (!searchIndex.adapter || searchIndex.adapter === adapter) {
			indexes[indexes.length] = searchIndex;
		}
	}
	return indexes;
}

export function searchFieldsForAdapter(model: ResolvedModelMeta, adapter: string | undefined) {
	const seen = new Set<string>();
	const fields: string[] = [];
	for (const index of searchIndexesForAdapter(model, adapter)) {
		for (const field of index.fields) {
			if (SET_HAS.call(seen, field)) continue;
			SET_ADD.call(seen, field);
			fields[fields.length] = field;
		}
	}
	return fields;
}

export function searchProjectionFieldsForAdapter(model: ResolvedModelMeta, adapter: string | undefined) {
	const seen = new Set<string>();
	const fields: string[] = [];
	const addField = (field: string) => {
		if (SET_HAS.call(seen, field)) return;
		SET_ADD.call(seen, field);
		fields[fields.length] = field;
	};
	for (const field of searchFieldsForAdapter(model, adapter)) addField(field);
	if (model.datastore?.ancestorFields) {
		for (const field of model.datastore.ancestorFields) addField(field);
	}
	return fields;
}

export function markNativeSearchAdapter<TAdapter extends SearchAdapter>(
	adapter: TAdapter,
	store: StoreAdapter,
	rebind: (store: StoreAdapter) => SearchAdapter
) {
	defineDataProperty(adapter, NATIVE_SEARCH_SOURCE_STORE, store, { enumerable: false, configurable: false });
	defineDataProperty(adapter, NATIVE_SEARCH_REBIND, rebind, { enumerable: false, configurable: false });
	return adapter;
}

export function markSearchAdapterSource<TAdapter extends SearchAdapter>(adapter: TAdapter, source: SearchAdapter) {
	defineDataProperty(adapter, SEARCH_ADAPTER_SOURCE, source, { enumerable: false, configurable: false });
	return adapter;
}

export function markProjectingSearchAdapter<TAdapter extends SearchAdapter>(adapter: TAdapter) {
	defineDataProperty(adapter, PROJECTING_SEARCH_ADAPTER, true, { enumerable: false, configurable: false });
	return adapter;
}

export function searchAdapterUsesProjection(adapter: SearchAdapter) {
	const seen = new Set<SearchAdapter>();
	let current: SearchAdapter | undefined = adapter;
	while (current) {
		if (SET_HAS.call(seen, current)) return false;
		SET_ADD.call(seen, current);
		const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(current, PROJECTING_SEARCH_ADAPTER);
		if (descriptor) {
			if (!('value' in descriptor)) {
				throw new ActiveTsConfigurationError('Search adapter projection marker must be a data property.');
			}
			if (descriptor.value !== true) {
				throw new ActiveTsConfigurationError('Search adapter projection marker must be true.');
			}
			return true;
		}
		const next = searchAdapterSource(current);
		if (next === current) return false;
		current = next;
	}
	return false;
}

export function searchAdapterSource(adapter: SearchAdapter): SearchAdapter | undefined {
	if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) return undefined;
	const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(adapter, SEARCH_ADAPTER_SOURCE);
	if (!descriptor) return undefined;
	if (!('value' in descriptor)) {
		throw new ActiveTsConfigurationError('Search adapter source must be a data property.');
	}
	const value = descriptor.value;
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ActiveTsConfigurationError('Search adapter source must be an adapter object.');
	}
	return value as SearchAdapter;
}

export function searchAdapterSourceChain(adapter: SearchAdapter): SearchAdapter[] {
	const chain: SearchAdapter[] = [];
	const seen = new Set<SearchAdapter>();
	let current: SearchAdapter | undefined = adapter;
	while (current) {
		if (SET_HAS.call(seen, current)) return chain;
		SET_ADD.call(seen, current);
		chain[chain.length] = current;
		current = searchAdapterSource(current);
	}
	return chain;
}

export function contextBoundSearchDatastoreNamespace(
	adapter: unknown,
	model: ResolvedModelMeta
): string | undefined {
	if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) return undefined;
	for (const source of searchAdapterSourceChain(adapter as SearchAdapter)) {
		const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(source, CONTEXT_BOUND_SEARCH_DATASTORE_NAMESPACE);
		if (!descriptor) continue;
		if (!('value' in descriptor)) {
			throw new ActiveTsConfigurationError('Context-bound search Datastore namespace reader must be a data property.');
		}
		if (typeof descriptor.value !== 'function') {
			throw new ActiveTsConfigurationError('Context-bound search Datastore namespace reader must be a function.');
		}
		const namespace = descriptor.value(model);
		if (namespace !== undefined && (typeof namespace !== 'string' || !namespace || namespace.includes('\0'))) {
			throw new ActiveTsConfigurationError(
				'Context-bound search Datastore namespace must be a non-empty string without null bytes, or undefined for the default namespace.'
			);
		}
		return namespace;
	}
	return undefined;
}

export function markSearchDocumentIdentity<T extends object>(
	document: T,
	identity: string | undefined
) {
	if (identity === undefined) return document;
	WEAKMAP_SET.call(SEARCH_DOCUMENT_IDENTITIES, document, assertSafeCacheKey(identity, 'search document identity'));
	return document;
}

export function searchHitDocumentIdentity(hit: unknown) {
	if (!hit || typeof hit !== 'object') return undefined;
	return WEAKMAP_GET.call(SEARCH_DOCUMENT_IDENTITIES, hit as object);
}

export function datastoreSearchHitDocumentIdentity(
	model: Pick<ResolvedModelMeta, 'datastore' | 'name'>,
	hit: unknown,
	context: string
) {
	const identity = searchHitDocumentIdentity(hit);
	if (identity === undefined && model.datastore?.ancestor) {
		throw new ActiveTsValidationError(`${context} for Datastore model "${model.name}" is missing search document identity.`);
	}
	return identity;
}

export function datastoreSearchHitDocumentIdentityOrForced(
	model: Pick<ResolvedModelMeta, 'datastore' | 'name' | 'searchDocumentIdentity'>,
	hit: unknown,
	context: string
) {
	const identity = searchHitDocumentIdentity(hit);
	if (identity !== undefined) return identity;
	if (!model.datastore?.ancestor) return undefined;
	if (model.searchDocumentIdentity !== undefined) {
		return assertSafeCacheKey(model.searchDocumentIdentity, `${context} forced search document identity`);
	}
	throw new ActiveTsValidationError(`${context} for Datastore model "${model.name}" is missing search document identity.`);
}

export function nativeSearchSourceStore(adapter: SearchAdapter): StoreAdapter | undefined {
	if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) return undefined;
	const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(adapter, NATIVE_SEARCH_SOURCE_STORE);
	if (!descriptor) return undefined;
	if (!('value' in descriptor)) {
		throw new ActiveTsConfigurationError('Native search adapter source store must be a data property.');
	}
	const value = descriptor.value;
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ActiveTsConfigurationError('Native search adapter source store must be an adapter object.');
	}
	return value as StoreAdapter;
}

export function rebindNativeSearchAdapter(adapter: SearchAdapter, store: StoreAdapter): SearchAdapter | undefined {
	const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(adapter, NATIVE_SEARCH_REBIND);
	if (!descriptor) return undefined;
	if (!('value' in descriptor)) {
		throw new ActiveTsConfigurationError('Native search adapter rebind hook must be a data property.');
	}
	if (typeof descriptor.value !== 'function') {
		throw new ActiveTsConfigurationError('Native search adapter rebind hook must be a function.');
	}
	return descriptor.value(store);
}

export function searchIndexAdapterKind(adapter: Pick<SearchAdapter, 'kind' | 'searchIndexKind'>, routeName: string) {
	if (adapter.searchIndexKind !== undefined) return assertSafeSchemaIdentifier(adapter.searchIndexKind, 'search adapter searchIndexKind');
	try {
		return assertSafeSchemaIdentifier(adapter.kind, 'search adapter kind');
	} catch {
		return routeName;
	}
}

export function assertSafeSearchQuery(query: unknown, context = 'search query') {
	if (typeof query !== 'string') {
		throw new ActiveTsValidationError(`${context} must be a string.`);
	}
	if (query.length > MAX_SEARCH_QUERY_LENGTH) {
		throw new ActiveTsValidationError(`${context} is too long.`);
	}
	if (query.includes('\0')) {
		throw new ActiveTsValidationError(`${context} must not contain null bytes.`);
	}
	return query;
}

export function normalizeSearchAdapterOptions(
	options: unknown,
	context: string,
	diagnostics: { limit?: string; cursor?: string } = {}
): SearchOptions {
	if (options === undefined) return { where: undefined, native: undefined, limit: undefined, cursor: undefined };
	if (!options || typeof options !== 'object' || Array.isArray(options)) {
		throw new ActiveTsValidationError(`${context} must be a plain object.`);
	}
	const prototype = OBJECT_GET_PROTOTYPE_OF(options);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsValidationError(`${context} must be a plain object.`);
	}
	if (OBJECT_GET_OWN_PROPERTY_SYMBOLS(options).length) {
		throw new ActiveTsValidationError(`${context} cannot contain symbol fields.`);
	}
	assertKnownSearchOptionKeys(options, context);
	const value = options as Record<string, unknown>;
	const where = ownOptionValue(value, 'where', context);
	const native = ownOptionValue(value, 'native', context);
	const limit = ownOptionValue(value, 'limit', context);
	const cursor = ownOptionValue(value, 'cursor', context);
	let safeWhere: SearchOptions['where'] | undefined;
	if (where !== undefined) {
		assertPlainWhereShape(where as SearchOptions['where'], `${context}.where`);
		const plan = whereShapeToPlan(where as SearchOptions['where'], `${context}.where`);
		safeWhere = plan.where.length ? wherePlanToShape(plan.where) : undefined;
	}
	return {
		where: safeWhere,
		native: cloneNativePayload(native, `${context}.native`),
		limit: limit === undefined ? undefined : assertSafeLimit(limit as number, diagnostics.limit ?? `${context} limit`),
		cursor: assertSafeCursor(cursor, diagnostics.cursor ?? `${context} cursor`)
	};
}

export function normalizeSearchWriteOptions(options: unknown, context: string): SearchWriteOptions {
	if (options === undefined) return {};
	if (!options || typeof options !== 'object' || Array.isArray(options)) {
		throw new ActiveTsValidationError(`${context} must be a plain object.`);
	}
	const prototype = OBJECT_GET_PROTOTYPE_OF(options);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsValidationError(`${context} must be a plain object.`);
	}
	if (OBJECT_GET_OWN_PROPERTY_SYMBOLS(options).length) {
		throw new ActiveTsValidationError(`${context} cannot contain symbol fields.`);
	}
	for (const property of OBJECT_GET_OWN_PROPERTY_NAMES(options)) {
		if (!SET_HAS.call(SEARCH_WRITE_OPTION_KEY_SET, property)) {
			throw new ActiveTsValidationError(`${context} contains unknown option "${property}".`);
		}
	}
	const revision = ownOptionValue(options as Record<string, unknown>, 'revision', context);
	if (revision !== undefined && (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision <= 0)) {
		throw new ActiveTsValidationError(`${context}.revision must be a positive safe integer.`);
	}
	return revision === undefined ? {} : { revision };
}

export function assertSearchWriteOptionsSupported(
	adapter: Pick<SearchAdapter, 'kind' | 'capabilities'>,
	options: SearchWriteOptions
) {
	if (options.revision !== undefined && !searchCapability(adapter.capabilities, 'revisionWrites')) {
		throw new ActiveTsConfigurationError(
			`Search adapter "${adapter.kind}" does not support revision-ordered writes.`
		);
	}
}

export function rejectUnsupportedSearchOption(value: unknown, option: string, context: string) {
	if (value !== undefined) {
		throw new ActiveTsConfigurationError(`${context} does not support ${option}.`);
	}
}

export function assertSearchOptionsSupported(
	adapter: Pick<SearchAdapter, 'kind' | 'capabilities'>,
	options: SearchOptions
) {
	const wheres = options.where ? whereShapeToPlan(options.where, 'search where').where : [];
	if (wheres.length) {
		if (!searchCapability(adapter.capabilities, 'where'))
			throw new ActiveTsConfigurationError(`Search adapter "${adapter.kind}" does not support where() filters.`);
		for (const where of wheres) {
			if (where.op === 'contains') {
				throw new ActiveTsConfigurationError(
					'The legacy contains operator is ambiguous. Use arrayContains, textContains, or jsonContains.'
				);
			}
			if (!searchWhereOperatorCapability(adapter.capabilities, where.op)) {
				throw new ActiveTsConfigurationError(
					`Search adapter "${adapter.kind}" does not support ${where.op} where filters.`
				);
			}
			if ((where.op === 'isNull' || where.op === 'isNotNull') && !searchCapability(adapter.capabilities, 'nullOperators')) {
				throw new ActiveTsConfigurationError(`Search adapter "${adapter.kind}" does not support null where filters.`);
			}
			if (isRangeOperator(where.op) && !searchCapability(adapter.capabilities, 'numericComparisons')) {
				throw new ActiveTsConfigurationError(
					`Search adapter "${adapter.kind}" does not support safe range filters without typed fields.`
				);
			}
			if (where.field.includes('.') && !searchCapability(adapter.capabilities, 'nestedFields')) {
				throw new ActiveTsConfigurationError(`Search adapter "${adapter.kind}" does not support nested where filters.`);
			}
		}
	}
	if (options.cursor !== undefined && !searchCapability(adapter.capabilities, 'cursor'))
		throw new ActiveTsConfigurationError(`Search adapter "${adapter.kind}" does not support cursor pagination.`);
	if (options.native !== undefined && !searchCapability(adapter.capabilities, 'native'))
		throw new ActiveTsConfigurationError(`Search adapter "${adapter.kind}" does not support native search options.`);
}

function ownOptionValue(record: Record<string, unknown>, key: string, context: string) {
	if (!OBJECT_HAS_OWN(record, key)) return undefined;
	const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(record, key);
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsValidationError(`${context} "${key}" must be a data property.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsValidationError(`${context} "${key}" must be enumerable.`);
	}
	return descriptor.value;
}

function assertKnownSearchOptionKeys(value: object, context: string) {
	for (const property of OBJECT_GET_OWN_PROPERTY_NAMES(value)) {
		if (!SET_HAS.call(SEARCH_OPTION_KEY_SET, property)) {
			throw new ActiveTsValidationError(`${context} contains unknown option "${property}".`);
		}
	}
}

function wherePlanToShape(entries: QueryPlan['where']): SearchOptions['where'] {
	const shape = {} as NonNullable<SearchOptions['where']>;
	for (const entry of entries) {
		if (entry.op === '=') {
			shape[entry.field] = entry.value as WhereValue;
		} else if (entry.op === 'between') {
			shape[entry.field] = [entry.op, entry.value, entry.value2] as WhereValue;
		} else if (entry.op === 'isNull' || entry.op === 'isNotNull') {
			shape[entry.field] = [entry.op];
		} else {
			shape[entry.field] = [entry.op, entry.value] as WhereValue;
		}
	}
	return shape;
}

export function withSearchIndexesForAdapter(
	model: ResolvedModelMeta,
	adapter: string | undefined,
	adapterKind = adapter
): ResolvedModelMeta {
	const searchIndexes: SearchIndexMeta[] = [];
	for (let index = 0; index < model.searchIndexes.length; index++) {
		const searchIndex = model.searchIndexes[index];
		if (!searchIndex.adapter || searchIndex.adapter === adapter || searchIndex.adapter === adapterKind) {
			searchIndexes[searchIndexes.length] = { ...searchIndex, adapter: adapterKind ?? searchIndex.adapter };
		}
	}
	return {
		...model,
		search: adapterKind ?? adapter ?? model.search,
		searchIndexes
	};
}

export function withSearchDocumentIdentity(
	model: ResolvedModelMeta,
	searchDocumentIdentity: string | undefined
): ResolvedModelMeta {
	if (searchDocumentIdentity === undefined) return model;
	return {
		...model,
		searchDocumentIdentity: assertSafeCacheKey(searchDocumentIdentity, `${model.name} search document identity`)
	};
}

export function searchDocumentIdentity(
	model: ResolvedModelMeta,
	id: string | number,
	context: string,
	data?: any,
	options: { validatePayloadAncestor?: boolean; trustDatastoreEntityKey?: boolean } = {}
): string {
	const identity = model.searchDocumentIdentity;
	if (identity !== undefined) {
		const safeIdentity = assertSafeCacheKey(identity, context);
		if (model.datastore?.ancestor && data !== undefined) {
			const canResolvePayloadAncestor = datastorePayloadCanResolveAncestor(model, id, data, context);
			if (
				options.trustDatastoreEntityKey === false &&
				datastoreSearchDocumentHasEntityKey(data) &&
				!canResolvePayloadAncestor
			) {
				throw new ActiveTsValidationError(
					`${context} partial Datastore search document cannot use untrusted active-ts entity key metadata.`
				);
			}
			if (options.validatePayloadAncestor !== false && canResolvePayloadAncestor) {
				if (!datastoreSearchPayloadIdentityMatches(model, id, data, safeIdentity, context, datastoreSearchNamespace(model))) {
					throw new ActiveTsValidationError(
						`Search document identity for Datastore model "${model.name}" does not match its Datastore payload data.`
					);
				}
			}
		}
		return safeIdentity;
	}
	if (model.datastore?.ancestor) {
		const datastoreNamespace = datastoreSearchNamespace(model);
		if (data !== undefined) {
			const canResolvePayloadAncestor = datastorePayloadCanResolveAncestor(model, id, data, context);
			if (
				options.trustDatastoreEntityKey === false &&
				datastoreSearchDocumentHasEntityKey(data) &&
				!canResolvePayloadAncestor
			) {
				throw new ActiveTsValidationError(
					`${context} partial Datastore search document cannot use untrusted active-ts entity key metadata.`
				);
			}
			let entityKeyAncestor = options.trustDatastoreEntityKey === false
				? undefined
				: datastoreSearchAncestorWithNamespace(
						datastoreSearchDocumentAncestorFromEntityKey(model, id, data, context),
						datastoreNamespace,
						`${context} active-ts entity key`
					);
			const payloadAncestors = entityKeyAncestor === undefined ||
				(options.validatePayloadAncestor !== false && canResolvePayloadAncestor)
				? datastoreSearchPayloadAncestors(model, id, data, context)
				: [];
			const matchingPayloadAncestor = entityKeyAncestor === undefined
				? undefined
				: datastoreSearchMatchingPayloadAncestor(entityKeyAncestor, payloadAncestors);
			const payloadAncestor = matchingPayloadAncestor ?? payloadAncestors[payloadAncestors.length - 1];
			if (matchingPayloadAncestor !== undefined) {
				entityKeyAncestor = datastoreSearchAncestorWithPayloadNamespace(
					entityKeyAncestor,
					matchingPayloadAncestor,
					`${context} active-ts entity key`
				);
			}
			if (
				entityKeyAncestor !== undefined &&
				payloadAncestor !== undefined &&
				matchingPayloadAncestor === undefined
			) {
				throw new ActiveTsValidationError(
					`Search document identity for Datastore model "${model.name}" does not match its Datastore payload data.`
				);
			}
			const ancestor = entityKeyAncestor ?? payloadAncestor;
			if (ancestor === undefined) {
				throw new ActiveTsConfigurationError(
					`Search document identity for Datastore model "${model.name}" requires ancestor metadata.`
				);
			}
			return datastoreSearchDocumentIdentity(model, id, ancestor, datastoreNamespace);
		}
		throw new ActiveTsConfigurationError(
			`Search document identity for Datastore model "${model.name}" requires ancestor metadata.`
		);
	}
	assertSafeEntityId(id, context);
	return entityIdKey(id);
}

function datastoreSearchPayloadIdentityMatches(
	model: ResolvedModelMeta,
	id: string | number,
	data: unknown,
	expectedIdentity: string,
	context: string,
	datastoreNamespace: string | undefined
) {
	const ancestors = datastoreSearchPayloadAncestors(model, id, data, context);
	for (let index = 0; index < ancestors.length; index++) {
		if (datastoreSearchDocumentIdentity(model, id, ancestors[index], datastoreNamespace) === expectedIdentity) {
			return true;
		}
	}
	return false;
}

function datastoreSearchMatchingPayloadAncestor(
	expectedAncestor: DatastoreKey,
	payloadAncestors: DatastoreKey[]
) {
	for (let index = 0; index < payloadAncestors.length; index++) {
		const payloadAncestor = payloadAncestors[index];
		const expected = datastoreSearchAncestorWithPayloadNamespace(
			expectedAncestor,
			payloadAncestor,
			'Datastore search identity active-ts entity key'
		);
		if (expected !== undefined && datastoreKeyIdentity(expected) === datastoreKeyIdentity(payloadAncestor)) {
			return payloadAncestor;
		}
	}
	return undefined;
}

function datastoreSearchPayloadAncestors(
	model: ResolvedModelMeta,
	id: string | number,
	data: unknown,
	context: string
) {
	const ancestors: DatastoreKey[] = [];
	const seen = new Set<string>();
	if (data && typeof data === 'object' && !Array.isArray(data)) {
		try {
			const candidates = datastoreWritePayloadAncestorCandidates(model, id, data as Record<string, unknown>);
			for (let index = 0; index < candidates.length; index++) {
				const candidate = candidates[index];
				if (candidate === undefined) continue;
				const normalized = normalizeDatastoreKey(candidate, `${context} payload Datastore ancestor`);
				const identity = datastoreKeyIdentity(normalized);
				if (SET_HAS.call(seen, identity)) continue;
				SET_ADD.call(seen, identity);
				ancestors[ancestors.length] = normalized;
			}
		} catch {
			// Partial search documents may omit fields needed by undeclared ancestor resolvers.
		}
	}
	if (ancestors.length) return ancestors;
	const ancestor = model.datastore?.ancestor?.({ model, id, data });
	return ancestor === undefined
		? ancestors
		: [normalizeDatastoreKey(ancestor, `${context} payload Datastore ancestor`)];
}

function datastoreSearchDocumentHasEntityKey(data: unknown) {
	if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
	const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(data, ACTIVE_TS_ENTITY_KEY);
	return descriptor !== undefined && 'value' in descriptor && !descriptor.enumerable;
}

function datastoreSearchDocumentAncestorFromEntityKey(
	model: ResolvedModelMeta,
	id: string | number,
	data: unknown,
	context: string
) {
	if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
	const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(data, ACTIVE_TS_ENTITY_KEY);
	if (descriptor === undefined) return undefined;
	if (!('value' in descriptor)) {
		throw new ActiveTsValidationError(`${context} active-ts entity key must be a data property.`);
	}
	if (descriptor.enumerable) {
		throw new ActiveTsValidationError(`${context} active-ts entity key must be non-enumerable.`);
	}
	return datastoreAncestorFromEntityKey(
		descriptor.value,
		model.name,
		id,
		`${context} active-ts entity key`
	);
}

export function withDatastoreSearchNamespace(
	model: ResolvedModelMeta,
	namespace: string | undefined
): ResolvedModelMeta {
	if (namespace === undefined || !model.datastore?.ancestor) return model;
	const datastore = model.datastore;
	const ancestorForModel = datastore.ancestor!;
	const namespacedAncestor: NonNullable<ResolvedModelMeta['datastore']>['ancestor'] = (input) => {
		const ancestor = ancestorForModel(input);
		return ancestor === undefined
			? undefined
			: datastoreKeyWithNamespace(ancestor, namespace, `Datastore ancestor for "${model.name}"`);
	};
	WEAKMAP_SET.call(DATASTORE_SEARCH_NAMESPACES, namespacedAncestor, namespace);
	return {
		...model,
		datastore: {
			...datastore,
			ancestor: namespacedAncestor
		}
	};
}

function datastoreSearchNamespace(model: ResolvedModelMeta) {
	const ancestor = model.datastore?.ancestor;
	return ancestor === undefined ? undefined : WEAKMAP_GET.call(DATASTORE_SEARCH_NAMESPACES, ancestor);
}

function datastoreSearchAncestorWithNamespace(
	ancestor: DatastoreKey | undefined,
	namespace: string | undefined,
	context: string
) {
	if (ancestor === undefined || namespace === undefined) return ancestor;
	return datastoreKeyWithNamespace(ancestor, namespace, context);
}

function datastoreSearchAncestorWithPayloadNamespace(
	ancestor: DatastoreKey | undefined,
	payloadAncestor: DatastoreKey,
	context: string
) {
	if (ancestor === undefined) return undefined;
	const normalizedPayload = datastoreKeyWithNamespace(payloadAncestor, undefined, `${context} payload ancestor`);
	if (normalizedPayload.namespace === undefined) return ancestor;
	return datastoreKeyWithNamespace(ancestor, normalizedPayload.namespace, context);
}

export function datastoreSearchDocumentIdentity(
	model: Pick<ResolvedModelMeta, 'name'>,
	id: string | number,
	ancestor: DatastoreKey | undefined,
	namespace?: string
) {
	const safeAncestor = ancestor === undefined
		? undefined
		: datastoreKeyWithNamespace(ancestor, namespace, `Datastore search ancestor for "${model.name}"`);
	const path = safeAncestor ? [...safeAncestor.path] : [];
	path[path.length] = { kind: model.name, id };
	const physicalIdentity = datastoreKeyIdentity({ path, namespace: safeAncestor?.namespace ?? namespace });
	return `datastore:${createHash('sha256').update(physicalIdentity).digest('base64url')}`;
}

export function projectSearchDocument(
	model: ResolvedModelMeta,
	adapter: string | undefined,
	id: string | number,
	data: any,
	options: { trustDatastoreEntityKey?: boolean; preserveSearchDocumentIdentity?: boolean } = {}
) {
	assertSafeSchemaIdentifier(model.name, 'search document model name');
	const idField = assertSafeTopLevelField(model.idField, `${model.name} search document id field`);
	assertPlainDataObject(data, `${model.name} search document input`);
	const fields = searchProjectionFieldsForAdapter(model, adapter);
	const projected: Record<string, any> = {};
	const currentId = valueFor(data, idField);
	const documentId = currentId === undefined ? id : currentId;
	assertSafeEntityId(documentId, `${model.name}.${idField} search document id`);
	if (entityIdKey(documentId) !== entityIdKey(id)) {
		throw new ActiveTsValidationError(
			`${model.name}.${idField} search document id must match the indexed id.`
		);
	}
	setPath(projected, idField, documentId);
	for (const field of fields) {
		const value = searchProjectionValue(data, field);
		if (value !== undefined) setPath(projected, field, value);
	}
	const normalized = applyFieldTypeTransforms(model, projected, 'write');
	assertPortableStoredData(normalized, `${model.name} search document`);
	const preservedIdentity = options.preserveSearchDocumentIdentity
		? searchHitDocumentIdentity(data)
		: undefined;
	return markSearchDocumentIdentity(
		cloneSafeData(normalized),
		preservedIdentity ?? searchDocumentIdentity(model, id, `${model.name} search document id`, data, {
			trustDatastoreEntityKey: options.trustDatastoreEntityKey
		})
	);
}

function searchProjectionValue(data: Record<string, any>, field: string) {
	const nested = valueFor(data, field);
	if (nested !== undefined || !field.includes('.')) return nested;
	if (!OBJECT_HAS_OWN(data, field)) return undefined;
	const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(data, field);
	return descriptor && 'value' in descriptor && descriptor.enumerable ? descriptor.value : undefined;
}

function isRangeOperator(op: QueryPlan['where'][number]['op']) {
	return op === '>' || op === '>=' || op === '<' || op === '<=' || op === 'between';
}
