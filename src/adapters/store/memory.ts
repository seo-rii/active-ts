import type {
	AggregatePlan,
	AggregateResult,
	EntityId,
	QueryPlan,
	QueryResult,
	ResolvedModelMeta,
	SchemaPlan,
	StoreAdapter,
	StoreCapabilities,
	StoreTransactionOptions,
	StoreWriteOptions
} from '../../core/types.js';
import {
	assertSafeEntityId,
	assertSafeLimit,
	assertSafeSchemaIdentifier,
	assertSafeEntityIdArray,
	assertSafeTopLevelField,
	clonePortableDataObject,
	cloneSafeDataObject
} from '../../core/safe-keys.js';
import { aggregateRows, assertAggregateSpecsCompatibleWithModel } from '../../core/aggregate.js';
import { ActiveTsConfigurationError, ActiveTsConflictError, ActiveTsNotFoundError, ActiveTsValidationError } from '../../core/errors.js';
import {
	assertStoreDataMatchesId,
	assertStoreDataHasModelId,
	assertStorePlanSupported,
	createCloseGuardedStoreAdapter,
	normalizeStoreAggregatePlan,
	normalizeStoreQueryPlan,
	normalizeStoreTransactionOptions,
	normalizeStoreWriteOptions,
	rejectUnsupportedStoreReadOptions,
	rejectUnsupportedStoreWriteMetadata,
	rejectUnsupportedStoreWriteOptions,
	validateStoreQueryReadOptions
} from '../../core/store-options.js';
import { normalizeSchemaModels } from '../../core/schema-utils.js';
import { normalizeStoreSchemaApplyOptions } from '../../core/schema-options.js';
import { snapshotAdapterModel } from '../../core/adapter-model.js';
import { snapshotArrayInput } from '../../core/array-input.js';
import {
	iterableToArray,
	MAP_CLEAR,
	MAP_DELETE,
	MAP_ENTRIES,
	MAP_GET,
	MAP_HAS,
	MAP_SET,
	MAP_SIZE,
	MAP_VALUES,
	SET_ADD,
	SET_HAS
} from '../../core/collection-intrinsics.js';
import { normalizeAggregatePlanFieldTypes, normalizeQueryPlanFieldTypes } from '../../core/field-types.js';
import {
	assertNoAggregateFieldCodecSpecs,
	encodeAggregatePlanFieldCodecs,
	encodeQueryPlanFieldCodecs,
	stripFieldCodecQueryOperandMarker
} from '../../core/field-codecs.js';
import {
	assertCursorMatchesSort,
	compareRowsBySort,
	compareRowToCursor,
	cursorValues,
	decodeCursor,
	encodeCursor,
	sortWithStableId
} from '../../core/cursor.js';
import { entityIdKey, filterRows, pickFields, valueFor } from '../../core/query-utils.js';

type DirtyChange =
	| { operation: 'create'; value: any }
	| { operation: 'update'; value: any; expectedVersion?: number }
	| { operation: 'delete'; expectedVersion?: number };

type PointReadSet = Map<string, Map<string, true>>;

export type MemoryStoreOptions = {
	cacheScope?: string;
};

const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const MAX_ROW_REVISION = 9_007_199_254_740_991;

function cloneRow<T>(value: T | null | undefined, context: string): T | null {
	if (value === null || value === undefined) return null;
	return cloneSafeDataObject(value, context) as T;
}

function mapGet<K, V>(map: Map<K, V>, key: K): V | undefined {
	return MAP_GET.call(map, key) as V | undefined;
}

function mapHas<K, V>(map: Map<K, V>, key: K): boolean {
	return MAP_HAS.call(map, key);
}

function mapSet<K, V>(map: Map<K, V>, key: K, value: V) {
	MAP_SET.call(map, key, value);
}

function mapDelete<K, V>(map: Map<K, V>, key: K): boolean {
	return MAP_DELETE.call(map, key);
}

export class MemoryStoreAdapter implements StoreAdapter {
	readonly kind = 'memory';
	readonly cacheScope?: string;
	readonly datastoreNamespace?: string;
	readonly datastoreProjectId?: string;
	readonly datastoreDatabaseId?: string | null;
	readonly datastoreKeyEncoding?: 'active-ts' | 'native';
	readonly capabilities: Required<Omit<StoreCapabilities, 'datastoreAncestor' | 'datastoreReadPolicy'>> = {
		or: true,
		contains: false,
		arrayContains: true,
		textContains: true,
		jsonContains: true,
		startsWith: true,
		cursor: true,
		offset: true,
		select: true,
		nestedFields: true,
		numericComparisons: true,
		aggregate: true,
		transaction: true,
		transactionConflictDetection: true,
		savepoint: false,
		uniqueIndex: false,
		optimisticLock: true,
		nullOperators: true,
		missingFieldNulls: true,
		native: false
	};
	private readonly collections = new Map<string, Map<string, any>>();
	private readonly rowRevisions = new Map<string, Map<string, number>>();
	private readonly rowRevisionTombstones = new Map<string, Map<string, number>>();
	private readonly activeTransactionSnapshots = new Map<number, number>();
	private rowRevisionGeneration = 0;
	readonly stats = {
		get: 0,
		getMany: 0,
		query: 0,
		aggregate: 0,
		create: 0,
		update: 0,
		delete: 0
	};

	constructor(options: MemoryStoreOptions = {}) {
		if (!options || typeof options !== 'object' || Array.isArray(options)) {
			throw new ActiveTsConfigurationError('Memory store adapter options must be a plain object.');
		}
		const prototype = Object.getPrototypeOf(options);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new ActiveTsConfigurationError('Memory store adapter options must be a plain object.');
		}
		if (Object.getOwnPropertySymbols(options).length) {
			throw new ActiveTsConfigurationError('Memory store adapter options cannot contain symbol fields.');
		}
		for (const property of Object.getOwnPropertyNames(options)) {
			if (property !== 'cacheScope') {
				throw new ActiveTsConfigurationError(`Memory store adapter options contain unknown option "${property}".`);
			}
		}
		const descriptor = Object.getOwnPropertyDescriptor(options, 'cacheScope');
		if (descriptor && (!('value' in descriptor) || !descriptor.enumerable)) {
			throw new ActiveTsConfigurationError('Memory store adapter option "cacheScope" must be an enumerable data property.');
		}
		const cacheScope = descriptor && 'value' in descriptor ? descriptor.value : undefined;
		if (cacheScope !== undefined && (typeof cacheScope !== 'string' || !cacheScope || cacheScope.includes('\0'))) {
			throw new ActiveTsConfigurationError(
				'Memory store adapter cacheScope must be a non-empty string without null bytes.'
			);
		}
		this.cacheScope = cacheScope as string | undefined;
	}

	async get(model: ResolvedModelMeta, id: EntityId, options?: unknown) {
		model = snapshotAdapterModel(model, 'memory store model metadata');
		rejectUnsupportedStoreReadOptions(options, 'memory store read options');
		assertSafeEntityId(id, `${model.name} store id`);
		this.stats.get++;
		return cloneRow(mapGet(this.existingCollection(model.name), entityIdKey(id)), `${model.name} stored row`);
	}

	async getMany(model: ResolvedModelMeta, ids: EntityId[], options?: unknown) {
		model = snapshotAdapterModel(model, 'memory store model metadata');
		rejectUnsupportedStoreReadOptions(options, 'memory store read options');
		ids = assertSafeEntityIdArray(ids, 'memory store ids');
		this.stats.getMany++;
		const collection = this.existingCollection(model.name);
		const rows: Array<any | null> = [];
		for (let index = 0; index < ids.length; index++) {
			rows[index] = cloneRow(mapGet(collection, entityIdKey(ids[index])), `${model.name} stored row`);
		}
		return rows;
	}

	async query(model: ResolvedModelMeta, plan: QueryPlan, options?: unknown): Promise<QueryResult> {
		model = snapshotAdapterModel(model, 'memory store model metadata');
		plan = normalizeStoreQueryPlan(plan, model.idField, 'memory query plan');
		plan = normalizeQueryPlanFieldTypes(model, plan);
		plan = encodeQueryPlanFieldCodecs(model, plan);
		assertStorePlanSupported(this.kind, this.capabilities, plan);
		validateStoreQueryReadOptions(options, plan, 'memory store read options');
		this.stats.query++;
		let list = this.filtered(model, plan);
		const sort = sortWithStableId(plan, model.idField);
		list = sortMemoryRows(list, sort);
		if (plan.cursor) {
			const cursor = decodeCursor(plan.cursor);
			assertCursorMatchesSort(cursor, sort);
			const afterCursor: any[] = [];
			for (let index = 0; index < list.length; index++) {
				const item = list[index];
				if (compareRowToCursor(item, cursor) > 0) afterCursor[afterCursor.length] = item;
			}
			list = afterCursor;
		}
		if (plan.offset !== undefined) list = copyRows(list, plan.offset, list.length);
		let cursor: string | undefined;
		let more = false;
		if (plan.limit !== undefined) {
			const limit = assertSafeLimit(plan.limit, 'memory adapter limit') as number;
			more = list.length > limit;
			list = copyRows(list, 0, limit);
			const last = list.length ? list[list.length - 1] : undefined;
			if (more && last) cursor = encodeCursor({ v: 1, kind: 'keyset', sort, values: cursorValues(last, sort) });
		}
		if (plan.select?.length) {
			const selected: any[] = [];
			for (let index = 0; index < list.length; index++) {
				selected[index] = pickFields(list[index], plan.select, model.idField);
			}
			list = selected;
		}
		const rows: any[] = [];
		for (let index = 0; index < list.length; index++) {
			rows[index] = cloneSafeDataObject(list[index], `${model.name} query row`);
		}
		return { list: rows, cursor, more, count: rows.length };
	}

	async aggregate(model: ResolvedModelMeta, plan: AggregatePlan): Promise<AggregateResult> {
		model = snapshotAdapterModel(model, 'memory store model metadata');
		plan = normalizeStoreAggregatePlan(plan, 'memory aggregate plan');
		plan = normalizeAggregatePlanFieldTypes(model, plan);
		plan = encodeAggregatePlanFieldCodecs(model, plan);
		assertStorePlanSupported(this.kind, this.capabilities, plan);
		const specs = assertAggregateSpecsCompatibleWithModel(model, plan.aggregates, 'memory aggregate');
		assertNoAggregateFieldCodecSpecs(model, specs, 'memory aggregate');
		this.stats.aggregate++;
		return aggregateRows(this.filtered(model, plan), specs);
	}

	async create(model: ResolvedModelMeta, id: EntityId, data: any, options = {}) {
		model = snapshotAdapterModel(model, 'memory store model metadata');
		assertSafeEntityId(id, `${model.name} store id`);
		rejectUnsupportedStoreWriteOptions(options, 'memory store create options');
		this.stats.create++;
		const clean = clonePortableDataObject(data, `${model.name} stored data`);
		assertStoreDataMatchesId(model, id, clean);
		const key = entityIdKey(id);
		const existing = this.existingCollection(model.name);
		if (mapHas(existing, key)) {
			throw new ActiveTsConflictError(`Cannot create ${model.name}:${String(id)} because it already exists.`);
		}
		const revision = this.reserveRowRevisions(1);
		const collection = this.collection(model.name);
		mapSet(collection, key, clean);
		this.recordRowRevision(model.name, key, revision, true);
	}

	async update(model: ResolvedModelMeta, id: EntityId, data: any, options: StoreWriteOptions = {}) {
		model = snapshotAdapterModel(model, 'memory store model metadata');
		assertSafeEntityId(id, `${model.name} store id`);
		this.stats.update++;
		options = rejectUnsupportedStoreWriteMetadata(
			normalizeStoreWriteOptions(options, 'memory store write options'),
			'memory store write options'
		);
		const clean = clonePortableDataObject(data, `${model.name} stored data`);
		assertStoreDataMatchesId(model, id, clean);
		const collection = this.existingCollection(model.name);
		const key = entityIdKey(id);
		if (!mapHas(collection, key)) {
			throw new ActiveTsNotFoundError(`Cannot update ${model.name}:${String(id)} because it does not exist.`);
		}
		if (options.expectedVersion !== undefined) {
			const current = mapGet(collection, key);
			if (!memoryVersionMatches(current, options.expectedVersion)) {
				throw new ActiveTsConflictError(
					`Optimistic lock failed for ${model.name}:${String(id)}. Expected version ${options.expectedVersion}.`
				);
			}
		}
		const revision = this.reserveRowRevisions(1);
		mapSet(collection, key, clean);
		this.recordRowRevision(model.name, key, revision, true);
	}

	async delete(model: ResolvedModelMeta, id: EntityId, options = {}) {
		model = snapshotAdapterModel(model, 'memory store model metadata');
		assertSafeEntityId(id, `${model.name} store id`);
		this.stats.delete++;
		const writeOptions = rejectUnsupportedStoreWriteMetadata(
			normalizeStoreWriteOptions(options, 'memory store delete options'),
			'memory store delete options'
		);
		const collection = this.existingCollection(model.name);
		const key = entityIdKey(id);
		if (writeOptions.expectedVersion !== undefined) {
			const current = mapGet(collection, key);
			if (!current) {
				throw new ActiveTsNotFoundError(`Cannot delete ${model.name}:${String(id)} because it does not exist.`);
			}
			if (!memoryVersionMatches(current, writeOptions.expectedVersion)) {
				throw new ActiveTsConflictError(
					`Optimistic lock failed for ${model.name}:${String(id)}. Expected version ${writeOptions.expectedVersion}.`
				);
			}
		}
		if (mapHas(collection, key)) {
			const revision = this.reserveRowRevisions(1);
			mapDelete(collection, key);
			this.recordRowRevision(model.name, key, revision, false);
		}
	}

	async transaction<T>(fn: (tx: StoreAdapter) => Promise<T>, options?: StoreTransactionOptions): Promise<T> {
		if (typeof fn !== 'function') {
			throw new ActiveTsConfigurationError('memory store transaction callback must be a function.');
		}
		const transactionOptions = normalizeStoreTransactionOptions(options, 'memory store transaction options');
		if (transactionOptions.isolation !== undefined) {
			throw new ActiveTsConfigurationError('memory store transaction options.isolation is not supported.');
		}
		if (transactionOptions.timeoutMs !== undefined) {
			throw new ActiveTsConfigurationError('memory store transaction options.timeoutMs is not supported.');
		}
		if (transactionOptions.native !== undefined) {
			throw new ActiveTsConfigurationError('memory store transaction options.native is not supported.');
		}
		const txStore = new MemoryStoreAdapter();
		txStore.replaceCollections(this.cloneCollections());
		const dirty = new Map<string, Map<string, DirtyChange>>();
		const pointReads: PointReadSet = new Map();
		let revisionSnapshot = 0;
		const cloneDirty = () => {
			const snapshot = new Map<string, Map<string, DirtyChange>>();
			for (const [name, changes] of MAP_ENTRIES.call(dirty)) {
				const clonedChanges = new Map<string, DirtyChange>();
				for (const [id, change] of MAP_ENTRIES.call(changes)) {
					mapSet(
						clonedChanges,
						id,
						change.operation === 'delete'
							? { ...change }
							: {
									...change,
									value: cloneSafeDataObject(change.value, `${name} transaction checkpoint row`)
								}
					);
				}
				mapSet(snapshot, name, clonedChanges);
			}
			return snapshot;
		};
		const restoreDirty = (snapshot: Map<string, Map<string, DirtyChange>>) => {
			MAP_CLEAR.call(dirty);
			for (const [name, changes] of MAP_ENTRIES.call(snapshot)) mapSet(dirty, name, changes);
		};
		const clonePointReads = () => {
			const snapshot: PointReadSet = new Map();
			for (const [name, reads] of MAP_ENTRIES.call(pointReads)) {
				const clonedReads = new Map<string, true>();
				for (const [id] of MAP_ENTRIES.call(reads)) mapSet(clonedReads, id, true);
				mapSet(snapshot, name, clonedReads);
			}
			return snapshot;
		};
		const restorePointReads = (snapshot: PointReadSet) => {
			MAP_CLEAR.call(pointReads);
			for (const [name, reads] of MAP_ENTRIES.call(snapshot)) mapSet(pointReads, name, reads);
		};
		const recordPointRead = (model: ResolvedModelMeta, id: EntityId) => {
			const key = entityIdKey(id);
			let reads = mapGet(pointReads, model.name);
			if (!reads) {
				reads = new Map();
				mapSet(pointReads, model.name, reads);
			}
			mapSet(reads, key, true);
		};
		const dirtyCollection = (model: ResolvedModelMeta) => {
			const collection = mapGet(dirty, model.name) ?? new Map<string, DirtyChange>();
			mapSet(dirty, model.name, collection);
			return collection;
		};
		const markCreate = (model: ResolvedModelMeta, id: EntityId, value: any) => {
			const collection = dirtyCollection(model);
			const key = entityIdKey(id);
			const current = mapGet(collection, key);
			mapSet(
				collection,
				key,
				current?.operation === 'delete'
					? { operation: 'update', value, expectedVersion: current.expectedVersion }
					: { operation: 'create', value }
			);
		};
		const markUpdate = (model: ResolvedModelMeta, id: EntityId, value: any, expectedVersion?: number) => {
			const collection = dirtyCollection(model);
			const key = entityIdKey(id);
			const current = mapGet(collection, key);
			mapSet(
				collection,
				key,
				current?.operation === 'create'
					? { operation: 'create', value }
					: {
							operation: 'update',
							value,
							expectedVersion: current?.operation === 'update' || current?.operation === 'delete'
								? current.expectedVersion
								: expectedVersion
						}
			);
		};
		const markDelete = (model: ResolvedModelMeta, id: EntityId, existed: boolean, expectedVersion?: number) => {
			const collection = dirtyCollection(model);
			const key = entityIdKey(id);
			const current = mapGet(collection, key);
			if (current?.operation === 'create') {
				mapDelete(collection, key);
				if (!MAP_SIZE.call(collection)) mapDelete(dirty, model.name);
				return;
			}
			if (!existed && !current) {
				if (!MAP_SIZE.call(collection)) mapDelete(dirty, model.name);
				return;
			}
			mapSet(collection, key, {
				operation: 'delete',
				expectedVersion: current?.operation === 'update' || current?.operation === 'delete'
					? current.expectedVersion
					: expectedVersion
			});
		};
		let tx!: StoreAdapter;
		tx = {
			kind: txStore.kind,
			cacheScope: this.cacheScope,
			datastoreNamespace: this.datastoreNamespace,
			datastoreProjectId: this.datastoreProjectId,
			datastoreDatabaseId: this.datastoreDatabaseId,
			datastoreKeyEncoding: this.datastoreKeyEncoding,
			capabilities: { ...txStore.capabilities, transaction: false, savepoint: true },
			get: async (model, id, options) => {
				const safeModel = snapshotAdapterModel(model, 'memory store model metadata');
				assertSafeEntityId(id, `${safeModel.name} store id`);
				const row = await txStore.get(safeModel, id, options);
				recordPointRead(safeModel, id);
				return row;
			},
			getMany: async (model, ids, options) => {
				const safeModel = snapshotAdapterModel(model, 'memory store model metadata');
				const safeIds = assertSafeEntityIdArray(ids, 'memory store ids');
				const rows = await txStore.getMany(safeModel, safeIds, options);
				for (let index = 0; index < safeIds.length; index++) recordPointRead(safeModel, safeIds[index]);
				return rows;
			},
			query: (model, plan, options) => txStore.query(model, plan, options),
			aggregate: (model, plan) => txStore.aggregate(model, plan),
			create: async (model, id, data, options) => {
				const safeModel = snapshotAdapterModel(model, 'memory store model metadata');
				rejectUnsupportedStoreWriteOptions(options, 'memory store create options');
				const clean = clonePortableDataObject(data, `${safeModel.name} transaction create data`);
				assertStoreDataMatchesId(safeModel, id, clean);
				await txStore.create(safeModel, id, clean);
				markCreate(safeModel, id, clean);
			},
			update: async (model, id, data, options) => {
				const safeModel = snapshotAdapterModel(model, 'memory store model metadata');
				const writeOptions = rejectUnsupportedStoreWriteMetadata(
					normalizeStoreWriteOptions(options, 'memory store write options'),
					'memory store write options'
				);
				const clean = clonePortableDataObject(data, `${safeModel.name} transaction update data`);
				assertStoreDataMatchesId(safeModel, id, clean);
				await txStore.update(safeModel, id, clean, writeOptions);
				markUpdate(safeModel, id, clean, writeOptions.expectedVersion);
			},
			delete: async (model, id, options) => {
				const safeModel = snapshotAdapterModel(model, 'memory store model metadata');
				assertSafeEntityId(id, `${safeModel.name} store id`);
				const writeOptions = rejectUnsupportedStoreWriteMetadata(
					normalizeStoreWriteOptions(options, 'memory store delete options'),
					'memory store delete options'
				);
				const existed = mapHas(txStore.existingCollection(safeModel.name), entityIdKey(id));
				await txStore.delete(safeModel, id, writeOptions);
				markDelete(safeModel, id, existed, writeOptions.expectedVersion);
			},
			savepoint: async (savepointFn) => {
				if (typeof savepointFn !== 'function') {
					throw new ActiveTsConfigurationError('memory store savepoint callback must be a function.');
				}
				const collectionsCheckpoint = txStore.cloneCollections();
				const dirtyCheckpoint = cloneDirty();
				const pointReadsCheckpoint = clonePointReads();
				try {
					return await savepointFn(tx);
				} catch (error) {
					txStore.replaceCollections(collectionsCheckpoint);
					restoreDirty(dirtyCheckpoint);
					restorePointReads(pointReadsCheckpoint);
					throw error;
				}
			}
		};
		const rejectReadOnlyWrite = async () => {
			throw new ActiveTsConfigurationError('memory store transaction is read-only.');
		};
		let scopedTx!: StoreAdapter;
		scopedTx = transactionOptions.readOnly === true
			? {
					kind: tx.kind,
					cacheScope: tx.cacheScope,
					datastoreNamespace: tx.datastoreNamespace,
					datastoreProjectId: tx.datastoreProjectId,
					datastoreDatabaseId: tx.datastoreDatabaseId,
					datastoreKeyEncoding: tx.datastoreKeyEncoding,
					capabilities: { ...tx.capabilities, transaction: false, native: false },
					get: (model, id, options) => tx.get(model, id, options),
					getMany: (model, ids, options) => tx.getMany(model, ids, options),
					query: (model, plan, options) => tx.query(model, plan, options),
					aggregate: tx.aggregate ? (model, plan) => tx.aggregate!(model, plan) : undefined,
					create: rejectReadOnlyWrite,
					update: rejectReadOnlyWrite,
					delete: rejectReadOnlyWrite,
					savepoint: (savepointFn) => tx.savepoint!(async () => savepointFn(scopedTx))
				}
			: tx;
		let closed: string | undefined;
		const guardedTx = createCloseGuardedStoreAdapter(scopedTx, () => closed, 'memory store');
		revisionSnapshot = this.beginTransactionSnapshot();
		try {
			const result = await fn(guardedTx.adapter);
			closed = 'callback finished';
			await guardedTx.waitForPendingOperations();
			this.applyDirty(dirty, pointReads, revisionSnapshot);
			closed = 'commit';
			return result;
		} catch (error) {
			closed = 'rollback';
			try {
				await guardedTx.waitForPendingOperations();
			} catch {
				// Preserve the callback or operation error that triggered rollback.
			}
			throw error;
		} finally {
			try {
				this.mergeStats(txStore.stats);
			} finally {
				this.releaseTransactionSnapshot(revisionSnapshot);
			}
		}
	}

	async seed(modelOrName: string | ResolvedModelMeta, rows: any[]) {
		if (!Array.isArray(rows)) {
			throw new ActiveTsValidationError('memory store seed rows must be an array.');
		}
		const safeRows = snapshotArrayInput(rows, 'memory store seed rows');
		const model = typeof modelOrName === 'string'
			? undefined
			: snapshotAdapterModel(modelOrName, 'memory store seed model metadata');
		const modelName = assertSafeSchemaIdentifier(
			typeof modelOrName === 'string' ? modelOrName : model!.name,
			'memory store seed model name'
		);
		const idField = assertSafeTopLevelField(
			typeof modelOrName === 'string' ? 'id' : model!.idField,
			'memory store seed id field'
		);
		const prepared: Array<readonly [string, any]> = [];
		for (let index = 0; index < safeRows.length; index++) {
			const row = safeRows[index];
			const clean = clonePortableDataObject(row, `${modelName} stored data`);
			const id = assertStoreDataHasModelId({ name: modelName, idField }, clean, `${modelName} seed row`);
			prepared[index] = [entityIdKey(id), clean] as const;
		}
		const seen = new Set<string>();
		for (const [key] of prepared) {
			if (SET_HAS.call(seen, key)) {
				throw new ActiveTsConflictError(`Cannot seed ${modelName}:${key} because the seed batch contains duplicate ids.`);
			}
			SET_ADD.call(seen, key);
		}
		const existing = mapGet(this.collections, modelName);
		for (const [key] of prepared) {
			if (existing && mapHas(existing, key)) {
				throw new ActiveTsConflictError(`Cannot seed ${modelName}:${key} because it already exists.`);
			}
		}
		const firstRevision = prepared.length === 0 ? 0 : this.reserveRowRevisions(prepared.length);
		const collection = this.collection(modelName);
		let revisionOffset = 0;
		for (const [key, row] of prepared) {
			mapSet(collection, key, row);
			this.recordRowRevision(modelName, key, firstRevision + revisionOffset++, true);
		}
	}

	async seedModel(model: ResolvedModelMeta, rows: any[]) {
		await this.seed(model, rows);
	}

	dump(modelName: string) {
		modelName = assertSafeSchemaIdentifier(modelName, 'memory collection name');
		const collection = mapGet(this.collections, modelName);
		const rows: any[] = [];
		if (!collection) return rows;
		let index = 0;
		for (const item of MAP_VALUES.call(collection) as Iterable<any>) {
			rows[index++] = cloneSafeDataObject(item, `${modelName} stored row`);
		}
		return rows;
	}

	snapshot(modelName: string): any[];
	snapshot(): Record<string, any[]>;
	snapshot(modelName?: string) {
		if (modelName) return this.dump(modelName);
		const snapshot: Record<string, any[]> = {};
		for (const [name, collection] of MAP_ENTRIES.call(this.collections) as Iterable<[string, Map<string, any>]>) {
			const rows: any[] = [];
			let index = 0;
			for (const item of MAP_VALUES.call(collection) as Iterable<any>) {
				rows[index++] = cloneSafeDataObject(item, `${name} stored row`);
			}
			snapshot[name] = rows;
		}
		return snapshot;
	}

	reset(modelName?: string) {
		if (modelName) {
			modelName = assertSafeSchemaIdentifier(modelName, 'memory collection name');
			const collection = mapGet(this.collections, modelName);
			let firstRevision = 0;
			if (collection && MAP_SIZE.call(collection) > 0) {
				firstRevision = this.reserveRowRevisions(MAP_SIZE.call(collection));
			}
			mapDelete(this.collections, modelName);
			if (collection) {
				let revisionOffset = 0;
				for (const [id] of MAP_ENTRIES.call(collection)) {
					this.recordRowRevision(modelName, id, firstRevision + revisionOffset++, false);
				}
			}
		} else {
			const removedCollections: Array<readonly [string, Map<string, any>]> = [];
			let removedCount = 0;
			for (const [name, collection] of MAP_ENTRIES.call(this.collections)) {
				removedCollections[removedCollections.length] = [name, collection];
				removedCount += MAP_SIZE.call(collection);
			}
			const firstRevision = removedCount === 0 ? 0 : this.reserveRowRevisions(removedCount);
			MAP_CLEAR.call(this.collections);
			let revisionOffset = 0;
			for (const [name, collection] of removedCollections) {
				for (const [id] of MAP_ENTRIES.call(collection)) {
					this.recordRowRevision(name, id, firstRevision + revisionOffset++, false);
				}
			}
		}
		this.resetStats();
	}

	resetStats() {
		this.stats.get = 0;
		this.stats.getMany = 0;
		this.stats.query = 0;
		this.stats.aggregate = 0;
		this.stats.create = 0;
		this.stats.update = 0;
		this.stats.delete = 0;
	}

	schema = {
			plan: async (models: ResolvedModelMeta[]): Promise<SchemaPlan> => {
				const safeModels = normalizeSchemaModels(models, 'memory store schema models');
				assertNoMemoryUniqueIndexes(safeModels);
				const changes: SchemaPlan['changes'] = [];
				for (let index = 0; index < safeModels.length; index++) {
					const model = safeModels[index];
					if (!mapHas(this.collections, model.name)) {
						changes[changes.length] = { type: 'create-collection', target: model.name };
					}
				}
				return {
					adapter: this.kind,
					changes
				};
			},
		apply: async (models: ResolvedModelMeta[], options?: unknown): Promise<SchemaPlan> => {
			normalizeStoreSchemaApplyOptions(options, 'memory store schema apply options');
			const safeModels = normalizeSchemaModels(models, 'memory store schema models');
			const plan = await this.schema.plan(safeModels);
			for (const model of safeModels) this.collection(model.name);
			return plan;
		}
	};

	private collection(name: string) {
		name = assertSafeSchemaIdentifier(name, 'memory collection name');
		let collection = mapGet(this.collections, name);
		if (!collection) {
			collection = new Map();
			mapSet(this.collections, name, collection);
		}
		return collection;
	}

	private existingCollection(name: string) {
		name = assertSafeSchemaIdentifier(name, 'memory collection name');
		return mapGet(this.collections, name) ?? new Map<string, any>();
	}

	private filtered(model: ResolvedModelMeta, plan: Pick<QueryPlan, 'where' | 'or'>) {
		return filterRows(
			iterableToArray(MAP_VALUES.call(this.existingCollection(model.name))),
			stripFieldCodecQueryOperandMarker(plan),
			model.idField
		);
	}

	private cloneCollections() {
		const next = new Map<string, Map<string, any>>();
		for (const [name, collection] of MAP_ENTRIES.call(this.collections)) {
			const cloned = new Map<string, any>();
			for (const [id, value] of MAP_ENTRIES.call(collection)) {
				mapSet(cloned, id, cloneSafeDataObject(value, `${name} stored row`));
			}
			mapSet(next, name, cloned);
		}
		return next;
	}

	private replaceCollections(next: Map<string, Map<string, any>>) {
		MAP_CLEAR.call(this.collections);
		for (const [name, collection] of MAP_ENTRIES.call(next)) mapSet(this.collections, name, collection);
	}

	private reserveRowRevisions(count: number) {
		if (
			!NUMBER_IS_SAFE_INTEGER(this.rowRevisionGeneration) ||
			this.rowRevisionGeneration < 0 ||
			!NUMBER_IS_SAFE_INTEGER(count) ||
			count <= 0 ||
			this.rowRevisionGeneration > MAX_ROW_REVISION - count
		) {
			throw new ActiveTsConfigurationError('memory store row revision counter is exhausted.');
		}
		const firstRevision = this.rowRevisionGeneration + 1;
		this.rowRevisionGeneration += count;
		return firstRevision;
	}

	private recordRowRevision(name: string, id: string, revision: number, rowExists: boolean) {
		let revisions = mapGet(this.rowRevisions, name);
		if (!revisions) {
			revisions = new Map();
			mapSet(this.rowRevisions, name, revisions);
		}
		mapSet(revisions, id, revision);
		let tombstones = mapGet(this.rowRevisionTombstones, name);
		if (rowExists) {
			if (tombstones && mapDelete(tombstones, id) && MAP_SIZE.call(tombstones) === 0) {
				mapDelete(this.rowRevisionTombstones, name);
			}
			return;
		}
		if (this.hasSnapshotBefore(revision)) {
			if (!tombstones) {
				tombstones = new Map();
				mapSet(this.rowRevisionTombstones, name, tombstones);
			}
			mapSet(tombstones, id, revision);
		} else {
			mapDelete(revisions, id);
			if (MAP_SIZE.call(revisions) === 0) mapDelete(this.rowRevisions, name);
			if (tombstones && mapDelete(tombstones, id) && MAP_SIZE.call(tombstones) === 0) {
				mapDelete(this.rowRevisionTombstones, name);
			}
		}
	}

	private beginTransactionSnapshot() {
		const snapshot = this.rowRevisionGeneration;
		const count = mapGet(this.activeTransactionSnapshots, snapshot) ?? 0;
		mapSet(this.activeTransactionSnapshots, snapshot, count + 1);
		return snapshot;
	}

	private releaseTransactionSnapshot(snapshot: number) {
		const count = mapGet(this.activeTransactionSnapshots, snapshot);
		if (count === 1) mapDelete(this.activeTransactionSnapshots, snapshot);
		else if (count !== undefined) mapSet(this.activeTransactionSnapshots, snapshot, count - 1);
		this.compactRowRevisionTombstones();
	}

	private hasSnapshotBefore(revision: number) {
		for (const [snapshot] of MAP_ENTRIES.call(this.activeTransactionSnapshots)) {
			if (snapshot < revision) return true;
		}
		return false;
	}

	private compactRowRevisionTombstones() {
		let oldestSnapshot: number | undefined;
		for (const [snapshot] of MAP_ENTRIES.call(this.activeTransactionSnapshots)) {
			if (oldestSnapshot === undefined || snapshot < oldestSnapshot) oldestSnapshot = snapshot;
		}
		for (const [name, tombstones] of MAP_ENTRIES.call(this.rowRevisionTombstones)) {
			const revisions = mapGet(this.rowRevisions, name);
			for (const [id, revision] of MAP_ENTRIES.call(tombstones)) {
				if (oldestSnapshot === undefined || revision <= oldestSnapshot) {
					if (revisions && mapGet(revisions, id) === revision) mapDelete(revisions, id);
					mapDelete(tombstones, id);
				}
			}
			if (revisions && MAP_SIZE.call(revisions) === 0) mapDelete(this.rowRevisions, name);
			if (MAP_SIZE.call(tombstones) === 0) mapDelete(this.rowRevisionTombstones, name);
		}
	}

	private applyDirty(
		dirty: Map<string, Map<string, DirtyChange>>,
		pointReads: PointReadSet,
		revisionSnapshot: number
	) {
		for (const [name, changes] of MAP_ENTRIES.call(dirty)) {
			const collection = mapGet(this.collections, name);
			for (const [id, change] of MAP_ENTRIES.call(changes)) {
				const exists = collection !== undefined && mapHas(collection, id);
				if (change.operation === 'create' && exists) {
					throw new ActiveTsConflictError(`Cannot create ${name}:${id} because it already exists.`);
				}
				if (change.operation === 'update' && !exists) {
					throw new ActiveTsNotFoundError(`Cannot update ${name}:${id} because it does not exist.`);
				}
				if ((change.operation === 'update' || change.operation === 'delete') && change.expectedVersion !== undefined) {
					const current = collection === undefined ? undefined : mapGet(collection, id);
					if (change.operation === 'delete' && current === undefined) {
						throw new ActiveTsNotFoundError(`Cannot delete ${name}:${id} because it does not exist.`);
					}
					if (!memoryVersionMatches(current, change.expectedVersion)) {
						throw new ActiveTsConflictError(
							`Optimistic lock failed for ${name}:${id}. Expected version ${change.expectedVersion}.`
						);
					}
				}
			}
		}
		for (const [name, reads] of MAP_ENTRIES.call(pointReads)) {
			const currentRevisions = mapGet(this.rowRevisions, name);
			for (const [id] of MAP_ENTRIES.call(reads)) {
				const currentRevision = currentRevisions === undefined ? undefined : mapGet(currentRevisions, id);
				if (currentRevision !== undefined && currentRevision > revisionSnapshot) {
					throw new ActiveTsConflictError(
						`Transaction conflict for ${name}:${id} because it changed after a transactional point read.`
					);
				}
			}
		}
		let mutationCount = 0;
		for (const [name, changes] of MAP_ENTRIES.call(dirty)) {
			const collection = mapGet(this.collections, name);
			for (const [id, change] of MAP_ENTRIES.call(changes)) {
				if (change.operation !== 'delete' || (collection !== undefined && mapHas(collection, id))) {
					mutationCount++;
				}
			}
		}
		const firstRevision = mutationCount === 0 ? 0 : this.reserveRowRevisions(mutationCount);
		let revisionOffset = 0;
		for (const [name, changes] of MAP_ENTRIES.call(dirty)) {
			for (const [id, change] of MAP_ENTRIES.call(changes)) {
				if (change.operation === 'delete') {
					const collection = mapGet(this.collections, name);
					if (collection !== undefined && mapHas(collection, id)) {
						mapDelete(collection, id);
						this.recordRowRevision(name, id, firstRevision + revisionOffset++, false);
					}
				} else {
					const collection = this.collection(name);
					mapSet(collection, id, cloneSafeDataObject(change.value, `${name} stored row`));
					this.recordRowRevision(name, id, firstRevision + revisionOffset++, true);
				}
			}
		}
	}

	private mergeStats(stats: MemoryStoreAdapter['stats']) {
		this.stats.get += stats.get;
		this.stats.getMany += stats.getMany;
		this.stats.query += stats.query;
		this.stats.aggregate += stats.aggregate;
		this.stats.create += stats.create;
		this.stats.update += stats.update;
		this.stats.delete += stats.delete;
	}
}

function sortMemoryRows(rows: any[], sort: ReturnType<typeof sortWithStableId>) {
	const sorted: any[] = [];
	for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
		const row = rows[rowIndex];
		let insertAt = sorted.length;
		for (let sortedIndex = 0; sortedIndex < sorted.length; sortedIndex++) {
			if (compareRowsBySort(row, sorted[sortedIndex], sort) < 0) {
				insertAt = sortedIndex;
				break;
			}
		}
		for (let shift = sorted.length; shift > insertAt; shift--) {
			sorted[shift] = sorted[shift - 1];
		}
		sorted[insertAt] = row;
	}
	return sorted;
}

function copyRows(rows: any[], start: number, end: number) {
	const result: any[] = [];
	for (let index = start; index < end && index < rows.length; index++) {
		result[result.length] = rows[index];
	}
	return result;
}

function assertNoMemoryUniqueIndexes(models: ResolvedModelMeta[]) {
	for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
		const model = models[modelIndex];
		for (let indexIndex = 0; indexIndex < model.indexes.length; indexIndex++) {
			const index = model.indexes[indexIndex];
			if (index.unique !== true) continue;
			throw new ActiveTsConfigurationError(
				`Memory store adapter does not support unique indexes. Unsupported index "${index.name}" on "${model.name}".`
			);
		}
	}
}

function memoryVersionMatches(current: any, expectedVersion: number) {
	return (
		!!current &&
		Object.prototype.hasOwnProperty.call(current, 'version') &&
		current.version === expectedVersion
	);
}
