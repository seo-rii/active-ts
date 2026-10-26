import { snapshotArrayInput } from './array-input.js';
import { SET_ADD, SET_HAS } from './collection-intrinsics.js';
import { ActiveTsValidationError } from './errors.js';
import { assertSafeCacheKey } from './safe-keys.js';
import type { CacheWriteOptions } from './types.js';

type CacheKeyValidator = (value: unknown, context: string) => string;

/** Complete owned batch snapshots must precede adapter mutations or codec calls. */
export function normalizeCacheKeys(keys: unknown, context: string, validate: CacheKeyValidator = assertSafeCacheKey): string[] {
	const input = snapshotArrayInput(keys, context);
	const result: string[] = [];
	for (let index = 0; index < input.length; index++) result[index] = validate(input[index], `${context}[${index}]`);
	return result;
}

export function normalizeCacheEntries(entries: unknown, context: string, validate: CacheKeyValidator = assertSafeCacheKey, tupleStyle: 'entries' | 'tuple' = 'entries'): Array<[string, any]> {
	const input = snapshotArrayInput(entries, context);
	const result: Array<[string, any]> = [];
	const keys = new Set<string>();
	for (let index = 0; index < input.length; index++) {
		const entry = input[index];
		if (!Array.isArray(entry) || entry.length !== 2) {
			throw new ActiveTsValidationError(tupleStyle === 'entries'
				? `${context} must contain [key, value] entries.` : `${context}[${index}] must be a [key, value] tuple.`);
		}
		const tuple = snapshotArrayInput(entry, `${context}[${index}]`);
		const key = validate(tuple[0], `${context}[${index}] key`);
		if (SET_HAS.call(keys, key)) throw new ActiveTsValidationError(`${context} contains duplicate key "${key}".`);
		SET_ADD.call(keys, key);
		result[index] = [key, tuple[1]];
	}
	return result;
}

/** TTL range validation stays with the adapter's existing TTL policy. */
export function normalizeCacheWriteOptions(options: unknown, context: string, ttlContext = `${context}.ttl`): CacheWriteOptions {
	if (options === undefined) return { ttl: undefined };
	if (!options || typeof options !== 'object' || Array.isArray(options)) {
		throw new ActiveTsValidationError(`${context} must be a plain object.`);
	}
	const prototype = Object.getPrototypeOf(options);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsValidationError(`${context} must be a plain object.`);
	}
	if (Object.getOwnPropertySymbols(options).length) throw new ActiveTsValidationError(`${context} cannot contain symbol fields.`);
	for (const key of Object.getOwnPropertyNames(options)) {
		if (key !== 'ttl') throw new ActiveTsValidationError(`${context} contains unknown option "${key}".`);
	}
	const descriptor = Object.getOwnPropertyDescriptor(options, 'ttl');
	if (descriptor && !('value' in descriptor)) throw new ActiveTsValidationError(`${ttlContext} must be a data property.`);
	if (descriptor && !descriptor.enumerable) throw new ActiveTsValidationError(`${ttlContext} must be enumerable.`);
	return { ttl: descriptor?.value };
}
