import { ActiveTsConfigurationError } from './errors.js';
import { MAP_HAS, MAP_KEYS, MAP_SIZE } from './collection-intrinsics.js';
import { assertNoOverlappingFieldPaths } from './query-utils.js';
import { assertDenseArrayItems, assertSafeFieldPath } from './safe-keys.js';
import type { DatastoreModelMeta, FieldCodec, FieldType, IndexMeta, SearchIndexMeta } from './types.js';

export function validateModelFieldTransformMetadata(
	modelName: string,
	idField: string,
	fieldCodecs: Map<string, FieldCodec>,
	fieldTypes: Map<string, FieldType>
) {
	validateIdentityFieldCodecs(modelName, idField, fieldCodecs);
	validateIdentityFieldTypes(modelName, idField, fieldTypes);
	validateFieldTransformPaths(modelName, fieldCodecs, fieldTypes);
}

export function validateSearchIndexProjection(index: SearchIndexMeta, idField: string): SearchIndexMeta {
	assertNoOverlappingFieldPaths([idField, ...index.fields], `search index "${index.name}" fields`);
	return index;
}

export function validateSearchIndexProjectionWithDatastoreAncestorFields(
	index: SearchIndexMeta,
	idField: string,
	datastore: DatastoreModelMeta | undefined
): SearchIndexMeta {
	validateSearchIndexProjection(index, idField);
	if (datastore?.ancestor) {
		if (datastore.ancestorFields === undefined) {
			throw new ActiveTsConfigurationError(
				`Datastore ancestor model search index "${index.name}" must declare datastore.ancestorFields so search hits can preserve ancestor identity. Use [] only when the ancestor resolver does not need payload fields.`
			);
		}
		assertNoOverlappingFieldPaths(
			[idField, ...index.fields, ...datastore.ancestorFields],
			`search index "${index.name}" projection fields`
		);
	}
	return index;
}

export function validateDatastoreUnindexedMetadata<TData>(
	modelName: string,
	idField: string,
	indexes: readonly IndexMeta[],
	datastore: DatastoreModelMeta<TData> | undefined
): DatastoreModelMeta<TData> | undefined {
	if (datastore === undefined) return datastore;
	if (!datastore || typeof datastore !== 'object' || Array.isArray(datastore)) {
		throw new ActiveTsConfigurationError(`Datastore metadata for ${modelName} must be an object.`);
	}
	const rawAncestorFields = ownDatastoreMetaValue(datastore as Record<string, unknown>, 'ancestorFields', modelName);
	if (rawAncestorFields !== undefined) {
		if (!Array.isArray(rawAncestorFields)) {
			throw new ActiveTsConfigurationError(`Datastore ancestorFields for ${modelName} must be an array.`);
		}
		if (Object.getOwnPropertySymbols(rawAncestorFields).length) {
			throw new ActiveTsConfigurationError(`Datastore ancestorFields for ${modelName} cannot contain symbol fields.`);
		}
		assertDenseArrayItems(rawAncestorFields, `Datastore ancestorFields for ${modelName}`);
		const safeAncestorFields: string[] = [];
		for (let index = 0; index < rawAncestorFields.length; index++) {
			safeAncestorFields[index] = assertSafeFieldPath(rawAncestorFields[index], `Datastore ancestor field for ${modelName}`);
		}
		assertNoOverlappingFieldPaths([idField, ...safeAncestorFields], `Datastore ancestorFields for ${modelName}`);
	}
	const rawFields = ownDatastoreMetaValue(datastore as Record<string, unknown>, 'unindexed', modelName);
	if (rawFields === undefined) return datastore;
	if (!Array.isArray(rawFields) || !rawFields.length) {
		throw new ActiveTsConfigurationError(`Datastore unindexed fields for ${modelName} must be a non-empty array.`);
	}
	if (Object.getOwnPropertySymbols(rawFields).length) {
		throw new ActiveTsConfigurationError(`Datastore unindexed fields for ${modelName} cannot contain symbol fields.`);
	}
	assertDenseArrayItems(rawFields, `Datastore unindexed fields for ${modelName}`);
	for (let index = 0; index < rawFields.length; index++) {
		const field = assertSafeFieldPath(rawFields[index], `Datastore unindexed field for ${modelName}`);
		if (fieldPathsOverlap(field, idField)) {
			throw new ActiveTsConfigurationError(
				`Datastore unindexed field "${field}" for ${modelName} cannot overlap id field "${idField}". Datastore id lookups require the id field to remain indexed.`
			);
		}
		for (let indexIndex = 0; indexIndex < indexes.length; indexIndex++) {
			const schemaIndex = indexes[indexIndex];
			for (let fieldIndex = 0; fieldIndex < schemaIndex.fields.length; fieldIndex++) {
				const indexedField = schemaIndex.fields[fieldIndex];
				if (!fieldPathsOverlap(field, indexedField)) continue;
				throw new ActiveTsConfigurationError(
					`Datastore unindexed field "${field}" for ${modelName} overlaps indexed field "${indexedField}" in index "${schemaIndex.name}". Remove the field from datastore.unindexed or from the index.`
				);
			}
		}
	}
	return datastore;
}

function validateIdentityFieldCodecs(modelName: string, idField: string, fieldCodecs: Map<string, FieldCodec>) {
	if (!MAP_SIZE.call(fieldCodecs)) return;
	if (MAP_HAS.call(fieldCodecs, idField)) {
		throw new ActiveTsConfigurationError(
			`Field codec cannot be registered on id field "${idField}" for ${modelName}. Id fields use the active-ts entity id codec.`
		);
	}
	assertNoOverlappingFieldPaths([idField, ...MAP_KEYS.call(fieldCodecs)], `field codec paths for ${modelName}`);
}

function validateIdentityFieldTypes(modelName: string, idField: string, fieldTypes: Map<string, FieldType>) {
	if (!MAP_SIZE.call(fieldTypes)) return;
	if (MAP_HAS.call(fieldTypes, idField)) {
		throw new ActiveTsConfigurationError(
			`Field type cannot be registered on id field "${idField}" for ${modelName}. Id fields are limited to string or safe-integer entity ids.`
		);
	}
	assertNoOverlappingFieldPaths([idField, ...MAP_KEYS.call(fieldTypes)], `field type paths for ${modelName}`);
}

function validateFieldTransformPaths(
	modelName: string,
	fieldCodecs: Map<string, FieldCodec>,
	fieldTypes: Map<string, FieldType>
) {
	if (!MAP_SIZE.call(fieldCodecs) || !MAP_SIZE.call(fieldTypes)) return;
	assertNoOverlappingFieldPaths(
		[...MAP_KEYS.call(fieldCodecs), ...MAP_KEYS.call(fieldTypes)],
		`field transform paths for ${modelName}`
	);
}

function fieldPathsOverlap(left: string, right: string) {
	return left === right || left.startsWith(`${right}.`) || right.startsWith(`${left}.`);
}

function ownDatastoreMetaValue(record: Record<string, unknown>, key: string, modelName: string) {
	if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(record, key);
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsConfigurationError(`Datastore metadata for ${modelName}.${key} must be a data property.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsConfigurationError(`Datastore metadata for ${modelName}.${key} must be enumerable.`);
	}
	return descriptor.value;
}
