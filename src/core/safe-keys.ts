import { ActiveTsValidationError } from './errors.js';
import type { EntityId } from './types.js';
import { dateTime } from './date-intrinsics.js';
import {
	SET_ADD,
	SET_HAS,
	WEAKMAP_GET,
	WEAKMAP_HAS,
	WEAKMAP_SET,
	WEAKSET_ADD,
	WEAKSET_DELETE,
	WEAKSET_HAS
} from './collection-intrinsics.js';
import {
	OBJECT_ENTRIES,
	OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
	OBJECT_GET_OWN_PROPERTY_NAMES,
	OBJECT_GET_OWN_PROPERTY_SYMBOLS,
	OBJECT_GET_PROTOTYPE_OF,
	OBJECT_HAS_OWN,
	OBJECT_IS_EXTENSIBLE,
	OBJECT_KEYS
} from './object-intrinsics.js';

export const ACTIVE_TS_ENTITY_KEY: unique symbol = Symbol.for('active-ts.entity-key') as any;

const RESERVED_FIELD_NAMES = stringSet(['__proto__', 'constructor', 'prototype']);
const SAFE_SCHEMA_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_-]*$/;
const MAX_SCHEMA_IDENTIFIER_BYTES = 63;
const MAX_ENTITY_ID_BYTES = 1024;
const MAX_CACHE_KEY_BYTES = 4096;
const ARRAY_METHOD_SHADOW_FIELDS = arrayMethodShadowFields();

function stringSet(values: readonly string[]) {
	const set = new Set<string>();
	for (const value of values) SET_ADD.call(set, value);
	return set;
}

function arrayMethodShadowFields() {
	const set = new Set<string>();
	const names = OBJECT_GET_OWN_PROPERTY_NAMES(Array.prototype);
	for (let index = 0; index < names.length; index++) {
		const name = names[index];
		if (name === 'constructor') continue;
		if (typeof (Array.prototype as any)[name] === 'function') SET_ADD.call(set, name);
	}
	return set;
}

export function isReservedFieldName(field: unknown) {
	if (typeof field !== 'string') {
		throw new ActiveTsValidationError('field name must be a string.');
	}
	return field.startsWith('__') || SET_HAS.call(RESERVED_FIELD_NAMES, field);
}

export function assertSafeFieldPath(field: unknown, context = 'field'): string {
	if (typeof field !== 'string') {
		throw new ActiveTsValidationError(`${context} must be a string.`);
	}
	if (!field) {
		throw new ActiveTsValidationError(`Empty ${context} is not allowed.`);
	}
	if (field.includes('\0')) {
		throw new ActiveTsValidationError(`${context} must not contain null bytes.`);
	}
	const parts = field.split('.');
	for (const part of parts) {
		if (!part) {
			throw new ActiveTsValidationError(`Empty ${context} segment in "${field}" is not allowed.`);
		}
		if (isReservedFieldName(part)) {
			throw new ActiveTsValidationError(
				`Reserved ${context} "${field}" is not allowed. Use symbol metadata instead of "__" properties.`
			);
		}
	}
	return field;
}

export function assertSafeTopLevelField(field: unknown, context = 'field') {
	const safeField = assertSafeFieldPath(field, context);
	if (safeField.includes('.')) {
		throw new ActiveTsValidationError(`${context} "${field}" must be a top-level field.`);
	}
	return safeField;
}

export function assertSafeLimit(limit: number | undefined, context = 'limit') {
	if (limit === undefined) return limit;
	if (typeof limit !== 'number') {
		throw new ActiveTsValidationError(`${context} must be a positive safe integer.`);
	}
	if (!Number.isSafeInteger(limit) || limit <= 0) {
		throw new ActiveTsValidationError(`${context} "${limit}" must be a positive safe integer.`);
	}
	return limit;
}

export function assertSafeOffset(offset: number | undefined, context = 'offset') {
	if (offset === undefined) return offset;
	if (typeof offset !== 'number') {
		throw new ActiveTsValidationError(`${context} must be a non-negative safe integer.`);
	}
	if (!Number.isSafeInteger(offset) || offset < 0) {
		throw new ActiveTsValidationError(`${context} "${offset}" must be a non-negative safe integer.`);
	}
	return offset;
}

export function assertCompatibleQueryPagination(
	offset: number | undefined,
	cursor: string | undefined,
	context = 'Query pagination'
) {
	if (offset !== undefined && cursor !== undefined) {
		throw new ActiveTsValidationError(`${context} cannot combine offset() with cursor().`);
	}
}

export function assertSafeResultCount(count: unknown, context = 'result count'): number | undefined {
	if (count === undefined) return undefined;
	if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
		throw new ActiveTsValidationError(`${context} must be a non-negative safe integer.`);
	}
	return count;
}

export function assertSafeCursor(cursor: unknown, context = 'cursor') {
	if (cursor === undefined) return undefined;
	if (typeof cursor !== 'string') throw new ActiveTsValidationError(`${context} must be a string.`);
	if (cursor.length > 4096) throw new ActiveTsValidationError(`${context} is too long.`);
	if (cursor.includes('\0')) throw new ActiveTsValidationError(`${context} must not contain null bytes.`);
	return cursor;
}

export function assertSafeCacheKey(key: unknown, context = 'cache key') {
	if (typeof key !== 'string') throw new ActiveTsValidationError(`${context} must be a string.`);
	if (!key) throw new ActiveTsValidationError(`${context} cannot be empty.`);
	if (Buffer.byteLength(key, 'utf8') > MAX_CACHE_KEY_BYTES) {
		throw new ActiveTsValidationError(`${context} is too long.`);
	}
	if (key.includes('\0')) throw new ActiveTsValidationError(`${context} must not contain null bytes.`);
	return key;
}

export function assertSafeTtl(ttl: number | undefined, context = 'ttl') {
	if (ttl === undefined) return ttl;
	if (typeof ttl !== 'number') {
		throw new ActiveTsValidationError(`${context} must be a positive number and safe integer.`);
	}
	if (!Number.isSafeInteger(ttl) || ttl <= 0) {
		throw new ActiveTsValidationError(`${context} "${ttl}" must be a positive number and safe integer.`);
	}
	return ttl;
}

export function assertDenseArrayItems(array: readonly unknown[], context = 'array') {
	for (const property of OBJECT_GET_OWN_PROPERTY_NAMES(array)) {
		if (property === 'length') continue;
		if (!isArrayIndexProperty(property, array.length) && !SET_HAS.call(ARRAY_METHOD_SHADOW_FIELDS, property)) {
			throw new ActiveTsValidationError(`${context} cannot contain non-index array property "${property}".`);
		}
	}
	for (let index = 0; index < array.length; index++) {
		if (!OBJECT_HAS_OWN(array, index)) {
			throw new ActiveTsValidationError(`${context}[${index}] is missing. Sparse arrays are not allowed.`);
		}
		const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(array, String(index));
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsValidationError(`${context}[${index}] must be a data property. Accessor array items are not allowed.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsValidationError(`${context}[${index}] must be enumerable.`);
		}
	}
}

export function assertSafeEntityId(id: unknown, context = 'Entity id'): asserts id is EntityId {
	if (typeof id === 'string') {
		if (!id) throw new ActiveTsValidationError(`${context} cannot be an empty string.`);
		if (Buffer.byteLength(id, 'utf8') > MAX_ENTITY_ID_BYTES) {
			throw new ActiveTsValidationError(`${context} is too long.`);
		}
		if (id.includes('\0')) throw new ActiveTsValidationError(`${context} must not contain null bytes.`);
		return;
	}
	if (typeof id === 'number') {
		if (Object.is(id, -0)) {
			throw new ActiveTsValidationError(`${context} "-0" is not allowed. Use 0 or a string id.`);
		}
		if (!Number.isSafeInteger(id)) {
			throw new ActiveTsValidationError(`${context} "${String(id)}" must be a safe integer.`);
		}
		return;
	}
	throw new ActiveTsValidationError(`${context} must be a string or safe integer.`);
}

export function assertSafeEntityIdArray(ids: unknown, context = 'Entity ids'): EntityId[] {
	if (!Array.isArray(ids)) {
		throw new ActiveTsValidationError(`${context} must be an array.`);
	}
	if (OBJECT_GET_OWN_PROPERTY_SYMBOLS(ids).length) {
		throw new ActiveTsValidationError(`${context} cannot contain symbol fields.`);
	}
	assertDenseArrayItems(ids, context);
	const safeIds: EntityId[] = [];
	for (let index = 0; index < ids.length; index++) {
		const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(ids, String(index));
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsValidationError(`${context}[${index}] must be a data property.`);
		}
		assertSafeEntityId(descriptor.value, `${context}[${index}]`);
		safeIds.push(descriptor.value);
	}
	return safeIds;
}

export function assertSafeSchemaIdentifier(name: unknown, context = 'schema identifier'): string {
	if (typeof name !== 'string') {
		throw new ActiveTsValidationError(`${context} must be a string.`);
	}
	if (!SAFE_SCHEMA_IDENTIFIER.test(name) || isReservedFieldName(name)) {
		throw new ActiveTsValidationError(
			`${context} "${name}" is not allowed. Use letters, numbers, "_" or "-", starting with a letter.`
		);
	}
	return name;
}

export function assertSafePhysicalIdentifierLength(name: string, context = 'schema identifier', maxBytes = MAX_SCHEMA_IDENTIFIER_BYTES) {
	if (Buffer.byteLength(name, 'utf8') > maxBytes) {
		throw new ActiveTsValidationError(`${context} "${name}" is too long.`);
	}
	return name;
}

export function assertDefinedCacheValue(value: unknown) {
	if (value === undefined) {
		throw new ActiveTsValidationError('Cache values cannot be undefined. Use null for an explicit cached empty value.');
	}
}

export function assertCacheableValue(value: unknown, path = '$', seen = new WeakSet<object>()) {
	assertDefinedCacheValue(value);
	assertSafeDataKeys(value, path);
	if (value === null || typeof value !== 'object') return;
	if (value instanceof Date) {
		throw new ActiveTsValidationError(`Cache values cannot contain Date at "${path}". Encode dates as strings.`);
	}
	if (value instanceof Uint8Array) {
		throw new ActiveTsValidationError(`Cache values cannot contain binary data at "${path}". Encode binary values first.`);
	}
	if (WEAKSET_HAS.call(seen, value)) return;
	WEAKSET_ADD.call(seen, value);
	try {
		if (Array.isArray(value)) {
			for (let index = 0; index < value.length; index++) {
				const item = dataPropertyValue(value, String(index), `${path}[${index}]`);
				if (item === undefined) {
					throw new ActiveTsValidationError(`Cache values cannot contain undefined at "${path}[${index}]".`);
				}
				assertCacheableValue(item, `${path}[${index}]`, seen);
			}
			return;
		}
		for (const [key, item] of OBJECT_ENTRIES(value as Record<string, unknown>)) {
			if (item === undefined) {
				throw new ActiveTsValidationError(`Cache values cannot contain undefined at "${path}.${key}".`);
			}
			assertCacheableValue(item, `${path}.${key}`, seen);
		}
	} finally {
		WEAKSET_DELETE.call(seen, value);
	}
}

export function assertSafeDataKeys(value: unknown, path = '$', seen = new WeakSet<object>()) {
	if (value === undefined) return;
	const valueType = typeof value;
	if (valueType === 'number' && !Number.isFinite(value)) {
		throw new ActiveTsValidationError(`Unsupported data number at "${path}". Use finite numbers.`);
	}
	if (valueType === 'function' || valueType === 'symbol' || valueType === 'bigint') {
		throw new ActiveTsValidationError(`Unsupported data value at "${path}". Use plain JSON-like data.`);
	}
	if (value === null || valueType !== 'object') return;
	if (value instanceof Date) {
		if (!Number.isFinite(dateTime(value))) {
			throw new ActiveTsValidationError(`Unsupported data date at "${path}". Use valid dates.`);
		}
		assertNoRuntimeBuiltInCustomProperties(value, path);
		return;
	}
	if (value instanceof Uint8Array) {
		assertNoRuntimeBuiltInCustomProperties(value, path, value.length);
		return;
	}
	if (value instanceof RegExp || value instanceof Map || value instanceof Set) {
		throw new ActiveTsValidationError(`Unsupported data value at "${path}". Use plain JSON-like data.`);
	}
	for (const symbol of OBJECT_GET_OWN_PROPERTY_SYMBOLS(value)) {
		if (symbol === ACTIVE_TS_ENTITY_KEY) {
			const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, symbol);
			if (!descriptor || !('value' in descriptor)) {
				throw new ActiveTsValidationError(
					`Unsupported data accessor at "${path}[active-ts.entity-key]". Use plain data properties.`
				);
			}
			if (descriptor.enumerable) {
				throw new ActiveTsValidationError(
					`Unsupported enumerable active-ts entity key metadata at "${path}". Use non-enumerable symbol metadata.`
				);
			}
			continue;
		}
		throw new ActiveTsValidationError(
			`Unsupported data symbol key at "${path}". Use string fields or active-ts metadata symbols.`
		);
	}
	if (WEAKSET_HAS.call(seen, value)) {
		throw new ActiveTsValidationError(`Circular data value at "${path}" is not allowed. Use plain JSON-like data.`);
	}
	WEAKSET_ADD.call(seen, value);

	try {
		if (Array.isArray(value)) {
			assertDenseOwnArray(value, path, 'Unsupported data value');
			for (let index = 0; index < value.length; index++) {
				const item = dataPropertyValue(value, String(index), `${path}[${index}]`);
				if (item === undefined) {
					throw new ActiveTsValidationError(`Unsupported data value at "${path}[${index}]". Use null or omit the field.`);
				}
				assertSafeDataKeys(item, `${path}[${index}]`, seen);
			}
			return;
		}

		const prototype = OBJECT_GET_PROTOTYPE_OF(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new ActiveTsValidationError(`Unsupported data object at "${path}". Use plain objects.`);
		}

		for (const key of OBJECT_GET_OWN_PROPERTY_NAMES(value)) {
			const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, key);
			if (!descriptor || !('value' in descriptor)) {
				throw new ActiveTsValidationError(`Unsupported data accessor at "${path}.${key}". Use plain data properties.`);
			}
			if (!descriptor.enumerable) {
				throw new ActiveTsValidationError(`Unsupported non-enumerable data key "${path}.${key}". Use enumerable fields or active-ts metadata symbols.`);
			}
			if (isReservedFieldName(key)) {
				throw new ActiveTsValidationError(
					`Reserved data key "${path}.${key}" is not allowed. Use symbol metadata instead.`
				);
			}
			assertSafeDataKeys(descriptor.value, `${path}.${key}`, seen);
		}
	} finally {
		WEAKSET_DELETE.call(seen, value);
	}
}

function dataPropertyValue(value: object, key: string | symbol, path: string) {
	const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, key);
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsValidationError(`Unsupported data accessor at "${path}". Use plain data properties.`);
	}
	return descriptor.value;
}

function assertNoRuntimeBuiltInCustomProperties(value: object, path: string, allowedIndexLength?: number) {
	if (OBJECT_GET_OWN_PROPERTY_SYMBOLS(value).length) {
		throw new ActiveTsValidationError(
			`Unsupported data symbol key at "${path}". Use string fields or active-ts metadata symbols.`
		);
	}
	for (const key of OBJECT_GET_OWN_PROPERTY_NAMES(value)) {
		if (allowedIndexLength !== undefined && isArrayIndexProperty(key, allowedIndexLength)) continue;
		throw new ActiveTsValidationError(
			`Unsupported custom data key "${path}.${key}". Use plain JSON-like data without built-in object metadata.`
		);
	}
}

function assertDenseOwnArray(array: readonly unknown[], path: string, context: string) {
	for (const property of OBJECT_GET_OWN_PROPERTY_NAMES(array)) {
		if (property === 'length') continue;
		if (!isArrayIndexProperty(property, array.length)) {
			throw new ActiveTsValidationError(`${context} at "${path}" cannot contain non-index array property "${property}".`);
		}
		const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(array, property);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsValidationError(`${context} at "${path}[${property}]" must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsValidationError(`${context} at "${path}[${property}]" must be enumerable.`);
		}
	}
	for (let index = 0; index < array.length; index++) {
		if (!OBJECT_HAS_OWN(array, index)) {
			throw new ActiveTsValidationError(`${context} at "${path}[${index}]". Use null or omit the field.`);
		}
	}
}

function isArrayIndexProperty(property: string, length: number) {
	if (!/^(0|[1-9]\d*)$/.test(property)) return false;
	const index = Number(property);
	return Number.isSafeInteger(index) && index >= 0 && index < length;
}

export function cloneSafeData(value: any) {
	assertSafeDataKeys(value);
	const cloned = value === undefined ? value : structuredClone(value);
	restoreActiveEntityKeyDescriptors(value, cloned, new WeakSet<object>());
	pruneUndefinedObjectProperties(cloned);
	assertSafeDataKeys(cloned);
	return cloned;
}

export function cloneSafeDataWithoutActiveEntityKey(value: any) {
	assertSafeDataKeys(value);
	const cloned = value === undefined ? value : structuredClone(value);
	pruneUndefinedObjectProperties(cloned);
	assertSafeDataKeys(cloned);
	return cloned;
}

function restoreActiveEntityKeyDescriptors(source: unknown, target: unknown, seen: WeakSet<object>) {
	if (!source || typeof source !== 'object' || !target || typeof target !== 'object') return;
	if (
		source instanceof Date ||
		source instanceof Uint8Array ||
		source instanceof RegExp ||
		source instanceof Map ||
		source instanceof Set
	) return;
	if (WEAKSET_HAS.call(seen, source)) return;
	WEAKSET_ADD.call(seen, source);
	const entityKey = activeEntityKeyDescriptor(source);
	if (entityKey) {
		defineDataProperty(target, ACTIVE_TS_ENTITY_KEY, cloneActiveEntityKeyValue(entityKey.value), {
			enumerable: false,
			configurable: entityKey.configurable,
			writable: entityKey.writable
		});
	}
	if (Array.isArray(source)) {
		for (let index = 0; index < source.length; index++) {
			const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(source, String(index));
			if (descriptor && 'value' in descriptor) {
				restoreActiveEntityKeyDescriptors(descriptor.value, (target as unknown[])[index], seen);
			}
		}
		WEAKSET_DELETE.call(seen, source);
		return;
	}
	for (const key of OBJECT_GET_OWN_PROPERTY_NAMES(source)) {
		const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(source, key);
		if (descriptor && 'value' in descriptor) {
			restoreActiveEntityKeyDescriptors(descriptor.value, (target as Record<string, unknown>)[key], seen);
		}
	}
	WEAKSET_DELETE.call(seen, source);
}

function activeEntityKeyDescriptor(value: unknown) {
	if (!value || typeof value !== 'object') return undefined;
	const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, ACTIVE_TS_ENTITY_KEY);
	if (!descriptor || !('value' in descriptor) || descriptor.enumerable) return undefined;
	return descriptor;
}

function cloneActiveEntityKeyValue(
	value: unknown,
	path = 'active-ts entity key metadata',
	seen = new WeakMap<object, unknown>()
): unknown {
	if (value === null || typeof value !== 'object') return cloneStructuredEntityKeyPrimitive(value, path);
	if (WEAKMAP_HAS.call(seen, value)) return WEAKMAP_GET.call(seen, value);
	if (Array.isArray(value)) {
		if (OBJECT_GET_OWN_PROPERTY_SYMBOLS(value).length) {
			throw new ActiveTsValidationError(`${path} cannot contain symbol fields.`);
		}
		const clone: unknown[] = [];
		WEAKMAP_SET.call(seen, value, clone);
		for (const property of OBJECT_GET_OWN_PROPERTY_NAMES(value)) {
			if (property === 'length') continue;
			if (!isArrayIndexProperty(property, value.length)) {
				throw new ActiveTsValidationError(`${path} cannot contain non-index array property "${property}".`);
			}
			const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, property);
			if (!descriptor || !('value' in descriptor)) {
				throw new ActiveTsValidationError(`${path}[${property}] must be a data property.`);
			}
			if (!descriptor.enumerable) {
				throw new ActiveTsValidationError(`${path}[${property}] must be enumerable.`);
			}
		}
		for (let index = 0; index < value.length; index++) {
			if (!OBJECT_HAS_OWN(value, index)) {
				throw new ActiveTsValidationError(`${path}[${index}] is missing.`);
			}
			const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, String(index))!;
			clone[index] = cloneActiveEntityKeyValue(descriptor.value, `${path}[${index}]`, seen);
		}
		return clone;
	}
	const prototype = OBJECT_GET_PROTOTYPE_OF(value);
	if (prototype !== Object.prototype && prototype !== null) {
		return cloneStructuredEntityKeyObject(value, path);
	}
	if (OBJECT_GET_OWN_PROPERTY_SYMBOLS(value).length) {
		throw new ActiveTsValidationError(`${path} cannot contain symbol fields.`);
	}
	const clone = Object.create(prototype) as Record<string, unknown>;
	WEAKMAP_SET.call(seen, value, clone);
	for (const key of OBJECT_GET_OWN_PROPERTY_NAMES(value)) {
		const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, key);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsValidationError(`${path}.${key} must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsValidationError(`${path}.${key} must be enumerable.`);
		}
		defineDataProperty(clone, key, cloneActiveEntityKeyValue(descriptor.value, `${path}.${key}`, seen), {
			enumerable: true,
			configurable: true,
			writable: true
		});
	}
	return clone;
}

function cloneStructuredEntityKeyPrimitive(value: unknown, path: string) {
	if (
		value === undefined ||
		value === null ||
		typeof value === 'string' ||
		typeof value === 'boolean'
	) return value;
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) {
			throw new ActiveTsValidationError(`${path} must contain finite numbers.`);
		}
		return value;
	}
	throw new ActiveTsValidationError(`${path} must contain structured-cloneable metadata.`);
}

function cloneStructuredEntityKeyObject(value: object, path: string) {
	try {
		return structuredClone(value);
	} catch {
		throw new ActiveTsValidationError(`${path} must contain structured-cloneable metadata.`);
	}
}

export function clonePortableData(value: any, path = '$') {
	const cloned = cloneSafeData(value);
	assertPortableStoredData(cloned, path);
	return cloned;
}

export function cloneSafeDataObject(value: any, context = 'data') {
	assertPlainDataObject(value, context);
	return cloneSafeData(value);
}

export function cloneSafeDataObjectWithoutActiveEntityKey(value: any, context = 'data') {
	assertPlainDataObject(value, context);
	return cloneSafeDataWithoutActiveEntityKey(value);
}

export function clonePortableDataObject(value: any, context = 'data') {
	assertPlainDataObject(value, context);
	return clonePortableData(value, context);
}

export function assertPortableStoredData(value: unknown, path = '$', seen = new WeakSet<object>()) {
	assertSafeDataKeys(value, path);
	if (!value || typeof value !== 'object') return;
	if (value instanceof Date) {
		throw new ActiveTsValidationError(`Unsupported stored data date at "${path}". Declare a date field type or encode it.`);
	}
	if (value instanceof Uint8Array) {
		throw new ActiveTsValidationError(`Unsupported stored binary value at "${path}". Encode binary fields before persistence.`);
	}
	if (WEAKSET_HAS.call(seen, value)) return;
	WEAKSET_ADD.call(seen, value);
	try {
		if (Array.isArray(value)) {
			for (let index = 0; index < value.length; index++) {
				assertPortableStoredData(dataPropertyValue(value, String(index), `${path}[${index}]`), `${path}[${index}]`, seen);
			}
			return;
		}
		for (const [key, item] of OBJECT_ENTRIES(value as Record<string, unknown>)) {
			assertPortableStoredData(item, `${path}.${key}`, seen);
		}
	} finally {
		WEAKSET_DELETE.call(seen, value);
	}
}

function pruneUndefinedObjectProperties(value: unknown, seen = new WeakSet<object>()) {
	if (!value || typeof value !== 'object') return;
	if (value instanceof Date || value instanceof Uint8Array || value instanceof RegExp || value instanceof Map || value instanceof Set)
		return;
	if (WEAKSET_HAS.call(seen, value)) return;
	WEAKSET_ADD.call(seen, value);
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) {
			const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, String(index));
			if (descriptor && 'value' in descriptor) pruneUndefinedObjectProperties(descriptor.value, seen);
		}
		return;
	}
	for (const key of OBJECT_KEYS(value)) {
		const next = (value as Record<string, unknown>)[key];
		if (next === undefined) delete (value as Record<string, unknown>)[key];
		else pruneUndefinedObjectProperties(next, seen);
	}
}

export function assertPlainDataObject(value: unknown, context = 'data'): asserts value is Record<string, any> {
	assertSafeDataKeys(value);
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ActiveTsValidationError(`${context} must be a plain object.`);
	}
	const prototype = OBJECT_GET_PROTOTYPE_OF(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsValidationError(`${context} must be a plain object.`);
	}
}

export function defineDataProperty(
	target: object,
	property: PropertyKey,
	value: unknown,
	options: { enumerable?: boolean; configurable?: boolean; writable?: boolean } = {}
) {
	const descriptor = Object.create(null) as PropertyDescriptor;
	descriptor.value = value;
	if (options.enumerable !== undefined) descriptor.enumerable = options.enumerable;
	if (options.configurable !== undefined) descriptor.configurable = options.configurable;
	if (options.writable !== undefined) descriptor.writable = options.writable;
	Object.defineProperty(target, property, descriptor);
}

export function defineGetterProperty(
	target: object,
	property: PropertyKey,
	get: () => unknown,
	options: { enumerable?: boolean; configurable?: boolean } = {}
) {
	const descriptor = Object.create(null) as PropertyDescriptor;
	descriptor.get = get;
	if (options.enumerable !== undefined) descriptor.enumerable = options.enumerable;
	if (options.configurable !== undefined) descriptor.configurable = options.configurable;
	Object.defineProperty(target, property, descriptor);
}

export function attachEntityKey<T extends object>(value: T, key: unknown) {
	if (!value || typeof value !== 'object') {
		throw new ActiveTsValidationError('entity key target must be an object.');
	}
	const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, ACTIVE_TS_ENTITY_KEY);
	if (descriptor) {
		if (!('value' in descriptor)) {
			throw new ActiveTsValidationError('entity key target active-ts entity key must be a data property.');
		}
		if (descriptor.value !== key) {
			throw new ActiveTsValidationError('entity key target already has a different active-ts entity key.');
		}
		return value;
	}
	if (!OBJECT_IS_EXTENSIBLE(value)) {
		throw new ActiveTsValidationError('entity key target must be extensible.');
	}
	defineDataProperty(value, ACTIVE_TS_ENTITY_KEY, key, { enumerable: false, configurable: false });
	return value;
}
