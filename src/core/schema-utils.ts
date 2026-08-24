import { ActiveTsConfigurationError } from './errors.js';
import {
	assertDenseArrayItems,
	assertSafeFieldPath,
	assertSafeSchemaIdentifier,
	assertSafeTopLevelField,
	defineDataProperty,
	isReservedFieldName
} from './safe-keys.js';
import { assertNoOverlappingFieldPaths } from './query-utils.js';
import { SET_ADD, SET_HAS } from './collection-intrinsics.js';
import {
	OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
	OBJECT_GET_OWN_PROPERTY_NAMES,
	OBJECT_GET_OWN_PROPERTY_SYMBOLS,
	OBJECT_GET_PROTOTYPE_OF,
	OBJECT_HAS_OWN,
	OBJECT_KEYS
} from './object-intrinsics.js';
import type { ResolvedModelMeta, SchemaChange, SchemaPlan } from './types.js';

const SCHEMA_PLAN_KEYS = ['adapter', 'route', 'changes', 'status', 'note'] as const;
const COLLECTION_CHANGE_KEYS = ['type', 'target'] as const;
const INDEX_CHANGE_KEYS = ['type', 'target', 'name', 'fields', 'directions', 'unique', 'ancestor'] as const;
const SEARCH_INDEX_CHANGE_KEYS = ['type', 'target', 'name', 'fields'] as const;
const STORE_SCHEMA_INDEX_KEYS = ['name', 'fields', 'directions', 'unique'] as const;
const SEARCH_SCHEMA_INDEX_KEYS = ['name', 'fields', 'adapter'] as const;

export function datastoreSchemaAncestorModes(hasAncestor: boolean): readonly boolean[] {
	return hasAncestor ? [true, false] : [false];
}

export function normalizeSchemaModels(models: unknown, context: string): ResolvedModelMeta[] {
	if (!Array.isArray(models)) {
		throw new ActiveTsConfigurationError(`${context} must be an array.`);
	}
	const safeModels = snapshotSchemaArray<ResolvedModelMeta>(models, context);
	const normalized: ResolvedModelMeta[] = [];
	for (let index = 0; index < safeModels.length; index++) {
		normalized[index] = snapshotSchemaModel(safeModels[index], `${context}[${index}]`);
	}
	return normalized;
}

function snapshotSchemaModel(model: unknown, context: string): ResolvedModelMeta {
	if (!model || typeof model !== 'object' || Array.isArray(model)) {
		throw new ActiveTsConfigurationError(`${context} must be a resolved model metadata object.`);
	}
	const record = model as Record<string, unknown>;
	assertNoSymbolFields(record, context);
	assertOwnEnumerableDataProperties(record, context);
	assertNoReservedSchemaModelFields(record, context);
	const snapshot: Record<string, unknown> = Object.create(null);
	for (const key of OBJECT_GET_OWN_PROPERTY_NAMES(record)) {
		const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(record, key)!;
		defineDataProperty(snapshot, key, descriptor.value, { enumerable: true, configurable: true, writable: true });
	}
	defineDataProperty(snapshot, 'name', assertSafeSchemaIdentifier(ownValue(record, 'name', context), `${context}.name`), {
		enumerable: true,
		configurable: true,
		writable: true
	});
	const idField = assertSafeTopLevelField(ownValue(record, 'idField', context), `${context}.idField`);
	defineDataProperty(snapshot, 'idField', idField, {
		enumerable: true,
		configurable: true,
		writable: true
	});
	const indexes = ownValue(record, 'indexes', context);
	if (!Array.isArray(indexes)) {
		throw new ActiveTsConfigurationError(`${context}.indexes must be an array.`);
	}
	const safeIndexes = snapshotSchemaArray(indexes, `${context}.indexes`);
	defineDataProperty(
		snapshot,
		'indexes',
		snapshotSchemaStoreIndexes(safeIndexes, `${context}.indexes`),
		{ enumerable: true, configurable: true, writable: true }
	);
	const searchIndexes = ownValue(record, 'searchIndexes', context);
	if (!Array.isArray(searchIndexes)) {
		throw new ActiveTsConfigurationError(`${context}.searchIndexes must be an array.`);
	}
	const safeSearchIndexes = snapshotSchemaArray(searchIndexes, `${context}.searchIndexes`);
	defineDataProperty(
		snapshot,
		'searchIndexes',
		snapshotSchemaSearchIndexes(safeSearchIndexes, `${context}.searchIndexes`, idField),
		{ enumerable: true, configurable: true, writable: true }
	);
	return snapshot as ResolvedModelMeta;
}

function snapshotSchemaStoreIndexes(indexes: unknown[], context: string) {
	const normalized: ReturnType<typeof snapshotSchemaStoreIndex>[] = [];
	for (let index = 0; index < indexes.length; index++) {
		normalized[index] = snapshotSchemaStoreIndex(indexes[index], `${context}[${index}]`);
	}
	return normalized;
}

function snapshotSchemaSearchIndexes(indexes: unknown[], context: string, idField: string) {
	const normalized: ReturnType<typeof snapshotSchemaSearchIndex>[] = [];
	for (let index = 0; index < indexes.length; index++) {
		normalized[index] = snapshotSchemaSearchIndex(indexes[index], `${context}[${index}]`, idField);
	}
	return normalized;
}

function assertNoReservedSchemaModelFields(record: Record<string, unknown>, context: string) {
	for (const property of OBJECT_GET_OWN_PROPERTY_NAMES(record)) {
		if (!isReservedFieldName(property)) continue;
		throw new ActiveTsConfigurationError(
			`${context} cannot contain reserved metadata field "${property}". Use symbol metadata instead of "__" properties.`
		);
	}
}

function snapshotSchemaStoreIndex(index: unknown, context: string) {
	const base = snapshotSchemaIndex(index, context);
	const record = base.record;
	assertKnownKeys(record, STORE_SCHEMA_INDEX_KEYS, context);
	const directions = ownValue(record, 'directions', context);
	const unique = ownValue(record, 'unique', context);
	if (unique !== undefined && typeof unique !== 'boolean') {
		throw new ActiveTsConfigurationError(`${context}.unique must be a boolean.`);
	}
	const safeDirections = normalizeIndexDirections(directions, base.index.fields.length, `${context}.directions`);
	return {
		...base.index,
		...(safeDirections === undefined ? {} : { directions: safeDirections }),
		...(unique === undefined ? {} : { unique })
	};
}

function snapshotSchemaSearchIndex(index: unknown, context: string, idField: string) {
	const base = snapshotSchemaIndex(index, context);
	const record = base.record;
	assertKnownKeys(record, SEARCH_SCHEMA_INDEX_KEYS, context);
	assertNoOverlappingFieldPaths(base.index.fields, `${context}.fields`);
	assertNoOverlappingFieldPaths([idField, ...base.index.fields], `${context}.fields`);
	const adapter = ownValue(record, 'adapter', context);
	return adapter === undefined
		? base.index
		: { ...base.index, adapter: assertSafeSchemaIdentifier(adapter, `${context}.adapter`) };
}

function snapshotSchemaIndex(index: unknown, context: string) {
	if (!index || typeof index !== 'object' || Array.isArray(index)) {
		throw new ActiveTsConfigurationError(`${context} must be an index metadata object.`);
	}
	const record = index as Record<string, unknown>;
	assertNoSymbolFields(record, context);
	assertOwnEnumerableDataProperties(record, context);
	const name = assertSafeSchemaIdentifier(ownValue(record, 'name', context), `${context}.name`);
	const fields = ownValue(record, 'fields', context);
	if (!Array.isArray(fields) || !fields.length) {
		throw new ActiveTsConfigurationError(`${context}.fields must be a non-empty array.`);
	}
	const safeFields = snapshotSchemaArray(fields, `${context}.fields`);
	return {
		record,
		index: {
			name,
			fields: snapshotSchemaIndexFields(safeFields, `${context}.fields`)
		}
	};
}

function snapshotSchemaIndexFields(fields: unknown[], context: string) {
	const normalized: string[] = [];
	for (let index = 0; index < fields.length; index++) {
		normalized[index] = assertSafeFieldPath(fields[index], `${context}[${index}]`);
	}
	return normalized;
}

function normalizeIndexDirections(directions: unknown, fieldCount: number, context: string) {
	if (directions === undefined) return undefined;
	if (!Array.isArray(directions) || directions.length !== fieldCount) {
		throw new ActiveTsConfigurationError(`${context} must be an array with one direction per index field.`);
	}
	const values = snapshotSchemaArray(directions, context);
	const normalized: Array<'asc' | 'desc'> = [];
	for (let index = 0; index < values.length; index++) {
		const direction = values[index];
		if (direction !== 'asc' && direction !== 'desc') {
			throw new ActiveTsConfigurationError(`${context}[${index}] must be "asc" or "desc".`);
		}
		normalized[index] = direction;
	}
	return normalized;
}

export function normalizeSchemaPlan(plan: unknown, context: string): SchemaPlan {
	const record = assertPlainObject(plan, context);
	assertKnownKeys(record, SCHEMA_PLAN_KEYS, context);
	const adapter = assertSafeSchemaIdentifier(ownValue(record, 'adapter', context), `${context}.adapter`);
	const route = ownValue(record, 'route', context);
	const rawChanges = ownValue(record, 'changes', context);
	if (!Array.isArray(rawChanges)) {
		throw new ActiveTsConfigurationError(`${context}.changes must be an array.`);
	}
	const changes = snapshotSchemaArray(rawChanges, `${context}.changes`);
	const status = ownValue(record, 'status', context);
	if (status !== undefined && status !== 'planned' && status !== 'applied' && status !== 'manual') {
		throw new ActiveTsConfigurationError(`${context}.status must be "planned", "applied", or "manual".`);
	}
	const note = ownValue(record, 'note', context);
	if (note !== undefined && typeof note !== 'string') {
		throw new ActiveTsConfigurationError(`${context}.note must be a string.`);
	}
	return {
		adapter,
		...(route === undefined ? {} : { route: assertSafeSchemaIdentifier(route, `${context}.route`) }),
		changes: normalizeSchemaChanges(changes, `${context}.changes`),
		...(status === undefined ? {} : { status }),
		...(note === undefined ? {} : { note })
	};
}

function normalizeSchemaChanges(changes: unknown[], context: string) {
	const normalized: SchemaChange[] = [];
	const seen = new Set<string>();
	for (let index = 0; index < changes.length; index++) {
		const change = normalizeSchemaChange(changes[index], `${context}[${index}]`);
		const key = schemaChangeIdentity(change);
		if (SET_HAS.call(seen, key)) {
			throw new ActiveTsConfigurationError(
				`${context}[${index}] duplicates schema change "${key}".`
			);
		}
		SET_ADD.call(seen, key);
		normalized[index] = change;
	}
	return normalized;
}

function schemaChangeIdentity(change: SchemaChange) {
	if (change.type === 'create-collection') return `${change.type}:${change.target}`;
	if (change.type === 'create-index' && change.ancestor !== undefined) {
		return `${change.type}:${change.target}:${change.name}:ancestor:${String(change.ancestor)}`;
	}
	return `${change.type}:${change.target}:${change.name}`;
}

function normalizeSchemaChange(change: unknown, context: string): SchemaChange {
	const record = assertPlainObject(change, context);
	const type = ownValue(record, 'type', context);
	if (type !== 'create-collection' && type !== 'create-index' && type !== 'create-search-index') {
		throw new ActiveTsConfigurationError(`${context}.type must be a supported schema change type.`);
	}
	assertKnownKeys(
		record,
		type === 'create-collection'
			? COLLECTION_CHANGE_KEYS
			: type === 'create-search-index'
				? SEARCH_INDEX_CHANGE_KEYS
				: INDEX_CHANGE_KEYS,
		context
	);
	const target = assertSafeSchemaIdentifier(ownValue(record, 'target', context), `${context}.target`);
	if (type === 'create-collection') return { type, target };
	const name = assertSafeSchemaIdentifier(ownValue(record, 'name', context), `${context}.name`);
	const rawFields = ownValue(record, 'fields', context);
	if (!Array.isArray(rawFields) || !rawFields.length) {
		throw new ActiveTsConfigurationError(`${context}.fields must be a non-empty array.`);
	}
	const rawFieldValues = snapshotSchemaArray(rawFields, `${context}.fields`);
	const fields = snapshotSchemaIndexFields(rawFieldValues, `${context}.fields`);
	if (type === 'create-search-index') {
		assertNoOverlappingFieldPaths(fields, `${context}.fields`);
		return { type, target, name, fields };
	}
	const unique = ownValue(record, 'unique', context);
	if (unique !== undefined && typeof unique !== 'boolean') {
		throw new ActiveTsConfigurationError(`${context}.unique must be a boolean.`);
	}
	const ancestor = ownValue(record, 'ancestor', context);
	if (ancestor !== undefined && typeof ancestor !== 'boolean') {
		throw new ActiveTsConfigurationError(`${context}.ancestor must be a boolean.`);
	}
	const directions = normalizeIndexDirections(ownValue(record, 'directions', context), fields.length, `${context}.directions`);
	return {
		type,
		target,
		name,
		fields,
		...(directions === undefined ? {} : { directions }),
		...(unique === undefined ? {} : { unique }),
		...(ancestor === undefined ? {} : { ancestor })
	};
}

function assertPlainObject(value: unknown, context: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ActiveTsConfigurationError(`${context} must be a plain object.`);
	}
	const prototype = OBJECT_GET_PROTOTYPE_OF(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsConfigurationError(`${context} must be a plain object.`);
	}
	const record = value as Record<string, unknown>;
	assertNoSymbolFields(record, context);
	assertOwnEnumerableDataProperties(record, context);
	return record;
}

function assertNoSymbolFields(record: Record<string, unknown>, context: string) {
	if (OBJECT_GET_OWN_PROPERTY_SYMBOLS(record).length) {
		throw new ActiveTsConfigurationError(`${context} cannot contain symbol fields.`);
	}
}

function assertKnownKeys(record: Record<string, unknown>, allowed: readonly string[], context: string) {
	const allowedKeys = stringSet(allowed);
	for (const property of OBJECT_KEYS(record)) {
		if (!SET_HAS.call(allowedKeys, property)) {
			throw new ActiveTsConfigurationError(`${context} contains unknown option "${property}".`);
		}
	}
}

function stringSet(values: readonly string[]) {
	const set = new Set<string>();
	for (const value of values) SET_ADD.call(set, value);
	return set;
}

function snapshotSchemaArray<T = unknown>(value: unknown[], context: string): T[] {
	if (OBJECT_GET_OWN_PROPERTY_SYMBOLS(value).length) {
		throw new ActiveTsConfigurationError(`${context} cannot contain symbol fields.`);
	}
	assertDenseArrayItems(value, context);
	const items: T[] = [];
	for (let index = 0; index < value.length; index++) {
		const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, String(index));
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsConfigurationError(`${context}[${index}] must be a data property.`);
		}
		items.push(descriptor.value as T);
	}
	return items;
}

function ownValue(record: Record<string, unknown>, key: string, context: string) {
	if (!OBJECT_HAS_OWN(record, key)) return undefined;
	const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(record, key);
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsConfigurationError(`${context}.${key} must be a data property.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsConfigurationError(`${context}.${key} must be enumerable.`);
	}
	return descriptor.value;
}

function assertOwnEnumerableDataProperties(record: Record<string, unknown>, context: string) {
	for (const key of OBJECT_GET_OWN_PROPERTY_NAMES(record)) {
		const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(record, key);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsConfigurationError(`${context}.${key} must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsConfigurationError(`${context}.${key} must be enumerable.`);
		}
	}
}
