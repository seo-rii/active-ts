import type { CacheAdapter, CacheWriteOptions } from '../../core/types.js';
import { assertCacheableValue, assertSafeCacheKey, assertSafeTtl, defineDataProperty } from '../../core/safe-keys.js';
import { ActiveTsValidationError } from '../../core/errors.js';
import { snapshotArrayInput } from '../../core/array-input.js';
import { iterableToArray, MAP_CLEAR, MAP_DELETE, MAP_ENTRIES, MAP_GET, MAP_SET, SET_ADD, SET_HAS } from '../../core/collection-intrinsics.js';

type Entry = { value: any; expires?: number };
const CACHE_WRITE_OPTION_KEYS = ['ttl'] as const;

function cloneCacheValue<T>(value: T): T {
	return value === undefined ? value : structuredClone(value);
}

export class MemoryCacheAdapter implements CacheAdapter {
	readonly kind = 'memory';
	private readonly entries = new Map<string, Entry>();
	readonly stats = {
		getMany: 0,
		setMany: 0,
		deleteMany: 0,
		hits: 0,
		misses: 0
	};

	async getMany(keys: string[]) {
		this.stats.getMany++;
		keys = normalizeCacheKeys(keys, 'memory cache keys');
		const now = Date.now();
		const result: Array<any | undefined> = [];
		for (let index = 0; index < keys.length; index++) {
			const rawKey = keys[index];
			const key = assertSafeCacheKey(rawKey, 'memory cache key');
			const entry = MAP_GET.call(this.entries, key);
			if (!entry) {
				this.stats.misses++;
				result[index] = undefined;
				continue;
			}
			if (entry.expires !== undefined && entry.expires <= now) {
				MAP_DELETE.call(this.entries, key);
				this.stats.misses++;
				result[index] = undefined;
				continue;
			}
			this.stats.hits++;
			result[index] = cloneCacheValue(entry.value);
		}
		return result;
	}

	async setMany(entries: Array<[string, any]>, options: CacheWriteOptions = {}) {
		this.stats.setMany++;
		entries = normalizeCacheEntries(entries, 'memory cache entries');
		const ttl = assertSafeTtl(
			normalizeCacheWriteOptions(options, 'memory cache write options').ttl,
			'memory cache ttl'
		);
		const expires = ttl === undefined ? undefined : Date.now() + ttl * 1000;
		const prepared: Array<readonly [string, Entry]> = [];
		for (let index = 0; index < entries.length; index++) {
			const [rawKey, value] = entries[index];
			const key = assertSafeCacheKey(rawKey, 'memory cache key');
			assertCacheableValue(value);
			prepared[index] = [key, { value: cloneCacheValue(value), expires }];
		}
		for (const [key, entry] of prepared) MAP_SET.call(this.entries, key, entry);
	}

	async deleteMany(keys: string[]) {
		this.stats.deleteMany++;
		keys = normalizeCacheKeys(keys, 'memory cache keys');
		for (const key of keys) MAP_DELETE.call(this.entries, assertSafeCacheKey(key, 'memory cache key'));
	}

	clear() {
		MAP_CLEAR.call(this.entries);
		this.resetStats();
	}

	snapshot(): Record<string, { value: any; expires?: number }> {
		const now = Date.now();
		const snapshot = {} as Record<string, { value: any; expires?: number }>;
		for (const [key, entry] of iterableToArray(MAP_ENTRIES.call(this.entries) as Iterable<[string, Entry]>)) {
			if (entry.expires !== undefined && entry.expires <= now) {
				MAP_DELETE.call(this.entries, key);
				continue;
			}
			defineDataProperty(snapshot, key, { value: structuredClone(entry.value), expires: entry.expires }, {
				enumerable: true,
				configurable: true,
				writable: true
			});
		}
		return snapshot;
	}

	resetStats() {
		this.stats.getMany = 0;
		this.stats.setMany = 0;
		this.stats.deleteMany = 0;
		this.stats.hits = 0;
		this.stats.misses = 0;
	}
}

function normalizeCacheKeys(keys: unknown, context: string): string[] {
	return snapshotArrayInput<string>(keys, context);
}

function normalizeCacheEntries(entries: unknown, context: string): Array<[string, any]> {
	const items = snapshotArrayInput<unknown>(entries, context);
	const result: Array<[string, any]> = [];
	const keys = new Set<string>();
	for (let index = 0; index < items.length; index++) {
		const entry = items[index];
		if (!Array.isArray(entry) || entry.length !== 2) {
			throw new ActiveTsValidationError(`${context} must contain [key, value] entries.`);
		}
		const tuple = snapshotArrayInput(entry, `${context}[${index}]`);
		const key = assertSafeCacheKey(tuple[0], `${context}[${index}] key`);
		if (SET_HAS.call(keys, key)) {
			throw new ActiveTsValidationError(`${context} contains duplicate key "${key}".`);
		}
		SET_ADD.call(keys, key);
		result[index] = [key, tuple[1]];
	}
	return result;
}

function normalizeCacheWriteOptions(options: unknown, context: string): CacheWriteOptions {
	if (options === undefined) return { ttl: undefined };
	if (!options || typeof options !== 'object' || Array.isArray(options)) {
		throw new ActiveTsValidationError(`${context} must be a plain object.`);
	}
	const prototype = Object.getPrototypeOf(options);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsValidationError(`${context} must be a plain object.`);
	}
	if (Object.getOwnPropertySymbols(options).length) {
		throw new ActiveTsValidationError(`${context} cannot contain symbol fields.`);
	}
	assertKnownCacheWriteOptions(options, context);
	return {
		ttl: ownOptionValue(options as Record<string, unknown>, 'ttl', context)
	};
}

function assertKnownCacheWriteOptions(options: object, context: string) {
	const allowed = new Set<string>();
	for (const key of CACHE_WRITE_OPTION_KEYS) SET_ADD.call(allowed, key);
	for (const property of Object.getOwnPropertyNames(options)) {
		if (!SET_HAS.call(allowed, property)) {
			throw new ActiveTsValidationError(`${context} contains unknown option "${property}".`);
		}
	}
}

function ownOptionValue(record: Record<string, unknown>, key: string, context: string) {
	if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(record, key);
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsValidationError(`${context}.${key} must be a data property.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsValidationError(`${context}.${key} must be enumerable.`);
	}
	return descriptor.value;
}
