import { ActiveTsConfigurationError } from './errors.js';
import {
	assertSafeFieldPath,
	assertSafeSchemaIdentifier,
	assertSafeTopLevelField,
	defineDataProperty
} from './safe-keys.js';
import { snapshotArrayInput } from './array-input.js';
import { MAP_ENTRIES, MAP_SET, SET_ADD, SET_HAS } from './collection-intrinsics.js';
import { assertNoOverlappingFieldPaths } from './query-utils.js';
import {
	validateDatastoreUnindexedMetadata,
	validateModelFieldTransformMetadata,
	validateSearchIndexProjectionWithDatastoreAncestorFields
} from './model-metadata-invariants.js';
import type {
	DatastoreModelMeta,
	FieldCodec,
	FieldCodecQueryOperator,
	FieldType,
	IndexMeta,
	ResolvedModelMeta,
	SearchIndexMeta
} from './types.js';

const STORE_INDEX_KEYS = ['name', 'fields', 'directions', 'unique'] as const;
const SEARCH_INDEX_KEYS = ['name', 'fields', 'adapter'] as const;
const DATASTORE_KEYS = ['ancestor', 'ancestorFields', 'unindexed'] as const;
const FIELD_CODEC_KEYS = ['name', 'encode', 'decode', 'encodeQuery', 'queryOperators'] as const;
const FIELD_TYPES = capturedSet<FieldType>(['string', 'number', 'boolean', 'date']);
const FIELD_CODEC_QUERY_OPERATORS = capturedSet<FieldCodecQueryOperator>([
	'=',
	'!=',
	'>',
	'>=',
	'<',
	'<=',
	'in',
	'between',
	'arrayContains',
	'textContains',
	'jsonContains',
	'startsWith'
]);

function capturedSet<T>(values: readonly T[]) {
	const set = new Set<T>();
	for (const value of values) SET_ADD.call(set, value);
	return set;
}

export function snapshotAdapterModel(model: ResolvedModelMeta, context: string): ResolvedModelMeta {
	if (!model || typeof model !== 'object' || Array.isArray(model)) {
		throw new ActiveTsConfigurationError(`${context} must be a resolved model metadata object.`);
	}
	const prototype = Object.getPrototypeOf(model);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsConfigurationError(`${context} must be a resolved model metadata object.`);
	}
	if (Object.getOwnPropertySymbols(model).length) {
		throw new ActiveTsConfigurationError(`${context} cannot contain symbol fields.`);
	}
	const snapshot: Record<string, unknown> = Object.create(null);
	for (const key of Object.getOwnPropertyNames(model)) {
		const descriptor = Object.getOwnPropertyDescriptor(model, key);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsConfigurationError(`${context}.${key} must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsConfigurationError(`${context}.${key} must be enumerable.`);
		}
		defineDataProperty(snapshot, key, descriptor.value, { enumerable: true, configurable: true, writable: true });
	}
	assertSafeSchemaIdentifier(snapshot.name, `${context}.name`);
	const idField = assertSafeTopLevelField(snapshot.idField, `${context}.idField`);
	const indexes = snapshotStoreIndexes(snapshot.indexes, `${context}.indexes`);
	defineDataProperty(snapshot, 'indexes', indexes, {
		enumerable: true,
		configurable: true,
		writable: true
	});
	const datastore = validateDatastoreUnindexedMetadata(
		snapshot.name as string,
		idField,
		indexes,
		snapshotDatastoreMeta(snapshot.datastore, `${context}.datastore`)
	);
	if (datastore !== undefined || Object.prototype.hasOwnProperty.call(snapshot, 'datastore')) {
		defineDataProperty(snapshot, 'datastore', datastore, {
			enumerable: true,
			configurable: true,
			writable: true
		});
	}
	defineDataProperty(snapshot, 'searchIndexes', snapshotSearchIndexes(snapshot.searchIndexes, `${context}.searchIndexes`, idField), {
		enumerable: true,
		configurable: true,
		writable: true
	});
	defineDataProperty(snapshot, 'relations', snapshotMapMetadata(snapshot.relations, `${context}.relations`), {
		enumerable: true,
		configurable: true,
		writable: true
	});
	defineDataProperty(snapshot, 'views', snapshotMapMetadata(snapshot.views, `${context}.views`), {
		enumerable: true,
		configurable: true,
		writable: true
	});
	defineDataProperty(snapshot, 'policies', snapshotMapMetadata(snapshot.policies, `${context}.policies`), {
		enumerable: true,
		configurable: true,
		writable: true
	});
	defineDataProperty(snapshot, 'scopes', snapshotMapMetadata(snapshot.scopes, `${context}.scopes`), {
		enumerable: true,
		configurable: true,
		writable: true
	});
	const fieldCodecs = snapshotFieldCodecs(snapshot.fieldCodecs, `${context}.fieldCodecs`);
	const fieldTypes = snapshotFieldTypes(snapshot.fieldTypes, `${context}.fieldTypes`);
	validateModelFieldTransformMetadata(snapshot.name as string, idField, fieldCodecs, fieldTypes);
	defineDataProperty(snapshot, 'fieldCodecs', fieldCodecs, {
		enumerable: true,
		configurable: true,
		writable: true
	});
	defineDataProperty(snapshot, 'fieldTypes', fieldTypes, {
		enumerable: true,
		configurable: true,
		writable: true
	});
	assertPlainMetadataObject(snapshot.hooks, `${context}.hooks`);
	return snapshot as ResolvedModelMeta;
}

export function snapshotSearchAdapterModel(
	model: ResolvedModelMeta,
	context: string,
	adapter?: string
): ResolvedModelMeta {
	const snapshot = snapshotAdapterModel(model, context);
	const safeAdapter = adapter === undefined ? undefined : assertSafeSchemaIdentifier(adapter, `${context}.search adapter`);
	const searchIndexes = snapshotSearchIndexes(snapshot.searchIndexes, `${context}.searchIndexes`, snapshot.idField);
	for (let index = 0; index < searchIndexes.length; index++) {
		const searchIndex = searchIndexes[index];
		if (safeAdapter !== undefined && searchIndex.adapter && searchIndex.adapter !== safeAdapter) continue;
		validateSearchIndexProjectionWithDatastoreAncestorFields(searchIndex, snapshot.idField, snapshot.datastore);
	}
	defineDataProperty(snapshot as unknown as Record<string, unknown>, 'searchIndexes', searchIndexes, {
		enumerable: true,
		configurable: true,
		writable: true
	});
	return snapshot;
}

function snapshotStoreIndexes(indexes: unknown, context: string): IndexMeta[] {
	if (!Array.isArray(indexes)) {
		throw new ActiveTsConfigurationError(`${context} must be an array.`);
	}
	const items = snapshotArrayInput(indexes, context);
	const snapshot: IndexMeta[] = [];
	for (let position = 0; position < items.length; position++) {
		snapshot[position] = snapshotStoreIndex(items[position], `${context}[${position}]`);
	}
	return snapshot;
}

function snapshotStoreIndex(index: unknown, context: string): IndexMeta {
	if (!index || typeof index !== 'object' || Array.isArray(index)) {
		throw new ActiveTsConfigurationError(`${context} must be an index metadata object.`);
	}
	const prototype = Object.getPrototypeOf(index);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsConfigurationError(`${context} must be an index metadata object.`);
	}
	if (Object.getOwnPropertySymbols(index).length) {
		throw new ActiveTsConfigurationError(`${context} cannot contain symbol fields.`);
	}
	const record = index as Record<string, unknown>;
	assertKnownMetadataKeys(record, STORE_INDEX_KEYS, context);
	const name = assertSafeSchemaIdentifier(ownMetadataValue(record, 'name', context), `${context}.name`);
	const fields = ownMetadataValue(record, 'fields', context);
	const directions = ownMetadataValue(record, 'directions', context);
	const unique = ownMetadataValue(record, 'unique', context);
	if (!Array.isArray(fields) || !fields.length) {
		throw new ActiveTsConfigurationError(`${context}.fields must be a non-empty array.`);
	}
	if (unique !== undefined && typeof unique !== 'boolean') {
		throw new ActiveTsConfigurationError(`${context}.unique must be a boolean.`);
	}
	const rawFields = snapshotArrayInput(fields, `${context}.fields`);
	const safeFields: string[] = [];
	for (let position = 0; position < rawFields.length; position++) {
		safeFields[position] = assertSafeFieldPath(rawFields[position], `${context}.fields[${position}]`);
	}
	const safeDirections = snapshotStoreIndexDirections(directions, safeFields.length, `${context}.directions`);
	return {
		name,
		fields: safeFields,
		...(safeDirections === undefined ? {} : { directions: safeDirections }),
		...(unique === undefined ? {} : { unique })
	};
}

function snapshotStoreIndexDirections(directions: unknown, fieldCount: number, context: string) {
	if (directions === undefined) return undefined;
	if (!Array.isArray(directions) || directions.length !== fieldCount) {
		throw new ActiveTsConfigurationError(`${context} must be an array with one direction per index field.`);
	}
	const rawDirections = snapshotArrayInput(directions, context);
	const safeDirections: Array<'asc' | 'desc'> = [];
	for (let position = 0; position < rawDirections.length; position++) {
		const direction = rawDirections[position];
		if (direction !== 'asc' && direction !== 'desc') {
			throw new ActiveTsConfigurationError(`${context}[${position}] must be "asc" or "desc".`);
		}
		safeDirections[position] = direction;
	}
	return safeDirections;
}

function snapshotSearchIndexes(indexes: unknown, context: string, idField?: string): SearchIndexMeta[] {
	if (!Array.isArray(indexes)) {
		throw new ActiveTsConfigurationError(`${context} must be an array.`);
	}
	const items = snapshotArrayInput(indexes, context);
	const snapshot: SearchIndexMeta[] = [];
	for (let position = 0; position < items.length; position++) {
		snapshot[position] = snapshotSearchIndex(items[position], `${context}[${position}]`, idField);
	}
	return snapshot;
}

function snapshotSearchIndex(index: unknown, context: string, idField?: string): SearchIndexMeta {
	if (!index || typeof index !== 'object' || Array.isArray(index)) {
		throw new ActiveTsConfigurationError(`${context} must be a search index metadata object.`);
	}
	const prototype = Object.getPrototypeOf(index);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsConfigurationError(`${context} must be a search index metadata object.`);
	}
	if (Object.getOwnPropertySymbols(index).length) {
		throw new ActiveTsConfigurationError(`${context} cannot contain symbol fields.`);
	}
	const record = index as Record<string, unknown>;
	assertKnownMetadataKeys(record, SEARCH_INDEX_KEYS, context);
	const name = assertSafeSchemaIdentifier(ownMetadataValue(record, 'name', context), `${context}.name`);
	const adapter = ownMetadataValue(record, 'adapter', context);
	const safeAdapter = adapter === undefined
		? undefined
		: assertSafeSchemaIdentifier(adapter, `${context}.adapter`);
	const fields = ownMetadataValue(record, 'fields', context);
	if (!Array.isArray(fields) || !fields.length) {
		throw new ActiveTsConfigurationError(`${context}.fields must be a non-empty array.`);
	}
	const rawFields = snapshotArrayInput(fields, `${context}.fields`);
	const safeFields: string[] = [];
	for (let position = 0; position < rawFields.length; position++) {
		safeFields[position] = assertSafeFieldPath(rawFields[position], `${context}.fields[${position}]`);
	}
	assertNoOverlappingFieldPaths(safeFields, `${context}.fields`);
	if (idField !== undefined) {
		const fieldsWithId = [idField];
		for (let position = 0; position < safeFields.length; position++) {
			fieldsWithId[fieldsWithId.length] = safeFields[position];
		}
		assertNoOverlappingFieldPaths(fieldsWithId, `${context}.fields`);
	}
	return safeAdapter === undefined
		? { name, fields: safeFields }
		: { name, adapter: safeAdapter, fields: safeFields };
}

function snapshotDatastoreMeta(datastore: unknown, context: string): DatastoreModelMeta | undefined {
	if (datastore === undefined) return undefined;
	if (!datastore || typeof datastore !== 'object' || Array.isArray(datastore)) {
		throw new ActiveTsConfigurationError(`${context} must be a datastore metadata object.`);
	}
	const prototype = Object.getPrototypeOf(datastore);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsConfigurationError(`${context} must be a datastore metadata object.`);
	}
	if (Object.getOwnPropertySymbols(datastore).length) {
		throw new ActiveTsConfigurationError(`${context} cannot contain symbol fields.`);
	}
	const record = datastore as Record<string, unknown>;
	assertKnownMetadataKeys(record, DATASTORE_KEYS, context);
	const ancestor = ownMetadataValue(record, 'ancestor', context);
	if (ancestor !== undefined && typeof ancestor !== 'function') {
		throw new ActiveTsConfigurationError(`${context}.ancestor must be a function.`);
	}
	const ancestorFields = ownMetadataValue(record, 'ancestorFields', context);
	const unindexed = ownMetadataValue(record, 'unindexed', context);
	const snapshot: DatastoreModelMeta = {};
	if (ancestor !== undefined) snapshot.ancestor = ancestor as DatastoreModelMeta['ancestor'];
	if (ancestorFields !== undefined) {
		snapshot.ancestorFields = snapshotDatastoreArray(ancestorFields, `${context}.ancestorFields`) as string[];
	}
	if (unindexed !== undefined) {
		snapshot.unindexed = snapshotDatastoreArray(unindexed, `${context}.unindexed`) as string[];
	}
	return snapshot;
}

function snapshotDatastoreArray(value: unknown, context: string) {
	if (!Array.isArray(value)) return value;
	return snapshotArrayInput(value, context);
}

function ownMetadataValue(record: Record<string, unknown>, key: string, context: string) {
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

function assertKnownMetadataKeys(record: Record<string, unknown>, allowed: readonly string[], context: string) {
	const allowedKeys = capturedSet(allowed);
	for (const property of Object.getOwnPropertyNames(record)) {
		if (!SET_HAS.call(allowedKeys, property)) {
			throw new ActiveTsConfigurationError(`${context} contains unknown option "${property}".`);
		}
	}
}

function snapshotMapMetadata(value: unknown, context: string) {
	if (!(value instanceof Map)) {
		throw new ActiveTsConfigurationError(`${context} must be a Map.`);
	}
	if (Object.getOwnPropertySymbols(value).length) {
		throw new ActiveTsConfigurationError(`${context} cannot contain symbol fields.`);
	}
	const snapshot = new Map<unknown, unknown>();
	for (const [key, entryValue] of MAP_ENTRIES.call(value)) {
		MAP_SET.call(snapshot, key, entryValue);
	}
	return snapshot;
}

function snapshotFieldTypes(value: unknown, context: string): Map<string, FieldType> {
	const entries = snapshotMapMetadata(value, context);
	const safe = new Map<string, FieldType>();
	for (const [field, type] of MAP_ENTRIES.call(entries)) {
		const safeField = assertSafeFieldPath(field, `${context} key`);
		if (!SET_HAS.call(FIELD_TYPES, type as FieldType)) {
			throw new ActiveTsConfigurationError(`${context}.${safeField} must be a valid field type.`);
		}
		MAP_SET.call(safe, safeField, type as FieldType);
	}
	return safe;
}

function snapshotFieldCodecs(value: unknown, context: string): Map<string, FieldCodec> {
	const entries = snapshotMapMetadata(value, context);
	const safe = new Map<string, FieldCodec>();
	for (const [field, codec] of MAP_ENTRIES.call(entries)) {
		const safeField = assertSafeFieldPath(field, `${context} key`);
		MAP_SET.call(safe, safeField, snapshotFieldCodec(codec, `${context}.${safeField}`));
	}
	return safe;
}

function snapshotFieldCodec(codec: unknown, context: string): FieldCodec {
	if (!codec || typeof codec !== 'object' || Array.isArray(codec)) {
		throw new ActiveTsConfigurationError(`${context} must be a field codec object.`);
	}
	const prototype = Object.getPrototypeOf(codec);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsConfigurationError(`${context} must be a plain field codec object.`);
	}
	if (Object.getOwnPropertySymbols(codec).length) {
		throw new ActiveTsConfigurationError(`${context} cannot contain symbol fields.`);
	}
	const record = codec as Record<string, unknown>;
	assertKnownMetadataKeys(record, FIELD_CODEC_KEYS, context);
	const name = assertSafeSchemaIdentifier(ownMetadataValue(record, 'name', context), `${context}.name`);
	const encode = ownMetadataValue(record, 'encode', context);
	const decode = ownMetadataValue(record, 'decode', context);
	const encodeQuery = ownMetadataValue(record, 'encodeQuery', context);
	const queryOperators = ownMetadataValue(record, 'queryOperators', context);
	if (typeof encode !== 'function') throw new ActiveTsConfigurationError(`${context}.encode must be a function.`);
	if (typeof decode !== 'function') throw new ActiveTsConfigurationError(`${context}.decode must be a function.`);
	if (encodeQuery !== undefined && typeof encodeQuery !== 'function') {
		throw new ActiveTsConfigurationError(`${context}.encodeQuery must be a function.`);
	}
	const safeQueryOperators = snapshotFieldCodecQueryOperators(queryOperators, `${context}.queryOperators`);
	if (safeQueryOperators !== undefined && encodeQuery === undefined) {
		throw new ActiveTsConfigurationError(`${context}.queryOperators require ${context}.encodeQuery.`);
	}
	return Object.freeze({
		name,
		encode: encode as FieldCodec['encode'],
		decode: decode as FieldCodec['decode'],
		encodeQuery: encodeQuery as FieldCodec['encodeQuery'],
		queryOperators: safeQueryOperators
	});
}

function snapshotFieldCodecQueryOperators(value: unknown, context: string) {
	if (value === undefined) return undefined;
	const operators = snapshotArrayInput(value, context);
	const safe: FieldCodecQueryOperator[] = [];
	const seen = new Set<string>();
	for (const operator of operators) {
		if (typeof operator !== 'string' || !SET_HAS.call(FIELD_CODEC_QUERY_OPERATORS, operator as FieldCodecQueryOperator)) {
			throw new ActiveTsConfigurationError(`${context} contains unsupported operator.`);
		}
		if (SET_HAS.call(seen, operator)) {
			throw new ActiveTsConfigurationError(`${context} contains duplicate operator "${operator}".`);
		}
		SET_ADD.call(seen, operator);
		safe[safe.length] = operator as FieldCodecQueryOperator;
	}
	return Object.freeze(safe);
}

function assertPlainMetadataObject(value: unknown, context: string) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ActiveTsConfigurationError(`${context} must be a plain object.`);
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsConfigurationError(`${context} must be a plain object.`);
	}
}
