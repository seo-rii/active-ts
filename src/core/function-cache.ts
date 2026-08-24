import { createHash } from 'node:crypto';
import { ActiveContext, getDefaultContext } from './context.js';
import { assertContextTransactionWritable, currentTransactionContext } from './context-internal.js';
import { cacheAdapterSource, markCacheAdapterSource } from './cache-utils.js';
import {
	assertCacheableValue,
	assertDefinedCacheValue,
	assertSafeCacheKey,
	assertSafeSchemaIdentifier,
	assertSafeTtl
} from './safe-keys.js';
import { snapshotArrayInput } from './array-input.js';
import { ActiveTsConfigurationError, ActiveTsValidationError } from './errors.js';
import {
	MAP_CLEAR,
	MAP_DELETE,
	MAP_ENTRIES,
	MAP_GET,
	MAP_HAS,
	MAP_KEYS,
	MAP_SET,
	MAP_SIZE,
	SET_ADD,
	SET_DELETE,
	SET_HAS,
	SET_SIZE,
	WEAKSET_ADD,
	WEAKSET_DELETE,
	WEAKSET_HAS,
	WEAKMAP_DELETE,
	WEAKMAP_GET,
	WEAKMAP_SET
} from './collection-intrinsics.js';
import type { CacheAdapter, MaybePromise } from './types.js';

export type FunctionCacheKeyResolver<TInput> = (input: TInput) => MaybePromise<string>;

export type FunctionCacheOptions<TInput, TValue> = {
	prefix: string;
	factory: (input: TInput) => MaybePromise<TValue>;
	key?: FunctionCacheKeyResolver<TInput>;
	namespace?: string | ((input: TInput) => MaybePromise<string>);
	context?: ActiveContext;
	cache?: CacheAdapter | string | false;
	ttl?: number;
	memory?: false | { ttl?: number; maxEntries?: number };
	singleFlight?: boolean;
	staleWhileRevalidate?: number;
};

export type FunctionCacheGetOptions = {
	refresh?: boolean;
};

type MemoryEntry<TValue> = {
	value: TValue;
	expires?: number;
	staleUntil?: number;
	epoch: number;
};
type FunctionCacheRuntime = {
	adapter?: CacheAdapter;
	context?: ActiveContext;
	transactionContext?: ActiveContext;
};
type FunctionCachePersistentHit<TValue> = {
	stored: TValue;
	value: TValue;
};
const FUNCTION_CACHE_OPTION_KEYS = [
	'prefix',
	'factory',
	'key',
	'namespace',
	'context',
	'cache',
	'ttl',
	'memory',
	'singleFlight',
	'staleWhileRevalidate'
] as const;
const FUNCTION_CACHE_MEMORY_OPTION_KEYS = ['ttl', 'maxEntries'] as const;
const FUNCTION_CACHE_GET_OPTION_KEYS = ['refresh'] as const;
const FUNCTION_CACHE_INVALIDATION_EPOCH_LIMIT = 4096;
const functionCacheInvalidationEpochs = new Map<string, number>();
const functionCacheInvalidationFailures = new WeakMap<object, Set<string>>();
const functionCachePendingInvalidations = new Map<string, number>();
const functionCacheTransactionScopes = new WeakMap<ActiveContext, number>();
const DATE_GET_TIME = Date.prototype.getTime;
const DATE_TO_ISO_STRING = Date.prototype.toISOString;
let functionCacheDefaultInvalidationEpoch = 0;
let nextFunctionCacheTransactionScope = 0;

export class ActiveFunctionCache<TInput, TValue> {
	readonly stats = {
		memoryHits: 0,
		cacheHits: 0,
		misses: 0,
		sets: 0,
		invalidations: 0
	};

	private readonly memory = new Map<string, MemoryEntry<TValue>>();
	private readonly inFlight = new Map<string, Promise<TValue>>();
	private readonly options: FunctionCacheOptions<TInput, TValue>;

	constructor(options: FunctionCacheOptions<TInput, TValue>) {
		this.options = normalizeFunctionCacheOptions(options) as FunctionCacheOptions<TInput, TValue>;
		assertSafeSchemaIdentifier(this.options.prefix, 'function cache prefix');
		if (typeof this.options.namespace === 'string') assertSafeSchemaIdentifier(this.options.namespace, 'function cache namespace');
		assertSafeTtl(this.options.ttl, 'function cache ttl');
		if (this.options.memory) assertSafeTtl(this.options.memory.ttl, 'function cache memory ttl');
		if (this.options.memory) assertSafeMaxEntries(this.options.memory.maxEntries);
		assertSafeTtl(this.options.staleWhileRevalidate, 'function cache staleWhileRevalidate');
	}

	async get(input: TInput, options: FunctionCacheGetOptions = {}) {
		const getOptions = normalizeFunctionCacheGetOptions(options);
		const key = await this.keyFor(input);
		const epoch = this.invalidationEpoch(key);
		const bypassCache = this.shouldBypassCacheForTransaction();
		const flightScope = this.inFlightScope();
		if (!bypassCache && !getOptions.refresh) {
			const local = this.memoryGet(key, { allowStale: true });
			if (local.found && !local.stale) {
				const value = await this.cacheHitValue(key, local.value);
				if (value !== undefined && this.invalidationEpochUnchanged(key, epoch)) {
					this.stats.memoryHits++;
					return value;
				}
				MAP_DELETE.call(this.memory, key);
			}
			if (local.found && local.stale) {
				const value = await this.cacheHitValue(key, local.value);
				if (value !== undefined && this.invalidationEpochUnchanged(key, epoch)) {
					this.stats.memoryHits++;
					void this.refreshInBackground(input, key, this.invalidationEpoch(key));
					return value;
				}
				MAP_DELETE.call(this.memory, key);
			}
		}
		if (this.options.singleFlight !== false) {
			const flightKey = this.inFlightKey(key, getOptions, epoch, flightScope);
			const active = MAP_GET.call(this.inFlight, flightKey) as Promise<TValue> | undefined;
			if (active) return await active;
			const pending = this.getAfterMemoryMiss(input, key, getOptions, epoch, bypassCache);
			MAP_SET.call(this.inFlight, flightKey, pending);
			try {
				return await pending;
			} finally {
				MAP_DELETE.call(this.inFlight, flightKey);
			}
		}
		return await this.getAfterMemoryMiss(input, key, getOptions, epoch, bypassCache);
	}

	private async getAfterMemoryMiss(
		input: TInput,
		key: string,
		getOptions: FunctionCacheGetOptions,
		expectedEpoch: number,
		bypassCache: boolean
	) {
		if (!bypassCache && !getOptions.refresh) {
			const cached = await this.cacheGet(key);
			if (cached !== undefined && this.invalidationEpochUnchanged(key, expectedEpoch)) {
				this.stats.cacheHits++;
				this.memorySet(key, cached.stored);
				return cached.value;
			}
		}
		this.stats.misses++;
		return await this.compute(input, key, this.invalidationEpoch(key));
	}

	async peek(input: TInput) {
		if (this.shouldBypassCacheForTransaction()) return undefined;
		const key = await this.keyFor(input);
		const epoch = this.invalidationEpoch(key);
		const local = this.memoryGet(key);
		if (local.found) {
			const value = await this.cacheHitValue(key, local.value);
			if (value !== undefined && this.invalidationEpochUnchanged(key, epoch)) return value;
			MAP_DELETE.call(this.memory, key);
		}
		const cached = await this.cacheGet(key);
		if (cached === undefined || !this.invalidationEpochUnchanged(key, epoch)) return undefined;
		this.memorySet(key, cached.stored);
		return cached.value;
	}

	async set(input: TInput, value: TValue) {
		const key = await this.keyFor(input);
		const transactionContext = this.transactionContext();
		if (transactionContext?.isInTransaction()) {
			assertContextTransactionWritable(transactionContext, 'set function cache entries');
			assertCacheableValue(value);
			const committedValue = cloneFunctionCacheValue(value);
			const runtime = this.deferredRuntime(transactionContext);
			await transactionContext.afterCommitInternal(async () => {
				const epoch = this.bumpInvalidationEpoch(key);
				MAP_DELETE.call(this.memory, key);
				await this.setResolvedKey(key, committedValue, epoch, runtime);
			});
			return value;
		}
		const epoch = this.bumpInvalidationEpoch(key);
		MAP_DELETE.call(this.memory, key);
		await this.setResolvedKey(key, value, epoch);
		return value;
	}

	async invalidate(input: TInput) {
		const key = await this.keyFor(input);
		const transactionContext = this.transactionContext();
		if (transactionContext?.isInTransaction()) {
			assertContextTransactionWritable(transactionContext, 'invalidate function cache entries');
			const runtime = this.deferredRuntime(transactionContext);
			await transactionContext.afterCommitInternal(() => this.invalidateResolvedKey(key, runtime));
			return;
		}
		await this.invalidateResolvedKey(key);
	}

	private async invalidateResolvedKey(key: string, runtime = this.currentRuntime()) {
		this.bumpInvalidationEpoch(key);
		markPendingInvalidation(key);
		MAP_DELETE.call(this.memory, key);
		const { adapter, context } = runtime;
		let deleted = false;
		try {
			if (context) {
				await context.runHooks('beforeCacheInvalidate', {
					id: key,
					operation: 'function-cache',
					meta: { prefix: this.options.prefix, key }
				});
			}
			if (adapter) await adapter.deleteMany([key]);
			deleted = true;
		} catch (error) {
			if (adapter) markInvalidationFailure(adapter, key);
			throw error;
		} finally {
			if (!deleted) clearPendingInvalidation(key);
		}
		if (adapter) clearInvalidationFailure(adapter, key);
		this.bumpInvalidationEpoch(key);
		clearPendingInvalidation(key);
		if (context) {
			await context.runHooks('afterCacheInvalidate', {
				id: key,
				operation: 'function-cache',
				meta: { prefix: this.options.prefix, key }
			});
		}
		this.stats.invalidations++;
	}

	clearMemory() {
		MAP_CLEAR.call(this.memory);
	}

	snapshotMemory(): Record<string, { value: TValue; expires?: number }> {
		const snapshot: Record<string, { value: TValue; expires?: number }> = {};
		for (const [key, entry] of MAP_ENTRIES.call(this.memory) as Iterable<[string, MemoryEntry<TValue>]>) {
			Object.defineProperty(snapshot, key, {
				value: { value: structuredClone(entry.value), expires: entry.expires },
				enumerable: true,
				configurable: true,
				writable: true
			});
		}
		return snapshot;
	}

	private async setResolvedKey(
		key: string,
		value: TValue,
		expectedEpoch?: number,
		runtime = this.currentRuntime()
	) {
		const { adapter, context, transactionContext } = runtime;
		let cacheValue: TValue;
		try {
			assertCacheableValue(value);
			cacheValue = cloneFunctionCacheValue(value);
			if (context) {
				const before = await context.runHooks('beforeCacheSet', {
					id: key,
					data: cacheValue,
					operation: 'function-cache',
					meta: { prefix: this.options.prefix, key }
				});
				cacheValue = sanitizeFunctionCacheValue(before.data as TValue, 'beforeCacheSet data') as TValue;
			}
			assertCacheableValue(cacheValue);
		} catch (error) {
			if (!transactionContext?.isInTransaction()) this.poisonFailedPreWriteSet(key, adapter);
			throw error;
		}
		if (!this.invalidationEpochUnchanged(key, expectedEpoch)) return value;
		if (transactionContext?.isInTransaction()) return value;
		if (adapter) {
			try {
				await adapter.setMany([[key, cacheValue]], { ttl: this.options.ttl });
			} catch (error) {
				markInvalidationFailure(adapter, key);
				throw error;
			}
			if (!this.invalidationEpochUnchanged(key, expectedEpoch)) {
				try {
					await adapter.deleteMany([key]);
				} catch (error) {
					markInvalidationFailure(adapter, key);
					throw error;
				}
				return value;
			}
			clearInvalidationFailure(adapter, key);
		}
		this.memorySet(key, cacheValue);
		if (context) {
			try {
				await context.runHooks('afterCacheSet', {
					id: key,
					data: cloneFunctionCacheValue(cacheValue),
					operation: 'function-cache',
					meta: { prefix: this.options.prefix, key }
				});
			} catch (error) {
				await this.poisonCommittedSet(key, adapter, error);
				throw error;
			}
		}
		this.stats.sets++;
		return value;
	}

	private poisonFailedPreWriteSet(key: string, adapter: CacheAdapter | undefined) {
		this.bumpInvalidationEpoch(key);
		MAP_DELETE.call(this.memory, key);
		if (adapter) markInvalidationFailure(adapter, key);
	}

	private async poisonCommittedSet(key: string, adapter: CacheAdapter | undefined, cause: unknown) {
		this.bumpInvalidationEpoch(key);
		MAP_DELETE.call(this.memory, key);
		if (!adapter) return;
		try {
			await adapter.deleteMany([key]);
			clearInvalidationFailure(adapter, key);
		} catch (error) {
			markInvalidationFailure(adapter, key);
			throw new AggregateError([cause, error], 'Function cache set hook failed and cleanup failed.');
		}
	}

	private async cacheGet(key: string) {
		const adapter = this.adapter();
		if (!adapter) return undefined;
		if (hasPendingInvalidation(key)) return undefined;
		if (hasInvalidationFailure(adapter, key)) return undefined;
		const context = this.hookContext();
		if (context) await this.beforeCacheGet(context, key);
		if (hasPendingInvalidation(key)) return undefined;
		const rawValues = sanitizeFunctionCacheGetMany(await adapter.getMany([key]), adapter.kind);
		if (hasPendingInvalidation(key)) return undefined;
		const rawValue = rawValues[0] as TValue | undefined;
		const stored = sanitizeFunctionCacheValue(rawValue, `Function cache adapter "${adapter.kind}" getMany result[0]`);
		const value = context ? await this.afterCacheGet(context, key, cloneFunctionCacheValue(stored)) : stored;
		if (value === undefined) return undefined;
		return {
			stored: stored === undefined ? value : stored,
			value
		} as FunctionCachePersistentHit<TValue>;
	}

	private async cacheHitValue(key: string, value: TValue | undefined) {
		const context = this.hookContext();
		if (!context) return value;
		await this.beforeCacheGet(context, key);
		return await this.afterCacheGet(context, key, value);
	}

	private async beforeCacheGet(context: ActiveContext, key: string) {
		await context.runHooks('beforeCacheGet', {
			id: key,
			operation: 'function-cache',
			meta: { prefix: this.options.prefix, key }
		});
	}

	private async afterCacheGet(context: ActiveContext, key: string, value: TValue | undefined) {
		const after = await context.runHooks('afterCacheGet', {
			id: key,
			result: value,
			operation: 'function-cache',
			meta: { prefix: this.options.prefix, key }
		});
		const result = after.result as TValue | undefined;
		return sanitizeFunctionCacheValue(result, 'afterCacheGet result');
	}

	private async compute(input: TInput, key: string, expectedEpoch: number) {
		const value = await this.options.factory(input);
		await this.setResolvedKey(key, value, expectedEpoch);
		return value;
	}

	private async refreshInBackground(input: TInput, key: string, expectedEpoch: number) {
		const flightKey = this.inFlightKey(key, { refresh: true }, expectedEpoch, this.inFlightScope());
		if (MAP_HAS.call(this.inFlight, flightKey)) return;
		const pending = this.compute(input, key, expectedEpoch);
		MAP_SET.call(this.inFlight, flightKey, pending);
		try {
			await pending;
		} catch {
			// stale-while-revalidate deliberately keeps the stale value on refresh failure
		} finally {
			MAP_DELETE.call(this.inFlight, flightKey);
		}
	}

	private inFlightKey(key: string, options: FunctionCacheGetOptions, epoch: number, scope: string) {
		return `${scope}\0${options.refresh ? 'refresh' : 'normal'}\0${epoch}\0${key}`;
	}

	private invalidationEpoch(key: string) {
		return (MAP_GET.call(functionCacheInvalidationEpochs, key) as number | undefined) ?? functionCacheDefaultInvalidationEpoch;
	}

	private bumpInvalidationEpoch(key: string) {
		const epoch = this.invalidationEpoch(key) + 1;
		if (MAP_HAS.call(functionCacheInvalidationEpochs, key)) MAP_DELETE.call(functionCacheInvalidationEpochs, key);
		MAP_SET.call(functionCacheInvalidationEpochs, key, epoch);
		pruneFunctionCacheInvalidationEpochs();
		return epoch;
	}

	private invalidationEpochUnchanged(key: string, expectedEpoch: number | undefined) {
		return expectedEpoch === undefined || this.invalidationEpoch(key) === expectedEpoch;
	}

	private memoryGet(key: string, options: { allowStale?: boolean } = {}): { found: boolean; stale: boolean; value?: TValue } {
		const entry = MAP_GET.call(this.memory, key) as MemoryEntry<TValue> | undefined;
		if (!entry) return { found: false, stale: false };
		if (entry.epoch !== this.invalidationEpoch(key)) {
			MAP_DELETE.call(this.memory, key);
			return { found: false, stale: false };
		}
		if (entry.expires !== undefined && entry.expires <= Date.now()) {
			if (options.allowStale && entry.staleUntil !== undefined && entry.staleUntil > Date.now()) {
				return { found: true, stale: true, value: cloneFunctionCacheValue(entry.value) };
			}
			MAP_DELETE.call(this.memory, key);
			return { found: false, stale: false };
		}
		return { found: true, stale: false, value: cloneFunctionCacheValue(entry.value) };
	}

	private memorySet(key: string, value: TValue) {
		if (this.options.memory === false) return;
		assertCacheableValue(value);
		const ttl = this.options.memory?.ttl ?? this.options.ttl;
		const expires = ttl === undefined ? undefined : Date.now() + ttl * 1000;
		const staleUntil =
			expires && this.options.staleWhileRevalidate
				? expires + this.options.staleWhileRevalidate * 1000
				: undefined;
		MAP_SET.call(this.memory, key, { value: cloneFunctionCacheValue(value), expires, staleUntil, epoch: this.invalidationEpoch(key) });
		const maxEntries = this.options.memory?.maxEntries;
		if (maxEntries && MAP_SIZE.call(this.memory) > maxEntries) {
			const first = MAP_KEYS.call(this.memory).next().value;
			if (first) MAP_DELETE.call(this.memory, first);
		}
	}

	private currentRuntime(): FunctionCacheRuntime {
		return {
			adapter: this.adapter(),
			context: this.hookContext(),
			transactionContext: this.transactionContext()
		};
	}

	private deferredRuntime(transactionContext: ActiveContext): FunctionCacheRuntime {
		const root = transactionContext.rootContext();
		return {
			adapter: this.deferredAdapter(transactionContext),
			context: this.hookContext(root)
		};
	}

	private deferredAdapter(transactionContext: ActiveContext) {
		const cache = this.options.cache;
		if (cache === false) return undefined;
		if (cache && typeof cache !== 'string') return cache;
		return transactionContext.cacheForDeferredTask(cache ?? 'default');
	}

	private adapter(context?: ActiveContext) {
		const cache = this.options.cache;
		if (cache === false) return undefined;
		if (cache && typeof cache !== 'string') return cache;
		return (context ?? this.context()).cache(cache ?? 'default');
	}

	private hookContext(context?: ActiveContext) {
		if (this.options.context) return context ?? this.context();
		if (
			this.options.cache === false ||
			(this.options.cache && typeof this.options.cache !== 'string')
		) return undefined;
		return context ?? this.context();
	}

	private shouldBypassCacheForTransaction() {
		return this.transactionContext()?.isInTransaction() === true;
	}

	private inFlightScope() {
		const context = this.transactionContext();
		if (!context?.isInTransaction()) return 'root';
		return `tx:${functionCacheTransactionScope(context)}`;
	}

	private transactionContext() {
		try {
			return this.context();
		} catch (error) {
			if (
				error instanceof ActiveTsConfigurationError &&
				error.message === 'No default active-ts context is configured.'
			) {
				return currentTransactionContext();
			}
			throw error;
		}
	}

	private context() {
		if (this.options.context) return this.options.context.transactionScopedContext('use function cache context');
		try {
			return getDefaultContext().transactionScopedContext('use function cache context');
		} catch (error) {
			if (
				error instanceof ActiveTsConfigurationError &&
				error.message === 'No default active-ts context is configured.'
			) {
				const transactionContext = currentTransactionContext();
				if (transactionContext) return transactionContext.transactionScopedContext('use function cache context');
			}
			throw error;
		}
	}

	private async keyFor(input: TInput) {
		const raw = this.options.key ? await this.options.key(input) : stableInputKey(input);
		if (typeof raw !== 'string') throw new ActiveTsValidationError('Function cache key resolver must return a string.');
		const namespace =
			typeof this.options.namespace === 'function'
				? validateNamespace(await this.options.namespace(input))
				: this.options.namespace;
		const hash = createHash('sha256').update(raw).digest('base64url');
		const key = namespace === undefined ? `${this.options.prefix}:${hash}` : `${this.options.prefix}:${namespace}:${hash}`;
		return assertSafeCacheKey(key, 'function cache key');
	}
}

function validateNamespace(namespace: unknown) {
	if (typeof namespace !== 'string') throw new ActiveTsValidationError('Function cache namespace resolver must return a string.');
	return assertSafeSchemaIdentifier(namespace, 'function cache namespace');
}

function assertSafeMaxEntries(maxEntries: number | undefined) {
	if (maxEntries === undefined) return;
	if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
		throw new ActiveTsValidationError('function cache memory maxEntries must be a positive safe integer.');
	}
}

function normalizeFunctionCacheOptions(value: unknown): FunctionCacheOptions<unknown, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ActiveTsValidationError('function cache options must be a plain object.');
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsValidationError('function cache options must be a plain object.');
	}
	const options = value as Record<string, unknown>;
	assertNoSymbolOptions(options, 'function cache options');
	assertKnownFunctionCacheOptionKeys(options, FUNCTION_CACHE_OPTION_KEYS, 'function cache options');
	const prefix = ownOptionValue(options, 'prefix', 'function cache options');
	const factory = ownOptionValue(options, 'factory', 'function cache options');
	const key = ownOptionValue(options, 'key', 'function cache options');
	const namespace = ownOptionValue(options, 'namespace', 'function cache options');
	const memory = ownOptionValue(options, 'memory', 'function cache options');
	const singleFlight = ownOptionValue(options, 'singleFlight', 'function cache options');
	const context = ownOptionValue(options, 'context', 'function cache options');
	const cache = ownOptionValue(options, 'cache', 'function cache options');
	const ttl = ownOptionValue(options, 'ttl', 'function cache options');
	const staleWhileRevalidate = ownOptionValue(options, 'staleWhileRevalidate', 'function cache options');
	if (typeof factory !== 'function') {
		throw new ActiveTsValidationError('function cache factory must be a function.');
	}
	if (key !== undefined && typeof key !== 'function') {
		throw new ActiveTsValidationError('function cache key resolver must be a function.');
	}
	if (
		namespace !== undefined &&
		typeof namespace !== 'string' &&
		typeof namespace !== 'function'
	) {
		throw new ActiveTsValidationError('function cache namespace must be a string or function.');
	}
	let normalizedMemory: FunctionCacheOptions<unknown, unknown>['memory'] = memory as any;
	if (memory !== undefined && memory !== false) {
		if (!memory || typeof memory !== 'object' || Array.isArray(memory)) {
			throw new ActiveTsValidationError('function cache memory options must be false or a plain object.');
		}
		const memoryPrototype = Object.getPrototypeOf(memory);
		if (memoryPrototype !== Object.prototype && memoryPrototype !== null) {
			throw new ActiveTsValidationError('function cache memory options must be false or a plain object.');
		}
		const memoryOptions = memory as Record<string, unknown>;
		assertNoSymbolOptions(memoryOptions, 'function cache memory options');
		assertKnownFunctionCacheOptionKeys(memoryOptions, FUNCTION_CACHE_MEMORY_OPTION_KEYS, 'function cache memory options');
		normalizedMemory = {
			ttl: ownOptionValue(memoryOptions, 'ttl', 'function cache memory options') as number | undefined,
			maxEntries: ownOptionValue(memoryOptions, 'maxEntries', 'function cache memory options') as number | undefined
		};
	}
	if (singleFlight !== undefined && typeof singleFlight !== 'boolean') {
		throw new ActiveTsValidationError('function cache singleFlight option must be a boolean.');
	}
	if (context !== undefined && !(context instanceof ActiveContext)) {
		throw new ActiveTsValidationError('function cache context must be an ActiveContext.');
	}
	if (typeof cache === 'string') {
		assertSafeSchemaIdentifier(cache, 'function cache adapter name');
	}
	const normalizedCache = normalizeFunctionCacheAdapterOption(cache);
	return {
		prefix: prefix as string,
		factory: factory as FunctionCacheOptions<unknown, unknown>['factory'],
		key: key as FunctionCacheOptions<unknown, unknown>['key'],
		namespace: namespace as FunctionCacheOptions<unknown, unknown>['namespace'],
		context: context as ActiveContext | undefined,
		cache: normalizedCache as FunctionCacheOptions<unknown, unknown>['cache'],
		ttl: ttl as number | undefined,
		memory: normalizedMemory,
		singleFlight: singleFlight as boolean | undefined,
		staleWhileRevalidate: staleWhileRevalidate as number | undefined
	};
}

function normalizeFunctionCacheGetOptions(value: unknown): FunctionCacheGetOptions {
	if (value === undefined) return {};
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ActiveTsValidationError('function cache get options must be a plain object.');
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsValidationError('function cache get options must be a plain object.');
	}
	const options = value as Record<string, unknown>;
	assertNoSymbolOptions(options, 'function cache get options');
	assertKnownFunctionCacheOptionKeys(options, FUNCTION_CACHE_GET_OPTION_KEYS, 'function cache get options');
	const refresh = ownOptionValue(options, 'refresh', 'function cache get options');
	if (refresh !== undefined && typeof refresh !== 'boolean') {
		throw new ActiveTsValidationError('function cache get refresh option must be a boolean.');
	}
	return { refresh };
}

function assertNoSymbolOptions(record: Record<string, unknown>, context: string) {
	if (Object.getOwnPropertySymbols(record).length) {
		throw new ActiveTsValidationError(`${context} cannot contain symbol fields.`);
	}
}

function assertKnownFunctionCacheOptionKeys(record: Record<string, unknown>, allowed: readonly string[], context: string) {
	for (const property of Object.getOwnPropertyNames(record)) {
		if (!isKnownFunctionCacheOptionKey(property, allowed)) {
			throw new ActiveTsValidationError(`${context} contains unknown option "${property}".`);
		}
	}
}

function isKnownFunctionCacheOptionKey(property: string, allowed: readonly string[]) {
	for (let index = 0; index < allowed.length; index++) {
		if (allowed[index] === property) return true;
	}
	return false;
}

function ownOptionValue(record: Record<string, unknown>, key: string, context: string) {
	if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(record, key);
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsValidationError(`${context} "${key}" must be a data property.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsValidationError(`${context} "${key}" must be enumerable.`);
	}
	return descriptor.value;
}

function normalizeFunctionCacheAdapterOption(cache: unknown) {
	if (cache === undefined || cache === false || typeof cache === 'string') return cache;
	if (!cache || typeof cache !== 'object' || Array.isArray(cache)) {
		throw new ActiveTsValidationError('function cache adapter must be false, a string name, or a cache adapter object.');
	}
	const kind = functionCacheAdapterMember(cache, 'kind');
	const getMany = functionCacheAdapterMember(cache, 'getMany');
	const setMany = functionCacheAdapterMember(cache, 'setMany');
	const deleteMany = functionCacheAdapterMember(cache, 'deleteMany');
	if (
		typeof kind !== 'string' ||
		!kind ||
		kind.includes('\0') ||
		typeof getMany !== 'function' ||
		typeof setMany !== 'function' ||
		typeof deleteMany !== 'function'
	) {
		throw new ActiveTsValidationError('function cache adapter object must provide kind, getMany, setMany, and deleteMany.');
	}
	const normalized = Object.freeze({
		kind,
		getMany: getMany.bind(cache),
		setMany: setMany.bind(cache),
		deleteMany: deleteMany.bind(cache)
	});
	return markCacheAdapterSource(normalized, cache);
}

function cacheFailureSource(adapter: CacheAdapter) {
	return cacheAdapterSource(adapter);
}

function hasInvalidationFailure(adapter: CacheAdapter, key: string) {
	const keys = WEAKMAP_GET.call(functionCacheInvalidationFailures, cacheFailureSource(adapter)) as Set<string> | undefined;
	return keys ? SET_HAS.call(keys, key) : false;
}

function markInvalidationFailure(adapter: CacheAdapter, key: string) {
	const source = cacheFailureSource(adapter);
	const keys = (WEAKMAP_GET.call(functionCacheInvalidationFailures, source) as Set<string> | undefined) ?? new Set<string>();
	SET_ADD.call(keys, key);
	WEAKMAP_SET.call(functionCacheInvalidationFailures, source, keys);
}

function clearInvalidationFailure(adapter: CacheAdapter, key: string) {
	const source = cacheFailureSource(adapter);
	const keys = WEAKMAP_GET.call(functionCacheInvalidationFailures, source) as Set<string> | undefined;
	if (!keys) return;
	SET_DELETE.call(keys, key);
	if (!SET_SIZE.call(keys)) WEAKMAP_DELETE.call(functionCacheInvalidationFailures, source);
}

function markPendingInvalidation(key: string) {
	const count = (MAP_GET.call(functionCachePendingInvalidations, key) as number | undefined) ?? 0;
	MAP_SET.call(functionCachePendingInvalidations, key, count + 1);
}

function clearPendingInvalidation(key: string) {
	const count = (MAP_GET.call(functionCachePendingInvalidations, key) as number | undefined) ?? 0;
	if (count <= 1) {
		MAP_DELETE.call(functionCachePendingInvalidations, key);
		return;
	}
	MAP_SET.call(functionCachePendingInvalidations, key, count - 1);
}

function hasPendingInvalidation(key: string) {
	return MAP_HAS.call(functionCachePendingInvalidations, key);
}

function functionCacheTransactionScope(context: ActiveContext) {
	let scope = WEAKMAP_GET.call(functionCacheTransactionScopes, context) as number | undefined;
	if (scope === undefined) {
		scope = ++nextFunctionCacheTransactionScope;
		WEAKMAP_SET.call(functionCacheTransactionScopes, context, scope);
	}
	return scope;
}

function functionCacheAdapterMember(adapter: object, property: string) {
	let current: object | null = adapter;
	while (current && current !== Object.prototype) {
		if (Object.prototype.hasOwnProperty.call(current, property)) {
			const descriptor = Object.getOwnPropertyDescriptor(current, property);
			if (!descriptor || !('value' in descriptor)) {
				throw new ActiveTsValidationError(`function cache adapter object "${property}" must be a data property.`);
			}
			if (current === adapter && !descriptor.enumerable) {
				throw new ActiveTsValidationError(`function cache adapter object "${property}" must be enumerable.`);
			}
			return descriptor.value;
		}
		current = Object.getPrototypeOf(current);
	}
	return undefined;
}

function cloneFunctionCacheValue<TValue>(value: TValue): TValue {
	return value === undefined ? value : structuredClone(value);
}

function sanitizeFunctionCacheGetMany(value: unknown, adapter: string): unknown[] {
	if (!Array.isArray(value) || value.length !== 1) {
		throw new ActiveTsValidationError(`Function cache adapter "${adapter}" getMany result must be an array with 1 entries.`);
	}
	return snapshotArrayInput(value, `Function cache adapter "${adapter}" getMany result`);
}

function sanitizeFunctionCacheValue<TValue>(value: TValue | undefined, context: string): TValue | undefined {
	if (value === undefined) return undefined;
	try {
		assertCacheableValue(value);
		return cloneFunctionCacheValue(value);
	} catch (error) {
		if (error instanceof ActiveTsValidationError) {
			throw new ActiveTsValidationError(`${context}: ${error.message}`);
		}
		throw error;
	}
}

export function createFunctionCache<TInput, TValue>(options: FunctionCacheOptions<TInput, TValue>) {
	return new ActiveFunctionCache(options);
}

export function getFunctionCacheDiagnostics() {
	return {
		invalidationEpochs: MAP_SIZE.call(functionCacheInvalidationEpochs),
		invalidationEpochLimit: FUNCTION_CACHE_INVALIDATION_EPOCH_LIMIT
	};
}

function pruneFunctionCacheInvalidationEpochs() {
	while (MAP_SIZE.call(functionCacheInvalidationEpochs) > FUNCTION_CACHE_INVALIDATION_EPOCH_LIMIT) {
		const next = (MAP_KEYS.call(functionCacheInvalidationEpochs) as IterableIterator<string>).next();
		if (next.done) return;
		const key = next.value;
		const epoch = (MAP_GET.call(functionCacheInvalidationEpochs, key) as number | undefined) ?? functionCacheDefaultInvalidationEpoch;
		MAP_DELETE.call(functionCacheInvalidationEpochs, key);
		functionCacheDefaultInvalidationEpoch = Math.max(functionCacheDefaultInvalidationEpoch, epoch + 1);
	}
}

function stableInputKey(input: unknown) {
	return stableStringify(input, new WeakSet());
}

function stableStringify(input: unknown, seen: WeakSet<object>): string {
	if (input === null) return 'null';
	if (typeof input === 'string') return `string:${stableStringComponent(input)}`;
	if (typeof input === 'number') {
		if (!Number.isFinite(input)) throw new ActiveTsValidationError('Function cache default keys only support JSON-like inputs.');
		if (Object.is(input, -0)) return 'number:-0';
		return `number:${String(input)}`;
	}
	if (typeof input === 'boolean') return `boolean:${String(input)}`;
	if (typeof input === 'bigint') return `bigint:${input.toString()}`;
	if (input === undefined || typeof input === 'symbol' || typeof input === 'function') {
		throw new ActiveTsValidationError('Function cache default keys only support JSON-like inputs.');
	}
	if (input instanceof Date) {
		let timestamp: number;
		try {
			timestamp = DATE_GET_TIME.call(input);
		} catch {
			throw new ActiveTsValidationError('Function cache default keys only support JSON-like inputs.');
		}
		if (!Number.isFinite(timestamp)) throw new ActiveTsValidationError('Function cache default keys only support JSON-like inputs.');
		if (Object.getOwnPropertyNames(input).length || Object.getOwnPropertySymbols(input).length) {
			throw new ActiveTsValidationError('Function cache default keys only support JSON-like inputs.');
		}
		return `date:${DATE_TO_ISO_STRING.call(input)}`;
	}
	if (Array.isArray(input)) {
		if (WEAKSET_HAS.call(seen, input)) throw new ActiveTsValidationError('Cannot create a stable cache key for circular input.');
		WEAKSET_ADD.call(seen, input);
		try {
			if (Object.getOwnPropertySymbols(input).length) {
				throw new ActiveTsValidationError('Function cache default keys only support JSON-like inputs.');
			}
			for (const property of Object.getOwnPropertyNames(input)) {
				if (property === 'length') continue;
				if (!isArrayIndexProperty(property, input.length)) {
					throw new ActiveTsValidationError('Function cache default keys only support JSON-like inputs.');
				}
				stableInputPropertyValue(input, property);
			}
			let values = '';
			for (let index = 0; index < input.length; index++) {
				if (!Object.prototype.hasOwnProperty.call(input, index))
					throw new ActiveTsValidationError('Function cache default keys only support JSON-like inputs.');
				if (index > 0) values += ',';
				values += stableStringify(stableInputPropertyValue(input, String(index)), seen);
			}
			return `array:[${values}]`;
		} finally {
			WEAKSET_DELETE.call(seen, input);
		}
	}
	if (typeof input === 'object') {
		const prototype = Object.getPrototypeOf(input);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new ActiveTsValidationError('Function cache default keys only support JSON-like inputs.');
		}
		if (Object.getOwnPropertySymbols(input).length) {
			throw new ActiveTsValidationError('Function cache default keys only support JSON-like inputs.');
		}
		if (WEAKSET_HAS.call(seen, input)) throw new ActiveTsValidationError('Cannot create a stable cache key for circular input.');
		WEAKSET_ADD.call(seen, input);
		try {
			const keys = sortedStableInputPropertyNames(input);
			let entries = '';
			for (let index = 0; index < keys.length; index++) {
				const key = keys[index]!;
				if (index > 0) entries += ',';
				const value = stableStringify(stableInputPropertyValue(input, key), seen);
				entries += `${stableStringComponent(key)}:${value}`;
			}
			return `object:{${entries}}`;
		} finally {
			WEAKSET_DELETE.call(seen, input);
		}
	}
	throw new ActiveTsValidationError('Function cache default keys only support JSON-like inputs.');
}

function stableStringComponent(value: string) {
	return `${value.length}:${value}`;
}

function sortedStableInputPropertyNames(input: object) {
	const names = Object.getOwnPropertyNames(input);
	const sorted: string[] = [];
	for (let index = 0; index < names.length; index++) {
		insertSortedString(sorted, names[index]!);
	}
	return sorted;
}

function insertSortedString(values: string[], value: string) {
	let index = 0;
	while (index < values.length && values[index]! < value) index++;
	for (let move = values.length; move > index; move--) values[move] = values[move - 1]!;
	values[index] = value;
}

function stableInputPropertyValue(input: object, key: string) {
	const descriptor = Object.getOwnPropertyDescriptor(input, key);
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsValidationError('Function cache default keys only support JSON-like inputs.');
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsValidationError('Function cache default keys only support JSON-like inputs.');
	}
	return descriptor.value;
}

function isArrayIndexProperty(property: string, length: number) {
	if (!/^(0|[1-9]\d*)$/.test(property)) return false;
	const index = Number(property);
	return Number.isSafeInteger(index) && index >= 0 && index < length;
}
