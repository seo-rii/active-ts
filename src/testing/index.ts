import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import {
	clearDefaultContext,
	createActiveTs,
	getCurrentDefaultContext,
	setDefaultContext,
	type ActiveContext
} from '../core/context.js';
import {
	ActiveTsConfigurationError,
	ActiveTsConflictError,
	ActiveTsNotFoundError,
	safeErrorMessage
} from '../core/errors.js';
import { MemoryCacheAdapter } from '../adapters/cache/memory.js';
import { MemorySearchAdapter } from '../adapters/search/memory.js';
import { MemoryStoreAdapter } from '../adapters/store/memory.js';
import { resetLazyLoadWarnings } from '../core/lazy-ref.js';
import { entityIdKey, valueFor } from '../core/query-utils.js';
import { datastoreKey } from '../core/datastore-key.js';
import { snapshotArrayInput } from '../core/array-input.js';
import {
	assertDenseArrayItems,
	assertSafeCacheKey,
	assertSafeEntityId,
	assertSafeResultCount,
	assertSafeSchemaIdentifier,
	cloneSafeData,
	cloneSafeDataObject
} from '../core/safe-keys.js';
import { datastoreSchemaAncestorModes, normalizeSchemaPlan } from '../core/schema-utils.js';
import {
	assertStoreDataMatchesId,
	normalizeStoreQueryResultForModel,
	storeTrustsDatastoreEntityKeyRows
} from '../core/store-options.js';
import { searchDocumentIdentity, searchHitDocumentIdentity } from '../core/search-utils.js';
import { MAP_SET, SET_ADD, SET_HAS } from '../core/collection-intrinsics.js';
import type {
	ActiveTsConfig,
	CacheAdapter,
	DatastoreKey,
	EntityId,
	FieldCodec,
	FieldType,
	MaybePromise,
	ModelConstructor,
	QueryResult,
	ResolvedModelMeta,
	SchemaPlan,
	SearchAdapter,
	SortDirection,
	StoreAdapter,
	StoreReadOptions
} from '../core/types.js';

const SAFE_PROMISE = Promise;
const PROMISE_THEN = SAFE_PROMISE.prototype.then;

function startUnobservedContractCreate(
	adapter: StoreAdapter,
	model: ResolvedModelMeta,
	id: EntityId,
	data: StoreContractModel
): Promise<void> {
	let operation: Promise<void>;
	try {
		operation = adapter.create(model, id, data);
	} catch (error) {
		operation = SAFE_PROMISE.reject(error);
	}
	void PROMISE_THEN.call(operation, undefined, () => undefined);
	return operation;
}

function capturedMap<K, V>(entries: ReadonlyArray<readonly [K, V]> = []): Map<K, V> {
	const map = new Map<K, V>();
	for (const [key, value] of entries) MAP_SET.call(map, key, value);
	return map;
}

export type StoreContractModel = {
	id: EntityId;
	name: string;
	score: number;
	tags?: string[];
	token?: string;
	optionalMarker?: string | null;
	profile?: { city?: string };
	version?: number;
};

export type StoreContractCustomIdModel = {
	slug: EntityId;
	name: string;
	score: number;
};

export type StoreContractDatastoreAncestorModel = {
	id: EntityId;
	parentId: number;
	name: string;
	score: number;
};

export type SearchContractCustomIdModel = {
	slug: EntityId;
	title: string;
	score: number;
};

export type SearchContractDatastoreAncestorModel = {
	id: EntityId;
	parentId: number;
	title: string;
	score: number;
};

export type LazyWarningMode = 'console' | 'capture' | 'throw' | 'off';

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
const WITH_TEST_CONTEXT_OPTION_KEYS = ['install'] as const;
const STORE_ADAPTER_CONTRACT_OPTION_KEYS = ['nativeProbe'] as const;
const SEARCH_ADAPTER_CONTRACT_OPTION_KEYS = ['settleMs', 'pollIntervalMs', 'nativeProbe'] as const;
const SEARCH_CONTRACT_RESULT_KEYS = ['list', 'cursor', 'more', 'count', 'total'] as const;
const INTEGRATION_HARNESS_KEYS = [
	'name',
	'start',
	'stop',
	'createStore',
	'createCache',
	'createSearch',
	'lazyLoadWarnings'
] as const;
const STORE_CONTRACT_CAPABILITY_KEYS = [
	'or',
	'contains',
	'arrayContains',
	'textContains',
	'jsonContains',
	'startsWith',
	'cursor',
	'offset',
	'select',
	'nestedFields',
	'numericComparisons',
	'aggregate',
	'transaction',
	'transactionConflictDetection',
	'savepoint',
	'uniqueIndex',
	'optimisticLock',
	'nullOperators',
	'missingFieldNulls',
	'native',
	'datastoreAncestor',
	'datastoreReadPolicy'
] as const;
const SEARCH_CONTRACT_CAPABILITY_KEYS = [
	'where',
	'whereOperators',
	'nestedFields',
	'numericComparisons',
	'nullOperators',
	'cursor',
	'native',
	'index',
	'revisionWrites'
] as const;
const STORE_CONTRACT_TOKEN_CODEC: FieldCodec = {
	name: 'store_contract_token_codec',
	encode: (value) => `encoded:${String(value)}`,
	decode: (value) => String(value).replace(/^encoded:/, ''),
	encodeQuery: (value) => `encoded:${String(value)}`
};
const SEARCH_CONTRACT_WHERE_OPERATOR_KEYS = [
	'=',
	'!=',
	'>',
	'>=',
	'<',
	'<=',
	'in',
	'between',
	'isNull',
	'isNotNull',
	'contains',
	'arrayContains',
	'textContains',
	'jsonContains',
	'startsWith'
] as const;
const SEARCH_CONTRACT_UNSUPPORTED_WHERE_CASES = [
	{ operator: '=', where: { title: 'shared number' } },
	{ operator: '!=', where: { title: ['!=', 'missing'] } },
	{ operator: '>', where: { score: ['>', 5] } },
	{ operator: '>=', where: { score: ['>=', 5] } },
	{ operator: '<', where: { score: ['<', 25] } },
	{ operator: '<=', where: { score: ['<=', 25] } },
	{ operator: 'in', where: { score: ['in', [10, 20]] } },
	{ operator: 'between', where: { score: ['between', 5, 25] } },
	{ operator: 'isNull', where: { subtitle: ['isNull'] } },
	{ operator: 'isNotNull', where: { subtitle: ['isNotNull'] } },
	{ operator: 'contains', where: { title: ['contains', 'shared'] } },
	{ operator: 'arrayContains', where: { tags: ['arrayContains', 'cat'] } },
	{ operator: 'textContains', where: { title: ['textContains', 'shared'] } },
	{ operator: 'jsonContains', where: { profile: ['jsonContains', { city: 'Seoul' }] } },
	{ operator: 'startsWith', where: { title: ['startsWith', 'shared'] } }
] as const;

function capturedSet<T>(values: readonly T[]) {
	const set = new Set<T>();
	for (const value of values) SET_ADD.call(set, value);
	return set;
}

function mapArray<T, U>(items: readonly T[], mapper: (item: T, index: number) => U) {
	const result: U[] = [];
	for (let index = 0; index < items.length; index++) result[result.length] = mapper(items[index], index);
	return result;
}

function someArray<T>(items: readonly T[], predicate: (item: T, index: number) => boolean) {
	for (let index = 0; index < items.length; index++) {
		if (predicate(items[index], index)) return true;
	}
	return false;
}

function everyArray<T>(items: readonly T[], predicate: (item: T, index: number) => boolean) {
	for (let index = 0; index < items.length; index++) {
		if (!predicate(items[index], index)) return false;
	}
	return true;
}

function sortEntityIds(ids: EntityId[]) {
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

function joinStrings(values: readonly string[], separator: string) {
	let result = '';
	for (let index = 0; index < values.length; index++) {
		if (index > 0) result += separator;
		result += values[index];
	}
	return result;
}

type SearchContractModel = {
	id: EntityId;
	title: string;
	subtitle?: string | null;
	body?: string;
	score?: number;
	tags?: string[];
	profile?: { city?: string };
};

export type StoreAdapterContractOptions = {
	/** Required positive native-payload probe for adapters that advertise `capabilities.native`. */
	nativeProbe?: (input: { adapter: StoreAdapter; model: ResolvedModelMeta<any> }) => void | Promise<void>;
};

type NormalizedStoreAdapterContractOptions = {
	nativeProbe?: (input: { adapter: StoreAdapter; model: ResolvedModelMeta<any> }) => void | Promise<void>;
};

export type SearchAdapterContractOptions = {
	/**
	 * How long the contract may poll for indexed/deleted search documents to
	 * become visible. Keep this at the default for synchronous test adapters.
	 */
	settleMs?: number;
	/** Delay between search visibility checks when `settleMs` is non-zero. */
	pollIntervalMs?: number;
	/** Required positive native-payload probe for adapters that advertise `capabilities.native`. */
	nativeProbe?: (input: { adapter: SearchAdapter; model: ResolvedModelMeta<any> }) => void | Promise<void>;
};

type NormalizedSearchAdapterContractOptions = {
	settleMs: number;
	pollIntervalMs: number;
	nativeProbe?: (input: { adapter: SearchAdapter; model: ResolvedModelMeta<any> }) => void | Promise<void>;
};

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

	static hasInstalledContext() {
		return !!ActiveTestContext.installedContext;
	}

	async seed<TModel extends { data: any }>(model: ModelConstructor<TModel>, rows: TModel['data'][]) {
		const safeRows = snapshotSeedRows<TModel['data']>(rows);
		const meta = this.context.meta(model);
		const ids = mapArray(safeRows, (row) => seedRowId(row, meta));
		const store = this.store as StoreAdapter & {
			seed?: (modelName: string, rows: TModel['data'][]) => MaybePromise<void>;
			seedModel?: (meta: ResolvedModelMeta, rows: TModel['data'][]) => MaybePromise<void>;
		};
		const seedModel = testingAdapterMethod(store, 'seedModel');
		if (seedModel) {
			await seedModel(meta, cloneSeedRowsForAdapter(safeRows));
			return safeRows;
		}
		const seed = testingAdapterMethod(store, 'seed');
		if (seed) {
			await seed(meta.name, cloneSeedRowsForAdapter(safeRows));
			return safeRows;
		}
		for (let index = 0; index < safeRows.length; index++) {
			const row = safeRows[index];
			await this.store.create(meta, ids[index], cloneSafeDataObject(row, `ActiveTestContext.seed() rows[${index}]`));
		}
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
		const tasks: Array<MaybePromise<void>> = [];
		const reset = testingAdapterMethod(this.store, 'reset');
		if (reset) tasks.push(reset(modelName));
		if (this.cache) {
			const clear = testingAdapterMethod(this.cache, 'clear');
			if (clear) tasks.push(clear());
		}
		if (this.search) {
			const clear = testingAdapterMethod(this.search, 'clear');
			if (clear) tasks.push(clear(modelName));
		}
		this.warnings.length = 0;
		resetLazyLoadWarnings();
		return Promise.all(tasks).then(() => undefined);
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

function testingAdapterMethod(adapter: object, property: string) {
	const value = testingAdapterMember(adapter, property);
	if (value === undefined) return undefined;
	if (typeof value !== 'function') {
		throw new ActiveTsConfigurationError(`Testing adapter property "${property}" must be a function.`);
	}
	return value.bind(adapter);
}

function testingAdapterMember(adapter: object, property: string) {
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
		context.install();
		try {
			return await fn(context);
		} finally {
			context.restore();
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

export async function runStoreAdapterContract(
	adapter: StoreAdapter,
	options: StoreAdapterContractOptions = {}
) {
	adapter = validateStoreContractAdapter(adapter, 'Store contract adapter');
	const contractOptions = normalizeStoreAdapterContractOptions(options);
	const capabilities = snapshotStoreContractCapabilities(adapter, 'Store contract adapter');
	assertStoreContractCapabilityMethods(adapter, capabilities);
	const model: ResolvedModelMeta<StoreContractModel> = {
		model: class {},
		name: `contract_${randomUUID()}`,
		store: adapter.kind,
		idField: 'id',
		readValidation: 'off',
		indexes: [{ name: 'score', fields: ['score'] }],
		searchIndexes: [],
		relations: new Map(),
		hooks: {},
		views: new Map(),
		policies: new Map(),
		scopes: new Map(),
		fieldCodecs: capturedMap<string, FieldCodec>([['token', STORE_CONTRACT_TOKEN_CODEC]]),
		fieldTypes: capturedMap<string, FieldType>([['score', 'number']])
	};
	const uniqueModel: ResolvedModelMeta<StoreContractModel> = {
		...model,
		model: class {},
		name: `contract_unique_${randomUUID()}`,
		indexes: [{ name: 'unique_name', fields: ['name'], directions: ['desc'], unique: true }]
	};
	const customIdModel: ResolvedModelMeta<StoreContractCustomIdModel> = {
		model: class {},
		name: `contract_custom_id_${randomUUID()}`,
		store: adapter.kind,
		idField: 'slug',
		readValidation: 'off',
		indexes: [],
		searchIndexes: [],
		relations: new Map(),
		hooks: {},
		views: new Map(),
		policies: new Map(),
		scopes: new Map(),
		fieldCodecs: new Map(),
		fieldTypes: capturedMap<string, FieldType>([['score', 'number']])
	};
	const datastoreAncestorLeft = datastoreKey('contract_parent', 10);
	const datastoreAncestorRight = datastoreKey('contract_parent', 20);
	const datastoreAncestorModelName = `contract_ds_ancestor_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
	const datastoreAncestorModel: ResolvedModelMeta<StoreContractDatastoreAncestorModel> = {
		model: class {},
		name: datastoreAncestorModelName,
		store: adapter.kind,
		idField: 'id',
		readValidation: 'off',
		indexes: [{ name: 'parent_score', fields: ['parentId', 'score'] }],
		searchIndexes: [],
		relations: new Map(),
		hooks: {},
		views: new Map(),
		policies: new Map(),
		scopes: new Map(),
		fieldCodecs: new Map(),
		fieldTypes: capturedMap<string, FieldType>([
			['parentId', 'number'],
			['score', 'number']
		]),
		datastore: {
			ancestor: ({ data }) => {
				if (data === undefined) return undefined;
				return datastoreKey('contract_parent', data.parentId);
			},
			ancestorFields: ['parentId']
		}
	};
	const cleanupIds: EntityId[] = [1, 2, 4, '1', 900, '900', 777, 778, 780, 781, 880, 881, 882, 883, 885, 886, 887, 888, 889, 890, 891, 892, 893, 894, 910, 911, 912, 913, 914, 915, 916, 'codec-token', 998, 999];
	let datastoreAncestorCleanupFixtures: Array<{ id: EntityId; ancestor: DatastoreKey }> = [];

	if (adapter.schema) {
		const schemaModels: ResolvedModelMeta[] = capabilities?.datastoreAncestor === true
			? [model, customIdModel, datastoreAncestorModel]
			: [model, customIdModel];
		const schemaPlan = normalizeSchemaPlan(
			await adapter.schema.plan(schemaModels),
			`Store contract adapter "${adapter.kind}" schema plan`
		);
		if (capabilities?.datastoreAncestor === true) {
			assertStoreContractDatastoreAncestorSchemaPlan(
				schemaPlan,
				datastoreAncestorModel,
				`Store contract adapter "${adapter.kind}" schema plan`
			);
		}
		const schemaApplyPlan = normalizeSchemaPlan(
			await adapter.schema.apply(schemaModels, { mode: 'safe' }),
			`Store contract adapter "${adapter.kind}" schema apply plan`
		);
		if (capabilities?.datastoreAncestor === true) {
			assertStoreContractDatastoreAncestorSchemaPlan(
				schemaApplyPlan,
				datastoreAncestorModel,
				`Store contract adapter "${adapter.kind}" schema apply plan`
			);
		}
	}
	let contractError: unknown;
	try {
	await adapter.create(model, 1, { id: 1, name: 'alpha', score: 10 });
	await adapter.create(model, 2, { id: 2, name: 'beta', score: 20, tags: ['cat'], optionalMarker: 'set', profile: { city: 'Seoul' } });
	await adapter.create(model, 4, { id: 4, name: 'null-marker', score: 5, optionalMarker: null });
	await assert.rejects(() => adapter.create(model, 1, { id: 1, name: 'duplicate', score: 99 }));
	await assert.rejects(() =>
		adapter.create(model, 998, { id: 999, name: 'mismatched-create', score: 1 })
	);
	assert.equal(await runStoreContractGet(adapter, model, 998), null);
	await assert.rejects(() =>
		adapter.create(model, 999, {
			id: 999,
			name: 'runtime-date',
			score: 1,
			profile: { city: new Date('2026-05-14T00:00:00.000Z') } as any
		})
	);
	await assert.rejects(() =>
		adapter.update(model, 2, {
			id: 2,
			name: 'runtime-binary',
			score: 20,
			profile: { city: new Uint8Array([1, 2, 3]) } as any
		})
	);
	await assert.rejects(() =>
		adapter.update(model, 2, { id: 999, name: 'mismatched-update', score: 99 })
	);
	assert.equal((await runStoreContractGet(adapter, model, 2))?.name, 'beta');

	await assertStoreContractRejectsUnsupportedCapabilities(adapter, model, uniqueModel, capabilities);
	await assertStoreContractCustomIdFields(adapter, customIdModel, capabilities);
	await assertStoreContractUniqueIndexes(adapter, uniqueModel, capabilities);
	if (capabilities?.native === true) {
		if (!contractOptions.nativeProbe) {
			throw new ActiveTsConfigurationError(
				`Store contract adapter "${adapter.kind}" advertises capabilities.native: true; pass Store adapter contract options.nativeProbe to verify native payload behavior.`
			);
		}
		await contractOptions.nativeProbe({ adapter, model });
		const nativeResult = await runStoreContractQuery(adapter, model, {
			where: [],
			or: [],
			sort: [],
			include: [],
			native: {
				payload: async () => ({
					list: [{ id: 'native-probe', name: 'native-probe', score: 99 }],
					count: 1,
					more: false
				})
			}
		});
		assert.deepEqual(nativeResult.list, [{ id: 'native-probe', name: 'native-probe', score: 99 }]);
		if (adapter.aggregate && capabilities.aggregate === true) {
			const nativeAggregate = await adapter.aggregate(model, {
				where: [],
				or: [],
				aggregates: [{ op: 'count', as: 'count' }],
				native: {
					payload: async () => ({ count: 99 })
				}
			});
			assert.deepEqual(
				nativeAggregate,
				{ count: 99 },
				'native aggregate function payload must control aggregate result'
			);
		}
	}

	if (capabilities?.nullOperators === true && capabilities.missingFieldNulls === true) {
		const nulls = await runStoreContractQuery(adapter, model, {
			where: [{ field: 'optionalMarker', op: 'isNull', value: undefined }],
			or: [],
			sort: [],
			include: [],
			meta: { requiresMissingFieldNulls: true }
		});
		assert.deepEqual(contractResultIds(nulls.list), [1, 4]);
	}
	const notNullByInequality = await runStoreContractQuery(adapter, model, {
		where: [{ field: 'optionalMarker', op: '!=', value: null }],
		or: [],
		sort: [],
		include: []
	});
	assert.deepEqual(contractResultIds(notNullByInequality.list), [2]);

	const one = await runStoreContractGet(adapter, model, 1);
	assert.equal(one?.name, 'alpha');
	if (one) {
		one.name = 'mutated-get-result';
		assert.equal(
			(await runStoreContractGet(adapter, model, 1))?.name,
			'alpha',
			'get result mutations must not write through to backend state'
		);
	}

	const many = await runStoreContractGetMany(adapter, model, [1, 2, 3]);
	assert.equal(many[0]?.score, 10);
	assert.equal(many[1]?.score, 20);
	assert.equal(many[2], null);
	if (many[0]) {
		many[0].name = 'mutated-getmany-result';
		assert.equal(
			(await runStoreContractGet(adapter, model, 1))?.name,
			'alpha',
			'getMany result mutations must not write through to backend state'
		);
	}
	const duplicateMany = await runStoreContractGetMany(adapter, model, [1, 1]);
	assert.equal(duplicateMany[0]?.name, 'alpha');
	assert.equal(duplicateMany[1]?.name, 'alpha');
	assert.notEqual(
		duplicateMany[0],
		duplicateMany[1],
		'duplicate getMany result slots must not share row object references'
	);
	if (capabilities?.datastoreReadPolicy === true) {
		const readOptions: StoreReadOptions = {
			meta: { datastoreRead: { consistency: 'strong' } }
		};
		assert.equal(
			(await runStoreContractGet(adapter, model, 1, readOptions))?.name,
			'alpha',
			'Datastore read-policy point reads must preserve rows'
		);
		assert.equal(
			(await runStoreContractGetMany(adapter, model, [1], readOptions))[0]?.name,
			'alpha',
			'Datastore read-policy batch reads must preserve rows'
		);
		const policyQuery = await runStoreContractQuery(
			adapter,
			model,
			{ where: [], or: [], sort: [], include: [], meta: readOptions.meta },
			readOptions
		);
		assert.equal(
			policyQuery.list.some((row) => row.id === 1),
			true,
			'Datastore read-policy queries must preserve matching rows'
		);
		if (adapter.aggregate && capabilities.aggregate === true) {
			const policyAggregate = await adapter.aggregate(model, {
				where: [],
				or: [],
				aggregates: [{ op: 'count', as: 'count' }],
				meta: readOptions.meta
			});
			assert.equal(policyAggregate.count, 3, 'Datastore read-policy aggregates must preserve the snapshot row count');
		}
	}

	const rangeWhere =
		capabilities?.numericComparisons !== true
			? []
			: [{ field: 'score', op: '>=' as const, value: 15 }];
	const queried = await runStoreContractQuery(adapter, model, {
		where: rangeWhere,
		or: [],
		sort: [{ field: 'score', direction: 'desc' }],
		include: [],
		limit: 2
	});
	assert.deepEqual(
		mapArray(queried.list, (item) => item.id),
		capabilities?.numericComparisons === true ? [2] : [2, 1],
		'numeric comparison contract must narrow score >= 15 when advertised'
	);

	await adapter.create(model, '1', { id: '1', name: 'string-one', score: 11 });
	const typedIds = await runStoreContractGetMany(adapter, model, [1, '1']);
	assert.equal(typedIds[0]?.name, 'alpha');
	assert.equal(typedIds[1]?.name, 'string-one');
	const limitedRows = await runStoreContractQuery(adapter, model, {
		where: [],
		or: [],
		sort: [{ field: 'score', direction: 'asc' }],
		include: [],
		limit: 2
	});
	assert.equal(limitedRows.list.length, 2);
	assert.equal(limitedRows.more, true, 'limited query contract must report more when additional rows exist');
	if (capabilities?.cursor === true) {
		assert.equal(typeof limitedRows.cursor, 'string', 'cursor-capable stores must include a cursor when more is true');
	} else {
		assert.equal(limitedRows.cursor, undefined, 'stores without cursor capability must not expose portable cursors');
	}
	if (capabilities?.offset === true) {
		const offsetRows = await runStoreContractQuery(adapter, model, {
			where: [],
			or: [],
			sort: [{ field: 'score', direction: 'asc' }],
			include: [],
			offset: 1,
			limit: 1
		});
		assert.deepEqual(
			mapArray(offsetRows.list, (item) => item.id),
			[1],
			'offset-capable stores must skip rows after filtering and sorting'
		);
		assert.equal(offsetRows.more, true, 'offset queries must retain limit lookahead semantics');
	}
	await adapter.create(model, 900, { id: 900, name: 'numeric-900', score: 90 });
	await adapter.create(model, '900', { id: '900', name: 'string-900', score: 91 });
	const typedIdQuery = await runStoreContractQuery(adapter, model, {
		where: [{ field: 'id', op: '=', value: '900' }],
		or: [],
		sort: [],
		include: []
	});
	assert.deepEqual(
		contractResultIds(typedIdQuery.list),
		['900'],
		'typed id equality query must not match numeric id 900'
	);
	await adapter.delete(model, 900);
	assert.equal(await runStoreContractGet(adapter, model, 900), null);
	assert.equal(
		(await runStoreContractGet(adapter, model, '900'))?.name,
		'string-900',
		'typed id delete must not remove string id "900" when deleting number 900'
	);

	if (capabilities?.datastoreAncestor === true) {
		await adapter.create(
			datastoreAncestorModel,
			1,
			{ id: 1, parentId: 10, name: 'ancestor-left', score: 11 },
			{ meta: { datastoreAncestor: datastoreAncestorLeft } }
		);
		datastoreAncestorCleanupFixtures[datastoreAncestorCleanupFixtures.length] = {
			id: 1,
			ancestor: datastoreAncestorLeft
		};
		await assert.rejects(() =>
			adapter.create(
				datastoreAncestorModel,
				1,
				{ id: 1, parentId: 10, name: 'ancestor-left-duplicate', score: 12 },
				{ meta: { datastoreAncestor: datastoreAncestorLeft } }
			)
		);
		await adapter.create(
			datastoreAncestorModel,
			1,
			{ id: 1, parentId: 20, name: 'ancestor-right', score: 21 },
			{ meta: { datastoreAncestor: datastoreAncestorRight } }
		);
		datastoreAncestorCleanupFixtures[datastoreAncestorCleanupFixtures.length] = {
			id: 1,
			ancestor: datastoreAncestorRight
		};
		const leftAncestorRows = await runStoreContractQuery(adapter, datastoreAncestorModel, {
			where: [{ field: 'id', op: '=', value: 1 }],
			or: [],
			sort: [],
			include: [],
			meta: { datastoreAncestor: datastoreAncestorLeft }
		});
		assert.deepEqual(
			mapArray(leftAncestorRows.list, (row) => row.name),
			['ancestor-left'],
			`Store contract adapter "${adapter.kind}" must isolate Datastore ancestor query metadata.`
		);
		const rightAncestorRows = await runStoreContractQuery(adapter, datastoreAncestorModel, {
			where: [{ field: 'id', op: '=', value: 1 }],
			or: [],
			sort: [],
			include: [],
			meta: { datastoreAncestor: datastoreAncestorRight }
		});
		assert.deepEqual(
			mapArray(rightAncestorRows.list, (row) => row.name),
			['ancestor-right'],
			`Store contract adapter "${adapter.kind}" must isolate Datastore ancestor identities.`
		);
		await assert.rejects(
			() =>
				adapter.create(
					datastoreAncestorModel,
					6,
					{ id: 6, parentId: 20, name: 'ancestor-mismatched-create', score: 61 },
					{ meta: { datastoreAncestor: datastoreAncestorLeft } }
				),
			`Store contract adapter "${adapter.kind}" must reject Datastore create metadata that conflicts with payload data.`
		);
		const mismatchedCreateLeftRows = await runStoreContractQuery(adapter, datastoreAncestorModel, {
			where: [{ field: 'id', op: '=', value: 6 }],
			or: [],
			sort: [],
			include: [],
			meta: { datastoreAncestor: datastoreAncestorLeft }
		});
		assert.deepEqual(
			mismatchedCreateLeftRows.list,
			[],
			`Store contract adapter "${adapter.kind}" must not write mismatched Datastore create metadata into the metadata ancestor.`
		);
		const mismatchedCreateRightRows = await runStoreContractQuery(adapter, datastoreAncestorModel, {
			where: [{ field: 'id', op: '=', value: 6 }],
			or: [],
			sort: [],
			include: [],
			meta: { datastoreAncestor: datastoreAncestorRight }
		});
		assert.deepEqual(
			mismatchedCreateRightRows.list,
			[],
			`Store contract adapter "${adapter.kind}" must not write mismatched Datastore create metadata into the payload ancestor.`
		);
		await assert.rejects(
			() =>
				adapter.update(
					datastoreAncestorModel,
					1,
					{ id: 1, parentId: 20, name: 'ancestor-mismatched-update', score: 62 },
					{ meta: { datastoreAncestor: datastoreAncestorLeft } }
				),
			`Store contract adapter "${adapter.kind}" must reject Datastore update metadata that conflicts with payload data.`
		);
		const mismatchedUpdateLeftRows = await runStoreContractQuery(adapter, datastoreAncestorModel, {
			where: [{ field: 'id', op: '=', value: 1 }],
			or: [],
			sort: [],
			include: [],
			meta: { datastoreAncestor: datastoreAncestorLeft }
		});
		assert.deepEqual(
			mapArray(mismatchedUpdateLeftRows.list, (row) => row.name),
			['ancestor-left'],
			`Store contract adapter "${adapter.kind}" must not update metadata-scoped rows with mismatched Datastore payload ancestors.`
		);
		const mismatchedUpdateRightRows = await runStoreContractQuery(adapter, datastoreAncestorModel, {
			where: [{ field: 'id', op: '=', value: 1 }],
			or: [],
			sort: [],
			include: [],
			meta: { datastoreAncestor: datastoreAncestorRight }
		});
		assert.deepEqual(
			mapArray(mismatchedUpdateRightRows.list, (row) => row.name),
			['ancestor-right'],
			`Store contract adapter "${adapter.kind}" must not update payload-scoped rows with mismatched Datastore metadata ancestors.`
		);
		await assert.rejects(
			async () => await adapter.get(datastoreAncestorModel, 1),
			/metadata|Datastore ancestor|ancestor-aware query|direct id reads/
		);
		await assert.rejects(
			async () => await adapter.getMany(datastoreAncestorModel, [1]),
			/metadata|Datastore ancestor|ancestor-aware query|direct id reads/
		);
		await assert.rejects(
			async () => await adapter.delete(datastoreAncestorModel, 1),
			/metadata|Datastore ancestor|ancestor-aware query|direct id reads/
		);
		await assert.rejects(
			async () => await adapter.get(datastoreAncestorModel, 1, { meta: { datastoreAncestor: undefined } }),
			/metadata|Datastore ancestor|ancestor-aware query|direct id reads/
		);
		await assert.rejects(
			async () => await adapter.getMany(datastoreAncestorModel, [1], { meta: { datastoreAncestor: undefined } }),
			/metadata|Datastore ancestor|ancestor-aware query|direct id reads/
		);
		await assert.rejects(
			async () => await adapter.delete(datastoreAncestorModel, 1, { meta: { datastoreAncestor: undefined } }),
			/metadata|Datastore ancestor|ancestor-aware query|direct id reads/
		);
		const leftAncestorDirect = await runStoreContractGet(adapter, datastoreAncestorModel, 1, {
			meta: { datastoreAncestor: datastoreAncestorLeft }
		});
		assert.equal(
			leftAncestorDirect?.name,
			'ancestor-left',
			`Store contract adapter "${adapter.kind}" must apply Datastore ancestor metadata to direct gets.`
		);
		const rightAncestorDirect = await runStoreContractGet(adapter, datastoreAncestorModel, 1, {
			meta: { datastoreAncestor: datastoreAncestorRight }
		});
		assert.equal(
			rightAncestorDirect?.name,
			'ancestor-right',
			`Store contract adapter "${adapter.kind}" must isolate Datastore ancestor direct gets.`
		);
		const leftAncestorMany = await runStoreContractGetMany(adapter, datastoreAncestorModel, [1, 1, 2], {
			meta: { datastoreAncestor: datastoreAncestorLeft }
		});
		assert.equal(
			leftAncestorMany[0]?.name,
			'ancestor-left',
			`Store contract adapter "${adapter.kind}" must apply Datastore ancestor metadata to direct getMany reads.`
		);
		assert.equal(
			leftAncestorMany[1]?.name,
			'ancestor-left',
			`Store contract adapter "${adapter.kind}" must preserve duplicate Datastore ancestor getMany slots.`
		);
		assert.notEqual(
			leftAncestorMany[0],
			leftAncestorMany[1],
			`Store contract adapter "${adapter.kind}" must not alias duplicate Datastore ancestor getMany slots.`
		);
		assert.equal(
			leftAncestorMany[2],
			null,
			`Store contract adapter "${adapter.kind}" must preserve Datastore ancestor getMany miss slots.`
		);
		const rightAncestorMany = await runStoreContractGetMany(adapter, datastoreAncestorModel, [1], {
			meta: { datastoreAncestor: datastoreAncestorRight }
		});
		assert.equal(
			rightAncestorMany[0]?.name,
			'ancestor-right',
			`Store contract adapter "${adapter.kind}" must isolate Datastore ancestor direct getMany reads.`
		);
		if (capabilities.transaction === true) {
			await adapter.transaction!(async (tx) => {
				await assert.rejects(
					async () => await tx.get(datastoreAncestorModel, 1),
					/metadata|Datastore ancestor|ancestor-aware query|direct id reads/
				);
				await assert.rejects(
					async () => await tx.getMany(datastoreAncestorModel, [1]),
					/metadata|Datastore ancestor|ancestor-aware query|direct id reads/
				);
				await assert.rejects(
					async () => await tx.delete(datastoreAncestorModel, 1),
					/metadata|Datastore ancestor|ancestor-aware query|direct id reads/
				);
				await assert.rejects(
					async () => await tx.get(datastoreAncestorModel, 1, { meta: { datastoreAncestor: undefined } }),
					/metadata|Datastore ancestor|ancestor-aware query|direct id reads/
				);
				await assert.rejects(
					async () => await tx.getMany(datastoreAncestorModel, [1], { meta: { datastoreAncestor: undefined } }),
					/metadata|Datastore ancestor|ancestor-aware query|direct id reads/
				);
				await assert.rejects(
					async () => await tx.delete(datastoreAncestorModel, 1, { meta: { datastoreAncestor: undefined } }),
					/metadata|Datastore ancestor|ancestor-aware query|direct id reads/
				);
				const txLeftAncestorDirect = await runStoreContractGet(tx, datastoreAncestorModel, 1, {
					meta: { datastoreAncestor: datastoreAncestorLeft }
				});
				assert.equal(
					txLeftAncestorDirect?.name,
					'ancestor-left',
					`Store contract adapter "${adapter.kind}" must apply Datastore ancestor metadata to transaction direct gets.`
				);
				const txRightAncestorDirect = await runStoreContractGet(tx, datastoreAncestorModel, 1, {
					meta: { datastoreAncestor: datastoreAncestorRight }
				});
				assert.equal(
					txRightAncestorDirect?.name,
					'ancestor-right',
					`Store contract adapter "${adapter.kind}" must isolate Datastore ancestor transaction direct gets.`
				);
				const txRightAncestorMany = await runStoreContractGetMany(tx, datastoreAncestorModel, [1, 1, 2], {
					meta: { datastoreAncestor: datastoreAncestorRight }
				});
				assert.equal(
					txRightAncestorMany[0]?.name,
					'ancestor-right',
					`Store contract adapter "${adapter.kind}" must apply Datastore ancestor metadata to transaction direct getMany reads.`
				);
				assert.equal(
					txRightAncestorMany[1]?.name,
					'ancestor-right',
					`Store contract adapter "${adapter.kind}" must preserve duplicate Datastore ancestor transaction getMany slots.`
				);
				assert.notEqual(
					txRightAncestorMany[0],
					txRightAncestorMany[1],
					`Store contract adapter "${adapter.kind}" must not alias duplicate Datastore ancestor transaction getMany slots.`
				);
				assert.equal(
					txRightAncestorMany[2],
					null,
					`Store contract adapter "${adapter.kind}" must preserve Datastore ancestor transaction getMany miss slots.`
				);
				await assert.rejects(
					() =>
						tx.create(
							datastoreAncestorModel,
							7,
							{ id: 7, parentId: 20, name: 'ancestor-mismatched-tx-create', score: 71 },
							{ meta: { datastoreAncestor: datastoreAncestorLeft } }
						),
					`Store contract adapter "${adapter.kind}" must reject Datastore transaction create metadata that conflicts with payload data.`
				);
				await assert.rejects(
					() =>
						tx.update(
							datastoreAncestorModel,
							1,
							{ id: 1, parentId: 20, name: 'ancestor-mismatched-tx-update', score: 72 },
							{ meta: { datastoreAncestor: datastoreAncestorLeft } }
						),
					`Store contract adapter "${adapter.kind}" must reject Datastore transaction update metadata that conflicts with payload data.`
				);
				await tx.create(
					datastoreAncestorModel,
					3,
					{ id: 3, parentId: 10, name: 'ancestor-left-tx-created', score: 31 },
					{ meta: { datastoreAncestor: datastoreAncestorLeft } }
				);
				await tx.create(
					datastoreAncestorModel,
					5,
					{ id: 5, parentId: 10, name: 'ancestor-left-tx-retained', score: 51 },
					{ meta: { datastoreAncestor: datastoreAncestorLeft } }
				);
				await tx.create(
					datastoreAncestorModel,
					5,
					{ id: 5, parentId: 20, name: 'ancestor-right-tx-deleted', score: 52 },
					{ meta: { datastoreAncestor: datastoreAncestorRight } }
				);
				await tx.update(
					datastoreAncestorModel,
					3,
					{ id: 3, parentId: 10, name: 'ancestor-left-tx-updated', score: 32 },
					{ meta: { datastoreAncestor: datastoreAncestorLeft } }
				);
				await tx.delete(datastoreAncestorModel, 5, { meta: { datastoreAncestor: datastoreAncestorRight } });
			});
			datastoreAncestorCleanupFixtures[datastoreAncestorCleanupFixtures.length] = {
				id: 3,
				ancestor: datastoreAncestorLeft
			};
			datastoreAncestorCleanupFixtures[datastoreAncestorCleanupFixtures.length] = {
				id: 5,
				ancestor: datastoreAncestorLeft
			};
			const txMismatchedCreateLeftRows = await runStoreContractQuery(adapter, datastoreAncestorModel, {
				where: [{ field: 'id', op: '=', value: 7 }],
				or: [],
				sort: [],
				include: [],
				meta: { datastoreAncestor: datastoreAncestorLeft }
			});
			assert.deepEqual(
				txMismatchedCreateLeftRows.list,
				[],
				`Store contract adapter "${adapter.kind}" must not commit mismatched Datastore transaction create metadata into the metadata ancestor.`
			);
			const txMismatchedCreateRightRows = await runStoreContractQuery(adapter, datastoreAncestorModel, {
				where: [{ field: 'id', op: '=', value: 7 }],
				or: [],
				sort: [],
				include: [],
				meta: { datastoreAncestor: datastoreAncestorRight }
			});
			assert.deepEqual(
				txMismatchedCreateRightRows.list,
				[],
				`Store contract adapter "${adapter.kind}" must not commit mismatched Datastore transaction create metadata into the payload ancestor.`
			);
			const txMismatchedUpdateLeftRows = await runStoreContractQuery(adapter, datastoreAncestorModel, {
				where: [{ field: 'id', op: '=', value: 1 }],
				or: [],
				sort: [],
				include: [],
				meta: { datastoreAncestor: datastoreAncestorLeft }
			});
			assert.deepEqual(
				mapArray(txMismatchedUpdateLeftRows.list, (row) => row.name),
				['ancestor-left'],
				`Store contract adapter "${adapter.kind}" must not commit mismatched Datastore transaction updates into the metadata ancestor.`
			);
			const txMismatchedUpdateRightRows = await runStoreContractQuery(adapter, datastoreAncestorModel, {
				where: [{ field: 'id', op: '=', value: 1 }],
				or: [],
				sort: [],
				include: [],
				meta: { datastoreAncestor: datastoreAncestorRight }
			});
			assert.deepEqual(
				mapArray(txMismatchedUpdateRightRows.list, (row) => row.name),
				['ancestor-right'],
				`Store contract adapter "${adapter.kind}" must not commit mismatched Datastore transaction updates into the payload ancestor.`
			);
			const txUpdatedLeftAncestorRows = await runStoreContractQuery(adapter, datastoreAncestorModel, {
				where: [{ field: 'id', op: '=', value: 3 }],
				or: [],
				sort: [],
				include: [],
				meta: { datastoreAncestor: datastoreAncestorLeft }
			});
			assert.deepEqual(
				mapArray(txUpdatedLeftAncestorRows.list, (row) => row.name),
				['ancestor-left-tx-updated'],
				`Store contract adapter "${adapter.kind}" must apply Datastore ancestor metadata to transaction create and update writes.`
			);
			const txRetainedLeftAncestorRows = await runStoreContractQuery(adapter, datastoreAncestorModel, {
				where: [{ field: 'id', op: '=', value: 5 }],
				or: [],
				sort: [],
				include: [],
				meta: { datastoreAncestor: datastoreAncestorLeft }
			});
			assert.deepEqual(
				mapArray(txRetainedLeftAncestorRows.list, (row) => row.name),
				['ancestor-left-tx-retained'],
				`Store contract adapter "${adapter.kind}" must preserve left Datastore ancestor rows when deleting right transaction rows.`
			);
			const txDeletedRightAncestorRows = await runStoreContractQuery(adapter, datastoreAncestorModel, {
				where: [{ field: 'id', op: '=', value: 5 }],
				or: [],
				sort: [],
				include: [],
				meta: { datastoreAncestor: datastoreAncestorRight }
			});
			assert.deepEqual(
				txDeletedRightAncestorRows.list,
				[],
				`Store contract adapter "${adapter.kind}" must apply Datastore ancestor metadata to transaction delete writes.`
			);
			await adapter.delete(datastoreAncestorModel, 3, { meta: { datastoreAncestor: datastoreAncestorLeft } });
			await adapter.delete(datastoreAncestorModel, 5, { meta: { datastoreAncestor: datastoreAncestorLeft } });
			datastoreAncestorCleanupFixtures = datastoreAncestorCleanupFixtures.filter(
				(fixture) =>
					!(
						fixture.ancestor === datastoreAncestorLeft &&
						(fixture.id === 3 || fixture.id === 5)
					)
			);
		}
		await adapter.update(
			datastoreAncestorModel,
			1,
			{ id: 1, parentId: 10, name: 'ancestor-left-updated', score: 13 },
			{ meta: { datastoreAncestor: datastoreAncestorLeft } }
		);
		const updatedLeftAncestorRows = await runStoreContractQuery(adapter, datastoreAncestorModel, {
			where: [{ field: 'id', op: '=', value: 1 }],
			or: [],
			sort: [],
			include: [],
			meta: { datastoreAncestor: datastoreAncestorLeft }
		});
		assert.deepEqual(
			mapArray(updatedLeftAncestorRows.list, (row) => row.name),
			['ancestor-left-updated'],
			`Store contract adapter "${adapter.kind}" must apply Datastore ancestor metadata to updates.`
		);
		const isolatedRightAncestorRows = await runStoreContractQuery(adapter, datastoreAncestorModel, {
			where: [{ field: 'id', op: '=', value: 1 }],
			or: [],
			sort: [],
			include: [],
			meta: { datastoreAncestor: datastoreAncestorRight }
		});
		assert.deepEqual(
			mapArray(isolatedRightAncestorRows.list, (row) => row.name),
			['ancestor-right'],
			`Store contract adapter "${adapter.kind}" must not update rows in other Datastore ancestors.`
		);
		if (adapter.aggregate && capabilities.aggregate === true) {
			const leftAncestorAggregate = await adapter.aggregate(datastoreAncestorModel, {
				where: [],
				or: [],
				aggregates: [
					{ op: 'count', as: 'count' },
					{ op: 'sum', field: 'score', as: 'total' }
				],
				meta: { datastoreAncestor: datastoreAncestorLeft }
			});
			assert.deepEqual(
				leftAncestorAggregate,
				{ count: 1, total: 13 },
				`Store contract adapter "${adapter.kind}" must apply Datastore ancestor metadata to aggregates.`
			);
			const rightAncestorAggregate = await adapter.aggregate(datastoreAncestorModel, {
				where: [],
				or: [],
				aggregates: [
					{ op: 'count', as: 'count' },
					{ op: 'sum', field: 'score', as: 'total' }
				],
				meta: { datastoreAncestor: datastoreAncestorRight }
			});
			assert.deepEqual(
				rightAncestorAggregate,
				{ count: 1, total: 21 },
				`Store contract adapter "${adapter.kind}" must isolate Datastore ancestor aggregate metadata.`
			);
		}
		await adapter.delete(datastoreAncestorModel, 1, { meta: { datastoreAncestor: datastoreAncestorLeft } });
		const deletedLeftAncestorRows = await runStoreContractQuery(adapter, datastoreAncestorModel, {
			where: [{ field: 'id', op: '=', value: 1 }],
			or: [],
			sort: [],
			include: [],
			meta: { datastoreAncestor: datastoreAncestorLeft }
		});
		assert.deepEqual(
			deletedLeftAncestorRows.list,
			[],
			`Store contract adapter "${adapter.kind}" must apply Datastore ancestor metadata to deletes.`
		);
		const retainedDatastoreAncestorCleanupFixtures: Array<{ id: EntityId; ancestor: DatastoreKey }> = [];
		for (let index = 0; index < datastoreAncestorCleanupFixtures.length; index++) {
			const fixture = datastoreAncestorCleanupFixtures[index];
			if (fixture.id === 1 && fixture.ancestor === datastoreAncestorLeft) continue;
			retainedDatastoreAncestorCleanupFixtures[retainedDatastoreAncestorCleanupFixtures.length] = fixture;
		}
		datastoreAncestorCleanupFixtures = retainedDatastoreAncestorCleanupFixtures;
		const retainedRightAncestorRows = await runStoreContractQuery(adapter, datastoreAncestorModel, {
			where: [{ field: 'id', op: '=', value: 1 }],
			or: [],
			sort: [],
			include: [],
			meta: { datastoreAncestor: datastoreAncestorRight }
		});
		assert.deepEqual(
			mapArray(retainedRightAncestorRows.list, (row) => row.name),
			['ancestor-right'],
			`Store contract adapter "${adapter.kind}" must not delete rows in other Datastore ancestors.`
		);
	} else {
		await assert.rejects(
			() =>
				runStoreContractQuery(adapter, model, {
					where: [],
					or: [],
					sort: [],
					include: [],
					meta: { datastoreAncestor: datastoreAncestorLeft }
				}),
			/metadata|Datastore ancestor/
		);
		await assert.rejects(
			() => runStoreContractGet(adapter, model, 1, { meta: { datastoreAncestor: datastoreAncestorLeft } }),
			/metadata|Datastore ancestor/
		);
		await assert.rejects(
			() => runStoreContractGetMany(adapter, model, [1], { meta: { datastoreAncestor: datastoreAncestorLeft } }),
			/metadata|Datastore ancestor/
		);
		if (adapter.aggregate) {
			await assert.rejects(
				() =>
					adapter.aggregate!(model, {
						where: [],
						or: [],
						aggregates: [{ op: 'count', as: 'count' }],
						meta: { datastoreAncestor: datastoreAncestorLeft }
					}),
				/metadata|Datastore ancestor/
			);
		}
	}

	await adapter.update(model, 1, { id: 1, name: 'alpha', score: 30 });
	assert.equal((await runStoreContractGet(adapter, model, 1))?.score, 30);

	if (capabilities?.optimisticLock === true) {
		await adapter.create(model, 777, { id: 777, name: 'locked', score: 77, version: 1 });
		await adapter.update(model, 777, { id: 777, name: 'locked-next', score: 78, version: 2 }, { expectedVersion: 1 });
		assert.equal((await runStoreContractGet(adapter, model, 777))?.version, 2);
		await assert.rejects(() =>
			adapter.update(model, 777, { id: 777, name: 'stale-write', score: 79, version: 3 }, { expectedVersion: 1 })
		);
		assert.equal((await runStoreContractGet(adapter, model, 777))?.name, 'locked-next');
		await adapter.create(model, 778, { id: 778, name: 'locked-delete', score: 78, version: 1 });
		await adapter.update(model, 778, { id: 778, name: 'locked-delete-next', score: 79, version: 2 }, { expectedVersion: 1 });
		await assert.rejects(() => adapter.delete(model, 778, { expectedVersion: 1 }));
		assert.equal((await runStoreContractGet(adapter, model, 778))?.name, 'locked-delete-next');
		await adapter.delete(model, 778, { expectedVersion: 2 });
		assert.equal(await runStoreContractGet(adapter, model, 778), null);
		await assert.rejects(
			() => adapter.update(model, 779, { id: 779, name: 'missing-lock-update', score: 79, version: 2 }, { expectedVersion: 1 }),
			ActiveTsNotFoundError
		);
		await assert.rejects(
			() => adapter.delete(model, 779, { expectedVersion: 1 }),
			ActiveTsNotFoundError
		);
	}

	if (capabilities?.transaction === true) {
		const malformedCallbacks = [undefined, null, false, 'callback', {}];
		for (let index = 0; index < malformedCallbacks.length; index++) {
			let malformedTransactionRejected = false;
			try {
				await adapter.transaction!(malformedCallbacks[index] as any);
			} catch {
				malformedTransactionRejected = true;
			}
			assert.equal(
				malformedTransactionRejected,
				true,
				`Store contract adapter "${adapter.kind}" must reject malformed transaction callbacks.`
			);
		}
		const symbolTransactionOptions: Record<PropertyKey, unknown> = {};
		symbolTransactionOptions[Symbol('transactionOption')] = true;
		const hiddenTransactionOptions: Record<string, unknown> = {};
		Object.defineProperty(hiddenTransactionOptions, 'readOnly', {
			value: true,
			enumerable: false,
			configurable: true
		});
		const accessorTransactionOptions: Record<string, unknown> = {};
		Object.defineProperty(accessorTransactionOptions, 'readOnly', {
			get() {
				throw new Error('transaction option getter invoked');
			},
			enumerable: true,
			configurable: true
		});
		const unsafeNativeTransactionOptions = { native: { vendor: Object.create({ inherited: true }) } };
		const invalidTransactionOptions: Array<readonly [string, unknown]> = [
			['null options', null],
			['array options', []],
			['unknown option', { vendor: true }],
			['invalid isolation', { isolation: 'snapshot' }],
			['invalid readOnly', { readOnly: 'yes' }],
			['invalid timeoutMs', { timeoutMs: 0 }],
			['symbol option', symbolTransactionOptions],
			['hidden option', hiddenTransactionOptions],
			['accessor option', accessorTransactionOptions],
			['unsafe native option', unsafeNativeTransactionOptions]
		];
		for (const [label, options] of invalidTransactionOptions) {
			let invalidOptionCallbackRan = false;
			let invalidOptionRejected = false;
			try {
				await adapter.transaction!(async () => {
					invalidOptionCallbackRan = true;
				}, options as any);
			} catch {
				invalidOptionRejected = true;
			}
			assert.equal(
				invalidOptionRejected,
				true,
				`Store contract adapter "${adapter.kind}" must reject malformed transaction options (${label}).`
			);
			assert.equal(
				invalidOptionCallbackRan,
				false,
				`Store contract adapter "${adapter.kind}" must reject malformed transaction options before running the callback (${label}).`
			);
		}
		let callbackRan = false;
		let committedTransactionAdapter: StoreAdapter | undefined;
		let inFlightCreate!: Promise<void>;
		const committedTransactionResult = await adapter.transaction!(async (tx) => {
			callbackRan = true;
			committedTransactionAdapter = tx;
			const txCapabilities = snapshotStoreContractCapabilities(
				tx,
				`Store contract adapter "${adapter.kind}" transaction callback adapter`
			);
			if (txCapabilities?.aggregate === true && typeof tx.aggregate !== 'function') {
				throw new ActiveTsConfigurationError(
					`Store contract adapter "${adapter.kind}" transaction callback adapter advertises capabilities.aggregate: true but does not expose aggregate().`
				);
			}
			assertStoreContractCapabilityMethods(tx, txCapabilities);
			assert.equal(txCapabilities?.transaction, false);
			assert.equal(
				tx.schema,
				undefined,
				`Store contract adapter "${adapter.kind}" must not expose schema hooks on transaction callback adapters.`
			);
			assert.equal(
				tx.transaction,
				undefined,
				`Store contract adapter "${adapter.kind}" must not expose nested transaction hooks on transaction callback adapters.`
			);
			if (txCapabilities?.savepoint === true) {
				assert.equal(
					txCapabilities.savepoint,
					true,
					`Store contract adapter "${adapter.kind}" must preserve savepoint capability on transaction callback adapters.`
				);
				assert.equal(
					typeof tx.savepoint,
					'function',
					`Store contract adapter "${adapter.kind}" must expose savepoint() on transaction callback adapters.`
				);
				const malformedSavepointCallbacks = [undefined, null, false, 'callback', {}];
				for (let index = 0; index < malformedSavepointCallbacks.length; index++) {
					await assert.rejects(() => tx.savepoint!(malformedSavepointCallbacks[index] as any));
				}
				let retainedSavepointAdapter: StoreAdapter | undefined;
				let savepointCallbackCalls = 0;
				let nestedSavepointCallbackCalls = 0;
				const savepointResult = await tx.savepoint!(async (savepointTx) => {
					savepointCallbackCalls++;
					const savepointCapabilities = snapshotStoreContractCapabilities(
						savepointTx,
						`Store contract adapter "${adapter.kind}" savepoint child adapter`
					);
					assertStoreContractCapabilityMethods(savepointTx, savepointCapabilities);
					assert.equal(
						savepointCapabilities?.savepoint,
						true,
						`Store contract adapter "${adapter.kind}" must preserve savepoint capability on child adapters.`
					);
					assert.equal(
						typeof savepointTx.savepoint,
						'function',
						`Store contract adapter "${adapter.kind}" must expose savepoint() on child adapters.`
					);
					retainedSavepointAdapter = savepointTx;
					await savepointTx.create(model, 910, { id: 910, name: 'tx-savepoint-committed', score: 90 });
					await savepointTx.savepoint!(async (nestedTx) => {
						nestedSavepointCallbackCalls++;
						const nestedCapabilities = snapshotStoreContractCapabilities(
							nestedTx,
							`Store contract adapter "${adapter.kind}" nested savepoint child adapter`
						);
						assertStoreContractCapabilityMethods(nestedTx, nestedCapabilities);
						assert.equal(
							nestedCapabilities?.savepoint,
							true,
							`Store contract adapter "${adapter.kind}" must preserve savepoint capability on nested child adapters.`
						);
						assert.equal(
							typeof nestedTx.savepoint,
							'function',
							`Store contract adapter "${adapter.kind}" must expose savepoint() on nested child adapters.`
						);
						await nestedTx.create(model, 911, { id: 911, name: 'tx-savepoint-nested', score: 91 });
					});
						return 'savepoint-result';
					});
					await new Promise<void>((resolve) => setImmediate(resolve));
					assert.equal(
						savepointCallbackCalls,
					1,
					`Store contract adapter "${adapter.kind}" must run each savepoint callback exactly once.`
				);
				assert.equal(
					nestedSavepointCallbackCalls,
					1,
					`Store contract adapter "${adapter.kind}" must run each nested savepoint callback exactly once.`
				);
				assert.equal(savepointResult, 'savepoint-result');
					assert.equal((await runStoreContractGet(tx, model, 910))?.name, 'tx-savepoint-committed');
					assert.equal((await runStoreContractGet(tx, model, 911))?.name, 'tx-savepoint-nested');
					await assert.rejects(() => runStoreContractGet(retainedSavepointAdapter!, model, 910));
					let rollbackSavepointCallbackCalls = 0;
					await assert.rejects(
						() => tx.savepoint!(async (savepointTx) => {
							rollbackSavepointCallbackCalls++;
							await savepointTx.create(model, 912, { id: 912, name: 'tx-savepoint-rolled-back', score: 92 });
							throw new Error('contract savepoint rollback');
					}),
						/contract savepoint rollback/
					);
					assert.equal(
						rollbackSavepointCallbackCalls,
						1,
						`Store contract adapter "${adapter.kind}" must run each rolled-back savepoint callback exactly once.`
					);
					assert.equal(await runStoreContractGet(tx, model, 912), null);
				let releaseSavepoint!: () => void;
				let markSavepointStarted!: () => void;
				const savepointBarrier = new Promise<void>((resolve) => {
					releaseSavepoint = resolve;
				});
				const savepointStarted = new Promise<void>((resolve) => {
					markSavepointStarted = resolve;
				});
				const rollingBackSavepoint = tx.savepoint!(async (savepointTx) => {
					await savepointTx.create(model, 913, { id: 913, name: 'tx-savepoint-concurrent-rollback', score: 93 });
					markSavepointStarted();
					await savepointBarrier;
					throw new Error('contract concurrent savepoint rollback');
				});
				await savepointStarted;
				const parentCreate = tx.create(model, 914, { id: 914, name: 'tx-savepoint-parent-after', score: 94 });
				releaseSavepoint();
				await assert.rejects(() => rollingBackSavepoint, /contract concurrent savepoint rollback/);
				await parentCreate;
				assert.equal(await runStoreContractGet(tx, model, 913), null);
				assert.equal((await runStoreContractGet(tx, model, 914))?.name, 'tx-savepoint-parent-after');
			} else {
				assert.notEqual(
					txCapabilities?.savepoint,
					true,
					`Store contract adapter "${adapter.kind}" must not add unsupported savepoint capability inside transactions.`
				);
			}
			await assertStoreContractRejectsUnsupportedCapabilities(tx, model, uniqueModel, txCapabilities);
			if (txCapabilities?.datastoreAncestor !== true) {
				await assert.rejects(
					() =>
						runStoreContractQuery(tx, model, {
							where: [],
							or: [],
							sort: [],
							include: [],
							meta: { datastoreAncestor: datastoreAncestorLeft }
						}),
					/metadata|Datastore ancestor/
				);
				await assert.rejects(
					() => runStoreContractGet(tx, model, 1, { meta: { datastoreAncestor: datastoreAncestorLeft } }),
					/metadata|Datastore ancestor/
				);
				await assert.rejects(
					() => runStoreContractGetMany(tx, model, [1], { meta: { datastoreAncestor: datastoreAncestorLeft } }),
					/metadata|Datastore ancestor/
				);
				if (tx.aggregate) {
					await assert.rejects(
						() =>
							tx.aggregate!(model, {
								where: [],
								or: [],
								aggregates: [{ op: 'count', as: 'count' }],
								meta: { datastoreAncestor: datastoreAncestorLeft }
							}),
						/metadata|Datastore ancestor/
					);
				}
				await assert.rejects(
					() =>
						tx.create(
							model,
							886,
							{ id: 886, name: 'tx-unsupported-ancestor-create', score: 86 },
							{ meta: { datastoreAncestor: datastoreAncestorLeft } }
						),
					/metadata|Datastore ancestor/
				);
				await assert.rejects(
					() =>
						tx.update(
							model,
							1,
							{ id: 1, name: 'tx-unsupported-ancestor-update', score: 86 },
							{ meta: { datastoreAncestor: datastoreAncestorLeft } }
						),
					/metadata|Datastore ancestor/
				);
				await assert.rejects(
					() => tx.delete(model, 1, { meta: { datastoreAncestor: datastoreAncestorLeft } }),
					/metadata|Datastore ancestor/
				);
			}
			if (txCapabilities?.native === true) {
				if (!contractOptions.nativeProbe) {
					throw new ActiveTsConfigurationError(
						`Store contract adapter "${adapter.kind}" transaction callback adapter advertises capabilities.native: true; pass Store adapter contract options.nativeProbe to verify transaction native payload behavior.`
					);
				}
				await contractOptions.nativeProbe({ adapter: tx, model });
				const transactionNativeResult = await runStoreContractQuery(tx, model, {
					where: [],
					or: [],
					sort: [],
					include: [],
					native: {
						payload: async () => ({
							list: [{ id: 'tx-native-probe', name: 'tx-native-probe', score: 98 }],
							count: 1,
							more: false
						})
					}
				});
				assert.deepEqual(transactionNativeResult.list, [
					{ id: 'tx-native-probe', name: 'tx-native-probe', score: 98 }
				]);
				if (tx.aggregate && txCapabilities.aggregate === true) {
					const transactionNativeAggregate = await tx.aggregate(model, {
						where: [],
						or: [],
						aggregates: [{ op: 'count', as: 'count' }],
						native: {
							payload: async () => ({ count: 98 })
						}
					});
					assert.deepEqual(
						transactionNativeAggregate,
						{ count: 98 },
						'transaction native aggregate function payload must control aggregate result'
					);
				}
			}
			await tx.create(model, 880, { id: 880, name: 'tx-create-delete', score: 88 });
			assert.equal((await runStoreContractGet(tx, model, 880))?.name, 'tx-create-delete');
			await tx.update(model, 880, { id: 880, name: 'tx-updated', score: 89 });
			assert.equal((await runStoreContractGet(tx, model, 880))?.score, 89);
			await tx.delete(model, 880);
			assert.equal(await runStoreContractGet(tx, model, 880), null);
			const concurrentCreate = tx.create(model, 888, { id: 888, name: 'tx-concurrent-read', score: 88 });
			const concurrentRead = runStoreContractGet(tx, model, 888);
			const concurrentBatchRead = runStoreContractGetMany(tx, model, [888]);
			const [, concurrentRow, concurrentRows] = await Promise.all([
				concurrentCreate,
				concurrentRead,
				concurrentBatchRead
			]);
			assert.equal(
				concurrentRow?.name,
				'tx-concurrent-read',
				`Store contract adapter "${adapter.kind}" transaction reads must wait for earlier same-id writes.`
			);
			assert.equal(
				concurrentRows[0]?.name,
				'tx-concurrent-read',
				`Store contract adapter "${adapter.kind}" transaction batch reads must wait for earlier same-id writes.`
			);
			await tx.create(model, 889, { id: 889, name: 'tx-delete-recreate-before', score: 89 });
			const concurrentDelete = tx.delete(model, 889);
			const concurrentRecreate = tx.create(model, 889, {
				id: 889,
				name: 'tx-delete-recreate-after',
				score: 90
			});
			await Promise.all([concurrentDelete, concurrentRecreate]);
			assert.equal(
				(await runStoreContractGet(tx, model, 889))?.name,
				'tx-delete-recreate-after',
				`Store contract adapter "${adapter.kind}" transaction mutations must preserve same-id invocation order.`
			);
			await tx.create(model, 881, { id: 881, name: 'tx-committed', score: 81 });
			inFlightCreate = tx.create(model, 887, { id: 887, name: 'tx-in-flight', score: 87 });
			return 'tx-callback-result';
		});
		await inFlightCreate;
		assert.equal(callbackRan, true);
		assert.equal(
			committedTransactionResult,
			'tx-callback-result',
			`Store contract adapter "${adapter.kind}" must resolve transaction callbacks to the callback result.`
		);
		assert.equal(await runStoreContractGet(adapter, model, 880), null);
		assert.equal((await runStoreContractGet(adapter, model, 881))?.name, 'tx-committed');
		assert.equal(
			(await runStoreContractGet(adapter, model, 887))?.name,
			'tx-in-flight',
			`Store contract adapter "${adapter.kind}" must finish operations started before transaction callbacks settle.`
		);
		assert.ok(
			committedTransactionAdapter,
			`Store contract adapter "${adapter.kind}" must provide a transaction callback adapter before commit.`
		);
		if (capabilities?.optimisticLock === true) {
			await adapter.create(model, 780, { id: 780, name: 'tx-locked', score: 80, version: 1 });
			await adapter.transaction!(async (tx) => {
				await tx.update(model, 780, { id: 780, name: 'tx-locked-next', score: 81, version: 2 }, { expectedVersion: 1 });
			});
			assert.equal((await runStoreContractGet(adapter, model, 780))?.version, 2);
			await assert.rejects(() =>
				adapter.transaction!(async (tx) => {
					await tx.update(model, 780, { id: 780, name: 'tx-stale-write', score: 82, version: 3 }, { expectedVersion: 1 });
				})
			);
			assert.equal(
				(await runStoreContractGet(adapter, model, 780))?.name,
				'tx-locked-next',
				`Store contract adapter "${adapter.kind}" must reject stale optimistic transaction updates.`
			);
			await adapter.create(model, 781, { id: 781, name: 'tx-locked-delete', score: 81, version: 1 });
			await adapter.transaction!(async (tx) => {
				await tx.update(model, 781, { id: 781, name: 'tx-locked-delete-next', score: 82, version: 2 }, { expectedVersion: 1 });
			});
			await assert.rejects(() =>
				adapter.transaction!(async (tx) => {
					await tx.delete(model, 781, { expectedVersion: 1 });
				})
			);
			assert.equal(
				(await runStoreContractGet(adapter, model, 781))?.name,
				'tx-locked-delete-next',
				`Store contract adapter "${adapter.kind}" must reject stale optimistic transaction deletes.`
			);
			await adapter.transaction!(async (tx) => {
				await tx.delete(model, 781, { expectedVersion: 2 });
			});
			assert.equal(await runStoreContractGet(adapter, model, 781), null);
		}
		const committedTx = committedTransactionAdapter;
		const committedCloseProbes: Array<readonly [string, () => Promise<unknown>]> = [
			['get', () => runStoreContractGet(committedTx, model, 881)],
			['getMany', () => runStoreContractGetMany(committedTx, model, [881])],
			[
				'query',
				() =>
					runStoreContractQuery(committedTx, model, {
						where: [{ field: 'id', op: '=', value: 881 }],
						or: [],
						sort: [],
						include: []
					})
			],
			['create', () => committedTx.create(model, 884, { id: 884, name: 'tx-closed-create', score: 84 })],
			['update', () => committedTx.update(model, 881, { id: 881, name: 'tx-closed-update', score: 84 })],
			['delete', () => committedTx.delete(model, 881)]
		];
		if (committedTx.aggregate) {
			committedCloseProbes.push([
				'aggregate',
				() =>
					committedTx.aggregate!(model, {
						where: [],
						or: [],
						aggregates: [{ op: 'count', as: 'count' }]
					})
			]);
		}
		if (committedTx.savepoint) {
			committedCloseProbes.push(['savepoint', () => committedTx.savepoint!(async () => undefined)]);
		}
		for (const [operation, probe] of committedCloseProbes) {
			let committedTransactionClosed = false;
			try {
				await probe();
			} catch {
				committedTransactionClosed = true;
			}
			assert.equal(
				committedTransactionClosed,
				true,
				`Store contract adapter "${adapter.kind}" must close transaction callback adapters after commit (${operation}).`
			);
		}
		let rolledBackTransactionAdapter: StoreAdapter | undefined;
		let rollbackRejected = false;
		let rollbackError: unknown;
		try {
			await adapter.transaction!(async (tx) => {
				rolledBackTransactionAdapter = tx;
				await tx.create(model, 882, { id: 882, name: 'tx-rolled-back', score: 82 });
				throw new Error('contract rollback');
			});
		} catch (error) {
			rollbackRejected = true;
			rollbackError = error;
		}
		assert.equal(
			rollbackRejected,
			true,
			`Store contract adapter "${adapter.kind}" must reject rollback transaction callback errors.`
		);
		assert.ok(
			rolledBackTransactionAdapter,
			`Store contract adapter "${adapter.kind}" must invoke transaction callbacks before rollback.`
		);
		assert.match(
			safeErrorMessage(rollbackError),
			/contract rollback/,
			`Store contract adapter "${adapter.kind}" must reject rollback transactions with the callback error.`
		);
		assert.equal(await runStoreContractGet(adapter, model, 882), null);
		const rolledBackTx = rolledBackTransactionAdapter;
		const rolledBackCloseProbes: Array<readonly [string, () => Promise<unknown>]> = [
			['get', () => runStoreContractGet(rolledBackTx, model, 882)],
			['getMany', () => runStoreContractGetMany(rolledBackTx, model, [882])],
			[
				'query',
				() =>
					runStoreContractQuery(rolledBackTx, model, {
						where: [{ field: 'id', op: '=', value: 882 }],
						or: [],
						sort: [],
						include: []
					})
			],
			['create', () => rolledBackTx.create(model, 886, { id: 886, name: 'tx-closed-rollback-create', score: 86 })],
			['update', () => rolledBackTx.update(model, 881, { id: 881, name: 'tx-closed-rollback-update', score: 86 })],
			['delete', () => rolledBackTx.delete(model, 881)]
		];
		if (rolledBackTx.aggregate) {
			rolledBackCloseProbes.push([
				'aggregate',
				() =>
					rolledBackTx.aggregate!(model, {
						where: [],
						or: [],
						aggregates: [{ op: 'count', as: 'count' }]
					})
			]);
		}
		if (rolledBackTx.savepoint) {
			rolledBackCloseProbes.push(['savepoint', () => rolledBackTx.savepoint!(async () => undefined)]);
		}
		for (const [operation, probe] of rolledBackCloseProbes) {
			let rolledBackTransactionClosed = false;
			try {
				await probe();
			} catch {
				rolledBackTransactionClosed = true;
			}
			assert.equal(
				rolledBackTransactionClosed,
				true,
				`Store contract adapter "${adapter.kind}" must close transaction callback adapters after rollback (${operation}).`
			);
		}
		const readOnlyWriteProbes: Array<readonly [string, () => Promise<unknown>, () => Promise<void>]> = [
			[
				'create',
				() =>
					adapter.transaction!(
						async (tx) => {
							await tx.create(model, 883, { id: 883, name: 'tx-readonly-create', score: 83 });
						},
						{ readOnly: true }
					),
				async () => {
					assert.equal(await runStoreContractGet(adapter, model, 883), null);
				}
			],
			[
				'update',
				() =>
					adapter.transaction!(
						async (tx) => {
							await tx.update(model, 1, { id: 1, name: 'tx-readonly-update', score: 83 });
						},
						{ readOnly: true }
					),
				async () => {
					const row = await runStoreContractGet(adapter, model, 1);
					assert.equal(row?.name, 'alpha');
					assert.equal(row?.score, 30);
				}
			],
			[
				'delete',
				() =>
					adapter.transaction!(
						async (tx) => {
							await tx.delete(model, 2);
						},
						{ readOnly: true }
					),
				async () => {
					const row = await runStoreContractGet(adapter, model, 2);
					assert.equal(row?.name, 'beta');
					assert.equal(row?.score, 20);
				}
			]
		];
		if (capabilities?.datastoreAncestor === true) {
			readOnlyWriteProbes.push(
				[
					'Datastore ancestor create',
					() =>
						adapter.transaction!(
							async (tx) => {
								await tx.create(
									datastoreAncestorModel,
									884,
									{ id: 884, parentId: 10, name: 'tx-readonly-ancestor-create', score: 84 },
									{ meta: { datastoreAncestor: datastoreAncestorLeft } }
								);
							},
							{ readOnly: true }
						),
					async () => {
						const rows = await runStoreContractQuery(adapter, datastoreAncestorModel, {
							where: [{ field: 'id', op: '=', value: 884 }],
							or: [],
							sort: [],
							include: [],
							meta: { datastoreAncestor: datastoreAncestorLeft }
						});
						if (rows.list.length) {
							datastoreAncestorCleanupFixtures[datastoreAncestorCleanupFixtures.length] = {
								id: 884,
								ancestor: datastoreAncestorLeft
							};
						}
						assert.deepEqual(rows.list, []);
					}
				],
				[
					'Datastore ancestor update',
					() =>
						adapter.transaction!(
							async (tx) => {
								await tx.update(
									datastoreAncestorModel,
									1,
									{ id: 1, parentId: 20, name: 'tx-readonly-ancestor-update', score: 84 },
									{ meta: { datastoreAncestor: datastoreAncestorRight } }
								);
							},
							{ readOnly: true }
						),
					async () => {
						const row = await runStoreContractGet(adapter, datastoreAncestorModel, 1, {
							meta: { datastoreAncestor: datastoreAncestorRight }
						});
						assert.equal(row?.name, 'ancestor-right');
						assert.equal(row?.score, 21);
					}
				],
				[
					'Datastore ancestor delete',
					() =>
						adapter.transaction!(
							async (tx) => {
								await tx.delete(datastoreAncestorModel, 1, { meta: { datastoreAncestor: datastoreAncestorRight } });
							},
							{ readOnly: true }
						),
					async () => {
						const row = await runStoreContractGet(adapter, datastoreAncestorModel, 1, {
							meta: { datastoreAncestor: datastoreAncestorRight }
						});
						assert.equal(row?.name, 'ancestor-right');
						assert.equal(row?.score, 21);
					}
				]
			);
		}
		for (const [operation, probe, verify] of readOnlyWriteProbes) {
			let readOnlyWriteRejected = false;
			try {
				await probe();
			} catch {
				readOnlyWriteRejected = true;
			}
			assert.equal(
				readOnlyWriteRejected,
				true,
				`Store contract adapter "${adapter.kind}" must reject read-only transaction ${operation} writes.`
			);
			await verify();
		}
		let callbackReturning!: () => void;
		const callbackWillReturn = new SAFE_PROMISE<void>((resolve) => {
			callbackReturning = resolve;
		});
		let leadingDrainWrite!: Promise<void>;
		let lateObservedFailure!: Promise<void>;
		let drainingTransactionAdapter!: StoreAdapter;
		const lateObservationTransaction = adapter.transaction!(async (tx) => {
			drainingTransactionAdapter = tx;
			leadingDrainWrite = tx.create(model, 890, { id: 890, name: 'tx-leading-drain-write', score: 90 });
			lateObservedFailure = startUnobservedContractCreate(tx, model, 891, {
				id: 892,
				name: 'tx-late-observed-invalid',
				score: 91
			});
			await new SAFE_PROMISE<void>((resolve) => setImmediate(resolve));
			callbackReturning();
		});
		let lateObservationTransactionSettled = false;
		void PROMISE_THEN.call(
			lateObservationTransaction,
			() => {
				lateObservationTransactionSettled = true;
			},
			() => {
				lateObservationTransactionSettled = true;
			}
		);
		await callbackWillReturn;
		const drainAnchorRow = await runStoreContractGet(drainingTransactionAdapter, model, 890);
		assert.equal(
			drainAnchorRow?.name,
			'tx-leading-drain-write',
			`Store contract adapter "${adapter.kind}" must finish operations started before callback drain probes.`
		);
		assert.equal(
			lateObservationTransactionSettled,
			false,
			`Store contract adapter "${adapter.kind}" must keep transactions pending while callback operations drain.`
		);
		let drainOperationRejected = false;
		try {
			await runStoreContractGet(drainingTransactionAdapter, model, 890);
		} catch {
			drainOperationRejected = true;
		}
		assert.equal(
			drainOperationRejected,
			true,
			`Store contract adapter "${adapter.kind}" must reject new operations while transaction callbacks drain.`
		);
		await assert.rejects(() => lateObservedFailure);
		let lateObservationRejected = false;
		try {
			await lateObservationTransaction;
		} catch {
			lateObservationRejected = true;
		}
		assert.equal(
			lateObservationRejected,
			true,
			`Store contract adapter "${adapter.kind}" must not forgive operation failures observed after transaction callbacks close.`
		);
		await leadingDrainWrite;
		assert.equal(
			await runStoreContractGet(adapter, model, 890),
			null,
			`Store contract adapter "${adapter.kind}" must roll back writes that precede late-observed operation failures.`
		);
		const callbackPrecedenceError = new Error('contract callback error precedence');
		let callbackPrecedenceFailure!: Promise<void>;
		let callbackPrecedenceResult: unknown;
		try {
			await adapter.transaction!(async (tx) => {
				await tx.create(model, 892, { id: 892, name: 'tx-callback-precedence', score: 92 });
				callbackPrecedenceFailure = startUnobservedContractCreate(tx, model, 893, {
					id: 894,
					name: 'tx-callback-precedence-invalid',
					score: 93
				});
				throw callbackPrecedenceError;
			});
		} catch (error) {
			callbackPrecedenceResult = error;
		}
		await assert.rejects(() => callbackPrecedenceFailure);
		assert.equal(
			callbackPrecedenceResult,
			callbackPrecedenceError,
			`Store contract adapter "${adapter.kind}" must preserve callback errors over unobserved operation failures during rollback.`
			);
			assert.equal(await runStoreContractGet(adapter, model, 892), null);
			if (capabilities.transactionConflictDetection === true) {
				for (const probe of [
					{ id: 915 as EntityId, method: 'get' as const },
					{ id: 916 as EntityId, method: 'getMany' as const }
				]) {
					await adapter.create(model, probe.id, {
						id: probe.id,
						name: `tx-conflict-${probe.method}`,
						score: 0
					});
					const probeContext =
						`Store contract adapter "${adapter.kind}" advertises transactionConflictDetection: true` +
						` but lost a concurrent write after a transactional ${probe.method} point read.`;
					let markFirstRead!: () => void;
					let releaseFirst!: () => void;
					const firstRead = new SAFE_PROMISE<void>((resolve) => {
						markFirstRead = resolve;
					});
					const firstMayCommit = new SAFE_PROMISE<void>((resolve) => {
						releaseFirst = resolve;
					});
					const first = adapter.transaction!(async (tx) => {
						const row = probe.method === 'get'
							? await runStoreContractGet(tx, model, probe.id)
							: (await runStoreContractGetMany(tx, model, [probe.id]))[0];
						assert.ok(row, `${probeContext} The fixture could not be read.`);
						markFirstRead();
						await firstMayCommit;
						await tx.update(model, probe.id, { ...row, score: row.score + 1 });
					});
					const firstOutcome = PROMISE_THEN.call(
						first,
						() => ({ status: 'fulfilled' as const }),
						(reason: unknown) => ({ status: 'rejected' as const, reason })
					) as Promise<
						| { status: 'fulfilled' }
						| { status: 'rejected'; reason: unknown }
					>;
					await SAFE_PROMISE.race([
						firstRead,
						PROMISE_THEN.call(firstOutcome, (outcome) => {
							if (outcome.status === 'rejected') throw outcome.reason;
							throw new ActiveTsConfigurationError(`${probeContext} The first callback completed before its read barrier.`);
						})
					]);
					let secondOutcome: Promise<
						| { status: 'fulfilled' }
						| { status: 'rejected'; reason: unknown }
					>;
					try {
						const second = adapter.transaction!(async (tx) => {
							const row = probe.method === 'get'
								? await runStoreContractGet(tx, model, probe.id)
								: (await runStoreContractGetMany(tx, model, [probe.id]))[0];
							assert.ok(row, `${probeContext} The fixture could not be read.`);
							await tx.update(model, probe.id, { ...row, score: row.score + 1 });
						});
						secondOutcome = PROMISE_THEN.call(
							second,
							() => ({ status: 'fulfilled' as const }),
							(reason: unknown) => ({ status: 'rejected' as const, reason })
						) as typeof secondOutcome;
					} catch (reason) {
						secondOutcome = SAFE_PROMISE.resolve({ status: 'rejected' as const, reason });
					} finally {
						releaseFirst();
					}
					const outcomes = await SAFE_PROMISE.all([firstOutcome, secondOutcome]);
					let fulfilled = 0;
					const rejected: unknown[] = [];
					for (let index = 0; index < outcomes.length; index++) {
						const outcome = outcomes[index];
						if (outcome.status === 'fulfilled') fulfilled++;
						else rejected[rejected.length] = outcome.reason;
					}
					const conflictRow = await runStoreContractGet(adapter, model, probe.id);
					if (fulfilled === 2) {
						assert.equal(rejected.length, 0, probeContext);
						assert.equal(conflictRow?.score, 2, probeContext);
					} else {
						assert.equal(fulfilled, 1, probeContext);
						assert.equal(rejected.length, 1, probeContext);
						assert.ok(rejected[0] instanceof ActiveTsConflictError, probeContext);
						assert.equal(conflictRow?.score, 1, probeContext);
					}
				}
			}
		}

	if (capabilities?.select === true) {
		const projected = await runStoreContractQuery(adapter, model, {
			where: [{ field: 'id', op: '=', value: 1 }],
			or: [],
			sort: [],
			include: [],
			select: ['name']
		});
		assert.deepEqual(projected.list[0], { id: 1, name: 'alpha' });
	}

	if (capabilities?.or) {
		const or = await runStoreContractQuery(adapter, model, {
			where: [],
			or: [
				{ where: [{ field: 'name', op: '=', value: 'alpha' }], or: [], sort: [], include: [] },
				{ where: [{ field: 'name', op: '=', value: 'beta' }], or: [], sort: [], include: [] }
			],
			sort: [{ field: 'score', direction: 'asc' }],
			include: []
		});
		assert.deepEqual(
			mapArray(or.list, (item) => item.name),
			['beta', 'alpha']
		);
	}

	if (capabilities?.startsWith) {
		const prefixed = await runStoreContractQuery(adapter, model, {
			where: [{ field: 'name', op: 'startsWith', value: 'alp' }],
			or: [],
			sort: [],
			include: []
		});
		assert.deepEqual(mapArray(prefixed.list, (item) => item.name), ['alpha']);
	}

	if (capabilities?.arrayContains) {
		const contained = await runStoreContractQuery(adapter, model, {
			where: [{ field: 'tags', op: 'arrayContains', value: 'cat' }],
			or: [],
			sort: [],
			include: []
		});
		assert.deepEqual(mapArray(contained.list, (item) => item.name), ['beta']);
	}

	if (capabilities?.textContains) {
		const contained = await runStoreContractQuery(adapter, model, {
			where: [{ field: 'name', op: 'textContains', value: 'alp' }],
			or: [],
			sort: [],
			include: []
		});
		assert.deepEqual(mapArray(contained.list, (item) => item.name), ['alpha']);
	}

	if (capabilities?.jsonContains) {
		const contained = await runStoreContractQuery(adapter, model, {
			where: [{ field: 'profile', op: 'jsonContains', value: { city: 'Seoul' } }],
			or: [],
			sort: [],
			include: []
		});
		assert.deepEqual(mapArray(contained.list, (item) => item.name), ['beta']);
	}

	if (capabilities?.contains === false) {
		await assert.rejects(() =>
			adapter.query(model, {
				where: [{ field: 'tags', op: 'contains', value: 'cat' }],
				or: [],
				sort: [],
				include: []
			})
		);
	}

	if (capabilities?.nestedFields) {
		const nested = await runStoreContractQuery(adapter, model, {
			where: [{ field: 'profile.city', op: '=', value: 'Seoul' }],
			or: [],
			sort: [],
			include: []
		});
		assert.deepEqual(mapArray(nested.list, (item) => item.name), ['beta']);
	}

	if (adapter.aggregate && capabilities?.aggregate === true) {
		const aggregate = await adapter.aggregate(model, {
			where: [{ field: 'name', op: 'in', value: ['alpha', 'beta'] }],
			or: [],
			aggregates: [
				{ op: 'count', as: 'count' },
				{ op: 'sum', field: 'score', as: 'total' },
				{ op: 'max', field: 'score', as: 'maxScore' }
			]
		});
		assert.deepEqual(aggregate, { count: 2, total: 50, maxScore: 30 });
		if (capabilities.or === true) {
			const aggregateOr = await adapter.aggregate(model, {
				where: [],
				or: [
					{ where: [{ field: 'name', op: '=', value: 'alpha' }], or: [], sort: [], include: [] },
					{ where: [{ field: 'name', op: '=', value: 'string-one' }], or: [], sort: [], include: [] }
				],
				aggregates: [
					{ op: 'count', as: 'count' },
					{ op: 'sum', field: 'score', as: 'total' }
				]
			});
			assert.deepEqual(
				aggregateOr,
				{ count: 2, total: 41 },
				'aggregate OR contract must honor aggregate OR branches'
			);
		}
		if (capabilities.nestedFields === true) {
			const nestedAggregate = await adapter.aggregate(model, {
				where: [{ field: 'profile.city', op: '=', value: 'Seoul' }],
				or: [],
				aggregates: [
					{ op: 'count', as: 'count' },
					{ op: 'sum', field: 'score', as: 'total' },
					{ op: 'max', field: 'score', as: 'maxScore' }
				]
			});
			assert.deepEqual(
				nestedAggregate,
				{ count: 1, total: 20, maxScore: 20 },
				'nested aggregate contract must honor dotted aggregate filters'
			);
		}
	}

	if (capabilities?.cursor) {
		const firstPage = await runStoreContractQuery(adapter, model, {
			where: [],
			or: [],
			sort: [{ field: 'score', direction: 'asc' }],
			include: [],
			limit: 1
		});
		assert.equal(firstPage.list.length, 1);
		assert.equal(firstPage.more, true, 'cursor contract first page must report more when additional rows exist');
		assert.equal(typeof firstPage.cursor, 'string', 'cursor contract first page must include a cursor when more is true');
		const secondPage = await runStoreContractQuery(adapter, model, {
			where: [],
			or: [],
			sort: [{ field: 'score', direction: 'asc' }],
			include: [],
			limit: 2,
			cursor: firstPage.cursor
		});
		assert.equal(secondPage.list.length, 2);
		assert.equal(someArray(secondPage.list, (item) => item.id === firstPage.list[0].id), false);
	}

	await assertStoreContractFieldCodecs(adapter, model, capabilities);
	if (capabilities?.datastoreAncestor !== true) {
		await assert.rejects(
			() =>
				adapter.create(
					model,
					885,
					{ id: 885, name: 'unsupported-ancestor-write', score: 85 },
					{ meta: { datastoreAncestor: datastoreAncestorLeft } }
				),
			/metadata|Datastore ancestor/
		);
		await adapter.create(model, 885, { id: 885, name: 'unsupported-ancestor-write-target', score: 85 });
		await assert.rejects(
			() =>
				adapter.update(
					model,
					885,
					{ id: 885, name: 'unsupported-ancestor-update', score: 86 },
					{ meta: { datastoreAncestor: datastoreAncestorLeft } }
				),
			/metadata|Datastore ancestor/
		);
		await assert.rejects(
			() => adapter.delete(model, 885, { meta: { datastoreAncestor: datastoreAncestorLeft } }),
			/metadata|Datastore ancestor/
		);
	}
	await adapter.delete(model, 1);
	assert.equal(await runStoreContractGet(adapter, model, 1), null);
	await assert.rejects(() => adapter.update(model, 1, { id: 1, name: 'revived', score: 99 }));
	await deleteStoreContractFixtures(adapter, model, [2, 4, '1', '900', 777, 881, 'codec-token']);
	} catch (error) {
		contractError = error;
	}
	const cleanupResults = await deleteStoreContractFixturesSettled(adapter, model, cleanupIds);
	const datastoreAncestorCleanupResults = await Promise.allSettled(
		mapArray(datastoreAncestorCleanupFixtures, (fixture) =>
			adapter.delete(datastoreAncestorModel, fixture.id, { meta: { datastoreAncestor: fixture.ancestor } })
		)
	);
	const cleanupError = [...cleanupResults, ...datastoreAncestorCleanupResults].find((result) => result.status === 'rejected') as
		| PromiseRejectedResult
		| undefined;
	if (contractError && cleanupError) {
		throw new AggregateError(
			[contractError, cleanupError.reason],
			`Store adapter contract failed and cleanup failed: ${safeErrorMessage(contractError)}`
		);
	}
	if (contractError) throw contractError;
	if (cleanupError) throw cleanupError.reason;
}

export async function runCacheAdapterContract(adapter: CacheAdapter) {
	adapter = validateCacheContractAdapter(adapter, 'Cache contract adapter');
	const keyPrefix = `contract:${randomUUID()}`;
	const key = (name: string) => `${keyPrefix}:${name}`;
	if (adapter.codecKey) {
		assertSafeCacheKey(adapter.codecKey(key('codec-key')), 'Cache contract adapter.codecKey result');
	}
	const cleanupKeys = [
		key('a'),
		key('b'),
		key('set-input-isolation'),
		key('ttl'),
		key('atomic-valid'),
		key('bad'),
		key('bad-date'),
		key('bad-ttl'),
		key('bad-options'),
		key('bad-option-unknown'),
		key('bad-option-symbol'),
		key('bad-option-hidden'),
		key('bad-option-accessor'),
		key('atomic-invalid'),
		key('duplicate')
	];

	await adapter.deleteMany(cleanupKeys);
	let contractError: unknown;
	try {
		await adapter.setMany([
			[key('a'), { nested: { value: 'alpha' } }],
			[key('b'), null]
		]);
		const first = await adapter.getMany([key('a'), key('b'), key('a'), key('missing')]);
		assert.equal(first.length, 4);
		assert.deepEqual(first[0], { nested: { value: 'alpha' } });
		assert.equal(first[1], null);
		assert.deepEqual(first[2], { nested: { value: 'alpha' } });
		assert.equal(
			Object.prototype.hasOwnProperty.call(first, 3),
			true,
			'cache contract miss slots must be dense own properties'
		);
		assert.equal(first[3], undefined);
		assert.notEqual(
			first[0],
			first[2],
			'duplicate cache hit result slots must not share value object references'
		);

		const inputRetained = { nested: { value: 'isolated' } };
		await adapter.setMany([[key('set-input-isolation'), inputRetained]]);
		inputRetained.nested.value = 'mutated';
		const inputIsolated = await adapter.getMany([key('set-input-isolation')]);
		assert.deepEqual(
			inputIsolated[0],
			{ nested: { value: 'isolated' } },
			'cache setMany must not retain input value object references'
		);

		(first[0] as { nested: { value: string } }).nested.value = 'mutated';
		const cloned = await adapter.getMany([key('a')]);
		assert.deepEqual(cloned[0], { nested: { value: 'alpha' } });

		await adapter.deleteMany([key('a'), key('a'), key('missing')]);
		assert.deepEqual(await adapter.getMany([key('a'), key('b')]), [undefined, null]);

		await adapter.setMany([[key('ttl'), 'expires']], { ttl: 1 });
		assert.deepEqual(await adapter.getMany([key('ttl')]), ['expires']);
		await sleep(1100);
		assert.deepEqual(await adapter.getMany([key('ttl')]), [undefined]);

		await assert.rejects(() => adapter.getMany(['']));
		await assert.rejects(() => adapter.deleteMany(['bad\0key']));
		await assert.rejects(() => adapter.setMany([[key('bad'), { value: undefined }]]));
		await assert.rejects(() => adapter.setMany([[key('bad-date'), { value: new Date('2026-05-25T00:00:00.000Z') }]]));
		await assert.rejects(() => adapter.setMany([[key('bad-ttl'), 'value']], { ttl: 0 }));
		await assert.rejects(() => adapter.setMany([[key('bad-options'), 'value']], null as any));
		await assert.rejects(() => adapter.setMany([[key('bad-option-unknown'), 'value']], { ttll: 1 } as any));
		await assert.rejects(() =>
			adapter.setMany([[key('bad-option-symbol'), 'value']], { [Symbol('ttl')]: 1 } as any)
		);
		const hiddenOptions = Object.defineProperty({}, 'ttl', {
			enumerable: false,
			value: 1
		});
		await assert.rejects(() => adapter.setMany([[key('bad-option-hidden'), 'value']], hiddenOptions));
		let optionReads = 0;
		const accessorOptions = Object.defineProperty({}, 'ttl', {
			enumerable: true,
			get() {
				optionReads++;
				return 1;
			}
		});
		await assert.rejects(() => adapter.setMany([[key('bad-option-accessor'), 'value']], accessorOptions));
		assert.equal(optionReads, 0);
		await assert.rejects(() =>
			adapter.setMany([
				[key('atomic-valid'), 'should-not-write'],
				[key('atomic-invalid'), { value: undefined }]
			])
		);
		assert.deepEqual(await adapter.getMany([key('atomic-valid')]), [undefined]);
		await assert.rejects(() =>
			adapter.setMany([
				[key('duplicate'), 'first'],
				[key('duplicate'), 'second']
			])
		);
		assert.deepEqual(await adapter.getMany([key('duplicate')]), [undefined]);
	} catch (error) {
		contractError = error;
	}
	let cleanupError: unknown;
	try {
		await adapter.deleteMany(cleanupKeys);
	} catch (error) {
		cleanupError = error;
	}
	if (contractError && cleanupError) {
		throw new AggregateError(
			[contractError, cleanupError],
			`Cache adapter contract failed and cleanup failed: ${safeErrorMessage(contractError)}`
		);
	}
	if (contractError) throw contractError;
	if (cleanupError) throw cleanupError;
}

export async function runSearchAdapterContract(
	adapter: SearchAdapter,
	options: SearchAdapterContractOptions = {}
) {
	adapter = validateSearchContractAdapter(adapter, 'Search contract adapter');
	const contractOptions = normalizeSearchAdapterContractOptions(options);
	const capabilities = snapshotSearchContractCapabilities(adapter, 'Search contract adapter');
	if (capabilities?.index !== true) {
		throw new ActiveTsConfigurationError(
			`Search contract adapter "${adapter.kind}" must declare capabilities.index: true because runSearchAdapterContract() exercises indexing and delete behavior.`
		);
	}
	const model: ResolvedModelMeta<SearchContractModel> = {
		model: class {},
		name: `search_contract_${randomUUID()}`,
		store: 'contract-store',
		search: adapter.kind,
		idField: 'id',
		readValidation: 'off',
		indexes: [],
		searchIndexes: [{ name: 'contract_search', fields: ['title', 'subtitle', 'score', 'tags', 'profile.city'] }],
		relations: new Map(),
		hooks: {},
		views: new Map(),
		policies: new Map(),
		scopes: new Map(),
		fieldCodecs: new Map(),
		fieldTypes: capturedMap<string, FieldType>([['score', 'number']])
	};
	const customIdModel: ResolvedModelMeta<SearchContractCustomIdModel> = {
		model: class {},
		name: `search_contract_custom_id_${randomUUID()}`,
		store: 'contract-store',
		search: adapter.kind,
		idField: 'slug',
		readValidation: 'off',
		indexes: [],
		searchIndexes: [{ name: 'contract_custom_id_search', fields: ['title', 'score'] }],
		relations: new Map(),
		hooks: {},
		views: new Map(),
		policies: new Map(),
		scopes: new Map(),
		fieldCodecs: new Map(),
		fieldTypes: capturedMap<string, FieldType>([['score', 'number']])
	};
	const datastoreAncestorModel: ResolvedModelMeta<SearchContractDatastoreAncestorModel> = {
		model: class {},
		name: `search_contract_datastore_${randomUUID()}`,
		store: 'contract-store',
		search: adapter.kind,
		idField: 'id',
		readValidation: 'off',
		indexes: [],
		searchIndexes: [{ name: 'contract_datastore_search', fields: ['title', 'score'] }],
		relations: new Map(),
		hooks: {},
		views: new Map(),
		policies: new Map(),
		scopes: new Map(),
		fieldCodecs: new Map(),
		fieldTypes: capturedMap<string, FieldType>([['score', 'number']]),
		datastore: {
			ancestor: ({ data }) =>
				data === undefined ? undefined : datastoreKey('search_contract_parent', data.parentId),
			ancestorFields: ['parentId']
		}
	};

	if (adapter.schema) {
		normalizeSchemaPlan(
			await adapter.schema.plan([model, customIdModel, datastoreAncestorModel]),
			`Search contract adapter "${adapter.kind}" schema plan`
		);
		normalizeSchemaPlan(
			await adapter.schema.apply([model, customIdModel, datastoreAncestorModel], { mode: 'safe' }),
			`Search contract adapter "${adapter.kind}" schema apply plan`
		);
	}
	if (adapter.syncSchema) {
		normalizeSchemaPlan(
			await adapter.syncSchema([model, customIdModel, datastoreAncestorModel]),
			`Search contract adapter "${adapter.kind}" schema sync plan`
		);
	}
	if (capabilities.native === true && !contractOptions.nativeProbe) {
		throw new ActiveTsConfigurationError(
			`Search contract adapter "${adapter.kind}" advertises capabilities.native: true; pass Search adapter contract options.nativeProbe to verify native payload behavior.`
		);
	}
	const nativeProbe = contractOptions.nativeProbe;
	if (capabilities.native === true && nativeProbe) {
		await nativeProbe({ adapter, model });
	}

	await adapter.delete(model, 1);
	await adapter.delete(model, '1');
	await adapter.delete(model, 2);
	await adapter.delete(model, 3);
	await adapter.delete(model, 4);
	let contractError: unknown;
	try {
	await adapter.index(model, 1, {
		id: 1,
		title: 'shared number',
		subtitle: null,
		body: 'private body',
		score: 10,
		tags: ['cat'],
		profile: { city: 'Seoul' }
	});
	await adapter.index(model, '1', {
		id: '1',
		title: 'shared string',
		subtitle: 'present',
		body: 'private body',
		score: 20,
		tags: ['dog'],
		profile: { city: 'Busan' }
	});
	await adapter.index(model, 2, {
		id: 2,
		title: 'other',
		subtitle: 'irrelevant',
		body: 'shared hidden',
		score: 30,
		tags: ['cat'],
		profile: { city: 'Incheon' }
	});

	const shared = await searchContractResult(adapter, model, 'shared', {}, [1, '1'], contractOptions);
	assert.deepEqual(searchContractResultIds(shared.list), [1, '1']);
	assert.equal(shared.count, shared.list.length);
	assertSearchContractTotal(shared, 2, `Search contract adapter "${adapter.kind}" shared result`);
	assert.equal(shared.more, false);
	for (const item of shared.list) {
		assert.equal(Object.prototype.hasOwnProperty.call(item, 'body'), false);
	}
	const originalTitle = (shared.list[0] as Record<string, unknown>).title;
	const originalProfileCity = valueFor(shared.list[0], 'profile.city');
	const originalTag = Array.isArray((shared.list[0] as Record<string, unknown>).tags)
		? ((shared.list[0] as Record<string, unknown>).tags as unknown[])[0]
		: undefined;
	try {
		(shared.list[0] as Record<string, unknown>).title = 'active-ts contract mutation';
		const profile = (shared.list[0] as Record<string, unknown>).profile;
		if (profile && typeof profile === 'object' && !Array.isArray(profile)) {
			(profile as Record<string, unknown>).city = 'active-ts nested contract mutation';
		}
		const tags = (shared.list[0] as Record<string, unknown>).tags;
		if (Array.isArray(tags) && tags.length) tags[0] = 'active-ts array contract mutation';
	} catch {
		// Immutable hit objects are valid; mutable objects must still be isolated from adapter state.
	}
	const isolated = await searchContractResult(adapter, model, 'shared', {}, [1, '1'], contractOptions);
	assert.equal(
		(isolated.list[0] as Record<string, unknown>).title,
		originalTitle,
		'Search contract adapter hits must be isolated from caller mutations.'
	);
	assert.equal(
		valueFor(isolated.list[0], 'profile.city'),
		originalProfileCity,
		'Search contract adapter nested hit objects must be isolated from caller mutations.'
	);
	if (originalTag !== undefined && Array.isArray((isolated.list[0] as Record<string, unknown>).tags)) {
		assert.equal(
			((isolated.list[0] as Record<string, unknown>).tags as unknown[])[0],
			originalTag,
			'Search contract adapter hit arrays must be isolated from caller mutations.'
		);
	}

	const limited = await searchContractAssert(
		adapter,
		model,
		'shared',
		{ limit: 1 },
		(result) => {
			assert.equal(result.list.length, 1);
			assert.equal(result.count, 1);
			assertSearchContractTotal(result, 2, `Search contract adapter "${adapter.kind}" limited result`);
			assert.equal(result.more, true);
			const ids = searchContractResultIds(result.list);
			assert.equal(everyArray(ids, (id) => id === 1 || id === '1'), true);
		},
		contractOptions
	);
	if (capabilities?.cursor === true) {
		assert.ok(limited.cursor);
		const firstIds = capturedSet(mapArray(searchContractResultIds(limited.list), entityIdKey));
		await searchContractAssert(
			adapter,
			model,
			'shared',
			{ limit: 1, cursor: limited.cursor },
			(result) => {
				assert.equal(result.list.length, 1);
				for (const id of searchContractResultIds(result.list)) {
					assert.equal(SET_HAS.call(firstIds, entityIdKey(id)), false);
				}
			},
			contractOptions
		);
	} else {
		assert.equal(limited.cursor, undefined, 'search adapters without cursor capability must not expose portable cursors');
	}

	await adapter.index(model, 1, {
		id: 1,
		title: 'replacement number',
		subtitle: null,
		score: 11,
		tags: ['replacement-tag'],
		profile: { city: 'Jeju' }
	});
	const sharedAfterReplace = await searchContractResult(adapter, model, 'shared', {}, ['1'], contractOptions);
	assert.deepEqual(searchContractResultIds(sharedAfterReplace.list), ['1']);
	assertSearchContractTotal(sharedAfterReplace, 1, `Search contract adapter "${adapter.kind}" replacement shared result`);
	const replacement = await searchContractResult(adapter, model, 'replacement', {}, [1], contractOptions);
	assert.deepEqual(searchContractResultIds(replacement.list), [1]);
	assertSearchContractTotal(replacement, 1, `Search contract adapter "${adapter.kind}" replacement result`);
	await adapter.index(model, 1, {
		id: 1,
		title: 'shared number',
		subtitle: null,
		score: 10,
		tags: ['cat'],
		profile: { city: 'Seoul' }
	});

	await adapter.delete(model, 1);
	const afterDelete = await searchContractResult(adapter, model, 'shared', {}, ['1'], contractOptions);
	assert.deepEqual(searchContractResultIds(afterDelete.list), ['1']);
	assertSearchContractTotal(afterDelete, 1, `Search contract adapter "${adapter.kind}" delete result`);

	await adapter.index(model, 1, {
		id: 1,
		title: 'shared number',
		score: 10,
		tags: ['cat'],
		profile: { city: 'Seoul' }
	});
	if (capabilities?.where === true && capabilities.numericComparisons === true) {
		const filtered = await searchContractResult(
			adapter,
			model,
			'shared',
			{ where: { score: ['>=', 15] } },
			['1'],
			contractOptions
		);
		assert.deepEqual(searchContractResultIds(filtered.list), ['1']);
	}
	if (capabilities?.where === true && capabilities.whereOperators?.['='] === true) {
		const filtered = await searchContractResult(
			adapter,
			model,
			'shared',
			{ where: { title: 'shared string' } },
			['1'],
			contractOptions
		);
		assert.deepEqual(searchContractResultIds(filtered.list), ['1']);
	}
	if (capabilities?.where === true && capabilities.whereOperators?.['!='] === true) {
		const filtered = await searchContractResult(
			adapter,
			model,
			'shared',
			{ where: { title: ['!=', 'shared number'] } },
			['1'],
			contractOptions
		);
		assert.deepEqual(searchContractResultIds(filtered.list), ['1']);
	}
	if (capabilities?.where === true && capabilities.whereOperators?.in === true) {
		const filtered = await searchContractResult(
			adapter,
			model,
			'shared',
			{ where: { score: ['in', [20]] } },
			['1'],
			contractOptions
		);
		assert.deepEqual(searchContractResultIds(filtered.list), ['1']);
	}
	if (capabilities?.where === true && capabilities.whereOperators?.between === true) {
		const filtered = await searchContractResult(
			adapter,
			model,
			'shared',
			{ where: { score: ['between', 15, 25] } },
			['1'],
			contractOptions
		);
		assert.deepEqual(searchContractResultIds(filtered.list), ['1']);
	}
	if (capabilities?.where === true && capabilities.whereOperators?.arrayContains === true) {
		const filtered = await searchContractResult(
			adapter,
			model,
			'shared',
			{ where: { tags: ['arrayContains', 'dog'] } },
			['1'],
			contractOptions
		);
		assert.deepEqual(searchContractResultIds(filtered.list), ['1']);
	}
	if (capabilities?.where === true && capabilities.whereOperators?.textContains === true) {
		const filtered = await searchContractResult(
			adapter,
			model,
			'shared',
			{ where: { title: ['textContains', 'string'] } },
			['1'],
			contractOptions
		);
		assert.deepEqual(searchContractResultIds(filtered.list), ['1']);
	}
	if (capabilities?.where === true && capabilities.whereOperators?.jsonContains === true) {
		const filtered = await searchContractResult(
			adapter,
			model,
			'shared',
			{ where: { profile: ['jsonContains', { city: 'Busan' }] } },
			['1'],
			contractOptions
		);
		assert.deepEqual(searchContractResultIds(filtered.list), ['1']);
	}
	if (capabilities?.where === true && capabilities.whereOperators?.startsWith === true) {
		const filtered = await searchContractResult(
			adapter,
			model,
			'shared',
			{ where: { title: ['startsWith', 'shared str'] } },
			['1'],
			contractOptions
		);
		assert.deepEqual(searchContractResultIds(filtered.list), ['1']);
	}
	if (capabilities?.where === true && capabilities.nullOperators === true && capabilities.whereOperators?.isNull === true) {
		const filtered = await searchContractResult(
			adapter,
			model,
			'shared',
			{ where: { subtitle: ['isNull'] } },
			[1],
			contractOptions
		);
		assert.deepEqual(searchContractResultIds(filtered.list), [1]);
	}
	if (capabilities?.where === true && capabilities.nullOperators === true && capabilities.whereOperators?.isNotNull === true) {
		const filtered = await searchContractResult(
			adapter,
			model,
			'shared',
			{ where: { subtitle: ['isNotNull'] } },
			['1'],
			contractOptions
		);
		assert.deepEqual(searchContractResultIds(filtered.list), ['1']);
	}
	if (capabilities?.where === true && capabilities.nestedFields === true) {
		const filtered = await searchContractResult(
			adapter,
			model,
			'shared',
			{ where: { 'profile.city': 'Busan' } },
			['1'],
			contractOptions
		);
		assert.deepEqual(searchContractResultIds(filtered.list), ['1']);
	}

	await assertSearchContractRejectsUnsupportedCapabilities(adapter, model, capabilities);
	await assertSearchContractCustomIdFields(adapter, customIdModel, contractOptions);
	await assertSearchContractDatastoreAncestorIdentities(adapter, datastoreAncestorModel, contractOptions);
	await assertSearchContractRevisionWrites(adapter, model, capabilities, contractOptions);
	await assert.rejects(() => adapter.search(model, null as any, {}));
	await assert.rejects(() => adapter.search(model, 'shared', null as any));
	await assert.rejects(() => adapter.index(model, 3, { id: 4, title: 'mismatched id' }));
	await assertSearchContractRejectsUnsafeIndexPayloads(adapter, model, contractOptions);
	} catch (error) {
		contractError = error;
	}
	const cleanupResults = await deleteSearchContractFixturesSettled(adapter, model, [1, '1', 2, 3, 4]);
	const cleanupError = cleanupResults.find((result) => result.status === 'rejected') as
		| PromiseRejectedResult
		| undefined;
	if (contractError && cleanupError) {
		throw new AggregateError(
			[contractError, cleanupError.reason],
			`Search adapter contract failed and cleanup failed: ${safeErrorMessage(contractError)}`
		);
	}
	if (contractError) throw contractError;
	if (cleanupError) throw cleanupError.reason;
}

async function assertSearchContractRevisionWrites(
	adapter: SearchAdapter,
	model: ResolvedModelMeta<SearchContractModel>,
	capabilities: SearchAdapter['capabilities'],
	contractOptions: NormalizedSearchAdapterContractOptions
) {
	const current = {
		id: 4,
		title: 'currentfencetoken',
		subtitle: null,
		score: 40,
		tags: ['revision'],
		profile: { city: 'Daejeon' }
	};
	const stale = { ...current, title: 'stalefencetoken' };
	if (capabilities?.revisionWrites !== true) {
		await assert.rejects(() => adapter.index(model, 4, current, { revision: 100 }));
		await assert.rejects(() => adapter.delete(model, 4, { revision: 100 }));
		return;
	}

	await adapter.index(model, 4, current, { revision: 100 });
	await adapter.index(model, 4, stale, { revision: 99 });
	await adapter.index(model, 4, stale, { revision: 100 });
	await adapter.delete(model, 4, { revision: 99 });
	await searchContractResult(adapter, model, 'currentfencetoken', {}, [4], contractOptions);
	await searchContractResult(adapter, model, 'stalefencetoken', {}, [], contractOptions);

	await adapter.delete(model, 4, { revision: 101 });
	await adapter.index(model, 4, stale, { revision: 100 });
	await searchContractResult(adapter, model, 'stalefencetoken', {}, [], contractOptions);

	await adapter.index(model, 4, current, { revision: 102 });
	await searchContractResult(adapter, model, 'currentfencetoken', {}, [4], contractOptions);
	await adapter.delete(model, 4, { revision: 103 });
}

async function assertStoreContractRejectsUnsupportedCapabilities(
	adapter: StoreAdapter,
	model: ResolvedModelMeta<StoreContractModel>,
	uniqueModel: ResolvedModelMeta<StoreContractModel>,
	capabilities: StoreAdapter['capabilities']
) {
	if (capabilities?.or !== true) {
		await assert.rejects(() =>
			adapter.query(model, {
				where: [],
				or: [{ where: [{ field: 'name', op: '=', value: 'alpha' }], or: [], sort: [], include: [] }],
				sort: [],
				include: []
			})
		);
	}
	if (capabilities?.select !== true) {
		await assert.rejects(() =>
			adapter.query(model, { where: [], or: [], sort: [], include: [], select: ['name'] })
		);
	}
	if (capabilities?.cursor !== true) {
		await assert.rejects(() =>
			adapter.query(model, { where: [], or: [], sort: [], include: [], cursor: 'contract-cursor' })
		);
	}
	if (capabilities?.offset !== true) {
		await assert.rejects(() =>
			adapter.query(model, { where: [], or: [], sort: [], include: [], offset: 1 })
		);
	}
	if (capabilities?.startsWith !== true) {
		await assert.rejects(() =>
			adapter.query(model, { where: [{ field: 'name', op: 'startsWith', value: 'a' }], or: [], sort: [], include: [] })
		);
	}
	if (capabilities?.arrayContains !== true) {
		await assert.rejects(() =>
			adapter.query(model, { where: [{ field: 'tags', op: 'arrayContains', value: 'cat' }], or: [], sort: [], include: [] })
		);
	}
	if (capabilities?.textContains !== true) {
		await assert.rejects(() =>
			adapter.query(model, { where: [{ field: 'name', op: 'textContains', value: 'alp' }], or: [], sort: [], include: [] })
		);
	}
	if (capabilities?.jsonContains !== true) {
		await assert.rejects(() =>
			adapter.query(model, { where: [{ field: 'profile', op: 'jsonContains', value: { city: 'Seoul' } }], or: [], sort: [], include: [] })
		);
	}
	if (capabilities?.nestedFields !== true) {
		await assert.rejects(() =>
			adapter.query(model, { where: [{ field: 'profile.city', op: '=', value: 'Seoul' }], or: [], sort: [], include: [] })
		);
	}
	if (capabilities?.numericComparisons !== true) {
		await assert.rejects(() =>
			adapter.query(model, { where: [{ field: 'score', op: '>=', value: 10 }], or: [], sort: [], include: [] })
		);
	}
	if (capabilities?.nullOperators !== true) {
		await assert.rejects(() =>
			adapter.query(model, { where: [{ field: 'profile.city', op: 'isNull', value: undefined }], or: [], sort: [], include: [] })
		);
	}
	if (capabilities?.nullOperators === true && capabilities?.missingFieldNulls !== true) {
		await assert.rejects(() =>
			adapter.query(model, { where: [{ field: 'optionalMarker', op: 'isNull', value: undefined }], or: [], sort: [], include: [] })
		);
	}
	if (capabilities?.missingFieldNulls !== true) {
		await assert.rejects(() =>
			adapter.query(model, {
				where: [{ field: 'optionalMarker', op: 'isNull', value: undefined }],
				or: [],
				sort: [],
				include: [],
				meta: { requiresMissingFieldNulls: true }
			})
		);
	}
	if (capabilities?.native !== true) {
		await assert.rejects(() =>
			adapter.query(model, { where: [], or: [], sort: [], include: [], native: { payload: { contract: true } } })
		);
	} else if (capabilities?.cursor !== true) {
		try {
			const nativeCursorResult = await adapter.query(model, {
				where: [],
				or: [],
				sort: [],
				include: [],
				native: {
					payload: () => ({
						list: [{ id: 1, name: 'alpha', score: 10 }],
						more: true,
						cursor: 'contract-native-cursor'
					})
				}
			});
			assert.equal(
				nativeCursorResult.cursor,
				undefined,
				'stores without cursor capability must not expose portable cursors from native queries'
			);
		} catch (error) {
			if (error instanceof assert.AssertionError) throw error;
		}
	}
	if (capabilities?.datastoreReadPolicy !== true) {
		const readOptions: StoreReadOptions = {
			meta: { datastoreRead: { consistency: 'strong' } }
		};
		await assert.rejects(() => adapter.get(model, 1, readOptions));
		await assert.rejects(() => adapter.getMany(model, [1], readOptions));
		await assert.rejects(() => adapter.query(
			model,
			{ where: [], or: [], sort: [], include: [], meta: readOptions.meta },
			readOptions
		));
		if (adapter.aggregate) {
			await assert.rejects(() => adapter.aggregate!(model, {
				where: [],
				or: [],
				aggregates: [{ op: 'count', as: 'count' }],
				meta: readOptions.meta
			}));
		}
	}
	if (capabilities?.optimisticLock !== true) {
		await assert.rejects(() =>
			adapter.update(model, 2, { id: 2, name: 'unsupported-lock-update', score: 21 }, { expectedVersion: 1 })
		);
		await assert.rejects(() => adapter.delete(model, 2, { expectedVersion: 1 }));
	}
	if (adapter.schema && capabilities?.uniqueIndex !== true) {
		await assert.rejects(() => adapter.schema!.plan([uniqueModel]));
		await assert.rejects(() => adapter.schema!.apply([uniqueModel], { mode: 'safe' }));
	}
	if (adapter.aggregate && capabilities?.aggregate !== true) {
		await assert.rejects(() =>
			adapter.aggregate!(model, { where: [], or: [], aggregates: [{ op: 'count', as: 'count' }] })
		);
	}
}

async function assertStoreContractFieldCodecs(
	adapter: StoreAdapter,
	model: ResolvedModelMeta<StoreContractModel>,
	capabilities: StoreAdapter['capabilities']
) {
	await adapter.create(model, 'codec-token', {
		id: 'codec-token',
		name: 'codec-token',
		score: 30,
		token: 'encoded:alpha'
	});
	const matched = await runStoreContractQuery(adapter, model, {
		where: [{ field: 'token', op: '=', value: 'alpha' }],
		or: [],
		sort: [],
		include: []
	});
	assert.deepEqual(
		contractResultIds(matched.list),
		['codec-token'],
		'field codec query contract must encode portable operands before storage filtering'
	);
	if (adapter.aggregate && capabilities?.aggregate === true) {
		await assert.rejects(
			() =>
				adapter.aggregate!(model, {
					where: [],
					or: [],
					aggregates: [{ op: 'max', field: 'token', as: 'maxToken' }]
				}),
			/field-codec|codec/i,
			'field codec aggregate contract must reject codec-backed aggregate fields'
		);
	}
}

async function deleteStoreContractFixture(adapter: StoreAdapter, model: ResolvedModelMeta, id: EntityId) {
	if (await runStoreContractGet(adapter, model, id)) await adapter.delete(model, id);
}

function deleteStoreContractFixtures(adapter: StoreAdapter, model: ResolvedModelMeta, ids: readonly EntityId[]) {
	return Promise.all(mapArray(ids, (id) => deleteStoreContractFixture(adapter, model, id)));
}

function deleteStoreContractFixturesSettled(
	adapter: StoreAdapter,
	model: ResolvedModelMeta,
	ids: readonly EntityId[]
) {
	return Promise.allSettled(mapArray(ids, (id) => deleteStoreContractFixture(adapter, model, id)));
}

function deleteSearchContractFixturesSettled(
	adapter: SearchAdapter,
	model: ResolvedModelMeta,
	ids: readonly EntityId[]
) {
	return Promise.allSettled(mapArray(ids, (id) => adapter.delete(model, id)));
}

async function runStoreContractQuery<TModel extends Record<string, unknown>>(
	adapter: StoreAdapter,
	model: ResolvedModelMeta<TModel>,
	plan: Parameters<StoreAdapter['query']>[1],
	options?: Parameters<StoreAdapter['query']>[2]
) {
	const context = `Store contract adapter "${adapter.kind}" query`;
	const raw = await adapter.query(model, plan, options);
	const result = normalizeStoreQueryResultForModel(
		model,
		raw,
		context,
		{
			adapterKind: adapter.kind,
			datastoreAncestor: plan.meta?.datastoreAncestor,
			datastoreNamespace: adapter.datastoreNamespace,
			trustedDatastoreEntityKeys: storeTrustsDatastoreEntityKeyRows(adapter)
		}
	);
	assertContractProvidedCount(raw, result.list.length, context);
	return result;
}

async function runStoreContractGet<TModel extends Record<string, unknown>>(
	adapter: StoreAdapter,
	model: ResolvedModelMeta<TModel>,
	id: EntityId,
	options?: StoreReadOptions
) {
	return normalizeStoreContractGetResult(
		model,
		id,
		await adapter.get(model, id, options),
		`Store contract adapter "${adapter.kind}" get`,
		{
			datastoreAncestor: options?.meta?.datastoreAncestor,
			datastoreNamespace: adapter.datastoreNamespace,
			trustedDatastoreEntityKeys: storeTrustsDatastoreEntityKeyRows(adapter)
		}
	);
}

async function runStoreContractGetMany<TModel extends Record<string, unknown>>(
	adapter: StoreAdapter,
	model: ResolvedModelMeta<TModel>,
	ids: readonly EntityId[],
	options?: StoreReadOptions
) {
	const context = `Store contract adapter "${adapter.kind}" getMany`;
	const requestedIds = mapArray(ids, (id) => id);
	const rows = snapshotArrayInput<any | null>(
		await adapter.getMany(model, requestedIds, options),
		`${context} result`
	);
	if (rows.length !== ids.length) {
		throw new ActiveTsConfigurationError(`${context} result must contain ${ids.length} entries.`);
	}
	const result: Array<TModel | null> = [];
	for (let index = 0; index < rows.length; index++) {
		result[index] = normalizeStoreContractGetResult(model, ids[index], rows[index], `${context} result[${index}]`, {
			datastoreAncestor: options?.meta?.datastoreAncestor,
			datastoreNamespace: adapter.datastoreNamespace,
			trustedDatastoreEntityKeys: storeTrustsDatastoreEntityKeyRows(adapter)
		});
	}
	return result;
}

function normalizeStoreContractGetResult<TModel extends Record<string, unknown>>(
	model: ResolvedModelMeta<TModel>,
	id: EntityId,
	row: unknown,
	context: string,
	options: { datastoreAncestor?: unknown; datastoreNamespace?: string; trustedDatastoreEntityKeys?: boolean } = {}
) {
	if (row === null) return null;
	const result = normalizeStoreQueryResultForModel(model, { list: [row] }, context, {
		adapterKind: context,
		datastoreAncestor: options.datastoreAncestor,
		datastoreNamespace: options.datastoreNamespace,
		trustedDatastoreEntityKeys: options.trustedDatastoreEntityKeys
	});
	const data = cloneSafeDataObject(result.list[0], context) as TModel;
	assertStoreDataMatchesId(model, id, data, context);
	return data;
}

function assertContractProvidedCount(result: unknown, pageSize: number, context: string) {
	if (!result || typeof result !== 'object' || Array.isArray(result)) return;
	const record = result as Record<string, unknown>;
	const countValue = ownOptionValue(record, 'count', `${context} result`);
	const count = assertSafeResultCount(countValue, `${context} result.count`);
	if (count !== undefined && count !== pageSize) {
		throw new ActiveTsConfigurationError(`${context} result.count must equal result.list length.`);
	}
}

async function assertStoreContractUniqueIndexes(
	adapter: StoreAdapter,
	model: ResolvedModelMeta<StoreContractModel>,
	capabilities: StoreAdapter['capabilities']
) {
	if (capabilities?.uniqueIndex !== true) return;
	if (!adapter.schema) {
		throw new ActiveTsConfigurationError(
			`Store contract adapter "${adapter.kind}" advertises unique indexes but does not expose schema hooks.`
		);
	}
	assertStoreContractUniqueSchemaPlan(
		await adapter.schema.plan([model]),
		model,
		`Store contract adapter "${adapter.kind}" unique schema plan`
	);
	assertStoreContractUniqueSchemaPlan(
		await adapter.schema.apply([model], { mode: 'safe' }),
		model,
		`Store contract adapter "${adapter.kind}" unique schema apply plan`
	);
	try {
		await adapter.create(model, 900, { id: 900, name: 'unique-name', score: 90 });
		await assert.rejects(() => adapter.create(model, 901, { id: 901, name: 'unique-name', score: 91 }));
		await adapter.create(model, 902, { id: 902, name: 'other-name', score: 92 });
		await assert.rejects(() => adapter.update(model, 902, { id: 902, name: 'unique-name', score: 93 }));
		assert.equal((await runStoreContractGet(adapter, model, 902))?.name, 'other-name');
	} finally {
		await Promise.allSettled(mapArray([900, 901, 902], (id) => adapter.delete(model, id)));
	}
}

async function assertStoreContractCustomIdFields(
	adapter: StoreAdapter,
	model: ResolvedModelMeta<StoreContractCustomIdModel>,
	capabilities: StoreAdapter['capabilities']
) {
	try {
		await adapter.create(model, 'custom-a', { slug: 'custom-a', name: 'custom-alpha', score: 41 });
		await assert.rejects(() =>
			adapter.create(model, 'custom-mismatch', { slug: 'custom-other', name: 'custom-mismatch', score: 42 })
		);
		assert.deepEqual((await runStoreContractGet(adapter, model, 'custom-a'))?.slug, 'custom-a');
		const many = await runStoreContractGetMany(adapter, model, ['custom-a', 'custom-missing']);
		assert.deepEqual(mapArray(many, (item) => item?.slug ?? null), ['custom-a', null]);
		const queried = await runStoreContractQuery(adapter, model, {
			where: [{ field: 'slug', op: '=', value: 'custom-a' }],
			or: [],
			sort: [],
			include: []
		});
		assert.deepEqual(contractResultIds(queried.list, model.idField), ['custom-a']);
		if (capabilities?.select === true) {
			const projected = await runStoreContractQuery(adapter, model, {
				where: [{ field: 'slug', op: '=', value: 'custom-a' }],
				or: [],
				sort: [],
				include: [],
				select: ['name']
			});
			assert.deepEqual(projected.list[0], { slug: 'custom-a', name: 'custom-alpha' });
		}
		await adapter.update(model, 'custom-a', { slug: 'custom-a', name: 'custom-beta', score: 43 });
		assert.equal((await runStoreContractGet(adapter, model, 'custom-a'))?.name, 'custom-beta');
		await assert.rejects(() =>
			adapter.update(model, 'custom-a', { slug: 'custom-other', name: 'custom-bad', score: 44 })
		);
	} finally {
		await Promise.allSettled(mapArray(['custom-a', 'custom-mismatch'], (id) => adapter.delete(model, id)));
	}
}

function assertStoreContractUniqueSchemaPlan(
	plan: unknown,
	model: ResolvedModelMeta<StoreContractModel>,
	context: string
) {
	const normalized = normalizeSchemaPlan(plan, context);
	assert.equal(
		someArray(
			normalized.changes,
			(change) =>
				change.type === 'create-index' &&
				change.target === model.name &&
				change.name === 'unique_name' &&
				change.unique === true &&
				change.fields.length === 1 &&
				change.fields[0] === 'name' &&
				change.directions?.length === 1 &&
				change.directions[0] === 'desc'
		),
		true,
		`${context} must include the declared unique index with directions`
	);
	return normalized;
}

function assertStoreContractDatastoreAncestorSchemaPlan(
	plan: SchemaPlan,
	model: ResolvedModelMeta<StoreContractDatastoreAncestorModel>,
	context: string
) {
	const index = model.indexes[0]!;
	const expected = datastoreRuntimeContractIndex(model, index.fields, index.directions);
	const ancestorModes = datastoreSchemaAncestorModes(true);
	for (let modeIndex = 0; modeIndex < ancestorModes.length; modeIndex++) {
		const ancestor = ancestorModes[modeIndex];
		assert.equal(
			someArray(
				plan.changes,
				(change) =>
					change.type === 'create-index' &&
					change.target === model.name &&
					change.name === index.name &&
					change.ancestor === ancestor &&
					schemaFieldsEqual(change.fields, expected.fields) &&
					schemaFieldsEqual(change.directions ?? [], expected.directions)
			),
			true,
			`${context} must include the declared Datastore ancestor index with runtime fields, directions, and both ancestor modes`
		);
	}
}

function datastoreRuntimeContractIndex(
	model: ResolvedModelMeta,
	rawFields: readonly string[],
	rawDirections: readonly SortDirection[] | undefined
) {
	const fields = [...rawFields];
	const directions: SortDirection[] = [];
	for (let index = 0; index < fields.length; index++) directions[index] = rawDirections?.[index] ?? 'asc';
	let hasIdField = false;
	for (let index = 0; index < fields.length; index++) {
		if (fields[index] !== model.idField) continue;
		hasIdField = true;
		break;
	}
	if (!hasIdField) {
		fields[fields.length] = model.idField;
		directions[directions.length] = 'asc';
	}
	return { fields, directions };
}

function schemaFieldsEqual(fields: readonly string[], expected: readonly string[]) {
	if (fields.length !== expected.length) return false;
	for (let index = 0; index < expected.length; index++) {
		if (fields[index] !== expected[index]) return false;
	}
	return true;
}

function contractResultIds(list: any[], idField = 'id') {
	return sortEntityIds(
		mapArray(list, (item) => {
			const id = valueFor(item, idField);
			assertSafeEntityId(id, 'Store contract result id');
			return id;
		})
	);
}

async function assertSearchContractRejectsUnsupportedCapabilities(
	adapter: SearchAdapter,
	model: ResolvedModelMeta<SearchContractModel>,
	capabilities: SearchAdapter['capabilities']
) {
	if (capabilities?.where !== true) {
		await assert.rejects(() => adapter.search(model, 'shared', { where: { title: 'shared' } }));
	}
	if (capabilities?.where === true) {
		for (const testCase of SEARCH_CONTRACT_UNSUPPORTED_WHERE_CASES) {
			if (capabilities.whereOperators?.[testCase.operator] !== true) {
				await assert.rejects(() => adapter.search(model, 'shared', { where: testCase.where as any }));
			}
		}
	}
	if (capabilities?.where === true && capabilities.nullOperators !== true) {
		await assert.rejects(() => adapter.search(model, 'shared', { where: { 'profile.city': ['isNull'] } }));
	}
	if (capabilities?.where === true && capabilities.numericComparisons !== true) {
		await assert.rejects(() => adapter.search(model, 'shared', { where: { score: ['>=', 10] } }));
	}
	if (capabilities?.where === true && capabilities.nestedFields !== true) {
		await assert.rejects(() => adapter.search(model, 'shared', { where: { 'profile.city': 'Seoul' } }));
	}
	if (capabilities?.cursor !== true) {
		await assert.rejects(() => adapter.search(model, 'shared', { cursor: 'contract-cursor' }));
	}
	if (capabilities?.native !== true) {
		await assert.rejects(() => adapter.search(model, 'shared', { native: { contract: true } }));
	}
}

async function assertSearchContractCustomIdFields(
	adapter: SearchAdapter,
	model: ResolvedModelMeta<SearchContractCustomIdModel>,
	contractOptions: NormalizedSearchAdapterContractOptions
) {
	try {
		await adapter.delete(model, 'custom-a');
		await adapter.index(model, 'custom-a', { slug: 'custom-a', title: 'custom searchable', score: 41 });
		await assert.rejects(() =>
			adapter.index(model, 'custom-mismatch', { slug: 'custom-other', title: 'custom mismatch', score: 42 })
		);
		const result = await searchContractResult(
			adapter,
			model,
			'custom',
			{},
			['custom-a'],
			contractOptions
		);
		assert.deepEqual(result.list[0], { slug: 'custom-a', title: 'custom searchable', score: 41 });
	} finally {
		await Promise.allSettled(mapArray(['custom-a', 'custom-mismatch'], (id) => adapter.delete(model, id)));
	}
}

async function assertSearchContractDatastoreAncestorIdentities(
	adapter: SearchAdapter,
	model: ResolvedModelMeta<SearchContractDatastoreAncestorModel>,
	contractOptions: NormalizedSearchAdapterContractOptions
) {
	const left = { id: 7, parentId: 100, title: 'ancestor shared left', score: 51 };
	const right = { id: 7, parentId: 200, title: 'ancestor shared right', score: 52 };
	const leftIdentity = searchDocumentIdentity(model, left.id, `${model.name} left search document id`, left);
	const rightIdentity = searchDocumentIdentity(model, right.id, `${model.name} right search document id`, right);
	const modelWithLeftIdentity = { ...model, searchDocumentIdentity: leftIdentity };
	const modelWithRightIdentity = { ...model, searchDocumentIdentity: rightIdentity };
	try {
		await adapter.index(model, left.id, left);
		await adapter.index(model, right.id, right);
		await searchContractAssert(
			adapter,
			model,
			'ancestor shared',
			{},
			(result) => {
				assert.equal(
					result.list.length,
					2,
					`Search contract adapter "${adapter.kind}" must preserve same-id Datastore ancestor hits.`
				);
				const parents: number[] = [];
				for (const item of result.list) {
					const parentId = valueFor(item, 'parentId');
					assert.equal(typeof parentId, 'number', 'Datastore ancestor search hits must include ancestor fields.');
					let insertAt = parents.length;
					for (let parentIndex = 0; parentIndex < parents.length; parentIndex++) {
						if ((parentId as number) < parents[parentIndex]) {
							insertAt = parentIndex;
							break;
						}
					}
					parents.splice(insertAt, 0, parentId as number);
				}
				assert.deepEqual(parents, [left.parentId, right.parentId]);
				for (const item of result.list) {
					const parentId = valueFor(item, 'parentId');
					const identity = searchHitDocumentIdentity(item);
					const expected = parentId === left.parentId
						? leftIdentity
						: parentId === right.parentId
							? rightIdentity
							: undefined;
					assert.equal(
						identity,
						expected,
						`Search contract adapter "${adapter.kind}" must preserve Datastore ancestor hit document identity markers.`
					);
				}
				assertSearchContractTotal(
					result,
					2,
					`Search contract adapter "${adapter.kind}" Datastore ancestor result`
				);
			},
			contractOptions
		);
		await adapter.delete(modelWithLeftIdentity, left.id);
		const afterDelete = await searchContractResult(
			adapter,
			model,
			'ancestor shared',
			{},
			[left.id],
			contractOptions
		);
		assert.deepEqual(mapArray(afterDelete.list, (item) => valueFor(item, 'parentId')), [right.parentId]);
		assert.equal(
			searchHitDocumentIdentity(afterDelete.list[0]),
			rightIdentity,
			`Search contract adapter "${adapter.kind}" must preserve Datastore ancestor hit document identity markers after delete.`
		);
		assertSearchContractTotal(
			afterDelete,
			1,
			`Search contract adapter "${adapter.kind}" Datastore ancestor delete result`
		);
	} finally {
		await Promise.allSettled([
			adapter.delete(modelWithLeftIdentity, left.id),
			adapter.delete(modelWithRightIdentity, right.id)
		]);
	}
}

async function assertSearchContractRejectsUnsafeIndexPayloads(
	adapter: SearchAdapter,
	model: ResolvedModelMeta<SearchContractModel>,
	contractOptions: NormalizedSearchAdapterContractOptions
) {
	const cases: Array<{ id: EntityId; query: string; data: Record<string, unknown>; accessorInvoked?: () => boolean }> = [];
	cases[cases.length] = {
		id: 3,
		query: 'unsafe-contract-date',
		data: {
			id: 3,
			title: 'unsafe-contract-date',
			profile: { city: new Date('2026-06-13T00:00:00.000Z') }
		}
	};
	cases[cases.length] = {
		id: 3,
		query: 'unsafe-contract-binary',
		data: {
			id: 3,
			title: 'unsafe-contract-binary',
			profile: { city: new Uint8Array([1, 2, 3]) }
		}
	};
	const symbolPayload: Record<string, unknown> = { id: 3, title: 'unsafe-contract-symbol' };
	Object.defineProperty(symbolPayload, Symbol('search-contract-symbol'), { value: 'hidden', enumerable: true });
	cases[cases.length] = { id: 3, query: 'unsafe-contract-symbol', data: symbolPayload };

	const hiddenPayload: Record<string, unknown> = { id: 3, title: 'unsafe-contract-hidden' };
	Object.defineProperty(hiddenPayload, 'hidden', { value: 'hidden', enumerable: false });
	cases[cases.length] = { id: 3, query: 'unsafe-contract-hidden', data: hiddenPayload };

	const nonPlainPayload = Object.create({ inherited: true }) as Record<string, unknown>;
	Object.defineProperty(nonPlainPayload, 'id', { value: 3, enumerable: true });
	Object.defineProperty(nonPlainPayload, 'title', { value: 'unsafe-contract-nonplain', enumerable: true });
	cases[cases.length] = { id: 3, query: 'unsafe-contract-nonplain', data: nonPlainPayload };

	let accessorInvoked = false;
	const accessorPayload: Record<string, unknown> = { id: 4, title: 'unsafe-contract-accessor' };
	Object.defineProperty(accessorPayload, 'profile', {
		enumerable: true,
		get() {
			accessorInvoked = true;
			return { city: 'Seoul' };
		}
	});
	cases[cases.length] = {
		id: 4,
		query: 'unsafe-contract-accessor',
		data: accessorPayload,
		accessorInvoked: () => accessorInvoked
	};

	for (const testCase of cases) {
		await assert.rejects(() => adapter.index(model, testCase.id, testCase.data));
		if (testCase.accessorInvoked) {
			assert.equal(testCase.accessorInvoked(), false, 'Search contract unsafe index accessors must not be invoked.');
		}
		await searchContractResult(adapter, model, testCase.query, {}, [], contractOptions);
	}
}

async function searchContractResult(
	adapter: SearchAdapter,
	model: ResolvedModelMeta<any>,
	query: string,
	options: Parameters<SearchAdapter['search']>[2],
	expectedIds: EntityId[],
	contractOptions: NormalizedSearchAdapterContractOptions
) {
	return await searchContractAssert(
		adapter,
		model,
		query,
		options,
		(result) => assert.deepEqual(searchContractResultIds(result.list, model.idField), expectedIds),
		contractOptions
	);
}

async function searchContractAssert(
	adapter: SearchAdapter,
	model: ResolvedModelMeta<any>,
	query: string,
	options: Parameters<SearchAdapter['search']>[2],
	assertResult: (result: QueryResult) => void,
	contractOptions: NormalizedSearchAdapterContractOptions
) {
	const deadline = Date.now() + contractOptions.settleMs;
	let lastError: unknown;
	while (true) {
		try {
			const result = normalizeSearchContractResult(
				await adapter.search(model, query, options),
				`Search contract adapter "${adapter.kind}" result`
			);
			assertResult(result);
			return result;
		} catch (error) {
			lastError = error;
		}
		if (contractOptions.settleMs <= 0 || Date.now() >= deadline) {
			throw lastError;
		}
		await sleep(Math.min(contractOptions.pollIntervalMs, Math.max(0, deadline - Date.now())));
	}
}

function normalizeSearchContractResult(result: unknown, context: string): QueryResult {
	if (!result || typeof result !== 'object' || Array.isArray(result)) {
		throw new ActiveTsConfigurationError(`${context} must be an object.`);
	}
	const prototype = Object.getPrototypeOf(result);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsConfigurationError(`${context} must be a plain object.`);
	}
	if (Object.getOwnPropertySymbols(result).length) {
		throw new ActiveTsConfigurationError(`${context} cannot contain symbol fields.`);
	}
	assertKnownSearchContractResultKeys(result as Record<string, unknown>, context);
	const list = ownOptionValue(result as Record<string, unknown>, 'list', context);
	const cursor = ownOptionValue(result as Record<string, unknown>, 'cursor', context);
	const more = ownOptionValue(result as Record<string, unknown>, 'more', context);
	const countValue = ownOptionValue(result as Record<string, unknown>, 'count', context);
	const totalValue = ownOptionValue(result as Record<string, unknown>, 'total', context);
	if (!Array.isArray(list)) throw new ActiveTsConfigurationError(`${context}.list must be an array.`);
	const count = assertSafeResultCount(countValue, `${context}.count`);
	const total = assertSafeResultCount(totalValue, `${context}.total`);
	if (cursor !== undefined && typeof cursor !== 'string') {
		throw new ActiveTsConfigurationError(`${context}.cursor must be a string.`);
	}
	if (more !== undefined && typeof more !== 'boolean') {
		throw new ActiveTsConfigurationError(`${context}.more must be a boolean.`);
	}
	const safeList = normalizeSearchContractHitList(list, `${context}.list`);
	if (count !== undefined && count !== safeList.length) {
		throw new ActiveTsConfigurationError(`${context}.count must equal result.list length.`);
	}
	if (total !== undefined && total < safeList.length) {
		throw new ActiveTsConfigurationError(`${context}.total cannot be smaller than result.list length.`);
	}
	const normalized: QueryResult = { list: safeList, count: count ?? safeList.length, total };
	if (cursor !== undefined) normalized.cursor = cursor;
	if (more !== undefined) normalized.more = more;
	return normalized;
}

function assertSearchContractTotal(result: QueryResult, expected: number, context: string) {
	if (result.total === undefined) return;
	assert.equal(result.total, expected, `${context}.total must match the deterministic fixture hit count.`);
}

function normalizeSearchContractHitList(list: unknown[], context: string) {
	if (Object.getOwnPropertySymbols(list).length) {
		throw new ActiveTsConfigurationError(`${context} cannot contain symbol fields.`);
	}
	assertDenseArrayItems(list, context);
	const hits: Record<string, unknown>[] = [];
	const seen = new Set<object>();
	for (let index = 0; index < list.length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(list, String(index));
		const item = descriptor && 'value' in descriptor ? descriptor.value : undefined;
		cloneSafeDataObject(item, `${context}[${index}]`);
		if (SET_HAS.call(seen, item as object)) {
			throw new ActiveTsConfigurationError(`${context} must not reuse hit object references.`);
		}
		SET_ADD.call(seen, item as object);
		hits[index] = item as Record<string, unknown>;
	}
	return hits;
}

function assertKnownSearchContractResultKeys(record: Record<string, unknown>, context: string) {
	const allowed = capturedSet<string>(SEARCH_CONTRACT_RESULT_KEYS);
	for (const property of Object.getOwnPropertyNames(record)) {
		if (!SET_HAS.call(allowed, property)) {
			throw new ActiveTsConfigurationError(`${context} contains unknown result property "${property}".`);
		}
	}
}

function assertStoreContractCapabilityMethods(
	adapter: StoreAdapter,
	capabilities: StoreAdapter['capabilities'] | undefined
) {
	if (capabilities?.aggregate === true && typeof adapter.aggregate !== 'function') {
		throw new ActiveTsConfigurationError(
			`Store contract adapter "${adapter.kind}" advertises aggregate support but does not expose aggregate().`
		);
	}
	if (capabilities?.transaction === true && typeof adapter.transaction !== 'function') {
		throw new ActiveTsConfigurationError(
			`Store contract adapter "${adapter.kind}" advertises transaction support but does not expose transaction().`
		);
	}
	if (capabilities?.savepoint === true && typeof adapter.savepoint !== 'function') {
		throw new ActiveTsConfigurationError(
			`Store contract adapter "${adapter.kind}" advertises savepoint support but does not expose savepoint().`
		);
	}
}

function searchContractResultIds(list: any[], idField = 'id') {
	return sortEntityIds(
		mapArray(list, (item) => {
			const id = valueFor(item, idField);
			assertSafeEntityId(id, 'Search contract result id');
			return id;
		})
	);
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export type AdapterContractSuite = Record<string, StoreAdapter | (() => MaybePromise<StoreAdapter>)>;
export type CacheAdapterContractSuite = Record<string, CacheAdapter | (() => MaybePromise<CacheAdapter>)>;
export type SearchAdapterContractSuite = Record<string, SearchAdapter | (() => MaybePromise<SearchAdapter>)>;

export function createAdapterContractSuite(
	adapters: AdapterContractSuite,
	options: StoreAdapterContractOptions = {}
) {
	const contractOptions = normalizeStoreAdapterContractOptions(options);
	if (!adapters || typeof adapters !== 'object' || Array.isArray(adapters)) {
		throw new ActiveTsConfigurationError('Adapter contract suite must be an object.');
	}
	const prototype = Object.getPrototypeOf(adapters);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsConfigurationError('Adapter contract suite must be an object.');
	}
	if (Object.getOwnPropertySymbols(adapters).length) {
		throw new ActiveTsConfigurationError('Adapter contract suite cannot contain symbol adapter names.');
	}
	const entries = mapArray(Object.getOwnPropertyNames(adapters), (name) => {
		const adapterOrFactory = ownOptionValue(adapters as Record<string, unknown>, name, 'Adapter contract suite');
		return [name, adapterOrFactory] as const;
	});
	for (const [name, adapterOrFactory] of entries) {
		if (typeof adapterOrFactory === 'function') continue;
		validateStoreContractAdapter(adapterOrFactory, `Adapter contract suite "${name}" adapter`);
	}
	return {
		async run() {
			for (const [name, adapterOrFactory] of entries) {
				const adapter =
					typeof adapterOrFactory === 'function' ? await adapterOrFactory() : adapterOrFactory;
				try {
					await runStoreAdapterContract(adapter, contractOptions);
				} catch (error) {
					if (error instanceof Error) error.message = `${name}: ${error.message}`;
					throw error;
				}
			}
		}
	};
}

export function createCacheAdapterContractSuite(adapters: CacheAdapterContractSuite) {
	const entries = snapshotAdapterContractSuiteEntries(
		adapters,
		'Cache adapter contract suite',
		validateCacheContractAdapter
	);
	return {
		async run() {
			for (const [name, adapterOrFactory] of entries) {
				const adapter =
					typeof adapterOrFactory === 'function' ? await adapterOrFactory() : adapterOrFactory;
				try {
					await runCacheAdapterContract(adapter);
				} catch (error) {
					if (error instanceof Error) error.message = `${name}: ${error.message}`;
					throw error;
				}
			}
		}
	};
}

export function createSearchAdapterContractSuite(
	adapters: SearchAdapterContractSuite,
	options: SearchAdapterContractOptions = {}
) {
	const contractOptions = normalizeSearchAdapterContractOptions(options);
	const entries = snapshotAdapterContractSuiteEntries(
		adapters,
		'Search adapter contract suite',
		validateSearchContractAdapter
	);
	return {
		async run() {
			for (const [name, adapterOrFactory] of entries) {
				const adapter =
					typeof adapterOrFactory === 'function' ? await adapterOrFactory() : adapterOrFactory;
				try {
					await runSearchAdapterContract(adapter, contractOptions);
				} catch (error) {
					if (error instanceof Error) error.message = `${name}: ${error.message}`;
					throw error;
				}
			}
		}
	};
}

function snapshotAdapterContractSuiteEntries<TAdapter>(
	adapters: Record<string, TAdapter | (() => MaybePromise<TAdapter>)>,
	context: string,
	validateAdapter: (adapter: unknown, context: string) => TAdapter
) {
	if (!adapters || typeof adapters !== 'object' || Array.isArray(adapters)) {
		throw new ActiveTsConfigurationError(`${context} must be an object.`);
	}
	const prototype = Object.getPrototypeOf(adapters);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsConfigurationError(`${context} must be an object.`);
	}
	if (Object.getOwnPropertySymbols(adapters).length) {
		throw new ActiveTsConfigurationError(`${context} cannot contain symbol adapter names.`);
	}
	const entries = mapArray(Object.getOwnPropertyNames(adapters), (name) => {
		const adapterOrFactory = ownOptionValue(adapters as Record<string, unknown>, name, context);
		return [name, adapterOrFactory] as const;
	});
	for (const [name, adapterOrFactory] of entries) {
		if (typeof adapterOrFactory === 'function') continue;
		validateAdapter(adapterOrFactory, `${context} "${name}" adapter`);
	}
	return entries;
}

function validateStoreContractAdapter(adapter: unknown, context: string): StoreAdapter {
	if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) {
		throw new ActiveTsConfigurationError(`${context} must be a store adapter object.`);
	}
	const record = adapter as Record<string, unknown>;
	validateTestingAdapterKind(testingAdapterMember(record, 'kind'), context);
	for (const property of ['get', 'getMany', 'query', 'create', 'update', 'delete']) {
		if (typeof testingAdapterMember(record, property) !== 'function') {
			throw new ActiveTsConfigurationError(`${context}.${property} must be a function.`);
		}
	}
	return adapter as StoreAdapter;
}

function validateCacheContractAdapter(adapter: unknown, context: string): CacheAdapter {
	if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) {
		throw new ActiveTsConfigurationError(`${context} must be a cache adapter object.`);
	}
	const record = adapter as Record<string, unknown>;
	validateTestingAdapterKind(testingAdapterMember(record, 'kind'), context);
	for (const property of ['getMany', 'setMany', 'deleteMany']) {
		if (typeof testingAdapterMember(record, property) !== 'function') {
			throw new ActiveTsConfigurationError(`${context}.${property} must be a function.`);
		}
	}
	const codecKey = testingAdapterMember(record, 'codecKey');
	if (codecKey !== undefined && typeof codecKey !== 'function') {
		throw new ActiveTsConfigurationError(`${context}.codecKey must be a function.`);
	}
	return adapter as CacheAdapter;
}

function validateSearchContractAdapter(adapter: unknown, context: string): SearchAdapter {
	if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) {
		throw new ActiveTsConfigurationError(`${context} must be a search adapter object.`);
	}
	const record = adapter as Record<string, unknown>;
	validateTestingAdapterKind(testingAdapterMember(record, 'kind'), context);
	for (const property of ['search', 'index', 'delete']) {
		if (typeof testingAdapterMember(record, property) !== 'function') {
			throw new ActiveTsConfigurationError(`${context}.${property} must be a function.`);
		}
	}
	const syncSchema = testingAdapterMember(record, 'syncSchema');
	if (syncSchema !== undefined && typeof syncSchema !== 'function') {
		throw new ActiveTsConfigurationError(`${context}.syncSchema must be a function.`);
	}
	const schema = testingAdapterMember(record, 'schema');
	if (schema !== undefined) {
		if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
			throw new ActiveTsConfigurationError(`${context}.schema must be an object.`);
		}
		if (typeof testingAdapterMember(schema as Record<string, unknown>, 'plan') !== 'function') {
			throw new ActiveTsConfigurationError(`${context}.schema.plan must be a function.`);
		}
		if (typeof testingAdapterMember(schema as Record<string, unknown>, 'apply') !== 'function') {
			throw new ActiveTsConfigurationError(`${context}.schema.apply must be a function.`);
		}
	}
	return adapter as SearchAdapter;
}

function validateTestingAdapterKind(kind: unknown, context: string) {
	if (typeof kind !== 'string' || !kind || kind.includes('\0')) {
		throw new ActiveTsConfigurationError(`${context}.kind must be a non-empty string without null bytes.`);
	}
	return kind;
}

function snapshotStoreContractCapabilities(adapter: StoreAdapter, context: string): StoreAdapter['capabilities'] {
	const raw = testingAdapterMember(adapter as Record<string, unknown>, 'capabilities');
	if (raw === undefined) return undefined;
	const record = assertPlainStoreContractCapabilityObject(raw, `${context}.capabilities`);
	assertKnownStoreContractCapabilityKeys(record, `${context}.capabilities`);
	const capabilities: NonNullable<StoreAdapter['capabilities']> = {};
	for (const key of STORE_CONTRACT_CAPABILITY_KEYS) {
		const value = ownStoreContractCapabilityValue(record, key, `${context}.capabilities`);
		if (value === undefined) continue;
		if (typeof value !== 'boolean') {
			throw new ActiveTsConfigurationError(`${context}.capabilities.${key} must be a boolean.`);
		}
		capabilities[key] = value;
	}
	return Object.freeze(capabilities);
}

function snapshotSearchContractCapabilities(adapter: SearchAdapter, context: string): SearchAdapter['capabilities'] {
	const raw = testingAdapterMember(adapter as Record<string, unknown>, 'capabilities');
	if (raw === undefined) return undefined;
	const record = assertPlainStoreContractCapabilityObject(raw, `${context}.capabilities`);
	assertKnownSearchContractCapabilityKeys(record, `${context}.capabilities`);
	const capabilities: NonNullable<SearchAdapter['capabilities']> = {};
	for (const key of SEARCH_CONTRACT_CAPABILITY_KEYS) {
		const value = ownStoreContractCapabilityValue(record, key as typeof STORE_CONTRACT_CAPABILITY_KEYS[number], `${context}.capabilities`);
		if (value === undefined) continue;
		if (key === 'whereOperators') {
			capabilities.whereOperators = snapshotSearchWhereOperators(value, `${context}.capabilities.whereOperators`);
			continue;
		}
		if (typeof value !== 'boolean') {
			throw new ActiveTsConfigurationError(`${context}.capabilities.${key} must be a boolean.`);
		}
		(capabilities as Record<string, unknown>)[key] = value;
	}
	return Object.freeze(capabilities);
}

function normalizeStoreAdapterContractOptions(
	options: StoreAdapterContractOptions
): NormalizedStoreAdapterContractOptions {
	assertPlainTestOptionObject(options, 'Store adapter contract options');
	const record = options as Record<string, unknown>;
	assertKnownOptionKeys(record, STORE_ADAPTER_CONTRACT_OPTION_KEYS, 'Store adapter contract options');
	const nativeProbe = ownOptionValue(record, 'nativeProbe', 'Store adapter contract options');
	if (nativeProbe !== undefined && typeof nativeProbe !== 'function') {
		throw new ActiveTsConfigurationError('Store adapter contract options.nativeProbe must be a function.');
	}
	return {
		nativeProbe: nativeProbe as NormalizedStoreAdapterContractOptions['nativeProbe']
	};
}

function normalizeSearchAdapterContractOptions(
	options: SearchAdapterContractOptions
): NormalizedSearchAdapterContractOptions {
	assertPlainTestOptionObject(options, 'Search adapter contract options');
	const record = options as Record<string, unknown>;
	assertKnownOptionKeys(record, SEARCH_ADAPTER_CONTRACT_OPTION_KEYS, 'Search adapter contract options');
	const settleMs = ownOptionValue(record, 'settleMs', 'Search adapter contract options');
	const pollIntervalMs = ownOptionValue(record, 'pollIntervalMs', 'Search adapter contract options');
	const nativeProbe = ownOptionValue(record, 'nativeProbe', 'Search adapter contract options');
	if (nativeProbe !== undefined && typeof nativeProbe !== 'function') {
		throw new ActiveTsConfigurationError('Search adapter contract options.nativeProbe must be a function.');
	}
	return {
		settleMs: normalizeSearchContractMs(settleMs, 'Search adapter contract options.settleMs', {
			defaultValue: 0,
			allowZero: true
		}),
		pollIntervalMs: normalizeSearchContractMs(pollIntervalMs, 'Search adapter contract options.pollIntervalMs', {
			defaultValue: 25,
			allowZero: false
		}),
		nativeProbe: nativeProbe as NormalizedSearchAdapterContractOptions['nativeProbe']
	};
}

function normalizeSearchContractMs(
	value: unknown,
	context: string,
	options: { defaultValue: number; allowZero: boolean }
) {
	if (value === undefined) return options.defaultValue;
	if (
		typeof value !== 'number' ||
		!Number.isSafeInteger(value) ||
		value < 0 ||
		(!options.allowZero && value === 0)
	) {
		throw new ActiveTsConfigurationError(
			`${context} must be a ${options.allowZero ? 'non-negative' : 'positive'} safe integer.`
		);
	}
	return value;
}

function snapshotSearchWhereOperators(value: unknown, context: string) {
	const record = assertPlainStoreContractCapabilityObject(value, context);
	const allowed = capturedSet<string>(SEARCH_CONTRACT_WHERE_OPERATOR_KEYS);
	for (const property of Object.keys(record)) {
		if (!SET_HAS.call(allowed, property)) {
			throw new ActiveTsConfigurationError(`${context} contains unknown operator "${property}".`);
		}
	}
	const operators: NonNullable<NonNullable<SearchAdapter['capabilities']>['whereOperators']> = {};
	for (const operator of SEARCH_CONTRACT_WHERE_OPERATOR_KEYS) {
		if (!Object.prototype.hasOwnProperty.call(record, operator)) continue;
		const descriptor = Object.getOwnPropertyDescriptor(record, operator);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsConfigurationError(`${context}.${operator} must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsConfigurationError(`${context}.${operator} must be enumerable.`);
		}
		if (typeof descriptor.value !== 'boolean') {
			throw new ActiveTsConfigurationError(`${context}.${operator} must be a boolean.`);
		}
		operators[operator] = descriptor.value;
	}
	return Object.freeze(operators);
}

function assertPlainStoreContractCapabilityObject(value: unknown, context: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ActiveTsConfigurationError(`${context} must be a plain object.`);
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsConfigurationError(`${context} must be a plain object.`);
	}
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
	return value as Record<string, unknown>;
}

function assertKnownStoreContractCapabilityKeys(record: Record<string, unknown>, context: string) {
	const allowed = capturedSet(STORE_CONTRACT_CAPABILITY_KEYS);
	for (const property of Object.keys(record)) {
		if (!SET_HAS.call(allowed, property as typeof STORE_CONTRACT_CAPABILITY_KEYS[number])) {
			throw new ActiveTsConfigurationError(`${context} contains unknown capability "${property}".`);
		}
	}
}

function assertKnownSearchContractCapabilityKeys(record: Record<string, unknown>, context: string) {
	const allowed = capturedSet(SEARCH_CONTRACT_CAPABILITY_KEYS);
	for (const property of Object.keys(record)) {
		if (!SET_HAS.call(allowed, property as typeof SEARCH_CONTRACT_CAPABILITY_KEYS[number])) {
			throw new ActiveTsConfigurationError(`${context} contains unknown capability "${property}".`);
		}
	}
}

function ownStoreContractCapabilityValue(
	record: Record<string, unknown>,
	key: typeof STORE_CONTRACT_CAPABILITY_KEYS[number],
	context: string
) {
	if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(record, key);
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsConfigurationError(`${context}.${key} must be a data property.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsConfigurationError(`${context}.${key} must be enumerable.`);
	}
	return descriptor.value;
}

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
			try {
				result = await withTestContext(handle.context, fn, withOptions);
			} catch (error) {
				runError = error;
			}
			try {
				await handle.close();
			} catch (closeError) {
				if (runError) {
					throw new AggregateError(
						[runError, closeError],
						`Integration harness "${harness.name}" failed while running withContext and cleanup failed.`
					);
				}
				throw closeError;
			}
			if (runError) throw runError;
			return result as T;
		},
		async runStoreContract(options: StoreAdapterContractOptions = {}) {
			const contractOptions = normalizeStoreAdapterContractOptions(options);
			let resource: TResource | undefined;
			let contractError: unknown;
			let stopError: unknown;
			try {
				resource = harness.start ? await harness.start() : undefined;
				await runStoreAdapterContract(await harness.createStore(resource), contractOptions);
			} catch (error) {
				contractError = error;
			}
			if (harness.stop) {
				try {
					await harness.stop(resource);
				} catch (error) {
					stopError = error;
				}
			}
			if (contractError && stopError) {
				throw new AggregateError(
					[contractError, stopError],
					`Integration harness "${harness.name}" failed to run the store contract and cleanup failed.`
				);
			}
			if (contractError) throw contractError;
			if (stopError) throw stopError;
		},
		async runCacheContract() {
			let resource: TResource | undefined;
			let contractError: unknown;
			let stopError: unknown;
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
			}
			if (harness.stop) {
				try {
					await harness.stop(resource);
				} catch (error) {
					stopError = error;
				}
			}
			if (contractError && stopError) {
				throw new AggregateError(
					[contractError, stopError],
					`Integration harness "${harness.name}" failed to run the cache contract and cleanup failed.`
				);
			}
			if (contractError) throw contractError;
			if (stopError) throw stopError;
		},
		async runSearchContract(options: SearchAdapterContractOptions = {}) {
			const contractOptions = normalizeSearchAdapterContractOptions(options);
			let resource: TResource | undefined;
			let contractError: unknown;
			let stopError: unknown;
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
			}
			if (harness.stop) {
				try {
					await harness.stop(resource);
				} catch (error) {
					stopError = error;
				}
			}
			if (contractError && stopError) {
				throw new AggregateError(
					[contractError, stopError],
					`Integration harness "${harness.name}" failed to run the search contract and cleanup failed.`
				);
			}
			if (contractError) throw contractError;
			if (stopError) throw stopError;
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

function validateLazyWarningMode(mode: unknown): asserts mode is LazyWarningMode {
	if (mode !== 'console' && mode !== 'capture' && mode !== 'throw' && mode !== 'off') {
		throw new ActiveTsConfigurationError(
			'Test lazyLoadWarnings must be one of "console", "capture", "throw", or "off".'
		);
	}
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

function assertPlainTestOptionObject(value: unknown, context: string) {
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

function assertKnownOptionKeys(record: Record<string, unknown>, allowed: readonly string[], context: string) {
	const allowedKeys = capturedSet(allowed);
	for (const property of Object.keys(record)) {
		if (!SET_HAS.call(allowedKeys, property)) {
			throw new ActiveTsConfigurationError(`${context} contains unknown option "${property}".`);
		}
	}
}

function assertActiveTestContext(context: unknown, label: string): asserts context is ActiveTestContext {
	if (!(context instanceof ActiveTestContext)) {
		throw new ActiveTsConfigurationError(`${label} must be an ActiveTestContext.`);
	}
}

function normalizeWithTestContextOptions(options: { install?: boolean }) {
	assertPlainTestOptionObject(options, 'withTestContext options');
	assertKnownOptionKeys(options as Record<string, unknown>, WITH_TEST_CONTEXT_OPTION_KEYS, 'withTestContext options');
	const install = ownOptionValue(options as Record<string, unknown>, 'install', 'withTestContext options');
	if (install !== undefined && typeof install !== 'boolean') {
		throw new ActiveTsConfigurationError('withTestContext options.install must be a boolean.');
	}
	return { install };
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

function ownOptionValue(record: Record<string, unknown>, key: string, context?: string) {
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

function seedRowId(row: Record<string, unknown>, meta: ResolvedModelMeta) {
	const id = valueFor(row, meta.idField);
	assertSafeEntityId(id, `ActiveTestContext.seed() ${meta.name}.${meta.idField}`);
	return id;
}
