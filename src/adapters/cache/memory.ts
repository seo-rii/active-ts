import { normalizeCacheKeys as snapshotCacheKeys, normalizeCacheEntries, normalizeCacheWriteOptions } from '../../core/cache-input.js';
import type { CacheAdapter, CacheWriteOptions } from '../../core/types.js';
import { assertCacheableValue, assertSafeCacheKey, assertSafeTtl, defineDataProperty } from '../../core/safe-keys.js';
import { ActiveTsValidationError } from '../../core/errors.js';
import { iterableToArray, MAP_CLEAR, MAP_DELETE, MAP_ENTRIES, MAP_GET, MAP_KEYS, MAP_SET, MAP_SIZE } from '../../core/collection-intrinsics.js';

type Entry = { value: any; expires?: number };
export type MemoryCacheOptions = {
	/** Maximum retained entries; omitted preserves the existing unlimited capacity. */
	maxEntries?: number;
	/** Entries inspected for expiry per operation (default: 16). */
	sweepSize?: number;
};

function cloneCacheValue<T>(value: T): T {
	return value === undefined ? value : structuredClone(value);
}

export class MemoryCacheAdapter implements CacheAdapter {
	readonly kind = 'memory';
	private readonly entries = new Map<string, Entry>();
	private sweepIterator?: IterableIterator<[string, Entry]>;
	private readonly options: MemoryCacheOptions;

	constructor(options: MemoryCacheOptions = {}) {
		if (!options || typeof options !== 'object' || Array.isArray(options) ||
			(Object.getPrototypeOf(options) !== Object.prototype && Object.getPrototypeOf(options) !== null)) {
			throw new ActiveTsValidationError('memory cache options must be a plain object.');
		}
		if (Object.getOwnPropertySymbols(options).length) throw new ActiveTsValidationError('memory cache options cannot contain symbol fields.');
		for (const key of Object.getOwnPropertyNames(options)) {
			if (key !== 'maxEntries' && key !== 'sweepSize') throw new ActiveTsValidationError(`Unknown memory cache option "${key}".`);
		}
		this.options = {
			maxEntries: ownOptionValue(options as Record<string, unknown>, 'maxEntries', 'memory cache options'),
			sweepSize: ownOptionValue(options as Record<string, unknown>, 'sweepSize', 'memory cache options')
		};
		for (const key of ['maxEntries', 'sweepSize'] as const) {
			const value = this.options[key];
			if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
				throw new ActiveTsValidationError(`memory cache options.${key} must be a positive safe integer.`);
			}
		}
	}
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
		this.sweepExpired(now);
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
		this.sweepExpired(Date.now());
		for (const [key, entry] of prepared) {
			MAP_SET.call(this.entries, key, entry);
			if (this.options.maxEntries !== undefined && MAP_SIZE.call(this.entries) > this.options.maxEntries) {
				const oldest = (MAP_KEYS.call(this.entries) as IterableIterator<string>).next();
				if (!oldest.done) MAP_DELETE.call(this.entries, oldest.value);
			}
		}
	}

	async deleteMany(keys: string[]) {
		this.stats.deleteMany++;
		keys = normalizeCacheKeys(keys, 'memory cache keys');
		for (const key of keys) MAP_DELETE.call(this.entries, assertSafeCacheKey(key, 'memory cache key'));
	}

	clear() {
		MAP_CLEAR.call(this.entries);
		this.sweepIterator = undefined;
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

	private sweepExpired(now: number) {
		this.sweepIterator ??= MAP_ENTRIES.call(this.entries) as IterableIterator<[string, Entry]>;
		for (let count = 0; count < (this.options.sweepSize ?? 16); count++) {
			const next = this.sweepIterator.next();
			if (next.done) { this.sweepIterator = undefined; break; }
			const [key, entry] = next.value;
			if (entry.expires !== undefined && entry.expires <= now) MAP_DELETE.call(this.entries, key);
		}
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
	return snapshotCacheKeys(keys, context, value => assertSafeCacheKey(value, 'memory cache key'));
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
