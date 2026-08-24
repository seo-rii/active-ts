import type { QueryResult, ResolvedModelMeta, SearchAdapter, StoreAdapter } from '../../core/types.js';
import {
	assertPlainDataObject,
	assertSafeCursor,
	assertSafeEntityId,
	assertSafeFieldPath,
	assertSafeResultCount,
	assertSafeSchemaIdentifier,
	cloneSafeData
} from '../../core/safe-keys.js';
import { ActiveTsConfigurationError, ActiveTsValidationError } from '../../core/errors.js';
import { snapshotSearchAdapterModel } from '../../core/adapter-model.js';
import { snapshotArrayInput } from '../../core/array-input.js';
import { assertValidWhereOperand, valueFor } from '../../core/query-utils.js';
import { applyFieldCodecs, encodeFieldCodecQueryOperand, markFieldCodecQueryOperandsEncoded } from '../../core/field-codecs.js';
import { applyFieldTypeTransforms } from '../../core/field-types.js';
import {
	assertSafeSearchQuery,
	normalizeSearchAdapterOptions,
	projectSearchDocument,
	rejectUnsupportedSearchOption,
	markNativeSearchAdapter,
	searchFieldsForAdapter,
	searchHitDocumentIdentity,
	withDatastoreSearchNamespace
} from '../../core/search-utils.js';
import { SET_ADD, SET_HAS } from '../../core/collection-intrinsics.js';
import {
	inheritAdapterTransactionOperationCarrier,
	storeTrustsDatastoreEntityKeyRows,
	trackStoreTransactionOperation
} from '../../core/store-options.js';
import { isContextBoundStoreAdapter } from '../../core/context.js';

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
const NATIVE_SEARCH_RESULT_KEYS = ['list', 'cursor', 'more', 'count', 'total'] as const;

function stringSet(values: readonly string[]) {
	const set = new Set<string>();
	for (const value of values) SET_ADD.call(set, value);
	return set;
}

export function createNativeSearchAdapter(store: StoreAdapter): SearchAdapter {
	const wrapped = normalizeNativeSearchStore(store);
	const storeCapabilities = snapshotNativeStoreCapabilities(wrapped.capabilities);
	const trustDatastoreEntityKeyRows = storeTrustsDatastoreEntityKeyRows(store);
	const adapter: SearchAdapter = {
		kind: 'native',
		capabilities: {
			where: false,
			cursor: storeCapabilities.cursor,
			native: storeCapabilities.native,
			index: false
		},
		search(model, query, options = {}) {
			return trackStoreTransactionOperation(store, async () => {
				model = snapshotSearchAdapterModel(model, 'native search model metadata', 'native');
				assertSafeSchemaIdentifier(model.name, 'native search model name');
				options = normalizeSearchAdapterOptions(options, 'native search options');
				rejectUnsupportedSearchOption(options.where, 'where filters', 'Native search adapter');
				const safeQuery = assertSafeSearchQuery(query, 'native search query');
				const rawFields = searchFieldsForAdapter(model, 'native');
				const fields: string[] = [];
				for (let index = 0; index < rawFields.length; index++) {
					fields[index] = assertSafeFieldPath(rawFields[index], 'native search field');
				}
				if (options.native !== undefined && !storeCapabilities.native)
					throw new ActiveTsConfigurationError(`Store adapter "${wrapped.kind}" does not support native search payloads.`);
				if (options.cursor !== undefined && !storeCapabilities.cursor)
					throw new ActiveTsConfigurationError(`Store adapter "${wrapped.kind}" does not support native search cursors.`);
				const searchModel = withDatastoreSearchNamespace(model, wrapped.datastoreNamespace);
				if (options.native !== undefined) {
					return normalizeNativeSearchResult(
						searchModel,
						await wrapped.query(
							model,
							{
								where: [],
								or: [],
								sort: [],
								include: [],
								limit: options.limit,
								cursor: options.cursor,
								native: { payload: options.native }
							},
							{ native: options.native }
						),
						`Native search store "${wrapped.kind}" query`,
						{ cursor: storeCapabilities.cursor, adapterKind: wrapped.kind, trustDatastoreEntityKeyRows }
					);
				}
				if (!fields.length && options.native === undefined) return { list: [], more: false, count: 0 };
				if (fields.length && !storeCapabilities.textContains)
					throw new ActiveTsConfigurationError(`Store adapter "${wrapped.kind}" does not support native textContains search.`);
				if (nativeSearchFieldsHaveNestedPath(fields) && !storeCapabilities.nestedFields)
					throw new ActiveTsConfigurationError(`Store adapter "${wrapped.kind}" does not support native nested search fields.`);
				if (fields.length > 1 && !storeCapabilities.or)
					throw new ActiveTsConfigurationError(`Store adapter "${wrapped.kind}" does not support native multi-field search.`);
				const textContains: Array<{ field: string; op: 'textContains'; value: unknown }> = [];
				for (let index = 0; index < fields.length; index++) {
					const field = fields[index];
					const value = encodeFieldCodecQueryOperand(model, field, safeQuery, 'textContains');
					assertValidWhereOperand('textContains', value, undefined, field);
					textContains[index] = {
						field,
						op: 'textContains' as const,
						value
					};
				}
				const orBranches: Array<{ where: typeof textContains; or: []; sort: []; include: [] }> = [];
				if (fields.length > 1) {
					for (let index = 0; index < textContains.length; index++) {
						orBranches[index] = { where: [textContains[index]], or: [], sort: [], include: [] };
					}
				}
				const queryPlan = markFieldCodecQueryOperandsEncoded({
					where: fields.length === 1 ? textContains : [],
					or: orBranches,
					sort: [],
					include: [],
					limit: options.limit,
					cursor: options.cursor,
					native: options.native !== undefined ? { payload: options.native } : undefined
				});
				return normalizeNativeSearchResult(
					searchModel,
					await wrapped.query(
						model,
						queryPlan,
						options.native === undefined ? undefined : { native: options.native }
					),
					`Native search store "${wrapped.kind}" query`,
					{ cursor: storeCapabilities.cursor, adapterKind: wrapped.kind, trustDatastoreEntityKeyRows }
				);
			});
		},
		index() {
			return trackStoreTransactionOperation(store, async () => {
				throw new ActiveTsConfigurationError('Native search adapter does not support indexing.');
			});
		},
		delete() {
			return trackStoreTransactionOperation(store, async () => {
				throw new ActiveTsConfigurationError('Native search adapter does not support indexing.');
			});
		}
	};
	return inheritAdapterTransactionOperationCarrier(
		markNativeSearchAdapter(adapter, store, (nextStore) => createNativeSearchAdapter(nextStore)),
		store
	);
}

function normalizeNativeSearchResult(
	model: ResolvedModelMeta,
	result: unknown,
	context: string,
	capabilities: { cursor: boolean; adapterKind: string; trustDatastoreEntityKeyRows: boolean }
): QueryResult {
	if (!result || typeof result !== 'object' || Array.isArray(result)) {
		throw new ActiveTsValidationError(`${context} result must be a plain object.`);
	}
	const prototype = Object.getPrototypeOf(result);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsValidationError(`${context} result must be a plain object.`);
	}
	const record = result as Record<string, unknown>;
	assertNoNativeAccessorFields(record, `${context} result`, ActiveTsValidationError);
	assertKnownNativeResultKeys(record, `${context} result`);
	const list = ownResultValue(record, 'list', context);
	if (!Array.isArray(list)) throw new ActiveTsValidationError(`${context} result.list must be an array.`);
	const rows = snapshotArrayInput(list, `${context} result.list`);
	const safeList: any[] = [];
	const datastoreSearchIdentities = model.datastore?.ancestor ? new Set<string>() : undefined;
	for (let index = 0; index < rows.length; index++) {
		const item = rows[index];
		assertPlainDataObject(item, `${context} result.list[${index}]`);
		const id = valueFor(item, model.idField);
		if (id === undefined || id === null) {
			throw new ActiveTsValidationError(`${context} result.list[${index}] is missing id field "${model.idField}".`);
		}
		assertSafeEntityId(id, `${context} result.list[${index}].${model.idField}`);
		const decoded = applyFieldTypeTransforms(model, applyFieldCodecs(model, cloneSafeData(item), 'read'), 'read');
		const projected = projectSearchDocument(model, 'native', id, decoded, {
			trustDatastoreEntityKey: capabilities.trustDatastoreEntityKeyRows
		});
		const searchIdentity = datastoreSearchIdentities ? searchHitDocumentIdentity(projected) : undefined;
		if (searchIdentity !== undefined) {
			if (SET_HAS.call(datastoreSearchIdentities, searchIdentity)) {
				throw new ActiveTsValidationError(`${context} result contains duplicate search document identity.`);
			}
			SET_ADD.call(datastoreSearchIdentities, searchIdentity);
		}
		safeList[index] = projected;
	}
	const cursor = assertSafeCursor(ownResultValue(record, 'cursor', context), `${context} result cursor`);
	const more = ownResultValue(record, 'more', context);
	assertSafeResultCount(ownResultValue(record, 'count', context), `${context} result.count`);
	const total = assertSafeResultCount(ownResultValue(record, 'total', context), `${context} result.total`);
	if (more !== undefined && typeof more !== 'boolean') {
		throw new ActiveTsValidationError(`${context} result.more must be a boolean.`);
	}
	if (cursor !== undefined && !capabilities.cursor) {
		throw new ActiveTsConfigurationError(
			`Store adapter "${capabilities.adapterKind}" does not support returning portable cursors.`
		);
	}
	if (total !== undefined && total < safeList.length) {
		throw new ActiveTsValidationError(`${context} result.total cannot be smaller than result.list length.`);
	}
	return { list: safeList, cursor, more, count: safeList.length, total };
}

function nativeSearchFieldsHaveNestedPath(fields: string[]) {
	for (let index = 0; index < fields.length; index++) {
		if (fields[index].includes('.')) return true;
	}
	return false;
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

function normalizeNativeSearchStore(store: StoreAdapter) {
	if (!store || typeof store !== 'object' || Array.isArray(store)) {
		throw new ActiveTsConfigurationError('Native search store must be an adapter object.');
	}
	const allowContextAccessors = isContextBoundStoreAdapter(store);
	const kind = adapterMember(store, 'kind');
	const query = adapterMember(store, 'query');
	const capabilities = adapterMember(store, 'capabilities', { allowOwnAccessor: allowContextAccessors });
	const datastoreNamespace = normalizeOptionalNativeStoreDatastoreNamespace(
		adapterMember(store, 'datastoreNamespace', { allowOwnAccessor: allowContextAccessors }),
		'Native search store.datastoreNamespace'
	);
	if (typeof kind !== 'string' || !kind || kind.includes('\0')) {
		throw new ActiveTsConfigurationError('Native search store.kind must be a non-empty string without null bytes.');
	}
	if (typeof query !== 'function') {
		throw new ActiveTsConfigurationError('Native search store.query must be a function.');
	}
	if (capabilities !== undefined) assertNativeStoreCapabilities(capabilities);
	return Object.freeze({
		kind,
		query: query.bind(store) as StoreAdapter['query'],
		datastoreNamespace,
		capabilities: capabilities as StoreAdapter['capabilities'] | undefined
	});
}

function normalizeOptionalNativeStoreDatastoreNamespace(value: unknown, context: string) {
	if (value === undefined) return undefined;
	if (typeof value !== 'string' || !value || value.includes('\0')) {
		throw new ActiveTsConfigurationError(`${context} must be a non-empty string without null bytes.`);
	}
	return value;
}

function snapshotNativeStoreCapabilities(rawCapabilities: StoreAdapter['capabilities'] | undefined) {
	const capabilities = rawCapabilities === undefined
		? {}
		: assertNativeStoreCapabilities(rawCapabilities);
	return Object.freeze({
		cursor: nativeStoreCapability(capabilities, 'cursor'),
		native: nativeStoreCapability(capabilities, 'native'),
		or: nativeStoreCapability(capabilities, 'or'),
		textContains: nativeStoreCapability(capabilities, 'textContains'),
		nestedFields: nativeStoreCapability(capabilities, 'nestedFields')
	});
}

function adapterMember(adapter: object, property: string, options: { allowOwnAccessor?: boolean } = {}) {
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
						throw new ActiveTsConfigurationError(`Native search store.${property} must be enumerable.`);
					}
					return descriptor.get.call(adapter);
				}
				throw new ActiveTsConfigurationError(`Native search store.${property} must be a data property.`);
			}
			if (current === adapter && !descriptor.enumerable && descriptor.value !== undefined) {
				throw new ActiveTsConfigurationError(`Native search store.${property} must be enumerable.`);
			}
			return descriptor.value;
		}
		current = Object.getPrototypeOf(current);
	}
	return undefined;
}

function assertNativeStoreCapabilities(capabilities: unknown): Record<string, unknown> {
	if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
		throw new ActiveTsConfigurationError('Native search store.capabilities must be a plain object.');
	}
	const prototype = Object.getPrototypeOf(capabilities);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsConfigurationError('Native search store.capabilities must be a plain object.');
	}
	assertNoNativeAccessorFields(capabilities as Record<string, unknown>, 'Native search store.capabilities', ActiveTsConfigurationError);
	assertKnownStoreCapabilityKeys(capabilities as Record<string, unknown>);
	return capabilities as Record<string, unknown>;
}

function assertKnownStoreCapabilityKeys(capabilities: Record<string, unknown>) {
	const allowed = stringSet(STORE_CAPABILITY_KEYS);
	for (const property of Object.keys(capabilities)) {
		if (!SET_HAS.call(allowed, property as typeof STORE_CAPABILITY_KEYS[number])) {
			throw new ActiveTsConfigurationError(`Native search store.capabilities contains unknown capability "${property}".`);
		}
	}
}

function nativeStoreCapability(capabilities: Record<string, unknown>, key: string) {
	if (!Object.prototype.hasOwnProperty.call(capabilities, key)) return false;
	const descriptor = Object.getOwnPropertyDescriptor(capabilities, key);
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsConfigurationError(`Native search store.capabilities.${key} must be a data property.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsConfigurationError(`Native search store.capabilities.${key} must be enumerable.`);
	}
	const value = descriptor.value;
	if (value === undefined) return false;
	if (typeof value !== 'boolean') {
		throw new ActiveTsConfigurationError(`Native search store.capabilities.${key} must be a boolean.`);
	}
	return value;
}

function assertNoNativeAccessorFields(
	record: Record<string, unknown>,
	context: string,
	ErrorClass: typeof ActiveTsConfigurationError | typeof ActiveTsValidationError
) {
	if (Object.getOwnPropertySymbols(record).length) {
		throw new ErrorClass(`${context} cannot contain symbol fields.`);
	}
	for (const property of Object.getOwnPropertyNames(record)) {
		const descriptor = Object.getOwnPropertyDescriptor(record, property);
		if (!descriptor || !('value' in descriptor)) {
			throw new ErrorClass(`${context}.${property} must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ErrorClass(`${context}.${property} must be enumerable.`);
		}
	}
}

function assertKnownNativeResultKeys(record: Record<string, unknown>, context: string) {
	const allowed = stringSet(NATIVE_SEARCH_RESULT_KEYS);
	for (const property of Object.getOwnPropertyNames(record)) {
		if (!SET_HAS.call(allowed, property)) {
			throw new ActiveTsValidationError(`${context} contains unknown option "${property}".`);
		}
	}
}
