import { ActiveTsConfigurationError } from '../core/errors.js';
import { entityIdKey } from '../core/query-utils.js';
import { MAP_SET, SET_ADD, SET_HAS } from '../core/collection-intrinsics.js';
import type { EntityId } from '../core/types.js';


export function capturedMap<K, V>(entries: ReadonlyArray<readonly [K, V]> = []): Map<K, V> {
	const map = new Map<K, V>();
	for (const [key, value] of entries) MAP_SET.call(map, key, value);
	return map;
}

export type LazyWarningMode = 'console' | 'capture' | 'throw' | 'off';
const WITH_TEST_CONTEXT_OPTION_KEYS = ['install'] as const;

export function capturedSet<T>(values: readonly T[]) {
	const set = new Set<T>();
	for (const value of values) SET_ADD.call(set, value);
	return set;
}

export function mapArray<T, U>(items: readonly T[], mapper: (item: T, index: number) => U) {
	const result: U[] = [];
	for (let index = 0; index < items.length; index++) result[result.length] = mapper(items[index], index);
	return result;
}

export function someArray<T>(items: readonly T[], predicate: (item: T, index: number) => boolean) {
	for (let index = 0; index < items.length; index++) {
		if (predicate(items[index], index)) return true;
	}
	return false;
}

export function everyArray<T>(items: readonly T[], predicate: (item: T, index: number) => boolean) {
	for (let index = 0; index < items.length; index++) {
		if (!predicate(items[index], index)) return false;
	}
	return true;
}

export function sortEntityIds(ids: EntityId[]) {
	const sorted: EntityId[] = [];
	for (let index = 0; index < ids.length; index++) {
		const id = ids[index];
		let insertAt = sorted.length;
		for (let sortedIndex = 0; sortedIndex < sorted.length; sortedIndex++) {
			if (entityIdKey(id).localeCompare(entityIdKey(sorted[sortedIndex])) < 0) {
				insertAt = sortedIndex;
				break;
			}
		}
		for (let shift = sorted.length; shift > insertAt; shift--) sorted[shift] = sorted[shift - 1];
		sorted[insertAt] = id;
	}
	return sorted;
}

export function joinStrings(values: readonly string[], separator: string) {
	let result = '';
	for (let index = 0; index < values.length; index++) {
		if (index > 0) result += separator;
		result += values[index];
	}
	return result;
}

export function testingAdapterMethod(adapter: object, property: string) {
	const value = testingAdapterMember(adapter, property);
	if (value === undefined) return undefined;
	if (typeof value !== 'function') {
		throw new ActiveTsConfigurationError(`Testing adapter property "${property}" must be a function.`);
	}
	return value.bind(adapter);
}

export function testingAdapterMember(adapter: object, property: string) {
	let current: object | null = adapter;
	while (current && current !== Object.prototype) {
		if (Object.prototype.hasOwnProperty.call(current, property)) {
			const descriptor = Object.getOwnPropertyDescriptor(current, property);
			if (!descriptor || !('value' in descriptor)) {
				throw new ActiveTsConfigurationError(`Testing adapter property "${property}" must be a data property.`);
			}
			if (current === adapter && !descriptor.enumerable) {
				throw new ActiveTsConfigurationError(`Testing adapter property "${property}" must be enumerable.`);
			}
			return descriptor.value;
		}
		current = Object.getPrototypeOf(current);
	}
	return undefined;
}

export function validateLazyWarningMode(mode: unknown): asserts mode is LazyWarningMode {
	if (mode !== 'console' && mode !== 'capture' && mode !== 'throw' && mode !== 'off') {
		throw new ActiveTsConfigurationError(
			'Test lazyLoadWarnings must be one of "console", "capture", "throw", or "off".'
		);
	}
}

export function assertPlainTestOptionObject(value: unknown, context: string) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ActiveTsConfigurationError(`${context} must be an object.`);
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsConfigurationError(`${context} must be an object.`);
	}
	assertNoSymbolOrAccessorFields(value, context);
}

function assertNoSymbolOrAccessorFields(value: object, context: string) {
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
}

export function assertKnownOptionKeys(record: Record<string, unknown>, allowed: readonly string[], context: string) {
	const allowedKeys = capturedSet(allowed);
	for (const property of Object.keys(record)) {
		if (!SET_HAS.call(allowedKeys, property)) {
			throw new ActiveTsConfigurationError(`${context} contains unknown option "${property}".`);
		}
	}
}

export function normalizeWithTestContextOptions(options: { install?: boolean }) {
	assertPlainTestOptionObject(options, 'withTestContext options');
	assertKnownOptionKeys(options as Record<string, unknown>, WITH_TEST_CONTEXT_OPTION_KEYS, 'withTestContext options');
	const install = ownOptionValue(options as Record<string, unknown>, 'install', 'withTestContext options');
	if (install !== undefined && typeof install !== 'boolean') {
		throw new ActiveTsConfigurationError('withTestContext options.install must be a boolean.');
	}
	return { install };
}

export function ownOptionValue(record: Record<string, unknown>, key: string, context?: string) {
	if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(record, key);
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsConfigurationError(`${context ? `${context}.${key}` : `property "${key}"`} must be a data property.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsConfigurationError(`${context ? `${context}.${key}` : `property "${key}"`} must be enumerable.`);
	}
	return descriptor.value;
}
