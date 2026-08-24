import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ActiveContext, assertOutsideActiveTransaction, isContextBoundSearchAdapter } from './context.js';
import {
	ActiveTsConflictError,
	ActiveTsConfigurationError,
	ActiveTsNotFoundError,
	ActiveTsValidationError,
	safeErrorMessage
} from './errors.js';
import {
	assertDenseArrayItems,
	assertSafeCacheKey,
	assertSafeEntityId,
	assertSafeSchemaIdentifier,
	ACTIVE_TS_ENTITY_KEY,
	cloneSafeData,
	cloneSafeDataObject,
	cloneSafeDataObjectWithoutActiveEntityKey,
	defineDataProperty
} from './safe-keys.js';
import { snapshotArrayInput } from './array-input.js';
import { entityIdKey, valueFor } from './query-utils.js';
import {
	datastoreSearchDocumentIdentity,
	searchAdapterSource,
	searchAdapterUsesProjection,
	withSearchDocumentIdentity,
	searchIndexAdapterKind,
	withSearchIndexesForAdapter,
	withDatastoreSearchNamespace
} from './search-utils.js';
import {
	datastoreAncestorFromEntityKey,
	datastoreKeyIdentity,
	datastoreKeyWithNamespace,
	normalizeDatastoreKey
} from './datastore-key.js';
import { cloneDate, dateIsoString, dateParse, dateTime } from './date-intrinsics.js';
import {
	MAP_GET,
	MAP_HAS,
	MAP_SET,
	MAP_SIZE,
	SET_ADD,
	SET_HAS,
	WEAKMAP_GET,
	WEAKMAP_HAS,
	WEAKMAP_SET
} from './collection-intrinsics.js';
import {
	OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
	OBJECT_GET_OWN_PROPERTY_NAMES,
	OBJECT_GET_OWN_PROPERTY_SYMBOLS,
	OBJECT_GET_PROTOTYPE_OF,
	OBJECT_HAS_OWN
} from './object-intrinsics.js';
import { contextInternalStore } from './context-internal.js';
import { resolveModelMeta } from './metadata.js';
import {
	datastorePayloadHasAncestorFields,
	datastorePayloadResolvedAncestor,
	normalizeStoreQueryResultForModel,
	storeTrustsDatastoreEntityKeyRows
} from './store-options.js';
import { storeAdapterSourceChain } from './store-utils.js';
import { MODEL_DATASTORE_WRITE_ANCESTOR } from './model-internal.js';
import type { ActiveTsPlugin, DatastoreKey, EntityId, ModelConstructor, QueryPlan, ResolvedModelMeta, SearchAdapter, SearchCapabilities, StoreAdapter } from './types.js';

export type OutboxOperation = 'create' | 'update' | 'delete';

export type OutboxEvent = {
	id: string;
	model: string;
	modelId?: EntityId;
	modelIdentity?: string;
	modelDatastoreAncestor?: DatastoreKey;
	modelDatastoreProjectId?: string;
	operation: OutboxOperation;
	data?: any;
	dataEncoding?: 'public' | 'stored';
	createdAt: string;
	sequence?: string;
	version?: number;
	leaseToken?: string;
	leaseExpiresAt?: string;
};

export type OutboxAdapter = {
	readonly transactionStore?: string;
	setup?: (context: ActiveContext) => Promise<void> | void;
	append: (event: OutboxEvent) => Promise<void>;
	appendTransactional?: (context: ActiveContext, event: OutboxEvent) => Promise<void>;
	list?: () => Promise<OutboxEvent[]>;
	lease?: (options?: OutboxBatchOptions) => Promise<OutboxEvent[]>;
	supportsExclusiveLease?: () => Promise<boolean> | boolean;
	isLeaseCurrent?: (event: OutboxEvent) => Promise<boolean>;
	release?: (events: OutboxEvent[]) => Promise<void>;
	ack?: (events: OutboxEvent[]) => Promise<void>;
	drain?: (options?: OutboxBatchOptions) => Promise<OutboxEvent[]>;
	requeue?: (events: OutboxEvent[]) => Promise<void>;
};
export type OutboxBatchOptions = {
	limit?: number;
};
const OUTBOX_PLUGIN_OPTION_KEYS = ['outbox', 'includeData', 'id', 'allowUnsafeTransactionDeferredAppend'] as const;
const SEARCH_SYNC_WORKER_OPTION_KEYS = [
	'outbox',
	'search',
	'models',
	'context',
	'adapter',
	'batchSize',
	'allowUnsafeDrainFallback',
	'allowUnsafeIdentityOnlyDatastoreDelete'
] as const;
const STORE_OUTBOX_ADAPTER_OPTION_KEYS = ['context', 'store', 'modelName'] as const;
const SEARCH_SYNC_CAPABILITY_KEYS: Array<Exclude<keyof SearchCapabilities, 'whereOperators'>> = [
	'where',
	'nestedFields',
	'numericComparisons',
	'nullOperators',
	'cursor',
	'native',
	'index'
];
const SEARCH_SYNC_WHERE_OPERATOR_KEYS = [
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
const SEARCH_SYNC_WHERE_OPERATORS = stringSet(SEARCH_SYNC_WHERE_OPERATOR_KEYS);
const OUTBOX_EVENT_KEYS = [
	'id',
	'model',
	'modelId',
	'modelIdentity',
	'modelDatastoreAncestor',
	'modelDatastoreProjectId',
	'operation',
	'data',
	'dataEncoding',
	'createdAt',
	'sequence',
	'version',
	'leaseToken',
	'leaseExpiresAt'
] as const;
const DEFAULT_STORE_OUTBOX_MODEL_NAME = 'active_ts_outbox_event';
const STORE_OUTBOX_LEASE_TTL_MS = 5 * 60 * 1000;
const STALE_SEARCH_SYNC_LEASE_RELEASE_ERROR = Symbol('active-ts.outbox.stale-search-sync-lease-release-error');
let storeOutboxSequence = 0;

class StoreOutboxEventModel {}

export class MemoryOutboxAdapter implements OutboxAdapter {
	private readonly events: OutboxEvent[] = [];

	async append(event: OutboxEvent) {
		const normalized = sanitizeOutboxEvent(event, { requireModelId: false });
		this.assertAvailableIds([normalized], 'memory outbox append event');
		this.events[this.events.length] = normalized;
	}

	async list() {
		const list: OutboxEvent[] = [];
		for (let index = 0; index < this.events.length; index++) {
			list[index] = sanitizeOutboxEvent(this.events[index], { requireModelId: false });
		}
		return list;
	}

	async drain(options?: OutboxBatchOptions) {
		const limit = normalizeOutboxBatchLimit(options, 'memory outbox drain options');
		const count = limit ?? this.events.length;
		const drained: OutboxEvent[] = [];
		for (let index = 0; index < count && index < this.events.length; index++) {
			drained[index] = sanitizeOutboxEvent(this.events[index], { requireModelId: false });
		}
		removeMemoryOutboxHead(this.events, drained.length);
		return drained;
	}

	async requeue(events: OutboxEvent[]) {
		const safeEvents = snapshotArrayInput<OutboxEvent>(events, 'memory outbox requeue events');
		const normalized: OutboxEvent[] = [];
		for (let index = 0; index < safeEvents.length; index++) {
			normalized[index] = sanitizeOutboxEvent(safeEvents[index], { requireModelId: false });
		}
		this.assertAvailableIds(normalized, 'memory outbox requeue events');
		prependMemoryOutboxEvents(this.events, normalized);
	}

	private assertAvailableIds(events: readonly OutboxEvent[], context: string) {
		const existing = new Set<string>();
		for (const event of this.events) SET_ADD.call(existing, event.id);
		const incoming = new Set<string>();
		for (const event of events) {
			if (SET_HAS.call(incoming, event.id)) {
				throw new ActiveTsConflictError(`${context} contains duplicate event id "${event.id}".`);
			}
			SET_ADD.call(incoming, event.id);
			if (SET_HAS.call(existing, event.id)) {
				throw new ActiveTsConflictError(`Memory outbox event id "${event.id}" already exists.`);
			}
		}
	}
}

function removeMemoryOutboxHead(events: OutboxEvent[], count: number) {
	if (count <= 0) return;
	let write = 0;
	for (let read = count; read < events.length; read++) {
		events[write] = events[read];
		write++;
	}
	events.length = write;
}

function prependMemoryOutboxEvents(events: OutboxEvent[], prefix: readonly OutboxEvent[]) {
	if (!prefix.length) return;
	const next: OutboxEvent[] = [];
	let write = 0;
	for (let index = 0; index < prefix.length; index++) {
		next[write] = prefix[index];
		write++;
	}
	for (let index = 0; index < events.length; index++) {
		next[write] = events[index];
		write++;
	}
	events.length = 0;
	for (let index = 0; index < next.length; index++) {
		events[index] = next[index];
	}
}

export type StoreOutboxAdapterOptions = {
	context?: ActiveContext;
	store?: string;
	modelName?: string;
};

export class StoreOutboxAdapter implements OutboxAdapter {
	readonly transactionStore!: string;
	private context?: ActiveContext;
	private readonly meta: ResolvedModelMeta;

	constructor(options: StoreOutboxAdapterOptions) {
		const safeOptions = validateStoreOutboxAdapterOptions(options);
		this.context = safeOptions.context;
		this.meta = createStoreOutboxMeta(safeOptions.store, safeOptions.modelName);
		defineDataProperty(this, 'transactionStore', this.meta.store, {
			enumerable: true,
			configurable: false,
			writable: false
		});
	}

	setup(context: ActiveContext) {
		if (!(context instanceof ActiveContext)) {
			throw new ActiveTsConfigurationError('Store outbox adapter context must be an ActiveContext.');
		}
		if (this.context && this.context !== context) {
			throw new ActiveTsConfigurationError('Store outbox adapter is already bound to a different ActiveContext.');
		}
		contextInternalStore(context, this.meta.store);
		this.context = context;
	}

	async append(event: OutboxEvent) {
		await this.appendWithContext(this.activeContext(), event);
	}

	async appendTransactional(context: ActiveContext, event: OutboxEvent) {
		if (!(context instanceof ActiveContext)) {
			throw new ActiveTsConfigurationError('Store outbox transactional context must be an ActiveContext.');
		}
		const root = context.rootContext();
		if (this.context && this.context !== root) {
			throw new ActiveTsConfigurationError('Store outbox adapter is already bound to a different ActiveContext.');
		}
		if (!context.isInTransaction()) {
			throw new ActiveTsConfigurationError('Store outbox appendTransactional requires an active transaction context.');
		}
		this.context ??= root;
		await this.appendWithContext(context, event);
	}

	async list() {
		return await this.listWithContext(this.activeContext());
	}

	async lease(options?: OutboxBatchOptions) {
		const limit = normalizeOutboxBatchLimit(options, 'store outbox lease options');
		const context = this.activeContext();
		const store = contextInternalStore(context, this.meta.store);
		if (store.capabilities?.optimisticLock !== true && !storeSupportsOutboxLeaseTransactions(store)) {
			throw new ActiveTsConfigurationError(
				`Store outbox adapter requires store "${store.kind}" to support optimistic locking or conflict-detecting transactions for exclusive leases.`
			);
		}
		const now = new Date();
		const token = randomUUID();
		const expiresAt = dateIsoString(new Date(dateTime(now) + STORE_OUTBOX_LEASE_TTL_MS));
		const leased: OutboxEvent[] = [];
		const blockedEntityKeys = new Set<string>();
		let cursor: string | undefined;
		const paged = limit !== undefined && store.capabilities?.cursor === true;
		do {
			const remaining = limit === undefined ? undefined : limit - leased.length;
			if (remaining !== undefined && remaining <= 0) break;
			const page = await this.listPageWithContext(context, { limit: paged ? remaining : undefined, cursor });
			for (const event of page.events) {
				const checkOrderKeys = outboxEntityOrderCheckKeys(event);
				const blockOrderKeys = outboxEntityOrderBlockKeys(event);
				if (outboxEntityOrderKeysBlocked(blockedEntityKeys, checkOrderKeys)) {
					blockOutboxEntityOrderKeys(blockedEntityKeys, blockOrderKeys);
					continue;
				}
				if (isOutboxLeaseActive(event, now)) {
					blockOutboxEntityOrderKeys(blockedEntityKeys, blockOrderKeys);
					continue;
				}
				const releaseCandidate = withOutboxLease(event, token, expiresAt);
				try {
					const claim = await this.claimOutboxLease(context, event, token, expiresAt, now);
					if (!claim.claimed) {
						blockOutboxEntityOrderKeys(blockedEntityKeys, blockOrderKeys);
						if (claim.current) {
							blockOutboxEntityOrderKeys(blockedEntityKeys, outboxEntityOrderBlockKeys(claim.current));
						}
						continue;
					}
					leased.push(claim.claimed);
					blockOutboxEntityOrderKeys(blockedEntityKeys, outboxEntityOrderBlockKeys(claim.claimed));
				} catch (error) {
					if (isStoreOutboxLeaseClaimConflict(store, error)) {
						blockOutboxEntityOrderKeys(blockedEntityKeys, blockOrderKeys);
						const next = await this.currentOutboxEvent(context, event.id);
						if (next) blockOutboxEntityOrderKeys(blockedEntityKeys, outboxEntityOrderBlockKeys(next));
						continue;
					}
					await this.releaseClaimedLeaseBatch([...leased, releaseCandidate], error);
					throw error;
				}
				if (limit !== undefined && leased.length >= limit) break;
			}
			if (!paged || !page.more || !page.cursor) break;
			cursor = page.cursor;
		} while (limit === undefined || leased.length < limit);
		return leased;
	}

	supportsExclusiveLease() {
		const store = contextInternalStore(this.activeContext(), this.meta.store);
		return store.capabilities?.optimisticLock === true || storeSupportsOutboxLeaseTransactions(store);
	}

	async isLeaseCurrent(event: OutboxEvent) {
		const normalized = sanitizeOutboxEvent(event, { requireModelId: false });
		const current = await this.currentOutboxEvent(this.activeContext(), normalized.id);
		if (normalized.leaseToken === undefined) {
			return current !== undefined && current.leaseToken === undefined && isOutboxSnapshotCurrent(current, normalized);
		}
		return current !== undefined &&
			isOutboxLeaseCurrent(current, normalized.leaseToken, new Date()) &&
			isOutboxSnapshotCurrent(current, normalized);
	}

	async release(events: OutboxEvent[]) {
		const normalized = sanitizeOutboxEventBatch(events, 'store outbox release events');
		const context = this.activeContext();
		const run = async (activeContext: ActiveContext, batch: readonly OutboxEvent[]) => {
			const store = contextInternalStore(activeContext, this.meta.store);
			for (const event of batch) {
				if (event.leaseToken === undefined) continue;
				const current = await this.currentOutboxEvent(activeContext, event.id);
				if (!current || current.leaseToken !== event.leaseToken) continue;
				const released = withoutOutboxLease(current);
				try {
					await store.update(
						this.meta,
						event.id,
						released,
						store.capabilities?.optimisticLock === true ? outboxExpectedVersionOption(current) : undefined
					);
				} catch (error) {
					if (error instanceof ActiveTsConflictError || error instanceof ActiveTsNotFoundError) continue;
					throw error;
				}
			}
		};
		const store = contextInternalStore(context, this.meta.store);
		if (store.capabilities?.optimisticLock !== true && storeSupportsOutboxLeaseTransactions(store)) {
			const errors: unknown[] = [];
			for (const event of normalized) {
				try {
					await context.transaction((tx) => run(tx, [event]), { store: this.meta.store });
				} catch (error) {
					errors[errors.length] = error;
				}
			}
			if (errors.length === 1) throw errors[0];
			if (errors.length > 1) throw new AggregateError(errors, 'Store outbox release failed.');
			return;
		}
		await run(context, normalized);
	}

	private async claimOutboxLease(
		context: ActiveContext,
		event: OutboxEvent,
		token: string,
		expiresAt: string,
		now: Date
	) {
		const run = async (activeContext: ActiveContext) => {
			const current = await this.currentOutboxEvent(activeContext, event.id);
			if (!current || !isOutboxSnapshotCurrent(current, event) || isOutboxLeaseActive(current, now)) {
				return { current, claimed: undefined };
			}
			const claimed = withOutboxLease(current, token, expiresAt);
			const store = contextInternalStore(activeContext, this.meta.store);
			await store.update(
				this.meta,
				current.id,
				claimed,
				store.capabilities?.optimisticLock === true ? outboxExpectedVersionOption(current) : undefined
			);
			return { current: claimed, claimed };
		};
		const store = contextInternalStore(context, this.meta.store);
		if (store.capabilities?.optimisticLock === true) return await run(context);
		return await context.transaction((tx) => run(tx), { store: this.meta.store });
	}

	private async releaseClaimedLeaseBatch(events: OutboxEvent[], cause: unknown) {
		if (!events.length) return;
		try {
			await this.release(events);
		} catch (releaseError) {
			throw new AggregateError(
				[cause, releaseError],
				`Store outbox lease failed and release failed: ${safeErrorMessage(cause)}`
			);
		}
	}

	async ack(events: OutboxEvent[]) {
		const normalized = sanitizeOutboxEventBatch(events, 'store outbox ack events');
		const run = async (context: ActiveContext, recoverDeletes: boolean, batch: readonly OutboxEvent[]) => {
			const deleted: OutboxEvent[] = [];
			for (const event of batch) {
				const current = await this.currentOutboxEvent(context, event.id);
				if (!current) continue;
				if (
					event.leaseToken !== undefined &&
					(
						!isOutboxLeaseCurrent(current, event.leaseToken, new Date()) ||
						!isOutboxSnapshotCurrent(current, event)
					)
				) {
					continue;
				}
				if (event.leaseToken === undefined && current.leaseToken !== undefined) continue;
				if (event.leaseToken === undefined && !isOutboxSnapshotCurrent(current, event)) continue;
				const currentStore = contextInternalStore(context, this.meta.store);
				const deleteOptions = currentStore.capabilities?.optimisticLock === true
					? outboxExpectedVersionOption(current)
					: undefined;
				try {
					await currentStore.delete(this.meta, event.id, deleteOptions);
					if (recoverDeletes) deleted.push(current);
				} catch (error) {
					if (current && (error instanceof ActiveTsConflictError || error instanceof ActiveTsNotFoundError)) {
						continue;
					}
					if (recoverDeletes) {
						const errors = await this.reinsertDeletedEvents(context, current ? [...deleted, current] : deleted);
						if (errors.length) {
							throw new AggregateError(
								[error, ...errors],
								`Store outbox ack failed and rollback failed: ${safeErrorMessage(error)}`
							);
						}
					}
					throw error;
				}
			}
		};
		const context = this.activeContext();
		const store = contextInternalStore(context, this.meta.store);
		if (store.capabilities?.optimisticLock !== true && storeSupportsOutboxLeaseTransactions(store)) {
			const errors: unknown[] = [];
			for (const event of normalized) {
				try {
					await context.transaction((tx) => run(tx, false, [event]), { store: this.meta.store });
				} catch (error) {
					errors[errors.length] = error;
				}
			}
			if (errors.length === 1) throw errors[0];
			if (errors.length > 1) throw new AggregateError(errors, 'Store outbox ack failed.');
			return;
		}
		if (storeSupportsOutboxManagementTransactions(store)) {
			return await context.transaction((tx) => run(tx, false, normalized), { store: this.meta.store });
		}
		await run(context, true, normalized);
	}

	async drain(options?: OutboxBatchOptions) {
		const limit = normalizeOutboxBatchLimit(options, 'store outbox drain options');
		const run = async (context: ActiveContext, recoverDeletes: boolean) => {
			const store = contextInternalStore(context, this.meta.store);
			const now = new Date();
			const deleted: OutboxEvent[] = [];
			const drained: OutboxEvent[] = [];
			const blockedEntityKeys = new Set<string>();
			let cursor: string | undefined;
			const paged = limit !== undefined && store.capabilities?.cursor === true;
			do {
				const remaining = limit === undefined ? undefined : limit - drained.length;
				if (remaining !== undefined && remaining <= 0) break;
				const page = await this.listPageWithContext(context, { limit: paged ? remaining : undefined, cursor });
				for (const event of page.events) {
					const checkOrderKeys = outboxEntityOrderCheckKeys(event);
					const blockOrderKeys = outboxEntityOrderBlockKeys(event);
					if (outboxEntityOrderKeysBlocked(blockedEntityKeys, checkOrderKeys)) {
						blockOutboxEntityOrderKeys(blockedEntityKeys, blockOrderKeys);
						continue;
					}
					if (isOutboxLeaseActive(event, now)) {
						blockOutboxEntityOrderKeys(blockedEntityKeys, blockOrderKeys);
						continue;
					}
					const current = await this.currentOutboxEvent(context, event.id);
					if (!current || !isOutboxSnapshotCurrent(current, event) || isOutboxLeaseActive(current, now)) {
						blockOutboxEntityOrderKeys(blockedEntityKeys, blockOrderKeys);
						if (current) blockOutboxEntityOrderKeys(blockedEntityKeys, outboxEntityOrderBlockKeys(current));
						continue;
					}
					try {
						await store.delete(
							this.meta,
							current.id,
							store.capabilities?.optimisticLock === true ? outboxExpectedVersionOption(current) : undefined
						);
						if (recoverDeletes) deleted.push(current);
						drained.push(current);
						if (limit !== undefined && drained.length >= limit) break;
					} catch (error) {
						if (
							store.capabilities?.optimisticLock === true &&
							(error instanceof ActiveTsConflictError || error instanceof ActiveTsNotFoundError)
						) {
							blockOutboxEntityOrderKeys(blockedEntityKeys, blockOrderKeys);
							continue;
						}
						if (recoverDeletes) {
							const errors = await this.reinsertDeletedEvents(context, [...deleted, event]);
							if (errors.length) {
								throw new AggregateError(
									[error, ...errors],
									`Store outbox drain failed and rollback failed: ${safeErrorMessage(error)}`
								);
							}
						}
						throw error;
					}
				}
				if (!paged || !page.more || !page.cursor) break;
				cursor = page.cursor;
			} while (limit === undefined || drained.length < limit);
			return drained;
		};
		const context = this.activeContext();
		const store = contextInternalStore(context, this.meta.store);
		if (storeSupportsOutboxManagementTransactions(store)) return await context.transaction((tx) => run(tx, false), { store: this.meta.store });
		return await run(context, true);
	}

	async requeue(events: OutboxEvent[]) {
		const normalized = sanitizeOutboxEventBatch(events, 'store outbox requeue events');
		const run = async (context: ActiveContext, recoverCreates: boolean) => {
			const created: OutboxEvent[] = [];
			for (const event of normalized) {
				try {
					const inserted = await this.appendWithContext(context, event);
					if (recoverCreates) created.push(inserted);
				} catch (error) {
					if (recoverCreates) {
						const errors = await this.deleteInsertedEvents(context, created);
						if (errors.length) {
							throw new AggregateError(
								[error, ...errors],
								`Store outbox requeue failed and rollback failed: ${safeErrorMessage(error)}`
							);
						}
					}
					throw error;
				}
			}
		};
		const context = this.activeContext();
		const store = contextInternalStore(context, this.meta.store);
		if (storeSupportsOutboxManagementTransactions(store)) return await context.transaction((tx) => run(tx, false), { store: this.meta.store });
		await run(context, true);
	}

	private async appendWithContext(context: ActiveContext, event: OutboxEvent) {
		const safeEvent = withStoreOutboxSequence(sanitizeOutboxEvent(event, { requireModelId: false }));
		await contextInternalStore(context, this.meta.store).create(this.meta, safeEvent.id, safeEvent);
		return safeEvent;
	}

	private async listWithContext(context: ActiveContext) {
		return (await this.listPageWithContext(context)).events;
	}

	private async listPageWithContext(
		context: ActiveContext,
		options: { limit?: number; cursor?: string } = {}
	) {
		const plan = outboxListQueryPlan(options);
		const result = normalizeStoreQueryResultForModel(
			this.meta,
			await contextInternalStore(context, this.meta.store).query(this.meta, plan),
			'Store outbox query'
		);
		const events: OutboxEvent[] = [];
		for (let index = 0; index < result.list.length; index++) {
			events[index] = sanitizeStoreOutboxEvent(result.list[index], { requireModelId: false });
		}
		return { events, cursor: result.cursor, more: result.more === true };
	}

	private activeContext() {
		if (!this.context) {
			throw new ActiveTsConfigurationError(
				'Store outbox adapter is not bound to an ActiveContext. Pass context or install it through createOutboxPlugin().'
			);
		}
		return this.context;
	}

	private async reinsertDeletedEvents(context: ActiveContext, events: OutboxEvent[]) {
		const errors: unknown[] = [];
		for (const event of events) {
			try {
				const current = await contextInternalStore(context, this.meta.store).get(this.meta, event.id);
				if (current !== null && current !== undefined) continue;
				await contextInternalStore(context, this.meta.store).create(this.meta, event.id, event);
			} catch (error) {
				errors.push(error);
			}
		}
		return errors;
	}

	private async deleteInsertedEvents(context: ActiveContext, events: OutboxEvent[]) {
		const errors: unknown[] = [];
		const reversed = copyEventsReversed(events);
		const store = contextInternalStore(context, this.meta.store);
		for (const event of reversed) {
			try {
				const current = await store.get(this.meta, event.id);
				if (current === null || current === undefined) continue;
				const currentEvent = sanitizeStoreOutboxEvent(current, { requireModelId: false });
				if (!isOutboxRequeueInsertCurrent(currentEvent, event)) continue;
				await store.delete(
					this.meta,
					event.id,
					store.capabilities?.optimisticLock === true ? outboxExpectedVersionOption(currentEvent) : undefined
				);
			} catch (error) {
				errors.push(error);
			}
		}
		return errors;
	}

	private async currentOutboxEvent(context: ActiveContext, id: EntityId) {
		const current = await contextInternalStore(context, this.meta.store).get(this.meta, id);
		if (current === null || current === undefined) return undefined;
		const event = sanitizeStoreOutboxEvent(current, { requireModelId: false });
		if (entityIdKey(event.id) !== entityIdKey(id)) {
			throw new ActiveTsValidationError(
				`Store outbox get result id "${event.id}" does not match requested id "${String(id)}".`
			);
		}
		return event;
	}
}

function validateStoreOutboxAdapterOptions(options: StoreOutboxAdapterOptions) {
	if (!options || typeof options !== 'object' || Array.isArray(options)) {
		throw new ActiveTsConfigurationError('Store outbox adapter options must be an object.');
	}
	assertPlainOptions(options, 'Store outbox adapter options');
	const record = options as Record<string, unknown>;
	assertNoSymbolOptions(record, 'Store outbox adapter options');
	assertKnownOptions(record, STORE_OUTBOX_ADAPTER_OPTION_KEYS, 'Store outbox adapter options');
	const context = ownOptionValue(record, 'context', 'Store outbox adapter options');
	const store = ownOptionValue(record, 'store', 'Store outbox adapter options');
	const modelName = ownOptionValue(record, 'modelName', 'Store outbox adapter options');
	if (context !== undefined && !(context instanceof ActiveContext)) {
		throw new ActiveTsConfigurationError('Store outbox adapter context must be an ActiveContext.');
	}
	return {
		context,
		store: store === undefined ? 'default' : assertSafeSchemaIdentifier(store, 'Store outbox adapter store'),
		modelName: modelName === undefined
			? DEFAULT_STORE_OUTBOX_MODEL_NAME
			: assertSafeSchemaIdentifier(modelName, 'Store outbox adapter modelName')
	};
}

function createStoreOutboxMeta(store: string, modelName: string): ResolvedModelMeta {
	return {
		model: StoreOutboxEventModel,
		name: modelName,
		store,
		idField: 'id',
		readValidation: 'off',
		indexes: [{ name: `${modelName}_created_at`, fields: ['createdAt', 'sequence', 'id'] }],
		searchIndexes: [],
		relations: new Map(),
		hooks: {},
		views: new Map(),
		policies: new Map(),
		scopes: new Map(),
		fieldCodecs: new Map(),
		fieldTypes: new Map([
			['createdAt', 'string'],
			['sequence', 'string']
		])
	};
}

function sanitizeStoreOutboxEvent(event: OutboxEvent, options: { requireModelId: boolean }) {
	return sanitizeOutboxEvent(stripStoreOutboxEntityKey(event), options);
}

function stripStoreOutboxEntityKey(event: OutboxEvent) {
	if (!event || typeof event !== 'object' || Array.isArray(event)) return event;
	const symbols = OBJECT_GET_OWN_PROPERTY_SYMBOLS(event);
	if (symbols.length !== 1 || symbols[0] !== ACTIVE_TS_ENTITY_KEY) return event;
	const clone = Object.create(OBJECT_GET_PROTOTYPE_OF(event));
	for (const key of OBJECT_GET_OWN_PROPERTY_NAMES(event)) {
		const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(event, key);
		if (descriptor) {
			Object.defineProperty(clone, key, descriptor);
		}
	}
	return clone;
}

function storeSupportsOutboxManagementTransactions(store: StoreAdapter) {
	if (store.kind === 'datastore') return false;
	return typeof store.transaction === 'function' && store.capabilities?.transaction === true;
}

function storeSupportsOutboxLeaseTransactions(store: StoreAdapter) {
	return typeof store.transaction === 'function' &&
		store.capabilities?.transaction === true &&
		store.capabilities.transactionConflictDetection === true;
}

function isStoreOutboxLeaseClaimConflict(store: StoreAdapter, error: unknown) {
	if (error instanceof ActiveTsConflictError || error instanceof ActiveTsNotFoundError) return true;
	if (store.kind !== 'datastore' || !error || typeof error !== 'object' || Array.isArray(error)) return false;
	const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(error, 'code');
	if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return false;
	return descriptor.value === 10 || descriptor.value === 'aborted' || descriptor.value === 'ABORTED';
}

function outboxListQueryPlan(options: { limit?: number; cursor?: string } = {}): QueryPlan {
	const plan: QueryPlan = {
		where: [],
		or: [],
		sort: [
			{ field: 'createdAt', direction: 'asc' },
			{ field: 'sequence', direction: 'asc' },
			{ field: 'id', direction: 'asc' }
		],
		include: []
	};
	if (options.limit !== undefined) plan.limit = options.limit;
	if (options.cursor !== undefined) plan.cursor = options.cursor;
	return plan;
}

function withStoreOutboxSequence(event: OutboxEvent): OutboxEvent {
	return {
		...event,
		sequence: event.sequence ?? nextStoreOutboxSequence(),
		version: event.version ?? 0
	};
}

function withOutboxLease(event: OutboxEvent, leaseToken: string, leaseExpiresAt: string): OutboxEvent {
	return {
		...event,
		version: outboxEventVersion(event) + 1,
		leaseToken,
		leaseExpiresAt
	};
}

function withoutOutboxLease(event: OutboxEvent): OutboxEvent {
	const next: OutboxEvent = {
		...event,
		version: outboxEventVersion(event) + 1
	};
	delete next.leaseToken;
	delete next.leaseExpiresAt;
	return next;
}

function outboxExpectedVersionOption(event: OutboxEvent) {
	return event.version === undefined ? undefined : { expectedVersion: event.version };
}

function outboxEventVersion(event: OutboxEvent) {
	return event.version ?? 0;
}

function isOutboxLeaseActive(event: OutboxEvent, now: Date) {
	if (event.leaseToken === undefined || event.leaseExpiresAt === undefined) return false;
	return dateParse(event.leaseExpiresAt) > dateTime(now);
}

function isOutboxLeaseCurrent(event: OutboxEvent, leaseToken: string, now: Date) {
	return event.leaseToken === leaseToken && isOutboxLeaseActive(event, now);
}

function isOutboxSnapshotCurrent(current: OutboxEvent, snapshot: OutboxEvent) {
	return current.id === snapshot.id &&
		current.model === snapshot.model &&
		current.operation === snapshot.operation &&
		current.createdAt === snapshot.createdAt &&
		current.sequence === snapshot.sequence &&
		current.version === snapshot.version &&
		current.leaseToken === snapshot.leaseToken &&
		current.leaseExpiresAt === snapshot.leaseExpiresAt &&
		current.modelIdentity === snapshot.modelIdentity &&
		current.modelDatastoreProjectId === snapshot.modelDatastoreProjectId &&
		current.dataEncoding === snapshot.dataEncoding &&
		outboxDatastoreAncestorMatches(current.modelDatastoreAncestor, snapshot.modelDatastoreAncestor) &&
		outboxEntityIdMatches(current.modelId, snapshot.modelId) &&
		isDeepStrictEqual(current.data, snapshot.data);
}

function isOutboxRequeueInsertCurrent(current: OutboxEvent, inserted: OutboxEvent) {
	return current.id === inserted.id &&
		current.model === inserted.model &&
		current.operation === inserted.operation &&
		current.createdAt === inserted.createdAt &&
		current.sequence === inserted.sequence &&
		current.version === inserted.version &&
		current.leaseToken === inserted.leaseToken &&
		current.leaseExpiresAt === inserted.leaseExpiresAt &&
		current.modelIdentity === inserted.modelIdentity &&
		current.modelDatastoreProjectId === inserted.modelDatastoreProjectId &&
		current.dataEncoding === inserted.dataEncoding &&
		outboxDatastoreAncestorMatches(current.modelDatastoreAncestor, inserted.modelDatastoreAncestor) &&
		outboxEntityIdMatches(current.modelId, inserted.modelId) &&
		isDeepStrictEqual(current.data, inserted.data);
}

function outboxEntityIdMatches(left: EntityId | undefined, right: EntityId | undefined) {
	if (left === undefined || right === undefined) return left === right;
	return entityIdKey(left) === entityIdKey(right);
}

function outboxDatastoreAncestorMatches(left: DatastoreKey | undefined, right: DatastoreKey | undefined) {
	if (left === undefined || right === undefined) return left === right;
	return datastoreKeyIdentity(left) === datastoreKeyIdentity(right);
}

function outboxEntityOrderKeys(event: OutboxEvent) {
	const keys: string[] = [];
	if (event.modelIdentity !== undefined) keys[keys.length] = `${event.model}:${event.modelIdentity}`;
	if (event.modelDatastoreAncestor !== undefined && event.modelId !== undefined) {
		const ancestorIdentity = datastoreSearchDocumentIdentity(
			{ name: event.model },
			event.modelId,
			event.modelDatastoreAncestor
		);
		keys[keys.length] = `${event.model}:${ancestorIdentity}`;
	}
	if (keys.length) return keys;
	if (event.modelId === undefined) return [`event:${event.id}`];
	return [`${event.model}:${entityIdKey(event.modelId)}`];
}

function outboxEntityOrderCheckKeys(event: OutboxEvent) {
	const keys = outboxEntityOrderKeys(event);
	const identityOnlyAlias = outboxIdentityOnlyDatastoreCheckAliasKey(event);
	if (identityOnlyAlias !== undefined) appendOutboxEntityOrderKey(keys, identityOnlyAlias);
	const namespaceLessAncestorAlias = outboxNamespaceLessDatastoreAncestorCheckAliasKey(event);
	if (namespaceLessAncestorAlias !== undefined) appendOutboxEntityOrderKey(keys, namespaceLessAncestorAlias);
	return keys;
}

function outboxEntityOrderBlockKeys(event: OutboxEvent) {
	const keys = outboxEntityOrderKeys(event);
	const identityOnlyAlias = outboxIdentityOnlyDatastoreBlockAliasKey(event);
	if (identityOnlyAlias !== undefined) appendOutboxEntityOrderKey(keys, identityOnlyAlias);
	const namespaceLessAncestorAlias = outboxNamespaceLessDatastoreAncestorBlockAliasKey(event);
	if (namespaceLessAncestorAlias !== undefined) appendOutboxEntityOrderKey(keys, namespaceLessAncestorAlias);
	return keys;
}

function outboxIdentityOnlyDatastoreCheckAliasKey(event: OutboxEvent) {
	return outboxIsDatastoreIdentityOnlyEvent(event)
		? outboxDatastoreAliasKey(event, 'namespace-less-ancestor')
		: undefined;
}

function outboxIdentityOnlyDatastoreBlockAliasKey(event: OutboxEvent) {
	return outboxIsDatastoreIdentityOnlyEvent(event)
		? outboxDatastoreAliasKey(event, 'identity-only')
		: undefined;
}

function outboxNamespaceLessDatastoreAncestorCheckAliasKey(event: OutboxEvent) {
	return outboxIsNamespaceLessDatastoreAncestorEvent(event)
		? outboxDatastoreAliasKey(event, 'identity-only')
		: undefined;
}

function outboxNamespaceLessDatastoreAncestorBlockAliasKey(event: OutboxEvent) {
	return outboxIsNamespaceLessDatastoreAncestorEvent(event)
		? outboxDatastoreAliasKey(event, 'namespace-less-ancestor')
		: undefined;
}

function outboxIsDatastoreIdentityOnlyEvent(event: OutboxEvent) {
	return event.modelId !== undefined &&
		event.modelDatastoreAncestor === undefined &&
		event.modelIdentity !== undefined &&
		event.modelIdentity.startsWith('datastore:');
}

function outboxIsNamespaceLessDatastoreAncestorEvent(event: OutboxEvent) {
	return event.modelId !== undefined &&
		event.modelDatastoreAncestor !== undefined &&
		event.modelDatastoreAncestor.namespace === undefined;
}

function outboxDatastoreAliasKey(event: OutboxEvent, kind: 'identity-only' | 'namespace-less-ancestor') {
	return `${event.model}:datastore-${kind}-namespace-alias:${entityIdKey(event.modelId!)}`;
}

function appendOutboxEntityOrderKey(keys: string[], key: string) {
	for (let index = 0; index < keys.length; index++) {
		if (keys[index] === key) return;
	}
	keys[keys.length] = key;
}

function outboxEntityOrderKeysBlocked(blockedEntityKeys: Set<string>, orderKeys: string[]) {
	for (let index = 0; index < orderKeys.length; index++) {
		if (SET_HAS.call(blockedEntityKeys, orderKeys[index])) return true;
	}
	return false;
}

function blockOutboxEntityOrderKeys(blockedEntityKeys: Set<string>, orderKeys: string[]) {
	for (let index = 0; index < orderKeys.length; index++) {
		SET_ADD.call(blockedEntityKeys, orderKeys[index]);
	}
}

function nextStoreOutboxSequence() {
	storeOutboxSequence = storeOutboxSequence >= Number.MAX_SAFE_INTEGER ? 1 : storeOutboxSequence + 1;
	return `${Date.now().toString(36).padStart(10, '0')}:${storeOutboxSequence
		.toString(36)
		.padStart(10, '0')}:${randomUUID()}`;
}

export type OutboxPluginOptions = {
	outbox: OutboxAdapter;
	includeData?: boolean;
	id?: () => string;
	allowUnsafeTransactionDeferredAppend?: boolean;
};

export function createOutboxPlugin(options: OutboxPluginOptions): ActiveTsPlugin {
	options = validateOutboxPluginOptions(options);
	const append = async (
		context: unknown,
		model: unknown,
		modelId: EntityId | undefined,
		operation: OutboxOperation,
		data: any,
		target?: unknown
	) => {
		const modelName = outboxHookModelName(model);
		if (!modelName) return;
		const resolvedMeta = resolvedOutboxMeta(model);
		const datastoreIdentity = outboxDatastoreIdentity(
			resolvedMeta,
			modelId,
			data,
			target,
			datastoreNamespaceForContext(context, resolvedMeta)
		);
		const eventPayload = options.includeData
			? await committedOutboxPayload(context, model, modelId, operation, data)
			: { data: undefined, dataEncoding: undefined };
		const event = sanitizeOutboxEvent({
			id: assertSafeCacheKey(options.id?.() ?? randomUUID(), 'outbox event id'),
			model: modelName,
			modelId,
			modelIdentity: datastoreIdentity.modelIdentity,
			modelDatastoreAncestor: datastoreIdentity.modelDatastoreAncestor,
			modelDatastoreProjectId: datastoreProjectIdForContext(context, resolvedMeta),
			operation,
			data: eventPayload.data,
			dataEncoding: eventPayload.dataEncoding,
			createdAt: dateIsoString(new Date())
		}, { requireModelId: false });
		const activeContext = context as ActiveContext;
		if (activeContext instanceof ActiveContext && activeContext.isInTransaction()) {
			if (options.outbox.appendTransactional) {
				await options.outbox.appendTransactional(activeContext, event);
				return;
			}
			const unsafeDeferredStore = resolvedMeta
				? outboxTransactionDeferredAppendUnsafeStore(activeContext, resolvedMeta)
				: undefined;
			if (options.allowUnsafeTransactionDeferredAppend !== true && unsafeDeferredStore !== undefined) {
				throw new ActiveTsConfigurationError(
					`Outbox plugin cannot safely defer appends until after a ${unsafeDeferredStore} transaction commit because commit failures can leave the transaction outcome unknown. Use an outbox adapter with appendTransactional(), such as StoreOutboxAdapter, or pass allowUnsafeTransactionDeferredAppend: true to acknowledge missing-event risk.`
				);
			}
			await activeContext.afterCommitInternal(() => options.outbox.append(event));
			return;
		}
		await options.outbox.append(event);
	};

	const plugin: ActiveTsPlugin = {
		name: 'outbox',
		hooks: {
			afterCreate: (payload) => append(payload.context, payload.model, payload.id, 'create', payload.data, payload.target),
			afterUpdate: (payload) => append(payload.context, payload.model, payload.id, 'update', payload.data, payload.target),
			afterDelete: (payload) => append(payload.context, payload.model, payload.id, 'delete', payload.data, payload.target)
		}
	};
	if (options.outbox.setup) {
		plugin.setup = (context) => {
			if (!(context instanceof ActiveContext)) {
				throw new ActiveTsConfigurationError('Outbox plugin setup context must be an ActiveContext.');
			}
			return options.outbox.setup!(context);
		};
	}
	return plugin;
}

function outboxHookModelName(model: unknown) {
	if (model === undefined || model === null) return undefined;
	if (typeof model !== 'object' || Array.isArray(model)) {
		throw new ActiveTsValidationError('Outbox hook model must be a plain object.');
	}
	return assertSafeSchemaIdentifier(
		ownOptionValue(model as Record<string, unknown>, 'name', 'Outbox hook model'),
		'Outbox hook model name'
	);
}

async function committedOutboxPayload(
	context: unknown,
	model: unknown,
	modelId: EntityId | undefined,
	operation: OutboxOperation,
	fallbackData: any
) {
	if (operation === 'delete') return { data: undefined, dataEncoding: undefined };
	const resolvedMeta = resolvedOutboxMeta(model);
	if (context instanceof ActiveContext && modelId !== undefined && resolvedMeta) {
		if (!outboxDirectIdReadUnsafe(resolvedMeta)) {
			const raw = await contextInternalStore(context, resolvedMeta.store).get(resolvedMeta, modelId);
			if (raw !== null && raw !== undefined) {
				if (requiresStoredOutboxPayload(resolvedMeta)) {
					return { data: cloneSafeData(raw), dataEncoding: 'stored' as const };
				}
				return { data: context.validateRead(resolvedMeta, raw, { partial: true }), dataEncoding: 'public' as const };
			}
		}
		if (requiresStoredOutboxPayload(resolvedMeta)) {
			if (fallbackData === undefined) {
				throw new ActiveTsConfigurationError(
					`Outbox payload for ${resolvedMeta.name}:${String(modelId)} requires stored encoding but no committed row was available.`
				);
			}
			return { data: context.encodeWrite(resolvedMeta, fallbackData), dataEncoding: 'stored' as const };
		}
	}
	return { data: fallbackData, dataEncoding: fallbackData === undefined ? undefined : 'public' as const };
}

function outboxDirectIdReadUnsafe(model: ResolvedModelMeta) {
	return model.datastore?.ancestor !== undefined;
}

function outboxTransactionDeferredAppendUnsafeStore(
	context: ActiveContext,
	meta: ResolvedModelMeta
): 'Datastore' | 'Firestore' | undefined {
	const store = contextInternalStore(context.rootContext(), meta.store);
	const sourceChain = storeAdapterSourceChain(store);
	for (let index = 0; index < sourceChain.length; index++) {
		const source = sourceChain[index] as StoreAdapter;
		if (source?.kind === 'datastore') return 'Datastore';
		if (source?.kind === 'firestore') return 'Firestore';
	}
	return undefined;
}

function outboxDatastoreIdentity(
	model: ResolvedModelMeta | undefined,
	modelId: EntityId | undefined,
	data: any,
	target?: unknown,
	namespace?: string
) {
	if (!model?.datastore?.ancestor || modelId === undefined) {
		return { modelIdentity: undefined, modelDatastoreAncestor: undefined };
	}
	const ancestor = outboxTargetDatastoreAncestor(target) ?? (
		data === undefined ? undefined : model.datastore.ancestor({ model, id: modelId, data })
	);
	if (ancestor === undefined && data === undefined) {
		return { modelIdentity: undefined, modelDatastoreAncestor: undefined };
	}
	if (ancestor === undefined) {
		throw new ActiveTsConfigurationError(
			`Outbox event for Datastore model "${model.name}" cannot be identified without ancestor metadata.`
		);
	}
	const safeAncestor = datastoreKeyWithNamespace(
		ancestor,
		namespace,
		`Outbox event Datastore ancestor for "${model.name}"`
	);
	return {
		modelIdentity: datastoreSearchDocumentIdentity(model, modelId, safeAncestor),
		modelDatastoreAncestor: safeAncestor
	};
}

function outboxTargetDatastoreAncestor(target: unknown) {
	if (!target || typeof target !== 'object' || Array.isArray(target)) return undefined;
	const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(target, MODEL_DATASTORE_WRITE_ANCESTOR);
	if (!descriptor) return undefined;
	if (!('value' in descriptor)) {
		throw new ActiveTsValidationError('Outbox target Datastore ancestor must be a data property.');
	}
	return descriptor.value === undefined
		? undefined
		: normalizeDatastoreKey(descriptor.value, 'Outbox target Datastore ancestor');
}

function requiresStoredOutboxPayload(model: ResolvedModelMeta) {
	return MAP_SIZE.call(model.fieldCodecs) > 0 || MAP_SIZE.call(model.fieldTypes) > 0;
}

function resolvedOutboxMeta(model: unknown): ResolvedModelMeta | undefined {
	if (model === undefined || model === null || typeof model !== 'object' || Array.isArray(model)) return undefined;
	const record = model as Record<string, unknown>;
	if (!OBJECT_HAS_OWN(record, 'store') && !OBJECT_HAS_OWN(record, 'idField')) return undefined;
	const store = ownOptionValue(record, 'store', 'Outbox hook model');
	const idField = ownOptionValue(record, 'idField', 'Outbox hook model');
	if (typeof store !== 'string' || typeof idField !== 'string') return undefined;
	const fieldCodecs = ownOptionValue(record, 'fieldCodecs', 'Outbox hook model');
	const fieldTypes = ownOptionValue(record, 'fieldTypes', 'Outbox hook model');
	if (!(fieldCodecs instanceof Map)) {
		throw new ActiveTsConfigurationError('Outbox hook model fieldCodecs must be a Map.');
	}
	if (!(fieldTypes instanceof Map)) {
		throw new ActiveTsConfigurationError('Outbox hook model fieldTypes must be a Map.');
	}
	return model as ResolvedModelMeta;
}

function validateOutboxPluginOptions(options: OutboxPluginOptions) {
	if (!options || typeof options !== 'object' || Array.isArray(options)) {
		throw new ActiveTsConfigurationError('Outbox plugin options must be an object.');
	}
	assertPlainOptions(options, 'Outbox plugin options');
	const record = options as Record<string, unknown>;
	assertNoSymbolOptions(record, 'Outbox plugin options');
	assertKnownOptions(record, OUTBOX_PLUGIN_OPTION_KEYS, 'Outbox plugin options');
	const outbox = normalizeOutboxAdapter(ownOptionValue(record, 'outbox', 'Outbox plugin options'), 'Outbox plugin outbox', false);
	const includeData = ownOptionValue(record, 'includeData', 'Outbox plugin options');
	const id = ownOptionValue(record, 'id', 'Outbox plugin options');
	const allowUnsafeTransactionDeferredAppend = ownOptionValue(
		record,
		'allowUnsafeTransactionDeferredAppend',
		'Outbox plugin options'
	);
	if (includeData !== undefined && typeof includeData !== 'boolean') {
		throw new ActiveTsConfigurationError('Outbox plugin includeData must be a boolean.');
	}
	if (id !== undefined && typeof id !== 'function') {
		throw new ActiveTsConfigurationError('Outbox plugin id must be a function.');
	}
	if (
		allowUnsafeTransactionDeferredAppend !== undefined &&
		typeof allowUnsafeTransactionDeferredAppend !== 'boolean'
	) {
		throw new ActiveTsConfigurationError('Outbox plugin allowUnsafeTransactionDeferredAppend must be a boolean.');
	}
	return {
		outbox,
		includeData: includeData as boolean | undefined,
		id: id as (() => string) | undefined,
		allowUnsafeTransactionDeferredAppend: allowUnsafeTransactionDeferredAppend as boolean | undefined
	};
}

export type SearchSyncWorkerOptions = {
	outbox: OutboxAdapter;
	search: SearchAdapter;
	models: ModelConstructor[];
	context?: ActiveContext;
	adapter?: string;
	batchSize?: number;
	allowUnsafeDrainFallback?: boolean;
	allowUnsafeIdentityOnlyDatastoreDelete?: boolean;
};

export async function runSearchSyncWorker(options: SearchSyncWorkerOptions) {
	const activeOptions = validateSearchSyncWorkerOptions(options);
	assertOutsideActiveTransaction('run search sync workers');
	activeOptions.context?.assertOutsideTransaction('run search sync workers');
	const modelByName = new Map<string, ModelConstructor>();
	for (const model of activeOptions.models) {
		const name = activeOptions.context ? activeOptions.context.meta(model).name : outboxModelName(model);
		if (MAP_HAS.call(modelByName, name)) {
			throw new ActiveTsConfigurationError(
				`Outbox search sync models contain duplicate model name "${name}".`
			);
		}
		MAP_SET.call(modelByName, name, model);
	}
	let events: OutboxEvent[];
	let drained: unknown;
	let drainRecoverySnapshot: OutboxDrainRecoverySnapshot | undefined;
	const batchOptions = outboxBatchOptions(activeOptions.batchSize);
	const leaseOutboxEvents = activeOptions.outbox.lease;
	let usesLease = typeof leaseOutboxEvents === 'function';
	let leaseFallbackRequiresUnsafeOptIn = false;
	if (usesLease && activeOptions.outbox.supportsExclusiveLease) {
		usesLease = await activeOptions.outbox.supportsExclusiveLease();
		leaseFallbackRequiresUnsafeOptIn = !usesLease;
	}
	if (usesLease) {
		if (!leaseOutboxEvents) {
			throw new ActiveTsConfigurationError('Outbox adapter does not support lease().');
		}
		assertSearchSyncLeaseContract(activeOptions.outbox, 'Outbox search sync outbox');
		drained = await leaseOutboxEvents(batchOptions);
	} else {
		if (leaseFallbackRequiresUnsafeOptIn && activeOptions.allowUnsafeDrainFallback !== true) {
			throw new ActiveTsConfigurationError(
				'Outbox search sync cannot safely drain an outbox after lease() reported non-exclusive leases. Pass allowUnsafeDrainFallback: true to acknowledge crash-loss risk and use drain()/requeue() fallback.'
			);
		}
		if (!activeOptions.outbox.drain) {
			throw new ActiveTsConfigurationError('Outbox adapter does not support drain().');
		}
		if (!activeOptions.outbox.requeue) {
			throw new ActiveTsConfigurationError(
				'Outbox search sync outbox.drain requires Outbox search sync outbox.requeue for ordered search sync failure recovery.'
			);
		}
		drainRecoverySnapshot = await captureOutboxDrainRecoverySnapshot(activeOptions.outbox);
		try {
			drained = await activeOptions.outbox.drain!(batchOptions);
		} catch (error) {
			const requeueErrors = await recoverFailedOutboxDrain(activeOptions.outbox, drainRecoverySnapshot);
			if (requeueErrors.length) {
				throw new AggregateError(
					[error, ...requeueErrors],
					`Outbox search sync drain failed and recovery failed: ${safeErrorMessage(error)}`
				);
			}
			throw error;
		}
	}
	try {
		events = sanitizeOutboxDrainResult(drained);
	} catch (error) {
		const requeueErrors = usesLease
			? Array.isArray(drained)
				? await releaseOutboxEvents(activeOptions.outbox, drainResultEntriesForRequeue(drained))
				: []
			: Array.isArray(drained)
				? await requeueOutboxEvents(activeOptions.outbox, drainResultEntriesForRequeue(drained))
				: drainRecoverySnapshot
					? await recoverFailedOutboxDrain(activeOptions.outbox, drainRecoverySnapshot)
					: [];
		if (requeueErrors.length) {
			throw new AggregateError(
				[error, ...requeueErrors],
				`Outbox search sync failed and ${usesLease ? 'release' : 'requeue'} failed: ${safeErrorMessage(error)}`
			);
		}
		throw error;
	}
	if (activeOptions.batchSize !== undefined && events.length > activeOptions.batchSize) {
		const overflow = copyEvents(events, activeOptions.batchSize);
		const retryErrors = usesLease
			? await releaseOutboxEvents(activeOptions.outbox, overflow)
			: await requeueOutboxEvents(activeOptions.outbox, overflow);
		if (retryErrors.length) {
			const recoveryErrors = await recoverOverflowedOutboxBatch(
				activeOptions.outbox,
				events,
				usesLease,
				drainRecoverySnapshot
			);
			throw new AggregateError(
				[...retryErrors, ...recoveryErrors],
				recoveryErrors.length
					? `Outbox search sync ${usesLease ? 'release' : 'requeue'} failed for events beyond batchSize and recovery failed.`
				: `Outbox search sync ${usesLease ? 'release' : 'requeue'} failed for events beyond batchSize; drained events were recovered.`
			);
		}
		events = copyEvents(events, 0, activeOptions.batchSize);
	}
	let index = 0;
	let processed = 0;
	try {
		eventLoop: for (; index < events.length; index++) {
			const event = sanitizeOutboxEvent(events[index], { requireModelId: true });
			if (!(await ensureSearchSyncLeaseCurrent(activeOptions.outbox, event, usesLease))) continue eventLoop;
			const model = MAP_GET.call(modelByName, event.model) as ModelConstructor | undefined;
			if (!model) {
				throw new ActiveTsConfigurationError(
					`Outbox event "${event.id}" references unregistered model "${event.model}".`
				);
			}
			if (event.modelId === undefined) {
				throw new ActiveTsConfigurationError(`Outbox event "${event.id}" is missing modelId.`);
			}
			const meta = activeOptions.context ? activeOptions.context.meta(model) : legacyOutboxMeta(model, event.model);
			assertOutboxDatastoreProjectId(activeOptions.context, meta, event);
			const searchRoutes = resolveSearchSyncAdapterRoutes(
				activeOptions.context,
				meta,
				activeOptions.adapter,
				activeOptions.search,
				activeOptions.searchSource
			);
			for (let routeIndex = 0; routeIndex < searchRoutes.length; routeIndex++) {
				const searchRoute = searchRoutes[routeIndex];
				const search = searchRoute.adapter;
				const searchMeta = withDatastoreSearchNamespace(
					withSearchIndexesForAdapter(
						meta,
						searchRoute.name,
						searchRoute.indexKind
					),
					datastoreNamespaceForContext(activeOptions.context, meta)
				);
				if (event.operation === 'delete') {
					let data = event.data;
					if (data !== undefined) {
						if (event.dataEncoding === 'stored') {
							if (!activeOptions.context) {
								throw new ActiveTsConfigurationError(
									`Outbox event "${event.id}" stores encoded data and requires a context for search indexing.`
								);
							}
							data = activeOptions.context.validateRead(meta, data);
						} else if (activeOptions.context) {
							data = activeOptions.context.validateDecodedRead(meta, data);
						}
						data = normalizeSearchIndexEventData(event, meta, data);
					}
					const searchEventMeta = withSearchDocumentIdentity(
						searchMeta,
						outboxEventSearchDocumentIdentity(
							event,
							meta,
							data,
							datastoreNamespaceForContext(activeOptions.context, meta),
							{
								allowUnsafeIdentityOnlyDatastoreDelete: activeOptions.allowUnsafeIdentityOnlyDatastoreDelete
							}
						)
					);
					if (!(await ensureSearchSyncLeaseCurrent(activeOptions.outbox, event, usesLease))) continue eventLoop;
					await runSearchIndexHook(activeOptions.context, 'beforeIndex', searchEventMeta, event.modelId, undefined, 'index-delete');
					if (!(await ensureSearchSyncLeaseCurrent(activeOptions.outbox, event, usesLease))) continue eventLoop;
					await search.delete(searchEventMeta, event.modelId);
					if (!(await ensureSearchSyncLeaseCurrent(activeOptions.outbox, event, usesLease))) continue eventLoop;
					await runSearchIndexHook(activeOptions.context, 'afterIndex', searchEventMeta, event.modelId, undefined, 'index-delete');
					if (!(await ensureSearchSyncLeaseCurrent(activeOptions.outbox, event, usesLease))) continue eventLoop;
				} else {
					let data = event.data;
					let searchEventMeta = searchMeta;
					if (data === undefined && activeOptions.context) {
						const raw = await loadSearchSyncEventData(activeOptions.context, meta, event);
						const loaded = activeOptions.context.instantiate(model, raw);
						data = (loaded as any)?.data;
						if (data === undefined) {
							searchEventMeta = withSearchDocumentIdentity(
								searchMeta,
								outboxEventSearchDocumentIdentity(
									event,
									meta,
									undefined,
									datastoreNamespaceForContext(activeOptions.context, meta),
									{
										allowUnsafeIdentityOnlyDatastoreDelete: activeOptions.allowUnsafeIdentityOnlyDatastoreDelete
									}
								)
							);
							if (!(await ensureSearchSyncLeaseCurrent(activeOptions.outbox, event, usesLease))) continue eventLoop;
							await runSearchIndexHook(activeOptions.context, 'beforeIndex', searchEventMeta, event.modelId, undefined, 'index-delete');
							if (!(await ensureSearchSyncLeaseCurrent(activeOptions.outbox, event, usesLease))) continue eventLoop;
							await search.delete(searchEventMeta, event.modelId);
							if (!(await ensureSearchSyncLeaseCurrent(activeOptions.outbox, event, usesLease))) continue eventLoop;
							await runSearchIndexHook(activeOptions.context, 'afterIndex', searchEventMeta, event.modelId, undefined, 'index-delete');
							if (!(await ensureSearchSyncLeaseCurrent(activeOptions.outbox, event, usesLease))) continue eventLoop;
							continue;
						}
					}
					if (data === undefined) {
						throw new ActiveTsConfigurationError(`Outbox event "${event.id}" is missing data for search indexing.`);
					}
					if (!activeOptions.context && searchAdapterUsesProjection(activeOptions.searchSource)) {
						throw new ActiveTsConfigurationError(
							`Outbox event "${event.id}" requires a context for search indexing with a projecting search adapter.`
						);
					}
					if (event.dataEncoding === 'stored') {
						if (!activeOptions.context) {
							throw new ActiveTsConfigurationError(
								`Outbox event "${event.id}" stores encoded data and requires a context for search indexing.`
							);
						}
						data = activeOptions.context.validateRead(meta, data);
					} else if (activeOptions.context) {
						data = activeOptions.context.validateDecodedRead(meta, data);
					}
					data = normalizeSearchIndexEventData(event, meta, data, { requireDatastoreAncestorFields: true });
					searchEventMeta = withSearchDocumentIdentity(
						searchMeta,
						outboxEventSearchDocumentIdentity(
							event,
							meta,
							data,
							datastoreNamespaceForContext(activeOptions.context, meta),
							{
								allowUnsafeIdentityOnlyDatastoreDelete: activeOptions.allowUnsafeIdentityOnlyDatastoreDelete
							}
						)
					);
					const adapterData = cloneSafeDataObjectWithoutActiveEntityKey(data, `Outbox event "${event.id}" search index data`);
					if (!(await ensureSearchSyncLeaseCurrent(activeOptions.outbox, event, usesLease))) continue eventLoop;
					await runSearchIndexHook(activeOptions.context, 'beforeIndex', searchEventMeta, event.modelId, adapterData, 'index');
					if (!(await ensureSearchSyncLeaseCurrent(activeOptions.outbox, event, usesLease))) continue eventLoop;
					await search.index(searchEventMeta, event.modelId, adapterData);
					if (!(await ensureSearchSyncLeaseCurrent(activeOptions.outbox, event, usesLease))) continue eventLoop;
					await runSearchIndexHook(activeOptions.context, 'afterIndex', searchEventMeta, event.modelId, adapterData, 'index');
					if (!(await ensureSearchSyncLeaseCurrent(activeOptions.outbox, event, usesLease))) continue eventLoop;
				}
			}
			if (usesLease) await ackOutboxEvents(activeOptions.outbox, [event]);
			processed++;
		}
	} catch (error) {
		const remaining = copyEvents(events, isStaleSearchSyncLeaseReleaseError(error) ? index + 1 : index);
		const retryErrors = usesLease
			? await releaseOutboxEvents(activeOptions.outbox, remaining)
			: await requeueOutboxEvents(activeOptions.outbox, remaining);
		if (retryErrors.length) {
			throw new AggregateError(
				[error, ...retryErrors],
				`Outbox search sync failed and ${usesLease ? 'release' : 'requeue'} failed: ${safeErrorMessage(error)}`
			);
		}
		throw error;
	}
	return processed;
}

function copyEvents<T>(events: readonly T[], start = 0, end = events.length) {
	const result: T[] = [];
	for (let index = start; index < end && index < events.length; index++) {
		result[result.length] = events[index];
	}
	return result;
}

function copyEventsReversed<T>(events: readonly T[]) {
	const result: T[] = [];
	for (let index = events.length - 1; index >= 0; index--) {
		result[result.length] = events[index];
	}
	return result;
}

function resolveSearchSyncAdapterRoutes(
	context: ActiveContext | undefined,
	meta: ResolvedModelMeta,
	requested: string | undefined,
	search: SearchAdapter,
	searchSource: SearchAdapter
) {
	if (!context || requested !== undefined) {
		const route = requested ?? meta.search ?? search.kind;
		return [assertSearchSyncRouteHasIndexes(meta, searchSyncAdapterForRoute(context, meta, route, search, searchSource))];
	}
	const fallbackRoute = meta.search ?? search.kind;
	let registeredRoutes: ReturnType<ActiveContext['searchAdapterSchemaRoutesFor']>;
	try {
		registeredRoutes = context.searchAdapterSchemaRoutesFor(meta);
		const seenRoutes = new Set<string>();
		for (let index = 0; index < registeredRoutes.length; index++) {
			SET_ADD.call(seenRoutes, registeredRoutes[index].name);
			SET_ADD.call(seenRoutes, registeredRoutes[index].indexKind);
		}
		for (let index = 0; index < meta.searchIndexes.length; index++) {
			const adapterName = meta.searchIndexes[index].adapter;
			if (adapterName === undefined || SET_HAS.call(seenRoutes, adapterName)) continue;
			const route = context.searchAdapterRouteFor(meta, '', {}, adapterName);
			registeredRoutes[registeredRoutes.length] = route;
			SET_ADD.call(seenRoutes, adapterName);
			SET_ADD.call(seenRoutes, route.indexKind);
		}
	} catch (error) {
		if (safeErrorMessage(error) === `Search adapter "${fallbackRoute}" is not registered.`) {
			assertProvidedSearchAdapterMatchesRoute(fallbackRoute, search, searchIndexAdapterKind(search, fallbackRoute));
			return [{ name: fallbackRoute, indexKind: searchIndexAdapterKind(search, fallbackRoute), adapter: search }];
		}
		throw error;
	}
	let providedAdapterMatchesRegisteredRoute = false;
	const routes: Array<{ name: string; indexKind: string; adapter: SearchAdapter }> = [];
	for (let index = 0; index < registeredRoutes.length; index++) {
		const registered = registeredRoutes[index];
		if (isRegisteredSearchAdapterSource(registered.adapter, searchSource)) {
			providedAdapterMatchesRegisteredRoute = true;
		}
		const routedMeta = withSearchIndexesForAdapter(meta, registered.name, registered.indexKind);
		if (!routedMeta.searchIndexes.length) continue;
		routes[routes.length] = {
			name: registered.name,
			indexKind: registered.indexKind,
			adapter: registered.adapter
		};
	}
	if (!providedAdapterMatchesRegisteredRoute) {
		throw new ActiveTsConfigurationError(
			'Outbox search sync adapter does not match any registered search adapter route.'
		);
	}
	if (routes.length === 1 && isRegisteredSearchAdapterSource(routes[0].adapter, searchSource)) {
		return [{
			name: routes[0].name,
			indexKind: routes[0].indexKind,
			adapter: searchSyncExecutionAdapter(routes[0].adapter)
		}];
	}
	return routes;
}

type OutboxDrainRecoverySnapshot =
	| { captured: true; value: unknown }
	| { captured: false; error?: unknown };

async function captureOutboxDrainRecoverySnapshot(outbox: OutboxAdapter): Promise<OutboxDrainRecoverySnapshot> {
	if (!outbox.list) return { captured: false };
	try {
		return { captured: true, value: await outbox.list() };
	} catch (error) {
		return { captured: false, error };
	}
}

async function recoverFailedOutboxDrain(
	outbox: OutboxAdapter,
	snapshot: OutboxDrainRecoverySnapshot
) {
	if (!snapshot.captured) return snapshot.error === undefined ? [] : [snapshot.error];
	if (!outbox.list) return [];
	const errors: unknown[] = [];
	let before: OutboxEvent[];
	let after: OutboxEvent[];
	try {
		before = sanitizeOutboxDrainResult(snapshot.value);
	} catch (error) {
		return [error];
	}
	try {
		after = sanitizeOutboxDrainResult(await outbox.list());
	} catch (error) {
		return [error];
	}
	const currentIds = new Set<string>();
	for (const event of after) {
		try {
			SET_ADD.call(currentIds, sanitizeOutboxEvent(event, { requireModelId: false }).id);
		} catch (error) {
			errors.push(error);
		}
	}
	if (errors.length) return errors;
	const missing: OutboxEvent[] = [];
	let firstCurrentIndex = -1;
	let lastCurrentIndex = -1;
	for (let index = 0; index < before.length; index++) {
		const event = before[index];
		try {
			const id = sanitizeOutboxEvent(event, { requireModelId: false }).id;
			if (SET_HAS.call(currentIds, id)) {
				if (firstCurrentIndex < 0) firstCurrentIndex = index;
				lastCurrentIndex = index;
			} else {
				missing[missing.length] = event;
			}
		} catch {
			missing[missing.length] = event;
		}
	}
	if (firstCurrentIndex >= 0) {
		const prefix: OutboxEvent[] = [];
		for (let index = 0; index < firstCurrentIndex; index++) {
			const event = before[index];
			try {
				if (!SET_HAS.call(currentIds, sanitizeOutboxEvent(event, { requireModelId: false }).id)) {
					prefix[prefix.length] = event;
				}
			} catch {
				prefix[prefix.length] = event;
			}
		}
		const suffix: OutboxEvent[] = [];
		for (let index = lastCurrentIndex + 1; index < before.length; index++) {
			const event = before[index];
			try {
				if (!SET_HAS.call(currentIds, sanitizeOutboxEvent(event, { requireModelId: false }).id)) {
					suffix[suffix.length] = event;
				}
			} catch {
				suffix[suffix.length] = event;
			}
		}
		const middleMissing: OutboxEvent[] = [];
		for (let index = firstCurrentIndex + 1; index < lastCurrentIndex; index++) {
			const event = before[index];
			try {
				if (!SET_HAS.call(currentIds, sanitizeOutboxEvent(event, { requireModelId: false }).id)) {
					middleMissing[middleMissing.length] = event;
				}
			} catch {
				middleMissing[middleMissing.length] = event;
			}
		}
		const recoveryErrors = await requeueOutboxEvents(outbox, [...prefix, ...middleMissing]);
		recoveryErrors.push(...await appendOutboxEvents(outbox, suffix));
		return recoveryErrors;
	}
	return await requeueOutboxEvents(outbox, missing);
}

async function recoverOverflowedOutboxBatch(
	outbox: OutboxAdapter,
	events: OutboxEvent[],
	usesLease: boolean,
	snapshot: OutboxDrainRecoverySnapshot | undefined
) {
	if (usesLease) return await releaseOutboxEvents(outbox, events);
	if (snapshot) return await recoverFailedOutboxDrain(outbox, snapshot);
	return await requeueOutboxEvents(outbox, events);
}

function normalizeSearchIndexEventData(
	event: OutboxEvent,
	meta: ResolvedModelMeta,
	data: unknown,
	options: { requireDatastoreAncestorFields?: boolean } = {}
) {
	const clean = cloneSafeDataObject(data, `Outbox event "${event.id}" data`);
	const dataId = valueFor(clean, meta.idField);
	if (dataId === undefined) {
		throw new ActiveTsConfigurationError(
			`Outbox event "${event.id}" data is missing id field "${meta.idField}".`
		);
	}
	if (entityIdKey(dataId) !== entityIdKey(event.modelId!)) {
		throw new ActiveTsConfigurationError(
			`Outbox event "${event.id}" data id does not match modelId.`
		);
	}
	if (options.requireDatastoreAncestorFields && !outboxEventPayloadHasAncestorFields(meta, clean)) {
		const fields = meta.datastore?.ancestorFields ?? [];
		let missing: string | undefined;
		for (let index = 0; index < fields.length; index++) {
			const field = fields[index];
			if (valueFor(clean, field) !== undefined) continue;
			missing = field;
			break;
		}
		throw new ActiveTsConfigurationError(
			missing === undefined
				? `Outbox event "${event.id}" data is missing Datastore ancestor metadata.`
				: `Outbox event "${event.id}" data is missing Datastore ancestor metadata field "${missing}".`
		);
	}
	return clean;
}

function outboxEventSearchDocumentIdentity(
	event: OutboxEvent,
	meta: ResolvedModelMeta,
	data?: any,
	namespace?: string,
	options: { allowUnsafeIdentityOnlyDatastoreDelete?: boolean } = {}
) {
	if (!meta.datastore?.ancestor) {
		if (event.modelDatastoreAncestor !== undefined) {
			throw new ActiveTsConfigurationError(
				`Outbox event "${event.id}" for non-Datastore model "${meta.name}" cannot include Datastore ancestor metadata.`
			);
		}
		if (event.modelIdentity !== undefined) {
			throw new ActiveTsConfigurationError(
				`Outbox event "${event.id}" for non-Datastore model "${meta.name}" cannot include model identity metadata.`
			);
		}
		return undefined;
	}
	const dataAncestor = data === undefined
		? undefined
		: outboxEventDataDatastoreAncestor(event, meta, data, namespace, {
			trustEntityKeyOnlyAncestor: event.operation !== 'delete' ||
				outboxEventPayloadHasAncestorFields(meta, data) ||
				event.modelIdentity !== undefined
		});
	const rawAncestor = dataAncestor ?? event.modelDatastoreAncestor;
	if (rawAncestor === undefined) {
		if (
			event.operation === 'delete' &&
			event.modelIdentity !== undefined &&
			options.allowUnsafeIdentityOnlyDatastoreDelete === true
		) {
			return event.modelIdentity;
		}
		throw new ActiveTsConfigurationError(
			`Outbox event "${event.id}" for Datastore model "${meta.name}" is missing Datastore ancestor metadata.`
		);
	}
	const ancestor = datastoreKeyWithNamespace(
		rawAncestor,
		namespace,
		`Outbox event "${event.id}" Datastore ancestor`
	);
	if (
		data !== undefined &&
		dataAncestor !== undefined &&
		event.modelDatastoreAncestor !== undefined &&
		!outboxDatastoreAncestorMatches(
			dataAncestor,
			datastoreKeyWithNamespace(
				event.modelDatastoreAncestor,
				namespace,
				`Outbox event "${event.id}" stored Datastore ancestor`
			)
		)
	) {
		throw new ActiveTsConfigurationError(
			`Outbox event "${event.id}" Datastore ancestor does not match its payload data.`
		);
	}
	const expectedIdentity = datastoreSearchDocumentIdentity(meta, event.modelId!, ancestor);
	if (event.modelIdentity !== undefined && event.modelIdentity !== expectedIdentity) {
		throw new ActiveTsConfigurationError(
			`Outbox event "${event.id}" modelIdentity does not match its Datastore ancestor.`
		);
	}
	return event.modelIdentity ?? expectedIdentity;
}

function outboxEventDataDatastoreAncestor(
	event: OutboxEvent,
	meta: ResolvedModelMeta,
	data: any,
	namespace?: string,
	options: { trustEntityKeyOnlyAncestor?: boolean } = {}
) {
	const payloadAncestor = outboxEventPayloadDatastoreAncestor(event, meta, data, namespace);
	const entityKeyAncestor = payloadAncestor !== undefined || options.trustEntityKeyOnlyAncestor !== false
		? outboxEventEntityKeyDatastoreAncestor(event, meta, data, namespace)
		: undefined;
	if (
		entityKeyAncestor !== undefined &&
		payloadAncestor !== undefined &&
		!outboxDatastoreAncestorMatches(entityKeyAncestor, payloadAncestor)
	) {
		throw new ActiveTsConfigurationError(
			`Outbox event "${event.id}" Datastore ancestor does not match its payload data.`
		);
	}
	return entityKeyAncestor ?? payloadAncestor;
}

function outboxEventEntityKeyDatastoreAncestor(
	event: OutboxEvent,
	meta: ResolvedModelMeta,
	data: any,
	namespace?: string
) {
	if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
	const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(data, ACTIVE_TS_ENTITY_KEY);
	if (descriptor === undefined) return undefined;
	if (!('value' in descriptor)) {
		throw new ActiveTsValidationError(`Outbox event "${event.id}" active-ts entity key must be a data property.`);
	}
	if (descriptor.enumerable) {
		throw new ActiveTsValidationError(`Outbox event "${event.id}" active-ts entity key must be non-enumerable.`);
	}
	const ancestor = datastoreAncestorFromEntityKey(
		descriptor.value,
		meta.name,
		event.modelId!,
		`Outbox event "${event.id}" active-ts entity key`
	);
	return ancestor === undefined
		? undefined
		: datastoreKeyWithNamespace(ancestor, namespace, `Outbox event "${event.id}" active-ts entity key`);
}

function outboxEventPayloadDatastoreAncestor(
	event: OutboxEvent,
	meta: ResolvedModelMeta,
	data: any,
	namespace?: string
) {
	if (!outboxEventPayloadHasAncestorFields(meta, data)) return undefined;
	const ancestor = datastorePayloadResolvedAncestor(
		meta,
		event.modelId!,
		data,
		`Outbox event "${event.id}" payload`
	);
	return ancestor === undefined
		? undefined
		: datastoreKeyWithNamespace(ancestor, namespace, `Outbox event "${event.id}" payload Datastore ancestor`);
}

function outboxEventPayloadHasAncestorFields(meta: ResolvedModelMeta, data: unknown) {
	if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
	if (!meta.datastore?.ancestorFields?.length) return true;
	return datastorePayloadHasAncestorFields(meta, data);
}

function datastoreNamespaceForContext(
	context: ActiveContext | undefined | unknown,
	meta: ResolvedModelMeta | undefined
) {
	if (!(context instanceof ActiveContext) || !meta?.datastore?.ancestor) return undefined;
	return contextInternalStore(context, meta.store).datastoreNamespace;
}

function datastoreProjectIdForContext(
	context: ActiveContext | undefined | unknown,
	meta: ResolvedModelMeta | undefined
) {
	if (!(context instanceof ActiveContext) || !meta) return undefined;
	return contextInternalStore(context, meta.store).datastoreProjectId;
}

function assertOutboxDatastoreProjectId(
	context: ActiveContext | undefined,
	meta: ResolvedModelMeta,
	event: OutboxEvent
) {
	if (event.modelDatastoreProjectId === undefined) return;
	if (!context) {
		throw new ActiveTsConfigurationError(
			`Outbox event "${event.id}" declares a Datastore project and requires a context for verification.`
		);
	}
	const projectId = contextInternalStore(context, meta.store).datastoreProjectId;
	if (projectId === undefined) {
		throw new ActiveTsConfigurationError(
			`Outbox event "${event.id}" cannot verify store "${meta.store}" because it does not expose datastoreProjectId.`
		);
	}
	if (projectId !== event.modelDatastoreProjectId) {
		throw new ActiveTsConfigurationError(
			`Outbox event "${event.id}" targets Datastore project "${event.modelDatastoreProjectId}", but store "${meta.store}" uses project "${projectId}".`
		);
	}
}

async function loadSearchSyncEventData(context: ActiveContext, meta: ResolvedModelMeta, event: OutboxEvent) {
	if (!meta.datastore?.ancestor) {
		return await contextInternalStore(context, meta.store).get(meta, event.modelId!);
	}
	if (event.modelDatastoreAncestor === undefined) {
		throw new ActiveTsConfigurationError(
			`Outbox event "${event.id}" for Datastore model "${meta.name}" is missing Datastore ancestor metadata.`
		);
	}
	const plan: QueryPlan = {
		where: [{ field: meta.idField, op: '=', value: event.modelId }],
		or: [],
		sort: [],
		limit: 2,
		include: [],
		meta: { datastoreAncestor: event.modelDatastoreAncestor }
	};
	const store = contextInternalStore(context, meta.store);
	const result = normalizeStoreQueryResultForModel(
		meta,
		await store.query(meta, plan),
		`Outbox event "${event.id}" Datastore ancestor lookup`,
		{
			datastoreAncestor: event.modelDatastoreAncestor,
			datastoreNamespace: store.datastoreNamespace,
			trustedDatastoreEntityKeys: storeTrustsDatastoreEntityKeyRows(store)
		}
	);
	if (result.list.length > 1) {
		throw new ActiveTsValidationError(
			`Outbox event "${event.id}" Datastore ancestor lookup returned duplicate rows.`
		);
	}
	return result.list[0] ?? null;
}

async function ensureSearchSyncLeaseCurrent(outbox: OutboxAdapter, event: OutboxEvent, usesLease: boolean) {
	if (!usesLease || !outbox.isLeaseCurrent) return true;
	if (await outbox.isLeaseCurrent(event)) return true;
	const releaseErrors = await releaseOutboxEvents(outbox, [event]);
	if (releaseErrors.length) throw staleSearchSyncLeaseReleaseError(event, releaseErrors);
	return false;
}

function staleSearchSyncLeaseReleaseError(event: OutboxEvent, errors: unknown[]) {
	const error = new AggregateError(
		errors,
		`Outbox search sync stale lease release failed for event "${event.id}".`
	);
	defineDataProperty(error, STALE_SEARCH_SYNC_LEASE_RELEASE_ERROR, true, {
		enumerable: false,
		configurable: false
	});
	return error;
}

function isStaleSearchSyncLeaseReleaseError(error: unknown) {
	if (!error || typeof error !== 'object') return false;
	const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(error, STALE_SEARCH_SYNC_LEASE_RELEASE_ERROR);
	return !!descriptor && 'value' in descriptor && descriptor.value === true;
}

function searchSyncAdapterForRoute(
	context: ActiveContext | undefined,
	meta: ResolvedModelMeta,
	route: string,
	search: SearchAdapter,
	searchSource: SearchAdapter
) {
	const actualIndexKind = searchIndexAdapterKind(search, route);
	if (!context) {
		assertProvidedSearchAdapterMatchesRoute(route, search, actualIndexKind);
		return { name: route, indexKind: actualIndexKind, adapter: search };
	}
	let registered: ReturnType<ActiveContext['searchAdapterRouteFor']>;
	try {
		registered = context.searchAdapterRouteFor(meta, '', {}, route);
	} catch (error) {
		if (safeErrorMessage(error) === `Search adapter "${route}" is not registered.`) {
			const physicalRoute = searchSyncAdapterForPhysicalRoute(
				context,
				meta,
				route,
				search,
				searchSource,
				actualIndexKind
			);
			if (physicalRoute) return physicalRoute;
			assertProvidedSearchAdapterMatchesRoute(route, search, actualIndexKind);
			return { name: route, indexKind: actualIndexKind, adapter: search };
		}
		throw error;
	}
	if (!isRegisteredSearchAdapterSource(registered.adapter, searchSource)) {
		throw new ActiveTsConfigurationError(
			`Outbox search sync adapter "${route}" does not match the registered search adapter.`
		);
	}
	if (registered.indexKind !== actualIndexKind) {
		throw new ActiveTsConfigurationError(
			`Outbox search sync adapter "${route}" does not match the provided search adapter "${search.kind}".`
		);
	}
	return {
		name: registered.name,
		indexKind: registered.indexKind,
		adapter: searchSyncExecutionAdapter(registered.adapter)
	};
}

function searchSyncAdapterForPhysicalRoute(
	context: ActiveContext,
	meta: ResolvedModelMeta,
	route: string,
	search: SearchAdapter,
	searchSource: SearchAdapter,
	actualIndexKind: string
) {
	let registeredRoutes: ReturnType<ActiveContext['searchAdapterSchemaRoutesFor']>;
	try {
		registeredRoutes = context.searchAdapterSchemaRoutesFor(meta);
	} catch (error) {
		if (/^Search adapter ".+" is not registered\.$/.test(safeErrorMessage(error))) return undefined;
		throw error;
	}
	let matchedPhysicalRoute = false;
	for (let index = 0; index < registeredRoutes.length; index++) {
		const registered = registeredRoutes[index];
		if (registered.indexKind !== route) continue;
		matchedPhysicalRoute = true;
		if (!isRegisteredSearchAdapterSource(registered.adapter, searchSource)) continue;
		if (registered.indexKind !== actualIndexKind) {
			throw new ActiveTsConfigurationError(
				`Outbox search sync adapter "${route}" does not match the provided search adapter "${search.kind}".`
			);
		}
		return {
			name: registered.name,
			indexKind: registered.indexKind,
			adapter: searchSyncExecutionAdapter(registered.adapter)
		};
	}
	if (matchedPhysicalRoute) {
		throw new ActiveTsConfigurationError(
			`Outbox search sync adapter "${route}" does not match the registered search adapter.`
		);
	}
	return undefined;
}

function assertSearchSyncRouteHasIndexes<T extends { name: string; indexKind: string }>(
	meta: ResolvedModelMeta,
	route: T
): T {
	if (!meta.searchIndexes.length) return route;
	if (withSearchIndexesForAdapter(meta, route.name, route.indexKind).searchIndexes.length) return route;
	throw new ActiveTsConfigurationError(
		`Outbox search sync adapter "${route.name}" has no search indexes for model "${meta.name}".`
	);
}

function isRegisteredSearchAdapterSource(registered: SearchAdapter, provided: SearchAdapter) {
	const registeredSources = searchAdapterSourceChain(registered);
	for (const adapter of searchAdapterSourceChain(provided)) {
		if (SET_HAS.call(registeredSources, adapter)) return true;
	}
	return false;
}

function searchSyncExecutionAdapter(registered: SearchAdapter) {
	return registered;
}

function searchAdapterSourceChain(start: SearchAdapter) {
	const chain = new Set<SearchAdapter>();
	let current: SearchAdapter | undefined = start;
	while (current) {
		if (SET_HAS.call(chain, current)) return chain;
		SET_ADD.call(chain, current);
		const next = searchAdapterSource(current);
		if (next === current) return chain;
		current = next;
	}
	return chain;
}

function assertProvidedSearchAdapterMatchesRoute(route: string, search: SearchAdapter, actualIndexKind: string) {
	if (search.kind !== route && actualIndexKind !== route) {
		throw new ActiveTsConfigurationError(
			`Outbox search sync adapter "${route}" does not match search adapter "${search.kind}".`
		);
	}
}

function validateSearchSyncWorkerOptions(options: SearchSyncWorkerOptions): SearchSyncWorkerOptions & {
	outbox: OutboxAdapter;
	searchSource: SearchAdapter;
} {
	if (!options || typeof options !== 'object' || Array.isArray(options)) {
		throw new ActiveTsConfigurationError('Outbox search sync options must be an object.');
	}
	assertPlainOptions(options, 'Outbox search sync options');
	const record = options as Record<string, unknown>;
	assertNoSymbolOptions(record, 'Outbox search sync options');
	assertKnownOptions(record, SEARCH_SYNC_WORKER_OPTION_KEYS, 'Outbox search sync options');
	const outbox = ownOptionValue(record, 'outbox', 'Outbox search sync options') as OutboxAdapter | undefined;
	const search = ownOptionValue(record, 'search', 'Outbox search sync options') as SearchAdapter | undefined;
	const models = ownOptionValue(record, 'models', 'Outbox search sync options');
	const context = ownOptionValue(record, 'context', 'Outbox search sync options') as ActiveContext | undefined;
	const adapter = ownOptionValue(record, 'adapter', 'Outbox search sync options');
	const batchSize = ownOptionValue(record, 'batchSize', 'Outbox search sync options');
	const allowUnsafeDrainFallback = ownOptionValue(
		record,
		'allowUnsafeDrainFallback',
		'Outbox search sync options'
	);
	const allowUnsafeIdentityOnlyDatastoreDelete = ownOptionValue(
		record,
		'allowUnsafeIdentityOnlyDatastoreDelete',
		'Outbox search sync options'
	);
	const normalizedOutbox = normalizeOutboxAdapter(outbox, 'Outbox search sync outbox', true);
	const normalizedSearch = normalizeSearchSyncAdapter(search);
	if (!Array.isArray(models)) {
		throw new ActiveTsConfigurationError('Outbox search sync models must be an array.');
	}
	const safeModels = snapshotArrayInput<ModelConstructor>(models, 'Outbox search sync models');
	for (let index = 0; index < safeModels.length; index++) {
		const model = safeModels[index];
		if (typeof model !== 'function') {
			throw new ActiveTsConfigurationError(`Outbox search sync models[${index}] must be a model constructor.`);
		}
	}
	if (context !== undefined) {
		if (!(context instanceof ActiveContext)) {
			throw new ActiveTsConfigurationError('Outbox search sync context must be an ActiveContext.');
		}
	}
	const safeAdapter = adapter === undefined ? undefined : assertSafeSchemaIdentifier(adapter, 'Outbox search sync adapter');
	const safeBatchSize = batchSize === undefined
		? undefined
		: assertPositiveSafeInteger(batchSize, 'Outbox search sync batchSize');
	if (allowUnsafeDrainFallback !== undefined && typeof allowUnsafeDrainFallback !== 'boolean') {
		throw new ActiveTsConfigurationError('Outbox search sync allowUnsafeDrainFallback must be a boolean.');
	}
	if (
		allowUnsafeIdentityOnlyDatastoreDelete !== undefined &&
		typeof allowUnsafeIdentityOnlyDatastoreDelete !== 'boolean'
	) {
		throw new ActiveTsConfigurationError(
			'Outbox search sync allowUnsafeIdentityOnlyDatastoreDelete must be a boolean.'
		);
	}
	return {
		outbox: normalizedOutbox,
		search: normalizedSearch,
		searchSource: search as SearchAdapter,
		models: safeModels,
		context,
		adapter: safeAdapter,
		batchSize: safeBatchSize,
		allowUnsafeDrainFallback: allowUnsafeDrainFallback as boolean | undefined,
		allowUnsafeIdentityOnlyDatastoreDelete: allowUnsafeIdentityOnlyDatastoreDelete as boolean | undefined
	} as SearchSyncWorkerOptions & {
		outbox: OutboxAdapter;
		searchSource: SearchAdapter;
	};
}

async function runSearchIndexHook(
	context: ActiveContext | undefined,
	name: 'beforeIndex' | 'afterIndex',
	model: ResolvedModelMeta,
	id: EntityId,
	data: any,
	operation: string
) {
	if (!context) return;
	await context.runHooks(name, {
		model: snapshotSearchIndexHookModel(model),
		id,
		data: data === undefined ? undefined : cloneSafeData(data),
		operation
	});
}

function snapshotSearchIndexHookModel(model: ResolvedModelMeta): ResolvedModelMeta {
	const searchIndexes = [];
	for (let index = 0; index < model.searchIndexes.length; index++) {
		const searchIndex = model.searchIndexes[index];
		const fields = [];
		for (let fieldIndex = 0; fieldIndex < searchIndex.fields.length; fieldIndex++) {
			fields[fieldIndex] = searchIndex.fields[fieldIndex];
		}
		searchIndexes[index] = {
			...searchIndex,
			fields
		};
	}
	const datastore = model.datastore === undefined
		? undefined
		: {
				...model.datastore,
				ancestorFields: model.datastore.ancestorFields === undefined
					? undefined
					: snapshotArrayInput<string>(model.datastore.ancestorFields, `${model.name} datastore ancestorFields`),
				unindexed: model.datastore.unindexed === undefined
					? undefined
					: snapshotArrayInput<string>(model.datastore.unindexed, `${model.name} datastore unindexed`)
			};
	return {
		...model,
		searchIndexes,
		datastore
	};
}

export function normalizeOutboxEvent(event: unknown): OutboxEvent {
	return sanitizeOutboxEvent(event, { requireModelId: false });
}

function sanitizeOutboxEvent(event: unknown, options: { requireModelId: boolean }): OutboxEvent {
	if (!event || typeof event !== 'object' || Array.isArray(event)) {
		throw new ActiveTsConfigurationError('Outbox event must be an object.');
	}
	const record = event as Record<string, unknown>;
	assertPlainOptions(record, 'Outbox event');
	assertNoSymbolOptions(record, 'Outbox event');
	assertKnownOptions(record, OUTBOX_EVENT_KEYS, 'Outbox event');
	const id = assertSafeCacheKey(ownOptionValue(record, 'id', 'Outbox event'), 'outbox event id');
	const model = assertSafeSchemaIdentifier(ownOptionValue(record, 'model', 'Outbox event'), 'outbox event model');
	const operation = ownOptionValue(record, 'operation', 'Outbox event');
	const modelId = ownOptionValue(record, 'modelId', 'Outbox event');
	const modelIdentity = ownOptionValue(record, 'modelIdentity', 'Outbox event');
	const modelDatastoreAncestor = ownOptionValue(record, 'modelDatastoreAncestor', 'Outbox event');
	const modelDatastoreProjectId = ownOptionValue(record, 'modelDatastoreProjectId', 'Outbox event');
	const data = ownOptionValue(record, 'data', 'Outbox event');
	const dataEncoding = ownOptionValue(record, 'dataEncoding', 'Outbox event');
	const sequence = ownOptionValue(record, 'sequence', 'Outbox event');
	const version = ownOptionValue(record, 'version', 'Outbox event');
	const leaseToken = ownOptionValue(record, 'leaseToken', 'Outbox event');
	const leaseExpiresAt = ownOptionValue(record, 'leaseExpiresAt', 'Outbox event');
	if (operation !== 'create' && operation !== 'update' && operation !== 'delete') {
		throw new ActiveTsConfigurationError(
			typeof operation === 'string'
				? `Outbox event "${id}" has unsupported operation "${operation}".`
				: `Outbox event "${id}" has unsupported operation.`
		);
	}
	const safeOperation = operation as OutboxOperation;
	if (options.requireModelId && modelId === undefined) {
		throw new ActiveTsConfigurationError(`Outbox event "${id}" is missing modelId.`);
	}
	if (modelId !== undefined) assertSafeEntityId(modelId, `Outbox event "${id}" modelId`);
	if (modelIdentity !== undefined) assertSafeCacheKey(modelIdentity, `Outbox event "${id}" modelIdentity`);
	if (
		modelDatastoreProjectId !== undefined &&
		(typeof modelDatastoreProjectId !== 'string' || !modelDatastoreProjectId || modelDatastoreProjectId.includes('\0'))
	) {
		throw new ActiveTsConfigurationError(
			`Outbox event "${id}" modelDatastoreProjectId must be a non-empty string without null bytes.`
		);
	}
	const safeModelDatastoreAncestor = modelDatastoreAncestor === undefined
		? undefined
		: normalizeDatastoreKey(modelDatastoreAncestor, `Outbox event "${id}" modelDatastoreAncestor`);
	if (dataEncoding !== undefined && dataEncoding !== 'public' && dataEncoding !== 'stored') {
		throw new ActiveTsConfigurationError(`Outbox event "${id}" dataEncoding must be "public" or "stored".`);
	}
	if (data === undefined && dataEncoding !== undefined) {
		throw new ActiveTsConfigurationError(`Outbox event "${id}" cannot declare dataEncoding without data.`);
	}
	if (version !== undefined && (!Number.isSafeInteger(version) || version < 0)) {
		throw new ActiveTsConfigurationError(`Outbox event "${id}" version must be a non-negative safe integer.`);
	}
	if ((leaseToken === undefined) !== (leaseExpiresAt === undefined)) {
		throw new ActiveTsConfigurationError(`Outbox event "${id}" leaseToken and leaseExpiresAt must be configured together.`);
	}
	const createdAt = assertCanonicalIsoTimestamp(ownOptionValue(record, 'createdAt', 'Outbox event'), `Outbox event "${id}" createdAt`);
	const normalized: OutboxEvent = {
		id,
		model,
		operation: safeOperation,
		createdAt,
		data: data === undefined ? undefined : cloneSafeData(data)
	};
	if (modelId !== undefined) normalized.modelId = modelId as EntityId;
	if (modelIdentity !== undefined) normalized.modelIdentity = modelIdentity as string;
	if (safeModelDatastoreAncestor !== undefined) normalized.modelDatastoreAncestor = safeModelDatastoreAncestor;
	if (modelDatastoreProjectId !== undefined) {
		normalized.modelDatastoreProjectId = modelDatastoreProjectId as string;
	}
	if (dataEncoding !== undefined) normalized.dataEncoding = dataEncoding as OutboxEvent['dataEncoding'];
	if (sequence !== undefined) normalized.sequence = assertSafeCacheKey(sequence, `Outbox event "${id}" sequence`);
	if (version !== undefined) normalized.version = version as number;
	if (leaseToken !== undefined) normalized.leaseToken = assertSafeCacheKey(leaseToken, `Outbox event "${id}" leaseToken`);
	if (leaseExpiresAt !== undefined) {
		normalized.leaseExpiresAt = assertCanonicalIsoTimestamp(leaseExpiresAt, `Outbox event "${id}" leaseExpiresAt`);
	}
	return normalized;
}

function sanitizeOutboxDrainResult(value: unknown) {
	if (!Array.isArray(value)) {
		throw new ActiveTsConfigurationError('Outbox drain result must be an array.');
	}
	return snapshotArrayInput<OutboxEvent>(value, 'Outbox drain result');
}

function drainResultEntriesForRequeue(value: unknown[]) {
	const events: OutboxEvent[] = [];
	for (let index = 0; index < value.length; index++) {
		const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, String(index));
		if (descriptor && 'value' in descriptor) events.push(descriptor.value as OutboxEvent);
	}
	return events;
}

function assertNoSymbolOptions(record: Record<string, unknown>, context: string) {
	if (OBJECT_GET_OWN_PROPERTY_SYMBOLS(record).length) {
		throw new ActiveTsConfigurationError(`${context} cannot contain symbol fields.`);
	}
}

function assertPlainOptions(value: object, context: string) {
	const prototype = OBJECT_GET_PROTOTYPE_OF(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsConfigurationError(`${context} must be a plain object.`);
	}
}

function assertKnownOptions(record: Record<string, unknown>, allowed: readonly string[], context: string) {
	const allowedSet = stringSet(allowed);
	for (const property of OBJECT_GET_OWN_PROPERTY_NAMES(record)) {
		if (!SET_HAS.call(allowedSet, property)) {
			throw new ActiveTsConfigurationError(`${context} contains unknown option "${property}".`);
		}
	}
}

function stringSet(values: readonly string[]) {
	const set = new Set<string>();
	for (const value of values) SET_ADD.call(set, value);
	return set;
}

function ownOptionValue(record: Record<string, unknown>, key: string, context: string) {
	if (!OBJECT_HAS_OWN(record, key)) return undefined;
	const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(record, key);
	if (!descriptor || !('value' in descriptor)) {
		throw new ActiveTsConfigurationError(`${context} "${key}" must be a data property.`);
	}
	if (!descriptor.enumerable) {
		throw new ActiveTsConfigurationError(`${context} "${key}" must be enumerable.`);
	}
	return descriptor.value;
}

function normalizeOutboxAdapter(value: unknown, context: string, requireDrain: boolean): OutboxAdapter {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ActiveTsConfigurationError(`${context} must be an adapter object.`);
	}
	const setup = adapterMember(value, 'setup');
	const append = adapterMember(value, 'append');
	const appendTransactional = adapterMember(value, 'appendTransactional');
	const list = adapterMember(value, 'list');
	const lease = adapterMember(value, 'lease');
	const supportsExclusiveLease = adapterMember(value, 'supportsExclusiveLease');
	const isLeaseCurrent = adapterMember(value, 'isLeaseCurrent');
	const release = adapterMember(value, 'release');
	const ack = adapterMember(value, 'ack');
	const drain = adapterMember(value, 'drain');
	const requeue = adapterMember(value, 'requeue');
	if (setup !== undefined && typeof setup !== 'function') {
		throw new ActiveTsConfigurationError(`${context}.setup must be a function.`);
	}
	if (typeof append !== 'function') {
		throw new ActiveTsConfigurationError(`${context}.append must be a function.`);
	}
	if (appendTransactional !== undefined && typeof appendTransactional !== 'function') {
		throw new ActiveTsConfigurationError(`${context}.appendTransactional must be a function.`);
	}
	if (list !== undefined && typeof list !== 'function') {
		throw new ActiveTsConfigurationError(`${context}.list must be a function.`);
	}
	if (lease !== undefined && typeof lease !== 'function') {
		throw new ActiveTsConfigurationError(`${context}.lease must be a function.`);
	}
	if (supportsExclusiveLease !== undefined && typeof supportsExclusiveLease !== 'function') {
		throw new ActiveTsConfigurationError(`${context}.supportsExclusiveLease must be a function.`);
	}
	if (isLeaseCurrent !== undefined && typeof isLeaseCurrent !== 'function') {
		throw new ActiveTsConfigurationError(`${context}.isLeaseCurrent must be a function.`);
	}
	if (release !== undefined && typeof release !== 'function') {
		throw new ActiveTsConfigurationError(`${context}.release must be a function.`);
	}
	if (ack !== undefined && typeof ack !== 'function') {
		throw new ActiveTsConfigurationError(`${context}.ack must be a function.`);
	}
	if ((lease === undefined) !== (ack === undefined)) {
		throw new ActiveTsConfigurationError(`${context}.lease and ${context}.ack must be configured together.`);
	}
	if (
		requireDrain &&
		lease !== undefined &&
		supportsExclusiveLease === undefined &&
		(isLeaseCurrent === undefined || release === undefined)
	) {
		throw new ActiveTsConfigurationError(
			`${context}.lease, ${context}.ack, ${context}.isLeaseCurrent, and ${context}.release must be configured together for search sync.`
		);
	}
	if (drain !== undefined && typeof drain !== 'function') {
		throw new ActiveTsConfigurationError(`${context}.drain must be a function.`);
	}
	if (requeue !== undefined && typeof requeue !== 'function') {
		throw new ActiveTsConfigurationError(`${context}.requeue must be a function.`);
	}
	if (
		requireDrain &&
		typeof drain === 'function' &&
		!(typeof lease === 'function' && typeof ack === 'function') &&
		typeof requeue !== 'function'
	) {
		throw new ActiveTsConfigurationError(
			`${context}.drain requires ${context}.requeue for ordered search sync failure recovery.`
		);
	}
	if (requireDrain && typeof drain !== 'function' && !(typeof lease === 'function' && typeof ack === 'function')) {
		throw new ActiveTsConfigurationError('Outbox adapter does not support drain() or lease()/ack().');
	}
	return {
		setup: typeof setup === 'function' ? setup.bind(value) : undefined,
		append: append.bind(value),
		appendTransactional: typeof appendTransactional === 'function' ? appendTransactional.bind(value) : undefined,
		list: typeof list === 'function' ? list.bind(value) : undefined,
		lease: typeof lease === 'function' ? lease.bind(value) : undefined,
		supportsExclusiveLease: typeof supportsExclusiveLease === 'function' ? supportsExclusiveLease.bind(value) : undefined,
		isLeaseCurrent: typeof isLeaseCurrent === 'function' ? isLeaseCurrent.bind(value) : undefined,
		release: typeof release === 'function' ? release.bind(value) : undefined,
		ack: typeof ack === 'function' ? ack.bind(value) : undefined,
		drain: typeof drain === 'function' ? drain.bind(value) : undefined,
		requeue: typeof requeue === 'function' ? requeue.bind(value) : undefined
	};
}

function assertSearchSyncLeaseContract(outbox: OutboxAdapter, context: string) {
	if (!outbox.isLeaseCurrent || !outbox.release) {
		throw new ActiveTsConfigurationError(
			`${context}.lease, ${context}.ack, ${context}.isLeaseCurrent, and ${context}.release must be configured together for search sync.`
		);
	}
}

function normalizeSearchSyncAdapter(value: unknown): SearchAdapter {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ActiveTsConfigurationError('Outbox search sync search must be an adapter object.');
	}
	const rawKind = adapterMember(value, 'kind');
	const kind = rawKind === undefined
		? 'outbox-search'
		: assertSearchSyncAdapterKind(rawKind, 'Outbox search sync search.kind');
	const index = adapterMember(value, 'index');
	const deleteDocument = adapterMember(value, 'delete');
	const rawCapabilities = adapterMember(value, 'capabilities', {
		allowOwnAccessor: isContextBoundSearchAdapter(value)
	});
	const rawSearchIndexKind = optionalAdapterMember(value, 'searchIndexKind');
	const searchIndexKind = rawSearchIndexKind === undefined
		? undefined
		: assertSafeSchemaIdentifier(rawSearchIndexKind, 'Outbox search sync search.searchIndexKind');
	if (typeof index !== 'function') {
		throw new ActiveTsConfigurationError('Outbox search sync search.index must be a function.');
	}
	if (typeof deleteDocument !== 'function') {
		throw new ActiveTsConfigurationError('Outbox search sync search.delete must be a function.');
	}
	const capabilities = normalizeSearchSyncCapabilities(rawCapabilities, kind);
	if (capabilities.index !== true) {
		throw new ActiveTsConfigurationError(
			`Outbox search sync search adapter "${kind}" does not support indexing.`
		);
	}
	return {
		kind,
		searchIndexKind,
		capabilities,
		search: async () => ({ list: [], more: false }),
		index: index.bind(value),
		delete: deleteDocument.bind(value)
	};
}

function normalizeSearchSyncCapabilities(value: unknown, kind: string): SearchCapabilities {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ActiveTsConfigurationError(
			`Outbox search sync search adapter "${kind}" must declare capabilities.index: true.`
		);
	}
	const context = 'Outbox search sync search capabilities';
	assertPlainOptions(value, context);
	const record = value as Record<string, unknown>;
	assertNoSymbolOptions(record, context);
	assertKnownSearchSyncCapabilityKeys(record, [...SEARCH_SYNC_CAPABILITY_KEYS, 'whereOperators'], context);
	const normalized: SearchCapabilities = {};
	for (const key of SEARCH_SYNC_CAPABILITY_KEYS) {
		const capability = ownOptionValue(record, key, context);
		if (capability === undefined) continue;
		if (typeof capability !== 'boolean') {
			throw new ActiveTsConfigurationError(`${context}.${key} must be a boolean.`);
		}
		normalized[key] = capability;
	}
	const whereOperators = ownOptionValue(record, 'whereOperators', context);
	if (whereOperators !== undefined) {
		if (!whereOperators || typeof whereOperators !== 'object' || Array.isArray(whereOperators)) {
			throw new ActiveTsConfigurationError(`${context}.whereOperators must be a plain object.`);
		}
		assertPlainOptions(whereOperators, `${context}.whereOperators`);
		const operators = whereOperators as Record<string, unknown>;
		assertNoSymbolOptions(operators, `${context}.whereOperators`);
		const normalizedOperators: NonNullable<SearchCapabilities['whereOperators']> = {};
		for (const operator of OBJECT_GET_OWN_PROPERTY_NAMES(operators)) {
			const enabled = ownOptionValue(operators, operator, `${context}.whereOperators`);
			if (!isSearchSyncWhereOperator(operator)) {
				throw new ActiveTsConfigurationError(`${context}.whereOperators contains unknown operator "${operator}".`);
			}
			if (typeof enabled !== 'boolean') {
				throw new ActiveTsConfigurationError(`${context}.whereOperators.${operator} must be a boolean.`);
			}
			normalizedOperators[operator] = enabled;
		}
		normalized.whereOperators = Object.freeze(normalizedOperators);
	}
	return Object.freeze(normalized);
}

function assertKnownSearchSyncCapabilityKeys(
	record: Record<string, unknown>,
	allowed: readonly string[],
	context: string
) {
	const allowedSet = stringSet(allowed);
	for (const property of OBJECT_GET_OWN_PROPERTY_NAMES(record)) {
		if (!SET_HAS.call(allowedSet, property)) {
			throw new ActiveTsConfigurationError(`${context} contains unknown capability "${property}".`);
		}
	}
}

function isSearchSyncWhereOperator(value: string): value is keyof NonNullable<SearchCapabilities['whereOperators']> {
	return SET_HAS.call(SEARCH_SYNC_WHERE_OPERATORS, value);
}

function assertSearchSyncAdapterKind(value: unknown, context: string) {
	if (typeof value !== 'string' || !value || value.includes('\0')) {
		throw new ActiveTsConfigurationError(`${context} must be a non-empty string without null bytes.`);
	}
	return value;
}

function assertPositiveSafeInteger(value: unknown, context: string) {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
		throw new ActiveTsConfigurationError(`${context} must be a positive safe integer.`);
	}
	return value;
}

function normalizeOutboxBatchLimit(options: OutboxBatchOptions | undefined, context: string) {
	if (options === undefined) return undefined;
	if (!options || typeof options !== 'object' || Array.isArray(options)) {
		throw new ActiveTsConfigurationError(`${context} must be an object.`);
	}
	assertPlainOptions(options, context);
	const record = options as Record<string, unknown>;
	assertNoSymbolOptions(record, context);
	assertKnownOptions(record, ['limit'], context);
	const limit = ownOptionValue(record, 'limit', context);
	return limit === undefined ? undefined : assertPositiveSafeInteger(limit, `${context}.limit`);
}

function outboxBatchOptions(batchSize: number | undefined): OutboxBatchOptions | undefined {
	return batchSize === undefined ? undefined : { limit: batchSize };
}

function adapterMember(adapter: object, property: string, options: { allowOwnAccessor?: boolean } = {}) {
	let current: object | null = adapter;
	while (current && current !== Object.prototype) {
		if (OBJECT_HAS_OWN(current, property)) {
			const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(current, property);
			if (!descriptor || !('value' in descriptor)) {
				if (
					options.allowOwnAccessor &&
					current === adapter &&
					descriptor &&
					typeof descriptor.get === 'function'
				) {
					if (!descriptor.enumerable) {
						throw new ActiveTsConfigurationError(`Outbox adapter member "${property}" must be enumerable.`);
					}
					return descriptor.get.call(adapter);
				}
				throw new ActiveTsConfigurationError(`Outbox adapter member "${property}" must be a data property.`);
			}
			if (current === adapter && !descriptor.enumerable) {
				throw new ActiveTsConfigurationError(`Outbox adapter member "${property}" must be enumerable.`);
			}
			return descriptor.value;
		}
		current = OBJECT_GET_PROTOTYPE_OF(current);
	}
	return undefined;
}

function optionalAdapterMember(adapter: object, property: string) {
	let current: object | null = adapter;
	while (current && current !== Object.prototype) {
		if (OBJECT_HAS_OWN(current, property)) {
			const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(current, property);
			if (!descriptor || !('value' in descriptor)) {
				throw new ActiveTsConfigurationError(`Outbox adapter member "${property}" must be a data property.`);
			}
			if (descriptor.value === undefined) return undefined;
			if (current === adapter && !descriptor.enumerable) {
				throw new ActiveTsConfigurationError(`Outbox adapter member "${property}" must be enumerable.`);
			}
			return descriptor.value;
		}
		current = OBJECT_GET_PROTOTYPE_OF(current);
	}
	return undefined;
}

function assertCanonicalIsoTimestamp(value: unknown, context: string) {
	const text = assertSafeCacheKey(value, context);
	const timestamp = dateParse(text);
	if (!Number.isFinite(timestamp) || dateIsoString(new Date(timestamp)) !== text) {
		throw new ActiveTsConfigurationError(`${context} must be a canonical ISO timestamp.`);
	}
	return text;
}

function sanitizeOutboxEventBatch(events: OutboxEvent[], context: string) {
	const safeEvents = snapshotArrayInput<OutboxEvent>(events, context);
	const normalized: OutboxEvent[] = [];
	for (let index = 0; index < safeEvents.length; index++) {
		normalized[index] = sanitizeOutboxEvent(safeEvents[index], { requireModelId: false });
	}
	return normalized;
}

async function requeueOutboxEvents(outbox: OutboxAdapter, events: OutboxEvent[]) {
	const errors: unknown[] = [];
	const snapshots: OutboxEvent[] = [];
	for (const event of events) {
		try {
			snapshots.push(snapshotOutboxEventForRequeue(event));
		} catch (error) {
			errors.push(error);
		}
	}
	if (!snapshots.length) return errors;
	if (outbox.requeue) {
		try {
			await outbox.requeue(snapshots);
		} catch (error) {
			errors.push(error);
		}
		return errors;
	}
	for (const event of snapshots) {
		try {
			await outbox.append(event);
		} catch (error) {
			errors.push(error);
		}
	}
	return errors;
}

async function appendOutboxEvents(outbox: OutboxAdapter, events: OutboxEvent[]) {
	const errors: unknown[] = [];
	for (const event of events) {
		try {
			await outbox.append(snapshotOutboxEventForRequeue(event));
		} catch (error) {
			errors.push(error);
		}
	}
	return errors;
}

async function ackOutboxEvents(outbox: OutboxAdapter, events: OutboxEvent[]) {
	if (!outbox.ack) {
		throw new ActiveTsConfigurationError('Outbox adapter does not support ack().');
	}
	const snapshots = sanitizeOutboxEventBatch(events, 'outbox ack events');
	await outbox.ack(snapshots);
}

async function releaseOutboxEvents(outbox: OutboxAdapter, events: OutboxEvent[]) {
	if (!outbox.release) return [];
	const errors: unknown[] = [];
	const snapshots: OutboxEvent[] = [];
	for (const event of events) {
		try {
			snapshots.push(sanitizeOutboxEvent(event, { requireModelId: false }));
		} catch (error) {
			errors.push(error);
		}
	}
	if (!snapshots.length) return errors;
	try {
		await outbox.release(snapshots);
	} catch (error) {
		errors.push(error);
	}
	return errors;
}

function snapshotOutboxEventForRequeue(event: OutboxEvent): OutboxEvent {
	try {
		return sanitizeOutboxEvent(event, { requireModelId: false });
	} catch {
		return snapshotRequeueValue(event, new WeakMap(), 'Outbox requeue event') as OutboxEvent;
	}
}

function snapshotRequeueValue(value: unknown, seen: WeakMap<object, unknown>, context: string): unknown {
	if (!value || typeof value !== 'object') return snapshotRequeuePrimitive(value, context);
	if (value instanceof Date) {
		if (!Number.isFinite(dateTime(value))) {
			throw new ActiveTsConfigurationError(`${context} must contain valid Date values for requeue snapshotting.`);
		}
		assertNoRequeueBuiltInCustomProperties(value, context);
		return cloneDate(value);
	}
	if (value instanceof Uint8Array) {
		assertNoRequeueBuiltInCustomProperties(value, context, value.length);
		return new Uint8Array(value);
	}
	if (WEAKMAP_HAS.call(seen, value)) return WEAKMAP_GET.call(seen, value);
	if (Array.isArray(value)) {
		assertRequeueArrayShape(value, context);
		const clone: unknown[] = [];
		WEAKMAP_SET.call(seen, value, clone);
		for (let index = 0; index < value.length; index++) {
			const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, String(index))!;
			clone[index] = snapshotRequeueValue(descriptor.value, seen, `${context}[${index}]`);
		}
		return clone;
	}
	if (OBJECT_GET_OWN_PROPERTY_SYMBOLS(value).length) {
		throw new ActiveTsConfigurationError(`${context} cannot contain symbol fields.`);
	}
	const prototype = OBJECT_GET_PROTOTYPE_OF(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ActiveTsConfigurationError(`${context} must be plain data for requeue snapshotting.`);
	}
	const clone = Object.create(prototype) as Record<string, unknown>;
	WEAKMAP_SET.call(seen, value, clone);
	for (const key of OBJECT_GET_OWN_PROPERTY_NAMES(value)) {
		const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, key);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsConfigurationError(`${context}.${key} must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsConfigurationError(`${context}.${key} must be enumerable.`);
		}
		defineDataProperty(clone, key, snapshotRequeueValue(descriptor.value, seen, `${context}.${key}`), {
			enumerable: true,
			configurable: true,
			writable: true
		});
	}
	return clone;
}

function snapshotRequeuePrimitive(value: unknown, context: string) {
	if (
		value === undefined ||
		value === null ||
		typeof value === 'string' ||
		typeof value === 'boolean'
	) return value;
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) {
			throw new ActiveTsConfigurationError(`${context} must contain finite numbers for requeue snapshotting.`);
		}
		return value;
	}
	throw new ActiveTsConfigurationError(`${context} must contain plain data for requeue snapshotting.`);
}

function assertNoRequeueBuiltInCustomProperties(value: object, context: string, allowedIndexLength?: number) {
	if (OBJECT_GET_OWN_PROPERTY_SYMBOLS(value).length) {
		throw new ActiveTsConfigurationError(`${context} cannot contain symbol fields.`);
	}
	for (const property of OBJECT_GET_OWN_PROPERTY_NAMES(value)) {
		if (allowedIndexLength !== undefined && isArrayIndexProperty(property, allowedIndexLength)) continue;
		throw new ActiveTsConfigurationError(`${context} cannot contain custom built-in property "${property}".`);
	}
}

function assertRequeueArrayShape(value: unknown[], context: string) {
	if (OBJECT_GET_OWN_PROPERTY_SYMBOLS(value).length) {
		throw new ActiveTsConfigurationError(`${context} cannot contain symbol fields.`);
	}
	assertDenseArrayItems(value, context);
	for (const property of OBJECT_GET_OWN_PROPERTY_NAMES(value)) {
		if (property === 'length') continue;
		if (!isArrayIndexProperty(property, value.length)) {
			throw new ActiveTsConfigurationError(`${context} cannot contain non-index array property "${property}".`);
		}
		const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, property);
		if (!descriptor || !('value' in descriptor)) {
			throw new ActiveTsConfigurationError(`${context}[${property}] must be a data property.`);
		}
		if (!descriptor.enumerable) {
			throw new ActiveTsConfigurationError(`${context}[${property}] must be enumerable.`);
		}
	}
}

function isArrayIndexProperty(property: string, length: number) {
	if (!/^(0|[1-9]\d*)$/.test(property)) return false;
	const index = Number(property);
	return Number.isSafeInteger(index) && index >= 0 && index < length;
}

function legacyOutboxMeta(model: ModelConstructor, name: string): ResolvedModelMeta {
	const resolved = legacyResolvedOutboxMeta(model);
	return {
		model,
		name,
		store: 'outbox',
		idField: resolved?.datastore?.ancestor ? resolved.idField : 'id',
		readValidation: resolved?.datastore?.ancestor ? resolved.readValidation : 'off' as const,
		indexes: [],
		searchIndexes: [],
		relations: new Map(),
		hooks: {},
		views: new Map(),
		policies: new Map(),
		scopes: new Map(),
		fieldCodecs: resolved?.datastore?.ancestor ? resolved.fieldCodecs : new Map(),
		fieldTypes: resolved?.datastore?.ancestor ? resolved.fieldTypes : new Map(),
		datastore: resolved?.datastore
	};
}

function legacyResolvedOutboxMeta(model: ModelConstructor) {
	try {
		return resolveModelMeta(model, { store: 'outbox' });
	} catch (error) {
		if (
			error instanceof ActiveTsConfigurationError &&
			/ is missing entity metadata\./.test(safeErrorMessage(error))
		) {
			return undefined;
		}
		throw error;
	}
}

function outboxModelName(model: ModelConstructor) {
	const modelName = staticModelString(model, 'modelName', true);
	return assertSafeSchemaIdentifier(modelName ?? staticModelString(model, 'name', false), 'Outbox search sync model name');
}

function staticModelString(model: ModelConstructor, property: 'modelName' | 'name', inherited: boolean) {
	let current: unknown = model;
	while (typeof current === 'function') {
		if (OBJECT_HAS_OWN(current, property)) {
			const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(current, property);
			if (!descriptor || !('value' in descriptor)) {
				throw new ActiveTsConfigurationError(`Outbox search sync model ${property} must be a data property.`);
			}
			if (descriptor.value !== undefined && typeof descriptor.value !== 'string') {
				throw new ActiveTsConfigurationError(`Outbox search sync model ${property} must be a string.`);
			}
			return descriptor.value as string | undefined;
		}
		if (!inherited) return undefined;
		const next = OBJECT_GET_PROTOTYPE_OF(current);
		if (!next || next === Function.prototype) return undefined;
		current = next;
	}
	return undefined;
}
