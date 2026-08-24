import { optionalImport } from '../../core/optional-import.js';
import { ActiveTsConfigurationError, ActiveTsValidationError } from '../../core/errors.js';
import { isPlainErrorObject, ownErrorValue } from '../../core/error-classification.js';
import {
	assertPlainDataObject,
	assertSafeCacheKey,
	assertSafeEntityId,
	assertSafeFieldPath,
	assertSafeSchemaIdentifier,
	cloneSafeData
} from '../../core/safe-keys.js';
import { snapshotArrayInput } from '../../core/array-input.js';
import { entityIdFromCanonicalKey } from '../../core/query-utils.js';
import { snapshotSearchAdapterModel } from '../../core/adapter-model.js';
import {
	assertSafeSearchQuery,
	markProjectingSearchAdapter,
	markSearchDocumentIdentity,
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

export type ElasticsearchOptions = {
	client?: any;
	node?: string;
	indexPrefix?: string;
};
const ELASTICSEARCH_OPTION_KEYS = ['client', 'node', 'indexPrefix'] as const;
const ELASTICSEARCH_PREFIX_VALIDATION_SUFFIX = 'active_ts_model';
const ELASTICSEARCH_INDEX_MAX_BYTES = 255;
const ELASTICSEARCH_ID_MAX_BYTES = 512;
const ELASTICSEARCH_RESERVED_PROJECTION_FIELD_NAMES = stringSet([
	'_id',
	'_source',
	'_index',
	'_score',
	'_type',
	'_routing',
	'_seq_no',
	'_primary_term',
	'_version',
	'_ignored'
]);

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

function elasticsearchNativeBody(native: unknown): Record<string, unknown> | undefined {
	if (native === undefined) return undefined;
	assertPlainDataObject(native, 'Elasticsearch native payload');
	return native;
}

function elasticsearchTextBody(query: string, fields: string[], sourceFields: string[]) {
	return {
		_source: sourceFields,
		query: {
			multi_match: {
				query,
				fields,
				lenient: true
			}
		}
	};
}

function elasticsearchSearchBody(
	native: Record<string, unknown> | undefined,
	query: string,
	fields: string[],
	sourceFields: string[],
	hasActiveTsLimit: boolean
) {
	if (native && fields.length) {
		if (Object.prototype.hasOwnProperty.call(native, 'query')) {
			throw new ActiveTsConfigurationError(
				'Elasticsearch native query cannot be combined with portable search fields. Use a native-only model/search call or move the filter into native options without "query".'
			);
		}
		if (Object.prototype.hasOwnProperty.call(native, '_source')) {
			throw new ActiveTsConfigurationError(
				'Elasticsearch native _source cannot be combined with portable search fields.'
			);
		}
		for (const key of ['size', 'from', 'search_after']) {
			if (!Object.prototype.hasOwnProperty.call(native, key)) continue;
			throw new ActiveTsConfigurationError(
				`Elasticsearch native parameter "${key}" cannot be combined with portable search fields. active-ts owns pagination for portable searches.`
			);
		}
		return { ...native, ...elasticsearchTextBody(query, fields, sourceFields) };
	}
	if (native && hasActiveTsLimit) {
		for (const key of ['size', 'from', 'search_after']) {
			if (!Object.prototype.hasOwnProperty.call(native, key)) continue;
			throw new ActiveTsConfigurationError(
				`Elasticsearch native parameter "${key}" cannot be combined with active-ts limit.`
			);
		}
	}
	return native ?? elasticsearchTextBody(query, fields, sourceFields);
}

type ElasticsearchNativePagination = {
	from: number;
	searchAfter: boolean;
};

type ElasticsearchTotal = {
	value: number | undefined;
	lowerBound: boolean;
};

function elasticsearchNativePagination(native: Record<string, unknown> | undefined): ElasticsearchNativePagination {
	if (native === undefined) return { from: 0, searchAfter: false };
	const from = ownOptionValue(native, 'from');
	const searchAfter = Object.prototype.hasOwnProperty.call(native, 'search_after');
	if (from === undefined) return { from: 0, searchAfter };
	if (typeof from !== 'number' || !Number.isSafeInteger(from) || from < 0) {
		throw new ActiveTsValidationError('Elasticsearch native parameter "from" must be a non-negative safe integer.');
	}
	return { from, searchAfter };
}

function elasticsearchMore(
	total: ElasticsearchTotal,
	hitsLength: number,
	pagination: ElasticsearchNativePagination
) {
	if (total.lowerBound) {
		if (hitsLength === 0) return false;
		if (pagination.searchAfter) return undefined;
		return true;
	}
	if (total.value === undefined) return false;
	if (pagination.searchAfter) return hitsLength === 0 ? false : undefined;
	return pagination.from + hitsLength < total.value;
}

export async function createElasticsearchSearchAdapter(options: ElasticsearchOptions = {}): Promise<SearchAdapter> {
	options = validateElasticsearchOptions(options);
	const mod = options.client ? undefined : await optionalImport('@elastic/elasticsearch', 'ElasticsearchSearchAdapter');
	const Client = mod?.Client;
	const client = normalizeElasticsearchClient(options.client ?? new Client({ node: options.node }));
	const indexName = (name: string) => {
		const safeName = assertSafeSchemaIdentifier(name, 'Elasticsearch model name');
		const index = `${options.indexPrefix ?? ''}${safeName}`;
		return assertSafeElasticsearchIndexName(index);
	};
	const schemaPlan = async (models: ResolvedModelMeta[]) => {
		models = normalizeSchemaModels(models, 'Elasticsearch syncSchema models');
		return {
			adapter: 'elasticsearch',
			status: 'manual' as const,
			note: 'Elasticsearch index mappings and settings must be reviewed and applied with Elasticsearch tooling.',
			changes: elasticsearchSchemaChanges(models, indexName)
		};
	};

	return markProjectingSearchAdapter({
		kind: 'elasticsearch',
		capabilities: { where: false, cursor: false, native: true, index: true },
		async search(model, query: string, searchOptions: SearchOptions = {}): Promise<QueryResult> {
			model = snapshotSearchAdapterModel(model, 'Elasticsearch model metadata', 'elasticsearch');
			searchOptions = normalizeSearchAdapterOptions(searchOptions, 'Elasticsearch search options', {
				limit: 'Elasticsearch limit',
				cursor: 'Elasticsearch cursor'
			});
			rejectUnsupportedSearchOption(searchOptions.where, 'where filters', 'Elasticsearch search adapter');
			rejectUnsupportedSearchOption(searchOptions.cursor, 'cursors', 'Elasticsearch search adapter');
			const safeQuery = assertSafeSearchQuery(query, 'Elasticsearch search query');
			const fields = elasticsearchSearchFields(model);
			const idField = assertSafeElasticsearchProjectionField(model.idField, 'Elasticsearch model id field');
			const sourceFields = uniqueStrings([idField, ...elasticsearchProjectionFields(model)]);
			const native = elasticsearchNativeBody(searchOptions.native);
			const nativePagination = elasticsearchNativePagination(native);
			if (native === undefined && !fields.length) return { list: [], more: false, count: 0 };
			const res = await client.search(cloneJsonTransportPayload({
				index: indexName(model.name),
				...(searchOptions.limit === undefined ? {} : { size: searchOptions.limit }),
				body: elasticsearchSearchBody(native, safeQuery, fields, sourceFields, searchOptions.limit !== undefined)
			}, 'Elasticsearch search request'));
			const hits = elasticsearchHits(res);
			const total = elasticsearchTotal(res);
			const more = elasticsearchMore(total, hits.length, nativePagination);
			const list = elasticsearchSearchList(hits, model);
			if (total.value !== undefined && total.value < list.length) {
				throw new ActiveTsValidationError('Elasticsearch search total.value cannot be smaller than hits length.');
			}
			const result: QueryResult = {
				list,
				count: hits.length,
				total: total.value
			};
			if (more !== undefined) result.more = more;
			return result;
		},
		async index(model, id: EntityId, data: any) {
			model = snapshotSearchAdapterModel(model, 'Elasticsearch model metadata', 'elasticsearch');
			assertSafeElasticsearchProjectionField(model.idField, 'Elasticsearch model id field');
			elasticsearchSearchFields(model);
			elasticsearchProjectionFields(model);
			const documentId = elasticsearchDocumentId(
				searchDocumentIdentity(model, id, `${model.name} search document id`, data, {
					trustDatastoreEntityKey: false
				}),
				`${model.name} search document id`
			);
			await client.index(cloneJsonTransportPayload({
				index: indexName(model.name),
				id: documentId,
				document: projectSearchDocument(model, 'elasticsearch', id, data, {
					trustDatastoreEntityKey: false
				})
			}, 'Elasticsearch index request'));
		},
		async delete(model, id: EntityId) {
			model = snapshotSearchAdapterModel(model, 'Elasticsearch model metadata', 'elasticsearch');
			const documentId = elasticsearchDocumentId(
				searchDocumentIdentity(model, id, `${model.name} search delete id`),
				`${model.name} search delete id`
			);
			await client.delete(cloneJsonTransportPayload({
				index: indexName(model.name),
				id: documentId
			}, 'Elasticsearch delete request')).catch((error: unknown) => {
				if (isMissingDocumentError(error)) return undefined;
				throw error;
			});
		},
		schema: {
			plan: schemaPlan,
			apply: async (models, applyOptions) => {
				normalizeStoreSchemaApplyOptions(applyOptions, 'Elasticsearch schema apply options');
				return schemaPlan(models);
			}
		},
		syncSchema: schemaPlan
	});
}

function elasticsearchSchemaChanges(models: ResolvedModelMeta[], indexName: (name: string) => string) {
	const changes: SchemaChange[] = [];
	for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
		const model = models[modelIndex];
		assertSafeElasticsearchProjectionField(model.idField, 'Elasticsearch model id field');
		const indexes = searchIndexesForAdapter(model, 'elasticsearch');
		for (let indexPosition = 0; indexPosition < indexes.length; indexPosition++) {
			const index = indexes[indexPosition];
			indexName(model.name);
			changes[changes.length] = {
				type: 'create-search-index',
				target: model.name,
				name: index.name,
				fields: copyElasticsearchIndexFields(index.fields)
			};
		}
	}
	return changes;
}

function copyElasticsearchIndexFields(rawFields: readonly string[]) {
	const fields: string[] = [];
	for (let index = 0; index < rawFields.length; index++) {
		fields[index] = assertSafeElasticsearchProjectionField(rawFields[index], 'Elasticsearch search field');
	}
	return fields;
}

function elasticsearchSearchFields(model: ResolvedModelMeta) {
	const rawFields = searchFieldsForAdapter(model, 'elasticsearch');
	const fields: string[] = [];
	for (let index = 0; index < rawFields.length; index++) {
		fields[index] = assertSafeElasticsearchProjectionField(rawFields[index], 'Elasticsearch search field');
	}
	return fields;
}

function elasticsearchProjectionFields(model: ResolvedModelMeta) {
	const rawFields = searchProjectionFieldsForAdapter(model, 'elasticsearch');
	const fields: string[] = [];
	for (let index = 0; index < rawFields.length; index++) {
		fields[index] = assertSafeElasticsearchProjectionField(rawFields[index], 'Elasticsearch projection field');
	}
	return fields;
}

function assertSafeElasticsearchProjectionField(field: unknown, context: string) {
	const safeField = assertSafeFieldPath(field, context);
	const dot = safeField.indexOf('.');
	const topLevel = dot < 0 ? safeField : safeField.slice(0, dot);
	if (SET_HAS.call(ELASTICSEARCH_RESERVED_PROJECTION_FIELD_NAMES, topLevel)) {
		throw new ActiveTsValidationError(`${context} "${safeField}" uses reserved Elasticsearch metadata field "${topLevel}".`);
	}
	return safeField;
}

function elasticsearchDocumentId(id: string, context: string) {
	const documentId = assertSafeCacheKey(id, context);
	if (Buffer.byteLength(documentId, 'utf8') > ELASTICSEARCH_ID_MAX_BYTES) {
		throw new ActiveTsValidationError(`${context} encoded Elasticsearch _id exceeds 512 bytes.`);
	}
	return documentId;
}

function elasticsearchSearchList(hits: any[], model: ResolvedModelMeta) {
	const list: any[] = [];
	for (let index = 0; index < hits.length; index++) {
		list[index] = elasticsearchSearchHit(hits[index], model);
	}
	return list;
}

function elasticsearchSearchHit(hit: any, model: ResolvedModelMeta) {
	assertPlainDataObject(hit, 'Elasticsearch hit');
	const source = elasticsearchHitSource(hit);
	const clean = cloneSafeData(source);
	const row = ownOptionValue(source, model.idField) === undefined
		? { ...clean, [model.idField]: idFromElasticsearchHit(hit, model) }
		: clean;
	const logicalId = row[model.idField];
	assertSafeEntityId(logicalId, `Elasticsearch hit ${model.idField}`);
	return markSearchDocumentIdentity(
		projectSearchDocument(model, 'elasticsearch', logicalId, row),
		documentIdentityFromElasticsearchHit(hit, model)
	);
}

function elasticsearchHits(response: unknown): any[] {
	const hitsContainer = ownResponseValue(response, 'hits');
	if (hitsContainer === undefined) {
		throw new ActiveTsValidationError('Elasticsearch search response.hits is required.');
	}
	const hits = ownResponseValue(hitsContainer, 'hits');
	if (hits === undefined) {
		throw new ActiveTsValidationError('Elasticsearch search response.hits.hits is required.');
	}
	if (!Array.isArray(hits)) {
		throw new ActiveTsValidationError('Elasticsearch search hits must be an array.');
	}
	return snapshotArrayInput(hits, 'Elasticsearch search hits');
}

function elasticsearchTotal(response: unknown) {
	const hitsContainer = ownResponseValue(response, 'hits');
	if (hitsContainer === undefined) return { value: undefined, lowerBound: false };
	const total = ownResponseValue(hitsContainer, 'total');
	if (total === undefined) return { value: undefined, lowerBound: false };
	if (typeof total === 'number')
		return { value: elasticsearchNonNegativeNumber(total, 'Elasticsearch search total'), lowerBound: false };
	assertPlainResponseObject(total, 'Elasticsearch search total');
	const relation = ownOptionValue(total as Record<string, unknown>, 'relation');
	if (relation !== undefined && relation !== 'eq' && relation !== 'gte') {
		throw new ActiveTsValidationError('Elasticsearch search total.relation must be "eq" or "gte".');
	}
	const value = ownOptionValue(total as Record<string, unknown>, 'value');
	if (value === undefined) {
		throw new ActiveTsValidationError('Elasticsearch search total.value is required.');
	}
	const exact = elasticsearchNonNegativeNumber(value, 'Elasticsearch search total.value');
	return relation === 'gte'
		? { value: undefined, lowerBound: true }
		: { value: exact, lowerBound: false };
}

function elasticsearchNonNegativeNumber(value: unknown, context: string) {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
		throw new ActiveTsValidationError(`${context} must be a non-negative safe integer.`);
	}
	return value;
}

function ownResponseValue(response: unknown, key: string) {
	assertPlainResponseObject(response, 'Elasticsearch search response');
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

function validateElasticsearchOptions(options: ElasticsearchOptions) {
	if (!options || typeof options !== 'object' || Array.isArray(options)) {
		throw new ActiveTsConfigurationError('Elasticsearch adapter options must be an object.');
	}
	assertPlainFactoryOptions(options, 'Elasticsearch adapter options');
	const record = options as Record<string, unknown>;
	assertNoSymbolOptions(record, 'Elasticsearch adapter options');
	assertKnownOptions(record, ELASTICSEARCH_OPTION_KEYS, 'Elasticsearch adapter options');
	const node = ownFactoryOptionValue(record, 'node', 'Elasticsearch adapter option');
	const indexPrefix = ownFactoryOptionValue(record, 'indexPrefix', 'Elasticsearch adapter option');
	const client = ownFactoryOptionValue(record, 'client', 'Elasticsearch adapter option');
	if (node !== undefined && typeof node !== 'string') {
		throw new ActiveTsConfigurationError('Elasticsearch adapter node must be a string.');
	}
	if (indexPrefix !== undefined && typeof indexPrefix !== 'string') {
		throw new ActiveTsConfigurationError('Elasticsearch adapter indexPrefix must be a string.');
	}
	if (typeof indexPrefix === 'string') {
		assertSafeElasticsearchIndexName(`${indexPrefix}${ELASTICSEARCH_PREFIX_VALIDATION_SUFFIX}`);
	}
	if (client !== undefined && node !== undefined) {
		throw new ActiveTsConfigurationError('Elasticsearch adapter options cannot combine client and node.');
	}
	if (client !== undefined) {
		normalizeElasticsearchClient(client);
	} else if (typeof node !== 'string' || !node) {
		throw new ActiveTsConfigurationError('Elasticsearch adapter node must be a non-empty string when no client is supplied.');
	}
	return { node, indexPrefix, client } as ElasticsearchOptions;
}

function assertSafeElasticsearchIndexName(index: string) {
	if (
		!index ||
		index === '.' ||
		index === '..' ||
		index !== index.toLowerCase() ||
		/[\s,\\/*?"<>|#]/.test(index) ||
		/^[-_+]/.test(index)
	) {
		throw new ActiveTsValidationError(`Elasticsearch index name "${index}" is not allowed.`);
	}
	if (Buffer.byteLength(index, 'utf8') > ELASTICSEARCH_INDEX_MAX_BYTES) {
		throw new ActiveTsValidationError(`Elasticsearch index name "${index}" is too long.`);
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

function normalizeElasticsearchClient(client: unknown) {
	if (!client || typeof client !== 'object' || Array.isArray(client)) {
		throw new ActiveTsConfigurationError('Elasticsearch adapter client must be an object.');
	}
	const search = clientMethod(client, 'search', 'Elasticsearch adapter client.search');
	const index = clientMethod(client, 'index', 'Elasticsearch adapter client.index');
	const deleteDocument = clientMethod(client, 'delete', 'Elasticsearch adapter client.delete');
	return Object.freeze({ search, index, delete: deleteDocument });
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

function elasticsearchHitSource(hit: Record<string, unknown>) {
	if (!Object.prototype.hasOwnProperty.call(hit, '_source')) return {};
	const source = ownOptionValue(hit, '_source');
	assertPlainDataObject(source, 'Elasticsearch hit _source');
	return source as Record<string, unknown>;
}

function idFromElasticsearchHit(hit: any, model: ResolvedModelMeta) {
	const id = ownOptionValue(hit, '_id');
	if (typeof id !== 'string') {
		throw new ActiveTsValidationError(`Elasticsearch hit missing string _id for "${model.idField}" fallback.`);
	}
	if (model.datastore?.ancestor) {
		throw new ActiveTsValidationError(
			`Elasticsearch hit for Datastore ancestor model "${model.name}" must include "${model.idField}".`
		);
	}
	return entityIdFromCanonicalKey(id, `Elasticsearch hit _id "${id}"`);
}

function documentIdentityFromElasticsearchHit(hit: any, model: ResolvedModelMeta) {
	const id = ownOptionValue(hit, '_id');
	if (typeof id !== 'string') return undefined;
	return model.datastore?.ancestor ? id : undefined;
}

function isMissingDocumentError(error: unknown) {
	const statusCode = ownErrorValue(error, 'statusCode');
	const meta = ownErrorValue(error, 'meta');
	return statusCode === 404 || (isPlainErrorObject(meta) && ownErrorValue(meta, 'statusCode') === 404);
}
