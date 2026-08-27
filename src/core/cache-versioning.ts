import { ActiveTsValidationError } from './errors.js';
import { snapshotArrayInput } from './array-input.js';
import { SET_ADD, SET_HAS } from './collection-intrinsics.js';
import { assertCacheableValue, assertSafeCacheKey } from './safe-keys.js';
import type { CacheAdapter, CacheVersionedEntry, CacheVersionedValue } from './types.js';
import {
	OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
	OBJECT_GET_OWN_PROPERTY_NAMES,
	OBJECT_GET_OWN_PROPERTY_SYMBOLS,
	OBJECT_GET_PROTOTYPE_OF
} from './object-intrinsics.js';

export function cacheSupportsVersioning(adapter: CacheAdapter): adapter is CacheAdapter & Required<Pick<
	CacheAdapter,
	'getManyVersioned' | 'setManyVersioned' | 'invalidateMany'
>> {
	return typeof adapter.getManyVersioned === 'function' &&
		typeof adapter.setManyVersioned === 'function' &&
		typeof adapter.invalidateMany === 'function';
}

export function assertCompleteCacheVersioning(adapter: CacheAdapter, context: string) {
	const methods = [adapter.getManyVersioned, adapter.setManyVersioned, adapter.invalidateMany];
	let count = 0;
	for (const method of methods) {
		if (method !== undefined) count++;
	}
	if (count !== 0 && count !== methods.length) {
		throw new ActiveTsValidationError(
			`${context} must provide getManyVersioned(), setManyVersioned(), and invalidateMany() together.`
		);
	}
}

export function normalizeCacheVersion(value: unknown, context: string) {
	if (typeof value !== 'string' || !value || value.includes('\0')) {
		throw new ActiveTsValidationError(`${context} must be a non-empty opaque string without null bytes.`);
	}
	return value;
}

export function normalizeCacheVersionedValues(
	value: unknown,
	expected: number,
	context: string
): CacheVersionedValue[] {
	const rows = snapshotExactArray(value, context);
	if (rows.length !== expected) {
		throw new ActiveTsValidationError(`${context} must contain ${expected} entries.`);
	}
	const normalized: CacheVersionedValue[] = [];
	for (let index = 0; index < rows.length; index++) {
		const rowContext = `${context}[${index}]`;
		const row = rows[index];
		if (!row || typeof row !== 'object' || Array.isArray(row)) {
			throw new ActiveTsValidationError(`${rowContext} must be a plain object.`);
		}
		const prototype = OBJECT_GET_PROTOTYPE_OF(row);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new ActiveTsValidationError(`${rowContext} must be a plain object.`);
		}
		if (OBJECT_GET_OWN_PROPERTY_SYMBOLS(row).length) {
			throw new ActiveTsValidationError(`${rowContext} cannot contain symbol fields.`);
		}
		for (const property of OBJECT_GET_OWN_PROPERTY_NAMES(row)) {
			if (property !== 'value' && property !== 'version') {
				throw new ActiveTsValidationError(`${rowContext} contains unknown field "${property}".`);
			}
		}
		const stored = ownDataValue(row, 'value', rowContext);
		const version = normalizeCacheVersion(ownDataValue(row, 'version', rowContext), `${rowContext}.version`);
		if (stored !== undefined) assertCacheableValue(stored);
		normalized[index] = {
			value: stored === undefined ? undefined : structuredClone(stored),
			version
		};
	}
	return normalized;
}

export function normalizeCacheVersionedEntries(value: unknown, context: string): CacheVersionedEntry[] {
	const entries = snapshotExactArray(value, context);
	const normalized: CacheVersionedEntry[] = [];
	const keys = new Set<string>();
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (!Array.isArray(entry) || entry.length !== 3) {
			throw new ActiveTsValidationError(`${context}[${index}] must be a [key, value, expectedVersion] tuple.`);
		}
		const tuple = snapshotExactArray(entry, `${context}[${index}]`);
		const key = assertSafeCacheKey(tuple[0], `${context}[${index}] key`);
		if (SET_HAS.call(keys, key)) {
			throw new ActiveTsValidationError(`${context} contains duplicate key "${key}".`);
		}
		SET_ADD.call(keys, key);
		assertCacheableValue(tuple[1]);
		normalized[index] = [
			key,
			structuredClone(tuple[1]),
			normalizeCacheVersion(tuple[2], `${context}[${index}] expectedVersion`)
		];
	}
	return normalized;
}

export function normalizeCacheVersionedSetResult(value: unknown, expected: number, context: string) {
	const results = snapshotExactArray(value, context);
	if (results.length !== expected) {
		throw new ActiveTsValidationError(`${context} must contain ${expected} entries.`);
	}
	const normalized: boolean[] = [];
	for (let index = 0; index < results.length; index++) {
		if (typeof results[index] !== 'boolean') {
			throw new ActiveTsValidationError(`${context}[${index}] must be a boolean.`);
		}
		normalized[index] = results[index] as boolean;
	}
	return normalized;
}

function ownDataValue(value: object, property: string, context: string) {
	const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, property);
	if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
		throw new ActiveTsValidationError(`${context}.${property} must be an enumerable data property.`);
	}
	return descriptor.value;
}

function snapshotExactArray(value: unknown, context: string): unknown[] {
	const items = snapshotArrayInput<unknown>(value, context);
	for (const property of OBJECT_GET_OWN_PROPERTY_NAMES(value as unknown[])) {
		if (property === 'length') continue;
		const index = Number(property);
		if (!Number.isSafeInteger(index) || index < 0 || index >= items.length || String(index) !== property) {
			throw new ActiveTsValidationError(`${context} cannot contain non-index array property "${property}".`);
		}
	}
	return items;
}
