import { optionalImport } from '../../core/optional-import.js';
import { ActiveTsConfigurationError, ActiveTsValidationError } from '../../core/errors.js';
import {
	assertPlainDataObject,
	assertSafeEntityId,
	assertSafeFieldPath,
	assertSafeLimit,
	assertSafeSchemaIdentifier,
	cloneSafeData
} from '../../core/safe-keys.js';
import { snapshotArrayInput } from '../../core/array-input.js';
import { entityIdFromCanonicalKey } from '../../core/query-utils.js';
import { snapshotSearchAdapterModel } from '../../core/adapter-model.js';
import {
	assertSafeSearchQuery,
	markSearchDocumentIdentity,
	markProjectingSearchAdapter,
	normalizeSearchAdapterOptions,
	projectSearchDocument,
	rejectUnsupportedSearchOption,
	searchDocumentIdentity,
	searchFieldsForAdapter,
	searchProjectionFieldsForAdapter,
	searchIndexesForAdapter
} from '../../core/search-utils.js';
import { normalizeSchemaModels } from '../../core/schema-utils.js';
import { normalizeStoreSchemaApplyOptions } from '../../core/schema-options.js';
import { cloneJsonTransportPayload } from '../../core/native-payload.js';
import { SET_ADD, SET_HAS } from '../../core/collection-intrinsics.js';
import type { EntityId, QueryResult, ResolvedModelMeta, SchemaChange, SearchAdapter, SearchOptions } from '../../core/types.js';

export type AlgoliaOptions = {
	client?: any;
	appId?: string;
	apiKey?: string;
	indexPrefix?: string;
};
const ALGOLIA_OPTION_KEYS = ['client', 'appId', 'apiKey', 'indexPrefix'] as const;

const ALGOLIA_PORTABLE_SEARCH_PARAMS = [
	'query',
	'hitsPerPage',
	'page',
	'offset',
	'length',
	'restrictSearchableAttributes',
	'attributesToRetrieve'
] as const;
const ALGOLIA_HIT_METADATA_KEYS = stringSet([
	'objectID',
	'_highlightResult',
	'_snippetResult',
	'_rankingInfo',
	'_distinctSeqID',
	'_geoloc',
	'__position',
	'__queryID'
]);
const ALGOLIA_RESERVED_PROJECTION_FIELD_NAMES = stringSet([
	'objectID',
	'_highlightResult',
	'_snippetResult',
	'_rankingInfo',
	'_distinctSeqID',
	'_geoloc'
]);
const ALGOLIA_PREFIX_VALIDATION_SUFFIX = 'active_ts_model';
const ALGOLIA_INDEX_MAX_BYTES = 255;

function stringSet(values: readonly string[]) {
	const set = new Set<string>();
	for (const value of values) SET_ADD.call(set, value);
	return set;
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

function pageFromCursor(cursor: string | undefined) {
	if (cursor === undefined) return undefined;
	if (!/^(0|[1-9]\d*)$/.test(cursor)) {
		throw new ActiveTsValidationError(`Algolia cursor "${cursor}" is not allowed.`);
	}
	const page = Number(cursor);
	if (!Number.isSafeInteger(page)) {
		throw new ActiveTsValidationError(`Algolia cursor "${cursor}" is not allowed.`);
	}
	return page;
}

function algoliaNativeOptions(native: unknown) {
	if (native === undefined) return undefined;
	assertPlainDataObject(native, 'Algolia native payload');
	for (const key of ALGOLIA_PORTABLE_SEARCH_PARAMS) {
		if (Object.prototype.hasOwnProperty.call(native, key)) {
			throw new ActiveTsConfigurationError(
				`Algolia native parameter "${key}" cannot be combined with active-ts search query, limit, or cursor options.`
			);
		}
	}
	return native;
}

export async function createAlgoliaSearchAdapter(options: AlgoliaOptions = {}): Promise<SearchAdapter> {
	options = validateAlgoliaOptions(options);
	const mod = options.client ? undefined : await optionalImport('algoliasearch', 'AlgoliaSearchAdapter');
	const client = normalizeAlgoliaClient(options.client ?? mod.algoliasearch(options.appId, options.apiKey));
	const indexName = (name: string) => {
		const safeName = assertSafeSchemaIdentifier(name, 'Algolia model name');
		const index = `${options.indexPrefix ?? ''}${safeName}`;
		return assertSafeAlgoliaIndexName(index);
	};
	const schemaPlan = async (models: ResolvedModelMeta[]) => {
		models = normalizeSchemaModels(models, 'Algolia syncSchema models');
		return {
			adapter: 'algolia',
			status: 'manual' as const,
			note: 'Algolia search index settings must be reviewed and applied with Algolia tooling.',
			changes: algoliaSchemaChanges(models, indexName)
		};
	};

	return markProjectingSearchAdapter({
		kind: 'algolia',
		capabilities: { where: false, cursor: true, native: true, index: true },
		async search(model, query: string, searchOptions: SearchOptions = {}): Promise<QueryResult> {
			model = snapshotSearchAdapterModel(model, 'Algolia model metadata', 'algolia');
			searchOptions = normalizeSearchAdapterOptions(searchOptions, 'Algolia search options', {
				limit: 'Algolia limit',
				cursor: 'Algolia cursor'
			});
			rejectUnsupportedSearchOption(searchOptions.where, 'where filters', 'Algolia search adapter');
			const safeQuery = assertSafeSearchQuery(query, 'Algolia search query');
			const native = algoliaNativeOptions(searchOptions.native);
			const idField = assertSafeAlgoliaProjectionField(model.idField, 'Algolia model id field');
			const fields = algoliaSearchFields(model);
			const projectionFields = algoliaProjectionFields(model);
			const attributesToRetrieve = uniqueStrings([idField, ...projectionFields]);
			if (native === undefined && !fields.length) return { list: [], more: false, count: 0 };
			const searchParams = {
				...(native ?? {}),
				query: safeQuery,
				...(searchOptions.limit === undefined
					? {}
					: { hitsPerPage: assertSafeLimit(searchOptions.limit, 'Algolia limit') }),
				...(searchOptions.cursor === undefined ? {} : { page: pageFromCursor(searchOptions.cursor) }),
				...(fields.length
					? {
							restrictSearchableAttributes: fields,
							attributesToRetrieve
						}
					: {})
			};
			const res = await client.searchSingleIndex(cloneJsonTransportPayload({
				indexName: indexName(model.name),
				searchParams
			}, 'Algolia search request'));
			const page = algoliaOptionalNonNegativeInteger(ownResponseValue(res, 'page'), 'Algolia search response page');
			const nbPages = algoliaOptionalNonNegativeInteger(ownResponseValue(res, 'nbPages'), 'Algolia search response nbPages');
			if ((searchOptions.limit !== undefined || searchOptions.cursor !== undefined) && (page === undefined || nbPages === undefined)) {
				throw new ActiveTsValidationError('Algolia search response page and nbPages are required for paginated searches.');
			}
			const total = algoliaExactTotal(res);
			const more = page !== undefined && nbPages !== undefined ? page + 1 < nbPages : false;
			const list = algoliaSearchList(algoliaHits(res), model);
			if (total !== undefined && total < list.length) {
				throw new ActiveTsValidationError('Algolia search response nbHits cannot be smaller than hits length.');
			}
			return {
				list,
				cursor: more && page !== undefined ? String(page + 1) : undefined,
				more,
				count: list.length,
				total
			};
		},
		async index(model, id: EntityId, data: any) {
			model = snapshotSearchAdapterModel(model, 'Algolia model metadata', 'algolia');
			assertSafeAlgoliaProjectionField(model.idField, 'Algolia model id field');
			algoliaSearchFields(model);
			algoliaProjectionFields(model);
			const documentIdentity = searchDocumentIdentity(model, id, `${model.name} search document id`, data, {
				trustDatastoreEntityKey: false
			});
			await client.saveObject(cloneJsonTransportPayload({
				indexName: indexName(model.name),
				body: {
					...projectSearchDocument(model, 'algolia', id, data, {
						trustDatastoreEntityKey: false
					}),
					objectID: `${model.name}:${documentIdentity}`
				}
			}, 'Algolia index request'));
		},
		async delete(model, id: EntityId) {
			model = snapshotSearchAdapterModel(model, 'Algolia model metadata', 'algolia');
			assertSafeEntityId(id, `${model.name} search delete id`);
			const documentIdentity = searchDocumentIdentity(model, id, `${model.name} search delete id`);
			await client.deleteObject(cloneJsonTransportPayload({
				indexName: indexName(model.name),
				objectID: `${model.name}:${documentIdentity}`
			}, 'Algolia delete request'));
		},
		schema: {
			plan: schemaPlan,
			apply: async (models, applyOptions) => {
				normalizeStoreSchemaApplyOptions(applyOptions, 'Algolia schema apply options');
				return schemaPlan(models);
			}
		},
		syncSchema: schemaPlan
	});
}

function algoliaSchemaChanges(models: ResolvedModelMeta[], indexName: (name: string) => string) {
	const changes: SchemaChange[] = [];
	for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
		const model = models[modelIndex];
		indexName(model.name);
		assertSafeAlgoliaProjectionField(model.idField, 'Algolia model id field');
		const indexes = searchIndexesForAdapter(model, 'algolia');
		for (let indexPosition = 0; indexPosition < indexes.length; indexPosition++) {
			const index = indexes[indexPosition];
			changes[changes.length] = {
				type: 'create-search-index',
				target: model.name,
				name: index.name,
				fields: algoliaSchemaFields(index.fields)
			};
		}
	}
	return changes;
}

function algoliaSchemaFields(rawFields: readonly string[], context = 'Algolia search field') {
	const fields: string[] = [];
	for (let index = 0; index < rawFields.length; index++) {
		fields[index] = assertSafeAlgoliaProjectionField(rawFields[index], context);
	}
	return fields;
}

function assertSafeAlgoliaProjectionField(field: unknown, context: string) {
	const safeField = assertSafeFieldPath(field, context);
	const dot = safeField.indexOf('.');
	const topLevel = dot < 0 ? safeField : safeField.slice(0, dot);
	if (SET_HAS.call(ALGOLIA_RESERVED_PROJECTION_FIELD_NAMES, topLevel)) {
		throw new ActiveTsValidationError(`${context} "${safeField}" uses reserved Algolia metadata field "${topLevel}".`);
	}
	return safeField;
}

function algoliaSearchFields(model: ResolvedModelMeta) {
	return algoliaSchemaFields(searchFieldsForAdapter(model, 'algolia'));
}

function algoliaProjectionFields(model: ResolvedModelMeta) {
	return algoliaSchemaFields(searchProjectionFieldsForAdapter(model, 'algolia'), 'Algolia projection field');
}

function algoliaSearchList(hits: any[], model: ResolvedModelMeta) {
	const list: any[] = [];
	for (let index = 0; index < hits.length; index++) {
		list[index] = stripAlgoliaHit(hits[index], model);
	}
	return list;
}

function validateAlgoliaOptions(options: AlgoliaOptions) {
	if (!options || typeof options !== 'object' || Array.isArray(options)) {
		throw new ActiveTsConfigurationError('Algolia adapter options must be an object.');
	}
	assertPlainFactoryOptions(options, 'Algolia adapter options');
	const record = options as Record<string, unknown>;
	assertNoSymbolOptions(record, 'Algolia adapter options');
	assertKnownOptions(record, ALGOLIA_OPTION_KEYS, 'Algolia adapter options');
	const appId = ownFactoryOptionValue(record, 'appId', 'Algolia adapter option');
	const apiKey = ownFactoryOptionValue(record, 'apiKey', 'Algolia adapter option');
	const indexPrefix = ownFactoryOptionValue(record, 'indexPrefix', 'Algolia adapter option');
	const client = ownFactoryOptionValue(record, 'client', 'Algolia adapter option');
	if (appId !== undefined && typeof appId !== 'string') {
		throw new ActiveTsConfigurationError('Algolia adapter appId must be a string.');
	}
	if (apiKey !== undefined && typeof apiKey !== 'string') {
		throw new ActiveTsConfigurationError('Algolia adapter apiKey must be a string.');
	}
	if (indexPrefix !== undefined && typeof indexPrefix !== 'string') {
		throw new ActiveTsConfigurationError('Algolia adapter indexPrefix must be a string.');
	}
	if (typeof indexPrefix === 'string') {
		assertSafeAlgoliaIndexName(`${indexPrefix}${ALGOLIA_PREFIX_VALIDATION_SUFFIX}`);
	}
	if (client !== undefined && (appId !== undefined || apiKey !== undefined)) {
		throw new ActiveTsConfigurationError('Algolia adapter options cannot combine client with appId or apiKey.');
	}
	if (client !== undefined) {
		normalizeAlgoliaClient(client);
	} else {
		if (typeof appId !== 'string' || !appId) {
			throw new ActiveTsConfigurationError('Algolia adapter appId must be a non-empty string when no client is supplied.');
		}
		if (typeof apiKey !== 'string' || !apiKey) {
			throw new ActiveTsConfigurationError('Algolia adapter apiKey must be a non-empty string when no client is supplied.');
		}
	}
	return { appId, apiKey, indexPrefix, client } as AlgoliaOptions;
}

function assertSafeAlgoliaIndexName(index: string) {
	if (!index || /[\0\r\n]/.test(index)) {
		throw new ActiveTsValidationError(`Algolia index name "${index}" is not allowed.`);
	}
	if (Buffer.byteLength(index, 'utf8') > ALGOLIA_INDEX_MAX_BYTES) {
		throw new ActiveTsValidationError(`Algolia index name "${index}" is too long.`);
	}
	return index;
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
	const allowed = stringSet(allowedKeys);
	for (const property of Object.getOwnPropertyNames(record)) {
		if (!SET_HAS.call(allowed, property)) {
			throw new ActiveTsConfigurationError(`${context} contains unknown option "${property}".`);
		}
	}
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

function normalizeAlgoliaClient(client: unknown) {
	if (!client || typeof client !== 'object' || Array.isArray(client)) {
		throw new ActiveTsConfigurationError('Algolia adapter client must be an object.');
	}
	const searchSingleIndex = clientMethod(client, 'searchSingleIndex', 'Algolia adapter client.searchSingleIndex');
	const saveObject = clientMethod(client, 'saveObject', 'Algolia adapter client.saveObject');
	const deleteObject = clientMethod(client, 'deleteObject', 'Algolia adapter client.deleteObject');
	return Object.freeze({ searchSingleIndex, saveObject, deleteObject });
}

function clientMethod(client: object, method: string, context: string) {
	const value = clientMember(client, method, context);
	if (typeof value !== 'function') {
		throw new ActiveTsConfigurationError(`${context} must be a function.`);
	}
	return value.bind(client);
}

function clientMember(client: object, property: string, context: string) {
	let current: object | null = client;
	while (current && current !== Object.prototype) {
		if (Object.prototype.hasOwnProperty.call(current, property)) {
			const descriptor = Object.getOwnPropertyDescriptor(current, property);
			if (!descriptor || !('value' in descriptor)) {
				throw new ActiveTsConfigurationError(`${context} must be a data property.`);
			}
			if (current === client && !descriptor.enumerable && descriptor.value !== undefined) {
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

function stripAlgoliaHit(hit: any, model: ResolvedModelMeta) {
	assertPlainResponseObject(hit, 'Algolia hit');
	const objectID = ownOptionValue(hit, 'objectID');
	const cleanInput: Record<string, unknown> = {};
	for (const property of Object.getOwnPropertyNames(hit)) {
		if (SET_HAS.call(ALGOLIA_HIT_METADATA_KEYS, property)) continue;
		const descriptor = Object.getOwnPropertyDescriptor(hit, property);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsValidationError(`Algolia hit.${property} must be a data property.`);
		}
		cleanInput[property] = descriptor.value;
	}
	const clean = cloneSafeData(cleanInput);
	if (clean[model.idField] === undefined) {
		clean[model.idField] = idFromAlgoliaObjectID(objectID, model);
	}
	const logicalId = clean[model.idField];
	assertSafeEntityId(logicalId, `Algolia hit ${model.idField}`);
	return markSearchDocumentIdentity(
		projectSearchDocument(model, 'algolia', logicalId, clean),
		documentIdentityFromAlgoliaObjectID(objectID, model)
	);
}

function algoliaHits(response: unknown): any[] {
	const hits = ownResponseValue(response, 'hits');
	if (hits === undefined) {
		throw new ActiveTsValidationError('Algolia search response.hits is required.');
	}
	if (!Array.isArray(hits)) {
		throw new ActiveTsValidationError('Algolia search hits must be an array.');
	}
	return snapshotArrayInput(hits, 'Algolia search hits');
}

function ownResponseValue(response: unknown, key: string) {
	assertPlainResponseObject(response, 'Algolia search response');
	return ownOptionValue(response as Record<string, unknown>, key);
}

function assertPlainResponseObject(response: unknown, context: string) {
	if (!response || typeof response !== 'object' || Array.isArray(response)) {
		throw new ActiveTsValidationError(`${context} must be a plain object.`);
	}
	const prototype = Object.getPrototypeOf(response);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsValidationError(`${context} must be a plain object.`);
	}
	const record = response as Record<string, unknown>;
	if (Object.getOwnPropertySymbols(record).length) {
		throw new ActiveTsValidationError(`${context} cannot contain symbol fields.`);
	}
	for (const property of Object.getOwnPropertyNames(record)) {
		const descriptor = Object.getOwnPropertyDescriptor(record, property);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsValidationError(`${context}.${property} must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsValidationError(`${context}.${property} must be enumerable.`);
		}
	}
}

function algoliaOptionalNonNegativeInteger(value: unknown, context: string) {
	if (value === undefined) return undefined;
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
		throw new ActiveTsValidationError(`${context} must be a non-negative safe integer.`);
	}
	return value;
}

function algoliaExactTotal(response: unknown) {
	const total = algoliaOptionalNonNegativeInteger(ownResponseValue(response, 'nbHits'), 'Algolia search response nbHits');
	const exhaustiveNbHits = algoliaOptionalBoolean(
		ownResponseValue(response, 'exhaustiveNbHits'),
		'Algolia search response exhaustiveNbHits'
	);
	const exhaustive = ownResponseValue(response, 'exhaustive');
	if (exhaustive !== undefined) {
		assertPlainResponseObject(exhaustive, 'Algolia search response exhaustive');
		const nested = algoliaOptionalBoolean(
			ownOptionValue(exhaustive as Record<string, unknown>, 'nbHits'),
			'Algolia search response exhaustive.nbHits'
		);
		if (nested === false) return undefined;
	}
	return exhaustiveNbHits === false ? undefined : total;
}

function algoliaOptionalBoolean(value: unknown, context: string) {
	if (value === undefined) return undefined;
	if (typeof value !== 'boolean') {
		throw new ActiveTsValidationError(`${context} must be a boolean.`);
	}
	return value;
}

function idFromAlgoliaObjectID(objectID: unknown, model: ResolvedModelMeta) {
	if (typeof objectID !== 'string') {
		throw new ActiveTsValidationError(`Algolia hit missing string objectID for "${model.idField}" fallback.`);
	}
	if (model.datastore?.ancestor) {
		throw new ActiveTsValidationError(
			`Algolia hit for Datastore ancestor model "${model.name}" must include "${model.idField}".`
		);
	}
	const prefix = `${model.name}:`;
	if (!objectID.startsWith(prefix)) {
		throw new ActiveTsValidationError(`Algolia objectID "${objectID}" does not match model "${model.name}".`);
	}
	return entityIdFromCanonicalKey(objectID.slice(prefix.length), `Algolia objectID "${objectID}"`);
}

function documentIdentityFromAlgoliaObjectID(objectID: unknown, model: ResolvedModelMeta) {
	if (typeof objectID !== 'string') return undefined;
	const prefix = `${model.name}:`;
	return objectID.startsWith(prefix) ? objectID.slice(prefix.length) : undefined;
}
