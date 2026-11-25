import { ActiveTsConfigurationError } from '../core/errors.js';
import type { CacheAdapter, MaybePromise, SearchAdapter, StoreAdapter } from '../core/types.js';
import { ActiveTestContext, createTestContext, withTestContext } from './context.js';
import {
	type SearchAdapterContractOptions,
	type StoreAdapterContractOptions,
	normalizeSearchAdapterContractOptions,
	normalizeStoreAdapterContractOptions,
	runCacheAdapterContract,
	runSearchAdapterContract,
	runStoreAdapterContract
} from './contracts.js';
import {
	type LazyWarningMode,
	assertKnownOptionKeys,
	assertPlainTestOptionObject,
	normalizeWithTestContextOptions,
	ownOptionValue,
	validateLazyWarningMode
} from './shared.js';

const INTEGRATION_HARNESS_KEYS = [
	'name',
	'start',
	'stop',
	'createStore',
	'createCache',
	'createSearch',
	'lazyLoadWarnings'
] as const;

export type IntegrationHarness<TResource = unknown> = {
	name: string;
	start?: () => MaybePromise<TResource>;
	stop?: (resource: TResource | undefined) => MaybePromise<void>;
	createStore: (resource: TResource | undefined) => MaybePromise<StoreAdapter>;
	createCache?: (resource: TResource | undefined) => MaybePromise<CacheAdapter | undefined>;
	createSearch?: (resource: TResource | undefined) => MaybePromise<SearchAdapter | undefined>;
	lazyLoadWarnings?: LazyWarningMode;
};

export type IntegrationHarnessContextHandle<TResource = unknown> = {
	context: ActiveTestContext;
	resource: TResource | undefined;
	close: () => Promise<void>;
	dispose: () => Promise<void>;
};

export type IntegrationHarnessApi<TResource = unknown> = {
	name: string;
	createContext: () => Promise<IntegrationHarnessContextHandle<TResource>>;
	withContext: <T>(
		fn: (context: ActiveTestContext) => MaybePromise<T>,
		options?: { install?: boolean }
	) => Promise<T>;
	runStoreContract: (options?: StoreAdapterContractOptions) => Promise<void>;
	runCacheContract: () => Promise<void>;
	runSearchContract: (options?: SearchAdapterContractOptions) => Promise<void>;
};

export function createIntegrationHarness<TResource = unknown>(
	harness: IntegrationHarness<TResource>
): IntegrationHarnessApi<TResource> {
	harness = validateIntegrationHarness(harness);
	const api = {
		name: harness.name,
		async createContext() {
			let resource: TResource | undefined;
			try {
				resource = harness.start ? await harness.start() : undefined;
				let closed = false;
				const store = requireIntegrationHarnessStore(await harness.createStore(resource), harness.name);
				const cache = harness.createCache
					? requireOptionalIntegrationHarnessAdapter<CacheAdapter>(await harness.createCache(resource), harness.name, 'createCache')
					: undefined;
				const search = harness.createSearch
					? requireOptionalIntegrationHarnessAdapter<SearchAdapter>(await harness.createSearch(resource), harness.name, 'createSearch')
					: undefined;
				const context = createTestContext({
					store,
					cache: cache === undefined ? false : cache,
					search: search === undefined ? false : search,
					lazyLoadWarnings: harness.lazyLoadWarnings ?? 'capture'
				});
				let closePromise: Promise<void> | undefined;
				const close = async () => {
					if (closed) return;
					if (closePromise) return await closePromise;
					closePromise = (async () => {
						if (harness.stop) await harness.stop(resource);
						closed = true;
					})();
					try {
						await closePromise;
					} finally {
						closePromise = undefined;
					}
				};
				return { context, resource, close, dispose: close };
			} catch (error) {
				if (harness.stop) {
					try {
						await harness.stop(resource);
					} catch (stopError) {
						throw new AggregateError(
							[error, stopError],
							`Integration harness "${harness.name}" failed to create a context and cleanup failed.`
						);
					}
				}
				throw error;
			}
		},
		async withContext<T>(
			fn: (context: ActiveTestContext) => MaybePromise<T>,
			options: { install?: boolean } = {}
		) {
			if (typeof fn !== 'function') {
				throw new ActiveTsConfigurationError('withTestContext fn must be a function.');
			}
			const withOptions = normalizeWithTestContextOptions(options);
			const handle = await api.createContext();
			let result: T | undefined;
			let runError: unknown;
			let runFailed = false;
			try {
				result = await withTestContext(handle.context, fn, withOptions);
			} catch (error) {
				runError = error;
				runFailed = true;
			}
			try {
				await handle.close();
			} catch (closeError) {
				if (runFailed) {
					throw new AggregateError(
						[runError, closeError],
						`Integration harness "${harness.name}" failed while running withContext and cleanup failed.`
					);
				}
				throw closeError;
			}
			if (runFailed) throw runError;
			return result as T;
		},
		async runStoreContract(options: StoreAdapterContractOptions = {}) {
			const contractOptions = normalizeStoreAdapterContractOptions(options);
			let resource: TResource | undefined;
			let contractError: unknown;
			let contractFailed = false;
			let stopError: unknown;
			let stopFailed = false;
			try {
				resource = harness.start ? await harness.start() : undefined;
				await runStoreAdapterContract(await harness.createStore(resource), contractOptions);
			} catch (error) {
				contractError = error;
				contractFailed = true;
			}
			if (harness.stop) {
				try {
					await harness.stop(resource);
				} catch (error) {
					stopError = error;
					stopFailed = true;
				}
			}
			if (contractFailed && stopFailed) {
				throw new AggregateError(
					[contractError, stopError],
					`Integration harness "${harness.name}" failed to run the store contract and cleanup failed.`
				);
			}
			if (contractFailed) throw contractError;
			if (stopFailed) throw stopError;
		},
		async runCacheContract() {
			let resource: TResource | undefined;
			let contractError: unknown;
			let contractFailed = false;
			let stopError: unknown;
			let stopFailed = false;
			try {
				resource = harness.start ? await harness.start() : undefined;
				if (!harness.createCache) {
					throw new ActiveTsConfigurationError(
						`Integration harness "${harness.name}" does not define createCache().`
					);
				}
				const cache = await harness.createCache(resource);
				if (!cache) {
					throw new ActiveTsConfigurationError(
						`Integration harness "${harness.name}" createCache() must return a cache adapter.`
					);
				}
				await runCacheAdapterContract(cache);
			} catch (error) {
				contractError = error;
				contractFailed = true;
			}
			if (harness.stop) {
				try {
					await harness.stop(resource);
				} catch (error) {
					stopError = error;
					stopFailed = true;
				}
			}
			if (contractFailed && stopFailed) {
				throw new AggregateError(
					[contractError, stopError],
					`Integration harness "${harness.name}" failed to run the cache contract and cleanup failed.`
				);
			}
			if (contractFailed) throw contractError;
			if (stopFailed) throw stopError;
		},
		async runSearchContract(options: SearchAdapterContractOptions = {}) {
			const contractOptions = normalizeSearchAdapterContractOptions(options);
			let resource: TResource | undefined;
			let contractError: unknown;
			let contractFailed = false;
			let stopError: unknown;
			let stopFailed = false;
			try {
				resource = harness.start ? await harness.start() : undefined;
				if (!harness.createSearch) {
					throw new ActiveTsConfigurationError(
						`Integration harness "${harness.name}" does not define createSearch().`
					);
				}
				const search = await harness.createSearch(resource);
				if (!search) {
					throw new ActiveTsConfigurationError(
						`Integration harness "${harness.name}" createSearch() must return a search adapter.`
					);
				}
				await runSearchAdapterContract(search, contractOptions);
			} catch (error) {
				contractError = error;
				contractFailed = true;
			}
			if (harness.stop) {
				try {
					await harness.stop(resource);
				} catch (error) {
					stopError = error;
					stopFailed = true;
				}
			}
			if (contractFailed && stopFailed) {
				throw new AggregateError(
					[contractError, stopError],
					`Integration harness "${harness.name}" failed to run the search contract and cleanup failed.`
				);
			}
			if (contractFailed) throw contractError;
			if (stopFailed) throw stopError;
		}
	};
	return api;
}

function requireIntegrationHarnessStore(value: unknown, name: string): StoreAdapter {
	if (value === undefined || value === null || value === false) {
		throw new ActiveTsConfigurationError(`Integration harness "${name}" createStore() must return a store adapter.`);
	}
	return value as StoreAdapter;
}

function requireOptionalIntegrationHarnessAdapter<TAdapter>(
	value: unknown,
	name: string,
	factory: 'createCache' | 'createSearch'
): TAdapter | undefined {
	if (value === undefined) return undefined;
	if (value === null || value === false) {
		throw new ActiveTsConfigurationError(
			`Integration harness "${name}" ${factory}() must return an adapter or undefined.`
		);
	}
	return value as TAdapter;
}

function validateIntegrationHarness<TResource>(
	harness: IntegrationHarness<TResource>
): IntegrationHarness<TResource> {
	if (!harness || typeof harness !== 'object' || Array.isArray(harness)) {
		throw new ActiveTsConfigurationError('Integration harness must be an object.');
	}
	assertPlainTestOptionObject(harness, 'Integration harness');
	const record = harness as Record<string, unknown>;
	assertKnownOptionKeys(record, INTEGRATION_HARNESS_KEYS, 'Integration harness');
	const name = ownOptionValue(record, 'name', 'Integration harness');
	const start = ownOptionValue(record, 'start', 'Integration harness');
	const stop = ownOptionValue(record, 'stop', 'Integration harness');
	const createStore = ownOptionValue(record, 'createStore', 'Integration harness');
	const createCache = ownOptionValue(record, 'createCache', 'Integration harness');
	const createSearch = ownOptionValue(record, 'createSearch', 'Integration harness');
	const lazyLoadWarnings = ownOptionValue(record, 'lazyLoadWarnings', 'Integration harness');
	if (typeof name !== 'string' || !name) {
		throw new ActiveTsConfigurationError('Integration harness name must be a non-empty string.');
	}
	if (start !== undefined && typeof start !== 'function') {
		throw new ActiveTsConfigurationError('Integration harness start must be a function.');
	}
	if (stop !== undefined && typeof stop !== 'function') {
		throw new ActiveTsConfigurationError('Integration harness stop must be a function.');
	}
	if (typeof createStore !== 'function') {
		throw new ActiveTsConfigurationError('Integration harness createStore must be a function.');
	}
	if (createCache !== undefined && typeof createCache !== 'function') {
		throw new ActiveTsConfigurationError('Integration harness createCache must be a function.');
	}
	if (createSearch !== undefined && typeof createSearch !== 'function') {
		throw new ActiveTsConfigurationError('Integration harness createSearch must be a function.');
	}
	if (lazyLoadWarnings !== undefined) validateLazyWarningMode(lazyLoadWarnings);
	return {
		name,
		start: start as IntegrationHarness<TResource>['start'],
		stop: stop as IntegrationHarness<TResource>['stop'],
		createStore: createStore as IntegrationHarness<TResource>['createStore'],
		createCache: createCache as IntegrationHarness<TResource>['createCache'],
		createSearch: createSearch as IntegrationHarness<TResource>['createSearch'],
		lazyLoadWarnings: lazyLoadWarnings as LazyWarningMode | undefined
	};
}
