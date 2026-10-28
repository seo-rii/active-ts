import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { inspect } from 'node:util';
import {
	clearDefaultContext,
	createActiveTs,
	getCurrentDefaultContext,
	setDefaultContext,
	type ActiveContext
} from '../core/context.js';
import { ActiveTsConfigurationError } from '../core/errors.js';
import { MemoryCacheAdapter } from '../adapters/cache/memory.js';
import { MemorySearchAdapter } from '../adapters/search/memory.js';
import { MemoryStoreAdapter } from '../adapters/store/memory.js';
import { resetLazyLoadWarnings } from '../core/lazy-ref.js';
import { valueFor } from '../core/query-utils.js';
import {
	assertDenseArrayItems,
	assertSafeEntityId,
	cloneSafeData,
	cloneSafeDataObject
} from '../core/safe-keys.js';
import type {
	ActiveTsConfig,
	CacheAdapter,
	MaybePromise,
	ModelConstructor,
	ResolvedModelMeta,
	SearchAdapter,
	StoreAdapter
} from '../core/types.js';
import {
	type LazyWarningMode,
	assertKnownOptionKeys,
	assertPlainTestOptionObject,
	joinStrings,
	mapArray,
	normalizeWithTestContextOptions,
	ownOptionValue,
	testingAdapterMember,
	testingAdapterMethod,
	validateLazyWarningMode
} from './shared.js';


export type TestContextOptions = {
	store?: StoreAdapter;
	cache?: CacheAdapter | false;
	search?: SearchAdapter | false;
	preset?: 'memory';
	lazyLoadWarnings?: LazyWarningMode;
	config?: Partial<Omit<ActiveTsConfig, 'stores' | 'caches' | 'search'>>;
};

export type TestContextSnapshot = {
	store: unknown;
	cache?: unknown;
	search?: unknown;
	stats: ReturnType<ActiveTestContext['stats']>;
	warnings: string[];
};

let lazyWarningCaptureActive = false;
const TEST_CONTEXT_OPTION_KEYS = ['store', 'cache', 'search', 'preset', 'lazyLoadWarnings', 'config'] as const;
const TEST_CONTEXT_CONFIG_FORBIDDEN_KEYS = ['stores', 'caches', 'search'] as const;

export class ActiveTestContext {
	readonly store: StoreAdapter;
	readonly cache?: CacheAdapter;
	readonly search?: SearchAdapter;
	readonly context: ActiveContext;
	readonly warnings: string[] = [];
	private previousContext: ActiveContext | undefined;
	private previousWarn: typeof console.warn | undefined;
	private installed = false;
	private readonly warningMode: LazyWarningMode;
	private static installedContext: ActiveTestContext | undefined;

	constructor(options: TestContextOptions = {}) {
		options = validateTestContextOptions(options);
		this.store = options.store ?? new MemoryStoreAdapter();
		this.cache = options.cache === false ? undefined : options.cache ?? new MemoryCacheAdapter();
		this.search = options.search === false ? undefined : options.search ?? new MemorySearchAdapter();
		this.warningMode = options.lazyLoadWarnings ?? 'capture';
		this.context = createActiveTs({
			defaultStore: 'default',
			defaultCache: this.cache ? 'default' : undefined,
			defaultSearch: this.search ? 'default' : undefined,
			lazyWarnings: this.warningMode !== 'off',
			...options.config,
			stores: { default: this.store },
			caches: this.cache ? { default: this.cache } : undefined,
			search: this.search ? { default: this.search } : undefined
		});
	}

	install() {
		if (this.installed) return this;
		if (lazyWarningCaptureActive) {
			throw new ActiveTsConfigurationError(
				'ActiveTestContext.install() mutates process-global console.warn and cannot overlap with captureLazyLoadWarnings().'
			);
		}
		if (ActiveTestContext.installedContext) {
			throw new ActiveTsConfigurationError(
				'ActiveTestContext.install() mutates process-global state and cannot overlap. Use withTestContext(context, fn, { install: false }) with bound models for parallel tests.'
			);
		}
		resetLazyLoadWarnings();
		this.previousContext = getCurrentDefaultContext();
		this.previousWarn = console.warn;
		if (this.warningMode === 'capture') {
			console.warn = (message?: any, ...args: any[]) => {
				const text = formatWarningArgs([message, ...args]);
				this.warnings.push(text);
			};
		} else if (this.warningMode === 'throw') {
			console.warn = (message?: any, ...args: any[]) => {
				const text = formatWarningArgs([message, ...args]);
				this.warnings.push(text);
				throw new Error(text);
			};
		}
		setDefaultContext(this.context);
		ActiveTestContext.installedContext = this;
		this.installed = true;
		return this;
	}

	restore() {
		if (!this.installed) return;
		if (this.previousWarn) console.warn = this.previousWarn;
		if (this.previousContext) setDefaultContext(this.previousContext);
		else clearDefaultContext();
		this.previousContext = undefined;
		this.previousWarn = undefined;
		if (ActiveTestContext.installedContext === this) ActiveTestContext.installedContext = undefined;
		this.installed = false;
	}

	static hasInstalledContext(context?: ActiveTestContext) {
		return context === undefined
			? !!ActiveTestContext.installedContext
			: ActiveTestContext.installedContext === context;
	}

	async seed<TModel extends { data: any }>(model: ModelConstructor<TModel>, rows: TModel['data'][]) {
		const safeRows = snapshotSeedRows<TModel['data']>(rows);
		const meta = this.context.meta(model);
		const ids = mapArray(safeRows, (row) => seedRowId(row, meta));
		const store = this.store as StoreAdapter & {
			seed?: (modelName: string, rows: TModel['data'][]) => MaybePromise<void>;
			seedModel?: (meta: ResolvedModelMeta, rows: TModel['data'][]) => MaybePromise<void>;
		};
		let writeFailed = false;
		let writeError: unknown;
		try {
			const seedModel = testingAdapterMethod(store, 'seedModel');
			const seed = seedModel ? undefined : testingAdapterMethod(store, 'seed');
			if (seedModel) await seedModel(meta, cloneSeedRowsForAdapter(safeRows));
			else if (seed) await seed(meta.name, cloneSeedRowsForAdapter(safeRows));
			else {
				for (let index = 0; index < safeRows.length; index++) {
					await this.store.create(meta, ids[index], cloneSafeDataObject(safeRows[index], `ActiveTestContext.seed() rows[${index}]`));
				}
			}
		} catch (error) {
			writeFailed = true;
			writeError = error;
		}
		// Fixture helpers write directly to the base store, so invalidate outside
		// any ambient transaction. A helper may partially write before rejecting.
		const invalidations = await Promise.allSettled(mapArray(ids, (id) => this.context.invalidateModelExternal(model, id)));
		const failures: unknown[] = [];
		if (writeFailed) failures.push(writeError);
		for (const result of invalidations) {
			if (result.status === 'rejected') failures.push(result.reason);
		}
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1) throw new AggregateError(failures, 'Fixture seed and cache invalidation failed.');
		return safeRows;
	}

	async fixture<TModel extends { data: any }>(
		model: ModelConstructor<TModel>,
		row: TModel['data']
	) {
		const [seeded] = await this.seed(model, [row]);
		return seeded;
	}

	reset(model?: ModelConstructor): Promise<void> {
		const modelName = model ? this.context.meta(model).name : undefined;
		// Validate helper shapes before starting any cleanup side effects.
		const reset = testingAdapterMethod(this.store, 'reset');
		const clearCache = this.cache ? testingAdapterMethod(this.cache, 'clear') : undefined;
		const clearSearch = this.search ? testingAdapterMethod(this.search, 'clear') : undefined;
		const operations: Array<() => MaybePromise<void>> = [];
		if (reset) operations.push(() => reset(modelName));
		if (clearCache) operations.push(() => clearCache());
		if (clearSearch) operations.push(() => clearSearch(modelName));
		const tasks: Array<Promise<void>> = [];
		for (const operation of operations) {
			try { tasks.push(Promise.resolve(operation())); }
			catch (error) { tasks.push(Promise.reject(error)); }
		}
		this.warnings.length = 0;
		resetLazyLoadWarnings();
		return Promise.allSettled(tasks).then((results) => {
			const errors: unknown[] = [];
			for (const result of results) {
				if (result.status === 'rejected') errors.push(result.reason);
			}
			if (errors.length === 1) throw errors[0];
			if (errors.length > 1) throw new AggregateError(errors, 'Test context reset cleanup failed.');
		});
	}

	snapshotStore(model?: ModelConstructor) {
		const modelName = model ? this.context.meta(model).name : undefined;
		const snapshot = testingAdapterMethod(this.store, 'snapshot');
		if (snapshot) return snapshotTestingSnapshot(snapshot(modelName), 'store');
		return undefined;
	}

	snapshot(): TestContextSnapshot {
		const cacheSnapshot = this.cache ? testingAdapterMethod(this.cache, 'snapshot') : undefined;
		const searchSnapshot = this.search ? testingAdapterMethod(this.search, 'snapshot') : undefined;
		const cache = cacheSnapshot ? snapshotTestingSnapshot(cacheSnapshot(), 'cache') : undefined;
		const search = searchSnapshot ? snapshotTestingSnapshot(searchSnapshot(), 'search') : undefined;
		return {
			store: this.snapshotStore(),
			cache,
			search,
			stats: this.stats(),
			warnings: [...this.warnings]
		};
	}

	stats() {
		return {
			store: snapshotTestingStats(testingAdapterMember(this.store, 'stats')),
			cache: this.cache ? snapshotTestingStats(testingAdapterMember(this.cache, 'stats')) : undefined,
			search: this.search ? snapshotTestingStats(testingAdapterMember(this.search, 'stats')) : undefined
		};
	}
}

function snapshotTestingStats(value: unknown) {
	return value === undefined ? undefined : cloneSafeData(value);
}

function snapshotTestingSnapshot(value: unknown, adapter: string) {
	if (value === undefined) return undefined;
	try {
		return cloneSafeData(value);
	} catch (error) {
		if (error instanceof Error) {
			error.message = `Testing ${adapter} snapshot is not safe data: ${error.message}`;
		}
		throw error;
	}
}

const currentTestContext = new AsyncLocalStorage<ActiveTestContext>();

export function createTestContext(options: TestContextOptions = {}) {
	return new ActiveTestContext(options);
}

export async function withTestContext<T>(
	context: ActiveTestContext,
	fn: (context: ActiveTestContext) => MaybePromise<T>,
	options: { install?: boolean } = {}
) {
	assertActiveTestContext(context, 'withTestContext context');
	if (typeof fn !== 'function') {
		throw new ActiveTsConfigurationError('withTestContext fn must be a function.');
	}
	const withOptions = normalizeWithTestContextOptions(options);
	return await currentTestContext.run(context, async () => {
		if (withOptions.install === false) return await fn(context);
		const alreadyInstalled = ActiveTestContext.hasInstalledContext(context);
		context.install();
		try {
			return await fn(context);
		} finally {
			if (!alreadyInstalled) context.restore();
		}
	});
}

export function getCurrentTestContext() {
	const context = currentTestContext.getStore();
	if (!context)
		throw new ActiveTsConfigurationError(
			'No active test context. Wrap the test in withTestContext(...) first.'
		);
	return context;
}

export async function resetTestContext(model?: ModelConstructor) {
	await getCurrentTestContext().reset(model);
}

export async function seed<TModel extends { data: any }>(
	model: ModelConstructor<TModel>,
	rows: TModel['data'][]
) {
	return await getCurrentTestContext().seed(model, rows);
}

export async function fixture<TModel extends { data: any }>(
	model: ModelConstructor<TModel>,
	row: TModel['data']
) {
	return await getCurrentTestContext().fixture(model, row);
}

export function snapshotStore(model?: ModelConstructor) {
	return getCurrentTestContext().snapshotStore(model);
}

export async function captureLazyLoadWarnings<T>(fn: () => MaybePromise<T>) {
	if (typeof fn !== 'function') {
		throw new ActiveTsConfigurationError('captureLazyLoadWarnings fn must be a function.');
	}
	if (lazyWarningCaptureActive || ActiveTestContext.hasInstalledContext()) {
		throw new ActiveTsConfigurationError(
			'captureLazyLoadWarnings() mutates process-global console.warn and cannot overlap with another warning capture or installed test context.'
		);
	}
	const warnings: string[] = [];
	const originalWarn = console.warn;
	lazyWarningCaptureActive = true;
	resetLazyLoadWarnings();
	console.warn = (message?: any, ...args: any[]) => {
		warnings.push(formatWarningArgs([message, ...args]));
	};
	try {
		const result = await fn();
		return { result, warnings };
	} finally {
		console.warn = originalWarn;
		lazyWarningCaptureActive = false;
		resetLazyLoadWarnings();
	}
}

function formatWarningArgs(args: unknown[]) {
	return joinStrings(mapArray(args, formatWarningArg), ' ');
}

function formatWarningArg(value: unknown) {
	if (typeof value === 'string') return value;
	if (value === null) return 'null';
	if (value === undefined) return 'undefined';
	const valueType = typeof value;
	if (valueType !== 'object' && valueType !== 'function') return String(value);
	try {
		return inspect(value, { breakLength: Infinity, customInspect: false, getters: false });
	} catch {
		return '<unprintable warning argument>';
	}
}

export async function expectNoLazyLoadWarnings<T>(fn: () => MaybePromise<T>) {
	const { result, warnings } = await captureLazyLoadWarnings(fn);
	assert.deepEqual(warnings, []);
	return result;
}

function validateTestContextOptions(options: TestContextOptions) {
	assertPlainTestOptionObject(options, 'Test context options');
	const record = options as Record<string, unknown>;
	assertKnownOptionKeys(record, TEST_CONTEXT_OPTION_KEYS, 'Test context options');
	const store = ownOptionValue(record, 'store', 'Test context options');
	const cache = ownOptionValue(record, 'cache', 'Test context options');
	const search = ownOptionValue(record, 'search', 'Test context options');
	const preset = ownOptionValue(record, 'preset', 'Test context options');
	const lazyLoadWarnings = ownOptionValue(record, 'lazyLoadWarnings', 'Test context options');
	const config = ownOptionValue(record, 'config', 'Test context options');
	assertNonNullTestAdapter(store, 'store');
	assertNonNullTestAdapter(cache, 'cache');
	assertNonNullTestAdapter(search, 'search');
	if (preset !== undefined && preset !== 'memory')
		throw new ActiveTsConfigurationError(
			typeof preset === 'string' ? `Unknown test preset "${preset}".` : 'Unknown test preset.'
		);
	if (lazyLoadWarnings !== undefined) validateLazyWarningMode(lazyLoadWarnings);
	if (config !== undefined) {
		assertPlainTestOptionObject(config, 'Test context config');
		assertNoTestContextAdapterRegistries(config as Record<string, unknown>);
	}
	return {
		store: store as StoreAdapter | undefined,
		cache: cache as CacheAdapter | undefined,
		search: search as SearchAdapter | undefined,
		preset: preset as 'memory' | undefined,
		lazyLoadWarnings: lazyLoadWarnings as LazyWarningMode | undefined,
		config: config as TestContextOptions['config']
	};
}

function assertNonNullTestAdapter(value: unknown, option: 'store' | 'cache' | 'search') {
	if (value !== null) return;
	throw new ActiveTsConfigurationError(
		`Test context ${option} cannot be null. Omit the option to use the memory default${option === 'store' ? '.' : ', or pass false to disable it.'}`
	);
}

function assertNoTestContextAdapterRegistries(config: Record<string, unknown>) {
	for (const property of TEST_CONTEXT_CONFIG_FORBIDDEN_KEYS) {
		if (Object.prototype.hasOwnProperty.call(config, property)) {
			const option = property === 'stores' ? 'store' : property === 'caches' ? 'cache' : 'search';
			throw new ActiveTsConfigurationError(
				`Test context config cannot include adapter registry "${property}". Use createTestContext() ${option} option instead.`
			);
		}
	}
}

function assertActiveTestContext(context: unknown, label: string): asserts context is ActiveTestContext {
	if (!(context instanceof ActiveTestContext)) {
		throw new ActiveTsConfigurationError(`${label} must be an ActiveTestContext.`);
	}
}

function snapshotSeedRows<T>(rows: T[]): T[] {
	if (!Array.isArray(rows)) {
		throw new ActiveTsConfigurationError('ActiveTestContext.seed() rows must be an array.');
	}
	if (Object.getOwnPropertySymbols(rows).length) {
		throw new ActiveTsConfigurationError('ActiveTestContext.seed() rows cannot contain symbol fields.');
	}
	assertDenseArrayItems(rows, 'ActiveTestContext.seed() rows');
	const safeRows: T[] = [];
	for (let index = 0; index < rows.length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(rows, String(index));
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsConfigurationError(`ActiveTestContext.seed() rows[${index}] must be a data property.`);
		}
		safeRows.push(cloneSafeDataObject(descriptor.value, `ActiveTestContext.seed() rows[${index}]`) as T);
	}
	return safeRows;
}

function cloneSeedRowsForAdapter<T>(rows: T[]): T[] {
	return cloneSafeData(rows) as T[];
}

function seedRowId(row: Record<string, unknown>, meta: ResolvedModelMeta) {
	const id = valueFor(row, meta.idField);
	assertSafeEntityId(id, `ActiveTestContext.seed() ${meta.name}.${meta.idField}`);
	return id;
}
