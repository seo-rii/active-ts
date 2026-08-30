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
	reconcileFromStore?: boolean;
	createdAt: string;
	sequence?: string;
	version?: number;
	leaseToken?: string;
	leaseExpiresAt?: string;
	deliveryAttempts?: number;
	availableAt?: string;
	deadLetteredAt?: string;
	lastDeliveryError?: string;
};

export type OutboxEventIdentity = {
	id?: string;
	model?: string;
	modelId?: EntityId;
	modelIdentity?: string;
	leaseToken?: string;
	leaseExpiresAt?: string;
};

export type OutboxDeliveryFailure = {
	identity: OutboxEventIdentity;
	event?: OutboxEvent;
	attempt: number;
	maxAttempts: number;
	failedAt: string;
	retryAt?: string;
	error: string;
};

export type OutboxAdapter = {
	readonly transactionStore?: string;
	setup?: (context: ActiveContext) => Promise<void> | void;
	append: (event: OutboxEvent) => Promise<void | OutboxEvent>;
	appendTransactional?: (context: ActiveContext, event: OutboxEvent) => Promise<void | OutboxEvent>;
	list?: () => Promise<OutboxEvent[]>;
	listDeadLetters?: () => Promise<OutboxEvent[]>;
	lease?: (options?: OutboxBatchOptions) => Promise<OutboxEvent[]>;
	supportsExclusiveLease?: () => Promise<boolean> | boolean;
	isLeaseCurrent?: (event: OutboxEvent) => Promise<boolean>;
	renewLease?: (event: OutboxEvent) => Promise<OutboxEvent | undefined>;
	release?: (events: OutboxEvent[]) => Promise<void>;
	ack?: (events: OutboxEvent[]) => Promise<void | boolean>;
	retry?: (failures: OutboxDeliveryFailure[]) => Promise<void>;
	deadLetter?: (failures: OutboxDeliveryFailure[]) => Promise<void>;
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
	'maxAttempts',
	'retryDelayMs',
	'deadLetter',
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
	'index',
	'revisionWrites'
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
	'reconcileFromStore',
	'createdAt',
	'sequence',
	'version',
	'leaseToken',
	'leaseExpiresAt',
	'deliveryAttempts',
	'availableAt',
	'deadLetteredAt',
	'lastDeliveryError'
] as const;
const DEFAULT_STORE_OUTBOX_MODEL_NAME = 'active_ts_outbox_event';
const STORE_OUTBOX_LEASE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_SEARCH_SYNC_MAX_ATTEMPTS = 5;
const DEFAULT_SEARCH_SYNC_RETRY_DELAY_MS = 0;
const MAX_SEARCH_SYNC_RETRY_DELAY_MS = 60_000;
const STALE_SEARCH_SYNC_LEASE_RELEASE_ERROR = Symbol('active-ts.outbox.stale-search-sync-lease-release-error');
let storeOutboxSequence = 0;

class StoreOutboxEventModel {}

export class MemoryOutboxAdapter implements OutboxAdapter {
	private readonly events: OutboxEvent[] = [];
	private readonly deadLetters: OutboxEvent[] = [];

	async append(event: OutboxEvent): Promise<void | OutboxEvent> {
		const normalized = sanitizeOutboxEvent(event, { requireModelId: false });
		this.assertAvailableIds([normalized], 'memory outbox append event');
		this.events[this.events.length] = normalized;
		return sanitizeOutboxEvent(normalized, { requireModelId: false });
	}

	async list() {
		const list: OutboxEvent[] = [];
		for (let index = 0; index < this.events.length; index++) {
			list[index] = sanitizeOutboxEvent(this.events[index], { requireModelId: false });
		}
		return list;
	}

	async listDeadLetters() {
		const list: OutboxEvent[] = [];
		for (let index = 0; index < this.deadLetters.length; index++) {
			list[index] = sanitizeOutboxEvent(this.deadLetters[index], { requireModelId: false });
		}
		return list;
	}

	async drain(options?: OutboxBatchOptions) {
		const limit = normalizeOutboxBatchLimit(options, 'memory outbox drain options');
		const drained: OutboxEvent[] = [];
		const retained: OutboxEvent[] = [];
		const blockedEntityKeys = new Set<string>();
		const now = new Date();
		for (let index = 0; index < this.events.length; index++) {
			const event = sanitizeOutboxEvent(this.events[index], { requireModelId: false });
			const checkOrderKeys = outboxEntityOrderCheckKeys(event);
			const blockOrderKeys = outboxEntityOrderBlockKeys(event);
			if (
				(limit !== undefined && drained.length >= limit) ||
				outboxEntityOrderKeysBlocked(blockedEntityKeys, checkOrderKeys)
			) {
				retained[retained.length] = event;
				continue;
			}
			if (!isOutboxDeliveryAvailable(event, now)) {
				blockOutboxEntityOrderKeys(blockedEntityKeys, blockOrderKeys);
				retained[retained.length] = event;
				continue;
			}
			drained[drained.length] = event;
		}
		replaceMemoryOutboxEvents(this.events, retained);
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

	async retry(failures: OutboxDeliveryFailure[]) {
		const normalized = sanitizeOutboxDeliveryFailureBatch(failures, 'memory outbox retry failures', true);
		const events: OutboxEvent[] = [];
		for (let index = 0; index < normalized.length; index++) {
			events[index] = outboxRetryEvent(normalized[index]);
		}
		this.assertAvailableIds(events, 'memory outbox retry failures');
		prependMemoryOutboxEvents(this.events, events);
	}

	async deadLetter(failures: OutboxDeliveryFailure[]) {
		const normalized = sanitizeOutboxDeliveryFailureBatch(failures, 'memory outbox dead-letter failures', true);
		const existing = new Set<string>();
		for (const event of this.deadLetters) SET_ADD.call(existing, event.id);
		for (let index = 0; index < normalized.length; index++) {
			const event = outboxDeadLetterEvent(normalized[index]);
			if (SET_HAS.call(existing, event.id)) {
				throw new ActiveTsConflictError(`Memory outbox dead-letter event id "${event.id}" already exists.`);
			}
			SET_ADD.call(existing, event.id);
			this.deadLetters[this.deadLetters.length] = event;
		}
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

function replaceMemoryOutboxEvents(events: OutboxEvent[], next: readonly OutboxEvent[]) {
	events.length = 0;
	for (let index = 0; index < next.length; index++) events[index] = next[index];
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

	async append(event: OutboxEvent): Promise<void | OutboxEvent> {
		return await this.appendWithContext(this.activeContext(), event);
	}

	async appendTransactional(context: ActiveContext, event: OutboxEvent): Promise<void | OutboxEvent> {
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
		return await this.appendWithContext(context, event);
	}

	async list() {
		const events = await this.listWithContext(this.activeContext());
		const pending: OutboxEvent[] = [];
		for (const event of events) {
			if (event.deadLetteredAt === undefined) pending[pending.length] = event;
		}
		return pending;
	}

	async listDeadLetters() {
		const events = await this.listWithContext(this.activeContext());
		const deadLetters: OutboxEvent[] = [];
		for (const event of events) {
			if (event.deadLetteredAt !== undefined) deadLetters[deadLetters.length] = event;
		}
		return deadLetters;
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
				if (event.deadLetteredAt !== undefined) continue;
				if (outboxEntityOrderKeysBlocked(blockedEntityKeys, checkOrderKeys)) {
					blockOutboxEntityOrderKeys(blockedEntityKeys, blockOrderKeys);
					continue;
				}
				if (!isOutboxDeliveryAvailable(event, now)) {
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

	async renewLease(event: OutboxEvent) {
		const normalized = sanitizeOutboxEvent(event, { requireModelId: false });
		if (normalized.leaseToken === undefined) {
			throw new ActiveTsConfigurationError('Store outbox renewLease requires a leased event.');
		}
		const context = this.activeContext();
		const now = new Date();
		const expiresAt = dateIsoString(new Date(dateTime(now) + STORE_OUTBOX_LEASE_TTL_MS));
		const run = async (activeContext: ActiveContext) => {
			const current = await this.currentOutboxEvent(activeContext, normalized.id);
			if (
				!current ||
				!isOutboxSnapshotCurrent(current, normalized) ||
				!isOutboxLeaseCurrent(current, normalized.leaseToken!, now)
			) {
				return undefined;
			}
			const renewed = withOutboxLease(current, normalized.leaseToken!, expiresAt);
			const store = contextInternalStore(activeContext, this.meta.store);
			await store.update(
				this.meta,
				current.id,
				renewed,
				store.capabilities?.optimisticLock === true ? outboxExpectedVersionOption(current) : undefined
			);
			return renewed;
		};
		const store = contextInternalStore(context, this.meta.store);
		try {
			if (store.capabilities?.optimisticLock === true) return await run(context);
			if (storeSupportsOutboxLeaseTransactions(store)) {
				return await context.transaction((tx) => run(tx), { store: this.meta.store });
			}
			throw new ActiveTsConfigurationError(
				`Store outbox adapter requires store "${store.kind}" to support optimistic locking or conflict-detecting transactions for lease renewal.`
			);
		} catch (error) {
			if (isStoreOutboxLeaseClaimConflict(store, error)) return undefined;
			throw error;
		}
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

	async retry(failures: OutboxDeliveryFailure[]) {
		await this.settleDeliveryFailures(failures, 'retry');
	}

	async deadLetter(failures: OutboxDeliveryFailure[]) {
		await this.settleDeliveryFailures(failures, 'dead-letter');
	}

	private async settleDeliveryFailures(
		failures: OutboxDeliveryFailure[],
		disposition: 'retry' | 'dead-letter'
	) {
		const normalized = sanitizeOutboxDeliveryFailureBatch(
			failures,
			`store outbox ${disposition} failures`,
			true
		);
		const run = async (activeContext: ActiveContext, batch: readonly OutboxDeliveryFailure[]) => {
			const store = contextInternalStore(activeContext, this.meta.store);
			for (const failure of batch) {
				const source = failure.event!;
				const current = await this.currentOutboxEvent(activeContext, source.id);
				if (!current) {
					if (source.leaseToken !== undefined) continue;
					const next = disposition === 'retry'
						? outboxRetryEvent(failure)
						: outboxDeadLetterEvent(failure);
					await store.create(this.meta, next.id, next);
					continue;
				}
				if (!isOutboxSnapshotCurrent(current, source)) continue;
				if (source.leaseToken !== undefined && current.leaseToken !== source.leaseToken) continue;
				const currentFailure = { ...failure, event: current };
				const next = disposition === 'retry'
					? outboxRetryEvent(currentFailure)
					: outboxDeadLetterEvent(currentFailure);
				await store.update(
					this.meta,
					current.id,
					next,
					store.capabilities?.optimisticLock === true ? outboxExpectedVersionOption(current) : undefined
				);
			}
		};
		const context = this.activeContext();
		const store = contextInternalStore(context, this.meta.store);
		if (store.capabilities?.optimisticLock !== true && storeSupportsOutboxLeaseTransactions(store)) {
			const errors: unknown[] = [];
			for (const failure of normalized) {
				try {
					await context.transaction((tx) => run(tx, [failure]), { store: this.meta.store });
				} catch (error) {
					errors[errors.length] = error;
				}
			}
			if (errors.length === 1) throw errors[0];
			if (errors.length > 1) {
				throw new AggregateError(errors, `Store outbox ${disposition} failed.`);
			}
			return;
		}
		if (storeSupportsOutboxManagementTransactions(store)) {
			await context.transaction((tx) => run(tx, normalized), { store: this.meta.store });
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
			if (
				!current ||
				current.deadLetteredAt !== undefined ||
				!isOutboxDeliveryAvailable(current, now) ||
				!isOutboxSnapshotCurrent(current, event) ||
				isOutboxLeaseActive(current, now)
			) {
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
			const currentEvents: OutboxEvent[] = [];
			const now = new Date();
			for (const event of batch) {
				const current = await this.currentOutboxEvent(context, event.id);
				if (!current) return false;
				if (
					event.leaseToken !== undefined &&
					(
						!isOutboxLeaseCurrent(current, event.leaseToken, now) ||
						!isOutboxSnapshotCurrent(current, event)
					)
				) {
					return false;
				}
				if (event.leaseToken === undefined && current.leaseToken !== undefined) return false;
				if (event.leaseToken === undefined && !isOutboxSnapshotCurrent(current, event)) return false;
				currentEvents[currentEvents.length] = current;
			}
			const deleted: OutboxEvent[] = [];
			for (let index = 0; index < batch.length; index++) {
				const event = batch[index];
				const current = currentEvents[index];
				const currentStore = contextInternalStore(context, this.meta.store);
				const deleteOptions = currentStore.capabilities?.optimisticLock === true
					? outboxExpectedVersionOption(current)
					: undefined;
				try {
					await currentStore.delete(this.meta, event.id, deleteOptions);
					if (recoverDeletes) deleted.push(current);
				} catch (error) {
					if (current && (error instanceof ActiveTsConflictError || error instanceof ActiveTsNotFoundError)) {
						if (recoverDeletes) {
							const errors = await this.reinsertDeletedEvents(context, deleted);
							if (errors.length) {
								throw new AggregateError(
									[error, ...errors],
									`Store outbox ack lost ownership and rollback failed: ${safeErrorMessage(error)}`
								);
							}
							return false;
						}
						throw error;
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
			return true;
		};
		const context = this.activeContext();
		const store = contextInternalStore(context, this.meta.store);
		if (store.capabilities?.optimisticLock !== true && storeSupportsOutboxLeaseTransactions(store)) {
			const errors: unknown[] = [];
			let acknowledged = true;
			for (const event of normalized) {
				try {
					if (!(await context.transaction((tx) => run(tx, false, [event]), { store: this.meta.store }))) {
						acknowledged = false;
						break;
					}
				} catch (error) {
					if (isStoreOutboxLeaseClaimConflict(store, error)) acknowledged = false;
					else errors[errors.length] = error;
					break;
				}
			}
			if (errors.length === 1) throw errors[0];
			if (errors.length > 1) throw new AggregateError(errors, 'Store outbox ack failed.');
			return acknowledged;
		}
		if (storeSupportsOutboxManagementTransactions(store)) {
			try {
				return await context.transaction((tx) => run(tx, false, normalized), { store: this.meta.store });
			} catch (error) {
				if (isStoreOutboxLeaseClaimConflict(store, error)) return false;
				throw error;
			}
		}
		return await run(context, true, normalized);
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
					if (event.deadLetteredAt !== undefined) continue;
					if (outboxEntityOrderKeysBlocked(blockedEntityKeys, checkOrderKeys)) {
						blockOutboxEntityOrderKeys(blockedEntityKeys, blockOrderKeys);
						continue;
					}
					if (!isOutboxDeliveryAvailable(event, now)) {
						blockOutboxEntityOrderKeys(blockedEntityKeys, blockOrderKeys);
						continue;
					}
					if (isOutboxLeaseActive(event, now)) {
						blockOutboxEntityOrderKeys(blockedEntityKeys, blockOrderKeys);
						continue;
					}
					const current = await this.currentOutboxEvent(context, event.id);
					if (
						!current ||
						current.deadLetteredAt !== undefined ||
						!isOutboxDeliveryAvailable(current, now) ||
						!isOutboxSnapshotCurrent(current, event) ||
						isOutboxLeaseActive(current, now)
					) {
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
			['sequence', 'string'],
			['reconcileFromStore', 'boolean'],
			['deliveryAttempts', 'number'],
			['availableAt', 'string'],
			['deadLetteredAt', 'string'],
			['lastDeliveryError', 'string']
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

function isOutboxDeliveryAvailable(event: OutboxEvent, now: Date) {
	return event.availableAt === undefined || dateParse(event.availableAt) <= dateTime(now);
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
		current.deliveryAttempts === snapshot.deliveryAttempts &&
		current.availableAt === snapshot.availableAt &&
		current.deadLetteredAt === snapshot.deadLetteredAt &&
		current.lastDeliveryError === snapshot.lastDeliveryError &&
		current.modelIdentity === snapshot.modelIdentity &&
		current.modelDatastoreProjectId === snapshot.modelDatastoreProjectId &&
		current.dataEncoding === snapshot.dataEncoding &&
		current.reconcileFromStore === snapshot.reconcileFromStore &&
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
		current.deliveryAttempts === inserted.deliveryAttempts &&
		current.availableAt === inserted.availableAt &&
		current.deadLetteredAt === inserted.deadLetteredAt &&
		current.lastDeliveryError === inserted.lastDeliveryError &&
		current.modelIdentity === inserted.modelIdentity &&
		current.modelDatastoreProjectId === inserted.modelDatastoreProjectId &&
		current.dataEncoding === inserted.dataEncoding &&
		current.reconcileFromStore === inserted.reconcileFromStore &&
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

type OutboxDeliveryIdentitySnapshot = {
	identity: OutboxEventIdentity;
	releaseSnapshot?: OutboxEvent;
	orderCheckKeys: string[];
	orderBlockKeys: string[];
	deliveryAttempts: number;
};

function snapshotOutboxDeliveryIdentity(value: unknown, index: number): OutboxDeliveryIdentitySnapshot {
	const identity: OutboxEventIdentity = {};
	const releaseSnapshot = Object.create(null) as Record<string, unknown>;
	let hasReleaseId = false;
	let deliveryAttempts = 0;
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		const id = outboxOwnDataValue(value, 'id');
		if (typeof id === 'string' && isSafeOutboxCacheKey(id)) {
			identity.id = id;
			releaseSnapshot.id = id;
			hasReleaseId = true;
		}
		const model = outboxOwnDataValue(value, 'model');
		if (typeof model === 'string' && isSafeOutboxSchemaIdentifier(model)) {
			identity.model = model;
			releaseSnapshot.model = model;
		}
		const modelId = outboxOwnDataValue(value, 'modelId');
		if ((typeof modelId === 'string' || typeof modelId === 'number') && isSafeOutboxEntityId(modelId)) {
			identity.modelId = modelId;
			releaseSnapshot.modelId = modelId;
		}
		const modelIdentity = outboxOwnDataValue(value, 'modelIdentity');
		if (typeof modelIdentity === 'string' && isSafeOutboxCacheKey(modelIdentity)) {
			identity.modelIdentity = modelIdentity;
			releaseSnapshot.modelIdentity = modelIdentity;
		}
		const leaseToken = outboxOwnDataValue(value, 'leaseToken');
		if (typeof leaseToken === 'string' && isSafeOutboxCacheKey(leaseToken)) {
			identity.leaseToken = leaseToken;
			releaseSnapshot.leaseToken = leaseToken;
		}
		const leaseExpiresAt = outboxOwnDataValue(value, 'leaseExpiresAt');
		if (typeof leaseExpiresAt === 'string' && isCanonicalOutboxTimestamp(leaseExpiresAt)) {
			identity.leaseExpiresAt = leaseExpiresAt;
			releaseSnapshot.leaseExpiresAt = leaseExpiresAt;
		}
		const version = outboxOwnDataValue(value, 'version');
		if (typeof version === 'number' && Number.isSafeInteger(version) && version >= 0) {
			releaseSnapshot.version = version;
		}
		const attempts = outboxOwnDataValue(value, 'deliveryAttempts');
		if (typeof attempts === 'number' && Number.isSafeInteger(attempts) && attempts >= 0) {
			deliveryAttempts = attempts;
			releaseSnapshot.deliveryAttempts = attempts;
		}
	}
	const orderKeys = outboxIdentityOrderKeys(identity, index);
	return {
		identity,
		releaseSnapshot: hasReleaseId ? releaseSnapshot as OutboxEvent : undefined,
		orderCheckKeys: orderKeys,
		orderBlockKeys: copyEvents(orderKeys),
		deliveryAttempts
	};
}

function outboxOwnDataValue(value: object, property: string) {
	const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, property);
	return descriptor && 'value' in descriptor && descriptor.enumerable ? descriptor.value : undefined;
}

function isSafeOutboxCacheKey(value: string) {
	try {
		assertSafeCacheKey(value, 'outbox delivery identity');
		return true;
	} catch {
		return false;
	}
}

function isSafeOutboxSchemaIdentifier(value: string) {
	try {
		assertSafeSchemaIdentifier(value, 'outbox delivery identity');
		return true;
	} catch {
		return false;
	}
}

function isSafeOutboxEntityId(value: string | number): value is EntityId {
	try {
		assertSafeEntityId(value, 'outbox delivery identity');
		return true;
	} catch {
		return false;
	}
}

function isCanonicalOutboxTimestamp(value: string) {
	const timestamp = dateParse(value);
	return Number.isFinite(timestamp) && dateIsoString(new Date(timestamp)) === value;
}

function outboxIdentityOrderKeys(identity: OutboxEventIdentity, index: number) {
	if (identity.model !== undefined && identity.modelIdentity !== undefined) {
		return [`${identity.model}:${identity.modelIdentity}`];
	}
	if (identity.model !== undefined && identity.modelId !== undefined) {
		return [`${identity.model}:${entityIdKey(identity.modelId)}`];
	}
	if (identity.id !== undefined) return [`event:${identity.id}`];
	return [`malformed:${index}`];
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
			reconcileFromStore: true,
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
				await activeContext.afterCommitInternal(async () => {
					await options.outbox.append(event);
				});
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

type SearchSyncWorkerSharedOptions = {
	search: SearchAdapter;
	models: ModelConstructor[];
	adapter?: string;
	batchSize?: number;
	maxAttempts?: number;
	retryDelayMs?: number | ((attempt: number) => number | Promise<number>);
	deadLetter?: (failures: OutboxDeliveryFailure[]) => Promise<void>;
	allowUnsafeDrainFallback?: boolean;
	allowUnsafeIdentityOnlyDatastoreDelete?: boolean;
};

type SearchSyncWorkerContextOption<TOutbox extends OutboxAdapter> =
	TOutbox extends { lease: NonNullable<OutboxAdapter['lease']> }
		? TOutbox extends { supportsExclusiveLease: () => false | Promise<false> }
			? { context?: ActiveContext }
			: { context: ActiveContext }
		: { context?: ActiveContext };

export type SearchSyncWorkerOptions<TOutbox extends OutboxAdapter = OutboxAdapter> =
	SearchSyncWorkerSharedOptions &
	{ outbox: TOutbox } &
	SearchSyncWorkerContextOption<NoInfer<TOutbox>>;

export async function runSearchSyncWorker<TOutbox extends OutboxAdapter = OutboxAdapter>(
	options: SearchSyncWorkerOptions<TOutbox>
) {
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
		if (!activeOptions.context) {
			throw new ActiveTsConfigurationError(
				'Outbox search sync requires a context when using leases so stale external search mutations can be reconciled from the authoritative store.'
			);
		}
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
	let processed = 0;
	const failures: unknown[] = [];
	const deliveryFailures: PendingSearchSyncFailure[] = [];
	const deferredEvents: PendingSearchSyncDeferredEvent[] = [];
	const repairCleanupErrors: unknown[] = [];
	const blockedEntityKeys = new Set<string>();
	eventLoop: for (let index = 0; index < events.length; index++) {
		const rawEvent: unknown = events[index];
		let event: OutboxEvent | undefined;
		let identitySnapshot = snapshotOutboxDeliveryIdentity(rawEvent, index);
		let repair: Awaited<ReturnType<typeof enqueueSearchSyncRepair>> | undefined;
		let preserveRepair = false;
		if (outboxEntityOrderKeysBlocked(blockedEntityKeys, identitySnapshot.orderCheckKeys)) {
			deferredEvents[deferredEvents.length] = { index, value: rawEvent, identity: identitySnapshot };
			continue;
		}
		try {
			event = sanitizeOutboxEvent(rawEvent, { requireModelId: true });
			events[index] = event;
			identitySnapshot = snapshotOutboxDeliveryIdentity(event, index);
			const orderKeys = outboxEntityOrderCheckKeys(event);
			if (outboxEntityOrderKeysBlocked(blockedEntityKeys, orderKeys)) {
				deferredEvents[deferredEvents.length] = { index, value: event, identity: identitySnapshot };
				continue;
			}
			if (!(await ensureSearchSyncLeaseCurrent(activeOptions.outbox, event, usesLease))) {
				blockOutboxEntityOrderKeys(blockedEntityKeys, outboxEntityOrderBlockKeys(event));
				continue;
			}
			const model = MAP_GET.call(modelByName, event.model) as ModelConstructor | undefined;
			if (!model) {
				throw new ActiveTsConfigurationError(
					`Outbox event "${event.id}" references unregistered model "${event.model}".`
				);
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
			const mutation = await resolveSearchSyncMutation(
				activeOptions.context,
				model,
				meta,
				event,
				activeOptions.searchSource,
				activeOptions.allowUnsafeIdentityOnlyDatastoreDelete,
				event.reconcileFromStore === true
			);
			repair = usesLease && searchRoutes.length
				? await enqueueSearchSyncRepair(activeOptions.outbox, event)
				: undefined;
			for (let routeIndex = 0; routeIndex < searchRoutes.length; routeIndex++) {
				const searchRoute = searchRoutes[routeIndex];
				const searchEventMeta = searchSyncEventMeta(activeOptions.context, meta, searchRoute, mutation.identity);
				const hookOperation = mutation.operation === 'index' ? 'index' : 'index-delete';
				const hookData = mutation.operation === 'index' ? mutation.data : undefined;
				if (!(await ensureSearchSyncLeaseCurrent(activeOptions.outbox, event, usesLease))) {
					blockOutboxEntityOrderKeys(blockedEntityKeys, outboxEntityOrderBlockKeys(event));
					continue eventLoop;
				}
				await runSearchIndexHook(activeOptions.context, 'beforeIndex', searchEventMeta, event.modelId!, hookData, hookOperation);
				if (!(await ensureSearchSyncLeaseCurrent(activeOptions.outbox, event, usesLease))) {
					blockOutboxEntityOrderKeys(blockedEntityKeys, outboxEntityOrderBlockKeys(event));
					continue eventLoop;
				}
				// Once a remote mutation starts, a rejection cannot prove that it had no side effect.
				preserveRepair = true;
				const mutationResult = await runSearchSyncMutationWithLease(
					activeOptions.outbox,
					event,
					usesLease,
					() => executeSearchSyncMutation(searchRoute.adapter, searchEventMeta, event!, mutation)
				);
				event = mutationResult.event;
				events[index] = event;
				if (mutationResult.mutationFailed) throw mutationResult.mutationError;
				if (!mutationResult.current) {
					preserveRepair = true;
					await reconcileStaleSearchSyncMutation(
						activeOptions.context!,
						model,
						meta,
						repair!.event,
						searchRoute,
						activeOptions.searchSource,
						activeOptions.allowUnsafeIdentityOnlyDatastoreDelete
					);
					blockOutboxEntityOrderKeys(blockedEntityKeys, outboxEntityOrderBlockKeys(event));
					if (mutationResult.renewalError !== undefined) throw mutationResult.renewalError;
					continue eventLoop;
				}
				await runSearchIndexHook(activeOptions.context, 'afterIndex', searchEventMeta, event.modelId!, hookData, hookOperation);
				if (!(await ensureSearchSyncLeaseCurrent(activeOptions.outbox, event, usesLease))) {
					blockOutboxEntityOrderKeys(blockedEntityKeys, outboxEntityOrderBlockKeys(event));
					continue eventLoop;
				}
			}
			if (usesLease) {
				const ackEvents = repair?.ackSnapshot ? [event, repair.ackSnapshot] : [event];
				let acknowledged: boolean;
				try {
					acknowledged = await ackOutboxEvents(activeOptions.outbox, ackEvents);
				} catch (error) {
					preserveRepair = true;
					throw error;
				}
				if (!acknowledged) {
					preserveRepair = true;
					blockOutboxEntityOrderKeys(blockedEntityKeys, outboxEntityOrderBlockKeys(event));
					continue;
				}
			}
			processed++;
		} catch (error) {
			if (repair?.ackSnapshot && !preserveRepair) {
				try {
					if (!(await ackOutboxEvents(activeOptions.outbox, [repair.ackSnapshot]))) {
						repairCleanupErrors[repairCleanupErrors.length] = new ActiveTsConflictError(
							`Outbox event "${event?.id ?? identitySnapshot.identity.id ?? '<unknown>'}" repair guard was no longer current.`
						);
					}
				} catch (cleanupError) {
					repairCleanupErrors[repairCleanupErrors.length] = cleanupError;
				}
			}
			failures.push(error);
			blockOutboxEntityOrderKeys(
				blockedEntityKeys,
				event ? outboxEntityOrderBlockKeys(event) : identitySnapshot.orderBlockKeys
			);
			if (!isStaleSearchSyncLeaseReleaseError(error)) {
				deliveryFailures[deliveryFailures.length] = {
					index,
					value: rawEvent,
					event,
					identity: identitySnapshot,
					error
				};
			}
		}
	}
	const retryErrors = await settleSearchSyncFailures(
		activeOptions,
		deliveryFailures,
		deferredEvents,
		usesLease
	);
	retryErrors.push(...repairCleanupErrors);
	if (retryErrors.length) {
		const primary = failures[0] ?? retryErrors[0];
		throw new AggregateError(
			[...failures, ...retryErrors],
			`Outbox search sync failed and ${usesLease ? 'release' : 'requeue'} failed: ${safeErrorMessage(primary)}`
		);
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) {
		throw new AggregateError(
			failures,
			`Outbox search sync failed for ${failures.length} isolated events: ${safeErrorMessage(failures[0])}`
		);
	}
	return processed;
}

type PendingSearchSyncDeferredEvent = {
	index: number;
	value: unknown;
	identity: OutboxDeliveryIdentitySnapshot;
};

type PendingSearchSyncFailure = PendingSearchSyncDeferredEvent & {
	event?: OutboxEvent;
	error: unknown;
};

async function settleSearchSyncFailures(
	options: ReturnType<typeof validateSearchSyncWorkerOptions>,
	pendingFailures: PendingSearchSyncFailure[],
	deferredEvents: PendingSearchSyncDeferredEvent[],
	usesLease: boolean
) {
	const recoveryErrors: unknown[] = [];
	const retryFailures: Array<{ pending: PendingSearchSyncFailure; failure: OutboxDeliveryFailure }> = [];
	const deadLetterFailures: Array<{ pending: PendingSearchSyncFailure; failure: OutboxDeliveryFailure }> = [];
	const recoverSources: PendingSearchSyncDeferredEvent[] = [];
	for (const pending of pendingFailures) {
		try {
			const failure = await createSearchSyncDeliveryFailure(options, pending);
			if (failure.attempt >= failure.maxAttempts) {
				deadLetterFailures[deadLetterFailures.length] = { pending, failure };
			} else {
				retryFailures[retryFailures.length] = { pending, failure };
			}
		} catch (error) {
			recoveryErrors[recoveryErrors.length] = error;
			recoverSources[recoverSources.length] = pending;
		}
	}

	if (deadLetterFailures.length) {
		const failures: OutboxDeliveryFailure[] = [];
		for (const entry of deadLetterFailures) failures[failures.length] = entry.failure;
		const handler = options.deadLetter ?? options.outbox.deadLetter;
		if (!handler) {
			recoveryErrors[recoveryErrors.length] = new ActiveTsConfigurationError(
				'Outbox search sync reached maxAttempts but no deadLetter handler is configured.'
			);
			for (const entry of deadLetterFailures) recoverSources[recoverSources.length] = entry.pending;
		} else {
			try {
				await handler(failures);
				if (options.deadLetter && usesLease) {
					const sourceEvents: unknown[] = [];
					for (const entry of deadLetterFailures) {
						sourceEvents[sourceEvents.length] = entry.pending.event ?? entry.pending.value;
					}
					const acknowledged = await ackOutboxSnapshots(
						options.outbox,
						sourceEvents
					);
					if (!acknowledged) {
						recoveryErrors[recoveryErrors.length] = new ActiveTsConflictError(
							'Outbox search sync dead-letter sink completed, but the source lease was no longer current.'
						);
					}
				}
			} catch (error) {
				recoveryErrors[recoveryErrors.length] = error;
				for (const entry of deadLetterFailures) recoverSources[recoverSources.length] = entry.pending;
			}
		}
	}

	if (retryFailures.length) {
		if (usesLease) {
			try {
				const failures: OutboxDeliveryFailure[] = [];
				for (const entry of retryFailures) failures[failures.length] = entry.failure;
				await options.outbox.retry!(failures);
			} catch (error) {
				recoveryErrors[recoveryErrors.length] = error;
				for (const entry of retryFailures) recoverSources[recoverSources.length] = entry.pending;
			}
		} else {
			for (const entry of retryFailures) {
				if (entry.failure.event) {
					recoverSources[recoverSources.length] = {
						...entry.pending,
						value: outboxRetryEvent(entry.failure)
					};
				} else if (options.outbox.retry) {
					try {
						await options.outbox.retry([entry.failure]);
					} catch (error) {
						recoveryErrors[recoveryErrors.length] = error;
						recoverSources[recoverSources.length] = entry.pending;
					}
				} else {
					recoverSources[recoverSources.length] = entry.pending;
				}
			}
		}
	}

	for (const event of deferredEvents) recoverSources[recoverSources.length] = event;
	const orderedRecoveries = orderPendingOutboxRecoveries(recoverSources);
	if (orderedRecoveries.length) {
		const values: unknown[] = [];
		for (const entry of orderedRecoveries) values[values.length] = entry.value;
		recoveryErrors.push(...(usesLease
			? await releaseOutboxEvents(options.outbox, values)
			: await requeueOutboxEvents(options.outbox, values)));
	}
	return recoveryErrors;
}

async function createSearchSyncDeliveryFailure(
	options: ReturnType<typeof validateSearchSyncWorkerOptions>,
	pending: PendingSearchSyncFailure
) {
	const previousAttempts = pending.event?.deliveryAttempts ?? pending.identity.deliveryAttempts;
	const attempt = Math.min(options.maxAttempts, previousAttempts + 1);
	const failedAt = dateIsoString(new Date());
	let retryAt: string | undefined;
	if (attempt < options.maxAttempts) {
		const delay = await searchSyncRetryDelay(options.retryDelayMs, attempt);
		retryAt = dateIsoString(new Date(Date.now() + delay));
	}
	return sanitizeOutboxDeliveryFailure(
		{
			identity: pending.identity.identity,
			event: pending.event,
			attempt,
			maxAttempts: options.maxAttempts,
			failedAt,
			retryAt,
			error: outboxDeliveryErrorMessage(pending.error)
		},
		'Outbox search sync delivery failure',
		false
	);
}

async function searchSyncRetryDelay(
	configured: SearchSyncWorkerOptions['retryDelayMs'],
	attempt: number
) {
	let delay: unknown;
	if (typeof configured === 'function') delay = await configured(attempt);
	else if (configured !== undefined) delay = configured;
	else {
		const exponent = Math.min(attempt - 1, 16);
		delay = Math.min(MAX_SEARCH_SYNC_RETRY_DELAY_MS, DEFAULT_SEARCH_SYNC_RETRY_DELAY_MS * (2 ** exponent));
	}
	return assertNonNegativeSafeInteger(delay, 'Outbox search sync retry delay');
}

function outboxDeliveryErrorMessage(error: unknown) {
	let message = safeErrorMessage(error).replaceAll('\0', '\\0');
	if (!message) message = '<empty error message>';
	while (Buffer.byteLength(message, 'utf8') > 4_096) {
		message = message.slice(0, Math.max(1, Math.floor(message.length * 0.75)));
	}
	return message;
}

function orderPendingOutboxRecoveries(events: PendingSearchSyncDeferredEvent[]) {
	const ordered: PendingSearchSyncDeferredEvent[] = [];
	for (const event of events) {
		let insertAt = ordered.length;
		while (insertAt > 0 && ordered[insertAt - 1].index > event.index) insertAt--;
		for (let index = ordered.length; index > insertAt; index--) ordered[index] = ordered[index - 1];
		ordered[insertAt] = event;
	}
	return ordered;
}

type SearchSyncAdapterRoute = {
	name: string;
	indexKind: string;
	adapter: SearchAdapter;
};

type SearchSyncMutation =
	| { operation: 'index'; identity: string | undefined; data: Record<string, any> }
	| { operation: 'delete'; identity: string | undefined };

async function resolveSearchSyncMutation(
	context: ActiveContext | undefined,
	model: ModelConstructor,
	meta: ResolvedModelMeta,
	event: OutboxEvent,
	searchSource: SearchAdapter,
	allowUnsafeIdentityOnlyDatastoreDelete: boolean | undefined,
	reconcileFromStore: boolean
): Promise<SearchSyncMutation> {
	let data = event.data;
	let loadedFromStore = false;
	if (context && (reconcileFromStore || (event.operation !== 'delete' && data === undefined))) {
		const raw = await loadSearchSyncEventData(context, meta, event);
		const loaded = context.instantiate(model, raw);
		data = (loaded as any)?.data;
		loadedFromStore = true;
	}
	if (data === undefined) {
		if (!context && event.operation !== 'delete') {
			throw new ActiveTsConfigurationError(`Outbox event "${event.id}" is missing data for search indexing.`);
		}
		return {
			operation: 'delete',
			identity: outboxEventSearchDocumentIdentity(
				event,
				meta,
				undefined,
				datastoreNamespaceForContext(context, meta),
				{ allowUnsafeIdentityOnlyDatastoreDelete }
			)
		};
	}
	if (!loadedFromStore && event.operation === 'delete') {
		if (event.dataEncoding === 'stored') {
			if (!context) {
				throw new ActiveTsConfigurationError(
					`Outbox event "${event.id}" stores encoded data and requires a context for search indexing.`
				);
			}
			data = context.validateRead(meta, data);
		} else if (context) {
			data = context.validateDecodedRead(meta, data);
		}
		data = normalizeSearchIndexEventData(event, meta, data);
		return {
			operation: 'delete',
			identity: outboxEventSearchDocumentIdentity(
				event,
				meta,
				data,
				datastoreNamespaceForContext(context, meta),
				{ allowUnsafeIdentityOnlyDatastoreDelete }
			)
		};
	}
	if (!context && searchAdapterUsesProjection(searchSource)) {
		throw new ActiveTsConfigurationError(
			`Outbox event "${event.id}" requires a context for search indexing with a projecting search adapter.`
		);
	}
	if (context && (loadedFromStore || event.dataEncoding !== 'stored')) {
		data = context.validateDecodedRead(meta, data);
	} else if (context) {
		data = context.validateRead(meta, data);
	} else if (event.dataEncoding === 'stored') {
		throw new ActiveTsConfigurationError(
			`Outbox event "${event.id}" stores encoded data and requires a context for search indexing.`
		);
	}
	data = normalizeSearchIndexEventData(event, meta, data, { requireDatastoreAncestorFields: true });
	return {
		operation: 'index',
		identity: outboxEventSearchDocumentIdentity(
			event,
			meta,
			data,
			datastoreNamespaceForContext(context, meta),
			{ allowUnsafeIdentityOnlyDatastoreDelete }
		),
		data: cloneSafeDataObjectWithoutActiveEntityKey(data, `Outbox event "${event.id}" search index data`)
	};
}

function searchSyncEventMeta(
	context: ActiveContext | undefined,
	meta: ResolvedModelMeta,
	route: SearchSyncAdapterRoute,
	identity: string | undefined
) {
	return withSearchDocumentIdentity(
		withDatastoreSearchNamespace(
			withSearchIndexesForAdapter(meta, route.name, route.indexKind),
			datastoreNamespaceForContext(context, meta)
		),
		identity
	);
}

async function executeSearchSyncMutation(
	search: SearchAdapter,
	meta: ResolvedModelMeta,
	event: OutboxEvent,
	mutation: SearchSyncMutation
) {
	if (mutation.operation === 'delete') {
		await search.delete(meta, event.modelId!);
		return;
	}
	await search.index(meta, event.modelId!, mutation.data);
}

async function enqueueSearchSyncRepair(outbox: OutboxAdapter, event: OutboxEvent) {
	const repairEvent = sanitizeOutboxEvent({
		id: randomUUID(),
		model: event.model,
		modelId: event.modelId,
		modelIdentity: event.modelIdentity,
		modelDatastoreAncestor: event.modelDatastoreAncestor,
		modelDatastoreProjectId: event.modelDatastoreProjectId,
		operation: 'update',
		reconcileFromStore: true,
		createdAt: event.createdAt,
		sequence: nextStoreOutboxSequence(),
		version: 0
	}, { requireModelId: true });
	const appended = await outbox.append(repairEvent);
	const ackSnapshot = appended === undefined
		? repairEvent
		: sanitizeOutboxEvent(appended, { requireModelId: true });
	if (
		ackSnapshot.id !== repairEvent.id ||
		ackSnapshot.model !== repairEvent.model ||
		!outboxEntityIdMatches(ackSnapshot.modelId, repairEvent.modelId) ||
		ackSnapshot.reconcileFromStore !== true ||
		ackSnapshot.deadLetteredAt !== undefined ||
		ackSnapshot.leaseToken !== undefined
	) {
		throw new ActiveTsConfigurationError(
			`Outbox adapter append returned an invalid search repair snapshot for event "${event.id}".`
		);
	}
	return { event: repairEvent, ackSnapshot };
}

async function reconcileStaleSearchSyncMutation(
	context: ActiveContext,
	model: ModelConstructor,
	meta: ResolvedModelMeta,
	event: OutboxEvent,
	route: SearchSyncAdapterRoute,
	searchSource: SearchAdapter,
	allowUnsafeIdentityOnlyDatastoreDelete: boolean | undefined
) {
	const mutation = await resolveSearchSyncMutation(
		context,
		model,
		meta,
		event,
		searchSource,
		allowUnsafeIdentityOnlyDatastoreDelete,
		true
	);
	const repairMeta = searchSyncEventMeta(context, meta, route, mutation.identity);
	await executeSearchSyncMutation(route.adapter, repairMeta, event, mutation);
}

async function runSearchSyncMutationWithLease(
	outbox: OutboxAdapter,
	event: OutboxEvent,
	usesLease: boolean,
	mutation: () => Promise<void>
) {
	if (!usesLease) {
		await mutation();
		return { event, current: true, renewalError: undefined as unknown, mutationFailed: false as const };
	}
	let activeEvent = event;
	let renewalError: unknown;
	let renewalLost = false;
	let mutationError: unknown;
	let mutationFailed = false;
	let renewalChain = Promise.resolve();
	let timer: NodeJS.Timeout | undefined;
	if (outbox.renewLease) {
		const interval = searchSyncLeaseRenewalInterval(event);
		timer = setInterval(() => {
			renewalChain = renewalChain.then(async () => {
				if (renewalError !== undefined || renewalLost) return;
				try {
					const renewed = await outbox.renewLease!(activeEvent);
					if (renewed === undefined) {
						renewalLost = true;
						return;
					}
					const normalized = sanitizeOutboxEvent(renewed, { requireModelId: true });
					assertOutboxLeaseRenewal(activeEvent, normalized);
					activeEvent = normalized;
				} catch (error) {
					renewalError = error;
				}
			});
		}, interval);
	}
	try {
		await mutation();
	} catch (error) {
		mutationFailed = true;
		mutationError = error;
	} finally {
		if (timer !== undefined) clearInterval(timer);
		await renewalChain;
	}
	if (mutationFailed) {
		return {
			event: activeEvent,
			current: false,
			renewalError,
			mutationFailed: true as const,
			mutationError
		};
	}
	if (renewalError !== undefined || renewalLost) {
		return {
			event: activeEvent,
			current: false,
			renewalError: renewalError ?? new ActiveTsConflictError(
				`Outbox event "${event.id}" lost its lease during search mutation renewal.`
			),
			mutationFailed: false as const
		};
	}
	return {
		event: activeEvent,
		current: await ensureSearchSyncLeaseCurrent(outbox, activeEvent, true),
		renewalError: undefined as unknown,
		mutationFailed: false as const
	};
}

function searchSyncLeaseRenewalInterval(event: OutboxEvent) {
	if (event.leaseExpiresAt === undefined) return 30_000;
	const remaining = dateParse(event.leaseExpiresAt) - Date.now();
	return Math.max(1, Math.min(30_000, Math.floor(remaining / 3)));
}

function assertOutboxLeaseRenewal(previous: OutboxEvent, renewed: OutboxEvent) {
	const comparable = {
		...renewed,
		version: previous.version,
		leaseExpiresAt: previous.leaseExpiresAt
	};
	if (
		!isOutboxSnapshotCurrent(comparable, previous) ||
		outboxEventVersion(renewed) <= outboxEventVersion(previous) ||
		dateParse(renewed.leaseExpiresAt!) <= dateParse(previous.leaseExpiresAt!)
	) {
		throw new ActiveTsConfigurationError(
			`Outbox adapter renewLease returned an invalid renewal for event "${previous.id}".`
		);
	}
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
	maxAttempts: number;
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
	const maxAttempts = ownOptionValue(record, 'maxAttempts', 'Outbox search sync options');
	const retryDelayMs = ownOptionValue(record, 'retryDelayMs', 'Outbox search sync options');
	const deadLetter = ownOptionValue(record, 'deadLetter', 'Outbox search sync options');
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
	const safeMaxAttempts = maxAttempts === undefined
		? DEFAULT_SEARCH_SYNC_MAX_ATTEMPTS
		: assertPositiveSafeInteger(maxAttempts, 'Outbox search sync maxAttempts');
	if (typeof retryDelayMs !== 'function' && retryDelayMs !== undefined) {
		assertNonNegativeSafeInteger(retryDelayMs, 'Outbox search sync retryDelayMs');
	}
	if (deadLetter !== undefined && typeof deadLetter !== 'function') {
		throw new ActiveTsConfigurationError('Outbox search sync deadLetter must be a function.');
	}
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
		maxAttempts: safeMaxAttempts,
		retryDelayMs: retryDelayMs as SearchSyncWorkerOptions['retryDelayMs'],
		deadLetter: deadLetter as SearchSyncWorkerOptions['deadLetter'],
		allowUnsafeDrainFallback: allowUnsafeDrainFallback as boolean | undefined,
		allowUnsafeIdentityOnlyDatastoreDelete: allowUnsafeIdentityOnlyDatastoreDelete as boolean | undefined
	} as SearchSyncWorkerOptions & {
		outbox: OutboxAdapter;
		searchSource: SearchAdapter;
		maxAttempts: number;
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
	const reconcileFromStore = ownOptionValue(record, 'reconcileFromStore', 'Outbox event');
	const sequence = ownOptionValue(record, 'sequence', 'Outbox event');
	const version = ownOptionValue(record, 'version', 'Outbox event');
	const leaseToken = ownOptionValue(record, 'leaseToken', 'Outbox event');
	const leaseExpiresAt = ownOptionValue(record, 'leaseExpiresAt', 'Outbox event');
	const deliveryAttempts = ownOptionValue(record, 'deliveryAttempts', 'Outbox event');
	const availableAt = ownOptionValue(record, 'availableAt', 'Outbox event');
	const deadLetteredAt = ownOptionValue(record, 'deadLetteredAt', 'Outbox event');
	const lastDeliveryError = ownOptionValue(record, 'lastDeliveryError', 'Outbox event');
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
	if (reconcileFromStore !== undefined && typeof reconcileFromStore !== 'boolean') {
		throw new ActiveTsConfigurationError(`Outbox event "${id}" reconcileFromStore must be a boolean.`);
	}
	if (version !== undefined && (!Number.isSafeInteger(version) || version < 0)) {
		throw new ActiveTsConfigurationError(`Outbox event "${id}" version must be a non-negative safe integer.`);
	}
	if (deliveryAttempts !== undefined && (!Number.isSafeInteger(deliveryAttempts) || deliveryAttempts < 0)) {
		throw new ActiveTsConfigurationError(
			`Outbox event "${id}" deliveryAttempts must be a non-negative safe integer.`
		);
	}
	if ((leaseToken === undefined) !== (leaseExpiresAt === undefined)) {
		throw new ActiveTsConfigurationError(`Outbox event "${id}" leaseToken and leaseExpiresAt must be configured together.`);
	}
	if (deadLetteredAt !== undefined && leaseToken !== undefined) {
		throw new ActiveTsConfigurationError(`Outbox event "${id}" cannot be dead-lettered while leased.`);
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
	if (reconcileFromStore !== undefined) normalized.reconcileFromStore = reconcileFromStore as boolean;
	if (sequence !== undefined) normalized.sequence = assertSafeCacheKey(sequence, `Outbox event "${id}" sequence`);
	if (version !== undefined) normalized.version = version as number;
	if (leaseToken !== undefined) normalized.leaseToken = assertSafeCacheKey(leaseToken, `Outbox event "${id}" leaseToken`);
	if (leaseExpiresAt !== undefined) {
		normalized.leaseExpiresAt = assertCanonicalIsoTimestamp(leaseExpiresAt, `Outbox event "${id}" leaseExpiresAt`);
	}
	if (deliveryAttempts !== undefined) normalized.deliveryAttempts = deliveryAttempts as number;
	if (availableAt !== undefined) {
		normalized.availableAt = assertCanonicalIsoTimestamp(availableAt, `Outbox event "${id}" availableAt`);
	}
	if (deadLetteredAt !== undefined) {
		normalized.deadLetteredAt = assertCanonicalIsoTimestamp(
			deadLetteredAt,
			`Outbox event "${id}" deadLetteredAt`
		);
	}
	if (lastDeliveryError !== undefined) {
		normalized.lastDeliveryError = assertSafeCacheKey(
			lastDeliveryError,
			`Outbox event "${id}" lastDeliveryError`
		);
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
	const transactionStore = adapterMember(value, 'transactionStore');
	const append = adapterMember(value, 'append');
	const appendTransactional = adapterMember(value, 'appendTransactional');
	const list = adapterMember(value, 'list');
	const listDeadLetters = adapterMember(value, 'listDeadLetters');
	const lease = adapterMember(value, 'lease');
	const supportsExclusiveLease = adapterMember(value, 'supportsExclusiveLease');
	const isLeaseCurrent = adapterMember(value, 'isLeaseCurrent');
	const renewLease = adapterMember(value, 'renewLease');
	const release = adapterMember(value, 'release');
	const ack = adapterMember(value, 'ack');
	const retry = adapterMember(value, 'retry');
	const deadLetter = adapterMember(value, 'deadLetter');
	const drain = adapterMember(value, 'drain');
	const requeue = adapterMember(value, 'requeue');
	if (setup !== undefined && typeof setup !== 'function') {
		throw new ActiveTsConfigurationError(`${context}.setup must be a function.`);
	}
	if (transactionStore !== undefined) {
		assertSafeSchemaIdentifier(transactionStore, `${context}.transactionStore`);
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
	if (listDeadLetters !== undefined && typeof listDeadLetters !== 'function') {
		throw new ActiveTsConfigurationError(`${context}.listDeadLetters must be a function.`);
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
	if (renewLease !== undefined && typeof renewLease !== 'function') {
		throw new ActiveTsConfigurationError(`${context}.renewLease must be a function.`);
	}
	if (release !== undefined && typeof release !== 'function') {
		throw new ActiveTsConfigurationError(`${context}.release must be a function.`);
	}
	if (ack !== undefined && typeof ack !== 'function') {
		throw new ActiveTsConfigurationError(`${context}.ack must be a function.`);
	}
	if (retry !== undefined && typeof retry !== 'function') {
		throw new ActiveTsConfigurationError(`${context}.retry must be a function.`);
	}
	if (deadLetter !== undefined && typeof deadLetter !== 'function') {
		throw new ActiveTsConfigurationError(`${context}.deadLetter must be a function.`);
	}
	if ((lease === undefined) !== (ack === undefined)) {
		throw new ActiveTsConfigurationError(`${context}.lease and ${context}.ack must be configured together.`);
	}
	if (renewLease !== undefined && lease === undefined) {
		throw new ActiveTsConfigurationError(`${context}.renewLease requires ${context}.lease.`);
	}
	if (
		requireDrain &&
		lease !== undefined &&
		supportsExclusiveLease === undefined &&
		(isLeaseCurrent === undefined || release === undefined || retry === undefined)
	) {
		throw new ActiveTsConfigurationError(
			`${context}.lease, ${context}.ack, ${context}.isLeaseCurrent, ${context}.release, and ${context}.retry must be configured together for search sync.`
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
		transactionStore: transactionStore as string | undefined,
		setup: typeof setup === 'function' ? setup.bind(value) : undefined,
		append: append.bind(value),
		appendTransactional: typeof appendTransactional === 'function' ? appendTransactional.bind(value) : undefined,
		list: typeof list === 'function' ? list.bind(value) : undefined,
		listDeadLetters: typeof listDeadLetters === 'function' ? listDeadLetters.bind(value) : undefined,
		lease: typeof lease === 'function' ? lease.bind(value) : undefined,
		supportsExclusiveLease: typeof supportsExclusiveLease === 'function' ? supportsExclusiveLease.bind(value) : undefined,
		isLeaseCurrent: typeof isLeaseCurrent === 'function' ? isLeaseCurrent.bind(value) : undefined,
		renewLease: typeof renewLease === 'function' ? renewLease.bind(value) : undefined,
		release: typeof release === 'function' ? release.bind(value) : undefined,
		ack: typeof ack === 'function' ? ack.bind(value) : undefined,
		retry: typeof retry === 'function' ? retry.bind(value) : undefined,
		deadLetter: typeof deadLetter === 'function' ? deadLetter.bind(value) : undefined,
		drain: typeof drain === 'function' ? drain.bind(value) : undefined,
		requeue: typeof requeue === 'function' ? requeue.bind(value) : undefined
	};
}

function assertSearchSyncLeaseContract(outbox: OutboxAdapter, context: string) {
	if (!outbox.isLeaseCurrent || !outbox.release || !outbox.retry) {
		throw new ActiveTsConfigurationError(
			`${context}.lease, ${context}.ack, ${context}.isLeaseCurrent, ${context}.release, and ${context}.retry must be configured together for search sync.`
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

function assertNonNegativeSafeInteger(value: unknown, context: string) {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
		throw new ActiveTsConfigurationError(`${context} must be a non-negative safe integer.`);
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

function sanitizeOutboxDeliveryFailureBatch(
	failures: OutboxDeliveryFailure[],
	context: string,
	requireEvent: boolean
) {
	const safeFailures = snapshotArrayInput<OutboxDeliveryFailure>(failures, context);
	const normalized: OutboxDeliveryFailure[] = [];
	for (let index = 0; index < safeFailures.length; index++) {
		normalized[index] = sanitizeOutboxDeliveryFailure(
			safeFailures[index],
			`${context}[${index}]`,
			requireEvent
		);
	}
	return normalized;
}

function sanitizeOutboxDeliveryFailure(value: unknown, context: string, requireEvent: boolean) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ActiveTsConfigurationError(`${context} must be an object.`);
	}
	assertPlainOptions(value, context);
	const record = value as Record<string, unknown>;
	assertNoSymbolOptions(record, context);
	assertKnownOptions(
		record,
		['identity', 'event', 'attempt', 'maxAttempts', 'failedAt', 'retryAt', 'error'],
		context
	);
	const eventValue = ownOptionValue(record, 'event', context);
	if (requireEvent && eventValue === undefined) {
		throw new ActiveTsConfigurationError(`${context}.event is required.`);
	}
	const event = eventValue === undefined
		? undefined
		: sanitizeOutboxEvent(eventValue, { requireModelId: false });
	const identity = sanitizeOutboxEventIdentity(ownOptionValue(record, 'identity', context), `${context}.identity`);
	const attempt = assertPositiveSafeInteger(ownOptionValue(record, 'attempt', context), `${context}.attempt`);
	const maxAttempts = assertPositiveSafeInteger(
		ownOptionValue(record, 'maxAttempts', context),
		`${context}.maxAttempts`
	);
	if (attempt > maxAttempts) {
		throw new ActiveTsConfigurationError(`${context}.attempt cannot exceed maxAttempts.`);
	}
	const failedAt = assertCanonicalIsoTimestamp(ownOptionValue(record, 'failedAt', context), `${context}.failedAt`);
	const retryAtValue = ownOptionValue(record, 'retryAt', context);
	const retryAt = retryAtValue === undefined
		? undefined
		: assertCanonicalIsoTimestamp(retryAtValue, `${context}.retryAt`);
	const error = assertSafeCacheKey(ownOptionValue(record, 'error', context), `${context}.error`);
	return {
		identity,
		event,
		attempt,
		maxAttempts,
		failedAt,
		retryAt,
		error
	} satisfies OutboxDeliveryFailure;
}

function sanitizeOutboxEventIdentity(value: unknown, context: string): OutboxEventIdentity {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ActiveTsConfigurationError(`${context} must be an object.`);
	}
	assertPlainOptions(value, context);
	const record = value as Record<string, unknown>;
	assertNoSymbolOptions(record, context);
	assertKnownOptions(record, ['id', 'model', 'modelId', 'modelIdentity', 'leaseToken', 'leaseExpiresAt'], context);
	const identity: OutboxEventIdentity = {};
	const id = ownOptionValue(record, 'id', context);
	const model = ownOptionValue(record, 'model', context);
	const modelId = ownOptionValue(record, 'modelId', context);
	const modelIdentity = ownOptionValue(record, 'modelIdentity', context);
	const leaseToken = ownOptionValue(record, 'leaseToken', context);
	const leaseExpiresAt = ownOptionValue(record, 'leaseExpiresAt', context);
	if (id !== undefined) identity.id = assertSafeCacheKey(id, `${context}.id`);
	if (model !== undefined) identity.model = assertSafeSchemaIdentifier(model, `${context}.model`);
	if (modelId !== undefined) {
		assertSafeEntityId(modelId, `${context}.modelId`);
		identity.modelId = modelId;
	}
	if (modelIdentity !== undefined) {
		identity.modelIdentity = assertSafeCacheKey(modelIdentity, `${context}.modelIdentity`);
	}
	if (leaseToken !== undefined) identity.leaseToken = assertSafeCacheKey(leaseToken, `${context}.leaseToken`);
	if (leaseExpiresAt !== undefined) {
		identity.leaseExpiresAt = assertCanonicalIsoTimestamp(leaseExpiresAt, `${context}.leaseExpiresAt`);
	}
	return identity;
}

function outboxRetryEvent(failure: OutboxDeliveryFailure) {
	if (!failure.event || failure.retryAt === undefined) {
		throw new ActiveTsConfigurationError('Outbox retry failure requires an event and retryAt.');
	}
	const event: OutboxEvent = {
		...failure.event,
		version: outboxEventVersion(failure.event) + 1,
		deliveryAttempts: failure.attempt,
		availableAt: failure.retryAt,
		lastDeliveryError: failure.error
	};
	delete event.leaseToken;
	delete event.leaseExpiresAt;
	delete event.deadLetteredAt;
	return sanitizeOutboxEvent(event, { requireModelId: false });
}

function outboxDeadLetterEvent(failure: OutboxDeliveryFailure) {
	if (!failure.event) {
		throw new ActiveTsConfigurationError('Outbox dead-letter failure requires an event.');
	}
	const event: OutboxEvent = {
		...failure.event,
		version: outboxEventVersion(failure.event) + 1,
		deliveryAttempts: failure.attempt,
		deadLetteredAt: failure.failedAt,
		lastDeliveryError: failure.error
	};
	delete event.leaseToken;
	delete event.leaseExpiresAt;
	delete event.availableAt;
	return sanitizeOutboxEvent(event, { requireModelId: false });
}

async function requeueOutboxEvents(outbox: OutboxAdapter, events: unknown[]) {
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
	return await ackOutboxSnapshots(outbox, events);
}

async function ackOutboxSnapshots(outbox: OutboxAdapter, events: unknown[]) {
	if (!outbox.ack) {
		throw new ActiveTsConfigurationError('Outbox adapter does not support ack().');
	}
	const snapshots: OutboxEvent[] = [];
	for (let index = 0; index < events.length; index++) {
		try {
			snapshots[snapshots.length] = sanitizeOutboxEvent(events[index], { requireModelId: false });
		} catch (error) {
			const identity = snapshotOutboxDeliveryIdentity(events[index], index);
			if (!identity.releaseSnapshot) throw error;
			snapshots[snapshots.length] = identity.releaseSnapshot;
		}
	}
	return (await outbox.ack(snapshots)) !== false;
}

async function releaseOutboxEvents(outbox: OutboxAdapter, events: unknown[]) {
	if (!outbox.release) return [];
	const errors: unknown[] = [];
	const snapshots: OutboxEvent[] = [];
	for (let index = 0; index < events.length; index++) {
		const event = events[index];
		try {
			snapshots.push(sanitizeOutboxEvent(event, { requireModelId: false }));
		} catch (error) {
			const identity = snapshotOutboxDeliveryIdentity(event, index);
			if (identity.releaseSnapshot) snapshots.push(identity.releaseSnapshot);
			else errors.push(error);
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

function snapshotOutboxEventForRequeue(event: unknown): OutboxEvent {
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
