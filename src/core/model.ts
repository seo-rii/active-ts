import { isDeepStrictEqual } from 'node:util';
import { snapshotArrayInput } from './array-input.js';
import { ActiveContext, getDefaultContext } from './context.js';
import { ActiveTsCommittedWriteError, ActiveTsConfigurationError, ActiveTsValidationError, safeErrorMessage } from './errors.js';
import { LazyRef } from './lazy-ref.js';
import { isPartialModel } from './partial-model.js';
import { entityIdKey, valueFor } from './query-utils.js';
import {
	snapshotRelationOwnerLocalKey,
	snapshotRelationResult,
	validateRelationOwnerLocalKeySnapshot,
	validateRelationResultSnapshot
} from './relation-result.js';
import { FindBuilder, normalizeIncludeSpecs, QueryBuilder, SearchBuilder } from './query.js';
import type { AggregateComparableValue, AggregateFieldConstraint } from './query.js';
import {
	ACTIVE_TS_ENTITY_KEY,
	assertPlainDataObject,
	assertSafeEntityId,
	assertSafeFieldPath,
	assertSafeTopLevelField,
	cloneSafeData,
	cloneSafeDataObject,
	defineDataProperty
} from './safe-keys.js';
import {
	ACTIVE_TS_MODEL_INSTANCE,
	datastoreHistoricalModelReadTime,
	MODEL_DATASTORE_WRITE_ANCESTOR,
	MODEL_PERSISTED_TOKEN,
	trackTransactionModel,
	type ModelConstructorOptions
} from './model-internal.js';
import { BOUND_CONTEXT, SOURCE_MODEL, staticMarkerValue } from './model-markers.js';
import { storeCapability } from './capabilities.js';
import { MAP_CLEAR, MAP_ENTRIES, MAP_GET, MAP_SET, SET_ADD, SET_HAS } from './collection-intrinsics.js';
import {
	assertContextTransactionWritable,
	contextInternalStore,
	markContextTransactionRollbackOnly,
	runTrackedContextOperation
} from './context-internal.js';
import {
	datastoreAncestorFromEntityKey,
	datastoreKeyIdentity,
	datastoreKeyWithNamespace,
	datastoreScopedAncestorMatches
} from './datastore-key.js';
import type {
	ActiveTsHookPayload,
	EntityId,
	DatastoreKey,
	IncludeSpec,
	ModelConstructor,
	ModelTransactionOptions,
	RelationMeta,
	ResolvedModelMeta,
	StoreAdapter,
	StoreWriteOptions,
	WhereShape
} from './types.js';

const SAFE_PROMISE_REJECT = Promise.reject.bind(Promise);

function mapGet<TKey, TValue>(map: Map<TKey, TValue>, key: TKey) {
	return MAP_GET.call(map, key) as TValue | undefined;
}

function mapSet<TKey, TValue>(map: Map<TKey, TValue>, key: TKey, value: TValue) {
	MAP_SET.call(map, key, value);
}

export type ModelUpsertResult<TModel extends Model = Model> = {
	operation: 'create' | 'update';
	item: TModel;
};

type PreparedModelCreate<TModel extends Model> = {
	context: ActiveContext;
	meta: ResolvedModelMeta;
	store: StoreAdapter;
	id: EntityId;
	data: Record<string, any>;
	committedData: Record<string, any>;
	encodedData: Record<string, any>;
	writeOptions: StoreWriteOptions;
	item: TModel;
};

type PreparedModelUpdate = {
	context: ActiveContext;
	meta: ResolvedModelMeta;
	store: StoreAdapter;
	id: EntityId;
	data: Record<string, any>;
	committedData: Record<string, any>;
	encodedData: Record<string, any>;
	writeOptions: StoreWriteOptions;
};

type PreparedStaticDelete = {
	context: ActiveContext;
	meta: ResolvedModelMeta;
	store: StoreAdapter;
	id: EntityId;
	writeOptions?: StoreWriteOptions;
};

export abstract class Model<TData extends Record<string, any> = Record<string, any>> {
	readonly data: TData;
	protected readonly context: ActiveContext;
	private persistedId?: EntityId;
	private [MODEL_DATASTORE_WRITE_ANCESTOR]?: DatastoreKey;
	private readonly plannedRelations = new Set<string>();
	private readonly relationCache = new Map<string, LazyRef<any>>();

	constructor(data: TData, context?: ActiveContext, options: ModelConstructorOptions = {}) {
		if (context !== undefined && !(context instanceof ActiveContext)) {
			throw new ActiveTsConfigurationError('Model constructor context must be an ActiveContext.');
		}
		options = normalizeModelConstructorOptions(options);
		defineDataProperty(this, ACTIVE_TS_MODEL_INSTANCE, true, { enumerable: false, configurable: false });
		this.context = (context ?? contextFor(this.constructor as ModelConstructor)).transactionScopedContext('construct models');
		this.data = data;
		const meta = this.context.meta(this.constructor as ModelConstructor);
		this.persistedId = options.persisted ? valueFor(data, meta.idField) as EntityId | undefined : undefined;
		if (options.persisted && this.persistedId !== undefined && meta.datastore?.ancestor) {
			const descriptor = Object.getOwnPropertyDescriptor(data, ACTIVE_TS_ENTITY_KEY);
			if (descriptor !== undefined) {
				if (!('value' in descriptor)) {
					throw new ActiveTsValidationError(`${meta.name} active-ts entity key must be a data property.`);
				}
				if (descriptor.enumerable) {
					throw new ActiveTsValidationError(`${meta.name} active-ts entity key must be non-enumerable.`);
				}
				const ancestor = datastoreAncestorFromEntityKey(
					descriptor.value,
					meta.name,
					this.persistedId,
					`${meta.name} active-ts entity key`
				);
				if (ancestor !== undefined) this[MODEL_DATASTORE_WRITE_ANCESTOR] = ancestor;
			}
		}
		if (options.persisted) {
			trackTransactionModel(this.context, this);
		}
	}

	get id() {
		const meta = this.context.meta(this.constructor as ModelConstructor);
		return valueFor(this.data, meta.idField) as EntityId | undefined;
	}

	static use(context: ActiveContext): typeof this {
		if (!(context instanceof ActiveContext)) {
			throw new ActiveTsConfigurationError('Model.use context must be an ActiveContext.');
		}
		const source = staticMarkerValue(this, SOURCE_MODEL);
		if (source !== undefined && typeof source !== 'function') {
			throw new ActiveTsConfigurationError('Model source marker must be a model constructor.');
		}
		const Base = (source ?? this) as any;
		class BoundModel extends Base {
			static [BOUND_CONTEXT] = context;
			static [SOURCE_MODEL] = Base;

			constructor(data: any, explicitContext?: ActiveContext, options: ModelConstructorOptions = {}) {
				super(data, explicitContext ?? context, options);
			}
		}
		defineDataProperty(BoundModel, 'name', staticFunctionNameValue(Base));
		const modelName = staticModelNameValue(Base);
		if (modelName !== undefined) {
			defineDataProperty(BoundModel, 'modelName', modelName, { enumerable: false, configurable: true, writable: true });
		}
		return BoundModel as unknown as typeof this;
	}

	static transaction<TModel extends Model, TResult>(
		this: ModelConstructor<TModel>,
		fn: (context: ActiveContext) => Promise<TResult>,
		options: ModelTransactionOptions = {}
	): Promise<TResult> {
		try {
			const context = contextFor(this);
			const meta = context.meta(this);
			if (options === undefined) return context.transaction(fn, { store: meta.store });
			if (!options || typeof options !== 'object' || Array.isArray(options)) {
				return context.transaction(fn, options as any);
			}
			const txOptions = { store: meta.store } as Record<string, unknown>;
			const optionRecord = options as Record<string, unknown>;
			if (Object.getOwnPropertySymbols(optionRecord).length) return context.transaction(fn, options as any);
			for (const key of Object.getOwnPropertyNames(optionRecord)) {
				const descriptor = Object.getOwnPropertyDescriptor(optionRecord, key);
				if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
					return context.transaction(fn, options as any);
				}
				if (key === 'store') {
					throw new ActiveTsConfigurationError('Model.transaction options cannot include store.');
				}
				defineDataProperty(txOptions, key, descriptor.value, {
					enumerable: true,
					configurable: true,
					writable: true
				});
			}
			return context.transaction(fn, txOptions as any);
		} catch (error) {
			return SAFE_PROMISE_REJECT(error);
		}
	}

	static find<TModel extends Model>(this: ModelConstructor<TModel>, id: EntityId) {
		return new FindBuilder<TModel>(contextFor(this), this, id);
	}

	static query<TModel extends Model>(this: ModelConstructor<TModel>) {
		return new QueryBuilder<TModel>(contextFor(this), this);
	}

	static where<TModel extends Model>(this: ModelConstructor<TModel>, shape: WhereShape<TModel['data']>) {
		return new QueryBuilder<TModel>(contextFor(this), this).where(shape);
	}

	static scope<TModel extends Model>(this: ModelConstructor<TModel>, name: string, viewer?: unknown, args?: unknown) {
		return new QueryBuilder<TModel>(contextFor(this), this).scope(name, viewer, args);
	}

	static ancestor<TModel extends Model>(this: ModelConstructor<TModel>, key: DatastoreKey) {
		return new QueryBuilder<TModel>(contextFor(this), this).ancestor(key);
	}

	static under<TModel extends Model>(this: ModelConstructor<TModel>, key: DatastoreKey) {
		return new QueryBuilder<TModel>(contextFor(this), this).under(key);
	}

	static withDeleted<TModel extends Model>(this: ModelConstructor<TModel>) {
		return new QueryBuilder<TModel>(contextFor(this), this).withDeleted();
	}

	static onlyDeleted<TModel extends Model>(this: ModelConstructor<TModel>) {
		return new QueryBuilder<TModel>(contextFor(this), this).onlyDeleted();
	}

	static count<TModel extends Model>(this: ModelConstructor<TModel>) {
		return new QueryBuilder<TModel>(contextFor(this), this).count();
	}

	static sum<TModel extends Model, TField extends string>(
		this: ModelConstructor<TModel>,
		field: TField & AggregateFieldConstraint<TModel['data'], TField, number>
	): Promise<number> {
		return new QueryBuilder<TModel>(contextFor(this), this).sum(field as any);
	}

	static avg<TModel extends Model, TField extends string>(
		this: ModelConstructor<TModel>,
		field: TField & AggregateFieldConstraint<TModel['data'], TField, number>
	): Promise<number | null> {
		return new QueryBuilder<TModel>(contextFor(this), this).avg(field as any);
	}

	static min<TModel extends Model, TField extends string>(
		this: ModelConstructor<TModel>,
		field: TField & AggregateFieldConstraint<TModel['data'], TField, AggregateComparableValue>
	): Promise<TField extends keyof TModel['data'] ? TModel['data'][TField] | null : unknown> {
		return new QueryBuilder<TModel>(contextFor(this), this).min(field as any);
	}

	static max<TModel extends Model, TField extends string>(
		this: ModelConstructor<TModel>,
		field: TField & AggregateFieldConstraint<TModel['data'], TField, AggregateComparableValue>
	): Promise<TField extends keyof TModel['data'] ? TModel['data'][TField] | null : unknown> {
		return new QueryBuilder<TModel>(contextFor(this), this).max(field as any);
	}

	static search<TModel extends Model>(this: ModelConstructor<TModel>, text: string) {
		return new SearchBuilder<TModel>(contextFor(this), this, text);
	}

	include(...relations: IncludeSpec[]) {
		return runTrackedContextOperation(
			() => this.context.transactionScopedContext('include relations'),
			async (context) => {
				this.assertFullModel('include relations');
				const meta = context.meta(this.constructor as ModelConstructor);
				const expectedId = valueFor(this.data, meta.idField);
				if (expectedId === undefined || expectedId === null) {
					throw new ActiveTsValidationError(`include target is missing id field "${meta.idField}".`);
				}
				assertSafeEntityId(expectedId, `${meta.name}.${meta.idField}`);
				const expectedDatastoreAncestor = this[MODEL_DATASTORE_WRITE_ANCESTOR] ?? (
					meta.datastore?.ancestor ? meta.datastore.ancestor({ model: meta, id: expectedId, data: this.data }) : undefined
				);
				const grouped = new Map<string, string[]>();
				for (const path of normalizeIncludeSpecs(relations)) {
					const segments = path.split('.');
					let relation: string | undefined;
					const nested: string[] = [];
					for (let index = 0; index < segments.length; index++) {
						const segment = segments[index];
						if (!segment) continue;
						if (relation === undefined) {
							relation = segment;
						} else {
							nested[nested.length] = segment;
						}
					}
					if (!relation) continue;
					SET_ADD.call(this.plannedRelations, relation);
					const paths = mapGet(grouped, relation) ?? [];
					if (nested.length) paths.push(nested.join('.'));
					mapSet(grouped, relation, paths);
				}
				for (const [relation, nested] of MAP_ENTRIES.call(grouped)) {
					const ref = this.ref(relation);
					try {
						ref.markPlanned();
						await context.runHooks('beforeRelationLoad', {
							model: meta,
							target: this,
							operation: 'relation',
							meta: { relation }
						});
						context.validateModelInstance(meta, this as any, `beforeRelationLoad ${meta.name}.${relation} target`, {
							expectedId,
							expectedDatastoreAncestor,
							partial: false
						});
						const relationMeta = mapGet(meta.relations, relation);
						if (!relationMeta) {
							throw new ActiveTsConfigurationError(`Relation "${relation}" is not registered on ${meta.name}.`);
						}
						const ownerLocalKeySnapshot = snapshotRelationOwnerLocalKey(
							context,
							meta,
							this,
							relationMeta,
							`beforeRelationLoad ${meta.name}.${relation} target`
						);
						let result = await ref.load({ full: nested.length > 0, hooks: false });
						const resultSnapshot = snapshotRelationResult(
							context,
							relationMeta,
							result,
							`afterRelationLoad ${meta.name}.${relation}`
						);
						if (nested.length && result) {
							if (Array.isArray(result)) {
								const tasks: Array<Promise<unknown>> = [];
								for (let index = 0; index < result.length; index++) {
									tasks[index] = result[index].include(...nested);
								}
								await Promise.all(tasks);
							} else {
								await (result as any).include(...nested);
							}
						}
						const after = await context.runHooks('afterRelationLoad', {
							model: meta,
							target: this,
							result,
							operation: 'relation',
							meta: { relation }
						});
						result = after.result as any;
						context.validateModelInstance(meta, this as any, `afterRelationLoad ${meta.name}.${relation} target`, {
							expectedId,
							expectedDatastoreAncestor,
							partial: false
						});
						validateRelationOwnerLocalKeySnapshot(
							context,
							ownerLocalKeySnapshot,
							this,
							`afterRelationLoad ${meta.name}.${relation} target`
						);
						validateRelationResultSnapshot(
							context,
							resultSnapshot,
							result,
							`afterRelationLoad ${meta.name}.${relation}`
						);
						ref.prime(result, { full: nested.length > 0 });
					} catch (error) {
						ref.clear();
						throw error;
					}
				}
				context.validateModelInstance(meta, this as any, 'include result', {
					expectedId,
					expectedDatastoreAncestor,
					partial: false
				});
				return this;
			}
		);
	}

	ref<TModel = any>(name: string) {
		this.assertFullModel('load relations');
		const context = this.context.transactionScopedContext('load relations');
		const safeName = assertSafeTopLevelField(name, 'relation name');
		let cached = mapGet(this.relationCache, safeName);
		if (cached) {
			if (SET_HAS.call(this.plannedRelations, safeName)) cached.markPlanned();
			return cached as LazyRef<TModel>;
		}
		const meta = context.meta(this.constructor as ModelConstructor);
		const relation = mapGet(meta.relations, safeName);
		if (!relation) throw new ActiveTsConfigurationError(`Relation "${safeName}" is not registered on ${meta.name}.`);
		cached = new LazyRef<TModel>(
			context,
			this,
			relation,
			SET_HAS.call(this.plannedRelations, safeName) || relation.warnOnLazy === false
		);
		mapSet(this.relationCache, safeName, cached);
		return cached as LazyRef<TModel>;
	}

	view<TView = unknown>(name = 'default', viewer?: unknown) {
		return runTrackedContextOperation(
			() => this.context.transactionScopedContext('resolve views'),
			async (context) => {
				this.assertFullModel('resolve views');
				const meta = context.meta(this.constructor as ModelConstructor);
				const safeName = assertSafeFieldPath(name, 'view name');
				const resolver = mapGet(meta.views, safeName);
				if (!resolver) throw new ActiveTsConfigurationError(`View "${safeName}" is not registered on ${meta.name}.`);
				return (await resolver({
					context,
					model: this,
					data: this.data,
					viewer,
					name: safeName
				})) as TView;
			}
		);
	}

	can(policy: string, viewer?: unknown) {
		return runTrackedContextOperation(
			() => this.context.transactionScopedContext('evaluate policies'),
			async (context) => {
				this.assertFullModel('evaluate policies');
				const meta = context.meta(this.constructor as ModelConstructor);
				const safePolicy = assertSafeFieldPath(policy, 'policy name');
				const resolver = mapGet(meta.policies, safePolicy);
				if (!resolver) throw new ActiveTsConfigurationError(`Policy "${safePolicy}" is not registered on ${meta.name}.`);
				return await resolver({
					context,
					model: this,
					data: this.data,
					viewer,
					policy: safePolicy
				});
			}
		);
	}

	save() {
		return runTrackedContextOperation(
			() => this.context.transactionScopedContext('save'),
			async (context) => {
				const prepared = await this.prepareSave(context);
				await this.writePreparedSave(prepared);
				await this.finishPreparedSave(prepared);
				return this;
			}
		);
	}

	private async prepareSave(context: ActiveContext): Promise<PreparedModelUpdate> {
		this.assertFullModel('save');
		const meta = context.meta(this.constructor as ModelConstructor);
		assertModelSnapshotWritable(this, meta.name, 'save');
		const id = this.persistedId;
		if (id === undefined || id === null) {
			if (this.id !== undefined && this.id !== null) {
				throw new ActiveTsConfigurationError(
					`Cannot save ${meta.name} instance that was not loaded or created by active-ts. Use create() or update() for writes.`
				);
			}
			throw new ActiveTsValidationError(`Cannot save ${meta.name} without id field "${meta.idField}".`);
		}
		assertContextTransactionWritable(context, `save ${meta.name}`);
		trackTransactionModel(context, this);
		const safeData = cloneSafeDataObject(this.data, `${meta.name} update data`);
		const originalVersion = typeof safeData.version === 'number' ? safeData.version : undefined;
		const before = await context.runHooks('beforeUpdate', {
			model: meta,
			target: this,
			id,
			data: safeData,
			operation: 'update'
		});
		const data = await context.prepareWrite(meta, before.data, 'update', this);
		assertEntityIdUnchanged(meta.name, meta.idField, id, data[meta.idField]);
		const store = contextInternalStore(context, meta.store);
		const preparedVersion = typeof data.version === 'number' ? data.version : undefined;
		if (originalVersion !== undefined && preparedVersion !== originalVersion) {
			throw new ActiveTsValidationError(
				`Cannot change version field on ${meta.name} during save hooks or validation.`
			);
		}
		const expectedVersion = originalVersion ?? preparedVersion;
		if (expectedVersion !== undefined) {
			if (!storeCapability(store.capabilities, 'optimisticLock')) {
				throw new ActiveTsConfigurationError(
					`Store adapter "${store.kind}" does not support atomic optimistic locking.`
				);
			}
			const nextVersion = expectedVersion + 1;
			if (!Number.isSafeInteger(nextVersion)) {
				throw new ActiveTsValidationError(
					`Cannot increment version field on ${meta.name}; the next version must be a safe integer.`
				);
			}
			data.version = nextVersion;
		}
		assertReplaceableDataTarget(this.data, data, `${meta.name} model data`, true);
		assertDatastoreWriteMatchesScopedAncestor(
			meta,
			id,
			data,
			this[MODEL_DATASTORE_WRITE_ANCESTOR],
			`${meta.name}.save()`
		);
		const encodedData = context.encodeWrite(meta, data);
		const writeOptions = datastoreWriteOptions(
			meta,
			id,
			data,
			expectedVersion,
			this[MODEL_DATASTORE_WRITE_ANCESTOR]
		);
		return {
			context,
			meta,
			store,
			id,
			data,
			committedData: cloneSafeDataObject(data, `${meta.name} committed update data`),
			encodedData,
			writeOptions
		};
	}

	private async writePreparedSave(prepared: PreparedModelUpdate) {
		assertReplaceableDataTarget(this.data, prepared.data, `${prepared.meta.name} model data`, true);
		await prepared.store.update(
			prepared.meta,
			prepared.id,
			prepared.encodedData,
			prepared.writeOptions
		);
		replaceData(this.data, prepared.data);
		this.persistedId = prepared.id;
		MAP_CLEAR.call(this.relationCache);
	}

	private async finishPreparedSave(prepared: PreparedModelUpdate) {
		await afterStoreWrite(prepared.context, prepared.meta.name, 'update', prepared.id, async () => {
			await runCommittedWriteBoundaryEffects(prepared.context, prepared.meta, prepared.id, {
				model: prepared.meta,
				target: this,
				id: prepared.id,
				data: prepared.data,
				result: this,
				operation: 'update'
			});
			await prepared.context.runHooks('afterUpdate', {
				model: prepared.meta,
				target: this,
				id: prepared.id,
				data: prepared.data,
				result: this,
				operation: 'update'
			});
			assertPostWriteModelDataUnchanged(
				prepared.context,
				prepared.meta,
				this,
				prepared.committedData,
				'afterUpdate target',
				prepared.id
			);
		});
	}

	delete() {
		return runTrackedContextOperation(
			() => this.context.transactionScopedContext('delete'),
			async (context) => {
				this.assertFullModel('delete');
				const meta = context.meta(this.constructor as ModelConstructor);
				assertModelSnapshotWritable(this, meta.name, 'delete');
				const id = this.persistedId;
				if (id === undefined || id === null) {
					throw new ActiveTsConfigurationError(
						`Cannot delete ${meta.name} instance that was not loaded or created by active-ts. Use static delete() for id-based deletes.`
					);
				}
				assertContextTransactionWritable(context, `delete ${meta.name}`);
				trackTransactionModel(context, this);
				const safeData = cloneSafeDataObject(this.data, `${meta.name} delete data`);
				const currentId = valueFor(safeData, meta.idField);
				if (currentId === undefined || currentId === null) {
					throw new ActiveTsValidationError(`${meta.name} delete data is missing id field "${meta.idField}".`);
				}
				assertSafeEntityId(currentId, `${meta.name}.${meta.idField}`);
				if (entityIdKey(currentId) !== entityIdKey(id)) {
					throw new ActiveTsValidationError(`${meta.name} delete data id field "${meta.idField}" must match the loaded id.`);
				}
				const store = contextInternalStore(context, meta.store);
				const expectedVersion = typeof safeData.version === 'number' ? safeData.version : undefined;
				if (expectedVersion !== undefined && store.capabilities?.optimisticLock !== true) {
					throw new ActiveTsConfigurationError(
						`Store adapter "${store.kind}" does not support atomic optimistic locking.`
					);
				}
				await context.runHooks('beforeDelete', {
					model: meta,
					target: this,
					id,
					data: safeData,
					operation: 'delete'
				});
				assertDatastoreWriteMatchesScopedAncestor(meta, id, safeData, this[MODEL_DATASTORE_WRITE_ANCESTOR], `${meta.name}.delete()`);
				await store.delete(
					meta,
					id,
					datastoreWriteOptions(meta, id, safeData, expectedVersion, this[MODEL_DATASTORE_WRITE_ANCESTOR])
				);
				this.persistedId = undefined;
				MAP_CLEAR.call(this.relationCache);
				await afterStoreWrite(context, meta.name, 'delete', id, async () => {
					await runCommittedWriteBoundaryEffects(context, meta, id, {
						model: meta,
						target: this,
						id,
						data: safeData,
						operation: 'delete'
					});
					await context.runHooks('afterDelete', {
						model: meta,
						target: this,
						id,
						data: safeData,
						operation: 'delete'
					});
				});
			}
		);
	}

	protected assertFullModel(operation: string) {
		if (!isPartialModel(this)) return;
		const meta = this.context.meta(this.constructor as ModelConstructor);
		throw new ActiveTsConfigurationError(
			`Cannot ${operation} on partial ${meta.name} instance loaded with select(). Load the full model first.`
		);
	}

	static create<TModel extends Model>(
		this: ModelConstructor<TModel>,
		data: TModel['data'],
		context?: ActiveContext
	) {
		return runTrackedContextOperation(
			() => explicitContextFor(this, context, 'create'),
			async (resolvedContext) => {
				const prepared = await prepareModelCreate(this, data, resolvedContext, 'create data');
				await writePreparedModelCreate(prepared);
				await finishPreparedModelCreate(prepared);
				return prepared.item;
			}
		);
	}

	static createMany<TModel extends Model>(
		this: ModelConstructor<TModel>,
		data: readonly TModel['data'][],
		context?: ActiveContext
	): Promise<TModel[]> {
		return runTrackedContextOperation(
			() => explicitContextFor(this, context, 'createMany'),
			async (resolvedContext) => {
				const meta = resolvedContext.meta(this);
				const rows = snapshotModelDataArray<TModel['data']>(data, `${meta.name} createMany data`);
				if (!rows.length) return [];
				return await runModelBulkTransaction(resolvedContext, meta, async (transactionContext) => {
					assertContextTransactionWritable(transactionContext, `createMany ${meta.name}`);
					const prepared: Array<PreparedModelCreate<TModel>> = [];
					for (let index = 0; index < rows.length; index++) {
						prepared[index] = await prepareModelCreate(
							this,
							rows[index],
							transactionContext,
							`createMany data[${index}]`
						);
					}
					const identities = new Set<string>();
					for (let index = 0; index < prepared.length; index++) {
						const identity = preparedCreateIdentity(prepared[index]);
						if (SET_HAS.call(identities, identity)) {
							throw new ActiveTsValidationError(
								`${meta.name} createMany data resolves multiple rows to the same entity identity "${String(prepared[index].id)}".`
							);
						}
						SET_ADD.call(identities, identity);
					}
					for (let index = 0; index < prepared.length; index++) {
						await writePreparedModelCreate(prepared[index], true);
					}
					const items: TModel[] = [];
					for (let index = 0; index < prepared.length; index++) {
						await finishPreparedModelCreate(prepared[index]);
						items[index] = prepared[index].item;
					}
					return items;
				});
			}
		);
	}

	static upsertMany<TModel extends Model>(
		this: ModelConstructor<TModel>,
		data: readonly TModel['data'][],
		context?: ActiveContext
	): Promise<Array<ModelUpsertResult<TModel>>> {
		return runTrackedContextOperation(
			() => explicitContextFor(this, context, 'upsertMany'),
			async (resolvedContext) => {
				const meta = resolvedContext.meta(this);
				const rows = snapshotModelDataArray<TModel['data']>(data, `${meta.name} upsertMany data`);
				const ids: EntityId[] = [];
				for (let index = 0; index < rows.length; index++) {
					const id = valueFor(rows[index], meta.idField);
					if (id === undefined || id === null) {
						throw new ActiveTsValidationError(
							`${meta.name} upsertMany data[${index}] is missing id field "${meta.idField}".`
						);
					}
					assertSafeEntityId(id, `${meta.name} upsertMany data[${index}].${meta.idField}`);
					ids[index] = id;
				}
				assertUniqueEntityIds(ids, `${meta.name} upsertMany data`);
				if (!rows.length) return [];
				if (meta.datastore?.ancestor) {
					throw new ActiveTsConfigurationError(
						`Datastore model "${meta.name}" declares an ancestor resolver, so direct id reads require an ancestor-aware query.`
					);
				}
				return await runModelBulkTransaction(resolvedContext, meta, async (transactionContext) => {
					assertContextTransactionWritable(transactionContext, `upsertMany ${meta.name}`);
					const loaded = await transactionContext.loadManyNow(this, ids);
					const prepared: Array<
						| { operation: 'create'; create: PreparedModelCreate<TModel> }
						| { operation: 'update'; item: TModel; update: PreparedModelUpdate }
					> = [];
					for (let index = 0; index < rows.length; index++) {
						const item = loaded[index];
						if (!item) {
							const create = await prepareModelCreate(
								this,
								rows[index],
								transactionContext,
								`upsertMany data[${index}]`
							);
							assertEntityIdUnchanged(meta.name, meta.idField, ids[index], create.id);
							prepared[index] = { operation: 'create', create };
							continue;
						}
						const patch = cloneSafeDataObject(rows[index], `${meta.name} upsertMany update data[${index}]`);
						assertReplaceableDataTarget(item.data, patch, `${meta.name} model data`, false);
						patchData(item.data, patch);
						prepared[index] = {
							operation: 'update',
							item,
							update: await (item as Model).prepareSave(transactionContext)
						};
					}
					for (let index = 0; index < prepared.length; index++) {
						const entry = prepared[index];
						if (entry.operation === 'create') {
							await writePreparedModelCreate(entry.create, true);
						} else {
							await (entry.item as Model).writePreparedSave(entry.update);
						}
					}
					const results: Array<ModelUpsertResult<TModel>> = [];
					for (let index = 0; index < prepared.length; index++) {
						const entry = prepared[index];
						if (entry.operation === 'create') {
							await finishPreparedModelCreate(entry.create);
							results[index] = { operation: 'create', item: entry.create.item };
						} else {
							await (entry.item as Model).finishPreparedSave(entry.update);
							results[index] = { operation: 'update', item: entry.item };
						}
					}
					return results;
				});
			}
		);
	}

	static update<TModel extends Model>(
		this: ModelConstructor<TModel>,
		id: EntityId,
		patch: Partial<TModel['data']>,
		context?: ActiveContext
	) {
		return runTrackedContextOperation(
			() => explicitContextFor(this, context, 'update'),
			async (resolvedContext) => {
				const meta = resolvedContext.meta(this);
				assertSafeEntityId(id, `${meta.name}.${meta.idField}`);
				assertPlainDataObject(patch, `${meta.name} update patch`);
				assertContextTransactionWritable(resolvedContext, `update ${meta.name}`);
				const patchId = (patch as Record<string, unknown>)[meta.idField];
				if (patchId !== undefined) assertEntityIdUnchanged(meta.name, meta.idField, id, patchId);
				const safePatch = cloneSafeData(patch);
				const loaded = await resolvedContext.loadByIdFresh(this, id);
				if (!loaded) {
					await afterStoreWrite(resolvedContext, meta.name, 'update', id, async () => {
						await runCommittedWriteBoundaryEffects(resolvedContext, meta, id, {
							model: meta,
							id,
							operation: 'update',
							meta: { storeWrite: false, committedAbsence: true }
						});
					});
					return null;
				}
				assertReplaceableDataTarget((loaded as any).data, safePatch, `${meta.name} model data`, false);
				patchData((loaded as any).data, safePatch);
				await (loaded as any).save();
				return loaded as TModel;
			}
		);
	}

	static delete<TModel extends Model>(this: ModelConstructor<TModel>, id: EntityId, context?: ActiveContext) {
		return runTrackedContextOperation(
			() => explicitContextFor(this, context, 'delete'),
			async (resolvedContext) => {
				const meta = resolvedContext.meta(this);
				assertSafeEntityId(id, `${meta.name}.${meta.idField}`);
				if (meta.datastore?.ancestor) {
					throw new ActiveTsConfigurationError(
						`Datastore model "${meta.name}" declares an ancestor resolver, so direct id reads require an ancestor-aware query.`
					);
				}
				assertContextTransactionWritable(resolvedContext, `delete ${meta.name}`);
				const store = contextInternalStore(resolvedContext, meta.store);
				const existing = await store.get(meta, id);
				const prepared = await prepareStaticDelete(resolvedContext, meta, store, id, existing);
				await writePreparedStaticDelete(prepared);
				await finishPreparedStaticDelete(prepared);
			}
		);
	}

	static deleteMany<TModel extends Model>(
		this: ModelConstructor<TModel>,
		ids: readonly EntityId[],
		context?: ActiveContext
	): Promise<void> {
		return runTrackedContextOperation(
			() => explicitContextFor(this, context, 'deleteMany'),
			async (resolvedContext) => {
				const meta = resolvedContext.meta(this);
				const safeIds = snapshotArrayInput<EntityId>(ids, `${meta.name} deleteMany ids`);
				for (let index = 0; index < safeIds.length; index++) {
					assertSafeEntityId(safeIds[index], `${meta.name} deleteMany ids[${index}]`);
				}
				assertUniqueEntityIds(safeIds, `${meta.name} deleteMany ids`);
				if (!safeIds.length) return;
				if (meta.datastore?.ancestor) {
					throw new ActiveTsConfigurationError(
						`Datastore model "${meta.name}" declares an ancestor resolver, so direct id reads require an ancestor-aware query.`
					);
				}
				await runModelBulkTransaction(resolvedContext, meta, async (transactionContext) => {
					assertContextTransactionWritable(transactionContext, `deleteMany ${meta.name}`);
					const store = contextInternalStore(transactionContext, meta.store);
					const existing = snapshotArrayInput<any>(
						await store.getMany(meta, safeIds),
						`Store adapter "${store.kind}" getMany result`
					);
					if (existing.length !== safeIds.length) {
						throw new ActiveTsValidationError(
							`Store adapter "${store.kind}" getMany result length must match requested ids.`
						);
					}
					const prepared: PreparedStaticDelete[] = [];
					for (let index = 0; index < safeIds.length; index++) {
						prepared[index] = await prepareStaticDelete(
							transactionContext,
							meta,
							store,
							safeIds[index],
							existing[index]
						);
					}
					for (let index = 0; index < prepared.length; index++) {
						await writePreparedStaticDelete(prepared[index]);
					}
					for (let index = 0; index < prepared.length; index++) {
						await finishPreparedStaticDelete(prepared[index]);
					}
				});
			}
		);
	}
}

function snapshotModelDataArray<TData extends Record<string, any>>(value: unknown, context: string): TData[] {
	const rows = snapshotArrayInput<TData>(value, context);
	const snapshots: TData[] = [];
	for (let index = 0; index < rows.length; index++) {
		snapshots[index] = cloneSafeDataObject(rows[index], `${context}[${index}]`) as TData;
	}
	return snapshots;
}

function assertUniqueEntityIds(ids: EntityId[], context: string) {
	const seen = new Set<string>();
	for (let index = 0; index < ids.length; index++) {
		const key = entityIdKey(ids[index]);
		if (SET_HAS.call(seen, key)) {
			throw new ActiveTsValidationError(`${context} contains duplicate id "${String(ids[index])}".`);
		}
		SET_ADD.call(seen, key);
	}
}

async function runModelBulkTransaction<TResult>(
	context: ActiveContext,
	meta: ResolvedModelMeta,
	run: (transactionContext: ActiveContext) => Promise<TResult>
) {
	return await context.transaction(
		async (transactionContext) => {
			try {
				return await run(transactionContext);
			} catch (error) {
				markContextTransactionRollbackOnly(transactionContext, error);
				throw error;
			}
		},
		{ store: meta.store, join: 'reuse' }
	);
}

async function prepareModelCreate<TModel extends Model>(
	model: ModelConstructor<TModel>,
	data: TModel['data'],
	context: ActiveContext,
	inputContext: string
): Promise<PreparedModelCreate<TModel>> {
	const meta = context.meta(model);
	assertContextTransactionWritable(context, `create ${meta.name}`);
	const safeData = cloneSafeDataObject(data, `${meta.name} ${inputContext}`);
	const before = await context.runHooks('beforeCreate', {
		model: meta,
		data: safeData,
		operation: 'create'
	});
	const clean = await context.prepareWrite(meta, before.data, 'create');
	const id = clean[meta.idField];
	if (id === undefined || id === null) {
		throw new ActiveTsValidationError(`Cannot create ${meta.name} without id field "${meta.idField}".`);
	}
	assertSafeEntityId(id, `${meta.name}.${meta.idField}`);
	const committedData = cloneSafeDataObject(clean, `${meta.name} committed create data`);
	const item = new model(clean, context, { persisted: true, [MODEL_PERSISTED_TOKEN]: true }) as TModel;
	const encodedData = context.encodeWrite(meta, clean);
	const writeOptions = datastoreWriteOptions(meta, id, clean);
	const prepared = {
		context,
		meta,
		store: contextInternalStore(context, meta.store),
		id,
		data: clean,
		committedData,
		encodedData,
		writeOptions,
		item
	};
	preparedCreateIdentity(prepared);
	return prepared;
}

function preparedCreateIdentity(prepared: PreparedModelCreate<Model>) {
	if (!prepared.meta.datastore?.ancestor) return entityIdKey(prepared.id);
	const ancestor = prepared.writeOptions.meta?.datastoreAncestor;
	if (ancestor === undefined) {
		throw new ActiveTsConfigurationError(
			`Datastore model "${prepared.meta.name}" declares an ancestor resolver, so write metadata cannot set datastoreAncestor to undefined.`
		);
	}
	const scopedAncestor = datastoreKeyWithNamespace(
		ancestor as DatastoreKey,
		prepared.store.datastoreNamespace,
		`Datastore model "${prepared.meta.name}" ancestor`
	);
	return `${datastoreKeyIdentity(scopedAncestor)}:${entityIdKey(prepared.id)}`;
}

async function writePreparedModelCreate<TModel extends Model>(
	prepared: PreparedModelCreate<TModel>,
	assertPreparedTarget = false
) {
	if (assertPreparedTarget) {
		const currentData = cloneSafeDataObject(prepared.item.data, `${prepared.meta.name} prepared create data`);
		if (!isDeepStrictEqual(currentData, prepared.committedData)) {
			throw new ActiveTsValidationError(
				`Prepared create target cannot change committed ${prepared.meta.name} data before the store write.`
			);
		}
	}
	await prepared.store.create(
		prepared.meta,
		prepared.id,
		prepared.encodedData,
		prepared.writeOptions
	);
}

async function finishPreparedModelCreate<TModel extends Model>(prepared: PreparedModelCreate<TModel>) {
	await afterStoreWrite(prepared.context, prepared.meta.name, 'create', prepared.id, async () => {
		await runCommittedWriteBoundaryEffects(prepared.context, prepared.meta, prepared.id, {
			model: prepared.meta,
			target: prepared.item,
			id: prepared.id,
			data: prepared.data,
			result: prepared.item,
			operation: 'create'
		});
		await prepared.context.runAfterInstantiateHooks(prepared.meta, prepared.item, 'create');
		await prepared.context.runHooks('afterCreate', {
			model: prepared.meta,
			target: prepared.item,
			id: prepared.id,
			data: prepared.data,
			result: prepared.item,
			operation: 'create'
		});
		assertPostWriteModelDataUnchanged(
			prepared.context,
			prepared.meta,
			prepared.item,
			prepared.committedData,
			'afterCreate target',
			prepared.id
		);
	});
}

async function prepareStaticDelete(
	context: ActiveContext,
	meta: ResolvedModelMeta,
	store: StoreAdapter,
	id: EntityId,
	existing: unknown
): Promise<PreparedStaticDelete> {
	if (existing == null) return { context, meta, store, id };
	const existingData = context.validateRead(meta, existing, { partial: true });
	const existingId = valueFor(existingData, meta.idField);
	if (existingId === undefined || existingId === null) {
		throw new ActiveTsValidationError(`${meta.name} delete probe is missing id field "${meta.idField}".`);
	}
	assertSafeEntityId(existingId, `${meta.name}.${meta.idField}`);
	if (entityIdKey(existingId) !== entityIdKey(id)) {
		throw new ActiveTsValidationError(
			`${meta.name} delete probe id field "${meta.idField}" must match the requested id.`
		);
	}
	const expectedVersion = typeof existingData.version === 'number' ? existingData.version : undefined;
	if (expectedVersion !== undefined && store.capabilities?.optimisticLock !== true) {
		throw new ActiveTsConfigurationError(
			`Store adapter "${store.kind}" does not support atomic optimistic locking.`
		);
	}
	await context.runHooks('beforeDelete', { model: meta, id, operation: 'delete' });
	return { context, meta, store, id, writeOptions: { expectedVersion } };
}

async function writePreparedStaticDelete(prepared: PreparedStaticDelete) {
	if (prepared.writeOptions === undefined) return;
	await prepared.store.delete(prepared.meta, prepared.id, prepared.writeOptions);
}

async function finishPreparedStaticDelete(prepared: PreparedStaticDelete) {
	if (prepared.writeOptions === undefined) {
		await afterStoreWrite(prepared.context, prepared.meta.name, 'delete', prepared.id, async () => {
			await runCommittedWriteBoundaryEffects(prepared.context, prepared.meta, prepared.id, {
				model: prepared.meta,
				id: prepared.id,
				operation: 'delete',
				meta: { storeWrite: false, committedAbsence: true }
			});
		});
		return;
	}
	await afterStoreWrite(prepared.context, prepared.meta.name, 'delete', prepared.id, async () => {
		await runCommittedWriteBoundaryEffects(prepared.context, prepared.meta, prepared.id, {
			model: prepared.meta,
			id: prepared.id,
			operation: 'delete'
		});
		await prepared.context.runHooks('afterDelete', {
			model: prepared.meta,
			id: prepared.id,
			operation: 'delete'
		});
	});
}

export function getRelation(model: Model, relation: RelationMeta) {
	if (!model || typeof model !== 'object') {
		throw new ActiveTsConfigurationError('getRelation model must be an active-ts model instance.');
	}
	const ref = modelMember(model, 'ref', 'getRelation model');
	if (typeof ref !== 'function') {
		throw new ActiveTsConfigurationError('getRelation model must be an active-ts model instance.');
	}
	if (!relation || typeof relation !== 'object' || Array.isArray(relation)) {
		throw new ActiveTsConfigurationError('getRelation relation must be a relation metadata object.');
	}
	const name = relationValue(relation, 'name', 'getRelation relation');
	return ref.call(model, assertSafeTopLevelField(name, 'relation name'));
}

function modelMember(model: object, property: string, context: string) {
	let current: object | null = model;
	while (current && current !== Object.prototype) {
		if (Object.prototype.hasOwnProperty.call(current, property)) {
			const descriptor = Object.getOwnPropertyDescriptor(current, property);
			if (!descriptor || !('value' in descriptor)) {
				throw new ActiveTsConfigurationError(`${context}.${property} must be a data property.`);
			}
			if (current === model && !descriptor.enumerable) {
				throw new ActiveTsConfigurationError(`${context}.${property} must be enumerable.`);
			}
			return descriptor.value;
		}
		current = Object.getPrototypeOf(current);
	}
	return undefined;
}

function relationValue(relation: object, property: string, context: string) {
	if (!Object.prototype.hasOwnProperty.call(relation, property)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(relation, property);
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsConfigurationError(`${context}.${property} must be a data property.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsConfigurationError(`${context}.${property} must be enumerable.`);
	}
	return descriptor.value;
}

function contextFor(model: ModelConstructor) {
	const context = staticMarkerValue(model, BOUND_CONTEXT);
	if (context !== undefined && !(context instanceof ActiveContext)) {
		throw new ActiveTsConfigurationError('Model bound context marker must be an ActiveContext.');
	}
	return (context ?? getDefaultContext()).transactionScopedContext('use model static APIs');
}

function staticModelNameValue(model: ModelConstructor) {
	let current: unknown = model;
	while (typeof current === 'function') {
		if (Object.prototype.hasOwnProperty.call(current, 'modelName')) {
			const descriptor = Object.getOwnPropertyDescriptor(current, 'modelName');
			if (!descriptor || !('value' in descriptor)) {
				throw new ActiveTsConfigurationError('Static modelName must be a data property.');
			}
			if (descriptor.value !== undefined && typeof descriptor.value !== 'string') {
				throw new ActiveTsConfigurationError('Static modelName must be a string.');
			}
			return descriptor.value as string | undefined;
		}
		const next = Object.getPrototypeOf(current);
		if (!next || next === Function.prototype) return undefined;
		current = next;
	}
	return undefined;
}

function staticFunctionNameValue(model: ModelConstructor) {
	const descriptor = Object.getOwnPropertyDescriptor(model, 'name');
	if (!descriptor) return '';
	if (!('value' in descriptor)) {
		throw new ActiveTsConfigurationError('Static model name must be a data property.');
	}
	if (typeof descriptor.value !== 'string') {
		throw new ActiveTsConfigurationError('Static model name must be a string.');
	}
	return descriptor.value;
}

function explicitContextFor(model: ModelConstructor, context: ActiveContext | undefined, operation: string) {
	if (context === undefined) return contextFor(model);
	if (!(context instanceof ActiveContext)) {
		throw new ActiveTsConfigurationError(`Model.${operation} context must be an ActiveContext.`);
	}
	return context.transactionScopedContext(`Model.${operation}`);
}

function assertEntityIdUnchanged(modelName: string, idField: string, originalId: EntityId, nextId: unknown) {
	if (nextId === undefined || nextId === null) {
		throw new ActiveTsValidationError(`Cannot save ${modelName} without id field "${idField}".`);
	}
	assertSafeEntityId(nextId, `${modelName}.${idField}`);
	if (entityIdKey(nextId as EntityId) !== entityIdKey(originalId)) {
		throw new ActiveTsValidationError(`Cannot change id field "${idField}" on ${modelName}.`);
	}
}

function assertPostWriteModelDataUnchanged(
	context: ActiveContext,
	meta: ResolvedModelMeta,
	item: Model,
	committedData: Record<string, any>,
	operation: string,
	expectedId: EntityId
) {
	const clean = context.validateModelInstance(meta, item, operation, { expectedId, partial: false });
	if (!isDeepStrictEqual(clean, committedData)) {
		throw new ActiveTsValidationError(
			`${operation} cannot change committed ${meta.name} data after the store write.`
		);
	}
}

function assertModelSnapshotWritable(item: object, modelName: string, operation: 'save' | 'delete') {
	const readTime = datastoreHistoricalModelReadTime(item);
	if (readTime === undefined) return;
	throw new ActiveTsConfigurationError(
		`Cannot ${operation} ${modelName} loaded by readAt(${readTime}); Datastore historical snapshots are read-only. ` +
		'Load the current entity or use an explicit id-based write to restore selected fields.'
	);
}

function normalizeModelConstructorOptions(options: unknown): ModelConstructorOptions {
	if (!options || typeof options !== 'object' || Array.isArray(options)) {
		throw new ActiveTsConfigurationError('Model constructor options must be a plain object.');
	}
	const prototype = Object.getPrototypeOf(options);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsConfigurationError('Model constructor options must be a plain object.');
	}
	const record = options as Record<string | symbol, unknown>;
	assertKnownModelConstructorOptions(record);
	const persisted = modelConstructorOptionValue(record, 'persisted', 'Model constructor options');
	const persistedToken = modelConstructorOptionValue(record, MODEL_PERSISTED_TOKEN, 'Model constructor options');
	if (persisted !== undefined && typeof persisted !== 'boolean') {
		throw new ActiveTsConfigurationError('Model constructor persisted option must be a boolean.');
	}
	if (persisted && persistedToken !== true) {
		throw new ActiveTsConfigurationError('Model constructor persisted option is reserved for active-ts internals.');
	}
	return {
		persisted,
		[MODEL_PERSISTED_TOKEN]: persistedToken === true ? true : undefined
	};
}

function assertKnownModelConstructorOptions(record: Record<string | symbol, unknown>) {
	for (const property of Object.getOwnPropertyNames(record)) {
		if (property !== 'persisted') {
			throw new ActiveTsConfigurationError(`Model constructor options contains unknown option "${property}".`);
		}
	}
	for (const symbol of Object.getOwnPropertySymbols(record)) {
		if (symbol !== MODEL_PERSISTED_TOKEN) {
			throw new ActiveTsConfigurationError('Model constructor options cannot contain symbol fields.');
		}
	}
}

function modelConstructorOptionValue(record: Record<string | symbol, unknown>, key: string | symbol, context: string) {
	if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(record, key);
	if (!descriptor || !('value' in descriptor)) {
		const name = typeof key === 'symbol' ? key.description ?? String(key) : key;
		throw new ActiveTsConfigurationError(`${context}.${name} must be a data property.`);
	}
	if (!descriptor.enumerable) {
		const name = typeof key === 'symbol' ? key.description ?? String(key) : key;
		throw new ActiveTsConfigurationError(`${context}.${name} must be enumerable.`);
	}
	return descriptor.value;
}

function replaceData(target: Record<string, any>, source: Record<string, any>) {
	for (const key of Object.keys(target)) {
		if (!Object.prototype.hasOwnProperty.call(source, key)) delete target[key];
	}
	patchData(target, source);
}

function patchData(target: Record<string, any>, source: Record<string, any>) {
	for (const key of Object.keys(source)) {
		defineOwnDataValue(target, key, source[key]);
	}
}

function defineOwnDataValue(target: Record<string, any>, key: string, value: unknown) {
	const existing = Object.getOwnPropertyDescriptor(target, key);
	const attributes = existing && 'value' in existing
		? { enumerable: existing.enumerable, configurable: existing.configurable, writable: existing.writable }
		: { enumerable: true, configurable: true, writable: true };
	defineDataProperty(target, key, value, attributes);
}

function assertReplaceableDataTarget(
	target: Record<string, any>,
	source: Record<string, any>,
	context: string,
	deleteMissing: boolean
) {
	if (!Object.isExtensible(target)) {
		for (const key of Object.keys(source)) {
			if (!Object.prototype.hasOwnProperty.call(target, key)) {
				throw new ActiveTsValidationError(`${context}.${key} cannot be added because model data is not extensible.`);
			}
		}
	}
	for (const symbol of Object.getOwnPropertySymbols(target)) {
		if (symbol !== ACTIVE_TS_ENTITY_KEY) {
			throw new ActiveTsValidationError(`${context} cannot contain symbol fields before save.`);
		}
		const descriptor = Object.getOwnPropertyDescriptor(target, symbol);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsValidationError(`${context}.${symbol.description ?? String(symbol)} must be a data property.`);
		}
		if (descriptor.enumerable) {
			throw new ActiveTsValidationError(`${context}.${symbol.description ?? String(symbol)} must be non-enumerable before save.`);
		}
	}
	for (const key of Object.getOwnPropertyNames(target)) {
		const descriptor = Object.getOwnPropertyDescriptor(target, key);
		if (!descriptor) continue;
		const hasSource = Object.prototype.hasOwnProperty.call(source, key);
		if (!('value' in descriptor)) {
			throw new ActiveTsValidationError(`${context}.${key} must be a data property before save.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsValidationError(`${context}.${key} must be enumerable before save.`);
		}
		if (hasSource && !descriptor.writable) {
			throw new ActiveTsValidationError(`${context}.${key} must be writable before save.`);
		}
		if (deleteMissing && !hasSource && Object.prototype.propertyIsEnumerable.call(target, key) && !descriptor.configurable) {
			throw new ActiveTsValidationError(`${context}.${key} must be configurable before save.`);
		}
	}
}

function datastoreWriteOptions(
	meta: ResolvedModelMeta,
	id: EntityId,
	data: Record<string, any>,
	expectedVersion?: number,
	ancestorOverride?: DatastoreKey
): StoreWriteOptions {
	const options: StoreWriteOptions = { expectedVersion };
	if (ancestorOverride !== undefined) {
		options.meta = { datastoreAncestor: ancestorOverride };
		return options;
	}
	if (meta.datastore?.ancestor) {
		options.meta = {
			datastoreAncestor: meta.datastore.ancestor({ model: meta, id, data })
		};
	}
	return options;
}

function assertDatastoreWriteMatchesScopedAncestor(
	meta: ResolvedModelMeta,
	id: EntityId,
	data: Record<string, any>,
	expected: DatastoreKey | undefined,
	context: string
) {
	if (expected === undefined || !meta.datastore?.ancestor) return;
	const actual = meta.datastore.ancestor({ model: meta, id, data });
	if (datastoreScopedAncestorMatches(actual, expected)) return;
	throw new ActiveTsValidationError(`${context} cannot move ${meta.name}:${String(id)} outside the scoped Datastore ancestor.`);
}

async function afterStoreWrite(
	context: ActiveContext,
	model: string,
	operation: 'create' | 'update' | 'delete',
	id: EntityId,
	task: () => Promise<void>
) {
	if (context.isTransactionContext()) {
		await task();
		return;
	}
	try {
		await task();
	} catch (error) {
		throw new ActiveTsCommittedWriteError(
			`Post-write ${operation} side effect failed for ${model}:${String(id)} after the store write committed: ${
				safeErrorMessage(error)
			}`,
			error,
			{ model, operation, id }
		);
	}
}

async function runCommittedWriteBoundaryEffects(
	context: ActiveContext,
	meta: ResolvedModelMeta,
	id: EntityId,
	payload: Omit<ActiveTsHookPayload, 'context'>
) {
	const results = await Promise.allSettled([
		context.runHooks('afterStoreWrite', payload),
		context.invalidate(meta, id)
	]);
	const errors: unknown[] = [];
	for (let index = 0; index < results.length; index++) {
		const result = results[index];
		if (result.status === 'rejected') errors[errors.length] = result.reason;
	}
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) {
		throw new AggregateError(errors, `Committed ${payload.operation ?? 'write'} boundary side effects failed.`);
	}
}
