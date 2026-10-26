import { normalizeCacheKeys as snapshotCacheKeys, normalizeCacheEntries, normalizeCacheWriteOptions } from '../../core/cache-input.js';
import type { CacheAdapter, CacheWriteOptions } from '../../core/types.js';
import { assertCacheableValue, assertSafeCacheKey, assertSafeTtl, defineDataProperty } from '../../core/safe-keys.js';
import { iterableToArray, MAP_CLEAR, MAP_DELETE, MAP_ENTRIES, MAP_GET, MAP_SET } from '../../core/collection-intrinsics.js';

type Entry = { value: any; expires?: number };

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
	return snapshotCacheKeys(keys, context, value => assertSafeCacheKey(value, 'memory cache key'));
}
