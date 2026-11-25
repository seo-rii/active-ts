import { ActiveContext } from './context.js';
import { ActiveTsValidationError } from './errors.js';
import { QueryBuilder, relationPreloadSelectFields } from './query.js';
import { loadCompleteRelationQuery } from './relation-query.js';
import {
	assertUnambiguousDatastoreRelationFallback,
	relationAncestorForOwner,
	relationTargetJoinKeys
} from './relation-ancestor.js';
import { assertPortableScalar, valueFor } from './query-utils.js';
import {
	snapshotRelationOwnerLocalKey,
	snapshotRelationResult,
	runAfterRelationLoad
} from './relation-result.js';
import { assertSafeEntityId } from './safe-keys.js';
import { SET_ADD, SET_HAS, WEAKMAP_GET, WEAKMAP_SET } from './collection-intrinsics.js';
import { assertModelSnapshotRelationsAllowed, MODEL_DATASTORE_WRITE_ANCESTOR } from './model-internal.js';
import type { DatastoreKey, EntityId, ModelConstructor, RelationMeta } from './types.js';
import { runTrackedContextOperation } from './context-internal.js';

let warned = new WeakMap<ActiveContext, Set<string>>();
const PROMISE_THEN = Promise.prototype.then;

type LazyLoadOptions = { full?: boolean; hooks?: boolean };

export function resetLazyLoadWarnings() {
	warned = new WeakMap();
}

export class LazyRef<TModel = any> implements PromiseLike<TModel | TModel[] | null> {
	private promise?: Promise<TModel | TModel[] | null>;
	private promiseContext?: ActiveContext;
	private plannedLoad: boolean;

	constructor(
		private readonly context: ActiveContext,
		private readonly owner: any,
		private readonly relation: RelationMeta,
		planned: boolean
	) {
		this.plannedLoad = planned;
	}

	markPlanned() {
		this.plannedLoad = true;
	}

	prime(value: TModel | TModel[] | null, options: { full?: boolean } = {}) {
		const context = this.scopedContext('prime relations');
		this.plannedLoad = true;
		this.promise = Promise.resolve(value);
		this.promiseContext = context;
		if (options.full) {
			this.fullPromise = this.promise;
			this.fullPromiseContext = context;
		}
	}

	clear() {
		this.promise = undefined;
		this.promiseContext = undefined;
		this.fullPromise = undefined;
		this.fullPromiseContext = undefined;
	}

	load(options: LazyLoadOptions = {}) {
		const context = this.scopedContext('load relations');
		if (options.full) {
			if (!this.fullPromise || this.fullPromiseContext !== context) {
				this.warnIfUnplanned();
				const promise = runTrackedContextOperation(() => context, async () => await this.loadNow(options));
				this.fullPromise = promise;
				this.fullPromiseContext = context;
				this.promise = promise;
				this.promiseContext = context;
				void PROMISE_THEN.call(promise, undefined, () => {
					if (this.fullPromise === promise && this.fullPromiseContext === context) {
						this.fullPromise = undefined;
						this.fullPromiseContext = undefined;
					}
					if (this.promise === promise && this.promiseContext === context) {
						this.promise = undefined;
						this.promiseContext = undefined;
					}
				});
			}
			return this.fullPromise;
		}
		if (!this.promise || this.promiseContext !== context) {
			this.warnIfUnplanned();
			const promise = runTrackedContextOperation(() => context, async () => await this.loadNow(options));
			this.promise = promise;
			this.promiseContext = context;
			void PROMISE_THEN.call(promise, undefined, () => {
				if (this.promise === promise && this.promiseContext === context) {
					this.promise = undefined;
					this.promiseContext = undefined;
				}
			});
		}
		return this.promise;
	}

	then<TResult1 = TModel | TModel[] | null, TResult2 = never>(
		onfulfilled?: ((value: TModel | TModel[] | null) => TResult1 | PromiseLike<TResult1>) | null,
		onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
	): PromiseLike<TResult1 | TResult2> {
		return this.load().then(onfulfilled, onrejected);
	}

	private fullPromise?: Promise<TModel | TModel[] | null>;
	private fullPromiseContext?: ActiveContext;

	private scopedContext(operation: string) {
		assertModelSnapshotRelationsAllowed(this.owner);
		const context = this.context.transactionScopedContext(operation);
		const descriptor = Object.getOwnPropertyDescriptor(this.owner, 'context');
		const ownerContext = descriptor && 'value' in descriptor ? descriptor.value : undefined;
		if (ownerContext instanceof ActiveContext) ownerContext.transactionScopedContext(operation);
		return context;
	}

	private async loadNow(options: LazyLoadOptions = {}) {
		const context = this.scopedContext('load relations');
		const ownerMeta = context.meta(this.owner.constructor as ModelConstructor);
		const expectedOwnerId = valueFor(this.owner.data, ownerMeta.idField);
		if (expectedOwnerId === undefined || expectedOwnerId === null) {
			throw new ActiveTsValidationError(`relation owner is missing id field "${ownerMeta.idField}".`);
		}
		assertSafeEntityId(expectedOwnerId, `${ownerMeta.name}.${ownerMeta.idField}`);
		const scopedDatastoreAncestor = (this.owner as any)[MODEL_DATASTORE_WRITE_ANCESTOR] as DatastoreKey | undefined;
		const expectedDatastoreAncestor = scopedDatastoreAncestor ?? (
			ownerMeta.datastore?.ancestor
				? ownerMeta.datastore.ancestor({ model: ownerMeta, id: expectedOwnerId, data: this.owner.data })
				: undefined
		);
		const emitHooks = options.hooks !== false;
		if (emitHooks) {
			await context.runHooks('beforeRelationLoad', {
				model: ownerMeta,
				target: this.owner,
				operation: 'relation',
				meta: { relation: this.relation.name }
			});
			this.scopedContext('load relations');
			context.validateModelInstance(ownerMeta, this.owner, `beforeRelationLoad ${ownerMeta.name}.${this.relation.name} target`, {
				expectedId: expectedOwnerId,
				expectedDatastoreAncestor,
				partial: false
			});
		}
		const ownerLocalKeySnapshot = snapshotRelationOwnerLocalKey(
			context,
			ownerMeta,
			this.owner,
			this.relation,
			`beforeRelationLoad ${ownerMeta.name}.${this.relation.name} target`
		);
		let result = await this.resolveNow(options);
		this.scopedContext('load relations');
		if (emitHooks) {
			const resultSnapshot = snapshotRelationResult(
				context,
				this.relation,
				result,
				`afterRelationLoad ${ownerMeta.name}.${this.relation.name}`
			);
			result = await runAfterRelationLoad(context, {
				ownerMeta,
				owner: this.owner,
				relation: this.relation,
				ownerLocalKey: ownerLocalKeySnapshot,
				validateOwner: (label) => {
					context.validateModelInstance(ownerMeta, this.owner, label, {
						expectedId: expectedOwnerId,
						expectedDatastoreAncestor,
						partial: false
					});
				}
			}, resultSnapshot, result, () => { this.scopedContext('load relations'); }) as TModel | TModel[] | null;
		}
		return result;
	}

	private async resolveNow(options: LazyLoadOptions = {}) {
		const context = this.scopedContext('resolve relations');
		const target = this.relation.target() as ModelConstructor;
		const ownerData = this.owner.data ?? {};
		const localValue = valueFor(ownerData, this.relation.localKey);
		if (localValue === undefined || localValue === null) return this.relation.kind === 'many' ? [] : null;
		const targetMeta = context.meta(target);
		const ownerMeta = context.meta(this.owner.constructor as ModelConstructor);
		const ancestor = relationAncestorForOwner(context, ownerMeta, targetMeta, this.relation, this.owner);
		if (this.relation.foreignKey === targetMeta.idField) assertSafeEntityId(localValue, `${this.relation.name} relation key`);
		else assertPortableScalar(localValue, `${this.relation.name} relation key`);
		const ownerJoinKeys = relationTargetJoinKeys(
			targetMeta,
			this.relation,
			localValue,
			ownerData,
			`${ownerMeta.name}.${this.relation.name}`
		);
		const canMatchTargetAncestorFields = ownerJoinKeys.targetJoinKey !== ownerJoinKeys.joinKey;
		const targetHasDatastoreAncestorFields = (targetMeta.datastore?.ancestorFields?.length ?? 0) > 0;
		if (
			this.relation.kind === 'one' &&
			this.relation.foreignKey === targetMeta.idField &&
			(options.full || !this.relation.preload?.length) &&
			!canMatchTargetAncestorFields &&
			!targetHasDatastoreAncestorFields
		) {
			assertSafeEntityId(localValue, `${this.relation.name} relation key`);
			if (this.relation.ancestor || ancestor !== undefined) {
				let query = new QueryBuilder<any>(context, target);
				if (ancestor) query = query.ancestor(ancestor);
				return await query.find(localValue as EntityId).load();
			}
			return await context.loadById(target, localValue as EntityId);
		}
		let query = new QueryBuilder<any>(context, target).where(this.relation.foreignKey, '=', localValue);
		if (ancestor) query = query.ancestor(ancestor);
		if (!options.full && this.relation.preload?.length) {
			const select = relationPreloadSelectFields(
				context,
				targetMeta,
				[{ field: this.relation.foreignKey, op: '=', value: localValue }],
				[this.relation.foreignKey, ...this.relation.preload]
			);
			if (select) query.select(...select);
		}
		if (!canMatchTargetAncestorFields) {
			if (this.relation.kind === 'one') {
				const list = (await query.limit(targetMeta.datastore?.ancestor ? 2 : 1).load()).list;
				assertUnambiguousDatastoreRelationFallback(ownerMeta, targetMeta, this.relation, ownerJoinKeys, list);
				return list[0] ?? null;
			}
			return await loadCompleteRelationQuery(query);
		}
		const list = (await loadCompleteRelationQuery(query)).filter((targetItem) => {
			const foreignValue = valueFor(targetItem.data, this.relation.foreignKey);
			if (foreignValue === undefined || foreignValue === null) return false;
			return relationTargetJoinKeys(
				targetMeta,
				this.relation,
				foreignValue,
				targetItem.data,
				`${targetMeta.name}.${this.relation.foreignKey}`
			).targetJoinKey === ownerJoinKeys.targetJoinKey;
		});
		if (this.relation.kind === 'one') return list[0] ?? null;
		return list;
	}

	private warnIfUnplanned() {
		const context = this.scopedContext('warn about lazy relation loads');
		if (this.plannedLoad || !context.lazyWarningsEnabled()) return;
		const ownerMeta = context.meta(this.owner.constructor as ModelConstructor);
		const key = `${ownerMeta.name}:${this.relation.name}`;
		let contextWarnings = WEAKMAP_GET.call(warned, context) as Set<string> | undefined;
		if (!contextWarnings) {
			contextWarnings = new Set();
			WEAKMAP_SET.call(warned, context, contextWarnings);
		}
		if (SET_HAS.call(contextWarnings, key)) return;
		SET_ADD.call(contextWarnings, key);
		console.warn(
			`active-ts lazy relation "${key}" was loaded without include(). Add include("${this.relation.name}") to batch it explicitly.`
		);
	}
}
